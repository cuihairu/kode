// 书 PR-002 ③:workspaceDiscovery 交互路径 Sync 存量实测(tests/perf 专用,不进门禁):
//   npx vitest run --config vitest.bench.config.ts tests/perf/discoverySync.bench.ts
//
// AUDIT-006 存量:workspaceDiscovery.ts 17 处 fs.*Sync。本 probe 逐项量测
// 「交互路径(hover/definition 每次调用)真实触达」的 Sync 成本,冷/热分列:
//   D1 深扫描 walk(readdirSync,cachedScan 冷):巨仓首查卡顿来源;
//   D2 conventionalConfigRoots readdirSync(每 resolveDiscoveredConfigRoot);
//   D3 hasEngineConfigProbe+firstExisting 探针链(每 resolveDiscoveredConfigRoot);
//   D4 getDiscoveryChoice existsSync(每 getDefinitionWorkspaceLayout ×3);
//   D5 resolveDiscovered{EntityDefsRoot,EntitiesXmlPath,TypesXmlPath} 全链热态。
// 输出 DISCOVERY-METRIC 前缀,落 docs/perf/discovery-sync-run.txt。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'perf_hooks';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { workspace as stubWorkspace } from '../fake-vscode/workspaceState';
import {
  conventionalConfigRoots,
  hasEngineConfigProbe,
  getDiscoveryChoice,
  preheatDiscoveryScan,
  resetDiscoveryState,
  scanWorkspaceAnchors,
  resolveDiscoveredEntityDefsRoot,
  resolveDiscoveredEntitiesXmlPath,
  resolveDiscoveredTypesXmlPath,
  setDiscoveryChoice
} from '../../src/workspaceDiscovery';

const ASSETS_OUT = path.join(os.tmpdir(), 'kode-perf-discovery-assets');
const OUT_FILE = process.env.KODE_DISCOVERY_OUT
  ?? path.resolve(__dirname, '../../docs/perf/discovery-sync-run.txt');
const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.appendFileSync(OUT_FILE, line + '\n');
  console.log(line);
};

const once = (name: string, value: number, unit = 'ms'): void => {
  emit(`DISCOVERY-METRIC ${name} n=1 ${Math.round(value * 100) / 100}${unit}`);
};

const sample = (name: string, runs: number, body: () => void): void => {
  const started = performance.now();
  for (let i = 0; i < runs; i += 1) {
    body();
  }
  const elapsed = (performance.now() - started) / runs;
  once(name, elapsed, 'ms/call');
};

const makeRoots = (): Record<string, string> => {
  execFileSync('node', [
    path.resolve(__dirname, '../../scripts/generate-perf-assets.mjs'),
    '--out', ASSETS_OUT,
    '--keep'
  ], { stdio: 'inherit' });
  return {
    'def-heavy': path.join(ASSETS_OUT, 'def-heavy'),
    large: path.join(ASSETS_OUT, 'large')
  };
};

describe('书 PR-002 ③:workspaceDiscovery Sync 成本(交互路径)', () => {
  const roots: Record<string, string> = {};

  beforeAll(() => {
    stubWorkspace.workspaceFolders = [];
    emit(`DISCOVERY-ENV node=${process.version} cpus=${os.cpus().length}`);
    for (const [name, root] of Object.entries(makeRoots())) {
      roots[name] = root;
    }
  }, 900000);

  afterAll(() => {
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
    resetDiscoveryState();
  });

  it('D1-D2:深扫描冷 walk 与约定 readdir(def-heavy + large)', () => {
    for (const scenario of ['def-heavy', 'large'] as const) {
      const root = roots[scenario];
      // D1:cachedScan 冷(walk 本体)——修复后由激活期预热承担,交互不再触发
      resetDiscoveryState();
      let d1 = 0;
      {
        const started = performance.now();
        const found = scanWorkspaceAnchors(root);
        d1 = performance.now() - started;
        once(`D1.${scenario}.coldAnchorWalk`, d1);
        once(`D1.${scenario}.coldAnchorWalkVisited`, found.scanVisited, ' entries');
      }
      // 直接重复调用(不经缓存,等价于修复前交互路径冷触发反复付价)
      sample(`D1.${scenario}.uncachedWalkRepeat`, 20, () => {
        scanWorkspaceAnchors(root);
      });
      // 修复后交互路径:preheat(激活期)→ resolve 三兄弟每次调用成本
      resetDiscoveryState();
      preheatDiscoveryScan(root);
      sample(`D1.${scenario}.interactiveResolveAfterPreheat`, 1000, () => {
        resolveDiscoveredEntityDefsRoot(root);
        resolveDiscoveredEntitiesXmlPath(root);
        resolveDiscoveredTypesXmlPath(root);
      });
      // D2:约定根 readdirSync(每 resolveDiscoveredConfigRoot 未 memo 上游时)
      sample(`D2.${scenario}.conventionalConfigRoots`, 1000, () => {
        conventionalConfigRoots(root);
      });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 600000);

  it('D3-D5:探针链与记忆项 existsSync(交互路径每次调用)', () => {
    const root = roots['def-heavy'];
    resetDiscoveryState();
    scanWorkspaceAnchors(root); // 预热 cachedScan(交互常态)
    setDiscoveryChoice(root, 'entityDefs', path.join(root, 'scripts', 'entity_defs'));

    // D3:资产根探针链(hasEngineConfigProbe existsSync ×约定数 + firstExisting)
    sample('D3.defheavy.configRootProbeChain', 1000, () => {
      let hit: string | null = null;
      for (const candidate of conventionalConfigRoots(root).filter(hasEngineConfigProbe)) {
        hit = candidate;
        break;
      }
      if (hit === null && root === '') {
        throw new Error('unreachable');
      }
    });

    // D4:getDiscoveryChoice 的 remembered existsSync(每 layout ×3 次)
    sample('D4.defheavy.discoveryChoiceExistsSync', 1000, () => {
      getDiscoveryChoice(root, 'entityDefs');
      getDiscoveryChoice(root, 'entitiesXml');
      getDiscoveryChoice(root, 'typesXml');
    });

    // D5:三兄弟 resolve 全链热态(hover/definition 每 getDefinitionWorkspaceLayout)
    sample('D5.defheavy.resolvedTripleWarm', 1000, () => {
      resolveDiscoveredEntityDefsRoot(root);
      resolveDiscoveredEntitiesXmlPath(root);
      resolveDiscoveredTypesXmlPath(root);
    });
    fs.rmSync(root, { recursive: true, force: true });
  }, 600000);
});
