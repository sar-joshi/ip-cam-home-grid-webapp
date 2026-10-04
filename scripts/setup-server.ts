import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { privateSetup } from "./private-setup.ts";

export async function startPrivateSetup(
  port = 8890,
  save: (input: unknown) => Promise<void> = privateSetup,
  onComplete: () => void = () => {},
  form?: {
    title: string;
    description: string;
    fields: string;
    submit: string;
    success: string;
  },
) {
  const token = randomBytes(32).toString("base64url");
  let origin = "";
  const path = `/setup/${token}`;
  let submitting = false,
    completed = false;
  const ip =
    Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "";
  const success = form?.success ?? "Private setup saved";
  const fields =
    form?.fields ??
    `<label for="app">Viewer address</label><input id="app" name="appOrigin" type="url" value="https://homegrid.thepixelscout.com" required>
<label for="gateway">Gateway address</label><input id="gateway" name="gatewayUrl" type="url" value="https://homegrid-gateway.thepixelscout.com" required>
<label for="lan">Your Mac's LAN IP</label><input id="lan" name="lanIp" value="${ip}" required>
<label for="nvr">NVR IP</label><input id="nvr" name="nvrHost" value="192.168.4.37" required>
<label for="user">NVR read-only username</label><input id="user" name="nvrUser" maxlength="256" required>
<label for="nvr-password">NVR password</label><input id="nvr-password" name="nvrPassword" type="password" autocomplete="off" maxlength="256" required>
<label for="password">New household password (12–128 characters)</label><input id="password" name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required>
<label for="confirm">Confirm household password</label><input id="confirm" name="confirmation" type="password" minlength="12" maxlength="128" autocomplete="new-password" required>
`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${form?.title ?? "HomeGrid private setup"}</title>
<style>body{color-scheme:dark;background:#10171d;color:#e4eaee;font:14px -apple-system,BlinkMacSystemFont,sans-serif;margin:0}main{max-width:540px;margin:40px auto;padding:26px;border:1px solid #2b3942;border-radius:12px;background:#172128}h1{font-size:25px;margin:0 0 12px}p{color:#a6bac7;line-height:1.6}label{display:block;font-size:12px;margin:18px 0 7px}input{box-sizing:border-box;width:100%;background:#101b22;border:1px solid #3a4b56;border-radius:5px;color:#fff;height:40px;padding:0 11px;font:inherit}button{width:100%;margin-top:24px;height:44px;border:0;border-radius:6px;background:#a8d3d7;color:#10252b;font:600 14px -apple-system,sans-serif}.note{font-size:12px}@media(max-width:600px){main{margin:20px 12px}}</style>
<main><h1>${form?.title ?? "HomeGrid private setup"}</h1><p>${form?.description ?? "This page runs only on your Mac. NVR credentials stay in private gateway configuration; your household password is stored as a hash in local SQLite."}</p>
<form method="post" action="${path}" autocomplete="off">
${fields}
<button type="submit">${form?.submit ?? "Save private setup"}</button><p class="note">This setup page never sends credentials to Vercel or Cloudflare.</p></form></main></html>`;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    // HTML form POSTs under no-referrer can carry Origin: null. Preserve the
    // same-origin referrer so the strict CSRF check accepts our own form.
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    const actual = Buffer.from(request.url ?? ""),
      expected = Buffer.from(path);
    if (
      request.headers.host !== new URL(origin).host ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (completed) {
      response.end(`<h1>${success}</h1><p>You can close this page.</p>`);
      return;
    }
    if (request.method === "GET") {
      response.end(html);
      return;
    }
    if (
      request.method !== "POST" ||
      request.headers.origin !== origin ||
      request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
        "application/x-www-form-urlencoded"
    ) {
      response.writeHead(403).end("Request rejected");
      return;
    }
    if (submitting) {
      response.writeHead(409).end("Setup in progress");
      return;
    }
    submitting = true;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) throw new Error("Too large");
        chunks.push(chunk);
      }
      const fields = Object.fromEntries(
        new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
      );
      await save(fields);
      completed = true;
      response.end(
        `<main><h1>${success}</h1><p>Your credentials stayed on this Mac. You can close this page.</p></main>`,
      );
      console.log(
        "Private setup saved successfully. No credentials were printed or sent online.",
      );
      onComplete();
    } catch {
      response
        .writeHead(400)
        .end(
          "<main><h1>Setup could not finish</h1><p>Check the addresses and password requirements, then go back and try again. Other settings are preserved.</p></main>",
        );
    } finally {
      submitting = false;
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("Invalid setup address"));
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  return { server, url: `${origin}${path}` };
}
