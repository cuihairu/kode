import { describe, expect, it } from 'vitest';

import {
  computeBehaviorLintFindingsAsync,
  computeDestroyedEntityReferenceFindings,
  computeFixedDictNestedMutationFindings,
  computeTimerLeakOnDestroyFindings,
  fixedDictRootPropertyNames,
  isFixedDictTypeName,
  FIXED_DICT_NESTED_MUTATION_CODE,
  DESTROYED_ENTITY_REFERENCE_CODE,
  TIMER_LEAK_ON_DESTROY_CODE
} from '../src/behaviorLints';
import { maskPythonNonCode } from '../src/backend/pythonLexicalMask';
import { parsePythonFile } from '../src/backend/pythonParser';
import type { PropertyDefinitionInfo } from '../src/entityMapping';
import type { CustomTypeInfo } from '../src/definitionWorkspace';

/**
 * Gap-arm coverage for src/behaviorLints.ts (baseline uncovered statement
 * start-lines 63, 77, 78, 99, 101, 112, 144, 147, 169, 243, 273, 333, 335,
 * 344, 400).
 *
 * DEAD ARM — line 63 (`return subject` in the `if (!entry)` guard of
 * findingMessage): `findingMessage` is only ever called with the three
 * exported codes (FIXED_DICT_NESTED_MUTATION_CODE / DESTROYED_ENTITY_REFERENCE_CODE
 * / TIMER_LEAK_ON_DESTROY_CODE), and every one of them is registered in
 * BEHAVIOR_KNOWLEDGE_ENTRIES with a matching `detection.code`
 * (behaviorKnowledge.ts:372 / :64 / :386). `behaviorEntryByCode` therefore
 * never returns undefined for those inputs, so `!entry` can never be true.
 * Not reachable via the module's public API (the code set is closed).
 */

const FILE = '/proj/assets/scripts/cell/avatar.py';

/** 掩码 + 解析一次(rule 2/3 常规入口) */
function prepared(text: string): { masked: string; parsed: ReturnType<typeof parsePythonFile> } {
  return { masked: maskPythonNonCode(text), parsed: parsePythonFile(text, FILE) };
}

