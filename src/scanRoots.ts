/**
 * 索引扫描根(用户 2026-10-16:「不是只扫描顶层吧,还有 assetsRoot」;
 * 2026-11-23:「只从 assetsRoot 起扫,找不到就不扫,不要退回 workspace」)。
 *
 * `workspace.findFiles` 的裸 glob 按 workspace 匹配,workspace 之外显式配置的
 * assetsRoot 扫不到;这里把扫描根定为 **assetsRoot**(配置派生 scripts 根 →
 * `assetsRoot` 设置 → 自动发现),并为 workspace 外的根提供手工遍历补齐。
 * assetsRoot 未配置/不存在/读取异常 → **空数组**:不退回 workspace 顶层,
 * 因为那会把引擎仓、依赖树、构建产物全扫进索引,是浪费而不是兜底——
 * 空根就是「配置不对」的明确信号,由上层如实提示。不外抛。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfigDerivedScanRoot } from './configDerive';
import { startLanguageServiceOperation } from './languageServiceMetrics';
import { resetDiscoveryMemo, resolveDiscoveredConfigRoot } from './workspaceDiscovery';
import { resolveManagedDirName } from './backend/managedDir';
import { filterManagedDirCopies } from './backend/pythonScanRules';
import { findEngineRoot } from './backend/engineCompatibility';
import { hasEngineTreeMarker } from './backend/engineApiMetadata';
import minimatch from 'minimatch';

/** 比较用规范化:绝对化、正斜杠;Windows 盘符路径小写化以稳定去重 */
function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, '/');
  return /^[A-Za-z]:/.test(resolved) ? resolved.toLowerCase() : resolved;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isContained(parentKey: string, childKey: string): boolean {
  if (parentKey === childKey) {
    return true;
  }
  return childKey.startsWith(parentKey.endsWith('/') ? parentKey : `${parentKey}/`);
}

/**
 * 自动发现的资产根按 workspace 根记忆:发现链含约定探测后的有界深扫描,
 * 每次扫描根计算都重跑会让跳转退化为全树 walk;配置原值不参与记忆(每次现算,
 * 读配置是纯内存操作),配置变化即时生效。
 */
const discoveryMemo = new Map<string, string | null>();

/**
 * 活动 profile 的选定资产根(IDE-PRJ-011):会话内显式状态,由 profile
 * 切换接线写入——选定根存在即在 resolveAssetsRootForWorkspace 里优先于
 * assetsRoot 设置与自动发现(显式选择优先);不存在如实落空走原链。
 * 它不是发现记忆,resetScanRootCache 不清它(选择的生命周期跟 profile,
 * 跟缓存失效无关);测试用 setActiveProfileScanRoot(null) 复位。
 */
let activeProfileScanRoot: string | null = null;

export function setActiveProfileScanRoot(root: string | null): void {
  activeProfileScanRoot = root && root.trim() ? root : null;
}

export function getActiveProfileScanRoot(): string | null {
  return activeProfileScanRoot;
}

/** 测试用:清 discovery 记忆(不同用例换工作区根时不残留) */
export function resetScanRootCache(): void {
  discoveryMemo.clear();
  // 书 PR-002 ③:workspaceDiscovery 交互路径 Top3 memo 同级失效
  resetDiscoveryMemo();
  // 锚点根记忆同级失效(默认布局后建/挪位时按新探测落地)
  anchorScanRootMemo = null;
}

export function resolveAssetsRootForWorkspace(workspaceRoot: string): string {
  // 选定根优先(IDE-PRJ-011):存在才采用,不存在如实落空走配置/发现链
  if (activeProfileScanRoot && isDirectory(activeProfileScanRoot)) {
    return activeProfileScanRoot;
  }
  let configured = '';
  try {
    configured = (vscode.workspace.getConfiguration('kbengine').get<string>('assetsRoot', '') ?? '').trim();
  } catch {
    configured = '';
  }
  const rawPath = configured.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
  // 归一化:去 ${workspaceFolder} 后的 `..` 段;相对路径按工作区根解析(与
  // 发现报告口径一致)。配置原值存在即用——扫描根看目录存在性,不看引擎
  // 装载探针(探针只管启动链)。
  // 相对值必须有仓库根可锚(path.resolve 的 '.' 会落 cwd,禁用);无根 → 空串
  const expanded = rawPath
    ? path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : workspaceRoot
        ? path.resolve(workspaceRoot, rawPath)
        : ''
    : '';
  if (expanded && isDirectory(expanded)) {
    return expanded;
  }
  if (!workspaceRoot) {
    return '';
  }
  if (!discoveryMemo.has(workspaceRoot)) {
    let discovered: string | null = null;
    try {
      discovered = resolveDiscoveredConfigRoot(workspaceRoot);
    } catch {
      discovered = null;
    }
    discoveryMemo.set(workspaceRoot, discovered);
  }
  const discovered = discoveryMemo.get(workspaceRoot);
  return discovered && isDirectory(discovered) ? discovered : '';
}

/**
 * 索引扫描根:**只扫 assetsRoot/scripts**(2026-11-23 用户令)。
 *
 * 扫描根 = `{assets}/scripts`(脚本源);找不到 scripts 目录就返回**空数组**,
 * 绝不退回 assetsRoot 本体或 workspace 顶层——那是全盘扫的来源。调用方按
 * 「扫不到」处理,提示配置不对,不抛错。
 *
 * 旧语义(workspace 顶层 ∪ assetsRoot)让 assets 之外的引擎仓/依赖树全被
 * 扫进索引(全盘 2398 文件),已按用户反复要求收窄到 scripts。
 */
