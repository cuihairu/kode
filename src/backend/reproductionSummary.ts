/**
 * Reproduction config summary (IDE-REL-007): a one-page export of "what the
 * environment looks like" for diagnostic troubleshooting.
 * Five sections rendered honestly — active versions (extension id@version +
 * build commit), roots (workspace / index scan roots / active profile dual
 * roots), host role (local|remote + extension host side), switches
 * (kbengine.* booleans), queue data (diagnostics queued/in flight,
 * annotations, index tasks, schema cold builds + language service active
 * operations). Connection info is masked at two layers:
 * ① when rendering connection lines username/password never get a value
 *   (fixed ***);
 * ② the whole text goes through maskConnectionSecrets as a backstop —
 *   password/token/secret/authorization assignments and URL userinfo are
 *   always ***, preventing any field (e.g. a profile name) from leaking
 *   credential-shaped text. This module only renders; collection and masking
 *   semantics are all locked by tests.
 */

export interface ReproductionExtensionFact {
  id: string;
  version: string;
  active: boolean;
  /** Extension host side (workspace host | ui host), same ruling as the extension identity report (MET-001) */
  side: string;
}

export interface ReproductionConnectionFact {
  /** Connection source identifier (e.g. engine-dbmgr: the engine dbmgr database interface config) */
  source: string;
  host: string;
  port: number;
  username: string;
  databaseName: string;
  /** Engine <encrypt>: true = RSA ciphertext, kode cannot read the plaintext in the first place */
  encrypt: boolean;
}

export interface ReproductionSummaryInput {
  /** Host role: label=local|remote(name) (hostLabel ruling), side=the current window's extension host side */
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
    /** Shared annotation index build in-flight counts (IDE-REV-029): running / waiting / all-cancelled wrapping up */
    annotationBuilds: { running: number; waiting: number; cancelled: number };
    /** Parse worker queue and byte usage (IDE-REV-030/IDE-AUD-023): distinguishes host
     * waiting (queued/queuedBytes, not yet posted) from posted (running/postedBytes, worker
     * in flight); dual count+byte ruling, retention input readable in one pass — total retention =
     * running + queued jobs, queued bytes + in-flight bytes; do not misread "no backlog" from a
     * high running alone or queuedBytes=0 alone */
    worker: {
      running: number;
      queued: number;
      queuedBytes: number;
      maxQueuedBytes: number;
      peakQueuedBytes: number;
      budgetRejects: number;
      /** Posted (worker in-flight) source text bytes (AUD-022/023) */
      postedBytes: number;
      /** Hard cap on the number of in-flight jobs */
      maxPostedJobs: number;
      /** Hard cap on in-flight source text bytes */
      maxPostedBytes: number;
    };
    /** Related cache capacity faces (IDE-REV-031): entry counts and obtainable usage, configured caps;
     * byte-less-estimated caches report entry counts only and note the ruling, never treating cumulative hits as capacity */
    caches: {
      parsedDocuments: { entries: number; maxEntries: number; bytes: number; maxBytes: number };
      databaseSchemas: { entries: number; capacity: number };
      annotationIndex: { entries: number; ttlMs: number };
    };
    indexTasksQueued: number;
    schemaColdBuilds: number;
  };
  /** Language service active operation counts (MET-008 getActiveOperationCounts ruling) */
  activeOperations: Record<string, number>;
  connections: ReproductionConnectionFact[];
}

const SECRET_VALUE_PATTERN =
  /((?:password|passwd|token|secret|authorization)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n,;&]+)/gi;
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi;

/** Connection credential masking backstop: assignment shapes (password=x / token: "y") and URL userinfo → *** */
export function maskConnectionSecrets(text: string): string {
  return text
    .replace(SECRET_VALUE_PATTERN, '$1***')
    .replace(URL_USERINFO_PATTERN, '$1***@');
}

/** Connection line: username/password never get a value (masked at the render layer, not relying on the backstop) */
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
