import { describe, expect, it } from 'vitest';
import { applyAcceptedReceipt, parseHotReloadAcceptedReceipt } from '../src/hotReloadReceipt';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';

// IDE-HOT-003 解析单目标 accepted 回执:已记录协议=JSON
// {"status":"accepted","file":"<与所发文件逐字一致的回显>"}(可选
// "targetId" 给了就必须一致;额外字段忽略,只认已记录字段)。只有
// 逐字段符合该契约才把记录升格 accepted;未知结构/回显不符/其他
// 状态值(applied 是 HOT-004 的核验面)一律保留未确认,不猜。

const EXPECTATION = { file: '/ws/r/assets/scripts/base/Avatar.py', targetId: 'cellapp#a' };

describe('parseHotReloadAcceptedReceipt(已记录协议)', () => {
  it('逐字段符合契约 → accepted', () => {
    const verdict = parseHotReloadAcceptedReceipt(
      JSON.stringify({ status: 'accepted', file: EXPECTATION.file }),
      EXPECTATION
    );
    expect(verdict.kind).toBe('accepted');
  });

  it('可选 targetId 给了且一致 → accepted;不一致 → 保留未确认', () => {
    const ok = parseHotReloadAcceptedReceipt(
      JSON.stringify({ status: 'accepted', file: EXPECTATION.file, targetId: 'cellapp#a' }),
      EXPECTATION
    );
    expect(ok.kind).toBe('accepted');

    const wrong = parseHotReloadAcceptedReceipt(
      JSON.stringify({ status: 'accepted', file: EXPECTATION.file, targetId: 'cellapp#b' }),
      EXPECTATION
    );
    expect(wrong.kind).toBe('not-accepted');
  });

  it('额外未知字段忽略(只认已记录字段)', () => {
    const verdict = parseHotReloadAcceptedReceipt(
      JSON.stringify({ status: 'accepted', file: EXPECTATION.file, engineVersion: '2.5.0' }),
      EXPECTATION
    );
    expect(verdict.kind).toBe('accepted');
  });

  it('非 JSON / JSON 非对象 → 未知结构保留未确认', () => {
    for (const body of ['not json', '"a string"', '[1,2]', 'null', '']) {
      const verdict = parseHotReloadAcceptedReceipt(body, EXPECTATION);
      expect(verdict.kind).toBe('not-accepted');
      if (verdict.kind === 'not-accepted') {
        expect(verdict.reason).toContain('未知结构');
      }
    }
  });

  it('状态值不是 accepted(ok/applied/queued/缺失/非串)→ 不升格', () => {
    const bodies = [
      JSON.stringify({ status: 'ok', file: EXPECTATION.file }),
      JSON.stringify({ status: 'applied', file: EXPECTATION.file }),
      JSON.stringify({ status: 'queued', file: EXPECTATION.file }),
      JSON.stringify({ file: EXPECTATION.file }),
      JSON.stringify({ status: 200, file: EXPECTATION.file })
    ];
    for (const body of bodies) {
      expect(parseHotReloadAcceptedReceipt(body, EXPECTATION).kind).toBe('not-accepted');
    }
  });

  it('file 回显缺失/不一致 → 不升格(回执必须钉住所发文件)', () => {
    const bodies = [
      JSON.stringify({ status: 'accepted' }),
      JSON.stringify({ status: 'accepted', file: '/other/Avatar.py' }),
      JSON.stringify({ status: 'accepted', file: 42 })
    ];
    for (const body of bodies) {
      expect(parseHotReloadAcceptedReceipt(body, EXPECTATION).kind).toBe('not-accepted');
    }
  });
});

describe('applyAcceptedReceipt(升格即入账)', () => {
  it('符合协议:记录升格 accepted 带 detail', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    const key = { rootId: 'r', targetId: 'cellapp#a' };
    store.record(key, EXPECTATION.file, 'sent-unverified');

    const verdict = applyAcceptedReceipt(store, key, EXPECTATION.file, JSON.stringify({ status: 'accepted', file: EXPECTATION.file }), { now: 5 });

    expect(verdict.kind).toBe('accepted');
    const record = store.get(key, EXPECTATION.file);
    expect(record?.outcome).toBe('accepted');
    expect(record?.recordedAt).toBe(5);
    expect(record?.detail).toContain('accepted');
  });

  it('未知结构:已有 sent-unverified 原样保留(验收原文)', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    const key = { rootId: 'r', targetId: 'cellapp#a' };
    store.record(key, EXPECTATION.file, 'sent-unverified', { detail: 'HTTP 200:已送达,应用层未证实(回执不在此级解读)' });

    const verdict = applyAcceptedReceipt(store, key, EXPECTATION.file, JSON.stringify({ status: 'ok' }), { now: 5 });

    expect(verdict.kind).toBe('not-accepted');
    const record = store.get(key, EXPECTATION.file);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.recordedAt).toBe(1);
  });

  it('邻居目标不受升格影响(键上隔离)', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    const keyA = { rootId: 'r', targetId: 'cellapp#a' };
    const keyB = { rootId: 'r', targetId: 'cellapp#b' };
    store.record(keyA, EXPECTATION.file, 'sent-unverified');
    store.record(keyB, EXPECTATION.file, 'sent-unverified');

    applyAcceptedReceipt(store, keyA, EXPECTATION.file, JSON.stringify({ status: 'accepted', file: EXPECTATION.file }));

    expect(store.get(keyA, EXPECTATION.file)?.outcome).toBe('accepted');
    expect(store.get(keyB, EXPECTATION.file)?.outcome).toBe('sent-unverified');
  });
});
