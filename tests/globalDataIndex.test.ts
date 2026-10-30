import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { workspaceEvents } from './helpers/vscodeStub';
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
  findKbeDataDictAccesses,
  findLineCommentIndex,
  getKbeDataDictAccessAtPosition,
  inferDataDictValueType,
  isKeyInsideLineComment,
  normalizeKeySignature
} from '../src/globalDataIndex';

// GLOBDATA-001(2026-10-30 用户令):KBEngine.globalData/baseAppData/cellAppData
// 字典键访问索引。纯逻辑面:键签名归一(字面量/标识符/计算键骨架)与
// 全文扫描(写点 `[K]=RHS`/读点 `[K]`/`.get(K)`);索引类跨文件互链 +
// noteSaved 编辑路径刷新。

const KBE = new Set(['KBEngine', 'kbe']);

describe('normalizeKeySignature(GLOBDATA-001 键粒度)', () => {
  it('精确形态:字符串字面量解引/标识符/数字按原文', () => {
    expect(normalizeKeySignature("'config'")).toBe('config');
    expect(normalizeKeySignature('"a.b"')).toBe('a.b');
    expect(normalizeKeySignature('xx')).toBe('xx');
    expect(normalizeKeySignature('42')).toBe('42');
    expect(normalizeKeySignature('-3.14')).toBe('-3.14');
  });

  it('计算键:f-string 与顶层 + 拼接折为字面量骨架+* 通配', () => {
    expect(normalizeKeySignature('f"SERVER_{id}"')).toBe('SERVER_*');
    expect(normalizeKeySignature('"SERVER_" + str(serverID)')).toBe('SERVER_*');
    expect(normalizeKeySignature('"A" + str(x) + "B"')).toBe('A*B');
    expect(normalizeKeySignature('"A" + "B"')).toBe('AB');
  });

  it('全动态/复杂/空 → null(不索引)', () => {
    expect(normalizeKeySignature('a + b')).toBeNull();
    expect(normalizeKeySignature('data[key]')).toBeNull();
    expect(normalizeKeySignature('make_key()')).toBeNull();
    expect(normalizeKeySignature('   ')).toBeNull();
  });
});

describe('findKbeDataDictAccesses(GLOBDATA-001 扫描)', () => {
  it('写点 [K]=RHS 与读点 [K]/get(K) 各自识别', () => {
    const text = [
      'import KBEngine',
      'KBEngine.globalData["cfg"] = {"gold": 1}',
      'KBEngine.globalData[xx] = yy',
      'value = KBEngine.globalData.get("cfg")',
      'other = KBEngine.baseAppData[KEY]',
      'KBEngine.cellAppData.get("c", 5)'
    ].join('\n');
    const accesses = findKbeDataDictAccesses(text, KBE);
    expect(accesses.map(a => ({ dict: a.dict, key: a.keySignature, kind: a.kind }))).toEqual([
      { dict: 'globalData', key: 'cfg', kind: 'write' },
      { dict: 'globalData', key: 'xx', kind: 'write' },
      { dict: 'globalData', key: 'cfg', kind: 'read' },
      { dict: 'baseAppData', key: 'KEY', kind: 'read' },
      { dict: 'cellAppData', key: 'c', kind: 'read' }
    ]);
    expect(accesses[0].valueText).toBe('{"gold": 1}');
    expect(accesses[1].valueText).toBe('yy');
  });

  it('== 比较不算赋值;增强赋值算写但无值文本;get 默认值忽略', () => {
    const text = [
      'a = KBEngine.globalData[k] == 5',
      'KBEngine.globalData[k] += 1',
      'b = KBEngine.globalData.get(k, 5)'
    ].join('\n');
    const accesses = findKbeDataDictAccesses(text, KBE);
    expect(accesses.map(a => ({ key: a.keySignature, kind: a.kind, valueText: a.valueText }))).toEqual([
      { key: 'k', kind: 'read', valueText: null },
      { key: 'k', kind: 'write', valueText: null },
      { key: 'k', kind: 'read', valueText: null }
    ]);
  });

  it('计算键写读同签名(字面量骨架+通配)可互链', () => {
    const text = [
      'KBEngine.globalData["SERVER_" + str(serverID)] = xxx',
      'v = KBEngine.globalData.get("SERVER_" + str(serverID))',
      'w = KBEngine.globalData.get(f"SERVER_{serverID}")'
    ].join('\n');
    const accesses = findKbeDataDictAccesses(text, KBE);
    expect(accesses.map(a => a.keySignature)).toEqual(['SERVER_*', 'SERVER_*', 'SERVER_*']);
    expect(accesses.every(a => a.kind === 'write' || a.kind === 'read')).toBe(true);
    expect(accesses[0].kind).toBe('write');
    expect(accesses[1].kind).toBe('read');
  });

  it('非别名接收者、属性链前缀、跨行括号不闭合、复杂键全部跳过', () => {
    const text = [
      'foo.globalData[k] = 1',
      'x.KBEngine.globalData[k] = 1',
      'KBEngine.globalData["cfg"',
      'KBEngine.globalData[data[k]] = 1',
      'import KBEngine'
    ].join('\n');
    expect(findKbeDataDictAccesses(text, KBE)).toEqual([]);
  });

  it('别名未引入(空集)不扫描', () => {
    expect(findKbeDataDictAccesses('KBEngine.globalData[k] = 1', new Set())).toEqual([]);
  });
});

