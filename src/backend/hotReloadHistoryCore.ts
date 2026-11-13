/**
 * 热更历史库纯核(HR-PR-06,书 §19.4 ui-status):
 * - 零 vscode 导入、零 IO:容量/时钟注入,装配面(TreeView/面板/装饰)只消费
 *   本核的查询面,与 hotReloadSavePipeline 同边界;
 * - HR-UI-002/006/HR-MOD-014 字段形状:每条历史同时存 fullModule 与
 *   requestModule(HR-MOD-014)+fileUri/targetId/时间/请求 id/状态/错误摘要,
 *   树节点标题取 fullModule,tooltip 字段投影含 requestModule/URI/target/
 *   时间/请求 id——用户看到的名称与请求名称分开呈现(HR-UI-006);
 * - HR-UI-010/014 同路径不同 target 是两条独立历史(targetId 是行身份的
 *   一部分),过滤按 fullModule 子串(大小写不敏)/targetId/状态/时间范围;
 * - HR-UI-009 状态语义与 hotReloadStatus 同口径:sent-unverified 是 2xx 无
 *   业务回执的如实态,applied 只在引擎回执核验后;状态迁移单向
 *   sent-unverified→applied/failed,终态不回退(回退=伪造,拒并如实返回
 *   false),requestId 不存在也如实 false;
 * - HR-UI-007 高频合并:同 requestId 在合并窗内的多次更新合并为一条取末态
 *   (纯决策,UI 适配面拿合并结果决定重渲染节流),容量有界环形淘汰最旧;
 * - 分页窗口(offset/pageSize+total/hasMore)给虚拟滚动与增量加载用;
 * - 分组(recent/byFile/byTarget)供 HR-UI-002 树视图:组内保持最新在前。
 *
 * 装配接线(TreeView/面板注册、i18n 渲染、a11y、生命周期绑定)不在本核。
 */

/** HR-UI-009 状态口径(与 hotReloadStatus 同语义,独立枚举不引 vscode 面) */
export type HotReloadHistoryStatus = 'sent-unverified' | 'applied' | 'failed';

export interface HotReloadHistoryInput {
  /** 请求关联 id(HR-HTTP-014 每次执行生成;重放同 id=幂等替换不重复成行) */
  readonly requestId: string;
  /** 完整模块名(树标题/搜索主键,HR-UI-006) */
  readonly fullModule: string;
  /** 发送模块名(请求实际携带,HR-UI-006 详情) */
  readonly requestModule: string;
  /** 规范化文件路径(canonicalizeScriptFilePath 产物) */
  readonly fileUri: string;
  /** 目标环境 id(行身份的一部分:同文件不同目标=两行,HR-UI-010/014) */
  readonly targetId: string;
  /** 时钟毫秒 */
  readonly time: number;
  readonly status: HotReloadHistoryStatus;
  /** 失败/拦截摘要(如 HTTP 状态、错误分类;密钥/header 一律不落) */
  readonly errorSummary?: string;
}

/** 历史行(只读视图;状态更新经 updateStatus,外部不可变改) */
export type HotReloadHistoryEntry = HotReloadHistoryInput;

/** 单向迁移表:仅 sent-unverified 可推进;终态回退/自迁移一律拒 */
const ALLOWED_TRANSITIONS: Readonly<Record<HotReloadHistoryStatus, readonly HotReloadHistoryStatus[]>> = {
  'sent-unverified': ['applied', 'failed'],
  applied: [],
  failed: []
};

export interface HotReloadHistoryFilter {
  /** fullModule 大小写不敏子串匹配 */
  readonly fullModuleContains?: string;
  readonly targetId?: string;
  readonly fileUri?: string;
  readonly status?: HotReloadHistoryStatus;
  /** 时间范围含边界 [from,to];undefined=不限 */
  readonly timeFrom?: number;
  readonly timeTo?: number;
}

export interface HotReloadHistoryPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly hasMore: boolean;
}

