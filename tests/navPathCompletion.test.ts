import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Position, Uri } from './fake-vscode/core';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { makeTextDocument } from './helpers/vscodeStub';
import { KBEngineCompletionProvider } from '../src/languageProviders';
import { resetScanRootCache } from '../src/scanRoots';

// SP-3: addSpaceGeometryMapping 第 3 参(path)与 params dict 值内
// 字符串字面量 → 扫描 workspace/assetsRoot 的 *.navmesh/*.tmx 路径补全。
// 验收:路径前缀补全出实际存在的导航文件;无匹配时返回空表不误报不阻塞。

const NAV_FILES = [
  'D:/ws/res/spaces/xinshoucun/srv_xinshoucun.navmesh',
  'D:/ws/res/spaces/xinshoucun/srv_xinshoucun_1.navmesh',
  'D:/ws/res/maps/2d_map.tmx'
];

describe('nav path completion in addSpaceGeometryMapping (SP-3)', () => {
  const ORIGINAL = stubWorkspace.findFiles;
  const ORIGINAL_FOLDERS = stubWorkspace.workspaceFolders;

  beforeEach(() => {
    resetScanRootCache();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('D:/ws'), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async (pattern?: string) => {
      if (typeof pattern === 'string' && pattern.includes('navmesh')) {
        return NAV_FILES.filter(f => f.endsWith('.navmesh')).map(Uri.file);
      }
      if (typeof pattern === 'string' && pattern.includes('.tmx')) {
        return NAV_FILES.filter(f => f.endsWith('.tmx')).map(Uri.file);
      }
      return [];
    }) as typeof stubWorkspace.findFiles;
  });

  afterEach(() => {
    stubWorkspace.findFiles = ORIGINAL;
    stubWorkspace.workspaceFolders = ORIGINAL_FOLDERS;
    resetScanRootCache();
  });

  const complete = async (lineText: string): Promise<{ label: unknown }[]> => {
    const provider = new KBEngineCompletionProvider();
    const document = makeTextDocument(lineText + '\n', {
      fileName: 'D:/ws/scripts/cell/kbemain.py',
      languageId: 'python'
    });
    const position = new Position(0, lineText.length);
    const items = (await provider.provideCompletionItems(document, position)) as
      | { label: unknown }[]
      | undefined;
    return items ?? [];
  };

  it('completes navmesh paths in the path argument string', async () => {
    const items = await complete('KBEngine.addSpaceGeometryMapping(0, None, "');
    const labels = items.map(item => String(item.label));
    expect(labels.some(label => label.endsWith('srv_xinshoucun.navmesh'))).toBe(true);
    expect(labels.some(label => label.endsWith('2d_map.tmx'))).toBe(true);
  });

  it('completes navmesh paths inside params dict values', async () => {
    const items = await complete(
      'KBEngine.addSpaceGeometryMapping(0, None, "spaces", True, {0: "'
    );
    const labels = items.map(item => String(item.label));
    expect(labels.some(label => label.endsWith('.navmesh'))).toBe(true);
    expect(labels.some(label => label.endsWith('.tmx'))).toBe(true);
  });

  it('filters by typed path prefix', async () => {
    const items = await complete('KBEngine.addSpaceGeometryMapping(0, None, "spaces/xinshoucun/srv_');
    const labels = items.map(item => String(item.label));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every(label => label.includes('srv_'))).toBe(true);
    expect(labels.some(label => label.includes('2d_map'))).toBe(false);
  });

  it('returns empty when no nav files match the scan', async () => {
    stubWorkspace.findFiles = (async () => []) as typeof stubWorkspace.findFiles;
    const items = await complete('KBEngine.addSpaceGeometryMapping(0, None, "');
    expect(items).toEqual([]);
  });

  it('does not hijack completion outside addSpaceGeometryMapping strings', async () => {
    // 普通字符串参数不在目标调用内
    const other = await complete('someOtherFunction("');
    expect(other).toEqual([]);
    // 目标调用但光标不在字符串内
    const notInString = await complete('KBEngine.addSpaceGeometryMapping(0, None, path');
    expect(notInString).toEqual([]);
  });

  it('does not break existing KBEngine. reload completion on the same provider', async () => {
    const items = await complete('self.cellData = KBEngine.');
    const labels = items.map(item => String(item.label));
    // 既有 reload 面不受 nav 分支影响(非字符串上下文)
    expect(labels).toContain('reloadScript');
  });
});
