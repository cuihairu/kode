import { afterAll, describe, expect, it, vi } from 'vitest';

import { KodeCoreClient, type KodeCoreInitializeParams } from '../src/backend/kodeCoreClient';
import { KodeCoreGate, type ShadowClientLike } from '../src/backend/kodeCoreGate';

// RUST-069-W 门单测:根生命周期账本与重启重放。真二进制装配面在
// kodeCoreRootLifecycle.test.ts;这里用替身钉 gate 侧行为——
// 账去重/kill-switch 零开销/移除出账/重启重放先根后文档/替身缺面不炸。

interface CallRecord {
  op: string;
  arg?: string;
}

function makeRootStubClient(options: {
  generation?: () => number;
  withRootFaces?: boolean;
} = {}): ShadowClientLike & { calls: CallRecord[]; receipts: Map<string, { root: number }> } {
  const calls: CallRecord[] = [];
  const receipts = new Map<string, { root: number }>();
  let nextRoot = 1;
  const client: ShadowClientLike & {
    calls: CallRecord[];
    receipts: Map<string, { root: number }>;
    setGeneration?: (n: number) => void;
  } = {
    calls,
    receipts,
    start: vi.fn(async () => {
      calls.push({ op: 'start' });
      return {};
    }),
    request: vi.fn(async () => ({})),
    dispose: vi.fn(async () => undefined),
    openDocument: vi.fn((uri: string) => {
      calls.push({ op: 'openDocument', arg: uri });
    }),
    changeDocument: vi.fn((uri: string) => {
      calls.push({ op: 'changeDocument', arg: uri });
    }),
    closeDocument: vi.fn((uri: string) => {
      calls.push({ op: 'closeDocument', arg: uri });
    }),
  };
  if (options.generation) {
    let generation = 0;
    Object.defineProperty(client, 'getRestartGeneration', {
      value: () => generation,
    });
    (client as { setGeneration: (n: number) => void }).setGeneration = (n: number) => {
      generation = n;
    };
  }
  if (options.withRootFaces !== false) {
    client.addWorkspaceRoot = async (fsPath: string) => {
      calls.push({ op: 'addWorkspaceRoot', arg: fsPath });
      const root = { root: nextRoot++ };
      receipts.set(fsPath, root);
      return root;
    };
    client.removeWorkspaceRoot = async (fsPath: string) => {
      calls.push({ op: 'removeWorkspaceRoot', arg: fsPath });
      return { removed: receipts.has(fsPath) };
    };
  }
  return client as ShadowClientLike & { calls: CallRecord[]; receipts: Map<string, { root: number }> };
}

const realClients: KodeCoreClient[] = [];
afterAll(async () => {
  for (const client of realClients) {
    await client.dispose().catch(() => undefined);
  }
});

const initParams: KodeCoreInitializeParams = {
  processId: 1,
  capabilities: {},
  workspaceFolders: [],
};

function makeGate(client: ShadowClientLike): KodeCoreGate {
  const gate = new KodeCoreGate({ clientFactory: () => client });
  gate.setConfig({ backend: 'rust', serverPath: 'node:stub', shadowTimeoutMs: 500 });
  gate.setInitializeParams(initParams);
  return gate;
}

describe('KodeCoreGate 根生命周期(RUST-069-W)', () => {
  it('registerRoot 发请求记账并回执;同根重复注册账内去重不重发', async () => {
    const client = makeRootStubClient();
    const gate = makeGate(client);
    const first = await gate.registerRoot('/ws/alpha');
    expect(first).toEqual({ root: 1 });
    const repeat = await gate.registerRoot('/ws/alpha');
    expect(repeat).toBeNull();
    const adds = client.calls.filter(call => call.op === 'addWorkspaceRoot');
    expect(adds).toHaveLength(1);
    expect(adds[0].arg).toBe('/ws/alpha');
    await gate.dispose();
  });

  it('removeRoot 出账并转发;未注册根照发(server 幂等兜底)', async () => {
    const client = makeRootStubClient();
    const gate = makeGate(client);
    await gate.registerRoot('/ws/alpha');
    const removal = await gate.removeRoot('/ws/alpha');
    expect(removal).toEqual({ removed: true });
    // 出账后重注册 = 新请求(新进程语义下账内已无此根)
    const again = await gate.registerRoot('/ws/alpha');
    expect(again).toEqual({ root: 2 });
    // 从未注册的根也照发(未知根 removed:false 由 server 回执)
    const ghost = await gate.removeRoot('/ws/ghost');
    expect(ghost).toEqual({ removed: false });
    await gate.dispose();
  });

  it('kill-switch(ts 轨道)根操作零开销直通,不建 client', async () => {
    const client = makeRootStubClient();
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'ts', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    expect(await gate.registerRoot('/ws/alpha')).toBeNull();
    expect(await gate.removeRoot('/ws/alpha')).toBeNull();
    expect(client.start).not.toHaveBeenCalled();
    await gate.dispose();
  });

  it('替身缺根面:账照记,请求不发,回执 null(重启重放仍可补)', async () => {
    const client = makeRootStubClient({ withRootFaces: false });
    const gate = makeGate(client);
    expect(await gate.registerRoot('/ws/alpha')).toBeNull();
    expect(client.calls.filter(call => call.op === 'addWorkspaceRoot')).toHaveLength(0);
    await gate.dispose();
  });

  it('重启重放:先补注册根,再重放语料快照(顺序不可倒置)', async () => {
    const client = makeRootStubClient({ generation: () => 0 });
    const gate = makeGate(client);
    await gate.registerRoot('/ws/alpha');
    await gate.mirrorDocument('file:///ws/alpha/entities/Monster.def', 'kbengine-def', 1, '<root/>');
    const stub = client as ShadowClientLike & { setGeneration: (n: number) => void };
    stub.setGeneration(1);
    await gate.mirrorDocument('file:///ws/alpha/entities/Monster.def', 'kbengine-def', 2, '<root/>');
    const ops = client.calls.map(call => call.op);
    const rootReplayAt = ops.indexOf('addWorkspaceRoot', ops.indexOf('start', 1) + 1);
    const docReplayAt = ops.indexOf('openDocument', rootReplayAt);
    expect(rootReplayAt).toBeGreaterThan(-1);
    expect(docReplayAt).toBeGreaterThan(rootReplayAt);
    // 快照重放只此一次,重复请求不重发根
    await gate.mirrorDocument('file:///ws/alpha/entities/Monster.def', 'kbengine-def', 2, '<root/>');
    expect(client.calls.filter(call => call.op === 'addWorkspaceRoot')).toHaveLength(2);
    await gate.dispose();
  });

  it('换 serverPath(kill/重装):根账清空,新进程重新注册', async () => {
    const client = makeRootStubClient();
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'rust', serverPath: 'node:stub-a', shadowTimeoutMs: 500 });
    gate.setInitializeParams(initParams);
    await gate.registerRoot('/ws/alpha');
    gate.setConfig({ backend: 'rust', serverPath: 'node:stub-b', shadowTimeoutMs: 500 });
    await gate.registerRoot('/ws/alpha');
    expect(client.calls.filter(call => call.op === 'addWorkspaceRoot')).toHaveLength(2);
    await gate.dispose();
  });
});