export function getIndexScanRoots(): string[] {
  // 2026-11-23 用户令:**索引只从 assetsRoot/scripts 起扫,没有兜底**。
  // scripts 是 KBEngine 的脚本源;assetsRoot 解析出但 scripts 目录缺 → 空数组
  // (调用方按「扫不到」处理,提示配置不对),**绝不退回 assetsRoot 本体或
  // workspace 顶层**——空根兜底会把引擎仓/依赖树/构建产物全扫进来(2398 文件
  // 全盘扫即由此来),是浪费而非保险。workspace 根只用于解析 assetsRoot 的
  // 相对路径与自动发现,自身永远不进 KBEngine 扫描根。
  //
  // 分支三分(与 HEAD 前的「assetsRoot 落空回退 workspace」历史行为对齐):
  // ① assetsRoot 解析出(配置有效或自动发现命中)→ {assets}/scripts;scripts
  //    缺 → 空数组(用户令:找不到 scripts 就不扫)。
  // ② 配置读取失败或配置显式给出却解析不出(配置不对)→ 空数组(不退回
  //    workspace 全盘扫;配置错了就如实提示,不拿 workspace 兜底掩盖)。
  // ③ 无配置、无发现、无配置错误(真非 KBEngine 仓库)→ 维持旧 workspace
  //    腿:有 scripts 的文件夹收窄到 scripts,没有的按旧语义整文件夹。这是
  //    HEAD 前的回退行为,只在不涉及 assetsRoot 时生效。
  const workspaceRoot = (() => {
    try {
      return (vscode.workspace.workspaceFolders ?? [])[0]?.uri?.fsPath ?? '';
    } catch {
      return '';
    }
  })();

  // 配置原值先读:显式配置但解析不出(如指向不存在目录)=「配置不对」,必须与
  // 「完全未配置」区分开——后者才走 ③ 的 workspace 腿(历史回退)。
  let configuredRaw = '';
  let configReadFailed = false;
  try {
    configuredRaw = (vscode.workspace.getConfiguration('kbengine').get<string>('assetsRoot', '') ?? '').trim();
  } catch {
    configReadFailed = true; // 配置系统异常 = 不可信,按配置不对处理(不扫)
  }

  const assetsRoot = (() => {
    try {
      return resolveAssetsRootForWorkspace(workspaceRoot);
    } catch {
      return ''; // 解析异常 = 配置不对,扫描根保持空,上层如实提示
    }
  })();

  // ① 索引范围 = **assetsRoot 下的 scripts 目录**(比整棵 assetsRoot 更小)。
  // scripts 才是 KBEngine 的脚本源(scripts/base|cell|client),assetsRoot 剩下
  // 的 res/、entity_defs/ 等对类索引无用。显式拼路径而非依赖派生根:派生根需要
  // 配置派生链先算成,而 assetsRoot/scripts 是直接可判的存在性。assetsRoot 为空
  // 时不拼相对路径(会落到 cwd 上,禁用)。
  if (assetsRoot) {
    const scriptsRoot = path.join(assetsRoot, 'scripts');
    if (isDirectory(scriptsRoot)) {
      return [scriptsRoot];
    }
    // ② 用户令原话:**assetsRoot 找得到但 scripts 目录没有 → 不扫描**(绝不
    // 退回 assetsRoot 本体或 workspace 顶层)。空根就是「配置不对」的明确信号,
    // 由上层如实提示——本分支不再查派生根/workspace 腿,避免「assets 在而
    // scripts 缺」被别的兜底悄悄掩盖成一次全盘扫。
    // 锚点放开腿(2026-11-23 二段令):默认落点缺席时唯一允许的放开 = 按
    // 引擎默认布局(entities.xml/entity_defs)定位的 scripts 根——找的是默认
    // 布局,不是 workspace 兜底;定位不到仍空根如实。
    return anchorLegRoots();
  }

  // ② 配置读取失败或配置显式给出但解析不出:配置不对,不扫。显式配置存在
  // (哪怕指向不存在目录)说明用户有明确意图,落空是错误而非「没 KBEngine」,
  // 此时拿 workspace 兜底会掩盖错误(HEAD 前 ghost 配置回退 workspace 正是
  // 被用户否掉的「全盘扫」来源之一)。
  // 锚点放开腿(2026-11-23 二段令):同上——配置错就按引擎默认布局定位,
  // 定位不到如实空根,不拿 workspace 裸 glob 掩盖。
  if (configReadFailed || configuredRaw) {
    return anchorLegRoots();
  }

  // ③ assetsRoot 完全解析不出且无配置(真非 KBEngine 仓库):按默认布局
  // 收窄——文件夹根下有 scripts/ 的收窄到该 scripts,没有的**不贡献扫描根**
  // (2026-11-23 用户令:引擎源码钉死派生链,resmgr.cpp:489 getPyUserScriptsPath
  // + entitydef.cpp:159/176-181——entities.xml/entity_defs/types.xml 只在
  // {assets}/scripts 及其 entity_defs 下,引擎不存在「其他目录」;默认位置
  // 没有就不扫,整文件夹兜底会把引擎仓/依赖树/构建产物全扫进来,全盘 694 即
  // 由此来)。配置派生根(引擎根配置派生,等价 KBE_RES_PATH 指路)保留:那是
  // 引擎唯一支持的「非默认落点」,属于合法放开;锚点腿(默认布局定位)兜其
  // 后。多文件夹各留其 scripts(多工程工作区互不牵连)。
  const derivedRoot = getConfigDerivedScanRoot();
  if (derivedRoot) {
    return [derivedRoot];
  }
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderPath = (() => {
      try {
        return folder?.uri?.fsPath ?? '';
      } catch {
        return '';
      }
    })();
    if (!folderPath) {
      continue;
    }
    const key = normalizeForCompare(folderPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const workspaceScripts = path.join(folderPath, 'scripts');
    // 默认落点没有 scripts → 该文件夹不贡献扫描根(不整文件夹兜底,③ 注)
    if (isDirectory(workspaceScripts)) {
      roots.push(workspaceScripts);
    }
  }
  // 锚点放开腿(2026-11-23 二段令):folder 顶层/派生根都缺席时,已探测到的
  // 引擎默认布局锚点根并入(定位不到 = 空根如实)。异步面先 await
  // ensureAnchorScanRoot() 再进入,同步面只认已记忆结果。
  return anchorLegRoots(roots);
}

