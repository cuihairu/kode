import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import {
  settleAppliedStatus,
  verifyAppliedReceipt
} from '../src/hotReloadAppliedCheck';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';

// IDE-HOT-004 核验单目标 applied 状态:已记录协议的 applied 回执=JSON
// {"status":"applied","file":"<逐字回显>","digest":"<所发内容的 sha256
// hex>"}——digest 对得上才标 applied(可信 digest+已验证回执双证);
// digest 缺失/不符/回执不合规一律保留未确认;超时结算仍未确认的保持
// 未确认,不冒充失败也不冒充 applied。

const FILE = '/ws/r/assets/scripts/base/Avatar.py';
const CONTENT = 'class Avatar:\n    def tick(self):\n        pass\n';
const DIGEST = createHash('sha256').update(Buffer.from(CONTENT, 'utf8')).digest('hex');
const KEY = { rootId: 'r', targetId: 'cellapp#a' };

const appliedBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ status: 'applied', file: FILE, digest: DIGEST, ...overrides });

describe('verifyAppliedReceipt(可信 digest 或已验证回执才 applied)', () => {
  it('applied 回执+digest 与所发内容一致 → applied,detail 带 digest 指纹', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    store.record(KEY, FILE, 'accepted');

    const verdict = verifyAppliedReceipt(store, KEY, FILE, appliedBody(), { sentContent: CONTENT, now: 9 });

    expect(verdict.kind).toBe('applied');
    const record = store.get(KEY, FILE);
    expect(record?.outcome).toBe('applied');
    expect(record?.recordedAt).toBe(9);
    expect(record?.detail).toContain(DIGEST.slice(0, 12));
  });

  it('digest 与所发内容不符 → 可疑回执不升格,保留原状态', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    store.record(KEY, FILE, 'accepted');

    const verdict = verifyAppliedReceipt(
      store,
      KEY,
      FILE,
      JSON.stringify({ status: 'applied', file: FILE, digest: 'f'.repeat(64) }),
      { sentContent: CONTENT, now: 9 }
    );

    expect(verdict.kind).toBe('not-applied');
    expect(store.get(KEY, FILE)?.outcome).toBe('accepted');
    expect(store.get(KEY, FILE)?.recordedAt).toBe(1);
  });

  it('digest 缺失/非串 → 无可信证据不升格', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    store.record(KEY, FILE, 'accepted');

    for (const body of [
      JSON.stringify({ status: 'applied', file: FILE }),
      JSON.stringify({ status: 'applied', file: FILE, digest: 42 })
    ]) {
      expect(verifyAppliedReceipt(store, KEY, FILE, body, { sentContent: CONTENT }).kind).toBe('not-applied');
    }
    expect(store.get(KEY, FILE)?.outcome).toBe('accepted');
  });

  it('状态不是 applied(accepted/未知值/非 JSON)→ 不升格', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    store.record(KEY, FILE, 'sent-unverified');

    for (const body of [
      JSON.stringify({ status: 'accepted', file: FILE, digest: DIGEST }),
      JSON.stringify({ status: 'ok', file: FILE }),
      'not json'
    ]) {
      expect(verifyAppliedReceipt(store, KEY, FILE, body, { sentContent: CONTENT }).kind).toBe('not-applied');
    }
    expect(store.get(KEY, FILE)?.outcome).toBe('sent-unverified');
  });

  it('file 回显不一致 → 回执不钉住所发文件,不升格', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    store.record(KEY, FILE, 'accepted');

    const verdict = verifyAppliedReceipt(
      store,
      KEY,
      FILE,
      JSON.stringify({ status: 'applied', file: '/other.py', digest: DIGEST }),
      { sentContent: CONTENT }
    );

    expect(verdict.kind).toBe('not-applied');
    expect(store.get(KEY, FILE)?.outcome).toBe('accepted');
  });

  it('邻居目标不受升格影响', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    const keyB = { rootId: 'r', targetId: 'cellapp#b' };
    store.record(KEY, FILE, 'accepted');
    store.record(keyB, FILE, 'accepted');

    verifyAppliedReceipt(store, KEY, FILE, appliedBody(), { sentContent: CONTENT });

    expect(store.get(KEY, FILE)?.outcome).toBe('applied');
    expect(store.get(keyB, FILE)?.outcome).toBe('accepted');
  });
});

describe('settleAppliedStatus(超时仍未确认)', () => {
  it('已 applied → applied', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    store.record(KEY, FILE, 'applied');
    const settled = settleAppliedStatus(store.get(KEY, FILE), { deadlineMs: 1000, now: () => 5000 });
    expect(settled).toBe('applied');
  });

  it('超时仍未确认 → 未确认(不冒充失败也不冒充 applied)', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    store.record(KEY, FILE, 'sent-unverified');
    const settled = settleAppliedStatus(store.get(KEY, FILE), { deadlineMs: 1000, now: () => 5000 });
    expect(settled).toBe('unconfirmed-timeout');
  });

  it('未到截止 → pending(还在等回执)', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    store.record(KEY, FILE, 'sent-unverified');
    const settled = settleAppliedStatus(store.get(KEY, FILE), { deadlineMs: 10_000, now: () => 5000 });
    expect(settled).toBe('pending');
  });

  it('failed 记录如实 failed(超时结算不改失败面)', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    store.record(KEY, FILE, 'failed');
    const settled = settleAppliedStatus(store.get(KEY, FILE), { deadlineMs: 1000, now: () => 5000 });
    expect(settled).toBe('failed');
  });
});
