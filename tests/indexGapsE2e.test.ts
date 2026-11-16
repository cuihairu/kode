import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { KodeCoreClient } from '../src/backend/kodeCoreClient';

// RUST-133:索引缺口报告 E2E——真实 kode-server 二进制 + 真实磁盘文件。
// 锁线上契约面:$/kode/indexGaps per-URI 裁定四态 + fill 按需补齐循环
// (定义缺口 → 报告 unindexed → fill 回读盘入库 → 命中),health 顶层
// indexGaps 键恒装配。分派层全链语义在 Rust index_gaps_dispatch 钉死。
// 二进制缺失时现场 cargo build;无 Rust 工具链环境整套 skip。

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');

if (!existsSync(binaryPath)) {
  spawnSync('cargo', ['build', '-p', 'kode-server'], { cwd: repoRoot, timeout: 300_000 });
}
const binaryReady = existsSync(binaryPath);

const suite = binaryReady ? describe : describe.skip;

const DEF =
  '<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n';

suite('RUST-133 索引缺口报告 E2E(真实 kode-server + 真实磁盘)', () => {
  const clients: KodeCoreClient[] = [];
  const roots: string[] = [];
  afterAll(async () => {
    for (const client of clients) {
      await client.dispose().catch(() => undefined);
    }
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRoot(tag: string): string {
    const root = mkdtempSync(join(tmpdir(), `kode-r133-e2e-${tag}-`));
    roots.push(root);
    return root;
  }

  function makeClient(root: string): KodeCoreClient {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: {
        processId: process.pid,
        rootUri: `file://${root}`,
        capabilities: {},
      },
      onStderr: () => undefined,
    });
    clients.push(client);
    return client;
  }

  function gaps(client: KodeCoreClient, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return client.request('$/kode/indexGaps', params) as Promise<Record<string, unknown>>;
  }

  function hoverAt(client: KodeCoreClient, uri: string): Promise<unknown> {
    return client.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 2, character: 4 },
    });
  }

  it('fill 循环:盘上未入库文件 unindexed → fill 回读 → 定义命中', async () => {
    const root = makeRoot('fill');
    // 探针面:hover/definition 都要求来源文档已打开——用已打开的 Probe.def
    // 的 <Parent> 引用做定义探针,目标 Late.def 全程不打开(fill 的适用面:
    // 盘上未入库依赖)。defs_root 探测锚=entities.xml 所在目录。
    const lateFile = join(root, 'Late.def');
    writeFileSync(lateFile, DEF);
    const ENTITIES = '<root>\n\t<Late> Late.def </Late>\n</root>\n';
    writeFileSync(join(root, 'entities.xml'), ENTITIES);
    const probeFile = join(root, 'Probe.def');
    const PROBE = '<root>\n\t<Parent> Late </Parent>\n</root>\n';
    writeFileSync(probeFile, PROBE);
    const client = makeClient(root);
    await client.start();
    const lateUri = `file://${lateFile}`;
    const probeUri = `file://${probeFile}`;

    client.notify('textDocument/didOpen', {
      textDocument: { uri: `file://${root}/entities.xml`, languageId: 'plaintext', version: 1, text: ENTITIES },
    });
    client.notify('textDocument/didOpen', {
      textDocument: { uri: probeUri, languageId: 'plaintext', version: 1, text: PROBE },
    });

    function definitionOnProbe(): Promise<unknown> {
      return client.request('textDocument/definition', {
        textDocument: { uri: probeUri },
        position: { line: 1, character: 10 },
      });
    }

    // fill 前定义缺口:语料无 Late.def,定义请求 miss。
    expect(await definitionOnProbe()).toBeNull();

    // 纯观测:未入库如实报告,零侧效。
    const observed = await gaps(client, { uri: lateUri });
    expect(observed.gap).toBe('unindexed');
    expect(observed.tracked).toBe(false);
    expect(observed.filled).toBe(false);

    // fill 按需补齐:回读盘入库(执行时刻真相重放)。
    const filled = await gaps(client, { uri: lateUri, fill: true });
    expect(filled.gap).toBe('unindexed');
    expect(filled.filled).toBe(true);

    // 补齐后命中(todo 行口径:避免误报无法找到定义)。请求入口
    // pump_budgeted 顺带执行 fill 入队的刷新任务;语料面落点 uri=纯路径
    // (definition 既有约定,非 file:// scheme)。
    const definition = (await definitionOnProbe()) as { uri?: string } | null;
    expect(definition).toBeTruthy();
    expect(definition?.uri).toBe(lateFile);
    const settled = await gaps(client, { uri: lateUri });
    expect(settled.gap).toBe('none');
    expect(settled.tracked).toBe(true);
  });

  it('per-URI 裁定:已入库文件 none + health indexGaps 三族恒装配', async () => {
    const root = makeRoot('open');
    const file = join(root, 'Known.def');
    writeFileSync(file, DEF);
    const client = makeClient(root);
    await client.start();
    const uri = `file://${file}`;

    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'plaintext', version: 1, text: DEF },
    });
    // 首个请求入口 freshen 泵掉 didOpen 刷新,此后零缺口。
    expect(await hoverAt(client, uri)).toBeTruthy();

    const verdict = await gaps(client, { uri });
    expect(verdict.gap).toBe('none');
    expect(verdict.tracked).toBe(true);
    expect(verdict.pendingRefresh).toBe(false);
    expect(verdict.parseError).toBeNull();

    const health = (await client.request('$/kode/health', {})) as Record<string, unknown>;
    const indexGaps = health.indexGaps as Record<string, unknown>;
    expect(indexGaps).toBeTruthy();
    expect(Object.keys(indexGaps).sort()).toEqual(['partial', 'stale', 'unindexed']);
    expect((indexGaps.partial as Record<string, unknown>).count).toBe(0);
  });
});
