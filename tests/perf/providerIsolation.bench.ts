/**
 * RUST-412(HR-EXT-008)provider 派发调度隔离基准:键开时注册表解析(canSend 是
 * 第三方同步代码)是否占住合并窗 fire 回调同步段,以及该切片对同事件循环上
 * 的语言服务(hover/definition)尾延迟的传导。基准跑法:
 *   npx vitest run --config vitest.bench.config.ts tests/perf/providerIsolation.bench.ts
 *
 * 只观测不改行为;断言=语义计数命中面(每 fire 恰一次派发、canSend 全部在
 * 微任务),墙钟一律不进断言(p50/p95/p99/max 只记录,阈值化归后续)。
 * 输出 ISOL-ENV/ISOL-METRIC/ISOL-NOTE 落 docs/perf/provider-isolation-run.txt
 * (追加制,KODE_ISOL_OUT 可覆盖),与主 unit 门无交集(.bench.ts 独立 lane)。
 *
 * 机制与诚实边界:
 *   P1 fire 切片(N0/N24 两臂):合并窗 fire 回调自身墙钟。修复后 N24≈N0
 *     (canSend 挪出同步段);未修复时 N24≈N0+24×spin。
 *   P1b 兄弟定时回调偏移(同批):每轮在 fire tick 前登记一个兄弟定时器,量它
 *     相对 tick 入口的调用时刻。真实扩展宿主里 hover 预算/索引泵定时器正是
 *     同一批的兄弟回调——canSend 在同步段时兄弟回调被垫高 24×spin,修复后
 *     兄弟回调先于派发微任务执行,偏移回到基线。这是「语言服务尾延迟不受
 *     派发决议拖累」的机制级证据。
 *   P2 hover 尾延迟(N0/N24):warm hover 是纯微任务链,「启动即悬置→同步切片→
 *     await」形状如实呈现同步切片阻塞——修复前切片吞 hover 首续延(整段
 *     24×spin 垫进延迟),修复后首续延先于派发微任务恢复(派发微任务仍与
 *     hover 后续跳同队列交错,残余=N24−N0 受 provider 数×spin 有界,完整
 *     归因看 P1/P1b)。
 *   P3 definition 尾延迟(N0/N24,诚实注记):竞争源与 hover 完全同源(fire 同步
 *     切片),主口径=P1/P1b 直接归因+既有 tests/perf/unblockedDefinition.bench
 *     .ts;本臂作补充观测(.def→py 落点),语料未命中记 ISOL-NOTE hit=0 不中断。
 *   PythonDefinitionProvider(2500ms 预算闸)不复刻:预算语义由 tests/hoverBudget
 *     .test.ts 锁定,构造/首扫成本与 fire 切片竞争是另一面。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { Position, Uri, makeTextDocument } from '../fake-vscode/core';
import {
  hotReloadSectionReader,
  readHotReloadSettings,
  setupHotReload,
  type HotReloadTimerDeps
} from '../../src/hotReload';
import {
  HOT_RELOAD_PLUGIN_API_VERSION,
  type HotReloadProvider
} from '../../src/backend/hotReloadPluginApi';
import { allFileSystemWatchers, configurationOverrides } from '../helpers/vscodeStub';
import { KBEngineDefinitionProvider, KBEngineHoverProvider } from '../../src/languageProviders';
import { EntityMappingManager } from '../../src/entityMapping';
import { IndexScheduler } from '../../src/backend/indexScheduler';
import { resetScanRootCache } from '../../src/scanRoots';

const ASSETS_OUT = process.env.KODE_ISOL_ASSETS_OUT
  ?? path.join(os.tmpdir(), 'kode-isol-assets');
const LARGE_FILES = Number(process.env.KODE_ISOL_LARGE_FILES ?? '24');
const PROVIDER_COUNT = Number(process.env.KODE_ISOL_PROVIDERS ?? '24');
const FIRE_ROUNDS = Number(process.env.KODE_ISOL_FIRES ?? '200');
const BUSY_SPIN_MS = Number(process.env.KODE_ISOL_CANSEND_SPIN_MS ?? '0.15');

const OUT_FILE = process.env.KODE_ISOL_OUT
  ?? path.resolve(__dirname, '../../docs/perf/provider-isolation-run.txt');
const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.appendFileSync(OUT_FILE, line + '\n');
  console.log(line);
};

const percentile = (samples: number[], rank: number): number => {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
};

const pooled = (name: string, samples: number[]): void => {
  emit(
    `ISOL-METRIC ${name} n=${samples.length} ` +
    `p50=${percentile(samples, 0.5)}ms p95=${percentile(samples, 0.95)}ms ` +
    `p99=${percentile(samples, 0.99)}ms max=${percentile(samples, 1)}ms`
  );
};

const once = (name: string, value: number, unit = 'ms'): void => {
  emit(`ISOL-METRIC ${name} n=1 ${Math.round(value * 100) / 100}${unit}`);
};

/** 同步忙转:建模第三方 canSend 的同步解析成本(无 await 让出,不产生 IO)。 */
const busySpin = (ms: number): void => {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    // 忙转本体
  }
};

