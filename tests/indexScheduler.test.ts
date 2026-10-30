import { describe, expect, it, afterEach } from 'vitest';
import {
  IndexScheduler,
  IndexTaskPriority,
  isInteractivePriority
} from '../src/indexScheduler';

// 统一索引调度器(评审 docs/review/2026-10-22 §3.3 / PR3)测试锁定:
// ①任务生命周期与状态查询;②同文件同版本合并+过期任务取消丢弃;
// ③优先级顺序(当前文件轻量>请求局部>依赖更新>后台全量>非交互)顺序断言;
// ④失败恢复(首扫被杀后请求可恢复,不永久 pending);
// ⑥后台限流(编辑高峰后台任务让路,指标计数验证)。

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => {
  // 每例独立实例,无全局状态;防御性清队只是防用例泄漏计时器
});

describe('indexScheduler 任务生命周期与状态查询', () => {
  it('任务按 completed/failed/cancelled 终态计数,状态查询可见', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    const done = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/a.py',
      version: 1,
      run: async () => undefined
    });
    const failing = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/b.py',
      version: 1,
      run: async () => { throw new Error('boom'); }
    });
    const cancelling = scheduler.enqueue({
      kind: 'dependency-update',
      priority: IndexTaskPriority.CurrentFileLight,
      run: async () => undefined
    });
    cancelling.cancel('test');
    await expect(done.wait).resolves.toBeUndefined();
    await expect(failing.wait).rejects.toThrow('boom');
    await flush();
    const status = scheduler.getStatus();
    expect(status.completed).toBe(1);
    expect(status.failed).toBe(1);
    expect(status.cancelled).toBe(1);
    expect(status.queued).toBe(0);
    expect(status.running).toBeNull();
    scheduler.dispose();
  });

  it('终态任务出表:completed/failed/cancelled 后 tasks Map 不再滞留(不泄漏)', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    // tasks 是私有生命周期表;经运行态快照只读探针取证(Map 大小即滞留数)
    const mapSize = (): number =>
      (scheduler as unknown as { tasks: Map<number, unknown> }).tasks.size;
    const done = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/a.py',
      version: 1,
      run: async () => undefined
    });
    const failing = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/b.py',
      version: 1,
      run: async () => { throw new Error('boom'); }
    });
    const cancelled = scheduler.enqueue({
      kind: 'dependency-update',
      priority: IndexTaskPriority.CurrentFileLight,
      run: async () => undefined
    });
    cancelled.cancel('test');
    // 入队后立即取消的也曾在表里(取消即出表)
    await expect(done.wait).resolves.toBeUndefined();
    await expect(failing.wait).rejects.toThrow('boom');
    await flush();
    expect(mapSize()).toBe(0);
    expect(scheduler.getStatus().completed).toBe(1);
    expect(scheduler.getStatus().failed).toBe(1);
    expect(scheduler.getStatus().cancelled).toBe(1);
    scheduler.dispose();
  });

  it('isKeyedComplete 反映 keyed 任务终态:无条目 false,完成 true', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    // 无 keyed 条目:便捷查询不抛,按未完成处理
    expect(scheduler.isKeyedComplete('first-scan')).toBe(false);

    await scheduler.ensureTask('first-scan', () => ({
      kind: 'dependency-update',
      priority: IndexTaskPriority.CurrentFileLight,
      run: async () => undefined
    }));
    await flush();

    // 状态查询便捷面与 getStatus().keyedTasks 同源:'completed' 即真
    expect(scheduler.isKeyedComplete('first-scan')).toBe(true);
    expect(scheduler.getStatus().keyedTasks['first-scan']).toBe('completed');
    scheduler.dispose();
  });

  it('delete-cleanup 任务带 targetPath 全生命周期可查', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    const handle = scheduler.enqueue({
      kind: 'delete-cleanup',
      priority: IndexTaskPriority.DependencyUpdate,
      targetPath: '/gone/entity.py',
      run: async () => undefined
    });
    expect(handle.state()).toBe('queued');
    await handle.wait;
    expect(handle.state()).toBe('completed');
    scheduler.dispose();
  });

  it('单并发:后台全量(full-reindex)任务一次只跑一个', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = async (): Promise<void> => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await flush();
      concurrent -= 1;
    };
    const a = scheduler.enqueue({ kind: 'full-reindex', priority: IndexTaskPriority.BackgroundFull, run });
    const b = scheduler.enqueue({ kind: 'full-reindex', priority: IndexTaskPriority.BackgroundFull, run });
    await Promise.all([a.wait, b.wait]);
    expect(maxConcurrent).toBe(1);
    scheduler.dispose();
  });
});

