import { describe, expect, it } from 'vitest';
import {
  HOT_RELOAD_STATE_LABELS,
  HOT_RELOAD_STATE_TRANSITIONS,
  HotReloadState,
  HotReloadStateMachine,
  HotReloadStateTransitionError,
  canHotReloadTransition,
  projectDeliveryOutcome,
  projectStatusKind
} from '../src/backend/hotReloadStateMachine';

// HR-STATE-001 状态模型+迁移表(纯核):13 态定义、迁移表逐行可达、非法迁移
// 如实拒、每键状态机初始 unknown、投递四态/状态栏七态投影、非法迁移错误可审。

const ALL_STATES: readonly HotReloadState[] = [
  'disabled',
  'idle',
  'dirty',
  'queued',
  'checking',
  'sending',
  'sent_unverified',
  'accepted',
  'applied',
  'failed',
  'blocked',
  'restart_required',
  'unknown'
];

describe('HR-STATE-001 13 态定义', () => {
  it('恰好 13 态,名字与 todo 行逐字一致(无重复)', () => {
    expect(ALL_STATES).toHaveLength(13);
    expect(new Set(ALL_STATES).size).toBe(13);
    // todo 行点名逐字在场
    for (const name of ALL_STATES) {
      expect(ALL_STATES).toContain(name);
    }
  });

  it('每态都有中文标签(只述已核实事实,未确认不称成功)', () => {
    for (const state of ALL_STATES) {
      const label = HOT_RELOAD_STATE_LABELS[state];
      expect(label.length).toBeGreaterThan(0);
    }
    // 未确认不称成功:sent_unverified 文案含「未确认」,不称「已应用」
    expect(HOT_RELOAD_STATE_LABELS.sent_unverified).toContain('未确认');
    expect(HOT_RELOAD_STATE_LABELS.sent_unverified).not.toContain('已应用');
  });
});

describe('HR-STATE-001 迁移表(定义)', () => {
  it('迁移表覆盖全部 13 态(每态都有 from 行)', () => {
    for (const state of ALL_STATES) {
      expect(HOT_RELOAD_STATE_TRANSITIONS[state]).toBeDefined();
    }
  });

  it('迁移表自洽:每个 from 的目标都在 13 态内,无自迁移(除非显式)', () => {
    for (const from of ALL_STATES) {
      const targets = HOT_RELOAD_STATE_TRANSITIONS[from];
      for (const to of targets) {
        expect(ALL_STATES).toContain(to);
      }
      // 自迁移不入表(幂等由状态机 current===state 短路)
      expect(targets).not.toContain(from);
    }
  });

  it('事实可达迁移(收拢既有四面已证):发送→未确认/接受/应用/失败/未知', () => {
    expect(canHotReloadTransition('sending', 'sent_unverified')).toBe(true);
    expect(canHotReloadTransition('sending', 'accepted')).toBe(true);
    expect(canHotReloadTransition('sending', 'applied')).toBe(true);
    expect(canHotReloadTransition('sending', 'failed')).toBe(true);
    expect(canHotReloadTransition('sending', 'unknown')).toBe(true);
  });

  it('回执升级链(晚回执不冒新代,既有守卫在侧):sent_unverified→accepted/applied/failed', () => {
    expect(canHotReloadTransition('sent_unverified', 'accepted')).toBe(true);
    expect(canHotReloadTransition('sent_unverified', 'applied')).toBe(true);
    expect(canHotReloadTransition('sent_unverified', 'failed')).toBe(true);
    expect(canHotReloadTransition('accepted', 'applied')).toBe(true);
  });

  it('再编辑→dirty(重入热更链):applied/failed/blocked/sent_unverified/accepted→dirty', () => {
    for (const from of ['applied', 'failed', 'blocked', 'sent_unverified', 'accepted'] as const) {
      expect(canHotReloadTransition(from, 'dirty')).toBe(true);
    }
  });

  it('def 结构变更→restart_required(仅已发送结果面):applied/failed→restart_required', () => {
    expect(canHotReloadTransition('applied', 'restart_required')).toBe(true);
    expect(canHotReloadTransition('failed', 'restart_required')).toBe(true);
  });

  it('关/拆→disabled(吸收):非 disabled 态皆可达 disabled', () => {
    for (const from of ALL_STATES) {
      if (from !== 'disabled') {
        expect(canHotReloadTransition(from, 'disabled')).toBe(true);
      }
    }
  });

  it('非法迁移如实拒:发送前阶段不可直接 applied;applied 不可回 sending', () => {
    expect(canHotReloadTransition('idle', 'applied')).toBe(false);
    expect(canHotReloadTransition('queued', 'applied')).toBe(false);
    expect(canHotReloadTransition('applied', 'sending')).toBe(false);
    expect(canHotReloadTransition('disabled', 'sending')).toBe(false);
  });

  it('迁移表与「合法目标集合」一致(canTransition 逐对核对,无表外漏网)', () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const inTable = HOT_RELOAD_STATE_TRANSITIONS[from].includes(to);
        expect(canHotReloadTransition(from, to)).toBe(inTable);
      }
    }
  });
});

