// KODE-CFG-007 验收(todo.md:1011):telnet 按配置启用。
//
//   开:telnet 段开启 → 自动列出 Telnet/Debug Targets 目标(含派生端口);
//   关:telnet 段不在 → 不列(空目标)。
//
// 门替身镜像 Rust derive_telnet 契约(read_custom_telnet 取文档序首个
// telnet_service 节点;显式端口单目标标 kbengine.xml;无端口逐组件写死表;
// passwordSet=元件段密码非空)。契约真值由 crates/kode-parser/tests/
// config_derive_units.rs 钉死,此处验 TS 侧接线(配置树读盘 → RPC params
// → 派生缓存 → 目标列表)。复用 CFG-005/006 的 scriptsFromConfig 契约镜像。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Uri } from './fake-vscode/core';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';
import {
  ensureConfigDerivedScanRoot,
  getConfigDerivedScanRootState,
  resetConfigDerivedScanRootForTests,
  type ConfigDeriveResult
} from '../src/configDerive';
import {
  buildDerivedTelnetTargets,
  readDerivedTelnetTargets
} from '../src/telnetDeriveTargets';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { contractResolveResult } from './helpers/configCoreContract';
import { resetRootConfigGenerationForTests } from '../src/rootConfigGeneration';
import { ensureConfigResolved } from '../src/serverConfigResolve';

interface TreeNode {
  name: string;
  text: string;
  children: TreeNode[];
}

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
  const m = /^(.*[\\/])res[\\/]server[\\/]kbengine\.xml$/.exec(p);
  return m ? `${m[1]}scripts` : null;
};

/** 文档序首个名匹配节点(镜像 Rust first_node) */
const firstNode = (node: TreeNode, name: string): TreeNode | null => {
  for (const child of node.children) {
    if (child.name === name) {
      return child;
    }
  }
  for (const child of node.children) {
    const found = firstNode(child, name);
    if (found) {
      return found;
    }
  }
  return null;
};

/** 写死组件默认端口表(镜像 ENGINE_DEFAULT_TELNET_PORTS) */
const ENGINE_PORTS: Array<[string, number]> = [
  ['loginapp', 31000],
  ['dbmgr', 32000],
  ['interfaces', 33000],
  ['logger', 34000],
  ['baseapp', 40000],
  ['cellapp', 50000],
  ['bots', 51000]
];

/** Rust derive_telnet 契约镜像:读 custom 树 telnet_service 段 → 开关 + 派生端口 */
const contractDeriveTelnet = (
  tree: TreeNode | null
): ConfigDeriveResult['derive']['telnet'] => {
  const section = tree ? firstNode(tree, 'telnet_service') : null;
  if (!section) {
    return { enabled: false, endpoints: [] };
  }
  const pick = (name: string): string =>
    section.children.find(c => c.name === name)?.text.trim() ?? '';
  const portText = pick('port');
  const port = /^\d+$/.test(portText) && Number(portText) > 0 ? Number(portText) : undefined;
  const passwordSet = pick('password') !== '';
  const endpoints = port !== undefined
    ? [{ component: 'kbengine.xml', host: '127.0.0.1', port, passwordSet }]
    : ENGINE_PORTS.map(([component, p]) => ({
        component,
        host: '127.0.0.1',
        port: p,
        passwordSet
      }));
  return { enabled: true, endpoints };
};

/** Rust derive_capabilities 契约镜像:def_scan_roots + entry_scripts 直传 + telnet 读树 */
const contractDerive = (
  facts: DeriveFacts,
  tree: TreeNode | null
): ConfigDeriveResult['derive'] => {
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
  return {
    defScanRoots,
    telnet: contractDeriveTelnet(tree),
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
    entryScripts,
    debug: { ready: defScanRoots.roots.length > 0, reasons }
  };
};

const makeGate = (calls: Array<{ method: string; params: unknown }>): KodeCoreGate => {
  return {
    runInRust: async (method: string, params: unknown) => {
      calls.push({ method, params });
      // KODE-CFG-009:派生刷新先走 `$/kode/config/resolve`(core 解析),
      // 按契约回数(镜像语义在 configCoreContract)。
      if (method === '$/kode/config/resolve') {
        const rp = params as { defaultsXml: string | null; customXml: string | null };
        return {
          ok: true as const,
          result: contractResolveResult(rp.defaultsXml, rp.customXml)
        };
      }
      const p = params as { tree?: TreeNode | null; facts?: DeriveFacts };
      const facts: DeriveFacts = p.facts ?? {
        workspaceRoot: null,
        customConfigPath: null,
        entryScripts: []
      };
      return {
        ok: true as const,
        result: {
          derive: contractDerive(facts, p.tree ?? null),
          diagnostics: []
        }
      };
    }
  } as unknown as KodeCoreGate;
};

