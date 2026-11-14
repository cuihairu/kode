/**
 * KSEM-DATA-01(SEM-042)复核共享数据现有接线 — 审计钉。
 *
 * 验收口径(todo.md SEM-042):核实 globalData/baseAppData/cellAppData 的
 * 引用/跳转/类型消费和工程隔离;**已有功能只记录差距不重复实施**——
 * 本文件钉「现有接线面」的当前真值,并把已知差距按当前行为如实钉住
 * (差距的语义化修复属后续项:SEM-043 键补全/SEM-044 多写者联合/
 * SEM-045 异步可用性与进程域),本批不修不演。
 *
 * 接线复核面(现状全绿的部分):
 *  - 装配:一单例索引四处消费(definition/references/hover/inlay);
 *  - 开关:kbengine.python.enableDataDictIndex 关→四面全部静默;
 *  - 工程隔离:双根同键不互链(AUD-068 根身份键);三字典键空间互不相混;
 *  - 类型消费:读点 union 同键写点值类型;推不出(空 {}/调用式)不出。
 *
 * 差距钉(现状如实,不修):
 *  - del 归读点(无删除态)——删除对可用性/类型的影响不表达(SEM-045 域);
 *  - .get(k, default) 的 default 不入面——读点类型不消费兜底值(SEM-045 域);
 *  - 进程域不收窄——scripts/cell 与 scripts/base 同键互链,引擎真域
 *    (baseAppData 仅 baseapp、cellAppData 仅 cellapp)不缩小候选(SEM-045 域);
 *  - 三字典无补全面(hover 写读文案中文硬编码无 l10n)——差距记录在
 *    docs/review/2026-11-14-ksem-data-01-audit.md,不入测试面。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { EntityMappingManager } from '../src/entityMapping';
import {
  KBEngineHoverProvider,
  KBEngineReferencesProvider,
  PythonDefinitionProvider,
  setPythonDataDictIndexEnabled
} from '../src/languageProviders';
import { PythonTypeInlayHintsProvider } from '../src/typeInlayHints';
import { GlobalDataDictIndex } from '../src/globalDataIndex';
import { findKbeDataDictAccesses } from '../src/backend/globalDataIndexCore';

const ALIASES = new Set(['KBEngine', 'kbe']);
const stubManager = (): EntityMappingManager =>
  new EntityMappingManager({ subscriptions: [] } as never);

const hoverText = (hover: vscode.Hover | null): string => {
  if (!hover) {
    return '';
  }
  const contents = hover.contents as { value: string } | Array<{ value: string }>;
  return Array.isArray(contents) ? contents.map(item => item.value).join('') : contents.value;
};

describe('KSEM-DATA-01 复核:接线装配面', () => {
  /** 单根工作区:writer 写点 + reader 读点(同键 cfg)。 */
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'da01-'));
    const writer = path.join(root, 'base', 'writer.py');
    const reader = path.join(root, 'cell', 'reader.py');
    fs.mkdirSync(path.dirname(writer), { recursive: true });
    fs.mkdirSync(path.dirname(reader), { recursive: true });
    const writerText = 'import KBEngine\nKBEngine.globalData["cfg"] = {"gold": 1}\n';
    const readerText = 'import KBEngine\nvalue = KBEngine.globalData.get("cfg")\n';
    fs.writeFileSync(writer, writerText);
    fs.writeFileSync(reader, readerText);
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    const originalFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const restore = () => {
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      vscode.workspace.workspaceFolders = originalFolders;
      fs.rmSync(root, { recursive: true, force: true });
    };
    return { root, writer, reader, writerText, readerText, restore };
  };

  it('同一单例索引四处消费:definition 跳写点/references 全量/hover 出类型/inlay 出 union', async () => {
    const { root, writer, reader, writerText, readerText, restore } = setup();
    const index = new GlobalDataDictIndex();
    const definition = new PythonDefinitionProvider(stubManager(), undefined, index);
    const references = new KBEngineReferencesProvider(stubManager(), index);
    const hover = new KBEngineHoverProvider(stubManager(), index);
    const inlay = new PythonTypeInlayHintsProvider(stubManager(), index);
    try {
      // definition:读点 F12 → writer 写点
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const fromRead = await definition.provideDefinition(
        readDoc,
        new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1)
      ) as vscode.Location | null;
      expect(fromRead?.uri.fsPath).toBe(writer);
      // references:同键族全量(reader+writer 双文件)
      const onKey = await references.provideReferences(
        readDoc,
        new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1),
        {} as vscode.ReferenceContext
      );
      expect((onKey ?? []).map(loc => path.basename(loc.uri.fsPath)).sort())
        .toEqual(['reader.py', 'writer.py']);
      // hover:读点出同键写点类型 + 首个写点位置
      const readHover = hoverText(await hover.provideHover(
        readDoc,
        new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1)
      ) as vscode.Hover | null);
      expect(readHover).toContain('Dict[str, int]');
      expect(readHover).toContain('writer.py');
      // inlay:读点出同键写点值类型
      const readHints = await inlay.provideInlayHints(
        readDoc,
        new vscode.Range(1, 0, 1, readerText.split('\n')[1].length)
      );
      expect(readHints.map(h => h.label)).toContain(': Dict[str, int]');
      // inlay:写点出 RHS 类型
      const writeDoc = vscode.makeTextDocument(writerText, { fileName: writer, languageId: 'python' });
      const writeHints = await inlay.provideInlayHints(
        writeDoc,
        new vscode.Range(1, 0, 1, writerText.split('\n')[1].length)
      );
      expect(writeHints.map(h => h.label)).toContain(': Dict[str, int]');
      void root;
    } finally {
      index.dispose();
      restore();
    }
  });

  it('开关关闭:四面全部静默(definition/references 交回常规链)', async () => {
    const { reader, readerText, restore } = setup();
    const index = new GlobalDataDictIndex();
    const definition = new PythonDefinitionProvider(stubManager(), undefined, index);
    const references = new KBEngineReferencesProvider(stubManager(), index);
    try {
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const pos = new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1);
      setPythonDataDictIndexEnabled(false);
      expect(await definition.provideDefinition(readDoc, pos)).toBeNull();
      expect(await references.provideReferences(readDoc, pos, {} as vscode.ReferenceContext))
        .toBeNull();
    } finally {
      setPythonDataDictIndexEnabled(true);
      index.dispose();
      restore();
    }
  });
});

