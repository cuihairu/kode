import { createHash } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';
import {
  HotReloadVersionTracker,
  matchesHotReloadGlob,
  type HotReloadVersionBadgeView
} from '../src/hotReloadFileVersion';
import { formatHotReloadTime } from '../src/hotReloadStatus';

// 热更状态栏文件版本号(用户令 2026-11-09):版本=每文件单调递增整数
// (v1, v2, …),不暴露 mtime:size 原始 token。规则:首次跟踪记 v1;盘上
// version token 变 +1;回执 applied 且 digest 与当前盘上一致时基线追平
// (基线=当前版本)。基线存台账(HotReloadTargetState 同生命周期,不新开
// 存储)。红先行:单调递增/applied 追平单号/改动后双号/版本不倒退/无活动
// 文档回落最近变更/tooltip 多文件/watch-off 无上下文不显版本/五态文案不回归。

const FILE = '/ws/scripts/base/Account.py';
const KEY = { rootId: '/ws', targetId: 'baseapp' };
const sha = (text: string): string =>
  // 与 hotReloadFileState.sha256Hex 同源口径(UTF-8 sha256 hex)
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

interface Harness {
  store: HotReloadTargetStateStore;
  tracker: HotReloadVersionTracker;
  tokens: Map<string, string>;
  contents: Map<string, string>;
  setActive(file: string | undefined): void;
  setScope(file: string, watched: boolean): void;
}

const makeHarness = (extra: { now?: () => number } = {}): Harness => {
  const store = new HotReloadTargetStateStore({ now: extra.now ?? (() => 1_000) });
  const tokens = new Map<string, string>();
  const contents = new Map<string, string>();
  const scope = new Map<string, boolean>();
  let active: string | undefined;
  const tracker = new HotReloadVersionTracker({
    store,
    activeFile: () => active,
    isWatched: file => scope.get(file) ?? file.endsWith('.py'),
    now: extra.now ?? (() => 1_000),
    statToken: async file => tokens.get(file),
    readContent: async file => contents.get(file)
  });
  return {
    store,
    tracker,
    tokens,
    contents,
    setActive: file => {
      active = file;
    },
    setScope: (file, watched) => scope.set(file, watched)
  };
};

const suffix = (view: HotReloadVersionBadgeView | undefined): string | undefined =>
  view === undefined ? undefined : view.baseline === view.current ? `v${view.current}` : `v${view.baseline}→v${view.current}`;

