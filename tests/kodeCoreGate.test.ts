import { join } from 'path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KodeCoreGate,
  ShadowDiffLog,
  canonicalize,
  firstDiffPath,
  resolveBackendMode,
  type ShadowClientLike,
} from '../src/backend/kodeCoreGate';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import {
  awaitWithInteractiveBudget,
  interactiveCircuitState,
  resetInteractiveCircuit,
  resetInteractiveCircuitForManualRestart
} from '../src/backend/kodeCoreShadowFaces';

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

function makeShadowGate(client: ShadowClientLike): KodeCoreGate {
  const gate = new KodeCoreGate({ clientFactory: () => client });
  gate.setConfig({ backend: 'shadow', serverPath: 'node:stub', shadowTimeoutMs: 500 });
  return gate;
}

describe('语料镜像账与自动重启对账(E-2)', () => {
  it('自动重启:版本账重置并重放快照,继续编辑以 didChange 打到新进程', async () => {
    const client = makeRestartableStubClient();
    const gate = makeShadowGate(client);
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
    const gate = makeShadowGate(client);
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
    const gate = makeShadowGate(client);
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

  it('RUST-221 restartCore:显式重启与 kill-switch 往返同效,重开走 didOpen', async () => {
    const client = makeRestartableStubClient();
    const gate = makeShadowGate(client);
    await gate.mirrorDocument(URI, 'kbengine-def', 4, '<Entity/>');
    expect(client.calls.filter(call => call.method !== 'start')).toHaveLength(1);
    gate.restartCore();
    expect(client.dispose).toHaveBeenCalled();
    // 旧账已清:重启后继续编辑按快照重放 didOpen(版本 4),不是 didChange(5)
    await gate.mirrorDocument(URI, 'kbengine-def', 5, '<Entity/>');
    expect(client.calls.filter(call => call.method !== 'start').map(call => call.method)).toEqual([
      'openDocument',
      'openDocument'
    ]);
  });

  it('RUST-221 restartCore 在 ts 模式幂等无害:无进程可停,不抛不建 client', async () => {
    const gate = new KodeCoreGate({
      clientFactory: () => {
        throw new Error('ts mode must not build a client');
      }
    });
    gate.setConfig({ backend: 'ts', serverPath: '', shadowTimeoutMs: 500 });
    expect(() => gate.restartCore()).not.toThrow();
    await expect(gate.mirrorDocument(URI, 'kbengine-def', 1, '<Entity/>')).resolves.toBeUndefined();
  });
});

describe('关文档清理(E-4)', () => {
  it('撤版本账与快照:重开走低版本 didOpen 而不是 didChange,didClose 只发一次', async () => {
    const client = makeRestartableStubClient();
    const gate = makeShadowGate(client);
    await gate.mirrorDocument(URI, 'kbengine-def', 5, '<Entity/>');
    gate.closeMirroredDocument(URI);
    await gate.mirrorDocument(URI, 'kbengine-def', 1, '<Entity/>');
    // 幂等:已无快照,重复关闭不再通知 Rust
    gate.closeMirroredDocument(URI);
    expect(client.calls.map(call => call.method)).toEqual([
      'start',
      'openDocument',
      'closeDocument',
      'start',
      'openDocument',
      'closeDocument'
    ]);
    expect(client.calls.filter(call => call.method === 'openDocument').length).toBe(2);
    expect(client.calls.some(call => call.method === 'changeDocument')).toBe(false);
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

  it('rust:服务轨道放行(2026-11-08 用户令「直接切」,serving 门禁解除)', () => {
    expect(resolveBackendMode('rust')).toEqual({ mode: 'rust', rustServingGated: false });
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

  it('rust 模式:服务轨道放行(配 serverPath 即 serveFromRust),未配回落 ts 留 notice', async () => {
    let factoryCalls = 0;
    const gate = new KodeCoreGate({
      clientFactory: () => {
        factoryCalls += 1;
        throw new Error('should not spawn');
      },
    });
    gate.setConfig({ backend: 'rust', serverPath: 'node:fake', shadowTimeoutMs: 100 });
    expect(gate.servingMode).toBe('rust');
    expect(gate.rustServingGated).toBe(false);
    expect(gate.serveFromRust()).toBe(true);
    // 服务轨道下 compare 直通(影子对拍只在 shadow),不拉进程
    const tsResult = { ok: true };
    await expect(gate.compare('$/kode/health', undefined, tsResult)).resolves.toBe(tsResult);
    expect(factoryCalls).toBe(0);

    // 未配 serverPath → 回落 ts(不误伤),留一次 notice 存照
    gate.setConfig({ backend: 'rust', serverPath: '', shadowTimeoutMs: 100 });
    expect(gate.serveFromRust()).toBe(false);
    expect(gate.servingMode).toBe('ts');
    expect(gate.state.notices.some(note => note.includes('serverPath 未配置'))).toBe(true);
    // 重复 setConfig 不刷屏(noticeOnce)
    gate.setConfig({ backend: 'rust', serverPath: '', shadowTimeoutMs: 100 });
    expect(gate.state.notices.filter(note => note.includes('serverPath 未配置'))).toHaveLength(1);
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

  it('shadow→rust:镜像轨道延续,client 保持存活,服务轨道切 rust', async () => {
    const gate = new KodeCoreGate({ clientFactory: makeFakeClientFactory() });
    gate.setConfig({ backend: 'shadow', serverPath: 'node:fake', shadowTimeoutMs: 2000 });
    void gate.compare('$/kode/health', undefined, {});
    await vi.waitFor(() => expect(gate.state.clientAlive).toBe(true));
    gate.setConfig({ backend: 'rust', serverPath: 'node:fake', shadowTimeoutMs: 2000 });
    // rust 服务轨道仍镜像语料:client 不被停(与 ts kill-switch 不同)
    expect(gate.servingMode).toBe('rust');
    expect(gate.state.clientAlive).toBe(true);
    await gate.dispose();
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

describe('runInRust 命令级 RPC 面(Phase0 接线)', () => {
  it('按需拉起并包成 $/kode/rpc,返回 ok:true + 结果', async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = {
      start: vi.fn(async () => ({})),
      request: vi.fn(async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return { echoed: true };
      }),
      dispose: vi.fn(async () => undefined),
    } as unknown as ShadowClientLike;
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'ts', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    const result = await gate.runInRust<{ echoed: boolean }>('$/kode/echo', { a: 1 });
    expect(result).toEqual({ ok: true, result: { echoed: true } });
    expect(calls).toEqual([
      { method: '$/kode/rpc', params: { method: '$/kode/echo', params: { a: 1 } } },
    ]);
  });

  it('无 serverPath 时返回 ok:false 且不拉起', async () => {
    const start = vi.fn(async () => ({}));
    const client = {
      start,
      request: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } as unknown as ShadowClientLike;
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'ts', serverPath: '', shadowTimeoutMs: 500 });
    const result = await gate.runInRust('$/kode/echo', {});
    expect(result).toEqual({ ok: false, reason: 'no serverPath' });
    expect(start).not.toHaveBeenCalled();
  });

  it('client 请求失败返回 ok:false + 原因(兜底路径)', async () => {
    const client = {
      start: vi.fn(async () => ({})),
      request: vi.fn(async () => {
        throw new Error('boom');
      }),
      dispose: vi.fn(async () => undefined),
    } as unknown as ShadowClientLike;
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'ts', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    const result = await gate.runInRust('$/kode/echo', {});
    expect(result).toEqual({ ok: false, reason: 'boom' });
  });
});

describe('serveInRust 服务面(2026-11-08 用户令「直接切」)', () => {
  it('rust 轨道:LSP 方法直发 kode-server,返回 Rust 结果', async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = {
      start: vi.fn(async () => ({})),
      request: vi.fn(async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return {
          uri: '/ws/avatar.def',
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } },
        };
      }),
      dispose: vi.fn(async () => undefined),
    } as unknown as ShadowClientLike;
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'rust', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    const result = await gate.serveInRust(
      'textDocument/definition',
      { textDocument: { uri: '/ws/a.def' } },
      null
    );
    expect(result).toEqual({
      uri: '/ws/avatar.def',
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } },
    });
    expect(calls).toEqual([
      { method: 'textDocument/definition', params: { textDocument: { uri: '/ws/a.def' } } },
    ]);
  });

  it('非 rust 轨道(ts):零开销返回 fallback,不拉进程', async () => {
    const start = vi.fn();
    const client = {
      start,
      request: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } as unknown as ShadowClientLike;
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'ts', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    await expect(gate.serveInRust('textDocument/definition', {}, 'ts-fallback')).resolves.toBe(
      'ts-fallback'
    );
    expect(start).not.toHaveBeenCalled();
  });

  it('Rust 请求失败:返回 fallback,留 notice,不抛', async () => {
    const client = {
      start: vi.fn(async () => ({})),
      request: vi.fn(async () => {
        throw new Error('boom');
      }),
      dispose: vi.fn(async () => undefined),
    } as unknown as ShadowClientLike;
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'rust', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    await expect(gate.serveInRust('textDocument/definition', {}, 'ts-fallback')).resolves.toBe(
      'ts-fallback'
    );
    expect(gate.state.notices.some(note => note.includes('boom'))).toBe(true);
  });

  it('rust 轨道未配 serverPath:回落 ts,返回 fallback', async () => {
    const gate = new KodeCoreGate();
    gate.setConfig({ backend: 'rust', serverPath: '', shadowTimeoutMs: 500 });
    await expect(gate.serveInRust('textDocument/definition', {}, 'ts-fallback')).resolves.toBe(
      'ts-fallback'
    );
    expect(gate.state.clientAlive).toBe(false);
  });

  it('CORE-015 连续性:崩溃窗口内请求回落 TS 续服务,恢复后 rust 轨道续轨', async () => {
    // 崩溃时序(与 kodeCoreClient.handleExit 语义对齐):进程退出 → 在飞
    // 请求以 EXITED 拒绝 → respawn+重握手完成后 start() 恢复成功。
    const calls: string[] = [];
    let phase: 'serving' | 'down' | 'recovered' = 'serving';
    const client = {
      start: vi.fn(async () => {
        if (phase === 'down') {
          throw new Error('server exited (signal=SIGKILL)');
        }
        return {};
      }),
      request: vi.fn(async (_method: string, params?: unknown) => {
        calls.push(phase);
        void params;
        return { rust: phase };
      }),
      dispose: vi.fn(async () => undefined),
    } as unknown as ShadowClientLike;
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'rust', serverPath: 'node:stub', shadowTimeoutMs: 500 });

    // 崩溃前:rust 轨道正常服务。
    await expect(gate.serveInRust('textDocument/definition', {}, null)).resolves.toEqual({
      rust: 'serving',
    });
    expect(calls).toEqual(['serving']);

    // 崩溃窗口:EXITED 拒绝 → fallback(provider 走 TS 实现链,语法功能
    // 继续使用,不抛不悬挂),留 notice 存照。
    phase = 'down';
    await expect(gate.serveInRust('textDocument/definition', {}, 'ts-fallback')).resolves.toBe(
      'ts-fallback'
    );
    expect(calls).toEqual(['serving'], '崩溃窗口内请求不落 rust(request 未达)');
    expect(gate.state.notices.some(note => note.includes('server exited'))).toBe(true);

    // respawn+重握手完成:同一 client 实例恢复,rust 轨道续服务(换实例由
    // ensureClient 按 serverPath 处理,此处钉同实例恢复语义)。
    phase = 'recovered';
    await expect(gate.serveInRust('textDocument/definition', {}, null)).resolves.toEqual({
      rust: 'recovered',
    });
    expect(calls).toEqual(['serving', 'recovered']);
  });
});

