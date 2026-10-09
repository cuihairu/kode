import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  KBE_SCHEME,
  KBE_STUB_PATH,
  KBE_SYMBOLS,
  buildKbeStubDocument,
  buildKbeStubUriString,
  filterKbeSymbols,
  getKbeAliases,
  getKbeCompletionContext,
  getKbeFromImportedSymbols,
  getKbeSymbol,
  getPythonClassBaseAtPosition,
  resolveKbeAccessAtPosition
} from '../src/kbeModuleIndex';
import { resolveEngineRoot } from './helpers/engineRoot';

// kbe 模块符号索引(批108):别名解析、访问定位、补全语境、桩文档结构与
// URI 组装。符号面以引擎 typings 为唯一事实源——带 KBEngine 检出时逐条
// 回验 sourceFile:sourceLine 确实落在对应 class/def 声明行(与 hooks/
// metadata 的"插件数据 vs 引擎源码"同口径);无检出时该组 skip。

const engineRoot = resolveEngineRoot();

describe('kbe 模块符号索引(批108)', () => {
  it('符号表非空且 KBEntity 别名条目在列', () => {
    expect(KBE_SYMBOLS.length).toBeGreaterThan(0);
    const alias = getKbeSymbol('KBEntity');
    expect(alias?.aliasOf).toBe('Entity');
    expect(alias?.kind).toBe('class');
  });

  it('未知符号返回 null', () => {
    expect(getKbeSymbol('NoSuchSymbol')).toBeNull();
  });

  it('URI 组装为 kbe-stub scheme', () => {
    expect(buildKbeStubUriString()).toBe(`${KBE_SCHEME}:${KBE_STUB_PATH}`);
    expect(KBE_SCHEME).toBe('kbe-stub');
    expect(KBE_STUB_PATH).toBe('/KBEngine.pyi');
  });

  describe('别名解析 getKbeAliases', () => {
    it('import KBEngine / import kbe / as 别名 / from 语句全形态', () => {
      expect(getKbeAliases('import KBEngine\n')).toEqual(new Set(['KBEngine']));
      expect(getKbeAliases('import kbe\n')).toEqual(new Set(['kbe']));
      expect(getKbeAliases('import KBEngine as kbe\n')).toEqual(new Set(['kbe']));
      expect(getKbeAliases('from kbe import KBEntity\n')).toEqual(new Set(['kbe']));
      expect(getKbeAliases('from KBEngine import Entity\n')).toEqual(new Set(['KBEngine']));
    });

    it('无引入语句时为空集', () => {
      expect(getKbeAliases('class GameObject:\n    pass\n').size).toBe(0);
    });

    it('同文档多别名合并;缩进语句(函数内引入)同样识别', () => {
      const text = [
        'import KBEngine',
        'def setup():',
        '    import kbe',
        '    from KBEngine import Entity'
      ].join('\n');
      expect(getKbeAliases(text)).toEqual(new Set(['KBEngine', 'kbe']));
    });

    it('不吞相近模块名(kbek/KBEngineX 不命中)', () => {
      expect(getKbeAliases('import kbengine\nimport KBEngineX\n').size).toBe(0);
    });
  });

  describe('from-import 符号 getKbeFromImportedSymbols', () => {
    it('单名字/多名字/括号字面全形态', () => {
      expect(getKbeFromImportedSymbols('from kbe import KBEntity\n')).toEqual(new Set(['KBEntity']));
      expect(getKbeFromImportedSymbols('from KBEngine import Entity, Proxy\n'))
        .toEqual(new Set(['Entity', 'Proxy']));
      expect(getKbeFromImportedSymbols('from kbe import (KBEntity,\n  Entity)\n'))
        .toEqual(new Set(['KBEntity', 'Entity']));
    });

    it('非 kbe 来源与非法名字不入集', () => {
      expect(getKbeFromImportedSymbols('from os import path\n').size).toBe(0);
      expect(getKbeFromImportedSymbols('from kbe import *\n').size).toBe(0);
      expect(getKbeFromImportedSymbols('from kbe import a.b\n').size).toBe(0);
    });

    it('函数内缩进 from-import 同样识别', () => {
      expect(getKbeFromImportedSymbols('def f():\n    from kbe import KBEntity\n'))
        .toEqual(new Set(['KBEntity']));
    });
  });

  describe('类继承头基类定位 getPythonClassBaseAtPosition', () => {
    const locate = (line: string, needle: string) => line.indexOf(needle);

    it('基类首尾列均命中', () => {
      const line = 'class GameObject(Monster):';
      const start = locate(line, 'Monster');
      expect(getPythonClassBaseAtPosition(line, start)).toBe('Monster');
      expect(getPythonClassBaseAtPosition(line, start + 'Monster'.length)).toBe('Monster');
    });

    it('多基类列表按所在段命中', () => {
      const line = 'class Avatar(Monster, kbe.Space):';
      expect(getPythonClassBaseAtPosition(line, locate(line, 'Monster'))).toBe('Monster');
      expect(getPythonClassBaseAtPosition(line, locate(line, 'Space'))).toBe('Space');
    });

    it('类名与括号外不命中', () => {
      const line = 'class Avatar(Monster):';
      expect(getPythonClassBaseAtPosition(line, locate(line, 'class'))).toBeNull();
      expect(getPythonClassBaseAtPosition(line, locate(line, 'Avatar'))).toBeNull();
      expect(getPythonClassBaseAtPosition(line, line.length)).toBeNull();
    });

    it('非继承头(无括号/普通语句)不命中', () => {
      expect(getPythonClassBaseAtPosition('class Avatar:', 0)).toBeNull();
      expect(getPythonClassBaseAtPosition('x = dict(a=1)', 5)).toBeNull();
    });
  });

  describe('访问定位 resolveKbeAccessAtPosition', () => {
    const aliases = getKbeAliases('import KBEngine as kbe\n');

    it('类继承链样例:kbe.KBEntity 的 KBEntity 段命中', () => {
      const line = 'class GameObject(kbe.KBEntity):';
      const start = line.indexOf('KBEntity');
      const access = resolveKbeAccessAtPosition(line, start + 3, aliases);
      expect(access).toEqual({
        alias: 'kbe',
        symbol: 'KBEntity',
        symbolStart: start,
        symbolEnd: start + 'KBEntity'.length
      });
    });

    it('符号首列(含)与末列(含)均命中', () => {
      const line = 'x = kbe.Entity';
      const start = line.indexOf('Entity');
      expect(resolveKbeAccessAtPosition(line, start, aliases)?.symbol).toBe('Entity');
      expect(resolveKbeAccessAtPosition(line, start + 'Entity'.length, aliases)?.symbol).toBe('Entity');
    });

    it('符号区间外(模块名上/行首外)不命中', () => {
      const line = 'x = kbe.Entity';
      const moduleStart = line.indexOf('kbe');
      expect(resolveKbeAccessAtPosition(line, moduleStart, aliases)).toBeNull();
      expect(resolveKbeAccessAtPosition(line, 0, aliases)).toBeNull();
    });

    it('嵌套段(kbe.Entity.id 的 id)不属模块面,返回 null', () => {
      const line = 'kbe.Entity.id';
      const idStart = line.indexOf('id');
      expect(resolveKbeAccessAtPosition(line, idStart, aliases)).toBeNull();
    });

    it('未引入别名时不接管', () => {
      expect(resolveKbeAccessAtPosition('x = kbe.Entity', 8, new Set())).toBeNull();
    });

    it('属性链上的同名前缀(self.kbe.x)不接管', () => {
      const line = 'self.kbe.Entity';
      const start = line.indexOf('Entity');
      expect(resolveKbeAccessAtPosition(line, start, aliases)).toBeNull();
    });

    it('调用链结果上的同名前缀(getItems().kbe.x)不接管', () => {
      // 点号前是 ')' 的链段:贪婪匹配在 '()' 处断开,'kbe.Entity' 作为新
      // 匹配段起始且前导字符为 '.',落入前置守卫的 continue 分支
      const line = 'getItems().kbe.Entity';
      const start = line.indexOf('Entity');
      expect(resolveKbeAccessAtPosition(line, start, aliases)).toBeNull();
    });

    it('非别名模块(os.path)不命中', () => {
      expect(resolveKbeAccessAtPosition('import os.path', 11, aliases)).toBeNull();
    });
  });

  describe('补全语境 getKbeCompletionContext', () => {
    const aliases = getKbeAliases('import kbe\n');

    it('kbe. 与 kbe.partial 语境命中', () => {
      expect(getKbeCompletionContext('x = kbe.', aliases)).toEqual({ alias: 'kbe', partialSymbol: '' });
      expect(getKbeCompletionContext('x = kbe.cr', aliases)).toEqual({ alias: 'kbe', partialSymbol: 'cr' });
    });

    it('KBEngine 别名同款', () => {
      const kb = getKbeAliases('import KBEngine\n');
      expect(getKbeCompletionContext('KBEngine.create', kb)).toEqual({
        alias: 'KBEngine',
        partialSymbol: 'create'
      });
    });

    it('非模块语境(self. 与裸词)不命中', () => {
      expect(getKbeCompletionContext('self.kbe.', aliases)).toBeNull();
      expect(getKbeCompletionContext('kbe', aliases)).toBeNull();
      expect(getKbeCompletionContext('x = ', aliases)).toBeNull();
    });
  });

  describe('符号过滤 filterKbeSymbols', () => {
    it('空串返回全量', () => {
      expect(filterKbeSymbols('')).toEqual(KBE_SYMBOLS);
    });

    it('前缀大小写不敏感', () => {
      const names = filterKbeSymbols('kb').map(entry => entry.name);
      expect(names).toEqual(['KBEntity']);
    });

    it('createEntity 前缀命中全部创建族函数', () => {
      const names = filterKbeSymbols('createEntity').map(entry => entry.name);
      expect(names).toEqual([
        'createEntity',
        'createEntityLocally',
        'createEntityAnywhere',
        'createEntityRemotely',
        'createEntityFromDBID',
        'createEntityAnywhereFromDBID',
        'createEntityRemotelyFromDBID'
      ]);
    });

    it('无匹配返回空数组', () => {
      expect(filterKbeSymbols('zzz')).toEqual([]);
    });
  });

  describe('桩文档 buildKbeStubDocument', () => {
    const stub = buildKbeStubDocument();

    it('每个符号都有唯一声明行,行内容即签名', () => {
      const seen = new Set<number>();
      for (const entry of KBE_SYMBOLS) {
        const lineNo = stub.symbolLines[entry.name];
        expect(lineNo, `${entry.name} 应有桩文档行`).toBeGreaterThan(0);
        expect(seen.has(lineNo), `${entry.name} 声明行应唯一`).toBe(false);
        seen.add(lineNo);
        const lines = stub.content.split('\n');
        expect(lines[lineNo]).toBe(`${entry.signature}:`);
      }
    });

    it('头部注明 kode 提供与 KBEntity 别名口径', () => {
      const lines = stub.content.split('\n');
      expect(lines[0]).toContain('kode 提供');
      expect(stub.content).toContain('KBEntity 为 kode 内置别名');
    });

    it('KBEntity 条目带别名指向与引擎锚点行', () => {
      const kbLine = stub.symbolLines['KBEntity'];
      const lines = stub.content.split('\n');
      const body = lines.slice(kbLine, kbLine + 6).join('\n');
      expect(body).toContain('Entity');
      expect(body).toContain('typings/_KBEngine_common.pyi:52');
    });
  });
});

describe.skipIf(!engineRoot)('kbe 符号索引 vs 引擎 typings 源码', () => {
  it('每条符号的 sourceFile:sourceLine 落在引擎 typings 的对应声明行', () => {
    for (const entry of KBE_SYMBOLS) {
      const declName = entry.aliasOf ?? entry.name;
      const stubPath = path.join(engineRoot!, entry.sourceFile);
      const lines = fs.readFileSync(stubPath, 'utf8').split('\n');
      const declLine = lines[entry.sourceLine - 1];
      expect(
        declLine,
        `${entry.name} 锚点 ${entry.sourceFile}:${entry.sourceLine} 应存在`
      ).toBeDefined();
      const keyword = entry.kind === 'class' ? 'class' : 'def';
      expect(
        declLine.startsWith(`${keyword} ${declName}`),
        `${entry.name} 锚点行应为 "${keyword} ${declName}",实得: ${declLine}`
      ).toBe(true);
    }
  });
});
