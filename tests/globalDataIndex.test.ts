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
  findKbeDataDictAccesses,
  findKbeDataDictAccessesSliced,
  findLineCommentIndex,
  getKbeDataDictAccessAtPosition,
  inferDataDictValueType,
  isKeyInsideLineComment,
  normalizeKeySignature,
  replaceFileSitesSliced
} from '../src/globalDataIndex';
import type { KbeDataDictSite } from '../src/globalDataIndex';
import { getKbeAliases } from '../src/kbeModuleIndex';

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

describe('AUD-065 词法过滤非代码访问(R4-F01 目标扫描)', () => {
  it('注释行与尾随注释里的伪写/读点不入索引,行内真代码照常', () => {
    const text = [
      '# KBEngine.globalData["cfg"] = 1',
      'KBEngine.globalData["real"] = 2  # KBEngine.globalData["fake"] = 3',
      'v = KBEngine.baseAppData.get("a")  # KBEngine.baseAppData.get("b")'
    ].join('\n');
    const accesses = findKbeDataDictAccesses(text, KBE);
    expect(accesses.map(a => a.keySignature)).toEqual(['real', 'a']);
    expect(accesses.map(a => a.kind)).toEqual(['write', 'read']);
  });

  it('普通字符串里的伪访问不入索引', () => {
    const text = [
      's = "KBEngine.globalData[\'cfg\'] = 1"',
      't = \'KBEngine.globalData.get("cfg")\'',
      'KBEngine.globalData["real"] = 1'
    ].join('\n');
    const accesses = findKbeDataDictAccesses(text, KBE);
    expect(accesses.map(a => a.keySignature)).toEqual(['real']);
  });

  it('三引号字符串(含跨行 docstring)里的伪访问不入索引,前后代码照常', () => {
    const text = [
      '"""',
      'KBEngine.globalData["doc1"] = 1',
      'KBEngine.globalData.get("doc2")',
      '"""',
      "'''",
      'KBEngine.globalData["doc3"] = 1',
      "'''",
      'KBEngine.globalData["after"] = 1'
    ].join('\n');
    const accesses = findKbeDataDictAccesses(text, KBE);
    expect(accesses.map(a => a.keySignature)).toEqual(['after']);
    expect(accesses.map(a => a.kind)).toEqual(['write']);
  });

  it('真实下标与 get 的字符串键仍识别(回归)', () => {
    const text = [
      'KBEngine.globalData["cfg"] = {"gold": 1}',
      'v = KBEngine.baseAppData.get("c", 5)'
    ].join('\n');
    const accesses = findKbeDataDictAccesses(text, KBE);
    expect(accesses.map(a => ({ key: a.keySignature, kind: a.kind }))).toEqual([
      { key: 'cfg', kind: 'write' },
      { key: 'c', kind: 'read' }
    ]);
  });

  it('键字符串里的 # 是字面量,行尾注释不误伤真实写点', () => {
    const text = 'KBEngine.globalData["a#b"] = 1  # real comment';
    const accesses = findKbeDataDictAccesses(text, KBE);
    expect(accesses).toHaveLength(1);
    expect(accesses[0].keySignature).toBe('a#b');
    expect(accesses[0].valueText).toBe('1');
  });
});

