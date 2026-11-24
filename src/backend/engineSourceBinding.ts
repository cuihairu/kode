// RUST-174 API metadata 与真实 engine source 绑定:把策展 KBE 符号解析到
// 真实引擎检出上的定义锚(Python=引擎 typings .pyi 的声明行,与
// tests/kbeModuleIndex.test.ts 引擎源码条件用例同一验收口径;C++=按
// cppClassName 在 src/lib 头文件里有界扫描 `class X` 声明行)。
// 锚点漂移只给文件不给假行,引擎缺席/扫描未见/无锚名各自如实分型,
// 绝不编造位置。version constraints 复用 engineApiVersionAnnotation。
// 纯模块,不 import vscode;fs 由 deps 注入。

import * as path from 'path';
import { engineApiVersionAnnotation, type KbeSymbolEntry } from '../kbeModuleIndex';

/**
 * 引擎 typings 锚点候选(sourceFile 相对路径如 typings/_KBEngine_common.pyi):
 * typings 是**用户自己的引擎 stub 包**(2026-11-24 用户令),fork 里位于
 * 仓库根(引擎安装根的兄弟位),不在安装根内。engineRoot 语义 = kbe 目录
 * 本身,故候选两处:安装根内 typings/ 优先,退仓库根(安装根父目录)的
 * typings/。纯路径函数不做盘探测——首命中由调用面按 deps.existsSync 选,
 * 皆不存在时落首候选形态(existsSync 判 engine-absent,不编造存在)。
 */
export function resolveEngineTypingsCandidates(engineRoot: string, relativePath: string): string[] {
  const direct = path.join(engineRoot, relativePath);
  if (!relativePath.startsWith('typings/')) {
    return [direct];
  }
  const sibling = path.join(path.dirname(engineRoot), relativePath);
  return sibling === direct ? [direct] : [direct, sibling];
}

/** Python 定义解析:三种诚实形态,无一伪造。 */
export type EnginePythonDefinition =
  | { kind: 'engine-typings'; file: string; line: number }
  | { kind: 'engine-typings-drifted'; file: string }
  | { kind: 'engine-absent' };

export interface EngineSourceFsDeps {
  existsSync(candidate: string): boolean;
  readFileSync(candidate: string): string;
}

/** 锚点声明名:Vector2/3/4 的暴露名≠C++ 类名,回退链与测试用例一致。 */
const declarationName = (entry: Pick<KbeSymbolEntry, 'name' | 'cppClassName' | 'aliasOf'>): string =>
  entry.cppClassName ?? entry.aliasOf ?? entry.name;

/**
 * 解析符号到真实引擎 typings 的声明行。验收与引擎源码条件用例同一口径:
 * 声明行应以 `class|def <declName>` 开头。文件在而锚点行漂移 → 只给文件
 * (行不声称);引擎缺席 → engine-absent。
 */
export function resolveEnginePythonDefinition(
  entry: Pick<KbeSymbolEntry, 'name' | 'kind' | 'sourceFile' | 'sourceLine' | 'cppClassName' | 'aliasOf'>,
  engineRoot: string | null,
  deps: EngineSourceFsDeps
): EnginePythonDefinition {
  if (!engineRoot) {
    return { kind: 'engine-absent' };
  }
  const candidates = resolveEngineTypingsCandidates(engineRoot, entry.sourceFile);
  const file = candidates.find(candidate => deps.existsSync(candidate)) ?? candidates[0];
  if (!deps.existsSync(file)) {
    return { kind: 'engine-absent' };
  }
  const keyword = entry.kind === 'class' ? 'class' : 'def';
  const expected = `${keyword} ${declarationName(entry)}`;
  try {
    const lines = deps.readFileSync(file).split('\n');
    const anchor = lines[entry.sourceLine - 1];
    if (anchor !== undefined && anchor.startsWith(expected)) {
      return { kind: 'engine-typings', file, line: entry.sourceLine };
    }
  } catch {
    // 读取失败按漂移处理:文件在,行不声称
  }
  return { kind: 'engine-typings-drifted', file };
}

