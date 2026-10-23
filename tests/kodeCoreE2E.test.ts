import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { KodeCoreClient } from '../src/kodeCoreClient';

// kode2 PR-003 e2e(PH1-02,书 §15):真实 Rust kode-server 二进制。
// 握手 → didOpen/didChange/didClose → cancel → 健康探针 → kill 后自动重启。
// 二进制缺失时现场 cargo build(debug);无 Rust 工具链的环境跳过本套件
// (单测基线不背工具链依赖)。

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const URI = 'file:///workspace/demo/entities/Monster.def';

if (!existsSync(binaryPath)) {
  spawnSync('cargo', ['build', '-p', 'kode-server'], { cwd: repoRoot, timeout: 300_000 });
}
const binaryReady = existsSync(binaryPath);

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value: T | undefined;
    try {
      value = await probe();
    } catch {
      // 探针失败(进程切换间隙)继续重试
    }
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await sleep(50);
  }
}

const suite = binaryReady ? describe : describe.skip;

suite('kode core e2e(真实 kode-server 二进制)', () => {
  const clients: KodeCoreClient[] = [];
  afterAll(async () => {
    for (const client of clients) {
      await client.dispose().catch(() => undefined);
    }
  });

  function makeClient(): KodeCoreClient {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined,
    });
    clients.push(client);
    return client;
  }

  it(
    '握手:initialize 协商 serverInfo/capabilities',
    async () => {
      const client = makeClient();
      const result = await client.start();
      expect(result.serverInfo.name).toBe('kode-server');
      expect(result.serverInfo.version).toBe('0.2.0');
      expect(result.capabilities.textDocumentSync).toEqual({ openClose: true, change: 1 });
      await client.dispose();
    },
    20_000
  );

  it(
    '文档生命周期:didOpen → didChange → health 对账 → didClose',
    async () => {
      const client = makeClient();
      await client.start();
      client.openDocument(URI, 'kbengine-def', 1, '<Entity/>');
      let health = await client.health();
      expect(health.status).toBe('ok');
      expect(health.initialized).toBe(true);
      expect(health.documents).toEqual([{ uri: URI, version: 1 }]);

      client.changeDocument(URI, 7, '<Entity><GroupName>mob</GroupName></Entity>');
      health = await client.health();
      expect(health.documents).toEqual([{ uri: URI, version: 7 }]);
      expect(health.pid).toBeGreaterThan(0);
      expect(health.serverVersion).toBe('0.2.0');

      client.closeDocument(URI);
      expect((await client.health()).documents).toEqual([]);
      await client.dispose();
    },
    20_000
  );

  it(
    'cancel:5s 的 $/kode/wait 在 ~0.2s 内被取消,错误码 -32800',
    async () => {
      const client = makeClient();
      await client.start();
      const request = client.request('$/kode/wait', { ms: 5000 });
      await sleep(200); // 等服务器进入 wait 循环
      const startedAt = Date.now();
      request.cancel();
      await expect(request).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect(await client.health()).toMatchObject({ status: 'ok' });
      await client.dispose();
    },
    20_000
  );

  it(
    '健康/重启(CORE-015/016):SIGKILL 后自动 respawn + 重握手,代数 +1',
    async () => {
      const client = makeClient();
      await client.start();
      const firstPid = (await client.health()).pid;
      expect(firstPid).toBeGreaterThan(0);

      client.childProcess!.kill('SIGKILL');
      // 重启中 health 可能打在旧进程上:等代数推进且 pid 变化才算重启完成
      const restarted = await waitFor(async () => {
        const current = await client.health();
        return current.pid !== firstPid && client.restartGeneration >= 1 ? current : undefined;
      }, 10_000);
      expect(restarted.restartGeneration).toBe(1);
      expect(restarted.initialized).toBe(true);
      expect(restarted.pid).not.toBe(firstPid);
      expect((await client.health()).documents).toEqual([]);
      await client.dispose();
    },
    30_000
  );
});
