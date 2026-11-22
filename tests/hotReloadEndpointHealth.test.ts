import { describe, expect, it } from 'vitest';
import {
  HttpReloadTransport,
  type EndpointHealthObserver,
  type ReloadTarget
} from '../src/backend/hotReloadTransport';
import type { HttpRequestEntry } from '../src/backend/httpRequests';
import {
  probeToEndpointHealth,
  sendErrorToEndpointHealth,
  sendStatusToEndpointHealth
} from '../src/backend/hotReloadEndpointHealth';

// RUST-357(HR-HTTP-015)端点健康账:断连/重连更新 endpoint health;
// health success 不等于任何模块已更新成功(健康面只有传输层可达性事实,
// 结构上无模块投递字段,与回执/台账轴零交集)。

const target: ReloadTarget = { rootId: '/ws/scripts', targetId: 'baseapp' };
const files = ['/ws/scripts/base/Monster.py'];

const entry = (): HttpRequestEntry => ({
  name: 'reload',
  url: 'http://127.0.0.1:8000/api/hotfix',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"files":${files}}',
  enabled: true,
  keybinding: ''
});

const HEALTH_KEYS = ['at', 'detail', 'ok', 'source'];

describe('sendErrorToEndpointHealth(断连=无响应,端点不可达)', () => {
  it('抛错 → ok:false + 五分类定性可用错误 + source=send + at=观察时刻', () => {
    const record = sendErrorToEndpointHealth(new Error('connect ECONNREFUSED 127.0.0.1:8000'), 7);
    expect(record.ok).toBe(false);
    expect(record.source).toBe('send');
    expect(record.at).toBe(7);
    expect(record.detail).toContain('端点不可达');
    // 原始原因不被吞(分类只做定性,可用错误输出 = 定性 + 原始)
    expect(record.detail).toContain('ECONNREFUSED');
  });

  it('证书/代理错误同样落不可达(分类不同但健康面同口径)', () => {
    for (const raw of ['connect EPROTOCOL certificate verify failed', 'proxy tunnel 407 proxy authentication required']) {
      const record = sendErrorToEndpointHealth(new Error(raw), 1);
      expect(record.ok).toBe(false);
      expect(record.source).toBe('send');
      expect(record.detail).not.toBe('');
    }
  });
});

describe('sendStatusToEndpointHealth(重连=2xx 可达;非 2xx=可达但不健康)', () => {
  it('2xx → ok:true(端点可达/重连),detail 点明状态码', () => {
    for (const status of [200, 204, 299]) {
      const record = sendStatusToEndpointHealth(status, 3);
      expect(record.ok).toBe(true);
      expect(record.detail).toBe(`端点可达(HTTP ${status})`);
      expect(record.source).toBe('send');
      expect(record.at).toBe(3);
    }
  });

  it('非 2xx → ok:false(与 probe 同一 ok 口径),detail 区分「可达但非 2xx」与断连', () => {
    for (const status of [300, 404, 500]) {
      const record = sendStatusToEndpointHealth(status, 3);
      expect(record.ok).toBe(false);
      expect(record.detail).toBe(`端点可达但非 2xx(HTTP ${status})`);
    }
  });
});

describe('probeToEndpointHealth(probe 结果原样入账,来源=probe)', () => {
  it('ok/detail 原样透传,来源与时刻如实记录', () => {
    const ok = probeToEndpointHealth(true, '端点可达(HTTP 200)', 11);
    expect(ok).toEqual({ ok: true, detail: '端点可达(HTTP 200)', at: 11, source: 'probe' });
    const bad = probeToEndpointHealth(false, '端点不可达(HTTP 503 非 2xx)', 12);
    expect(bad.ok).toBe(false);
    expect(bad.source).toBe('probe');
    expect(bad.at).toBe(12);
  });
});

