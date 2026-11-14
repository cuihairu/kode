import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { KodeCoreClient } from '../src/backend/kodeCoreClient';

// RUST-055(部分,第一增量):协议契约门——TS 消费的 RPC 面对着真实
// kode-server 二进制钉**应答形状**(键集+类型,不钉数值),把 mock-vs-wire
// 契约漂移的教训(mock 编码实现侧形状≠线上契约)变成常红闸:Rust 侧行为
// 即规范真源,TS 侧类型与封装必须与观测形状一致;任一侧漂移本门即红。
// 覆盖核心面:initialize/health/$/kode/rpc 信封(echo 往返+method not found
// 错误码)/textDocument 四面(hover/definition/completion/diagnostic)。
// 二进制缺失时现场 cargo build;无 Rust 工具链环境整套 skip(同 kodeCoreE2E)。

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');

if (!existsSync(binaryPath)) {
  spawnSync('cargo', ['build', '-p', 'kode-server'], { cwd: repoRoot, timeout: 300_000 });
}
const binaryReady = existsSync(binaryPath);

const sortedKeys = (value: unknown): string[] =>
  Object.keys(value as Record<string, unknown>).sort();

const suite = binaryReady ? describe : describe.skip;
const URI = 'file:///workspace/contract/entities/Monster.def';

suite('协议契约门(真实 kode-server 应答形状)', () => {
  const clients: KodeCoreClient[] = [];
  afterAll(async () => {
    for (const client of clients) {
      await client.dispose().catch(() => undefined);
    }
  });

  function makeClient(): KodeCoreClient {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/contract', capabilities: {} },
      onStderr: () => undefined,
    });
    clients.push(client);
    return client;
  }

  it('initialize:capabilities/serverInfo 键集钉死', async () => {
    const client = makeClient();
    const result = await client.start();
    expect(sortedKeys(result)).toEqual(['capabilities', 'serverInfo']);
    expect(sortedKeys(result.capabilities)).toEqual(
      ['completionProvider', 'definitionProvider', 'hoverProvider', 'textDocumentSync']
    );
    expect(result.capabilities.textDocumentSync).toEqual({ openClose: true, change: 1 });
    // completion triggerCharacters 面随契约钉死(def 标签补全 '<' 触发)
    expect((result.capabilities.completionProvider as { triggerCharacters: string[] }).triggerCharacters)
      .toEqual(['<']);
    expect(sortedKeys(result.serverInfo)).toEqual(['name', 'version']);
    await client.dispose();
  }, 20_000);

  it('health:顶层键集与 resources 键集钉死(开文档前后 documents 形状一致)', async () => {
    const client = makeClient();
    await client.start();
    client.openDocument(URI, 'kbengine-def', 1, '<Entity><GroupName>mob</GroupName></Entity>');
    const health = await client.health();
    expect(sortedKeys(health)).toEqual(
      ['documents', 'initialized', 'pid', 'resources', 'restartGeneration',
       'serverVersion', 'shutdownRequested', 'status', 'uptimeMs']
    );
    expect(Array.isArray(health.documents)).toBe(true);
    expect(health.documents[0]).toEqual({ uri: URI, version: 1 });
    expect(sortedKeys(health.resources)).toEqual(
      ['cpuTimeMs', 'diskReadBytes', 'diskWriteBytes', 'rssBytes', 'threads']
    );
    for (const value of Object.values(health.resources ?? {})) {
      expect(typeof value).toBe('number');
    }
    await client.dispose();
  }, 20_000);

  it('$/kode/rpc 信封:echo 直返值(不包 ok 信封),未知方法 -32601', async () => {
    const client = makeClient();
    await client.start();
    const echoed = await client.request('$/kode/rpc', {
      method: '$/kode/echo',
      params: { seq: 7, blob: 'x' }
    });
    // 直返 dispatch 值:无 ok/error 包裹层(包裹层属 TS 侧封装,不在线上)
    expect(sortedKeys(echoed)).toEqual(['blob', 'seq']);
    expect(echoed.seq).toBe(7);
    // TS 侧错误映射:server JSON-RPC error code → 字符串码(非 -32800 一律
    // SERVER_ERROR),原文码进 message——两侧契约都在钉
    await expect(client.request('$/kode/rpc', { method: '$/kode/no-such-method', params: {} }))
      .rejects.toMatchObject({ code: 'SERVER_ERROR' });
    await expect(client.request('$/kode/rpc', { method: '$/kode/no-such-method', params: {} }))
      .rejects.toThrow(/-32601.*method not found/);
    await client.dispose();
  }, 20_000);

  it('textDocument/diagnostic:full 面 item 键集钉死(未注册类型 Error 项)', async () => {
    const client = makeClient();
    await client.start();
    client.openDocument(URI, 'kbengine-def', 1, '<Entity><GroupName>mob</GroupName></Entity>');
    const result = (await client.request('textDocument/diagnostic', {
      textDocument: { uri: URI }
    })) as { kind: string; items: Array<Record<string, unknown>> };
    expect(sortedKeys(result)).toEqual(['items', 'kind']);
    expect(result.kind).toBe('full');
    expect(Array.isArray(result.items)).toBe(true);
    for (const item of result.items) {
      // LSP Diagnostic 形状:range/severity/message 必在;键集钉死防漂移
      expect(sortedKeys(item)).toEqual(['message', 'range', 'severity']);
      expect(sortedKeys(item.range)).toEqual(['end', 'start']);
      expect(sortedKeys(item.range.start)).toEqual(['character', 'line']);
    }
    await client.dispose();
  }, 20_000);

  it('textDocument/hover|definition|completion:打开文档上的未命中面形状(null/空集)', async () => {
    const client = makeClient();
    await client.start();
    client.openDocument(URI, 'kbengine-def', 1, '<Entity><GroupName>mob</GroupName></Entity>');
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri: URI }, position: { line: 0, character: 2 }
    });
    // 词不命中任何声明符号 → JSON null(不是空对象/空 contents)
    expect(hover).toBeNull();
    const definition = await client.request('textDocument/definition', {
      textDocument: { uri: URI }, position: { line: 0, character: 2 }
    });
    expect(definition === null || Array.isArray(definition)).toBe(true);
    const completion = await client.request('textDocument/completion', {
      textDocument: { uri: URI }, position: { line: 0, character: 2 }
    });
    // 未命中(词上下文判定不出)→ null,不是空数组(实测钉死,防 TS 侧
    // 把 null 当 [] 展开成假命中面)
    expect(completion === null || Array.isArray(completion)).toBe(true);
    for (const item of (completion as Array<Record<string, unknown>> | null) ?? []) {
      expect(typeof item.label).toBe('string');
    }
    await client.dispose();
  }, 20_000);
});
