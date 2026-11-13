import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import { HotReloadVersionTracker } from '../src/backend/hotReloadFileVersion';
import { HOT_RELOAD_TOGGLE_COMMAND } from '../src/hotReloadToggle';
import {
  HOT_RELOAD_SHOW_LOG_COMMAND,
  HotReloadStatusController,
  type HotReloadTimerDeps,
  type OutputChannelLike,
  type StatusBarItemLike
} from '../src/hotReloadStatus';

// 热更状态栏文件版本号(用户令 2026-11-09):五种既有状态与版本号正交组合,
// 不新增状态——单号=同步(`热更: 就绪 v3`),双号=待同步(`热更: … v2→v3`,
// 箭头左=基线/上次发送版本,右=盘上当前版本)。未跟踪/不在监视范围的文件
// 不显号;无活动文档回落最近变更文件;tooltip 列全部待同步版本对;开日志命令
// (kbengine.hotReload.showLog,开关提示的「打开日志」入口)进 OUTPUT 列版本台账;
// 状态栏点击本身=一键关/开(主干架构 HOT_RELOAD_TOGGLE_COMMAND),不承载台账。
// 补充约束:版本台账独立于 watcher——enabled=false 的
// 手动触发路径同样出号,且与 watcher 开启同口径(同一台账同一实现)。

const OFF_FACE = '$(eye-closed) 热更: 关';
const READY_FACE = '$(eye) 热更: 就绪';
const SENDING_FACE = '$(sync~spin) 热更: 发送中';
const SENT_FACE = '$(cloud-upload) 热更: 已发送(未确认)';
const FAILED_FACE = '$(error) 热更: 失败';

const A = '/ws/scripts/base/Account.py';
const B = '/ws/scripts/base/Goods.py';

const makeTimers = (): {
  timers: HotReloadTimerDeps;
  pending: () => number;
  tick: () => number;
} => {
  const handles = new Map<unknown, () => void>();
  let nextHandle = 0;
  return {
    pending: () => handles.size,
    tick: () => {
      const callbacks = [...handles.values()];
      handles.clear();
      for (const callback of callbacks) {
        callback();
      }
      return callbacks.length;
    },
    timers: {
      set: (callback): unknown => {
        const handle = nextHandle++;
        handles.set(handle, callback);
        return handle;
      },
      clear: (handle): void => {
        handles.delete(handle);
      }
    }
  };
};

const settle = (clock: { pending: () => number; tick: () => number }): void => {
  for (let guard = 0; guard < 8 && clock.pending() > 0; guard += 1) {
    clock.tick();
  }
};

/** 微任务排干:版本采样是异步 stat,渲染后的补渲染在微任务里收敛 */
const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

const sha = (text: string): string =>
  // 与 hotReloadFileState.sha256Hex 同源口径
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

interface Harness {
  clock: ReturnType<typeof makeTimers>;
  bar: StatusBarItemLike & { visible: boolean };
  lines: string[];
  showCalls: number[];
  controller: HotReloadStatusController;
  store: HotReloadTargetStateStore;
  tracker: HotReloadVersionTracker;
  tokens: Map<string, string>;
  contents: Map<string, string>;
  setActive(file: string | undefined): void;
  /** 跑开日志命令(状态栏开关提示的「打开日志」入口)= 列版本台账 */
  runShowLog(): void;
}

const makeHarness = (): Harness => {
  const clock = makeTimers();
  const store = new HotReloadTargetStateStore({ now: () => 1_000 });
  const tokens = new Map<string, string>();
  const contents = new Map<string, string>();
  let active: string | undefined;
  const tracker = new HotReloadVersionTracker({
    store,
    activeFile: () => active,
    isWatched: file => file.endsWith('.py'),
    now: () => 1_000,
    statToken: async file => tokens.get(file),
    readContent: async file => contents.get(file)
  });
  const bar: StatusBarItemLike & { visible: boolean } = {
    text: '',
    command: undefined,
    tooltip: '',
    visible: false,
    show(): void {
      this.visible = true;
    },
    hide(): void {
      this.visible = false;
    },
    dispose(): void {
      this.visible = false;
    }
  };
  const lines: string[] = [];
  const showCalls: number[] = [];
  const channel: OutputChannelLike = {
    appendLine: line => void lines.push(line),
    show: () => void showCalls.push(showCalls.length),
    dispose: (): void => undefined
  };
  const handlers = new Map<string, () => void>();
  const controller = new HotReloadStatusController({
    createStatusBarItem: () => bar,
    createOutputChannel: () => channel,
    registerCommand: (command, registered) => {
      handlers.set(command, registered);
      return { dispose: (): void => undefined };
    },
    timers: clock.timers,
    now: () => new Date(2026, 0, 1, 12, 0, 0).getTime(),
    versions: tracker
  });
  return {
    clock,
    bar,
    lines,
    showCalls,
    controller,
    store,
    tracker,
    tokens,
    contents,
    setActive: file => void (active = file),
    runShowLog: (): void => handlers.get(HOT_RELOAD_SHOW_LOG_COMMAND)?.()
  };
};

