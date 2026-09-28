import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a real web + worker + PostgreSQL + Mailpit stack.
 * Start the stack first (see docs/PROGRESS.md "Running end-to-end tests") or let CI do it.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
// Local sandboxes may provide a preinstalled Chromium instead of Playwright's pinned download.
const chromiumExecutable = process.env.PW_CHROMIUM_EXECUTABLE;
const chromiumLaunch = chromiumExecutable
  ? { launchOptions: { executablePath: chromiumExecutable } }
  : {};
// Playwright 1.63's Firefox (build 1543) can drop a protocol message after Cross-Origin-Opener-
// Policy replaces a page's browsing context: the replacement's message ids restart at 1 while the
// browser end still holds unacknowledged answers under the same ids, so the colliding message
// (often "navigation committed") is answered from that cache and never delivered, and page.goto
// waits until the test times out (microsoft/playwright#42731, fixed in Firefox build 1551, which
// no stable Playwright ships yet). Every HyFib page sends COOP: same-origin and the store tests
// round-trip through stand-ins on another origin, so Firefox runs with COOP enforcement off;
// Chromium and WebKit still enforce it. Drop this with the upgrade to Firefox 1551 or later.
const firefoxLaunch = {
  launchOptions: { firefoxUserPrefs: { 'browser.tabs.remote.useCrossOriginOpenerPolicy': false } },
};

export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.ts',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A navigation that never settles fails here (and is retried in CI) instead of holding the
    // test until its own timeout; pages load in a few seconds at most.
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...chromiumLaunch } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], ...firefoxLaunch } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], ...chromiumLaunch } },
  ],
});
