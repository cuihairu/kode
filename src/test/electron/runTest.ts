// 真机层入口(真机验收令 2026-10-10):用 @vscode/test-electron 拉起真 VS Code
// 扩展宿主,把 out/test/electron/suite 下的用例交给宿主内 mocha 执行。
// 与 src/test/runTest.ts(fake-vscode 装配烟测,纯 node)不同,本层消费的是
// 真编辑器 API 面:executeCompletionItemProvider / executeHoverProvider /
// executeDefinitionProvider / executeDocumentSymbolProvider / 诊断集合。
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // 仓库根 = out/test/electron 上溯三级(与 main 字段同根)
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index.js');
  const workspacePath = path.resolve(
    extensionDevelopmentPath,
    'tests/fixtures/electron-ws'
  );

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      // 无显示环境(headless/CI)必需:xvfb 下禁 GPU 与沙箱
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // 关掉欢迎页/恢复提示,保证工作区按参数打开
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes'
    ]
  });
}

main().catch(error => {
  console.error('真机层启动失败:', error);
  process.exit(1);
});