export interface HotReloadHistoryOptions {
  /** 容量(缺省 200):超出淘汰最旧(HR-UI-007 上千记录靠分页+淘汰,不全量驻留) */
  readonly capacity?: number;
}

/** 合并输入:同 requestId 在窗内的更新序列 */
export interface HotReloadHistoryUpdate {
  readonly requestId: string;
  readonly status: HotReloadHistoryStatus;
  readonly time: number;
  readonly errorSummary?: string;
}

/**
 * HR-UI-007 高频合并(纯函数):同 requestId 在 windowMs 内的多条更新合并
 * 为一条取末条状态/时间(跨窗不合并);不同 requestId 各自独立。
 * 事件序按输入序(调用方保证时序);status 单向语义由调用方的历史库迁移
 * 面保证,本函数只做呈现层合并不改迁移规则。
 */
export function coalesceHistoryUpdates(
  updates: readonly HotReloadHistoryUpdate[],
  windowMs: number
): HotReloadHistoryUpdate[] {
  const out: HotReloadHistoryUpdate[] = [];
  const lastIndexByRequest = new Map<string, number>();
  for (const update of updates) {
    const lastIndex = lastIndexByRequest.get(update.requestId);
    if (
      lastIndex !== undefined &&
      update.time - out[lastIndex].time <= windowMs
    ) {
      out[lastIndex] = update;
      continue;
    }
    lastIndexByRequest.set(update.requestId, out.length);
    out.push(update);
  }
  return out;
}

/** HR-UI-006 树节点标题投影:fullModule 优先,缺如实占位 */
export function buildHistoryEntryLabel(entry: HotReloadHistoryEntry): string {
  return entry.fullModule.length > 0 ? entry.fullModule : entry.requestModule || '(unknown module)';
}

/** HR-UI-002/006 tooltip 字段投影(结构化行,UI 面再渲染;不拼 HTML) */
export function buildHistoryEntryTooltipLines(entry: HotReloadHistoryEntry): string[] {
  const lines: string[] = [];
  if (entry.fullModule.length > 0 && entry.requestModule !== entry.fullModule) {
    lines.push(`requestModule: ${entry.requestModule}`);
  }
  lines.push(`module: ${entry.fullModule || entry.requestModule}`);
  lines.push(`file: ${entry.fileUri}`);
  lines.push(`target: ${entry.targetId || '(default)'}`);
  lines.push(`time: ${new Date(entry.time).toISOString()}`);
  lines.push(`requestId: ${entry.requestId}`);
  lines.push(`status: ${entry.status}`);
  if (entry.errorSummary) {
    lines.push(`error: ${entry.errorSummary}`);
  }
  return lines;
}

/** 热更历史库(纯核):记录/推进/过滤/分组/分页 */
export class HotReloadHistoryCore {
  private readonly capacity: number;
  /** 插入序即新旧序(append-only;requestId 替换原位不动序) */
  private readonly rows: HotReloadHistoryEntry[] = [];
  private readonly indexByRequest = new Map<string, number>();

  constructor(options: HotReloadHistoryOptions = {}) {
    this.capacity = options.capacity ?? 200;
  }

  /** 自省:当前行数(测试/装配面核查) */
  size(): number {
    return this.rows.length;
  }

  /**
   * 记录一次发送。同 requestId 已存在 → 原位幂等替换(不重复成行,顺序
   * 不动);新 id 追加到最新位,超容量淘汰最旧并如实清其索引。
   */
  record(input: HotReloadHistoryInput): void {
    const existing = this.indexByRequest.get(input.requestId);
    if (existing !== undefined) {
      this.rows[existing] = { ...input };
      return;
    }
    this.rows.push({ ...input });
    this.indexByRequest.set(input.requestId, this.rows.length - 1);
    while (this.rows.length > this.capacity) {
      const evicted = this.rows.shift();
      if (evicted) {
        this.indexByRequest.delete(evicted.requestId);
      }
      // shift 后全体索引前移一位
      for (const [id, index] of this.indexByRequest) {
        this.indexByRequest.set(id, index - 1);
      }
    }
  }

