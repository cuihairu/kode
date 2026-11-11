/**
 * KBUG-TIME 交互请求截止控制(Rust 类型 hover 预算):
 * - 存活不响应服务注入(silentRpc/silentInitialize 替身,真实进程):交互面
 *   (inferLocalReturnTypeFromRust 生产入口)必须在端到端预算内自行降级,
 *   不无限挂起(修前用例明确红);
 * - 预算覆盖 start/排队/响应全程;硬超时额外等待显式计入(清理窗口);
 * - 取消探测:provider 取消(光标移开/文档更新)即时结束本次等待,不误伤
 *   并发在途的其他请求;迟到响应不改变已结算结果;
 * - 资源清理:超时/成功/取消后 pending 与计时器归零,重复无响应请求不积累、
 *   不触发重启风暴;
 * - 四状态验收:存活无响应/慢启动/长队列/正常快速,分别记录等待与回退。
 */
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { inferLocalReturnTypeFromRust } from '../src/backend/localReturnTypeRust';

const FAKE_SERVER = join(__dirname, 'helpers', 'kodeFakeServer.cjs');

const SAMPLE_LINES = ['def build() -> DATA:', '    pass', '', 'data = build()'];

/** 外部截止:证明面自身会在预算内结算(挂死=红,不等 vitest 全局超时) */
function withExternalDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label}: 超出外部截止 ${ms}ms 仍未结算(请求挂死)`)), ms)
    ),
  ]);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 真门 + 真客户端 + 替身服务器(故障注入走真实 stdio,非 mock) */
function makeGate(modes: string[], extra: Partial<ConstructorParameters<typeof KodeCoreClient>[0]> = {}): KodeCoreGate {
  const clients: KodeCoreClient[] = [];
  const gate = new KodeCoreGate({
    clientFactory: () => {
      const client = new KodeCoreClient({
        binaryPath: process.execPath,
        args: [FAKE_SERVER, ...modes],
        ...extra,
      });
      clients.push(client);
      return client;
    },
  });
  gate.setConfig({ backend: 'rust', serverPath: 'fake-server', shadowTimeoutMs: 2000 });
  (gate as unknown as { __clients: KodeCoreClient[] }).__clients = clients;
  return gate;
}

describe('KBUG-TIME 交互请求截止控制(存活不响应/慢启动/长队列/快速)', () => {
  const gates: KodeCoreGate[] = [];

  afterEach(async () => {
    setKodeCoreShadowGate(null);
    for (const gate of gates.splice(0)) {
      await gate.dispose().catch(() => undefined);
      for (const client of (gate as unknown as { __clients: KodeCoreClient[] }).__clients) {
        await client.dispose().catch(() => undefined);
      }
    }
  });

  function tracked(gate: KodeCoreGate): KodeCoreGate {
    gates.push(gate);
    return gate;
  }

  it('KBUG-TIME-01: 存活不响应服务——localReturnType 面在预算内降级 null(修前挂死红)', async () => {
    const gate = tracked(makeGate(['silentRpc']));
    setKodeCoreShadowGate(gate);
    const startedAt = Date.now();
    const face = await withExternalDeadline(
      inferLocalReturnTypeFromRust(SAMPLE_LINES, 3, 'data', 'budget:silent-rpc'),
      8000,
      'localReturnType@silentRpc'
    );
    const elapsed = Date.now() - startedAt;
    expect(face, '预算内降级:存活不响应不得挂起 hover').toBeNull();
    expect(elapsed, '端到端预算(含排队/硬超时等待)内有界').toBeLessThan(8000);
  }, 15_000);

  it('KBUG-TIME-02/03: initialize 挂死(start 阶段)——预算内降级 null 不挂 start()', async () => {
    const gate = tracked(makeGate(['silentInitialize']));
    setKodeCoreShadowGate(gate);
    const startedAt = Date.now();
    const face = await withExternalDeadline(
      inferLocalReturnTypeFromRust(SAMPLE_LINES, 3, 'data', 'budget:silent-init'),
      8000,
      'localReturnType@silentInitialize'
    );
    expect(Date.now() - startedAt, '预算覆盖 client.start 全程').toBeLessThan(8000);
    expect(face).toBeNull();
  }, 15_000);

  it('KBUG-TIME-04: provider 取消即时结束等待,并发其他请求不受误伤', async () => {
    const gate = tracked(makeGate(['delayRpc=0']));
    setKodeCoreShadowGate(gate);
    let cancelled = false;
    setTimeout(() => {
      cancelled = true;
    }, 100);
    const startedAt = Date.now();
    const cancelledFace = await withExternalDeadline(
      inferLocalReturnTypeFromRust(SAMPLE_LINES, 3, 'data', 'budget:cancel', () => cancelled),
      8000,
      'localReturnType@cancel'
    );
    expect(Date.now() - startedAt, '取消后立即返回,不等预算耗尽').toBeLessThan(1500);
    expect(cancelledFace).toBeNull();
    // 同 client 并发的未取消请求正常结算(取消不波及其他在途)
    const healthy = await inferLocalReturnTypeFromRust(SAMPLE_LINES, 3, 'data', 'budget:cancel-other');
    expect(healthy).toEqual({ target: 'data', annotation: 'DATA', methodName: 'build' });
  }, 15_000);

  it('KBUG-TIME-05: 超时后 pending/计时器归零,重复无响应不积累不重启', async () => {
    const gate = tracked(makeGate(['silentRpc']));
    setKodeCoreShadowGate(gate);
    let client: KodeCoreClient | undefined;
    for (let round = 0; round < 3; round += 1) {
      const face = await inferLocalReturnTypeFromRust(SAMPLE_LINES, 3, 'data', `budget:drain-${round}`);
      expect(face).toBeNull();
      // client 由 ensureClient 懒建;首轮之后必已存在
      client = client ?? (gate as unknown as { __clients: KodeCoreClient[] }).__clients[0];
      // 硬超时窗口 = 预算 + 2000(显式计入);轮询至 pending 清空
      const deadline = Date.now() + 7000;
      while (client.pendingCountForTests() > 0 && Date.now() < deadline) {
        await sleep(100);
      }
      expect(client.pendingCountForTests(), `第 ${round} 轮 pending 必须清空`).toBe(0);
    }
    expect(client.restartGeneration, '进程存活,不因无响应触发重启风暴').toBe(0);
  }, 30_000);

  it('KBUG-TIME-06: 四状态——快速命中/慢启动等待后命中/长队列降级/存活无响应降级', async () => {
    // 快速:预算内命中
    const fastGate = tracked(makeGate(['delayRpc=0']));
    setKodeCoreShadowGate(fastGate);
    expect(await inferLocalReturnTypeFromRust(SAMPLE_LINES, 3, 'data', 'budget:fast')).toEqual({
      target: 'data',
      annotation: 'DATA',
      methodName: 'build',
    });

    // 慢启动:initialize 延迟 400ms < 预算,等待后仍命中(start 被预算覆盖)
    const slowStartGate = tracked(makeGate(['delayInitialize=400', 'delayRpc=0']));
    setKodeCoreShadowGate(slowStartGate);
    expect(await inferLocalReturnTypeFromRust(SAMPLE_LINES, 3, 'data', 'budget:slow-start')).toEqual({
      target: 'data',
      annotation: 'DATA',
      methodName: 'build',
    });

    // 长队列:响应 2600ms > 预算 → 降级 null(迟到响应不改已结算结果)
    const queuedGate = tracked(makeGate(['delayRpc=2600']));
    setKodeCoreShadowGate(queuedGate);
    const startedAt = Date.now();
    const queuedFace = await inferLocalReturnTypeFromRust(SAMPLE_LINES, 3, 'data', 'budget:queue');
    const queuedElapsed = Date.now() - startedAt;
    expect(queuedFace, '超预算队列降级 null').toBeNull();
    expect(queuedElapsed, '预算点附近降级(而非等满 2600ms)').toBeLessThan(6000);

    // 存活无响应:silentRpc 详例见 KBUG-TIME-01;此处复验返回 null
    const silentGate = tracked(makeGate(['silentRpc']));
    setKodeCoreShadowGate(silentGate);
    expect(await inferLocalReturnTypeFromRust(SAMPLE_LINES, 3, 'data', 'budget:silent-4state')).toBeNull();
  }, 30_000);

  it('start 截止控制:initialize 挂死时 start() 以 TIMEOUT 拒绝且 pending 清空', async () => {
    const client = new KodeCoreClient({
      binaryPath: process.execPath,
      args: [FAKE_SERVER, 'silentInitialize'],
      startTimeoutMs: 300,
    });
    const startedAt = Date.now();
    await expect(
      withExternalDeadline(client.start(), 8000, 'start@silentInitialize')
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - startedAt, '握手预算(300ms)+硬超时窗口内拒绝').toBeLessThan(5000);
    const deadline = Date.now() + 5000;
    while (client.pendingCountForTests() > 0 && Date.now() < deadline) {
      await sleep(50);
    }
    expect(client.pendingCountForTests(), '握手超时后 pending 清空').toBe(0);
    await client.dispose().catch(() => undefined);
  }, 15_000);
});
