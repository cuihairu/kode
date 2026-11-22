import { describe, expect, it } from 'vitest';
import {
  buildEngineProfile,
  createDefaultHotReloadEligibilityRule
} from '../src/backend/hotReloadPluginApi';
import type {
  HotReloadEligibilityDecision,
  HotReloadEligibilityInput
} from '../src/backend/hotReloadPluginApi';

/**
 * HR-QA-018(RUST-430):安全与功能完成矩阵——按 engine profile × root(目标)×
 * 文件类型 × 触发方式逐格签收。
 *
 * 缺省资格规则(createDefaultHotReloadEligibilityRule)是四要素分类面:
 *   engine profile(已知/未知)、root(已配/未配)、文件类型(.py/.def/非 py)、
 *   触发上下文(watcher-auto/command/temp-edit/retry/userInitiated + def 结构因)。
 * 本测试穷举全叉积,用**独立 oracle 重导契约**(restart=结构因非空;auto=四要素
 * 齐备;其余=manual),断言规则逐格命中——任何一格逃逸(auto 在缺要素、restart 在
 * 无结构因、出现第四种结论)即红。既有 HR-EXT-003 四钉是抽查;本矩阵是完备签收。
 *
 * 安全维(target/引擎侧)由各自门禁套件钉住,此处按契约只钉功能分类:
 *   未知引擎/未知根/非 py/人工链/用户显式 → 绝不 auto(保守 manual);
 *   def 结构因非空 → restart(优先于一切)。目标门(loopback 白名单 RUST-420、
 *   workspace trust RUST-422、权限声明 RUST-408)在 docs 矩阵节逐格签收,不重做。
 */

const rule = createDefaultHotReloadEligibilityRule();

const profileNull: HotReloadEligibilityInput['profile'] = null;
const profileUnknown = buildEngineProfile({}); // engineVersion null
const profileKnown = buildEngineProfile({ engineVersion: '2.5.10' });

const PROFILES: [string, HotReloadEligibilityInput['profile']][] = [
  ['profile-null', profileNull],
  ['profile-unknown', profileUnknown],
  ['profile-known', profileKnown]
];

const ROOTS: [string, HotReloadEligibilityInput['root']][] = [
  ['root-null', null],
  ['root-known', '/ws/scripts']
];

const FILES: [string, HotReloadEligibilityInput['fileUri']][] = [
  ['file-py', '/ws/scripts/entities/fight/FightAI.py'],
  ['file-def', '/ws/scripts/entities/fight/FightAI.def'],
  ['file-nonpy', '/ws/scripts/data.xml'],
  ['file-null', null]
];

const TRIGGERS: [string, 'watcher-auto' | 'command' | 'temp-edit' | 'retry' | undefined][] = [
  ['trigger-watcher-auto', 'watcher-auto'],
  ['trigger-command', 'command'],
  ['trigger-temp-edit', 'temp-edit'],
  ['trigger-retry', 'retry'],
  ['trigger-absent', undefined]
];

const USER_INITIATED: boolean[] = [false, true];
const STRUCTURAL: [string, string[]][] = [
  ['struct-none', []],
  ['struct-reasons', ['字段类型变更']]
];

/** 独立 oracle:重导契约(与实现无共享代码,防同源假绿) */
const oracle = (
  file: HotReloadEligibilityInput['fileUri'],
  root: HotReloadEligibilityInput['root'],
  engineKnown: boolean,
  trigger: 'watcher-auto' | 'command' | 'temp-edit' | 'retry' | undefined,
  userInitiated: boolean,
  structuralReasons: string[]
): HotReloadEligibilityDecision => {
  // ① restart 最强:def 结构闸结论非空,优先于一切
  if (structuralReasons.length > 0) {
    return 'restart';
  }
  // ② auto 须四要素齐备;缺一保守 manual
  const isPython = typeof file === 'string' && /\.py$/i.test(file);
  const rootKnown = typeof root === 'string' && root.length > 0;
  const autoTrigger = trigger === 'watcher-auto' && userInitiated !== true;
  return isPython && rootKnown && engineKnown && autoTrigger ? 'auto' : 'manual';
};

const buildInput = (
  profile: HotReloadEligibilityInput['profile'],
  root: HotReloadEligibilityInput['root'],
  file: HotReloadEligibilityInput['fileUri'],
  trigger: 'watcher-auto' | 'command' | 'temp-edit' | 'retry' | undefined,
  userInitiated: boolean,
  structuralReasons: string[]
): HotReloadEligibilityInput => ({
  profile,
  root,
  fileUri: file,
  context: { trigger, userInitiated, structuralReasons }
});

