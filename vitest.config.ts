import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // definitionSemantics 纯逻辑测试经由 definitionWorkspace 传递依赖 vscode;
      // 这里用最小 stub 满足模块求值,真实 vscode 行为仍由 test-electron 层覆盖。
      vscode: path.resolve(__dirname, 'tests/helpers/vscodeStub.ts')
    }
  },
  test: {
    // 纯逻辑层单测(vitest);需要真实 vscode API 的测试走
    // src/test/suite(mocha + @vscode/test-electron),两套互不掺和。
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 回环 socket 集成测试(machine discovery 20086 等)共享固定端口,
    // 文件必须串行执行,否则并行 worker 抢绑同端口会 EADDRINUSE。
    fileParallelism: false,
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
