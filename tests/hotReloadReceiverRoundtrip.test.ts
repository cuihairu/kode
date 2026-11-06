import * as http from 'http';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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
  extraArgs: string[] = [],
  shellPrelude?: string,
  rootOverride?: string
): Promise<ReceiverHandle> => {
  const root = rootOverride ?? mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-receiver-'));
  const argv = ['--port', '0', '--root', root, '--mode', mode, '--scenario', scenario, ...extraArgs];
  // shellPrelude:经 sh 包裹启动(如 ulimit 资源上限注入),仅测试构造资源型
  // 失败用;默认直接 spawn node。路径均无空格,单引号包裹足够。
  const proc =
    shellPrelude === undefined
      ? spawn(process.execPath, [RECEIVER_SCRIPT, ...argv], { stdio: ['ignore', 'pipe', 'inherit'] })
      : spawn(
          'sh',
          [
            '-c',
            `${shellPrelude}; exec '${process.execPath}' '${RECEIVER_SCRIPT}' ${argv.map(arg => `'${arg}'`).join(' ')}`
          ],
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

  const start = async (mode: string, scenario: string, extraArgs: string[] = [], shellPrelude?: string, rootOverride?: string): Promise<ReceiverHandle> => {
    const handle = await startReceiver(mode, scenario, extraArgs, shellPrelude, rootOverride);
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

  // F3 五轮(R2-F3 硬化 1+2)→ 七轮按 temp+rename 机制重造:落盘全部发生在
  // 自建临时文件上('wx' 独占创建),引擎目录只读(0o555)时临时文件创建即
  // 失败 → failed;既有产物从头到尾未被触碰、无临时文件残留。(旧构造
  // 「0444 只读旧产物」在 temp+rename 下 rename 原子替换不读目标权限,如实
  // applied——该场景由目录级只读替代构造真实的落盘失败。)
  it('F3 七轮回归:引擎目录只读(0o555)落盘失败 → failed,既有产物原样无残留', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 11\n';
    writeFileSync(file, content, 'utf8');
    // 既有旧产物 + 引擎目录只读:临时文件创建失败 → 落盘失败,旧产物不被触碰
    const engineFile = path.join(engineDir, 'Avatar.py');
    const oldContent = 'class Avatar:\n    HP = 10\n';
    writeFileSync(engineFile, oldContent, 'utf8');
    chmodSync(engineDir, 0o555);

    try {
      const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
      const receipt = JSON.parse(response.body) as { status: string; reason?: string; rollback_failed?: string };
      expect(receipt.status).toBe('failed');
      expect(receipt.reason).toContain('落盘失败');
      // 既有产物逐字节原样(temp+rename 下失败收尾不碰产物)
      expect(readFileSync(engineFile, 'utf8')).toBe(oldContent);
      // 无临时文件残留,回执不虚报 rollback_failed
      expect(readdirSync(engineDir).filter(name => name.startsWith('.kode-artifact-tmp-'))).toEqual([]);
      expect(receipt).not.toHaveProperty('rollback_failed');
      expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
    } finally {
      chmodSync(engineDir, 0o755);
    }
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

  // F3 五轮(R2-F3 硬化 4)→ 七轮机制:temp+rename 下哈希不符只在临时文件
  // 上发生,既有产物从未被触碰(不删不改写,强于「还原原内容」)。
  it('F3 七轮回归:哈希不符失败 → 预存在产物原样保留(不删不改写)', async () => {
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
    // 旧产物原样保留(temp+rename 下失败只清理临时文件,产物位未被写入)
    expect(readFileSync(engineFile, 'utf8')).toBe(oldContent);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  it('F3 七轮回归:多文件批坏文件失败只清自己的临时文件,好文件照常 applied,坏文件旧产物原样', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const good = path.join(receiver.root, 'Avatar.py');
    const bad = path.join(receiver.root, 'Monster.py');
    const goodContent = 'class Avatar:\n    HP = 32\n';
    const badContent = 'class Monster:\n    HP = 33\n';
    writeFileSync(good, goodContent, 'utf8');
    writeFileSync(bad, badContent, 'utf8');
    // 坏文件在引擎目录里也有上一批 applied 的旧产物:失败只清坏文件自己的
    // 临时文件,旧产物原样,好文件不受牵连
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
    // 好文件产物逐字一致;坏文件旧产物原样(只清了它自己的临时文件)
    expect(readFileSync(path.join(engineDir, 'Avatar.py'), 'utf8')).toBe(goodContent);
    expect(readFileSync(path.join(engineDir, 'Monster.py'), 'utf8')).toBe(badOld);
    const ledger = readFileSync(path.join(receiver.root, 'applied-revisions.jsonl'), 'utf8');
    expect(JSON.parse(ledger.trim().split('\n')[0])).toMatchObject({ file: good });
  });

  // F3 六轮(复审 FAIL-4 闭合):部分写入后抛错 → 残留被回滚清理,如实报告
  // 「无残留」。用 RLIMIT_FSIZE 构造真实的「写一半再抛错」:接收端在
  // ulimit -f 2(单文件 1024 字节上限)下运行,900B 源文件可暂存,但产物内容
  // (非法 UTF-8 字节读入后再编码为 1100B)落盘越过上限 → 写入中途 EFBIG,
  // 留下 1024B 部分写入残留,回滚必须把它清干净。
  it('F3 六轮回归:部分写入后抛错(RLIMIT_FSIZE)→ 残留被清理,如实「无残留」', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir], 'ulimit -f 2');
    const file = path.join(receiver.root, 'Big.py');
    // 800×'A' + 100×0x80(非法 UTF-8):接收端 utf8 读入得 100 个 U+FFFD,
    // 再编码落盘 = 800 + 300 = 1100B > 1024B 上限;暂存副本(原始 900B)可过
    const raw = Buffer.concat([Buffer.alloc(800, 0x41), Buffer.alloc(100, 0x80)]);
    writeFileSync(file, raw);
    const decoded = readFileSync(file, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(decoded) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('落盘失败');
    // 部分写入残留(1024B 半成品)被回滚清理:引擎目录无残留,如实声明
    expect(existsSync(path.join(engineDir, 'Big.py'))).toBe(false);
    expect(receipt).not.toHaveProperty('rollback_failed');
    expect(receipt.reason).toContain('无残留');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 七轮(复审 FAIL-1):根内外命名空间碰撞——六轮对暂存根之外的文件回落
  // 「绝对路径全结构展开」,但该回落与根内相对路径共享同一命名空间:根内
  // <root>/tmp/X.py 映射 tmp/X.py,根外 /tmp/X.py 回落也展开成 tmp/X.py,
  // 分批发送后者覆盖前者。修后根外路径直接拒绝整批,产物命名空间只剩根内
  // 相对路径一种归属。
  it('F3 七轮回归:根内 tmp/X.py 与根外 /tmp/X.py 分批发送 → 根外拒绝整批,产物不被覆盖', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    // 根内:<root>/tmp/X.py → 映射 tmp/X.py
    const insideFile = path.join(receiver.root, 'tmp', 'X.py');
    const contentA = 'X_INSIDE_ROOT = 61\n';
    mkdirSync(path.dirname(insideFile), { recursive: true });
    writeFileSync(insideFile, contentA, 'utf8');
    const first = await postReload(receiver.port, { files: [insideFile], sender_digests: { [insideFile]: sha256(contentA) } });
    expect(JSON.parse(first.body as string).status).toBe('applied');
    // 根外:/tmp/X.py(与暂存根只差最后一层目录名,回落展开同名 tmp/X.py)
    const outsideFile = path.join(os.tmpdir(), 'X.py');
    const hadOriginal = existsSync(outsideFile);
    const originalBytes = hadOriginal ? readFileSync(outsideFile) : undefined;
    const contentB = 'X_OUTSIDE_ROOT = 62\n';
    writeFileSync(outsideFile, contentB, 'utf8');
    try {
      const second = await postReload(receiver.port, { files: [outsideFile], sender_digests: { [outsideFile]: sha256(contentB) } });
      const receipt = JSON.parse(second.body) as { status: string; reason?: string };
      // 根外路径拒绝整批:不写盘、不落台账
      expect(receipt.status).toBe('failed');
      expect(receipt.reason).toContain('暂存根之外');
      // 第一批的产物不被第二批覆盖,也不落引擎目录根
      expect(readFileSync(path.join(engineDir, 'tmp', 'X.py'), 'utf8')).toBe(contentA);
      expect(existsSync(path.join(engineDir, 'X.py'))).toBe(false);
      // 台账只有第一批(根内)的 applied 记录,根外拒绝不产生任何台账条目
      const ledger = readFileSync(path.join(receiver.root, 'applied-revisions.jsonl'), 'utf8');
      const ledgerEntries = ledger.trim().split('\n').map(line => JSON.parse(line) as { file: string });
      expect(ledgerEntries).toHaveLength(1);
      expect(ledgerEntries[0].file).toBe(insideFile);
    } finally {
      if (hadOriginal && originalBytes !== undefined) {
        writeFileSync(outsideFile, originalBytes);
      } else {
        rmSync(outsideFile, { force: true });
      }
    }
  });

  // F3 六轮(复审 FAIL-2)七轮补口:悬空 symlink 穿透——最终组件是指向引擎
  // 目录外**不存在文件**的 symlink 时,realpath 抛 ENOENT 回落到最深已存在
  // 祖先(引擎目录本身)→ 六轮防护误判安全 → 写入沿悬空链接把产物落到引擎
  // 目录外。修后写前 lstat 最终组件:是 symlink(无论悬空与否)一律拒绝。
  it('F3 七轮回归:产物位悬空 symlink 指向目录外 → 拒绝写入不逃逸', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-outside-'));
    outsideDirs.push(outsideDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    // 产物位 = 悬空 symlink → 引擎目录外的不存在文件
    symlinkSync(path.join(outsideDir, 'missing.py'), path.join(engineDir, 'Dangling.py'), 'file');
    const file = path.join(receiver.root, 'Dangling.py');
    const content = 'X_DANGLING_PROBE = 71\n';
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('符号链接');
    // 绝不沿悬空链接把产物写到引擎目录外,链接本身也不被动过
    expect(existsSync(path.join(outsideDir, 'missing.py'))).toBe(false);
    expect(lstatSync(path.join(engineDir, 'Dangling.py')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 七轮:lstat 拒链接不分悬空与否——产物位是**指向引擎目录内**的 symlink
  // 也一律拒绝(链接位被整体替换的语义不引入;产物只落自建普通文件)。
  it('F3 七轮回归:产物位 symlink 指向目录内也一律拒绝', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    // 引擎目录内真实文件,产物位是指向它的 symlink
    writeFileSync(path.join(engineDir, 'real.py'), 'REAL = 1\n', 'utf8');
    symlinkSync(path.join(engineDir, 'real.py'), path.join(engineDir, 'Linked.py'), 'file');
    const file = path.join(receiver.root, 'Linked.py');
    const content = 'X_LINKED_PROBE = 72\n';
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('符号链接');
    // 链接与其目标都原样
    expect(lstatSync(path.join(engineDir, 'Linked.py')).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(engineDir, 'real.py'), 'utf8')).toBe('REAL = 1\n');
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 八轮(复审缺陷 2):暂存副本不再按 basename 落暂存根顶层——同批
  // <root>/sub/X.py 与 <root>/X.py 的顶层暂存路径相同,前者暂存动作直接把
  // 后者的**源文件**覆盖掉(后续读到的是被污染内容,digest 自然不符)。修后
  // 每文件按已清洗防碰撞的报文相对路径独立展开到 <root>/.staged/<相对路径>,
  // 同批互不覆盖、也碰不到任何源文件。
  it('F3 八轮回归:同批 sub/X.py 与 X.py → 暂存互不覆盖,源文件不被暂存动作污染', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const subFile = path.join(receiver.root, 'sub', 'X.py');
    const topFile = path.join(receiver.root, 'X.py');
    const subContent = 'X_IN_SUB = 81\n';
    const topContent = 'X_AT_TOP = 82\n';
    mkdirSync(path.dirname(subFile), { recursive: true });
    writeFileSync(subFile, subContent, 'utf8');
    writeFileSync(topFile, topContent, 'utf8');

    const response = await postReload(receiver.port, {
      files: [subFile, topFile],
      sender_digests: { [subFile]: sha256(subContent), [topFile]: sha256(topContent) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string; reason?: string }>;
    const subReceipt = receipts.find(receipt => receipt.file === subFile);
    const topReceipt = receipts.find(receipt => receipt.file === topFile);
    // 两个文件各自 applied:暂存动作没有污染任何源文件
    expect(subReceipt?.status).toBe('applied');
    expect(topReceipt?.status).toBe('applied');
    // 源文件逐字原样(旧实现:sub/X.py 的暂存副本按 basename 覆盖 root/X.py 源文件)
    expect(readFileSync(subFile, 'utf8')).toBe(subContent);
    expect(readFileSync(topFile, 'utf8')).toBe(topContent);
    // 产物各归各的相对路径
    expect(readFileSync(path.join(engineDir, 'sub', 'X.py'), 'utf8')).toBe(subContent);
    expect(readFileSync(path.join(engineDir, 'X.py'), 'utf8')).toBe(topContent);
    // 暂存副本独立子目录,各自内容正确,不再落暂存根顶层
    expect(readFileSync(path.join(receiver.root, '.staged', 'sub', 'X.py'), 'utf8')).toBe(subContent);
    expect(readFileSync(path.join(receiver.root, '.staged', 'X.py'), 'utf8')).toBe(topContent);
  });

  // F3 八轮(复审缺陷 1):目录竞争包含性验证——产物父目录链中某级是**指向
  // 引擎目录内**的 symlink 时,六轮包含性检查放行(解析结果仍在引擎目录内),
  // 旧 rename 直接沿真实父目录落盘(路径实际经 symlink 组件到达别处)。修后
  // rename 前 realpath 父目录并做双重验证:包含性(在引擎目录 real 内)+ 一致性
  // (解析结果与原路径逐字一致,否则说明有 symlink 组件)→ 一致性不过即拒绝。
  // 竞态(检查后目录被换成外部 symlink)在同一代码路径上被同一验证拦截;
  // JS 无 O_NOFOLLOW,realpath→rename 一瞬的残余窗口如实记录(见设计 §4.3)。
  it('F3 八轮回归:父目录链含 symlink 组件(指向引擎目录内)→ rename 前拒绝,不落盘', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    // 产物父目录 sub 是指向引擎目录内 other/ 的 symlink:包含性检查(六轮)放行
    mkdirSync(path.join(engineDir, 'other'), { recursive: true });
    symlinkSync(path.join(engineDir, 'other'), path.join(engineDir, 'sub'), 'dir');
    const file = path.join(receiver.root, 'sub', 'X.py');
    const content = 'X_THROUGH_LINK = 83\n';
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('符号链接');
    // 旧实现沿 symlink 组件把产物落进 engineDir/other/X.py;修后不落盘
    expect(existsSync(path.join(engineDir, 'other', 'X.py'))).toBe(false);
    // 链接原样,无台账,引擎目录根无临时残留
    expect(lstatSync(path.join(engineDir, 'sub')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
    const engineEntries = readdirSync(engineDir).filter(name => name.startsWith('.kode-artifact-tmp-'));
    expect(engineEntries).toHaveLength(0);
  });

  // F3 九轮(复审窄点 1):暂存命名空间仍在允许源文件树内——八轮把暂存副本
  // 展开到 <root>/.staged/<相对路径>,但源路径清洗不排除 .staged 前缀:同批
  // 含既有 <root>/.staged/X.py 源文件时,<root>/X.py 的暂存副本 copyFileSync
  // 直接覆盖该源文件。修后 .staged 前缀源路径属接收端暂存命名空间,拒绝整批。
  it('F3 九轮回归:同批含 .staged 命名空间源文件 → 拒绝整批,既有 .staged/X.py 源文件不被暂存覆盖', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const topFile = path.join(receiver.root, 'X.py');
    const stagedSource = path.join(receiver.root, '.staged', 'X.py');
    const topContent = 'X_AT_TOP = 91\n';
    const stagedContent = 'X_STAGED_SRC = 92\n';
    mkdirSync(path.dirname(stagedSource), { recursive: true });
    writeFileSync(topFile, topContent, 'utf8');
    writeFileSync(stagedSource, stagedContent, 'utf8');

    const response = await postReload(receiver.port, {
      files: [topFile, stagedSource],
      sender_digests: { [topFile]: sha256(topContent), [stagedSource]: sha256(stagedContent) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string; reason?: string }>;
    expect(receipts).toHaveLength(2);
    // 拒绝整批:两个文件都 failed 且 reason 点名 .staged 暂存命名空间
    for (const receipt of receipts) {
      expect(receipt.status).toBe('failed');
      expect(receipt.reason).toContain('.staged');
    }
    // 旧实现:topFile 的暂存副本落 <root>/.staged/X.py,直接覆盖既有源文件——
    // 修后两个源文件都逐字原样
    expect(readFileSync(stagedSource, 'utf8')).toBe(stagedContent);
    expect(readFileSync(topFile, 'utf8')).toBe(topContent);
    // 整批拒绝:无任何产物落盘、无暂存副本、无应用台账
    expect(existsSync(path.join(engineDir, 'X.py'))).toBe(false);
    expect(existsSync(path.join(engineDir, '.staged', 'X.py'))).toBe(false);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 九轮(复审窄点 1,暂存路径 symlink):暂存写入此前无 symlink 检查——
  // .staged(或更深目录)被换成指向暂存根外的 symlink 时,copyFileSync 沿
  // 链接把暂存副本写到暂存根外。修后暂存写前做与 rename 目标同一套双重验证
  // (包含性+一致性)+ lstat 最终组件拒 symlink,任一不过即拒绝本文件暂存。
  it('F3 九轮回归:.staged 是指向暂存根外的 symlink → 拒绝暂存,副本不沿链接逃逸', async () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-outside-'));
    outsideDirs.push(outsideDir);
    const receiver = await start('stage', 'accepted');
    // 接收端尚未自建暂存目录,.staged 预置为指向暂存根外的目录 symlink
    const escapeDir = path.join(outsideDir, 'escape');
    mkdirSync(escapeDir, { recursive: true });
    symlinkSync(escapeDir, path.join(receiver.root, '.staged'), 'dir');
    const file = path.join(receiver.root, 'X.py');
    const content = 'X_STAGE_LINK = 93\n';
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file] });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('符号链接');
    // 暂存副本绝不沿链接落到暂存根外,链接原样
    expect(readdirSync(escapeDir)).toHaveLength(0);
    expect(lstatSync(path.join(receiver.root, '.staged')).isSymbolicLink()).toBe(true);
  });

  // F3 九轮复审 FAIL-1 补口:词法 '.staged' 排除挡不住指向暂存树的 symlink
  // 别名——root/alias → root/.staged 时,同批发送 [root/X.py, root/alias/A.py]
  // (A.py 预置于暂存树内),X.py 的暂存目标 .staged/X.py 虽不直接覆盖 A.py,
  // 但 alias/A.py 读取经别名落到暂存树内、内容可被批内暂存动作影响——整批
  // 必须在写入前拒绝。
  it('F3 九轮复审回归:源路径 symlink 别名指向暂存树 → 拒绝整批', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    // 既有真实源文件落在暂存树内,另经别名 symlink 指向暂存树
    const stagedSource = path.join(receiver.root, '.staged', 'A.py');
    const aliasFile = path.join(receiver.root, 'alias', 'A.py');
    const topFile = path.join(receiver.root, 'X.py');
    const stagedContent = 'A_IN_STAGED = 61\n';
    const topContent = 'X_AT_TOP = 62\n';
    mkdirSync(path.dirname(stagedSource), { recursive: true });
    writeFileSync(stagedSource, stagedContent, 'utf8');
    symlinkSync(path.join(receiver.root, '.staged'), path.dirname(aliasFile), 'dir');
    writeFileSync(topFile, topContent, 'utf8');

    const response = await postReload(receiver.port, {
      files: [topFile, aliasFile],
      sender_digests: { [topFile]: sha256(topContent), [aliasFile]: sha256(stagedContent) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string; reason?: string }>;
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.status).toBe('failed');
    }
    // 暂存树内既有源文件不被批内暂存动作覆盖
    expect(readFileSync(stagedSource, 'utf8')).toBe(stagedContent);
    expect(existsSync(path.join(engineDir, 'X.py'))).toBe(false);
    expect(existsSync(path.join(engineDir, 'alias', 'A.py'))).toBe(false);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 九轮复审 FAIL-A 补口:悬空别名源 + 批内暂存补齐目标——alias/X.py 在
  // 批处理起点指向不存在的 .staged/X.py,同批 X.py 的暂存动作恰好把它「补齐」,
  // 旧实现预检放行后读取阶段经别名读到 X.py 的暂存副本内容并照常 applied。
  // 修后预检 realpath 失败但 lstat 成功(悬空链接)= 无法证明不在暂存树内 →
  // 写入前拒绝整批。
  it('F3 九轮复审回归:悬空别名源被批内暂存补齐 → 预检拒绝整批,不产生经别名的 applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const aliasDir = path.join(receiver.root, 'alias');
    const aliasFile = path.join(aliasDir, 'X.py');
    const topFile = path.join(receiver.root, 'X.py');
    const topContent = 'X_DANGLING_ALIAS = 64\n';
    // 暂存树目录预存在(上一批残留),目标文件尚不存在 → alias 悬空
    mkdirSync(path.join(receiver.root, '.staged'), { recursive: true });
    symlinkSync(path.join(receiver.root, '.staged'), aliasDir, 'dir');
    writeFileSync(topFile, topContent, 'utf8');

    const response = await postReload(receiver.port, {
      files: [topFile, aliasFile],
      sender_digests: { [topFile]: sha256(topContent), [aliasFile]: sha256(topContent) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string; reason?: string }>;
    expect(receipts).toHaveLength(2);
    // 旧实现:X.py 暂存补齐 .staged/X.py 后,alias/X.py 读取成功且 digest 恰与
    // 所发一致 → 两个 applied(经别名的应用通路);修后整批在写入前拒绝
    for (const receipt of receipts) {
      expect(receipt.status).toBe('failed');
      expect(receipt.reason).toContain('符号链接');
    }
    expect(existsSync(path.join(engineDir, 'X.py'))).toBe(false);
    expect(existsSync(path.join(engineDir, 'alias', 'X.py'))).toBe(false);
    expect(existsSync(path.join(receiver.root, 'applied-revisions.jsonl'))).toBe(false);
  });

  // F3 九轮复审 FAIL-4 兼容性回归:--root 自身经合法 symlink 祖先到达(如
  // macOS /tmp → /private/tmp)时,一致性验证必须相对已解析的暂存根比较,
  // 不误拒正常暂存;树内 symlink 组件仍拒绝(由既有八/九轮回归钉住)。
  it('F3 九轮复审回归:暂存根经 symlink 祖先到达 → 正常暂存不误拒', async () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-rootbase-'));
    engineDirs.push(baseDir); // 复用 afterEach 清理
    const engineDir = path.join(baseDir, 'engine');
    mkdirSync(engineDir, { recursive: true });
    // 真实根 + 经 symlink 到达的路径别名作为 --root
    const rootReal = path.join(baseDir, 'root-real');
    mkdirSync(rootReal, { recursive: true });
    symlinkSync(rootReal, path.join(baseDir, 'root-link'), 'dir');
    const rootViaLink = path.join(baseDir, 'root-link');
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir], undefined, rootViaLink);
    const file = path.join(rootViaLink, 'X.py');
    const content = 'X_ROOT_ALIAS = 63\n';
    writeFileSync(file, content, 'utf8');

    const response = await postReload(receiver.port, { files: [file], sender_digests: { [file]: sha256(content) } });
    const receipt = JSON.parse(response.body) as { status: string; reason?: string };
    expect(receipt.status).toBe('applied');
    expect(readFileSync(path.join(engineDir, 'X.py'), 'utf8')).toBe(content);
    // 暂存副本按解析后的相对路径落盘,内容正确
    expect(readFileSync(path.join(rootReal, '.staged', 'X.py'), 'utf8')).toBe(content);

    // 三轮 FAIL-2 补口:根自身是合法 symlink 时,真实缺失的源文件不得被祖先
    // 链探测误判为「疑似悬空别名」而整批拒绝——保持「读不到所发文件」逐文件
    // 失败语义,另一文件照常 applied
    const missingFile = path.join(rootViaLink, 'missing.py');
    const response2 = await postReload(receiver.port, {
      files: [file, missingFile],
      sender_digests: { [file]: sha256(content), [missingFile]: sha256('whatever') }
    });
    const receipts2 = JSON.parse(response2.body) as Array<{ status: string; file: string; reason?: string }>;
    const missingReceipt = receipts2.find(r => r.file === missingFile);
    const goodReceipt = receipts2.find(r => r.file === file);
    expect(missingReceipt?.status).toBe('failed');
    expect(missingReceipt?.reason).toContain('读不到');
    expect(goodReceipt?.status).toBe('applied');
  });

  // F3 九轮复审三轮 FAIL-1 补口:源文件**自身**是悬空 symlink(final 组件)
  // 时同样会在批内暂存补齐目标后经别名复活——预检必须连文件自身一起查。
  it('F3 九轮复审回归:源文件自身为悬空 symlink → 预检拒绝整批', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const aliasFile = path.join(receiver.root, 'alias.py');
    const topFile = path.join(receiver.root, 'X.py');
    const topContent = 'X_FILE_ALIAS = 65\n';
    // 暂存树目录预存在,alias.py → .staged/X.py(尚不存在,悬空)
    mkdirSync(path.join(receiver.root, '.staged'), { recursive: true });
    symlinkSync(path.join(receiver.root, '.staged', 'X.py'), aliasFile, 'file');
    writeFileSync(topFile, topContent, 'utf8');

    const response = await postReload(receiver.port, {
      files: [topFile, aliasFile],
      sender_digests: { [topFile]: sha256(topContent), [aliasFile]: sha256(topContent) }
    });
    const receipts = JSON.parse(response.body) as Array<{ status: string; file: string; reason?: string }>;
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.status).toBe('failed');
      expect(receipt.reason).toContain('符号链接');
    }
    expect(existsSync(path.join(engineDir, 'X.py'))).toBe(false);
    expect(existsSync(path.join(engineDir, 'alias.py'))).toBe(false);
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
    // F3 四轮:applied 路径=接收端自己写产物(独占自建+写入)+ 哈希不符回滚
    expect(source).toContain('sender_digests');
    expect(source).toContain('--artifact-dir');
    // F3 八轮:temp+rename 收尾只清**确认自建**的临时文件(创建成功点标志位),
    // rename 前父目录包含性+一致性双重验证,暂存副本独立唯一子目录
    expect(source).toContain('openSync');
    expect(source).toContain('writeSync');
    expect(source).toContain('verifiedRealParentForRename');
    expect(source).toContain("'.staged'");
    expect(source).toContain('unlinkSync');
    // F3 九轮:.staged 源命名空间排除、暂存路径 symlink 双重验证、
    // 收尾清理 dev/ino 与创建时比对(不符跳过报 rollback_skipped)
    expect(source).toContain('safeStagingTarget');
    expect(source).toContain('rollback_skipped');
    expect(source).toContain('fstatSync');
    // F3 七轮:temp+rename 原子写 + lstat 拒链接——源码钉住新写入机制
    expect(source).toContain('renameSync');
    expect(source).toContain('lstatSync');
    expect(source).toContain("'wx'");
  });
});
