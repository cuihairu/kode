/**
 * 工作区自动发现(批125,设计约束:尽量减少配置项)
 *
 * 解析分层:约定路径(引擎/官方资产布局,零配置首选)→ 有界深扫描
 * (约定未命中时的兜底,限深限次,结果按工作区缓存)→ 多候选时激活期
 * 一次性询问并记忆(workspaceState),之后同步读取不再打扰。
 * 同步读路径只认「唯一命中」:记忆的选择优先;无记忆且多候选时宁缺勿猜,
 * 不静默改写 def 根。显式配置永远优先于发现结果;能从已存在文件推断的
 * 子模块路径(def 根 → interfaces/components/user_type 子目录)不进配置。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 约定路径(与 getDefinitionWorkspaceLayout 的候选同源,深扫描只作兜底) */
export const DISCOVERY_CONVENTIONS = {
  entityDefs: [
    'entity_defs',
    'scripts/entity_defs',
    'assets/scripts/entity_defs',
    'server_assets/scripts/entity_defs'
  ],
  entitiesXml: [
    'entities.xml',
    'scripts/entities.xml',
    'assets/scripts/entities.xml',
    'server_assets/scripts/entities.xml'
  ],
  typesXml: [
    'types.xml',
    'entity_defs/types.xml',
    'scripts/entity_defs/types.xml',
    'assets/scripts/entity_defs/types.xml',
    'server_assets/scripts/entity_defs/types.xml',
    'scripts/types.xml',
    'assets/scripts/types.xml'
  ],
  // 引擎源码根锚点:本仓 fork 为 kbe/src/lib,原版为 kbe/src/common
  kbeSourceAnchors: [
    'kbe/src/lib/entitydef/entitydef.cpp',
    'kbe/src/lib/db_mysql/entity_table_mysql.cpp',
    'kbe/src/common/entitydef/entitydef.cpp'
  ],
  // 服务器资产根(kbengine.configPath)约定:'' 即工作区根本身。命中验收
  // 不是目录存在,而是引擎装载探针 <候选>/res/server/kbengine.xml 在
  configRoots: ['', 'assets', 'server_assets']
} as const;

/**
 * 资产根验收谓词:引擎以该目录为 cwd 启动并从 <根>/res/server/kbengine.xml
 * 读元件配置,探针文件不在 = 起不来。发现、报告与 serverManager 共用此口径。
 */
export function hasEngineConfigProbe(configPath: string): boolean {
  return fs.existsSync(path.join(configPath, 'res', 'server', 'kbengine.xml'));
}

const SKIP_DIRECTORY_NAMES = new Set(['node_modules', '.git', '.vscode', 'out', 'dist']);

/** 有界深扫描默认上限(诊断报告如实呈现,触顶即标注截断) */
export const DEFAULT_SCAN_DEPTH = 7;
export const DEFAULT_SCAN_MAX_VISITED = 20000;

export interface DiscoveredCandidateSet {
  entityDefs: string[];
  entitiesXml: string[];
  typesXml: string[];
  kbeSourceRoots: string[];
  messagesXml: string[];
  /** 深扫描命中的资产根(res/server/kbengine.xml 探针所在目录族) */
  configRoots: string[];
  /** 本次扫描实际访问的条目数(受 maxVisited 截顶) */
  scanVisited: number;
  /** true = 在 maxVisited/maxDepth 触顶截断,命中集可能不全 */
  scanTruncated: boolean;
}

export interface ScanOptions {
  /** 目录深度上限(默认 7) */
  maxDepth?: number;
  /** 访问条目总量上限,防巨仓扫穿(默认 20000) */
  maxVisited?: number;
}

