# HomeGrid web app — planned

This repository is reserved for the future Next.js browser viewer and its Vercel deployment. The working native app lives in [ip-cam-home-grid-macos-apple-silicon](https://github.com/sar-joshi/ip-cam-home-grid-macos-apple-silicon).

The first web version will show up to six Dahua camera feeds with camera selection, draggable tiles, per-camera mute/stop, focus mode and persistent layout/quality choices. Camera inputs remain RTSP. Browsers require a local media gateway to deliver compatible video over WebRTC.

Proposed flow:

`Dahua NVR → RTSP → authenticated gateway at home → WebRTC → Next.js grid`

For the current home-network-only requirement, the interface and gateway can run at home. If Vercel hosts the interface later, this repository will be its Git source. Vercel will host the UI, while a home machine runs the media gateway. Browser HTTPS/local-network access, gateway authentication and codec compatibility must be verified before enabling that deployment. Use standard H.264 substreams as the initial browser compatibility target.

NVR passwords and credential-bearing RTSP URLs belong only in the local gateway's private configuration. They must never appear in Git, frontend source, `NEXT_PUBLIC_*` variables, browser storage or Vercel preview deployments. Public UI hosting does not grant access to cameras on a private network. No cameras or gateway have been exposed online.

Future implementation should use feature branches and pull requests, build and test checks before merge, and production deployment from the protected `main` branch. Add Vercel preview deployments only after a working interface and authentication flow exist. This repository currently contains planning documentation; no web application or Vercel deployment has been created.
