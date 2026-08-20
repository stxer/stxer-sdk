import { defineConfig } from 'vitest/config';

// Two suites live under `src/**/*-vitest.test.ts` and they are not
// interchangeable: `unit` is offline and fast, `live` drives the real
// simulator over the network and needs the long timeouts. Splitting them
// into named projects keeps `pnpm test` runnable without network access
// while `pnpm test:live` still exercises the samples.
//
// Vitest's positional CLI args are substring filters (not globs), so the
// discovery rules have to live here rather than in `package.json`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*-vitest.test.ts'],
          exclude: ['**/node_modules/**', 'src/sample/**'],
        },
      },
      {
        test: {
          name: 'live',
          include: ['src/sample/**/*-vitest.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
