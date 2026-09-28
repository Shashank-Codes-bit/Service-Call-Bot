import { defineConfig } from 'vitest/config';

/**
 * The opt-in suite that hits the real model. Separate from vitest.config.ts,
 * whose `exclude` deliberately keeps these out of the ordinary run.
 *
 * `LIVE` is set here rather than on the command line so `npm run test:live`
 * behaves the same in PowerShell as in bash. The suite still skips itself if
 * no API key is present.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.live.test.ts'],
    environment: 'node',
    env: { LIVE: '1' },
    // One model call per assertion; the default 5s is tight over a slow link.
    testTimeout: 30_000,
  },
});
