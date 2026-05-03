import { defineConfig } from 'vitest/config';

// `pnpm sample:vitest` discovers every `*-vitest.test.ts` under
// `src/sample/`. Vitest's positional CLI args are substring filters
// (not globs), so the discovery rule has to live in this config file
// rather than in `package.json`.
export default defineConfig({
  test: {
    include: ['src/sample/**/*-vitest.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