  /**
   * HR-UI-009 状态推进:sent-unverified→applied(回执核验)或→failed。
   * 终态(applied/failed)不回退、同态自迁移拒——伪造回退如实拒并返回
   * false;requestId 不存在(已被淘汰/未记录)也如实 false。
   */
  updateStatus(requestId: string, status: HotReloadHistoryStatus, errorSummary?: string): boolean {
    const index = this.indexByRequest.get(requestId);
    if (index === undefined) {
      return false;
    }
    const current = this.rows[index];
    if (!ALLOWED_TRANSITIONS[current.status].includes(status)) {
      return false;
    }
    this.rows[index] = {
      ...current,
      status,
      ...(errorSummary !== undefined ? { errorSummary } : {})
    };
    return true;
  }

  /** 全量行(插入序,最旧在前);调用方要最新在前用 newestFirst */
  entries(): readonly HotReloadHistoryEntry[] {
    return [...this.rows];
  }

  /** 最新在前视图(HR-UI-002 最近更新组) */
  newestFirst(): readonly HotReloadHistoryEntry[] {
    return [...this.rows].reverse();
  }

  /** HR-UI-010 过滤:全条件 AND;fullModule 子串大小写不敏 */
  filter(query: HotReloadHistoryFilter): HotReloadHistoryEntry[] {
    const needle = query.fullModuleContains?.toLowerCase();
    return this.rows.filter(entry => {
      if (needle && !entry.fullModule.toLowerCase().includes(needle)) {
        return false;
      }
      if (query.targetId !== undefined && entry.targetId !== query.targetId) {
        return false;
      }
      if (query.fileUri !== undefined && entry.fileUri !== query.fileUri) {
        return false;
      }
      if (query.status !== undefined && entry.status !== query.status) {
        return false;
      }
      if (query.timeFrom !== undefined && entry.time < query.timeFrom) {
        return false;
      }
      if (query.timeTo !== undefined && entry.time > query.timeTo) {
        return false;
      }
      return true;
    });
  }

  /**
   * HR-UI-007 分页窗口(虚拟滚动/增量加载的数据面):offset 越界如实空页。
   */
  static page<T>(
    rows: readonly T[],
    offset: number,
    pageSize: number
  ): HotReloadHistoryPage<T> {
    const safeOffset = Math.max(0, offset);
    const safeSize = Math.max(1, pageSize);
    const items = rows.slice(safeOffset, safeOffset + safeSize);
    return {
      items,
      total: rows.length,
      hasMore: safeOffset + items.length < rows.length
    };
  }

  /** HR-UI-002 按文件分组:组键按首次出现序(最新在前遍历),组内最新在前 */
  static groupByFile(rows: readonly HotReloadHistoryEntry[]): Map<string, HotReloadHistoryEntry[]> {
    return HotReloadHistoryCore.groupBy(rows, entry => entry.fileUri);
  }

  /** HR-UI-002/014 按目标分组:同路径不同 target 落不同组 */
  static groupByTarget(rows: readonly HotReloadHistoryEntry[]): Map<string, HotReloadHistoryEntry[]> {
    return HotReloadHistoryCore.groupBy(rows, entry => entry.targetId);
  }

  private static groupBy(
    rows: readonly HotReloadHistoryEntry[],
    keyOf: (entry: HotReloadHistoryEntry) => string
  ): Map<string, HotReloadHistoryEntry[]> {
    const groups = new Map<string, HotReloadHistoryEntry[]>();
    for (const entry of rows) {
      const key = keyOf(entry);
      const bucket = groups.get(key);
      if (bucket) {
        bucket.push(entry);
      } else {
        groups.set(key, [entry]);
      }
    }
    return groups;
  }
}
