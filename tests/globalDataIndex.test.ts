import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
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
  getKbeDataDictAccessAtPosition,
  inferDataDictValueType,
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
