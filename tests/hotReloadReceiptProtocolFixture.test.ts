// RUST-427(旧 HR-QA-015):用受控真实测试服务验证「accepted」与「applied」语义,
// 并固化协议 fixture(tests/fixtures/hot-reload-protocol/receipts.json)。
//
// 语义区分(可观察):
//   * accepted = 接收端暂存收下、应用**尚未发生**:引擎产物树无文件、回执不含
//     应用证据字段(digest/revision),台账升格 accepted 注解但**非** applied,
//     仍等待 HOT-004 applied 核验;
//   * applied = 应用**真实发生**:接收端自己写产物(独占自建+原子替换)且重算
//     sha256 与发送时点冻结基准一致才回 applied,引擎产物树内容=所发内容,
//     台账升格 applied。
// stage 诚实:stage 模式即使 sender_digests 匹配也只回 accepted,绝不自行升级
// applied(接受端不伪造应用)。批量规则:单文件=单对象、多文件=数组逐条,
// targetId 逐字回显。
//
// 协议 fixture 固化:真实回包字段集**恰为冻结形状**(精确键集断言,非
// toMatchObject 宽松断言),fixture 与生产解析器字段集一致(改 fixture 形状或
// 改生产解析器接受面任一即红)。真实服务=scripts/hot-reload-receiver/
// referenceReceiver.mjs(受控回环 HTTP,零依赖 node:http 实现已记录契约)。

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAcceptedReceipt } from '../src/backend/hotReloadReceipt';
import { verifyAppliedReceipt } from '../src/backend/hotReloadAppliedCheck';
import { parseReloadHttpReceipts } from '../src/backend/hotReloadTransport';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import { createHotReloadReceiverRoundtripHarness } from './helpers/hotReloadReceiverHarness';

type ReceiptShape = 'accepted' | 'applied' | 'failed';
interface ReceiptFieldSpec {
  const?: string;
  type?: string;
  pattern?: string;
  minimum?: number;
  optional?: boolean;
}
interface Fixture {
  receipts: Record<ReceiptShape, { required: string[]; fields: Record<string, ReceiptFieldSpec> }>;
  batchRule: { singleFile: string; multiFile: string };
}

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'hot-reload-protocol', 'receipts.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

/** 固化形状校验:必填在场+无意外键+const/type/pattern/minimum 逐项钉 */
const assertConforms = (receipt: unknown, shape: ReceiptShape): void => {
  expect(typeof receipt).toBe('object');
  expect(receipt).not.toBeNull();
  expect(Array.isArray(receipt)).toBe(false);
  const record = receipt as Record<string, unknown>;
  const spec = fixture.receipts[shape];
  const allowed = Object.keys(spec.fields);
  for (const key of spec.required) {
    expect(Object.keys(record)).toContain(key);
  }
  for (const key of Object.keys(record)) {
    expect(allowed).toContain(key);
  }
  for (const [key, field] of Object.entries(spec.fields)) {
    if (!(key in record)) {
      continue;
    }
    if (field.const !== undefined) {
      expect(record[key]).toBe(field.const);
    }
    if (field.type === 'string') {
      expect(typeof record[key]).toBe('string');
      if (field.pattern !== undefined) {
        expect(record[key]).toMatch(new RegExp(field.pattern));
      }
    }
    if (field.type === 'integer') {
      expect(Number.isInteger(record[key])).toBe(true);
      if (field.minimum !== undefined) {
        expect(record[key] as number).toBeGreaterThanOrEqual(field.minimum);
      }
    }
  }
};

