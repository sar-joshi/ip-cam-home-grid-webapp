import { test, expect } from "./fixture.ts";
import { AxeBuilder } from "@axe-core/playwright";
import { defaults } from "@homegrid/shared";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import type { Download } from "@playwright/test";

async function verifyClip(download: Download, hasAudio = true) {
  expect(download.suggestedFilename()).toMatch(
    /^HomeGrid-Camera-2-.*\.(mp4|webm)$/,
  );
  const path = await download.path();
  expect(path).toBeTruthy();
  const metadata = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-count_frames", "-show_streams", "-of", "json", path!],
      { encoding: "utf8" },
    ),
  );
  const video = metadata.streams.find(
    (stream: { codec_type: string }) => stream.codec_type === "video",
  );
  const audio = metadata.streams.find(
    (stream: { codec_type: string }) => stream.codec_type === "audio",
  );
  expect(video.width).toBe(640);
  expect(video.height).toBe(360);
  expect(Number(video.nb_read_frames)).toBeGreaterThan(10);
  if (download.suggestedFilename().endsWith(".mp4"))
    expect(video.codec_name).toBe("h264");
  if (hasAudio) {
    expect(audio).toBeTruthy();
    expect(Number(audio.nb_read_frames)).toBeGreaterThan(1);
    if (download.suggestedFilename().endsWith(".mp4")) {
      expect(audio.codec_name).toBe("aac");
      expect(audio.sample_rate).toBe("48000");
    }
  } else expect(audio).toBeUndefined();
}

