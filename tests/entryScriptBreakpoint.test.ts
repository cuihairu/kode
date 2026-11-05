// KODE-CFG-006 验收(按 todo.md:1010):entryScriptFile 自动断点。
//
//   1. 断点预填:attach/端口模式调试目标启动 → 按配置派生结果在入口脚本
//      (kbengine.py)自动预填断点——addBreakpoints 收到入口路径(行 0)。
//   2. 文件校验:入口脚本不存在 → 零断点 + 出诊断(派生 debug.reasons 含
//      「entry script missing」,经 onMissing 上报),不崩。
//
// 门替身镜像 CFG-004 契约(entry_scripts = facts 直传;debug.ready = 根非空;
// reasons 按 derive_debug 规则);契约真值由 crates/kode-parser/tests/
// config_derive_units.rs 钉死,此处只验 TS 侧接线(入口事实解析 → RPC params
// → 派生缓存 → 断点预填)。复用 CFG-005 的 scriptsFromConfig 契约镜像。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Uri, debug } from './fake-vscode/core';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';
import {
  ensureConfigDerivedScanRoot,
  getConfigDerivedScanRootState,
  resetConfigDerivedScanRootForTests,
  type ConfigDeriveResult
} from '../src/configDerive';
import { prefillEntryScriptBreakpoints } from '../src/entryScriptBreakpoint';
import type { KodeCoreGate } from '../src/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
import { resetRootConfigGenerationForTests } from '../src/rootConfigGeneration';

interface DeriveFacts {
  workspaceRoot: string | null;
  customConfigPath: string | null;
  entryScripts: Array<{ process: string; module: string; path: string | null; exists: boolean }>;
}

/** CFG-004 契约镜像:custConfigPath 命中 `res/server/kbengine.xml` → rfind 段起点 + scripts */
const scriptsFromConfig = (p: string | null): string | null => {
  if (!p) {
    return null;
  }
  // 贪婪 .* 取最后一次 res/server/kbengine.xml 出现(Rust rfind 语义)。
  const m = /^(.*\/)res\/server\/kbengine\.xml$/.exec(p);
  return m ? `${m[1]}scripts` : null;
};

/** Rust derive_capabilities 契约镜像:def_scan_roots + entry_scripts 直传 + derive_debug */
const contractDerive = (facts: DeriveFacts): ConfigDeriveResult['derive'] => {
  const root = scriptsFromConfig(facts.customConfigPath);
  const defScanRoots = root
    ? { roots: [root], fallback: null, degraded: false }
    : {
        roots: facts.workspaceRoot ? [facts.workspaceRoot] : [],
        fallback: 'workspaceRoot',
        degraded: true
      };
  const entryScripts = facts.entryScripts;
  const reasons: string[] = [];
  if (defScanRoots.degraded) {
    reasons.push('defScanRoots degraded: workspace root fallback');
  }
  for (const es of entryScripts) {
    if (!es.exists) {
      reasons.push(`entry script missing: ${es.process}/${es.module}`);
    }
  }
  if (defScanRoots.roots.length === 0) {
    reasons.push('no def scan root (no res anchor and no workspace root)');
  }
  return {
    defScanRoots,
    telnet: { enabled: false, endpoints: [] },
    entryScripts,
    debug: { ready: defScanRoots.roots.length > 0, reasons }
  };
};

const makeGate = (calls: Array<{ method: string; params: unknown }>): KodeCoreGate => {
  return {
    runInRust: async (method: string, params: unknown) => {
      calls.push({ method, params });
      const p = params as { facts?: DeriveFacts };
      const facts: DeriveFacts = p.facts ?? {
        workspaceRoot: null,
        customConfigPath: null,
        entryScripts: []
      };
      return {
        ok: true as const,
        result: {
          derive: contractDerive(facts),
          diagnostics: contractDerive(facts).defScanRoots.degraded
            ? [{ scope: 'defScanRoots', severity: 'warning', message: 'degraded' }]
            : []
        }
      };
    }
  } as unknown as KodeCoreGate;
};

let calls: Array<{ method: string; params: unknown }> = [];
let roots: string[] = [];

const mk = (prefix: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), `kode-cfg006-${prefix}-`));

