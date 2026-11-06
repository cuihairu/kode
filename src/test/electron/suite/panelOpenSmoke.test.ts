// 面板打开冒烟(热更/运行时查询等 UI-04~09 打开链路,真机层):
// 真 VS Code 扩展宿主内逐条执行打开命令,断言激活与打开全程不抛。
// 背景:用户报「热更面板根本打不开」,fake-vscode 层全绿 → 本层补真机证据。
import * as assert from 'assert';
import * as vscode from 'vscode';

const OPEN_COMMANDS: string[] = [
  // 热更入口(HR-UI-001 状态灯 → 「KBEngine 热更」通道 + 各热更命令)
  'kbengine.hotReload.showLog',
  'kbengine.hotReload.showBatchSummary',
  'kbengine.hotReload.showRevisionEvidence',
  'kbengine.hotReload.showFileState',
  'kbengine.hotReload.filterByState',
  'kbengine.hotReload.confirmDefBaseline',
  // UI-04~09 webview 面板打开链路
  'kbengine.runtimeQuery.show',
  'kbengine.monitoring.show',
  'kbengine.logs.showViewer',
  'kbengine.telnet.showPanel',
  'kbengine.dependency.show',
  'kbengine.pythonCallGraph.show',
  'kbengine.flow.show'
];

describe('panel open smoke (real host)', () => {
  it('extension activates and every panel-open command runs without throwing', async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();

    const failures: string[] = [];
    for (const command of OPEN_COMMANDS) {
      try {
        await vscode.commands.executeCommand(command);
      } catch (error) {
        failures.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    assert.deepStrictEqual(failures, [], `panel open failures:\n${failures.join('\n')}`);
  });
});
