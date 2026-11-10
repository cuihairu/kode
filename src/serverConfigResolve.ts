// KODE-CFG-009:配置消费通道(`$/kode/config/resolve`)。
//
// TS 只做「定位 + 读盘 + 送达」:defaults/元件 kbengine.xml 的定位与读取
// 留在 TS(设计 §6.2:location/cache/watching 不迁),解析/合并/telnet 速览/
// 数据库连接要素全部由 Rust core 经 `$/kode/config/resolve` 一次出全——
// 旧 TS parseConfigXml/mergeConfigXml/summarizeFinalTelnet/
// extractDatabaseInterfaceConfig 同步下线(设计 §6.1 step 3),core 是唯一
// 解析实现。
//
// 缓存口径与 configDerive 同款(IDE-SNP-010 generation 键控 + 单次在途):
// 同代且两份文件 stat 指纹未变 → 直接回缓存;generation bump 或文件变化
// → 重新 resolve。RPC 失败/门未接线 → 如实降级(ok=false,trees 全 null,
// 定位事实 customPath/defaultsPath 保留——configDerive facts 与消费端
// 「引擎不可知」路径依赖),绝不回退本地解析。

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import { getRootConfigGeneration } from './rootConfigGeneration';
import { expandWorkspacePlaceholders } from './workspacePath';
import { resolveDiscoveredConfigRoot, resolveKbeSourceRoot } from './workspaceDiscovery';
import type { ConfigXmlNode } from './serverConfigMerge';

/** core `telnetSummary` 条目(端口数字非法/密码空 → null,core 裁定) */
export interface CoreTelnetSummaryEntry {
  component: string;
  port: number | null;
  password: string | null;
}

/** core `customTelnet` 产物(元件配置 telnet_service 段读值;None → null) */
export interface CoreCustomTelnet {
  port: number | null;
  password: string | null;
}

/** core `dbInterface` 产物(镜像 serverConfigMerge.DatabaseInterfaceConfig) */
export interface CoreDatabaseInterfaceConfig {
  host: string;
  port: number;
  username: string;
  databaseName: string;
  /** true = 密码经引擎 RSA 加密,kode 不读不解读 */
  encrypt: boolean;
  characterSet: string;
  /** 明文密码(仅 encrypt=false 时由 core 提取) */
  plainPassword?: string;
}

/** `$/kode/config/resolve` 消费态(定位事实 + core 解析产物) */
export interface ConfigResolvedState {
  /** false = RPC 失败/门未接线:core 产物全空,定位事实仍在 */
  ok: boolean;
  generation: number;
  customTree: ConfigXmlNode | null;
  defaultsTree: ConfigXmlNode | null;
  customPath: string | null;
  defaultsPath: string | null;
  merged: ConfigXmlNode | null;
  telnetSummary: CoreTelnetSummaryEntry[];
  /** 引擎写死端口表(core 唯一真源;TS 常量表已删) */
  telnetDefaultPorts: Record<string, number>;
  /** 元件配置 telnet_service 段读值(无段 → null) */
  customTelnet: CoreCustomTelnet | null;
  dbInterface: CoreDatabaseInterfaceConfig | null;
  /** ok=false 时的降级原因(观测面) */
  reason?: string;
}

/**
 * 元件 kbengine.xml 定位(serverConfigMerge 原实现整体迁入,core 不碰盘):
 * kbengine.assetsRoot 下的 kbengine.xml 优先,再按约定路径探测工作区根。
 * 取第一个存在的文件。profile 资产根给定时只在其下找,绝不混工作区/设置链。
 */