describe('KSEM-DATA-01 复核:工程隔离面', () => {
  it('双根同键不互链:根 B 的查询不含根 A 的写点(AUD-068 根身份键)', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'da01-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'da01-b-'));
    const writerA = path.join(rootA, 'writer.py');
    const writerB = path.join(rootB, 'writer.py');
    const readerB = path.join(rootB, 'reader.py');
    fs.writeFileSync(writerA, 'import KBEngine\nKBEngine.globalData["k"] = 1\n');
    fs.writeFileSync(writerB, 'import KBEngine\nKBEngine.globalData["k"] = "s"\n');
    fs.writeFileSync(readerB, 'import KBEngine\nvalue = KBEngine.globalData.get("k")\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    const originalFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.findFiles = async () =>
      [writerA, writerB, readerB].map(file => vscode.Uri.file(file));
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file(rootA), name: 'A', index: 0 },
      { uri: vscode.Uri.file(rootB), name: 'B', index: 1 }
    ];
    const index = new GlobalDataDictIndex();
    const references = new KBEngineReferencesProvider(stubManager(), index);
    const inlay = new PythonTypeInlayHintsProvider(stubManager(), index);
    try {
      const readerText = 'import KBEngine\nvalue = KBEngine.globalData.get("k")\n';
      const readDoc = vscode.makeTextDocument(readerText, { fileName: readerB, languageId: 'python' });
      const pos = new vscode.Position(1, readerText.split('\n')[1].indexOf('k') + 1);
      // 根 B 读点:references 只含根 B 的两点,根 A 写点不入列
      const refs = (await references.provideReferences(readDoc, pos, {} as vscode.ReferenceContext)) ?? [];
      expect(refs.map(loc => path.basename(loc.uri.fsPath)).sort()).toEqual(['reader.py', 'writer.py']);
      expect(refs.every(loc => loc.uri.fsPath.startsWith(rootB))).toBe(true);
      // 根 B 读点类型=根 B 写点 str,不含根 A 的 int
      const hints = await inlay.provideInlayHints(
        readDoc,
        new vscode.Range(1, 0, 1, readerText.split('\n')[1].length)
      );
      expect(hints.map(h => h.label)).toEqual([': str']);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      vscode.workspace.workspaceFolders = originalFolders;
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });

  it('三字典键空间互不相混:baseAppData 与 cellAppData 同名键不互链', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'da01-dict-'));
    const baseWriter = path.join(root, 'baseWriter.py');
    const cellReader = path.join(root, 'cellReader.py');
    fs.writeFileSync(baseWriter, 'import KBEngine\nKBEngine.baseAppData["k"] = 1\n');
    fs.writeFileSync(cellReader, 'import KBEngine\nvalue = KBEngine.cellAppData["k"]\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    const originalFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(baseWriter), vscode.Uri.file(cellReader)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const index = new GlobalDataDictIndex();
    const references = new KBEngineReferencesProvider(stubManager(), index);
    try {
      const cellText = 'import KBEngine\nvalue = KBEngine.cellAppData["k"]\n';
      const cellDoc = vscode.makeTextDocument(cellText, { fileName: cellReader, languageId: 'python' });
      // cellAppData["k"] 读点:baseAppData["k"] 写点不相混(字典是键空间一段)。
      // 同键族=同字典内访问点,含自身读点;无写点 → 只返回自身。
      const refs = await references.provideReferences(
        cellDoc,
        new vscode.Position(1, cellText.split('\n')[1].indexOf('k') + 1),
        {} as vscode.ReferenceContext
      );
      expect(refs).toHaveLength(1);
      expect(refs![0].uri.fsPath).toBe(cellReader);
      expect(refs![0].range.start.line).toBe(1);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      vscode.workspace.workspaceFolders = originalFolders;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('KSEM-DATA-01 复核:类型消费面(多写者联合现状)', () => {
  it('同根两写点 int+str:读点 inlay union "int | str"(SEM-044 现状:联合已并,来源说明未做)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'da01-union-'));
    const writerA = path.join(root, 'writerA.py');
    const writerB = path.join(root, 'writerB.py');
    const reader = path.join(root, 'reader.py');
    fs.writeFileSync(writerA, 'import KBEngine\nKBEngine.globalData["k"] = 1\n');
    fs.writeFileSync(writerB, 'import KBEngine\nKBEngine.globalData["k"] = "s"\n');
    const readerText = 'import KBEngine\nvalue = KBEngine.globalData.get("k")\n';
    fs.writeFileSync(reader, readerText);
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    const originalFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.findFiles = async () =>
      [writerA, writerB, reader].map(file => vscode.Uri.file(file));
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const index = new GlobalDataDictIndex();
    const inlay = new PythonTypeInlayHintsProvider(stubManager(), index);
    try {
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const hints = await inlay.provideInlayHints(
        readDoc,
        new vscode.Range(1, 0, 1, readerText.split('\n')[1].length)
      );
      expect(hints.map(h => h.label)).toEqual([': int | str']);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      vscode.workspace.workspaceFolders = originalFolders;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('KSEM-DATA-01 差距钉(SEM-045 已收 del/default/进程域三钉;余钉如实)', () => {
  it('del 下标访问=delete 态(SEM-045 已落地):keySignature 照常入索引', () => {
    const sites = findKbeDataDictAccesses('import KBEngine\ndel KBEngine.globalData["k"]\n', ALIASES);
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe('delete');
    expect(sites[0].keySignature).toBe('k');
    expect(sites[0].valueText).toBeNull();
  });

  it('.get(k, default) 的 default 已入面(SEM-045):valueText 恒 null、defaultText 取第二参', () => {
    const sites = findKbeDataDictAccesses(
      'import KBEngine\nv = KBEngine.globalData.get("k", {})\n',
      ALIASES
    );
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe('read');
    expect(sites[0].valueText).toBeNull();
    expect(sites[0].defaultText).toBe('{}');
  });

  it('进程域收窄只落类型/补全面:references 导航如实跨角色互链不收窄(SEM-045 裁定)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'da01-role-'));
    const cellWriter = path.join(root, 'scripts', 'cell', 'Avatar.py');
    const baseReader = path.join(root, 'scripts', 'base', 'Avatar.py');
    fs.mkdirSync(path.dirname(cellWriter), { recursive: true });
    fs.mkdirSync(path.dirname(baseReader), { recursive: true });
    fs.writeFileSync(cellWriter, 'import KBEngine\nKBEngine.cellAppData["k"] = 1\n');
    fs.writeFileSync(baseReader, 'import KBEngine\nvalue = KBEngine.cellAppData["k"]\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    const originalFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(cellWriter), vscode.Uri.file(baseReader)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const index = new GlobalDataDictIndex();
    const references = new KBEngineReferencesProvider(stubManager(), index);
    try {
      // 引擎真域:cellAppData 只在 cellapp 注册(baseapp/cellapp.cpp:200),
      // base 脚本运行期读不到。SEM-045 进程域收窄落在类型/提示/补全信息面,
      // 导航(references)按键身份如实跨角色互链——域过滤不偷换导航面。
      const baseText = 'import KBEngine\nvalue = KBEngine.cellAppData["k"]\n';
      const baseDoc = vscode.makeTextDocument(baseText, { fileName: baseReader, languageId: 'python' });
      const refs = await references.provideReferences(
        baseDoc,
        new vscode.Position(1, baseText.split('\n')[1].indexOf('k') + 1),
        {} as vscode.ReferenceContext
      );
      expect((refs ?? []).map(loc => loc.uri.fsPath).sort())
        .toEqual([baseReader, cellWriter].sort());
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      vscode.workspace.workspaceFolders = originalFolders;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('hover 文案当前中文硬编码(无 l10n):读点含中文标签', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'da01-l10n-'));
    const writer = path.join(root, 'writer.py');
    const reader = path.join(root, 'reader.py');
    fs.writeFileSync(writer, 'import KBEngine\nKBEngine.globalData["cfg"] = {"gold": 1}\n');
    fs.writeFileSync(reader, 'import KBEngine\nvalue = KBEngine.globalData.get("cfg")\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    const originalFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const index = new GlobalDataDictIndex();
    const hover = new KBEngineHoverProvider(stubManager(), index);
    try {
      const readerText = 'import KBEngine\nvalue = KBEngine.globalData.get("cfg")\n';
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const text = hoverText(await hover.provideHover(
        readDoc,
        new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1)
      ) as vscode.Hover | null);
      expect(text).toContain('读点');
      expect(text).toContain('同键写点');
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      vscode.workspace.workspaceFolders = originalFolders;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
