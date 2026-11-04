import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { KodeCoreClient, KodeCoreTransportError } from '../src/kodeCoreClient';

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
    expect(Date.now() - startedAt).toBeLessThan(2000);
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
    expect(Date.now() - startedAt).toBeLessThan(1500); // 正常路径不等超时窗
    expect(await exitCode).toBe(0); // shutdown→exit 协议走完的优雅退出
    expect(client.childProcess).toBeNull();
  }, 10_000);

  it('KodeCoreTransportError 携带分类码', () => {
    const error = new KodeCoreTransportError('boom', 'BAD_FRAME');
    expect(error.name).toBe('KodeCoreTransportError');
    expect(error.code).toBe('BAD_FRAME');
  });
});