/** workspace 文件夹之外的扫描根(需手工遍历补齐的部分) */
export function getExternalScanRoots(): string[] {
  const folderKeys = (vscode.workspace.workspaceFolders ?? []).map(folder =>
    normalizeForCompare(folder.uri.fsPath)
  );
  return getIndexScanRoots().filter(root => {
    const key = normalizeForCompare(root);
    return !folderKeys.some(folder => isContained(folder, key));
  });
}

/** 文件所属的扫描根(最长匹配):workspace 文件夹优先,外部 assetsRoot 兜底 */
export function getScanRootForFile(filePath: string): string | null {
  const key = normalizeForCompare(filePath);
  const matches = getIndexScanRoots()
    .filter(root => isContained(normalizeForCompare(root), key));
  // 排序比较器不可达(批 63 定性):getIndexScanRoots(115-159)按包含关系去重,
  // 任意文件至多落入一个扫描根——两同含一文件的根必一含一,短者已被剔除,
  // 故匹配集恒 ≤1,长度降序比较器从不会被调用;保留 sort 仅作「最长匹配」
  // 防御语义,比较器体不可达。
  /* istanbul ignore start */
  const byLongestPath = (left: string, right: string): number =>
    normalizeForCompare(right).length - normalizeForCompare(left).length;
  /* istanbul ignore stop */
  return matches.sort(byLongestPath)[0] ?? null;
}

/**
 * 锚点扫描根(2026-11-23 用户令二段:「默认目录没有发现才放开范围去扫描」;
 * 引擎源码核,resmgr.cpp:489 getPyUserScriptsPath + entitydef.cpp:159/176-181):
 * 引擎只认 {scripts}/entities.xml 与 {scripts}/entity_defs 一处,不存在其他
 * 候选目录。folder 顶层 scripts/ 与配置派生根都不在时,唯一允许的放开腿 =
 * 按**引擎默认布局**定位 scripts 根——workspace 里哪处有 entities.xml 或
 * entity_defs/*.def(两者取路径最浅),哪处就是 scripts 根。定位不到维持空根:
 * 放开的是「找默认布局」,绝不是 workspace 裸 glob 兜底。
 *
 * 探测走异步 findFiles(单飞+按 workspace 根记忆),同步读面只认已记忆结果
 * ——与配置派生根同一装配法(ensureConfigDerivedScanRoot):异步扫描入口
 * 先 await 本函数,再调 getIndexScanRoots。
 */
let anchorScanRootMemo: { workspaceKey: string; root: string | null } | null = null;
let anchorScanRootInflight: Promise<string | null> | null = null;

function firstWorkspaceFolderPath(): string {
  try {
    return (vscode.workspace.workspaceFolders ?? [])[0]?.uri?.fsPath ?? '';
  } catch {
    return '';
  }
}

/** 受管镜像根集合(与 findFilesAcrossRoots 的 KODE-RESP-008 口径一致) */
function managedRootKeysForProbe(): string[] {
  const managedDir = (() => {
    try {
      return resolveManagedDirName(
        vscode.workspace.getConfiguration('kbengine').get<string>('managedDir')
      ).name;
    } catch {
      return '.kbengine';
    }
  })();
  const roots: string[] = [];
  const seen = new Set<string>();
  const push = (rootFsPath: string): void => {
    const abs = normalizeForCompare(path.join(rootFsPath, managedDir));
    if (abs && !seen.has(abs)) {
      seen.add(abs);
      roots.push(abs);
    }
  };
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder?.uri?.fsPath) {
      push(folder.uri.fsPath);
    }
  }
  for (const root of getExternalScanRoots()) {
    push(root);
  }
  return roots;
}

/** 锚点探测的下潜上限与预算(有界深扫描,与 workspaceDiscovery 同口径) */
const ANCHOR_PROBE_MAX_DEPTH = 6;
const ANCHOR_PROBE_MAX_DIRS = 4000;
/** 依赖树/构建产物/托管镜像/venv 不进入锚点定位 */
const ANCHOR_PROBE_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'out', 'dist', 'build', 'venv', '.venv', '__pycache__', '.vscode'
]);

