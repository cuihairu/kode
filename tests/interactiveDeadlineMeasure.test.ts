import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { KODE_PROTOCOL_VERSION, KodeCoreClient } from '../src/backend/kodeCoreClient';
import { KodeCoreGate } from '../src/backend/kodeCoreGate';
import {
  awaitWithInteractiveBudget,
  serveHoverFromRust,
  setKodeCoreShadowGate
} from '../src/backend/kodeCoreShadowFaces';
import { KBEngineHoverProvider } from '../src/languageProviders/hover';
import { Position, makeTextDocument } from './helpers/vscodeStub';

// QA-004(旧 KSEM-QA-04)交互截止与降级测量:①真实二进制热态下分段计时
// (镜像 IPC / 查询 IPC / 面提取)采样并断言 P99 低于交互预算
// INTERACTIVE_SERVE_BUDGET_MS=2000 —— 预算=设计截止,样本全量进分位数,
// 不挑最快一轮;rust 内部解析/查询细分无回传字段,诚实合并在查询段。
// ②存活但无响应真实超时:假服务器握手后永不回 → request 以 TIMEOUT 拒绝
// (KBUG-TIME-02 硬超时),两次挂起无 EXITED = 进程仍存活;③取消真传播:
// 假服务器仅在收到 $/cancelRequest 时回 -32800,错误包到达即证明取消经
// 传输层传播(CORE-007),拒绝码 REQUEST_CANCELLED,非客户端本地伪造;
// ④预算到期真实放弃 rust 等待回 null(降级),败方 promise 挂 catch 吞迟到
// 结算,不产生 unhandled rejection(KBUG-TIME-03/04)。二进制缺失时跳过
// (与 kodeCoreServingE2E 同口径)。阈值预登记:P99 三段一律 < 2000(交互
// 预算语义),实测明细落 docs/perf/2026-11-18-interactive-deadline-measure.md。
const repoRoot = join(__dirname, '..');
const serverBinary = join(repoRoot, 'target', 'debug', 'kode-server');
const deadServerHelper = join(__dirname, 'helpers', 'kodeDeadServer.cjs');
const DEFA = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets', 'scripts', 'entity_defs', 'Avatar.def');
const SAMPLES = 40;
const INTERACTIVE_BUDGET_MS = 2000;

const suite = existsSync(serverBinary) ? describe : describe.skip;

const defText = () => readFileSync(DEFA, 'utf8');

const hpPos = (text: string): { line: number; character: number } => {
  const lines = text.split('\n');
  const i = lines.findIndex(l => /\bhp\b/.test(l) && !/<Type>|<Flags>|<Default>|<Persistent>/.test(l));
  expect(i, 'def 应含 hp 属性词').toBeGreaterThanOrEqual(0);
  return { line: i, character: lines[i].indexOf('hp') + 1 };
};

function realGate(): { gate: KodeCoreGate; client: KodeCoreClient } {
  const client = new KodeCoreClient({ binaryPath: serverBinary });
  const gate = new KodeCoreGate({ clientFactory: () => client });
  gate.setConfig({ backend: 'rust', serverPath: serverBinary, shadowTimeoutMs: 15000 });
  return { gate, client };
}

function deadClient(mode: 'hang' | 'cancel-ack'): KodeCoreClient {
  // 握手协议版本经 env 传给假服务器(client spawn 继承 process.env)
  process.env.DEAD_PROTOCOL_VERSION = KODE_PROTOCOL_VERSION;
  return new KodeCoreClient({
    binaryPath: process.execPath,
    args: [deadServerHelper, mode],
    startTimeoutMs: 5000,
    shutdownTimeoutMs: 500
  });
}

/** nearest-rank 分位数(输入须升序) */
const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(((sorted.length - 1) * p) / 100))];

const report = (label: string, values: number[]): string => {
  const sorted = [...values].sort((a, b) => a - b);
  return `${label} n=${sorted.length} P50=${percentile(sorted, 50).toFixed(1)} P95=${percentile(sorted, 95).toFixed(1)} P99=${percentile(sorted, 99).toFixed(1)} max=${sorted[sorted.length - 1].toFixed(1)}`;
};

const gates: KodeCoreGate[] = [];
const clients: KodeCoreClient[] = [];
afterEach(() => {
  setKodeCoreShadowGate(null);
});
afterAll(async () => {
  await Promise.all(gates.splice(0).map(gate => gate.dispose().catch(() => undefined)));
  await Promise.all(clients.splice(0).map(client => client.dispose().catch(() => undefined)));
});

