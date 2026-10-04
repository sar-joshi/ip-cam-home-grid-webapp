import { test, expect } from "@playwright/test";
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
  if (hasAudio) {
    expect(audio).toBeTruthy();
    expect(Number(audio.nb_read_frames)).toBeGreaterThan(1);
  } else expect(audio).toBeUndefined();
}

test("password gate, real WebRTC video, controls, persistence, focus and logout", async ({
  page,
  context,
  browserName,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
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
  const stillDownload = page.waitForEvent("download");
  await second
    .getByRole("button", { name: "Snapshot Camera 2", exact: true })
    .click();
  const still = await stillDownload;
  expect(still.suggestedFilename()).toMatch(/\.png$/);
  const png = await readFile((await still.path())!);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.readUInt32BE(16)).toBe(640);
  expect(png.readUInt32BE(20)).toBe(360);
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
    const clipDownload = page.waitForEvent("download");
    await second
      .getByRole("button", { name: "Stop recording Camera 2", exact: true })
      .click();
    await verifyClip(await clipDownload);
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
  await page.getByRole("button", { name: "Close camera selection" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
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
