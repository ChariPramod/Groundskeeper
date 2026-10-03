import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./apps/web/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @groundskeeper/web start --port 4175",
      url: "http://127.0.0.1:4175",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DASHBOARD_MODE: "live",
        AUTH_ORIGIN: "https://team.example",
        AUTH_SECRET: "test-only-secret-test-only-secret",
        GITHUB_OAUTH_CLIENT_ID: "test",
        GITHUB_OAUTH_CLIENT_SECRET: "test",
        DASHBOARD_INSTALLATION_ID: "1",
        DATABASE_URL: "postgresql://test:test@127.0.0.1:1/unavailable",
      },
    },
    {
      command: "pnpm --filter @groundskeeper/web start --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { DASHBOARD_MODE: "demo" },
    },
    {
      command: "pnpm --filter @groundskeeper/web start --port 4174",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DASHBOARD_MODE: "live",
        DASHBOARD_INSTALLATION_ID: "1",
        DASHBOARD_ACCESS_TOKEN: "browser-test-token",
        DATABASE_URL: "postgresql://test:test@127.0.0.1:1/unavailable",
      },
    },
  ],
});
