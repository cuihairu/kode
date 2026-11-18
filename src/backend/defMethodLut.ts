/**
 * def→python 方法跳转反查表纯核(DEF-LUT-001,巡检单 2026-10-20/2026-11-18
 * 用户拍板「执行」):门控放行后后台建全局反查表,def 方法 F12 从「按需懒构建
 * +慢速兜底等待(等索引/全项目扫描)」变 O(1) 查表。
 *
 * 铁律(任务书口径):
 * - LUT 是**加速层不是唯一真相**:命中直接答,missing 秒回空,表未含该条
 *   (miss)回落既有慢链——清空 LUT 后查询结果必须与慢链一致(钉子④)。
 * - 构建/查询/失效独立可测,零 vscode 依赖(IO 与文档打开由装配层注入)。
 * - 门控红线:未放行工作区零构建——构建调度只在门控放行后的预热完成回调
 *   (monitoring.ts)发起,本核自身零启动副作用。
 *
 * 失效口径(照抄 semanticIndex 快照仓思想,事件驱动精确作废):
 * - .def 变更 → removeDef(该 def 全部条目出表);
 * - .py 变更 → invalidatePythonFile(贡献者索引反查出受影响键,精确摘除);
 * - 代际(generation)每次出表/重建推进,供测试与打点断言失效确实发生。
 */
import { normalizeFileIdentity } from './pathIdentity';

// 磁盘版本纪律:defLUT 载荷形状变更时随 INDEX_CACHE_SCHEMA_VERSION 整体
// bump(indexDiskCache 既有语义:版本不符旧缓存整体弃用,不背兼容包袱)。

/** 跳转落点(与 EntityMappingManager 解析面同形:line 1 基) */
export interface DefMethodLutTarget {
  filePath: string;
  line: number;
  character: number;
}

/**
 * 单方法条目。implementations=属主/绑定面命中(listMethodImplementations
 * ByIdentity 同源);mroImplementations=属主外补充实现(父 def/接口约定链与
 * 全项目唯一名回退的落点);missing=true 表示全链(def 声明了,属主 py、
 * 约定链、全项目回退都)无实现——查询面据此秒回空,不再进兜底等待。
 */
export interface DefMethodLutEntry {
  /** 归属 def 文件(原始路径,查询侧与当前文档比对用) */
  defFile: string;
  /** def 声明行(1 基) */
  defDeclLine: number;
  section: string;
  implementations: DefMethodLutTarget[];
  mroImplementations: DefMethodLutTarget[];
  missing: boolean;
}

/**
 * 反查键:与 entityMappingHelpers.buildMethodOwnerBindingKey 同构
 * (ownerKind::ownerName::section::symbolName 小写连接)——该函数所在模块
 * 引 vscode,纯核不能引,故此处同式复刻;tests 钉等价测试锁两式不漂移。
 */
export function buildDefMethodLutKey(identity: {
  ownerKind: string;
  ownerName: string;
  section?: string;
  symbolName: string;
}): string {
  return [
    identity.ownerKind,
    identity.ownerName,
    identity.section || '',
    identity.symbolName
  ].join('::').toLowerCase();
}

/** 单 def 的磁盘条目:indexDiskCache 范式,stat 快照供恢复侧校验(漂移拒收) */
export interface DefLutDiskFile {
  defPath: string;
  mtimeMs: number;
  size: number;
  entries: Array<[string, DefMethodLutEntry]>;
}

interface DefTable {
  stat: { mtimeMs: number; size: number };
  entries: Map<string, DefMethodLutEntry>;
}

/** stat 校验注入面(恢复侧用;默认恒通过,装配层传 fs.stat 版) */
export type DefStatProbe = (defPath: string) => { mtimeMs: number; size: number } | null;

export interface DefMethodLutRestoreReport {
  adoptedDefs: number;
  rejectedDefs: number;
  adoptedEntries: number;
}

/**
 * 反查表本体:表按 def 分桶(整表重建=逐 def upsert 原子替换),贡献者索引
 * (py 文件 → 键集合)支撑 python 变更的精确作废。查询 getHit 三态:
 * hit(带落点)/ missing(秒回空)/ undefined(miss → 慢链)。
 */
export class DefMethodLut {
  private readonly tables = new Map<string, DefTable>();
  /** 归一化 def 路径 → 原始路径(磁盘载荷 defPath 还原用) */
  private readonly originalPaths = new Map<string, string>();
  private readonly contributors = new Map<string, Set<string>>();
  private generationCounter = 0;

  /** 当前代际:每次出表/恢复推进(失效断言与「重建确实发生」的测试面) */
  generation(): number {
    return this.generationCounter;
  }

  /** 条目总数(测试/打点取证) */
  size(): number {
    let total = 0;
    for (const table of this.tables.values()) {
      total += table.entries.size;
    }
    return total;
  }

  defFileCount(): number {
    return this.tables.size;
  }

