import { describe, expect, it } from 'vitest';
import { HotReloadTargetStateStore, type HotReloadTargetKey } from '../src/backend/hotReloadTargetState';
import { HotReloadHistoryCore, type HotReloadHistoryEntry } from '../src/backend/hotReloadHistoryCore';
import {
  deriveHotReloadFileState,
  deriveHotReloadHashSet,
  HotReloadFileStateMachine,
  sha256Hex,
  worstHotReloadState,
  HOT_RELOAD_ATTENTION_STATES
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

describe('HR-STATE-003: applied 来源纪律(可信回执|引擎查询一致),旧版已应用磁盘再改', () => {
  // makeState 无 engineAppliedDigestFor:生产面未接 /status 轮询(HR-AUDIT-010)时
  // 引擎查询来源不可用,状态机回落到仅可信回执来源(诚实不凭空 applied)。
  const makeEngineState = (engineDigestFor: (key: HotReloadTargetKey, file: string) => string | undefined) =>
    new HotReloadFileStateMachine({ now: () => 1000, timeoutWindowMs: 10_000, engineAppliedDigestFor: engineDigestFor });

  it('无可信 applied 回执(仅 sent-unverified)但引擎查询与所发 hash 一致 → APPLIED(引擎权威)', () => {
    const sm = makeEngineState(() => DIGEST_A);
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('APPLIED');
    expect(view.annotation).toContain('引擎状态查询');
    // HR-STATE-002 一致:引擎查询确认 applied 也是「已核实生效」,进核验 hash 列
    expect(view.hashSet.lastVerifiedAppliedHash).toBe(DIGEST_A);
  });

  it('引擎查询一致后磁盘再改 → DIRTY(旧版已应用且磁盘又修改)', () => {
    const sm = makeEngineState(() => DIGEST_A);
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('APPLIED');
    expect(sm.derive(store, KEY, FILE, CONTENT_B).state).toBe('DIRTY');
  });

  it('引擎查询与所发 hash 不符 → 不冒充 applied(回落到超时未确认 FAILED)', () => {
    const sm = makeEngineState(() => DIGEST_B);
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).not.toBe('APPLIED');
    expect(view.hashSet.lastVerifiedAppliedHash).toBeUndefined();
  });

  it('引擎查询未提供(生产面默认)→ 无 applied,回落到 SENT(不凭空 applied)', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('SENT');
    expect(view.hashSet.lastVerifiedAppliedHash).toBeUndefined();
  });

  it('可信 applied 回执 + 引擎查询不一致 → 仍 APPLIED(来源并集非否决,如实注解)', () => {
    const sm = makeEngineState(() => DIGEST_B);
    const store = makeStore();
    store.record(KEY, FILE, 'applied', { sentDigest: DIGEST_A, detail: '回执 applied 且 digest 一致:已应用' });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('APPLIED');
    expect(view.annotation).toContain('以回执 applied 为准');
  });

  it('纯函数:引擎查询一致直接置 applied(仅 accepted 记录也确认),hashSet 核验列入账', () => {
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    store.record(KEY, FILE, 'accepted', {
      attempt: 1,
      sentDigest: DIGEST_A,
      detail: '回执 accepted:file 回显一致(应用仍需 HOT-004 核验)'
    });
    const view = deriveHotReloadFileState({
      record: store.get(KEY, FILE),
      file: FILE,
      currentDigest: DIGEST_A,
      baselineDigest: DIGEST_A,
      restartRequired: false,
      settle: 'pending',
      engineAppliedDigest: DIGEST_A
    });
    expect(view.state).toBe('APPLIED');
    expect(view.hashSet.lastVerifiedAppliedHash).toBe(DIGEST_A);
    expect(view.annotation).toContain('引擎状态查询');
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

describe('HR-STATE-004: 分区=(workspaceId,rootId,targetId,uri),切换目标不复用旧绿色', () => {
  // workspaceId 维度=工作区实例隔离:台账/基线册都是纯内存件,每窗口独立
  // 扩展宿主各持一份(store 实例即隔离边界,无跨窗口共享持久层);uri 维度=
  // 键内 file 即 uri 的 fsPath 绝对路径。状态机键(rootId×targetId×file)
  // 三维齐备,以下钉死「切换目标后不冒充旧绿色」的面。
  const KEY_B: HotReloadTargetKey = { rootId: '/ws', targetId: 'baseapp#b' };

  it('A 已 applied,切到无记录的 B(内容与 A 所发相同)→ B CLEAN,不复用 A 的绿', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'applied', { sentDigest: DIGEST_A });
    // 内容与 A 所发逐字相同——若基线册跨目标泄漏,B 会冒充 APPLIED
    const viewB = sm.derive(store, KEY_B, FILE, CONTENT_A);
    expect(viewB.state).toBe('CLEAN');
    expect(viewB.baselineDigest).toBe(DIGEST_A); // B 自己的首见基线,不是 A 的 applied 基线冒充
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('APPLIED'); // A 侧原样绿
  });

  it('切换目标后再编辑:B 以自己的基线判脏,不继承 A 的 applied 事实', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'applied', { sentDigest: DIGEST_A });
    sm.derive(store, KEY_B, FILE, CONTENT_A); // B 首见注册基线=当前内容(=A 所发内容)
    // 编辑发生在切换到 B 之后:B=DIRTY(改了自己首见基线),A=DIRTY(applied 后内容再偏)
    expect(sm.derive(store, KEY_B, FILE, CONTENT_B).state).toBe('DIRTY');
    expect(sm.derive(store, KEY, FILE, CONTENT_B).state).toBe('DIRTY');
    // 改回:B 回 CLEAN(回到自己基线),A 仍 DIRTY(偏离的是 A 的 applied 基线)
    expect(sm.derive(store, KEY_B, FILE, CONTENT_A).state).toBe('CLEAN');
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('APPLIED');
  });

  it('工作区实例隔离(同 rootId×targetId×file 两窗口):窗口二看不见窗口一的绿', () => {
    const storeOne = makeStore();
    const smOne = makeState();
    const storeTwo = makeStore(); // 窗口二自己的台账(同键同内容,独立实例)
    const smTwo = makeState();
    storeOne.record(KEY, FILE, 'applied', { sentDigest: DIGEST_A });
    expect(smOne.derive(storeOne, KEY, FILE, CONTENT_A).state).toBe('APPLIED');
    expect(smTwo.derive(storeTwo, KEY, FILE, CONTENT_A).state).toBe('CLEAN');
  });
});