/** 一次有界 walk 同时收集全部锚点;node_modules/.git 等直接剪枝 */
export function scanWorkspaceAnchors(
  workspaceRoot: string,
  options: ScanOptions = {}
): DiscoveredCandidateSet {
  const maxDepth = options.maxDepth ?? DEFAULT_SCAN_DEPTH;
  const maxVisited = options.maxVisited ?? DEFAULT_SCAN_MAX_VISITED;
  const found: DiscoveredCandidateSet = {
    entityDefs: [],
    entitiesXml: [],
    typesXml: [],
    kbeSourceRoots: [],
    messagesXml: [],
    configRoots: [],
    scanVisited: 0,
    scanTruncated: false
  };
  let visited = 0;
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || visited >= maxVisited) {
      // 触顶截断:命中集可能不全,报告如实标注,不当作零命中
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= maxVisited) {
        truncated = true;
        return;
      }
      visited += 1;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORY_NAMES.has(entry.name) && !entry.name.startsWith('.')) {
          if (entry.name === 'entity_defs') {
            found.entityDefs.push(fullPath);
          }
          walk(fullPath, depth + 1);
        }
        continue;
      }
      if (entry.isFile()) {
        if (entry.name === 'entities.xml') {
          found.entitiesXml.push(fullPath);
        } else if (entry.name === 'types.xml') {
          found.typesXml.push(fullPath);
        } else if (entry.name === 'messages_fixed.xml') {
          found.messagesXml.push(fullPath);
        } else if (entry.name === 'entitydef.cpp' || entry.name === 'entity_table_mysql.cpp') {
          const kbeRoot = findKbeRootAnchor(fullPath);
          if (kbeRoot && found.kbeSourceRoots.indexOf(kbeRoot) === -1) {
            found.kbeSourceRoots.push(kbeRoot);
          }
        } else if (
          // 资产根探针形态:kbengine.xml 恰在 <root>/res/server/ 下,资产根
          // 即再上两级目录(约定链之外的深嵌布局由此兜底,如 demo/res/server)
          entry.name === 'kbengine.xml'
          && path.basename(dir) === 'server'
          && path.basename(path.dirname(dir)) === 'res'
        ) {
          // 每个根的 res/server 下只有一个 kbengine.xml,同一根不会被推两次
          found.configRoots.push(path.dirname(path.dirname(dir)));
        }
      }
    }
  };

  walk(workspaceRoot, 0);
  found.scanVisited = visited;
  found.scanTruncated = truncated;
  return found;
}

