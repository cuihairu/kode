// KODE-SYN-005:领域标记纯核测试(computeDomainMarkerSpans 桩面)。
//
// 装饰层(setupKbengineDomainMarkers)依赖 vscode 装饰类型 API,vscodeStub
// 无 createTextEditorDecorationType,测试一律停在纯核层:注入桩解析器,钉四
// 个试点面的语义闸与诚实边界。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  computeDomainMarkerSpans,
  DOMAIN_MARKERS_CONFIG_KEY,
  DOMAIN_MARKER_HOOK_ROSTER_SIZE,
  DOMAIN_MARKERS_ENABLED_DEFAULT,
  type DomainMarkerResolvers
} from '../src/kbengineDomainMarkers';
import { KBENGINE_HOOKS } from '../src/hooks';

interface PropertyStub {
  domains: string[];
  typeName?: string;
  defFile: string;
  line: number;
}

interface MethodStub {
  section: string;
  defFile: string;
  line: number;
}

/**
 * 造桩解析器:属性按 fullPath 命中、方法按 (段, 名) 命中、数据字典键由
 * ready+写点数组裁定;每个解析器记录入参,供断言段闸/接收者分辨。
 */
function makeResolvers(opts: {
  properties?: Record<string, PropertyStub>;
  methods?: Record<string, MethodStub>; // key: `${section}:${name}`
  dataKey?: { ready: boolean; writeKeys: string[]; writeSites: number };
} = {}): DomainMarkerResolvers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolveProperty: async (_pythonFile, fullPath) => {
      calls.push(`property:${fullPath}`);
      const hit = opts.properties?.[fullPath];
      if (!hit) {
        return null;
      }
      return {
        identity: { symbolName: fullPath.split('.').pop() ?? fullPath },
        domains: hit.domains,
        typeName: hit.typeName,
        defFile: hit.defFile,
        line: hit.line
      };
    },
    resolveMethod: async (_pythonFile, methodName, section) => {
      calls.push(`method:${section}:${methodName}`);
      const hit = opts.methods?.[`${section}:${methodName}`];
      return hit ? { defFile: hit.defFile, line: hit.line, section: hit.section } : null;
    },
    queryDataKey: (dict, keySignature, _root) => {
      calls.push(`dataKey:${dict}:${keySignature}`);
      const spec = opts.dataKey;
      const writes =
        spec && (spec.writeKeys ?? []).some(key => keySignature.includes(key))
          ? spec.writeSites
          : 0;
      return {
        sites: Array.from({ length: writes }, () => ({ kind: 'write' })),
        ready: spec?.ready ?? false
      };
    }
  };
}

const ENTITY_PY = '/assets/scripts/base/MyPlayer.py';
const NON_ENTITY_PY = '/assets/scripts/utils/helpers.py';

/** 行相对取文本(span.character 是行内列,不是全文偏移) */
const lineText = (text: string, line: number): string => text.split('\n')[line] ?? '';

