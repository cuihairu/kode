/**
 * KODE-CFG-017 副本层：`.kbengine/inferred/` 镜像 scripts 树，供 pyrefly
 * infer 就地写注解（用户真码永不改）。纯逻辑层，不 import vscode。
 *
 * 镜像结构：每个 scripts 根按其工作区相对路径落在
 * `<managedDir>/inferred/<工作区相对>/...`（脚本根相对结构原样保留，
 * 多根不冲突）。内容比对零写（只在有差异时覆盖），与既有导出链同纪律。
 */

import * as path from 'path';

/** 副本根：`<managedDir>/inferred` */
export function inferredDirFor(managedDir: string): string {
  const dir = managedDir.replace(/^\/+|\/+$/g, '');
  return path.posix.join(dir, 'inferred');
}

/** scripts 根在镜像里的前缀 = 工作区相对路径（如 `scripts`、`assets/scripts`） */
export function mirrorPrefixFor(workspaceRoot: string, scriptsRoot: string): string {
  const rel = path.relative(workspaceRoot, scriptsRoot).replace(/\\/g, '/');
  return rel === '' ? '.' : rel;
}

export interface InferredMirrorPlan {
  /** 需新建（源有镜像无） */
  copy: string[];
  /** 需覆盖（两侧内容不同；内容比对零写纪律：相同不进任何列表） */
  overwrite: string[];
  /** 需删除（镜像有源无——源文件被删/改名后的残留，只清镜像管理段内） */
  deleteStale: string[];
  /** 已一致（幂等确认，供状态播报） */
  unchanged: string[];
}

export interface InferredMirrorDeps {
  /** 读文本；不存在返回 null */
  readText: (absPath: string) => string | null;
}

/**
 * 镜像计划（纯函数）：sourceFiles / existingInferred 均为相对路径
 * （如 `base/Avatar.py`）。内容比对零写；删除只清「本镜像管理」相对路径
 * 集合内的残留，绝不越界删用户文件。
 */
export function planInferredMirror(
  sourceRoot: string,
  inferredRoot: string,
  sourceFiles: readonly string[],
  existingInferred: readonly string[],
  deps: InferredMirrorDeps
): InferredMirrorPlan {
  const sourceSet = new Set(sourceFiles);
  const copy: string[] = [];
  const overwrite: string[] = [];
  const unchanged: string[] = [];
  for (const rel of sourceFiles) {
    const inferredPath = path.join(inferredRoot, rel);
    const inferredText = deps.readText(inferredPath);
    if (inferredText === null) {
      copy.push(rel);
      continue;
    }
    const sourceText = deps.readText(path.join(sourceRoot, rel));
    if (sourceText === null) {
      // 源文件在计划后消失：跳过（下轮 sync 会进 deleteStale）
      continue;
    }
    if (sourceText === inferredText) {
      unchanged.push(rel);
      continue;
    }
    overwrite.push(rel);
  }
  const deleteStale: string[] = [];
  for (const rel of existingInferred) {
    if (!sourceSet.has(rel)) {
      deleteStale.push(rel);
    }
  }
  return { copy, overwrite, deleteStale, unchanged };
}

/** 目录条目（装配层注入：fs.readdirSync 的 Dirent 形态） */
export interface InferredDirEntry {
  name: string;
  isDir: boolean;
}

export interface SourceFilesResult {
  /** 成功列举到的 .py/.pyi 相对路径（深度不限） */
  files: string[];
  /**
   * 列举期间有目录读取失败（如权限/暂态 IO）。结果不完整：调用方绝不能据此
   * 判定「某镜像文件已过期」——读失败不是空目录，照空目录处理会误删既有副本。
   */
  incomplete: boolean;
}

/**
 * 列举 scripts 根下待镜像的 .py/.pyi 相对路径（深度不限）。
 * 目录条目不区分文件/目录时靠 isDir 决定下钻；.py/.pyi 文件收，其余跳过。
 * 某目录读取失败置 incomplete=true 并跳过该子树（不抛出），由调用方据
 * incomplete 决定禁止删除——「读失败」与「真空目录」必须可区分。
 */
export function listSourceFiles(
  scriptsRoot: string,
  deps: { listDir: (absPath: string) => readonly InferredDirEntry[] }
): SourceFilesResult {
  const result: string[] = [];
  let incomplete = false;
  const walk = (absDir: string, relDir: string): void => {
    let entries: readonly InferredDirEntry[];
    try {
      entries = deps.listDir(absDir);
    } catch {
      incomplete = true;
      return;
    }
    for (const entry of entries) {
      const abs = `${absDir}/${entry.name}`;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDir) {
        walk(abs, rel);
        continue;
      }
      if (entry.name.endsWith('.py') || entry.name.endsWith('.pyi')) {
        result.push(rel);
      }
    }
  };
  walk(scriptsRoot, '');
  return { files: result, incomplete };
}