/**
 * 锚点探测:从各 workspace 文件夹(及已配置的 assetsRoot)有界下潜,找引擎
 * 默认布局落点——`<scripts>/entities.xml`(entitydef.cpp:176)或
 * `<scripts>/entity_defs/`(entitydef.cpp:177)。找到哪个,哪个的父目录就是
 * scripts 根;多候选取最浅(最贴近默认落点形态)。
 *
 * 走**真实文件系统**而非 `workspace.findFiles`:一是 glob 语义依赖调用方
 * 兑现(形态守卫必须自理),二是发现面的调用方对 findFiles 有严格调用计数
 * 口径(执行位分离/换代纪律),锚点探测若经它会给发现链记账。
 */
function probeAnchorScanRootSync(): string | null {
  const starts: string[] = [];
  const seenStarts = new Set<string>();
  const pushStart = (dir: string): void => {
    const key = normalizeForCompare(dir);
    if (dir && isDirectory(dir) && !seenStarts.has(key)) {
      seenStarts.add(key);
      starts.push(dir);
    }
  };
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      pushStart(folder?.uri?.fsPath ?? '');
    } catch {
      // 工作区根不可读=无该路可探
    }
  }
  try {
    pushStart(resolveAssetsRootForWorkspace(firstWorkspaceFolderPath()));
  } catch {
    // 配置链不可信=不参与探测起点
  }
  const engineExclusions = resolveEngineSubtreeExclusions();
  const managedRootKeys = managedRootKeysForProbe();
  const managedName = managedDirName();
  const candidates: string[] = [];
  const visited = new Set<string>();
  const walk = (dir: string, depth: number, budget: { left: number }): void => {
    if (budget.left <= 0 || depth > ANCHOR_PROBE_MAX_DEPTH) {
      return;
    }
    budget.left -= 1;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (ANCHOR_PROBE_SKIP_DIRS.has(entry.name) || entry.name === managedName) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const key = normalizeForCompare(full);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      if (
        engineExclusions.some(exclusionKey => isContained(exclusionKey, key)) ||
        managedRootKeys.some(rootKey => isContained(rootKey, key))
      ) {
        continue;
      }
      // entity_defs 是 scripts 下的 def 落点(entitydef.cpp:177):命中即定根
      if (entry.name === 'entity_defs') {
        candidates.push(dir);
        continue;
      }
      walk(full, depth + 1, budget);
    }
  };
  for (const start of starts) {
    const budget = { left: ANCHOR_PROBE_MAX_DIRS };
    // start 本身按 scripts 落点形态校验:含 entities.xml 即命中
    if (containsEntitiesXml(start)) {
      candidates.push(start);
    }
    walk(start, 1, budget);
  }
  if (candidates.length === 0) {
    return null;
  }
  const depth = (p: string): number => normalizeForCompare(p).split('/').length;
  candidates.sort((left, right) =>
    depth(left) - depth(right) || normalizeForCompare(left).localeCompare(normalizeForCompare(right))
  );
  return candidates[0];
}

function managedDirName(): string {
  try {
    return resolveManagedDirName(
      vscode.workspace.getConfiguration('kbengine').get<string>('managedDir')
    ).name;
  } catch {
    return '.kbengine';
  }
}

function containsEntitiesXml(dir: string): boolean {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some(entry =>
      entry.name === 'entities.xml'
    );
  } catch {
    return false;
  }
}

/**
 * 锚点探测(异步面):结果按 workspace 根记忆,同步读面(getIndexScanRoots)
 * 只认已记忆值。单飞仅护「探测在途」的重复盘读,不改变记忆口径。
 */
export async function ensureAnchorScanRoot(): Promise<string | null> {
  const workspaceKey = normalizeForCompare(firstWorkspaceFolderPath());
  if (anchorScanRootMemo && anchorScanRootMemo.workspaceKey === workspaceKey) {
    return anchorScanRootMemo.root;
  }
  let root: string | null = null;
  if (!anchorScanRootInflight) {
    anchorScanRootInflight = (async () => {
      const found = probeAnchorScanRootSync();
      // 有界深扫描挪出调用方微任务边界:激活链不被盘读占住
      await Promise.resolve();
      return found;
    })().finally(() => {
      anchorScanRootInflight = null;
    });
  }
  try {
    root = await anchorScanRootInflight;
  } catch {
    root = null; // 探测异常 = 没放开(维持空根,上层如实提示)
  }
  anchorScanRootMemo = { workspaceKey, root };
  return root;
}

/**
 * 锚点放开腿:主腿(配置/派生/folder 顶层)已给出的根之外,把已记忆的锚点
 * 根并入(不与既有根重含)。主腿全空且锚点未定位到 = 空根如实。
 */
function anchorLegRoots(roots: string[] = []): string[] {
  const memo = anchorScanRootMemo;
  // 记忆按 workspace 键持有:键已过期(workspace 换根/清空) = 同步读面
  // 不认旧锚点,等异步入口按新键重探
  if (
    !memo ||
    memo.workspaceKey !== normalizeForCompare(firstWorkspaceFolderPath()) ||
    !memo.root ||
    !isDirectory(memo.root)
  ) {
    return roots;
  }
  const anchorRoot = memo.root;
  const anchorKey = normalizeForCompare(anchorRoot);
  if (!roots.some(root => isContained(normalizeForCompare(root), anchorKey))) {
    roots.push(anchorRoot);
  }
  return roots;
}

