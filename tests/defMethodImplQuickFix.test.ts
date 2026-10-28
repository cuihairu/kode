import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineMethodImplementationCodeActionProvider } from '../src/languageProviders';
import { CodeActionKind, makeTextDocument, Position, Range, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-NAV-014:为缺少实现的方法生成单个空方法。验收口径:Code Action 展示
// 目标文件与插入点;已有同名实现时不重复生成(与 Go to Implementations
// 同一实现查询面);属性段/非 def/取消位不出;插入点按目标文件当前文本
// (打开缓冲区优先)计算;生成体只是本文件插入编辑,不建文件不碰 def。

const AVATAR_DEF = [
  '<root>',
  '  <BaseMethods>',
  '    <reqPos>',
  '      <Arg>UINT32</Arg>',
  '      <Arg>VECTOR3</Arg>',
  '    </reqPos>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <onTick/>',
  '  </CellMethods>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

/** 类体非空:已有方法 existing,类尾(0 基行 2)后插新方法 */
const BASE_PY = [
  'class Avatar(kbe.KBEntity):',
  '    def existing(self):',
  '        return 1',
  ''
].join('\n');

/** 类体为空:类头后直接插首个方法(无空行前缀) */
const CELL_PY = [
  'class Avatar(kbe.KBEntity):',
  ''
].join('\n');

/** 已有同名实现:reqPos 已在,不应再生成 */
const BASE_PY_IMPLEMENTED = [
  'class Avatar(kbe.KBEntity):',
  '    def reqPos(self, stamp, pos):',
  '        pass',
  ''
].join('\n');

interface Fixture {
  root: string;
  avatarDef: string;
  basePy: string;
  cellPy: string;
}

const buildWorkspace = (basePyContent: string): Fixture => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav014-'));
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
    return file;
  };
  const avatarDef = put('a/scripts/entity_defs/Avatar.def', AVATAR_DEF);
  const basePy = put('a/scripts/base/Avatar.py', basePyContent);
  const cellPy = put('a/scripts/cell/Avatar.py', CELL_PY);
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  return { root, avatarDef, basePy, cellPy };
};

const withStubbedDefs = async <T>(avatarDef: string, run: () => Promise<T>): Promise<T> => {
  const originalFindFiles = stubWorkspace.findFiles;
  stubWorkspace.findFiles = (async (glob?: string) =>
    glob === '**/*.def' ? [Uri.file(avatarDef)] : []) as typeof stubWorkspace.findFiles;
  try {
    return await run();
  } finally {
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.workspaceFolders = [];
  }
};

const makeManager = async (): Promise<EntityMappingManager> => {
  const manager = new EntityMappingManager({ subscriptions: [] } as never);
  await (manager as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
  return manager;
};

const roots: string[] = [];

beforeAll(() => { /* fixtures 按用例自建,此处只登记清理 */ });

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  stubWorkspace.textDocuments = [];
});

/** 光标落在 def 文本中某词首(0 基行列) */
const cursorOnWord = (text: string, word: string): Position => {
  const offset = text.indexOf(word);
  expect(offset).toBeGreaterThanOrEqual(0);
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return new Position(line, offset - (before.lastIndexOf('\n') + 1));
};

/** WorkspaceEdit 的 Map 按 Uri 对象身份键——按 fsPath 索引(既有约定) */
const editsByPath = (workspaceEdit: {
  entries(): Array<[{ fsPath: string }, Array<{ range: { start: Position }; newText: string }>]>
}, filePath: string): Array<{ range: { start: Position }; newText: string }> => {
  const byPath = new Map(
    workspaceEdit.entries().map(([uri, edits]) => [uri.fsPath, edits] as const)
  );
  return byPath.get(filePath) ?? [];
};

