import * as http from 'http';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyAcceptedReceipt
} from '../src/hotReloadReceipt';
import { verifyAppliedReceipt } from '../src/hotReloadAppliedCheck';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';
import {
  defaultReloadHttpRunner,
  HttpReloadTransport
} from '../src/hotReloadTransport';

// IDE-AUD-007 / IDE-REV-022 / IDE-REV-023 真实联调面:回执协议证据不能只靠
// 模拟 JSON 字符串喂解析器——本套件拉起真实的参考接收端(scripts/hot-reload-
// receiver/referenceReceiver.mjs,零依赖 node:http 实现已记录契约),经真实
// node:http 回环网络驱动生产模块(HttpReloadTransport+defaultReloadHttpRunner
// +真实台账),逐场景取证:accepted 升格/applied digest 双证/digest 不符不升格/
// 非 JSON 回包保持未确认/非 2xx failed。请求/响应样本由 roundtripProbe 落盘。

interface ReceiverHandle {
  port: number;
  root: string;
  proc: ReturnType<typeof spawn>;
}

const RECEIVER_SCRIPT = path.join(
  __dirname,
  '..',
  'scripts',
  'hot-reload-receiver',
  'referenceReceiver.mjs'
);

const startReceiver = async (
  mode: string,
  scenario: string,
  extraArgs: string[] = []
): Promise<ReceiverHandle> => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-receiver-'));
  const proc = spawn(
    process.execPath,
    [RECEIVER_SCRIPT, '--port', '0', '--root', root, '--mode', mode, '--scenario', scenario, ...extraArgs],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('receiver 启动超时')), 5000);
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = buffer.match(/KODE_RECEIVER_PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    proc.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`receiver 提前退出: code=${code} ${buffer}`));
    });
  });
  return { port, root, proc };
};