describe('HR-STATE-005: 文件不可读(已删除/移走/改名)=ghost,tombstone 清理;旧 UI 不假显示成功', () => {
  // 内容读不到(undefined)=文件不在(与 HR-WATCH-003/007「读不到=已删除」同
  // 判据)。派生视图不冒充存活态——APPLIED/SENT/FAILED/RESTART_REQUIRED 都
  // 意味着一个存在的文件,ghost 如实 CLEAN+注解;hashSet/台账保留(交付史
  // 是事实源,不因文件消失抹史)。

  it('applied 记录 + ghost → CLEAN 非 APPLIED(不假显示成功),交付史保留', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'applied', { sentDigest: DIGEST_A });
    const view = sm.derive(store, KEY, FILE, undefined);
    expect(view.state).toBe('CLEAN');
    expect(view.annotation).toContain('已删除/移走');
    // 交付史是事实:台账记录保留,核验 hash 仍在(HR-STATE-002 各司其职)
    expect(store.get(KEY, FILE)?.outcome).toBe('applied');
    expect(view.hashSet.lastVerifiedAppliedHash).toBe(DIGEST_A);
  });

  it('sent-unverified 记录 + ghost → CLEAN 非 SENT(不假显示在途)', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A });
    expect(sm.derive(store, KEY, FILE, undefined).state).toBe('CLEAN');
  });

  it('failed 记录 + ghost → CLEAN 非 FAILED(不假显示失败文件)', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'failed', { sentDigest: DIGEST_A, detail: '连接被拒' });
    expect(sm.derive(store, KEY, FILE, undefined).state).toBe('CLEAN');
  });

  it('RESTART_REQUIRED + ghost → CLEAN 非需重启,闸拦下标记随之清除(重生成不继承旧闸)', () => {
    const sm = makeState();
    const store = makeStore();
    sm.markRestartRequired(KEY, [FILE], ['结构性 def 变更']);
    expect(sm.derive(store, KEY, FILE, undefined).state).toBe('CLEAN');
    expect(sm.restartRequiredFiles(KEY)).toEqual([]); // tombstone:旧闸已清
    // 重生成健康文件(同内容)→ 不继承旧 RESTART_REQUIRED,首见基线回 CLEAN
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('CLEAN');
  });

  it('baseline-only(无记录)ghost → CLEAN;重生成与旧基线比较判得准(同回 CLEAN/异回 DIRTY)', () => {
    const sm = makeState();
    const store = makeStore();
    sm.derive(store, KEY, FILE, CONTENT_A); // 首见注册基线 A
    expect(sm.derive(store, KEY, FILE, undefined).state).toBe('CLEAN');
    // 重生成同内容=回基线 CLEAN;异内容=偏离基线 DIRTY(旧基线保留判得准)
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('CLEAN');
    expect(sm.derive(store, KEY, FILE, CONTENT_B).state).toBe('DIRTY');
  });

  it('注意力集过滤不含 ghost:applied+ghost 的文件不进「改了还没重载」', async () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'applied', { sentDigest: DIGEST_A });
    const views = await sm.filesByState(store, KEY, HOT_RELOAD_ATTENTION_STATES, () => undefined);
    expect(views).toEqual([]);
  });

  it('纯函数口径:记录在 + currentDigest undefined → CLEAN+注解,不冒充存活态', () => {
    const view = deriveHotReloadFileState({
      record: { rootId: KEY.rootId, targetId: KEY.targetId, file: FILE, outcome: 'applied', attempt: 1, recordedAt: 1000, sentDigest: DIGEST_A },
      file: FILE,
      currentDigest: undefined,
      baselineDigest: DIGEST_A,
      restartRequired: false,
      settle: 'applied'
    });
    expect(view.state).toBe('CLEAN');
    expect(view.annotation).toContain('已删除/移走');
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

describe('回执超时后内容再改 → DIRTY(新一次编辑,可再发)', () => {
  it('超时未确认且内容偏离所发 digest → DIRTY,不带失败原因', () => {
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    // 状态机时钟越过核验窗口(sentAt=1000 + 窗口 10s < now=20s)→ 超时结算;
    // 内容已是 B(≠ 所发 A):保持未确认语义里内容再改 = 新一次编辑回落 DIRTY
    const view = makeState(20_000, 10_000).derive(store, KEY, FILE, CONTENT_B);
    expect(view.state).toBe('DIRTY');
    expect(view.reason).toBeUndefined();
    expect(view.detail).toBeUndefined();
  });
});

describe('knownKeys 并集:被拦集与多目标键排序', () => {
  it('被拦集的键进 knownKeys(台账空也有键),多目标按 rootId::targetId 排序', () => {
    const sm = makeState();
    const keyB: HotReloadTargetKey = { rootId: '/ws2', targetId: 'cellapp#b' };
    sm.markRestartRequired(KEY, [FILE], ['结构性 def 变更']);
    sm.markRestartRequired(keyB, ['/ws2/scripts/cell/Mob.py'], ['结构性 def 变更']);
    const keys = sm.knownKeys(makeStore());
    expect(keys).toHaveLength(2);
    expect(`${keys[0].rootId}::${keys[0].targetId}`).toBe('/ws::cellapp#a');
    expect(`${keys[1].rootId}::${keys[1].targetId}`).toBe('/ws2::cellapp#b');
  });
});

describe('filesByState 候选:被拦文件不靠台账记录也能筛出', () => {
  it('被拦文件进候选且筛出 RESTART_REQUIRED 视图', async () => {
    const sm = makeState();
    const store = makeStore();
    sm.markRestartRequired(KEY, [FILE], ['拦下原因A']);
    // 文件存在可读(非 ghost)——HR-STATE-005:不可读=ghost 回 CLEAN,闸拦下
    // 只对存在文件生效;这里给可读内容验证被拦文件按 RESTART_REQUIRED 筛出
    const views = await sm.filesByState(store, KEY, ['RESTART_REQUIRED'], () => CONTENT_A);
    expect(views.map(view => view.file)).toEqual([FILE]);
    expect(views[0].state).toBe('RESTART_REQUIRED');
    // 实跑对账:RESTART_REQUIRED 视图的 reason 是派生面固定文案,写入的
    // 拦截原因明细留在 restartRequiredFiles/restartReasons 侧,不透传到视图
    expect(views[0].reason).toContain('结构性 def 变更');
  });
});

// 逐行不可达论证(诚实边界,不写凑数测试):
// - splitKeyId 的两个 null 守卫(`first < 0` / `second < 0`):splitKeyId 仅被
//   knownKeys 调用,入参只有 baselines / restartReasons 两张私有表的键;两表
//   只经 keyOf 写入,keyOf = buildHotReloadTargetKeyId(key)(rootId::targetId,
//   恒含一个 '::')+ '::' + file,任意键恒含 ≥2 个分隔符,两个 indexOf 恒 ≥0,
//   从公共入口(knownKeys/filesByState/derive)不可达,属防御性分支。

describe('HR-STATE-002 四 hash 区分:各司其职,不混用', () => {
  it('发出≠接受:sent-unverified 只有 lastRequestedHash,接受/核验如实 undefined', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.hashSet.lastRequestedHash).toBe(DIGEST_A);
    expect(view.hashSet.lastAcceptedHash).toBeUndefined();
    expect(view.hashSet.lastVerifiedAppliedHash).toBeUndefined();
    expect(view.hashSet.currentDiskHash).toBe(DIGEST_A);
  });

  it('accepted 回执 → lastAcceptedHash = 所发冻结基准(服务端确认取走该内容)', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    store.record(KEY, FILE, 'accepted', { attempt: 1, sentDigest: DIGEST_A });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.hashSet.lastAcceptedHash).toBe(DIGEST_A);
    // accepted ≠ 已核实生效:核验 hash 仍 undefined(仍等 applied 双证)
    expect(view.hashSet.lastVerifiedAppliedHash).toBeUndefined();
  });

  it('applied 双证通过 → lastVerifiedAppliedHash 赋值(applied 隐含 accepted)', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'applied', { sentDigest: DIGEST_A });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.hashSet.lastRequestedHash).toBe(DIGEST_A);
    expect(view.hashSet.lastAcceptedHash).toBe(DIGEST_A);
    expect(view.hashSet.lastVerifiedAppliedHash).toBe(DIGEST_A);
  });

  it('发送后磁盘再变:currentDiskHash ≠ lastRequestedHash,两值并陈不混用', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'applied', { sentDigest: DIGEST_A });
    // 发送后磁盘改成 B:所发基准仍是 A(冻结),磁盘如实 B——回执核验只认 A
    const view = sm.derive(store, KEY, FILE, CONTENT_B);
    expect(view.hashSet.lastRequestedHash).toBe(DIGEST_A);
    expect(view.hashSet.lastVerifiedAppliedHash).toBe(DIGEST_A);
    expect(view.hashSet.currentDiskHash).toBe(DIGEST_B);
  });

  it('回执超时未确认:lastRequestedHash 在,接受/核验如实 undefined(不冒充)', () => {
    // 窗口 = 1000 + 10000 = 11000;now=20000 已过 → 超时结算
    const sm = makeState(20000);
    const store = makeStore(1000);
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.hashSet.lastRequestedHash).toBe(DIGEST_A);
    expect(view.hashSet.lastAcceptedHash).toBeUndefined();
    expect(view.hashSet.lastVerifiedAppliedHash).toBeUndefined();
  });

  it('会话基线首见 hash 不冒充核验 hash:从未发送的文件只有 currentDiskHash', () => {
    const sm = makeState();
    const view = sm.derive(makeStore(), KEY, FILE, CONTENT_A);
    // 首见注册了会话基线(baselineDigest 在),但从未 applied → 核验 hash 如实 undefined
    expect(view.baselineDigest).toBe(DIGEST_A);
    expect(view.hashSet.lastVerifiedAppliedHash).toBeUndefined();
    expect(view.hashSet.lastRequestedHash).toBeUndefined();
    expect(view.hashSet.lastAcceptedHash).toBeUndefined();
    expect(view.hashSet.currentDiskHash).toBe(DIGEST_A);
  });

  it('内容不可读:currentDiskHash 如实缺,其余按各自事实源照常', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'accepted', { sentDigest: DIGEST_A });
    const view = sm.derive(store, KEY, FILE, undefined);
    expect(view.hashSet.currentDiskHash).toBeUndefined();
    expect(view.hashSet.lastRequestedHash).toBe(DIGEST_A);
    expect(view.hashSet.lastAcceptedHash).toBe(DIGEST_A);
  });

  it('deriveHotReloadHashSet 纯投影:四字段只从各自事实源来(空记录=仅磁盘)', () => {
    const only = deriveHotReloadHashSet({ record: undefined, currentDigest: DIGEST_B, verifiedApplied: false });
    expect(only).toEqual({ currentDiskHash: DIGEST_B });
    const none = deriveHotReloadHashSet({ record: undefined, currentDigest: undefined, verifiedApplied: false });
    expect(none).toEqual({});
  });
});

