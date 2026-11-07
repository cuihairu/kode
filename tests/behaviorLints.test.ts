import { describe, expect, it } from 'vitest';

import {
  buildFixedDictWholeReassignEdit,
  computeBehaviorLintFindingsAsync,
  computeDestroyedEntityReferenceFindings,
  computeFixedDictNestedMutationFindings,
  computeTimerLeakOnDestroyFindings,
  fixedDictRootPropertyNames,
  FIXED_DICT_NESTED_MUTATION_CODE,
  DESTROYED_ENTITY_REFERENCE_CODE,
  TIMER_LEAK_ON_DESTROY_CODE
} from '../src/behaviorLints';
import { maskPythonNonCode } from '../src/pythonLexicalMask';
import { parsePythonFile } from '../src/pythonParser';
import type { PropertyDefinitionInfo } from '../src/entityMapping';
import type { CustomTypeInfo } from '../src/definitionWorkspace';
import {
  FIXED_DICT_NESTED_MUTATION_CODE as FD_CODE_KB,
  DESTROYED_ENTITY_REFERENCE_CODE as DER_CODE_KB,
  TIMER_LEAK_ON_DESTROY_CODE as TL_CODE_KB
} from '../src/behaviorKnowledge';

const FILE = '/proj/assets/scripts/cell/avatar.py';

/** 掩码 + 解析一次(rule 2/3 常规入口) */
function prepared(text: string): { masked: string; parsed: ReturnType<typeof parsePythonFile> } {
  return { masked: maskPythonNonCode(text), parsed: parsePythonFile(text, FILE) };
}

describe('behaviorLints rule 1: fixed-dict-nested-mutation (C-23 ②)', () => {
  const fixedDictProps = new Set(['equip', 'bag']);

  it('flags subscript store and augmented store on FIXED_DICT properties', () => {
    const text = [
      'class Avatar(object):',
      '    def update(self):',
      "        self.equip['slot'] = 1",
      "        self.bag['a']['b'] += 2",
      "        self.equip['count'] -= 1"
    ].join('\n');
    const findings = computeFixedDictNestedMutationFindings(maskPythonNonCode(text), fixedDictProps);
    expect(findings).toHaveLength(3);
    for (const finding of findings) {
      expect(finding.code).toBe(FIXED_DICT_NESTED_MUTATION_CODE);
      expect(finding.message).toContain('FIXED_DICT');
    }
    expect(findings[0]).toMatchObject({ line: 2, character: 13, length: 5 });
    // 链式下标:整体配平后才看赋值号(第 3 行 `['a']['b'] += 2` 命中)
    expect(findings[1].line).toBe(3);
    expect(findings[2].line).toBe(4);
  });

  it('negative cases: plain assign, non-FIXED_DICT prop, reads, comparisons, comments/strings', () => {
    const text = [
      'class Avatar(object):',
      '    def update(self):',
      '        self.hp = 10',
      "        self.normal['k'] = 1",
      "        print(self.equip['k'])",
      "        if self.equip['k'] == 1:",
      '            pass',
      "        # self.equip['k'] = 1",
      '        s = "self.equip[\'k\'] = 1"'
    ].join('\n');
    const findings = computeFixedDictNestedMutationFindings(maskPythonNonCode(text), fixedDictProps);
    expect(findings).toHaveLength(0);
  });

  it('empty property set is zero-output (no FIXED_DICT in def → rule silent)', () => {
    const text = "self.equip['k'] = 1\n";
    expect(computeFixedDictNestedMutationFindings(maskPythonNonCode(text), new Set())).toHaveLength(0);
  });
});

describe('behaviorLints rule 2: destroyed-entity-reference (C-23 ②)', () => {
  it('flags self registered into module-level containers (call + subscript forms)', () => {
    const text = [
      'REGISTRY = {}',
      'ACTIVE = []',
      '',
      'class Avatar(object):',
      '    def enter(self):',
      '        REGISTRY[self.id] = self',
      '        ACTIVE.append(self)',
      '',
      '    def other(self):',
      '        self.cache.append(self)'
    ].join('\n');
    const { masked, parsed } = prepared(text);
    const findings = computeDestroyedEntityReferenceFindings(masked, parsed);
    expect(findings).toHaveLength(2);
    expect(findings.every(f => f.code === DESTROYED_ENTITY_REFERENCE_CODE)).toBe(true);
    expect(findings[0]).toMatchObject({ line: 5, character: 8, length: 8 });
    expect(findings[1]).toMatchObject({ line: 6, character: 8, length: 6 });
    expect(findings[0].message).toContain('REGISTRY');
    expect(findings[0].message).toContain('onDestroy');
  });

  it('negative: removal inside onDestroy cancels the finding per container name', () => {
    const text = [
      'REGISTRY = {}',
      'ACTIVE = []',
      '',
      'class Avatar(object):',
      '    def enter(self):',
      '        REGISTRY[self.id] = self',
      '        ACTIVE.append(self)',
      '',
      '    def onDestroy(self):',
      '        REGISTRY.pop(self.id, None)',
      '        ACTIVE.remove(self)'
    ].join('\n');
    const { masked, parsed } = prepared(text);
    expect(computeDestroyedEntityReferenceFindings(masked, parsed)).toHaveLength(0);
  });

  it('negative: local/param containers, non-self values, del-form removal', () => {
    const text = [
      'KEEP = {}',
      '',
      'class Avatar(object):',
      '    def reg(self, box):',
      '        box.append(self)',
      '',
      '    def store(self, other):',
      '        KEEP[other.id] = other',
      '        KEEP[self.id] = self',
      '',
      '    def onDestroy(self):',
      '        del KEEP[self.id]'
    ].join('\n');
    const { masked, parsed } = prepared(text);
    // box 是形参、other 不是 self、KEEP[self.id]=self 被 onDestroy del 抵消
    expect(computeDestroyedEntityReferenceFindings(masked, parsed)).toHaveLength(0);
  });
});

