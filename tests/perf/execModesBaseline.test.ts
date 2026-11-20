import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { ProcessManager } from '../../src/backend/processManager';
import {
  createPythonExecService,
  PYTHON_EXEC_TIMEOUT_MS
} from '../../src/backend/pythonExecService';
import { repeatStats } from './repeatStats';

// EXEC-BASELINE-002(RUST-200 落地)执行模式耗时基准:把「重用模式热态
// compile」与「纯进程冷启动/一次性执行」两种执行模式的真实耗时拆开量,
// 各 N=20 逐次计时(performance.now()),首跑热身不计入,P50/P95 经
// repeatStats(nearest-rank,与 v02Baseline 同源)汇总,实测明细落
// docs/perf/2026-11-20-exec-modes-baseline.md——性能回归对照基线。数字是
// 测量机当时状态的本地数字(机器/Python 版本/并发状态见报告行),CI 慢机
// 数字不外推。
//
// 三组口径:
// ① reuse-compile:pythonExecService 常驻帧协议服务,预热 1 次(含惰性
//    spawn+握手)后逐次 runCompile 同一脚本——重用模式单次执行耗时;
// ② cold-start:ProcessManager 受管 spawn `python3 -c pass`,spawn 到进程
//    自然退出(code 0)为「冷启动完成」的可观测上界(含空指令与退出收尾);
// ③ oneshot-compile:每次新 spawn `python3 -c compile(open(同脚本))` 到
//    exit(0)——旧一次性路径形态的每调用合计成本(spawn+compile+退出),
//    与②分开记,不相减出「纯 compile」(两个噪声样本相减只会放大噪声)。
//
// 断言=结构判据而非绝对阈值(跨机器绝对比较禁止,PERF-015 口径):
// 每样本 < 服务超时上限 5000ms;①中位数显著低于②中位数(重用 vs 冷启动
// 的结构性区分,RUST-200「准确分辨」的可测兑现);①中位数 < 50ms(热态
// 管道往返+compile 的宽松上界,超出即「重用」名存实亡)。
const repoRoot = join(__dirname, '..', '..');
const TASK_SCRIPT = join(
  repoRoot,
  'tests',
  'fixtures',
  'kbengine-demo-assets',
  'scripts',
  'cell',
  'Avatar.py'
);
const N = 20;

const manager = new ProcessManager();
afterAll(async () => {
  await manager.dispose().catch(() => undefined);
});

interface SpawnOutcome {
  code: number | null;
  ms: number;
  stdout: string;
}

/** 受管面 spawn 到退出:计时=manager.start(spawnProcess)到 exit 事件 */
const spawnUntilExit = async (id: string, args: readonly string[]): Promise<SpawnOutcome> => {
  const chunks: string[] = [];
  const t0 = performance.now();
  const managed = manager.start({ id, command: 'python3', args });
  managed.process.stdout?.setEncoding?.('utf8');
  managed.process.stdout?.on('data', (chunk: string) => chunks.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    managed.process.once('exit', (exitCode: number | null) => resolve(exitCode));
    managed.process.once('error', reject);
  });
  return { code, ms: performance.now() - t0, stdout: chunks.join('') };
};

