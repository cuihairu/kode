import { normalizeLookupPath } from './definitionSemantics';

// 统一语义查询层(PR4,用户令 2026-10-23):多资产根模型 + 实体/Python类/类型
// 注册关系的统一承载。查询 API 只返回条目与快照拷贝,不暴露内部 Map/遍历——
// 消费端(EntityMappingManager 等)不允许自行扫描索引内部结构。
//
// 查找顺序显式策略(A4-5/A4-6 取证固化,不改行为只立约):
// ① 同名实体:语义索引按注册序保存「每个实体名单一胜者」,后注册者覆盖先者
//    ——与既有 EntityMappingManager.mappingIndexes(Map.set 同名覆盖)逐字节
//    一致;冲突全根清单经 findEntityConflicts 暴露供取证/诊断,不静默吞掉。
// ② Python 文件 → 实体:owner 归属文件精确匹配优先,未命中再按
//    basename(去 .py)对实体名回落——与既有 findIndexForPythonFile 两段式
//    一致;owner 匹配多个时取注册序首个(既有 [...values()].find 语义)。
// ③ 根顺序:registerRoot 显式登记(工作区根在前、外部资产根按声明序),
//    查询按该显式序列裁断,不依赖任何 Map 插入序。

export interface SemanticRootDescriptor {
  /** 稳定根 ID = 规范化路径(小写斜杠),跨平台可比较 */
  readonly rootId: string;
  readonly normalizedPath: string;
  /** 显式查找序(0 起),登记时分配,与 Map 插入序无关 */
  readonly order: number;
}

/** 实体注册条目(EntityMappingManager 存索引时提交的语义投影) */
export interface SemanticEntityRegistration {
  readonly rootId: string;
  readonly entityName: string;
  /** 规范化 .def 路径 */
  readonly defFile: string;
  /** 规范化 owner 归属 Python 文件(注册序保持提交顺序) */
  readonly pythonFiles: readonly string[];
  /** owner 归属(kind+名,注册序;实体/接口/组件各段去重) */
  readonly owners: readonly SemanticOwnerRef[];
}

export interface SemanticOwnerRef {
  readonly kind: string;
  readonly name: string;
}

export interface SemanticEntityEntry {
  readonly rootId: string;
  readonly entityName: string;
  readonly defFile: string;
  readonly pythonFiles: readonly string[];
  readonly owners: readonly SemanticOwnerRef[];
}

/** 类型注册表快照(A4-3):查询纯内存,重建只由更新事件驱动 */
export interface SemanticTypeRegistrySnapshot<T = unknown> {
  readonly rootId: string;
  readonly aliasDiscovery: boolean;
  /** 快照代号:事件失效后自增,观测/指标用 */
  readonly generation: number;
  /** 快照依赖的物理文件(规范化):失效通知按此精确裁断 */
  readonly dependencies: readonly string[];
  /** 注册表条目(结构由调用方持有,如 CustomTypeInfo[]) */
  readonly entries: readonly T[];
}

interface EntityRecord {
  entry: SemanticEntityEntry;
}

interface TypeRegistryRecord<T = unknown> {
  snapshot: SemanticTypeRegistrySnapshot<T>;
}

export class SemanticIndex {
  private readonly roots = new Map<string, SemanticRootDescriptor>();
  private rootOrderCounter = 0;
  /** 实体名 → 单一胜者(后注册覆盖,策略①) */
  private readonly entitiesByName = new Map<string, EntityRecord>();
  /** 全根实体清单(同名冲突取证):规范化 def 路径 → 条目 */
  private readonly entitiesByDefFile = new Map<string, EntityRecord>();
  /** owner 归属文件 → 实体列表(注册顺序,规范化路径) */
  private readonly entitiesByPythonOwner = new Map<string, EntityRecord[]>();
  /** Python 类名 → 实体(先到先得,与既有 ownerName 扫描序一致) */
  private readonly entitiesByClassName = new Map<string, EntityRecord>();
  /** kind:name → 实体(先到先得,接口/组件符号回溯用) */
  private readonly entitiesByOwnerRef = new Map<string, EntityRecord>();
  private readonly typeRegistry = new Map<string, TypeRegistryRecord>();
  private typeRegistryGeneration = 0;

  // ---- 根模型(A4-5) ----

  /** 登记扫描根(规范化路径幂等):返回稳定 rootId */
  registerRoot(rootPath: string): string {
    const normalizedPath = normalizeLookupPath(rootPath);
    const existing = this.roots.get(normalizedPath);
    if (existing) {
      return existing.rootId;
    }
    const rootId = normalizedPath;
    this.roots.set(normalizedPath, {
      rootId,
      normalizedPath,
      order: this.rootOrderCounter
    });
    this.rootOrderCounter += 1;
    return rootId;
  }

  /** 根清单(显式 order 升序,拷贝) */
  getRoots(): readonly SemanticRootDescriptor[] {
    return [...this.roots.values()].sort((left, right) => left.order - right.order);
  }