describe('behaviorLints rule 3: timer-leak-on-destroy (C-23 ②)', () => {
  const leak = (body: string[]): string => [
    'import KBEngine',
    '',
    'class Tick(object):',
    ...body
  ].join('\n');

  it('flags module-level KBEngine.addTimer with self-bound repeating callback', () => {
    const text = leak([
      '    def start(self):',
      '        KBEngine.addTimer(0.5, 1.0, self.onTick)'
    ]);
    const { masked, parsed } = prepared(text);
    const findings = computeTimerLeakOnDestroyFindings(masked, parsed);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(TIMER_LEAK_ON_DESTROY_CODE);
    expect(findings[0]).toMatchObject({ line: 4, character: 8, length: 17 });
    expect(findings[0].message).toContain('KBEngine.addTimer');
  });

  it('still flags when onDestroy exists but has no KBEngine.delTimer', () => {
    const text = leak([
      '    def start(self):',
      '        KBEngine.addTimer(0.5, 1.0, self.onTick)',
      '',
      '    def onDestroy(self):',
      '        self.cleanup()'
    ]);
    const { masked, parsed } = prepared(text);
    expect(computeTimerLeakOnDestroyFindings(masked, parsed)).toHaveLength(1);
  });

  it('negative: KBEngine.delTimer inside onDestroy marks the class managed', () => {
    const text = leak([
      '    def start(self):',
      '        self.tid = KBEngine.addTimer(0.5, 1.0, self.onTick)',
      '',
      '    def onDestroy(self):',
      '        KBEngine.delTimer(self.tid)'
    ]);
    const { masked, parsed } = prepared(text);
    expect(computeTimerLeakOnDestroyFindings(masked, parsed)).toHaveLength(0);
  });

  it('negative: single-shot (repeat=0), non-self callback, entity-level addTimer, module-level call', () => {
    const text = [
      'import KBEngine',
      '',
      'def boot():',
      '    KBEngine.addTimer(0.5, 1.0, on_global_tick)',
      '',
      'class Tick(object):',
      '    def start(self):',
      '        KBEngine.addTimer(0.5, 0, self.onOnce)',
      '        self.addTimer(0.5, 1.0, 0)',
      '        KBEngine.addTimer(0.5, 1.0, self.onTick)  # 类内但同款单发? 不,repeat=1 应报',
      '        pass'
    ].join('\n');
    const { masked, parsed } = prepared(text);
    const findings = computeTimerLeakOnDestroyFindings(masked, parsed);
    // 仅 repeat=1.0 自绑定那行命中(0 起第 9 行)
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(9);
    // 实体级 self.addTimer(第 8 行)绝不报(destroy 全量取消,知识基线)
    expect(findings.some(f => f.line === 8)).toBe(false);
  });
});

describe('behaviorLints orchestrator (C-23 ②)', () => {
  it('per-rule config switches disable each rule independently', async () => {
    const text = [
      'import KBEngine',
      'REGISTRY = {}',
      '',
      'class Avatar(object):',
      '    def start(self):',
      "        self.equip['slot'] = 1",
      '        REGISTRY[self.id] = self',
      '        KBEngine.addTimer(0.5, 1.0, self.onTick)'
    ].join('\n');
    const names = new Set(['equip']);
    const all = await computeBehaviorLintFindingsAsync(text, FILE, { fixedDictPropertyNames: names });
    expect(all).toHaveLength(3);
    const noFixedDict = await computeBehaviorLintFindingsAsync(text, FILE, {
      fixedDictPropertyNames: names,
      fixedDictNestedMutationEnabled: false
    });
    expect(noFixedDict!.every(f => f.code !== FIXED_DICT_NESTED_MUTATION_CODE)).toBe(true);
    expect(noFixedDict).toHaveLength(2);
    const noDestroyed = await computeBehaviorLintFindingsAsync(text, FILE, {
      fixedDictPropertyNames: names,
      destroyedEntityReferenceEnabled: false
    });
    expect(noDestroyed!.every(f => f.code !== DESTROYED_ENTITY_REFERENCE_CODE)).toBe(true);
    const noTimer = await computeBehaviorLintFindingsAsync(text, FILE, {
      fixedDictPropertyNames: names,
      timerLeakOnDestroyEnabled: false
    });
    expect(noTimer!.every(f => f.code !== TIMER_LEAK_ON_DESTROY_CODE)).toBe(true);
    const none = await computeBehaviorLintFindingsAsync(text, FILE, {
      fixedDictNestedMutationEnabled: false,
      destroyedEntityReferenceEnabled: false,
      timerLeakOnDestroyEnabled: false
    });
    expect(none).toHaveLength(0);
  });

  it('no rule-2/3 hints → parsed provider never invoked (zero-parse fast path)', async () => {
    const text = 'x = 1\n';
    const explode = (): never => {
      throw new Error('parsed provider must not be called when hints are absent');
    };
    const findings = await computeBehaviorLintFindingsAsync(text, FILE, { parsed: explode });
    expect(findings).toHaveLength(0);
  });

  it('parsed provider null with hints present → whole round aborts (null, no partial publish)', async () => {
    const text = 'import KBEngine\n\nclass T(object):\n    def s(self):\n        KBEngine.addTimer(0.5, 1.0, self.t)\n';
    const findings = await computeBehaviorLintFindingsAsync(text, FILE, { parsed: null });
    expect(findings).toBeNull();
  });
});

