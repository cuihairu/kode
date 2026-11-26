import path from 'path';
import { defineConfig } from 'vitest/config';

// Batch 92 dedicated performance-benchmark config (does not participate in gates
// such as pnpm test / vitest run):
//   npx vitest run --config vitest.bench.config.ts
// include only tests/perf/*.bench.ts, non-overlapping with the main config
// (tests/**/*.test.ts); the alias matches the main config so languageProviders can
// be evaluated under fake-vscode.
export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'tests/helpers/vscodeStub.ts')
    }
  },
  test: {
    include: ['tests/perf/*.bench.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000
  }
});