describe('notifyFileChanged 通知面(热更旁路 §11.3)', () => {
  it('client 已存活 → 发 $/kode/fileChanged 通知帧并回 true', async () => {
    const notes: Array<{ method: string; params?: unknown }> = [];
    const client = {
      start: vi.fn(async () => ({})),
      request: vi.fn(async () => ({})),
      notify: vi.fn((method: string, params?: unknown) => {
        notes.push({ method, params });
      }),
      dispose: vi.fn(async () => undefined),
    } as unknown as ShadowClientLike;
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'ts', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    // 既有命令面把 client 拉活(与生产同链路),通知面复用同一 stdio 进程
    await gate.runInRust('$/kode/echo', {});
    const params = { fsPath: '/ws/assets/res/types.xml', ext: '.xml', kind: 'change' };

    expect(gate.notifyFileChanged(params)).toBe(true);

    expect(notes).toEqual([{ method: '$/kode/fileChanged', params }]);
    // 单向通知:不占请求 id,不改任何请求/响应语义
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it('client 未启动 → 静默降级 false,不为发通知拉起进程', () => {
    const factory = vi.fn();
    const gate = new KodeCoreGate({ clientFactory: factory });
    gate.setConfig({ backend: 'ts', serverPath: 'node:stub', shadowTimeoutMs: 500 });

    expect(gate.notifyFileChanged({ fsPath: '/a.xml' })).toBe(false);

    expect(factory).not.toHaveBeenCalled();
    expect(gate.state.clientAlive).toBe(false);
  });

  it('通知口抛错 → 收口成 false,不外抛阻塞热更', () => {
    const client = {
      start: vi.fn(async () => ({})),
      request: vi.fn(async () => ({})),
      notify: vi.fn(() => {
        throw new Error('stdio closed');
      }),
      dispose: vi.fn(async () => undefined),
    } as unknown as ShadowClientLike;
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'ts', serverPath: 'node:stub', shadowTimeoutMs: 500 });

    expect(() => gate.notifyFileChanged({ fsPath: '/a.xml' })).not.toThrow();
    expect(gate.notifyFileChanged({ fsPath: '/a.xml' })).toBe(false);
  });
});

