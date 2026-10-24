import path from 'path';
import { defineConfig } from 'vitest/config';

// 集成 tag(C-10 / V-07·c):需要真引擎源码树或真实 demo 脚本检出才能出真结果的套件。
// 选择口径是**显式文件清单**,不是通配——`*Real*` 之类通配会误收
// tests/realReproCellMethods.test.ts(名字带 Real 的普通单测,不依赖树)。
// 清单内每个文件自带树守卫(describeWithEngineTree / describe.skipIf):无树环境跑出
// 可见 skip 而不红,这是 675e805 的教训——检出缺席不得让流水线变红。
// 主门禁(vitest.config.ts)照常收全量 tests/**/*.test.ts,本配置只在有树环境
// 单独运行,不替代也不削减主门禁。
// 运行:npx vitest run --config vitest.integration.config.ts
// 有树环境真跑需给探针指向引擎根:KBENGINE_ROOT=<engine root>
export default defineConfig({
  resolve: {
    alias: {
      // 与 vitest.config.ts 同一 vscode 替身:装配口径不分裂
      vscode: path.resolve(__dirname, 'tests/helpers/vscodeStub.ts')
    }
  },
  test: {
    include: [
      'tests/engineTreeProbe.test.ts',
      'tests/realEngineIntegration.test.ts',
      'tests/fantasydemoRealExport.test.ts',
      'tests/fantasydemoDefAnalysis.test.ts'
    ],
    environment: 'node'
  }
});
