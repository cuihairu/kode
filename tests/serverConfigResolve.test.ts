// KODE-CFG-009 验收:TS 消费通道全改走 core 解析结果(`$/kode/config/resolve`),
// 旧 parseConfigXml/mergeConfigXml 本地解析实现下线——合成树、telnet 速览、
// 数据库连接要素都来自 core 单一真源;RPC 失败/门未接线 → 如实降级(trees
// 为 null,定位事实 customPath/defaultsPath 保留),不回退本地解析。
//
// 门替身按 dispatch 契约响应(契约真值由 Rust rpc_dispatch + resolve units
// 钉死,此处只验 TS 接线:原文送达 → core 树消费 → 缓存/降级/重解析)。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';
import {
  ensureConfigResolved,
  getConfigResolved,
  resetConfigResolveForTests
} from '../src/serverConfigResolve';
import {
  buildMergedConfigTree,
  resetDatabaseInterfaceConfigCache,
  resolveDatabaseInterfaceConfig
} from '../src/serverConfigMerge';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
import { bumpRootConfigGeneration } from '../src/rootConfigGeneration';
import type { KodeCoreGate } from '../src/kodeCoreGate';

interface Calls {
  method: string;
  params: { defaultsXml: string | null; customXml: string | null };
}

/** core 侧返回的合成树(磁盘原文若被本地解析,值会不同——判别实现归属) */
const CORE_MERGED = {
  name: '',
  text: '',
  children: [
    {
      name: 'baseapp',
      text: '',
      children: [{ name: 'entryScriptFile', text: 'core-parsed-entry', children: [] }]
    }
  ]
};

const CORE_SUMMARY = [
  { component: 'baseapp', port: 40001, password: 'corepwd' },
  { component: 'loginapp', port: 31000, password: null }
];

const CORE_DB = {
  host: '10.0.0.9',
  port: 3307,
  username: 'kbe',
  databaseName: 'kbe',
  encrypt: true,
  characterSet: 'utf8mb4'
};

let calls: Calls[] = [];

function installFakeGate(ok: boolean): void {
  setKodeCoreShadowGate({
    runInRust: async (_method: string, params: unknown) => {
      const typed = params as { defaultsXml: string | null; customXml: string | null };
      calls.push({ method: '$/kode/config/resolve', params: typed });
      if (!ok) {
        return { ok: false as const, reason: 'resolve unavailable' };
      }
      return {
        ok: true as const,
        result: {
          defaultsTree: CORE_MERGED,
          customTree: CORE_MERGED,
          merged: CORE_MERGED,
          telnetSummary: CORE_SUMMARY,
          dbInterface: CORE_DB
        }
      };
    }
  } as unknown as KodeCoreGate);
}

describe('KODE-CFG-009 消费通道走 core 解析', () => {
  let root: string;

  beforeEach(() => {
    resetConfigResolveForTests();
    resetDatabaseInterfaceConfigCache();
    calls = [];
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cfg009-'));
    // 引擎 defaults 按装载口径:<root>/kbe/res/server/kbengine_defaults.xml,
    // binPath 指向 <root>/kbe/bin/server 才能推导出该路径。
    fs.mkdirSync(path.join(root, 'kbe', 'res', 'server'), { recursive: true });
    // 磁盘原文若是本地解析,entryScriptFile 会是 local-parsed-entry——
    // 断言 core 值即判定消费走 core(红:旧实现本地解析返回 local 值)。
    fs.writeFileSync(
      path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml'),
      '<root><baseapp><entryScriptFile>local-parsed-entry</entryScriptFile></baseapp></root>'
    );
    fs.writeFileSync(
      path.join(root, 'kbengine.xml'),
      '<baseapp><entryScriptFile>local-parsed-entry</entryScriptFile></baseapp>'
    );
    configurationOverrides.set('kbengine', { binPath: path.join(root, 'kbe', 'bin', 'server') });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'cfg009', index: 0 }];
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    configurationOverrides.clear();
    stubWorkspace.workspaceFolders = [];
    setKodeCoreShadowGate(null);
  });

  it('buildMergedConfigTree 消费 core 合成树(非本地解析)', async () => {
    installFakeGate(true);
    await ensureConfigResolved();
    // 原文送达 core(TS 只读盘,不解析)
    expect(calls).toHaveLength(1);
    expect(calls[0].params.defaultsXml).toContain('<root>');
    expect(calls[0].params.customXml).toContain('local-parsed-entry');
    // 消费的是 core 合成树:值 = core 值,不是磁盘本地解析值
    const merged = buildMergedConfigTree().merged;
    const leaf = merged?.children[0]?.children.find(c => c.name === 'entryScriptFile');
    expect(leaf?.text).toBe('core-parsed-entry');
  });

  it('telnet 速览与数据库连接要素同样来自 core', async () => {
    installFakeGate(true);
    await ensureConfigResolved();
    expect(getConfigResolved()?.telnetSummary).toEqual(CORE_SUMMARY);
    expect(resolveDatabaseInterfaceConfig()).toEqual(CORE_DB);
  });

  it('RPC 失败如实降级:树为 null、定位事实保留、不回退本地解析', async () => {
    installFakeGate(false);
    await ensureConfigResolved();
    const state = getConfigResolved();
    expect(state?.ok).toBe(false);
    expect(state?.merged).toBeNull();
    expect(buildMergedConfigTree().merged).toBeNull();
    expect(resolveDatabaseInterfaceConfig()).toBeNull();
    // 定位事实是 TS 侧职责,降级时保留(configDerive facts 依赖)
    expect(state?.customPath).toBe(path.join(root, 'kbengine.xml'));
    expect(state?.defaultsPath).toBe(
      path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml')
    );
  });

  it('按 generation 缓存:bump 后才重新 resolve', async () => {
    installFakeGate(true);
    await ensureConfigResolved();
    await ensureConfigResolved();
    expect(calls).toHaveLength(1);
    bumpRootConfigGeneration('test');
    await ensureConfigResolved();
    expect(calls).toHaveLength(2);
  });
});