describe('文件版本簿(台账内,随 HotReloadTargetState 同生命周期)', () => {
  it('首次跟踪记 v1;同 token 不涨;token 变 +1,版本单调递增', () => {
    const store = new HotReloadTargetStateStore({ now: () => 0 });
    expect(store.fileVersion(FILE)).toBeUndefined();

    const first = store.noteFileVersion(FILE, '100:10', 10);
    expect(first?.change).toBe('tracked');
    expect(first?.state.version).toBe(1);
    expect(first?.state.baseline).toBe(1);
    expect(first?.state.token).toBe('100:10');

    expect(store.noteFileVersion(FILE, '100:10', 20)?.change).toBe('unchanged');
    expect(store.fileVersion(FILE)?.version).toBe(1);

    expect(store.noteFileVersion(FILE, '200:20', 30)?.change).toBe('bump');
    expect(store.fileVersion(FILE)?.version).toBe(2);
    expect(store.noteFileVersion(FILE, '300:30', 40)?.change).toBe('bump');
    expect(store.fileVersion(FILE)?.version).toBe(3);
  });

  it('回退(内容改回旧 token)版本继续 +1,绝不倒退', () => {
    const store = new HotReloadTargetStateStore({ now: () => 0 });
    store.noteFileVersion(FILE, '100:10', 1);
    store.noteFileVersion(FILE, '200:20', 2);
    const reverted = store.noteFileVersion(FILE, '100:10', 3);
    expect(reverted?.change).toBe('bump');
    expect(store.fileVersion(FILE)?.version).toBe(3);
    expect(store.fileVersion(FILE)?.baseline).toBeLessThanOrEqual(3);
  });

  it('无记录且盘上版本不可得(stat 失败)→ 不建档', () => {
    const store = new HotReloadTargetStateStore({ now: () => 0 });
    expect(store.noteFileVersion('/ws/missing.py', undefined, 5)).toBeUndefined();
    expect(store.fileVersion('/ws/missing.py')).toBeUndefined();
  });

  it('记录先行(手动发送建档 v1、token 未知)→ 首次 stat 采 token 不跳号', () => {
    const store = new HotReloadTargetStateStore({ now: () => 0 });
    store.record(KEY, FILE, 'sent-unverified', { now: 1 });
    expect(store.fileVersion(FILE)?.version).toBe(1);
    const adopted = store.noteFileVersion(FILE, '100:10', 2);
    expect(adopted?.change).toBe('adopted');
    expect(store.fileVersion(FILE)?.version).toBe(1);
  });

  it('基线:初始=版本;advance 追平;绝不倒退、绝不超当前版本', () => {
    const store = new HotReloadTargetStateStore({ now: () => 0 });
    store.noteFileVersion(FILE, '100:10', 1);
    store.noteFileVersion(FILE, '200:20', 2);
    expect(store.fileVersion(FILE)).toMatchObject({ version: 2, baseline: 1 });

    expect(store.advanceFileVersionBaseline(FILE, 3)).toBe(true);
    expect(store.fileVersion(FILE)).toMatchObject({ version: 2, baseline: 2 });
    // 已追平再 advance 幂等,不产生新事件
    expect(store.advanceFileVersionBaseline(FILE, 4)).toBe(false);

    store.noteFileVersion(FILE, '300:30', 5);
    expect(store.fileVersion(FILE)).toMatchObject({ version: 3, baseline: 2 });
    expect(store.fileVersion(FILE)!.baseline).toBeLessThanOrEqual(store.fileVersion(FILE)!.version);
  });

  it('投递事件进版本史:新发送/回执带 attempt、digest 前 8、outcome;同代同态只补字段不重复', () => {
    const store = new HotReloadTargetStateStore({ now: () => 0 });
    const digest = sha('hello');
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: digest, now: 10 });
    store.record(KEY, FILE, 'applied', { attempt: 1, now: 20 });
    store.record(KEY, FILE, 'applied', { attempt: 1, sentDigest: digest, now: 30 });

    const events = store.fileVersion(FILE)!.events;
    const deliveries = events.filter(event => event.kind === 'delivery');
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({
      stage: 'send',
      outcome: 'sent-unverified',
      attempt: 1,
      digest8: digest.slice(0, 8),
      targetId: 'baseapp'
    });
    expect(deliveries[1]).toMatchObject({ stage: 'receipt', outcome: 'applied', attempt: 1 });
    expect(events[0]).toMatchObject({ kind: 'tracked', version: 1 });
    expect(formatHotReloadTime(new Date(2026, 0, 1, 12, 0, 5).getTime())).toBe('12:00:05');
  });
});

describe('matchesHotReloadGlob(监视范围判定,与 enabled 开关无关)', () => {
  it('默认 **/*.py 全深度命中,非 .py 不命中', () => {
    expect(matchesHotReloadGlob('scripts/base/Account.py', ['**/*.py'])).toBe(true);
    expect(matchesHotReloadGlob('Account.py', ['**/*.py'])).toBe(true);
    expect(matchesHotReloadGlob('scripts/base/Account.pyc', ['**/*.py'])).toBe(false);
  });

  it('带路径模式按相对路径锚定;无斜杠模式任意深度;支持 {a,b} 花括号', () => {
    expect(matchesHotReloadGlob('src/x.py', ['src/**/*.py'])).toBe(true);
    expect(matchesHotReloadGlob('other/x.py', ['src/**/*.py'])).toBe(false);
    expect(matchesHotReloadGlob('deep/x.py', ['*.py'])).toBe(true);
    expect(matchesHotReloadGlob('scripts/base/Account.def', ['**/*.{py,def}'])).toBe(true);
    expect(matchesHotReloadGlob('scripts/base/Account.md', ['**/*.{py,def}'])).toBe(false);
  });
});

