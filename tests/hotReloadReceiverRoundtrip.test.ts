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
    const receiver = await start('apply', 'applied', ['--apply-command', realApplyCommand(engineDir)]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 100\n';
    writeFileSync(file, content, 'utf8');

    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 'cellapp-1' };
    const summary = await makeTransport(receiver.port).send(key, [file], () => {});
    expect(summary.receipts[0]).toMatchObject({ status: 'applied', file });
    // 真实应用证据:引擎目录里确实写入了所发内容(不再是空操作假应用)
    const engineFile = path.join(engineDir, 'Avatar.py');
    expect(existsSync(engineFile)).toBe(true);
    expect(readFileSync(engineFile, 'utf8')).toBe(content);

    const sentDigest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
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
    const receiver = await start('apply', 'digest-mismatch', ['--apply-command', realApplyCommand(engineDir)]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 200\n';
    writeFileSync(file, content, 'utf8');

    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 'cellapp-1' };
    const summary = await makeTransport(receiver.port).send(key, [file], () => {});
    expect(summary.receipts[0].status).toBe('applied');
    // 应用真实发生了(引擎目录有产物),只是回包 digest 被故意报错
    expect(existsSync(path.join(engineDir, 'Avatar.py'))).toBe(true);

    const sentDigest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
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
    const receiver = await start('apply', 'applied', ['--apply-command', applyCommand]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 300\n';
    writeFileSync(file, content, 'utf8');
    const digest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

    const summary = await makeTransport(receiver.port).send({ rootId: '/ws', targetId: 'cellapp-1' }, [file], () => {});
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

  it('F3 二轮回归:应用命令退出 0 但改动了所发内容 → 重算 digest 与发送方内容不符,如实回 failed 不自称 applied', async () => {
    const receiver = await start('apply', 'applied', [
      '--apply-command',
      // 退出码 0 的应用命令,但把所发文件改了(应用的不是发送方 digest 指纹
      // 指向的内容)——旧实现只看退出码就自称 applied
      `node -e "require('fs').appendFileSync(process.env.KODE_RELOAD_FILE, '-drifted')"`
    ]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 1\n';
    writeFileSync(file, content, 'utf8');

    const summary = await makeTransport(receiver.port).send({ rootId: '/ws', targetId: 'cellapp-1' }, [file], () => {});
    expect(summary.receipts[0].status).toBe('failed');
    expect((summary.receipts[0] as { reason?: string }).reason).toContain('不一致');
    // 内容漂移=应用核验不过,不落任何 applied 版本台账
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('证据源锁:接收端脚本在册,实现已登记契约', () => {
    const source = readFileSync(RECEIVER_SCRIPT, 'utf8');
    expect(source).toContain('"status":"accepted"');
    expect(source).toContain('"status":"applied"');
    expect(source).toContain('sha256');
  });
});
