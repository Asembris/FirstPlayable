import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run start -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    /**
     * The browser gate runs with persistence deliberately unconfigured.
     *
     * `npm test` and `npm run test:e2e` must not require Internet access or a
     * credential, so these sentinels override whatever `.env` holds (Next.js
     * never overwrites a variable already present in the environment). The
     * studio therefore exercises the "database unavailable" row of
     * specification section 12, and `/example` proves it still plays with no
     * database at all.
     *
     * The persistence happy path is verified against the deployed application
     * and recorded in docs/DEPLOYMENT_PREFLIGHT.md.
     */
    env: {
      SUPABASE_URL: "http://persistence-disabled-for-e2e.invalid",
      SUPABASE_SECRET_KEY: "e2e-sentinel-not-a-real-credential",
    },
  },
});
