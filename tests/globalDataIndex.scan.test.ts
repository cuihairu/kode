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

  it('R4-F12:from-import 不绑定模块别名,KBEngine.globalData 不入索引;import/as 照常', () => {
    // from KBEngine import Entity 只引入 Entity,KBEngine 不是模块绑定别名
    const fromOnly = 'from KBEngine import Entity\nKBEngine.globalData["cfg"] = 1\n';
    expect(getKbeAliases(fromOnly)).toEqual(new Set());
    expect(findKbeDataDictAccesses(fromOnly, getKbeAliases(fromOnly))).toEqual([]);
    // import / import as 照常识别
    expect(getKbeAliases('import KBEngine\n').size).toBe(1);
    expect(getKbeAliases('import KBEngine as k\n')).toEqual(new Set(['k']));
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

describe('getKbeDataDictAccessAtPosition(GLOBDATA-001 定位)', () => {
  it('落点落在键表达式上命中,落点在外返回 null', () => {
    const line = 'KBEngine.globalData.get("cfg")';
    const onKey = getKbeDataDictAccessAtPosition(line, line.indexOf('cfg') + 1, KBE);
    expect(onKey?.keySignature).toBe('cfg');
    expect(onKey?.kind).toBe('read');
    expect(getKbeDataDictAccessAtPosition(line, 0, KBE)).toBeNull();
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
