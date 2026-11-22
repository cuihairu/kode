import { describe, expect, it } from 'vitest';

import {
  classifyReloadTransportError,
  formatReloadTransportError,
  formatReloadTransportThrownError
} from '../src/backend/hotReloadTransportErrors';
import {
  defaultReloadHttpRunner,
  HttpReloadTransport
} from '../src/backend/hotReloadTransport';
import { sendFilesViaReloadChannel } from '../src/backend/hotReloadChannelSend';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import type { HotReloadTimerDeps } from '../src/hotReload';
import type { ReloadHttpRunner, ReloadReceipt, ReloadTarget, ReloadTransport } from '../src/backend/hotReloadTransport';
import type { HttpRequestEntry } from '../src/backend/httpRequests';

// RUST-419(HR-QA-007)验收受注:传输错误五分类(endpoint 不可达/证书/代理/
// target 重启/部分节点成功)各自输出可用错误。全部 mock 构造,不需要真环境:
// - 分类器=纯函数,原始错误文本直接喂;
// - 传输面=run 注入替身按类抛错,回执/探测 detail 断言分类输出;
// - 部分节点成功=两组目标一组成一败,台账逐文件 failed 明细带分类原因。

describe('classifyReloadTransportError 五分类(RUST-419)', () => {
  it('endpoint 不可达族:ECONNREFUSED/ENOTFOUND/超时/fetch failed', () => {
    for (const raw of [
      'connect ECONNREFUSED 127.0.0.1:8090',
      'getaddrinfo ENOTFOUND hotfix.internal',
      '请求超时(20000ms)',
      'fetch failed',
      'URL 无法解析: not-a-url::'
    ]) {
      expect(classifyReloadTransportError(raw).kind).toBe('endpoint-unreachable');
    }
  });

  it('证书错误族:verify 失败/过期/EPROTO/自签', () => {
    for (const raw of [
      'unable to verify the first certificate',
      'error:0B080012:X.509 routines:certificate has expired',
      'write EPROTO ... ssl3_get_record:wrong version number',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      '证书校验失败:SELF_SIGNED_CERT_IN_CHAIN'
    ]) {
      expect(classifyReloadTransportError(raw).kind).toBe('certificate');
    }
  });

  it('代理错误族:隧道失败/407/代理不可达(先于连接类匹配)', () => {
    for (const raw of [
      'tunneling socket could not be established, 502 status code Bad Gateway',
      'Proxy 407 authentication required',
      'connect ECONNREFUSED proxy.corp.local:3128',
      '代理连接失败'
    ]) {
      expect(classifyReloadTransportError(raw).kind).toBe('proxy');
    }
  });

  it('target 重启族:ECONNRESET/EPIPE/socket hang up/响应中断(先于不可达匹配)', () => {
    for (const raw of [
      'read ECONNRESET',
      'write EPIPE',
      'socket hang up',
      '响应中断:服务端提前断开连接(aborted)'
    ]) {
      expect(classifyReloadTransportError(raw).kind).toBe('target-restart');
    }
  });

  it('未命中族 → unknown,如实不猜', () => {
    expect(classifyReloadTransportError('something odd happened').kind).toBe('unknown');
    expect(classifyReloadTransportError('').kind).toBe('unknown');
  });

  it('format 输出 = 可用错误 + 原始原因(不吞证据)', () => {
    const text = formatReloadTransportError('connect ECONNREFUSED 127.0.0.1:8090');
    expect(text).toContain('端点不可达');
    expect(text).toContain('connect ECONNREFUSED 127.0.0.1:8090');
    expect(formatReloadTransportThrownError(new Error('socket hang up'))).toContain('目标连接中断');
  });
});

const entry = (overrides: Partial<HttpRequestEntry> = {}): HttpRequestEntry => ({
  name: 'reload',
  url: 'http://127.0.0.1:8090/hotfix',
  method: 'POST',
  headers: {},
  body: '',
  enabled: true,
  keybinding: '',
  ...overrides
});

const throwingRunner = (raw: string): ReloadHttpRunner => async () => {
  throw new Error(raw);
};

