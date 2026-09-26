import { defineConfig } from '@playwright/test';

const chrome = process.env.CHROME_PATH;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  retries: 0,
  globalSetup: './tests/e2e/global-setup.ts',
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      executablePath: chrome || undefined,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--use-file-for-fake-video-capture=test-results/boxing.y4m',
        '--autoplay-policy=no-user-gesture-required',
        '--enable-unsafe-swiftshader',
      ],
    },
    trace: 'off',
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
  },
});
