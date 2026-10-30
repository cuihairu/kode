/**
 * 复现配置摘要(IDE-REL-007):诊断排障时「环境长什么样」的一页导出。
 * 五节如实渲染——活动版本(扩展 id@version + 构建提交)、根(workspace/
 * 索引扫描根/活动 profile 双根)、宿主角色(local|remote + 扩展宿主侧)、
 * 开关(kbengine.* 布尔项)、队列数据(诊断排队/在途、注解、索引任务、
 * schema 冷构建 + 语言服务在册操作)。连接信息两层遮蔽:
 * ① 连接行渲染时 username/password 永不落值(固定 ***);
 * ② 全文过 maskConnectionSecrets 兜底——password/token/secret/
 *   authorization 赋值与 URL userinfo 一律 ***,防任意字段(如 profile 名)
 * 混入凭据形态文本外泄。本模块只渲染,采集与遮蔽语义全部经测试锁。
 */

export interface ReproductionExtensionFact {
  id: string;
  version: string;
  active: boolean;
  /** 扩展宿主侧(workspace host | ui host),口径同扩展身份报告(MET-001) */
  side: string;
}

export interface ReproductionConnectionFact {
  /** 连接来源标识(如 engine-dbmgr:引擎 dbmgr 数据库接口配置) */
  source: string;
  host: string;
  port: number;
  username: string;
  databaseName: string;
  /** 引擎 <encrypt>:true=RSA 密文,kode 本就读不出明文 */
  encrypt: boolean;
}

export interface ReproductionSummaryInput {
  /** 宿主角色:label=local|remote(name)(hostLabel 口径),side=当前窗口扩展宿主侧 */
  host: { label: string; side: string };
  extensions: ReproductionExtensionFact[];
  buildCommit: string;
  workspaceFolders: string[];
  scanRoots: string[];
  profile: { name: string; assetsRoot: string; engineRoot: string } | null;
  switches: Array<{ key: string; on: boolean }>;
  queue: {
    diagnosticsQueued: number;
    diagnosticsInFlight: number;
    annotationUpdates: number;
    /** 注解索引共享构建在途量(IDE-REV-029):运行/等待/已全体取消收尾中 */
    annotationBuilds: { running: number; waiting: number; cancelled: number };
    /** 解析 worker 队列与字节占用(IDE-REV-030/IDE-AUD-023):区分 host
     * 等待(queued/queuedBytes,未投递)与已投递(running/postedBytes,worker
     * 在途);计数与字节双口径,保留输入一次可读——总保留=运行+排队任务、
     * 排队字节+在途字节,不能只凭 running 高或 queuedBytes=0 误读无积压 */
    worker: {
      running: number;
      queued: number;
      queuedBytes: number;
      maxQueuedBytes: number;
      peakQueuedBytes: number;
      budgetRejects: number;
      /** 已投递(worker 在途)源码串字节(AUD-022/023) */
      postedBytes: number;
      /** 在途任务数硬上限 */
      maxPostedJobs: number;
      /** 在途源码串字节硬上限 */
      maxPostedBytes: number;
    };
    /** 相关缓存容量面(IDE-REV-031):条目数与可获取的占用量、配置上限;
     * 无字节估算的缓存只报条目并注明口径,不把累计命中当容量 */
    caches: {
      parsedDocuments: { entries: number; maxEntries: number; bytes: number; maxBytes: number };
      databaseSchemas: { entries: number; capacity: number };
      annotationIndex: { entries: number; ttlMs: number };
    };
    indexTasksQueued: number;
    schemaColdBuilds: number;
  };
  /** 语言服务在册操作计数(MET-008 getActiveOperationCounts 口径) */
  activeOperations: Record<string, number>;
  connections: ReproductionConnectionFact[];
}

const SECRET_VALUE_PATTERN =
  /((?:password|passwd|token|secret|authorization)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n,;&]+)/gi;
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi;

/** 连接凭据遮蔽兜底:赋值形态(password=x / token: "y")与 URL userinfo → *** */
export function maskConnectionSecrets(text: string): string {
  return text
    .replace(SECRET_VALUE_PATTERN, '$1***')
    .replace(URL_USERINFO_PATTERN, '$1***@');
}