describe('health success ≠ 任何模块已更新成功(RUST-357 子题 2)', () => {
  it('健康记录结构上无任何模块投递字段(没有可混用的面)', () => {
    const records = [
      sendErrorToEndpointHealth(new Error('x'), 1),
      sendStatusToEndpointHealth(200, 1),
      sendStatusToEndpointHealth(500, 1),
      probeToEndpointHealth(true, 'd', 1)
    ];
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual([...HEALTH_KEYS].sort());
      expect('applied' in record).toBe(false);
      expect('outcome' in record).toBe(false);
      expect('digest' in record).toBe(false);
      expect('receipts' in record).toBe(false);
    }
  });

  it('健康 ok:true 与模块投递结果相互独立:形状相同、无因果面', () => {
    // 同一 ok:true 事实,与本次发送是否真的 applied 无关——健康面推不出投递结论
    const healthy = sendStatusToEndpointHealth(200, 5);
    expect(healthy.ok).toBe(true);
    expect(Object.keys(healthy).sort()).toEqual([...HEALTH_KEYS].sort());
  });
});

describe('HttpReloadTransport × 健康观察口(断连/重连自动上报)', () => {
  const makeObserver = (): EndpointHealthObserver & { calls: Array<{ kind: string; ok: boolean; detail: string }> } => {
    const calls: Array<{ kind: string; ok: boolean; detail: string }> = [];
    return {
      calls,
      noteEndpointHealth: (kind, ok, detail) => {
        calls.push({ kind, ok, detail });
      }
    };
  };

  it('断连:执行器抛错 → 观察口收到 (http,false,可用错误),回执仍逐文件 failed', async () => {
    const observer = makeObserver();
    const transport = new HttpReloadTransport(entry(), {
      run: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
      },
      healthObserver: observer
    });
    const receipts: Array<{ status: string; reason?: string }> = [];
    await transport.send(target, files, receipt => receipts.push(receipt));

    // 观察口与逐文件 failed 回执同因(同一分类后的可用错误)
    expect(observer.calls).toHaveLength(1);
    expect(observer.calls[0]).toEqual({ kind: 'http', ok: false, detail: receipts[0].reason });
    expect(observer.calls[0].detail).toContain('端点不可达');
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe('failed');
  });

  it('非 2xx:有响应但不健康 → 观察口 (http,false,可达但非 2xx)', async () => {
    const observer = makeObserver();
    const transport = new HttpReloadTransport(entry(), {
      run: async () => ({ status: 500, body: 'err' }),
      healthObserver: observer
    });
    await transport.send(target, files, () => undefined);
    expect(observer.calls).toEqual([
      { kind: 'http', ok: false, detail: '端点可达但非 2xx(HTTP 500)' }
    ]);
  });

  it('重连:2xx → 观察口 (http,true,端点可达)', async () => {
    const observer = makeObserver();
    const transport = new HttpReloadTransport(entry(), {
      run: async () => ({ status: 200, body: JSON.stringify([{ status: 'applied', file: files[0] }]) }),
      healthObserver: observer
    });
    await transport.send(target, files, () => undefined);
    expect(observer.calls).toEqual([{ kind: 'http', ok: true, detail: '端点可达(HTTP 200)' }]);
  });

  it('health success ≠ 模块已更新成功:2xx 但无协议回执 → 健康 ok:true 而回执仍是 sent 未确认', async () => {
    const observer = makeObserver();
    const transport = new HttpReloadTransport(entry(), {
      run: async () => ({ status: 200, body: '纯文本回包,无 JSON 回执' }),
      healthObserver: observer
    });
    const receipts: Array<{ status: string }> = [];
    await transport.send(target, files, receipt => receipts.push(receipt));

    // 端点健康(可达)成立
    expect(observer.calls[0].ok).toBe(true);
    // 但模块投递面从未升级:无回执=已送达未确认,绝不 claim applied
    expect(receipts[0].status).toBe('sent');
    expect(observer.calls[0].detail).not.toContain('applied');
  });

  it('未注入观察口 → 零行为变化(既有通道零注入不回归)', async () => {
    const transport = new HttpReloadTransport(entry(), {
      run: async () => ({ status: 200, body: '{"status":"accepted","file":"' + files[0] + '"}' })
    });
    const receipts: Array<{ status: string }> = [];
    await expect(
      transport.send(target, files, receipt => receipts.push(receipt))
    ).resolves.toBeTruthy();
    expect(receipts[0].status).toBe('accepted');
  });
});
