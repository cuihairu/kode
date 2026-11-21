// kodeCoreGate 残余缺口臂(逐行定性,非补测刷分):
// - 纯面:uriUnderRoot 前缀判定 / firstDiffPath 规范化相等与分歧定位;
// - 通知/serving/命令面失败分:notify 抛错、client 创建失败、notice 20 上限;
// - 根生命周期与暖门(RUST-069-W/RUST-074-W)的逐个失败出口(尽力而为,
//   静默返 null);
// - 语料镜像账:corpus 补位语义(fill-only)、三腿(open/change/重开)抛错回滚、
//   版本回退 close+open;
// - 差异日志:BigInt 等不可序列化值的 detail 预览走 String 退路。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CORE_GATE_CONFIG,
  firstDiffPath,
  KodeCoreGate,
  ShadowDiffLog,
  uriUnderRoot,
  type KodeCoreGateConfig,
  type ShadowClientLike
} from '../src/backend/kodeCoreGate';

// ---------------------------------------------------------------------------
// 替身与装配
// ---------------------------------------------------------------------------

type Recorded = {
  openVersions: Array<{ uri: string; version: number }>;
  changes: Array<{ uri: string; version: number }>;
  closes: string[];
  notifies: string[];
  addRoots: string[];
  removeRoots: string[];
};

const record = (): Recorded => ({
  openVersions: [],
  changes: [],
  closes: [],
  notifies: [],
  addRoots: [],
  removeRoots: []
});

type StubOverrides = {
  start?: () => Promise<unknown>;
  request?: (method: string, params?: unknown) => Promise<unknown>;
  notify?: (method: string, params?: unknown) => void;
  openDocument?: (uri: string, languageId: string, version: number, text: string) => void | Promise<void>;
  changeDocument?: (uri: string, version: number, text: string) => void | Promise<void>;
  closeDocument?: (uri: string) => void | Promise<void>;
  addWorkspaceRoot?: (fsPath: string) => Promise<unknown>;
  removeWorkspaceRoot?: (fsPath: string) => Promise<unknown>;
  beginBackgroundScan?: (total: number) => Promise<unknown>;
  scanComplete?: (done: number, failed: number) => Promise<unknown>;
  scanCancel?: () => Promise<unknown>;
};

const stubFactory = (
  overrides: StubOverrides = {},
  factoryError?: string
): { factory: (serverPath: string) => ShadowClientLike; calls: Recorded } => {
  const calls = record();
  const factory = (_serverPath: string): ShadowClientLike => {
    if (factoryError) {
      throw new Error(factoryError);
    }
    return {
      start: async () => overrides.start?.() ?? null,
      request: async (method: string, params?: unknown) =>
        overrides.request?.(method, params) ?? null,
      dispose: async () => undefined,
      notify: (method: string, params?: unknown) => {
        if (overrides.notify) {
          overrides.notify(method, params);
          return;
        }
        calls.notifies.push(method);
      },
      // 先记账再委托:抛错臂的「帧写出即失败」要可观测(账面留痕,发送抛错)
      openDocument: (uri, languageId, version) => {
        calls.openVersions.push({ uri, version });
        if (overrides.openDocument) {
          return overrides.openDocument(uri, languageId, version, '');
        }
      },
      changeDocument: (uri, version) => {
        calls.changes.push({ uri, version });
        if (overrides.changeDocument) {
          return overrides.changeDocument(uri, version, '');
        }
      },
      closeDocument: (uri: string) => {
        if (overrides.closeDocument) {
          return overrides.closeDocument(uri);
        }
        calls.closes.push(uri);
      },
      addWorkspaceRoot: overrides.addWorkspaceRoot
        ? (fsPath: string) => {
            calls.addRoots.push(fsPath);
            return overrides.addWorkspaceRoot!(fsPath);
          }
        : async (fsPath: string) => {
            calls.addRoots.push(fsPath);
            return { root: 1 };
          },
      removeWorkspaceRoot: overrides.removeWorkspaceRoot
        ? (fsPath: string) => {
            calls.removeRoots.push(fsPath);
            return overrides.removeWorkspaceRoot!(fsPath);
          }
        : async (fsPath: string) => {
            calls.removeRoots.push(fsPath);
            return { removed: true };
          },
      beginBackgroundScan: overrides.beginBackgroundScan
        ? (total: number) => overrides.beginBackgroundScan!(total)
        : async () => ({ state: 'Warming' }),
      scanComplete: overrides.scanComplete
        ? (done: number, failed: number) => overrides.scanComplete!(done, failed)
        : async () => ({ state: 'Warm' }),
      scanCancel: overrides.scanCancel ? () => overrides.scanCancel!() : async () => ({ state: 'Idle' })
    };
  };
  return { factory, calls };
};

