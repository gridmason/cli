import { defineConfig } from 'vitest/config';

// The e2e suite is a separate gate from the fast unit run (`npm test`): it
// builds the binary (globalSetup) and drives it as a subprocess, so it is slower
// and depends on `dist/`. Keeping it in its own config lets CI run it as a named
// job while the unit config stays build-free. Run it with `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    globalSetup: ['test/e2e/global-setup.ts'],
    // Each e2e builds a scaffold and shells out to the binary; give them room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
