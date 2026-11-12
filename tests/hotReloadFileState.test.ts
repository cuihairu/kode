import { describe, expect, it } from 'vitest';
import { HotReloadTargetStateStore, type HotReloadTargetKey } from '../src/backend/hotReloadTargetState';
import {
  HotReloadFileStateMachine,
  sha256Hex,
  worstHotReloadState,
  HOT_RELOAD_ATTENTION_STATES,
  type HotReloadFileStateView
} from '../src/backend/hotReloadFileState';

// IDE-HOT-100 脚本文件热更状态机:每个 (rootId,targetId,file) 一份
// CLEAN/DIRTY/SENT/APPLIED/FAILED/RESTART_REQUIRED 生命周期态。依据=文件
// 内容 sha256 + 既有 accepted/applied 回执协议(HOT-002/003/004),不靠
// mtime;台账(HotReloadTargetStateStore)是事实源,本状态机是派生视图,
// 二者键同形(rootId×targetId×file),不另立身份。基线=最近一次 APPLIED
// 所发 hash,或会话基线册首次出现且 hash 相等。

const KEY: HotReloadTargetKey = { rootId: '/ws', targetId: 'cellapp#a' };
const FILE = '/ws/scripts/base/Avatar.py';
const CONTENT_A = 'print("A")\n';
const CONTENT_B = 'print("B")\n';
const DIGEST_A = sha256Hex(CONTENT_A);
const DIGEST_B = sha256Hex(CONTENT_B);

const makeState = (now = 1000, timeoutWindowMs = 10_000): HotReloadFileStateMachine =>
  new HotReloadFileStateMachine({ now: () => now, timeoutWindowMs });

const makeStore = (now = 1000): HotReloadTargetStateStore => new HotReloadTargetStateStore({ now: () => now });

describe('sha256Hex(状态依据原语)', () => {
  it('内容 sha256 与 applied 核验同源(现成 node:crypto 原语)', () => {
    expect(DIGEST_A).toMatch(/^[0-9a-f]{64}$/);
    expect(DIGEST_A).not.toBe(DIGEST_B);
  });
});

describe('acceptance 1: 内容 hash 偏离基线 → DIRTY;改回 → CLEAN(mtime 无关)', () => {
  it('未发送且内容与基线一致 → CLEAN', () => {
    const sm = makeState();
    const view = sm.derive(makeStore(), KEY, FILE, CONTENT_A);
    expect(view.state).toBe('CLEAN');
    expect(view.baselineDigest).toBe(DIGEST_A);
  });

  it('未发送且内容偏离基线 → DIRTY', () => {
    const sm = makeState();
    const store = makeStore();
    sm.derive(store, KEY, FILE, CONTENT_A); // 注册会话基线 A
    expect(sm.derive(store, KEY, FILE, CONTENT_B).state).toBe('DIRTY');
  });

  it('改回原内容(hash 回基线)→ CLEAN(mtime 变化无关)', () => {
    const sm = makeState();
    const store = makeStore();
    sm.derive(store, KEY, FILE, CONTENT_A); // 基线 A
    expect(sm.derive(store, KEY, FILE, CONTENT_B).state).toBe('DIRTY');
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('CLEAN');
  });
});

describe('acceptance 2: 入发送集 → SENT;applied+digest 一致 → APPLIED(基线=所发 hash)', () => {
  it('入发送集(台账 sent-unverified,窗口内)→ SENT', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('SENT');
    expect(view.attempt).toBe(1);
  });

  it('applied 回执+digest 一致 → APPLIED,基线更新为所发 hash', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'applied', { sentDigest: DIGEST_A, detail: '回执 applied 且 digest 一致:已应用' });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('APPLIED');
    expect(view.baselineDigest).toBe(DIGEST_A);
    expect(view.detail).toContain('applied');
  });

  it('APPLIED 后文件再改 → DIRTY(新一次偏离)', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'applied', { sentDigest: DIGEST_A });
    expect(sm.derive(store, KEY, FILE, CONTENT_B).state).toBe('DIRTY');
  });
});

describe('acceptance 3: accepted 回执 → 保持 SENT(注解),不提前转 APPLIED', () => {
  it('accepted 回执 → SENT 注解 accepted,仍等 applied', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    store.record(KEY, FILE, 'accepted', {
      attempt: 1,
      detail: '回执 accepted:file 回显一致(应用仍需 HOT-004 核验)'
    });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('SENT');
    expect(view.annotation).toContain('accepted');
  });
});

describe('acceptance 4: 投递失败/回执超时 → FAILED 带原因,不冒充 applied', () => {
  it('投递失败 → FAILED 带原因', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'failed', { detail: 'HTTP 状态 500:非 2xx 不算送达', now: 1000 });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('FAILED');
    expect(view.reason).toContain('HTTP 状态 500');
    expect(view.state).not.toBe('APPLIED');
  });

  it('updatedAt 透传台账投递时刻(呈现面据此显示「上次 HH:MM:SS」)', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    expect(sm.derive(store, KEY, FILE, CONTENT_A).updatedAt).toBe(1000);
  });

  it('回执超时未确认 → FAILED(未确认/超时),不冒充 applied', () => {
    // 窗口 = 1000 + 10000 = 11000;now=20000 已过
    const sm = makeState(20000);
    const store = makeStore(1000);
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('FAILED');
    expect(view.reason).toContain('超时');
    expect(view.reason).toContain('未确认');
  });

  it('FAILED 后文件再改 → DIRTY(可再发)', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'failed', { sentDigest: DIGEST_A, detail: '失败' });
    expect(sm.derive(store, KEY, FILE, CONTENT_B).state).toBe('DIRTY');
    // 内容仍为所发失败内容 → FAILED 如实保持
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('FAILED');
  });
});

