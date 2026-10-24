import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { KodeCoreClient } from '../src/kodeCoreClient';
import { KodeCoreGate } from '../src/kodeCoreGate';

// kode2 PR-003 e2e(PH1-02,书 §15):真实 Rust kode-server 二进制。
// 握手 → didOpen/didChange/didClose → cancel → 健康探针 → kill 后自动重启。
// E 组补两把生产接线锁(E-1 语料镜像/E-2 重启对账,真实进程 + 真实磁盘语料)。
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

  function makeClient(rootUri = 'file:///workspace/demo'): KodeCoreClient {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri, capabilities: {} },
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

  // ---- E 组生产接线锁(真实磁盘语料 + 真实 didOpen 通道) ------------------

  const TYPES_XML = ['<root>', '  <PARITY_POINT type="UINT32"/>', '</root>'].join('\n');
  const ENTITIES_XML = ['<root>', '  <Monster config="kbengine_monster_defaults"/>', '</root>'].join('\n');
  const ALIAS_XML = ['<root>', '  <PARITY_LIST type="ARRAY" of="UINT32"/>', '</root>'].join('\n');
  const MONSTER_DEF = [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>PARITY_POINT</Type>',
    '      <Flags>CELL_PUBLIC</Flags>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n');

  /** 临时工作区 + 三类语料 XML + 一个引用自定义类型的 .def(用完即删) */
  function makeCorpusWorkspace(): { dir: string; files: Record<string, string> } {
    const dir = mkdtempSync(join(tmpdir(), 'kode-core-'));
    const entityDefs = join(dir, 'scripts', 'entity_defs');
    mkdirSync(entityDefs, { recursive: true });
    const files: Record<string, string> = {
      typesXml: join(entityDefs, 'types.xml'),
      entitiesXml: join(entityDefs, 'entities.xml'),
      aliasXml: join(entityDefs, 'alias.xml'),
      monsterDef: join(entityDefs, 'Monster.def')
    };
    writeFileSync(files.typesXml, TYPES_XML);
    writeFileSync(files.entitiesXml, ENTITIES_XML);
    writeFileSync(files.aliasXml, ALIAS_XML);
    writeFileSync(files.monsterDef, MONSTER_DEF);
    return { dir, files };
  }

  async function requestDiagnostic(
    client: KodeCoreClient,
    uri: string
  ): Promise<{ kind: string; items: { message: string }[] }> {
    return (await client.request('textDocument/diagnostic', { textDocument: { uri } })) as {
      kind: string;
      items: { message: string }[];
    };
  }

  it(
    'E-1 语料接线:types.xml 未进 shadow 时误报未注册,补齐三类 XML 后诊断消失',
    async () => {
      const { dir, files } = makeCorpusWorkspace();
      const defUri = `file://${files.monsterDef}`;
      try {
        const client = makeClient(`file://${dir}`);
        await client.start();

        // 只镜像 .def(缺陷面):自定义类型被误报未注册
        client.openDocument(defUri, 'kbengine-def', 1, MONSTER_DEF);
        const missingMessages = (await requestDiagnostic(client, defUri)).items.map(item => item.message);
        expect(missingMessages).toContain(
          '自定义类型 PARITY_POINT 未在 types.xml 中注册，请先在 types.xml 注册后再引用'
        );

        // 三类 XML 经 didOpen 进 Rust 语料后,同一 .def 的误报消失
        client.openDocument(`file://${files.typesXml}`, 'xml', 1, TYPES_XML);
        client.openDocument(`file://${files.entitiesXml}`, 'xml', 1, ENTITIES_XML);
        client.openDocument(`file://${files.aliasXml}`, 'xml', 1, ALIAS_XML);
        const afterCorpus = await requestDiagnostic(client, defUri);
        expect(afterCorpus.kind).toBe('full');
        expect(afterCorpus.items.map(item => item.message)).not.toContain(
          '自定义类型 PARITY_POINT 未在 types.xml 中注册，请先在 types.xml 注册后再引用'
        );
        expect((await client.health()).documents).toHaveLength(4);
        await client.dispose();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    20_000
  );

  it(
    'E-2 影子账本:SIGKILL 自动重启后账本重置并重放快照,继续编辑打到新进程',
    async () => {
      const client = makeClient();
      const gate = new KodeCoreGate({ clientFactory: () => client });
      gate.setConfig({ backend: 'shadow', serverPath: binaryPath, shadowTimeoutMs: 5000 });
      await gate.mirrorDocument(URI, 'kbengine-def', 1, '<Entity/>');
      expect((await client.health()).documents).toEqual([{ uri: URI, version: 1 }]);

      const firstPid = (await client.health()).pid;
      client.childProcess!.kill('SIGKILL');
      await waitFor(async () => {
        const health = await client.health();
        return client.restartGeneration >= 1 && health.pid !== firstPid ? health : undefined;
      }, 10_000);
      expect((await client.health()).documents).toEqual([]);

      // 缺陷面:账本不失效时只发 didChange,新进程忽略(文档未打开)
      await gate.mirrorDocument(URI, 'kbengine-def', 2, '<Entity><hp/></Entity>');
      expect((await client.health()).documents).toEqual([{ uri: URI, version: 2 }]);
      await client.dispose();
    },
    40_000
  );

  it('E-4 关文档清理:Rust 侧不留残留 overlay,连续开合不积累,重开低版本正常', async () => {
    const client = makeClient();
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'shadow', serverPath: binaryPath, shadowTimeoutMs: 5000 });

    await gate.mirrorDocument(URI, 'kbengine-def', 5, '<Entity/>');
    expect((await client.health()).documents).toEqual([{ uri: URI, version: 5 }]);

    // 缺陷面:只释放 TS 侧时 Rust 仍持有旧 overlay,连续开合逐次积累
    gate.closeMirroredDocument(URI);
    expect((await client.health()).documents).toEqual([]);

    await gate.mirrorDocument(URI, 'kbengine-def', 6, '<Entity/>');
    gate.closeMirroredDocument(URI);
    expect((await client.health()).documents).toEqual([]);

    // 重开低版本:账本已清,走 didOpen 而不是被 didChange 忽略
    await gate.mirrorDocument(URI, 'kbengine-def', 1, '<Entity/>');
    expect((await client.health()).documents).toEqual([{ uri: URI, version: 1 }]);
    await client.dispose();
  }, 20_000);
});
