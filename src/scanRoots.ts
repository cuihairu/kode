/**
 * 索引扫描根(用户 2026-10-16:「不是只扫描顶层吧,还有 assetsRoot」)。
 *
 * `workspace.findFiles` 的裸 glob 按 workspace 匹配,workspace 之外显式配置的
 * assetsRoot 扫不到;这里把扫描根定为 **workspace 顶层 ∪ assetsRoot**(可能指
 * 向不同目录,按路径去重并剔除被包含的冗余根),并为 workspace 外的根提供手工
 * 遍历补齐。assetsRoot 未配置/不存在/读取异常时回退 workspace,不外抛。
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
 * 索引扫描根:workspace 全部文件夹 ∪ 有效 assetsRoot(配置原值 → 自动发现),
 * 路径去重 + 包含关系去重(assetsRoot 已在某 workspace 文件夹内时不重复入列),
 * 目录不存在的剔除。空工作区且无 assetsRoot → 空数组(调用方按「扫不到」处理,
 * 不抛错)。
 */
export function getIndexScanRoots(): string[] {
  const candidates: string[] = [];
  try {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder?.uri?.fsPath) {
        candidates.push(folder.uri.fsPath);
      }
    }
  } catch {
    // workspace 读取异常 → 只剩 assetsRoot 兜底,不外抛
  }
  const workspaceRoot = candidates[0] ?? '';
  // KODE-CFG-005:配置派生扫描根优先(CFG-004 链,经 ensureConfigDerivedScanRoot
  // 刷新的缓存读取;`{assets}/res/server/kbengine.xml` → `{assets}/scripts`)。
  // 缓存未就绪/RPC 失败/降级/目录不存在 → 派生根落空,自然走旧
  // workspace∪assetsRoot 链兜底(设计 §6.2:旧链保留为兜底,派生结果优先)
  const derivedRoot = getConfigDerivedScanRoot();
  if (derivedRoot) {
    candidates.push(derivedRoot);
  }
  try {
    const assetsRoot = resolveAssetsRootForWorkspace(workspaceRoot);
    // 审核发现修复:派生 scripts 根存在时仍把外部 assetsRoot 入列——否则
    // scripts 之外的资源/定义文件(res/、entity_defs 等)不再被索引。包含去重
    // 会留下更宽的 assetsRoot 并剔除被其包含的派生 scripts 根(不重复扫)。
    if (assetsRoot) {
      candidates.push(assetsRoot);
    }
  } catch {
    // assetsRoot 解析异常 → 仅 workspace,不外抛
  }

  const picked: string[] = [];
  const seen = new Set<string>();
  for (const root of candidates) {
    if (!root || !isDirectory(root)) {
      continue;
    }
    const key = normalizeForCompare(root);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    picked.push(root);
  }
  // 包含去重:被别的根完全包含的根丢弃(assetsRoot 在 workspace 内时由
  // workspace 的 findFiles 覆盖,无需重复入列)
  return picked.filter(
    (root, index) =>
      !picked.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          isContained(normalizeForCompare(other), normalizeForCompare(root))
      )
  );
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
  const merged = new Map<string, vscode.Uri>();
  const stopWorkspaceGlob = discovery.startSubPhase('workspace-glob');
  const base = await vscode.workspace.findFiles(glob, exclude, undefined, token);
  stopWorkspaceGlob();
  for (const uri of base) {
    const key = normalizeForCompare(uri.fsPath);
    if (engineExclusions.some(rootKey => isContained(rootKey, key))) {
      continue;
    }
    if (pathFilter && !pathFilter(uri.fsPath)) {
      continue;
    }
    merged.set(key, uri);
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
        await walkExternalRoot(root, match, skipDirs, merged, token, pathFilter, pruneRoots);
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
