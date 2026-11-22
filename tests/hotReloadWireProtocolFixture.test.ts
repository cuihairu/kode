/**
 * RUST-427(HR-QA-015)协议 fixture 固化面:受控真实测试服务
 * (scripts/hot-reload-receiver/referenceReceiver.mjs)与解析器
 * (hotReloadReceipt.parseHotReloadAcceptedReceipt /
 * hotReloadAppliedCheck.verifyAppliedReceipt)双侧都必须与冻结的
 * wire 协议 fixture(tests/fixtures/protocol/hot-reload-wire-protocol.json)
 * 一致——fixture 是协议唯一数据基准,改协议须先改 fixture 再过本测;
 * 实现侧与 fixture 单侧漂移在本测必红,协议静默漂移从机制上封死。
 *
 * 语义联调(accepted/applied 行为证据)已由 hotReloadReceiverRoundtrip
 * 覆盖;本测补其缺的「线形冻结」:
 *  ① fixture 完整性自证(canonical 样本 digest 自洽、请求/回执例形引用
 *     canonical digest、节齐);
 *  ② 解析器对 fixture 例形判定一致(accepted→accepted、applied→applied、
 *     unrecognized 各形→不升格);
 *  ③ 受控真实服务对 fixture 例形一致(live 回环:请求按 fixture 例形发,
 *     实际回包键集=fixture 例形键集+文档化 targetId 回显)。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { verifyAppliedReceipt } from '../src/backend/hotReloadAppliedCheck';
import { parseHotReloadAcceptedReceipt } from '../src/backend/hotReloadReceipt';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import { createHotReloadReceiverRoundtripHarness } from './helpers/hotReloadReceiverHarness';

const FIXTURE_PATH = path.join('tests', 'fixtures', 'protocol', 'hot-reload-wire-protocol.json');

describe('RUST-427 协议 fixture 固化:双侧对拍冻结线形', () => {
  let fixture: {
    canonical_sample: { content: string; sha256: string };
    request: { example: { files: string[]; targetId: string; request_id: string; sender_digests: Record<string, string> } };
    responses: {
      accepted: { example: { status: string; file: string; request_id: string } };
      applied: { example: { status: string; file: string; digest: string; revision: number; request_id: string } };
      batch: { example: unknown[] };
      unrecognized: { examples: Record<string, unknown> };
    };
    parsing: Record<string, string>;
    receiver: Record<string, string>;
  };
  let harness: ReturnType<typeof createHotReloadReceiverRoundtripHarness>;

  beforeEach(() => {
    fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    harness = createHotReloadReceiverRoundtripHarness();
  });

  afterEach(() => {
    harness.dispose();
  });

  it('fixture 完整性自证:canonical 样本 digest 自洽、请求/回执例形引用一致、节齐', () => {
    // canonical 样本:content 的字面 JSON 转义恰为这 27 字节(转义错一位
    // digest 就对不上)——fixture 作为数据基准自证,非凭空手填
    expect(fixture.canonical_sample.content).toBe('class Avatar:\n    HP = 100\n');
    expect(harness.sha256(fixture.canonical_sample.content)).toBe(fixture.canonical_sample.sha256);
    // 请求例形的 sender_digests 与 applied 例形的 digest 都引用 canonical
    // sha256(改任一侧=自证红,防三处 digest 各写各的)
    const sampleFile = fixture.request.example.files[0];
    expect(fixture.request.example.sender_digests[sampleFile]).toBe(fixture.canonical_sample.sha256);
    expect(fixture.responses.applied.example.digest).toBe(fixture.canonical_sample.sha256);
    // 节齐:请求/回执/批量/未识别/解析规则/接收端契约都在册
    expect(fixture.request.example.files).toHaveLength(1);
    expect(fixture.responses.accepted.example.status).toBe('accepted');
    expect(fixture.responses.applied.example.status).toBe('applied');
    expect(Array.isArray(fixture.responses.batch.example)).toBe(true);
    expect(fixture.responses.batch.example.length).toBeGreaterThan(0);
    expect(Object.keys(fixture.responses.unrecognized.examples).length).toBeGreaterThan(0);
    expect(Object.keys(fixture.parsing).length).toBeGreaterThan(0);
    expect(fixture.receiver.reference_impl).toBe('scripts/hot-reload-receiver/referenceReceiver.mjs');
  });

  it('解析器对 fixture 例形一致:accepted 例形→accepted,applied 例形→applied', () => {
    const accepted = fixture.responses.accepted.example;
    const verdict = parseHotReloadAcceptedReceipt(JSON.stringify(accepted), {
      file: accepted.file,
      requestId: accepted.request_id
    });
    expect(verdict.kind).toBe('accepted');

    const applied = fixture.responses.applied.example;
    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 'baseapp-1' };
    store.record(key, applied.file, 'sent-unverified', { sentDigest: fixture.canonical_sample.sha256 });
    const appliedVerdict = verifyAppliedReceipt(
      store,
      key,
      applied.file,
      JSON.stringify(applied),
      { sentDigest: fixture.canonical_sample.sha256, attempt: 1 }
    );
    expect(appliedVerdict.kind).toBe('applied');
    expect(store.get(key, applied.file)?.outcome).toBe('applied');
  });

  it('解析器对 fixture 未识别线形一律不升格(unrecognized 各形)', () => {
    const examples = fixture.responses.unrecognized.examples;
    const file = fixture.responses.accepted.example.file;
    // accepted 面:非 JSON/数组/状态非 accepted → not-accepted
    for (const key of ['notJson', 'array', 'unknownStatus']) {
      const verdict = parseHotReloadAcceptedReceipt(JSON.stringify(examples[key]), { file });
      expect(verdict.kind, `accepted 面未识别形 ${key} 应不升格`).toBe('not-accepted');
    }
    // applied 面:missingFile(回显缺失)/missingDigest(digest 缺失) → not-applied
    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 'baseapp-1' };
    for (const caseKey of ['missingFile', 'missingDigest']) {
      const verdict = verifyAppliedReceipt(store, key, file, JSON.stringify(examples[caseKey]), {
        sentDigest: fixture.canonical_sample.sha256,
        attempt: 1
      });
      expect(verdict.kind, `applied 面未识别形 ${caseKey} 应不升格`).toBe('not-applied');
    }
  });

  it('受控真实服务对 fixture 例形一致(accepted 场景 live 回环)', async () => {
    const receiver = await harness.start('stage', 'accepted');
    const file = path.join(receiver.root, 'Avatar.py');
    writeFileSync(file, fixture.canonical_sample.content, 'utf8');

    // 按 fixture 请求例形发(路径换真值;targetId/request_id 按文档可选回显)
    const body = {
      files: [file],
      targetId: fixture.request.example.targetId,
      request_id: fixture.request.example.request_id,
      sender_digests: { [file]: fixture.canonical_sample.sha256 }
    };
    const response = await harness.postReload(receiver.port, body);
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    // 实际回包键集=fixture 例形键集 + 文档化 targetId 回显(单文件=单对象)
    expect(Object.keys(parsed).sort()).toEqual(
      [...Object.keys(fixture.responses.accepted.example), 'targetId'].sort()
    );
    expect(parsed).toEqual({
      status: 'accepted',
      file,
      targetId: fixture.request.example.targetId,
      request_id: fixture.request.example.request_id
    });
  });

  it('受控真实服务对 fixture 例形一致(applied 场景 live 回环:自写产物+digest 双证)', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-rust427-engine-'));
    harness.engineDirs.push(engineDir);
    const receiver = await harness.start('apply', 'applied', ['--artifact-dir', engineDir]);
    const file = path.join(receiver.root, 'Avatar.py');
    writeFileSync(file, fixture.canonical_sample.content, 'utf8');

    const body = {
      files: [file],
      targetId: fixture.request.example.targetId,
      request_id: fixture.request.example.request_id,
      sender_digests: { [file]: fixture.canonical_sample.sha256 }
    };
    const response = await harness.postReload(receiver.port, body);
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    // 实际回包键集=fixture applied 例形键集 + targetId 回显;digest=canonical
    expect(Object.keys(parsed).sort()).toEqual(
      [...Object.keys(fixture.responses.applied.example), 'targetId'].sort()
    );
    expect(parsed).toEqual({
      status: 'applied',
      file,
      digest: fixture.canonical_sample.sha256,
      revision: expect.any(Number),
      targetId: fixture.request.example.targetId,
      request_id: fixture.request.example.request_id
    });
    // 接收端自写产物落引擎目录(与所发内容逐字一致)
    const engineFile = path.join(engineDir, 'Avatar.py');
    expect(existsSync(engineFile)).toBe(true);
    expect(readFileSync(engineFile, 'utf8')).toBe(fixture.canonical_sample.content);
  });
});
