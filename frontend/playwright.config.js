import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./browser-tests",
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  reporter: [
    ["list"],
    ["json", { outputFile: "../runtime/evidence/redesign-v001/browser-results.json" }],
  ],
  use: {
    channel: "msedge",
    // Fake mic + autoplay so push-to-talk can be tested without hardware or prompts.
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
    headless: process.env.ROTO_HEADLESS === "1",
    viewport: { width: 1440, height: 1000 },
    baseURL: process.env.ROTO_BASE_URL || "http://127.0.0.1:8000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  outputDir: "../runtime/evidence/redesign-v001/test-artifacts",
});