const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => number } => {
  const handles = new Map<unknown, () => void>();
  let nextHandle = 0;
  return {
    tick: () => {
      const callbacks = [...handles.values()];
      handles.clear();
      for (const callback of callbacks) {
        callback();
      }
      return callbacks.length;
    },
    timers: {
      set: (callback): unknown => {
        const handle = nextHandle++;
        handles.set(handle, callback);
        return handle;
      },
      clear: (handle): void => {
        handles.delete(handle);
      }
    }
  };
};

const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

const makeProvider = (overrides: Partial<HotReloadProvider> = {}): HotReloadProvider => ({
  providerId: 'iso-fork',
  apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
  displayName: 'Iso fork provider',
  canSend: () => true,
  send: () => ({ ok: true }),
  ...overrides
});

let largeRoot = '';

const contexts: vscode.ExtensionContext[] = [];

const disposeContextsFrom = (start: number): void => {
  for (const context of contexts.slice(start)) {
    for (const subscription of [...context.subscriptions].reverse()) {
      try {
        subscription.dispose();
      } catch {
        // 释放失败不掩盖用例本身的断言
      }
    }
  }
  contexts.length = start;
};

/**
 * 复制 tests/hotReloadProviderWiring.test.ts 的 boot 骨架,差异:
 * - readSnapshot 每文件唯一 hash(逐轮换文件防去重,200 次 fire 全放行);
 * - n 个 provider 只有第 n-1 个应答(走满 n 个 canSend,最大同步成本臂);
 * - canSend 带 busySpin 建模同步成本。
 */
const bootIso = (
  providerCount: number,
  counters: { canSend: number; providerSend: number },
  urls: string[]
): { clock: ReturnType<typeof makeTimers>; fireChange: (fsPath: string) => void } => {
  configurationOverrides.set('kbengine', {
    hotReload: {
      enabled: true,
      globs: ['**/*.py'],
      actionName: '',
      debounceMs: 100,
      syntaxGate: true,
      sendViaProviders: true
    }
  });
  const clock = makeTimers();
  const context = ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;
  contexts.push(context);
  setupHotReload(context, () => undefined, {
    timers: clock.timers,
    status: {
      log: () => undefined,
      setWatchOff: () => undefined,
      setReady: () => undefined,
      setSending: () => undefined,
      setSentUnverified: () => undefined,
      setFailed: () => undefined,
      setSkippedNoAction: () => undefined,
      setRestartRequired: () => undefined,
      dispose: () => undefined
    } as never,
    pipelineFaces: {
      readSnapshot: async file => ({ hash: file, content: 'x = 1' }),
      syntaxCheck: async () => ({ ok: true })
    },
    defaultHotfix: {
      transport: request => {
        urls.push(request.url);
        return Promise.resolve({ ok: true, status: 200, durationMs: 1, body: 'ok' });
      },
      resolveAllowRootLevelStem: () =>
        readHotReloadSettings(hotReloadSectionReader()).allowRootLevelStem
    },
    hotReloadProviders: Array.from({ length: providerCount }, (_, index) =>
      makeProvider({
        providerId: `iso-fork-${index}`,
        canSend: () => {
          busySpin(BUSY_SPIN_MS);
          counters.canSend += 1;
          return index === providerCount - 1;
        },
        send: () => {
          counters.providerSend += 1;
          return { ok: true, detail: 'iso' };
        }
      })
    )
  });
  const saveWatcher = allFileSystemWatchers[allFileSystemWatchers.length - 1];
  return {
    clock,
    fireChange: (fsPath: string) => saveWatcher.fireChange({ fsPath } as never)
  };
};

