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

describe('GLOBDATA-003 函数调用键解析(纯函数面)', () => {
  const defsFrom = (text: string): Map<string, Map<string, string[]>> =>
    new Map([['defs.py', extractFunctionReturns(text)]]);

  it('extractFunctionReturns:字面量/拼接/多 return/嵌套 def 跳过/注释与字符串剔除', () => {
    const text = [
      'def literal():',
      '    return "cfg"',
      'def concat():',
      '    return "SERVER_" + str(id)',
      'def multi(cond):',
      '    if cond:',
      '        return "a"',
      '    return "b"',
      'def outer():',
      '    def inner():',
      '        return "inner"',
      '    return "outer"',
      'def bare():',
      '    return',
      'def none():',
      '    return None',
      'def dynamic():',
      '    return data[key]',
      'def callret():',
      '    return literal()',
      '# def notdef():',
      '    # return "x"',
      's = "def fake(): return \\"y\\""'
    ].join('\n');
    const defs = extractFunctionReturns(text);
    expect(defs.get('literal')).toEqual(['"cfg"']);
    expect(defs.get('concat')).toEqual(['"SERVER_" + str(id)']);
    expect(defs.get('multi')).toEqual(['"a"', '"b"']);
    expect(defs.get('outer')).toEqual(['"outer"']);
    expect(defs.get('inner')).toBeUndefined(); // 嵌套 def 体整体跳过(闭包不可按名调用)
    expect(defs.get('bare')).toBeUndefined(); // 裸 return
    expect(defs.get('none')).toBeUndefined(); // return None
    expect(defs.get('dynamic')).toEqual(['data[key]']);
    expect(defs.get('callret')).toEqual(['literal()']);
    expect(defs.has('notdef')).toBe(false);
    expect(defs.has('fake')).toBe(false);
  });

  it('resolveFunctionReturns:字面量/拼接/嵌套调用/多 return/跨文件并集', () => {
    expect(resolveFunctionReturns('literal', defsFrom('def literal(): return "cfg"'))).toEqual(['cfg']);
    expect(resolveFunctionReturns('concat', defsFrom('def concat(): return "SERVER_" + str(id)'))).toEqual(['SERVER_*']);
    expect(resolveFunctionReturns('multi', defsFrom('def multi(c):\n    if c:\n        return "a"\n    return "b"\n'))).toEqual(['a', 'b']);
    expect(resolveFunctionReturns('k', defsFrom('def helper(): return "SERVER_" + str(id)\ndef k(): return helper()\n'))).toEqual(['SERVER_*']);
    const cross = new Map<string, Map<string, string[]>>();
    cross.set('f1.py', extractFunctionReturns('def k(): return "a"\n'));
    cross.set('f2.py', extractFunctionReturns('def k(): return "b"\n'));
    expect(resolveFunctionReturns('k', cross)).toEqual(['a', 'b']);
  });

  it('resolveFunctionReturns:递归自指/互指/深度超限/不在工作区/全动态 → null', () => {
    expect(resolveFunctionReturns('a', defsFrom('def a(): return a()\n'))).toBeNull();
    expect(resolveFunctionReturns('a', defsFrom('def a(): return b()\ndef b(): return a()\n'))).toBeNull();
    const chain = defsFrom('def a(): return b()\ndef b(): return c()\ndef c(): return d()\ndef d(): return e()\ndef e(): return "x"\n');
    expect(resolveFunctionReturns('a', chain)).toBeNull(); // 深度>3
    expect(resolveFunctionReturns('d', chain)).toEqual(['x']);
    expect(resolveFunctionReturns('nope', defsFrom('def a(): return "x"\n'))).toBeNull();
    expect(resolveFunctionReturns('a', defsFrom('def a(): return data[k]\n'))).toBeNull();
  });

  it('findKbeDataDictAccesses 带解析器:调用键展开为每签名一条记录', () => {
    const fnDefs = defsFrom('def k(): return "cfg"\n');
    const resolver = (fn: string) => resolveFunctionReturns(fn, fnDefs);
    const text = [
      'import KBEngine',
      'v = KBEngine.globalData.get(k())',
      'KBEngine.globalData[k()] = 1'
    ].join('\n');
    const accesses = findKbeDataDictAccesses(text, KBE, resolver);
    expect(accesses.length).toBe(2);
    expect(accesses[0]).toMatchObject({ keySignature: 'cfg', callFn: 'k', kind: 'read' });
    expect(accesses[1]).toMatchObject({ keySignature: 'cfg', callFn: 'k', kind: 'write', valueText: '1' });
  });

  it('多 return 一访问点展开多条记录(keyStart/keyEnd 指向调用整体)', () => {
    const fnDefs = defsFrom('def k(c):\n    if c:\n        return "a"\n    return "b"\n');
    const resolver = (fn: string) => resolveFunctionReturns(fn, fnDefs);
    const text = 'import KBEngine\nv = KBEngine.globalData.get(k(1))';
    const accesses = findKbeDataDictAccesses(text, KBE, resolver);
    expect(accesses.length).toBe(2);
    expect(accesses.map(a => a.keySignature).sort()).toEqual(['a', 'b']);
    const keyStart = text.split('\n')[1].indexOf('k(1)');
    for (const access of accesses) {
      expect(access.keyStart).toBe(keyStart);
      expect(access.keyEnd).toBe(keyStart + 'k(1)'.length);
    }
  });

  it('动态 return/递归函数不解析(不索引);非调用复杂键仍不索引', () => {
    const dyn = defsFrom('def k(): return data[k]\n');
    expect(findKbeDataDictAccesses('import KBEngine\nv = KBEngine.globalData.get(k())', KBE, fn => resolveFunctionReturns(fn, dyn))).toEqual([]);
    const rec = defsFrom('def k(): return k()\n');
    expect(findKbeDataDictAccesses('import KBEngine\nv = KBEngine.globalData.get(k())', KBE, fn => resolveFunctionReturns(fn, rec))).toEqual([]);
    expect(findKbeDataDictAccesses('import KBEngine\nKBEngine.globalData[data[k]] = 1', KBE, fn => resolveFunctionReturns(fn, defsFrom('')))).toEqual([]);
  });

  it('无解析器(查询面):调用键出标记记录(callFn 设、keySignature null)', () => {
    const text = 'import KBEngine\nv = KBEngine.globalData.get(k())';
    const accesses = findKbeDataDictAccesses(text, KBE);
    expect(accesses.length).toBe(1);
    expect(accesses[0].callFn).toBe('k');
    expect(accesses[0].keySignature).toBeNull();
    expect(accesses[0].kind).toBe('read');
  });

  it('queryDataDictSitesForAccess:调用键路由到签名并集,普通键走单键', () => {
    const fnDefs = defsFrom('def k(c):\n    if c:\n        return "a"\n    return "b"\n');
    const fakeIndex = {
      resolveCallSignatures: (fn: string) => resolveFunctionReturns(fn, fnDefs),
      query: (dict: string, sig: string) =>
        sig === 'a' ? [{ file: 'w.py', dict, keySignature: 'a', line: 1, keyStart: 0, keyEnd: 1, kind: 'write', valueText: '1', exprEnd: 2 }] : []
    } as never;
    const callAccess = { dict: 'globalData', keySignature: null, callFn: 'k', line: 1, keyStart: 0, keyEnd: 3, kind: 'read', valueText: null, exprEnd: 4 };
    const sites = queryDataDictSitesForAccess(fakeIndex, callAccess);
    expect(sites.length).toBe(1);
    expect(sites[0].keySignature).toBe('a');
    const plain = queryDataDictSitesForAccess(fakeIndex, { ...callAccess, callFn: undefined, keySignature: 'cfg' });
    expect(plain).toEqual([]); // 假索引 query('cfg') 为空
  });
});