describe('kode 执行模式耗时基准(EXEC-BASELINE-002)', () => {
  it(
    '三组基准 N=20:重用热态 compile / 纯进程冷启动 / 一次性执行,重用中位数显著低于冷启动',
    { timeout: 120_000 },
    async () => {
      const source = readFileSync(TASK_SCRIPT, 'utf8');
      expect(source.length, '基准任务=真实 demo 脚本(非空串假任务)').toBeGreaterThan(4000);

      const version = await spawnUntilExit('exec-baseline-version', ['--version']);
      expect(version.code, 'python3 --version 应 exit 0').toBe(0);

      // ① 重用模式:常驻服务热态 compile(预热 1 次含惰性 spawn+握手,不计入)
      const service = createPythonExecService({ interpreter: 'python3' });
      const warm = await service.runCompile({ content: source });
      expect(warm.ok, '预热 compile 应成功').toBe(true);
      const pidKept = service.pid();
      expect(pidKept, '预热后常驻进程应在').toBeGreaterThan(0);
      const reuseMs: number[] = [];
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const outcome = await service.runCompile({ content: source });
        const t1 = performance.now();
        expect(outcome.ok, `第 ${i} 次 compile 应成功`).toBe(true);
        reuseMs.push(t1 - t0);
      }
      expect(service.pid(), '重用模式全程同一常驻进程(不重 spawn)').toBe(pidKept);
      service.dispose();

      // ② 纯进程冷启动:受管 spawn `python3 -c pass` 到自然退出
      const coldMs: number[] = [];
      for (let i = 0; i < N; i++) {
        const outcome = await spawnUntilExit(`exec-baseline-cold-${i}`, ['-c', 'pass']);
        expect(outcome.code, `冷启动第 ${i} 次应 exit 0`).toBe(0);
        coldMs.push(outcome.ms);
      }

      // ③ 一次性执行:每次新进程 compile 同一脚本(spawn+compile+退出 合计)
      const dir = mkdtempSync(join(tmpdir(), 'kode-exec-baseline-'));
      try {
        const taskFile = join(dir, 'task.py');
        writeFileSync(taskFile, source);
        const oneshotArgs = [
          '-c',
          `compile(open(${JSON.stringify(taskFile)}, encoding="utf-8").read(), "<exec-modes-baseline>", "exec")`
        ];
        const oneshotMs: number[] = [];
        for (let i = 0; i < N; i++) {
          const outcome = await spawnUntilExit(`exec-baseline-oneshot-${i}`, oneshotArgs);
          expect(outcome.code, `一次性执行第 ${i} 次应 exit 0`).toBe(0);
          oneshotMs.push(outcome.ms);
        }

        // 汇总与报告(数字进 vitest 输出,落档 docs/perf/…-run.txt)
        const reuse = repeatStats(reuseMs);
        const cold = repeatStats(coldMs);
        const oneshot = repeatStats(oneshotMs);
        const line = (label: string, stats: ReturnType<typeof repeatStats>): string =>
          `[exec-baseline] ${label} n=${stats.n} P50=${stats.median}ms P95=${stats.p95}ms min=${stats.min}ms max=${stats.max}ms spread=${stats.spreadPct}%`;
        console.log(
          `[exec-baseline] env ${version.stdout.trim()} / node ${process.version} / ${process.platform} / 并发=vitest 全量套件内`
        );
        console.log(line('① reuse-compile(常驻热态单次)', reuse));
        console.log(line('② cold-start(python -c pass)', cold));
        console.log(line('③ oneshot-compile(spawn+compile+exit 合计)', oneshot));

        // 结构判据(非绝对阈值)
        for (const [label, samples] of [
          ['reuse', reuseMs],
          ['cold', coldMs],
          ['oneshot', oneshotMs]
        ] as const) {
          expect(samples, `${label} 样本数=N`).toHaveLength(N);
          expect(
            samples.every(ms => Number.isFinite(ms) && ms > 0 && ms < PYTHON_EXEC_TIMEOUT_MS),
            `${label} 每样本应在服务超时上限内(<${PYTHON_EXEC_TIMEOUT_MS}ms)`
          ).toBe(true);
        }
        expect(
          reuse.median,
          '重用模式中位数应显著低于纯进程冷启动中位数(RUST-200 结构判据)'
        ).toBeLessThan(cold.median);
        expect(
          reuse.median,
          '热态管道往返+compile 的宽松上界(超出即「重用」名存实亡)'
        ).toBeLessThan(50);
        expect(reuse.p95, '分位数序:P95 ≥ P50').toBeGreaterThanOrEqual(reuse.median);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
