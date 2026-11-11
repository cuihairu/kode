// KODE-CFG-009 验收:TS 消费通道走 core 解析结果(`$/kode/config/resolve`)——
// 合成树、telnet 速览、数据库连接要素优先来自 core 真源;门接线但无
// serverPath(纯 TS 通用包常态)或 RPC 失败时走 TS 回落(AUDIT-007,
// 2026-11-11 用户令):ok=true + resolver:'ts' 如实标注,四消费面不再降级。
// 门未接线(激活前/停用后)仍为瞬态降级(trees null,定位事实保留)。
//
// 门替身按 dispatch 契约响应(契约真值由 Rust rpc_dispatch + resolve units
// 钉死,回落核与替身同一实现);此处验 TS 接线:原文送达 → core 树消费 →
// 回落/软硬缓存/重解析。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';
import {
  ensureConfigResolved,
  getConfigResolved,
  invalidateConfigResolved,
  resetConfigResolveForTests
} from '../src/serverConfigResolve';
import {
  buildMergedConfigTree,
  resetDatabaseInterfaceConfigCache,
  resolveDatabaseInterfaceConfig
} from '../src/serverConfigMerge';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { bumpRootConfigGeneration } from '../src/rootConfigGeneration';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';

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

  it('RPC 失败走 TS 回落:ok=true resolver=ts、回落核出树与 dbInterface、硬缓存', async () => {
    installFakeGate(false);
    await ensureConfigResolved();
    const state = getConfigResolved();
    expect(state?.ok).toBe(true);
    expect(state?.resolver).toBe('ts');
    expect(state?.reason).toBe('resolve unavailable');
    // 回落核产物 = 磁盘原文镜像解析(entryScriptFile 是 local 值,判别非 core)。
    // 定位:伪根一层直挂段与 <root> 包裹二层都找(merge 后 defaults 侧整段
    // <root> 包裹保留在前、custom 侧 flat baseapp 追加在后,两层并存)
    const baseapp =
      state?.merged?.children.find(c => c.name === 'baseapp') ??
      state?.merged?.children.find(c => c.name === 'root')?.children.find(c => c.name === 'baseapp');
    const leaf = baseapp?.children.find(c => c.name === 'entryScriptFile');
    expect(leaf?.text).toBe('local-parsed-entry');
    expect(buildMergedConfigTree().merged).not.toBeNull();
    // fixture 无 dbmgr 段:镜像 Rust 语义 dbInterface=null(如实无数据库配置)
    expect(resolveDatabaseInterfaceConfig()).toBeNull();
    // 定位事实是 TS 侧职责,回落时保留(configDerive facts 依赖)
    expect(state?.customPath).toBe(path.join(root, 'kbengine.xml'));
    expect(state?.defaultsPath).toBe(
      path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml')
    );
    // 硬缓存:同代同指纹不再重锤坏 server(重试待代/指纹前进)
    await ensureConfigResolved();
    expect(calls).toHaveLength(1);
    bumpRootConfigGeneration('test');
    await ensureConfigResolved();
    expect(calls).toHaveLength(2);
  });

  it('无 serverPath 走 TS 回落并软缓存:每次 ensure 重试 Rust,接线后即被 Rust 态替换', async () => {
    setKodeCoreShadowGate({
      runInRust: async (_method: string, params: unknown) => {
        const typed = params as { defaultsXml: string | null; customXml: string | null };
        calls.push({ method: '$/kode/config/resolve', params: typed });
        return { ok: false as const, reason: 'no serverPath' };
      }
    } as unknown as KodeCoreGate);
    let state = await ensureConfigResolved();
    expect(state.ok).toBe(true);
    expect(state.resolver).toBe('ts');
    expect(state.reason).toBe('no serverPath');
    expect(state.merged).not.toBeNull();
    // 同步消费面可读(软缓存已落槽)
    expect(getConfigResolved()?.resolver).toBe('ts');
    // 软缓存:同代同指纹第二次 ensure 仍重试 Rust(零成本探测)
    await ensureConfigResolved();
    expect(calls).toHaveLength(2);
    // 接线后:下一次 ensure 即被 Rust 态替换
    installFakeGate(true);
    state = await ensureConfigResolved();
    expect(state.resolver).toBe('rust');
    expect(state.reason).toBeUndefined();
    await ensureConfigResolved();
    expect(calls).toHaveLength(3); // Rust 态硬缓存,不再探测
  });

  it('门未接线仍为瞬态降级:ok=false 产物全空,定位事实保留,不缓存', async () => {
    const state = await ensureConfigResolved();
    expect(state.ok).toBe(false);
    expect(state.reason).toBe('gate unavailable');
    expect(state.merged).toBeNull();
    expect(state.resolver).toBeUndefined();
    expect(state.customPath).toBe(path.join(root, 'kbengine.xml'));
    expect(state.defaultsPath).toBe(
      path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml')
    );
    // 瞬态不落槽:同步缓存读不到
    expect(getConfigResolved()).toBeNull();
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

  it('配置落盘后同键重取不复用旧在途请求;慢旧回包不覆盖新槽(审核席 P1)', async () => {
    // 红:在途按 overridesKey 单键共享时,同键第二发(新指纹)会拿到旧 RPC
    // 的 promise,变更后的立即重取返回旧配置;且慢旧回包晚落槽覆盖新产物。
    let releaseFirst: (() => void) | null = null;
    let rpcCount = 0;
    setKodeCoreShadowGate({
      runInRust: async (_method: string, params: unknown) => {
        rpcCount += 1;
        const seq = rpcCount;
        if (seq === 1) {
          await new Promise<void>(resolve => {
            releaseFirst = resolve;
          });
        }
        const typed = params as { defaultsXml: string | null; customXml: string | null };
        const entry = typed.defaultsXml?.includes('changed-entry') ?? false;
        const tree = {
          name: 'root',
          text: '',
          children: [
            {
              name: 'baseapp',
              text: '',
              children: [
                { name: 'entryScriptFile', text: entry ? 'changed-entry' : 'first-entry', children: [] }
              ]
            }
          ]
        };
        return {
          ok: true as const,
          result: {
            defaultsTree: tree,
            customTree: typed.customXml !== null ? tree : null,
            merged: typed.defaultsXml !== null ? tree : null,
            telnetSummary: [{ component: 'baseapp', port: 40000 + seq, password: null }],
            telnetDefaultPorts: { baseapp: 40000 },
            customTelnet: null,
            dbInterface: { ...CORE_DB, port: 3306 + seq }
          }
        };
      }
    } as unknown as KodeCoreGate);

    const first = ensureConfigResolved();
    // 等第一发真正进入在途(gate 已挂起)
    await new Promise(resolve => setTimeout(resolve, 0));
    // 配置落盘:指纹(size:mtimeMs)前进
    fs.writeFileSync(
      path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml'),
      '<root><baseapp><entryScriptFile>changed-entry</entryScriptFile></baseapp></root>'
    );
    const second = await ensureConfigResolved();
    // 新指纹 → 新在途新 RPC,不得复用旧 promise
    expect(rpcCount).toBe(2);
    expect(second.dbInterface?.port).toBe(3306 + 2);

    // 旧回包晚到:落槽前复核指纹 → 不覆盖新槽
    releaseFirst!();
    await first;
    const slot = getConfigResolved();
    expect(slot?.dbInterface?.port).toBe(3306 + 2);
    expect(slot?.merged?.children[0]?.children[0]?.text).toBe('changed-entry');
  });

  it('定位结果从无到有(创建元件配置)时旧在途回包不覆盖新槽(审核席残余 P1)', async () => {
    // 红:守卫只复核发起时路径的指纹——旧请求 customPath=null 时指纹恒空,
    // 创建 kbengine.xml + invalidate 后,旧成功/失败回包仍会覆盖新槽。
    let releaseFirst: (() => void) | null = null;
    let rpcCount = 0;
    setKodeCoreShadowGate({
      runInRust: async (_method: string, params: unknown) => {
        rpcCount += 1;
        const seq = rpcCount;
        if (seq === 1) {
          await new Promise<void>(resolve => {
            releaseFirst = resolve;
          });
        }
        const typed = params as { defaultsXml: string | null; customXml: string | null };
        return {
          ok: true as const,
          result: {
            defaultsTree: typed.defaultsXml !== null ? CORE_MERGED : null,
            customTree: typed.customXml !== null ? CORE_MERGED : null,
            merged: typed.defaultsXml !== null ? CORE_MERGED : null,
            telnetSummary: [],
            telnetDefaultPorts: { baseapp: 40000 },
            customTelnet: null,
            dbInterface: { ...CORE_DB, port: 3306 + seq }
          }
        };
      }
    } as unknown as KodeCoreGate);

    // 删掉元件配置:第一发在 customPath=null 的定位事实下进入在途
    fs.unlinkSync(path.join(root, 'kbengine.xml'));
    const first = ensureConfigResolved();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(first).toBeDefined();

    // 创建元件配置 + 失效(镜像 watcher 落盘联动面)
    fs.writeFileSync(path.join(root, 'kbengine.xml'), '<baseapp><entryScriptFile>x</entryScriptFile></baseapp>');
    invalidateConfigResolved();
    const second = await ensureConfigResolved();
    expect(second.customPath).toBe(path.join(root, 'kbengine.xml'));
    expect(second.dbInterface?.port).toBe(3306 + 2);

    // 旧回包(customPath=null,指纹空串)释放:不得覆盖新槽
    releaseFirst!();
    await first;
    const slot = getConfigResolved();
    expect(slot?.customPath).toBe(path.join(root, 'kbengine.xml'));
    expect(slot?.dbInterface?.port).toBe(3306 + 2);
  });

  it('在途期间失效(指纹不变)后,紧随 ensure 不复用注定不落槽的旧在途(审核席三审残余 P1)', async () => {
    // 红:在途键不含 epoch 且 invalidate 不清在途——无关 kbengine*.xml 事件
    // 在请求期间失效后,同键同指纹的紧随 ensure 复用旧 promise,而旧回包又因
    // epoch 被拒落槽 → 缓存持续为空。
    let releaseFirst: (() => void) | null = null;
    let rpcCount = 0;
    setKodeCoreShadowGate({
      runInRust: async (_method: string, params: unknown) => {
        rpcCount += 1;
        const seq = rpcCount;
        if (seq === 1) {
          await new Promise<void>(resolve => {
            releaseFirst = resolve;
          });
        }
        const typed = params as { defaultsXml: string | null; customXml: string | null };
        return {
          ok: true as const,
          result: {
            defaultsTree: typed.defaultsXml !== null ? CORE_MERGED : null,
            customTree: typed.customXml !== null ? CORE_MERGED : null,
            merged: typed.defaultsXml !== null ? CORE_MERGED : null,
            telnetSummary: [],
            telnetDefaultPorts: { baseapp: 40000 },
            customTelnet: null,
            dbInterface: { ...CORE_DB, port: 3306 + seq }
          }
        };
      }
    } as unknown as KodeCoreGate);

    const first = ensureConfigResolved();
    await new Promise(resolve => setTimeout(resolve, 0));
    // 无关失效(指纹不变,镜像 watcher 对别的 kbengine*.xml 事件失效)
    invalidateConfigResolved();
    const second = await ensureConfigResolved();
    // 新在途新 RPC:不复用注定不落槽的旧 promise
    expect(rpcCount).toBe(2);
    expect(second.dbInterface?.port).toBe(3306 + 2);

    releaseFirst!();
    await first;
    expect(getConfigResolved()?.dbInterface?.port).toBe(3306 + 2);
  });
});
