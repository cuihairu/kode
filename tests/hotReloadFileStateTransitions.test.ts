import { describe, expect, it } from 'vitest';
import { HotReloadTargetStateStore, type HotReloadTargetKey } from '../src/backend/hotReloadTargetState';
import { HotReloadFileStateMachine, sha256Hex, worstHotReloadState, HOT_RELOAD_STATE_SEVERITY } from '../src/backend/hotReloadFileState';

// KODE-HOT-002 全转换验收:SENT/ACCEPTED/APPLIED/FAILED/DIRTY/RESTART_REQUIRED
// 每个转换带测试。本 describe 把设计 §3.2/§3.3 的转换图逐边走一遍——已由
// acceptance 1..7 各面覆盖的边不重复,这里补齐此前未直接断言的边:
// SENT→SENT(重发 attempt 推进仍待回执)/APPLIED→SENT/FAILED→SENT(重试或
// 新发送)/SENT 期间再编辑(派生口径:窗口内仍 SENT,accepted 只注解)/
// RESTART_REQUIRED 对一切投递态的优先级/超时结算的时间轴两向。

const KEY: HotReloadTargetKey = { rootId: '/ws', targetId: 'cellapp#a' };
const FILE = '/ws/scripts/base/Avatar.py';
const CONTENT_A = 'print("A")\n';
const CONTENT_B = 'print("B")\n';

const makeStore = (): HotReloadTargetStateStore => new HotReloadTargetStateStore({ now: () => 1000 });