describe('HotReloadVersionTracker(盘上版本采样与徽标)', () => {
  it('noteFile:首次采样建 v1;盘上变 → v2;同 token 不变;changed 如实回报', async () => {
    const h = makeHarness();
    h.tokens.set(FILE, 'T0');
    expect(await h.tracker.noteFile(FILE)).toBe(true);
    expect(h.store.fileVersion(FILE)).toMatchObject({ version: 1, baseline: 1 });

    expect(await h.tracker.noteFile(FILE)).toBe(false); // 同 token 不重复计数
    h.tokens.set(FILE, 'T1');
    expect(await h.tracker.noteFile(FILE)).toBe(true);
    expect(h.store.fileVersion(FILE)?.version).toBe(2);
  });

  it('refresh:stat 全部已跟踪文件,盘上变则 +1;返回是否发生变化', async () => {
    const h = makeHarness();
    h.tokens.set(FILE, 'T0');
    await h.tracker.noteFile(FILE);
    expect(await h.tracker.refresh()).toBe(false);
    h.tokens.set(FILE, 'T1');
    expect(await h.tracker.refresh()).toBe(true);
    expect(h.store.fileVersion(FILE)?.version).toBe(2);
  });

  it('badge:活动文档已跟踪且在监视范围 → 显示活动文档版本', async () => {
    const h = makeHarness();
    h.tokens.set(FILE, 'T0');
    await h.tracker.noteFile(FILE);
    h.setActive(FILE);
    expect(suffix(h.tracker.badge())).toBe('v1');
    h.tokens.set(FILE, 'T1');
    await h.tracker.refresh();
    expect(suffix(h.tracker.badge())).toBe('v1→v2');
  });

  it('badge:活动文档不在监视范围/未跟踪 → 回落最近变更文件;全无 → undefined', async () => {
    const h = makeHarness();
    h.setActive('/ws/README.md');
    expect(h.tracker.badge()).toBeUndefined();

    h.tokens.set(FILE, 'T0');
    await h.tracker.noteFile(FILE);
    h.tokens.set('/ws/other.py', 'T0');
    await h.tracker.noteFile('/ws/other.py');
    h.tokens.set(FILE, 'T1');
    await h.tracker.noteFile(FILE); // 最近变更=FILE

    h.setActive('/ws/README.md'); // 不在监视范围 → 回落最近变更
    expect(h.tracker.badge()?.file).toBe(FILE);
    expect(suffix(h.tracker.badge())).toBe('v1→v2');

    h.setActive('/ws/other.py'); // 未跟踪的活动文档 → 同样回落
    h.setScope('/ws/other.py', false);
    expect(h.tracker.badge()?.file).toBe(FILE);
  });

  it('badge:活动文档不在监视范围且无任何已跟踪文件 → undefined(不虚构版本)', async () => {
    const h = makeHarness();
    h.setActive('/ws/notes.txt');
    expect(h.tracker.badge()).toBeUndefined();
    expect(h.tracker.pending()).toEqual([]);
    expect(h.tracker.report()).toEqual([]);
  });

  it('pending:基线≠盘上当前才列;applied 追平后不再列', async () => {
    const h = makeHarness();
    h.tokens.set(FILE, 'T0');
    await h.tracker.noteFile(FILE);
    expect(h.tracker.pending()).toEqual([]);

    h.tokens.set(FILE, 'T1');
    await h.tracker.noteFile(FILE);
    expect(suffix(h.tracker.pending()[0])).toBe('v1→v2');

    h.store.record(KEY, FILE, 'sent-unverified', { now: 4 });
    h.store.record(KEY, FILE, 'applied', { attempt: 1, sentDigest: sha('x'), now: 5 });
    h.contents.set(FILE, 'x'); // 盘上内容与所发一致 → 基线追平
    await h.tracker.refresh();
    expect(h.tracker.pending()).toEqual([]);
    expect(suffix(h.tracker.badge())).toBe('v2');
  });

  it('applied 回执且 digest 与当前盘上一致 → 基线追平(单号);不一致 → 不追平(双号)', async () => {
    const h = makeHarness();
    h.tokens.set(FILE, 'T0');
    await h.tracker.noteFile(FILE);
    h.tokens.set(FILE, 'T1');
    await h.tracker.noteFile(FILE); // v2,基线 1 → 双号
    expect(suffix(h.tracker.badge())).toBe('v1→v2');

    const disk = 'current content';
    h.contents.set(FILE, disk);
    h.store.record(KEY, FILE, 'sent-unverified', { sentDigest: sha(disk), now: 6 });
    h.store.record(KEY, FILE, 'applied', { attempt: 1, now: 7 });

    expect(await h.tracker.refresh()).toBe(true);
    expect(h.store.fileVersion(FILE)).toMatchObject({ version: 2, baseline: 2 });
    expect(suffix(h.tracker.badge())).toBe('v2');

    // 盘上再变(晚到 applied 不追平新内容):digest 与盘上不符 → 保持双号
    h.tokens.set(FILE, 'T2');
    h.contents.set(FILE, 'newer content');
    await h.tracker.refresh();
    expect(h.store.fileVersion(FILE)).toMatchObject({ version: 3, baseline: 2 });
    expect(suffix(h.tracker.badge())).toBe('v2→v3');
  });

  it('不在监视范围的已跟踪文件不进徽标/待同步/报告', async () => {
    const h = makeHarness();
    h.tokens.set(FILE, 'T0');
    await h.tracker.noteFile(FILE);
    h.tokens.set(FILE, 'T1');
    await h.tracker.noteFile(FILE);
    h.setScope(FILE, false);
    h.setActive(FILE);
    expect(h.tracker.badge()).toBeUndefined();
    expect(h.tracker.pending()).toEqual([]);
    expect(h.tracker.report()).toEqual([]);
  });

  it('report:逐文件列基线/盘上版本与版本跃迁(时间/attempt/digest 前 8/outcome)', async () => {
    const h = makeHarness({ now: () => new Date(2026, 0, 1, 12, 0, 0).getTime() });
    h.tokens.set(FILE, 'T0');
    await h.tracker.noteFile(FILE);
    const digest = sha('payload');
    h.store.record(KEY, FILE, 'sent-unverified', { sentDigest: digest, now: new Date(2026, 0, 1, 12, 0, 1).getTime() });
    h.tokens.set(FILE, 'T1');
    await h.tracker.noteFile(FILE);
    h.store.record(KEY, FILE, 'applied', { attempt: 1, now: new Date(2026, 0, 1, 12, 0, 2).getTime() });
    h.contents.set(FILE, 'payload');
    await h.tracker.refresh();

    const report = h.tracker.report();
    expect(report[0]).toContain('版本台账');
    expect(report[0]).toContain('1 个文件');
    const head = report[1];
    expect(head).toContain(FILE);
    expect(head).toContain('基线 v2');
    expect(head).toContain('盘上 v2');
    expect(head).toContain('已同步');
    const text = report.join('\n');
    expect(text).toContain('首次跟踪');
    expect(text).toContain('盘上内容变化');
    expect(text).toContain(`digest=${digest.slice(0, 8)}`);
    expect(text).toContain('attempt=1');
    expect(text).toContain('outcome=applied');
    expect(text).toContain('基线追平 v2');
  });
});

