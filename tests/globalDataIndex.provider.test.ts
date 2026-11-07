import { describe, expect, it } from 'vitest';
import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { workspaceEvents } from './helpers/vscodeStub';
import { configurationOverrides } from './fake-vscode/workspaceState';
import { resetScanRootCache } from '../src/scanRoots';
import { EntityMappingManager } from '../src/entityMapping';
import {
  KBEngineHoverProvider,
  KBEngineReferencesProvider,
  PythonDefinitionProvider,
  setPythonDataDictIndexEnabled
} from '../src/languageProviders';
import { PythonTypeInlayHintsProvider } from '../src/typeInlayHints';
import {
  GlobalDataDictIndex,
  extractFunctionReturns,
  findKbeDataDictAccesses,
  findKbeDataDictAccessesSliced,
  findLineCommentIndex,
  getKbeDataDictAccessAtPosition,
  inferDataDictValueType,
  isKeyInsideLineComment,
  normalizeKeySignature,
  queryDataDictSitesForAccess,
  REBUILD_SCAN_CONCURRENCY,
  replaceFileSitesSliced,
  resolveFunctionReturns
} from '../src/globalDataIndex';
import type { KbeDataDictSite } from '../src/globalDataIndex';
import { getKbeAliases } from '../src/kbeModuleIndex';

// GLOBDATA-001(2026-10-30 用户令):KBEngine.globalData/baseAppData/cellAppData
// 字典键访问索引。纯逻辑面:键签名归一(字面量/标识符/计算键骨架)与

const KBE = new Set(['KBEngine', 'kbe']);