/**
 * 引擎仓内嵌探测时跳过的目录(探盘降噪,不参与剔除语义)
 */
const ENGINE_PROBE_SKIP_DIRS = new Set(['.git', 'node_modules']);

/**
 * 引擎仓子树剔除缓存(ENGINE-LIB-SCAN-005 刀2):key=显式设置值+扫描根集合,
 * TTL 5s——findFilesAcrossRoots 也被悬停级的按实体名定向 def 查找调用,
 * 每调用现探盘(readdir×扫描根+existsSync×候选)会把探测 IO 打进交互路径;
 * TTL 内同 key 直接复用,扫描根/设置变化自然换 key 重探。
 */
let engineExclusionCache: { key: string; expiresAt: number; roots: string[] } | null = null;

/** 测试复位:清引擎子树剔除缓存(含 key,下次调用重探盘) */
export function resetEngineSubtreeExclusionCache(): void {
  engineExclusionCache = null;
}

/**
 * 扫描根内嵌引擎仓孩子(ENGINE-LIB-SCAN-005 刀2):用户布局=打开含引擎仓
 * +assets 的上层目录,引擎仓是工作区**孩子**,findEngineRoot 向上找找不到;
 * 探各扫描根的一/二层子目录 hasEngineTreeMarker(探盘仅每缓存刷新一轮一次)。
 */
function probeEmbeddedEngineRoots(root: string): string[] {
  const found: string[] = [];
  try {
    for (const level1 of fs.readdirSync(root, { withFileTypes: true })) {
      if (!level1.isDirectory() || ENGINE_PROBE_SKIP_DIRS.has(level1.name)) {
        continue;
      }
      const dir1 = path.join(root, level1.name);
      if (hasEngineTreeMarker(dir1, probe => fs.existsSync(probe))) {
        found.push(dir1);
        continue;
      }
      try {
        for (const level2 of fs.readdirSync(dir1, { withFileTypes: true })) {
          if (!level2.isDirectory() || ENGINE_PROBE_SKIP_DIRS.has(level2.name)) {
            continue;
          }
          const dir2 = path.join(dir1, level2.name);
          if (hasEngineTreeMarker(dir2, probe => fs.existsSync(probe))) {
            found.push(dir2);
          }
        }
      } catch {
        // 一层子目录不可读=其下无内嵌可探,跳过
      }
    }
  } catch {
    // 根不可读=无内嵌引擎仓可探
  }
  return found;
}

/**
 * 引擎仓子树剔出业务扫描的排除根(ENGINE-LIB-SCAN-005 刀2):业务索引
 * (workspace∪assetsRoot)不吃引擎仓,引擎语料走专用通道。候选:
 *   ① kbengine.engineRoot 显式设置(marker 校验通过才认,防误配整树误剔);
 *   ② 扫描根自身/祖先是引擎仓(findEngineRoot 向上)——工作区=引擎仓或
 *      引擎仓深处,整根都是引擎子树;
 *   ③ 扫描根内嵌引擎仓孩子(一/二层探测,见 probeEmbeddedEngineRoots)。
 * 绝对路径前缀判定(isContained 同口径),不按目录名全局剔除;空数组=
 * 无引擎仓面,全部调用方行为与刀2 前一致。
 */
export function resolveEngineSubtreeExclusions(): string[] {
  const configRoot =
    vscode.workspace.getConfiguration('kbengine').get<string>('engineRoot', '').trim();
  const scanRoots = getIndexScanRoots();
  const key = JSON.stringify([configRoot, ...scanRoots.map(normalizeForCompare).sort()]);
  const now = Date.now();
  if (engineExclusionCache && engineExclusionCache.key === key && now < engineExclusionCache.expiresAt) {
    return engineExclusionCache.roots;
  }
  const exclusions: string[] = [];
  const push = (dir: string | null): void => {
    const norm = dir ? normalizeForCompare(dir) : '';
    if (norm && !exclusions.includes(norm)) {
      exclusions.push(norm);
    }
  };
  if (configRoot && hasEngineTreeMarker(configRoot, probe => fs.existsSync(probe))) {
    push(configRoot);
  }
  for (const root of scanRoots) {
    push(findEngineRoot(root));
    for (const embedded of probeEmbeddedEngineRoots(root)) {
      push(embedded);
    }
  }
  engineExclusionCache = { key, expiresAt: now + 5000, roots: exclusions };
  return exclusions;
}

/**
 * 用户排除 glob 编译缓存(ENGINE-LIB-SCAN-005 刀3):key=globs JSON,配置
 * 变化自然换 key 重编译(编译结果与扫描根无关,不必进 engineExclusionCache)。
 */
let userExcludeCache: { key: string; matchers: RegExp[] } | null = null;

/** 测试复位:清用户排除 glob 编译缓存 */
export function resetUserScanExcludeCache(): void {
  userExcludeCache = null;
}

