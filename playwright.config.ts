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
    /**
     * The gate builds the assets it then tests.
     *
     * `next start` serves whatever `.next` happens to hold, so running this
     * command on its own silently tests the last build on the machine. That is
     * not a theoretical risk: a stale pre-feature `.next` makes the gate report
     * failures for a feature that is present in the source and absent only from
     * the build, and an equally stale one could report a pass. Building here
     * makes `npm run test:e2e` self-contained and independent of the order the
     * surrounding gate happens to run its steps in.
     */
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 300_000,
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