const SHADOW: Partial<KodeCoreGateConfig> = { backend: 'shadow', serverPath: '/bin/kode-server' };
const RUST: Partial<KodeCoreGateConfig> = { backend: 'rust', serverPath: '/bin/kode-server' };

const gateWith = (
  config: Partial<KodeCoreGateConfig>,
  factory?: (serverPath: string) => ShadowClientLike
): KodeCoreGate => {
  const gate = new KodeCoreGate({ clientFactory: factory, now: () => 1_000_000 });
  gate.setConfig({ ...DEFAULT_CORE_GATE_CONFIG, ...config });
  return gate;
};

// ---------------------------------------------------------------------------
// 纯面
// ---------------------------------------------------------------------------

describe('uriUnderRoot 前缀判定', () => {
  it('file:// 剥前缀;根本身/子路径命中;/ws 不误伤 /wsX', () => {
    expect(uriUnderRoot('file:///ws/a.py', '/ws')).toBe(true);
    expect(uriUnderRoot('/ws', '/ws')).toBe(true);
    expect(uriUnderRoot('/ws/sub/b.py', '/ws')).toBe(true);
    expect(uriUnderRoot('/wsX/a.py', '/ws')).toBe(false);
  });
});

describe('firstDiffPath 分歧定位', () => {
  it('键序差异被规范化抹平:相等返回 null', () => {
    expect(firstDiffPath({ b: 1, a: 2 }, { a: 2, b: 1 })).toBeNull();
  });

  it('相等子数组不遮蔽兄弟分歧:定位到分歧键', () => {
    expect(firstDiffPath({ a: [1], b: 1 }, { a: [1], b: 2 })).toBe('$.b');
  });

  it('原语/双 null 相等:规范化后同值短路判等(根级)', () => {
    // 对象对走键巡(引用不等但逐键等),原语对走 `===` 短路
    expect(firstDiffPath(1, 1)).toBeNull();
    expect(firstDiffPath('x', 'x')).toBeNull();
    expect(firstDiffPath(null, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 装配面与重启对账(E-2)
// ---------------------------------------------------------------------------

describe('装配与重启对账', () => {
  it('setInitializeParams:握手参数存储,镜像轨道照常装配', async () => {
    const { factory, calls } = stubFactory();
    const gate = new KodeCoreGate({ clientFactory: factory, now: () => 1_000_000 });
    gate.setInitializeParams({ processId: 4242, capabilities: {} });
    gate.setConfig({ ...DEFAULT_CORE_GATE_CONFIG, ...SHADOW });
    await gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'a = 1');
    expect(calls.openVersions).toHaveLength(1);
  });

  it('无 clientFactory:真身装配 KodeCoreClient,spawn 失败 → rust-unavailable 记录', async () => {
    // 真身构造只存握手参数(spawn 惰性);ENOENT 经 child error 事件
    // rejectAll(EXITED) → compare 的失败分类接住,不上浮
    const gate = new KodeCoreGate({ now: () => 1_000_000 });
    gate.setConfig({
      ...DEFAULT_CORE_GATE_CONFIG,
      backend: 'shadow',
      serverPath: '/nonexistent/kode-server'
    });
    const result = await gate.compare('textDocument/hover', {}, { ok: 1 }, 'file:///ws/a.py');
    expect(result).toEqual({ ok: 1 });
    const entries = gate.diffLog.entries();
    expect(entries[entries.length - 1].verdict).toBe('rust-unavailable');
    expect(entries[entries.length - 1].detail).toContain('启动失败');
  });

  it('自动重启对账:代数变化 → 版本账清零,注册根补注册,快照重放 didOpen', async () => {
    let generation = 1;
    const { factory, calls } = stubFactory();
    const gate = gateWith(SHADOW, serverPath => {
      const client = factory(serverPath);
      (client as unknown as { getRestartGeneration?: () => number }).getRestartGeneration =
        () => generation;
      return client;
    });
    await gate.registerRoot('/ws');
    await gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'a = 1');
    expect(calls.openVersions).toEqual([{ uri: 'file:///ws/a.py', version: 1 }]);
    generation = 2;
    await gate.mirrorDocument('file:///ws/a.py', 'python', 2, 'a = 2');
    // 重放序:根先补注册(归属依赖根已注册),快照按 didOpen 重建新账,
    // 随后本次镜像按前进走 didChange
    expect(calls.addRoots).toEqual(['/ws', '/ws']);
    expect(calls.openVersions).toEqual([
      { uri: 'file:///ws/a.py', version: 1 },
      { uri: 'file:///ws/a.py', version: 1 }
    ]);
    expect(calls.changes).toEqual([{ uri: 'file:///ws/a.py', version: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// 通知/serving/命令面失败分
// ---------------------------------------------------------------------------

describe('通知面失败分', () => {
  it('notifyFileChanged:notify 抛错 → 静默 false(不误伤热更)', async () => {
    const { factory } = stubFactory({ notify: () => { throw new Error('pipe closed'); } });
    const gate = gateWith(SHADOW, factory);
    // 拉起 client(经 mirrorDocument 的 start)
    await gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'x = 1');
    expect(gate.notifyFileChanged({ uri: 'file:///ws/a.py' })).toBe(false);
  });

  it('notifyWorkspaceFileEvent:notify 抛错 → 静默 false', async () => {
    const { factory } = stubFactory({ notify: () => { throw new Error('pipe closed'); } });
    const gate = gateWith(SHADOW, factory);
    await gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'x = 1');
    expect(gate.notifyWorkspaceFileEvent('workspace/didRenameFiles', { files: [] })).toBe(false);
  });
});

describe('命令级与 serving 失败分', () => {
  it('runInRust:client 创建失败 → ok:false client unavailable', async () => {
    const { factory } = stubFactory({}, 'factory exploded');
    const gate = gateWith(RUST, factory);
    const result = await gate.runInRust('$/kode/sdk/generate', {});
    expect(result).toEqual({ ok: false, reason: 'client unavailable' });
  });

  it('serveInRust:client 创建失败 → 回落 fallback 并记通知', async () => {
    const { factory } = stubFactory({}, 'factory exploded');
    const gate = gateWith(RUST, factory);
    const fallback = { ts: true };
    const result = await gate.serveInRust('textDocument/definition', {}, fallback);
    expect(result).toBe(fallback);
    expect(gate.state.notices.some(n => n.includes('client 创建失败'))).toBe(true);
  });

  it('notice 环形上限:20 条封顶,最旧被 shift', async () => {
    const { factory } = stubFactory({}, 'factory exploded');
    const gate = gateWith(RUST, factory);
    const methods = Array.from({ length: 22 }, (_, i) => `textDocument/method${i}`);
    for (const method of methods) {
      await gate.serveInRust(method, {}, null);
    }
    const notices = gate.state.notices;
    expect(notices).toHaveLength(20);
    expect(notices.some(n => n.includes('method0'))).toBe(false);
    expect(notices.some(n => n.includes('method21'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 根生命周期失败分(RUST-069-W)
// ---------------------------------------------------------------------------

describe('根生命周期失败分', () => {
  it('registerRoot:client 创建失败 → null', async () => {
    const { factory } = stubFactory({}, 'factory exploded');
    const gate = gateWith(SHADOW, factory);
    expect(await gate.registerRoot('/ws')).toBeNull();
  });

  it('registerRoot:非镜像轨道 → null(零开销直通)', async () => {
    const { factory } = stubFactory();
    const gate = gateWith({ backend: 'ts', serverPath: '' }, factory);
    expect(await gate.registerRoot('/ws')).toBeNull();
  });

  it('registerRoot:账内已注册 → null(去重不重发)', async () => {
    const { factory, calls } = stubFactory();
    const gate = gateWith(SHADOW, factory);
    expect(await gate.registerRoot('/ws')).toEqual({ root: 1 });
    expect(await gate.registerRoot('/ws')).toBeNull();
    expect(calls.addRoots).toEqual(['/ws']);
  });

  it('registerRoot:client 无 addWorkspaceRoot 面 → null', async () => {
    const { factory } = stubFactory();
    const gate = gateWith(SHADOW, serverPath => {
      const client = factory(serverPath);
      delete (client as Record<string, unknown>).addWorkspaceRoot;
      return client;
    });
    expect(await gate.registerRoot('/ws')).toBeNull();
  });

  it('registerRoot:start 抛错 → null', async () => {
    const { factory } = stubFactory({ start: async () => { throw new Error('spawn failed'); } });
    const gate = gateWith(SHADOW, factory);
    expect(await gate.registerRoot('/ws')).toBeNull();
  });

  it('registerRoot:addWorkspaceRoot 拒绝 → null', async () => {
    const { factory } = stubFactory({
      addWorkspaceRoot: async () => { throw new Error('root reg failed'); }
    });
    const gate = gateWith(SHADOW, factory);
    expect(await gate.registerRoot('/ws')).toBeNull();
  });

  it('removeRoot:账内该根条目同步摘除,他根保留;回执 removed:true', async () => {
    const { factory, calls } = stubFactory();
    const gate = gateWith(SHADOW, factory);
    await gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'a = 1');
    await gate.mirrorDocument('file:///other/b.py', 'python', 1, 'b = 1');
    const result = await gate.removeRoot('/ws');
    expect(result).toEqual({ removed: true });
    expect(calls.removeRoots).toEqual(['/ws']);
    // 行为面验证摘账:被撤根文档重镜像走 didOpen(账已清),他根文档走 didChange(账在)
    await gate.mirrorDocument('file:///ws/a.py', 'python', 2, 'a = 2');
    expect(calls.openVersions).toEqual([
      { uri: 'file:///ws/a.py', version: 1 },
      { uri: 'file:///other/b.py', version: 1 },
      { uri: 'file:///ws/a.py', version: 2 }
    ]);
    await gate.mirrorDocument('file:///other/b.py', 'python', 2, 'b = 2');
    expect(calls.changes).toEqual([{ uri: 'file:///other/b.py', version: 2 }]);
  });

  it('removeRoot:client 创建失败 → null(不伤账,静默)', async () => {
    const { factory, calls } = stubFactory({}, 'factory exploded');
    const gate = gateWith(SHADOW, factory);
    expect(await gate.removeRoot('/ws')).toBeNull();
    expect(calls.removeRoots).toHaveLength(0);
  });

  it('removeRoot:非镜像轨道 → null(零开销直通)', async () => {
    const { factory } = stubFactory();
    const gate = gateWith({ backend: 'ts', serverPath: '' }, factory);
    expect(await gate.removeRoot('/ws')).toBeNull();
  });

  it('removeRoot:removeWorkspaceRoot 拒绝 → null,账照摘(重镜像走 didOpen)', async () => {
    const { factory, calls } = stubFactory({
      removeWorkspaceRoot: async () => { throw new Error('dereg failed'); }
    });
    const gate = gateWith(SHADOW, factory);
    await gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'a = 1');
    expect(await gate.removeRoot('/ws')).toBeNull();
    // 账在 client 调用前摘除:摘账先于 client 腿,拒绝不回滚
    await gate.mirrorDocument('file:///ws/a.py', 'python', 2, 'a = 2');
    expect(calls.openVersions).toEqual([
      { uri: 'file:///ws/a.py', version: 1 },
      { uri: 'file:///ws/a.py', version: 2 }
    ]);
    expect(calls.changes).toHaveLength(0);
  });

  it('removeRoot:start 抛错 → null', async () => {
    const { factory } = stubFactory({ start: async () => { throw new Error('spawn failed'); } });
    const gate = gateWith(SHADOW, factory);
    expect(await gate.removeRoot('/ws')).toBeNull();
  });

  it('removeRoot:client 无 removeWorkspaceRoot 面 → null', async () => {
    const { factory } = stubFactory();
    // 换掉方法面:delete 掉 removeWorkspaceRoot 模拟旧版 client
    const bare = gateWith(SHADOW, serverPath => {
      const client = factory(serverPath);
      const clone = client as Record<string, unknown>;
      delete clone.removeWorkspaceRoot;
      return client;
    });
    expect(await bare.removeRoot('/ws')).toBeNull();
  });

});

// ---------------------------------------------------------------------------
// 暖门三态(RUST-074-W):begin/complete/cancel 各失败出口 + happy
// ---------------------------------------------------------------------------

describe('暖门失败分', () => {
  it('非镜像轨道直通 null(begin/complete/cancel 三面)', async () => {
    const { factory } = stubFactory();
    const gate = gateWith({ backend: 'ts', serverPath: '' }, factory);
    expect(await gate.beginBackgroundScan(3)).toBeNull();
    expect(await gate.scanComplete(3, 0)).toBeNull();
    expect(await gate.scanCancel()).toBeNull();
  });

  it('client 创建失败 → null(begin/complete/cancel 三面)', async () => {
    const { factory } = stubFactory({}, 'factory exploded');
    const gate = gateWith(SHADOW, factory);
    expect(await gate.beginBackgroundScan(3)).toBeNull();
    expect(await gate.scanComplete(3, 0)).toBeNull();
    expect(await gate.scanCancel()).toBeNull();
  });

  it('start 抛错 → null(begin/complete/cancel 三面)', async () => {
    const { factory } = stubFactory({ start: async () => { throw new Error('spawn failed'); } });
    const gate = gateWith(SHADOW, factory);
    expect(await gate.beginBackgroundScan(3)).toBeNull();
    expect(await gate.scanComplete(3, 0)).toBeNull();
    expect(await gate.scanCancel()).toBeNull();
  });

  it('暖门方法拒绝 → null(begin 面也收口)', async () => {
    const { factory } = stubFactory({
      beginBackgroundScan: async () => { throw new Error('begin failed'); }
    });
    const gate = gateWith(SHADOW, factory);
    expect(await gate.beginBackgroundScan(3)).toBeNull();
  });

  it('client 无暖门方法面 → null(begin/complete/cancel 三面)', async () => {
    const gate = gateWith(SHADOW, serverPath => {
      const base = stubFactory().factory(serverPath);
      const clone = base as Record<string, unknown>;
      delete clone.beginBackgroundScan;
      delete clone.scanComplete;
      delete clone.scanCancel;
      return base;
    });
    expect(await gate.beginBackgroundScan(3)).toBeNull();
    expect(await gate.scanComplete(3, 0)).toBeNull();
    expect(await gate.scanCancel()).toBeNull();
  });

  it('暖门方法拒绝 → null(complete/cancel 两面)', async () => {
    const { factory } = stubFactory({
      scanComplete: async () => { throw new Error('late scanComplete'); },
      scanCancel: async () => { throw new Error('cancel failed'); }
    });
    const gate = gateWith(SHADOW, factory);
    expect(await gate.scanComplete(3, 0)).toBeNull();
    expect(await gate.scanCancel()).toBeNull();
  });

  it('happy:三面回执照传(begin/complete/cancel)', async () => {
    const { factory } = stubFactory();
    const gate = gateWith(SHADOW, factory);
    expect(await gate.beginBackgroundScan(3)).toEqual({ state: 'Warming' });
    expect(await gate.scanComplete(3, 0)).toEqual({ state: 'Warm' });
    expect(await gate.scanCancel()).toEqual({ state: 'Idle' });
  });
});

// ---------------------------------------------------------------------------
// 语料镜像账:corpus 补位、三腿抛错回滚、版本回退
// ---------------------------------------------------------------------------

describe('镜像腿抛错回滚', () => {
  it('client 创建失败:mirrorDocument 静默返回', async () => {
    const { factory } = stubFactory({}, 'factory exploded');
    const gate = gateWith(SHADOW, factory);
    await expect(gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'a = 1')).resolves.toBeUndefined();
  });

  it('首发 didOpen 抛错:账回滚为空,下次重补 didOpen', async () => {
    let openCalls = 0;
    const { factory, calls } = stubFactory({
      openDocument: () => {
        openCalls += 1;
        if (openCalls === 1) {
          throw new Error('frame write failed');
        }
      }
    });
    const gate = gateWith(SHADOW, factory);
    await gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'a = 1');
    await gate.mirrorDocument('file:///ws/a.py', 'python', 2, 'a = 2');
    // 第一次抛错回滚(账空)→ 第二次仍走 didOpen 而非 didChange
    expect(calls.openVersions).toHaveLength(2);
    expect(calls.changes).toHaveLength(0);
  });

  it('didChange 抛错:账回滚到前一版本与快照', async () => {
    const { factory, calls } = stubFactory({
      changeDocument: () => { throw new Error('frame write failed'); }
    });
    const gate = gateWith(SHADOW, factory);
    await gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'a = 1');
    await gate.mirrorDocument('file:///ws/a.py', 'python', 2, 'a = 2');
    // change 抛错回滚 v1 → 再发 v2 时账是 v1,v2>1 照走 didChange(再抛再回滚)
    expect(calls.changes).toHaveLength(1);
    await gate.mirrorDocument('file:///ws/a.py', 'python', 2, 'a = 2-again');
    expect(calls.changes).toEqual([
      { uri: 'file:///ws/a.py', version: 2 },
      { uri: 'file:///ws/a.py', version: 2 }
    ]);
  });

  it('版本回退(重开):close+open 双发,open 抛错整腿回滚', async () => {
    const { factory, calls } = stubFactory();
    const gate = gateWith(SHADOW, factory);
    await gate.mirrorDocument('file:///ws/a.py', 'python', 2, 'a = 2');
    await gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'a = 1');
    expect(calls.closes).toEqual(['file:///ws/a.py']);
    expect(calls.openVersions).toEqual([
      { uri: 'file:///ws/a.py', version: 2 },
      { uri: 'file:///ws/a.py', version: 1 }
    ]);
  });

  it('版本回退且 open 抛错:账回滚(快照保留回退前值则下次重发同版本)', async () => {
    let openCalls = 0;
    const { factory, calls } = stubFactory({
      openDocument: (uri, _languageId, version) => {
        void uri;
        openCalls += 1;
        if (openCalls === 2) {
          throw new Error('reopen frame failed');
        }
        void version;
      }
    });
    const gate = gateWith(SHADOW, factory);
    await gate.mirrorDocument('file:///ws/a.py', 'python', 2, 'a = 2');
    await gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'a = 1');
    // 回滚到 v2 → 同版本 v1 重发仍走 close+open(1 < 2)
    await gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'a = 1-again');
    expect(calls.closes).toEqual(['file:///ws/a.py', 'file:///ws/a.py']);
    expect(openCalls).toBe(3);
  });
});

describe('corpus 补位语义(fill-only)', () => {
  it('账内已在场:corpus 快照照跳过,不降级不重发', async () => {
    const { factory, calls } = stubFactory();
    const gate = gateWith(SHADOW, factory);
    await gate.mirrorDocument('file:///ws/a.py', 'python', 3, 'a = 3');
    await gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'stale disk text', { corpus: true });
    // 编辑器流在役 v3:晚到盘快照 v1 不得把在役文档拉回旧内容
    expect(calls.openVersions).toEqual([{ uri: 'file:///ws/a.py', version: 3 }]);
    expect(calls.changes).toHaveLength(0);
    expect(calls.closes).toHaveLength(0);
  });

  it('缺席才补位:corpus 快照按 didOpen 入账', async () => {
    const { factory, calls } = stubFactory();
    const gate = gateWith(SHADOW, factory);
    await gate.mirrorDocument('file:///ws/disk.py', 'python', 1, 'disk = 1', { corpus: true });
    expect(calls.openVersions).toEqual([{ uri: 'file:///ws/disk.py', version: 1 }]);
    // 补位后再补同版本:照跳过
    await gate.mirrorDocument('file:///ws/disk.py', 'python', 1, 'disk = 1', { corpus: true });
    expect(calls.openVersions).toHaveLength(1);
  });

  it('补位 openDocument 抛错:账回滚,下次照补', async () => {
    let openCalls = 0;
    const { factory, calls } = stubFactory({
      openDocument: () => {
        openCalls += 1;
        if (openCalls === 1) {
          throw new Error('frame write failed');
        }
      }
    });
    const gate = gateWith(SHADOW, factory);
    await gate.mirrorDocument('file:///ws/disk.py', 'python', 1, 'disk = 1', { corpus: true });
    await gate.mirrorDocument('file:///ws/disk.py', 'python', 1, 'disk = 1', { corpus: true });
    expect(calls.openVersions).toHaveLength(2);
  });
});

describe('关文档清理', () => {
  it('未镜像文档关闭:零通知,幂等', () => {
    const { factory, calls } = stubFactory();
    const gate = gateWith(SHADOW, factory);
    gate.closeMirroredDocument('file:///ws/never.py');
    expect(calls.closes).toEqual([]);
  });

  it('镜像在册但轨道切回 ts:只清账不发 didClose', async () => {
    const { factory, calls } = stubFactory();
    const gate = gateWith(SHADOW, factory);
    await gate.mirrorDocument('file:///ws/a.py', 'python', 1, 'a = 1');
    gate.setConfig({ ...DEFAULT_CORE_GATE_CONFIG, backend: 'ts', serverPath: '' });
    gate.closeMirroredDocument('file:///ws/a.py');
    expect(calls.closes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 差异日志:不可序列化值的预览退路
// ---------------------------------------------------------------------------

describe('diff detail 预览退路', () => {
  it('BigInt 等不可序列化值:preview 走 String 退路,分歧路径照记', async () => {
    const { factory } = stubFactory({
      request: async () => ({ a: 1 })
    });
    const log = new ShadowDiffLog();
    const gate = new KodeCoreGate({ clientFactory: factory, now: () => 1_000_000, diffLog: log });
    gate.setConfig({ ...DEFAULT_CORE_GATE_CONFIG, ...SHADOW });
    // BigInt 使 preview 的 JSON.stringify 抛错 → String 退路;两侧同为对象
    // 才走 firstDiffPath 深探,定位到分歧键
    await gate.compare('textDocument/hover', {}, { a: 1n }, 'file:///ws/a.py');
    const entries = log.entries();
    const last = entries[entries.length - 1];
    expect(last.verdict).toBe('diff');
    expect(last.detail).toContain('$.a');
    expect(last.detail).toContain('[object Object]');
  });
});

// 覆盖口径残余(定性,不硬凑):
// - closeMirroredDocument 的镜像轨道复核(:804-805):setConfig 离开镜像
//   轨道必先 stopClient 清账(:296-297 → :491-493),「快照在场而镜像已关」
//   经公共 API 不可同时成立——防御一致性位,结构性不可达。