describe('KODE-HOT-002 全转换矩阵(逐边)', () => {
  it('CLEAN →(保存)→ DIRTY →(入发送集)→ SENT(attempt=1)', () => {
    const sm = new HotReloadFileStateMachine({ now: () => 1000, timeoutWindowMs: 10_000 });
    const store = makeStore();
    sm.derive(store, KEY, FILE, CONTENT_A); // 首见注册基线 → CLEAN
    expect(sm.derive(store, KEY, FILE, CONTENT_B).state).toBe('DIRTY');
    store.record(KEY, FILE, 'sent-unverified', {});
    expect(sm.derive(store, KEY, FILE, CONTENT_B).state).toBe('SENT');
    const view = sm.derive(store, KEY, FILE, CONTENT_B);
    expect(view.attempt).toBe(1);
  });

  it('SENT →(同文件重发)→ SENT(attempt 推进,仍是待回执不是新 DIRTY)', () => {
    const sm = new HotReloadFileStateMachine({ now: () => 1000, timeoutWindowMs: 10_000 });
    const store = makeStore();
    sm.derive(store, KEY, FILE, CONTENT_A);
    store.record(KEY, FILE, 'sent-unverified', {});
    store.record(KEY, FILE, 'sent-unverified', {}); // 重试/再次发送:台账覆盖,attempt=2
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('SENT');
    expect(view.attempt).toBe(2);
  });

  it('SENT 期间再编辑 → 派生口径仍 SENT(窗口内待回执优先;accepted 只注解)', () => {
    // 设计 §3.2:SENT=入发送集待回执;窗口内台账记录在途,等待回执或超时
    // 结算,期间的内容变化在窗口结算时按 sentDigest 判定回落,本边钉住当前
    // 契约:pending 分支无条件 SENT,不为内容漂移提前改判。
    const sm = new HotReloadFileStateMachine({ now: () => 1000, timeoutWindowMs: 10_000 });
    const store = makeStore();
    sm.derive(store, KEY, FILE, CONTENT_A);
    store.record(KEY, FILE, 'sent-unverified', {});
    expect(sm.derive(store, KEY, FILE, 'print("edited while pending")\n').state).toBe('SENT');
  });

  it('SENT →(applied+digest=所发内容)→ APPLIED →(再次发送)→ SENT(回执未到不残留 APPLIED)', () => {
    const sm = new HotReloadFileStateMachine({ now: () => 1000, timeoutWindowMs: 10_000 });
    const store = makeStore();
    sm.derive(store, KEY, FILE, CONTENT_A);
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: sha256Hex(CONTENT_A) });
    store.record(KEY, FILE, 'applied', { sentDigest: sha256Hex(CONTENT_A) });
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('APPLIED');
    // applied 后再发新版本:台账覆盖为 sent-unverified → 回 SENT,attempt 推进
    store.record(KEY, FILE, 'sent-unverified', {});
    expect(sm.derive(store, KEY, FILE, CONTENT_B).state).toBe('SENT');
    expect(sm.derive(store, KEY, FILE, CONTENT_B).attempt).toBe(3);
  });

  it('SENT →(投递失败)→ FAILED →(重试发送)→ SENT(台账翻面不留 failed 旧账)', () => {
    const sm = new HotReloadFileStateMachine({ now: () => 1000, timeoutWindowMs: 10_000 });
    const store = makeStore();
    sm.derive(store, KEY, FILE, CONTENT_A);
    store.record(KEY, FILE, 'failed', { detail: 'ECONNREFUSED' });
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('FAILED');
    store.record(KEY, FILE, 'sent-unverified', {});
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('SENT');
  });

  it('SENT →(窗口内 accepted)→ SENT 注解 →(超时结算)→ FAILED(不冒充 applied)', () => {
    const sm = new HotReloadFileStateMachine({ now: () => 1000, timeoutWindowMs: 10_000 });
    const store = makeStore();
    sm.derive(store, KEY, FILE, CONTENT_A);
    store.record(KEY, FILE, 'accepted', { detail: '回执 accepted:应用仍需核验' });
    const pending = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(pending.state).toBe('SENT');
    expect(pending.annotation).toContain('accepted');
    // 超时结算(recordedAt=1000,窗口 10s,now 推到 20000)→ FAILED,未确认语义
    const smLate = new HotReloadFileStateMachine({ now: () => 20_000, timeoutWindowMs: 10_000 });
    const view = smLate.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('FAILED');
    expect(view.reason).toContain('未确认');
  });

  it('SENT →(窗口内未确认)→ SENT;过截止 → FAILED;applied 记录过截止仍 APPLIED(时间轴两向)', () => {
    const store = makeStore();
    const sm = new HotReloadFileStateMachine({ now: () => 1000, timeoutWindowMs: 10_000 });
    sm.derive(store, KEY, FILE, CONTENT_A);
    store.record(KEY, FILE, 'sent-unverified', {});
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('SENT');
    expect(new HotReloadFileStateMachine({ now: () => 11_000, timeoutWindowMs: 10_000 }).derive(store, KEY, FILE, CONTENT_A).state).toBe('SENT');
    expect(new HotReloadFileStateMachine({ now: () => 11_001, timeoutWindowMs: 10_000 }).derive(store, KEY, FILE, CONTENT_A).state).toBe('FAILED');
    // applied 不受窗口影响:过截止仍是 APPLIED(终态,不回落)
    const store2 = makeStore();
    store2.record(KEY, FILE, 'applied', { sentDigest: sha256Hex(CONTENT_A) });
    expect(new HotReloadFileStateMachine({ now: () => 99_999, timeoutWindowMs: 10_000 }).derive(store2, KEY, FILE, CONTENT_A).state).toBe('APPLIED');
  });

  it('FAILED 后内容再改 → DIRTY →(再发送)→ SENT(FAILED──改──▶DIRTY──发──▶SENT)', () => {
    const sm = new HotReloadFileStateMachine({ now: () => 1000, timeoutWindowMs: 10_000 });
    const store = makeStore();
    sm.derive(store, KEY, FILE, CONTENT_A);
    store.record(KEY, FILE, 'failed', { sentDigest: sha256Hex(CONTENT_A), detail: 'boom' });
    expect(sm.derive(store, KEY, FILE, CONTENT_B).state).toBe('DIRTY');
    store.record(KEY, FILE, 'sent-unverified', {});
    expect(sm.derive(store, KEY, FILE, CONTENT_B).state).toBe('SENT');
  });

  it('RESTART_REQUIRED 优先于一切投递态(record=FAILED/APPLIED 也被拦下盖住);解除后回落投递事实态', () => {
    const sm = new HotReloadFileStateMachine({ now: () => 1000, timeoutWindowMs: 10_000 });
    const store = makeStore();
    sm.derive(store, KEY, FILE, CONTENT_A);
    store.record(KEY, FILE, 'applied', { sentDigest: sha256Hex(CONTENT_A) });
    sm.markRestartRequired(KEY, [FILE], ['属性结构变化']);
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('RESTART_REQUIRED');
    // FAILED 记录同样被拦下态盖住(拦下是保守拦截,优先级高于投递事实呈现)
    store.record(KEY, FILE, 'failed', { detail: 'boom' });
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('RESTART_REQUIRED');
    sm.clearRestartRequired(KEY, [FILE]);
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('FAILED');
  });

  it('严重度序:六态各有唯一位次,单调递进(状态集闭包)', () => {
    // severity 序单调:CLEAN < APPLIED < SENT < DIRTY < FAILED < RESTART_REQUIRED
    expect(HOT_RELOAD_STATE_SEVERITY.CLEAN).toBeLessThan(HOT_RELOAD_STATE_SEVERITY.APPLIED);
    expect(HOT_RELOAD_STATE_SEVERITY.APPLIED).toBeLessThan(HOT_RELOAD_STATE_SEVERITY.SENT);
    expect(HOT_RELOAD_STATE_SEVERITY.SENT).toBeLessThan(HOT_RELOAD_STATE_SEVERITY.DIRTY);
    expect(HOT_RELOAD_STATE_SEVERITY.DIRTY).toBeLessThan(HOT_RELOAD_STATE_SEVERITY.FAILED);
    expect(HOT_RELOAD_STATE_SEVERITY.FAILED).toBeLessThan(HOT_RELOAD_STATE_SEVERITY.RESTART_REQUIRED);
    // 六态两两可区分(位次全异)
    const all = ['CLEAN', 'APPLIED', 'SENT', 'DIRTY', 'FAILED', 'RESTART_REQUIRED'] as const;
    expect(new Set(all.map(state => HOT_RELOAD_STATE_SEVERITY[state])).size).toBe(6);
    // worst 聚合任取子集都落在集合内(闭包),全干净=CLEAN
    expect(worstHotReloadState([...all])).toBe('RESTART_REQUIRED');
    expect(worstHotReloadState(['CLEAN'])).toBe('CLEAN');
  });
});