describe('缺实现方法生成空方法(IDE-NAV-014)', () => {
  it('类体非空:reqPos 动作指向 base/Avatar.py 类尾插入,arg0/arg1 形参入签名', async () => {
    const ws = buildWorkspace(BASE_PY);
    roots.push(ws.root);
    await withStubbedDefs(ws.avatarDef, async () => {
      const manager = await makeManager();
      const provider = new KBEngineMethodImplementationCodeActionProvider(manager);
      const document = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef }) as never;
      const cursor = cursorOnWord(AVATAR_DEF, 'reqPos');

      const actions = (await provider.provideCodeActions(
        document, new Range(cursor, cursor), { diagnostics: [] }, undefined
      ))!;

      expect(actions).toHaveLength(1);
      const action = actions[0];
      // 展示目标文件与插入点:类尾(0 基行 2)后 = 0 基行 3 → 1 基 4
      expect(action.title).toContain('reqPos');
      expect(action.title).toContain(ws.basePy);
      expect(action.title).toContain(':4');
      expect(action.kind).toBe(CodeActionKind.Refactor);
      expect(action.command).toBeUndefined();

      const edits = editsByPath(action.edit!, ws.basePy);
      expect(edits, '只碰目标属主脚本,不动 def/别的文件').toHaveLength(1);
      expect(edits[0].range.start).toEqual(new Position(3, 0));
      // 空行前缀 + 4 缩进方法 + <Arg> 数量一致的 argN 形参 + 空体 pass
      expect(edits[0].newText).toBe('\n    def reqPos(self, arg0, arg1):\n        pass\n');
    });
  });

  it('类体为空:onTick 插在类头下一行,无空行前缀,签名只 (self)', async () => {
    const ws = buildWorkspace(BASE_PY);
    roots.push(ws.root);
    await withStubbedDefs(ws.avatarDef, async () => {
      const manager = await makeManager();
      const provider = new KBEngineMethodImplementationCodeActionProvider(manager);
      const document = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef }) as never;
      const cursor = cursorOnWord(AVATAR_DEF, 'onTick');

      const actions = (await provider.provideCodeActions(
        document, new Range(cursor, cursor), { diagnostics: [] }, undefined
      ))!;

      expect(actions).toHaveLength(1);
      expect(actions[0].title).toContain(ws.cellPy);
      expect(actions[0].title).toContain(':2');
      const edits = editsByPath(actions[0].edit!, ws.cellPy);
      expect(edits).toHaveLength(1);
      expect(edits[0].range.start).toEqual(new Position(1, 0));
      expect(edits[0].newText).toBe('    def onTick(self):\n        pass\n');
    });
  });

  it('插入点按目标文件当前文本:打开缓冲区(类尾多一方法)优先于磁盘', async () => {
    const ws = buildWorkspace(BASE_PY);
    roots.push(ws.root);
    const buffer = [
      'class Avatar(kbe.KBEntity):',
      '    def existing(self):',
      '        return 1',
      '',
      '    def another(self):',
      '        pass',
      ''
    ].join('\n');
    await withStubbedDefs(ws.avatarDef, async () => {
      const manager = await makeManager();
      const provider = new KBEngineMethodImplementationCodeActionProvider(manager);
      const document = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef }) as never;
      const cursor = cursorOnWord(AVATAR_DEF, 'reqPos');

      stubWorkspace.textDocuments = [{
        uri: { toString: () => `file://${ws.basePy}`, fsPath: ws.basePy },
        version: 3,
        getText: () => buffer
      }];
      try {
        const actions = (await provider.provideCodeActions(
          document, new Range(cursor, cursor), { diagnostics: [] }, undefined
        ))!;
        expect(actions).toHaveLength(1);
        const edits = editsByPath(actions[0].edit!, ws.basePy);
        // 缓冲区类尾(0 基行 5)后 = 0 基行 6 → 1 基 7;磁盘版会出 :4
        expect(edits[0].range.start).toEqual(new Position(6, 0));
        expect(actions[0].title).toContain(':7');
      } finally {
        stubWorkspace.textDocuments = [];
      }
    });
  });

  it('已有同名实现不重复生成;属性段/取消位不出', async () => {
    const ws = buildWorkspace(BASE_PY_IMPLEMENTED);
    roots.push(ws.root);
    await withStubbedDefs(ws.avatarDef, async () => {
      const manager = await makeManager();
      const provider = new KBEngineMethodImplementationCodeActionProvider(manager);
      const document = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef }) as never;

      // reqPos 已在 base/Avatar.py 实现 → 不重复生成
      const implemented = (await provider.provideCodeActions(
        document,
        new Range(cursorOnWord(AVATAR_DEF, 'reqPos'), cursorOnWord(AVATAR_DEF, 'reqPos')),
        { diagnostics: [] },
        undefined
      ))!;
      expect(implemented).toEqual([]);

      // 属性段符号(hp)不是方法 → 不出
      const hpCursor = cursorOnWord(AVATAR_DEF, 'hp');
      expect(await provider.provideCodeActions(
        document, new Range(hpCursor, hpCursor), { diagnostics: [] }, undefined
      )).toEqual([]);

      // 取消位 → 空
      const cursor = cursorOnWord(AVATAR_DEF, 'onTick');
      expect(await provider.provideCodeActions(
        document, new Range(cursor, cursor), { diagnostics: [] },
        { isCancellationRequested: true } as never
      )).toEqual([]);
    });
  });
});
