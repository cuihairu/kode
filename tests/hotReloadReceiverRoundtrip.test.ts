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
//
// SRC-012 可选拆(2026-11-09):F3 四五六轮 apply/回滚/映射证据迁 hotReloadReceiverApply.test.ts,
// 七八九轮与九轮复审 路径/别名安全证据迁 hotReloadReceiverSafety.test.ts,共享接收端装具迁
// tests/helpers/hotReloadReceiverHarness.ts。本文件留回执协议证据与通道 sender_digests 面。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAcceptedReceipt } from '../src/backend/hotReloadReceipt';
import { verifyAppliedReceipt } from '../src/backend/hotReloadAppliedCheck';
import { buildHttpPresetConfig } from '../src/backend/hotReloadChannelConfig';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import { defaultReloadHttpRunner, HttpReloadTransport } from '../src/backend/hotReloadTransport';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createHotReloadReceiverRoundtripHarness, RECEIVER_SCRIPT } from './helpers/hotReloadReceiverHarness';

describe('IDE-AUD-007 参考接收端真实回环联调(accepted/applied 协议证据)', () => {
  let harness: ReturnType<typeof createHotReloadReceiverRoundtripHarness>;
  let engineDirs: string[];
  let start: (typeof harness)['start'];
  let makeTransport: (typeof harness)['makeTransport'];
  let sha256: (typeof harness)['sha256'];

  beforeEach(() => {
    harness = createHotReloadReceiverRoundtripHarness();
    engineDirs = harness.engineDirs;
    start = harness.start;
    makeTransport = harness.makeTransport;
    sha256 = harness.sha256;
  });

  afterEach(() => {
    harness.dispose();
  });

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

  it('预设一键启用的默认配置真发一遍:JSON 对象体带 targetId/sender_digests → applied', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-engine-'));
    engineDirs.push(engineDir);
    const receiver = await start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    const content = 'class Avatar:\n    HP = 7\n';
    writeFileSync(file, content, 'utf8');
    const sentDigest = sha256(content);

    // 快捷启用预设的默认参数(本机端口/路径 + JSON 对象体);只把端口换成实测端口
    const preset = buildHttpPresetConfig(undefined);
    expect(preset.http?.body).toBe('{"files":${files}}');
    const entry = { ...preset.http!, url: `http://127.0.0.1:${receiver.port}/reload` };
    const transport = new HttpReloadTransport(entry, {
      run: request => defaultReloadHttpRunner(request)
    });
    const summary = await transport.send(
      { rootId: '/ws', targetId: 'baseapp-1' },
      [file],
      () => {},
      new Map([[file, sentDigest]])
    );
    // 对象体才会被 transport 自动附上 targetId/sender_digests:接收端核对 digest
    // 后自己写产物才回 applied(裸 ${files} 数组体到不了这一步)
    expect(summary.receipts[0]).toMatchObject({ status: 'applied', file });
    expect(readFileSync(path.join(engineDir, 'Avatar.py'), 'utf8')).toBe(content);
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
