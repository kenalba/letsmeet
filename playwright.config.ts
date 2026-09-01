import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // The fake-PDS server keeps its state in one in-memory DB, so tests share a process:
  // run them serially rather than racing two workers through the same repo.
  workers: 1,
  use: {
    baseURL: 'http://localhost:8787',
    // Pin the browser clock's zone: the grid renders columns in the *viewer's* zone.
    timezoneId: 'UTC',
  },
  webServer: {
    command: 'npm run build:client && FAKE_PDS=1 npx tsx src/index.ts',
    port: 8787,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