describe('getKbeDataDictAccessAtPosition(GLOBDATA-001 定位)', () => {
  it('落点落在键表达式上命中,落点在外返回 null', () => {
    const line = 'KBEngine.globalData.get("cfg")';
    const onKey = getKbeDataDictAccessAtPosition(line, line.indexOf('cfg') + 1, KBE);
    expect(onKey?.keySignature).toBe('cfg');
    expect(onKey?.kind).toBe('read');
    expect(getKbeDataDictAccessAtPosition(line, 0, KBE)).toBeNull();
  });
});

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

describe('inferDataDictValueType(GLOBDATA-002 能推才显)', () => {
  it('字面量:int/float/str/bool/None', () => {
    expect(inferDataDictValueType('1')).toBe('int');
    expect(inferDataDictValueType('-3')).toBe('int');
    expect(inferDataDictValueType('2.5')).toBe('float');
    expect(inferDataDictValueType('1e3')).toBe('float');
    expect(inferDataDictValueType('"cfg"')).toBe('str');
    expect(inferDataDictValueType("'a.b'")).toBe('str');
    expect(inferDataDictValueType('f"SERVER_{id}"')).toBe('str');
    expect(inferDataDictValueType('True')).toBe('bool');
    expect(inferDataDictValueType('None')).toBe('None');
  });

  it('集合字面量:List/Dict/Set/Tuple,异类取 union,空/Any 抑制', () => {
    expect(inferDataDictValueType('[1, 2]')).toBe('List[int]');
    expect(inferDataDictValueType('[1, "a"]')).toBe('List[int | str]');
    expect(inferDataDictValueType('{"gold": 1}')).toBe('Dict[str, int]');
    expect(inferDataDictValueType('{"a": 1, "b": "x"}')).toBe('Dict[str, int | str]');
    expect(inferDataDictValueType('{1, 2}')).toBe('Set[int]');
    expect(inferDataDictValueType('(1, "a")')).toBe('Tuple[int, str]');
    expect(inferDataDictValueType('(1,)')).toBe('Tuple[int]');
    expect(inferDataDictValueType('[]')).toBeNull();
    expect(inferDataDictValueType('{}')).toBeNull();
    expect(inferDataDictValueType('()')).toBeNull();
  });

  it('构造调用:已知内建/类构造可取,未知/运算符/标识符不出', () => {
    expect(inferDataDictValueType('str(x)')).toBe('str');
    expect(inferDataDictValueType('Avatar(1)')).toBe('Avatar');
    expect(inferDataDictValueType('dict()')).toBeNull();
    expect(inferDataDictValueType('list()')).toBeNull();
    expect(inferDataDictValueType('foo()')).toBeNull();
    expect(inferDataDictValueType('a + b')).toBeNull();
    expect(inferDataDictValueType('xx')).toBeNull();
    expect(inferDataDictValueType('self.attr')).toBeNull();
    expect(inferDataDictValueType(null)).toBeNull();
  });
});

