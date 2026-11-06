// KODE-CFG-005:def 扫描根按配置派生(CFG-004 推导链的消费端)。
//
// 经**命令级** `gate.runInRust('$/kode/config/derive')` 取 Rust 推导出的
// 派生能力(def 扫描根/入口脚本/telnet/调试就绪)。与 serving 面开关正交:
// 不动 `serveFromRust`(恒 false)、不依赖 `kbengine.core.backend`,params
// 由本模块直传(配置路径/工作区根/入口脚本事实,已从盘上解析)。
//
// 单一真源在 Rust core(TS 不复制推导逻辑);RPC 失败/降级 → 本模块如实
// 记录状态并回退旧 workspace∪assetsRoot 链(消费端 getIndexScanRoots 在
// 派生不可用时自然走旧链,不抛)。缓存按 rootConfigGeneration 键控:根
// 配置变化 bump 后下一次 ensure 重取;同步消费面只读缓存(不阻塞宿主)。
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findEngineEntryScript } from './debugpyWaitAtStartup';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import { getRootConfigGeneration } from './rootConfigGeneration';
import { buildConfigTreePair } from './serverConfigMerge';
import { expandWorkspacePlaceholders } from './workspacePath';

/** `$/kode/config/derive` 的 `{ derive, diagnostics }` 结果(镜像 Rust 序列化) */
export interface ConfigDeriveResult {
  derive: {
    defScanRoots: {
      roots: string[];
      fallback: string | null;
      degraded: boolean;
    };
    telnet: {
      enabled: boolean;
      endpoints: Array<{
        component: string;
        host: string;
        port: number;
        passwordSet: boolean;
      }>;
    };
    /** CLONE-P5 骨架:Rust 派生数据库连接档案(明文密码不回传) */
    database: {
      available: boolean;
      dbType: string;
      host: string;
      port: number;
      username: string;
      databaseName: string;
      characterSet: string;
      encrypt: boolean;
      passwordAvailable: boolean;
    };
    entryScripts: Array<{
      process: string;
      module: string;
      path: string | null;
      exists: boolean;
    }>;
    debug: {
      ready: boolean;
      reasons: string[];
    };
  };
  diagnostics: Array<{ scope: string; severity: string; message: string }>;
}

/** 派生缓存状态(消费面读 + 测试面断言) */
export interface ConfigDerivedScanRootState {
  generation: number;
  roots: string[];
  fallback: string | null;
  degraded: boolean;
  diagnostics: Array<{ scope: string; severity: string; message: string }>;
  /** 派生入口脚本事实(CFG-006 断点预填面读;= facts 直传,真源在 Rust) */
  entryScripts: Array<{
    process: string;
    module: string;
    path: string | null;
    exists: boolean;
  }>;
  /** 派生调试就绪(CFG-006 读 reasons 出缺入口诊断) */
  debug: { ready: boolean; reasons: string[] };
  /**
   * 派生 telnet 能力(CFG-007 目标列表读):段开关 + 逐组件派生端口,
   * 真源在 Rust derive_telnet(core 不碰盘,两棵配置树由 refresh 读盘
   * 解析后送达)。派生不可用/失败时为 enabled:false 空端点(如实降级,
   * 消费端 telnetDeriveTargets 回退旧路径)。
   */
  telnet: {
    enabled: boolean;
    endpoints: Array<{
      component: string;
      host: string;
      port: number;
      passwordSet: boolean;
    }>;
  };
  /**
   * 派生数据库连接档案(CLONE-P5 骨架,「玩家数据」只读面板读):连接要素
   * 真源在 Rust derive_database(engine config 两棵树);密码不回传值——
   * passwordAvailable 仅标记 encrypt=false 明文可连,明文由连接面读同
   * 一份引擎配置(serverConfigMerge),派生不可用时 available:false。
   */
  database: {
    available: boolean;
    dbType: string;
    host: string;
    port: number;
    username: string;
    databaseName: string;
    characterSet: string;
    encrypt: boolean;
    passwordAvailable: boolean;
  };
  /** RPC 调用是否成功(失败=该代仅一次尝试,回退旧链,不再锤 Rust) */
  ok: boolean;
  reason: string | null;
}

let cached: ConfigDerivedScanRootState | null = null;
let inflight: Promise<ConfigDerivedScanRootState> | null = null;

/** 派生不可用时的数据库档案占位(available:false,叶子留空如实降级) */
const DATABASE_PROFILE_UNAVAILABLE: ConfigDerivedScanRootState['database'] = {
  available: false,
  dbType: '',
  host: '',
  port: 0,
  username: '',
  databaseName: '',
  characterSet: '',
  encrypt: true,
  passwordAvailable: false
};

/** 同步读派生扫描根(仅取有效非降级且目录存在的第一个);不可用 → null(旧链兜底) */
export function getConfigDerivedScanRoot(): string | null {
  const state = currentState();
  if (!state || state.degraded || !state.ok) {
    return null;
  }
  for (const root of state.roots) {
    if (root && isDirectory(root)) {
      return root;
    }
  }
  return null;
}

/** 当前代缓存状态;代不匹配(根配置已变未刷新)/从未取过 → null */
export function getConfigDerivedScanRootState(): ConfigDerivedScanRootState | null {
  return currentState();
}

/**
 * 派生数据库连接档案(CLONE-P5 骨架,只读):仅派生成功(available)时给出,
 * 供「玩家数据」面板与只读查询命令消费;不可用 → null(调用方如实降级,
 * 不虚构连接)。明文密码不在此面——连接期经 serverConfigMerge 就地读取。
 */
