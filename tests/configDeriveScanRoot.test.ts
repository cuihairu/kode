// KODE-CFG-005 验收:def 扫描根按配置派生(CFG-004 链消费端)。
//
// 两测试(按 todo.md:1009 验收):
//   1. 定位到不同 kbengine.xml 段时扫描根随之变化——workspace=工具子目录,
//      assetsRoot 设置指向两个不同资产树(A: assets/、B: other/),各含
//      res/server/kbengine.xml + scripts/;切换 + bump generation 后重新
//      ensure,getIndexScanRoots 的派生根从 A 变 B,且派生根替换了旧的宽
//      assetsRoot(不再整树扫)。
//   2. 失效路径降级诊断——config 路径不含 res 锚点(assets/kbengine.xml
//      直接置根)→ 派生降级(degraded),getConfigDerivedScanRoot 落空,
//      旧 workspace∪assetsRoot 链兜底,状态含 defScanRoots 诊断,不崩。
//
// 门替身按 CFG-004 契约响应(customConfigPath 命中 res/server/kbengine.xml
// 段 → rfind(res) 段起点 + scripts;否则降级);契约真值由 Rust 侧
// rpc_dispatch.rs 两个 dispatch 测试钉死,此处只验 TS 侧接线(路径事实 →
// RPC params → 缓存 → 扫描根)。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Uri } from './fake-vscode/core';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';
import {
  ensureConfigDerivedScanRoot,
  getConfigDerivedScanRoot,
  getConfigDerivedScanRootState,
  resetConfigDerivedScanRootForTests
} from '../src/configDerive';
import type { KodeCoreGate } from '../src/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
import {
  getIndexScanRoots,
  resetScanRootCache,
  setActiveProfileScanRoot
} from '../src/scanRoots';
import {
  bumpRootConfigGeneration,
  resetRootConfigGenerationForTests
} from '../src/rootConfigGeneration';

interface DeriveFacts {
  workspaceRoot: string | null;
  customConfigPath: string | null;
  entryScripts: unknown[];
}

interface FakeGateResponse {
  defScanRoots: {
    roots: string[];
    fallback: string | null;
    degraded: boolean;
  };
}

/** CFG-004 契约镜像:custConfigPath 命中 `res/server/kbengine.xml` → rfind 段起点 + scripts */
const scriptsFromConfig = (p: string | null): string | null => {
  if (!p) {
    return null;
  }
  // 贪婪 .* 取最后一次 res/server/kbengine.xml 出现(Rust rfind 语义)。
  const m = /^(.*[\\/])res[\\/]server[\\/]kbengine\.xml$/.exec(p);
  return m ? `${m[1]}scripts` : null;
};

const contractDerive = (facts: DeriveFacts): FakeGateResponse => {
  const root = scriptsFromConfig(facts.customConfigPath);
  if (root) {
    return {
      defScanRoots: { roots: [root], fallback: null, degraded: false }
    };
  }
  return {
    defScanRoots: {
      roots: facts.workspaceRoot ? [facts.workspaceRoot] : [],
      fallback: 'workspaceRoot',
      degraded: true
    }
  };
};

/** 记录收到的 RPC params + 按契约返回 */
const makeGate = (calls: Array<{ method: string; params: unknown }>): KodeCoreGate => {
  return {
    runInRust: async (method: string, params: unknown) => {
      calls.push({ method, params });
      const p = params as { facts?: DeriveFacts };
      const derive = contractDerive(p.facts ?? { workspaceRoot: null, customConfigPath: null, entryScripts: [] });
      return {
        ok: true as const,
        result: {
          derive: {
            defScanRoots: derive.defScanRoots,
            telnet: { enabled: false, endpoints: [] },
    database: {
      available: false,
      dbType: '',
      host: '',
      port: 0,
      username: '',
      databaseName: '',
      characterSet: '',
      encrypt: true,
      passwordAvailable: false
    },
            entryScripts: [],
            debug: { ready: !derive.defScanRoots.degraded, reasons: [] }
          },
          diagnostics: derive.defScanRoots.degraded
            ? [{ scope: 'defScanRoots', severity: 'warning', message: 'degraded' }]
            : []
        }
      };
    }
  } as unknown as KodeCoreGate;
};

let roots: string[] = [];
let calls: Array<{ method: string; params: unknown }> = [];

const mk = (prefix: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), `kode-cfg005-${prefix}-`));

const writeFile = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
};

beforeEach(() => {
  roots = [];
  calls = [];
  resetConfigDerivedScanRootForTests();
  resetScanRootCache();
  resetRootConfigGenerationForTests();
  setActiveProfileScanRoot(null);
  configurationOverrides.clear();
  stubWorkspace.workspaceFolders = [];
});