/**
 * kbengine.index.scanExcludeGlobs 用户排除兜底(ENGINE-LIB-SCAN-005 刀3):
 * 每条 glob 经 minimatch.makeRe(dot 开)编译为正则,对规范化绝对路径
 * 匹配,命中的文件/目录不进业务索引(与刀2 引擎子树同一接入面)。裸目录
 * 名简写(如 kbe)按「任意前缀/kbe/任意后缀」的双星 glob 形态解释——
 * 用户心智=「剔这个目录」。坏模式(如未闭合的方括号)跳过不炸:配置
 * 兜底面不因一条手误把整个扫描炸停。默认空=零排除。
 */
export function getUserScanExcludeMatchers(): RegExp[] {
  const globs = vscode.workspace.getConfiguration('kbengine.index').get<string[]>('scanExcludeGlobs', []);
  const entries = Array.isArray(globs)
    ? globs.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const key = JSON.stringify(entries);
  if (userExcludeCache && userExcludeCache.key === key) {
    return userExcludeCache.matchers;
  }
  const matchers: RegExp[] = [];
  for (const raw of entries) {
    const glob = raw.trim();
    const pattern = glob.includes('*') ? glob : `**/${glob}/**`;
    try {
      matchers.push(minimatch.makeRe(pattern, { dot: true }));
    } catch {
      // 坏模式跳过(不炸扫描)
    }
  }
  userExcludeCache = { key, matchers };
  return matchers;
}

/** 支持的 glob 形状 → 文件名谓词;不认识的形状不手工走(只返回 workspace 结果) */
function matcherForGlob(glob: string): ((name: string) => boolean) | null {
  const extension = /^\*\*\/\*\.([A-Za-z0-9_]+)$/.exec(glob);
  if (extension) {
    return (name: string): boolean => name.endsWith(`.${extension[1]}`);
  }
  const named = /^\*\*\/([^*?[\]{}]+)$/.exec(glob);
  if (named) {
    return (name: string): boolean => name === named[1];
  }
  return null;
}

/** exclude glob → 目录名黑名单(只解析字符串形态:花括号列表或目录段形式) */
function excludeDirNames(exclude: vscode.GlobPattern | null | undefined): Set<string> {
  const names = new Set<string>();
  if (typeof exclude !== 'string') {
    return names;
  }
  const braces = /\{([^}]+)\}/.exec(exclude);
  const tokens = braces
    ? braces[1].split(',')
    : [...exclude.matchAll(/\*\*\/([^/]+)\/\*\*/g)].map(match => match[1]);
  for (const token of tokens) {
    const name = token.trim();
    if (name && !name.includes('*')) {
      names.add(name);
    }
  }
  return names;
}

async function walkExternalRoot(
  root: string,
  match: (name: string) => boolean,
  skipDirs: Set<string>,
  merged: Map<string, vscode.Uri>,
  token?: vscode.CancellationToken,
  pathFilter?: (fsPath: string) => boolean,
  /** 剪枝根(受管镜像根 ∪ 引擎仓子树,前缀命中整棵不下潜) */
  pruneRoots: readonly string[] = []
): Promise<void> {
  if (token?.isCancellationRequested) { return; }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  let visited = 0;
  for (const entry of entries) {
    if (++visited % 256 === 0) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (token?.isCancellationRequested) { return; }
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || skipDirs.has(entry.name)) {
        continue;
      }
      // KODE-RESP-008:受管镜像树剪枝——外部根自身的 .kbengine/inferred 副本
      // 整棵不下潜(与引擎仓子树剪枝同形,ENGINE-LIB-SCAN-005 刀2 起同集合:
      // 连 readdir 的 IO 都省掉,不只是事后滤结果;旧版遍历会重新进结果,
      // 造成自身副本重复索引)
      if (pruneRoots.length > 0) {
        const key = normalizeForCompare(full);
        if (
          pruneRoots.some(
            rootKey => key === rootKey || key.startsWith(rootKey.endsWith('/') ? rootKey : `${rootKey}/`)
          )
        ) {
          continue;
        }
      }
      // 路径形态剪枝:命中过滤器的目录整棵不下潜(引擎 Lib 数千文件连
      // readdir 的 IO 都省掉,不只是事后滤结果)
      if (pathFilter && !pathFilter(full)) {
        continue;
      }
      await walkExternalRoot(full, match, skipDirs, merged, token, pathFilter, pruneRoots);
      continue;
    }
    if (entry.isFile() && match(entry.name) && !(pathFilter && !pathFilter(full))) {
      merged.set(normalizeForCompare(full), vscode.Uri.file(full));
    }
  }
}

/**
 * 跨扫描根找文件:workspace 部分维持原裸 glob 调用(既有行为与测试口径不变),
 * 再为 workspace 外的 assetsRoot 手工遍历补齐,最终按文件路径去重。
 */
