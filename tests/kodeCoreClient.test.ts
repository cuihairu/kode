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

  it('KodeCoreTransportError 携带分类码', () => {
    const error = new KodeCoreTransportError('boom', 'BAD_FRAME');
    expect(error.name).toBe('KodeCoreTransportError');
    expect(error.code).toBe('BAD_FRAME');
  });
});