describe('buildPythonCodeMask(AUD-065 词法掩码)', () => {
  it('注释/字符串/三引号跨行/真实代码分类正确', async () => {
    const { buildPythonCodeMask } = await import('../src/globalDataIndex');
    const text = [
      'code = 1',
      '# comment KBEngine.globalData["x"] = 1',
      's = "KBEngine.globalData[1]"',
      '"""',
      'KBEngine.globalData["doc"] = 1',
      '"""',
      'after = 2'
    ].join('\n');
    const mask = buildPythonCodeMask(text);
    // 第 0 行 code;第 1 行 '#' 起 comment;第 2 行引号内 string
    expect(mask[0]).toBe(0);
    const line1 = text.indexOf('# comment');
    expect(mask[line1]).toBe(2);
    expect(mask[text.indexOf('"KBEngine')]).toBe(1);
    const docLine = text.indexOf('KBEngine.globalData["doc"]');
    expect(mask[docLine]).toBe(1);
    const afterLine = text.indexOf('after = 2');
    expect(mask[afterLine]).toBe(0);
  });

  it('字符串内 \\ 跳过下一字符(含行延续),引号不提前闭合', async () => {
    const { buildPythonCodeMask } = await import('../src/globalDataIndex');
    const text = 's = "a\\\'" + \'b\\\\c\'';
    const mask = buildPythonCodeMask(text);
    // `\\'` 转义引号在字符串内;`\\\\` 也整段在字符串内
    const escapedQuote = text.indexOf("\\'");
    expect(mask[escapedQuote]).toBe(1);
    expect(mask[escapedQuote + 1]).toBe(1);
  });

  it('行延续:单引号字符串以 \\ 结尾换行后仍在字符串内', async () => {
    const { buildPythonCodeMask } = await import('../src/globalDataIndex');
    const text = 's = "abc\\\nKBEngine.globalData[foo] = 1"\ndef = 2';
    const mask = buildPythonCodeMask(text);
    const fakeLine = text.indexOf('KBEngine.globalData[foo]');
    expect(mask[fakeLine]).toBe(1);
    const defLine = text.indexOf('def = 2');
    expect(mask[defLine]).toBe(0);
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

describe('AUD-066 查询源词法上下文验证(R4-F01 冷查前)', () => {
  /** 跨行 docstring 伪访问(与写点同键 cfg)+ 同文档真实读取的文档 */
  const makeDocstringDoc = () => [
    'import KBEngine',
    '"""',
    'KBEngine.globalData["cfg"] = 1',
    '"""',
    'value = KBEngine.globalData.get("cfg")'
  ].join('\n');
  const docText = makeDocstringDoc();
  const docstringLine = 2;
  const realLine = 4;
  const docChar = docText.split('\n')[docstringLine].indexOf('cfg') + 1;
  const realChar = docText.split('\n')[realLine].indexOf('cfg') + 1;

  it('纯逻辑:跨行 docstring 内的伪访问 null,真实字符串键访问照常返回', async () => {
    const { getDataDictAccessInCodeContext } = await import('../src/globalDataIndex');
    const fake = getDataDictAccessInCodeContext(docText, docstringLine, docChar, KBE);
    expect(fake).toBeNull();
    const real = getDataDictAccessInCodeContext(docText, realLine, realChar, KBE);
    expect(real?.keySignature).toBe('cfg');
    expect(real?.kind).toBe('read');
  });

  it('纯逻辑:外层单行字符串里的伪访问 null;尾随注释里的伪访问 null', async () => {
    const { getDataDictAccessInCodeContext } = await import('../src/globalDataIndex');
    const plain = 's = "KBEngine.globalData[\'cfg\'] = 1"\nreal = 2';
    const plainChar = plain.indexOf('cfg') + 1;
    expect(getDataDictAccessInCodeContext(plain, 0, plainChar, KBE)).toBeNull();
    const trailing = 'import KBEngine\nKBEngine.globalData["x"] = 1  # KBEngine.globalData["y"] = 2';
    const trailingChar = trailing.indexOf('"y"') + 2;
    expect(getDataDictAccessInCodeContext(trailing, 1, trailingChar, KBE)).toBeNull();
  });

  it('定义入口:docstring 里的伪访问不启动冷查不返回定义;真实读点照常跳写点', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdip-aud66-'));
    const writer = path.join(root, 'writer.py');
    const writerText = 'import KBEngine\nKBEngine.globalData["cfg"] = 1\n';
    fs.writeFileSync(writer, writerText);
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    const provider = new PythonDefinitionProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      undefined,
      index
    );
    try {
      const doc = vscode.makeTextDocument(docText, { fileName: writer, languageId: 'python' });
      const onDocstring = await provider.provideDefinition(
        doc,
        new vscode.Position(docstringLine, docChar)
      ) as vscode.Location | null;
      expect(onDocstring).toBeNull();
      const onReal = await provider.provideDefinition(
        doc,
        new vscode.Position(realLine, realChar)
      ) as vscode.Location | null;
      expect(onReal?.uri.fsPath).toBe(writer);
      expect(onReal?.range.start.line).toBe(1);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('引用入口:docstring 里的伪访问不返回引用;真实读点照常列同键族', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdip-aud66-'));
    const writer = path.join(root, 'writer.py');
    const writerText = 'import KBEngine\nKBEngine.globalData["cfg"] = 1\n';
    fs.writeFileSync(writer, writerText);
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    const refs = new KBEngineReferencesProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      index
    );
    try {
      const doc = vscode.makeTextDocument(docText, { fileName: writer, languageId: 'python' });
      const onDocstring = await refs.provideReferences(
        doc,
        new vscode.Position(docstringLine, docChar),
        {} as vscode.ReferenceContext
      );
      expect(onDocstring).toBeNull();
      const onReal = await refs.provideReferences(
        doc,
        new vscode.Position(realLine, realChar),
        {} as vscode.ReferenceContext
      );
      expect((onReal ?? []).map(loc => path.basename(loc.uri.fsPath))).toEqual(['writer.py']);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AUD-067 字符串键按 Python 值归一化(R4-F02)', () => {
  it('\\n 换行转义与字母 n 不合并(不同实际值)', () => {
    const nl = normalizeKeySignature('"\\n"');
    const n = normalizeKeySignature('"n"');
    expect(nl).toBe('\n');
    expect(n).toBe('n');
    expect(nl).not.toBe(n);
  });

  it('\\x41 与字面 A 正确关联(同为 A);\\101 八进制同值', () => {
    expect(normalizeKeySignature('"\\x41"')).toBe('A');
    expect(normalizeKeySignature('"A"')).toBe('A');
    expect(normalizeKeySignature('"\\101"')).toBe('A');
  });

  it('不支持转义如实跳过,不改写键值', () => {
    expect(normalizeKeySignature('"\\z"')).toBeNull();
    expect(normalizeKeySignature('"\\x4"')).toBeNull();
    expect(normalizeKeySignature('"a\\z"')).toBeNull();
  });

  it('r 原始前缀:反斜杠保留,与普通转义不合并', () => {
    expect(normalizeKeySignature('r"a\\n"')).toBe('a\\n');
    expect(normalizeKeySignature('"a\\n"')).toBe('a\n');
    expect(normalizeKeySignature('r"a\\n"')).not.toBe(normalizeKeySignature('"a\\n"'));
    expect(normalizeKeySignature('R"\\x41"')).toBe('\\x41');
  });

  it('扫描器:换行键与 n 键互链各自成族(跨文件同键),互不串键', () => {
    const text = [
      'import KBEngine',
      'KBEngine.globalData["\\n"] = 1',
      'KBEngine.globalData["n"] = 2'
    ].join('\n');
    const accesses = findKbeDataDictAccesses(text, KBE);
    expect(accesses.map(a => a.keySignature)).toEqual(['\n', 'n']);
  });

  it('扫描器:转义引号仍解出原文(回归)', () => {
    const escaped = findKbeDataDictAccesses('KBEngine.globalData["a\\"b"] = 1', KBE);
    expect(escaped).toHaveLength(1);
    expect(escaped[0].keySignature).toBe('a"b');
  });
});

describe('AUD-068 跨项目同名键不串跳(R4-F03 根身份)', () => {
  /** 双 workspace 根(A/B)同键 cfg:A 写点 + B 读点(+A 同根读点) */
  const setupTwoRoots = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdi-aud68-'));
    const dirA = path.join(root, 'project-A');
    const dirB = path.join(root, 'project-B');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const writerA = path.join(dirA, 'writer.py');
    const readerB = path.join(dirB, 'reader.py');
    const readerA = path.join(dirA, 'reader2.py');
    const writerText = 'import KBEngine\nKBEngine.globalData["cfg"] = 1\n';
    const readerText = 'import KBEngine\nvalue = KBEngine.globalData.get("cfg")\n';
    fs.writeFileSync(writerA, writerText);
    fs.writeFileSync(readerB, readerText);
    fs.writeFileSync(readerA, readerText);
    const savedFind = vscode.workspace.findFiles;
    const savedRead = vscode.workspace.fs.readFile;
    const savedFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.findFiles = async () => [
      vscode.Uri.file(writerA),
      vscode.Uri.file(readerB),
      vscode.Uri.file(readerA)
    ];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file(dirA), name: 'A', index: 0 },
      { uri: vscode.Uri.file(dirB), name: 'B', index: 1 }
    ];
    const restore = () => {
      vscode.workspace.findFiles = savedFind;
      vscode.workspace.fs.readFile = savedRead;
      vscode.workspace.workspaceFolders = savedFolders;
    };
    return { root, writerA, readerB, readerA, writerText, readerText, index: new GlobalDataDictIndex(), restore };
  };

  it('纯索引:B 读 cfg 只见 B 根内站点,A 写点不在 B 的查询结果', async () => {
    const { writerA, readerB, readerA, index, restore } = setupTwoRoots();
    try {
      await index.ensureStarted();
      const dirA = path.dirname(readerA);
      const dirB = path.dirname(readerB);
      const inB = index.query('globalData', 'cfg', dirB).map(s => s.file);
      expect(inB).toEqual([readerB]);
      const inA = index.query('globalData', 'cfg', dirA).map(s => s.file).sort();
      expect(inA).toEqual([readerA, writerA]);
    } finally {
      index.dispose();
      restore();
      fs.rmSync(path.dirname(path.dirname(readerB)), { recursive: true, force: true });
    }
  });

  it('定义入口:B 读点不跳 A 写点;A 读点同根跳 A 写点', async () => {
    const { writerA, readerB, readerA, readerText, index, restore } = setupTwoRoots();
    const provider = new PythonDefinitionProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      undefined,
      index
    );
    try {
      const docB = vscode.makeTextDocument(readerText, { fileName: readerB, languageId: 'python' });
      const posB = new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1);
      const fromB = await provider.provideDefinition(docB, posB) as vscode.Location | null;
      expect(fromB?.uri.fsPath).not.toBe(writerA);
      const docA = vscode.makeTextDocument(readerText, { fileName: readerA, languageId: 'python' });
      const posA = new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1);
      const fromA = await provider.provideDefinition(docA, posA) as vscode.Location | null;
      expect(fromA?.uri.fsPath).toBe(writerA);
    } finally {
      index.dispose();
      restore();
      fs.rmSync(path.dirname(path.dirname(readerB)), { recursive: true, force: true });
    }
  });

  it('引用入口:B 读点的引用不含 A 根站点', async () => {
    const { writerA, readerB, readerText, index, restore } = setupTwoRoots();
    const refs = new KBEngineReferencesProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      index
    );
    try {
      const docB = vscode.makeTextDocument(readerText, { fileName: readerB, languageId: 'python' });
      const posB = new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1);
      const locs = await refs.provideReferences(docB, posB, {} as vscode.ReferenceContext);
      expect(locs?.some(loc => loc.uri.fsPath === writerA)).toBe(false);
      expect(locs?.map(loc => path.basename(loc.uri.fsPath))).toEqual(['reader.py']);
    } finally {
      index.dispose();
      restore();
      fs.rmSync(path.dirname(path.dirname(readerB)), { recursive: true, force: true });
    }
  });
});

