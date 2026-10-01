import path from 'path';
import { defineConfig } from 'vitest/config';

// 批92 性能基准专用配置(不参与 pnpm test / vitest run 等门禁):
//   npx vitest run --config vitest.bench.config.ts
// include 仅 tests/perf/*.bench.ts,与主配置(tests/**/*.test.ts)互不重叠;
// alias 与主配置一致,使 languageProviders 可在 fake-vscode 下求值。
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