const files = ['/ws/scripts/base/Monster.py', '/ws/scripts/cell/Avatar.py'];

describe('传输面分类接线(send/probe/run,全部 mock 构造)', () => {
  it('send 传输异常 → 逐文件 failed 回执带分类可用错误(四族)', async () => {
    const arms: Array<{ raw: string; expectText: string }> = [
      { raw: 'connect ECONNREFUSED 127.0.0.1:8090', expectText: '端点不可达' },
      { raw: 'unable to verify the first certificate', expectText: '证书校验失败' },
      { raw: 'tunneling socket could not be established, 502 Bad Gateway', expectText: '代理错误' },
      { raw: 'read ECONNRESET', expectText: '目标连接中断' }
    ];
    for (const arm of arms) {
      const transport = new HttpReloadTransport(entry(), { run: throwingRunner(arm.raw) });
      const summary = await transport.send({ rootId: '/ws', targetId: 'baseapp' }, files, () => undefined);
      expect(summary.receipts).toHaveLength(2);
      for (const receipt of summary.receipts) {
        expect(receipt.status).toBe('failed');
        if (receipt.status === 'failed') {
          expect(receipt.reason).toContain(arm.expectText);
          expect(receipt.reason).toContain(arm.raw);
        }
      }
    }
  });

  it('probe 传输异常 → detail 分类输出', async () => {
    const transport = new HttpReloadTransport(entry(), { run: throwingRunner('getaddrinfo ENOTFOUND x.local') });
    const probe = await transport.probe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain('端点不可达');
    expect(probe.detail).toContain('ENOTFOUND');
  });

  it('默认 runner:ok:false 的真实原因以 throw 送达 catch 面(不再折成 HTTP 0)', async () => {
    // 不可解析协议 URL 走 defaultTransport 的零建连失败路径(不发网络请求)
    await expect(
      defaultReloadHttpRunner({ url: 'not-a-url::', method: 'POST', headers: {}, body: '' })
    ).rejects.toThrow('不支持的协议');
  });
});

// 定时器只登记不即发(生产定时器绝不同步触发;同步即发会踩 settle 回调里
// 「handle 未完成初始化」的 TDZ,也测不到结算前的中间态)
const makeTimers = (): HotReloadTimerDeps => {
  const pending: Array<() => void> = [];
  return {
    set: callback => {
      pending.push(callback);
      return pending.length;
    },
    clear: () => undefined
  };
};

describe('部分节点成功:一组失败一组送达,逐文件明细带分类原因', () => {
  it('两组目标一成一败 → sentCount/failedCount 各计,failed 台账明细分类可用', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const transport: ReloadTransport = {
      kind: 'http',
      probe: async () => ({ ok: true, detail: 'ok' }),
      send: async (target: ReloadTarget, fileSet: readonly string[], onReceipt) => {
        if (target.rootId === '/bad-root') {
          throw new Error('connect ECONNREFUSED 127.0.0.1:8090');
        }
        for (const file of fileSet) {
          onReceipt({ status: 'sent', file, detail: '已送达:无匹配回执(不 claim applied)' } as ReloadReceipt);
        }
        return { kind: 'http', receipts: [] };
      }
    };
    const result = await sendFilesViaReloadChannel({
      transport,
      targetId: 'profile-1',
      files: ['/ok-root/scripts/Avatar.py', '/bad-root/scripts/Monster.py'],
      resolveRootId: file => (file.startsWith('/bad-root') ? '/bad-root' : '/ok-root'),
      store,
      readFileContent: async () => null,
      timers: makeTimers(),
      settleHandles: new Set(),
      now: () => 1000,
      source: 'watcher-auto'
    });
    expect(result.sentCount).toBe(1);
    expect(result.failedCount).toBe(1);
    const okRecord = store.get({ rootId: '/ok-root', targetId: 'profile-1' }, '/ok-root/scripts/Avatar.py');
    expect(okRecord?.outcome).toBe('sent-unverified');
    const badRecord = store.get({ rootId: '/bad-root', targetId: 'profile-1' }, '/bad-root/scripts/Monster.py');
    expect(badRecord?.outcome).toBe('failed');
    expect(badRecord?.detail).toContain('端点不可达');
    expect(badRecord?.detail).toContain('ECONNREFUSED');
  });
});