describe('补充约束:版本台账独立于 watcher(手动路径与 watcher 同口径)', () => {
  const runPath = async (kind: 'watcher' | 'manual'): Promise<{ badge: string | undefined; version: number }> => {
    const h = makeHarness({ now: () => 1_000 });
    const key = KEY;
    h.tokens.set(FILE, 'T0');
    await h.tracker.noteFile(FILE); // 首次跟踪 v1
    for (const token of ['T1', 'T2']) {
      h.tokens.set(FILE, token);
      if (kind === 'watcher') {
        await h.tracker.noteFile(FILE); // watcher 事件即采样
      } else {
        // watcher 关闭:手动触发一次热更(落台账)+ 触发面刷新采样
        h.store.record(key, FILE, 'sent-unverified', { now: 1_000 });
        await h.tracker.refresh();
      }
    }
    return { badge: suffix(h.tracker.badge()), version: h.store.fileVersion(FILE)!.version };
  };

  it('watcher 关闭 → 手动触发 → 版本号出现,与 watcher 开启同文件同版本逐字相等', async () => {
    const watcher = await runPath('watcher');
    const manual = await runPath('manual');
    expect(manual.badge).toBeDefined();
    expect(manual.badge).toBe(watcher.badge);
    expect(manual.version).toBe(watcher.version);
    expect(manual.version).toBe(3); // T0→T1→T2 三次观察,两路径同一计数
  });

  it('两种路径不产生两套计数:同一文件同一 token 双路径采样只 +1', async () => {
    const h = makeHarness();
    h.tokens.set(FILE, 'T0');
    await h.tracker.noteFile(FILE); // watcher 采样
    h.tokens.set(FILE, 'T1');
    await h.tracker.noteFile(FILE); // watcher 采样 → v2
    h.store.record(KEY, FILE, 'sent-unverified', { now: 2 }); // 手动触发建档(已跟踪,不重建)
    expect(await h.tracker.refresh()).toBe(false); // 手动路径同 token 再采样 → 不再 +1
    expect(h.store.fileVersion(FILE)?.version).toBe(2);
    expect(h.store.fileVersions()).toHaveLength(1); // 只有一份计数
  });

  it('watch-off(未开监视)仍能出版本:手动触发建档即有号', async () => {
    const h = makeHarness();
    h.tokens.set(FILE, 'T0');
    h.store.record(KEY, FILE, 'sent-unverified', { now: 1 }); // 手动触发,watcher 从未开
    await h.tracker.refresh();
    expect(suffix(h.tracker.badge())).toBe('v1');
    h.tokens.set(FILE, 'T1');
    await h.tracker.refresh();
    expect(suffix(h.tracker.badge())).toBe('v1→v2');
  });
});