let calls: Array<{ method: string; params: unknown }> = [];
let roots: string[] = [];

const mk = (prefix: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), `kode-cfg007-${prefix}-`));

const writeFile = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
};

/** 标准夹具:tools 工作区根 + assets 资产根(res/server/kbengine.xml) */
const makeFixture = (prefix: string, xml: string): { ws: string; assets: string } => {
  const ws = mk(prefix);
  roots.push(ws);
  const tools = path.join(ws, 'tools');
  fs.mkdirSync(tools, { recursive: true });
  const assets = path.join(ws, 'assets');
  writeFile(path.join(assets, 'res', 'server', 'kbengine.xml'), xml);
  configurationOverrides.set('kbengine', { assetsRoot: assets });
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(tools), name: 'tools', index: 0 }];
  return { ws, assets };
};

const makeSettings = (partial: Partial<{
  host: string;
  port: number;
  password: string;
  enableCommands: string[];
}> = {}): void => {
  configurationOverrides.set('kbengine', {
    ...configurationOverrides.get('kbengine'),
    ...(partial.host !== undefined ? { 'telnet.host': partial.host } : {}),
    ...(partial.port !== undefined ? { 'telnet.port': partial.port } : {}),
    ...(partial.password !== undefined ? { 'telnet.password': partial.password } : {}),
    ...(partial.enableCommands !== undefined
      ? { 'telnet.enableCommands': partial.enableCommands }
      : {})
  });
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

describe('KODE-CFG-007 telnet 按配置启用', () => {
  it('telnet 段开启(显式端口):目标列表含派生端口,单目标标 kbengine.xml', async () => {
    makeFixture('on-explicit',
      '<root>\n  <baseapp>\n    <telnet_service>\n      <port>40009</port>\n    </telnet_service>\n  </baseapp>\n</root>\n');
    setKodeCoreShadowGate(makeGate(calls));

    await ensureConfigDerivedScanRoot();
    const state = getConfigDerivedScanRootState();

    // TS 读盘送原文,core 解析两棵树(calls[0] 是 resolve 取数调用)。
    const deriveCalls = calls.filter(call => call.method === '$/kode/config/derive');
    const sent = deriveCalls[0].params as { tree: TreeNode | null; defaultsTree: TreeNode | null };
    expect(sent.tree).not.toBeNull();
    expect(sent.defaultsTree).toBeNull();
    // 派生缓存含 telnet 能力(开关 + 派生端口)。
    expect(state?.telnet).toEqual({
      enabled: true,
      endpoints: [{ component: 'kbengine.xml', host: '127.0.0.1', port: 40009, passwordSet: false }]
    });

    const targets = readDerivedTelnetTargets();
    expect(targets).toEqual([
      {
        key: '127.0.0.1:40009',
        label: 'kbengine.xml',
        component: 'kbengine.xml',
        host: '127.0.0.1',
        port: 40009,
        password: '',
        enableCommands: []
      }
    ]);
  });

  it('telnet 段开启(无显式端口):逐组件目标含派生端口(写死表)', async () => {
    makeFixture('on-default', '<root>\n  <telnet_service>\n  </telnet_service>\n</root>\n');
    setKodeCoreShadowGate(makeGate(calls));

    await ensureConfigDerivedScanRoot();
    const state = getConfigDerivedScanRootState();
    expect(state?.telnet.enabled).toBe(true);

    const targets = readDerivedTelnetTargets();
    expect(targets.map(t => [t.component, t.port])).toEqual(ENGINE_PORTS);
  });

  it('telnet 段关闭(无 telnet_service 段):目标列表为空', async () => {
    makeFixture('off',
      '<root>\n  <baseapp>\n    <resPath>scripts</resPath>\n  </baseapp>\n</root>\n');
    setKodeCoreShadowGate(makeGate(calls));

    await ensureConfigDerivedScanRoot();
    const state = getConfigDerivedScanRootState();
    expect(state?.telnet).toEqual({ enabled: false, endpoints: [] });
    expect(readDerivedTelnetTargets()).toEqual([]);
  });

  it('派生不可用(无门):回落旧路径只保留 settings 半(core 不可知不猜配置)', () => {
    makeFixture('fallback',
      '<root>\n  <telnet_service>\n    <port>40009</port>\n  </telnet_service>\n</root>\n');
    // 无门:派生状态不缓存,getter 读不到 → 旧路径。KODE-CFG-009 起旧路径
    // 的配置读值也来自 core(resolve 同走门),门不可用 → 如实空目标,
    // 不再本地解析配置文件(核心唯一解析实现,无双实现残留)。
    const targets = readDerivedTelnetTargets();
    expect(targets).toEqual([]);
  });

  it('密码保护且 settings 未覆盖密码:回落旧路径保留元件 xml 明文密码', async () => {
    makeFixture('password',
      '<root>\n  <telnet_service>\n    <port>40009</port>\n    <password>secret</password>\n  </telnet_service>\n</root>\n');
    setKodeCoreShadowGate(makeGate(calls));

    await ensureConfigDerivedScanRoot();
    const state = getConfigDerivedScanRootState();
    // 派生端点只带 passwordSet 布尔(不回显明文,设计 §5.2 敏感值口径)。
    expect(state?.telnet.endpoints[0]?.passwordSet).toBe(true);

    const targets = readDerivedTelnetTargets();
    // 旧路径读 core 解析态(同一份文件):端口一致,密码取元件 xml 段。
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ port: 40009, password: 'secret' });
  });

  it('settings 显式端口(port>0):走旧路径「自定义目标」,不查派生端点', async () => {
    makeFixture('explicit-settings',
      '<root>\n  <baseapp>\n    <resPath>scripts</resPath>\n  </baseapp>\n</root>\n');
    makeSettings({ port: 41234, password: 'set-pwd' });
    setKodeCoreShadowGate(makeGate(calls));

    await ensureConfigDerivedScanRoot();
    // 派生 enabled=false(无段);显式端口不经派生,旧路径出「自定义目标」。
    expect(getConfigDerivedScanRootState()?.telnet.enabled).toBe(false);
    const targets = readDerivedTelnetTargets();
    expect(targets).toEqual([
      {
        key: '127.0.0.1:41234',
        label: '自定义目标',
        component: '自定义目标',
        host: '127.0.0.1',
        port: 41234,
        password: 'set-pwd',
        enableCommands: []
      }
    ]);
  });

  it('显式 telnet.configXmlPath:派生可用也回旧路径(读该文件,审核发现分叉修复)', async () => {
    const { ws } = makeFixture('explicit-xml',
      '<root>\n  <telnet_service>\n    <port>40009</port>\n  </telnet_service>\n</root>\n');
    // configXmlPath 指向**另一份**元件 xml(端口 47777):旧路径优先读它,
    // 派生半只认 assetsRoot 发现链——若不走旧路径会误报 40009。
    const otherXml = path.join(ws, 'other', 'res', 'server', 'kbengine.xml');
    writeFile(otherXml,
      '<root>\n  <telnet_service>\n    <port>47777</port>\n    <password>x</password>\n  </telnet_service>\n</root>\n');
    configurationOverrides.set('kbengine', {
      ...configurationOverrides.get('kbengine'),
      'telnet.configXmlPath': otherXml
    });
    setKodeCoreShadowGate(makeGate(calls));

    await ensureConfigDerivedScanRoot();
    expect(getConfigDerivedScanRootState()?.telnet.enabled).toBe(true);
    // 旧路径读 core 解析态:显式 configXmlPath 以独立 overrides 取数
    // (生产首取触发重取、下一轮探测即用;测试直接 await 后断言)。
    await ensureConfigResolved({ customXmlPath: otherXml });

    const targets = readDerivedTelnetTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ port: 47777, password: 'x' });
  });

  it('buildDerivedTelnetTargets 纯映射:settings 半覆盖 host/密码/命令白名单', () => {
    const targets = buildDerivedTelnetTargets(
      {
        enabled: true,
        endpoints: [
          { component: 'baseapp', host: '127.0.0.1', port: 40000, passwordSet: false },
          { component: 'cellapp', host: '127.0.0.1', port: 50000, passwordSet: true }
        ]
      },
      { host: ' 192.168.1.5 ', port: 0, password: 'pwd', enableCommands: ['stat'] }
    );
    expect(targets).toEqual([
      {
        key: '192.168.1.5:40000',
        label: 'baseapp',
        component: 'baseapp',
        host: '192.168.1.5',
        port: 40000,
        password: 'pwd',
        enableCommands: ['stat']
      },
      {
        key: '192.168.1.5:50000',
        label: 'cellapp',
        component: 'cellapp',
        host: '192.168.1.5',
        port: 50000,
        password: 'pwd',
        enableCommands: ['stat']
      }
    ]);
    // 关:空目标(批111「defaults 段不当开关」口径)。
    expect(
      buildDerivedTelnetTargets(
        { enabled: false, endpoints: [] },
        { host: '', port: 0, password: '', enableCommands: [] }
      )
    ).toEqual([]);
  });
});