describe('indexScheduler 同文件合并与过期丢弃', () => {
  it('同文件同版本的重复任务合并为一次执行', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    let runs = 0;
    const first = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/a.py',
      version: 7,
      run: async () => { runs += 1; }
    });
    const second = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.RequestLocal,
      filePath: '/a.py',
      version: 7,
      run: async () => { runs += 1; }
    });
    // 同句柄复用:等待同一个任务
    await first.wait;
    await second.wait;
    expect(runs).toBe(1);
    // 合并时优先级取更高者(数值更小):RequestLocal(1) 不覆盖 CurrentFileLight(0)
    expect(scheduler.getStatus().metrics.mergedTasks).toBe(1);
    scheduler.dispose();
  });

  it('同文件同版本合并时保留更高优先级(局部先到,轻量后到)', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    const order: string[] = [];
    const background = scheduler.enqueue({
      kind: 'full-reindex',
      priority: IndexTaskPriority.BackgroundFull,
      run: async () => { order.push('background'); }
    });
    const lower = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.RequestLocal,
      filePath: '/a.py',
      version: 1,
      run: async () => { order.push('merged'); }
    });
    const merged = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/a.py',
      version: 1,
      run: async () => { order.push('merged'); }
    });
    // 合并把已排队的 RequestLocal(1) 提升为 CurrentFileLight(0):先于 BackgroundFull
    expect(merged.id).toBe(lower.id);
    await merged.wait;
    await background.wait;
    expect(order).toEqual(['merged', 'background']);
    expect(scheduler.getStatus().metrics.mergedTasks).toBe(1);
    scheduler.dispose();
  });

  it('旧版本任务入队时取消队列里同文件的旧任务,只跑最新版本', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    const ran: number[] = [];
    const stale = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/a.py',
      version: 1,
      run: async () => { ran.push(1); }
    });
    const fresh = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/a.py',
      version: 2,
      run: async () => { ran.push(2); }
    });
    await expect(stale.wait).rejects.toThrow('stale-version');
    await fresh.wait;
    expect(ran).toEqual([2]);
    expect(scheduler.getStatus().metrics.staleDropped).toBe(1);
    scheduler.dispose();
  });

  it('比队列中任务更旧的版本直接丢弃(不执行、不覆盖新版本)', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    const ran: number[] = [];
    const fresh = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/a.py',
      version: 5,
      run: async () => { ran.push(5); }
    });
    const stale = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/a.py',
      version: 4,
      run: async () => { ran.push(4); }
    });
    await expect(stale.wait).rejects.toThrow('stale task dropped');
    await fresh.wait;
    expect(ran).toEqual([5]);
    expect(scheduler.getStatus().metrics.staleDropped).toBe(1);
    scheduler.dispose();
  });
});

describe('indexScheduler 优先级队列', () => {
  it('五级优先级按 当前文件轻量>请求局部>依赖更新>后台全量>非交互 执行', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    const order: string[] = [];
    const track = (label: string) => async (): Promise<void> => { order.push(label); };
    // 故意乱序入队
    const nonInteractive = scheduler.enqueue({
      kind: 'non-interactive', priority: IndexTaskPriority.NonInteractive, run: track('non-interactive')
    });
    const background = scheduler.enqueue({
      kind: 'full-reindex', priority: IndexTaskPriority.BackgroundFull, run: track('background-full')
    });
    const dependency = scheduler.enqueue({
      kind: 'dependency-update', priority: IndexTaskPriority.DependencyUpdate, run: track('dependency-update')
    });
    const requestLocal = scheduler.enqueue({
      kind: 'single-file-update', priority: IndexTaskPriority.RequestLocal, run: track('request-local')
    });
    const currentFile = scheduler.enqueue({
      kind: 'single-file-update', priority: IndexTaskPriority.CurrentFileLight, run: track('current-file-light')
    });
    await Promise.all([
      currentFile.wait, requestLocal.wait, dependency.wait, background.wait, nonInteractive.wait
    ]);
    expect(order).toEqual([
      'current-file-light',
      'request-local',
      'dependency-update',
      'background-full',
      'non-interactive'
    ]);
    scheduler.dispose();
  });

  it('同优先级按入队顺序(FIFO)执行', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    const order: number[] = [];
    const handles = [3, 1, 2].map(n => scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.RequestLocal,
      filePath: `/f${n}.py`,
      version: 1,
      run: async () => { order.push(n); }
    }));
    await Promise.all(handles.map(handle => handle.wait));
    expect(order).toEqual([3, 1, 2]);
    scheduler.dispose();
  });

  it('isInteractivePriority: 前三级为交互,后台全量与非交互不是', () => {
    expect(isInteractivePriority(IndexTaskPriority.CurrentFileLight)).toBe(true);
    expect(isInteractivePriority(IndexTaskPriority.RequestLocal)).toBe(true);
    expect(isInteractivePriority(IndexTaskPriority.DependencyUpdate)).toBe(true);
    expect(isInteractivePriority(IndexTaskPriority.BackgroundFull)).toBe(false);
    expect(isInteractivePriority(IndexTaskPriority.NonInteractive)).toBe(false);
  });
});