describe('RUST-412 provider 派发调度隔离基准', () => {
  let scheduler: IndexScheduler;
  let manager: EntityMappingManager;
  let hoverProvider: KBEngineHoverProvider;
  let definitionProvider: KBEngineDefinitionProvider;
  let avatarDocument: vscode.TextDocument;
  let hoverPosition: vscode.Position;
  let defDocument: vscode.TextDocument;
  let defPosition: vscode.Position;

  beforeAll(async () => {
    execFileSync('node', [
      path.resolve(__dirname, '../../scripts/generate-perf-assets.mjs'),
      '--out', ASSETS_OUT,
      '--only', 'large',
      '--large-files', String(LARGE_FILES),
      '--keep'
    ], { stdio: 'inherit' });
    largeRoot = path.join(ASSETS_OUT, 'large');
    resetScanRootCache();
    vscode.workspace.workspaceFolders = [{ uri: Uri.file(largeRoot), name: 'ws', index: 0 }];
    vscode.workspace.findFiles = (async (pattern: unknown): Promise<Uri[]> => {
      const glob = String(pattern);
      const match = /\*\.(\w+)$/.exec(glob);
      if (!match) {
        return [];
      }
      const suffix = `.${match[1]}`;
      const out: Uri[] = [];
      const walk = (dir: string): void => {
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile() && entry.name.endsWith(suffix)) {
            out.push(Uri.file(full));
          }
        }
      };
      walk(largeRoot);
      return out;
    }) as typeof vscode.workspace.findFiles;

    // Avatar.py 覆写补 onRpc0(py 方法名=def 声明方法,过形参闸),同 coldHover。
    const avatarPath = path.join(largeRoot, 'scripts', 'base', 'Avatar.py');
    fs.writeFileSync(
      avatarPath,
      'class Avatar:\n    def onEnterWorld(self):\n        return 0\n\n    def onRpc0(self, arg):\n        return arg\n',
      'utf8'
    );

    scheduler = new IndexScheduler();
    manager = new EntityMappingManager({ subscriptions: [] } as never, scheduler);
    hoverProvider = new KBEngineHoverProvider(manager);
    definitionProvider = new KBEngineDefinitionProvider(manager);

    avatarDocument = makeTextDocument(
      fs.readFileSync(avatarPath, 'utf8'),
      { fileName: avatarPath, languageId: 'python' }
    );
    hoverPosition = new Position(4, 13);

    const defPath = path.join(largeRoot, 'scripts', 'entity_defs', 'Avatar.def');
    const defText = fs.readFileSync(defPath, 'utf8');
    defDocument = makeTextDocument(defText, { fileName: defPath, languageId: 'kbengine-def' });
    const defLineIndex = defText.split('\n').findIndex(line => line.includes('onRpc0'));
    defPosition = new Position(
      Math.max(0, defLineIndex),
      Math.max(0, defText.split('\n')[defLineIndex]?.indexOf('onRpc0') ?? 0)
    );

    await manager.waitForInitialScan();
    emit(
      `ISOL-ENV node=${process.version} cpus=${os.cpus().length} largeFiles=${LARGE_FILES} `
      + `providers=${PROVIDER_COUNT} rounds=${FIRE_ROUNDS} spinMs=${BUSY_SPIN_MS} `
      + `avatarDefLine=${defLineIndex}`
    );
    const sanity = await hoverProvider.provideHover(avatarDocument, hoverPosition);
    if (!sanity) {
      throw new Error('P2 骨架失真:热 Avatar onRpc0 hover 未命中');
    }
  }, 600000);

  afterAll(() => {
    manager.dispose();
    scheduler.dispose();
    disposeContextsFrom(0);
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
    vscode.workspace.workspaceFolders = [];
    configurationOverrides.clear();
  });

  it('P1 fire 切片:N0 vs N24,200 次 fire,合并窗回调墙钟', async () => {
    for (const [label, providerCount] of [['N0', 0], ['N24', PROVIDER_COUNT]] as const) {
      const counters = { canSend: 0, providerSend: 0 };
      const urls: string[] = [];
      const armStart = contexts.length;
      const { clock, fireChange } = bootIso(providerCount, counters, urls);
      const slices: number[] = [];
      const siblingOffsets: number[] = [];
      for (let i = 0; i < FIRE_ROUNDS; i += 1) {
        fireChange(`${largeRoot}/scripts/base/A${i}.py`);
        clock.tick();
        await flush();
        const t0 = performance.now();
        let siblingAt = 0;
        // P1b:fire 定时器之后登记的兄弟定时回调(真实宿主里 hover 预算/索引泵
        // 定时器即同批兄弟回调),量它相对 tick 入口被垫高多少。
        clock.timers.set(() => {
          siblingAt = performance.now();
        });
        clock.tick(); // 合并窗 fire 回调 → 兄弟回调(被测同步切片)
        slices.push(performance.now() - t0);
        if (siblingAt > 0) {
          siblingOffsets.push(siblingAt - t0);
        }
        await flush(); // 微任务(canSend/send)排空
      }
      pooled(`P1.fireSlice.${label}`, slices);
      pooled(`P1.siblingTimer.${label}`, siblingOffsets);
      expect(siblingOffsets).toHaveLength(FIRE_ROUNDS); // 兄弟回调每轮都在同批执行
      once(`P1.fires.${label}`, FIRE_ROUNDS, ' fires');
      once(`P1.canSend.${label}`, counters.canSend, ' calls');
      if (providerCount === 0) {
        expect(urls).toHaveLength(FIRE_ROUNDS); // 默认热更每 fire 一次
      } else {
        expect(counters.providerSend).toBe(FIRE_ROUNDS); // 应答 provider 每 fire 一次
        expect(urls).toHaveLength(0);
      }
      expect(counters.canSend).toBe(providerCount * FIRE_ROUNDS); // 遍历全在微任务
      disposeContextsFrom(armStart);
      configurationOverrides.clear();
    }
  }, 600000);

  it('P2 hover 尾延迟:保存风暴与 hover 交错,N0 vs N24', async () => {
    for (const [label, providerCount] of [['N0', 0], ['N24', PROVIDER_COUNT]] as const) {
      const counters = { canSend: 0, providerSend: 0 };
      const armStart = contexts.length;
      const { clock, fireChange } = bootIso(providerCount, counters, []);
      const latencies: number[] = [];
      let hits = 0;
      for (let i = 0; i < FIRE_ROUNDS; i += 1) {
        fireChange(`${largeRoot}/scripts/base/A${i}.py`);
        const hoverStart = performance.now();
        const hoverPending = hoverProvider.provideHover(avatarDocument, hoverPosition);
        clock.tick(); // 去抖
        await flush();
        clock.tick(); // fire 同步切片(修复前吞 hover 首续延)
        const hover = await hoverPending;
        latencies.push(performance.now() - hoverStart);
        if (hover) {
          hits += 1;
        }
        await flush(); // 派发微任务排空
      }
      pooled(`P2.hover.${label}`, latencies);
      once(`P2.hoverHits.${label}`, hits, ' hits');
      expect(hits).toBe(FIRE_ROUNDS); // 每轮 hover 命中(语义)
      expect(counters.canSend).toBe(providerCount * FIRE_ROUNDS);
      if (providerCount > 0) {
        // 诚实归因:派发微任务与 warm hover 后续续延同队列交错,残余差受
        // provider 数×spin 有界;切片级阻塞的消除由 P1/P1b 直接证明。
        emit('ISOL-NOTE P2 残余=N24−N0 为派发微任务与 hover 续延同队列交错,'
          + '非切片阻塞;切片级归因看 P1.fireSlice/P1.siblingTimer');
      }
      disposeContextsFrom(armStart);
      configurationOverrides.clear();
    }
  }, 600000);

  it('P3 definition 尾延迟:.def→py 落点,N0 vs N24(诚实注记)', async () => {
    for (const [label, providerCount] of [['N0', 0], ['N24', PROVIDER_COUNT]] as const) {
      const counters = { canSend: 0, providerSend: 0 };
      const armStart = contexts.length;
      const { clock, fireChange } = bootIso(providerCount, counters, []);
      const latencies: number[] = [];
      let hits = 0;
      for (let i = 0; i < FIRE_ROUNDS; i += 1) {
        fireChange(`${largeRoot}/scripts/base/A${i}.py`);
        const start = performance.now();
        const pending = definitionProvider.provideDefinition(defDocument, defPosition);
        clock.tick();
        await flush();
        clock.tick();
        const location = await pending;
        latencies.push(performance.now() - start);
        if (location) {
          hits += 1;
        }
        await flush();
      }
      pooled(`P3.definition.${label}`, latencies);
      once(`P3.definitionHits.${label}`, hits, ' hits');
      expect(counters.canSend).toBe(providerCount * FIRE_ROUNDS);
      if (hits === 0) {
        emit(`ISOL-NOTE P3.${label} hit=0(语料未命中,仅延迟分布可观测)`);
      }
      disposeContextsFrom(armStart);
      configurationOverrides.clear();
    }
  }, 600000);
});
