# HomeGrid web

A private Next.js camera grid for six Dahua NVR channels. Vercel hosts the interface; a small gateway on your home Mac reads RTSP and delivers WebRTC video directly to browsers on the same home network. The gateway can later move to a Raspberry Pi 5 running 64-bit Linux.

## What it does

- Select cameras and choose one, two, or three grid columns. Small screens use a single column.
- Drag cameras to swap positions; keyboard users can move tiles with the grip's left/right arrow keys.
- Mute, stop/start, and switch Main/Sub 1/Sub 2 independently per camera.
- Double-click a camera or press its focus button to enlarge it; Escape restores the grid. Hidden tiles release their streams and explicitly stopped cameras stay stopped.
- Save camera selection, ordering, quality, mute, and stop choices in local SQLite.
- Use one household password with an eight-hour maximum session. Lock closes the current session's media streams and returns to the password screen.
- Pause video while the browser tab is hidden. Reconnect with capped backoff when a stream stalls or the connection drops.

## Architecture

```text
Browser ── HTTPS ── Vercel / Next.js ── authenticated HTTPS ── Cloudflare Tunnel
                                                               │
                                                     HomeGrid gateway / SQLite
                                                               │
Dahua NVR ── RTSP/TCP ── MediaMTX on the Mac ── encrypted WebRTC ─┘ Browser on LAN
```

Vercel handles the interface, authentication requests and WebRTC signaling. The gateway owns password hashes, sessions, rate limits, preferences and media leases. Video bypasses Vercel and Cloudflare: it stays on the LAN. The Mac must be awake whenever you view cameras. Eero only routes the traffic; it cannot run this application's gateway. There is no external database, storage, analytics, recording or camera upload.