describe('notifyWorkspaceFileEvent 通知面(RUST-131-W 生产文件事件)', () => {
  it('client 已存活 → 原方法名+params 通知帧,回 true', async () => {
    const notes: Array<{ method: string; params?: unknown }> = [];
    const client = {
      start: vi.fn(async () => ({})),
      request: vi.fn(async () => ({})),
      notify: vi.fn((method: string, params?: unknown) => {
        notes.push({ method, params });
      }),
      dispose: vi.fn(async () => undefined),
    } as unknown as ShadowClientLike;
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'ts', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    await gate.runInRust('$/kode/echo', {});

    const renameParams = {
      files: [{ oldUri: 'file:///ws/a.def', newUri: 'file:///ws/b.def' }],
    };
    expect(gate.notifyWorkspaceFileEvent('workspace/didRenameFiles', renameParams)).toBe(true);
    const deleteParams = { files: [{ uri: 'file:///ws/a.def' }] };
    expect(gate.notifyWorkspaceFileEvent('workspace/didDeleteFiles', deleteParams)).toBe(true);

    expect(notes).toEqual([
      { method: 'workspace/didRenameFiles', params: renameParams },
      { method: 'workspace/didDeleteFiles', params: deleteParams },
    ]);
  });

  it('client 未启动 → 静默降级 false,不为发通知拉起进程', () => {
    const factory = vi.fn();
    const gate = new KodeCoreGate({ clientFactory: factory });
    gate.setConfig({ backend: 'ts', serverPath: 'node:stub', shadowTimeoutMs: 500 });

    expect(
      gate.notifyWorkspaceFileEvent('workspace/didDeleteFiles', { files: [{ uri: 'file:///x' }] })
    ).toBe(false);

    expect(factory).not.toHaveBeenCalled();
    expect(gate.state.clientAlive).toBe(false);
  });

  it('通知口抛错 → 收口成 false,不外抛', () => {
    const client = {
      start: vi.fn(async () => ({})),
      request: vi.fn(async () => ({})),
      notify: vi.fn(() => {
        throw new Error('stdio closed');
      }),
      dispose: vi.fn(async () => undefined),
    } as unknown as ShadowClientLike;
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'ts', serverPath: 'node:stub', shadowTimeoutMs: 500 });

    expect(() =>
      gate.notifyWorkspaceFileEvent('workspace/didRenameFiles', {
        files: [{ oldUri: 'file:///a', newUri: 'file:///b' }],
      })
    ).not.toThrow();
    expect(
      gate.notifyWorkspaceFileEvent('workspace/didRenameFiles', {
        files: [{ oldUri: 'file:///a', newUri: 'file:///b' }],
      })
    ).toBe(false);
  });
});

