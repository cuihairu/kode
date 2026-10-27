// P0-4a 固化诊断③:同步阻塞导致定时预算延后(docs/perf/2026-10-26-stall-analysis.md §4):
//   npx vitest run --config vitest.bench.config.ts tests/perf/timerDelay.bench.ts
//
// 现象(stall-analysis 本地反例,基线 550d824):hoverBudget 的预算闸走同线程
// setTimeout,10ms 预算遇到 150ms 同步阻塞,实际 150.34ms 才返回——定时器
// 预算不是硬上限,同步 IO 期间无法触发。本 bench 用真实 raceWithBudget /
// createLinkedCancellationToken 复跑该现象并量化:
//   T1 延后现象:10ms 预算 + 150ms 同步阻塞 → 实测返回时刻与定时器延后量;
//   T2 收敛(P0-3d 修法):请求独占工作持 linked token,批间检查取消——预算
//      在阻塞期间已过期,事件循环恢复后首个检查点即停,操作计数收敛;
//   C1 对照:无预算无 token,同一批循环跑满,给出最大可能操作计数。
// 行为契约(取消收敛、共享扫描不误伤)另有门禁单测锁定:
// tests/hoverBudget.test.ts:130;本文件是诊断面,不进 pnpm test 门禁。
// 输出行以 TIMER-METRIC 前缀打印并落 docs/perf/timer-delay-run.txt。

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'perf_hooks';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  clearRecentHoverTimeouts,
  createLinkedCancellationToken,
  raceWithBudget
} from '../../src/hoverBudget';

const BUDGET_MS = 10;
const BLOCK_MS = 150;
const BATCHES = 1000;
const OPS_PER_BATCH = 1000;

const OUT_FILE = process.env.KODE_TIMER_DELAY_OUT
  ?? path.resolve(__dirname, '../../docs/perf/timer-delay-run.txt');
const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.appendFileSync(OUT_FILE, line + '\n');
  console.log(line);
};

/** 同步阻塞:占住当前线程 blockMs,模拟同步 readdir/解析等不可中断段 */
const busyBlock = (blockMs: number): void => {
  const deadline = performance.now() + blockMs;
  while (performance.now() < deadline) {
    /* spin */
  }
};

const makeParentToken = (): vscode.CancellationToken => ({
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined })
});

describe('P0-4a 诊断③:同步阻塞延后定时预算(真实 raceWithBudget)', () => {
  beforeAll(() => {
    clearRecentHoverTimeouts();
    fs.rmSync(OUT_FILE, { force: true });
  });

  afterAll(() => {
    clearRecentHoverTimeouts();
  });

  it('T1: 10ms 预算遇 150ms 同步阻塞,返回时刻 ≈ 阻塞结束(定时器延后)', async () => {
    const startedAt = performance.now();
    const raced = raceWithBudget('timer-delay-probe', new Promise<never>(() => undefined), BUDGET_MS);
    busyBlock(BLOCK_MS);
    const result = await raced;
    const returnedAt = performance.now() - startedAt;
    if (result !== null) {
      throw new Error(`T1 应因预算返回 null,实得 ${String(result)}`);
    }
    const timerDelay = returnedAt - BUDGET_MS;
    emit(
      `TIMER-METRIC sync-block-delay n=1 budget=${BUDGET_MS}ms block=${BLOCK_MS}ms ` +
      `returnedAt=${Math.round(returnedAt * 100) / 100}ms ` +
      `timerDelay=${Math.round(timerDelay * 100) / 100}ms`
    );
    if (returnedAt < BLOCK_MS) {
      throw new Error('T1 前提不成立:返回早于阻塞结束,同步阻塞未发生');
    }
  }, 30000);

  it('T2: linked token 下请求独占工作在阻塞后首个检查点收敛(操作计数不跑满)', async () => {
    const linked = createLinkedCancellationToken(makeParentToken());
    let ops = 0;
    let stoppedAtBatch = -1;
    const work = (async (): Promise<number> => {
      // 先让出一拍:确保 raceWithBudget 已装好 10ms 定时器,同步阻塞发生在
      // 预算过期之后(复现 stall-analysis 的时序,而非阻塞先于装闸)
      await new Promise(resolve => setImmediate(resolve));
      for (let batch = 0; batch < BATCHES; batch++) {
        if (linked.token.isCancellationRequested) {
          stoppedAtBatch = batch;
          break;
        }
        if (batch === 0) {
          busyBlock(BLOCK_MS); // 首批内一段同步阻塞:预算在阻塞期间已过期
        }
        for (let i = 0; i < OPS_PER_BATCH; i++) {
          ops++;
        }
        await new Promise(resolve => setImmediate(resolve)); // 批间让出事件循环(真让路,微任务队列不让定时器)
      }
      return ops;
    })();
    const startedAt = performance.now();
    const result = await raceWithBudget('timer-converge-probe', work, BUDGET_MS, linked.token, linked.cancel);
    const elapsed = performance.now() - startedAt;
    // race 在预算到期即返回;工作本体在下一个检查点停,等它自行结算再取计数
    await work.catch(() => undefined);
    await new Promise(resolve => setImmediate(resolve));
    const maxPossible = BATCHES * OPS_PER_BATCH;
    emit(
      `TIMER-METRIC budget-cancel-convergence n=1 budget=${BUDGET_MS}ms block=${BLOCK_MS}ms ` +
      `requestOps=${ops} stoppedAtBatch=${stoppedAtBatch} maxPossible=${maxPossible} ` +
      `elapsed=${Math.round(elapsed * 100) / 100}ms result=${result === null ? 'null' : result}`
    );
    if (ops >= maxPossible) {
      throw new Error('T2 未收敛:取消后工作仍跑满全部批次');
    }
    if (stoppedAtBatch < 0) {
      throw new Error('T2 未观测到取消检查点命中');
    }
  }, 30000);

  it('C1: 对照组,无预算无 token,同一批循环跑满(最大可能操作计数)', async () => {
    let ops = 0;
    const work = (async (): Promise<number> => {
      for (let batch = 0; batch < BATCHES; batch++) {
        for (let i = 0; i < OPS_PER_BATCH; i++) {
          ops++;
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      return ops;
    })();
    const result = await raceWithBudget('control-no-budget', work, 0);
    const maxPossible = BATCHES * OPS_PER_BATCH;
    emit(`TIMER-METRIC control-full-run n=1 requestOps=${result} maxPossible=${maxPossible}`);
    if (result !== maxPossible) {
      throw new Error(`C1 对照应跑满 ${maxPossible},实得 ${String(result)}`);
    }
  }, 30000);
});
