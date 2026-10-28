import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { PythonCompletionProvider } from '../src/languageProviders';
import {
  CompletionList,
  makeTextDocument,
  Position,
  Uri,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// IDE-NAV-016:冷补全可刷新状态。验收口径:索引未就绪时不记录永久 miss
// (冷查询过后索引就绪,同前缀查询仍能得到成员补全),冷期结果以
// isIncomplete=true 的空 CompletionList 呈现(编辑器继续输入会重查);
// 首扫完成后无归属的 .py 维持 null(真 miss 不虚报可刷新)。

const AVATAR_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const AVATAR_PY = [
  'class Avatar(object):',
  '    def tick(self):',
  '        self.h',
  ''
].join('\n');

const UNRELATED_PY = [
  'class Helper(object):',
  '    def run(self):',
  '        self.h',
  ''
].join('\n');

let root = '';
let avatarPyPath = '';
let unrelatedPyPath = '';

const originalFindFiles = stubWorkspace.findFiles;
const originalCreateWatcher = stubWorkspace.createFileSystemWatcher;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav016-'));
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
    return file;
  };
  put('a/scripts/entity_defs/Avatar.def', AVATAR_DEF);
  avatarPyPath = put('a/scripts/base/Avatar.py', AVATAR_PY);
  unrelatedPyPath = put('a/scripts/tools/helper.py', UNRELATED_PY);
  stubWorkspace.findFiles = (async (glob?: string) =>
    glob === '**/*.def' ? [Uri.file(path.join(root, 'a/scripts/entity_defs/Avatar.def'))] : []
  ) as typeof stubWorkspace.findFiles;
});

afterAll(() => {
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.createFileSystemWatcher = originalCreateWatcher;
  stubWorkspace.workspaceFolders = [];
  fs.rmSync(root, { recursive: true, force: true });
});

/** 光标在最后一行前缀尾(`self.h|`) */
const cursorAfter = (prefix: string): Position => {
  const line = AVATAR_PY.split('\n').length - 2; // 0 基:倒数第二行(self.h 行)
  expect(AVATAR_PY.split('\n')[line]).toBe(prefix);
  return new Position(line, prefix.length);
};

describe('冷补全可刷新状态(IDE-NAV-016)', () => {
  it('冷期:映射缺席时回 isIncomplete 空 CompletionList(可刷新),不装作终答', () => {
    // deferStartup:首扫未启动未完成 = 冷
    const manager = new EntityMappingManager({ subscriptions: [] } as never, undefined, {
      deferStartup: true
    });
    expect(manager.isInitialScanComplete(), '首扫状态可查').toBe(false);

    const provider = new PythonCompletionProvider(manager);
    const document = makeTextDocument(AVATAR_PY, {
      fileName: avatarPyPath, languageId: 'python'
    }) as never;
    const cold = provider.provideCompletionItems(document, cursorAfter('        self.h'), undefined);

    expect(cold, '冷期回 CompletionList 而非 null').toBeInstanceOf(CompletionList);
    expect((cold as CompletionList).isIncomplete, '可刷新状态').toBe(true);
    expect((cold as CompletionList).items).toEqual([]);
  });

  it('索引就绪后:同前缀得到成员补全(冷查询未记录永久 miss)', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never, undefined, {
      deferStartup: true
    });
    const provider = new PythonCompletionProvider(manager);
    const document = makeTextDocument(AVATAR_PY, {
      fileName: avatarPyPath, languageId: 'python'
    }) as never;
    const cursor = cursorAfter('        self.h');

    // 冷查询一次(此前会把它当终答)
    provider.provideCompletionItems(document, cursor, undefined);

    // 索引就绪
    await manager.waitForInitialScan();
    expect(manager.isInitialScanComplete()).toBe(true);

    const warm = provider.provideCompletionItems(document, cursor, undefined);
    const items = Array.isArray(warm) ? warm : (warm as CompletionList).items;
    const labels = items.map(item => String(item.label));
    expect(labels, '同前缀出 def 声明属性 hp').toContain('hp');
  });

  it('首扫完成后的真 miss(无归属 .py)维持 null,不虚报可刷新', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never, undefined, {
      deferStartup: true
    });
    await manager.waitForInitialScan();
    const provider = new PythonCompletionProvider(manager);
    const unrelated = UNRELATED_PY.split('\n');
    const document = makeTextDocument(UNRELATED_PY, {
      fileName: unrelatedPyPath, languageId: 'python'
    }) as never;
    const cursor = new Position(unrelated.length - 2, '        self.h'.length);

    const result = provider.provideCompletionItems(document, cursor, undefined);
    expect(result, '暖期真 miss 维持 null').toBeNull();
  });
});
