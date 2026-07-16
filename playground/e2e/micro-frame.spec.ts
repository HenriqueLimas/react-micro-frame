import { expect, test } from "@playwright/test";

test("the SSR React host hydrates React and Marko micro-frames", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.goto("http://127.0.0.1:5173");

  const reactFragment = page.locator(
    '[data-provider="react"] [data-react-fragment]',
  );
  const markoFragment = page.locator(
    '[data-provider="marko"] [data-marko-fragment]',
  );

  await expect(reactFragment).toHaveAttribute("data-version", "1");
  await expect(markoFragment).toHaveAttribute("data-version", "1");
  await expect(reactFragment.locator("[data-stream-complete]")).toBeVisible();
  await expect(markoFragment.locator("[data-stream-complete]")).toBeVisible();
  await expect(
    reactFragment.locator("[data-react-counter-root]"),
  ).toHaveAttribute("data-react-hydrated", "true");
  await expect(markoFragment).toHaveAttribute("data-marko-interactive", "");

  await reactFragment.getByRole("button", { name: "Increment React counter" }).click();
  await reactFragment.getByRole("button", { name: "Increment React counter" }).click();
  await markoFragment.getByRole("button", { name: "Increment Marko counter" }).click();
  await markoFragment.getByRole("button", { name: "Decrement Marko counter" }).click();
  await markoFragment.getByRole("button", { name: "Decrement Marko counter" }).click();
  await expect(reactFragment.locator("[data-counter-output]")).toHaveText("2");
  await expect(markoFragment.locator("[data-counter-output]")).toHaveText("-1");

  // This update is performed by the hydrated host and exercises browser fetching.
  await page.getByRole("button", { name: "Reload fragments" }).click();
  await expect(
    page.locator('[data-provider="marko"] [data-micro-frame-loading]'),
  ).toBeVisible();
  await expect(reactFragment).toHaveAttribute("data-version", "2");
  await expect(markoFragment).toHaveAttribute("data-version", "2");

  // The host fallback disappears on the first chunk, before either stream completes.
  await expect(
    page.locator('[data-provider="react"] [data-micro-frame-loading]'),
  ).toBeHidden();
  await expect(
    page.locator('[data-provider="marko"] [data-micro-frame-loading]'),
  ).toBeHidden();
  // Marko's second chunk remains pending after its delayed first chunk arrives.
  await expect(markoFragment.locator("[data-stream-complete]")).toHaveCount(0);

  await expect(reactFragment.locator("[data-stream-complete]")).toBeVisible();
  await expect(markoFragment.locator("[data-stream-complete]")).toBeVisible();
  await expect(
    reactFragment.locator("[data-react-counter-root]"),
  ).toHaveAttribute("data-react-hydrated", "true");
  await expect(markoFragment).toHaveAttribute("data-marko-interactive", "");
  await expect(reactFragment.locator("[data-counter-output]")).toHaveText("0");
  await expect(markoFragment.locator("[data-counter-output]")).toHaveText("0");

  // Both framework runtimes must remain interactive after writable-dom replaces them.
  await reactFragment.getByRole("button", { name: "Increment React counter" }).click();
  await markoFragment.getByRole("button", { name: "Increment Marko counter" }).click();
  await expect(reactFragment.locator("[data-counter-output]")).toHaveText("1");
  await expect(markoFragment.locator("[data-counter-output]")).toHaveText("1");

  await page.getByRole("button", { name: "Unmount fragments" }).click();
  await expect(reactFragment).toHaveCount(0);
  await expect(markoFragment).toHaveCount(0);
  await page.getByRole("button", { name: "Mount fragments" }).click();
  await expect(
    page.locator('[data-provider="react"] [data-react-fragment]'),
  ).toHaveAttribute("data-version", "2");
  await expect(
    page.locator('[data-provider="marko"] [data-marko-fragment]'),
  ).toHaveAttribute("data-version", "2");
  expect(pageErrors).toEqual([]);
});

for (const provider of [
  {
    name: "React",
    url: "http://127.0.0.1:5174/fragment?version=9&delay=500",
    first: "Remote React fragment v",
    delayed: "The delayed React chunk arrived after",
  },
  {
    name: "Marko",
    url: "http://127.0.0.1:5175/fragment?version=9&delay=500",
    first: "Remote Marko fragment v9",
    delayed: "The delayed chunk arrived after",
  },
]) {
  test(`${provider.name} sends an early fragment chunk`, async () => {
    const started = Date.now();
    const response = await fetch(provider.url);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const firstChunkAt = Date.now() - started;
    const earlyHtml = decoder.decode(first.value, { stream: true });
    let html = earlyHtml;

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      html += decoder.decode(chunk.value, { stream: true });
    }
    html += decoder.decode();

    expect(response.ok).toBeTruthy();
    expect(firstChunkAt).toBeLessThan(400);
    expect(earlyHtml).toContain(provider.first);
    expect(earlyHtml).not.toContain(provider.delayed);
    expect(html).toContain(provider.delayed);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });
}
