import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineReferencesProvider, PythonDefinitionProvider } from '../src/languageProviders';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// 用户反馈(2026-11-04):def 声明 <arena_data><Type>JSON</Type></arena_data>(JSON 是
// types.xml 自定义类型,一个 dict)。在 .py 里光标落在 self.arena_data 上:
//  - F12 应跳 def 文件的 <arena_data> 属性声明行(而非 types.xml 的 JSON 声明);
//  - Shift+F12(与 Shift+Alt+F12 同一 ReferenceProvider.provideReferences)应列出
//    def 声明 + py 里全部 self.arena_data 使用处。
// def 侧(在 def 里选 JSON → F12 types.xml,Shift+F12 全部使用处)已工作,本文件
// 只锁 py 侧;真实 EntityMappingManager + 临时工作区(与 defPropertyReferences 同款装配)。

const TYPES_XML = ['<root>', '  <JSON>UINT16</JSON>', '</root>'].join('\n');

const HERO_DEF = [
  '<root>',
  '  <Properties>',
  '    <arena_data>',
  '      <Type>JSON</Type>',
  '    </arena_data>',
  '  </Properties>',
  '</root>'
].join('\n');

const HERO_PY = [
  'class Hero(kbe.KBEntity):',
  '    def f(self):',
  '        self.arena_data = {}',
  '        return self.arena_data',
  ''
].join('\n');

/** <arena_data> 声明行(0 基)= F12 落点行 */
const ARENA_DECL_LINE = HERO_DEF.split('\n').findIndex(line => line.includes('<arena_data>'));

/** self.arena_data 首处使用位:行 2(0 基)字符 15(在 arena_data 名内) */
const ARENA_POS = new Position(2, 15);

const buildWorkspace = (): { root: string; defsDir: string; heroDef: string; heroPy: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-arena-'));
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  const defsDir = path.join(root, 'scripts', 'entity_defs');
  put('scripts/entity_defs/types.xml', TYPES_XML);
  const heroDef = put('scripts/entity_defs/Hero.def', HERO_DEF);
  const heroPy = put('scripts/base/Hero.py', HERO_PY);
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  return { root, defsDir, heroDef, heroPy };
};

const makeManager = async (): Promise<EntityMappingManager> => {
  const manager = new EntityMappingManager({ subscriptions: [] } as never);
  await (manager as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
  return manager;
};

const pyDoc = (heroPy: string) =>
  makeTextDocument(HERO_PY, { fileName: heroPy, languageId: 'python' }) as never;

/** 按 glob 返回本工作区 def/types.xml(仿 defSymbolReferences 装配) */
const mockFindFiles = (ws: { heroDef: string; defsDir: string }): typeof stubWorkspace.findFiles =>
  (async (glob?: string) => {
    if (typeof glob !== 'string') {
      return [];
    }
    if (glob === '**/*.def') {
      return [Uri.file(ws.heroDef)];
    }
    if (glob === '**/types.xml') {
      return [Uri.file(path.join(ws.defsDir, 'types.xml'))];
    }
    return [];
  }) as typeof stubWorkspace.findFiles;

describe('py 侧属性 F12 / Shift+F12(用户场景:arena_data/JSON)', () => {
  it('F12:self.arena_data → def 的 <arena_data> 声明行(不是 types.xml 的 JSON)', async () => {
    const ws = buildWorkspace();
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.findFiles = mockFindFiles(ws);
    try {
      const manager = await makeManager();
      const provider = new PythonDefinitionProvider(manager);
      const traced = await provider.provideDefinitionTraced(pyDoc(ws.heroPy), ARENA_POS, undefined);
      expect(traced.location).not.toBeNull();
      const loc = traced.location as { uri: { fsPath: string }; range: { start: { line: number } } };
      expect(loc.uri.fsPath).toBe(ws.heroDef);
      expect(loc.range.start.line).toBe(ARENA_DECL_LINE);
      expect(loc.uri.fsPath).not.toContain('types.xml');
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });

  it('Shift+F12(self.arena_data,includeDeclaration):def 声明 + Hero.py 两处使用', async () => {
    const ws = buildWorkspace();
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.findFiles = mockFindFiles(ws);
    try {
      const manager = await makeManager();
      const provider = new KBEngineReferencesProvider(manager);
      const result = await provider.provideReferences(
        pyDoc(ws.heroPy),
        ARENA_POS,
        { includeDeclaration: true },
        undefined
      );
      expect(result).not.toBeNull();
      const paths = result!.map(loc => loc.uri.fsPath);
      expect(paths.filter(p => p === ws.heroDef)).toHaveLength(1);
      expect(paths.filter(p => p === ws.heroPy)).toHaveLength(2);
      // def 声明行(行首)
      const decl = result!.find(loc => loc.uri.fsPath === ws.heroDef)!;
      expect(decl.range.start.line).toBe(ARENA_DECL_LINE);
      expect(decl.range.start.character).toBe(0);
      // py 使用位:行 2/3(0 基),字符对准属性名
      const pyAccesses = result!.filter(loc => loc.uri.fsPath === ws.heroPy);
      expect(pyAccesses.map(loc => loc.range.start.line).sort()).toEqual([2, 3]);
      for (const access of pyAccesses) {
        const lineText = HERO_PY.split('\n')[access.range.start.line];
        expect(
          lineText.slice(access.range.start.character, access.range.start.character + 'arena_data'.length)
        ).toBe('arena_data');
      }
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });

  it('Shift+F12(includeDeclaration=false):仅 Hero.py 两处,不含 def 声明', async () => {
    const ws = buildWorkspace();
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.findFiles = mockFindFiles(ws);
    try {
      const manager = await makeManager();
      const provider = new KBEngineReferencesProvider(manager);
      const result = await provider.provideReferences(
        pyDoc(ws.heroPy),
        ARENA_POS,
        { includeDeclaration: false },
        undefined
      );
      expect(result).not.toBeNull();
      expect(result!.length).toBe(2);
      expect(result!.every(loc => loc.uri.fsPath === ws.heroPy)).toBe(true);
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });
});