describe('HotReloadStateMachine 每键状态机', () => {
  it('初始 unknown(未登记键如实 unknown,不猜)', () => {
    const machine = new HotReloadStateMachine();
    expect(machine.get('/ws/a.py')).toBe('unknown');
  });

  it('set 沿迁移表推进;非法迁移拒抛且状态原样', () => {
    const machine = new HotReloadStateMachine();
    machine.set('k', 'idle', true); // 初始置位
    machine.set('k', 'dirty');
    machine.set('k', 'queued');
    expect(machine.get('k')).toBe('queued');
    // 非法:queued → applied(跳过了 checking/sending)
    expect(() => machine.set('k', 'applied')).toThrow(HotReloadStateTransitionError);
    expect(machine.get('k')).toBe('queued'); // 原样
  });

  it('幂等 set 同态不报(短路),force 绕过校验', () => {
    const machine = new HotReloadStateMachine();
    machine.set('k', 'idle', true);
    machine.set('k', 'idle'); // 同态:不校验
    expect(machine.get('k')).toBe('idle');
    // force 绕过:unknown → applied(初始面/重置面)
    machine.set('k2', 'applied', true);
    expect(machine.get('k2')).toBe('applied');
  });

  it('trySet 非法返回 false 不抛;合法返回 true', () => {
    const machine = new HotReloadStateMachine();
    machine.set('k', 'idle', true);
    expect(machine.trySet('k', 'applied')).toBe(false);
    expect(machine.trySet('k', 'dirty')).toBe(true);
    expect(machine.get('k')).toBe('dirty');
  });

  it('keys/clear 面', () => {
    const machine = new HotReloadStateMachine();
    machine.set('a', 'idle', true);
    machine.set('b', 'dirty', true);
    expect(machine.keys().sort()).toEqual(['a', 'b']);
    machine.clear();
    expect(machine.keys()).toEqual([]);
    expect(machine.get('a')).toBe('unknown');
  });

  it('非法迁移错误可审(key/from/to)', () => {
    const machine = new HotReloadStateMachine();
    machine.set('k', 'idle', true);
    let caught: HotReloadStateTransitionError | undefined;
    try {
      machine.set('k', 'applied');
    } catch (error) {
      caught = error as HotReloadStateTransitionError;
    }
    expect(caught).toBeInstanceOf(HotReloadStateTransitionError);
    expect(caught?.key).toBe('k');
    expect(caught?.from).toBe('idle');
    expect(caught?.to).toBe('applied');
    expect(caught?.message).toContain('idle → applied');
  });
});

describe('HR-STATE-001 投影(既有四面→13 态)', () => {
  it('投递台账四态投影逐字对应(发送结果面)', () => {
    expect(projectDeliveryOutcome('sent-unverified')).toBe('sent_unverified');
    expect(projectDeliveryOutcome('accepted')).toBe('accepted');
    expect(projectDeliveryOutcome('applied')).toBe('applied');
    expect(projectDeliveryOutcome('failed')).toBe('failed');
  });

  it('状态栏七态投影(ready 类归 idle;watch-off 归 disabled)', () => {
    expect(projectStatusKind('watch-off')).toBe('disabled');
    expect(projectStatusKind('ready')).toBe('idle');
    expect(projectStatusKind('ready-with-error')).toBe('idle');
    expect(projectStatusKind('sending')).toBe('sending');
    expect(projectStatusKind('sent-unverified')).toBe('sent_unverified');
    expect(projectStatusKind('applied')).toBe('applied');
    expect(projectStatusKind('failed')).toBe('failed');
  });
});

