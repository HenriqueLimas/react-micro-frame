import { expect, test } from "@playwright/test";

const hostUrl = "http://127.0.0.1:5173";

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