export function resolveCustomConfigXmlPath(
  workspaceRoot: string | undefined,
  overrideRoot?: string
): string | null {
  const readOk = (candidate: string): boolean => {
    try {
      fs.readFileSync(candidate, 'utf8');
      return true;
    } catch {
      return false;
    }
  };
  if (overrideRoot !== undefined) {
    // profile 面的元件配置只认 profile 自己的资产根:找不到 = 该 profile
    // 无元件配置(纯 defaults),不回落别处——回落即读到别的项目的配置
    const candidates = [
      path.join(overrideRoot, 'kbengine.xml'),
      path.join(overrideRoot, 'res', 'server', 'kbengine.xml')
    ];
    for (const candidate of candidates) {
      if (readOk(candidate)) {
        return candidate;
      }
    }
    return null;
  }
  const config = vscode.workspace.getConfiguration('kbengine');
  const settingPath = expandWorkspacePlaceholders(
    config.get<string>('assetsRoot', ''),
    workspaceRoot
  );
  // 设置自身候选(直接文件与装载口径位置)之后,发现出的资产根参与探测,
  // 最后才是工作区根约定。设置下的直接文件仍是第一优先(批112 契约)
  const discovered = workspaceRoot ? resolveDiscoveredConfigRoot(workspaceRoot) : null;
  const candidates: string[] = [];
  if (settingPath.length > 0) {
    candidates.push(
      path.join(settingPath, 'kbengine.xml'),
      path.join(settingPath, 'res', 'server', 'kbengine.xml')
    );
  }
  if (discovered && discovered !== settingPath) {
    candidates.push(
      path.join(discovered, 'kbengine.xml'),
      path.join(discovered, 'res', 'server', 'kbengine.xml')
    );
  }
  if (workspaceRoot) {
    candidates.push(
      ...['kbengine.xml', 'res/server/kbengine.xml', 'assets/res/server/kbengine.xml'].map(
        relative => path.join(workspaceRoot, relative)
      )
    );
  }
  for (const candidate of candidates) {
    if (readOk(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** 装载轴覆盖(IDE-REV-015,同 serverConfigMerge.MergedConfigTreeOverrides) */
export interface ConfigResolveOverrides {
  binPath?: string;
  configRoot?: string;
  /** 显式元件配置路径(telnet.configXmlPath;给定时替换标准发现链读它) */
  customXmlPath?: string;
}

/** 定位 defaults + 元件 kbengine.xml 并读盘原文(TS 唯一职责面) */
function locateAndRead(
  overrides: ConfigResolveOverrides
): { defaultsXml: string | null; customXml: string | null; defaultsPath: string | null; customPath: string | null } {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const overridesBinPath = overrides.binPath !== undefined && overrides.binPath.length > 0
    ? overrides.binPath
    : undefined;
  const binPath = overridesBinPath
    ?? expandWorkspacePlaceholders(
      vscode.workspace.getConfiguration('kbengine').get<string>('binPath', ''),
      workspaceRoot
    );
  // binPath 未配/推导不出时,用引擎源码根锚点兜底再推 defaults;profile
  // 覆盖轴不走发现链(profile 的根读不到 defaults = 如实无 defaults)
  let defaultsPath = deriveEngineDefaultsXmlPath(binPath);
  if (!defaultsPath && !overridesBinPath && workspaceRoot) {
    const kbeSourceRoot = resolveKbeSourceRoot(workspaceRoot);
    if (kbeSourceRoot) {
      defaultsPath = deriveEngineDefaultsXmlPath(path.join(kbeSourceRoot, 'bin', 'server'));
    }
  }
  let defaultsXml: string | null = null;
  if (defaultsPath) {
    try {
      defaultsXml = fs.readFileSync(defaultsPath, 'utf8');
    } catch {
      defaultsXml = null;
    }
  }
  const overridesConfigRoot = overrides.configRoot !== undefined && overrides.configRoot.length > 0
    ? overrides.configRoot
    : undefined;
  // 显式 configXmlPath(KODE-CFG-009:旧路径优先读该文件的语义保留——core
  // 解析的是这份文件,派生半只认标准发现链,两半不分会误报标准文件端口)
  const explicitCustomXmlPath = overrides.customXmlPath;
  const customPath = explicitCustomXmlPath !== undefined
    ? explicitCustomXmlPath
    : overridesConfigRoot !== undefined
      ? resolveCustomConfigXmlPath(workspaceRoot, overridesConfigRoot)
      : resolveCustomConfigXmlPath(workspaceRoot);
  let customXml: string | null = null;
  if (customPath) {
    // 不可达(批112 定性):customPath 刚经 resolveCustomConfigXmlPath 以同
    // 参数试读通过,同一 tick 内二次读盘不可能由可读转为不可读;catch 为
    // 防御臂,忽略。
    /* istanbul ignore start */
    try {
      customXml = fs.readFileSync(customPath, 'utf8');
    } catch {
      customXml = null;
    }
    /* istanbul ignore stop */
  }
  return { defaultsXml, customXml, defaultsPath, customPath };
}

/** 文件 stat 指纹(同代内容变化也触发重 resolve;stat 不可得记空串) */
function fingerprint(p: string | null): string {
  if (!p) {
    return '';
  }
  try {
    const stat = fs.statSync(p);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

interface CacheSlot extends ConfigResolvedState {
  overridesKey: string;
  fingerprint: string;
}

/**
 * 消费缓存按 overridesKey 分槽(单槽会在多消费键并存时互踢:激活预取 ''、
 * telnet 探测 {customXmlPath}、命令面 profile 根组合三者并存,后写者把先写
 * 者挤掉,同步读缓存的探测面每轮落空——telnet 状态灯随任意命令执行闪烁
 * 消失)。槽数有界(FIFO 逐出),profile 根组合数量级远低于上限。
 */
const RESOLVE_CACHE_SLOTS = 8;
const cacheSlots = new Map<string, CacheSlot>();
const inflights = new Map<string, Promise<ConfigResolvedState>>();
/** 失效版本边界:每次 invalidate 自增,落槽守卫据此拒绝旧在途回包
 * (覆盖「定位结果本身变化」——旧请求发起时 customPath=null、之后元件配置
 * 被创建的并发:旧回包对 null 路径的指纹恒空,仅靠指纹/generation 拦不住) */
let invalidationEpoch = 0;

const overridesKeyOf = (overrides: ConfigResolveOverrides): string =>
  `${overrides.binPath ?? ''}\n${overrides.configRoot ?? ''}\n${overrides.customXmlPath ?? ''}`;

/** 测试面:清缓存与在途 */
export function resetConfigResolveForTests(): void {
  cacheSlots.clear();
  inflights.clear();
  invalidationEpoch += 1;
}

/** 失效消费态(配置落盘/设置变化点调用):下一次 ensure 强制重取 core。
 * 同时清空在途:失效是版本边界,边界前的在途回包注定被落槽守卫拒绝——
 * 若不清,同键同指纹的紧随 ensure 会复用旧 promise、拿到注定不落槽的回包,
 * 缓存持续为空(审核席三审残余 P1) */
export function invalidateConfigResolved(): void {
  cacheSlots.clear();
  inflights.clear();
  invalidationEpoch += 1;
}

/** 同步读缓存(未就绪 → null;消费端如实按「core 不可知」降级) */
export function getConfigResolved(
  overrides: ConfigResolveOverrides = {}
): ConfigResolvedState | null {
  return cacheSlots.get(overridesKeyOf(overrides)) ?? null;
}

/**
 * 刷新 core 解析态(幂等:同代同文件指纹直接回缓存;并发按 overridesKey
 * 共享各自的单次在途)。由 async 消费入口在读取缓存前 await;同步消费面
 * 读 getConfigResolved。
 */
export async function ensureConfigResolved(
  overrides: ConfigResolveOverrides = {}
): Promise<ConfigResolvedState> {
  const generation = getRootConfigGeneration();
  const overridesKey = overridesKeyOf(overrides);
  const located = locateAndRead(overrides);
  const mark = `${fingerprint(located.defaultsPath)}|${fingerprint(located.customPath)}`;
  const hit = cacheSlots.get(overridesKey);
  if (hit && hit.generation === generation && hit.fingerprint === mark) {
    return hit;
  }
  // 在途请求按「代 + 文件指纹 + 键」隔离:配置落盘/设置变化(invalidate 或
  // 指纹前进)后,同键新调用不得复用旧配置的在途请求——否则变更后立即重取
  // 仍等到旧 RPC、合成文档回旧内容(审核席 P1:2026-11-07 CFG-009 审)。
  const inflightKey = `${generation}\n${mark}\n${invalidationEpoch}\n${overridesKey}`;
  const existing = inflights.get(inflightKey);
  if (existing) {
    return existing;
  }
  const inflight = refresh(generation, overridesKey, mark, invalidationEpoch, located).finally(() => {
    inflights.delete(inflightKey);
  });
  inflights.set(inflightKey, inflight);
  return inflight;
}

/** 落槽(FIFO 逐出最旧槽,槽数有界) */
function storeSlot(overridesKey: string, slot: CacheSlot): void {
  cacheSlots.delete(overridesKey); // 重插即视为最新
  cacheSlots.set(overridesKey, slot);
  while (cacheSlots.size > RESOLVE_CACHE_SLOTS) {
    const oldest = cacheSlots.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cacheSlots.delete(oldest);
  }
}

async function refresh(
  generation: number,
  overridesKey: string,
  mark: string,
  epoch: number,
  located: ReturnType<typeof locateAndRead>
): Promise<ConfigResolvedState> {
  const base: ConfigResolvedState = {
    ok: false,
    generation,
    customTree: null,
    defaultsTree: null,
    customPath: located.customPath,
    defaultsPath: located.defaultsPath,
    merged: null,
    telnetSummary: [],
    telnetDefaultPorts: {},
    customTelnet: null,
    dbInterface: null
  };
  // 回包落槽前复核:RPC 在途期间 generation 前进、失效边界(epoch)前进或
  // 两份文件指纹已变 → 本次产物按发起时的旧配置算出,只回给发起方,不落槽
  // (新指纹的下一次 ensure 自会重取;旧回包覆盖新槽会把过期配置缓存成
  // 「最新」。epoch 覆盖「定位结果本身变化」:旧请求发起时 customPath=null、
  // 之后元件配置被创建——旧回包对 null 路径的指纹恒空,仅指纹拦不住)。
  const stale = (): boolean =>
    getRootConfigGeneration() !== generation ||
    invalidationEpoch !== epoch ||
    `${fingerprint(located.defaultsPath)}|${fingerprint(located.customPath)}` !== mark;
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    // 门未接线(激活前/停用后):瞬态,不缓存——下一 ensure 重试
    return { ...base, reason: 'gate unavailable' };
  }
  const outcome = await gate.runInRust<Record<string, unknown>>('$/kode/config/resolve', {
    defaultsXml: located.defaultsXml,
    customXml: located.customXml
  });
  if (!outcome.ok) {
    if (outcome.reason === 'no serverPath') {
      // 门未接线(核心服务未配,装配面默认态):瞬态同「gate unavailable」,
      // 不缓存——替身/真服务接线后下一次 ensure 即取到;runInRust 在此形态
      // 下同步返回不建进程,无「重锤宕机 server」面,重复取零成本。
      return { ...base, reason: outcome.reason };
    }
    // RPC 失败:如实降级不缓存失败态为最终(缓存住,同代不重锤宕机
    // server;文件/代变化后重试),消费面按「core 不可知」降级。
    const failed: CacheSlot = { ...base, reason: outcome.reason, overridesKey, fingerprint: mark };
    if (!stale()) {
      storeSlot(overridesKey, failed);
    }
    return failed;
  }
  const result = outcome.result;
  const state: ConfigResolvedState = {
    ok: true,
    generation,
    customTree: (result['customTree'] as ConfigXmlNode | null) ?? null,
    defaultsTree: (result['defaultsTree'] as ConfigXmlNode | null) ?? null,
    customPath: located.customPath,
    defaultsPath: located.defaultsPath,
    merged: (result['merged'] as ConfigXmlNode | null) ?? null,
    telnetSummary: (result['telnetSummary'] as CoreTelnetSummaryEntry[]) ?? [],
    telnetDefaultPorts:
      (result['telnetDefaultPorts'] as Record<string, number> | undefined) ?? {},
    customTelnet: (result['customTelnet'] as CoreCustomTelnet | null) ?? null,
    dbInterface: (result['dbInterface'] as CoreDatabaseInterfaceConfig | null) ?? null
  };
  if (stale()) {
    return state;
  }
  const slot: CacheSlot = { ...state, overridesKey, fingerprint: mark };
  storeSlot(overridesKey, slot);
  return slot;
}

/** 由 kbengine.binPath 推导引擎 defaults 文件路径(自 telnetService 迁入:
 * KODE-CFG-009 起 telnetService 消费本模块,实现居此避免环;telnetService
 * 按原名对外)。后缀不在或剥完为空 → null。 */
export function deriveEngineDefaultsXmlPath(binPath: string): string | null {
  if (!binPath) {
    return null;
  }
  const normalized = path.normalize(binPath);
  const suffix = path.normalize(path.join('kbe', 'bin', 'server'));
  if (!normalized.endsWith(suffix)) {
    return null;
  }
  const root = normalized.slice(0, -(suffix.length + 1));
  if (root.length === 0) {
    return null;
  }
  return path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml');
}
