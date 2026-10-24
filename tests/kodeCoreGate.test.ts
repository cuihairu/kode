import { join } from 'path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KodeCoreGate,
  ShadowDiffLog,
  canonicalize,
  firstDiffPath,
  resolveBackendMode,
  type ShadowClientLike,
} from '../src/kodeCoreGate';
import { KodeCoreClient } from '../src/kodeCoreClient';

// kode2 PR-012:双轨切流门单测。kill-switch 解析、rust serving 门禁、
// shadow 影像比对四种 verdict、差异日志环形与订阅、compare 永不上浮。
// 真实 stdio 链路用 kodeFakeServer.cjs(与 kodeCoreClient.test.ts 同替身)。

const FAKE_SERVER = join(__dirname, 'helpers', 'kodeFakeServer.cjs');
const URI = 'file:///workspace/demo/entities/Monster.def';

const realClients: KodeCoreClient[] = [];

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const client of realClients) {
    await client.dispose().catch(() => undefined);
  }
});

function makeFakeClientFactory() {
  return (serverPath: string): ShadowClientLike => {
    if (serverPath === 'node:fake') {
      const client = new KodeCoreClient({
        binaryPath: process.execPath,
        args: [FAKE_SERVER],
      });
      realClients.push(client);
      return client;
    }
    return new KodeCoreClient({ binaryPath: serverPath });
  };
}