export async function findFilesAcrossRoots(
  glob: string,
  exclude?: vscode.GlobPattern | null,
  token?: vscode.CancellationToken,
  /**
   * ENGINE-LIB-SCAN-005:调用方路径形态过滤器(true=保留)。workspace glob
   * 结果按它后滤,外部根遍历按它剪枝(命中的目录整棵不下潜)——多段路径
   * 形态(如 kbe/scripts/common/Lib)无法塞进 PY_SCAN_EXCLUDE 的单段 brace
   * glob,由调用方在业务语义层给出。缺省不过滤(generic 行为不变)。
   */
  pathFilter?: (fsPath: string) => boolean
): Promise<vscode.Uri[]> {
  // PR1 性能打点:发现耗时拆 workspace glob 与外部根遍历两段,只记计数/耗时,
  // 不改发现口径与去重行为。
  const discovery = startLanguageServiceOperation('file-discovery');
  // ENGINE-LIB-SCAN-005 刀2:引擎仓子树剔出业务扫描——三面同构受管根
  // (workspace glob 后滤 + 外部遍历剪枝 + 收尾兜底);memo 见
  // resolveEngineSubtreeExclusions(悬停级调用不重复探盘)。
  const engineExclusions = resolveEngineSubtreeExclusions();
  // 刀3:用户排除 glob(minimatch)并入同一谓词——workspace glob 后滤 +
  // 外部遍历剪枝共用,目录命中整棵不下潜
  const userExcludeMatchers = getUserScanExcludeMatchers();
  // 2026-11-23 用户令(反复数十次):建立索引只扫 assetsRoot/scripts——
  // workspace findFiles 的裸 glob 按 workspace 全目录匹配,覆盖面 ⊋ 扫描根时
  // 扫描根之外的文件照样进结果(全盘扫主因)。收窄不在这里做全局前缀剔:
  // findFilesAcrossRoots 也服务非索引面(全仓拼写门、类型 xml 引用等),
  // 前缀剔会静默缩小那些面的覆盖面。收窄落在两处:
  // ① getIndexScanRoots 只给 scripts(② 派生根 ③ 找不到就不给),外部遍历
  //    与引擎子树剔除因此只覆盖 scripts;
  // ② 下方「扫描根在 workspace 文件夹内则把 glob 挂到该子路径」——workspace
  //    腿按 scripts 子路径匹配,不再遍历整棵 workspace。
  /** 刀2 引擎子树(前缀)+ 刀3 用户 glob(minimatch)+ 调用方形态过滤器的合取 */
  const keepPath = (fsPath: string): boolean => {
    const key = normalizeForCompare(fsPath);
    if (engineExclusions.some(rootKey => isContained(rootKey, key))) {
      return false;
    }
    if (userExcludeMatchers.length > 0 && userExcludeMatchers.some(matcher => matcher.test(key))) {
      return false;
    }
    return pathFilter ? pathFilter(fsPath) : true;
  };
  const merged = new Map<string, vscode.Uri>();
  const scanRootKeys = getIndexScanRoots().map(normalizeForCompare);
  // 用户令(2026-11-23,反复数十次):**assetsRoot 找得到但 scripts 目录没有 →
  // 不扫描**——绝不退回 assetsRoot 本体或 workspace 顶层(res/、依赖树、构建
  // 产物全扫进去是浪费而非保险)。只对「assetsRoot 已解析」生效:KBEngine 项目
  // 的 assets 在而 scripts 缺 = 布局不对,空结果如实提示;assetsRoot 完全解析
  // 不出(非 KBEngine 仓库)时不算「找不到 scripts」,workspace 腿维持旧裸 glob
  // 行为,通用 python/def 面不因收窄失去索引。
  if (scanRootKeys.length === 0) {
    const workspaceRootForGate = (() => {
      try {
        return (vscode.workspace.workspaceFolders ?? [])[0]?.uri?.fsPath ?? '';
      } catch {
        return '';
      }
    })();
    let assetsRootResolved = false;
    try {
      assetsRootResolved = resolveAssetsRootForWorkspace(workspaceRootForGate) !== '';
    } catch {
      assetsRootResolved = false;
    }
    if (assetsRootResolved) {
      // assetsRoot 在、scripts 缺 = 找不到 scripts 目录,不扫描(零文件)
      discovery.end('ok');
      return [];
    }
  }
  const stopWorkspaceGlob = discovery.startSubPhase('workspace-glob');
  // 2026-11-23 用户令(只扫 assetsRoot/scripts)的性能面:扫描根若落在某个
  // workspace 文件夹之内(典型:kbe 仓里 assets/scripts),glob 直接挂到该子路径
  // ——`{folder}/{rel}/**/*.py`,而不是裸 `**/*.py` 遍历整棵 workspace 只为被
  // keepPath 剔掉。裸 glob 扫 workspace 顶层正是 2398 文件盘扫的 IO 来源。
  // 扫描根在 workspace 之外(外部 assetsRoot)时维持裸 glob + 外部遍历补齐;
  // 扫描根为空且 assetsRoot 完全解析不出(非 KBEngine 仓库)时同样维持裸
  // glob——通用 python/def 面不因收窄失去索引(「assetsRoot 在而 scripts 缺」
  // 的零文件早退已在上方 gate 处理)。
  let base: vscode.Uri[] = [];
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const hasRootInsideWorkspace = workspaceFolders.some(folder =>
    scanRootKeys.some(rootKey => isContained(normalizeForCompare(folder.uri.fsPath), rootKey))
  );
  if (hasRootInsideWorkspace) {
    // 2026-11-23 修复:多文件夹工作区每个含扫描根的 folder 各自收窄
    // (folderForRoot 原来只取第一个,其余 folder 的扫描根文件被静默漏掉)。
    for (const folder of workspaceFolders) {
      const folderKey = normalizeForCompare(folder.uri.fsPath);
      const rootKey = scanRootKeys.find(rootKey => isContained(folderKey, rootKey));
      if (!rootKey) {
        continue;
      }
      const rel = path.relative(folder.uri.fsPath, rootKey).split(path.sep).join('/');
      const scopedGlob = rel ? `${rel}/${glob}` : glob;
      for (const uri of await vscode.workspace.findFiles(scopedGlob, exclude, undefined, token)) {
        // 收窄路径同样经 keepPath 后滤(引擎库/托管镜像/用户排除),与
        // else 分支的裸 glob 结果同口径——收窄 glob 只省 IO,不放宽过滤。
        if (!keepPath(uri.fsPath)) {
          continue;
        }
        merged.set(normalizeForCompare(uri.fsPath), uri);
      }
    }
  } else if (scanRootKeys.length === 0) {
    // 扫描根为空且 assetsRoot 未解析出(真非 KBEngine 仓库):workspace 腿维持
    // 裸 glob(通用 python/def 面不因收窄失去索引)。「assetsRoot 在而 scripts
    // 缺」的零文件早退已在上方 gate 处理,不会走到这。
    //
    // 2026-11-23 用户复核(实测仍全盘扫描):扫描根非空但全在 workspace 之外
    // (外部 assetsRoot)时**绝不**再走裸 workspace glob——裸 glob 按 workspace
    // 全目录匹配,扫描根之外的文件照样进结果(全盘扫主因,上次修复 2644cb1c
    // 只堵了「扫描根在 workspace 内」分支,漏了外部根)。外部根由下方
    // walkExternalRoot(getExternalScanRoots)补齐,workspace 本体不扫。
    base = await vscode.workspace.findFiles(glob, exclude, undefined, token);
  }
  // else: 扫描根非空且全在 workspace 之外 = 外部 assetsRoot,workspace 腿零
  // 产出(扫描根由外部遍历覆盖),不再退化成全盘扫。
  stopWorkspaceGlob();
  for (const uri of base) {
    if (!keepPath(uri.fsPath)) {
      continue;
    }
    merged.set(normalizeForCompare(uri.fsPath), uri);
  }
  // KODE-CFG-017:托管目录(.kbengine/inferred 镜像树)副本剔出合并结果,
  // 防 kode 自身扫描镜像双计;目录名按 kbengine.managedDir 设置值(可为
  // 多段相对路径如 tools/.kbengine),受管根=各扫描根+相对值,按绝对路径
  // 前缀判定,不按任意同名段全局剔除。
  // KODE-RESP-008:受管根=**全部 workspace 文件夹 ∪ 各外部扫描根**(旧版只
  // 登记首个 workspace 根——第二工作区与外部根自己的镜像副本逃过过滤,且
  // 外部遍历在旧版的前置过滤之后跑,会把外部根的受管副本重新加回结果)。
  // 统一在收尾一次剔净;外部遍历另按该集合剪枝(受管子树零 readdir)。
  const managedDir = resolveManagedDirName(
    vscode.workspace.getConfiguration('kbengine').get<string>('managedDir')
  ).name;
  const managedRoots: string[] = [];
  const seenManagedRoots = new Set<string>();
  const pushManagedRoot = (rootFsPath: string): void => {
    const abs = normalizeForCompare(path.join(rootFsPath, managedDir));
    if (!seenManagedRoots.has(abs)) {
      seenManagedRoots.add(abs);
      managedRoots.push(abs);
    }
  };
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder?.uri?.fsPath) {
      pushManagedRoot(folder.uri.fsPath);
    }
  }
  for (const root of getExternalScanRoots()) {
    pushManagedRoot(root);
  }
  // 剪枝根集合=受管镜像根 ∪ 引擎仓子树(刀2):walkExternalRoot 按前缀整棵
  // 不下潜,收尾 filterManagedDirCopies 再对全部来源兜底剔一遍。
  const pruneRoots: string[] = [...managedRoots];
  for (const engineRootKey of engineExclusions) {
    if (!pruneRoots.includes(engineRootKey)) {
      pruneRoots.push(engineRootKey);
    }
  }
  try {
    const match = matcherForGlob(glob);
    if (match) {
      const skipDirs = excludeDirNames(exclude);
      const stopExternalWalk = discovery.startSubPhase('external-walk');
      for (const root of getExternalScanRoots()) {
        if (token?.isCancellationRequested) { break; }
        await walkExternalRoot(root, match, skipDirs, merged, token, keepPath, pruneRoots);
      }
      stopExternalWalk();
    }
  } catch {
    // workspace 外根遍历失败不拖垮 workspace 结果(扫描按可得范围降级)
  }
  // 收尾统一过滤(RESP-008):workspace glob 结果与外部遍历结果按同一剪枝
  // 根集合(受管根 ∪ 引擎仓子树,刀2)一次剔净(旧版收尾只按首个 workspace
  // 受管根前缀过滤,外部根/第二工作区的副本会重新进结果);遍历剪枝之外,
  // 任何来源的受管/引擎副本都在此兜底
  if (pruneRoots.length > 0) {
    const kept = new Set(filterManagedDirCopies([...merged.keys()], pruneRoots));
    for (const key of merged.keys()) {
      if (!kept.has(key)) {
        merged.delete(key);
      }
    }
  }
  discovery.countFileDiscovery(merged.size);
  discovery.end('ok');
  return [...merged.values()];
}