describe('behaviorLints gap arms', () => {
  describe('findingMessage entry guard is dead (documented above)', () => {
    // 三条规则全部命中,消息里带上「依据」——证明 behaviorEntryByCode 对全部
    // 使用中的 code 都命中(不存在走 line 63 的输入)。断言按行为,不空跑。
    it('all three live codes resolve a knowledge entry (message carries evidence)', () => {
      const text = [
        'import KBEngine',
        'REGISTRY = {}',
        'class Avatar(object):',
        '    def start(self):',
        "        self.equip['slot'] = 1",
        '        REGISTRY[self.id] = self',
        '        KBEngine.addTimer(0.5, 1.0, self.onTick)'
      ].join('\n');
      const findings = computeFixedDictNestedMutationFindings(maskPythonNonCode(text), new Set(['equip']));
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('依据:');
      expect(findings[0].code).toBe(FIXED_DICT_NESTED_MUTATION_CODE);
    });
  });

  describe('splitTopLevelArgs nested brackets (77, 78)', () => {
    it('nested parens/brackets inside addTimer args are balanced by depth', () => {
      // `foo(a[1])` 内含 `(`/`[`/`]`/`)`——splitTopLevelArgs 的开口/闭口两臂都走
      const text = [
        'import KBEngine',
        'class Tick(object):',
        '    def start(self):',
        '        KBEngine.addTimer(foo(a[1]), 1.0, self.onTick)'
      ].join('\n');
      const { masked, parsed } = prepared(text);
      const findings = computeTimerLeakOnDestroyFindings(masked, parsed);
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(TIMER_LEAK_ON_DESTROY_CODE);
    });
  });

  describe('isFixedDictTypeName (99, 101)', () => {
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

    it('blank/null/whitespace typeName short-circuits false (99)', () => {
      expect(isFixedDictTypeName('', [])).toBe(false);
      expect(isFixedDictTypeName('   ', [])).toBe(false);
      expect(isFixedDictTypeName(null, [])).toBe(false);
      expect(isFixedDictTypeName(undefined, [])).toBe(false);
    });

    it('resolves via type graph alias (101): EQUIP_INFO -> FIXED_DICT is true, unknown is false', () => {
      const infos = [custom('EQUIP_INFO', 'FIXED_DICT')];
      expect(isFixedDictTypeName('EQUIP_INFO', infos)).toBe(true);
      expect(isFixedDictTypeName('SLOT_LIST', [custom('SLOT_LIST', 'ARRAY')])).toBe(false);
    });
  });

  describe('fixedDictRootPropertyNames empty typeName skip (112)', () => {
    const property = (symbolName: string, typeName: string | undefined): PropertyDefinitionInfo => ({
      defFile: '/proj/assets/scripts/entities/cell.xml',
      line: 0,
      typeName: typeName as string,
      defaultValue: undefined,
      domains: [],
      persistent: false,
      identity: {
        ownerKind: 'entity',
        ownerName: 'Avatar',
        sourceKind: 'local',
        sourceChain: [],
        symbolName
      }
    });

    it('blank/undefined typeName properties are skipped, valid ones kept', () => {
      const names = fixedDictRootPropertyNames(
        [
          property('blank', '   '),
          property('undef', undefined),
          property('good', 'FIXED_DICT')
        ],
        []
      );
      expect([...names]).toEqual(['good']);
    });
  });

  describe('consumeSubscriptChain defensive returns (144, 147, 169)', () => {
    const fixedDictProps = new Set(['equip']);

    it('misbalanced internal bracket returns -1 and skips the line (144, 169)', () => {
      // `self.equip[(x]) = 1`:链内 `)` 在 depth 归零且非 `]`——异形配平放弃
      const text = 'self.equip[(x]) = 1\n';
      const findings = computeFixedDictNestedMutationFindings(maskPythonNonCode(text), fixedDictProps);
      expect(findings).toHaveLength(0);
    });

    it('unclosed bracket chain returns -1 and skips the line (147, 169)', () => {
      // `self.equip[` 行尾未闭合——消费不到闭括号即放弃
      const text = 'self.equip[\n';
      const findings = computeFixedDictNestedMutationFindings(maskPythonNonCode(text), fixedDictProps);
      expect(findings).toHaveLength(0);
    });

    it('a well-formed store alongside malformed lines is still reported (169 does not swallow)', () => {
      const text = "self.equip[\nself.equip['k'] = 1\n";
      const findings = computeFixedDictNestedMutationFindings(maskPythonNonCode(text), fixedDictProps);
      expect(findings).toHaveLength(1);
      expect(findings[0].line).toBe(1);
    });
  });

  describe('computeDestroyedEntityReferenceFindings (243, 273)', () => {
    it('no module-level container names -> early return (243)', () => {
      const text = [
        'class Avatar(object):',
        '    def enter(self):',
        '        self.cache.append(self)'
      ].join('\n');
      const { masked, parsed } = prepared(text);
      expect(computeDestroyedEntityReferenceFindings(masked, parsed)).toHaveLength(0);
    });

    it('a class with no self-registration is skipped, sibling class still reported (273)', () => {
      const text = [
        'REGISTRY = {}',
        '',
        'class Quiet(object):',
        '    def nothing(self):',
        '        pass',
        '',
        'class Loud(object):',
        '    def enter(self):',
        '        REGISTRY[self.id] = self'
      ].join('\n');
      const { masked, parsed } = prepared(text);
      const findings = computeDestroyedEntityReferenceFindings(masked, parsed);
      // 只有 Loud 报;Quiet 的 registrations 空 → line 273 continue
      expect(findings).toHaveLength(1);
      expect(findings[0].line).toBe(8);
      expect(findings[0].code).toBe(DESTROYED_ENTITY_REFERENCE_CODE);
    });
  });

  describe('computeTimerLeakOnDestroyFindings (333, 335, 344)', () => {
    it('unclosed addTimer parens on the line -> skip (333)', () => {
      const text = [
        'import KBEngine',
        'class Tick(object):',
        '    def start(self):',
        '        KBEngine.addTimer(0.5, 1.0, self.onTick'
      ].join('\n');
      const { masked, parsed } = prepared(text);
      expect(computeTimerLeakOnDestroyFindings(masked, parsed)).toHaveLength(0);
    });

    it('fewer than two args -> skip (335)', () => {
      const text = [
        'import KBEngine',
        'class Tick(object):',
        '    def start(self):',
        '        KBEngine.addTimer(0.5)'
      ].join('\n');
      const { masked, parsed } = prepared(text);
      expect(computeTimerLeakOnDestroyFindings(masked, parsed)).toHaveLength(0);
    });

    it('self-bound call outside any class -> conservative skip (344)', () => {
      const text = [
        'import KBEngine',
        '',
        'KBEngine.addTimer(0.5, 1.0, self.onTick)',
        '',
        'class Tick(object):',
        '    def start(self):',
        '        pass'
      ].join('\n');
      const { masked, parsed } = prepared(text);
      expect(computeTimerLeakOnDestroyFindings(masked, parsed)).toHaveLength(0);
    });
  });

  describe('resolveParsed function provider (400)', () => {
    it('parsed as a thunk is invoked lazily and drives rule 2/3', async () => {
      const text = [
        'import KBEngine',
        'class Tick(object):',
        '    def start(self):',
        '        KBEngine.addTimer(0.5, 1.0, self.onTick)'
      ].join('\n');
      const parsed = parsePythonFile(text, FILE);
      const findings = await computeBehaviorLintFindingsAsync(text, FILE, { parsed: () => parsed });
      expect(findings).toHaveLength(1);
      expect(findings![0].code).toBe(TIMER_LEAK_ON_DESTROY_CODE);
    });
  });

});
