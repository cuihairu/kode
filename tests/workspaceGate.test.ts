import { describe, expect, it } from 'vitest';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import {
  detectKbEngineWorkspace,
  shouldStartKbEngineIndexing
} from '../src/workspaceGate';

// 工作区门控探测(书 PR-002 / AUDIT-003 负案例):有界特征探测的决策表。
// 探测本体不做全仓 walk——合并 glob 单次 findFiles(maxResults=1,命中即真);
// 无工作区文件夹直接判非;探测异常 fail-open 按 KBEngine 工作区处理(回退
// 门控前全量启动,不惩罚真实 KBE 工作区)。

const deps = (
  roots: string[],
  findFiles: () => Promise<Array<{ fsPath: string }>> | Array<{ fsPath: string }>
) => ({
  workspaceRoots: roots,
  findFiles: (() => Promise.resolve(findFiles())) as never
});

describe('detectKbEngineWorkspace 特征探测', () => {
  it('无工作区文件夹:直接判非,不发起 findFiles', async () => {
    let called = 0;
    const result = await detectKbEngineWorkspace({
      workspaceRoots: [],
      findFiles: (() => {
        called += 1;
        return Promise.resolve([]);
      }) as never
    });
    expect(result).toBe(false);
    expect(called).toBe(0);
  });

  it('findFiles 命中任一特征(.def/entities.xml/types.xml/alias.xml/kbengine*.xml):true', async () => {
    const hit = await detectKbEngineWorkspace(
      deps(['/ws'], () => [{ fsPath: '/ws/assets/scripts/entity_defs/Mage.def' }])
    );
    expect(hit).toBe(true);
  });

  it('findFiles 零命中(纯 Python 工作区):false', async () => {
    const miss = await detectKbEngineWorkspace(deps(['/ws'], () => []));
    expect(miss).toBe(false);
  });

  it('findFiles 抛错:fail-open 按 KBEngine 工作区处理(true)', async () => {
    const failOpen = await detectKbEngineWorkspace({
      workspaceRoots: ['/ws'],
      findFiles: (() => Promise.reject(new Error('vscode api down'))) as never
    });
    expect(failOpen).toBe(true);
  });

  it('shouldStartKbEngineIndexing:读真实 vscode.workspace(空工作区 → false)', async () => {
    stubWorkspace.workspaceFolders = [];
    expect(await shouldStartKbEngineIndexing()).toBe(false);
  });

  it('shouldStartKbEngineIndexing:工作区有特征命中 → true', async () => {
    stubWorkspace.workspaceFolders = [
      { uri: Uri.file('/ws/kbe'), name: 'kbe', index: 0 }
    ];
    const original = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async () => [
      Uri.file('/ws/kbe/scripts/entities.xml')
    ]) as typeof stubWorkspace.findFiles;
    try {
      expect(await shouldStartKbEngineIndexing()).toBe(true);
    } finally {
      stubWorkspace.findFiles = original;
    }
  });
});