// HR-STATE-009 历史快照与当前文件状态分离:唯一持久化面是历史日志
// (HotReloadHistoryCore 条目经 workspaceState 回载),台账/会话基线册/状态机
// 皆纯内存、每会话新实例。故重启后「当前文件状态」不从上一会话的 applied
// 继承——除非可复核运行时 revision(HR-STATE-003 engineAppliedDigestFor 缝,
// 且须有本会话台账记录作对账基准)。本 describe 钉两面分离与不自动信任。
describe('HR-STATE-009 历史快照与当前文件状态分离:重启不自动信任上一会话 applied', () => {
  /** 会话 A 的 applied 事实(会话内口径,acceptance 2 已钉),重启后被持久化的只是日志行 */
  const PRIOR_APPLIED_ROW: HotReloadHistoryEntry = {
    requestId: `${KEY.rootId}::${KEY.targetId}/${FILE}#1`,
    fullModule: 'base.Avatar',
    requestModule: 'Avatar',
    fileUri: FILE,
    targetId: KEY.targetId,
    time: 1000,
    status: 'applied'
  };

  it('会话内 applied 可信(前提钉):台账 applied 记录 + 内容一致 → APPLIED', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    store.record(KEY, FILE, 'applied', { attempt: 1, sentDigest: DIGEST_A });
    expect(sm.derive(store, KEY, FILE, CONTENT_A).state).toBe('APPLIED');
  });

  it('重启(新台账+新状态机)→ 同内容首见回 CLEAN,不自动相信上一会话 applied', () => {
    // 会话 A 走到 applied(前提钉),随后进程重启
    const smA = makeState();
    const storeA = makeStore();
    storeA.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    storeA.record(KEY, FILE, 'applied', { attempt: 1, sentDigest: DIGEST_A });
    expect(smA.derive(storeA, KEY, FILE, CONTENT_A).state).toBe('APPLIED');
    // —— 重启 ——台账是事实源但纯内存(无共享持久层,HR-STATE-004);状态机的
    // 会话基线册同为内存。两者都新实例,上一会话的 applied 无凭据可继承。
    const smB = makeState(30_000);
    const storeB = makeStore(30_000);
    const view = smB.derive(storeB, KEY, FILE, CONTENT_A);
    // 内容仍是所发内容也不回 APPLIED:本会话从未核验,首见注册回 CLEAN
    expect(view.state).toBe('CLEAN');
    expect(view.hashSet.lastVerifiedAppliedHash).toBeUndefined();
    expect(view.updatedAt).toBeUndefined(); // 无本会话台账证据,不透传时刻
  });

  it('重启后离线改过的文件同样不冒充 applied/脏:首见基线按当前内容注册', () => {
    // 重启期间磁盘已改成 B(≠ 上一会话所发 A)
    const view = makeState(30_000).derive(makeStore(30_000), KEY, FILE, CONTENT_B);
    // 不信任旧 applied 故不拿旧基线判脏:本会话首见=当前内容即基线,回 CLEAN
    expect(view.state).toBe('CLEAN');
    expect(view.baselineDigest).toBe(DIGEST_B);
    expect(view.hashSet.lastRequestedHash).toBeUndefined();
  });

  it('复核缝无本会话台账记录也无法复活 applied:applied 须本会话证据承接', () => {
    // 引擎复核缝(HR-STATE-003 第二来源,生产未接)声称运行时时仍是旧 applied 内容
    const sm = new HotReloadFileStateMachine({
      now: () => 30_000,
      timeoutWindowMs: 10_000,
      engineAppliedDigestFor: () => DIGEST_A
    });
    const view = sm.derive(makeStore(30_000), KEY, FILE, CONTENT_A);
    // 引擎 digest 需与 record.sentDigest 对账才算复核;重启后台账空,无基准可核,
    // 不凭空 applied(与超时不冒充 applied 同一诚实纪律)→ 首见基线回 CLEAN
    expect(view.state).toBe('CLEAN');
    expect(view.hashSet.lastVerifiedAppliedHash).toBeUndefined();
  });

  it('两面分离:日志保留 applied 行(交付史是事实),当前态不消费日志各自派生', () => {
    // 会话 A 把 applied 事实落进历史日志(与生产 translateDeliveryRecord 同形)
    const sessionA = new HotReloadHistoryCore();
    sessionA.record(PRIOR_APPLIED_ROW);
    // 重启:视图启动回载(HR-MOD-014)只回填日志核;当前态=新台账+新状态机
    const reloaded = new HotReloadHistoryCore();
    reloaded.record(PRIOR_APPLIED_ROW);
    const view = makeState(30_000).derive(makeStore(30_000), KEY, FILE, CONTENT_A);
    // 交付史不抹(日志行仍是 applied),当前态各判各的(derive 不读日志核)
    expect(reloaded.newestFirst()[0]?.status).toBe('applied');
    expect(view.state).toBe('CLEAN');
    expect(view.state).not.toBe('APPLIED');
  });
});