describe('RUST-427 accepted 与 applied 语义(受控真实服务)+ 协议 fixture 固化', () => {
  let harness: ReturnType<typeof createHotReloadReceiverRoundtripHarness>;
  let engineDirs: string[];

  const sha256 = (content: string): string => createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

  beforeEach(() => {
    harness = createHotReloadReceiverRoundtripHarness();
    // 引擎产物目录进 harness 台账(dispose 统一清理)
    engineDirs = harness.engineDirs;
  });

  afterEach(() => {
    harness.dispose();
  });

  const makeEngineDir = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kode-rust427-engine-'));
    engineDirs.push(dir);
    return dir;
  };

  it('accepted 语义:真实回包字段集恰为冻结形状,引擎产物树无文件(应用未发生),stage 模式不伪造 applied', async () => {
    const receiver = await harness.start('stage', 'accepted', ['--artifact-dir', makeEngineDir()]);
    const engineDir = engineDirs[engineDirs.length - 1];
    const file = path.join(receiver.root, 'Stage.py');
    const content = 'class Stage:\n    pass\n';
    writeFileSync(file, content, 'utf8');
    const sentDigest = sha256(content);

    // 真实服务回包体(受控回环 HTTP);sender_digests 匹配但 stage 模式不产 applied
    const { status, body } = await harness.postReload(receiver.port, {
      files: [file],
      targetId: 't-stage',
      sender_digests: { [file]: sentDigest }
    });
    expect(status).toBe(200);
    const receipt = JSON.parse(body) as Record<string, unknown>;
    // 单文件=单对象(批量规则),字段集恰为冻结 accepted 形状(无 digest/revision)
    expect(Array.isArray(receipt)).toBe(false);
    assertConforms(receipt, 'accepted');
    expect(Object.keys(receipt).sort()).toEqual(['file', 'status', 'targetId']);
    expect(receipt.file).toBe(file);
    expect(receipt.targetId).toBe('t-stage');
    expect(receipt).not.toHaveProperty('digest');
    expect(receipt).not.toHaveProperty('revision');

    // 应用未发生:引擎产物树无该文件(stage 模式只在暂存命名空间收副本,不写产物)
    expect(existsSync(path.join(engineDir, 'Stage.py'))).toBe(false);

    // 台账语义:accepted 注解但非 applied;applied 核验面拒收 accepted 回执
    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 't-stage' };
    store.record(key, file, 'sent-unverified', { sentDigest });
    const acceptedVerdict = applyAcceptedReceipt(store, key, file, body, { attempt: 1 });
    expect(acceptedVerdict.kind).toBe('accepted');
    expect(store.get(key, file)?.outcome).toBe('accepted');
    const appliedVerdict = verifyAppliedReceipt(store, key, file, body, { sentDigest, attempt: 1 });
    expect(appliedVerdict.kind).toBe('not-applied');
    expect((appliedVerdict as { reason: string }).reason).toContain('状态非 applied');
    expect(store.get(key, file)?.outcome).toBe('accepted');
    // 生产解析器:accepted 回执解析为 accepted(不 claim applied)
    expect(parseReloadHttpReceipts(body, [file])[0]?.status).toBe('accepted');
  }, 20000);

  it('applied 语义:真实回包字段集恰为冻结形状且 digest=发送基准,引擎产物树内容=所发内容;批量=数组逐条+targetId 逐字回显', async () => {
    const engineDir = makeEngineDir();
    const receiver = await harness.start('apply', 'applied', ['--artifact-dir', engineDir]);
    const fileA = path.join(receiver.root, 'Alpha.py');
    const fileB = path.join(receiver.root, 'Beta.py');
    const contentA = 'class Alpha:\n    HP = 100\n';
    const contentB = 'class Beta:\n    MP = 200\n';
    writeFileSync(fileA, contentA, 'utf8');
    writeFileSync(fileB, contentB, 'utf8');
    const digestA = sha256(contentA);
    const digestB = sha256(contentB);

    // 单文件:applied 单对象,字段集恰为冻结形状,digest=发送时点冻结基准,revision 自增自 1
    const single = await harness.postReload(receiver.port, {
      files: [fileA],
      targetId: 't-apply',
      sender_digests: { [fileA]: digestA }
    });
    expect(single.status).toBe(200);
    const applied = JSON.parse(single.body) as Record<string, unknown>;
    expect(Array.isArray(applied)).toBe(false);
    assertConforms(applied, 'applied');
    expect(Object.keys(applied).sort()).toEqual(['digest', 'file', 'revision', 'status', 'targetId']);
    expect(applied.file).toBe(fileA);
    expect(applied.digest).toBe(digestA);
    expect(applied.revision).toBe(1);
    expect(applied.targetId).toBe('t-apply');

    // 应用真实发生:引擎产物树内容与所发内容逐字一致
    expect(existsSync(path.join(engineDir, 'Alpha.py'))).toBe(true);
    expect(readFileSync(path.join(engineDir, 'Alpha.py'), 'utf8')).toBe(contentA);

    // 台账语义:applied 双证核验升格 applied
    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 't-apply' };
    store.record(key, fileA, 'sent-unverified', { sentDigest: digestA });
    const verdict = verifyAppliedReceipt(store, key, fileA, single.body, { sentDigest: digestA, attempt: 1 });
    expect(verdict.kind).toBe('applied');
    expect(store.get(key, fileA)?.outcome).toBe('applied');
    expect(parseReloadHttpReceipts(single.body, [fileA])[0]?.status).toBe('applied');

    // 批量规则:多文件=数组逐条(文件序),targetId 逐字回显
    const batch = await harness.postReload(receiver.port, {
      files: [fileA, fileB],
      targetId: 't-apply',
      sender_digests: { [fileA]: digestA, [fileB]: digestB }
    });
    expect(batch.status).toBe(200);
    const receipts = JSON.parse(batch.body) as unknown[];
    expect(Array.isArray(receipts)).toBe(true);
    expect(fixture.batchRule.multiFile).toBe('JSON array, per-file in files order');
    expect(receipts).toHaveLength(2);
    assertConforms(receipts[0], 'applied');
    assertConforms(receipts[1], 'applied');
    expect((receipts[0] as Record<string, unknown>).file).toBe(fileA);
    expect((receipts[0] as Record<string, unknown>).digest).toBe(digestA);
    expect((receipts[0] as Record<string, unknown>).revision).toBe(2);
    expect((receipts[1] as Record<string, unknown>).file).toBe(fileB);
    expect((receipts[1] as Record<string, unknown>).digest).toBe(digestB);
    expect((receipts[1] as Record<string, unknown>).revision).toBe(3);
    expect((receipts[0] as Record<string, unknown>).targetId).toBe('t-apply');
    expect(existsSync(path.join(engineDir, 'Beta.py'))).toBe(true);
    expect(readFileSync(path.join(engineDir, 'Beta.py'), 'utf8')).toBe(contentB);
    expect(fixture.batchRule.singleFile).toBe('single JSON object');
  }, 20000);

  it('accepted→applied 生命周期推进:同一台账记录先 accepted 注解(应用未发生),再经真实 applied 回执升格', async () => {
    const stageReceiver = await harness.start('stage', 'accepted');
    const applyEngineDir = makeEngineDir();
    // 同一源树(rootOverride):接收端按报文内路径读源文件,根外路径整批拒绝,
    // 故 applied 阶段的接收端须与 stage 阶段共享同一暂存根。
    const applyReceiver = await harness.start('apply', 'applied', ['--artifact-dir', applyEngineDir], undefined, stageReceiver.root);
    const file = path.join(stageReceiver.root, 'Lifecycle.py');
    const content = 'class Lifecycle:\n    pass\n';
    writeFileSync(file, content, 'utf8');
    const sentDigest = sha256(content);

    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 't-life' };
    store.record(key, file, 'sent-unverified', { sentDigest });

    // 阶段一:accepted(应用未发生)
    const acceptedBody = (
      await harness.postReload(stageReceiver.port, {
        files: [file],
        targetId: 't-life',
        sender_digests: { [file]: sentDigest }
      })
    ).body;
    expect(applyAcceptedReceipt(store, key, file, acceptedBody, { attempt: 1 }).kind).toBe('accepted');
    expect(store.get(key, file)?.outcome).toBe('accepted');

    // 阶段二:applied(应用真实发生)升格
    const appliedBody = (
      await harness.postReload(applyReceiver.port, {
        files: [file],
        targetId: 't-life',
        sender_digests: { [file]: sentDigest }
      })
    ).body;
    expect(verifyAppliedReceipt(store, key, file, appliedBody, { sentDigest, attempt: 1 }).kind).toBe('applied');
    expect(store.get(key, file)?.outcome).toBe('applied');
    expect(existsSync(path.join(applyEngineDir, 'Lifecycle.py'))).toBe(true);
    expect(readFileSync(path.join(applyEngineDir, 'Lifecycle.py'), 'utf8')).toBe(content);
  }, 30000);

  it('协议 fixture 固化:冻结形状与生产解析器字段集一致(fixture 与 parser 同改才绿)', () => {
    // accepted:生产解析器接受 {status,file}±targetId;fixture 必填/字段集一致
    const accepted = { status: 'accepted', file: '/ws/A.py', targetId: 't1' };
    assertConforms(accepted, 'accepted');
    expect(parseReloadHttpReceipts(JSON.stringify(accepted), ['/ws/A.py'], 't1')).toMatchObject([
      { status: 'accepted', file: '/ws/A.py', targetId: 't1' }
    ]);
    // applied:生产解析器接受 {status,file,digest,revision}±targetId
    const applied = { status: 'applied', file: '/ws/A.py', digest: 'a'.repeat(64), revision: 1, targetId: 't1' };
    assertConforms(applied, 'applied');
    expect(parseReloadHttpReceipts(JSON.stringify(applied), ['/ws/A.py'], 't1')).toMatchObject([
      { status: 'applied', file: '/ws/A.py', digest: 'a'.repeat(64), revision: 1, targetId: 't1' }
    ]);
    // fixture 负面面:非 JSON(无协议回执)与 failed 回执
    expect(parseReloadHttpReceipts('not json', ['/ws/A.py'])).toEqual([
      { status: 'sent', file: '/ws/A.py', detail: '回包非 JSON:已送达,无协议回执(不 claim applied)' }
    ]);
    const failed = { status: 'failed', file: '/ws/A.py', reason: 'staging failed' };
    assertConforms(failed, 'failed');
    expect(parseReloadHttpReceipts(JSON.stringify(failed), ['/ws/A.py'])).toMatchObject([
      { status: 'failed', file: '/ws/A.py' }
    ]);
    // 反例:applied 形状过 applied 核验面缺 digest → 拒收(状态 applied 但无证据不升格)
    const appliedNoDigest = { status: 'applied', file: '/ws/A.py', revision: 1 };
    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 't1' };
    store.record(key, '/ws/A.py', 'sent-unverified', { sentDigest: 'a'.repeat(64) });
    expect(
      verifyAppliedReceipt(store, key, '/ws/A.py', JSON.stringify(appliedNoDigest), { sentDigest: 'a'.repeat(64), attempt: 1 })
        .kind
    ).toBe('not-applied');
    expect(store.get(key, '/ws/A.py')?.outcome).toBe('sent-unverified');
  });
});
