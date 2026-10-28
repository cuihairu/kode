import { describe, expect, it } from 'vitest';
import { classifyHttpDelivery, recordHttpDelivery } from '../src/hotReloadDelivery';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';

// IDE-HOT-002 将 HTTP 发送成功记为未确认:投递分类器只认传输事实——
// 2xx=已送达(sent-unverified,绿色但明示未证实),非 2xx/传输失败=
// failed;回包 body 一律不作为应用证据(自称 applied/ok 也不升格,
// 回执解读是 HOT-003+ 的事)。

describe('classifyHttpDelivery(只认传输事实)', () => {
  it('2xx → sent-unverified,detail 带状态码并明示未证实', () => {
    for (const status of [200, 201, 204]) {
      const verdict = classifyHttpDelivery({ ok: true, status });
      expect(verdict.outcome).toBe('sent-unverified');
      expect(verdict.detail).toContain(String(status));
      expect(verdict.detail).toContain('未证实');
    }
  });

  it('2xx 回包 body 自称 applied/ok 也不升格(body 不当应用证据)', () => {
    const verdict = classifyHttpDelivery({ ok: true, status: 200 });
    expect(verdict.outcome).toBe('sent-unverified');
  });

  it('非 2xx → failed,detail 点名状态码', () => {
    for (const status of [404, 500, 302]) {
      const verdict = classifyHttpDelivery({ ok: true, status });
      expect(verdict.outcome).toBe('failed');
      expect(verdict.detail).toContain(String(status));
    }
  });

  it('传输失败(ok=false,含 URL 解析失败/超时)→ failed 带原因', () => {
    const verdict = classifyHttpDelivery({ ok: false, status: 0, error: 'URL 无法解析: x' });
    expect(verdict.outcome).toBe('failed');
    expect(verdict.detail).toContain('URL 无法解析');
  });

  it('无 error 字段的传输失败也如实 failed', () => {
    const verdict = classifyHttpDelivery({ ok: false, status: 0 });
    expect(verdict.outcome).toBe('failed');
    expect(verdict.detail).toContain('HTTP 发送失败');
  });
});

describe('recordHttpDelivery(分类即入账,键上隔离)', () => {
  it('2xx 入账 sent-unverified 带 detail 与注入时钟', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    const record = recordHttpDelivery(
      store,
      { rootId: 'r', targetId: 'cellapp#a' },
      '/r/x.py',
      { ok: true, status: 204 },
      { now: 42 }
    );
    expect(record.outcome).toBe('sent-unverified');
    expect(record.recordedAt).toBe(42);
    expect(store.get({ rootId: 'r', targetId: 'cellapp#a' }, '/r/x.py')?.detail).toContain('204');
  });

  it('同文件两实例一成一败各落各的(HOT-001 台账咬合)', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    const file = '/r/x.py';
    recordHttpDelivery(store, { rootId: 'r', targetId: 'cellapp#a' }, file, { ok: true, status: 200 });
    recordHttpDelivery(store, { rootId: 'r', targetId: 'cellapp#b' }, file, {
      ok: false,
      status: 0,
      error: 'connect ECONNREFUSED'
    });

    expect(store.get({ rootId: 'r', targetId: 'cellapp#a' }, file)?.outcome).toBe('sent-unverified');
    expect(store.get({ rootId: 'r', targetId: 'cellapp#b' }, file)?.outcome).toBe('failed');
    expect(store.get({ rootId: 'r', targetId: 'cellapp#b' }, file)?.detail).toContain('ECONNREFUSED');
  });
});
