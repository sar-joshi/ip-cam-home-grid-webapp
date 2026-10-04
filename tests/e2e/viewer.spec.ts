import { test, expect, type Request } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { defaults } from "@homegrid/shared";

test("password gate, real WebRTC video, controls, persistence, focus and logout", async ({
  page,
  context,
  browserName,
}) => {
  const errors: string[] = [];
  const pending = new Set<Request>();
  const cancelledByReload = new Set<Request>();
  const expectedAbortErrors = new Set<string>();
  const noteAbort = (path: string) => {
    if (
      browserName === "webkit" &&
      /^\/api\/streams\/cam-[1-6]\/[012]$/.test(path)
    )
      expectedAbortErrors.add(
        `/127.0.0.1:3000${path} due to access control checks.`,
      );
  };
  await page.exposeFunction("noteIntentionalStreamAbort", noteAbort);
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        window.location.href,
      );
      const signal = init?.signal;
      if (
        url.origin !== window.location.origin ||
        !/^\/api\/streams\/cam-[1-6]\/[012]$/.test(url.pathname) ||
        !signal
      )
        return originalFetch(input, init);
      const note = () => {
        // The app deliberately aborts on stop/focus/unmount. A timeout or real
        // CORS failure must still fail the browser-error assertion.
        if (
          signal.reason instanceof DOMException &&
          signal.reason.name === "AbortError"
        )
          void (
            window as typeof window & {
              noteIntentionalStreamAbort: (path: string) => Promise<void>;
            }
          ).noteIntentionalStreamAbort(url.pathname);
      };
      signal.addEventListener("abort", note, { once: true });
      return originalFetch(input, init).then(
        (response) => {
          signal.removeEventListener("abort", note);
          return response;
        },
        (error: unknown) => {
          signal.removeEventListener("abort", note);
          throw error;
        },
      );
    };
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/streams\/cam-/.test(request.url())
    )
      pending.add(request);
  });
  page.on("requestfinished", (request) => pending.delete(request));
  page.on("requestfailed", (request) => {
    pending.delete(request);
    // Linux WebKit reports some reload-cancelled fetches as access-control page
    // errors. Discount only requests this test cancelled that actually failed.
    if (browserName === "webkit" && cancelledByReload.has(request)) {
      const url = new URL(request.url());
      expectedAbortErrors.add(
        `/${url.host}${url.pathname} due to access control checks.`,
      );
    }
  });
  const reload = async () => {
    pending.forEach((request) => cancelledByReload.add(request));
    await page.reload();
  };
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
  // The household's preferences persist across browser contexts. Reset only
  // this synthetic household before exercising persistence inside this test.
  const fixture = await (await context.request.get("/api/bootstrap")).json();
  expect(
    (
      await context.request.put("/api/preferences", {
        headers: { Origin: "http://127.0.0.1:3000" },
        data: defaults(fixture.cameras),
      })
    ).status(),
  ).toBe(200);
  await reload();
  // Three columns put every video in view on iPhone; offscreen resume is tested
  // separately because WebKit may defer autoplay outside the viewport.
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
  await reload();
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
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.request.get("/api/bootstrap")).status()).toBe(401);
  expect(errors.filter((message) => !expectedAbortErrors.has(message))).toEqual(
    [],
  );
});
