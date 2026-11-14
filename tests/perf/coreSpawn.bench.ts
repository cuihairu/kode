import { appendFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { KodeCoreClient, KODE_PROTOCOL_VERSION } from '../../src/backend/kodeCoreClient';

// RUST-022 Core spawn/handshake 分段时延(此前 PERF-005 记 Untested,理由
// 「Rust Core 不存在」;2026-11-08 直接切 rust 后该段可测)。量测:
//   start.total   = 全新 client start()(spawn 进程+initialize 握手合计)
//   echo.rtt      = 暖进程 $/kode/echo 纯传输往返
//   localReturn.rtt = 暖进程 $/kode/python/localReturnType 真实分析往返
//   handshake ≈ start.total.p50 − echo.rtt.p50(推导值,诚实标注 derived)
// 输出 CORE-METRIC 前缀落 docs/perf/core-spawn-run.txt(KODE_CORE_OUT 可覆盖,
// emit 纪律同 v02Baseline)。二进制缺失=describe.skip(与 kodeCoreServingE2E
// 同口径,单测基线不背工具链依赖)。

const repoRoot = join(__dirname, '..', '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const suite = existsSync(binaryPath) ? describe : describe.skip;

const OUT_FILE = process.env.KODE_CORE_OUT
  ?? join(repoRoot, 'docs', 'perf', 'core-spawn-run.txt');
const emit = (line: string): void => {
  appendFileSync(OUT_FILE, line + '\n');
};

const percentile = (samples: number[], rank: number): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
};

suite('Core spawn/handshake 分段时延(RUST-022,真实二进制)', () => {
  const clients: KodeCoreClient[] = [];

  afterAll(async () => {
    await Promise.all(clients.map(client => client.dispose().catch(() => undefined)));
  });

  const freshClient = (): KodeCoreClient => {
    const client = new KodeCoreClient({ binaryPath });
    clients.push(client);
    return client;
  };

  it('start.total(spawn+握手)五连采样 + 握手版本对账', async () => {
    writeFileSync(OUT_FILE, '');
    const samples: number[] = [];
    let serverVersion = '';
    for (let i = 0; i < 5; i += 1) {
      const client = freshClient();
      const t0 = performance.now();
      const result = await client.start();
      samples.push(performance.now() - t0);
      serverVersion = result.serverInfo?.version ?? '';
    }
    emit(`CORE-METRIC start.total(spawn+handshake) n=${samples.length} `
      + `p50=${percentile(samples, 0.5)}ms p95=${percentile(samples, 0.95)}ms `
      + `p99=${percentile(samples, 0.99)}ms max=${percentile(samples, 1)}ms`);
    // 正确性闸:握手返回的协议版本必须与扩展侧一致(RUST-008 版本门)
    expect(serverVersion).toBe(KODE_PROTOCOL_VERSION);
  }, 120_000);

  it('echo.rtt 暖进程纯传输往返二十连采样', async () => {
    const client = freshClient();
    await client.start();
    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      // echo 是内层 registry 方法,须经 $/kode/rpc 包装(server.rs 外层
      // match 只收 initialize/shutdown/health/wait/rpc/hover/...)
      const echoed = (await client.request('$/kode/rpc', {
        method: '$/kode/echo',
        params: { seq: i, blob: 'x'.repeat(256) }
      })) as { seq?: number };
      samples.push(performance.now() - t0);
      expect(echoed.seq).toBe(i);
    }
    emit(`CORE-METRIC echo.rtt(warm transport) n=${samples.length} `
      + `p50=${percentile(samples, 0.5)}ms p95=${percentile(samples, 0.95)}ms `
      + `p99=${percentile(samples, 0.99)}ms max=${percentile(samples, 1)}ms`);
  }, 120_000);

  it('localReturn.rtt 暖进程真实分析往返十连采样', async () => {
    const client = freshClient();
    await client.start();
    // 已验证可推导样本形(Rust local_return 自测 module_def_call_annotation_hit
    // 同款):同文件 def `-> Repo` 注解经调用点落到 data
    const lines = [
      'def make_repo() -> Repo:',
      '    return None',
      '',
      'data = make_repo()'
    ];
    const samples: number[] = [];
    let faceSeen = false;
    for (let i = 0; i < 10; i += 1) {
      const t0 = performance.now();
      // 出参形状 {ret: null | {target, annotation, methodName}}(local_return.rs 契约)
      const response = (await client.request('$/kode/rpc', {
        method: '$/kode/python/localReturnType',
        params: { lines, hoverLine: 3, word: 'data' }
      })) as { ret?: { annotation?: string } | null };
      samples.push(performance.now() - t0);
      if (response.ret?.annotation) {
        faceSeen = true;
      }
    }
    emit(`CORE-METRIC localReturn.rtt(warm analysis) n=${samples.length} `
      + `p50=${percentile(samples, 0.5)}ms p95=${percentile(samples, 0.95)}ms `
      + `max=${percentile(samples, 1)}ms faceSeen=${faceSeen ? 1 : 0}`);
    // 可推导样本必须出 face(同文件 `thing = Widget()` → return thing)
    expect(faceSeen).toBe(true);
  }, 120_000);

  it('handshake 推导段:start.p50 − echo.p50(derived,诚实标注)', async () => {
    const client = freshClient();
    const t0 = performance.now();
    await client.start();
    const startTotal = performance.now() - t0;
    const echoSamples: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const t1 = performance.now();
      await client.request('$/kode/rpc', { method: '$/kode/echo', params: { seq: i } });
      echoSamples.push(performance.now() - t1);
    }
    const derivedHandshake = startTotal - percentile(echoSamples, 0.5);
    emit(`CORE-METRIC handshake(derived=start.p50-echo.p50) n=1 `
      + `startTotal=${Math.round(startTotal * 100) / 100}ms `
      + `echo.p50=${percentile(echoSamples, 0.5)}ms derived=${Math.round(derivedHandshake * 100) / 100}ms`);
    // 诚实下界:推导值非负(握手占 start.total 的主导份额)
    expect(derivedHandshake).toBeGreaterThan(0);
  }, 120_000);
});
