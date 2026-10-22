import { normalizeLookupPath } from './definitionSemantics';

// 语义依赖失效图(PR4 A4-2):entities.xml / .def / types.xml / alias.xml /
// Python 声明 的真实依赖边 + 定向失效计划。铁律:任何变更都不得推导出全仓
// 重建——InvalidationPlan.fullRebuild 恒 false,失效集合只含变更文件自身与
// 记录在案的依赖者(闭包)。
//
// 依赖方向:「派生物 dependsOn 来源」。.def 解析要读父链/接口/组件 .def 与
// types.xml/alias.xml → 子 .def 记 dependsOn 父 .def;类型注册表快照记
// dependsOn types.xml/alias.xml;Python owner 绑定记 dependsOn .def。
// 变更传播 = dependents 反向闭包(只沿已记录边,不猜全仓)。

export type SemanticFileKind =
  | 'entities-xml'
  | 'def'
  | 'types-xml'
  | 'alias-xml'
  | 'python'
  | 'other';

export type SemanticChangeKind = 'change' | 'create' | 'delete';

export function classifySemanticFile(filePath: string): SemanticFileKind {
  const normalized = normalizeLookupPath(filePath);
  if (normalized.endsWith('.def')) {
    return 'def';
  }
  if (normalized.endsWith('/types.xml')) {
    return 'types-xml';
  }
  if (normalized.endsWith('/alias.xml')) {
    return 'alias-xml';
  }
  if (normalized.endsWith('entities.xml')) {
    return 'entities-xml';
  }
  if (normalized.endsWith('.py')) {
    return 'python';
  }
  return 'other';
}

/** 定向失效计划:全仓重建被禁止,fullRebuild 恒 false(测试锁定) */
export interface InvalidationPlan {
  readonly changedFile: string;
  readonly changedKind: SemanticFileKind;
  readonly changeKind: SemanticChangeKind;
  /** 需重算的派生物(规范化路径,含变更文件自身) */
  readonly invalidateFiles: readonly string[];
  /** 类型注册表快照是否受影响(types.xml/alias.xml 变更) */
  readonly typeRegistryInvalidation: boolean;
  readonly fullRebuild: false;
}

interface DependencyRecord {
  /** 该文件的派生状态依赖的来源文件(规范化) */
  readonly dependsOn: Set<string>;
  /** 反向边:依赖该文件的派生物(规范化) */
  readonly dependents: Set<string>;
}

export class SemanticDependencyGraph {
  private readonly records = new Map<string, DependencyRecord>();

  /** 记录依赖边(file 的派生状态依赖 deps;幂等,全量替换该文件出边) */
  recordDependencies(file: string, deps: Iterable<string>): void {
    const normalizedFile = normalizeLookupPath(file);
    const nextDeps = new Set<string>();
    for (const dep of deps) {
      const normalizedDep = normalizeLookupPath(dep);
      if (normalizedDep !== normalizedFile && normalizedDep) {
        nextDeps.add(normalizedDep);
      }
    }
    const previous = this.records.get(normalizedFile);
    if (previous) {
      for (const dep of previous.dependsOn) {
        if (!nextDeps.has(dep)) {
          this.records.get(dep)?.dependents.delete(normalizedFile);
        }
      }
    }
    for (const dep of nextDeps) {
      let record = this.records.get(dep);
      if (!record) {
        record = { dependsOn: new Set(), dependents: new Set() };
        this.records.set(dep, record);
      }
      record.dependents.add(normalizedFile);
    }
    let record = this.records.get(normalizedFile);
    if (!record) {
      record = { dependsOn: new Set(), dependents: new Set() };
      this.records.set(normalizedFile, record);
    }
    record.dependsOn.clear();
    for (const dep of nextDeps) {
      record.dependsOn.add(dep);
    }
  }

  /** 文件离场(删除/索引移除):摘除其全部边 */
  removeFile(file: string): void {
    const normalized = normalizeLookupPath(file);
    const record = this.records.get(normalized);
    if (!record) {
      return;
    }
    for (const dep of record.dependsOn) {
      this.records.get(dep)?.dependents.delete(normalized);
    }
    for (const dependent of record.dependents) {
      this.records.get(dependent)?.dependsOn.delete(normalized);
    }
    this.records.delete(normalized);
  }

  getDependencies(file: string): readonly string[] {
    return [...this.records.get(normalizeLookupPath(file))?.dependsOn ?? []];
  }

  getDependents(file: string): readonly string[] {
    return [...this.records.get(normalizeLookupPath(file))?.dependents ?? []];
  }

  /**
   * 变更 → 定向失效计划。规则:
   * - 变更集 = {变更文件} ∪ 依赖者反向闭包(仅沿已记录边);
   * - types.xml/alias.xml:另置 typeRegistryInvalidation(类型注册表快照作废);
   * - create:尚无派生物记录,只失效文件自身;
   * - 恒不推导全仓重建(fullRebuild 恒 false)。
   */
  planInvalidation(changedFile: string, changeKind: SemanticChangeKind): InvalidationPlan {
    const normalized = normalizeLookupPath(changedFile);
    const kind = classifySemanticFile(changedFile);
    const invalidate = new Set<string>([normalized]);
    if (changeKind !== 'create') {
      const seen = new Set<string>([normalized]);
      const queue = [normalized];
      while (queue.length > 0) {
        const current = queue.shift() as string;
        for (const dependent of this.records.get(current)?.dependents ?? []) {
          if (!seen.has(dependent)) {
            seen.add(dependent);
            invalidate.add(dependent);
            queue.push(dependent);
          }
        }
      }
    }
    return {
      changedFile: normalized,
      changedKind: kind,
      changeKind,
      invalidateFiles: [...invalidate].sort(),
      typeRegistryInvalidation: kind === 'types-xml' || kind === 'alias-xml',
      fullRebuild: false
    };
  }

  clear(): void {
    this.records.clear();
  }
}