/** 锚点文件向上找名为 kbe 的祖先目录(引擎源码根) */
function findKbeRootAnchor(filePath: string): string | null {
  let dir = path.dirname(filePath);
  for (;;) {
    if (path.basename(dir) === 'kbe') {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

// ---- 会话内缓存与多候选记忆 ----

const scanCache = new Map<string, DiscoveredCandidateSet>();

export type DiscoveryKey = 'entityDefs' | 'entitiesXml' | 'typesXml' | 'configRoot';

const rememberedChoices = new Map<string, Partial<Record<DiscoveryKey, string>>>();

/** 激活期把 workspaceState 里持久化的选择灌进会话记忆(整组覆盖) */
export function applyDiscoveryChoices(
  workspaceRoot: string,
  choices: Partial<Record<DiscoveryKey, string>> | undefined
): void {
  if (choices) {
    rememberedChoices.set(workspaceRoot, choices);
    scanCache.delete(workspaceRoot);
  }
}

export function setDiscoveryChoice(workspaceRoot: string, key: DiscoveryKey, value: string): void {
  const current = rememberedChoices.get(workspaceRoot) ?? {};
  rememberedChoices.set(workspaceRoot, { ...current, [key]: value });
  scanCache.delete(workspaceRoot);
}

export function getDiscoveryChoice(workspaceRoot: string, key: DiscoveryKey): string | null {
  const choices = rememberedChoices.get(workspaceRoot);
  const value = choices?.[key];
  return value && fs.existsSync(value) ? value : null;
}

export function resetDiscoveryState(): void {
  scanCache.clear();
  rememberedChoices.clear();
}

function cachedScan(workspaceRoot: string, options?: ScanOptions): DiscoveredCandidateSet {
  const cached = scanCache.get(workspaceRoot);
  if (cached) {
    return cached;
  }
  const result = scanWorkspaceAnchors(workspaceRoot, options);
  scanCache.set(workspaceRoot, result);
  return result;
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 只认唯一命中:多个候选不同一猜。猜测会把整个 def 根重写,顺带的
 * interfacesRoot/componentsRoot/userTypeRoots 全跟着换根,破坏既有降级链;
 * 多候选交激活期 quick pick 一次性记忆,记忆项经 getDiscoveryChoice 回放。
 */
function firstSingle(candidates: string[]): string | null {
  return candidates.length === 1 ? candidates[0] : null;
}

/** 深扫描兜底的实体定义目录:记忆的选择优先,否则只认唯一命中 */
export function resolveDiscoveredEntityDefsRoot(workspaceRoot: string): string | null {
  const remembered = getDiscoveryChoice(workspaceRoot, 'entityDefs');
  if (remembered) {
    return remembered;
  }
  return firstSingle(cachedScan(workspaceRoot).entityDefs);
}

/** 深扫描兜底的 entities.xml:记忆的选择优先,否则只认唯一命中 */
export function resolveDiscoveredEntitiesXmlPath(workspaceRoot: string): string | null {
  const remembered = getDiscoveryChoice(workspaceRoot, 'entitiesXml');
  if (remembered) {
    return remembered;
  }
  return firstSingle(cachedScan(workspaceRoot).entitiesXml);
}

/** 深扫描兜底的 types.xml:记忆的选择优先,否则只认唯一命中 */
export function resolveDiscoveredTypesXmlPath(workspaceRoot: string): string | null {
  const remembered = getDiscoveryChoice(workspaceRoot, 'typesXml');
  if (remembered) {
    return remembered;
  }
  return firstSingle(cachedScan(workspaceRoot).typesXml);
}

/**
 * 服务器资产根发现(kbengine.configPath 未通过探针时的兜底):约定链按序
 * 取第一个探针命中(工作区根/assets/server_assets),约定全 miss 而深扫描
 * 多候选时用记忆的选择(激活期询问所得),深扫描唯一命中直接采用——口径与
 * def 根家族一致:约定优先、宁缺勿猜。
 */
export function resolveDiscoveredConfigRoot(workspaceRoot: string): string | null {
  const conventional = firstExisting(
    DISCOVERY_CONVENTIONS.configRoots
      .map(relative => path.join(workspaceRoot, relative))
      .filter(hasEngineConfigProbe)
  );
  if (conventional) {
    return conventional;
  }
  const remembered = getDiscoveryChoice(workspaceRoot, 'configRoot');
  if (remembered && hasEngineConfigProbe(remembered)) {
    return remembered;
  }
  return firstSingle(cachedScan(workspaceRoot).configRoots);
}

/**
 * 引擎源码根:约定锚点直查 → 记忆的选择 → 深扫描。供 binPath 兜底
 * (serverManager/serverConfigMerge)与 messages_fixed.xml 定位共用。
 */
export function resolveKbeSourceRoot(workspaceRoot: string): string | null {
  const conventional = firstExisting(
    DISCOVERY_CONVENTIONS.kbeSourceAnchors.map(anchor => path.join(workspaceRoot, anchor))
  );
  if (conventional) {
    return findKbeRootAnchor(conventional);
  }
  const scan = cachedScan(workspaceRoot);
  return scan.kbeSourceRoots[0] ?? null;
}

/**
 * 引擎 messages_fixed.xml:引擎资源目录精确位置(<源码根>/res/server/ 下用户
 * 改的 messages_fixed.xml,缺省回 messages_fixed_defaults.xml)优先;纯资产仓
 * (工作区无引擎源码)时深扫描兜底找用户 messages_fixed.xml。都没有为 null。
 */
export function resolveEngineMessagesXmlPath(workspaceRoot: string): string | null {
  const kbeRoot = resolveKbeSourceRoot(workspaceRoot);
  if (kbeRoot) {
    const exact = firstExisting([
      path.join(kbeRoot, 'res', 'server', 'messages_fixed.xml'),
      path.join(kbeRoot, 'res', 'server', 'messages_fixed_defaults.xml')
    ]);
    if (exact) {
      return exact;
    }
  }
  return firstSingle(cachedScan(workspaceRoot).messagesXml);
}

export interface DiscoveryCandidateReport {
  /** 每类锚点的候选全集(约定命中 + 深扫描命中,去重) */
  candidates: Record<DiscoveryKey, string[]>;
  /** 候选多于一个的锚点(激活期据此弹一次选择) */
  ambiguous: DiscoveryKey[];
}

/** 激活期盘点:多候选询问的数据源。约定命中与扫描命中合并去重 */
export function collectDiscoveryCandidates(workspaceRoot: string): DiscoveryCandidateReport {
  const scan = cachedScan(workspaceRoot);
  const exists = (relativePath: string): boolean => fs.existsSync(path.join(workspaceRoot, relativePath));

  const candidates: Record<DiscoveryKey, string[]> = {
    entityDefs: [
      ...DISCOVERY_CONVENTIONS.entityDefs.filter(exists).map(p => path.join(workspaceRoot, p)),
      ...scan.entityDefs
    ],
    entitiesXml: [
      ...DISCOVERY_CONVENTIONS.entitiesXml.filter(exists).map(p => path.join(workspaceRoot, p)),
      ...scan.entitiesXml
    ],
    typesXml: [
      ...DISCOVERY_CONVENTIONS.typesXml.filter(exists).map(p => path.join(workspaceRoot, p)),
      ...scan.typesXml
    ],
    // 资产根候选:探针验收(不是目录存在),约定命中与深扫描命中合并
    configRoot: [
      ...DISCOVERY_CONVENTIONS.configRoots
        .map(relative => path.join(workspaceRoot, relative))
        .filter(hasEngineConfigProbe),
      ...scan.configRoots
    ]
  };
  const deduped = (key: DiscoveryKey): string[] => [...new Set(candidates[key])];

  const entityDefs = deduped('entityDefs');
  const entitiesXml = deduped('entitiesXml');
  const typesXml = deduped('typesXml');
  const configRoot = deduped('configRoot');
  const ambiguous: DiscoveryKey[] = [];
  if (entityDefs.length > 1) {
    ambiguous.push('entityDefs');
  }
  if (entitiesXml.length > 1) {
    ambiguous.push('entitiesXml');
  }
  if (typesXml.length > 1) {
    ambiguous.push('typesXml');
  }
  if (configRoot.length > 1) {
    ambiguous.push('configRoot');
  }
  return {
    candidates: { entityDefs, entitiesXml, typesXml, configRoot },
    ambiguous
  };
}

/** 激活期询问依赖(注入以便测试;extension.ts 用 vscode.window/workspaceState 装配) */
export interface DiscoveryPromptDeps {
  // PromiseLike 而非 Promise:vscode.window.showQuickPick 返回 Thenable
  showQuickPick(items: string[], title: string): PromiseLike<string | undefined>;
  recall(workspaceRoot: string): Partial<Record<DiscoveryKey, string>> | undefined;
  remember(workspaceRoot: string, choices: Partial<Record<DiscoveryKey, string>>): void;
}

const KEY_LABELS: Record<DiscoveryKey, string> = {
  entityDefs: '实体定义目录(entity_defs)',
  entitiesXml: 'entities.xml',
  typesXml: 'types.xml',
  configRoot: '服务器资产根(kbengine.configPath)'
};

/**
 * 激活期发现流程:多候选且无记忆选择时每类锚点弹一次 quick pick,
 * 选择即记忆(后续会话经 workspaceState 回放,不再询问);无歧义不打扰。
 */
export async function runWorkspaceDiscovery(deps: DiscoveryPromptDeps, workspaceRoot: string): Promise<void> {
  applyDiscoveryChoices(workspaceRoot, deps.recall(workspaceRoot));
  const report = collectDiscoveryCandidates(workspaceRoot);

  for (const key of report.ambiguous) {
    const choices = rememberedChoices.get(workspaceRoot) ?? {};
    // union 键的元素访问不参与窄化,先落 const 再判
    const remembered = choices[key];
    if (remembered && fs.existsSync(remembered)) {
      continue;
    }
    const picked = await deps.showQuickPick(
      report.candidates[key],
      `检测到多个${KEY_LABELS[key]},选择本工作区使用的一项(仅询问一次)`
    );
    if (picked) {
      deps.remember(workspaceRoot, { ...choices, [key]: picked });
      applyDiscoveryChoices(workspaceRoot, { ...choices, [key]: picked });
    }
  }
}

// ---- 发现与定位诊断(批127:失败不再静默)----
//
// 背景:同步读路径"宁缺勿猜"时,layout 把 def 根回落到候选首项——一个可能
// 不存在的路径——下游 interfaces/components/types/entities 全跟着失效,
// 且全程无任何可见信号。本层把每次定位的输入与结论如实摊开,供输出通道
// 与命令按需呈现;报告可整段复制回给维护者,不必贴工作区文件树。

export type DiscoveryFieldStatus = 'ok' | 'ambiguous' | 'missing';

export type DiscoveryValueSource =
  | 'explicit-config'
  | 'remembered-choice'
  | 'convention'
  | 'deep-scan'
  | 'derived'
  | 'fallback'
  | 'none';

/** 报告字段的固定标签(字面联合供 remediationFor 做穷尽 switch,新增标签漏补即编译错) */
export type DiscoveryFieldLabel =
  | '实体定义目录 entity_defs'
  | 'entities.xml'
  | 'types.xml'
  | '接口目录 interfaces'
  | '组件目录 components'
  | '引擎消息消息表 messages_fixed.xml'
  | '资产根 kbengine.configPath'
  | '引擎二进制 kbengine.binPath';

export interface DiscoveryFieldReport {
  label: DiscoveryFieldLabel;
  status: DiscoveryFieldStatus;
  /** 最终取用的值(null = 未解析出) */
  resolved: string | null;
  /** 最终值的来源(未解析时为 none) */
  source: DiscoveryValueSource;
  /** 显式配置原值(null = 未设置) */
  explicitConfig: string | null;
  /** 显式配置是否指向真实存在的文件/目录 */
  explicitConfigExists: boolean | null;
  /** 约定链全集(工作区相对拼成绝对路径) */
  conventions: string[];
  /** 约定链中实际存在的 */
  conventionHits: string[];
  /** 深扫描命中的全集 */
  scanHits: string[];
  /** 会话内/持久化的多候选选择 */
  remembered: string | null;
}

export interface DiscoveryIssue {
  label: string;
  message: string;
  remediation: string;
}

export interface DiscoveryReport {
  workspaceRoot: string;
  generatedAt: string;
  scanVisited: number;
  scanTruncated: boolean;
  scanMaxDepth: number;
  scanMaxVisited: number;
  fields: DiscoveryFieldReport[];
  issues: DiscoveryIssue[];
}

/** 诊断所需的解析结果(装配层从 layout 与设置取,纯逻辑层不碰 vscode) */
export interface DiscoveryLayoutFacts {
  /** layout.entityDefsRoot:恒为非空字符串,但可能指向不存在的路径 */
  entityDefsRoot: string;
  entityScriptsRoot: string | null;
  interfacesRoot: string | null;
  componentsRoot: string | null;
  entitiesXmlPath: string | null;
  typesXmlPath: string | null;
  /** kbengine.configPath 原值(资产根,可能为空串;仅 ${workspaceFolder} 展开) */
  configPath: string;
  /** 生效资产根(装配层经管理器口径:原值探针命中优先,否则发现兜底) */
  configPathEffective: string;
  /** kbengine.binPath 原值(可能含 ${env:...} 占位,可为空串) */
  binPathSetting: string;
  /** 生效 binPath(装配层经管理器解析,含 kbe 源码根自动检测回落) */
  binPath: string;
  entityDefsPathSetting: string;
  entitiesXmlPathSetting: string;
  typesXmlPathSetting: string;
}

const SOURCE_LABELS: Record<DiscoveryValueSource, string> = {
  'explicit-config': '显式配置',
  'remembered-choice': '记忆选择',
  convention: '约定链',
  'deep-scan': '深扫描',
  derived: '推导(interfaces/components 由 def 根,binPath/messages 由引擎源码根)',
  fallback: '回落候选首项(不存在)',
  none: '未解析'
};

function existsValue(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && fs.existsSync(value);
}

/** 显式配置是否生效:非空且不等于任何约定链条目时才可能是配置值本身 */
function labelAnchorSource(
  resolved: string,
  explicit: string | null,
  conventions: string[],
  remembered: string | null,
  scanHits: string[]
): DiscoveryValueSource {
  if (explicit && resolved === explicit) {
    return 'explicit-config';
  }
  if (remembered && resolved === remembered) {
    return 'remembered-choice';
  }
  if (conventions.indexOf(resolved) !== -1) {
    return 'convention';
  }
  if (scanHits.indexOf(resolved) !== -1) {
    return 'deep-scan';
  }
  return existsValue(resolved) ? 'derived' : 'fallback';
}

function anchorField(
  label: DiscoveryFieldLabel,
  key: DiscoveryKey,
  workspaceRoot: string,
  conventions: readonly string[],
  scanHits: string[],
  explicit: string,
  resolved: string | null
): DiscoveryFieldReport {
  const rememberable = rememberedChoices.get(workspaceRoot)?.[key] ?? null;
  const remembered = rememberable && fs.existsSync(rememberable) ? rememberable : null;
  const absoluteConventions = conventions.map(relative => path.join(workspaceRoot, relative));
  const conventionHits = absoluteConventions.filter(p => fs.existsSync(p));
  // 歧义口径只数真实存在的候选(约定链全集仅供展示,零命中 ≠ 多候选)
  const existingCandidates = uniqueList(conventionHits.concat(scanHits));
  // ok = 解析且真实存在;歧义 = 未解析但存在的候选不止一个;missing = 其余
  // (含回落到不存在路径——批127 要点:这一情形此前完全静默)
  const status: DiscoveryFieldStatus =
    existsValue(resolved)
      ? 'ok'
      : resolved === null && existingCandidates.length > 1
        ? 'ambiguous'
        : 'missing';
  // 配置可能是相对路径或 ${workspaceFolder} 占位,与最终取用值比较前先同基
  const explicitResolved = explicit ? resolveAgainstWorkspace(workspaceRoot, explicit) : null;

  return {
    label,
    status,
    resolved,
    source: resolved
      ? labelAnchorSource(resolved, explicitResolved, absoluteConventions, remembered, scanHits)
      : 'none',
    explicitConfig: explicit || null,
    explicitConfigExists: explicitResolved ? fs.existsSync(explicitResolved) : null,
    conventions: absoluteConventions,
    conventionHits,
    scanHits,
    remembered
  };
}

function uniqueList(values: string[]): string[] {
  return [...new Set(values)];
}

/** 组装一份完整诊断:三个 def 根家族锚点 + 派生目录 + 资产根/引擎侧路径 */
export function buildDiscoveryReport(
  workspaceRoot: string,
  facts: DiscoveryLayoutFacts,
  scanOverride?: DiscoveredCandidateSet,
  generatedAt: string = new Date().toISOString()
): DiscoveryReport {
  // scanOverride:装配层不传(走缓存的真实深扫描);测试用它注入截断等
  // 无法用正常工作区复现的扫描形态
  const scan = scanOverride ?? cachedScan(workspaceRoot);
  const fields: DiscoveryFieldReport[] = [];

  fields.push(
    anchorField(
      '实体定义目录 entity_defs',
      'entityDefs',
      workspaceRoot,
      DISCOVERY_CONVENTIONS.entityDefs,
      scan.entityDefs,
      facts.entityDefsPathSetting,
      facts.entityDefsRoot || null
    )
  );
  fields.push(
    anchorField(
      'entities.xml',
      'entitiesXml',
      workspaceRoot,
      DISCOVERY_CONVENTIONS.entitiesXml,
      scan.entitiesXml,
      facts.entitiesXmlPathSetting,
      facts.entitiesXmlPath
    )
  );
  fields.push(
    anchorField(
      'types.xml',
      'typesXml',
      workspaceRoot,
      DISCOVERY_CONVENTIONS.typesXml,
      scan.typesXml,
      facts.typesXmlPathSetting,
      facts.typesXmlPath
    )
  );

  const derivedField = (label: DiscoveryFieldLabel, resolved: string | null): DiscoveryFieldReport => ({
    label,
    status: existsValue(resolved) ? 'ok' : 'missing',
    resolved,
    source: existsValue(resolved) ? 'derived' : 'none',
    explicitConfig: null,
    explicitConfigExists: null,
    conventions: [],
    conventionHits: [],
    scanHits: [],
    remembered: null
  });

  fields.push(derivedField('接口目录 interfaces', facts.interfacesRoot));
  fields.push(derivedField('组件目录 components', facts.componentsRoot));

  const kbeSourceRoot = resolveKbeSourceRoot(workspaceRoot);
  const engineMessages = resolveEngineMessagesXmlPath(workspaceRoot);
  fields.push({
    label: '引擎消息消息表 messages_fixed.xml',
    status: existsValue(engineMessages) ? 'ok' : 'missing',
    resolved: engineMessages,
    source: existsValue(engineMessages) ? (kbeSourceRoot ? 'derived' : 'deep-scan') : 'none',
    explicitConfig: null,
    explicitConfigExists: null,
    conventions: [],
    conventionHits: [],
    scanHits: scan.messagesXml,
    remembered: null
  });

  // 资产根:生效值(原值探针命中优先,否则发现兜底)以引擎装载口径验收
  // ——目录存在且 res/server/kbengine.xml 在(服务器以该目录为 cwd 启动,
  // 缺此文件引擎起不来)。来源按生效值落在哪条链上标注(批128 起含发现链)
  const configPathEffective = facts.configPathEffective
    ? resolveAgainstWorkspace(workspaceRoot, facts.configPathEffective)
    : '';
  const configProbe = configPathEffective
    ? path.join(configPathEffective, 'res', 'server', 'kbengine.xml')
    : null;
  const configProbeOk = existsValue(configProbe);
  const configConventionRoots = DISCOVERY_CONVENTIONS.configRoots.map(relative =>
    path.join(workspaceRoot, relative)
  );
  const configConventionProbes = configConventionRoots.map(root =>
    path.join(root, 'res', 'server', 'kbengine.xml')
  );
  const configConventionHitProbes = configConventionProbes.filter(probe => fs.existsSync(probe));
  const rememberableConfigRoot = rememberedChoices.get(workspaceRoot)?.['configRoot'] ?? null;
  const configRemembered = rememberableConfigRoot && fs.existsSync(rememberableConfigRoot)
    ? rememberableConfigRoot
    : null;
  const configExplicitResolved = facts.configPath
    ? resolveAgainstWorkspace(workspaceRoot, facts.configPath)
    : null;
  const configSource: DiscoveryValueSource = !configPathEffective
    ? 'none'
    : configExplicitResolved && configPathEffective === configExplicitResolved
      ? 'explicit-config'
      : configRemembered && configPathEffective === configRemembered
        ? 'remembered-choice'
        : configConventionRoots.indexOf(configPathEffective) !== -1
          ? 'convention'
          : scan.configRoots.indexOf(configPathEffective) !== -1
            ? 'deep-scan'
            : 'fallback';
  fields.push({
    label: '资产根 kbengine.configPath',
    status: configProbeOk ? 'ok' : 'missing',
    resolved: configPathEffective || null,
    source: configSource,
    explicitConfig: facts.configPath || null,
    // 有设置才有存在性可言(configExplicitResolved 与设置同真值)
    explicitConfigExists: configExplicitResolved ? fs.existsSync(configExplicitResolved) : null,
    conventions: configConventionProbes,
    conventionHits: configConventionHitProbes,
    scanHits: scan.configRoots,
    remembered: configRemembered
  });

  // binPath 来源:设置非空即显式配置(可能含 ${env:...} 展开);设置为空而
  // 生效值非空 = kbe 源码根/兄弟目录自动检测推导
  const binPathSettingResolved = facts.binPathSetting
    ? resolveAgainstWorkspace(workspaceRoot, facts.binPathSetting)
    : '';
  fields.push({
    label: '引擎二进制 kbengine.binPath',
    status: existsValue(facts.binPath) ? 'ok' : 'missing',
    resolved: facts.binPath || null,
    source: !facts.binPath
      ? 'none'
      : facts.binPathSetting
        ? 'explicit-config'
        : 'derived',
    explicitConfig: facts.binPathSetting || null,
    explicitConfigExists: facts.binPathSetting ? fs.existsSync(binPathSettingResolved) : null,
    conventions: [],
    conventionHits: [],
    scanHits: kbeSourceRoot ? [kbeSourceRoot] : [],
    remembered: null
  });

  return {
    workspaceRoot,
    generatedAt,
    scanVisited: scan.scanVisited,
    scanTruncated: scan.scanTruncated,
    scanMaxDepth: DEFAULT_SCAN_DEPTH,
    scanMaxVisited: DEFAULT_SCAN_MAX_VISITED,
    fields,
    issues: collectDiscoveryIssues(fields, scan.scanTruncated)
  };
}

/** 解析配置原值:支持 ${workspaceFolder} 占位与相对路径 */
function resolveAgainstWorkspace(workspaceRoot: string, value: string): string {
  const withWorkspace = value.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
  return path.isAbsolute(withWorkspace) ? withWorkspace : path.join(workspaceRoot, withWorkspace);
}

function collectDiscoveryIssues(
  fields: DiscoveryFieldReport[],
  scanTruncated: boolean
): DiscoveryIssue[] {
  const issues: DiscoveryIssue[] = [];

  for (const field of fields) {
    if (field.status === 'ok') {
      continue;
    }
    issues.push({
      label: field.label,
      message:
        field.status === 'ambiguous'
          ? `${field.label}找到 ${uniqueList(field.conventionHits.concat(field.scanHits)).length} 个候选但未选定:多候选需要激活期选一次并记忆,若当时取消则不再询问,本会话静默失效`
          : `${field.label}未解析出可用路径${field.resolved ? `(当前回落值不存在: ${field.resolved})` : ''}`,
      remediation: remediationFor(field)
    });
  }

  if (scanTruncated) {
    issues.push({
      label: '深扫描',
      message: '有界深扫描触顶截断,命中集可能不全——零命中不能等同于"工作区里真的没有"',
      remediation: '把工作区收窄到 KBEngine 工程本身,或显式配置对应路径项'
    });
  }

  return issues;
}

function remediationFor(field: DiscoveryFieldReport): string {
  switch (field.label) {
    case '实体定义目录 entity_defs':
      return `设置 kbengine.entityDefsPath 指向实体 .def 所在目录;或让目录名为 entity_defs 且位于约定链内(${field.conventions.join(' / ')}),多候选时下次激活会只询问一次`;
    case 'entities.xml':
      return '设置 kbengine.entitiesXmlPath 指向 entities.xml;或把它放在实体定义目录的同级/上级';
    case 'types.xml':
      return 'types.xml 无独立配置项:放在实体定义目录之下即可被找到(约定链兜底);缺失时先检查 entity_defs 根是否解析正确';
    case '接口目录 interfaces':
    case '组件目录 components':
      return '该目录由实体定义目录推导,先修好实体定义目录';
    case '资产根 kbengine.configPath':
      return '设置 kbengine.configPath 指向 KBEngine 资产根(其下应有 res/server/kbengine.xml 与 scripts/),或把资产根放在约定位置(工作区根、assets/、server_assets/,探针均为 res/server/kbengine.xml)';
    case '引擎二进制 kbengine.binPath':
      return '设置 kbengine.binPath 指向 kbe/bin/server(引擎源码根会被自动推导)';
    case '引擎消息消息表 messages_fixed.xml':
      return '需要引擎源码根(kbe/src 下 entitydef.cpp 锚点)或 messages_fixed.xml 在工作区内';
  }
}

const EMPTY_VALUES = '(无)';

/** 渲染成可直接复制的诊断文本 */
export function renderDiscoveryReport(report: DiscoveryReport): string {
  const lines: string[] = [];
  lines.push('Kode 发现与定位诊断');
  lines.push(`工作区: ${report.workspaceRoot}`);
  lines.push(`生成时间: ${report.generatedAt}`);
  lines.push(
    `深扫描: 访问 ${report.scanVisited} 条目, ` +
      `${report.scanTruncated ? '已截断(命中集可能不全)' : '未截断'} ` +
      `(上限 深度 ${report.scanMaxDepth} / ${report.scanMaxVisited} 条目)`
  );
  lines.push('');

  for (const field of report.fields) {
    lines.push(`[${field.status}] ${field.label}`);
    lines.push(
      `  最终: ${field.resolved ?? EMPTY_VALUES} (来源: ${SOURCE_LABELS[field.source]})`
    );
    lines.push(
      `  显式配置: ${field.explicitConfig ?? EMPTY_VALUES}` +
        (field.explicitConfigExists === null
          ? ''
          : ` ${field.explicitConfigExists ? '(存在)' : '(不存在)'}`)
    );
    lines.push(
      `  约定链命中: ${field.conventionHits.length ? field.conventionHits.join(', ') : EMPTY_VALUES}`
    );
    if (field.conventions.length > field.conventionHits.length) {
      lines.push(
        `  约定链未命中: ${field.conventions
          .filter(p => field.conventionHits.indexOf(p) === -1)
          .join(', ')}`
      );
    }
    lines.push(`  深扫描命中: ${field.scanHits.length ? field.scanHits.join(', ') : EMPTY_VALUES}`);
    lines.push(`  记忆选择: ${field.remembered ?? EMPTY_VALUES}`);
    lines.push('');
  }

  lines.push(`问题 ${report.issues.length} 项`);
  report.issues.forEach((issue, index) => {
    lines.push(`${index + 1}. ${issue.label}`);
    lines.push(`   ${issue.message}`);
    lines.push(`   补救: ${issue.remediation}`);
  });
  return lines.join('\n');
}
