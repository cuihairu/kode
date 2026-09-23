import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 纯逻辑层单测(vitest);需要真实 vscode API 的测试走
    // src/test/suite(mocha + @vscode/test-electron),两套互不掺和。
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // 覆盖率如实统计全部 src 源码:依赖 vscode API 的模块在 vitest 下
      // 无法执行,会按 0% 计入,这是真实覆盖水平,不做剔除美化。
      include: ['src/**/*.ts'],
      exclude: ['src/test/**', 'src/extension.ts'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage'
    }
  }
});
