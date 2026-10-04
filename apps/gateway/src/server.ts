import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import {
  preferencesSchema,
  qualitySchema,
  normalizePreferences,
} from "@homegrid/shared";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { Config } from "./config.ts";
import { makeAuth, HOUSEHOLD_EMAIL } from "./auth.ts";
import { consumeLimit, getPreferences, savePreferences } from "./database.ts";
import type { Media } from "./media.ts";

const uuid = z.string().uuid();
export function makeServer(
  config: Config,
  db: Database.Database,
  media: Media,
) {
  const server = Fastify({
    logger: false,
    bodyLimit: 65536,
    requestTimeout: 30000,
    connectionTimeout: 30000,
  });
  const auth = makeAuth(config, db);
  server.addContentTypeParser(
    ["application/sdp", "application/trickle-ice-sdpfrag"],
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );
  server.addHook("onRequest", async (request, reply) => {
    reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff");
    const expected = Buffer.from(`Bearer ${config.serviceToken}`);
    const actual = Buffer.from(request.headers.authorization ?? "");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    if (
      request.method !== "GET" &&
      request.headers.origin !== config.appOrigin
    ) {
      return reply.code(403).send({ error: "Invalid origin" });
    }
  });
  server.setErrorHandler((error, _request, reply) => {
    const code =
      error && typeof error === "object" && "statusCode" in error
        ? error.statusCode
        : undefined;
    const status =
      typeof code === "number" && code >= 400 && code < 500 ? code : 503;
    reply.code(status).send({
      error: status < 500 ? "Invalid request" : "Gateway unavailable",
    });
  });
  function authHeaders(cookie?: string) {
    return new Headers(cookie ? { cookie } : {});
  }
  async function session(cookie?: string) {
    return auth.api.getSession({ headers: authHeaders(cookie) });
  }
  server.post("/internal/auth/sign-in/email", async (request, reply) => {
    if (!consumeLimit(db, "household-login", 5, 60000))
      return reply
        .code(429)
        .header("Retry-After", "60")
        .send({ error: "Too many attempts. Try again in a minute." });
    const input = z
      .object({ password: z.string().min(1).max(128) })
      .safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({ error: "Enter your password." });
    const response = await auth.handler(
      new Request(`${config.appOrigin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: config.appOrigin,
        },
        body: JSON.stringify({
          email: HOUSEHOLD_EMAIL,
          password: input.data.password,
          rememberMe: false,
        }),
      }),
    );
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header("Set-Cookie", cookies);
    reply.code(response.status);
    return response.ok ? { ok: true } : { error: "Password not accepted." };
  });
  server.post("/internal/auth/sign-out", async (request, reply) => {
    const current = await session(request.headers.cookie);
    if (current) await media.removeAll(current.session.id);
    const response = await auth.handler(
      new Request(`${config.appOrigin}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          ...Object.fromEntries(authHeaders(request.headers.cookie)),
          origin: config.appOrigin,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header("Set-Cookie", cookies);
    return { ok: true };
  });
  server.get("/internal/bootstrap", async (request, reply) => {
    const current = await session(request.headers.cookie);
    if (!current)
      return reply.code(401).send({ error: "Unlock HomeGrid to continue." });
    return {
      cameras: config.cameras,
      preferences: getPreferences(db, current.user.id, config.cameras),
    };
  });
  server.put("/internal/preferences", async (request, reply) => {
    const current = await session(request.headers.cookie);
    if (!current) return reply.code(401).send({ error: "Unauthorized" });
    const parsed = preferencesSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "Invalid preferences" });
    savePreferences(
      db,
      current.user.id,
      normalizePreferences(parsed.data, config.cameras),
    );
    return { ok: true };
  });
  server.post("/internal/heartbeat", async (request, reply) => {
    const current = await session(request.headers.cookie);
    if (!current) return reply.code(401).send({ error: "Unauthorized" });
    const input = z
      .object({ ids: z.array(uuid).max(12) })
      .safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({ error: "Invalid sessions" });
    media.heartbeat(current.session.id, input.data.ids);
    return { ok: true };
  });
  server.post("/internal/streams/:camera/:quality", async (request, reply) => {
    const current = await session(request.headers.cookie);
    if (!current) return reply.code(401).send({ error: "Unauthorized" });
    const params = request.params as { camera: string; quality: string };
    if (
      !config.cameras.some((c) => c.id === params.camera) ||
      !qualitySchema.safeParse(params.quality).success
    )
      return reply.code(404).send({ error: "Camera not found" });
    if (!consumeLimit(db, `media-${current.session.id}`, 60, 60000))
      return reply.code(429).send({ error: "Reconnect limit reached" });
    if (
      request.headers["content-type"] !== "application/sdp" ||
      typeof request.body !== "string" ||
      !request.body.startsWith("v=0\r\n")
    )
      return reply.code(400).send({ error: "Invalid video offer" });
    try {
      const result = await media.create(
        current.session.id,
        params.camera,
        params.quality,
        request.body,
      );
      // Recheck after slow upstream connection: logout or expiry must invalidate the in-flight request.
      const stillValid = await session(request.headers.cookie);
      if (!stillValid || stillValid.session.id !== current.session.id) {
        await media.remove(current.session.id, result.id);
        return reply.code(401).send({ error: "Unauthorized" });
      }
      return reply
        .code(201)
        .type("application/sdp")
        .header("Location", `/api/streams/sessions/${result.id}`)
        .send(result.sdp);
    } catch {
      return reply.code(503).send({
        error: "Camera unavailable. Check the stream codec and connection.",
      });
    }
  });
  server.patch("/internal/streams/sessions/:id", async (request, reply) => {
    const current = await session(request.headers.cookie);
    if (!current) return reply.code(401).send({ error: "Unauthorized" });
    const id = uuid.safeParse((request.params as { id: string }).id);
    if (
      !id.success ||
      request.headers["content-type"] !== "application/trickle-ice-sdpfrag" ||
      typeof request.body !== "string" ||
      !request.body.startsWith("a=ice-ufrag:") ||
      !request.body.includes("\r\na=ice-pwd:")
    )
      return reply.code(400).send({ error: "Invalid ICE update" });
    if (!consumeLimit(db, `ice-${current.session.id}`, 120, 60000))
      return reply.code(429).send({ error: "Connection update limit reached" });
    try {
      const updated = await media.patch(
        current.session.id,
        id.data,
        request.body,
      );
      return updated
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Video session not found" });
    } catch {
      return reply.code(503).send({ error: "Connection update unavailable" });
    }
  });
  server.delete("/internal/streams/sessions/:id", async (request, reply) => {
    const current = await session(request.headers.cookie);
    if (!current) return reply.code(401).send({ error: "Unauthorized" });
    const id = uuid.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: "Invalid session" });
    await media.remove(current.session.id, id.data);
    return reply.code(204).send();
  });
  return server;
}