// P1-4(2026-11-24 用户令):Rust 熔断漏记启动失败 + 手动重启不复位。
// 启动失败此前与请求失败同笼转成正常回落,预算包装把它记成一次成功——
// 启动失败永不熔断;手动重启只 stopClient,熔断状态不动,重启无效。
describe('P1-4 Rust 熔断:启动失败如实记账 + 手动重启复位', () => {
  it('serveInRust 启动失败记入熔断(仍回落 ts);restartCore 无条件复位;复位后如实再开', async () => {
    // 隔离:模块级熔断状态按独立代清零
    resetInteractiveCircuit(-77001);
    expect(interactiveCircuitState().open).toBe(false);
    const gate = new KodeCoreGate({
      clientFactory: (): ShadowClientLike => ({
        start: vi.fn(async () => {
          throw new Error('spawn failed: binary missing');
        }),
        request: vi.fn(async () => ({})),
        dispose: vi.fn(async () => undefined),
      }),
    });
    gate.setConfig({ backend: 'rust', serverPath: 'broken-server', shadowTimeoutMs: 2000 });
    try {
      const out = await gate.serveInRust(
        'textDocument/hover',
        { textDocument: { uri: URI } },
        'TS-FALLBACK',
        { timeoutMs: 500 }
      );
      expect(out, '启动失败仍回落 ts(铁律:Rust 失败不误伤服务)').toBe('TS-FALLBACK');
      expect(
        interactiveCircuitState().open,
        '启动失败必须记入熔断(修前被预算包装记成成功)'
      ).toBe(true);
      // 手动重启:无条件复位(修前只 stopClient,熔断不动,重启等于无效)
      gate.restartCore();
      expect(interactiveCircuitState().open, '手动重启必须复位熔断').toBe(false);
      expect(interactiveCircuitState().timeoutStreak).toBe(0);
      // 复位后下一请求不再被熔断直通挡住;再次启动失败如实再开
      const out2 = await gate.serveInRust(
        'textDocument/hover',
        { textDocument: { uri: URI } },
        'TS-FALLBACK',
        { timeoutMs: 500 }
      );
      expect(out2).toBe('TS-FALLBACK');
      expect(interactiveCircuitState().open, '复位后的启动失败如实再开熔断').toBe(true);
    } finally {
      await gate.dispose().catch(() => undefined);
      resetInteractiveCircuitForManualRestart();
    }
  });

  it('连续预算超时开熔断后,手动重启必须复位(修前后续请求仍被挡)', async () => {
    resetInteractiveCircuit(-77002);
    for (let round = 0; round < 3; round += 1) {
      const face = await awaitWithInteractiveBudget(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return 'slow';
      }, 10);
      expect(face, '超预算降级 null').toBeNull();
    }
    expect(interactiveCircuitState().open, '连续 3 次超时熔断开放').toBe(true);
    const gate = new KodeCoreGate();
    gate.restartCore();
    expect(interactiveCircuitState().open, '手动重启必须复位熔断(修前重启无效)').toBe(false);
    expect(interactiveCircuitState().timeoutStreak).toBe(0);
    resetInteractiveCircuitForManualRestart();
  });
});