describe('indexScheduler 失败恢复', () => {
  it('首扫任务被杀(失败)后再次请求重新入队并可完成,不永久 pending', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    let attempts = 0;
    const factory = (): Parameters<Parameters<typeof scheduler.ensureTask>[1]>[0] => ({
      kind: 'initial-scan',
      priority: IndexTaskPriority.BackgroundFull,
      run: async () => {
        attempts += 1;
        if (attempts === 1) {
          // 模拟首扫被杀:进程/协程中途终止,任务体拒绝
          throw new Error('initial scan killed');
        }
      }
    });
    // 第一次请求:拒绝(而非悬挂)
    await expect(scheduler.ensureTask('initial-scan', factory)).rejects.toThrow('initial scan killed');
    expect(scheduler.getStatus().keyedTasks['initial-scan']).toBe('failed');
    // 第二次请求:恢复,重新扫描并完成
    await scheduler.ensureTask('initial-scan', factory);
    expect(attempts).toBe(2);
    expect(scheduler.getStatus().keyedTasks['initial-scan']).toBe('completed');
    expect(scheduler.getStatus().metrics.recoveries).toBe(1);
    scheduler.dispose();
  });

  it('进行中的 keyed 任务被复用(不重复入队)', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    let runs = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const factory = (): Parameters<Parameters<typeof scheduler.ensureTask>[1]>[0] => ({
      kind: 'initial-scan',
      priority: IndexTaskPriority.BackgroundFull,
      run: async () => { runs += 1; await gate; }
    });
    const first = scheduler.ensureTask('initial-scan', factory);
    const second = scheduler.ensureTask('initial-scan', factory);
    expect(first).toBe(second);
    release?.();
    await first;
    expect(runs).toBe(1);
    scheduler.dispose();
  });

  it('普通任务失败不阻塞后续任务(队列不楔死)', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    const failing = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/bad.py',
      version: 1,
      run: async () => { throw new Error('parse fail'); }
    });
    const after = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/good.py',
      version: 1,
      run: async () => undefined
    });
    await expect(failing.wait).rejects.toThrow('parse fail');
    await after.wait;
    expect(scheduler.getStatus().failed).toBe(1);
    expect(scheduler.getStatus().completed).toBe(1);
    scheduler.dispose();
  });
});

describe('indexScheduler 后台限流', () => {
  it('编辑高峰(交互任务连续入队)期间后台全量任务让路,空闲后恢复', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 30 });
    const order: string[] = [];
    let releaseBurst: (() => void) | null = null;
    const burstGate = new Promise<void>(resolve => { releaseBurst = resolve; });
    // 编辑高峰:一个长交互任务占住队列(模拟连续输入的增量解析)
    const burst = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/edit.py',
      version: 1,
      run: async () => { await burstGate; order.push('edit'); }
    });
    const background = scheduler.enqueue({
      kind: 'full-reindex',
      priority: IndexTaskPriority.BackgroundFull,
      run: async () => { order.push('background-full'); }
    });
    // 后台任务此刻必须仍在排队(交互任务占着队列,后台不启动)
    await flush();
    expect(order).toEqual([]);
    expect(background.state()).toBe('queued');
    releaseBurst?.();
    await burst.wait;
    // 交互任务刚完成的冷却窗口内,后台仍未启动
    expect(background.state()).toBe('queued');
    // 冷却窗口(30ms)过后后台恢复推进
    await background.wait;
    expect(order).toEqual(['edit', 'background-full']);
    const metrics = scheduler.getStatus().metrics;
    expect(metrics.postponedBackground).toBeGreaterThanOrEqual(1);
    expect(metrics.backgroundDelayMs).toBeGreaterThan(0);
    scheduler.dispose();
  });

  it('空闲时后台全量任务不额外等待(冷却只对交互后退期间生效)', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 5000 });
    const ran: string[] = [];
    const background = scheduler.enqueue({
      kind: 'full-reindex',
      priority: IndexTaskPriority.BackgroundFull,
      run: async () => { ran.push('background-full'); }
    });
    await background.wait;
    expect(ran).toEqual(['background-full']);
    scheduler.dispose();
  });

  it('index-scheduler 打点落入 languageServiceMetrics 聚合(ok/error 可查)', async () => {
    const { resetLanguageServiceMetrics, getOperationSummary } = await import('../src/languageServiceMetrics');
    resetLanguageServiceMetrics();
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    const ok = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/ok.py',
      version: 1,
      run: async () => undefined
    });
    const bad = scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/bad.py',
      version: 1,
      run: async () => { throw new Error('x'); }
    });
    await ok.wait;
    await expect(bad.wait).rejects.toThrow('x');
    await flush();
    const summary = getOperationSummary('index-scheduler');
    expect(summary).not.toBeNull();
    expect(summary!.count).toBe(2);
    expect(summary!.statusCounts.ok).toBe(1);
    expect(summary!.statusCounts.error).toBe(1);
    resetLanguageServiceMetrics();
    scheduler.dispose();
  });
});
