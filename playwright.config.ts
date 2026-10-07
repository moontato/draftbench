import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/ui',
  outputDir: process.env.TMPDIR
    ? `${process.env.TMPDIR}/draftbench-playwright-results`
    : './test-results',
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:1420', viewport: { width: 1440, height: 960 } },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
  },
})