  /** 文件所属根(最长前缀命中;无根归属返回 null) */
  resolveRootIdForPath(filePath: string): string | null {
    const normalized = normalizeLookupPath(filePath);
    let best: SemanticRootDescriptor | null = null;
    for (const root of this.roots.values()) {
      if ((normalized === root.normalizedPath || normalized.startsWith(`${root.normalizedPath}/`))
        && (!best || root.normalizedPath.length > best.normalizedPath.length)) {
        best = root;
      }
    }
    return best ? best.rootId : null;
  }

  // ---- 实体注册与查询 ----

  /** 注册实体语义投影(同名覆盖=策略①;py owner/类名先到先得=策略②③) */
  registerEntity(registration: SemanticEntityRegistration): SemanticEntityEntry {
    const entry: SemanticEntityEntry = {
      rootId: registration.rootId,
      entityName: registration.entityName,
      defFile: normalizeLookupPath(registration.defFile),
      pythonFiles: registration.pythonFiles.map(normalizeLookupPath),
      owners: [...registration.owners]
    };
    this.removeEntityByDefFile(entry.defFile);
    const record: EntityRecord = { entry };
    this.entitiesByName.set(entry.entityName, record);
    this.entitiesByDefFile.set(entry.defFile, record);
    for (const pythonFile of entry.pythonFiles) {
      const owners = this.entitiesByPythonOwner.get(pythonFile) ?? [];
      if (!owners.includes(record)) owners.push(record);
      this.entitiesByPythonOwner.set(pythonFile, owners);
    }
    for (const owner of entry.owners) {
      if (owner.name && !this.entitiesByClassName.has(owner.name)) {
        this.entitiesByClassName.set(owner.name, record);
      }
      const ownerKey = `${owner.kind}:${owner.name}`;
      if (owner.name && !this.entitiesByOwnerRef.has(ownerKey)) {
        this.entitiesByOwnerRef.set(ownerKey, record);
      }
    }
    return entry;
  }

  /** 按 .def 路径移除实体注册(定向失效),返回被移除条目或 null */
  removeEntityByDefFile(defFile: string): SemanticEntityEntry | null {
    const normalized = normalizeLookupPath(defFile);
    const record = this.entitiesByDefFile.get(normalized);
    if (!record) {
      return null;
    }
    if (this.entitiesByName.get(record.entry.entityName) === record) {
      this.entitiesByName.delete(record.entry.entityName);
    }
    for (const [pythonFile, owners] of this.entitiesByPythonOwner) {
      const remaining = owners.filter(owner => owner !== record);
      if (remaining.length) this.entitiesByPythonOwner.set(pythonFile, remaining);
      else this.entitiesByPythonOwner.delete(pythonFile);
    }
    for (const [className, owner] of this.entitiesByClassName) {
      if (owner === record) {
        this.entitiesByClassName.delete(className);
      }
    }
    for (const [ownerKey, owner] of this.entitiesByOwnerRef) {
      if (owner === record) {
        this.entitiesByOwnerRef.delete(ownerKey);
      }
    }
    this.entitiesByDefFile.delete(normalized);
    return record.entry;
  }

  clearEntities(): void {
    this.entitiesByName.clear();
    this.entitiesByDefFile.clear();
    this.entitiesByPythonOwner.clear();
    this.entitiesByClassName.clear();
    this.entitiesByOwnerRef.clear();
  }

  getEntityNames(): readonly string[] {
    return [...this.entitiesByName.keys()];
  }

  /** 实体名 → .def 路径(单一胜者,策略①) */
  getEntityDefFile(entityName: string): string | null {
    return this.entitiesByName.get(entityName)?.entry.defFile ?? null;
  }

  /** 实体名 → 全部 def 文件(IDE-IDX-003:同名实体按调用根挑选,不做单一胜者) */
  getEntityDefFilesByName(entityName: string): string[] {
    const out: string[] = [];
    for (const [defFile, record] of this.entitiesByDefFile) {
      if (record.entry.entityName === entityName) { out.push(defFile); }
    }
    return out;
  }

  /** 实体名 → 条目拷贝 */
  findEntityByName(entityName: string): SemanticEntityEntry | null {
    return this.entitiesByName.get(entityName)?.entry ?? null;
  }

  /** 同名实体全根清单(冲突取证,注册序) */
  findEntityConflicts(entityName: string): readonly SemanticEntityEntry[] {
    const winner = this.entitiesByName.get(entityName)?.entry ?? null;
    const conflicts = [...this.entitiesByDefFile.values()]
      .map(record => record.entry)
      .filter(entry => entry.entityName === entityName);
    // 胜者排首,其余按注册序
    return conflicts.sort((left, right) =>
      (left === winner ? -1 : right === winner ? 1 : 0));
  }

