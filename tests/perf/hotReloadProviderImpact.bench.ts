/**
 * RUST-412 新增 Provider 对语言服务尾延迟影响基准(HR-EXT-008):
 *   KODE_HPI_FILES=400 npx vitest run --config vitest.bench.config.ts tests/perf/hotReloadProviderImpact.bench.ts
 *
 * 调度隔离口径:provider 派发面只活在保存事件管线(src/hotReload.ts)与后端
 * 装配层,不在语言服务 hover/definition 调用图(结构性保障由
 * tests/hotReloadProviderSchedulingIsolation.test.ts 钉死)。本基准在
 * 调度隔离之上做**实证对照**:同一批真实盘上脚本 + 同一份实时索引下,
 * 语言服务 warm 尾延迟(p50/p95/p99/max)在
 *   HPI-H0 无 provider host(基线)
 *   HPI-HN 20 个 provider adapter 已注册进热更 host(进程内就绪)
 * 两形态逐点对照——若调度隔离成立,两者应落在同一噪声带(墙钟只记录
 * 不进断言,阈值化属 RUST-414 后续批次;本批只建测量+结构断言)。
 *
 * 测量面:悬停=KBEngineHoverProvider.provideHover(真实语言服务面);
 * 定义=PythonClassIndex.resolveSelfMethodCandidates(定义语义核,
 * unblockedDefinition 同口径,避免 Rust-first RPC 面依赖真实二进制)。
 * 结构断言:provider 派发计数在整轮悬停/定义测量中恒为 0(宿主就绪但
 * 从不被语言服务调用)——调度隔离的实证。
 *
 * 输出 HPI-ENV/HPI-METRIC/HPI-NOTE 落 docs/perf/hot-reload-provider-impact-run.txt
 * (追加制,KODE_HPI_OUT 可覆盖),与主 unit 门无交集(.bench.ts 独立 lane)。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Position, Uri, makeTextDocument } from '../fake-vscode/core';
import { workspace as stubWorkspace } from '../fake-vscode/workspaceState';
import { KBEngineHoverProvider } from '../../src/languageProviders';
import { PythonClassIndex } from '../../src/backend/pythonClassIndex';
import { IndexScheduler } from '../../src/backend/indexScheduler';
import { EntityMappingManager } from '../../src/entityMapping';
import { resetScanRootCache } from '../../src/scanRoots';
import { createHotReloadProviderHost } from '../../src/backend/hotReloadProviderAssembly';
import { HOT_RELOAD_PLUGIN_API_VERSION } from '../../src/backend/hotReloadPluginApi';
import type { HotReloadProvider } from '../../src/backend/hotReloadPluginApi';

const ASSETS_OUT = path.join(os.tmpdir(), 'kode-hpi-assets');
const FILES = Number(process.env.KODE_HPI_FILES ?? '400');
const WARM_N = Number(process.env.KODE_HPI_WARM ?? '40');
const ADAPTERS = Number(process.env.KODE_HPI_ADAPTERS ?? '20');

const OUT_FILE =
  process.env.KODE_HPI_OUT ??
  path.resolve(__dirname, '../../docs/perf/hot-reload-provider-impact-run.txt');
const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.appendFileSync(OUT_FILE, line + '\n');
  console.log(line);
};

const percentile = (samples: number[], rank: number): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
};

const metric = (name: string, values: number[]): void => {
  emit(
    `HPI-METRIC ${name} n=${values.length} ` +
      `p50=${percentile(values, 0.5)}ms p95=${percentile(values, 0.95)}ms ` +
      `p99=${percentile(values, 0.99)}ms max=${Math.max(...values)}ms`
  );
};

describe('书 HR-EXT-008:provider 存在/缺席两形态语言服务 warm 尾延迟对照', () => {
  let root = '';
  let dispatchCount = 0;
  let providerHost: ReturnType<typeof createHotReloadProviderHost> | null = null;
  let manager: EntityMappingManager | null = null;
  let index: PythonClassIndex | null = null;
  let document: ReturnType<typeof makeTextDocument>;
  let hoverPosition: Position;
  let definitionArgs: [string, number, string];

  const countingAdapter = (id: string): HotReloadProvider => ({
    providerId: `bench.provider.${id}`,
    apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
    displayName: `bench provider ${id}`,
    canSend: () => true,
    send: () => {
      dispatchCount += 1;
      return { ok: true, detail: '' };
    }
  });

  beforeAll(() => {
    execFileSync(
      'node',
      [
        path.resolve(__dirname, '../../scripts/generate-perf-assets.mjs'),
        '--out',
        ASSETS_OUT,
        '--large-files',
        String(FILES),
        '--keep'
      ],
      { stdio: 'inherit' }
    );
    root = path.join(ASSETS_OUT, 'large');
    resetScanRootCache();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async (pattern: unknown): Promise<Uri[]> => {
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
      walk(root);
      return out;
    }) as typeof stubWorkspace.findFiles;
    emit(`HPI-ENV node=${process.version} cpus=${os.cpus().length} files=${FILES} warm=${WARM_N} adapters=${ADAPTERS}`);
  }, 600000);

  afterAll(() => {
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
    stubWorkspace.workspaceFolders = [];
    providerHost?.dispose();
    manager?.dispose();
    index?.dispose?.();
  });

  it('HPI-H0/HPI-HN:provider 存在不改变 hover/definition warm 尾延迟;派发计数恒 0', async () => {
        const avatarPath = path.join(root, 'scripts', 'base', 'Avatar.py');
    // 覆写口径同 coldHover:补 onRpc0(py 侧签名 self+1 参,与生成器
    // Avatar.def 声明的 onRpc0..3 对上),悬停/定义都落在真实命中面。
    fs.writeFileSync(
      avatarPath,
      'class Avatar:\n    def onEnterWorld(self):\n        return 0\n\n    def onRpc0(self, arg):\n        return arg\n',
      'utf8'
    );
    const scheduler = new IndexScheduler();
    manager = new EntityMappingManager({ subscriptions: [] } as never, scheduler);
    index = new PythonClassIndex(scheduler);
    const hover = new KBEngineHoverProvider(manager);

    document = makeTextDocument(fs.readFileSync(avatarPath, 'utf8'), {
      fileName: avatarPath,
      languageId: 'python'
    });
    hoverPosition = new Position(4, 13); // onRpc0 方法名上
    definitionArgs = [avatarPath, 1, 'onEnterWorld'];

    // 等首扫完成,两形态都测 warm(热路径)尾延迟。
    await manager.waitForInitialScan();
    await index.waitForInitialScan();

    // HPI-H0:无 provider host(基线)
    const hoverH0: number[] = [];
    const defH0: number[] = [];
    for (let i = 0; i < WARM_N; i += 1) {
      const hs = performance.now();
      await hover.provideHover(document, hoverPosition);
      hoverH0.push(performance.now() - hs);
      const ds = performance.now();
      await index!.resolveSelfMethodCandidates(...definitionArgs);
      defH0.push(performance.now() - ds);
    }
    metric('HPI-H0.warmHover', hoverH0);
    metric('HPI-H0.warmDefinition', defH0);

    // HPI-HN:20 个 provider adapter 注册进热更 host(进程内就绪)
    providerHost = createHotReloadProviderHost({
      providers: Array.from({ length: ADAPTERS }, (_, i) => countingAdapter(`a${i}`))
    });
    const hoverHN: number[] = [];
    const defHN: number[] = [];
    for (let i = 0; i < WARM_N; i += 1) {
      const hs = performance.now();
      await hover.provideHover(document, hoverPosition);
      hoverHN.push(performance.now() - hs);
      const ds = performance.now();
      await index!.resolveSelfMethodCandidates(...definitionArgs);
      defHN.push(performance.now() - ds);
    }
    metric('HPI-HN.warmHover', hoverHN);
    metric('HPI-HN.warmDefinition', defHN);
    once('HPI-HN.registeredAdapters', ADAPTERS);

    // 结构断言:整轮悬停/定义测量,provider 派发计数恒 0(宿主就绪但从不
    // 被语言服务调用)。墙钟两形态对照只记录不进断言(阈值化属 RUST-414)。
    expect(dispatchCount, `provider 被语言服务调用 ${dispatchCount} 次`).toBe(0);
  });
});

function once(name: string, value: number, unit = ''): void {
  emit(`HPI-METRIC ${name} n=1 ${value}${unit}`);
}