describe('hotReloadFileVersion 缺口臂(glob 尾段/缺省采样读盘/台账说明/未知事件)', () => {
  it('glob:`**` 不带尾斜杠跨目录;`?` 单字符不跨目录', () => {
    expect(matchesHotReloadGlob('scripts/a/b.py', ['scripts/**'])).toBe(true);
    expect(matchesHotReloadGlob('other/b.py', ['scripts/**'])).toBe(false);
    expect(matchesHotReloadGlob('f1.py', ['f?.py'])).toBe(true);
    expect(matchesHotReloadGlob('f12.py', ['f?.py'])).toBe(false);
  });

  it('缺省采样/读盘:无注入走真 fs(mtime:size token + readFile),digest 一致即追平', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kode-hotver-'));
    try {
      const file = path.join(root, 'Account.py');
      writeFileSync(file, 'content-v1', 'utf8');
      const store = new HotReloadTargetStateStore({ now: () => 1_000 });
      // 不注入 statToken/readContent:stat/read 走缺省真 fs 面
      const tracker = new HotReloadVersionTracker({
        store,
        activeFile: () => undefined,
        isWatched: f => f.endsWith('.py'),
        now: () => 1_000
      });
      expect(await tracker.noteFile(file)).toBe(true); // 首采 v1(缺省 stat 面)
      // 盘上真实变化(mtime+size 同变)→ v2,基线停在 1 → 双号
      writeFileSync(file, 'content-v2-longer', 'utf8');
      expect(await tracker.noteFile(file)).toBe(true);
      store.record(KEY, file, 'sent-unverified', { sentDigest: sha('content-v2-longer'), now: 5 });
      store.record(KEY, file, 'applied', { attempt: 1, now: 6 });
      expect(await tracker.refresh()).toBe(true); // 读盘 digest 一致 → 基线追平(缺省 readFile 面)
      expect(tracker.describeVersion(file)).toContain('已同步');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('读盘缺失如实不追平:digest 记了但文件没了 → 双号保留,不虚构追平', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const tokens = new Map<string, string>([[FILE, '100:10']]);
    // readContent 缺省(真 fs),FILE 不在盘上 → readFile 落 catch → undefined
    const tracker = new HotReloadVersionTracker({
      store,
      activeFile: () => undefined,
      isWatched: f => f.endsWith('.py'),
      now: () => 1_000,
      statToken: async f => tokens.get(f)
    });
    await tracker.noteFile(FILE);
    tokens.set(FILE, '200:20');
    await tracker.noteFile(FILE); // v2,双号
    store.record(KEY, FILE, 'sent-unverified', { sentDigest: sha('gone-content'), now: 5 });
    store.record(KEY, FILE, 'applied', { attempt: 1, now: 6 });
    expect(await tracker.refresh()).toBe(false); // 盘上读不到 → 不追平
    expect(tracker.describeVersion(FILE)).toContain('待同步');
  });

  it('describeVersion:未跟踪=undefined;不在监视范围=undefined;跟踪后报双态', async () => {
    const h = makeHarness();
    expect(h.tracker.describeVersion('/ws/none.py')).toBeUndefined();
    h.tokens.set(FILE, 'T0');
    await h.tracker.noteFile(FILE);
    h.setScope(FILE, false);
    expect(h.tracker.describeVersion(FILE)).toBeUndefined();
    h.setScope(FILE, true);
    expect(h.tracker.describeVersion(FILE)).toContain('已同步');
    h.tokens.set(FILE, 'T1');
    await h.tracker.noteFile(FILE); // v2 → 双号待同步
    expect(h.tracker.describeVersion(FILE)).toContain('待同步');
  });

  it('report:未知事件 kind 如实渲染时间+版本(不崩不吞)', async () => {
    const h = makeHarness();
    h.tokens.set(FILE, 'T0');
    await h.tracker.noteFile(FILE);
    // 台账历史遗留形态:旧版本落盘的未知事件 kind → default 分支渲染
    const state = h.store.fileVersion(FILE) as unknown as { events: Array<{ kind: string; version: number; at: number }> };
    state.events.push({ kind: 'legacy-mystery', version: 9, at: 2_000 });
    const lines = h.tracker.report();
    expect(lines.some(line => / v9$/.test(line))).toBe(true);
  });
});
