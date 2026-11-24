/**
 * Python 父类链直读解析(2026-11-24 用户报「提了无数次」的病灶):
 * def 中定义的方法,对应 py 实体类继承的父类已实现,def-method-missing-in-python
 * 仍报警、F12 也跳不过去——此前的判定面(属主注册面/全项目唯一名)都不看真实
 * 继承:方法名多处出现时全项目唯一名臂静默,约定链只读属主文件。
 *
 * 本模块做**同步、缓冲区感知**的父类链遍历:从(文件, 类名)出发,沿 class 的
 * bases 走——同文件同名类直连;跨文件走 import 解析(候选路径与索引 staging
 * 同一口径 pythonImportModuleCandidates,单一事实源);解析不到的基类(引擎
 * 内建 KBEngine.Entity 等)如实跳过,不贡献方法。
 *
 * 消费面(三处同链):defPythonParity 采集(祖先方法并入已实现集,Rust 规则
 * 集合差语义不变)/entityMapping 缺口判定(祖先链有=不算缺)/def→python 跳转
 * mro 臂(落点=最近声明祖先,LUT 与慢链同序)。
 *
 * 边界:链序是「声明序 BFS(父先于祖)」,不是 C3 线性化——存在性判定与最近
 * 祖先落点两用途下与 C3 至多差在菱形继承多实现的选择,KBEngine 实体继承
 * 实际为单链;全量 C3 在 pythonClassIndex(需索引),本模块刻意零索引依赖。
 */

import { parsePythonFile, type ParsedPythonFile, type PythonClassDef } from './pythonParser';
import { readSharedFileSnapshot } from '../sharedFileSnapshot';
import { pythonImportModuleCandidates } from './pythonClassIndex';

/** 链上一个类环节:文件 + 类 + 该类方法表(parsePythonFile 的 Map 原样) */
export interface PythonBaseChainLink {
  filePath: string;
  className: string;
  cls: PythonClassDef;
}

/** 遍历护栏:类数/读盘文件数上限(真实 KBEngine 工程链深个位数,护栏只防环与病态布局) */
export const PYTHON_BASE_CHAIN_MAX_CLASSES = 64;
export const PYTHON_BASE_CHAIN_MAX_FILES = 32;

const fileKey = (filePath: string): string => filePath.replace(/\\/g, '/');

/** 在已解析文件里找类:顶层名优先,退而求 qualifiedName(嵌套类外层.内层) */
function findClass(parsed: ParsedPythonFile, className: string): PythonClassDef | undefined {
  return (
    parsed.classes.find(item => item.name === className) ??
    parsed.classes.find(item => (item.qualifiedName ?? item.name) === className)
  );
}

interface ChainWalkOptions {
  /** 是否把起点自身作为链首(缺省 true:调用方要「自身 ∪ 祖先」的并集语义) */
  includeSelf?: boolean;
}

/**
 * 沿父类链遍历(声明序 BFS,近亲在前)。读不到/解析不了/类不存在的环节
 * 整枝跳过(零猜测);护栏(类数/文件数)触顶即停止扩展,已收环节如实返回。
 */
export function walkPythonBaseChain(
  pythonFile: string,
  className: string,
  options: ChainWalkOptions = {}
): PythonBaseChainLink[] {
  const includeSelf = options.includeSelf ?? true;
  const seen = new Set<string>();
  const parseCache = new Map<string, ParsedPythonFile | null>();
  let filesRead = 0;

  const parseAt = (file: string): ParsedPythonFile | null => {
    const key = fileKey(file);
    if (parseCache.has(key)) {
      return parseCache.get(key) ?? null;
    }
    let parsed: ParsedPythonFile | null = null;
    if (filesRead < PYTHON_BASE_CHAIN_MAX_FILES) {
      const snapshot = readSharedFileSnapshot(file);
      if (snapshot) {
        parsed = parsePythonFile(snapshot.content, file);
        filesRead += 1;
      }
    }
    parseCache.set(key, parsed);
    return parsed;
  };

  const links: PythonBaseChainLink[] = [];
  let processed = false;
  const queue: Array<{ file: string; className: string }> = [{ file: pythonFile, className }];
  while (queue.length > 0 && links.length < PYTHON_BASE_CHAIN_MAX_CLASSES) {
    const node = queue.shift()!;
    const nodeKey = `${fileKey(node.file)}::${node.className}`;
    if (seen.has(nodeKey)) {
      continue;
    }
    seen.add(nodeKey);
    const parsed = parseAt(node.file);
    const cls = parsed ? findClass(parsed, node.className) : undefined;
    if (!cls) {
      continue;
    }
    // includeSelf 只控制「自身是否入链」,不控制遍历起点:用独立的已处理标记,
    // 否则 includeSelf:false 时首个节点(links 仍为空)也判 isFirst → 首个祖先
    // 一并被跳过,整链返空(2026-11-24 单测逮住:hasMethod…InBaseChain 恒 false)
    const isFirst = !processed;
    processed = true;
    if (!isFirst || includeSelf) {
      links.push({ filePath: node.file, className: node.className, cls });
    }
    if (links.length >= PYTHON_BASE_CHAIN_MAX_CLASSES) {
      break;
    }
    for (const base of cls.bases) {
      if (!base || base === node.className) {
        continue;
      }
      // 同文件同名类直连(嵌套/别名父类常见形)
      if (parsed!.classes.some(item => item.name === base && item !== cls)) {
        queue.push({ file: node.file, className: base });
        continue;
      }
      // 跨文件:import 绑定解析(from X import Y [as Z] → 绑定键 Z,原符号 Y)
      const binding = parsed!.imports?.get(base);
      if (!binding) {
        continue; // 引擎内建/第三方:解析不到,如实不贡献方法
      }
      const targetClassName = binding.symbol ?? base;
      for (const candidate of pythonImportModuleCandidates(node.file, binding.module)) {
        const candidateParsed = parseAt(candidate);
        if (candidateParsed && findClass(candidateParsed, targetClassName)) {
          queue.push({ file: candidate, className: targetClassName });
          break; // Python import 取首个命中模块,不串目录
        }
      }
    }
  }
  return links;
}

/** 祖先链(不含自身)上是否已实现该方法——缺口判定用(自身面调用方已查过) */
export function hasMethodImplementationInBaseChain(
  pythonFile: string,
  className: string,
  methodName: string
): boolean {
  return walkPythonBaseChain(pythonFile, className, { includeSelf: false }).some(link =>
    link.cls.methods.has(methodName)
  );
}

/** 链上声明该方法的环节(自身在前,近祖先后):跳转落点用,最近声明者优先 */
export function findMethodLocationsInPythonBaseChain(
  pythonFile: string,
  className: string,
  methodName: string
): Array<{ filePath: string; line: number; character: number; className: string }> {
  const out: Array<{ filePath: string; line: number; character: number; className: string }> = [];
  for (const link of walkPythonBaseChain(pythonFile, className)) {
    const loc = link.cls.methods.get(methodName);
    if (loc) {
      out.push({ filePath: link.filePath, line: loc.line, character: loc.character, className: link.className });
    }
  }
  return out;
}

/** 链上方法名并集(含自身):parity 采集的已实现集用 */
export function collectPythonBaseChainMethodNames(pythonFile: string, className: string): Set<string> {
  const names = new Set<string>();
  for (const link of walkPythonBaseChain(pythonFile, className)) {
    for (const name of link.cls.methods.keys()) {
      names.add(name);
    }
  }
  return names;
}

/** 测试口径:规范化路径(与内部 fileKey 同式) */
export const normalizeChainFilePath = fileKey;
