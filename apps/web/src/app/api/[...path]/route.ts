import { NextRequest } from "next/server";
import { gateway } from "@/lib/gateway";
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const routes: Record<string, string> = {
  "POST auth/login": "/internal/auth/sign-in/email",
  "POST auth/logout": "/internal/auth/sign-out",
  "GET bootstrap": "/internal/bootstrap",
  "PUT preferences": "/internal/preferences",
  "POST heartbeat": "/internal/heartbeat",
};
async function boundedBody(request: NextRequest): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new RangeError("Request too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function handle(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const name = path.join("/");
  const method = request.method;
  const noStore = { "Cache-Control": "private, no-store" };
  if (method !== "GET") {
    const origin = process.env.HOMEGRID_APP_ORIGIN;
    if (
      !origin ||
      request.headers.get("origin") !== origin ||
      request.headers.get("sec-fetch-site") === "cross-site"
    ) {
      return Response.json(
        { error: "Request rejected." },
        { status: 403, headers: noStore },
      );
    }
  }
  let target = routes[`${method} ${name}`];
  if (method === "POST" && /^streams\/cam-[1-6]\/[012]$/.test(name))
    target = `/internal/${name}`;
  if (method === "DELETE" && /^streams\/sessions\/[0-9a-f-]{36}$/.test(name))
    target = `/internal/${name}`;
  if (!target)
    return Response.json(
      { error: "Not found." },
      { status: 404, headers: noStore },
    );
  try {
    const body =
      method === "GET" || method === "DELETE"
        ? undefined
        : await boundedBody(request);
    const headers = new Headers();
    const cookie = request.headers.get("cookie");
    if (cookie) headers.set("cookie", cookie);
    if (body)
      headers.set(
        "content-type",
        request.headers.get("content-type") ?? "application/json",
      );
    const upstream = await gateway(target, { method, headers, body });
    const outputHeaders = new Headers(noStore);
    for (const key of ["content-type", "location", "retry-after"]) {
      const value = upstream.headers.get(key);
      if (value) outputHeaders.set(key, value);
    }
    for (const value of upstream.headers.getSetCookie())
      outputHeaders.append("set-cookie", value);
    return new Response(
      upstream.status === 204 ? null : await upstream.text(),
      { status: upstream.status, headers: outputHeaders },
    );
  } catch (error) {
    if (error instanceof RangeError)
      return Response.json(
        { error: "Request too large." },
        { status: 413, headers: noStore },
      );
    return Response.json(
      { error: "Home gateway unavailable. Check that it is running." },
      { status: 503, headers: noStore },
    );
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
