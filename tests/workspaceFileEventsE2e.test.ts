import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { KodeCoreClient } from '../src/backend/kodeCoreClient';

// RUST-131-W:生产文件事件(rename/delete)E2E——真实 kode-server 二进制 +
// 真实磁盘文件。TS notify 帧形状对线上契约(mock-vs-wire 教训:mock 编码
// 实现侧形状≠线上契约);server 分派层全链语义在 Rust
// workspace_file_events_dispatch 钉死,此处锁线上契约面:通知被接受且
// 产生撤销效果(旧 URI hover 无结果 + 队列 purge 记账),不静默丢弃。
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

suite('RUST-131-W 生产文件事件 E2E(真实 kode-server + 真实磁盘)', () => {
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
    const root = mkdtempSync(join(tmpdir(), `kode-r131w-e2e-${tag}-`));
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

  function hoverAt(client: KodeCoreClient, uri: string): Promise<unknown> {
    return client.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 2, character: 4 },
    });
  }

  it('delete:真盘删除后旧 URI 无 hover,队列 purge 记账', async () => {
    const root = makeRoot('del');
    const file = join(root, 'Gone.def');
    writeFileSync(file, DEF);
    const client = makeClient(root);
    await client.start();
    const uri = `file://${file}`;

    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'plaintext', version: 1, text: DEF },
    });
    const before = await hoverAt(client, uri);
    expect(before).toBeTruthy();

    // didChange 进风暴缓冲(窗口未移交)——删除后队列侧 purge 记账可观测
    // (首个 hover 已泵掉 didOpen 任务,纯逐出路径 purge 无可记)。
    client.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: DEF }],
    });

    rmSync(file);
    client.notify('workspace/didDeleteFiles', { files: [{ uri }] });
    const after = await hoverAt(client, uri);
    expect(after).toBeNull();

    const health = await client.request('$/kode/health', {});
    expect((health.ingest as { purged: number }).purged).toBeGreaterThanOrEqual(1);
  });

  it('rename:真盘移动后旧 URI 无结果,新 URI 经 didOpen 有结果', async () => {
    const root = makeRoot('ren');
    const oldFile = join(root, 'Old.def');
    const newFile = join(root, 'Renamed.def');
    writeFileSync(oldFile, DEF);
    const client = makeClient(root);
    await client.start();
    const oldUri = `file://${oldFile}`;
    const newUri = `file://${newFile}`;

    client.notify('textDocument/didOpen', {
      textDocument: { uri: oldUri, languageId: 'plaintext', version: 1, text: DEF },
    });
    const before = await hoverAt(client, oldUri);
    expect(before).toBeTruthy();

    renameSync(oldFile, newFile);
    client.notify('workspace/didRenameFiles', { files: [{ oldUri, newUri }] });
    // 旧侧撤销独立于新侧入库(此时新 URI 尚未 didOpen)。
    const evicted = await hoverAt(client, oldUri);
    expect(evicted).toBeNull();

    // 编辑器重开语义:didOpen(new) 后到,overlay 未保存修订胜出。
    client.notify('textDocument/didOpen', {
      textDocument: { uri: newUri, languageId: 'plaintext', version: 1, text: DEF },
    });
    const moved = await hoverAt(client, newUri);
    expect(moved).toBeTruthy();
  });
});