// RUST-367(HR-STATE-007 可检索历史「duration」):发送耗时=发送锚点(KR-AUD-47
// 同锚,transport.send 发起时点)到落账时刻;发送前的基准冻结路径无耗时
// (sendAnchor 仍 null,如实不带 durationMs)。
describe('发送耗时落账(HR-STATE-007 durationMs)', () => {
  it('回执路径:durationMs=回执落账时刻-发送锚点', async () => {
    let t = 1000;
    const store = new HotReloadTargetStateStore({ now: () => t });
    const transport: ReloadTransport = {
      kind: 'http',
      probe: async () => ({ ok: true, detail: 'ok' }),
      send: async (target: ReloadTarget, fileSet: readonly string[], onReceipt) => {
        // 模拟网络往返:发送发起后时钟前进 500ms 回执才到
        t += 500;
        for (const file of fileSet) {
          onReceipt({ status: 'sent', file, detail: '已送达:无匹配回执(不 claim applied)' } as ReloadReceipt);
        }
        return { kind: 'http', receipts: [] };
      }
    };
    await sendFilesViaReloadChannel({
      transport,
      targetId: 'profile-1',
      files: ['/ws/scripts/Avatar.py'],
      resolveRootId: () => '/ws',
      store,
      readFileContent: async () => null,
      timers: makeTimers(),
      settleHandles: new Set(),
      now: () => t,
      source: 'watcher-auto'
    });
    const record = store.get({ rootId: '/ws', targetId: 'profile-1' }, '/ws/scripts/Avatar.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.durationMs).toBe(500);
  });

  it('组异常路径:durationMs=异常落账时刻-发送锚点;无代际裸写同样带耗时', async () => {
    let t = 2000;
    const store = new HotReloadTargetStateStore({ now: () => t });
    const transport: ReloadTransport = {
      kind: 'http',
      probe: async () => ({ ok: true, detail: 'ok' }),
      send: async () => {
        t += 700;
        throw new Error('connect ECONNREFUSED 127.0.0.1:8090');
      }
    };
    await sendFilesViaReloadChannel({
      transport,
      targetId: 'profile-1',
      files: ['/ws/scripts/Monster.py'],
      resolveRootId: () => '/ws',
      store,
      readFileContent: async () => null,
      timers: makeTimers(),
      settleHandles: new Set(),
      now: () => t,
      source: 'command'
    });
    const record = store.get({ rootId: '/ws', targetId: 'profile-1' }, '/ws/scripts/Monster.py');
    expect(record?.outcome).toBe('failed');
    expect(record?.durationMs).toBe(700);
  });
});

// 通道发送缺口臂:根解析三态(null/''/命中)、冻结读取抛错、applied 负臂、
// 超时注解二次结算早退。计时器手工 tick(生产定时器绝不同步触发),tick
// 后保留回调以复触发——注解已在时二次结算必须早退(注解不重复堆叠)。
describe('通道发送缺口臂(根解析三态/冻结读取抛错/超时注解只写一次)', () => {
  const makeManualTimers = (): { timers: HotReloadTimerDeps; tick: () => number } => {
    const pending: Array<() => void> = [];
    return {
      tick: () => {
        let fired = 0;
        for (const callback of [...pending]) {
          callback();
          fired += 1;
        }
        return fired;
      },
      timers: {
        set: callback => {
          pending.push(callback);
          return pending.length;
        },
        clear: () => undefined
      }
    };
  };

  const makeReceiptTransport = (
    receipts: ReloadReceipt[]
  ): { transport: ReloadTransport; seenTargets: ReloadTarget[] } => {
    const seenTargets: ReloadTarget[] = [];
    const transport: ReloadTransport = {
      kind: 'http',
      probe: async () => ({ ok: true, detail: 'ok' }),
      send: async (target: ReloadTarget, fileSet: readonly string[], onReceipt) => {
        seenTargets.push(target);
        for (const file of fileSet) {
          for (const receipt of receipts) {
            onReceipt(receipt);
          }
        }
        return { kind: 'http', receipts: [] };
      }
    };
    return { transport, seenTargets };
  };

  it('根解析不到(null):文件仍发送归空组,不落台账也不排结算', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const { transport, seenTargets } = makeReceiptTransport([
      { status: 'sent', file: '/unknown/Avatar.py', detail: '已送达:无匹配回执(不 claim applied)' }
    ]);
    const result = await sendFilesViaReloadChannel({
      transport,
      targetId: 'profile-1',
      files: ['/unknown/Avatar.py'],
      resolveRootId: () => null,
      store,
      timers: makeManualTimers().timers,
      settleHandles: new Set(),
      now: () => 1000
    });
    expect(result.sentCount).toBe(1);
    expect(result.failedCount).toBe(0);
    // 仍发送,但归 '' 组(不猜根);台账键 ('' , profile-1) 无任何记录
    expect(seenTargets).toEqual([{ rootId: '', targetId: 'profile-1' }]);
    expect(store.get({ rootId: '', targetId: 'profile-1' }, '/unknown/Avatar.py')).toBeUndefined();
  });

  it('根解析为空串:发起记录照落,但回执与结算都被空根早退拦下', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const clock = makeManualTimers();
    const { transport } = makeReceiptTransport([
      { status: 'sent', file: '/odd/Avatar.py', detail: '已送达:无匹配回执(不 claim applied)' }
    ]);
    const result = await sendFilesViaReloadChannel({
      transport,
      targetId: 'profile-1',
      files: ['/odd/Avatar.py'],
      resolveRootId: () => '',
      store,
      timers: clock.timers,
      settleHandles: new Set(),
      now: () => 1000
    });
    expect(result.sentCount).toBe(1);
    // 发起记录落了('' 根可记),attempt=1;回执 detail 不落(空根早退)
    const record = store.get({ rootId: '', targetId: 'profile-1' }, '/odd/Avatar.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.attempt).toBe(1);
    expect(record?.detail).toBeUndefined();
    // 结算句柄被空根早退拦下:tick 无回调可发,注解也不会堆上来
    expect(clock.tick()).toBe(0);
    expect(store.get({ rootId: '', targetId: 'profile-1' }, '/odd/Avatar.py')?.detail).toBeUndefined();
  });

  it('冻结读取抛错:digest 无基准,applied 回执如实保持未确认并排结算注解', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const clock = makeManualTimers();
    let clockNow = 1000;
    const { transport } = makeReceiptTransport([
      { status: 'applied', file: '/ok/Avatar.py', digest: 'deadbeef' }
    ]);
    const settleHandles = new Set<unknown>();
    const result = await sendFilesViaReloadChannel({
      transport,
      targetId: 'profile-1',
      files: ['/ok/Avatar.py'],
      resolveRootId: () => '/ok',
      store,
      readFileContent: async () => {
        throw new Error('disk blown');
      },
      timers: clock.timers,
      settleHandles,
      now: () => clockNow
    });
    expect(result.sentCount).toBe(1);
    const key = { rootId: '/ok', targetId: 'profile-1' };
    const record = store.get(key, '/ok/Avatar.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('发送时点内容基准不可读');
    // 越过核验窗口后 tick:超时注解落上(保持未确认,不冒充失败/applied)
    clockNow = 12_000;
    expect(clock.tick()).toBe(1);
    const annotated = store.get(key, '/ok/Avatar.py');
    expect(annotated?.outcome).toBe('sent-unverified');
    expect(annotated?.detail).toContain('applied 核验超时');
    // 再 tick:注解已在,二次结算早退,不重复堆叠同因注解
    expect(clock.tick()).toBe(1);
    const settled = store.get(key, '/ok/Avatar.py');
    expect(settled?.detail).toBe(annotated?.detail);
    expect(settled?.detail?.split('applied 核验超时')).toHaveLength(2);
    expect(settleHandles.size).toBe(0);
  });
});