// RUST-373(HR-STATE-013)reducer 属性测试:五场景钉迁移表之外的行为属性——
// 乱序返回不回退、重复回执幂等、失败后文件再编辑可重入、目标切换键隔离、
// Core 重启清零(不自动相信上一会话 applied)。用 trySet(非抛 reducer 面)
// 逐序列断言状态推进与如实拒绝。
describe('RUST-373 reducer/property 五场景', () => {
  it('乱序返回:晚回执不回退(已 applied 再收早代 sent_unverified 如实拒,状态原样)', () => {
    const machine = new HotReloadStateMachine();
    machine.set('k', 'sending', true);
    expect(machine.trySet('k', 'sent_unverified')).toBe(true);
    expect(machine.trySet('k', 'applied')).toBe(true); // 回执升级
    // 乱序:更早执行的 sent_unverified 晚到——applied 不可回退,如实拒
    expect(machine.trySet('k', 'sent_unverified')).toBe(false);
    expect(machine.get('k')).toBe('applied'); // 不回退,原样
  });

  it('重复回执:同态回执幂等(第二次 applied 不报不退)', () => {
    const machine = new HotReloadStateMachine();
    machine.set('k', 'sending', true);
    expect(machine.trySet('k', 'applied')).toBe(true);
    // 重复回执(同回执二次送达):同态短路,幂等 true,状态不变
    expect(machine.trySet('k', 'applied')).toBe(true);
    expect(machine.get('k')).toBe('applied');
    // 重复失败回执同样幂等
    expect(machine.trySet('k', 'dirty')).toBe(true);
    expect(machine.trySet('k', 'queued')).toBe(true);
    machine.trySet('k', 'checking');
    machine.trySet('k', 'sending');
    expect(machine.trySet('k', 'failed')).toBe(true);
    expect(machine.trySet('k', 'failed')).toBe(true);
    expect(machine.get('k')).toBe('failed');
  });

  it('失败后文件再编辑:failed→dirty(重入热更链)不抛不拒', () => {
    const machine = new HotReloadStateMachine();
    machine.set('k', 'sending', true);
    expect(machine.trySet('k', 'failed')).toBe(true);
    // 再编辑 → dirty,失败态可重入
    expect(machine.trySet('k', 'dirty')).toBe(true);
    expect(machine.get('k')).toBe('dirty');
  });

  it('目标切换:键隔离——切目标(换键)不串状态,新目标如实 unknown 独立起链', () => {
    const machine = new HotReloadStateMachine();
    // 目标 1 走到 applied
    machine.set('t1', 'idle', true);
    machine.trySet('t1', 'dirty');
    machine.trySet('t1', 'queued');
    machine.trySet('t1', 'checking');
    machine.trySet('t1', 'sending');
    machine.trySet('t1', 'applied');
    expect(machine.get('t1')).toBe('applied');
    // 切目标:目标 2 键独立,不受 t1 状态串扰(不猜成 applied,如实 unknown)
    expect(machine.get('t2')).toBe('unknown');
    // 目标 2 独立起链(初始 force 置位),不影响 t1
    machine.set('t2', 'idle', true);
    expect(machine.get('t2')).toBe('idle');
    expect(machine.get('t1')).toBe('applied');
  });

  it('Core 重启:clear 后全部键回落 unknown,不自动相信上一会话 applied(不 force 不可直达)', () => {
    const machine = new HotReloadStateMachine();
    machine.set('t1', 'idle', true);
    machine.trySet('t1', 'dirty');
    machine.trySet('t1', 'queued');
    machine.trySet('t1', 'checking');
    machine.trySet('t1', 'sending');
    machine.trySet('t1', 'applied');
    machine.set('t2', 'failed', true);
    // Core 重启 = clear(新会话):全部回落 unknown,键清空
    machine.clear();
    expect(machine.keys()).toEqual([]);
    expect(machine.get('t1')).toBe('unknown');
    expect(machine.get('t2')).toBe('unknown');
    // 重启后不自动相信上一会话的 applied:unknown 不可直达 applied(须重新走链核验)
    expect(machine.trySet('t1', 'applied')).toBe(false);
    expect(machine.get('t1')).toBe('unknown');
  });
});
