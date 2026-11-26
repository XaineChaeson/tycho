import { defineConfig } from '@playwright/test';

// The browser smoke test: a few minutes through the built console on a real service.
// It is not part of `npm test`; run it with `npm run e2e`, which builds the console first.
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/.results',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
});