// HR-STATE-010 错误原因可操作:FAILED/RESTART_REQUIRED 的 reason 过七类
// 分类(已知加 [标签] 前缀+原文保留,未知原样透传);装饰/镜头经 view.reason
// 自动继承分类面。
describe('HR-STATE-010 错误原因可操作:reason 过七类分类', () => {
  it('FAILED reason 加 [目标不可达] 标签,原文(原始原因)保留', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(
      KEY,
      FILE,
      'failed',
      { sentDigest: DIGEST_A, detail: '端点不可达:检查地址/端口与目标服务是否在监听(原始:ECONNREFUSED)' }
    );
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('FAILED');
    expect(view.reason).toContain('[目标不可达]');
    expect(view.reason).toContain('原始:ECONNREFUSED'); // 定性不吞原文
  });

  it('FAILED reason 不可辨(bare detail)原样透传,不猜类别', () => {
    const sm = makeState();
    const store = makeStore();
    store.record(KEY, FILE, 'failed', { sentDigest: DIGEST_A, detail: 'HTTP 500' });
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.reason).toBe('HTTP 500');
  });

  it('RESTART_REQUIRED reason 加 [需重启] 标签(消息已内嵌动作不叠建议)', () => {
    const sm = makeState();
    const store = makeStore();
    sm.markRestartRequired(KEY, [FILE], ['def 结构变更']);
    const view = sm.derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('RESTART_REQUIRED');
    expect(view.reason).toContain('[需重启]');
    expect(view.reason).toContain('需重启进程后再应用'); // 内嵌动作保留
    expect(view.reason).not.toContain('建议:'); // 已内嵌,不叠
  });

  it('超时未确认 reason 保持原语义(不强行归类,如实透传)', () => {
    const store = makeStore();
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    const view = makeState(20_000, 10_000).derive(store, KEY, FILE, CONTENT_A);
    expect(view.state).toBe('FAILED');
    expect(view.reason).toContain('超时');
    expect(view.reason).not.toContain('['); // 超时语义不冒充七类之一
  });
});