export function getDerivedDatabaseProfile(): ConfigDerivedScanRootState['database'] | null {
  const state = currentState();
  if (!state || !state.ok || !state.database.available) {
    return null;
  }
  return state.database;
}

function currentState(): ConfigDerivedScanRootState | null {
  if (!cached || cached.generation !== getRootConfigGeneration()) {
    return null;
  }
  return cached;
}

/**
 * 刷新派生扫描根(幂等:同代已就绪直接返回;并发共享单次在途)。
 * 由扫描入口(async 面)在 getIndexScanRoots 之前 await,保证该次扫描
 * 用上派生结果;同步消费面(如 getScanRootForFile)在未刷新时读旧链兜底。
 */
export async function ensureConfigDerivedScanRoot(): Promise<ConfigDerivedScanRootState> {
  const generation = getRootConfigGeneration();
  const current = currentState();
  if (current) {
    return current;
  }
  if (inflight) {
    return inflight;
  }
  inflight = refresh(generation).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function refresh(generation: number): Promise<ConfigDerivedScanRootState> {
  const workspaceRoot = firstWorkspaceRoot();
  // 配置树对(CFG-007):custom/defaults 两棵树 TS 读盘解析后送达 Rust
  // (core 不碰盘,设计 §5.2);customPath 同时作为 facts 的配置路径,
  // 单次探测不各读各的。
  let pair: ReturnType<typeof buildConfigTreePair>;
  try {
    pair = buildConfigTreePair();
  } catch {
    pair = { customTree: null, defaultsTree: null, customPath: null, defaultsPath: null };
  }
  const entryScripts = resolveEntryScriptFacts(workspaceRoot);

  const gate = getKodeCoreShadowGate();
  if (!gate) {
    // 门未接线(激活前/停用后):瞬态,不缓存——下一 ensure 重试;消费面
    // 此时走旧链兜底。生产上激活即接线,扫描恒在接线后,此支仅防御。
    return {
      generation,
      roots: [],
      fallback: null,
      degraded: true,
      diagnostics: [],
      entryScripts,
      debug: { ready: false, reasons: ['gate unavailable'] },
      telnet: { enabled: false, endpoints: [] },
      database: DATABASE_PROFILE_UNAVAILABLE,
      ok: false,
      reason: 'gate unavailable'
    };
  }
  const outcome = await gate.runInRust<ConfigDeriveResult>('$/kode/config/derive', {
    tree: pair.customTree,
    defaultsTree: pair.defaultsTree,
    facts: {
      workspaceRoot: workspaceRoot || null,
      customConfigPath: pair.customPath,
      entryScripts
    }
  });

  if (!outcome.ok) {
    // RPC 失败:该代仅一次尝试(不锤宕机 server),如实记录降级状态供
    // 诊断面读,消费面回退旧链。
    cached = {
      generation,
      roots: [],
      fallback: null,
      degraded: true,
      diagnostics: [
        { scope: 'rpc', severity: 'warning', message: outcome.reason }
      ],
      entryScripts,
      debug: { ready: false, reasons: [outcome.reason] },
      telnet: { enabled: false, endpoints: [] },
      database: DATABASE_PROFILE_UNAVAILABLE,
      ok: false,
      reason: outcome.reason
    };
    return cached;
  }

  const derive = outcome.result.derive;
  cached = {
    generation,
    roots: derive.defScanRoots.roots,
    fallback: derive.defScanRoots.fallback,
    degraded: derive.defScanRoots.degraded,
    diagnostics: outcome.result.diagnostics,
    entryScripts: derive.entryScripts,
    debug: derive.debug,
    telnet: derive.telnet,
    database: derive.database,
    ok: true,
    reason: null
  };
  return cached;
}

/**
 * 解析 entryScriptFile 事实(CFG-006):与启动面同约定——配置 assetsRoot
 * (含 `${workspaceFolder}`/相对值展开),经 findEngineEntryScript 解析共享
 * 入口脚本 kbengine.py。profile/发现分支属高级形态,此处走标准配置路径;
 * 未解析到 → exists:false 如实上报(派生给「entry script missing」诊断,
 * 消费端不预填、不崩)。单一事实(baseapp/kbengine):入口脚本各组件共用,
 * 重复 7 份只会产生重复诊断噪音。
 */
function resolveEntryScriptFacts(workspaceRoot: string): ConfigDeriveResult['derive']['entryScripts'] {
  let assetsRoot = '';
  try {
    const raw = (vscode.workspace.getConfiguration('kbengine').get<string>('assetsRoot', '') ?? '').trim();
    // 审核发现:此前只手工展开 ${workspaceFolder},assetsRoot 用 ${env:...}
    // 时解析到错路径 → 误报「entry script missing」且断点预填失效。改走
    // expandWorkspacePlaceholders(与 serverManager.getBinPath 同口径,支持
    // ${workspaceFolder}/${env:};未解析落空串的既有约定不变)。
    const expanded = expandWorkspacePlaceholders(raw, workspaceRoot || undefined);
    assetsRoot = expanded
      ? path.isAbsolute(expanded)
        ? path.resolve(expanded)
        : workspaceRoot
          ? path.resolve(workspaceRoot, expanded)
          : ''
      : '';
  } catch {
    assetsRoot = '';
  }
  const entryPath = assetsRoot ? findEngineEntryScript(assetsRoot) : null;
  return [
    {
      process: 'baseapp',
      module: 'kbengine',
      path: entryPath,
      exists: !!entryPath
    }
  ];
}

function firstWorkspaceRoot(): string {
  try {
    return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? '';
  } catch {
    return '';
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 测试面:清缓存(下一 ensure 重取;不 bump generation,由测试自控) */
export function resetConfigDerivedScanRootForTests(): void {
  cached = null;
  inflight = null;
}
