import { test, expect } from "./fixture.ts";
import { AxeBuilder } from "@axe-core/playwright";
import { defaults } from "@homegrid/shared";

test("private NVR setup saves names, channels and visibility, reconnects, and survives reload", async ({
  page,
  context,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const headers = { Origin: "http://127.0.0.1:3000" };
  expect((await context.request.get("/api/settings")).status()).toBe(401);
  expect(
    (
      await context.request.post("/api/auth/login", {
        headers,
        data: { password: "synthetic-viewer-password" },
      })
    ).status(),
  ).toBe(200);
  const original = await (await context.request.get("/api/settings")).json();
  expect(JSON.stringify(original)).not.toContain("synthetic-camera-only");
  expect(JSON.stringify(original)).not.toContain('"username"');
  expect(JSON.stringify(original)).not.toContain('"password"');
  expect(
    (
      await context.request.put("/api/preferences", {
        headers,
        data: defaults(original.cameras),
      })
    ).status(),
  ).toBe(200);
  try {
    await page.goto("/");
    await expect(page.locator(".status-live")).toHaveCount(6, {
      timeout: 45000,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "NVR & cameras", exact: true })
      .click();
    const modal = page.getByRole("dialog", {
      name: "NVR & cameras",
      exact: true,
    });
    await expect(modal.getByLabel("Username", { exact: true })).toHaveValue("");
    await expect(modal.getByLabel("NVR password", { exact: true })).toHaveValue(
      "",
    );
    await modal
      .getByLabel("Camera 1 name", { exact: true })
      .fill("Driveway test");
    await modal.getByLabel("Camera 1 channel", { exact: true }).fill("7");
    await modal.getByLabel("Show Camera 6", { exact: true }).uncheck();
    await modal
      .getByLabel("Confirm household password", { exact: true })
      .fill("synthetic-viewer-password");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("nvr-settings.png") });
    await modal
      .getByRole("button", { name: "Save & apply", exact: true })
      .click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole("article")).toHaveCount(5);
    await expect(
      page.getByRole("article", { name: "Driveway test", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".status-live")).toHaveCount(5, {
      timeout: 45000,
    });
    await page.reload();
    await expect(page.getByRole("article")).toHaveCount(5);
    await page
      .getByRole("button", { name: "NVR & cameras", exact: true })
      .click();
    await expect(
      modal.getByLabel("Camera 1 channel", { exact: true }),
    ).toHaveValue("7");
    await expect(
      modal.getByLabel("Show Camera 6", { exact: true }),
    ).not.toBeChecked();
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".status-live")).toHaveCount(5, {
      timeout: 45000,
    });
    expect(errors).toEqual([]);
  } finally {
    await page.goto("about:blank");
    const current = await (await context.request.get("/api/settings")).json();
    expect(
      (
        await context.request.put("/api/settings", {
          headers,
          data: {
            revision: current.revision,
            nvr: {
              host: original.nvr.host,
              port: original.nvr.port,
              username: "",
              password: "",
            },
            cameras: original.cameras,
            householdPassword: "synthetic-viewer-password",
          },
        })
      ).status(),
    ).toBe(200);
    await context.request.post("/api/auth/logout", { headers, data: {} });
  }
});