describe('语料镜像账与自动重启对账(E-2)', () => {
  interface MirrorCall {
    method: string;
    params?: { uri: string; version: number };
  }

  /** 带重启代数的镜像替身:generation 由用例推进,模拟 CORE-015 自动重启 */
  function makeRestartableStubClient() {
    const calls: MirrorCall[] = [];
    let generation = 0;
    const client = {
      calls,
      start: vi.fn(async () => {
        calls.push({ method: 'start' });
        return {};
      }),
      request: vi.fn(async (method: string) => {
        calls.push({ method: `request:${method}` });
        return {};
      }),
      dispose: vi.fn(async () => undefined),
      openDocument: vi.fn((uri: string, _languageId: string, version: number, _text: string) => {
        calls.push({ method: 'openDocument', params: { uri, version } });
      }),
      changeDocument: vi.fn((uri: string, version: number, _text: string) => {
        calls.push({ method: 'changeDocument', params: { uri, version } });
      }),
      closeDocument: vi.fn((uri: string) => {
        calls.push({ method: 'closeDocument', params: { uri, version: 0 } });
      }),
      getRestartGeneration: () => generation,
      setGeneration: (next: number): void => {
        generation = next;
      }
    };
    return client as ShadowClientLike & typeof client;
  }

  const makeRestartGate = (client: ReturnType<typeof makeRestartableStubClient>): KodeCoreGate => {
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'shadow', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    return gate;
  };

  it('自动重启:版本账重置并重放快照,继续编辑以 didChange 打到新进程', async () => {
    const client = makeRestartableStubClient();
    const gate = makeRestartGate(client);
    await gate.mirrorDocument(URI, 'kbengine-def', 1, '<Entity/>');
    await gate.mirrorDocument(URI, 'kbengine-def', 2, '<Entity/>');
    expect(client.calls.map(call => call.method)).toEqual([
      'start',
      'openDocument',
      'start',
      'changeDocument'
    ]);

    // 新进程是空库:账本必须失效,下一次镜像先重放快照再发 didChange
    client.setGeneration(1);
    await gate.mirrorDocument(URI, 'kbengine-def', 3, '<Entity/>');
    const mirrored = client.calls.filter(call => call.method !== 'start');
    expect(mirrored.map(call => [call.method, call.params?.version])).toEqual([
      ['openDocument', 1],
      ['changeDocument', 2],
      ['openDocument', 2], // 重放:按最近快照版本重开(不是旧账的 didChange)
      ['changeDocument', 3]
    ]);
  });

  it('compare 同样先对账:重启后首次对拍先重放快照再发请求', async () => {
    const client = makeRestartableStubClient();
    const gate = makeRestartGate(client);
    await gate.mirrorDocument(URI, 'kbengine-def', 1, '<Entity/>');
    client.setGeneration(1);
    await gate.compare('textDocument/diagnostic', { textDocument: { uri: URI } }, { kind: 'full', items: [] });
    const order = client.calls.map(call => call.method);
    const replayIndex = order.lastIndexOf('openDocument');
    const requestIndex = order.lastIndexOf('request:textDocument/diagnostic');
    expect(requestIndex).toBeGreaterThan(replayIndex);
  });

  it('kill-switch 离开后重进 shadow:账与快照都清,重开走 didOpen 而不是 didChange', async () => {
    const client = makeRestartableStubClient();
    const gate = makeRestartGate(client);
    await gate.mirrorDocument(URI, 'kbengine-def', 5, '<Entity/>');
    client.setGeneration(1); // 会话期间发生过自动重启(旧账已随之失效)
    gate.setConfig({ backend: 'ts', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    gate.setConfig({ backend: 'shadow', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    await gate.mirrorDocument(URI, 'kbengine-def', 5, '<Entity/>');
    expect(client.calls.filter(call => call.method !== 'start').map(call => call.method)).toEqual([
      'openDocument',
      'openDocument'
    ]);
  });
});

describe('resolveBackendMode kill-switch 解析', () => {
  it('默认/undefined/空串/拼错一律回落 ts(安全侧是 TS 真相)', () => {
    for (const raw of [undefined, 'ts', '', 'TS', 'shaddow', 'rustt']) {
      expect(resolveBackendMode(raw)).toEqual({ mode: 'ts', rustServingGated: false });
    }
  });

  it('shadow:开启影子比对,不触门禁', () => {
    expect(resolveBackendMode('shadow')).toEqual({ mode: 'shadow', rustServingGated: false });
  });

  it('rust:字面量保留,但 serving 门禁置位', () => {
    expect(resolveBackendMode('rust')).toEqual({ mode: 'rust', rustServingGated: true });
  });
});

describe('canonicalize / firstDiffPath', () => {
  it('canonicalize 屏蔽对象键序差异', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toEqual(
      canonicalize({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 })
    );
  });

  it('firstDiffPath:一致 null;数组长度/元素/对象键/根类型各报首个分歧', () => {
    expect(firstDiffPath({ a: { b: 1 } }, { a: { b: 1 } })).toBeNull();
    expect(firstDiffPath([1, 2], [1])).toBe('$.length(2≠1)');
    expect(firstDiffPath({ a: [1, 2] }, { a: [1, 3] })).toBe('$.a[1]');
    expect(firstDiffPath({ a: 1 }, { b: 1 })).toBe('$.a');
    expect(firstDiffPath('x', 1)).toBe('$');
    expect(firstDiffPath({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toBe('$.a.b.c');
  });
});

describe('KodeCoreGate 非 shadow 模式', () => {
  it('ts 模式:compare 直通,不建 client、不记日志', async () => {
    let factoryCalls = 0;
    const gate = new KodeCoreGate({
      clientFactory: () => {
        factoryCalls += 1;
        throw new Error('should not spawn');
      },
    });
    gate.setConfig({ backend: 'ts', serverPath: 'node:fake', shadowTimeoutMs: 100 });
    const tsResult = { contents: 'ts-truth' };
    await expect(gate.compare('textDocument/hover', { uri: URI }, tsResult)).resolves.toBe(tsResult);
    expect(factoryCalls).toBe(0);
    expect(gate.diffLog.summary()).toEqual({ total: 0, match: 0, diff: 0, failure: 0 });
    expect(gate.serveFromRust()).toBe(false);
  });

  it('rust 模式:serving 门禁拒绝,生效轨道 ts,留一次 notice 存照', async () => {
    let factoryCalls = 0;
    const gate = new KodeCoreGate({
      clientFactory: () => {
        factoryCalls += 1;
        throw new Error('should not spawn');
      },
    });
    gate.setConfig({ backend: 'rust', serverPath: 'node:fake', shadowTimeoutMs: 100 });
    expect(gate.servingMode).toBe('ts');
    expect(gate.rustServingGated).toBe(true);
    expect(gate.serveFromRust()).toBe(false);
    const tsResult = { ok: true };
    await expect(gate.compare('$/kode/health', undefined, tsResult)).resolves.toBe(tsResult);
    expect(factoryCalls).toBe(0);
    expect(gate.state.notices).toHaveLength(1);
    expect(gate.state.notices[0]).toContain('serving 门禁拒绝');
    // 重复 setConfig 不刷屏(noticeOnce)
    gate.setConfig({ backend: 'rust', serverPath: 'node:fake', shadowTimeoutMs: 100 });
    expect(gate.state.notices).toHaveLength(1);
  });
});

describe('KodeCoreGate shadow 影像比对(fake stdio server)', () => {
  const config = { backend: 'shadow', serverPath: 'node:fake', shadowTimeoutMs: 2000 };

  const makeGate = (now = (): number => Date.now()) => {
    const gate = new KodeCoreGate({ clientFactory: makeFakeClientFactory(), now });
    gate.setConfig(config);
    return gate;
  };

  it('verdict=match:同参同结果只记一致,ts 结果原引用返回', async () => {
    const gate = makeGate();
    const client = new KodeCoreClient({ binaryPath: process.execPath, args: [FAKE_SERVER] });
    realClients.push(client);
    const truth = await client.start();
    await expect(gate.compare('initialize', {}, truth)).resolves.toBe(truth);
    expect(gate.diffLog.summary()).toEqual({ total: 1, match: 1, diff: 0, failure: 0 });
    await client.dispose();
  }, 10_000);

  it('verdict=diff:Rust 结果不同只记日志(含首个分歧路径),服务面不变', async () => {
    const gate = makeGate();
    const tsResult = { serverInfo: { name: 'kode-fake-server', version: '9.9.9-ts' } };
    await expect(gate.compare('initialize', {}, tsResult)).resolves.toBe(tsResult);
    const summary = gate.diffLog.summary();
    expect(summary).toEqual({ total: 1, match: 0, diff: 1, failure: 0 });
    const entry = gate.diffLog.entries()[0];
    expect(entry.verdict).toBe('diff');
    expect(entry.detail).toContain('$.serverInfo.version');
    expect(entry.uri).toBeUndefined();
  }, 10_000);

  it('verdict=rust-error:Rust 侧方法失败只记日志,compare 不抛', async () => {
    const gate = makeGate();
    const tsResult = ['ts-entry'];
    await expect(gate.compare('$/kode/no-such-method', undefined, tsResult, URI)).resolves.toBe(tsResult);
    const entry = gate.diffLog.entries()[0];
    expect(entry.verdict).toBe('rust-error');
    expect(entry.uri).toBe(URI);
    expect(entry.detail).toContain('method not found');
  }, 10_000);

  it('verdict=rust-timeout:挂死请求超时归 rust 侧,不上浮', async () => {
    const gate = new KodeCoreGate({ clientFactory: makeFakeClientFactory() });
    gate.setConfig({ backend: 'shadow', serverPath: 'node:fake', shadowTimeoutMs: 150 });
    const tsResult = { late: false };
    await expect(gate.compare('$/kode/wait', { ms: 2000 }, tsResult)).resolves.toBe(tsResult);
    const entry = gate.diffLog.entries()[0];
    expect(entry.verdict).toBe('rust-timeout');
    expect(entry.detail).toContain('150ms');
  }, 10_000);

  it('serverPath 未配置:记 rust-unavailable,零进程创建', async () => {
    const gate = makeGate();
    gate.setConfig({ backend: 'shadow', serverPath: '', shadowTimeoutMs: 100 });
    const tsResult = 42;
    await expect(gate.compare('$/kode/health', undefined, tsResult)).resolves.toBe(42);
    expect(gate.diffLog.entries()[0].verdict).toBe('rust-unavailable');
    expect(gate.state.clientAlive).toBe(false);
  });

  it('spawn 冷却:clientFactory 抛错后 30s 内不重试(记 unavailable),冷却过重建', async () => {
    let attempts = 0;
    let clock = 1_000_000;
    const gate = new KodeCoreGate({
      clientFactory: () => {
        attempts += 1;
        throw new Error('binary missing');
      },
      now: () => clock,
    });
    gate.setConfig(config);
    const tsResult = { ok: 1 };
    await gate.compare('$/kode/health', undefined, tsResult);
    await gate.compare('$/kode/health', undefined, tsResult);
    expect(attempts).toBe(1);
    const entry = gate.diffLog.entries()[1];
    expect(entry.verdict).toBe('rust-unavailable');
    expect(entry.detail).toContain('冷却');
    clock += 30_001;
    await gate.compare('$/kode/health', undefined, tsResult);
    expect(attempts).toBe(2);
  });
});

describe('kill-switch 生效:离开 shadow 停 Rust 进程', () => {
  it('shadow→ts:client dispose,后续 compare 直通不记日志', async () => {
    const gate = new KodeCoreGate({ clientFactory: makeFakeClientFactory() });
    gate.setConfig({ backend: 'shadow', serverPath: 'node:fake', shadowTimeoutMs: 2000 });
    const client = new KodeCoreClient({ binaryPath: process.execPath, args: [FAKE_SERVER] });
    realClients.push(client);
    const truth = await client.start();
    await gate.compare('initialize', {}, truth);
    expect(gate.diffLog.summary().total).toBe(1);

    gate.setConfig({ backend: 'ts', serverPath: 'node:fake', shadowTimeoutMs: 2000 });
    // dispose 异步;直通语义立即生效
    await gate.compare('initialize', {}, truth);
    expect(gate.diffLog.summary().total).toBe(1);
    await vi.waitFor(() => expect(gate.state.clientAlive).toBe(false));
    await client.dispose();
  }, 15_000);

  it('shadow→rust:serving 门禁拒绝,client 同步停,轨道回 ts', async () => {
    const gate = new KodeCoreGate({ clientFactory: makeFakeClientFactory() });
    gate.setConfig({ backend: 'shadow', serverPath: 'node:fake', shadowTimeoutMs: 2000 });
    void gate.compare('$/kode/health', undefined, {});
    await vi.waitFor(() => expect(gate.state.clientAlive).toBe(true));
    gate.setConfig({ backend: 'rust', serverPath: 'node:fake', shadowTimeoutMs: 2000 });
    await vi.waitFor(() => expect(gate.state.clientAlive).toBe(false));
    expect(gate.servingMode).toBe('ts');
  }, 15_000);
});

describe('ShadowDiffLog', () => {
  it('seq 单调、环形截断保最新、summary/clear/订阅回调', () => {
    const log = new ShadowDiffLog(3);
    const seen: ShadowDiffEntry[] = [];
    const sub = log.subscribe(entry => seen.push(entry));
    for (const verdict of ['match', 'diff', 'rust-error', 'match', 'rust-timeout'] as const) {
      log.record({ method: 'm', verdict });
    }
    expect(log.entries().map(item => item.seq)).toEqual([3, 4, 5]);
    expect(seen).toHaveLength(5);
    expect(log.summary()).toEqual({ total: 3, match: 1, diff: 0, failure: 2 });
    sub.dispose();
    log.record({ method: 'm', verdict: 'match' });
    expect(seen).toHaveLength(5);
    log.clear();
    expect(log.summary().total).toBe(0);
  });

  it('record 生成 ISO 时间戳', () => {
    const log = new ShadowDiffLog();
    const entry = log.record({ method: 'm', verdict: 'match' }, new Date('2026-10-23T00:00:00Z'));
    expect(entry.timestamp).toBe('2026-10-23T00:00:00.000Z');
  });
});