suite('kode 交互截止与降级测量(QA-004,真实二进制)', () => {
  it('分段计时采样:热态 hover 镜像/查询/提取三段 P99 均低于交互预算', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const text = defText();
    const pos = hpPos(text);

    // 预热:拉进程 + 建语料环境(冷客户端首请求吃满预算判例,不入样本)
    const warm = await serveHoverFromRust(
      makeTextDocument(text, { fileName: DEFA, languageId: 'kbengine-def', version: 1 }),
      pos
    );
    expect(warm).not.toBeNull();

    const mirrorMs: number[] = [];
    const queryMs: number[] = [];
    const extractMs: number[] = [];
    const totalMs: number[] = [];
    const params = { textDocument: { uri: DEFA }, position: pos };
    for (let i = 0; i < SAMPLES; i++) {
      const version = 2 + i;
      const t0 = performance.now();
      await gate.mirrorDocument(DEFA, 'kbengine-def', version, text);
      const t1 = performance.now();
      const result = await gate.serveInRust<unknown>('textDocument/hover', params, null, { timeoutMs: 15000 });
      const t2 = performance.now();
      const contents = (result as { contents?: { value?: unknown } } | null)?.contents;
      expect(contents && typeof contents.value === 'string', `第 ${i} 轮 hover 应命中`).toBe(true);
      expect(String(contents!.value).length, 'hover 内容非空').toBeGreaterThan(0);
      const t3 = performance.now();
      mirrorMs.push(t1 - t0);
      queryMs.push(t2 - t1);
      extractMs.push(t3 - t2);
      totalMs.push(t3 - t0);
    }
    // 阈值预登记:三段与全链 P99 一律低于交互预算(预算=设计截止)
    for (const [label, values] of [
      ['mirror', mirrorMs],
      ['query', queryMs],
      ['extract', extractMs],
      ['providerTotal', totalMs]
    ] as const) {
      const sorted = [...values].sort((a, b) => a - b);
      expect(
        percentile(sorted, 99),
        `${label} P99=${percentile(sorted, 99).toFixed(1)}ms 应低于交互预算 ${INTERACTIVE_BUDGET_MS}ms`
      ).toBeLessThan(INTERACTIVE_BUDGET_MS);
    }
    console.log(`[qa004] ${report('mirror', mirrorMs)}`);
    console.log(`[qa004] ${report('query', queryMs)}`);
    console.log(`[qa004] ${report('extract', extractMs)}`);
    console.log(`[qa004] ${report('providerTotal', totalMs)}`);
  }, 120_000);

  it('存活但无响应:假服务器握手后挂起,request 以 TIMEOUT 真实拒绝且进程不退出', async () => {
    const client = deadClient('hang');
    clients.push(client);
    await client.start();
    const t0 = performance.now();
    const first = client.request('$/kode/health', undefined, { timeoutMs: 400 });
    await expect(first).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('timed out after 400ms')
    });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(2500);
    // 存活语义:第二次仍挂起 TIMEOUT(若假服务器已退出,client 会以
    // EXITED rejectAll —— 见 spawn error/exit 处理),即进程活着但无响应。
    const second = client.request('$/kode/health', undefined, { timeoutMs: 300 });
    await expect(second).rejects.toMatchObject({ code: 'TIMEOUT' });
  }, 30_000);

  it('取消真传播:$/cancelRequest 到达假服务器后回 -32800,请求以 REQUEST_CANCELLED 拒绝', async () => {
    const client = deadClient('cancel-ack');
    clients.push(client);
    await client.start();
    const t0 = performance.now();
    const pending = client.request('$/kode/health', undefined, { timeoutMs: 8000 });
    setTimeout(() => pending.cancel(), 50);
    await expect(pending).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
      message: expect.stringContaining('-32800')
    });
    // 假服务器仅在收到 $/cancelRequest 时才回 -32800:错误包能在超时窗内
    // 到达,即取消经传输层真实传播(取消不能只改 UI)。
    expect(performance.now() - t0).toBeLessThan(8000);
  }, 30_000);

  it('预算到期降级:超预算真实放弃 rust 等待回 null,迟到结算不产生 unhandled rejection', async () => {
    // 案一:work 3000ms 后结算,budget 300ms —— 300ms 即回 null,不等 work
    let unhandled = 0;
    const listener = (): void => {
      unhandled += 1;
    };
    process.on('unhandledRejection', listener);
    try {
      const t0 = performance.now();
      const value = await awaitWithInteractiveBudget(
        () => new Promise<string>(resolve => setTimeout(() => resolve('late'), 3000)),
        300
      );
      expect(value).toBeNull();
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(1500);
      // 案二:work 迟到 reject 也不产生 unhandled rejection(挂 catch 吞)
      await awaitWithInteractiveBudget(
        () => new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error('late-reject')), 600)),
        200
      );
      await new Promise(resolve => setTimeout(resolve, 900));
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', listener);
    }
  }, 15_000);

  it('provider 全链对照:降级后的 TS 悬停链在预算语义内返回(门未装配)', async () => {
    // 采样臂的 providerTotal 是 rust 轨道全链;此臂钉 TS 降级轨道全链仍
    // 可用(隔离语义不依赖 rust 存活,QA-003 降级臂同向),两轨共享同一
    // 交互预算语义。
    setKodeCoreShadowGate(null);
    const text = defText();
    const pos = hpPos(text);
    const t0 = performance.now();
    const hover = await new KBEngineHoverProvider().provideHoverTimed(
      makeTextDocument(text, { fileName: DEFA, languageId: 'kbengine-def', version: 1 }),
      new Position(pos.line, pos.character)
    );
    const elapsed = performance.now() - t0;
    const contents = (hover as { contents: unknown }).contents;
    const render = Array.isArray(contents)
      ? contents.map(item => (typeof item === 'string' ? item : String((item as { value?: string }).value ?? ''))).join('')
      : typeof contents === 'object' && contents !== null && 'value' in contents
        ? String((contents as { value: string }).value)
        : String(contents);
    expect(render).toContain('hp');
    expect(elapsed).toBeLessThan(INTERACTIVE_BUDGET_MS);
    console.log(`[qa004] tsFallbackTotal n=1 ${elapsed.toFixed(1)}ms`);
  }, 30_000);
});
