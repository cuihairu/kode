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
  ]
} as const;

const SKIP_DIRECTORY_NAMES = new Set(['node_modules', '.git', '.vscode', 'out', 'dist']);

export interface DiscoveredCandidateSet {
  entityDefs: string[];
  entitiesXml: string[];
  typesXml: string[];
  kbeSourceRoots: string[];
  messagesXml: string[];
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
  const maxDepth = options.maxDepth ?? 7;
  const maxVisited = options.maxVisited ?? 20000;
  const found: DiscoveredCandidateSet = {
    entityDefs: [],
    entitiesXml: [],
    typesXml: [],
    kbeSourceRoots: [],
    messagesXml: []
  };
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || visited >= maxVisited) {
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
        }
      }
    }
  };

  walk(workspaceRoot, 0);
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

export type DiscoveryKey = 'entityDefs' | 'entitiesXml' | 'typesXml';

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
    ]
  };
  const deduped = (key: DiscoveryKey): string[] => [...new Set(candidates[key])];

  const entityDefs = deduped('entityDefs');
  const entitiesXml = deduped('entitiesXml');
  const typesXml = deduped('typesXml');
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
  return {
    candidates: { entityDefs, entitiesXml, typesXml },
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
  typesXml: 'types.xml'
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