describe('GLOBDATA-001 provider 装配(定义/引用)', () => {
  /** 临时双文件工作区:writer 写点 + reader 读点(同键 cfg)。 */
  const setupWorkspace = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdip-'));
    const writer = path.join(root, 'base', 'writer.py');
    const reader = path.join(root, 'cell', 'reader.py');
    fs.mkdirSync(path.dirname(writer), { recursive: true });
    fs.mkdirSync(path.dirname(reader), { recursive: true });
    const writerText = 'import KBEngine\nKBEngine.globalData["cfg"] = {"gold": 1}\n';
    const readerText = 'import KBEngine\nvalue = KBEngine.globalData.get("cfg")\n';
    fs.writeFileSync(writer, writerText);
    fs.writeFileSync(reader, readerText);
    return { root, writer, reader, writerText, readerText };
  };

  it('读点 F12 跳首个写点;写点 F12 跳首个异类同键点(跨文件)', async () => {
    const { root, writer, reader, writerText, readerText } = setupWorkspace();
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    const provider = new PythonDefinitionProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      undefined,
      index
    );
    try {
      // 读点 F12 → writer 写点(行 1,列 = `["cfg"]` 的引号)
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const readPos = new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1);
      const fromRead = await provider.provideDefinition(readDoc, readPos) as vscode.Location | null;
      expect(fromRead?.uri.fsPath).toBe(writer);
      expect(fromRead?.range.start.line).toBe(1);
      expect(fromRead?.range.start.character).toBe(writerText.split('\n')[1].indexOf('"cfg"'));
      // 写点 F12 → reader 读点(异类优先)
      const writeDoc = vscode.makeTextDocument(writerText, { fileName: writer, languageId: 'python' });
      const writePos = new vscode.Position(1, writerText.split('\n')[1].indexOf('cfg') + 1);
      const fromWrite = await provider.provideDefinition(writeDoc, writePos) as vscode.Location | null;
      expect(fromWrite?.uri.fsPath).toBe(reader);
      expect(fromWrite?.range.start.line).toBe(1);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('引用 Shift+F12 返回同键族全部写+读点;不在键上返回 null', async () => {
    const { root, writer, reader, readerText } = setupWorkspace();
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    const refs = new KBEngineReferencesProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      index
    );
    try {
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const onKey = await refs.provideReferences(
        readDoc,
        new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1),
        {} as vscode.ReferenceContext
      );
      const files = (onKey ?? []).map(loc => path.basename(loc.uri.fsPath)).sort();
      expect(files).toEqual(['reader.py', 'writer.py']);
      // 不在键上(行首)返回 null
      const offKey = await refs.provideReferences(
        readDoc,
        new vscode.Position(0, 0),
        {} as vscode.ReferenceContext
      );
      expect(offKey).toBeNull();
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('注释里的假访问不触发;开关关闭不查索引', async () => {
    const { root, writer, reader, writerText, readerText } = setupWorkspace();
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    const provider = new PythonDefinitionProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      undefined,
      index
    );
    try {
      // 注释里的字典访问:行内 # 前的键不算真代码 → 交回常规链(location null)
      const commented = 'import KBEngine\n# KBEngine.globalData.get("cfg")\n';
      const commentDoc = vscode.makeTextDocument(commented, { fileName: reader, languageId: 'python' });
      const onComment = await provider.provideDefinition(
        commentDoc,
        new vscode.Position(1, commented.split('\n')[1].indexOf('cfg') + 1)
      ) as vscode.Location | null;
      expect(onComment).toBeNull();

      // 开关关闭:字符串键守卫前即跳过,交回 context skip(location null)
      setPythonDataDictIndexEnabled(false);
      try {
        const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
        const off = await provider.provideDefinition(
          readDoc,
          new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1)
        ) as vscode.Location | null;
        expect(off).toBeNull();
      } finally {
        setPythonDataDictIndexEnabled(true);
      }
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('GLOBDATA-002 inlay/hover 装配', () => {
  const setupWorkspace = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdip2-'));
    const writer = path.join(root, 'base', 'writer.py');
    const reader = path.join(root, 'cell', 'reader.py');
    fs.mkdirSync(path.dirname(writer), { recursive: true });
    fs.mkdirSync(path.dirname(reader), { recursive: true });
    const writerText = 'import KBEngine\nKBEngine.globalData["cfg"] = {"gold": 1}\n';
    const readerText = 'import KBEngine\nvalue = KBEngine.globalData.get("cfg")\n';
    fs.writeFileSync(writer, writerText);
    fs.writeFileSync(reader, readerText);
    const stubs = {
      originalFind: vscode.workspace.findFiles,
      originalRead: vscode.workspace.fs.readFile
    };
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    return { root, writer, reader, writerText, readerText, stubs };
  };

  it('inlay:写点 RHS 类型 + 读点同键写点 union;无写点/未知 RHS 不出', async () => {
    const { root, writer, reader, writerText, readerText, stubs } = setupWorkspace();
    const index = new GlobalDataDictIndex();
    const provider = new PythonTypeInlayHintsProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      index
    );
    try {
      const writeDoc = vscode.makeTextDocument(writerText, { fileName: writer, languageId: 'python' });
      const writeHints = await provider.provideInlayHints(
        writeDoc,
        new vscode.Range(1, 0, 1, writerText.split('\n')[1].length)
      );
      expect(writeHints.map(h => h.label)).toContain(': Dict[str, int]');

      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const readHints = await provider.provideInlayHints(
        readDoc,
        new vscode.Range(1, 0, 1, readerText.split('\n')[1].length)
      );
      expect(readHints.map(h => h.label)).toContain(': Dict[str, int]');

      // 无写点键 → 读点不出
      const noWrite = 'import KBEngine\nvalue = KBEngine.globalData.get("orphan")\n';
      const noWriteDoc = vscode.makeTextDocument(noWrite, { fileName: reader, languageId: 'python' });
      const noWriteHints = await provider.provideInlayHints(
        noWriteDoc,
        new vscode.Range(1, 0, 1, noWrite.split('\n')[1].length)
      );
      expect(noWriteHints.map(h => h.label)).not.toContain(': ');
      // 未知 RHS → 写点不出
      const unknown = 'import KBEngine\nKBEngine.globalData["k"] = foo()\n';
      const unknownDoc = vscode.makeTextDocument(unknown, { fileName: writer, languageId: 'python' });
      const unknownHints = await provider.provideInlayHints(
        unknownDoc,
        new vscode.Range(1, 0, 1, unknown.split('\n')[1].length)
      );
      expect(unknownHints.map(h => h.label)).not.toContain(': ');
    } finally {
      index.dispose();
      vscode.workspace.findFiles = stubs.originalFind;
      vscode.workspace.fs.readFile = stubs.originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('hover:读点显示同键写点类型+首个写点位置;写点显示 RHS 类型', async () => {
    const { root, writer, reader, writerText, readerText, stubs } = setupWorkspace();
    const index = new GlobalDataDictIndex();
    const provider = new KBEngineHoverProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      index
    );
    try {
      const hoverText = (hover: vscode.Hover | null): string => {
        if (!hover) {
          return '';
        }
        const contents = hover.contents as { value: string } | Array<{ value: string }>;
        return Array.isArray(contents) ? contents.map(item => item.value).join('') : contents.value;
      };
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const readLine = readerText.split('\n')[1];
      const readHover = await provider.provideHover(
        readDoc,
        new vscode.Position(1, readLine.indexOf('cfg') + 1)
      ) as vscode.Hover | null;
      const readText = hoverText(readHover);
      expect(readText).toContain('Dict[str, int]');
      expect(readText).toContain('首个写点');
      expect(readText).toContain('writer.py');

      const writeDoc = vscode.makeTextDocument(writerText, { fileName: writer, languageId: 'python' });
      const writeLine = writerText.split('\n')[1];
      const writeHover = await provider.provideHover(
        writeDoc,
        new vscode.Position(1, writeLine.indexOf('cfg') + 1)
      ) as vscode.Hover | null;
      const writeText = hoverText(writeHover);
      expect(writeText).toContain('Dict[str, int]');
      expect(writeText).toContain('写点');
    } finally {
      index.dispose();
      vscode.workspace.findFiles = stubs.originalFind;
      vscode.workspace.fs.readFile = stubs.originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('GLOBDATA-003 函数调用键 provider 导航(定义/引用)', () => {
  const setupCallKeyWorkspace = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdi-k-'));
    const defs = path.join(root, 'base', 'defs.py');
    const writer = path.join(root, 'base', 'writer.py');
    const reader = path.join(root, 'cell', 'reader.py');
    fs.mkdirSync(path.dirname(defs), { recursive: true });
    fs.mkdirSync(path.dirname(reader), { recursive: true });
    const defsText = 'def GetServerGlobalDataKey(serverId):\n    return "SERVER_" + str(serverId)\n';
    const writerText = 'import KBEngine\nKBEngine.globalData["SERVER_" + str(serverId)] = {"gold": 1}\n';
    const readerText = 'import KBEngine\nvalue = KBEngine.globalData.get(GetServerGlobalDataKey(serverId))\n';
    fs.writeFileSync(defs, defsText);
    fs.writeFileSync(writer, writerText);
    fs.writeFileSync(reader, readerText);
    return { root, defs, writer, reader, writerText, readerText };
  };

  const withIndex = async (
    files: string[],
    run: (index: GlobalDataDictIndex, provider: PythonDefinitionProvider, refs: KBEngineReferencesProvider) => Promise<void>
  ): Promise<void> => {
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => files.map(f => vscode.Uri.file(f));
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    const provider = new PythonDefinitionProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      undefined,
      index
    );
    const refs = new KBEngineReferencesProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      index
    );
    try {
      await run(index, provider, refs);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
    }
  };

  it('读点 `.get(Fn(x))` F12 跳跨文件写点;写点 F12 跳读点(拼接签名互链)', async () => {
    const { root, defs, writer, reader, writerText, readerText } = setupCallKeyWorkspace();
    try {
      await withIndex([defs, writer, reader], async (_index, provider) => {
        const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
        const readPos = new vscode.Position(1, readerText.split('\n')[1].indexOf('GetServerGlobalDataKey') + 1);
        const fromRead = await provider.provideDefinition(readDoc, readPos) as vscode.Location | null;
        expect(fromRead?.uri.fsPath).toBe(writer);
        expect(fromRead?.range.start.line).toBe(1);
        const writeDoc = vscode.makeTextDocument(writerText, { fileName: writer, languageId: 'python' });
        const writePos = new vscode.Position(1, writerText.split('\n')[1].indexOf('SERVER_') + 3);
        const fromWrite = await provider.provideDefinition(writeDoc, writePos) as vscode.Location | null;
        expect(fromWrite?.uri.fsPath).toBe(reader);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('字面量 return 与多 return 多签名:读点 F12 命中对应写点', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdi-kl-'));
    const defs = path.join(root, 'base', 'defs.py');
    const writer = path.join(root, 'base', 'writer.py');
    const reader = path.join(root, 'cell', 'reader.py');
    fs.mkdirSync(path.dirname(defs), { recursive: true });
    fs.mkdirSync(path.dirname(reader), { recursive: true });
    const defsText = [
      'def CfgKey():',
      '    return "cfg"',
      'def MultiKey(c):',
      '    if c:',
      '        return "m_a"',
      '    return "m_b"',
      ''
    ].join('\n');
    const writerText = 'import KBEngine\nKBEngine.globalData["cfg"] = 1\nKBEngine.globalData["m_a"] = 2\nKBEngine.globalData["m_b"] = 3\n';
    const readerText = 'import KBEngine\nv = KBEngine.globalData.get(CfgKey())\nw = KBEngine.globalData.get(MultiKey(1))\n';
    fs.writeFileSync(defs, defsText);
    fs.writeFileSync(writer, writerText);
    fs.writeFileSync(reader, readerText);
    try {
      await withIndex([defs, writer, reader], async (_index, provider) => {
        const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
        const lines = readerText.split('\n');
        const cfgPos = new vscode.Position(1, lines[1].indexOf('CfgKey') + 1);
        const cfgHit = await provider.provideDefinition(readDoc, cfgPos) as vscode.Location | null;
        expect(cfgHit?.uri.fsPath).toBe(writer);
        expect(cfgHit?.range.start.line).toBe(1);
        const multiPos = new vscode.Position(2, lines[2].indexOf('MultiKey') + 1);
        const multiHit = await provider.provideDefinition(readDoc, multiPos) as vscode.Location | null;
        expect(multiHit?.uri.fsPath).toBe(writer);
        expect([2, 3]).toContain(multiHit?.range.start.line);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('写侧 `[Fn(x)] = v` F12 跳读点;引用互链(写+读)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdi-kw-'));
    const defs = path.join(root, 'base', 'defs.py');
    const writer = path.join(root, 'base', 'writer.py');
    const reader = path.join(root, 'cell', 'reader.py');
    fs.mkdirSync(path.dirname(defs), { recursive: true });
    fs.mkdirSync(path.dirname(reader), { recursive: true });
    const defsText = 'def GetServerGlobalDataKey(serverId):\n    return "SERVER_" + str(serverId)\n';
    const writerText = 'import KBEngine\nKBEngine.globalData[GetServerGlobalDataKey(serverId)] = {"gold": 1}\n';
    const readerText = 'import KBEngine\nvalue = KBEngine.globalData.get("SERVER_" + str(serverId))\n';
    fs.writeFileSync(defs, defsText);
    fs.writeFileSync(writer, writerText);
    fs.writeFileSync(reader, readerText);
    try {
      await withIndex([defs, writer, reader], async (_index, provider, refs) => {
        const writeDoc = vscode.makeTextDocument(writerText, { fileName: writer, languageId: 'python' });
        const writePos = new vscode.Position(1, writerText.split('\n')[1].indexOf('GetServerGlobalDataKey') + 1);
        const fromWrite = await provider.provideDefinition(writeDoc, writePos) as vscode.Location | null;
        expect(fromWrite?.uri.fsPath).toBe(reader);
        const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
        const readPos = new vscode.Position(1, readerText.split('\n')[1].indexOf('SERVER_') + 3);
        const refsOut = await refs.provideReferences(readDoc, readPos, {} as vscode.ReferenceContext);
        const files = (refsOut ?? []).map(loc => path.basename(loc.uri.fsPath)).sort();
        expect(files).toEqual(['reader.py', 'writer.py']);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