  /** Python 文件 → 实体:owner 精确匹配优先,实体名回落(策略②) */
  findEntityByPythonFile(pythonFile: string): SemanticEntityEntry | null {
    const normalized = normalizeLookupPath(pythonFile);
    const ownerRecord = this.entitiesByPythonOwner.get(normalized)?.[0];
    if (ownerRecord) {
      return ownerRecord.entry;
    }
    // 实体名回落保持既有大小写敏感口径(原 path.basename 原样比对,不规范化)
    const baseName = pythonFile.replace(/\\/g, '/').split('/').pop()
      ?.replace(/\.py$/i, '') ?? '';
    return this.entitiesByName.get(baseName)?.entry ?? null;
  }

  /** Python 文件 → owner 归属实体(不做实体名回落;变更裁断用) */
  findEntitiesByPythonOwner(pythonFile: string): readonly SemanticEntityEntry[] {
    const records = this.entitiesByPythonOwner.get(normalizeLookupPath(pythonFile)) ?? [];
    return records.map(record => record.entry);
  }

  /** Python 类名 → owner 实体(既有 ownerName 回溯口径) */
  findEntityByClassName(className: string): SemanticEntityEntry | null {
    return this.entitiesByClassName.get(className)?.entry ?? null;
  }

  /** owner(kind+名)归属实体(接口/组件符号回溯,注册序首中) */
  findEntitiesByOwner(kind: string, name: string): readonly SemanticEntityEntry[] {
    const record = this.entitiesByOwnerRef.get(`${kind}:${name}`);
    return record ? [record.entry] : [];
  }

  // ---- 类型注册表快照(A4-3) ----

  /**
   * 纯内存快照查询:不做任何文件系统检查(statSync 指纹已废除)。
   * 键 = 规范化根路径 + aliasDiscovery 开关;未命中返回 undefined,由调用方
   * 构建后 storeTypeRegistrySnapshot 回存。
   */
  getTypeRegistrySnapshot<T = unknown>(rootPath: string, aliasDiscovery: boolean): SemanticTypeRegistrySnapshot<T> | undefined {
    const key = this.typeRegistryKey(rootPath, aliasDiscovery);
    return this.typeRegistry.get(key)?.snapshot as SemanticTypeRegistrySnapshot<T> | undefined;
  }

  storeTypeRegistrySnapshot<T>(
    rootPath: string,
    aliasDiscovery: boolean,
    entries: readonly T[],
    dependencies: readonly string[]
  ): SemanticTypeRegistrySnapshot<T> {
    this.typeRegistryGeneration += 1;
    const snapshot: SemanticTypeRegistrySnapshot<T> = {
      rootId: normalizeLookupPath(rootPath),
      aliasDiscovery,
      generation: this.typeRegistryGeneration,
      dependencies: dependencies.map(normalizeLookupPath),
      entries: [...entries]
    };
    this.typeRegistry.set(this.typeRegistryKey(rootPath, aliasDiscovery), { snapshot });
    return snapshot;
  }

  /**
   * 更新事件驱动失效(A4-3):物理文件变更通知 → 仅作废依赖该文件的快照。
   * types.xml/alias.xml 路径由快照 dependencies 精确裁断;path 传空视为全量作废
   * (测试/关停面用,生产热路径不走)。
   */
  notifySemanticFilesChanged(changedFiles: readonly string[]): number {
    const changed = new Set(changedFiles.map(normalizeLookupPath));
    let invalidated = 0;
    for (const [key, record] of this.typeRegistry) {
      const hit = changed.size === 0
        || record.snapshot.dependencies.some(dependency => changed.has(dependency));
      if (hit) {
        this.typeRegistry.delete(key);
        invalidated += 1;
      }
    }
    return invalidated;
  }

  getTypeRegistrySnapshotCount(): number {
    return this.typeRegistry.size;
  }

  getTypeRegistryGeneration(): number {
    return this.typeRegistryGeneration;
  }

  private typeRegistryKey(rootPath: string, aliasDiscovery: boolean): string {
    return `${normalizeLookupPath(rootPath)}#${aliasDiscovery ? '1' : '0'}`;
  }
}

/** types.xml/alias.xml 判别(失效通知路由用) */
export function isTypeRegistryFile(filePath: string): boolean {
  const normalized = normalizeLookupPath(filePath);
  return normalized.endsWith('/types.xml') || normalized.endsWith('/alias.xml');
}

// 进程级共享实例:仅承载类型注册表快照仓(definitionWorkspace 查询与
// EntityMappingManager 的失效通知必须命中同一份)。实体注册表由各
// EntityMappingManager 自持(测试互不污染),不共享。
let sharedTypeRegistryIndex: SemanticIndex | null = null;

export function getSemanticIndex(): SemanticIndex {
  if (!sharedTypeRegistryIndex) {
    sharedTypeRegistryIndex = new SemanticIndex();
  }
  return sharedTypeRegistryIndex;
}

/** 测试面:重置共享类型注册表快照仓(实体注册表不在共享实例里) */
export function resetSemanticTypeRegistryForTests(): void {
  sharedTypeRegistryIndex = new SemanticIndex();
}
