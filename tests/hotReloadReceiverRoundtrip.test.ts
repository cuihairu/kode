import * as http from 'http';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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
//
// F3 四轮(2026-11-06 复审)设计级重做:applied 路径改为**接收端自己写产物**
// ——按报文 files 读到内容后由接收端自身代码直接落盘引擎目录(--artifact-dir),
// 写后重算 sha256 与 sender_digest 比对一致才回 applied(写失败/哈希不符→
// failed 且已写产物回滚);外部应用命令模式降级:命令副作用不可证实(无法证明
// 产物是本次命令写的),退出 0 也最多 accepted,绝不 applied。空操作场景从
// 设计上不存在假 applied:接收端没写产物就没有产物哈希可核验。

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
  let outsideDirs: string[] = [];

  beforeEach(() => {
    handles = [];
    engineDirs = [];
    outsideDirs = [];
  });

  afterEach(() => {
    for (const handle of handles) {
      handle.proc.kill();
      rmSync(handle.root, { recursive: true, force: true });
    }
    for (const dir of engineDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const dir of outsideDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    handles = [];
    engineDirs = [];
    outsideDirs = [];
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

  const sha256 = (content: string): string =>
    createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

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

  it('applied 回执:接收端自己写产物,产物哈希与 sender_digest 一致才升格 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    // F3 四轮:接收端自己写产物模式——不配外部命令,只配引擎产物目录
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 100\n';
    writeFileSync(file, content, 'utf8');
    const sentDigest = sha256(content);

    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 'cellapp-1' };
    // 发送方冻结 digest 随报文下发(sender_digests)
    const summary = await makeTransport(receiver.port).send(key, [file], () => {}, new Map([[file, sentDigest]]));
    expect(summary.receipts[0]).toMatchObject({ status: 'applied', file });
    // 接收端自己写的产物:引擎目录内容与所发内容逐字一致
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
    // applied 证据落版本台账(接收端自己写的产物哈希)
    const ledger = readFileSync(path.join(receiver.root, 'applied-revisions.jsonl'), 'utf8');
    expect(JSON.parse(ledger.trim().split('\n')[0])).toMatchObject({ file, digest: sentDigest });
  });

  it('digest 不符:接收端回包 digest 与所发内容不一致,保持未确认不升格', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'digest-mismatch', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 200\n';
    writeFileSync(file, content, 'utf8');
    const sentDigest = sha256(content);

    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 'cellapp-1' };
    const summary = await makeTransport(receiver.port).send(key, [file], () => {}, new Map([[file, sentDigest]]));
    // 接收端应用真实发生了(自己写的产物与所发一致),只是回包 digest 被故意报错
    expect(summary.receipts[0].status).toBe('applied');
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

  // F3 四轮:apply 模式未配置引擎产物目录 → 接收端写不了产物,只暂存不自称
  // applied,如实回 accepted + 未配置原因。
  it('F3 四轮回归:apply 模式未配置引擎产物目录 → 只暂存不自称 applied,如实回 accepted', async () => {
    const receiver = await start('apply', 'applied');
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    pass\n';
    writeFileSync(file, content, 'utf8');

    const summary = await makeTransport(receiver.port).send(
      { rootId: '/ws', targetId: 'cellapp-1' },
      [file],
      () => {},
      new Map([[file, sha256(content)]])
    );
    expect(summary.receipts[0].status).not.toBe('applied');
    expect(summary.receipts[0]).toMatchObject({ status: 'accepted', file });
    expect((summary.receipts[0] as { note?: string }).note).toContain('--artifact-dir');
    // 没有真实应用 → 不落任何 applied 版本台账
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 四轮(设计级):外部应用命令的副作用不可证实——接收端无法证明引擎目录
  // 里的产物是本次命令写的,命令退出 0 也最多 accepted(视为不可证实的副作用),
  // 绝不自称 applied、不落应用台账。
  it('F3 四轮回归:外部应用命令退出 0 → 降级 accepted(不可证实的副作用),绝不 applied 不落台账', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    // 命令真实把产物写进引擎目录(副作用真实发生),但接收端证明不了是它写的
    const applyCommand = `node -e "const fs=require('fs'),p=require('path');const d='${engineDir}';fs.mkdirSync(d,{recursive:true});fs.copyFileSync(process.env.KODE_RELOAD_FILE,p.join(d,p.basename(process.env.KODE_RELOAD_FILE)))"`;
    const receiver = await start('apply', 'applied', ['--apply-command', applyCommand, '--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 300\n';
    writeFileSync(file, content, 'utf8');

    const summary = await makeTransport(receiver.port).send(
      { rootId: '/ws', targetId: 'cellapp-1' },
      [file],
      () => {},
      new Map([[file, sha256(content)]])
    );
    // 降级:最多 accepted,绝不 applied
    expect(summary.receipts[0].status).not.toBe('applied');
    expect(summary.receipts[0]).toMatchObject({ status: 'accepted', file });
    expect((summary.receipts[0] as { note?: string }).note).toContain('不可证实');
    // 命令的副作用真实发生(引擎目录有产物),但回执仍不自称 applied
    expect(readFileSync(path.join(engineDir, 'Avatar.py'), 'utf8')).toBe(content);
    // 不落任何 applied 版本台账
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('F3 回归:外部应用命令执行失败 → 如实回 failed(副作用失败是真失败)', async () => {
    const receiver = await start('apply', 'applied', ['--apply-command', 'node -e "process.exit(3)"']);
    const file = path.join(receiver.root, 'Avatar.py');
    writeFileSync(file, 'class Avatar:\n    pass\n', 'utf8');

    const summary = await makeTransport(receiver.port).send({ rootId: '/ws', targetId: 'cellapp-1' }, [file], () => {});
    expect(summary.receipts[0].status).toBe('failed');
    expect((summary.receipts[0] as { reason?: string }).reason).toContain('应用命令');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('F3 四轮回归:外部应用命令空操作(退出 0、不写引擎产物)→ 降级 accepted,不存在假 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', [
      '--apply-command', 'node -e "process.exit(0)"',
      '--artifact-dir', engineDir
    ]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 1\n';
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    expect(response.status).toBe(200);
    const receipt = JSON.parse(response.body) as { status: string; note?: string };
    // 旧实现:空操作命令仍能借产物核验/前后哈希假 applied;修后外部命令模式
    // 一律降级 accepted——空操作场景从设计上不存在假 applied
    expect(receipt.status).toBe('accepted');
    expect(receipt.note).toContain('不可证实');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
    // 引擎目录没有产物(空操作什么都没写)
    expect(existsSync(path.join(engineDir, 'Avatar.py'))).toBe(false);
  });

  it('F3 四轮回归:接收端自己写产物但 sender_digest 与内容不符 → failed 且产物回滚(引擎目录无残留)', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    // 接收端自己写产物模式(无外部命令);sender_digest 是别的内容的哈希
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 2\n';
    writeFileSync(file, content, 'utf8');
    const wrongDigest = sha256('not what the receiver will read');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: wrongDigest } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('不一致');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
    // 哈希不符 → 已写产物回滚:引擎目录无残留
    expect(existsSync(path.join(engineDir, 'Avatar.py'))).toBe(false);
  });

  it('F3 四轮回归:报文缺 sender_digest → 接收端不写产物不自称 applied,如实 failed', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    writeFileSync(file, 'class Avatar:\n    pass\n', 'utf8');

    const response = await postReload(receiver.port, { files: [file] });
    const receipt = JSON.parse(response.body) as { status: string };
    expect(receipt.status).toBe('failed');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
    // 无比对基准就不落盘:引擎目录无产物
    expect(existsSync(path.join(engineDir, 'Avatar.py'))).toBe(false);
  });

  it('F3 六轮回归:读旧产物失败(目录占位,非 ENOENT)→ 拒绝写入不删除,不自称 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 7\n';
    writeFileSync(file, content, 'utf8');
    // 产物路径被目录占用 → 写前读旧产物抛 EISDIR(非 ENOENT):不得当作
    // 「不存在」继续写,必须拒绝写入且不动已存在的产物
    const engineFile = path.join(engineDir, 'Avatar.py');
    writeFileSync(path.join(engineDir, 'placeholder'), '', 'utf8');
    mkdirSync(engineFile, { recursive: true });

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('读旧产物失败');
    // 已存在的产物(此处为目录)保持原样,没有被删除/清理
    expect(existsSync(engineFile)).toBe(true);
    expect(receipt).not.toHaveProperty('rollback_failed');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 五轮(R2-F3 硬化 1+2)→ 六轮改由「只读旧产物」构造:写前读原内容成功、
  // 落盘失败(EACCES),回滚还原也失败 → 回执如实附 rollback_failed(残留路径),
  // 绝不谎称「已回滚无残留」。
  it('F3 六轮回归:落盘失败且清理失败(只读旧产物)→ failed 回执如实 rollback_failed,不谎称无残留', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 11\n';
    writeFileSync(file, content, 'utf8');
    // 预存在旧产物可读不可写(0444):写前读成功 → 走落盘,writeFileSync 必失败
    // (EACCES);回滚还原原内容同样 EACCES → 接收端必须如实上报 rollback_failed
    const engineFile = path.join(engineDir, 'Avatar.py');
    const oldContent = 'class Avatar:\n    HP = 10\n';
    writeFileSync(engineFile, oldContent, 'utf8');
    chmodSync(engineFile, 0o444);

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string; rollback_failed?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('落盘失败');
    // 清理失败如实上报残留路径,绝不声称「无残留」
    expect(receipt.rollback_failed).toBe(engineFile);
    expect(receipt.reason).not.toContain('无残留');
    // 旧产物原内容仍在(可读)
    expect(readFileSync(engineFile, 'utf8')).toBe(oldContent);
    chmodSync(engineFile, 0o644);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 六轮(复审 FAIL-3a):写前读旧产物把一切异常当 ENOENT → EACCES 时误判
  // 「不存在」,失败回滚 unlink 把预存在产物误删。修后仅 ENOENT 视为不存在,
  // 其他读异常如实拒绝写入且绝不删除。
  it('F3 六轮回归:读旧产物 EACCES → 拒绝写入且不误删预存在产物', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 50\n';
    writeFileSync(file, content, 'utf8');
    // 预存在产物不可读(0000):写前读抛 EACCES → 不得当作不存在
    const engineFile = path.join(engineDir, 'Avatar.py');
    writeFileSync(engineFile, 'class Avatar:\n    HP = 49\n', 'utf8');
    chmodSync(engineFile, 0o000);

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('读旧产物失败');
    // 预存在产物不被误删(旧实现把读失败当不存在,失败回滚 unlink 误删)
    expect(existsSync(engineFile)).toBe(true);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
    chmodSync(engineFile, 0o644);
  });

  // F3 六轮(复审 FAIL-3b):旧内容以 UTF-8 字符串保存,非 UTF-8 文件无法按
  // 原字节恢复。修后旧内容以 Buffer 保存恢复,逐字节还原。
  it('F3 六轮回归:非 UTF-8 旧产物失败回滚按原字节恢复(Buffer)', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 51\n';
    writeFileSync(file, content, 'utf8');
    // 预存在旧产物含非法 UTF-8 字节:回滚必须按原字节还原,不得经 UTF-8 转码
    const engineFile = path.join(engineDir, 'Avatar.py');
    const rawOld = Buffer.from([0x41, 0x80, 0x42, 0xff, 0x43, 0x0a]);
    writeFileSync(engineFile, rawOld);

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256('drifted away') } });
    const receipt = JSON.parse(response.body) as { status: string };
    expect(receipt.status).toBe('failed');
    // 逐字节一致(旧实现 utf8 读→utf8 写会把 0x80/0xff 变成 U+FFFD,字节改变)
    const restored = readFileSync(engineFile);
    expect(Buffer.compare(restored, rawOld)).toBe(0);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('F3 四轮回归:多文件批一个 digest 不符 → 该文件 failed 且只回滚该文件,另一文件照常 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const good = path.join(receiver.root, 'Avatar.py');
    const bad = path.join(receiver.root, 'Monster.py');
    const goodContent = 'class Avatar:\n    HP = 8\n';
    const badContent = 'class Monster:\n    HP = 9\n';
    writeFileSync(good, goodContent, 'utf8');
    writeFileSync(bad, badContent, 'utf8');

    const response = await postReload(receiver.port, {
      files: [good, bad],
      // bad 的 sender_digest 故意给错的(别的内容的哈希)
      sender_digests: { [good]: sha256(goodContent), [bad]: sha256('drifted baseline') }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string; reason?: string }>;
    const goodReceipt = receipts.find(receipt => receipt.file === good);
    const badReceipt = receipts.find(receipt => receipt.file === bad);
    expect(goodReceipt?.status).toBe('applied');
    expect(badReceipt?.status).toBe('failed');
    expect(badReceipt?.reason).toContain('不一致');
    // 好文件产物在,坏文件产物已回滚
    expect(readFileSync(path.join(engineDir, 'Avatar.py'), 'utf8')).toBe(goodContent);
    expect(existsSync(path.join(engineDir, 'Monster.py'))).toBe(false);
    const ledger = readFileSync(path.join(receiver.root, 'applied-revisions.jsonl'), 'utf8');
    expect(JSON.parse(ledger.trim().split('\n')[0])).toMatchObject({ file: good });
  });

  // F3 五轮(R2-F3 硬化 3):产物路径不再只用 basename——按报文内相对路径
  // 映射到 --artifact-dir 子结构,不同目录同名文件各归各,不相互踩踏。
  it('F3 五轮回归:不同目录同名文件 → 按报文相对路径映射子目录,不碰撞各自 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const fileA = path.join(receiver.root, 'subA', 'Monster.py');
    const fileB = path.join(receiver.root, 'subB', 'Monster.py');
    const contentA = 'class MonsterA:\n    HP = 21\n';
    const contentB = 'class MonsterB:\n    HP = 22\n';
    mkdirSync(path.dirname(fileA), { recursive: true });
    mkdirSync(path.dirname(fileB), { recursive: true });
    writeFileSync(fileA, contentA, 'utf8');
    writeFileSync(fileB, contentB, 'utf8');

    const response = await postReload(receiver.port, {
      files: [fileA, fileB],
      sender_digests: { [fileA]: sha256(contentA), [fileB]: sha256(contentB) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string }>;
    expect(receipts).toHaveLength(2);
    expect(receipts.map(receipt => receipt.status)).toEqual(['applied', 'applied']);
    // 各归各的子路径:同名不踩踏,内容逐字一致
    expect(readFileSync(path.join(engineDir, 'subA', 'Monster.py'), 'utf8')).toBe(contentA);
    expect(readFileSync(path.join(engineDir, 'subB', 'Monster.py'), 'utf8')).toBe(contentB);
  });

  // F3 六轮(复审 FAIL-1):映射必须跨批确定——不做批内共同祖先剥离,永远按
  // 报文内完整相对路径展开,与批次组成无关。旧实现 subA/X.py、subB/X.py 同批
  // → 各归子目录;分两次单文件发送 → 都映射到引擎目录根 X.py,后者覆盖前者。
  it('F3 六轮回归:跨批确定性映射——subA/X.py、subB/X.py 分两次单文件发送,各落子路径不覆盖', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const fileA = path.join(receiver.root, 'subA', 'X.py');
    const fileB = path.join(receiver.root, 'subB', 'X.py');
    const contentA = 'X_IN_SUB_A = 41\n';
    const contentB = 'X_IN_SUB_B = 42\n';
    mkdirSync(path.dirname(fileA), { recursive: true });
    mkdirSync(path.dirname(fileB), { recursive: true });
    writeFileSync(fileA, contentA, 'utf8');
    writeFileSync(fileB, contentB, 'utf8');

    // 第一批:只发 subA/X.py(单文件批)
    const first = await postReload(receiver.port, { files: [fileA], sender_digests: { [fileA]: sha256(contentA) } });
    const firstReceipt = JSON.parse(first.body) as { status: string };
    expect(firstReceipt.status).toBe('applied');
    // 第二批:只发 subB/X.py(单文件批)——批次组成不同,落位必须不变
    const second = await postReload(receiver.port, { files: [fileB], sender_digests: { [fileB]: sha256(contentB) } });
    const secondReceipt = JSON.parse(second.body) as { status: string };
    expect(secondReceipt.status).toBe('applied');
    // 各落各的子路径:第二批发送不覆盖第一批的产物,也不再裸落引擎目录根
    expect(readFileSync(path.join(engineDir, 'subA', 'X.py'), 'utf8')).toBe(contentA);
    expect(readFileSync(path.join(engineDir, 'subB', 'X.py'), 'utf8')).toBe(contentB);
    expect(existsSync(path.join(engineDir, 'X.py'))).toBe(false);
  });

  // F3 六轮(复审 FAIL-2):字符串检查防不住产物目录内的符号链接——产物落位
  // 的某级目录是指向引擎目录外的 symlink 时,沿它写入会把产物写到引擎目录外。
  // 修后:写/unlink 前对目标 realpath 解析,验证仍在 artifact-dir 内,否则拒绝。
  it('F3 六轮回归:产物目录内符号链接指向目录外 → 拒绝写入不落盘', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-outside-'));
    outsideDirs.push(outsideDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    // 产物子路径 subLink 是指向引擎目录外的 symlink
    symlinkSync(outsideDir, path.join(engineDir, 'subLink'), 'dir');
    const file = path.join(receiver.root, 'subLink', 'X.py');
    const content = 'X_ESCAPE_PROBE = 51\n';
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('逃逸');
    // 绝不沿 symlink 把产物写到引擎目录外,也不在链接处落任何东西
    expect(existsSync(path.join(outsideDir, 'X.py'))).toBe(false);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 五轮(R2-F3 硬化 3 防线):清洗后仍映射到同一产物位置(同一路径在批
  // 内重复出现)→ 拒绝整批,不写任何盘、不落台账。
  it('F3 五轮回归:批内映射到同一产物位置(同一路径重复)→ 拒绝整批不写盘', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 23\n';
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, {
      files: [file, file],
      sender_digests: { [file]: sha256(content) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; reason?: string }>;
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.status).toBe('failed');
      expect(receipt.reason).toContain('拒绝整批');
    }
    // 整批拒绝:引擎目录不写任何产物,不落任何 applied 台账
    expect(existsSync(path.join(engineDir, 'Avatar.py'))).toBe(false);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 五轮(R2-F3 硬化 4):写前读原内容——失败回滚**还原原内容**而非删除,
  // 绝不误删引擎目录里已 applied 的旧产物;回滚只及本次失败那一个文件。
  it('F3 五轮回归:预存在产物失败回滚 → 还原原内容而非删除', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 31\n';
    writeFileSync(file, content, 'utf8');
    // 引擎目录里已有上一批 applied 的旧产物
    const engineFile = path.join(engineDir, 'Avatar.py');
    const oldContent = 'class Avatar:\n    HP = 30\n';
    writeFileSync(engineFile, oldContent, 'utf8');
    const wrongDigest = sha256('drifted away');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: wrongDigest } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('不一致');
    // 旧产物被还原原内容,而不是被删除(删除会让引擎目录丢掉已 applied 的版本)
    expect(readFileSync(engineFile, 'utf8')).toBe(oldContent);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('F3 五轮回归:多文件批坏文件回滚只及该文件且还原其原内容,好文件照常 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const good = path.join(receiver.root, 'Avatar.py');
    const bad = path.join(receiver.root, 'Monster.py');
    const goodContent = 'class Avatar:\n    HP = 32\n';
    const badContent = 'class Monster:\n    HP = 33\n';
    writeFileSync(good, goodContent, 'utf8');
    writeFileSync(bad, badContent, 'utf8');
    // 坏文件在引擎目录里也有上一批 applied 的旧产物:回滚必须还原它,好文件不受牵连
    const badOld = 'class Monster:\n    HP = 30\n';
    writeFileSync(path.join(engineDir, 'Monster.py'), badOld, 'utf8');

    const response = await postReload(receiver.port, {
      files: [good, bad],
      sender_digests: { [good]: sha256(goodContent), [bad]: sha256('drifted baseline') }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string }>;
    const goodReceipt = receipts.find(receipt => receipt.file === good);
    const badReceipt = receipts.find(receipt => receipt.file === bad);
    expect(goodReceipt?.status).toBe('applied');
    expect(badReceipt?.status).toBe('failed');
    // 好文件产物逐字一致;坏文件产物还原上一批原内容(非删除)
    expect(readFileSync(path.join(engineDir, 'Avatar.py'), 'utf8')).toBe(goodContent);
    expect(readFileSync(path.join(engineDir, 'Monster.py'), 'utf8')).toBe(badOld);
    const ledger = readFileSync(path.join(receiver.root, 'applied-revisions.jsonl'), 'utf8');
    expect(JSON.parse(ledger.trim().split('\n')[0])).toMatchObject({ file: good });
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
    // F3 四轮:applied 路径=接收端自己写产物(writeFileSync)+ 哈希不符回滚
    expect(source).toContain('sender_digests');
    expect(source).toContain('--artifact-dir');
    expect(source).toContain('writeFileSync');
    expect(source).toContain('unlinkSync');
  });
});