  /**
   * 整 def 桶替换(后台重建的单位):旧桶的贡献者边先摘,再登记新桶。
   * generation 不推进(重建非失效;失效面由 removeDef/invalidatePythonFile
   * 承担,代际断言只对失效敏感)。
   */
  upsertDef(defFile: string, stat: { mtimeMs: number; size: number }, entries: Map<string, DefMethodLutEntry>): void {
    const key = normalizeFileIdentity(defFile);
    this.removeDefByKey(key);
    this.originalPaths.set(key, defFile);
    const table: DefTable = { stat, entries };
    this.tables.set(key, table);
    for (const [entryKey, entry] of entries) {
      this.addContributorEdges(key, entryKey, entry);
    }
  }

  /** def 变更作废:该 def 全部条目出表(条目级 generation 推进) */
  removeDef(defFile: string): number {
    return this.removeDefByKey(normalizeFileIdentity(defFile));
  }

  /** python 变更作废:贡献者索引反查受影响键,逐桶精确摘除对应条目 */
  invalidatePythonFile(pythonFile: string): number {
    const pyKey = normalizeFileIdentity(pythonFile);
    const affected = this.contributors.get(pyKey);
    if (!affected || affected.size === 0) {
      return 0;
    }
    this.contributors.delete(pyKey);
    let removed = 0;
    for (const defKey of [...this.tables.keys()]) {
      const table = this.tables.get(defKey)!;
      for (const entryKey of [...table.entries.keys()]) {
        if (!affected.has(`${defKey}\u0000${entryKey}`)) {
          continue;
        }
        table.entries.delete(entryKey);
        removed += 1;
      }
      if (table.entries.size === 0) {
        this.tables.delete(defKey);
      }
    }
    // 该 py 边已整组删除;其他 py 的贡献者边保留(键已出表,边成悬空无害,
    // 下次该 py 变更按空集早退——避免全表扫边清理的额外开销)
    if (removed > 0) {
      this.generationCounter += 1;
    }
    return removed;
  }

  /** 查询三态(钉子①②④):hit=有落点;missing=全链无实现秒回空;undefined=miss 走慢链 */
  getHit(key: string, defFile: string): { status: 'hit'; target: DefMethodLutTarget } | { status: 'missing' } | undefined {
    const table = this.tables.get(normalizeFileIdentity(defFile));
    if (!table) {
      return undefined;
    }
    const entry = table.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.implementations.length > 0) {
      return { status: 'hit', target: entry.implementations[0] };
    }
    if (entry.mroImplementations.length > 0) {
      return { status: 'hit', target: entry.mroImplementations[0] };
    }
    return entry.missing ? { status: 'missing' } : undefined;
  }

  /** 条目直读(测试/取证面;查询面走 getHit) */
  getEntry(key: string, defFile: string): DefMethodLutEntry | undefined {
    return this.tables.get(normalizeFileIdentity(defFile))?.entries.get(key);
  }

  /** 全部 def 桶快照(磁盘落盘载荷;空表返回 [] 而非 null——空表也是事实) */
  capture(): DefLutDiskFile[] {
    const files: DefLutDiskFile[] = [];
    for (const [defKey, table] of this.tables) {
      files.push({
        defPath: this.originalPaths.get(defKey) ?? defKey,
        mtimeMs: table.stat.mtimeMs,
        size: table.stat.size,
        entries: [...table.entries.entries()]
      });
    }
    return files;
  }

  /**
   * 磁盘恢复(钉子⑥):逐 def stat 校验(漂移/缺失拒收该桶,照旧后台重建;
   * 版本门由 indexDiskCache meta 承担)。恢复本身不推进 generation(空表
   * 恢复非失效;随后预热完成的后台重建 upsertDef 自然接管)。
   */
  restore(files: DefLutDiskFile[] | undefined, statOf: DefStatProbe = () => ({ mtimeMs: 0, size: 0 })): DefMethodLutRestoreReport {
    const report: DefMethodLutRestoreReport = { adoptedDefs: 0, rejectedDefs: 0, adoptedEntries: 0 };
    if (!files || files.length === 0) {
      return report;
    }
    for (const file of files) {
      if (!Array.isArray(file.entries)) {
        report.rejectedDefs += 1;
        continue;
      }
      const stat = statOf(file.defPath);
      if (!stat || stat.mtimeMs !== file.mtimeMs || stat.size !== file.size) {
        report.rejectedDefs += 1;
        continue;
      }
      this.upsertDef(file.defPath, { mtimeMs: file.mtimeMs, size: file.size }, new Map(file.entries));
      report.adoptedDefs += 1;
      report.adoptedEntries += file.entries.length;
    }
    return report;
  }

  private removeDefByKey(defKey: string): number {
    const table = this.tables.get(defKey);
    if (!table) {
      return 0;
    }
    this.tables.delete(defKey);
    this.originalPaths.delete(defKey);
    const removed = table.entries.size;
    if (removed > 0) {
      this.generationCounter += 1;
    }
    return removed;
  }

  private addContributorEdges(defKey: string, entryKey: string, entry: DefMethodLutEntry): void {
    for (const target of [...entry.implementations, ...entry.mroImplementations]) {
      const pyKey = normalizeFileIdentity(target.filePath);
      let edges = this.contributors.get(pyKey);
      if (!edges) {
        edges = new Set<string>();
        this.contributors.set(pyKey, edges);
      }
      edges.add(`${defKey}\u0000${entryKey}`);
    }
  }
}
