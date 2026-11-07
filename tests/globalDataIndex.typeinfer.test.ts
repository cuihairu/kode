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
