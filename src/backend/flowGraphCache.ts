/**
 * KFLOW 图增量失效(FLOW-013,G2 的增量失效核)。
 *
 * 验收:改实现/def/角色映射只更新相关节点和调用方;删除、重命名、未保存
 * 文本及跨根隔离有验证。
 *
 * 口径:
 *   - 解析缓存按 (rootKey, filePath, versionKey) 键控——versionKey 走宿主
 *     文档身份协议(不透明键;未保存文本=宿主编辑即换键,不存在脏读);
 *   - 「只更新相关」:文件换版只重解析该文件;装配(链接/场景)按依赖文件
 *     集合登记反向依赖,依赖集不含该文件的装配不失效;
 *   - 「调用方」=反向依赖:改实现文件 → 引用它的装配 stale(下次构建重建),
 *     其它装配原样复用;
 *   - 删除=解析丢弃+依赖装配全部 stale;重命名=旧路径删除+新路径解析
 *     (旧路径依赖 stale,不假装继承);
 *   - 跨根隔离:键含 rootKey,同路径异根互不影响;
 *   - 本核不管证(证据在 FLOW-004/007 面),只管「什么该重算」的账。
 */

import type { FlowCallResolverResult } from './flowCallResolver';

export interface FlowParseRequest {
  rootKey: string;
  filePath: string;
  versionKey: string;
  text: string;
}

export interface FlowAssemblyDep {
  rootKey: string;
  filePath: string;
  versionKey: string;
}

export interface FlowIncrementalIndexInput {
  /** 宿主解析装配(面推导/组件槽等由宿主按根配置注入);null=不可解析 */
  parse: (request: FlowParseRequest) => FlowCallResolverResult | null;
}

interface ParseEntry {
  versionKey: string;
  result: FlowCallResolverResult | null;
}

interface AssemblyEntry {
  /** depKey(rootKey,filePath) → 构建时 versionKey 快照 */
  deps: Map<string, string>;
  value: unknown;
}

export interface FlowIncrementalIndex {
  /** 更新/确保一个文件的解析;同键复用,换键重解析 */
  updateFile(request: FlowParseRequest): { action: 'parsed' | 'reused' };
  /** 删除:解析丢弃,返回受影响装配 key(调用方) */
  removeFile(rootKey: string, filePath: string): string[];
  /** 重命名:旧路径删除+新路径解析;返回旧路径受影响装配 key */
  renameFile(
    rootKey: string,
    fromPath: string,
    toPath: string,
    versionKey: string,
    text: string
  ): string[];
  /** 装配构建:依赖登记反向依赖;依赖版本未变复用,变了重建 */
  buildAssembly<T>(
    key: string,
    deps: ReadonlyArray<FlowAssemblyDep>,
    build: (resolve: (rootKey: string, filePath: string) => FlowCallResolverResult | null) => T
  ): { value: T; reused: boolean };
  /** 查询:哪些装配受这些文件变化影响(调用方面) */
  staleAssemblies(
    changedFiles: ReadonlyArray<{ rootKey: string; filePath: string }>
  ): string[];
  stats(): {
    parseCount: number;
    reuseCount: number;
    assemblyBuilds: number;
    assemblyReuses: number;
  };
}

const depKey = (rootKey: string, filePath: string): string => `${rootKey}\u001f${filePath}`;

export function createFlowIncrementalIndex(input: FlowIncrementalIndexInput): FlowIncrementalIndex {
  const parses = new Map<string, ParseEntry>();
  const assemblies = new Map<string, AssemblyEntry>();
  let parseCount = 0;
  let reuseCount = 0;
  let assemblyBuilds = 0;
  let assemblyReuses = 0;

  const affectedAssemblies = (rootKey: string, filePath: string): string[] => {
    const target = depKey(rootKey, filePath);
    const stale: string[] = [];
    for (const [key, entry] of assemblies) {
      if (entry.deps.has(target)) {
        stale.push(key);
      }
    }
    return stale;
  };

  const index: FlowIncrementalIndex = {
    updateFile(request) {
      const key = depKey(request.rootKey, request.filePath);
      const existing = parses.get(key);
      if (existing && existing.versionKey === request.versionKey) {
        reuseCount += 1;
        return { action: 'reused' };
      }
      const result = input.parse(request);
      parses.set(key, { versionKey: request.versionKey, result });
      parseCount += 1;
      return { action: 'parsed' };
    },

    removeFile(rootKey, filePath) {
      parses.delete(depKey(rootKey, filePath));
      return affectedAssemblies(rootKey, filePath);
    },

    renameFile(rootKey, fromPath, toPath, versionKey, text) {
      const stale = index.removeFile(rootKey, fromPath);
      index.updateFile({ rootKey, filePath: toPath, versionKey, text });
      return stale;
    },

    buildAssembly<T>(
      key: string,
      deps: ReadonlyArray<FlowAssemblyDep>,
      build: (resolve: (rootKey: string, filePath: string) => FlowCallResolverResult | null) => T
    ) {
      const existing = assemblies.get(key);
      if (existing && existing.deps.size === deps.length) {
        let unchanged = true;
        for (const dep of deps) {
          const dKey = depKey(dep.rootKey, dep.filePath);
          // 与「构建时快照」对比,不与调用方现在声明的键对比——
          // 文件自构建后换过版,无论调用方传什么键都必须重建
          const snapshot = existing.deps.get(dKey);
          const current = parses.get(dKey);
          if (snapshot === undefined || !current || current.versionKey !== snapshot) {
            unchanged = false;
            break;
          }
        }
        if (unchanged) {
          assemblyReuses += 1;
          return { value: existing.value as T, reused: true };
        }
      }
      const depSnapshot = new Map<string, string>();
      const resolve = (rootKey: string, filePath: string): FlowCallResolverResult | null =>
        parses.get(depKey(rootKey, filePath))?.result ?? null;
      for (const dep of deps) {
        depSnapshot.set(depKey(dep.rootKey, dep.filePath), dep.versionKey);
      }
      const value = build(resolve);
      assemblies.set(key, { deps: depSnapshot, value });
      assemblyBuilds += 1;
      return { value, reused: false };
    },

    staleAssemblies(changedFiles) {
      const stale = new Set<string>();
      for (const changed of changedFiles) {
        for (const key of affectedAssemblies(changed.rootKey, changed.filePath)) {
          stale.add(key);
        }
      }
      return [...stale];
    },

    stats() {
      return { parseCount, reuseCount, assemblyBuilds, assemblyReuses };
    }
  };
  return index;
}
