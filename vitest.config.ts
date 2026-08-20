import { defineConfig } from 'vitest/config';

// `pnpm sample:vitest` discovers every `*-vitest.test.ts` under `src/`.
// Most live in `src/sample/` and hit the live simulator; a few alongside
// the source are offline unit tests, which cost nothing to run here and
// would otherwise never execute — `dts test` (jest) cannot transform any
// of these files. Vitest's positional CLI args are substring filters (not
// globs), so `vitest run post-conditions` narrows to one file, and the
// discovery rule has to live in this config rather than in `package.json`.
export default defineConfig({
  test: {
    include: ['src/**/*-vitest.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
