import { describe, expect, it } from 'vitest';

import {
  buildTrapDiagnosticItems,
  FixedDictWholeReassignCodeActionProvider,
  TRAP_LINT_DIAGNOSTIC_COLLECTION
} from '../src/trapDiagnosticsWiring';
import {
  FIXED_DICT_MUTATION_DIAGNOSTIC_CODE
} from '../src/fixedDictMutationDiagnostics';
import {
  DESTROYED_ENTITY_REFERENCE_DIAGNOSTIC_CODE
} from '../src/destroyedEntityCaptureDiagnostics';
import {
  TIMER_CLEANUP_ON_DESTROY_DIAGNOSTIC_CODE
} from '../src/timerCleanupDiagnostics';
import {
  Position,
  Range,
  makeTextDocument,
  workspace
} from './helpers/vscodeStub';

// C-23 交付②接线层:三规则产物聚合 + 诊断面形态 + quick fix provider。
// 开关逐规则独立(验收:规则可用配置关闭由三 toggles 保证);诊断 code 与
// 注册表一致(lintRuleRegistry 契约);FIXED_DICT 属性表由 wiring 层构建。

const allOn = {
  fixedDictMutation: true,
  destroyedEntityReference: true,
  timerCleanup: true
};

const TRAP_TEXT = [
  'REGISTRY = []',
  '',
  'class Avatar:',
  '    def __init__(self):',
  '        self.timerID = self.addTimer(1, 0, 0)',
  '',
  '    def rename(self):',
  '        self.profile.name = "abc"',
  '',
  '    def register(self):',
  '        REGISTRY.append(self)',
  '',
  '    def onDestroy(self):',
  '        self.delTimer(self.timerID)',
  ''
].join('\n');

describe('buildTrapDiagnosticItems(C-23 接线层)', () => {
  it('三规则齐开:FIXED_DICT 子键/容器滞留/冗余 delTimer 各一条', () => {
    const items = buildTrapDiagnosticItems(TRAP_TEXT, {
      fixedDictProperties: new Map([['profile', ['name']]]),
      enabled: allOn
    });
    expect(items.map(item => item.code)).toEqual([
      FIXED_DICT_MUTATION_DIAGNOSTIC_CODE,
      DESTROYED_ENTITY_REFERENCE_DIAGNOSTIC_CODE,
      TIMER_CLEANUP_ON_DESTROY_DIAGNOSTIC_CODE
    ]);
    expect(items.filter(item => item.severity === 'Warning')).toHaveLength(2);
    expect(items.filter(item => item.severity === 'Information')).toHaveLength(1);
  });

  it('规则可用配置关闭:关掉的规则零产物(逐规则独立)', () => {
    const deps = {
      fixedDictProperties: new Map([['profile', ['name']]]),
      enabled: { ...allOn, fixedDictMutation: false, timerCleanup: false }
    };
    const items = buildTrapDiagnosticItems(TRAP_TEXT, deps);
    expect(items.map(item => item.code)).toEqual([DESTROYED_ENTITY_REFERENCE_DIAGNOSTIC_CODE]);
  });
});

describe('FixedDictWholeReassignCodeActionProvider(整体重赋 quick fix)', () => {
  const provider = new FixedDictWholeReassignCodeActionProvider();

  const actionsOf = (lineText: string, line = 0): unknown[] => {
    const document = makeTextDocument(`${lineText}\n`, { fileName: '/p/scripts/cell/a.py', languageId: 'python' });
    const diagnostic = {
      code: FIXED_DICT_MUTATION_DIAGNOSTIC_CODE,
      range: new Range(new Position(line, 8), new Position(line, 24))
    } as never;
    return provider.provideCodeActions(
      document as never,
      new Range(new Position(line, 0), new Position(line, 10)) as never,
      { diagnostics: [diagnostic] } as never
    ) as unknown[];
  };

  it('直接赋值单段键:给整体重赋习语编辑', () => {
    const actions = actionsOf('        self.profile.name = "abc"');
    expect(actions).toHaveLength(1);
    const action = actions[0] as { title: string; edit?: unknown };
    expect(action.title).toBe('Reassign the whole FIXED_DICT property');
  });

  it('增强赋值/非本规则 code:不冒充,零动作', () => {
    expect(actionsOf('        self.profile.level += 1')).toHaveLength(0);
  });

  it('下标字符串键赋值:同给整体重赋习语编辑(引号双形态)', () => {
    expect(actionsOf(`        self.bag['slot'] = 1`)).toHaveLength(1);
    expect(actionsOf(`        self.bag["slot"] = 1`)).toHaveLength(1);
  });

  it('诊断 code 不属于本规则:循环跳过,零动作', () => {
    const document = makeTextDocument(`        self.profile.name = "abc"\n`, {
      fileName: '/p/scripts/cell/a.py',
      languageId: 'python'
    });
    const diagnostic = {
      code: 'kbengine.someOtherRule',
      range: new Range(new Position(0, 8), new Position(0, 24))
    } as never;
    const actions = provider.provideCodeActions(
      document as never,
      new Range(new Position(0, 0), new Position(0, 10)) as never,
      { diagnostics: [diagnostic] } as never
    );
    expect(actions).toHaveLength(0);
  });

  it('集合名常量与 extension.test 对账', () => {
    expect(TRAP_LINT_DIAGNOSTIC_COLLECTION).toBe('kbengine-trap-lints');
  });
});
