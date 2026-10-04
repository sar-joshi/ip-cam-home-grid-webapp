import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { privateSetup } from "./private-setup.ts";

// This one-time setup server is separate from the deployed viewer. Loopback only.
process.umask(0o077);
if (existsSync("gateway.env"))
  throw new Error(
    "Private configuration already exists. Setup will not overwrite it.",
  );
const token = randomBytes(32).toString("base64url");
const origin = "http://127.0.0.1:8890";
const path = `/setup/${token}`;
let submitting = false,
  completed = false;
const ip =
  Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "";
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HomeGrid private setup</title>
<style>body{color-scheme:dark;background:#10171d;color:#e4eaee;font:14px -apple-system,BlinkMacSystemFont,sans-serif;margin:0}main{max-width:540px;margin:40px auto;padding:26px;border:1px solid #2b3942;border-radius:12px;background:#172128}h1{font-size:25px;margin:0 0 12px}p{color:#a6bac7;line-height:1.6}label{display:block;font-size:12px;margin:18px 0 7px}input{box-sizing:border-box;width:100%;background:#101b22;border:1px solid #3a4b56;border-radius:5px;color:#fff;height:40px;padding:0 11px;font:inherit}button{width:100%;margin-top:24px;height:44px;border:0;border-radius:6px;background:#a8d3d7;color:#10252b;font:600 14px -apple-system,sans-serif}.note{font-size:12px}@media(max-width:600px){main{margin:20px 12px}}</style>
<main><h1>HomeGrid private setup</h1><p>This page runs only on your Mac. NVR credentials stay in private gateway configuration; your household password is stored as a hash in local SQLite.</p>
<form method="post" action="${path}" autocomplete="off">
<label for="app">Viewer address</label><input id="app" name="appOrigin" type="url" value="https://homegrid.thepixelscout.com" required>
<label for="gateway">Gateway address</label><input id="gateway" name="gatewayUrl" type="url" value="https://homegrid-gateway.thepixelscout.com" required>
<label for="lan">Your Mac's LAN IP</label><input id="lan" name="lanIp" value="${ip}" required>
<label for="nvr">NVR IP</label><input id="nvr" name="nvrHost" value="192.168.4.37" required>
<label for="user">NVR read-only username</label><input id="user" name="nvrUser" maxlength="256" required>
<label for="nvr-password">NVR password</label><input id="nvr-password" name="nvrPassword" type="password" autocomplete="off" maxlength="256" required>
<label for="password">New household password (12–128 characters)</label><input id="password" name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required>
<label for="confirm">Confirm household password</label><input id="confirm" name="confirmation" type="password" minlength="12" maxlength="128" autocomplete="new-password" required>
<button type="submit">Save private setup</button><p class="note">Use a different password from your NVR. This setup page never sends credentials to Vercel or Cloudflare.</p></form></main></html>`;
const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  const actual = Buffer.from(request.url ?? ""),
    expected = Buffer.from(path);
  if (
    request.headers.host !== "127.0.0.1:8890" ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    response.writeHead(404).end("Not found");
    return;
  }
  if (completed) {
    response.end(
      "<h1>Private setup saved</h1><p>You can close this page. Continue with the Cloudflare connection.</p>",
    );
    return;
  }
  if (request.method === "GET") {
    response.end(html);
    return;
  }
  if (
    request.method !== "POST" ||
    request.headers.origin !== origin ||
    request.headers["content-type"] !== "application/x-www-form-urlencoded"
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
    await privateSetup(fields);
    completed = true;
    response.end(
      "<main><h1>Private setup saved</h1><p>Your credentials stayed on this Mac. You can close this page.</p></main>",
    );
    console.log(
      "Private setup saved successfully. No credentials were printed or sent online.",
    );
    setTimeout(() => server.close(() => process.exit(0)), 10000).unref();
  } catch {
    response
      .writeHead(400)
      .end(
        "<main><h1>Setup could not finish</h1><p>Check the addresses and password requirements, then go back and try again. Existing configuration is never overwritten.</p></main>",
      );
  } finally {
    submitting = false;
  }
});
server.listen(8890, "127.0.0.1", () => {
  writeFileSync(".tools/setup-url", `${origin}${path}`, { mode: 0o600 });
  console.log(`Open this private, one-time setup page: ${origin}${path}`);
});
setTimeout(() => server.close(() => process.exit(0)), 30 * 60 * 1000).unref();
