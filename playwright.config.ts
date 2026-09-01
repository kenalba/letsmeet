import { defineConfig, devices } from '@playwright/test';

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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // The segmented time field is the most browser-sensitive surface (spinbutton spans,
    // focus handoff between segments): run the same flows on Gecko.
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // A viewer far from the poll's zone — and on a half-hour offset, which shakes out any
    // whole-hour assumption in the zone math. Polls in these tests are created in UTC, so
    // every grid renders shifted +5:30 for this viewer.
    { name: 'tz-kolkata', use: { ...devices['Desktop Chrome'], timezoneId: 'Asia/Kolkata' } },
    // Coarse pointer: the create form keeps its native time inputs (no segments mount) and
    // the guest paints by tapping. The spec adapts to both via the project's `use` options.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run build:client && FAKE_PDS=1 npx tsx src/index.ts',
    port: 8787,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