describe('KCODE-SYN-005 领域标记纯核', () => {
  it('钩子表面板钉 36 条引擎生命周期表', () => {
    expect(DOMAIN_MARKER_HOOK_ROSTER_SIZE).toBe(KBENGINE_HOOKS.length);
    expect(DOMAIN_MARKER_HOOK_ROSTER_SIZE).toBe(36);
  });

  it('开关默认关闭,键名与 package.json 声明一致', () => {
    expect(DOMAIN_MARKERS_ENABLED_DEFAULT).toBe(false);
    expect(DOMAIN_MARKERS_CONFIG_KEY).toBe('kbengine.domainMarkers.enabled');
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')
    );
    // configuration 可成数组(多配置块),逐块查键
    const blocks = Array.isArray(pkg.contributes.configuration)
      ? pkg.contributes.configuration
      : [pkg.contributes.configuration];
    const declared = blocks
      .map(block => block?.properties?.[DOMAIN_MARKERS_CONFIG_KEY])
      .filter((entry): entry is { default?: unknown } => entry !== undefined)[0];
    expect(declared).toBeDefined();
    expect(declared.default).toBe(DOMAIN_MARKERS_ENABLED_DEFAULT);
  });

  it('def 属性面:命中出标记,长度=访问路径长度,tooltip 带域身份与出处', async () => {
    const text = [
      'class MyPlayer:',
      '    def __init__(self):',
      '        self.hp = 100',
      '        self.unknown = 1'
    ].join('\n');
    const resolvers = makeResolvers({
      properties: { hp: { domains: ['base', 'cell'], typeName: 'int', defFile: 'avatar.def', line: 12 } }
    });
    const spans = await computeDomainMarkerSpans(text, ENTITY_PY, resolvers);
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span.face).toBe('property');
    expect(span.line).toBe(2);
    expect(span.length).toBe('hp'.length);
    expect(lineText(text, span.line).slice(span.character, span.character + span.length)).toBe('hp');
    expect(span.tooltip).toContain('def 属性 · hp · 域位 base/cell · int · avatar.def:12');
    // 未命中的属性也问过解析器(诚实查询,不猜),结果零标记
    expect(resolvers.calls).toContain('property:hp');
    expect(resolvers.calls).toContain('property:unknown');
  });

  it('def 属性面:继承来的属性按索引侧裁定,标记给出声明出处(不在本核重推继承链)', async () => {
    const text = [
      'class Fighter(Monster):',
      '    def swing(self):',
      '        self.cooldown = 0',
      '        self.held = 1'
    ].join('\n');
    // 继承链由 resolvePropertyDefinitionInfo 同一索引口径裁定:本核只透传
    // 解析结果,标记把出处指向基类 .def 声明行
    const resolvers = makeResolvers({
      properties: { cooldown: { domains: ['cell'], typeName: 'float', defFile: 'monster.def', line: 88 } }
    });
    const spans = await computeDomainMarkerSpans(text, ENTITY_PY, resolvers);
    expect(spans).toHaveLength(1);
    expect(spans[0].line).toBe(2);
    expect(spans[0].tooltip).toContain('def 属性 · cooldown · 域位 cell · float · monster.def:88');
    expect(resolvers.calls).toContain('property:held');
  });

  it('掩码域:字符串/注释里的伪 self.访问不进发现面', async () => {
    const text = [
      '# self.ghost = 1',
      'msg = "self.alsoGhost"',
      'class MyPlayer:',
      '    def __init__(self):',
      '        self.hp = 1'
    ].join('\n');
    const resolvers = makeResolvers({
      properties: { hp: { domains: ['cell'], defFile: 'a.def', line: 3 } }
    });
    const spans = await computeDomainMarkerSpans(text, ENTITY_PY, resolvers);
    expect(spans).toHaveLength(1);
    expect(spans[0].line).toBe(4);
    expect(resolvers.calls).not.toContain('property:ghost');
    expect(resolvers.calls).not.toContain('property:alsoGhost');
  });

  it('RPC 面:同名方法跨 Base/Cell 段由接收者段闸分辨,段外命中零标记', async () => {
    const text = [
      'class MyPlayer:',
      '    def tick(self):',
      '        self.base.doThing()',
      '        self.cell.doThing()',
      '        self.client.doThing()'
    ].join('\n');
    const resolvers = makeResolvers({
      methods: {
        'BaseMethods:doThing': { section: 'BaseMethods', defFile: 'base.def', line: 5 },
        'CellMethods:doThing': { section: 'CellMethods', defFile: 'cell.def', line: 9 }
      }
    });
    const spans = await computeDomainMarkerSpans(text, ENTITY_PY, resolvers);
    expect(spans).toHaveLength(2);
    const base = spans.find(span => span.line === 2);
    const cell = spans.find(span => span.line === 3);
    expect(base?.tooltip).toContain('def RPC(base) · BaseMethods · base.def:5');
    expect(cell?.tooltip).toContain('def RPC(cell) · CellMethods · cell.def:9');
    if (!base) { throw new Error('base 段标记缺失'); }
    expect(
      lineText(text, base.line).slice(base.character, base.character + 'doThing'.length)
    ).toBe('doThing');
    // 三段的调用都按段闸查过(含查不中的 ClientMethods),解析器逐段裁定
    expect(resolvers.calls).toContain('method:BaseMethods:doThing');
    expect(resolvers.calls).toContain('method:CellMethods:doThing');
    expect(resolvers.calls).toContain('method:ClientMethods:doThing');
  });

  it('未知接收者(self.other.x)零装饰,不按名字猜', async () => {
    const text = [
      'class MyPlayer:',
      '    def tick(self):',
      '        self.other.doThing()'
    ].join('\n');
    const resolvers = makeResolvers({
      methods: { 'BaseMethods:doThing': { section: 'BaseMethods', defFile: 'b.def', line: 2 } }
    });
    const spans = await computeDomainMarkerSpans(text, ENTITY_PY, resolvers);
    expect(spans.filter(span => span.face === 'rpc')).toHaveLength(0);
  });

  it('钩子面:类体声明且名字命中 36 条表才出;表外方法零标记', async () => {
    const text = [
      'class MyPlayer:',
      '    def onDestroy(self):',
      '        pass',
      '',
      '    def notAHook(self):',
      '        pass'
    ].join('\n');
    const resolvers = makeResolvers();
    const spans = await computeDomainMarkerSpans(text, ENTITY_PY, resolvers);
    const hooks = spans.filter(span => span.face === 'hook');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].line).toBe(1);
    expect(hooks[0].length).toBe('onDestroy'.length);
    expect(
      spans.filter(span => span.face === 'hook').map(span =>
        lineText(text, span.line).slice(span.character, span.character + span.length)
      )
    ).toEqual(['onDestroy']);
    const hook = KBENGINE_HOOKS.find(entry => entry.name === 'onDestroy');
    expect(hooks[0].tooltip).toContain(`引擎生命周期钩子 · onDestroy · ${hook?.category}`);
  });

  it('钩子面:非 entity 脚本树一律不出(段闸外)', async () => {
    const text = [
      'class Helper:',
      '    def onDestroy(self):',
      '        pass'
    ].join('\n');
    const resolvers = makeResolvers();
    const spans = await computeDomainMarkerSpans(text, NON_ENTITY_PY, resolvers);
    expect(spans.filter(span => span.face === 'hook')).toHaveLength(0);
  });

  it('数据字典键面:有真实写点才出,纯读/未就绪零标记', async () => {
    const text = [
      'import KBEngine as kbe',
      '',
      'def seed():',
      '    kbe.globalData["serverTick"] = 1',
      '    _ = kbe.globalData["readOnly"]'
    ].join('\n');

    // 首扫未就绪(ready=false):直接略过,绝不把「索引未建」读成「无此键」
    const notReady = makeResolvers({ dataKey: { ready: false, writeKeys: ['serverTick'], writeSites: 3 } });
    const skipped = await computeDomainMarkerSpans(text, ENTITY_PY, notReady);
    expect(skipped.filter(span => span.face === 'dataKey')).toHaveLength(0);

    // 就绪且写点≥1:出键标记;只读键(写点 0)零标记
    const ready = makeResolvers({ dataKey: { ready: true, writeKeys: ['serverTick'], writeSites: 2 } });
    const spans = await computeDomainMarkerSpans(text, ENTITY_PY, ready);
    const key = spans.filter(span => span.face === 'dataKey');
    expect(key).toHaveLength(1);
    expect(key[0].line).toBe(3);
    expect(
      lineText(text, key[0].line).slice(key[0].character, key[0].character + key[0].length)
    ).toContain('serverTick');
    expect(key[0].tooltip).toContain('数据字典键 · globalData');
    expect(key[0].tooltip).toContain('写点 2');
  });

  it('诚实边界:全未命中/解析抛错静默,返回空标记不阻塞', async () => {
    const text = [
      'class MyPlayer:',
      '    def __init__(self):',
      '        self.nothing = 1',
      '        self.base.none()'
    ].join('\n');
    const resolvers: DomainMarkerResolvers = {
      resolveProperty: async () => null,
      resolveMethod: async () => null,
      queryDataKey: () => ({ sites: [], ready: true })
    };
    const spans = await computeDomainMarkerSpans(text, ENTITY_PY, resolvers);
    expect(spans).toHaveLength(0);
  });
});