test("password gate, real WebRTC video, controls, persistence, focus and logout", async ({
  page,
  context,
  browserName,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const blockedImages: string[] = [];
    Reflect.set(window, "qaBlockedImages", blockedImages);
    document.addEventListener("securitypolicyviolation", (event) => {
      if (event.effectiveDirective === "img-src")
        blockedImages.push(event.blockedURI.split(":")[0]);
    });
  });
  // Reset this synthetic household before the successful login response reaches
  // the UI, so fixture setup never opens streams just to discard them on reload.
  await page.route("**/api/auth/login", async (route) => {
    const response = await route.fetch();
    if (response.status() === 200) {
      const cookie = response
        .headersArray()
        .filter((header) => header.name.toLowerCase() === "set-cookie")
        .map((header) => header.value.split(";")[0])
        .join("; ");
      const fixture = await (
        await context.request.get("/api/bootstrap", { headers: { cookie } })
      ).json();
      expect(
        (
          await context.request.put("/api/preferences", {
            headers: { Origin: "http://127.0.0.1:3000", cookie },
            data: defaults(fixture.cameras),
          })
        ).status(),
      ).toBe(200);
    }
    await route.fulfill({ response });
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Unlock HomeGrid" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const unauthed = await context.request.get("/api/bootstrap");
  expect(unauthed.status()).toBe(401);
  const csrf = await context.request.post("/api/auth/login", {
    headers: { Origin: "https://evil.invalid" },
    data: { password: "synthetic-viewer-password" },
  });
  expect(csrf.status()).toBe(403);
  if (browserName === "chromium") {
    await page.getByLabel("Password", { exact: true }).fill("wrong");
    await page.getByRole("button", { name: "Unlock cameras" }).click();
    await expect(page.locator("#login-error")).toHaveText(
      "Password not accepted.",
    );
  }
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic-viewer-password");
  await page.getByRole("button", { name: "Unlock cameras" }).click();
  await expect(
    page.getByRole("heading", { name: "Your cameras" }),
  ).toBeVisible();
  await expect(page.locator(".status-live")).toHaveCount(6, { timeout: 45000 });
  await expect
    .poll(async () =>
      page.locator("video").evaluateAll((elements) =>
        elements.every((element) => {
          const v = element as HTMLVideoElement;
          return v.videoWidth === 640 && v.currentTime > 0;
        }),
      ),
    )
    .toBe(true);
  const bootstrap = await context.request.get("/api/bootstrap");
  const text = await bootstrap.text();
  expect(text).not.toContain("synthetic-camera-only");
  expect(text).not.toContain("rtsp://");
  const cookies = await context.cookies();
  expect(
    cookies
      .filter((c) => c.name.includes("homegrid"))
      .every((c) => c.httpOnly && c.sameSite === "Strict"),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole("button", { name: "Stop Camera 1", exact: true })
    .click();
  await expect(
    page
      .getByRole("article", { name: "Camera 1", exact: true })
      .getByText("Stream stopped"),
  ).toBeVisible();
  await page
    .getByRole("article", { name: "Camera 2", exact: true })
    .locator(".video-surface")
    .dblclick();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("article")).toHaveCount(6);
  await expect(
    page
      .getByRole("article", { name: "Camera 1", exact: true })
      .getByText("Stream stopped"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Move Camera 1", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("article").first()).toHaveAccessibleName(
    "Camera 2",
  );
  await page.getByLabel("Camera 2 quality", { exact: true }).selectOption("2");
  await page
    .getByRole("button", { name: "Unmute Camera 2", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Mute Camera 2", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(page.locator(".status-live")).toHaveCount(5, { timeout: 45000 });
  await page.reload();
  await expect(page.getByRole("article").first()).toHaveAccessibleName(
    "Camera 2",
  );
  await expect(
    page.getByLabel("Camera 2 quality", { exact: true }),
  ).toHaveValue("2");
  await expect(
    page
      .getByRole("article", { name: "Camera 1", exact: true })
      .getByText("Stream stopped"),
  ).toBeVisible();
  const second = page.getByRole("article", { name: "Camera 2", exact: true });
  await expect
    .poll(
      async () =>
        (await second.locator(".status-live, .status-tap-to-play").count()) > 0,
    )
    .toBe(true);
  const play = second.getByRole("button", { name: "Play video" });
  if (await play.isVisible()) await play.click();
  await expect(page.locator(".status-live")).toHaveCount(5, { timeout: 45000 });
  const streamBeforeCapture = await second
    .locator("video")
    .evaluate(
      (video) => ((video as HTMLVideoElement).srcObject as MediaStream).id,
    );
  await second
    .getByRole("button", { name: "Snapshot Camera 2", exact: true })
    .click();
  const preview = page.getByRole("dialog", { name: "Capture preview" });
  const previewImage = preview.getByAltText("Captured camera snapshot");
  await expect(previewImage).toBeVisible();
  await expect
    .poll(
      () =>
        previewImage.evaluate((image) => ({
          width: (image as HTMLImageElement).naturalWidth,
          height: (image as HTMLImageElement).naturalHeight,
        })),
      { timeout: 5000 },
    )
    .toEqual({ width: 640, height: 360 });
  expect(
    await page.evaluate(() => Reflect.get(window, "qaBlockedImages")),
  ).toEqual([]);
  await previewImage.evaluate((image) => (image as HTMLImageElement).decode());
  await preview.screenshot({
    path: testInfo.outputPath("snapshot-preview.png"),
  });
  await page.evaluate(() => {
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: (data: ShareData) => data.files?.length === 1,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: ShareData) => {
        Reflect.set(
          window,
          "qaShared",
          data.files?.map((file) => ({ name: file.name, type: file.type })),
        );
      },
    });
  });
  await preview
    .getByRole("button", { name: "Photos / Share", exact: true })
    .click();
  expect(await page.evaluate(() => Reflect.get(window, "qaShared"))).toEqual([
    { name: expect.stringMatching(/\.png$/), type: "image/png" },
  ]);
  await expect(second.locator(".capture-message")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const stillDownload = page.waitForEvent("download");
  await preview
    .getByRole("link", { name: "Save to Files", exact: true })
    .click();
  const still = await stillDownload;
  expect(still.suggestedFilename()).toMatch(/\.png$/);
  const png = await readFile((await still.path())!);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.readUInt32BE(16)).toBe(640);
  expect(png.readUInt32BE(20)).toBe(360);
  await expect(second.locator(".capture-message")).toHaveCount(0);
  await preview.getByRole("button", { name: "Close capture preview" }).click();
  await expect(second.locator(".capture-message")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: `Preview ${still.suggestedFilename()}`,
      exact: true,
    })
    .click();
  await previewImage.evaluate((image) => (image as HTMLImageElement).decode());
  expect(
    await previewImage.evaluate(
      (image) => (image as HTMLImageElement).naturalWidth,
    ),
  ).toBe(640);
  await preview.getByRole("button", { name: "Close capture preview" }).click();
  await second
    .getByRole("button", { name: "Snapshot Camera 2", exact: true })
    .click();
  await expect(previewImage).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).not.toBeVisible();
  await expect(second.locator(".capture-message")).toHaveCount(0);
  const capabilities = await page.evaluate(() => ({
    api: typeof MediaRecorder !== "undefined",
    formats:
      typeof MediaRecorder === "undefined"
        ? []
        : [
            "video/webm;codecs=vp8,opus",
            "video/webm",
            "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
            "video/mp4",
          ].filter((type) => MediaRecorder.isTypeSupported(type)),
  }));
  console.log("Recording capabilities:", JSON.stringify(capabilities));
  const canRecord = capabilities.formats.length > 0;
  if (canRecord) {
    await second
      .getByRole("button", { name: "Record Camera 2", exact: true })
      .click();
    await expect(
      second.getByLabel("Camera 2 quality", { exact: true }),
      (await second.locator(".capture-message").textContent()) ??
        "Preparing recording",
    ).toBeDisabled();
    await expect(
      second.getByRole("button", { name: "Mute Camera 2", exact: true }),
    ).toBeDisabled();
    await expect(second.locator(".capture-message")).toContainText("0:02", {
      timeout: 8000,
    });
    await second
      .getByRole("button", { name: "Snapshot Camera 2", exact: true })
      .click();
    await expect(previewImage).toBeVisible();
    await preview
      .getByRole("button", { name: "Close capture preview" })
      .click();
    await expect(second.locator(".capture-message")).toContainText(
      "Recording video and audio.",
    );
    const clipDownload = page.waitForEvent("download");
    await second
      .getByRole("button", { name: "Stop recording Camera 2", exact: true })
      .click();
    const previewVideo = preview.getByLabel("Recorded clip preview");
    await expect
      .poll(() =>
        previewVideo.evaluate(
          (element) => (element as HTMLVideoElement).videoWidth,
        ),
      )
      .toBe(640);
    await previewVideo.evaluate((element) =>
      (element as HTMLVideoElement).play(),
    );
    await expect
      .poll(() =>
        previewVideo.evaluate(
          (element) => (element as HTMLVideoElement).currentTime,
        ),
      )
      .toBeGreaterThan(0);
    await preview
      .getByRole("button", { name: "Photos / Share", exact: true })
      .click();
    const shared = (await page.evaluate(() =>
      Reflect.get(window, "qaShared"),
    )) as { name: string; type: string }[];
    if (
      capabilities.formats.includes("video/mp4;codecs=avc1.42E01E,mp4a.40.2")
    ) {
      expect(shared[0].name).toMatch(/\.mp4$/);
      expect(shared[0].type).toContain("video/mp4");
    }
    await expect(second.locator(".capture-message")).toHaveCount(0);
    await preview
      .getByRole("link", { name: "Save to Files", exact: true })
      .click();
    await verifyClip(await clipDownload);
    await expect(second.locator(".capture-message")).toHaveCount(0);
    await preview
      .getByRole("button", { name: "Close capture preview" })
      .click();
    await expect(second.locator(".capture-message")).toHaveCount(0);
    await expect(
      second.getByLabel("Camera 2 quality", { exact: true }),
    ).toBeEnabled();
  } else {
    await second
      .getByRole("button", { name: "Record Camera 2", exact: true })
      .click();
    await expect(second.locator(".capture-message")).toHaveText(
      capabilities.api
        ? "This browser cannot record this video format."
        : "Recording is unavailable in this browser.",
    );
    await expect(
      second.getByLabel("Camera 2 quality", { exact: true }),
    ).toBeEnabled();
  }
  expect(
    await second
      .locator("video")
      .evaluate(
        (video) => ((video as HTMLVideoElement).srcObject as MediaStream).id,
      ),
  ).toBe(streamBeforeCapture);
  await expect(page.locator(".status-live")).toHaveCount(5);
  await page.getByRole("button", { name: "Cameras 6", exact: true }).click();
  await page.getByRole("checkbox", { name: /Camera 6/ }).uncheck();
  await expect(page.getByRole("article")).toHaveCount(5);
  expect(
    await page
      .getByRole("region", { name: "Camera selection" })
      .evaluate((chooser) => {
        const box = chooser.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth;
      }),
  ).toBe(true);
  await page.getByRole("button", { name: "Close camera selection" }).click();
  await expect(
    page.getByRole("button", { name: "Close camera selection" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("capture-controls.png"),
    fullPage: true,
  });
  if (canRecord) {
    await second
      .getByRole("button", { name: "Mute Camera 2", exact: true })
      .click();
    await second
      .getByRole("button", { name: "Record Camera 2", exact: true })
      .click();
    await expect(second.locator(".capture-message")).toContainText("0:01", {
      timeout: 8000,
    });
    const lockedClip = page.waitForEvent("download");
    await page.getByRole("button", { name: "Lock", exact: true }).click();
    await verifyClip(await lockedClip, false);
  } else await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.request.get("/api/bootstrap")).status()).toBe(401);
  expect(errors).toEqual([]);
});
