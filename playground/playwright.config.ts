import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run playground:dev",
    url: "http://127.0.0.1:5173/health",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