const writeFile = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
};

beforeEach(() => {
  calls = [];
  roots = [];
  resetConfigDerivedScanRootForTests();
  resetRootConfigGenerationForTests();
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

describe('KODE-CFG-006 entryScriptFile 自动断点', () => {
  it('attach 调试目标启动按配置派生预填入口脚本断点(kbengine.py 行 0)', async () => {
    const ws = mk('prefill');
    roots.push(ws);
    const tools = path.join(ws, 'tools');
    fs.mkdirSync(tools, { recursive: true });
    const assets = path.join(ws, 'assets');
    writeFile(path.join(assets, 'res', 'server', 'kbengine.xml'), '<root/>');
    // scripts/entity_defs 同级放 kbengine.py(共享入口脚本)。
    writeFile(path.join(assets, 'scripts', 'entity_defs', '.keep'), '');
    writeFile(path.join(assets, 'scripts', 'kbengine.py'), 'import kbe\n');
    const entryPath = path.join(assets, 'scripts', 'kbengine.py');

    configurationOverrides.set('kbengine', { assetsRoot: assets });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(tools), name: 'tools', index: 0 }];
    setKodeCoreShadowGate(makeGate(calls));

    // 记录断点预填调用。
    const added: Array<{ uri: string; line: number }> = [];
    debug.addBreakpoints = (bps: readonly unknown[]) => {
      for (const bp of bps as Array<{
        location: { uri: { fsPath: string }; range: { start: { line: number } } };
      }>) {
        added.push({ uri: bp.location.uri.fsPath, line: bp.location.range.start.line });
      }
    };

    await ensureConfigDerivedScanRoot();
    const state = getConfigDerivedScanRootState();

    // TS 侧解析出真实入口事实并送达 Rust(派生真源)。
    const sent = calls[0].params as { facts?: DeriveFacts };
    expect(sent.facts?.entryScripts).toEqual([
      { process: 'baseapp', module: 'kbengine', path: entryPath, exists: true }
    ]);
    // 派生缓存含该入口脚本。
    expect(state?.entryScripts).toEqual([
      { process: 'baseapp', module: 'kbengine', path: entryPath, exists: true }
    ]);

    const result = prefillEntryScriptBreakpoints();
    expect(result.status).toBe('prefilled');
    expect(result.path).toBe(entryPath);
    expect(result.reason).toBeNull();
    // 断点落在入口脚本第 0 行。
    expect(added).toEqual([{ uri: entryPath, line: 0 }]);
  });

  it('入口脚本不存在 → 不预填 + 出诊断(entry script missing),不崩', async () => {
    const ws = mk('missing');
    roots.push(ws);
    const tools = path.join(ws, 'tools');
    fs.mkdirSync(tools, { recursive: true });
    const assets = path.join(ws, 'assets');
    writeFile(path.join(assets, 'res', 'server', 'kbengine.xml'), '<root/>');
    // entity_defs 在但 kbengine.py 缺失(入口脚本不存在)。
    writeFile(path.join(assets, 'scripts', 'entity_defs', '.keep'), '');

    configurationOverrides.set('kbengine', { assetsRoot: assets });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(tools), name: 'tools', index: 0 }];
    setKodeCoreShadowGate(makeGate(calls));

    let addCount = 0;
    debug.addBreakpoints = () => {
      addCount += 1;
    };
    const reported: string[] = [];

    await ensureConfigDerivedScanRoot();
    const state = getConfigDerivedScanRootState();

    // 派生诊断:入口脚本缺失(reasons 含「entry script missing」)。
    expect(state?.debug.reasons.some(r => r.startsWith('entry script missing'))).toBe(true);
    expect(state?.entryScripts).toEqual([
      { process: 'baseapp', module: 'kbengine', path: null, exists: false }
    ]);

    const result = prefillEntryScriptBreakpoints(reason => reported.push(reason));
    expect(result.status).toBe('missing');
    expect(result.path).toBeNull();
    expect(result.reason).toBe('entry script missing: baseapp/kbengine');
    // 零断点预填 + 诊断上报。
    expect(addCount).toBe(0);
    expect(reported).toEqual(['entry script missing: baseapp/kbengine']);
  });
});