describe('AUD-069 弃改关闭恢复盘版本(R4-F04)', () => {
  /** 单文件临时工程(盘上固定文本);返回可 fire change/close 的驱动。 */
  const setupOneFile = (diskText: string) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdi-aud69-'));
    const file = path.join(root, 'w.py');
    fs.writeFileSync(file, diskText);
    const savedFind = vscode.workspace.findFiles;
    const savedRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(file)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const restore = () => {
      vscode.workspace.findFiles = savedFind;
      vscode.workspace.fs.readFile = savedRead;
    };
    return { root, file, restore };
  };

  it('弃改关闭恢复盘版本:dirty 键撤销、disk 键回来', async () => {
    const { root, file, restore } = setupOneFile('import KBEngine\nKBEngine.globalData["disk"] = 1\n');
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'disk').map(s => s.kind)).toEqual(['write']);
      // 编辑缓冲:disk 写点改为 dirty 写点(未保存)
      workspaceEvents.documentChanged.fire({
        document: { uri: { fsPath: file }, isDirty: true, getText: () => 'import KBEngine\nKBEngine.globalData["dirty"] = 1\n' }
      } as never);
      expect(index.query('globalData', 'disk')).toEqual([]);
      expect(index.query('globalData', 'dirty').map(s => s.kind)).toEqual(['write']);
      // 丢弃关闭(不保存)
      workspaceEvents.documentClosed.fire({ uri: { fsPath: file }, isDirty: true } as never);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(index.query('globalData', 'disk').map(s => s.kind)).toEqual(['write']);
      expect(index.query('globalData', 'dirty')).toEqual([]);
    } finally {
      index.dispose();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('关闭已保存(干净)文档不丢正确索引:clean close 保持既有索引', async () => {
    const { root, file, restore } = setupOneFile('import KBEngine\nKBEngine.globalData["cfg"] = 1\n');
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'cfg').map(s => s.kind)).toEqual(['write']);
      workspaceEvents.documentClosed.fire({ uri: { fsPath: file }, isDirty: false } as never);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(index.query('globalData', 'cfg').map(s => s.kind)).toEqual(['write']);
    } finally {
      index.dispose();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('移除文件后弃改关闭不复活旧键:读盘失败清站点', async () => {
    const { root, file, restore } = setupOneFile('import KBEngine\nKBEngine.globalData["cfg"] = 1\n');
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'cfg').map(s => s.kind)).toEqual(['write']);
      // 磁盘移除(不走 watcher 通知);缓冲仍脏
      fs.rmSync(file);
      workspaceEvents.documentChanged.fire({
        document: { uri: { fsPath: file }, isDirty: true, getText: () => 'import KBEngine\nKBEngine.globalData["cfg"] = 1\n' }
      } as never);
      expect(index.query('globalData', 'cfg').map(s => s.kind)).toEqual(['write']);
      // 弃改关闭 → 读盘失败 → 站点清空,不复活
      workspaceEvents.documentClosed.fire({ uri: { fsPath: file }, isDirty: true } as never);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(index.query('globalData', 'cfg')).toEqual([]);
    } finally {
      index.dispose();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AUD-070 在飞读盘追赶后到变更(R4-F05)', () => {
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
      fireDelete: uri => listeners.delete.forEach(l => l(uri)),
      restoreWatcher: restore
    };
  };

  /** 快照门读:挂起路径首次读捕获"门住时"字节,放行返回该旧快照(非当下盘内容)。 */
  const makeSnapshotRead = (): {
    read: typeof vscode.workspace.fs.readFile;
    hang: (p: string) => void;
    release: (p: string) => void;
  } => {
    const gates = new Map<string, () => void>();
    const read = (async (uri: vscode.Uri) => {
      const p = uri.fsPath;
      if (gates.has(p)) {
        const captured = fs.readFileSync(p);
        await new Promise<void>(resolve => { gates.set(p, () => resolve()); });
        return captured;
      }
      return fs.readFileSync(p);
    }) as typeof vscode.workspace.fs.readFile;
    return {
      read,
      hang: (p: string) => gates.set(p, () => undefined),
      release: (p: string) => {
        const go = gates.get(p);
        if (go) { gates.delete(p); go(); }
      }
    };
  };

  const setup = (oldText: string) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdi-aud70-'));
    const file = path.join(root, 'w.py');
    fs.writeFileSync(file, oldText);
    const savedFind = vscode.workspace.findFiles;
    const savedRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(file)];
    const ctl = makeSnapshotRead();
    vscode.workspace.fs.readFile = ctl.read;
    const restore = () => {
      vscode.workspace.findFiles = savedFind;
      vscode.workspace.fs.readFile = savedRead;
    };
    return { root, file, ctl, restore };
  };

  it('在飞读旧字节 + 磁盘改 latest 后再 change → 只发布 latest(不吞变更)', async () => {
    const { root, file, ctl, restore } = setup('import KBEngine\nKBEngine.globalData["old"] = 1\n');
    const watcher = captureWatcherScoped();
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'old').map(s => s.kind)).toEqual(['write']);
      ctl.hang(file);
      watcher.fireChange(vscode.Uri.file(file));
      fs.writeFileSync(file, 'import KBEngine\nKBEngine.globalData["latest"] = 1\n');
      watcher.fireChange(vscode.Uri.file(file));
      ctl.release(file);
      await new Promise(r => setTimeout(r, 20));
      expect(index.query('globalData', 'latest').map(s => s.kind)).toEqual(['write']);
      expect(index.query('globalData', 'old')).toEqual([]);
    } finally {
      index.dispose();
      watcher.restoreWatcher();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('多次通知合并:在飞期间连续多次 change → 收敛 latest', async () => {
    const { root, file, ctl, restore } = setup('import KBEngine\nKBEngine.globalData["v1"] = 1\n');
    const watcher = captureWatcherScoped();
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      ctl.hang(file);
      watcher.fireChange(vscode.Uri.file(file));
      fs.writeFileSync(file, 'import KBEngine\nKBEngine.globalData["v2"] = 1\n');
      watcher.fireChange(vscode.Uri.file(file));
      fs.writeFileSync(file, 'import KBEngine\nKBEngine.globalData["v3"] = 1\n');
      watcher.fireChange(vscode.Uri.file(file));
      ctl.release(file);
      await new Promise(r => setTimeout(r, 20));
      expect(index.query('globalData', 'v3').map(s => s.kind)).toEqual(['write']);
      expect(index.query('globalData', 'v1')).toEqual([]);
      expect(index.query('globalData', 'v2')).toEqual([]);
    } finally {
      index.dispose();
      watcher.restoreWatcher();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('在飞读期间删除 → 站点清除不复活', async () => {
    const { root, file, ctl, restore } = setup('import KBEngine\nKBEngine.globalData["k"] = 1\n');
    const watcher = captureWatcherScoped();
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      ctl.hang(file);
      watcher.fireChange(vscode.Uri.file(file));
      watcher.fireDelete(vscode.Uri.file(file));
      ctl.release(file);
      await new Promise(r => setTimeout(r, 20));
      expect(index.query('globalData', 'k')).toEqual([]);
    } finally {
      index.dispose();
      watcher.restoreWatcher();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('在飞读期间脏文档 → 缓冲优先', async () => {
    const { root, file, ctl, restore } = setup('import KBEngine\nKBEngine.globalData["disk"] = 1\n');
    const watcher = captureWatcherScoped();
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      ctl.hang(file);
      watcher.fireChange(vscode.Uri.file(file));
      workspaceEvents.documentChanged.fire({
        document: { uri: { fsPath: file }, isDirty: true, getText: () => 'import KBEngine\nKBEngine.globalData["buf"] = 1\n' }
      } as never);
      ctl.release(file);
      await new Promise(r => setTimeout(r, 20));
      expect(index.query('globalData', 'buf').map(s => s.kind)).toEqual(['write']);
      expect(index.query('globalData', 'disk')).toEqual([]);
    } finally {
      index.dispose();
      watcher.restoreWatcher();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AUD-071 根变化更新索引与 watcher(R4-F06)', () => {
  /** 捕获本测试自建 watcher 的监听器(可 fire change)。 */
  const captureWatcherScoped = (): { fireChange: (uri: vscode.Uri) => void; restoreWatcher: () => void } => {
    const listeners: { change: Array<(uri: vscode.Uri) => void> } = { change: [] };
    const original = vscode.workspace.createFileSystemWatcher;
    vscode.workspace.createFileSystemWatcher = ((): unknown => ({
      onDidCreate: () => ({ dispose: () => undefined }),
      onDidChange: (l: (uri: vscode.Uri) => void) => { listeners.change.push(l); return { dispose: () => undefined }; },
      onDidDelete: () => ({ dispose: () => undefined }),
      dispose: () => undefined
    })) as typeof original;
    return {
      fireChange: uri => listeners.change.forEach(l => l(uri)),
      restoreWatcher: () => { vscode.workspace.createFileSystemWatcher = original; }
    };
  };

  /** 挂起读:放行时返回"门住时"快照(旧字节)。 */
  const makeSnapshotRead = (): { read: typeof vscode.workspace.fs.readFile; hang: (p: string) => void; release: (p: string) => void } => {
    const gates = new Map<string, () => void>();
    const read = (async (uri: vscode.Uri) => {
      const p = uri.fsPath;
      if (gates.has(p)) {
        const captured = fs.readFileSync(p);
        await new Promise<void>(resolve => { gates.set(p, () => resolve()); });
        return captured;
      }
      return fs.readFileSync(p);
    }) as typeof vscode.workspace.fs.readFile;
    return {
      read,
      hang: (p: string) => gates.set(p, () => undefined),
      release: (p: string) => { const go = gates.get(p); if (go) { gates.delete(p); go(); } }
    };
  };

  const cfgWrite = 'import KBEngine\nKBEngine.globalData["cfg"] = 1\n';

  /** A/B 双 workspace 根,cfg 各一写点。 */
  const setupTwoRoots = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdi-aud71-'));
    const dirA = path.join(root, 'A');
    const dirB = path.join(root, 'B');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const writerA = path.join(dirA, 'writer.py');
    const writerB = path.join(dirB, 'writer.py');
    fs.writeFileSync(writerA, cfgWrite);
    fs.writeFileSync(writerB, cfgWrite);
    const savedFind = vscode.workspace.findFiles;
    const savedRead = vscode.workspace.fs.readFile;
    const savedFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writerA), vscode.Uri.file(writerB)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const setFolders = (dirs: string[]) => {
      vscode.workspace.workspaceFolders = dirs.map((dir, i) => ({ uri: vscode.Uri.file(dir), name: path.basename(dir), index: i }));
    };
    setFolders([dirA, dirB]);
    const restore = () => {
      vscode.workspace.findFiles = savedFind;
      vscode.workspace.fs.readFile = savedRead;
      vscode.workspace.workspaceFolders = savedFolders;
    };
    return { root, dirA, dirB, writerA, writerB, setFolders, restore };
  };

  it('移除根立即撤回其贡献:dirA 键下不再见 A 写点,B 根原样保留', async () => {
    const { root, dirA, dirB, setFolders, restore } = setupTwoRoots();
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'cfg', dirA).map(s => s.kind)).toEqual(['write']);
      expect(index.query('globalData', 'cfg', dirB).map(s => s.kind)).toEqual(['write']);
      setFolders([dirB]);
      workspaceEvents.foldersChanged.fire({ removed: [{ uri: vscode.Uri.file(dirA) }], added: [] });
      expect(index.query('globalData', 'cfg', dirA)).toEqual([]);
      expect(index.query('globalData', 'cfg', dirB).map(s => s.kind)).toEqual(['write']);
    } finally {
      index.dispose();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('添加根重建覆盖:新根 C 下文件按 C 根身份入键', async () => {
    const { root, dirA, dirB, writerB, setFolders, restore } = setupTwoRoots();
    const dirC = path.join(root, 'C');
    fs.mkdirSync(dirC, { recursive: true });
    const writerC = path.join(dirC, 'writer.py');
    fs.writeFileSync(writerC, cfgWrite);
    const savedFind = vscode.workspace.findFiles;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writerB), vscode.Uri.file(writerC)];
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'cfg', dirC)).toEqual([]);
      setFolders([dirA, dirB, dirC]);
      workspaceEvents.foldersChanged.fire({ removed: [], added: [{ uri: vscode.Uri.file(dirC) }] });
      await new Promise(r => setTimeout(r, 20));
      expect(index.query('globalData', 'cfg', dirC).map(s => s.kind)).toEqual(['write']);
      expect(index.query('globalData', 'cfg', dirC)[0].file).toBe(writerC);
    } finally {
      index.dispose();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('在飞旧读不得重新发布旧根:移除后放行作废,dirA 键不复活', async () => {
    const { root, dirA, dirB, writerA, setFolders, restore } = setupTwoRoots();
    const savedRead = vscode.workspace.fs.readFile;
    const ctl = makeSnapshotRead();
    vscode.workspace.fs.readFile = ctl.read;
    const watcher = captureWatcherScoped();
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'cfg', dirA).map(s => s.kind)).toEqual(['write']);
      ctl.hang(writerA);
      watcher.fireChange(vscode.Uri.file(writerA));
      setFolders([dirB]);
      workspaceEvents.foldersChanged.fire({ removed: [{ uri: vscode.Uri.file(dirA) }], added: [] });
      expect(index.query('globalData', 'cfg', dirA)).toEqual([]);
      ctl.release(writerA);
      await new Promise(r => setTimeout(r, 20));
      expect(index.query('globalData', 'cfg', dirA)).toEqual([]);
    } finally {
      index.dispose();
      watcher.restoreWatcher();
      restore();
      vscode.workspace.fs.readFile = savedRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('外部 assetsRoot 移除:整根身份键撤回(证据:removeRoot 根无关)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdi-aud71x-'));
    const ws = path.join(root, 'ws');
    const assets = path.join(root, 'assets');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(assets, { recursive: true });
    const assetsWriter = path.join(assets, 'writer.py');
    fs.writeFileSync(assetsWriter, cfgWrite);
    const savedFind = vscode.workspace.findFiles;
    const savedRead = vscode.workspace.fs.readFile;
    const savedFolders = vscode.workspace.workspaceFolders;
    const savedConfig = configurationOverrides.get('kbengine');
    vscode.workspace.findFiles = async () => [vscode.Uri.file(assetsWriter)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: 'ws', index: 0 }];
    configurationOverrides.set('kbengine', { assetsRoot: assets });
    resetScanRootCache();
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      expect(index.query('globalData', 'cfg', assets).map(s => s.kind)).toEqual(['write']);
      // 外部根被移除(配置清空):整根撤回
      configurationOverrides.set('kbengine', { assetsRoot: '' });
      resetScanRootCache();
      index.removeRoot(assets);
      expect(index.query('globalData', 'cfg', assets)).toEqual([]);
      expect(index.query('globalData', 'cfg', '')).toEqual([]);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = savedFind;
      vscode.workspace.fs.readFile = savedRead;
      vscode.workspace.workspaceFolders = savedFolders;
      if (savedConfig) configurationOverrides.set('kbengine', savedConfig);
      else configurationOverrides.delete('kbengine');
      resetScanRootCache();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AUD-072 冷查询取消及时返回(R4-F07)', () => {
  /** 双文件工作区:writer 写点 + reader 读点(同键 cfg)。 */
  const setupWorkspace = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdip-a72-'));
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

  /** 门住读盘:gate 标记的路径首次读取挂起,release 放行;engaged 反映
   * 真正挂起的读(区分"已标记未读")。 */
  const makeGatedColdRead = (): {
    read: typeof vscode.workspace.fs.readFile;
    gate: (p: string) => void;
    release: (p: string) => void;
    engagedAny: () => boolean;
  } => {
    const shouldHang = new Set<string>();
    const hanging = new Map<string, () => void>();
    const read = (async (uri: vscode.Uri) => {
      const p = uri.fsPath;
      if (shouldHang.has(p)) {
        return new Promise<Uint8Array>(resolve => {
          hanging.set(p, () => resolve(fs.readFileSync(p)));
        });
      }
      return fs.readFileSync(p);
    }) as typeof vscode.workspace.fs.readFile;
    return {
      read,
      gate: p => shouldHang.add(p),
      release: p => {
        shouldHang.delete(p);
        const go = hanging.get(p);
        if (go) { hanging.delete(p); go(); }
      },
      engagedAny: () => hanging.size > 0
    };
  };

  /** setImmediate 轮询等待条件成立(上限内不成立抛错)。 */
  const waitUntil = async (cond: () => boolean, limit = 500): Promise<void> => {
    for (let i = 0; i < limit && !cond(); i += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    if (!cond()) {
      throw new Error('waitUntil condition not met');
    }
  };

  /** 限时观察 promise 是否落定:返回 true=已落定(含拒绝),false=超时。 */
  const settledWithin = (p: Promise<unknown>, ms: number): Promise<boolean> =>
    Promise.race([
      p.then(() => true, () => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), ms))
    ]);

  it('冷扫描在飞时取消:definition 放闸前返回 null(R4-F07)', async () => {
    const { root, writer, reader, readerText } = setupWorkspace();
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    const ctl = makeGatedColdRead();
    vscode.workspace.fs.readFile = ctl.read;
    ctl.gate(writer);
    ctl.gate(reader);
    const index = new GlobalDataDictIndex();
    const provider = new PythonDefinitionProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      undefined,
      index
    );
    const source = new vscode.CancellationTokenSource();
    try {
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const readPos = new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1);
      const defPromise = provider.provideDefinition(readDoc, readPos, source.token);
      await waitUntil(() => ctl.engagedAny());
      // 门仍在(初扫读盘挂起)时取消:当前调用须在放闸前返回
      source.cancel();
      expect(await settledWithin(defPromise, 200)).toBe(true);
      expect(await defPromise).toBeNull();
      expect(ctl.engagedAny()).toBe(true);
    } finally {
      source.dispose();
      ctl.release(writer);
      ctl.release(reader);
      await settledWithin(Promise.resolve(), 0);
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      index.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('冷扫描在飞时取消:references 放闸前返回 null(R4-F07)', async () => {
    const { root, writer, reader, readerText } = setupWorkspace();
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    const ctl = makeGatedColdRead();
    vscode.workspace.fs.readFile = ctl.read;
    ctl.gate(writer);
    ctl.gate(reader);
    const index = new GlobalDataDictIndex();
    const refs = new KBEngineReferencesProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      index
    );
    const source = new vscode.CancellationTokenSource();
    try {
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const refPromise = refs.provideReferences(
        readDoc,
        new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1),
        {} as vscode.ReferenceContext,
        source.token
      );
      await waitUntil(() => ctl.engagedAny());
      source.cancel();
      expect(await settledWithin(refPromise, 200)).toBe(true);
      expect(await refPromise).toBeNull();
      expect(ctl.engagedAny()).toBe(true);
    } finally {
      source.dispose();
      ctl.release(writer);
      ctl.release(reader);
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      index.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('取消后共享初扫不中止,继续服务其他请求(R4-F07)', async () => {
    const { root, writer, reader, readerText } = setupWorkspace();
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    const ctl = makeGatedColdRead();
    vscode.workspace.fs.readFile = ctl.read;
    ctl.gate(writer);
    ctl.gate(reader);
    const index = new GlobalDataDictIndex();
    const provider = new PythonDefinitionProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      undefined,
      index
    );
    const source = new vscode.CancellationTokenSource();
    try {
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const readPos = new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1);
      const cancelled = provider.provideDefinition(readDoc, readPos, source.token);
      await waitUntil(() => ctl.engagedAny());
      source.cancel();
      expect(await settledWithin(cancelled, 200)).toBe(true);
      // 放闸:共享初扫原样跑完(单次取消不中止)
      ctl.release(writer);
      ctl.release(reader);
      // 后续无 token 请求命中写点 → 索引未被取消破坏
      const fromRead = await provider.provideDefinition(readDoc, readPos) as vscode.Location | null;
      expect(fromRead?.uri.fsPath).toBe(writer);
    } finally {
      source.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      index.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('已取消 token 不触发冷扫描读盘(守卫)', async () => {
    const { root, writer, reader, readerText } = setupWorkspace();
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    const ctl = makeGatedColdRead();
    vscode.workspace.fs.readFile = ctl.read;
    ctl.gate(writer);
    ctl.gate(reader);
    const index = new GlobalDataDictIndex();
    const provider = new PythonDefinitionProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      undefined,
      index
    );
    const source = new vscode.CancellationTokenSource();
    source.cancel();
    try {
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const fromRead = await provider.provideDefinition(
        readDoc,
        new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1),
        source.token
      );
      expect(fromRead).toBeNull();
      expect(ctl.engagedAny()).toBe(false);
    } finally {
      source.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      index.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AUD-073 开关代际拦截过期发布(R4-F08)', () => {
  const setupWorkspace = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdip-a73-'));
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

  const makeGatedColdRead = (): {
    read: typeof vscode.workspace.fs.readFile;
    gate: (p: string) => void;
    release: (p: string) => void;
    engagedAny: () => boolean;
  } => {
    const shouldHang = new Set<string>();
    const hanging = new Map<string, () => void>();
    const read = (async (uri: vscode.Uri) => {
      const p = uri.fsPath;
      if (shouldHang.has(p)) {
        return new Promise<Uint8Array>(resolve => {
          hanging.set(p, () => resolve(fs.readFileSync(p)));
        });
      }
      return fs.readFileSync(p);
    }) as typeof vscode.workspace.fs.readFile;
    return {
      read,
      gate: p => shouldHang.add(p),
      release: p => {
        shouldHang.delete(p);
        const go = hanging.get(p);
        if (go) { hanging.delete(p); go(); }
      },
      engagedAny: () => hanging.size > 0
    };
  };

  const waitUntil = async (cond: () => boolean, limit = 500): Promise<void> => {
    for (let i = 0; i < limit && !cond(); i += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    if (!cond()) {
      throw new Error('waitUntil condition not met');
    }
  };

  const makeProvider = (index: GlobalDataDictIndex) =>
    new PythonDefinitionProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      undefined,
      index
    );

  it('冷查询等待中关闭开关:definition 不返回旧结果(R4-F08)', async () => {
    const { root, writer, reader, readerText } = setupWorkspace();
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    const ctl = makeGatedColdRead();
    vscode.workspace.fs.readFile = ctl.read;
    ctl.gate(writer);
    ctl.gate(reader);
    const index = new GlobalDataDictIndex();
    const provider = makeProvider(index);
    try {
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const readPos = new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1);
      const pending = provider.provideDefinition(readDoc, readPos);
      await waitUntil(() => ctl.engagedAny());
      // 等待期间关闭开关 → 发布前须拦截(不返回旧写点)
      setPythonDataDictIndexEnabled(false);
      ctl.release(writer);
      ctl.release(reader);
      const result = await pending;
      expect(result).toBeNull();
      // 重新开启:后续查询恢复正常
      setPythonDataDictIndexEnabled(true);
      const fromRead = await provider.provideDefinition(readDoc, readPos) as vscode.Location | null;
      expect(fromRead?.uri.fsPath).toBe(writer);
    } finally {
      setPythonDataDictIndexEnabled(true);
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      index.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('关闭再开启的代际切换不放行过期请求(R4-F08)', async () => {
    const { root, writer, reader, readerText } = setupWorkspace();
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    const ctl = makeGatedColdRead();
    vscode.workspace.fs.readFile = ctl.read;
    ctl.gate(writer);
    ctl.gate(reader);
    const index = new GlobalDataDictIndex();
    const provider = makeProvider(index);
    try {
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const readPos = new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1);
      const pending = provider.provideDefinition(readDoc, readPos);
      await waitUntil(() => ctl.engagedAny());
      // 关→开:代际已切换,启动于旧代际的请求不得放行
      setPythonDataDictIndexEnabled(false);
      setPythonDataDictIndexEnabled(true);
      ctl.release(writer);
      ctl.release(reader);
      expect(await pending).toBeNull();
    } finally {
      setPythonDataDictIndexEnabled(true);
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      index.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('冷查询等待中关闭开关:references 不返回旧结果(R4-F08)', async () => {
    const { root, writer, reader, readerText } = setupWorkspace();
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    const ctl = makeGatedColdRead();
    vscode.workspace.fs.readFile = ctl.read;
    ctl.gate(writer);
    ctl.gate(reader);
    const index = new GlobalDataDictIndex();
    const refs = new KBEngineReferencesProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      index
    );
    try {
      const readDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python' });
      const pending = refs.provideReferences(
        readDoc,
        new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1),
        {} as vscode.ReferenceContext
      );
      await waitUntil(() => ctl.engagedAny());
      setPythonDataDictIndexEnabled(false);
      ctl.release(writer);
      ctl.release(reader);
      expect(await pending).toBeNull();
    } finally {
      setPythonDataDictIndexEnabled(true);
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      index.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
describe('AUD-074 初扫与监听空窗(R4-F09)', () => {
  /** 捕获本测试自建 watcher 的监听器(可 fire create/change/delete)。 */
  const captureWatcherScoped = (): {
    fireCreate: (uri: vscode.Uri) => void;
    fireChange: (uri: vscode.Uri) => void;
    fireDelete: (uri: vscode.Uri) => void;
    restoreWatcher: () => void;
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
      restoreWatcher: restore
    };
  };

  const setupWorkspace = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdip-a74-'));
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

  const makeGatedColdRead = (): {
    read: typeof vscode.workspace.fs.readFile;
    gate: (p: string) => void;
    release: (p: string) => void;
    engagedAny: () => boolean;
  } => {
    const shouldHang = new Set<string>();
    const hanging = new Map<string, () => void>();
    const read = (async (uri: vscode.Uri) => {
      const p = uri.fsPath;
      if (shouldHang.has(p)) {
        return new Promise<Uint8Array>(resolve => {
          hanging.set(p, () => resolve(fs.readFileSync(p)));
        });
      }
      return fs.readFileSync(p);
    }) as typeof vscode.workspace.fs.readFile;
    return {
      read,
      gate: p => shouldHang.add(p),
      release: p => {
        shouldHang.delete(p);
        const go = hanging.get(p);
        if (go) { hanging.delete(p); go(); }
      },
      engagedAny: () => hanging.size > 0
    };
  };

  const waitUntil = async (cond: () => boolean, limit = 500): Promise<void> => {
    for (let i = 0; i < limit && !cond(); i += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    if (!cond()) {
      throw new Error('waitUntil condition not met');
    }
  };

  it('初扫期间删除已捕获字节的文件:不发布幽灵写点(R4-F09)', async () => {
    const { root, writer, reader } = setupWorkspace();
    const savedFind = vscode.workspace.findFiles;
    const savedRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    const ctl = makeGatedColdRead();
    vscode.workspace.fs.readFile = ctl.read;
    ctl.gate(writer);
    ctl.gate(reader);
    const watcher = captureWatcherScoped();
    const index = new GlobalDataDictIndex();
    try {
      const pending = index.ensureStarted();
      await waitUntil(() => ctl.engagedAny());
      // 捕获旧字节(放行读盘)后、提交前删除实际文件 + 删除事件
      ctl.release(writer);
      fs.rmSync(writer);
      watcher.fireDelete(vscode.Uri.file(writer));
      ctl.release(reader);
      await pending;
      // 幽灵写点不得发布:writer 键不在索引
      expect(index.query('globalData', 'cfg').map(s => path.basename(s.file))).not.toContain('writer.py');
    } finally {
      index.dispose();
      watcher.restoreWatcher();
      vscode.workspace.findFiles = savedFind;
      vscode.workspace.fs.readFile = savedRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('初扫期间变更已捕获字节的文件:最新内容入索引,旧内容不发布(R4-F09)', async () => {
    const { root, writer, reader } = setupWorkspace();
    const savedFind = vscode.workspace.findFiles;
    const savedRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    const ctl = makeGatedColdRead();
    vscode.workspace.fs.readFile = ctl.read;
    ctl.gate(writer);
    ctl.gate(reader);
    const watcher = captureWatcherScoped();
    const index = new GlobalDataDictIndex();
    try {
      const pending = index.ensureStarted();
      await waitUntil(() => ctl.engagedAny());
      // 捕获旧字节(放行读盘)后、提交前改写文件 + 变更事件
      ctl.release(writer);
      fs.writeFileSync(writer, 'import KBEngine\nKBEngine.globalData["changed"] = 1\n');
      watcher.fireChange(vscode.Uri.file(writer));
      ctl.release(reader);
      await pending;
      await new Promise(resolve => setTimeout(resolve, 20));
      // 最新内容入索引;writer 不再贡献旧 cfg 键(reader 自身读点仍在)
      expect(index.query('globalData', 'changed').map(s => path.basename(s.file))).toEqual(['writer.py']);
      expect(index.query('globalData', 'cfg').map(s => path.basename(s.file))).not.toContain('writer.py');
    } finally {
      index.dispose();
      watcher.restoreWatcher();
      vscode.workspace.findFiles = savedFind;
      vscode.workspace.fs.readFile = savedRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('初扫期间新建文件:create 事件入账,新文件被索引(R4-F09)', async () => {
    const { root, writer, reader } = setupWorkspace();
    const created = path.join(root, 'cell', 'created.py');
    const savedFind = vscode.workspace.findFiles;
    const savedRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    const ctl = makeGatedColdRead();
    vscode.workspace.fs.readFile = ctl.read;
    ctl.gate(writer);
    ctl.gate(reader);
    const watcher = captureWatcherScoped();
    const index = new GlobalDataDictIndex();
    try {
      const pending = index.ensureStarted();
      await waitUntil(() => ctl.engagedAny());
      // 初扫在飞时新建文件 + create 事件
      fs.writeFileSync(created, 'import KBEngine\nKBEngine.globalData["created"] = 1\n');
      watcher.fireCreate(vscode.Uri.file(created));
      ctl.release(writer);
      ctl.release(reader);
      await pending;
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(index.query('globalData', 'created').map(s => path.basename(s.file))).toEqual(['created.py']);
    } finally {
      index.dispose();
      watcher.restoreWatcher();
      vscode.workspace.findFiles = savedFind;
      vscode.workspace.fs.readFile = savedRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AUD-075 源文档版本复核(R4-F10)', () => {
  const setupWorkspace = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdip-a75-'));
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

  const makeGatedColdRead = (): {
    read: typeof vscode.workspace.fs.readFile;
    gate: (p: string) => void;
    release: (p: string) => void;
    engagedAny: () => boolean;
  } => {
    const shouldHang = new Set<string>();
    const hanging = new Map<string, () => void>();
    const read = (async (uri: vscode.Uri) => {
      const p = uri.fsPath;
      if (shouldHang.has(p)) {
        return new Promise<Uint8Array>(resolve => {
          hanging.set(p, () => resolve(fs.readFileSync(p)));
        });
      }
      return fs.readFileSync(p);
    }) as typeof vscode.workspace.fs.readFile;
    return {
      read,
      gate: p => shouldHang.add(p),
      release: p => {
        shouldHang.delete(p);
        const go = hanging.get(p);
        if (go) { hanging.delete(p); go(); }
      },
      engagedAny: () => hanging.size > 0
    };
  };

  const waitUntil = async (cond: () => boolean, limit = 500): Promise<void> => {
    for (let i = 0; i < limit && !cond(); i += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    if (!cond()) {
      throw new Error('waitUntil condition not met');
    }
  };

  const makeProvider = (index: GlobalDataDictIndex) =>
    new PythonDefinitionProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      undefined,
      index
    );

  it('冷发现期间源文档编辑:definition 不返回旧 cfg 位置(R4-F10)', async () => {
    const { root, writer, reader, readerText } = setupWorkspace();
    const savedFind = vscode.workspace.findFiles;
    const savedRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    const ctl = makeGatedColdRead();
    vscode.workspace.fs.readFile = ctl.read;
    ctl.gate(writer);
    ctl.gate(reader);
    const index = new GlobalDataDictIndex();
    const provider = makeProvider(index);
    try {
      const readerDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python', version: 1 });
      const readPos = new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1);
      const pending = provider.provideDefinition(readerDoc, readPos);
      await waitUntil(() => ctl.engagedAny());
      // 源文档编辑:cfg → different,版本 1→2(等待期间)
      readerDoc.version = 2;
      ctl.release(writer);
      ctl.release(reader);
      expect(await pending).toBeNull();
    } finally {
      vscode.workspace.findFiles = savedFind;
      vscode.workspace.fs.readFile = savedRead;
      index.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('冷发现期间源文档编辑:references 不返回旧 cfg 位置(R4-F10)', async () => {
    const { root, writer, reader, readerText } = setupWorkspace();
    const savedFind = vscode.workspace.findFiles;
    const savedRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    const ctl = makeGatedColdRead();
    vscode.workspace.fs.readFile = ctl.read;
    ctl.gate(writer);
    ctl.gate(reader);
    const index = new GlobalDataDictIndex();
    const refs = new KBEngineReferencesProvider(
      new EntityMappingManager({ subscriptions: [] } as never),
      index
    );
    try {
      const readerDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python', version: 1 });
      const pending = refs.provideReferences(
        readerDoc,
        new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1),
        {} as vscode.ReferenceContext
      );
      await waitUntil(() => ctl.engagedAny());
      readerDoc.version = 2;
      ctl.release(writer);
      ctl.release(reader);
      expect(await pending).toBeNull();
    } finally {
      vscode.workspace.findFiles = savedFind;
      vscode.workspace.fs.readFile = savedRead;
      index.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('源文档未编辑:definition 正常返回 writer 写点(守卫)', async () => {
    const { root, writer, reader, readerText } = setupWorkspace();
    const savedFind = vscode.workspace.findFiles;
    const savedRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer), vscode.Uri.file(reader)];
    const ctl = makeGatedColdRead();
    vscode.workspace.fs.readFile = ctl.read;
    ctl.gate(writer);
    ctl.gate(reader);
    const index = new GlobalDataDictIndex();
    const provider = makeProvider(index);
    try {
      const readerDoc = vscode.makeTextDocument(readerText, { fileName: reader, languageId: 'python', version: 1 });
      const pending = provider.provideDefinition(
        readerDoc,
        new vscode.Position(1, readerText.split('\n')[1].indexOf('cfg') + 1)
      );
      await waitUntil(() => ctl.engagedAny());
      ctl.release(writer);
      ctl.release(reader);
      const result = await pending as vscode.Location | null;
      expect(result?.uri.fsPath).toBe(writer);
    } finally {
      vscode.workspace.findFiles = savedFind;
      vscode.workspace.fs.readFile = savedRead;
      index.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AUD-076 编辑重扫接入交互调度预算(R4-F11)', () => {
  /** 合成大文件:约 3.7MB、12 万访问点(镜像审计 R4-F11 量级)。 */
  const buildLargeText = (accessCount = 120000): { text: string; accesses: number } => {
    const blocks: string[] = [];
    let accesses = 0;
    while (accesses < accessCount) {
      const n = 40 + (accesses % 30);
      let block = 'import KBEngine\n';
      for (let i = 0; i < n && accesses < accessCount; i += 1) {
        block += `KBEngine.globalData["k${accesses}"] = ${accesses}\n`;
        accesses += 1;
      }
      blocks.push(block);
    }
    return { text: blocks.join('\n'), accesses };
  };

  const waitUntil = async (cond: () => boolean, limit = 4000): Promise<void> => {
    for (let i = 0; i < limit && !cond(); i += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    if (!cond()) {
      throw new Error('waitUntil condition not met');
    }
  };

  it('大文件 noteSaved 不阻塞宿主(旧实现同步全量重扫)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdi-a76-'));
    const writer = path.join(root, 'base', 'big.py');
    fs.mkdirSync(path.dirname(writer), { recursive: true });
    const { text } = buildLargeText();
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      const startedAt = performance.now();
      index.noteSaved({
        uri: { fsPath: writer },
        getText: () => text,
        isDirty: true
      } as never);
      const elapsed = performance.now() - startedAt;
      // 交互预算:单次 noteSaved 的连续阻塞须远低于全量扫描时间(292ms 级)
      expect(elapsed).toBeLessThan(200);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it('切片扫描与同步扫描逐项一致(含 \\r\\n/注释/三引号/跨行字符串)', async () => {
    const mixed = [
      'import KBEngine\n',
      '# KBEngine.globalData["commented"] = 0\n',
      'x = KBEngine.globalData["real1"] = 1\n',
      's = """KBEngine.globalData["triple"] = 2"""\n',
      'KBEngine.globalData["crlf"] = 3\r\n',
      'KBEngine.cellAppData.get("cell")\n',
      'KBEngine.baseAppData["base"] = {"gold": 1}\n'
    ].join('');
    const aliases = getKbeAliases(mixed);
    const sync = findKbeDataDictAccesses(mixed, aliases);
    const sliced = await findKbeDataDictAccessesSliced(mixed, aliases, () => false, 2);
    expect(sliced.accesses).toEqual(sync);
    expect(sliced.sliceCount).toBeGreaterThan(1);
  });

  it('切片扫描最大执行片远小于同步全量(交互预算)', async () => {
    const { text } = buildLargeText(120000);
    const aliases = getKbeAliases(text);
    const syncStartedAt = performance.now();
    const sync = findKbeDataDictAccesses(text, aliases);
    const syncMs = performance.now() - syncStartedAt;
    const sliced = await findKbeDataDictAccessesSliced(text, aliases, () => false);
    expect(sliced.accesses).toEqual(sync);
    expect(sliced.sliceCount).toBeGreaterThan(1);
    // 最大执行片须远小于同步全量(至少切成 3 片且单片显著低于总量)
    expect(sliced.maxSliceMs).toBeLessThan(syncMs / 3);
    expect(sliced.maxSliceMs).toBeLessThan(300);
  }, 60000);

  it('倒排提交切片限阻塞(120k 访问点,非连续占用)', async () => {
    const { text } = buildLargeText(120000);
    const aliases = getKbeAliases(text);
    const accesses = findKbeDataDictAccesses(text, aliases);
    const byKey = new Map<string, KbeDataDictSite[]>();
    const stats = await replaceFileSitesSliced(byKey, '/tmp/big.py', [], accesses);
    expect(stats.sliceCount).toBeGreaterThan(1);
    expect(stats.maxSliceMs).toBeLessThan(300);
    expect(byKey.size).toBeGreaterThan(0);
    // 撤销后无残留
    const removed = await replaceFileSitesSliced(byKey, '/tmp/big.py', accesses, []);
    expect(byKey.size).toBe(0);
    expect(removed.maxSliceMs).toBeLessThan(300);
  }, 60000);

  it('连续编辑合并:突发多次 noteSaved 只提交最终一份', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdi-a76m-'));
    const writer = path.join(root, 'base', 'big.py');
    fs.mkdirSync(path.dirname(writer), { recursive: true });
    fs.writeFileSync(writer, 'import KBEngine\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      const mk = (marker: string): string =>
        `import KBEngine\n${Array.from({ length: 5000 }, (_, i) => `KBEngine.globalData["${marker}${i}"] = ${i}\n`).join('')}`;
      const v1 = mk('a');
      const v2 = mk('b');
      const v3 = mk('c');
      // 同一宏任务内连续编辑 → 只合并为最新一份
      index.noteSaved({ uri: { fsPath: writer }, getText: () => v1, isDirty: true } as never);
      index.noteSaved({ uri: { fsPath: writer }, getText: () => v2, isDirty: true } as never);
      index.noteSaved({ uri: { fsPath: writer }, getText: () => v3, isDirty: true } as never);
      await waitUntil(() => index.lastEditStats.commits >= 1);
      // 最终索引 = 最新文本 c;中间代(a/b)未成为最终态
      expect(index.query('globalData', 'c0').map(s => s.kind)).toEqual(['write']);
      expect(index.query('globalData', 'a0')).toEqual([]);
      expect(index.query('globalData', 'b0')).toEqual([]);
      expect(index.lastEditStats.commits).toBeLessThanOrEqual(2);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('取消旧代:在飞扫描被新编辑作废,旧结果丢弃', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdi-a76c-'));
    const writer = path.join(root, 'base', 'big.py');
    fs.mkdirSync(path.dirname(writer), { recursive: true });
    fs.writeFileSync(writer, 'import KBEngine\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer)];
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    const index = new GlobalDataDictIndex();
    try {
      await index.ensureStarted();
      const mk = (marker: string): string =>
        `import KBEngine\n${Array.from({ length: 12000 }, (_, i) => `KBEngine.globalData["${marker}${i}"] = ${i}\n`).join('')}`;
      const v1 = mk('x');
      const v2 = mk('y');
      index.noteSaved({ uri: { fsPath: writer }, getText: () => v1, isDirty: true } as never);
      // 同 tick 内作废:在飞扫描(旧代)被 revision 前进取消 → 旧结果丢弃
      index.noteSaved({ uri: { fsPath: writer }, getText: () => v2, isDirty: true } as never);
      await waitUntil(() => index.lastEditStats.commits >= 1);
      expect(index.lastEditStats.scansCancelled).toBeGreaterThanOrEqual(1);
      expect(index.query('globalData', 'y0').map(s => s.kind)).toEqual(['write']);
      expect(index.query('globalData', 'x0')).toEqual([]);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
