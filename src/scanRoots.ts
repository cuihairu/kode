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
import { startLanguageServiceOperation } from './languageServiceMetrics';
import { resetDiscoveryMemo, resolveDiscoveredConfigRoot } from './workspaceDiscovery';

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
  try {
    const assetsRoot = resolveAssetsRootForWorkspace(workspaceRoot);
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
  token?: vscode.CancellationToken
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
      await walkExternalRoot(full, match, skipDirs, merged, token);
      continue;
    }
    if (entry.isFile() && match(entry.name)) {
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
  token?: vscode.CancellationToken
): Promise<vscode.Uri[]> {
  // PR1 性能打点:发现耗时拆 workspace glob 与外部根遍历两段,只记计数/耗时,
  // 不改发现口径与去重行为。
  const discovery = startLanguageServiceOperation('file-discovery');
  const merged = new Map<string, vscode.Uri>();
  const stopWorkspaceGlob = discovery.startSubPhase('workspace-glob');
  const base = await vscode.workspace.findFiles(glob, exclude, undefined, token);
  stopWorkspaceGlob();
  for (const uri of base) {
    merged.set(normalizeForCompare(uri.fsPath), uri);
  }
  try {
    const match = matcherForGlob(glob);
    if (match) {
      const skipDirs = excludeDirNames(exclude);
      const stopExternalWalk = discovery.startSubPhase('external-walk');
      for (const root of getExternalScanRoots()) {
        if (token?.isCancellationRequested) { break; }
        await walkExternalRoot(root, match, skipDirs, merged, token);
      }
      stopExternalWalk();
    }
  } catch {
    // workspace 外根遍历失败不拖垮 workspace 结果(扫描按可得范围降级)
  }
  discovery.countFileDiscovery(merged.size);
  discovery.end('ok');
  return [...merged.values()];
}
