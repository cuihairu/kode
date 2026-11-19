import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { afterAll, describe, expect, it } from 'vitest';

import { KodeCoreClient, KodeCoreTransportError, type KodeCoreInitializeResult } from '../src/backend/kodeCoreClient';

// kode2 PR-003:BUILD-005 最小 transport 单测(fake stdio server,无 Rust 依赖)。
// 真实二进制握手 e2e 在 tests/kodeCoreE2E.test.ts。

const FAKE_SERVER = join(__dirname, 'helpers', 'kodeFakeServer.cjs');
const URI = 'file:///workspace/demo/entities/Monster.def';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function makeClient(
  extra: Partial<ConstructorParameters<typeof KodeCoreClient>[0]> = {}
): KodeCoreClient {
  return new KodeCoreClient({
    binaryPath: process.execPath,
    args: [FAKE_SERVER],
    ...extra,
  });
}

describe('kodeCoreClient transport(fake stdio server)', () => {
  const clients: KodeCoreClient[] = [];
  afterAll(async () => {
    for (const client of clients) {
      await client.dispose().catch(() => undefined);
    }
  });

  function tracked(client: KodeCoreClient): KodeCoreClient {
    clients.push(client);
    return client;
  }

  it('initialize 握手:serverInfo/capabilities 协商', async () => {
    const client = tracked(makeClient());
    const result = await client.start();
    expect(result.serverInfo.name).toBe('kode-fake-server');
    expect(result.capabilities.textDocumentSync.openClose).toBe(true);
    expect(result.capabilities.textDocumentSync.change).toBe(1);
    await client.dispose();
  }, 10_000);

  it('RUST-008 版本门:握手回包版本不一致 → PROTOCOL_VERSION_MISMATCH,子进程被杀、client 可再 spawn', async () => {
    const client = tracked(makeClient({ args: [FAKE_SERVER, 'wrongVersion'] }));
    const error = await client.start().then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(KodeCoreTransportError);
    expect((error as KodeCoreTransportError).code).toBe('PROTOCOL_VERSION_MISMATCH');
    expect((error as Error).message).toContain('0.2.0');
    // 子进程已被杀(不留一个只会说旧协议的进程挂着);client 本体未 disposed,
    // 换上版本一致的二进制后下一次 start() 可自然恢复——复用假替身验证可再 spawn。
    expect(client.childProcess).toBeNull();
    const recovered = tracked(makeClient());
    await expect(recovered.start()).resolves.toMatchObject({
      serverInfo: { version: '0.2.0' }
    });
    await recovered.dispose();
  }, 10_000);

  it('RUST-TRACK-FREEZE-007 握手按代缓存:同代重复 start() 不再重发 initialize(镜像/服务热路径)', async () => {
    const client = tracked(makeClient({ args: [FAKE_SERVER, 'countInitialize'] }));
    const first = await client.start();
    const second = await client.start();
    const third = await client.start();
    // 缓存命中:直接返回同一握手结果对象,零 RPC
    expect(second).toBe(first);
    expect(third).toBe(first);
    const count = (await client.request('kode/initCount')) as { initializeRequests: number };
    expect(count.initializeRequests).toBe(1);
    await client.dispose();
  }, 10_000);

  it('RUST-TRACK-FREEZE-007 缓存跨代失效:崩溃自动重启后重新握手,重启后的 start() 又走缓存', async () => {
    let resolveRestart!: (generation: number) => void;
    const restarted = new Promise<number>(resolve => {
      resolveRestart = resolve;
    });
    const client = tracked(
      makeClient({ args: [FAKE_SERVER, 'triggerCrash', 'countInitialize'], onRestart: resolveRestart })
    );
    await client.start();
    await expect(client.request('triggerCrash')).rejects.toMatchObject({ code: 'EXITED' });
    await expect(restarted).resolves.toBe(1);
    // 重启路径已对新进程握手(新进程 initialize=1);随后 start() 必须命中
    // 新代缓存而非重发握手——否则 initializeRequests 变 2。
    const cached = await client.start();
    expect(cached.serverInfo.version).toBe('0.2.0');
    const count = (await client.request('kode/initCount')) as { initializeRequests: number };
    expect(count.initializeRequests).toBe(1);
    await client.dispose();
  }, 15_000);

  it('request_id 贯穿 + didOpen/didChange/didClose 全生命周期', async () => {
    const client = tracked(makeClient());
    await client.start();
    client.openDocument(URI, 'kbengine-def', 1, '<Entity/>');
    client.changeDocument(URI, 2, '<Entity><GroupName>mob</GroupName></Entity>');
    expect((await client.health()).documents).toEqual([{ uri: URI, version: 2 }]);
    client.closeDocument(URI);
    expect((await client.health()).documents).toEqual([]);
    await client.dispose();
  }, 10_000);

  it('cancel:挂起的 $/kode/wait 被取消并回 -32800(REQUEST_CANCELLED)', async () => {
    const client = tracked(makeClient());
    await client.start();
    const request = client.request('$/kode/wait', { ms: 5000 });
    await sleep(150); // 等服务器注册 wait
    const startedAt = Date.now();
    request.cancel();
    await expect(request).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    // 取消后通道仍可用
    expect(await client.health()).toMatchObject({ status: 'ok' });
    await client.dispose();
  }, 10_000);

  it('崩溃重启:意外退出后自动 respawn + 重握手,restartGeneration +1', async () => {
    let resolveRestart!: (generation: number) => void;
    const restarted = new Promise<number>(resolve => {
      resolveRestart = resolve;
    });
    const client = tracked(
      makeClient({ args: [FAKE_SERVER, 'triggerCrash'], onRestart: resolveRestart })
    );
    await client.start();
    await expect(client.request('triggerCrash')).rejects.toMatchObject({ code: 'EXITED' });
    await expect(restarted).resolves.toBe(1);
    expect(client.restartGeneration).toBe(1);
    // 新进程健康可请求
    expect(await client.request('kode/pid')).toMatchObject({ pid: expect.any(Number) });
    expect(client.childProcess).not.toBeNull();
    await client.dispose();
  }, 15_000);

  it('请求正常完成后清理 cancelTimer,对已完成 id 无迟到 $/cancelRequest(CORE-2)', async () => {
    const client = tracked(makeClient({ args: [FAKE_SERVER, 'traceCancels'] }));
    await client.start();
    // 请求在 timeoutMs 内正常完成:修复前 cancelTimer 保留至 300ms 触发,
    // 对已完成 id 发迟到取消;修复后在 resolve 时即被清理
    await client.request('kode/pid', undefined, { timeoutMs: 300 });
    await sleep(600); // 越过 cancelTimer 触发点
    // 真正挂起的请求仍按超时取消(超时路径不受影响)
    const slow = client.request('$/kode/wait', { ms: 5000 }, { timeoutMs: 300 });
    await expect(slow).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    const cancels = (await client.request('kode/cancels')) as { ids: number[] };
    expect(cancels.ids).toHaveLength(1); // 只有挂起 wait 被取消,无迟到取消
    await client.dispose();
  }, 10_000);

  it('重启握手失败后杀掉未初始化进程,后续请求得 EXITED 而非 SERVER_ERROR(CORE-3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kode-fake-handshake-'));
    const markerPath = join(dir, 'crashed.marker');
    try {
      const client = tracked(
        makeClient({
          // triggerCrash 崩溃时写标记;respawn 出的新进程 initialize 看到标记
          // 回 -32002(对齐 kode-server/src/server.rs 未初始化态)→ 握手失败
          args: [FAKE_SERVER, 'triggerCrash', 'failHandshakeAfterCrash', `markerPath=${markerPath}`],
        })
      );
      await client.start(); // 首次握手成功(标记尚不存在)
      await expect(client.request('triggerCrash')).rejects.toMatchObject({ code: 'EXITED' });
      // 修复前:握手失败只记 stderr,child 非 null 且永不清理 → 此处超时失败
      const deadline = Date.now() + 5000;
      while (client.childProcess !== null && Date.now() < deadline) {
        await sleep(20);
      }
      expect(client.childProcess).toBeNull();
      expect(client.restartGeneration).toBe(1); // 只重启一次,不循环 respawn
      expect(client.recentStderr.some(line => line.includes('restart handshake failed'))).toBe(true);
      // 错误语义正确:EXITED(服务不可用),而非误导性 SERVER_ERROR(-32002)
      await expect(client.request('kode/pid')).rejects.toMatchObject({ code: 'EXITED' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('重启窗口耗尽后放弃重启,后续请求立即失败不悬挂', async () => {
    const client = tracked(
      makeClient({ args: [FAKE_SERVER, 'triggerCrash'], restart: { maxRestarts: 1, windowMs: 10_000 } })
    );
    await client.start();
    // 第一次崩溃:窗口内,重启
    await expect(client.request('triggerCrash')).rejects.toMatchObject({ code: 'EXITED' });
    const restartedAt = Date.now();
    while (client.restartGeneration < 1 && Date.now() - restartedAt < 5000) {
      await sleep(20);
    }
    expect(client.restartGeneration).toBe(1);
    // 第二次崩溃:超出 maxRestarts=1,放弃重启
    await expect(client.request('triggerCrash')).rejects.toBeInstanceOf(Error);
    await sleep(300);
    expect(client.restartGeneration).toBe(1);
    expect(client.childProcess).toBeNull();
    await expect(client.request('kode/pid')).rejects.toMatchObject({ code: 'EXITED' });
  }, 15_000);

  it('dispose 后请求以 DISPOSED 拒绝,子进程被回收', async () => {
    const client = tracked(makeClient());
    await client.start();
    expect(await client.request('kode/pid')).toMatchObject({ pid: expect.any(Number) });
    await client.dispose();
    await expect(client.health()).rejects.toMatchObject({ code: 'DISPOSED' });
    expect(client.childProcess).toBeNull();
  }, 10_000);

  it('dispose:server 挂死(shutdown 永不回包)时按超时 SIGKILL,不永久挂起(CORE-1 路径1)', async () => {
    const client = tracked(
      makeClient({ args: [FAKE_SERVER, 'hangShutdown'], shutdownTimeoutMs: 300 })
    );
    await client.start();
    const { pid } = (await client.request('kode/pid')) as { pid: number };
    const startedAt = Date.now();
    await client.dispose();
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(250); // 走满超时窗,而非立即返回
    expect(elapsed).toBeLessThan(2000); // 且有界,不吃到默认 5s/无超时挂死
    expect(client.childProcess).toBeNull();
    // 子进程确已被 SIGKILL:pid 不复存在(ESRCH)
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  }, 10_000);

  it('dispose:shutdown 等待期间子进程自行退出(exit 竞态)不挂起(CORE-1 路径2)', async () => {
    const client = tracked(makeClient({ args: [FAKE_SERVER, 'exitOnShutdown'] }));
    await client.start();
    const startedAt = Date.now();
    await client.dispose();
    // 不吃满默认 shutdown 超时:exit 事件已被 handleExit 消费,守卫直接完成
    // (win32 进程终止链路慢 ~2.5s,平台化阈值)
    expect(Date.now() - startedAt).toBeLessThan(process.platform === 'win32' ? 5000 : 2000);
    expect(client.childProcess).toBeNull();
    // disposed 状态下意外退出不触发崩溃重启
    expect(client.restartGeneration).toBe(0);
  }, 10_000);

  it('dispose:正常 shutdown 路径不受守卫影响,子进程优雅退出(exit code 0)', async () => {
    const client = tracked(makeClient());
    await client.start();
    const child = client.childProcess!;
    const exitCode = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    const startedAt = Date.now();
    await client.dispose();
    expect(Date.now() - startedAt).toBeLessThan(process.platform === 'win32' ? 4000 : 1500); // 正常路径不等超时窗(win32 终止链路慢,平台化阈值)
    expect(await exitCode).toBe(0); // shutdown→exit 协议走完的优雅退出
    expect(client.childProcess).toBeNull();
  }, 10_000);

  it('KBUG-ROOT: initializeParams.workspaceFolders 随握手上行(根归属参数)', async () => {
    const client = tracked(
      makeClient({
        initializeParams: {
          processId: 1,
          capabilities: {},
          workspaceFolders: [
            { uri: 'file:///ws/alpha', name: 'alpha' },
            { uri: 'file:///ws/beta', name: 'beta' },
          ],
        },
      })
    );
    const result = (await client.start()) as KodeCoreInitializeResult & {
      receivedWorkspaceFolders: { uri: string; name?: string }[] | null;
    };
    // 替身服务器把收到的 workspaceFolders 回显:证明参数真的随 initialize 上行
    expect(result.receivedWorkspaceFolders).toEqual([
      { uri: 'file:///ws/alpha', name: 'alpha' },
      { uri: 'file:///ws/beta', name: 'beta' },
    ]);
  }, 10_000);

  it('RUST-025 RPC 字节流量:JSON body 双向计数,随请求/响应增长', async () => {
    const client = tracked(makeClient());
    await client.start();
    // 握手一来一回,两个方向都已有量
    const afterStart = client.rpcTraffic;
    expect(afterStart.bytesOut).toBeGreaterThan(0);
    expect(afterStart.bytesIn).toBeGreaterThan(0);
    // 一轮真实 RPC(delayRpc=0 替身回 {ret:{...}} 面):双向各增
    const rpcClient = tracked(makeClient({ args: [FAKE_SERVER, 'delayRpc=0'] }));
    await rpcClient.start();
    const before = rpcClient.rpcTraffic;
    const face = (await rpcClient.request('$/kode/rpc', {
      method: '$/kode/python/localReturnType',
      params: { lines: ['data = build()'], hoverLine: 0, word: 'data' }
    })) as { ret?: { annotation?: string } | null };
    expect(face.ret?.annotation).toBe('DATA');
    const after = rpcClient.rpcTraffic;
    expect(after.bytesOut).toBeGreaterThan(before.bytesOut);
    expect(after.bytesIn).toBeGreaterThan(before.bytesIn);
    await client.dispose();
    await rpcClient.dispose();
  }, 10_000);

  it('KodeCoreTransportError 携带分类码', () => {
    const error = new KodeCoreTransportError('boom', 'BAD_FRAME');
    expect(error.name).toBe('KodeCoreTransportError');
    expect(error.code).toBe('BAD_FRAME');
  });

  it('RUST-068-W: $/kode/rpc 信封带 spanId(hex16),内层 params 原样', async () => {
    const client = tracked(makeClient({ args: [FAKE_SERVER, 'echoParams'] }));
    await client.start();
    const result = (await client.request('$/kode/rpc', {
      method: 'echoInner',
      params: { lines: ['SECRETPAYLOAD'], queryLine: 1 },
    })) as {
      envelope: { method: string; params: Record<string, unknown>; spanId?: unknown };
    };
    // 信封顶层新增 spanId;内层 method/params 原样(worker 契约零感知)
    expect(result.envelope.method).toBe('echoInner');
    expect(result.envelope.params).toEqual({ lines: ['SECRETPAYLOAD'], queryLine: 1 });
    expect(result.envelope.spanId).toMatch(/^[0-9a-f]{16}$/);
    await client.dispose();
  }, 10_000);

  it('RUST-068-W: 非 $/kode/rpc 顶层请求不注入 spanId(LSP 标准面零污染)', async () => {
    const client = tracked(makeClient({ args: [FAKE_SERVER, 'echoParams'] }));
    await client.start();
    const result = (await client.request('kode/echoTop', { y: 2 })) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(result.method).toBe('kode/echoTop');
    expect(result.params).toEqual({ y: 2 });
    expect(JSON.stringify(result)).not.toContain('spanId');
    await client.dispose();
  }, 10_000);

  it('RUST-068-W: onTrace send/done 同 span,并发请求不串 span,params 不进日志', async () => {
    const lines: string[] = [];
    const client = tracked(
      makeClient({
        args: [FAKE_SERVER, 'echoParams'],
        onTrace: line => lines.push(line),
      })
    );
    await client.start();
    const r1 = client.request('$/kode/rpc', { method: 'm1', params: { tag: 'SECRETPAYLOAD' } });
    const r2 = client.request('$/kode/rpc', { method: 'm2', params: {} });
    await Promise.all([r1, r2]);
    const sendLines = lines.filter(l => l.includes(' $/kode/rpc send '));
    expect(sendLines).toHaveLength(2);
    const spans = sendLines.map(l => /\(span=([0-9a-f]{16})\)/.exec(l)?.[1]);
    expect(spans[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(spans[1]).toMatch(/^[0-9a-f]{16}$/);
    expect(spans[0]).not.toBe(spans[1]);
    // 每个请求的 done 行与其 send 行同 span(跨 send→done 端到端可追踪)
    for (const span of spans) {
      expect(lines.some(l => l.includes(` $/kode/rpc done (span=${span})`))).toBe(true);
    }
    // 脱敏:params 内容(SECRETPAYLOAD)绝不进追踪行
    expect(lines.join('\n')).not.toContain('SECRETPAYLOAD');
    await client.dispose();
  }, 10_000);

  it('RUST-068-W: 取消请求的追踪行带同请求 span', async () => {
    const lines: string[] = [];
    const client = tracked(
      makeClient({ args: [FAKE_SERVER, 'traceCancels'], onTrace: line => lines.push(line) })
    );
    await client.start();
    const request = client.request('$/kode/wait', { ms: 5000 });
    await sleep(150); // 等服务器注册 wait
    request.cancel();
    await expect(request).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    const sendLine = lines.find(l => l.includes(' $/kode/wait send '));
    const cancelLine = lines.find(l => l.includes(' cancel sent '));
    expect(sendLine).toBeTruthy();
    expect(cancelLine).toBeTruthy();
    const sendSpan = /\(span=([0-9a-f]{16})\)/.exec(sendLine ?? '')?.[1];
    const cancelSpan = /\(span=([0-9a-f-]+)\)/.exec(cancelLine ?? '')?.[1];
    expect(sendSpan).toMatch(/^[0-9a-f]{16}$/);
    expect(cancelSpan).toBe(sendSpan);
    await client.dispose();
  }, 10_000);
});
