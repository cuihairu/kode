/**
 * 运行异常关联到源码定位(IDE-LIV-007):从引擎异常/日志行里解析出
 * 可解析的文件+行(Python traceback 的 `File "…" , line N` 与日志的
 * `path/file.py:N` 两种真实形态),并把相对路径解析到当前工作区里真
 * 实存在的文件——解析不到就明说不可跳转,原始行原样保留,绝不猜邻
 * 近文件或编造落点。可跳转时的落点也只信解析结果,行号照原始行。
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ExceptionSourceLocation {
  /** 原始行里的文件名(原样保留,不做大小写/分隔符改写) */
  file: string;
  /** 原始行里的 1 基行号 */
  line: number;
  /** 解析来源:traceback 形态或日志路径形态 */
  qualifier: 'traceback' | 'logpath';
}

/** Python traceback 形态:File "scripts/base/Avatar.py", line 42, in onTimer */
const TRACEBACK_PATTERN = /File\s+"([^"]+)",\s*line\s+(\d+)/;
/** 日志路径形态:... scripts/base/Avatar.py:42 ... */
const LOGPATH_PATTERN = /([A-Za-z0-9_\-./\\]+\.py):(\d+)/;

/** 解析单个异常行;无可解析文件行返回 null(不是猜一个) */
export function parseExceptionSourceLocation(raw: string): ExceptionSourceLocation | null {
  const traceback = TRACEBACK_PATTERN.exec(raw);
  if (traceback) {
    return { file: traceback[1], line: Number.parseInt(traceback[2], 10), qualifier: 'traceback' };
  }
  const logpath = LOGPATH_PATTERN.exec(raw);
  if (logpath) {
    return { file: logpath[1], line: Number.parseInt(logpath[2], 10), qualifier: 'logpath' };
  }
  return null;
}

export interface ResolvedExceptionSource {
  /** 工作区内真实存在的绝对路径(exists 校验过) */
  absolutePath: string;
  location: ExceptionSourceLocation;
}

/**
 * 把解析出的文件解析到工作区真实文件。候选序列:
 * ①原样绝对路径;②各工作区根下按原相对路径;③各根下常见脚本子目录
 * (scripts/base|cell|client|interfaces)拼 basename(KBEngine 日志里
 * 路径带 assets 前缀而工作区直接开 assets 内子目录的形态)。
 * 找不到存在的文件→null,由调用方保留原始信息。
 */
export function resolveExceptionSource(
  workspaceRoots: string[],
  location: ExceptionSourceLocation,
  exists: (candidate: string) => boolean = candidate => fs.existsSync(candidate)
): ResolvedExceptionSource | null {
  const normalized = location.file.replace(/\\/g, '/');
  const basename = path.posix.basename(normalized);
  const scriptDirs = ['scripts/base', 'scripts/cell', 'scripts/client', 'scripts/interfaces'];
  const candidates: string[] = [];
  if (path.isAbsolute(normalized)) {
    candidates.push(normalized);
  }
  for (const root of workspaceRoots) {
    candidates.push(path.join(root, normalized));
    for (const dir of scriptDirs) {
      candidates.push(path.join(root, dir, basename));
    }
  }
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return { absolutePath: candidate, location };
    }
  }
  return null;
}

/** 无源码时的保留文案:原始行原样带出,不做任何改写 */
export function formatUnresolvedException(raw: string, location: ExceptionSourceLocation | null): string {
  if (!location) {
    return `异常无可解析文件行,原始信息:${raw}`;
  }
  return `异常文件行 ${location.file}:${location.line} 在当前工作区未找到源码,原始信息:${raw}`;
}