describe('IDE-AUD-007 参考接收端真实回环联调(accepted/applied 协议证据)', () => {
  let handles: ReceiverHandle[] = [];
  let engineDirs: string[] = [];

  beforeEach(() => {
    handles = [];
    engineDirs = [];
  });

  afterEach(() => {
    for (const handle of handles) {
      handle.proc.kill();
      rmSync(handle.root, { recursive: true, force: true });
    }
    for (const dir of engineDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    handles = [];
    engineDirs = [];
  });

  const start = async (mode: string, scenario: string, extraArgs: string[] = []): Promise<ReceiverHandle> => {
    const handle = await startReceiver(mode, scenario, extraArgs);
    handles.push(handle);
    return handle;
  };

  const makeTransport = (port: number): HttpReloadTransport =>
    new HttpReloadTransport(
      {
        name: 'aud007',
        url: `http://127.0.0.1:${port}/reload`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // ${files} 占位:真实通道会把文件集 JSON 化进 body
        body: '{"files": ${files}}'
      },
      { run: request => defaultReloadHttpRunner(request) }
    );

  // F3 三轮:直连接收端的原始 POST(绕过通道模板)——专门钉接收端协议面
  // 本身(sender_digests 字段与应用产物核验),与经通道的 roundtrip 断言互补。
  const postReload = async (port: number, body: unknown): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: '/reload', method: 'POST', headers: { 'content-type': 'application/json' } },
        response => {
          let raw = '';
          response.on('data', (chunk: Buffer) => {
            raw += chunk.toString('utf8');
          });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: raw }));
        }
      );
      request.on('error', reject);
      request.write(JSON.stringify(body));
      request.end();
    });

  // F3 二轮:真实应用命令——把所发文件真实写入「引擎目录」(替代旧的
  // process.exit(0) 空操作假应用),测试可对引擎侧产物断言
  const realApplyCommand = (engineDir: string): string =>
    `node -e "const fs=require('fs'),p=require('path');const d='${engineDir}';fs.mkdirSync(d,{recursive:true});fs.copyFileSync(process.env.KODE_RELOAD_FILE,p.join(d,p.basename(process.env.KODE_RELOAD_FILE)))"`;

  it('accepted 回执:真实回包经 applyAcceptedReceipt 升格,台账 accepted(IDE-REV-022)', async () => {
    const receiver = await start('stage', 'accepted');
    const file = path.join(receiver.root, 'Avatar.py');
    writeFileSync(file, 'class Avatar:\n    pass\n', 'utf8');

    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 'baseapp-1' };
    const summary = await makeTransport(receiver.port).send(key, [file], () => {});

    expect(summary.receipts).toHaveLength(1);
    expect(summary.receipts[0]).toMatchObject({ status: 'accepted', file });
    // 台账先按传输事实落「未确认送达」,回执再按协议升格(生产管线口径)
    store.record(key, file, 'sent-unverified', {});
    const verdict = applyAcceptedReceipt(store, key, file, JSON.stringify(summary.receipts[0]), { attempt: 1 });
    expect(verdict.kind).toBe('accepted');
    expect(store.get(key, file)?.outcome).toBe('accepted');
  });

  it('applied 回执:digest 与所发内容一致才升格 applied(IDE-REV-023)', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    // F3 三轮:接收端按 --artifact-dir 里的应用产物核验 sender_digest
    const receiver = await start('apply', 'applied', [
      '--apply-command', realApplyCommand(engineDir),
      '--artifact-dir', engineDir
    ]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 100\n';
    writeFileSync(file, content, 'utf8');
    const sentDigest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 'cellapp-1' };
    // F3 三轮:发送方冻结 digest 随报文下发(sender_digests)
    const summary = await makeTransport(receiver.port).send(key, [file], () => {}, new Map([[file, sentDigest]]));
    expect(summary.receipts[0]).toMatchObject({ status: 'applied', file });
    // 真实应用证据:引擎目录里确实写入了所发内容(不再是空操作假应用)
    const engineFile = path.join(engineDir, 'Avatar.py');
    expect(existsSync(engineFile)).toBe(true);
    expect(readFileSync(engineFile, 'utf8')).toBe(content);

    store.record(key, file, 'sent-unverified', { sentDigest });
    const verdict = verifyAppliedReceipt(
      store,
      key,
      file,
      JSON.stringify(summary.receipts[0]),
      { sentDigest, attempt: 1 }
    );
    expect(verdict.kind).toBe('applied');
    expect(store.get(key, file)?.outcome).toBe('applied');
  });

  it('digest 不符:接收端回包 digest 与所发内容不一致,保持未确认不升格', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'digest-mismatch', [
      '--apply-command', realApplyCommand(engineDir),
      '--artifact-dir', engineDir
    ]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 200\n';
    writeFileSync(file, content, 'utf8');
    const sentDigest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 'cellapp-1' };
    const summary = await makeTransport(receiver.port).send(key, [file], () => {}, new Map([[file, sentDigest]]));
    expect(summary.receipts[0].status).toBe('applied');
    // 应用真实发生了(引擎目录有产物且与发送方冻结内容一致),只是回包 digest 被故意报错
    expect(readFileSync(path.join(engineDir, 'Avatar.py'), 'utf8')).toBe(content);

    store.record(key, file, 'sent-unverified', { sentDigest });
    const verdict = verifyAppliedReceipt(
      store,
      key,
      file,
      JSON.stringify(summary.receipts[0]),
      { sentDigest, attempt: 1 }
    );
    expect(verdict.kind).toBe('not-applied');
    expect(store.get(key, file)?.outcome).toBe('sent-unverified');
  });

  it('非 JSON 回包:已送达但未知结构,台账保持未确认(IDE-REV-022 反例)', async () => {
    const receiver = await start('stage', 'echo');
    const file = path.join(receiver.root, 'Avatar.py');
    writeFileSync(file, 'class Avatar:\n    pass\n', 'utf8');

    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 'baseapp-1' };
    const summary = await makeTransport(receiver.port).send(key, [file], () => {});
    expect(summary.receipts[0]).toMatchObject({ status: 'sent' });

    const verdict = applyAcceptedReceipt(store, key, file, 'receiver said ok, move along');
    expect(verdict.kind).toBe('not-accepted');
    expect(store.get(key, file)?.outcome ?? 'sent-unverified').toBe('sent-unverified');
  });

  it('非 2xx:送达失败,台账 failed', async () => {
    const receiver = await start('stage', 'error500');
    const file = path.join(receiver.root, 'Avatar.py');
    writeFileSync(file, 'class Avatar:\n    pass\n', 'utf8');

    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 'baseapp-1' };
    const summary = await makeTransport(receiver.port).send(key, [file], () => {});
    expect(summary.receipts[0]).toMatchObject({ status: 'failed' });
    expect(store.get(key, file)?.outcome ?? 'sent-unverified').toBe('sent-unverified');
  });

  // F3 回归(2026-11-05 审核):参考接收端伪称 applied 不能当协议证据——
  // apply 模式必须真正执行应用实现(真实命令)并落版本台账后才回 applied;
  // 无应用实现时如实回 accepted(仅暂存,未应用)。
  it('F3 回归:apply 模式无应用命令 → 不自称 applied,如实回 accepted(仅暂存未应用)', async () => {
    const receiver = await start('apply', 'applied');
    const file = path.join(receiver.root, 'Avatar.py');
    writeFileSync(file, 'class Avatar:\n    pass\n', 'utf8');

    const summary = await makeTransport(receiver.port).send({ rootId: '/ws', targetId: 'cellapp-1' }, [file], () => {});
    expect(summary.receipts[0].status).not.toBe('applied');
    expect(summary.receipts[0]).toMatchObject({ status: 'accepted', file });
    // 未应用的原因如实点名(不冒充、不吞;解析器透传 note)
    expect((summary.receipts[0] as { note?: string }).note).toContain('未配置');
    // 没有真实应用 → 不落任何 applied 版本台账
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('F3 回归:apply 模式配置真实应用命令 → 执行成功才回 applied,回执带 revision 并落应用台账', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const applyCommand = realApplyCommand(engineDir);
    const receiver = await start('apply', 'applied', [
      '--apply-command', applyCommand,
      '--artifact-dir', engineDir
    ]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 300\n';
    writeFileSync(file, content, 'utf8');
    const digest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

    const summary = await makeTransport(receiver.port).send(
      { rootId: '/ws', targetId: 'cellapp-1' },
      [file],
      () => {},
      new Map([[file, digest]])
    );
    expect(summary.receipts[0]).toMatchObject({ status: 'applied', file, revision: 1 });
    expect(summary.receipts[0].digest).toBe(digest);
    // 真实应用证据:引擎目录里的内容与所发内容逐字一致
    expect(readFileSync(path.join(engineDir, 'Avatar.py'), 'utf8')).toBe(content);
    // 应用后证据:版本台账逐条记录 revision/file/digest/命令
    const ledger = readFileSync(path.join(receiver.root, 'applied-revisions.jsonl'), 'utf8');
    const entry = JSON.parse(ledger.trim().split('\n')[0]);
    expect(entry).toMatchObject({ revision: 1, file, digest, command: applyCommand });
  });

  it('F3 回归:应用命令执行失败 → 如实回 failed,不冒充 applied', async () => {
    const receiver = await start('apply', 'applied', ['--apply-command', 'node -e "process.exit(3)"']);
    const file = path.join(receiver.root, 'Avatar.py');
    writeFileSync(file, 'class Avatar:\n    pass\n', 'utf8');

    const summary = await makeTransport(receiver.port).send({ rootId: '/ws', targetId: 'cellapp-1' }, [file], () => {});
    expect(summary.receipts[0].status).toBe('failed');
    expect((summary.receipts[0] as { reason?: string }).reason).toContain('应用命令');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('F3 二轮回归:应用命令退出 0 但改动了所发内容 → 应用产物核验不过,如实回 failed 不自称 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', [
      '--apply-command',
      // 退出码 0 的应用命令,但把所发文件改了、没写引擎产物——旧实现比较源
      // 文件前后哈希,空操作命令面前恒真;三轮修后按引擎产物核验 sender_digest
      `node -e "require('fs').appendFileSync(process.env.KODE_RELOAD_FILE, '-drifted')"`,
      '--artifact-dir', engineDir
    ]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 1\n';
    writeFileSync(file, content, 'utf8');
    const digest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

    const summary = await makeTransport(receiver.port).send(
      { rootId: '/ws', targetId: 'cellapp-1' },
      [file],
      () => {},
      new Map([[file, digest]])
    );
    expect(summary.receipts[0].status).toBe('failed');
    expect((summary.receipts[0] as { reason?: string }).reason).toContain('应用产物');
    // 内容漂移=应用核验不过,不落任何 applied 版本台账
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 三轮(2026-11-06 复审):协议级残余——二轮核验比较的是「所发源文件」
  // 应用命令前后两次哈希,而协议没把发送方冻结 digest 传给接收端:空操作命令
  // (不改源文件、退出 0)前后哈希相同仍能假 applied。修后:①请求报文带
  // sender_digests(发送方冻结 digest 随报文下发);②应用命令执行后对应用
  // 产物(--artifact-dir 引擎目录中的实际文件)重算 sha256,与 sender_digest
  // 比对一致才回 applied,否则 failed。

  it('F3 三轮回归:空操作命令(退出 0、不写引擎产物)→ failed,不自称 applied 不落台账', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', [
      '--apply-command', 'node -e "process.exit(0)"',
      '--artifact-dir', engineDir
    ]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 1\n';
    writeFileSync(file, content, 'utf8');
    const digest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: digest } });
    expect(response.status).toBe(200);
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    // 旧实现:源文件前后哈希相同(空操作没改源文件)→ 假 applied;修后必须 failed
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('应用产物');
    // 没有真实应用 → 不落任何 applied 版本台账
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
    // 引擎目录没有产物(空操作什么都没写)
    expect(existsSync(path.join(engineDir, 'Avatar.py'))).toBe(false);
  });

  it('F3 三轮回归:引擎产物内容与 sender_digest 不一致 → failed,不自称 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    // 退出 0 的应用命令,但往引擎目录写的不是发送方冻结的内容
    const applyCommand = `node -e "const fs=require('fs');fs.writeFileSync(process.env.KODE_RELOAD_ARTIFACT,'not what the sender froze')"`;
    const receiver = await start('apply', 'applied', ['--apply-command', applyCommand, '--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 2\n';
    writeFileSync(file, content, 'utf8');
    const digest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: digest } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('不一致');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('F3 三轮回归:报文缺 sender_digest → 无发送方冻结基准,不自称 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', [
      '--apply-command', realApplyCommand(engineDir),
      '--artifact-dir', engineDir
    ]);
    const file = path.join(receiver.root, 'Avatar.py');
    writeFileSync(file, 'class Avatar:\n    pass\n', 'utf8');

    const response = await postReload(receiver.port, { files: [file] });
    const receipt = JSON.parse(response.body) as { status: string };
    expect(receipt.status).not.toBe('applied');
    expect(receipt.status).toBe('failed');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('F3 三轮:通道发送自动附带 sender_digests(发送方冻结 digest 随报文下发)', async () => {
    let capturedBody: string | undefined;
    const transport = new HttpReloadTransport(
      {
        name: 'aud007-digests',
        url: 'http://127.0.0.1:1/reload',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"files": ${files}}'
      },
      {
        run: async request => {
          capturedBody = request.body;
          return { status: 200, body: '[]' };
        }
      }
    );
    await transport.send(
      { rootId: '/ws', targetId: 't1' },
      ['/ws/Avatar.py'],
      () => {},
      new Map([['/ws/Avatar.py', 'deadbeef']])
    );
    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!) as { files: string[]; sender_digests?: Record<string, string> };
    expect(parsed.files).toEqual(['/ws/Avatar.py']);
    expect(parsed.sender_digests).toEqual({ '/ws/Avatar.py': 'deadbeef' });
  });

  it('证据源锁:接收端脚本在册,实现已登记契约', () => {
    const source = readFileSync(RECEIVER_SCRIPT, 'utf8');
    expect(source).toContain('"status":"accepted"');
    expect(source).toContain('"status":"applied"');
    expect(source).toContain('sha256');
    // F3 三轮:协议报文带 sender_digests,接收端对应用产物核验
    expect(source).toContain('sender_digests');
    expect(source).toContain('--artifact-dir');
  });
});