describe('fixedDictRootPropertyNames (type-graph judgment)', () => {
  const custom = (name: string, aliasType: string): CustomTypeInfo => ({
    name,
    filePath: '/proj/assets/scripts/entity_defs/types.xml',
    line: 0,
    implementedByLine: 0,
    startOffset: 0,
    endOffset: 0,
    aliasType,
    rawValue: '',
    structure: { name, rawValue: '', children: [], line: null },
    properties: []
  });

  const property = (
    symbolName: string,
    typeName: string,
    extra: Partial<PropertyDefinitionInfo['identity']> = {}
  ): PropertyDefinitionInfo => ({
    defFile: '/proj/assets/scripts/entities/cell.xml',
    line: 0,
    typeName,
    defaultValue: undefined,
    domains: [],
    persistent: false,
    identity: {
      ownerKind: 'entity',
      ownerName: 'Avatar',
      sourceKind: 'local',
      sourceChain: [],
      symbolName,
      ...extra
    }
  });

  it('resolves via the type graph (aliasType FIXED_DICT), skips component slots and sub-keys', () => {
    const infos: CustomTypeInfo[] = [
      custom('EQUIP_INFO', 'FIXED_DICT'),
      custom('SLOT_LIST', 'ARRAY')
    ];
    const props = [
      property('equip', 'EQUIP_INFO'),
      property('slots', 'SLOT_LIST'),
      property('bag', 'FIXED_DICT'),
      property('inner', 'EQUIP_INFO', { propertyPath: 'equip.inner' }),
      property('compProp', 'EQUIP_INFO', { componentSlotName: 'comp' })
    ];
    const names = fixedDictRootPropertyNames(props, infos);
    // 'bag' 直文本即 FIXED_DICT(未别名)同样命中;ARRAY/子键/组件槽不进
    expect([...names].sort()).toEqual(['bag', 'equip']);
  });

  it('null/undefined property list → empty set', () => {
    expect(fixedDictRootPropertyNames(null, []).size).toBe(0);
    expect(fixedDictRootPropertyNames(undefined, []).size).toBe(0);
  });
});

describe('buildFixedDictWholeReassignEdit (code action pure layer)', () => {
  it('rewrites a subscript store into the whole-reassign idiom, indent preserved', () => {
    const text = "class A(object):\n    def u(self):\n        self.equip['slot'] = 1\n";
    const edit = buildFixedDictWholeReassignEdit(text, 2);
    expect(edit).toEqual({
      startLine: 2,
      endLine: 3,
      text: [
        '        _fd = self.equip',
        "        _fd['slot'] = 1",
        '        self.equip = _fd'
      ].join('\n')
    });
  });

  it('augmented assignment keeps its operator; chained subscripts keep the full suffix', () => {
    const text = "        self.bag['a']['b'] += 2\n";
    const edit = buildFixedDictWholeReassignEdit(text, 0)!;
    expect(edit.text).toBe([
      '        _fd = self.bag',
      "        _fd['a']['b'] += 2",
      '        self.bag = _fd'
    ].join('\n'));
  });

  it('tab indent preserved; non-store lines and bad line numbers return null', () => {
    const tabEdit = buildFixedDictWholeReassignEdit("\t\tself.equip['k'] = v\n", 0)!;
    expect(tabEdit.text.split('\n')[0]).toBe('\t\t_fd = self.equip');
    expect(buildFixedDictWholeReassignEdit('        self.hp = 1\n', 0)).toBeNull();
    expect(buildFixedDictWholeReassignEdit("        if self.equip['k'] == 1:\n", 0)).toBeNull();
    expect(buildFixedDictWholeReassignEdit('', 0)).toBeNull();
    expect(buildFixedDictWholeReassignEdit("self.equip['k'] = 1\n", 9)).toBeNull();
  });
});
