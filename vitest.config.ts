import { defineConfig } from 'vitest/config';

// The scaffold carries no coverage gate yet. When the shared checks module
// (src/checks) grows the security-relevant lint logic in the L-E2 epic, a
// coverage threshold on that path lands with it (mirroring the protocol
// package's verify/canon gate).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov', 'html'],
    },
  },
});