SQLite requires persistent disk and is therefore kept at home. Vercel functions do not provide shared permanent filesystem storage; see [Vercel's SQLite guidance](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel).

## Private setup

Requires Node.js 24, npm, and an Apple silicon Mac (or Linux x64/arm64). No public camera-player repository is cloned. MediaMTX is downloaded from its official release and verified against pinned SHA-256 checksums.

```sh
npm ci
npm run install:media
npm run setup:web
```

Open the one-time loopback URL printed by setup. Enter the NVR IP and a read-only streaming account, its password, and a separate household password of 12–128 characters. These entries stay on the Mac. The terminal alternative is `npm run setup` with hidden password entry.

Setup writes ignored `gateway.env`, `apps/web/.env.local`, and `state/homegrid.sqlite`. Configuration/database files have owner-only permissions. Never commit, publish or share these files. NVR credentials are plaintext in private gateway environment/configuration because the gateway must authenticate to the NVR; enable FileVault and restrict access to the gateway account. Household passwords use Better Auth's salted scrypt hash.

Default camera IDs `cam-1` through `cam-6` map to NVR channels 1–6. Set private `CAMERAS_JSON` in `gateway.env` to change names/channels; `.env.example` shows the format. Use an eero DHCP reservation for the Mac/Pi and set `GATEWAY_LAN_IP` to that address.

```sh
npm run gateway
```

MediaMTX reads RTSP only and performs packet forwarding rather than video transcoding. Its HTTP listener is on loopback, protected with a separate random credential; unused media protocols, recording and public management APIs are disabled. Its encrypted WebRTC media sockets use the specified LAN IP on TCP/UDP 8189. Allow those connections from your home network in the Mac firewall; do not forward these ports from the Internet.

## Dahua stream settings

Browsers need compatible codecs. Use standard **H.264 without B-frames**, preferably Baseline, and disable AI/Smart/plus codec modes for the streams used by the web viewer. H.265 main streams can still be used by the native app, but are not a portable browser target. This app changes `subtype` only; configure encoding in Dahua manually. [MediaMTX browser codec guidance](https://mediamtx.org/docs/features/webrtc-specific-features).

| Stream | Subtype | Starting settings |
|---|---|---|
| Main | 0 | Highest supported resolution; 20–25 fps; begin at 6–10 Mbps for 4K H.264 and adjust to the scene |
| Sub 1 | 1 | 1280×720 if supported; 10–15 fps; 0.7–1.5 Mbps |
| Sub 2 | 2 | 352×288 or 640×360; 5–10 fps; 0.2–0.5 Mbps |

Enable both substreams. Set an I-frame interval of roughly one second, e.g. 15 at 15 fps. Use CBR initially. These are starting points, not model-specific guarantees; use the resolutions offered by each camera. Your screenshot's 352×288 Sub 1 is usable, but cannot provide HD detail. Audio mute works when the source contains a browser-supported track (Opus, G.711 or supported G.722); AAC may need separate audio transcoding, which this lightweight version does not perform.

## Cloudflare and Vercel

Use separate subdomains, such as `homegrid.example.com` (Vercel) and `homegrid-gateway.example.com` (Cloudflare Tunnel).

1. Authorize the official `cloudflared` connector and create a named tunnel. Its only ingress is `http://127.0.0.1:8787`; the catch-all returns HTTP 404. Do not expose the NVR, MediaMTX, SQLite, or private setup page.
2. Connect the tunnel hostname in Cloudflare DNS. The HomeGrid gateway rejects every request without the random service token. Browser JavaScript never receives that token. Keep tunnel credentials in private `state/cloudflare/`.
3. Import this GitHub repository in Vercel. Select Next.js, Node.js 24, and **Root Directory `apps/web`** with files outside the root directory included. Use production branch `main`.
4. Add only `HOMEGRID_APP_ORIGIN`, `GATEWAY_URL`, and `GATEWAY_SERVICE_TOKEN` to Vercel's **production** environment. With the project linked, `npm run vercel:env` copies this explicit allowlist through stdin without printing values. **Never upload NVR_USERNAME or NVR_PASSWORD, and never use NEXT_PUBLIC for secrets.**
5. Add the viewer domain in Vercel and create its recommended DNS record in Cloudflare with proxy disabled. Redeploy production after setting variables. Preview deployments receive no production gateway credentials and fail closed.

With the chosen domains connected, visit the viewer on your home network and enter your household password. Approve the browser's local-network permission if requested. The interface can load while away, but LAN-only media needs a VPN or a separately designed remote-media path; this version does not expose video ports or add third-party STUN/TURN servers.

## Security and operations

Authentication uses Better Auth with SQLite-backed opaque sessions and HttpOnly, Secure, SameSite=Strict cookies on HTTPS. Every private endpoint validates the session at the gateway; protecting the page alone is insufficient. Public registration/reset endpoints are absent. Five household login attempts per minute are persisted atomically in SQLite and cannot be bypassed by forged client IP headers. This household-wide limit can temporarily throttle everyone after repeated failures.

State-changing requests require the exact configured viewer origin. The frontend uses a nonce-based CSP, denies framing, disables camera/microphone capture, avoids private-response caching, and serves no third-party scripts or fonts. Camera URLs and credentials are absent from frontend props and API DTOs. HTTP request bodies are bounded. Errors/logs omit upstream RTSP URLs and credentials.

Each media connection belongs to its login session. A 15-second heartbeat renews a 45-second lease. Logout revokes its streams immediately; expiry, revoked sessions or a disconnected client are cleaned up within five seconds after lease/session expiry. Idle source connections close one second after the last viewer. Stopping/focusing/closing tiles releases browser peers/tracks. A stalled source retries with backoff capped around 30 seconds. Authentication failures keep playback closed.

Change the household password locally with `npm run password:reset`; this revokes all sessions. Back up the private `state/` directory and `gateway.env` together using encrypted local backups. To migrate to the Pi, stop the Mac gateway/tunnel, transfer those private files securely, install Node 24 and verified Linux arm64 MediaMTX, update the LAN IP/binary path, and start the same named tunnel. Use a separate read-only NVR account and keep dependencies patched.

## Development and verification

```sh
npm run verify
npm audit --audit-level=high
npm run install:media
npx playwright install chromium
npm run test:e2e
```

E2E requires FFmpeg and a free localhost port 3000. It starts isolated synthetic H.264 RTSP cameras, a real MediaMTX gateway and the production Next.js server. It does not read your private setup, native app settings, or Keychain. Tests cover actual decoded WebRTC video, authentication, origins, persistence, tile controls, focus/restore, mobile layout, accessibility, and logout. GitHub Actions runs the same checks; feature branches merge through pull requests after required checks pass.

For a synthetic local preview: `npx tsx scripts/test-stack.ts`, then visit `http://127.0.0.1:3000` and use the documented **test-only** password `synthetic-viewer-password`. This stack creates a temporary database with fake NVR credentials; it never creates a production/demo bypass.