/**
 * 驱动一次状态变更并等版本采样收敛(渲染→采样→补渲染→节流尾沿)。末尾的
 * versionsChanged() 对应扩展装配里的接线点(watcher 采样/回执落账/手动触发
 * 建档都会走到它)——盘上变了但状态没翻时,靠它把徽标拉到最新。
 */
const drive = async (h: Harness, mutate?: () => void): Promise<void> => {
  mutate?.();
  h.controller.versionsChanged();
  await flush();
  settle(h.clock);
  await flush();
  settle(h.clock);
};

describe('热更状态栏版本徽标(五态正交,不新增状态)', () => {
  it('无版本上下文 → 五态原文案逐字不回归(watch-off 不显版本)', async () => {
    const h = makeHarness();
    await drive(h);
    expect(h.bar.text).toBe(OFF_FACE);
    expect(h.bar.text).not.toMatch(/\bv\d/);

    await drive(h, () => h.controller.setReady(['**/*.py'], 'derived', 500));
    expect(h.bar.text).toBe(READY_FACE);
    await drive(h, () => h.controller.setSending([A], 500));
    expect(h.bar.text).toBe(SENDING_FACE);
    await drive(h, () => h.controller.setSentUnverified());
    expect(h.bar.text).toBe(SENT_FACE);
    expect(h.bar.text).not.toMatch(/成功|Applied/i);
    await drive(h, () => h.controller.setFailed('boom'));
    expect(h.bar.text).toBe(FAILED_FACE);
    await drive(h, () => h.controller.setWatchOff());
    expect(h.bar.text).toBe(OFF_FACE);
  });

  it('已同步 = 单号;改动后 = 双号(基线→盘上);applied 追平回单号', async () => {
    const h = makeHarness();
    h.tokens.set(A, 'T0');
    await drive(h, () => void h.tracker.noteFile(A));
    h.setActive(A);
    await drive(h, () => h.controller.setReady(['**/*.py'], 'derived', 500));
    expect(h.bar.text).toBe(`${READY_FACE} v1`);

    h.tokens.set(A, 'T1');
    await drive(h);
    expect(h.bar.text).toBe(`${READY_FACE} v1→v2`);

    await drive(h, () => h.controller.setSentUnverified());
    expect(h.bar.text).toBe(`${SENT_FACE} v1→v2`);

    const disk = 'payload';
    h.contents.set(A, disk);
    h.store.record({ rootId: '/ws', targetId: 'baseapp' }, A, 'sent-unverified', {
      sentDigest: sha(disk),
      now: 10
    });
    h.store.record({ rootId: '/ws', targetId: 'baseapp' }, A, 'applied', { attempt: 1, now: 20 });
    await drive(h);
    expect(h.bar.text).toBe(`${SENT_FACE} v2`);
    expect(h.bar.tooltip).toContain('已同步');
  });

  it('watch-off + 手动触发建档(监视开关关)同样出号,与开监视同口径', async () => {
    const h = makeHarness();
    // enabled=false:没有任何 watcher 事件,手动发一次热更落台账
    h.tokens.set(A, 'T0');
    h.store.record({ rootId: '/ws', targetId: 'baseapp' }, A, 'sent-unverified', { now: 5 });
    await drive(h, () => h.controller.setWatchOff());
    expect(h.bar.text).toBe(`${OFF_FACE} v1`);

    h.tokens.set(A, 'T1');
    await drive(h);
    expect(h.bar.text).toBe(`${OFF_FACE} v1→v2`);
  });

  it('无活动文档 → 回落最近变更文件;活动文档已跟踪 → 显示活动文档', async () => {
    const h = makeHarness();
    h.tokens.set(A, 'T0');
    await drive(h, () => void h.tracker.noteFile(A));
    h.tokens.set(B, 'T0');
    await drive(h, () => void h.tracker.noteFile(B));
    h.tokens.set(A, 'T1');
    await drive(h, () => void h.tracker.noteFile(A)); // 最近变更=A

    h.setActive(undefined);
    await drive(h, () => h.controller.setReady(['**/*.py'], 'derived', 500));
    expect(h.bar.text).toBe(`${READY_FACE} v1→v2`);

    h.setActive(B);
    await drive(h);
    expect(h.bar.text).toBe(`${READY_FACE} v1`);
  });

  it('tooltip 列出全部待同步文件及其版本对', async () => {
    const h = makeHarness();
    h.tokens.set(A, 'T0');
    await drive(h, () => void h.tracker.noteFile(A));
    h.tokens.set(B, 'T0');
    await drive(h, () => void h.tracker.noteFile(B));
    h.tokens.set(A, 'T1');
    await drive(h, () => void h.tracker.noteFile(A));
    h.tokens.set(B, 'T1');
    await drive(h, () => void h.tracker.noteFile(B));
    h.setActive(A);
    await drive(h, () => h.controller.setReady(['**/*.py'], 'derived', 500));

    expect(h.bar.text).toBe(`${READY_FACE} v1→v2`);
    const tooltip = String(h.bar.tooltip);
    expect(tooltip).toContain(`当前文件 ${A}: v1→v2(待同步)`);
    expect(tooltip).toContain('待同步 2 个');
    expect(tooltip).toContain(`${A} v1→v2`);
    expect(tooltip).toContain(`${B} v1→v2`);
    expect(tooltip).toContain('热更新监视就绪'); // 既有状态 tooltip 保留
  });

  it('点击状态栏 → OUTPUT 列版本台账(当前文件/基线/盘上/每次跃迁与回执)', async () => {
    const h = makeHarness();
    h.tokens.set(A, 'T0');
    await drive(h, () => void h.tracker.noteFile(A));
    const digest = sha('payload');
    h.store.record({ rootId: '/ws', targetId: 'baseapp' }, A, 'sent-unverified', {
      sentDigest: digest,
      now: new Date(2026, 0, 1, 12, 0, 1).getTime()
    });
    h.tokens.set(A, 'T1');
    await drive(h, () => void h.tracker.noteFile(A));
    h.contents.set(A, 'payload');
    h.store.record({ rootId: '/ws', targetId: 'baseapp' }, A, 'applied', {
      attempt: 1,
      now: new Date(2026, 0, 1, 12, 0, 2).getTime()
    });
    await drive(h, () => h.controller.setReady(['**/*.py'], 'derived', 500));
    h.setActive(A);

    h.runShowLog();
    await flush();
    settle(h.clock);

    expect(h.showCalls).toHaveLength(1);
    const text = h.lines.join('\n');
    expect(text).toContain('版本台账');
    expect(text).toContain(A);
    expect(text).toContain('基线 v2');
    expect(text).toContain('盘上 v2');
    expect(text).toContain('12:00:01');
    expect(text).toContain(`digest=${digest.slice(0, 8)}`);
    expect(text).toContain('attempt=1');
    expect(text).toContain('outcome=applied');
    // 主干架构:状态栏点击=一键关/开(toggle),台账走开日志命令面
    expect(h.bar.command).toBe(HOT_RELOAD_TOGGLE_COMMAND);
  });

  it('节流与释放:版本补渲染走同一节流窗;dispose 后无迟到渲染', async () => {
    const h = makeHarness();
    h.tokens.set(A, 'T0');
    await drive(h, () => void h.tracker.noteFile(A));
    await drive(h, () => h.controller.setReady(['**/*.py'], 'derived', 500));
    expect(h.bar.text).toBe(`${READY_FACE} v1`);

    h.tokens.set(A, 'T1');
    h.controller.versionsChanged();
    h.controller.dispose();
    await flush();
    settle(h.clock);
    expect(h.bar.text).toBe(`${READY_FACE} v1`);
  });
});