// P1(复审 2026-11-24):旧客户端挂起启动在重启后才失败,记账必须校验
// 客户端身份——修前 catch 无条件 noteInteractiveStartupFailure,已消亡
// 会话的失败会打开新会话的熔断,下一次交互直通 null。
describe('P1 复审:旧客户端启动失败不得打开新会话熔断', () => {
  it('挂起旧 start → 重启且新客户端成功服务 → 旧 start 才拒绝:熔断不得开放', async () => {
    resetInteractiveCircuit(-77003);
    expect(interactiveCircuitState().open).toBe(false);
    let releaseOldStart: (error: Error) => void = () => undefined;
    let created = 0;
    const gate = new KodeCoreGate({
      clientFactory: (): ShadowClientLike => {
        created += 1;
        if (created === 1) {
          // 旧客户端:start 挂起(用户交互先落在慢握手上),由用例稍后拒绝
          return {
            start: vi.fn(
              () =>
                new Promise<never>((_resolve, reject) => {
                  releaseOldStart = (error: Error) => reject(error);
                })
            ),
            request: vi.fn(async () => ({})),
            dispose: vi.fn(async () => undefined),
          };
        }
        return {
          start: vi.fn(async () => ({})),
          request: vi.fn(async () => 'NEW-OK'),
          dispose: vi.fn(async () => undefined),
        };
      },
    });
    gate.setConfig({ backend: 'rust', serverPath: 'server-a', shadowTimeoutMs: 2000 });
    try {
      const oldInteraction = gate.serveInRust(
        'textDocument/hover',
        { textDocument: { uri: URI } },
        'TS-FALLBACK',
        { timeoutMs: 500 }
      );
      // 旧 start 挂起中:用户重启,新客户端启动成功并正常服务
      gate.restartCore();
      const newInteraction = gate.serveInRust(
        'textDocument/hover',
        { textDocument: { uri: URI } },
        'TS-FALLBACK',
        { timeoutMs: 500 }
      );
      expect(await newInteraction, '新客户端必须正常服务').toBe('NEW-OK');
      // 此刻旧 start 才拒绝(进程已亡):失败属已消亡会话
      releaseOldStart(new Error('stale handshake failed after restart'));
      expect(await oldInteraction, '旧帧仍回落 ts').toBe('TS-FALLBACK');
      expect(
        interactiveCircuitState().open,
        '旧会话的启动失败不得打开新会话熔断(修前被旧帧记账打开)'
      ).toBe(false);
      // 新会话继续可用:熔断未被旧帧污染
      const again = await gate.serveInRust(
        'textDocument/hover',
        { textDocument: { uri: URI } },
        'TS-FALLBACK',
        { timeoutMs: 500 }
      );
      expect(again, '新会话后续交互不被旧帧失败挡住').toBe('NEW-OK');
    } finally {
      await gate.dispose().catch(() => undefined);
      resetInteractiveCircuitForManualRestart();
    }
  });
});
