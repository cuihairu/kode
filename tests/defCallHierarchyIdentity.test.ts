import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import {
  KBEngineCallHierarchyProvider,
  KBEngineDefinitionProvider
} from '../src/languageProviders';
import { makeTextDocument, Position, Range, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-NAV-015:统一调用层次与 Definition 的符号身份。验收口径:相同
// RPC/mixin 方法在两种入口(F12 与调用层次)解析出的 owner 与目标一致——
// 两者共用同一条 def→python 解析链(identity 绑定/属主+全局唯一回退 →
// def 相对约定链),层次拿不到 python 目标才 null(F12 的提示+注册回落
// 是展示兜底,不是 python 目标,层次不借)。

const AVATAR_DEF = [
  '<root>',
  '  <BaseMethods>',
  '    <reqPos/>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <onTick/>',
  '  </CellMethods>',
  '  <BaseMethods>',
  '    <ghost/>',
  '  </BaseMethods>',
  '</root>',
  ''
].join('\n');

/** 约定链目标:base/Avatar.py 的 reqPos(def 未入索引时 F12 靠约定链找到) */
const BASE_PY = [
  'class Avatar(object):',
  '    def reqPos(self):',
  '        pass',
  ''
].join('\n');

/** mixin 目标:onTick 全项目唯一命中(域目录无果 → 全项目唯一名回退) */
const MIXIN_PY = [
  'class AvatarMixin(object):',
  '    def onTick(self):',
  '        pass',
  ''
].join('\n');

let root = '';
let avatarDefPath = '';
let basePyPath = '';
let mixinPyPath = '';

const write = (relative: string, content: string): string => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
  return file;
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav015-'));
  write('a/scripts/entities.xml', '<root>\n  <Avatar/>\n</root>\n');
  avatarDefPath = write('a/scripts/entity_defs/Avatar.def', AVATAR_DEF);
  basePyPath = write('a/scripts/base/Avatar.py', BASE_PY);
  mixinPyPath = write('a/scripts/mixin/avatar_mixin.py', MIXIN_PY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
  stubWorkspace.findFiles = (async () => []) as typeof stubWorkspace.findFiles;
});

/** 光标落在 def 文本中某词首(0 基行列) */
const cursorOnWord = (text: string, word: string): Position => {
  const offset = text.indexOf(word);
  expect(offset).toBeGreaterThanOrEqual(0);
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return new Position(line, offset - (before.lastIndexOf('\n') + 1));
};

const defDocument = () => makeTextDocument(AVATAR_DEF, { fileName: avatarDefPath }) as never;

const withIndexedDefs = async <T>(indexed: boolean, run: () => Promise<T>): Promise<T> => {
  const originalFindFiles = stubWorkspace.findFiles;
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  stubWorkspace.findFiles = (async (glob?: string) =>
    indexed && glob === '**/*.def' ? [Uri.file(avatarDefPath)] : []) as typeof stubWorkspace.findFiles;
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

describe('调用层次与 Definition 符号身份统一(IDE-NAV-015)', () => {
  it('def 未入索引:约定链目标两入口一致(F12 与层次同落 base/Avatar.py reqPos)', async () => {
    await withIndexedDefs(false, async () => {
      const manager = await makeManager();
      const hierarchy = new KBEngineCallHierarchyProvider(manager);
      const definition = new KBEngineDefinitionProvider(manager);
      const document = defDocument();
      const cursor = cursorOnWord(AVATAR_DEF, 'reqPos');

      const item = await hierarchy.prepareCallHierarchy(document, cursor);
      expect(item, '层次经约定链根到 python 实现(与 F12 同链)').toBeTruthy();
      expect((item as { uri: { fsPath: string } }).uri.fsPath).toBe(basePyPath);
      expect((item as { name: string }).name).toBe('reqPos');
      expect((item as { selectionRange: Range }).selectionRange.start.line).toBe(1);

      const location = await definition.provideDefinition(document, cursor) as {
        uri: { fsPath: string }; range: Range
      };
      expect(location.uri.fsPath).toBe(basePyPath);
      expect(location.range.start.line).toBe(1);
      // 两种入口同一目标(文件+行)
      expect(location.uri.fsPath).toBe((item as { uri: { fsPath: string } }).uri.fsPath);
      expect(location.range.start.line)
        .toBe((item as { selectionRange: Range }).selectionRange.start.line);
    });
  });

  it('mixin 实现全项目唯一:两入口同落 mixin 文件(域目录无果→全局唯一回退)', async () => {
    await withIndexedDefs(true, async () => {
      const manager = await makeManager();
      const hierarchy = new KBEngineCallHierarchyProvider(manager);
      const definition = new KBEngineDefinitionProvider(manager);
      const document = defDocument();
      const cursor = cursorOnWord(AVATAR_DEF, 'onTick');

      const item = await hierarchy.prepareCallHierarchy(document, cursor);
      expect(item, '层次根到 mixin 实现').toBeTruthy();
      expect((item as { uri: { fsPath: string } }).uri.fsPath).toBe(mixinPyPath);
      expect((item as { selectionRange: Range }).selectionRange.start.line).toBe(1);

      const location = await definition.provideDefinition(document, cursor) as {
        uri: { fsPath: string }; range: Range
      };
      expect(location.uri.fsPath).toBe(mixinPyPath);
      expect(location.range.start.line).toBe(1);
    });
  });

  it('无任何实现:层次如实 null(F12 展示兜底不是 python 目标,层次不借)', async () => {
    await withIndexedDefs(true, async () => {
      const manager = await makeManager();
      const hierarchy = new KBEngineCallHierarchyProvider(manager);
      const definition = new KBEngineDefinitionProvider(manager);
      const document = defDocument();
      const cursor = cursorOnWord(AVATAR_DEF, 'ghost');

      const item = await hierarchy.prepareCallHierarchy(document, cursor);
      expect(item).toBeNull();

      const location = await definition.provideDefinition(document, cursor) as {
        uri: { fsPath: string }; range: Range
      };
      expect(location, 'F12 仍有展示回落(注册声明/def 首行)').toBeTruthy();
      expect(location.uri.fsPath).not.toBe(mixinPyPath);
      expect(location.uri.fsPath).not.toBe(basePyPath);
    });
  });
});
