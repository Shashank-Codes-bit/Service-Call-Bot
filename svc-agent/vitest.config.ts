import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: that one sets `root` to the web app
// so the frontend builds, which would otherwise send Vitest looking for tests
// in src/web/dealer.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The live suite hits the real model and costs money. It is opt-in via
    // `npm run test:live`, never part of the ordinary run.
    exclude: ['tests/**/*.live.test.ts', '**/node_modules/**'],
    environment: 'node',
  },
});