describe('HR-QA-018 资格分类矩阵逐格签收(engine profile×root×文件类型×触发方式)', () => {
  it('穷举全叉积:每格分类命中独立 oracle,且绝不抛错/绝无第四种结论', () => {
    let cells = 0;
    let autoCells = 0;
    let restartCells = 0;
    let manualCells = 0;

    for (const [pLabel, profile] of PROFILES) {
      for (const [rLabel, root] of ROOTS) {
        for (const [fLabel, file] of FILES) {
          for (const [tLabel, trigger] of TRIGGERS) {
            for (const userInitiated of USER_INITIATED) {
              for (const [sLabel, reasons] of STRUCTURAL) {
                const input = buildInput(profile, root, file, trigger, userInitiated, reasons);
                const expected = oracle(
                  file,
                  root,
                  profile !== null && profile !== undefined && profile.engineVersion !== null,
                  trigger,
                  userInitiated,
                  reasons
                );
                let decision: HotReloadEligibilityDecision;
                expect(() => {
                  decision = rule.decide(input);
                }).not.toThrow();
                // 结论只允许三种(无第四类)
                expect(['auto', 'manual', 'restart']).toContain(decision!);
                // 逐格签收:规则 = oracle
                expect(decision, `${pLabel}/${rLabel}/${fLabel}/${tLabel}/ui=${userInitiated}/${sLabel}`).toBe(
                  expected
                );
                cells += 1;
                if (expected === 'auto') autoCells += 1;
                if (expected === 'restart') restartCells += 1;
                if (expected === 'manual') manualCells += 1;
              }
            }
          }
        }
      }
    }

    // 完备性计数:auto 恰=四要素齐备格数(1 已知档案×1 已知根×1 py×1 watcher-auto×1 非用户×2 结构态
    // 中只有 struct-none 那半,另一半 restart 覆盖);restart 恰=全部格×结构因非空那半。
    expect(cells).toBe(PROFILES.length * ROOTS.length * FILES.length * TRIGGERS.length * USER_INITIATED.length * STRUCTURAL.length);
    expect(autoCells).toBe(1); // 唯一 auto 格(四要素齐备+无结构因)
    expect(restartCells).toBe(cells / 2); // 结构因非空那半恒 restart
    expect(manualCells).toBe(cells / 2 - 1); // 余下半减去唯一 auto 格
  });

  it('auto 恒须四要素:任一要素缺即 manual(安全面,不自动发未知目标)', () => {
    // 独立于 oracle 的正面断言:缺根/缺档案/非 py/人工链/用户显式逐一验证
    const base: HotReloadEligibilityInput = {
      profile: profileKnown,
      root: '/ws/scripts',
      fileUri: '/ws/scripts/a.py',
      context: { trigger: 'watcher-auto', userInitiated: false, structuralReasons: [] }
    };
    expect(rule.decide(base)).toBe('auto');
    expect(rule.decide({ ...base, root: null })).toBe('manual');
    expect(rule.decide({ ...base, profile: profileNull })).toBe('manual');
    expect(rule.decide({ ...base, profile: profileUnknown })).toBe('manual');
    expect(rule.decide({ ...base, fileUri: '/ws/scripts/a.def' })).toBe('manual');
    expect(rule.decide({ ...base, fileUri: '/ws/scripts/data.xml' })).toBe('manual');
    expect(rule.decide({ ...base, context: { ...base.context, trigger: 'command' } })).toBe('manual');
    expect(rule.decide({ ...base, context: { ...base.context, trigger: 'temp-edit' } })).toBe('manual');
    expect(rule.decide({ ...base, context: { ...base.context, trigger: 'retry' } })).toBe('manual');
    expect(rule.decide({ ...base, context: { ...base.context, userInitiated: true } })).toBe('manual');
    expect(rule.decide({ ...base, context: { ...base.context, structuralReasons: ['字段类型变更'] } })).toBe(
      'restart'
    );
  });

  it('def 轴诚实:规则不特判 .def,结构因空=manual,结构因非空=restart(def 闸供因)', () => {
    const defBase: HotReloadEligibilityInput = {
      profile: profileKnown,
      root: '/ws/scripts',
      fileUri: '/ws/scripts/entities/fight/FightAI.def',
      context: { trigger: 'watcher-auto', userInitiated: false, structuralReasons: [] }
    };
    expect(rule.decide(defBase)).toBe('manual');
    expect(rule.decide({ ...defBase, context: { trigger: 'watcher-auto', structuralReasons: ['字段类型变更'] } })).toBe(
      'restart'
    );
  });
});
