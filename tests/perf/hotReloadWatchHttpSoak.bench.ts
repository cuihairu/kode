/**
 * RUST-428 Watch/HTTP soak(HR-QA-016):持续混合负载下的泄漏/风暴/存活观测。
 *   负载:每窗(5s)整根 rebuild + 一批磁盘事件喂 watch 控制器→流水线,加
 *   HTTP 发送两臂(成功=真实回环接收端 applied 回执;失败=关闭端口
 *   ECONNREFUSED,触发失败回执路径)。全部真实实现:
 *     Watch 腿=HotReloadDiskWatchController(真实控制器,注入工厂计存活句柄)
 *     HTTP 腿=HttpReloadTransport(真实发送,经 defaultReloadHttpRunner →
 *       pooledAgent keepAlive 连接池)+node:http 回环接收端
 *     Pipeline=HotReloadSavePipeline(纯核,小去抖全冲口,零预览滞留)
 *   断言只有四类(结构性,不钉墙钟):
 *     ①watcher 泄漏:每窗 rebuild 后存活 watcher 句柄数恒等于根数
 *        (旧根未释放会累积→线性增长,即泄漏);
 *     ②状态增长无界:gc 后 heapUsed 增量 < 界(缺省 100MB,同 RUST-030
 *        泄漏口径)+流水线每窗全排空(emitted==offered,无积压);
 *     ③连接泄漏:请求间空闲态存活 TCP socket 数 ≤ 基线+2(pooledAgent
 *        keepAlive 单主机只该有 ~1 条,每请求新建连接会线性累积);
 *     ④错误重试风暴:失败臂每文件每窗恰 1 次尝试(无指数风暴),错误总数
 *        恰等于期望值。
 *   墙钟百分位只观测记录,不做阈值。
 *
 * 时长:KODE_HRSOAK_SECONDS(缺省 60;24h 验收跑 KODE_HRSOAK_SECONDS=86400,
 * 测试超时按时长自动放宽)。输出 HRSOAK-ENV/HRSOAK-METRIC/HRSOAK-SUMMARY
 * 追加落 docs/perf/hot-reload-watch-http-soak-run.txt(KODE_HRSOAK_OUT 可覆盖)。
 *
 * 跑法:KODE_HRSOAK_SECONDS=86400 npx vitest run --config vitest.bench.config.ts tests/perf/hotReloadWatchHttpSoak.bench.ts
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HotReloadDiskWatchController,
  type DiskWatcherHandle
} from '../../src/backend/hotReloadDiskWatch';
import { HotReloadSavePipeline } from '../../src/backend/hotReloadSavePipeline';
import {
  HttpReloadTransport,
  defaultReloadHttpRunner
} from '../../src/backend/hotReloadTransport';
import type { ReloadTarget } from '../../src/backend/hotReloadTransport';

const ASSETS_OUT = process.env.KODE_HRSOAK_ASSETS_OUT ?? path.join(os.tmpdir(), 'kode-hrsoak-assets');
const FILES = Number(process.env.KODE_HRSOAK_FILES ?? '200');
const SOAK_SECONDS = Number(process.env.KODE_HRSOAK_SECONDS ?? '60');
const WINDOW_MS = Number(process.env.KODE_HRSOAK_WINDOW ?? '5000');
const HEAP_CEILING_MB = Number(process.env.KODE_HRSOAK_HEAP_GROWTH_MB ?? '100');
const SOCKET_SLACK = Number(process.env.KODE_HRSOAK_SOCKET_SLACK ?? '2');

const OUT_FILE =
  process.env.KODE_HRSOAK_OUT ??
  path.resolve(__dirname, '../../docs/perf/hot-reload-watch-http-soak-run.txt');
const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.appendFileSync(OUT_FILE, line + '\n');
  console.log(line);
};

const percentile = (samples: number[], rank: number): number => {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
};

const maybeGc = (): boolean => {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    gc();
    return true;
  }
  return false;
};

/** 活跃 TCP socket 资源数(Node ≥17 getActiveResourcesInfo;空闲态采样) */
const liveTcpSockets = (): number =>
  process.getActiveResourcesInfo().filter(resource => /TCP\s*Socket/i.test(resource)).length;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe(`RUST-428 watch/http soak(${SOAK_SECONDS}s,泄漏/风暴/存活四闸)`, () => {
  let root = '';
  let scripts: string[] = [];
  let receiver: http.Server | null = null;
  let receiverPort = 0;
  let failPort = 0;
  let controller: HotReloadDiskWatchController | null = null;
  let pipeline: HotReloadSavePipeline | null = null;
  let transportOk: HttpReloadTransport | null = null;
  let transportFail: HttpReloadTransport | null = null;

  // 存活 watcher 句柄账
  let liveWatchers = 0;
  let createdWatchers = 0;
  let disposedWatchers = 0;
  /** 在役句柄(释放即移出;事件由窗内触发,驱动真实控制器→过滤→offer 链) */
  let liveHandles: { fire: (file: string) => void }[] = [];

  // 每窗观测
  let offered = 0;
  let emitted = 0;
  let okReceipts = 0;
  let failAttempts = 0;
  let failReceipts = 0;

  const target: ReloadTarget = { rootId: 'soak-root', targetId: 'soak' };
  const onReceipt = (): void => {
    okReceipts += 1;
  };

  /** 注入工厂:计数创建/释放,返回可控句柄(事件由窗内触发) */
  const createWatcher = (pattern: string): DiskWatcherHandle => {
    const change: ((uri: string) => void)[] = [];
    const create: ((uri: string) => void)[] = [];
    const del: ((uri: string) => void)[] = [];
    createdWatchers += 1;
    liveWatchers += 1;
    const entry = {
      fired: false as boolean,
      fire: (file: string) => {
        entry.fired = true;
        for (const cb of change) {
          cb(file);
        }
      }
    };
    const handle: DiskWatcherHandle = {
      pattern,
      onDidChange: cb => change.push(cb),
      onDidCreate: cb => create.push(cb),
      onDidDelete: cb => del.push(cb),
      dispose: () => {
        liveWatchers -= 1;
        disposedWatchers += 1;
        const index = liveHandles.indexOf(entry);
        if (index >= 0) {
          liveHandles.splice(index, 1);
        }
      }
    };
    liveHandles.push(entry);
    return handle;
  };

  beforeAll(async () => {
    execFileSync(
      'node',
      [
        path.resolve(__dirname, '../../scripts/generate-perf-assets.mjs'),
        '--out',
        ASSETS_OUT,
        '--large-files',
        String(FILES),
        '--keep'
      ],
      { stdio: 'inherit' }
    );
    root = path.join(ASSETS_OUT, 'large');
    const collected: string[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.py')) {
          collected.push(full);
        }
      }
    };
    walk(root);
    scripts = collected.sort();

    // 真实回环接收端:applied 回执(逐字回显 file+sha256 形态的 64hex+递增 revision)
    let revision = 0;
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        const digest = 'a'.repeat(64);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'applied', file: 'soak', digest, revision: (revision += 1) }));
      });
    });
    await new Promise<void>(resolve => receiver!.listen(0, '127.0.0.1', resolve));
    receiverPort = (receiver.address() as { port: number }).port;

    // 失败臂:关闭端口(先占再关,拿到确定被拒的端口)
    const tmp = http.createServer();
    await new Promise<void>(resolve => tmp.listen(0, '127.0.0.1', resolve));
    failPort = (tmp.address() as { port: number }).port;
    await new Promise<void>(resolve => tmp.close(() => resolve()));

    pipeline = new HotReloadSavePipeline({
      debounceMs: 20,
      maxDelayMs: 200,
      stabilityWindowMs: 0,
      batchFlushMs: 20,
      batchPreviewThreshold: 1_000_000,
      targetOf: () => 'soak',
      onEmit: events => {
        emitted += events.length;
      }
    });
    // 事件经真实控制器→过滤→offer→流水线(offered=流水线收到的 offer 数)
    controller = new HotReloadDiskWatchController({
      offer: file => {
        offered += 1;
        pipeline!.offer(file, 'watch');
      },
      createWatcher
    });

    transportOk = new HttpReloadTransport(
      {
        name: 'soak-ok',
        url: `http://127.0.0.1:${receiverPort}/hot-reload`,
        method: 'POST',
        headers: {},
        body: '',
        enabled: true
      },
      { run: defaultReloadHttpRunner }
    );
    transportFail = new HttpReloadTransport(
      {
        name: 'soak-fail',
        url: `http://127.0.0.1:${failPort}/hot-reload`,
        method: 'POST',
        headers: {},
        body: '',
        enabled: true
      },
      { run: defaultReloadHttpRunner }
    );

    emit(
      `HRSOAK-ENV node=${process.version} cpus=${os.cpus().length} files=${scripts.length} ` +
        `seconds=${SOAK_SECONDS} windowMs=${WINDOW_MS} receiverPort=${receiverPort} failPort=${failPort}`
    );
  }, 600000);

  afterAll(async () => {
    controller?.dispose();
    pipeline?.dispose();
    await new Promise<void>(resolve => (receiver ? receiver.close(() => resolve()) : resolve()));
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
  });

  it(
    `RUST-428 soak:watcher 不泄漏/状态不无界/连接不泄漏/错误不风暴`,
    async () => {
      const roots = [root];
      const windowFileCount = Math.min(20, scripts.length);
      const failFileCount = Math.min(5, scripts.length);
      const heapBefore = process.memoryUsage().heapUsed;
      const socketBaseline = liveTcpSockets();
      const windowStart = Date.now();
      let windows = 0;
      let nextWindow = windowStart + WINDOW_MS;
      const socketSamples: number[] = [];
      let maxIdleSockets = socketBaseline;

      const deadline = windowStart + SOAK_SECONDS * 1000;
      while (Date.now() < deadline) {
        // ① watch 腿:整根重建(生产根变更路径,dispose 旧根;未释放会累积泄漏)
        controller!.rebuild(roots);
        controller!.arm();
        expect(liveWatchers, `watcher 泄漏:存活 ${liveWatchers} ≠ 根数 ${roots.length}`).toBe(roots.length);

        // 磁盘事件突发,经在役句柄触发真实控制器→过滤→offer 链
        const burst = scripts.slice(0, windowFileCount);
        for (const handle of liveHandles) {
          for (const file of burst) {
            handle.fire(path.join(root, file));
          }
        }

        // ② HTTP 成功臂:真实回环 applied 回执
        const okBefore = okReceipts;
        const okFiles = scripts.slice(0, windowFileCount);
        const okSummary = await transportOk!.send(target, okFiles, onReceipt);
        expect(okSummary.receipts.length).toBe(okFiles.length);
        expect(okReceipts - okBefore).toBe(okFiles.length);

        // ③ HTTP 失败臂:关闭端口,每文件恰 1 次尝试(无风暴)
        const attemptsBefore = failAttempts;
        const failFiles = scripts.slice(0, failFileCount);
        const failSummary = await transportFail!.send(target, failFiles, () => {
          failAttempts += 1;
          failReceipts += 1;
        });
        // defaultReloadHttpRunner 每次 send 对每文件恰 1 次请求;失败=每文件
        // 1 条 failed 回执,无重试放大
        expect(failSummary.receipts.length).toBe(failFiles.length);
        expect(failAttempts - attemptsBefore).toBe(failFiles.length);

        // ④ 空闲态 socket 采样(keepAlive 池,单主机应保持 ~1 条)
        await sleep(30);
        const idle = liveTcpSockets();
        socketSamples.push(idle);
        maxIdleSockets = Math.max(maxIdleSockets, idle);

        windows += 1;
        // 窗节奏:下一窗锚点推进,不因本窗耗时漂移(稳态交互形态)
        nextWindow += WINDOW_MS;
        const pad = nextWindow - Date.now();
        if (pad > 0) {
          await sleep(pad);
        }
      }

      // 收尾:流水线排空 + 断言四闸
      await sleep(400);
      const heapGrowthMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
      const gcApplied = maybeGc();
      const heapGrowthGcMb = gcApplied
        ? (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024
        : heapGrowthMb;

      emit(
        `HRSOAK-METRIC heapGrowthMb n=1 ${Math.round(heapGrowthMb * 100) / 100} ` +
          `heapGrowthGcMb=${Math.round(heapGrowthGcMb * 100) / 100} gcApplied=${gcApplied ? 1 : 0}`
      );
      emit(
        `HRSOAK-METRIC sockets n=${socketSamples.length} ` +
          `p50=${percentile(socketSamples, 0.5)} p95=${percentile(socketSamples, 0.95)} ` +
          `p99=${percentile(socketSamples, 0.99)} max=${Math.max(...socketSamples)}`
      );
      emit(
        `HRSOAK-SUMMARY windows=${windows} wall=${Date.now() - windowStart}ms ` +
          `watchersLive=${liveWatchers} watchersCreated=${createdWatchers} ` +
          `watchersDisposed=${disposedWatchers} offered=${offered} emitted=${emitted} ` +
          `okReceipts=${okReceipts} failReceipts=${failReceipts} ` +
          `heapGrowthGcMb=${Math.round(heapGrowthGcMb * 100) / 100} ` +
          `socketBaseline=${socketBaseline} maxIdleSockets=${maxIdleSockets}`
      );

      // 四闸(结构性,不钉墙钟)
      // ① watcher 不泄漏:存活句柄=根数,创建==释放+根数
      expect(liveWatchers, `watcher 泄漏:末态存活 ${liveWatchers}`).toBe(roots.length);
      expect(disposedWatchers).toBe(createdWatchers - roots.length);
      // ② 状态增长无界:gc 后堆增量 < 界;流水线每窗排空(offered==emitted)
      expect(heapGrowthGcMb, `堆增长 ${heapGrowthGcMb}MB ≥ 界 ${HEAP_CEILING_MB}MB`).toBeLessThan(
        HEAP_CEILING_MB
      );
      expect(emitted, `流水线积压:emitted ${emitted} ≠ offered ${offered}`).toBe(offered);
      // ③ 连接泄漏:空闲态 socket ≤ 基线+松弛(keepAlive 单主机 ~1 条,不线性累积)
      expect(
        maxIdleSockets,
        `连接泄漏:空闲态 socket ${maxIdleSockets} > 基线 ${socketBaseline}+${SOCKET_SLACK}`
      ).toBeLessThanOrEqual(socketBaseline + SOCKET_SLACK);
      // ④ 错误不风暴:失败臂每文件每窗恰 1 次,错误总数=窗数×失败文件数
      expect(failReceipts).toBe(windows * failFileCount);
    },
    SOAK_SECONDS * 1000 + 600000
  );
});