/** C++ 定义解析:有锚名才扫,扫描未见如实 not-found,无锚名不猜。 */
export type EngineCppDefinition =
  | { kind: 'engine-cpp'; file: string; line: number }
  | { kind: 'cpp-not-found' }
  | { kind: 'no-cpp-anchor' }
  | { kind: 'engine-absent' };

/** 有界扫描上限(与 workspaceDiscovery 深扫描同量级:深度 7/文件 20000)。 */
const CPP_SCAN_MAX_DEPTH = 7;
const CPP_SCAN_MAX_FILES = 20000;

export interface EngineSourceScanDeps extends EngineSourceFsDeps {
  readdirSync(candidate: string): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
}

/**
 * 按锚名在 `<engineRoot>/kbe/src/lib` 头文件里找 `class <name>` 声明行。
 * 目录序确定性遍历(排序),深度/文件数有界;首命中即返回,超限未见如实
 * cpp-not-found(宁缺勿猜)。
 */
export function resolveEngineCppDefinition(
  entry: Pick<KbeSymbolEntry, 'cppClassName'>,
  engineRoot: string | null,
  deps: EngineSourceScanDeps
): EngineCppDefinition {
  if (!engineRoot) {
    return { kind: 'engine-absent' };
  }
  const anchorName = entry.cppClassName;
  if (!anchorName) {
    return { kind: 'no-cpp-anchor' };
  }
  const prefix = `class ${anchorName}`;
  const searchRoot = path.join(engineRoot, 'src', 'lib');
  if (!deps.existsSync(searchRoot)) {
    return { kind: 'cpp-not-found' };
  }
  let filesScanned = 0;
  const visit = (directory: string, depth: number): EngineCppDefinition => {
    if (depth > CPP_SCAN_MAX_DEPTH || filesScanned >= CPP_SCAN_MAX_FILES) {
      return { kind: 'cpp-not-found' };
    }
    const entries = [...deps.readdirSync(directory)].sort((left, right) => left.name.localeCompare(right.name));
    for (const child of entries) {
      const childPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        const hit = visit(childPath, depth + 1);
        if (hit.kind === 'engine-cpp') {
          return hit;
        }
        continue;
      }
      if (!child.isFile() || !child.name.endsWith('.h')) {
        continue;
      }
      filesScanned += 1;
      if (filesScanned > CPP_SCAN_MAX_FILES) {
        return { kind: 'cpp-not-found' };
      }
      try {
        const lines = deps.readFileSync(childPath).split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          if (/^\s*class\s+\w/.test(lines[index]) && lines[index].trim().startsWith(prefix)) {
            return { kind: 'engine-cpp', file: childPath, line: index + 1 };
          }
        }
      } catch {
        // 单文件读取失败跳过,继续扫描
      }
    }
    return { kind: 'cpp-not-found' };
  };
  return visit(searchRoot, 0);
}

/** version constraints 面:分层 + 当前设置下的标注态(复用 KB-VER-002 口径)。 */
export interface EngineApiConstraintInfo {
  layer: 'baseline' | 'fork' | 'pending';
  /** 当前设置下该符号是否带「需 fork」提示(fork 语境=false) */
  annotated: boolean;
  /** 标注文案(双语由 engineApiVersionAnnotation 承担);baseline 通常 null */
  annotation: string | null;
}

export function describeEngineApiConstraint(
  entry: Pick<KbeSymbolEntry, 'version'>,
  engineVersion: string,
  ideLanguage?: string
): EngineApiConstraintInfo {
  const layer = entry.version ?? 'baseline';
  const annotation = engineApiVersionAnnotation({ version: layer }, engineVersion, ideLanguage);
  return { layer, annotated: annotation !== null, annotation };
}
