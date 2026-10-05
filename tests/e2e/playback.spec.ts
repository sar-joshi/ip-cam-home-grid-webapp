import { test, expect } from "./fixture.ts";
import { defaults } from "@homegrid/shared";

test("fast Sub 2 startup, autoplay recovery, background continuity and mobile columns", async ({
  page,
  context,
}, testInfo) => {
  const errors: string[] = [];
  let creates = 0,
    deletes = 0,
    patches = 0,
    heartbeats = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      /\/api\/streams\/cam-/.test(request.url()) &&
      request.method() === "POST"
    )
      creates++;
    if (/\/api\/streams\/sessions\//.test(request.url())) {
      if (request.method() === "DELETE") deletes++;
      if (request.method() === "PATCH") patches++;
    }
    if (request.url().endsWith("/api/heartbeat")) heartbeats++;
  });
  // Start with the user's failing combination: Camera 1 Sub 2, six tiles.
  const headers = { Origin: "http://127.0.0.1:3000" };
  expect(
    (
      await context.request.post("/api/auth/login", {
        headers,
        data: { password: "synthetic-viewer-password" },
      })
    ).status(),
  ).toBe(200);
  const bootstrap = await (await context.request.get("/api/bootstrap")).json();
  const preferences = defaults(bootstrap.cameras);
  preferences.cameras["cam-1"].quality = "2";
  expect(
    (
      await context.request.put("/api/preferences", {
        headers,
        data: preferences,
      })
    ).status(),
  ).toBe(200);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    // The first Sub 2 peer has video but no audio, matching this Dahua NVR.
    const addTransceiver = RTCPeerConnection.prototype.addTransceiver;
    const firstVideoPeer = new WeakSet<RTCPeerConnection>();
    let foundVideoPeer = false;
    RTCPeerConnection.prototype.addTransceiver = function (track, init) {
      if (track === "video" && !foundVideoPeer) {
        firstVideoPeer.add(this);
        foundVideoPeer = true;
      }
      return addTransceiver.call(
        this,
        track,
        track === "audio" && firstVideoPeer.has(this)
          ? { ...init, direction: "inactive" }
          : init,
      );
    };
    const nativePeer = window.RTCPeerConnection;
    (window as typeof window & { audioPeers: RTCPeerConnection[] }).audioPeers =
      [];
    window.RTCPeerConnection = new Proxy(nativePeer, {
      construct(Target, args) {
        const peer = new Target(...args);
        (
          window as typeof window & { audioPeers: RTCPeerConnection[] }
        ).audioPeers.push(peer);
        return peer;
      },
    });
    // Reproduce an autoplay refusal without breaking the underlying WebRTC peer.
    let allowPlayback = false;
    const originalPlay = HTMLMediaElement.prototype.play;
    const originalPaused = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "paused",
    )!.get!;
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get() {
        // Keep the simulated policy deterministic even if Linux WebKit briefly
        // schedules native autoplay before the overridden play method runs.
        if (
          this.getAttribute("aria-label") === "Camera 1 live video" &&
          !allowPlayback
        )
          return true;
        return originalPaused.call(this);
      },
    });
    HTMLMediaElement.prototype.play = function () {
      if (
        this.getAttribute("aria-label") === "Camera 1 live video" &&
        !allowPlayback
      ) {
        this.autoplay = false;
        this.pause();
        return Promise.reject(
          new DOMException("User gesture required", "NotAllowedError"),
        );
      }
      return originalPlay.call(this);
    };
    // Some engines schedule native autoplay before the overridden play method.
    // Enforce the simulated policy before the player's readiness listener runs.
    document.addEventListener(
      "playing",
      (event) => {
        const video = event.target as HTMLMediaElement;
        if (
          video.getAttribute("aria-label") === "Camera 1 live video" &&
          !allowPlayback
        )
          video.pause();
      },
      true,
    );
    document.addEventListener(
      "click",
      (event) => {
        if (
          (event.target as HTMLElement)
            .closest("button")
            ?.textContent?.trim() === "Play video"
        )
          allowPlayback = true;
      },
      true,
    );
    // An interface can keep gathering indefinitely. Negotiation must still start.
    Object.defineProperty(RTCPeerConnection.prototype, "iceGatheringState", {
      get: () => "gathering",
    });
    const originalRemote = RTCPeerConnection.prototype.setRemoteDescription as (
      this: RTCPeerConnection,
      description: RTCSessionDescriptionInit,
    ) => Promise<void>;
    RTCPeerConnection.prototype.setRemoteDescription = async function (
      description,
    ) {
      await originalRemote.call(this, description);
      // Video may start before this promise resolves (the original readiness race).
      await new Promise((resolve) => setTimeout(resolve, 600));
    };
  });
  await page.clock.install();
  await page.goto("/");
  const first = page.getByRole("article", { name: "Camera 1", exact: true });
  await expect(first.getByRole("button", { name: "Play video" })).toBeVisible({
    timeout: 7000,
  });
  await expect(page.locator(".status-live")).toHaveCount(5, { timeout: 7000 });
  await first.getByRole("button", { name: "Play video" }).click();
  await expect(page.locator(".status-live")).toHaveCount(6, { timeout: 7000 });
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluateAll((videos) =>
          videos.every(
            (video) =>
              (video as HTMLVideoElement).videoWidth === 640 &&
              (video as HTMLVideoElement).currentTime > 0,
          ),
        ),
    )
    .toBe(true);
  expect(creates).toBe(6);
  await expect.poll(() => patches).toBeGreaterThan(0);
  const streamIds = await page
    .locator("video")
    .evaluateAll((videos) =>
      videos.map(
        (video) => ((video as HTMLVideoElement).srcObject as MediaStream).id,
      ),
    );
  const beforeHide = heartbeats;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    document.querySelectorAll("video").forEach((video) => video.pause());
  });
  await expect.poll(() => heartbeats).toBeGreaterThan(beforeHide);
  const atHide = heartbeats;
  // Simulate the minute timer throttling used by background desktop tabs.
  await page.clock.fastForward(65000);
  await expect.poll(() => heartbeats).toBeGreaterThan(atHide);
  expect(creates).toBe(6);
  expect(deletes).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluateAll((videos) =>
          videos.every((video) => !(video as HTMLVideoElement).paused),
        ),
    )
    .toBe(true);
  expect(
    await page
      .locator("video")
      .evaluateAll((videos) =>
        videos.map(
          (video) => ((video as HTMLVideoElement).srcObject as MediaStream).id,
        ),
      ),
  ).toEqual(streamIds);
  // iOS can pause offscreen video. Scrolling it back must resume the same peer.
  await page.getByLabel("Grid columns").selectOption("1");
  const last = page.getByRole("article", { name: "Camera 6", exact: true });
  await first.scrollIntoViewIfNeeded();
  await last
    .locator("video")
    .evaluate((video) => (video as HTMLVideoElement).pause());
  await page.clock.fastForward(25000);
  expect(creates).toBe(6);
  await last.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      last
        .locator("video")
        .evaluate((video) => (video as HTMLVideoElement).paused),
    )
    .toBe(false);
  expect(creates).toBe(6);
  expect(deletes).toBe(0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const columns of [1, 2, 3]) {
      await page.getByLabel("Grid columns").selectOption(String(columns));
      await expect
        .poll(() =>
          page
            .locator(".camera-grid")
            .evaluate(
              (grid) =>
                getComputedStyle(grid).gridTemplateColumns.split(" ").length,
            ),
        )
        .toBe(columns);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect(
        await page
          .getByRole("article")
          .evaluateAll((tiles) =>
            tiles.every((tile) => tile.scrollWidth <= tile.clientWidth),
          ),
      ).toBe(true);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Grid columns").selectOption("2");
  await first.scrollIntoViewIfNeeded();
  await first
    .getByRole("button", { name: "Unmute Camera 1", exact: true })
    .click();
  await expect(first.getByText("Audio from Sub 1.")).toBeVisible({
    timeout: 10000,
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const peers = (
          window as typeof window & { audioPeers: RTCPeerConnection[] }
        ).audioPeers;
        const audioPeer = peers.find(
          (peer) => peer.getTransceivers().length === 1,
        );
        if (!audioPeer) return false;
        return [...(await audioPeer.getStats()).values()].some(
          (report) =>
            report.type === "inbound-rtp" &&
            report.kind === "audio" &&
            report.bytesReceived > 0,
        );
      }),
    )
    .toBe(true);
  expect(creates).toBe(7);
  expect(
    await first
      .locator("video")
      .evaluate(
        (video) => ((video as HTMLVideoElement).srcObject as MediaStream).id,
      ),
  ).toBe(streamIds[0]);
  // Preserve the three choices; unsupported choices should select and save the
  // camera's preferred fallback once rather than alternating failed profiles.
  await page.route("**/api/streams/cam-3/2", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"Camera unavailable"}',
    }),
  );
  await page.route("**/api/streams/cam-1/0", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"Camera unavailable"}',
    }),
  );
  await page.getByLabel("Camera 3 quality", { exact: true }).selectOption("2");
  await expect(
    page.getByLabel("Camera 3 quality", { exact: true }),
  ).toHaveValue("1");
  await expect(
    page
      .getByRole("article", { name: "Camera 3", exact: true })
      .locator(".status-live"),
  ).toHaveCount(1);
  await page.getByLabel("Camera 1 quality", { exact: true }).selectOption("0");
  await expect(
    page.getByLabel("Camera 1 quality", { exact: true }),
  ).toHaveValue("2");
  await expect(first.locator(".status-live")).toHaveCount(1);
  await expect(first.locator("select option")).toHaveCount(3);
  await page.clock.fastForward(1000);
  await expect(page.getByRole("status")).toHaveText("Saved");
  const saved = await (await context.request.get("/api/bootstrap")).json();
  expect(saved.preferences.cameras["cam-3"].quality).toBe("1");
  expect(saved.preferences.cameras["cam-1"].quality).toBe("2");
  await page.screenshot({ path: testInfo.outputPath("mobile-grid.png") });
  await first
    .getByRole("button", { name: "Stop Camera 1", exact: true })
    .click();
  await expect(first.getByText("Stream stopped")).toBeVisible();
  await first
    .getByRole("button", { name: "Start Camera 1", exact: true })
    .click();
  await expect(first.locator(".status-live")).toHaveCount(1);
  await first
    .getByRole("button", { name: "Focus Camera 1", exact: true })
    .click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Restore grid from Camera 1" })
    .click();
  await expect(page.getByRole("article")).toHaveCount(6);
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});