afterEach(() => {
  setKodeCoreShadowGate(null);
  configurationOverrides.clear();
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('KODE-CFG-005 def 扫描根按配置派生', () => {
  it('定位到不同 kbengine.xml 段时扫描根随之变化(派生根替换旧 assetsRoot)', async () => {
    // A:tools(workspace) + assets/res/server/kbengine.xml + assets/scripts/
    const wsA = mk('a');
    roots.push(wsA);
    const toolsA = path.join(wsA, 'tools');
    fs.mkdirSync(toolsA, { recursive: true });
    const assetsA = path.join(wsA, 'assets');
    writeFile(path.join(assetsA, 'res', 'server', 'kbengine.xml'), '<root/>');
    fs.mkdirSync(path.join(assetsA, 'scripts'), { recursive: true });

    configurationOverrides.set('kbengine', { assetsRoot: assetsA });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(toolsA), name: 'tools', index: 0 }];
    setKodeCoreShadowGate(makeGate(calls));

    await ensureConfigDerivedScanRoot();
    const derivedA = getConfigDerivedScanRoot();
    const scanRootsA = getIndexScanRoots();
    // 派生根 = assets/scripts(非降级、目录存在)。
    expect(derivedA).toBe(path.join(assetsA, 'scripts'));
    // 扫描根:workspace 工具子目录 + 宽 assetsRoot(审核发现修复:scripts 之外
    // 的资源/定义文件仍被索引;派生根 assets/scripts 被宽 assetsRoot 包含,去重后
    // 不再单独入列,不重复扫)。
    expect(scanRootsA).toContain(assetsA);
    expect(scanRootsA).not.toContain(path.join(assetsA, 'scripts'));
    // RPC 收到的是真实解析出的 config 路径事实。
    const sent = calls[0].params as { facts?: DeriveFacts };
    expect(sent.facts?.customConfigPath).toBe(
      path.join(assetsA, 'res', 'server', 'kbengine.xml')
    );

    // 切到 B(不同资产树):bump generation → 缓存过期 → 重取,扫描根变化。
    const wsB = mk('b');
    roots.push(wsB);
    const toolsB = path.join(wsB, 'tools');
    fs.mkdirSync(toolsB, { recursive: true });
    const otherB = path.join(wsB, 'other');
    writeFile(path.join(otherB, 'res', 'server', 'kbengine.xml'), '<root/>');
    fs.mkdirSync(path.join(otherB, 'scripts'), { recursive: true });

    configurationOverrides.set('kbengine', { assetsRoot: otherB });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(toolsB), name: 'tools', index: 0 }];
    bumpRootConfigGeneration('cfg005 test: switch assets tree');

    await ensureConfigDerivedScanRoot();
    const derivedB = getConfigDerivedScanRoot();
    const scanRootsB = getIndexScanRoots();
    expect(derivedB).toBe(path.join(otherB, 'scripts'));
    expect(derivedB).not.toBe(derivedA);
    expect(scanRootsB).toContain(otherB);
    expect(scanRootsB).not.toContain(path.join(otherB, 'scripts'));
    // 两次 RPC 的 config 路径事实不同 → 派生结果随之变。
    expect(calls).toHaveLength(2);
    const sentB = calls[1].params as { facts?: DeriveFacts };
    expect(sentB.facts?.customConfigPath).toBe(
      path.join(otherB, 'res', 'server', 'kbengine.xml')
    );
  });

  it('失效路径降级诊断:config 无 res 锚点 → 降级 + 旧链兜底,不崩', async () => {
    const wsC = mk('c');
    roots.push(wsC);
    const toolsC = path.join(wsC, 'tools');
    fs.mkdirSync(toolsC, { recursive: true });
    const assetsC = path.join(wsC, 'assets');
    // config 直接置 assets 根(无 res/server 段)→ 派生找不到锚点 → 降级。
    writeFile(path.join(assetsC, 'kbengine.xml'), '<root/>');

    configurationOverrides.set('kbengine', { assetsRoot: assetsC });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(toolsC), name: 'tools', index: 0 }];
    setKodeCoreShadowGate(makeGate(calls));

    await ensureConfigDerivedScanRoot();
    const state = getConfigDerivedScanRootState();
    expect(state?.degraded).toBe(true);
    expect(state?.ok).toBe(true);
    expect(state?.diagnostics.some(d => d.scope === 'defScanRoots')).toBe(true);
    // 派生不可用 → 同步访问器落空(消费面回退旧链)。
    expect(getConfigDerivedScanRoot()).toBeNull();

    // 旧链兜底:workspace ∪ assetsRoot,不抛、不崩。
    const scanRoots = getIndexScanRoots();
    expect(scanRoots).toContain(toolsC);
    expect(scanRoots).toContain(assetsC);
  });
});