describe('GLOBDATA-002 exprEnd 标注位与注释剥离', () => {
  it('写点 exprEnd=RHS 尾(尾随注释剥离);读点 exprEnd=`]`/`)` 尾', () => {
    const text = [
      'import KBEngine',
      'KBEngine.globalData["cfg"] = {"gold": 1}  # note',
      'v = KBEngine.globalData.get("cfg")',
      'w = KBEngine.globalData[k]'
    ].join('\n');
    const accesses = findKbeDataDictAccesses(text, KBE);
    expect(accesses[0].valueText).toBe('{"gold": 1}');
    expect(accesses[0].exprEnd).toBe(text.split('\n')[1].indexOf('{') + '{"gold": 1}'.length);
    expect(accesses[1].exprEnd).toBe(text.split('\n')[2].indexOf('get("cfg")') + 'get("cfg")'.length);
    expect(accesses[2].exprEnd).toBe(text.split('\n')[3].indexOf('[k]') + 3);
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

describe('GlobalDataDictIndex(GLOBDATA-001 跨文件索引)', () => {
  it('同键写读点跨文件互链;noteSaved 编辑路径重扫刷新倒排', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdi-'));
    const writer = path.join(root, 'base', 'writer.py');
    const reader = path.join(root, 'cell', 'reader.py');
    fs.mkdirSync(path.dirname(writer), { recursive: true });
    fs.mkdirSync(path.dirname(reader), { recursive: true });
    fs.writeFileSync(writer, 'import KBEngine\nKBEngine.globalData["cfg"] = 1\n');
    fs.writeFileSync(reader, 'import KBEngine\nvalue = KBEngine.globalData.get("cfg")\n');

    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);

    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      const sites = index.query('globalData', 'cfg');
      expect(sites.map(s => ({ kind: s.kind, file: path.basename(s.file) }))).toEqual([
        { kind: 'write', file: 'writer.py' },
        { kind: 'read', file: 'reader.py' }
      ]);

      // 编辑路径:writer 改键 + 改读点 → 旧键 cfg 只剩 reader 读点,新键 other 进写点
      index.noteSaved({
        uri: { fsPath: writer },
        getText: () => 'import KBEngine\nKBEngine.globalData["other"] = 2\n'
      } as never);
      expect(index.query('globalData', 'cfg').map(s => s.kind)).toEqual(['read']);
      expect(index.query('globalData', 'other').map(s => s.kind)).toEqual(['write']);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('GlobalDataDictIndex(GLOBDATA-001 生命周期/覆盖)', () => {
  /** 捕获本测试自建 watcher 的手工桩(可 fire create/change/delete)。 */
  const captureWatcher = (): {
    fireCreate: (uri: vscode.Uri) => void;
    fireChange: (uri: vscode.Uri) => void;
    fireDelete: (uri: vscode.Uri) => void;
    disposed: () => boolean;
  } => {
    const listeners: {
      create: Array<(uri: vscode.Uri) => void>;
      change: Array<(uri: vscode.Uri) => void>;
      delete: Array<(uri: vscode.Uri) => void>;
    } = { create: [], change: [], delete: [] };
    const original = vscode.workspace.createFileSystemWatcher;
    vscode.workspace.createFileSystemWatcher = ((): unknown => ({
      onDidCreate: (l: (uri: vscode.Uri) => void) => { listeners.create.push(l); return { dispose: () => undefined }; },
      onDidChange: (l: (uri: vscode.Uri) => void) => { listeners.change.push(l); return { dispose: () => undefined }; },
      onDidDelete: (l: (uri: vscode.Uri) => void) => { listeners.delete.push(l); return { dispose: () => undefined }; },
      dispose: () => undefined
    })) as typeof original;
    const restore = (): void => { vscode.workspace.createFileSystemWatcher = original; };
    return {
      fireCreate: uri => listeners.create.forEach(l => l(uri)),
      fireChange: uri => listeners.change.forEach(l => l(uri)),
      fireDelete: uri => listeners.delete.forEach(l => l(uri)),
      disposed: () => listeners.create.length === 0
    };
  };

  it('watcher create/change/delete 驱动倒排:新增/更新/删除同键站点', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdiw-'));
    const a = path.join(root, 'a.py');
    const b = path.join(root, 'b.py');
    fs.writeFileSync(a, 'import KBEngine\nKBEngine.globalData["k"] = 1\n');
    fs.writeFileSync(b, 'import KBEngine\nv = KBEngine.globalData.get("k")\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(a), vscode.Uri.file(b)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const watcher = captureWatcher();
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'k').map(s => s.kind)).toEqual(['write', 'read']);
      // create:新文件带同键读点 → 倒排追加
      const c = path.join(root, 'c.py');
      fs.writeFileSync(c, 'import KBEngine\nw = KBEngine.globalData.get("k")\n');
      watcher.fireCreate(vscode.Uri.file(c));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(index.query('globalData', 'k').map(s => s.kind)).toEqual(['write', 'read', 'read']);
      // change:a.py 改键 k→z → k 只剩读点,z 进写点
      fs.writeFileSync(a, 'import KBEngine\nKBEngine.globalData["z"] = 2\n');
      watcher.fireChange(vscode.Uri.file(a));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(index.query('globalData', 'k').map(s => s.kind)).toEqual(['read', 'read']);
      expect(index.query('globalData', 'z').map(s => s.kind)).toEqual(['write']);
      // delete:b.py 删除 → k 读点剩 1
      watcher.fireDelete(vscode.Uri.file(b));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(index.query('globalData', 'k').map(s => s.kind)).toEqual(['read']);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rename:旧路径撤除、有缓存项则迁移到新路径(内容不变)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdir-'));
    const writer = path.join(root, 'writer.py');
    const reader = path.join(root, 'reader.py');
    fs.writeFileSync(writer, 'import KBEngine\nKBEngine.globalData["cfg"] = 1\n');
    fs.writeFileSync(reader, 'import KBEngine\nv = KBEngine.globalData.get("cfg")\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      // writer.py 重命名到 moved.py(内容随迁移保持)→ cfg 写点迁至新路径
      const moved = path.join(root, 'moved.py');
      fs.renameSync(writer, moved);
      workspaceEvents.filesRenamed.fire({ files: [{ oldUri: vscode.Uri.file(writer), newUri: vscode.Uri.file(moved) }] });
      await new Promise(resolve => setTimeout(resolve, 20));
      const cfg = index.query('globalData', 'cfg');
      expect(cfg.map(s => s.kind).sort()).toEqual(['read', 'write']);
      const writeSite = cfg.find(s => s.kind === 'write')!;
      expect(writeSite.file).toBe(moved);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rename:旧路径无缓存项(未扫到的 .py)→ 按新路径全量重建', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdirn-'));
    const writer = path.join(root, 'writer.py');
    fs.writeFileSync(writer, 'import KBEngine\nKBEngine.globalData["cfg"] = 1\n');
    // 未扫到的 .py:不在 findFiles 返回集 → 无缓存项
    const orphan = path.join(root, 'orphan.py');
    fs.writeFileSync(orphan, 'import KBEngine\nKBEngine.globalData["fresh"] = 7\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'fresh')).toEqual([]);
      const moved = path.join(root, 'orphan-moved.py');
      fs.renameSync(orphan, moved);
      workspaceEvents.filesRenamed.fire({ files: [{ oldUri: vscode.Uri.file(orphan), newUri: vscode.Uri.file(moved) }] });
      await new Promise(resolve => setTimeout(resolve, 20));
      const fresh = index.query('globalData', 'fresh');
      expect(fresh.map(s => s.kind)).toEqual(['write']);
      expect(fresh[0].file).toBe(moved);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('幂等 ensureStarted/销毁后零工作/非 py noteSaved/缺失键查询', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdie-'));
    const py = path.join(root, 'x.py');
    fs.writeFileSync(py, 'import KBEngine\nKBEngine.globalData["k"] = 1\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(py)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      await index.ensureStarted(); // started=true → 立即返回(不重扫)
      expect(index.query('globalData', 'k').map(s => s.kind)).toEqual(['write']);
      expect(index.query('globalData', 'missing')).toEqual([]);
      // noteSaved 非 .py → 早退不炸
      index.noteSaved({ uri: { fsPath: path.join(root, 'y.def') }, getText: () => '' } as never);
      expect(index.query('globalData', 'k').map(s => s.kind)).toEqual(['write']);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
    // 销毁后:ensureStarted 早退,noteSaved 早退
    await index.ensureStarted();
    index.noteSaved({ uri: { fsPath: py }, getText: () => 'x' } as never);
  });

  /** 可控读:默认读盘;per-path 挂起队列 + 单次失败集合。 */
  const makeControllableRead = (): {
    read: typeof vscode.workspace.fs.readFile;
    hang: (p: string) => void;
    release: (p: string) => void;
    failNext: (p: string) => void;
  } => {
    const hanging = new Map<string, () => void>();
    const failOnce = new Set<string>();
    const read = (async (uri: vscode.Uri) => {
      const p = uri.fsPath;
      if (failOnce.has(p)) {
        failOnce.delete(p);
        throw new Error('io fail');
      }
      if (hanging.has(p)) {
        return new Promise<Uint8Array>((resolve, reject) => {
          hanging.set(p, (err?: Error) => (err ? reject(err) : resolve(fs.readFileSync(p))));
        });
      }
      return fs.readFileSync(p);
    }) as typeof vscode.workspace.fs.readFile;
    return {
      read,
      hang: p => hanging.set(p, () => undefined),
      release: p => {
        const go = hanging.get(p);
        if (go) { hanging.delete(p); go(); }
      },
      failNext: p => failOnce.add(p)
    };
  };

  it('documentChanged 事件经监听器刷新(改键后旧键撤、新键进)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdid-'));
    const writer = path.join(root, 'w.py');
    fs.writeFileSync(writer, 'import KBEngine\nKBEngine.globalData["a"] = 1\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'a').map(s => s.kind)).toEqual(['write']);
      workspaceEvents.documentChanged.fire({
        document: { uri: { fsPath: writer }, getText: () => 'import KBEngine\nKBEngine.globalData["b"] = 2\n' }
      } as never);
      expect(index.query('globalData', 'a')).toEqual([]);
      expect(index.query('globalData', 'b').map(s => s.kind)).toEqual(['write']);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ensureStarted 首扫失败清 starting,二次可重试成功', async () => {
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    let calls = 0;
    vscode.workspace.findFiles = async () => {
      calls += 1;
      if (calls === 1) { throw new Error('scan boom'); }
      return [];
    };
    vscode.workspace.fs.readFile = async () => new Uint8Array(0);
    const index = new GlobalDataDictIndex();
    try {
      await expect(index.ensureStarted()).rejects.toThrow('scan boom');
      await index.ensureStarted();
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
    }
  });

  it('启动时脏文档经 noteSaved 快路径,重扫同样取脏文本(不读盘)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gddy-'));
    const writer = path.join(root, 'w.py');
    fs.writeFileSync(writer, 'import KBEngine\nKBEngine.globalData["disk"] = 1\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    const originalDocs = (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [
      { uri: { fsPath: writer }, isDirty: true, getText: () => 'import KBEngine\nKBEngine.globalData["dirty"] = 1\n' }
    ];
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'dirty').map(s => s.kind)).toEqual(['write']);
      expect(index.query('globalData', 'disk')).toEqual([]);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = originalDocs;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('indexFile 并发去重/读失败驱逐/revision 变更后返回既有缓存', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdif-'));
    const a = path.join(root, 'a.py');
    fs.writeFileSync(a, 'import KBEngine\nKBEngine.globalData["keep"] = 1\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(a)];
    const ctl = makeControllableRead();
    vscode.workspace.fs.readFile = ctl.read;
    const watcher = captureWatcher();
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'keep').map(s => s.kind)).toEqual(['write']);
      // 1) 读失败 → 撤销该文件全部倒排并删缓存
      ctl.failNext(a);
      watcher.fireChange(vscode.Uri.file(a));
      await new Promise(r => setTimeout(r, 20));
      expect(index.query('globalData', 'keep')).toEqual([]);
      // 2) 并发去重:同文件两次 create,读挂起 → 同一 in-flight
      const x = path.join(root, 'x.py');
      fs.writeFileSync(x, 'import KBEngine\nKBEngine.globalData["x"] = 1\n');
      ctl.hang(x);
      watcher.fireCreate(vscode.Uri.file(x));
      watcher.fireCreate(vscode.Uri.file(x));
      ctl.release(x);
      await new Promise(r => setTimeout(r, 20));
      expect(index.query('globalData', 'x').map(s => s.kind)).toEqual(['write']);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('读文件途中销毁/revision 变更均返回既有缓存而非提交新倒排', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdrd-'));
    const a = path.join(root, 'a.py');
    fs.writeFileSync(a, 'import KBEngine\nKBEngine.globalData["keep"] = 1\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(a)];
    const ctl = makeControllableRead();
    vscode.workspace.fs.readFile = ctl.read;
    const watcher = captureWatcher();
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      // revision 变更(编辑保存)后旧重扫作废:返回既有缓存(仍见 keep)
      const y = path.join(root, 'y.py');
      fs.writeFileSync(y, 'import KBEngine\nKBEngine.globalData["y"] = 5\n');
      ctl.hang(y);
      watcher.fireChange(vscode.Uri.file(y));
      index.noteSaved({ uri: { fsPath: y }, getText: () => 'import KBEngine\nKBEngine.globalData["ynew"] = 5\n' });
      ctl.release(y);
      await new Promise(r => setTimeout(r, 20));
      expect(index.query('globalData', 'ynew').map(s => s.kind)).toEqual(['write']);
      // 读文件途中销毁:续体见 disposed → 早退(不提交)
      ctl.hang(a);
      watcher.fireChange(vscode.Uri.file(a));
      index.dispose();
      ctl.release(a);
      await new Promise(r => setTimeout(r, 20));
    } finally {
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
    // 销毁后 fireCreate → 直接早退
    watcher.fireCreate(vscode.Uri.file(a));
  });

  it('扫描途中销毁:findFiles 返回后早退,不建 watcher', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdsd-'));
    const a = path.join(root, 'a.py');
    fs.writeFileSync(a, 'import KBEngine\nKBEngine.globalData["k"] = 1\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    let releaseFind: () => void = () => undefined;
    const findGate = new Promise<void>(resolve => { releaseFind = resolve; });
    vscode.workspace.findFiles = async () => { await findGate; return [vscode.Uri.file(a)]; };
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    const p = index.ensureStarted();
    index.dispose();
    releaseFind();
    await p;
    expect(index.query('globalData', 'k')).toEqual([]);
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('并发扫描后销毁:Promise.all 收尾早退,不建 watcher', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdcd-'));
    const a = path.join(root, 'a.py');
    fs.writeFileSync(a, 'import KBEngine\nKBEngine.globalData["k"] = 1\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(a)];
    const ctl = makeControllableRead();
    vscode.workspace.fs.readFile = ctl.read;
    const index = new GlobalDataDictIndex();
    ctl.hang(a);
    const p = index.ensureStarted();
    await new Promise(r => setTimeout(r, 20));
    index.dispose();
    ctl.release(a);
    await p;
    expect(index.query('globalData', 'k')).toEqual([]);
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('纯逻辑边角分支(转义/嵌套/未闭合/空区间)', () => {
  it('字符串字面量:转义引号解出原文,未转义同引号 → null', () => {
    expect(normalizeKeySignature("'a\\'b'")).toBe("a'b");
    expect(normalizeKeySignature('"a"b"')).toBeNull();
  });

  it('f-string:{{ }} 转义直出,插值内嵌套 { 仍折叠为 *', () => {
    expect(normalizeKeySignature('f"a{{b}}c"')).toBe('a{b}c');
    expect(normalizeKeySignature("f\"a{ {'x':1}['x'] }\"")).toBe('a*');
  });

  it('拼接:f-string 段/数字段计入字面量,全动态段 → null', () => {
    expect(normalizeKeySignature('"A" + f"X_{id}"')).toBe('AX_*');
    expect(normalizeKeySignature('"A" + 42')).toBe('A42');
    expect(normalizeKeySignature('x + y')).toBeNull();
  });

  it('下标:字符串内转义/多余闭括号/未闭合 → 各自处理', () => {
    // 键字符串带转义引号:仍成写点,键解出原文
    const escaped = findKbeDataDictAccesses('KBEngine.globalData["a\\"b"] = 1', KBE);
    expect(escaped).toHaveLength(1);
    expect(escaped[0].keySignature).toBe('a"b');
    // `[})]`:开括号后先遇非匹配闭符再遇 ] → 深度跌穿 → 不认
    expect(findKbeDataDictAccesses('KBEngine.globalData[})] = 1', KBE)).toEqual([]);
    // 未闭合(跨行)→ 不认
    expect(findKbeDataDictAccesses('KBEngine.globalData["x"', KBE)).toEqual([]);
  });

  it('.get:非 get 调用/未闭合括号/键内转义/默认值转义', () => {
    expect(findKbeDataDictAccesses("KBEngine.globalData.getX('a')", KBE)).toEqual([]);
    expect(findKbeDataDictAccesses('KBEngine.globalData.get("x"', KBE)).toEqual([]);
    // 键带转义引号(括号配对内的转义不误判开闭)
    const escaped = findKbeDataDictAccesses('KBEngine.globalData.get("a\\"b")', KBE);
    expect(escaped).toHaveLength(1);
    expect(escaped[0].keySignature).toBe('a"b');
    // 逗号切分同样引号转义感知(首个实参含转义引号+默认值)
    const withDefault = findKbeDataDictAccesses('KBEngine.globalData.get("a\\"b", 0)', KBE);
    expect(withDefault).toHaveLength(1);
    expect(withDefault[0].keySignature).toBe('a"b');
  });

  it('键区间:首尾空白剥离,纯空白区间 → 不认', () => {
    const padded = findKbeDataDictAccesses('KBEngine.globalData[ "k" ] = 1', KBE);
    expect(padded).toHaveLength(1);
    expect(padded[0].keySignature).toBe('k');
    expect(findKbeDataDictAccesses('KBEngine.globalData[ ] = 1', KBE)).toEqual([]);
  });

  it('注释定位:字符串内转义后的 # 仍是字面量,引号外 # 才是注释', () => {
    const line = "KBEngine.globalData['a\\'#b'] = 1 # real";
    const real = line.indexOf('# real');
    expect(findLineCommentIndex(line)).toBe(real);
    expect(isKeyInsideLineComment(line, line.indexOf("'a\\'#b'"))).toBe(false);
  });

  it('集合推断:元素转义引号/嵌套容器/键转义的冒号/未知成员/未闭合', () => {
    expect(inferDataDictValueType('["a\\"b"]')).toBe('List[str]');
    expect(inferDataDictValueType('[[1]]')).toBe('List[List[int]]');
    // 冒号在转义引号之后(键内转义先于顶层冒号命中)
    expect(inferDataDictValueType('{"x\\"y": 1}')).toBe('Dict[str, int]');
    expect(inferDataDictValueType('{("k", 1): 2}')).toBe('Dict[Tuple[str, int], int]');
    expect(inferDataDictValueType('[1, 2')).toBeNull();
  });

  it('容器内未知成分整体不推(元组/字典值/无冒号对)', () => {
    // 元组含未知成员 → null
    expect(inferDataDictValueType('(1, foo)')).toBeNull();
    // 字典值未知 → null
    expect(inferDataDictValueType('{"a": foo}')).toBeNull();
    // 顶层有冒号但某对无冒号(裸元素混入)→ null
    expect(inferDataDictValueType('{"a": 1, foo}')).toBeNull();
  });

  it('构造调用小写未知与裸标识符 → null(能推才显)', () => {
    expect(inferDataDictValueType('list()')).toBeNull();
    expect(inferDataDictValueType('set()')).toBeNull();
    expect(inferDataDictValueType('foo(1)')).toBeNull();
    expect(inferDataDictValueType('bar')).toBeNull();
    // 纯空白(去 trim 后空)→ null
    expect(inferDataDictValueType('   ')).toBeNull();
  });
});

describe('生命周期边角(扫描让出窗口/倒排缺项)', () => {
  /** 捕获本测试自建 watcher 的监听器(可 fire create/change/delete)。 */
  const captureWatcherScoped = (): {
    fireCreate: (uri: vscode.Uri) => void;
    fireChange: (uri: vscode.Uri) => void;
    fireDelete: (uri: vscode.Uri) => void;
  } => {
    const listeners: {
      create: Array<(uri: vscode.Uri) => void>;
      change: Array<(uri: vscode.Uri) => void>;
      delete: Array<(uri: vscode.Uri) => void>;
    } = { create: [], change: [], delete: [] };
    const original = vscode.workspace.createFileSystemWatcher;
    vscode.workspace.createFileSystemWatcher = ((): unknown => ({
      onDidCreate: (l: (uri: vscode.Uri) => void) => { listeners.create.push(l); return { dispose: () => undefined }; },
      onDidChange: (l: (uri: vscode.Uri) => void) => { listeners.change.push(l); return { dispose: () => undefined }; },
      onDidDelete: (l: (uri: vscode.Uri) => void) => { listeners.delete.push(l); return { dispose: () => undefined }; },
      dispose: () => undefined
    })) as typeof original;
    const restore = (): void => { vscode.workspace.createFileSystemWatcher = original; };
    return {
      fireCreate: uri => listeners.create.forEach(l => l(uri)),
      fireChange: uri => listeners.change.forEach(l => l(uri)),
      fireDelete: uri => listeners.delete.forEach(l => l(uri))
    };
  };

  /** 可控读:默认读盘;per-path 挂起队列;release 可选在解析续体后微任务回调。 */
  const makeGatedRead = (): {
    read: typeof vscode.workspace.fs.readFile;
    hang: (p: string) => void;
    release: (p: string, after?: () => void) => void;
  } => {
    const pending = new Map<string, (err?: Error) => void>();
    const read = (async (uri: vscode.Uri) => {
      const p = uri.fsPath;
      if (pending.has(p)) {
        return new Promise<Uint8Array>((resolve, reject) => {
          pending.set(p, (err?: Error) => (err ? reject(err) : resolve(fs.readFileSync(p))));
        });
      }
      return fs.readFileSync(p);
    }) as typeof vscode.workspace.fs.readFile;
    return {
      read,
      hang: p => pending.set(p, () => undefined),
      release: (p, after) => {
        const go = pending.get(p);
        if (go) {
          pending.delete(p);
          go();
        }
        if (after) {
          // setImmediate(after):读返回的 thenable 同化要多轮微任务,微任务回调
          // 会抢在 indexFile 续体之前;挂宏任务保证 after 落在续体让出窗口内
          setImmediate(after);
        }
      }
    };
  };

  it('扫描 worker 遇 revision 已变文件跳过(编辑保存抢在扫描前)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdsk-'));
    const paths: string[] = [];
    // 9 个文件>并发 8:第 9 个必等 worker 空出才被取
    for (let i = 1; i <= 9; i += 1) {
      const p = path.join(root, `f${i}.py`);
      fs.writeFileSync(p, `import KBEngine\nKBEngine.globalData["k${i}"] = ${i}\n`);
      paths.push(p);
    }
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => paths.map(p => vscode.Uri.file(p));
    const ctl = makeGatedRead();
    vscode.workspace.fs.readFile = ctl.read;
    const index = new GlobalDataDictIndex();
    // 前 8 个全部挂起占满 worker
    for (let i = 0; i < 8; i += 1) {
      ctl.hang(paths[i]);
    }
    const started = index.ensureStarted();
    await new Promise(r => setTimeout(r, 20));
    // 第 9 个在等待期间经编辑路径改键(revision 抢跑)
    const ninth = paths[8];
    index.noteSaved({ uri: { fsPath: ninth }, getText: () => 'import KBEngine\nKBEngine.globalData["saved"] = 9\n' } as never);
    for (let i = 0; i < 8; i += 1) {
      ctl.release(paths[i]);
    }
    await started;
    expect(index.query('globalData', 'saved').map(s => s.kind)).toEqual(['write']);
    index.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('setImmediate 让出窗口内 revision 再变 → 返回既有缓存不提交', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdyd-'));
    const x = path.join(root, 'x.py');
    fs.writeFileSync(x, 'import KBEngine\nKBEngine.globalData["xk"] = 1\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [];
    const ctl = makeGatedRead();
    vscode.workspace.fs.readFile = ctl.read;
    const watcher = captureWatcherScoped();
    const index = new GlobalDataDictIndex();
    await index.ensureStarted();
    ctl.hang(x);
    watcher.fireCreate(vscode.Uri.file(x));
    ctl.release(x, () => {
      index.noteSaved({ uri: { fsPath: x }, getText: () => 'import KBEngine\nKBEngine.globalData["late"] = 1\n' } as never);
    });
    await new Promise(r => setTimeout(r, 20));
    expect(index.query('globalData', 'late').map(s => s.kind)).toEqual(['write']);
    expect(index.query('globalData', 'xk')).toEqual([]);
    index.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('同文件同键双访问移除时倒排缺项跳过(写+读同键)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gddk-'));
    const a = path.join(root, 'a.py');
    fs.writeFileSync(a, 'import KBEngine\nKBEngine.globalData["k"] = 1\nv = KBEngine.globalData.get("k")\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(a)];
    const ctl = makeGatedRead();
    vscode.workspace.fs.readFile = ctl.read;
    const watcher = captureWatcherScoped();
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'k').map(s => s.kind).sort()).toEqual(['read', 'write']);
      // 删除 → 同键第二访问移除时 byKey 已空 → 缺项跳过不炸
      watcher.fireDelete(vscode.Uri.file(a));
      expect(index.query('globalData', 'k')).toEqual([]);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
