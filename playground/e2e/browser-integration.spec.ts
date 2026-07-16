import { expect, test } from "@playwright/test";

const hostUrl = "http://127.0.0.1:5173";

test("the host hydrates while its server-composed fragment is still streaming", async ({
  page,
}) => {
  await page.goto(`${hostUrl}/?integration=active-hydration`, {
    waitUntil: "commit",
  });

  const host = page.locator("[data-micro-frame-state]");
  await expect(host).toHaveAttribute("data-micro-frame-state", "streaming");
  await expect(host.locator("[data-active-stream]")).toBeVisible();
  await expect(host.locator("[data-active-stream-complete]")).toHaveCount(0);

  await page.getByRole("button", { name: "Confirm hydration" }).click();
  await expect(page.locator("[data-hydration-confirmed]")).toHaveText(
    "Hydrated",
    { timeout: 1_000 },
  );
  await expect(host.locator("[data-active-stream-complete]")).toHaveCount(0);

  await expect(host.locator("[data-active-stream-complete]")).toBeVisible();
  await expect(host).toHaveAttribute("data-micro-frame-state", "complete");
});

test("browser streaming preserves blocking script execution order", async ({
  page,
}) => {
  await page.goto(`${hostUrl}/?integration=blocking-script`);

  const host = page.locator("[data-micro-frame-state]");
  const fixture = host.locator('[data-browser-fixture="blocking-script"]');
  await expect(fixture).toHaveAttribute("data-script-order", "external-1,inline");
  await expect(host).toHaveAttribute("data-micro-frame-state", "complete");

  await page.getByRole("button", { name: "Reload fixture" }).click();

  await expect(host).toHaveAttribute("data-micro-frame-state", "streaming");
  await expect(host.locator("[data-after-script]")).toHaveCount(0);
  await expect(fixture).toHaveAttribute("data-script-order", "external-2,inline");
  await expect(host.locator("[data-after-script]")).toHaveText(
    "Content after the blocking script.",
  );
  await expect(host).toHaveAttribute("data-micro-frame-state", "complete");
});

test("browser streaming waits for blocking styles before revealing content", async ({
  page,
}) => {
  await page.goto(`${hostUrl}/?integration=blocking-style`);

  const host = page.locator("[data-micro-frame-state]");
  const styledContent = host.locator("[data-styled-content]");
  await expect(styledContent).toHaveCSS("color", "rgb(12, 34, 56)");

  await page.getByRole("button", { name: "Reload fixture" }).click();

  await expect(host).toHaveAttribute("data-micro-frame-state", "streaming");
  await expect(styledContent).toHaveCount(0);
  await expect(styledContent).toHaveCSS("color", "rgb(12, 34, 56)");
  await expect(host).toHaveAttribute("data-micro-frame-state", "complete");
});

test("browser streaming preloads later assets while a stylesheet blocks", async ({
  page,
}) => {
  let stylesheetLoaded = false;
  let imageStartedBeforeStylesheet = false;

  page.on("response", (response) => {
    if (response.url().includes("blocking-preload.css?version=2")) {
      stylesheetLoaded = true;
    }
  });
  page.on("request", (request) => {
    if (request.url().includes("preload-target.svg?version=2")) {
      imageStartedBeforeStylesheet = !stylesheetLoaded;
    }
  });

  await page.goto(`${hostUrl}/?integration=preload`);
  const host = page.locator("[data-micro-frame-state]");
  await expect(host.locator("[data-preload-target]")).toBeVisible();

  await page.getByRole("button", { name: "Reload fixture" }).click();

  await expect(host.locator("[data-preload-target]")).toBeVisible();
  await expect(host).toHaveAttribute("data-micro-frame-state", "complete");
  expect(imageStartedBeforeStylesheet).toBe(true);
});
