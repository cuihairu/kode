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
    // 回环 socket 集成测试已全部迁移 tests/sim 仿真器(端口动态分配,
    // 见 docs/redesign.md 阶段 1),文件级并行不再有固定端口争用。
    coverage: {
      provider: 'v8',
      // 覆盖率如实统计全部 src 源码:重设计阶段 3 起 extension.ts 的
      // activate/deactivate 由 fake-vscode 装配测试驱动,进分母(P14/P16)。
      include: ['src/**/*.ts'],
      exclude: ['src/test/**'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage'
    }
  }
});
