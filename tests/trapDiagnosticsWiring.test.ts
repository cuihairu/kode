import { describe, expect, it } from 'vitest';

import {
  buildTrapDiagnosticItems,
  buildTrapDiagnosticItemsWithRust,
  FixedDictWholeReassignCodeActionProvider,
  renderRustTrapItems,
  TRAP_LINT_DIAGNOSTIC_COLLECTION,
  type TrapDiagnosticItem,
  type TrapLintComputeDeps
} from '../src/trapDiagnosticsWiring';
import {
  FIXED_DICT_MUTATION_DIAGNOSTIC_CODE,
  renderFixedDictMutationMessage
} from '../src/backend/fixedDictMutationDiagnostics';
import {
  DESTROYED_ENTITY_REFERENCE_DIAGNOSTIC_CODE
} from '../src/backend/destroyedEntityCaptureDiagnostics';
import {
  TIMER_CLEANUP_ON_DESTROY_DIAGNOSTIC_CODE
} from '../src/backend/timerCleanupDiagnostics';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
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

describe('buildTrapDiagnosticItemsWithRust(Rust-first,TS 兜底)', () => {
  const deps: TrapLintComputeDeps = {
    fixedDictProperties: new Map([['profile', ['name']]]),
    enabled: allOn
  };

  /** 注入门替身;runInRust 按给定应答回,记录 method/params */
  const withGate = async (
    respond: (method: string, params: unknown) => unknown,
    run: () => Promise<void>
  ): Promise<Array<{ method: string; params: unknown }>> => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const gate = {
      runInRust: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return respond(method, params);
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(gate);
    try {
      await run();
    } finally {
      setKodeCoreShadowGate(null);
    }
    return calls;
  };

  it('无门:回 TS 兜底,产物与同步路径逐条一致', async () => {
    const items = await buildTrapDiagnosticItemsWithRust(TRAP_TEXT, deps);
    expect(items).toEqual(buildTrapDiagnosticItems(TRAP_TEXT, deps));
  });

  it('门可用:Rust 结构面经渲染成诊断面(消息=TS 模板,严重级按 code)', async () => {
    const rustItem = {
      code: FIXED_DICT_MUTATION_DIAGNOSTIC_CODE,
      line: 8,
      character: 8,
      length: 17,
      property: 'profile'
    };
    await withGate(
      () => ({ ok: true as const, result: { items: [rustItem] } }),
      async () => {
        const items = await buildTrapDiagnosticItemsWithRust(TRAP_TEXT, deps);
        const expected: TrapDiagnosticItem[] = [{
          code: FIXED_DICT_MUTATION_DIAGNOSTIC_CODE,
          severity: 'Warning',
          line: 8,
          character: 8,
          length: 17,
          message: renderFixedDictMutationMessage('profile')
        }];
        expect(items).toEqual(expected);
      }
    );
  });

  it('门调用失败(ok:false):整面回 TS 兜底', async () => {
    await withGate(
      () => ({ ok: false as const, reason: 'no serverPath' }),
      async () => {
        const items = await buildTrapDiagnosticItemsWithRust(TRAP_TEXT, deps);
        expect(items).toEqual(buildTrapDiagnosticItems(TRAP_TEXT, deps));
      }
    );
  });

  it('畸形应答(缺 l10n 参数/未知 code/非条目):整面作废回 TS,不部分采用', async () => {
    // 注:空数组是合法空面(信任 Rust 结果),不属畸形
    const malformed: unknown[] = [
      { code: FIXED_DICT_MUTATION_DIAGNOSTIC_CODE, line: 0, character: 0, length: 3 }, // 缺 property
      { code: 'kbengine.unknownTrapCode', line: 0, character: 0, length: 1 },
      'not-an-item'
    ];
    for (const items of [malformed.slice(0, 1), malformed.slice(1)]) {
      await withGate(
        () => ({ ok: true as const, result: { items } }),
        async () => {
          const result = await buildTrapDiagnosticItemsWithRust(TRAP_TEXT, deps);
          expect(result).toEqual(buildTrapDiagnosticItems(TRAP_TEXT, deps));
        }
      );
    }
    expect(renderRustTrapItems([{ code: 'kbengine.unknownTrapCode', line: 0, character: 0, length: 1 }])).toBeNull();
  });

  it('RPC 契约:method=analyzeTraps,fixedDictProperties 序列化为普通对象', async () => {
    const calls = await withGate(
      () => ({ ok: true as const, result: { items: [] } }),
      async () => {
        await buildTrapDiagnosticItemsWithRust(TRAP_TEXT, deps);
      }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('$/kode/lint/analyzeTraps');
    expect(calls[0].params).toEqual({
      text: TRAP_TEXT,
      fixedDictProperties: { profile: ['name'] },
      enabled: allOn
    });
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