/** 连接行:username/password 永不落值(渲染层即遮蔽,不依赖兜底) */
export function renderConnectionLine(fact: ReproductionConnectionFact): string {
  return `${fact.source}: host=${fact.host} port=${fact.port} database=${fact.databaseName}`
    + ` username=*** password=*** encrypt=${fact.encrypt ? 'true' : 'false'}`;
}

export function renderReproductionSummary(input: ReproductionSummaryInput): string {
  const lines: string[] = ['Kode 复现配置摘要'];
  lines.push(`宿主角色: ${input.host.label}(${input.host.side})`);

  lines.push('活动版本:');
  if (input.extensions.length === 0) {
    lines.push('  无 cuihairu. 名下扩展');
  } else {
    for (const extension of input.extensions) {
      lines.push(`  ${extension.id}@${extension.version}`
        + ` active=${extension.active ? 'yes' : 'no'} side=${extension.side}`);
    }
    lines.push(`  构建提交: ${input.buildCommit}`);
  }

  lines.push('根:');
  for (const folder of input.workspaceFolders) {
    lines.push(`  workspace: ${folder}`);
  }
  for (const root of input.scanRoots) {
    lines.push(`  scan: ${root}`);
  }
  lines.push(input.profile
    ? `  profile: ${input.profile.name} assets=${input.profile.assetsRoot} engine=${input.profile.engineRoot}`
    : '  profile: 无(未选择活动 profile)');

  lines.push('开关:');
  for (const item of input.switches) {
    lines.push(`  ${item.key}: ${item.on ? 'on' : 'off'}`);
  }

  lines.push('队列:');
  lines.push(`  诊断排队=${input.queue.diagnosticsQueued}`
    + ` 诊断在途=${input.queue.diagnosticsInFlight}`
    + ` 注解待更新=${input.queue.annotationUpdates}`
    + ` 注解索引构建=运行${input.queue.annotationBuilds.running}`
      + `/等待${input.queue.annotationBuilds.waiting}`
      + `/已全取消${input.queue.annotationBuilds.cancelled}`
    + ` worker=运行${input.queue.worker.running}/排队${input.queue.worker.queued}`
    + ` worker排队字节=${input.queue.worker.queuedBytes}`
      + `/预算${input.queue.worker.maxQueuedBytes}`
      + `/峰值${input.queue.worker.peakQueuedBytes}`
      + `/超预算拒${input.queue.worker.budgetRejects}`
    + ` worker在途字节=${input.queue.worker.postedBytes}`
      + `/在途上限=数量${input.queue.worker.maxPostedJobs}`
      + `/字节${input.queue.worker.maxPostedBytes}`
    + ` worker总保留=任务${input.queue.worker.running + input.queue.worker.queued}`
      + `/字节${input.queue.worker.queuedBytes + input.queue.worker.postedBytes}`
    + ` 缓存:def文档=${input.queue.caches.parsedDocuments.entries}条`
      + `/上限${input.queue.caches.parsedDocuments.maxEntries}`
      + `/${input.queue.caches.parsedDocuments.bytes}B`
      + `/预算${input.queue.caches.parsedDocuments.maxBytes}B`
    + ` schema快照=${input.queue.caches.databaseSchemas.entries}条`
      + `/上限${input.queue.caches.databaseSchemas.capacity}`
    + ` 注解索引=${input.queue.caches.annotationIndex.entries}条`
      + `/TTL${input.queue.caches.annotationIndex.ttlMs}ms`
      + '(按工作区根,无字节估算)'
    + ` 索引任务=${input.queue.indexTasksQueued}`
    + ` schema冷构建=${input.queue.schemaColdBuilds}`);
  const operationEntries = Object.entries(input.activeOperations);
  lines.push(operationEntries.length === 0
    ? '  在册操作: 无'
    : `  在册操作: ${operationEntries.map(([name, count]) => `${name}=${count}`).join(' ')}`);

  lines.push('连接(已遮蔽):');
  if (input.connections.length === 0) {
    lines.push('  连接: 无(未解析到引擎数据库连接)');
  } else {
    for (const connection of input.connections) {
      lines.push(`  ${renderConnectionLine(connection)}`);
    }
  }

  return maskConnectionSecrets(lines.join('\n'));
}