describe('acceptance 5: 结构性 def 变更 → RESTART_REQUIRED,不进普通 reload', () => {
  it('markRestartRequired → RESTART_REQUIRED(不是失败,是保守拦下)', () => {
    const sm = makeState();
    const store = makeStore();
    sm.markRestartRequired(KEY, [FILE], ['Avatar.def: 属性面结构变化']);
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('RESTART_REQUIRED');
    expect(view.reason).toContain('结构性');
  });

  it('clearRestartRequired 解除后回落原态', () => {
    const sm = makeState();
    const store = makeStore();
    sm.markRestartRequired(KEY, [FILE], ['结构变化']);
    sm.clearRestartRequired(KEY, [FILE]);
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('CLEAN');
  });

  it('restartRequiredFiles 列出被拦文件', () => {
    const sm = makeState();
    const other = '/ws/scripts/base/Account.py';
    sm.markRestartRequired(KEY, [FILE, other], ['结构变化']);
    expect(sm.restartRequiredFiles(KEY).sort()).toEqual([FILE, other].sort());
  });
});

describe('acceptance 6: 重试 → 新 SENT(attempt 推进),成功后再 APPLIED', () => {
  it('失败后重发=新发送,attempt 推进;成功后再 APPLIED', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'failed', { detail: '第一次失败' }); // attempt 1
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A }); // attempt 2 重发
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('SENT');
    expect(view.attempt).toBe(2);
    // 重发成功(applied 回执 + digest 一致)→ APPLIED
    store.record(KEY, FILE, 'applied', { attempt: 2, sentDigest: DIGEST_A });
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('APPLIED');
  });
});

describe('acceptance 7: 按状态过滤只列出 DIRTY/SENT(改了还没重载)', () => {
  it('filesByState 只列 DIRTY/SENT,不含 CLEAN/APPLIED', async () => {
    const sm = makeState();
    const store = makeStore();
    const fileClean = '/ws/scripts/base/Avatar.py';
    const fileDirty = '/ws/scripts/base/Account.py';
    const fileSent = '/ws/scripts/base/Teleport.py';
    const fileApplied = '/ws/scripts/base/Bridge.py';
    sm.derive(store, KEY, fileClean, CONTENT_A); // 基线 → CLEAN
    sm.derive(store, KEY, fileDirty, CONTENT_A); // 基线 A
    sm.derive(store, KEY, fileDirty, CONTENT_B); // DIRTY
    store.record(KEY, fileSent, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 }); // SENT
    store.record(KEY, fileApplied, 'applied', { sentDigest: DIGEST_A }); // APPLIED
    const contentOf = async (file: string): Promise<string | undefined> => {
      if (file === fileDirty) return CONTENT_B;
      if (file === fileSent || file === fileApplied) return CONTENT_A;
      return CONTENT_A;
    };
    const views = await sm.filesByState(store, KEY, [...HOT_RELOAD_ATTENTION_STATES], contentOf);
    const files = views.map(v => v.file);
    expect(files).toContain(fileDirty);
    expect(files).toContain(fileSent);
    expect(files).not.toContain(fileClean);
    expect(files).not.toContain(fileApplied);
  });
});

describe('状态机派生视图:键同形(rootId×targetId×file),不另立身份', () => {
  it('同文件不同目标各自状态,不串', () => {
    const sm = makeState();
    const store = makeStore();
    const keyA: HotReloadTargetKey = { rootId: '/ws', targetId: 'cellapp#a' };
    const keyB: HotReloadTargetKey = { rootId: '/ws', targetId: 'cellapp#b' };
    store.record(keyA, FILE, 'applied', { sentDigest: DIGEST_A });
    store.record(keyB, FILE, 'failed', { detail: 'telnet 拒连' });
    expect(sm.derive(store, keyA, FILE, CONTENT_A).state).toBe('APPLIED');
    expect(sm.derive(store, keyB, FILE, CONTENT_A).state).toBe('FAILED');
  });

  it('同目标不同 rootId 也隔离', () => {
    const sm = makeState();
    const store = makeStore();
    const fileA = '/ws-a/scripts/base/Avatar.py';
    const fileB = '/ws-b/scripts/base/Avatar.py';
    store.record({ rootId: '/ws-a', targetId: 'baseapp' }, fileA, 'failed', { detail: '拒连' });
    expect(sm.derive(store, { rootId: '/ws-a', targetId: 'baseapp' }, fileA, CONTENT_A).state).toBe('FAILED');
    expect(sm.derive(store, { rootId: '/ws-b', targetId: 'baseapp' }, fileB, CONTENT_A).state).toBe('CLEAN');
  });
});

describe('展示辅助:严重度聚合与注意力集', () => {
  it('worstHotReloadState 按严重度取最重(干净最轻,需重启最重)', () => {
    expect(worstHotReloadState(['CLEAN', 'DIRTY', 'APPLIED'])).toBe('DIRTY');
    expect(worstHotReloadState(['SENT', 'FAILED', 'APPLIED'])).toBe('FAILED');
    expect(worstHotReloadState(['FAILED', 'RESTART_REQUIRED'])).toBe('RESTART_REQUIRED');
    expect(worstHotReloadState(['CLEAN'])).toBe('CLEAN');
  });

  it('HOT_RELOAD_ATTENTION_STATES = DIRTY ∪ SENT(改了还没重载)', () => {
    expect([...HOT_RELOAD_ATTENTION_STATES].sort()).toEqual(['DIRTY', 'SENT']);
  });
});
