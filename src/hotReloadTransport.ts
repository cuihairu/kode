/**
 * 重载通道抽象 (IDE-HOT-101):ReloadTransport 接口 + 两个内置实现。
 * 设计:docs/design/hot-reload-design.md §4。
 *
 * 通道 = 把一组文件「送达目标实例触发重载」的传输面。两个内置实现:
 * - 'kbengine-official' = KBEngine 官方方案:经 KBEngineTelnetClient 控制台对
 *   baseapp/cellapp 执行 KBEngine.reloadScript(fullReload)。引擎无 HTTP 回执
 *   协议(AUD-007 实勘),本实现只给「命令已发送/控制台已回显」级证据,
 *   绝不声称 applied。
 * - 'http' = 第三方 HTTP 方案:复用 HttpRequestEntry 模板(url/method/headers/
 *   body),扩展 ${files}(文件列表 JSON)/${fileList}(逗号分隔)占位;回包体走
 *   既有 accepted/applied 协议(HOT-003/004)解析,是唯一能产生 applied 证据
 *   的通道。
 *
 * 通道选择:resolveReloadTransport(部署配置下挂的 hotReload 段)→ 通道实现,
 * 未配/未知 → null(调用方回落既有 actionName quick action 通道)。
 *
 * 结构性 def 批不进任何通道:调用方(setupHotReload 的 HOT-005 结构闸)在
 * 通道 send 之前拦截,本模块不感知 def 结构(设计 §4.4)。接入火线(把通道
 * 送进 fire 路径)+ 配置面板是 IDE-HOT-102 的范围,本级交付抽象+实现+选择。
 */

import { defaultTransport as httpDefaultTransport, DEFAULT_HTTP_TIMEOUT_MS } from './httpRequestService';
import type { HttpRequestEntry } from './httpRequests';
import { resolveVariableExpression, type VariableContext } from './variableSubstitution';
import { KBEngineTelnetClient } from './telnetClient';

export type ReloadTransportKind = 'kbengine-official' | 'http';

/** 投递目标:rootId(文件归属扫描根)+ targetId(服务实例,如 baseapp/cellapp) */
export interface ReloadTarget {
  readonly rootId: string;
  readonly targetId: string;
}

/**
 * 回执流条目。'sent'=已发送/控制台已回显级证据(官方通道,引擎无回执协议,
 * 绝不 claim applied);'accepted'/'applied'=HTTP 通道按 HOT-003/004 协议
 * 解析(回包体逐字回显所发文件才认);'failed'=送达失败。
 */
export type ReloadReceipt =
  | { status: 'sent'; file?: string; detail: string }
  | { status: 'accepted'; file: string; digest?: string }
  | { status: 'applied'; file: string; digest?: string }
  | { status: 'failed'; file?: string; reason: string };

export interface ReloadSendSummary {
  readonly kind: ReloadTransportKind;
  readonly receipts: ReloadReceipt[];
}

export interface ReloadTransport {
  readonly kind: ReloadTransportKind;
  /** 连通性测试(配置面板按钮):HTTP=端点可达;官方=控制台可连 */
  probe(): Promise<{ ok: boolean; detail: string }>;
  /**
   * 发送一组文件重载。回执逐条经 onReceipt 推送;返回汇总(同批回执)。
   * 实现保证:官方通道不产生 applied;HTTP 通道仅在回包协议符合时产生
   * accepted/applied,未认到的文件落 'sent'(已送达无协议回执)。
   */
  send(
    target: ReloadTarget,
    fileSet: readonly string[],
    onReceipt: (receipt: ReloadReceipt) => void
  ): Promise<ReloadSendSummary>;
}

/** ${files} 文件列表占位(JSON 数组)与 ${fileList}(逗号分隔) */
export const RELOAD_FILES_PLACEHOLDER = '${files}';
export const RELOAD_FILE_LIST_PLACEHOLDER = '${fileList}';

/**
 * 替换重载专用占位 + 既有变量表:
 * ${files}=fileSet 的 JSON 数组;${fileList}=逗号分隔;其余 ${...} 走既有
 * 变量解析,未知占位原样保留(批105 口径),不吞。
 */
export function substituteReloadVariables(
  text: string,
  fileSet: readonly string[],
  context: VariableContext = { folders: [] }
): string {
  const filesJson = JSON.stringify(fileSet);
  const fileList = fileSet.join(',');
  return text.replace(/\$\{([^${}]*)\}/g, (raw, expression: string) => {
    const trimmed = expression.trim();
    if (trimmed === 'files') {
      return filesJson;
    }
    if (trimmed === 'fileList') {
      return fileList;
    }
    const resolved = resolveVariableExpression(expression, context);
    return resolved === undefined ? raw : resolved;
  });
}

/* ------------------------------------------------------------------ */
/* HTTP 通道                                                           */
/* ------------------------------------------------------------------ */

export interface ReloadHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface ReloadHttpResponse {
  status: number;
  body: string;
}

export type ReloadHttpRunner = (request: ReloadHttpRequest) => Promise<ReloadHttpResponse>;

export interface ReloadHttpDeps {
  run: ReloadHttpRunner;
  /** 既有变量表上下文(${module}/${filename}/... 等);缺省空 */
  context?: VariableContext;
}

/** 默认 HTTP 执行器:复用 httpRequestService 的纯 node http/https 传输面 */
export const defaultReloadHttpRunner: ReloadHttpRunner = request =>
  httpDefaultTransport({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    timeoutMs: DEFAULT_HTTP_TIMEOUT_MS
  }).then(result => ({ status: result.status, body: result.body }));

/**
 * 解析 HTTP 回包体为回执列表(HOT-003/004 协议口径):
 * - 数组=逐条;单对象=单条;非 JSON=全 'sent'(已送达,无协议回执)。
 * - 只认 file 与所发文件集逐字一致的条目;status 只认
 *   accepted/applied/failed,其余未记录状态不认。
 * - 未认到的文件补 'sent'(送达成功但无匹配回执,不 claim applied)。
 */
export function parseReloadHttpReceipts(body: string, fileSet: readonly string[]): ReloadReceipt[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fileSet.map(file => ({
      status: 'sent',
      file,
      detail: '回包非 JSON:已送达,无协议回执(不 claim applied)'
    }));
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const receipts: ReloadReceipt[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const file = typeof record.file === 'string' ? record.file : undefined;
    if (file === undefined || seen.has(file) || !fileSet.includes(file)) {
      continue;
    }
    const digest = typeof record.digest === 'string' ? record.digest : undefined;
    const status = record.status;
    if (status === 'accepted') {
      seen.add(file);
      receipts.push({ status: 'accepted', file, ...(digest !== undefined ? { digest } : {}) });
    } else if (status === 'applied') {
      seen.add(file);
      receipts.push({ status: 'applied', file, ...(digest !== undefined ? { digest } : {}) });
    } else if (status === 'failed') {
      seen.add(file);
      receipts.push({
        status: 'failed',
        file,
        reason: typeof record.reason === 'string' ? record.reason : '回执 failed 无原因'
      });
    }
  }
  for (const file of fileSet) {
    if (!seen.has(file)) {
      receipts.push({
        status: 'sent',
        file,
        detail: '已送达:无匹配 accepted/applied 回执(不 claim applied)'
      });
    }
  }
  return receipts;
}

export class HttpReloadTransport implements ReloadTransport {
  readonly kind = 'http' as const;

  constructor(
    private readonly entry: HttpRequestEntry,
    private readonly deps: ReloadHttpDeps
  ) {}

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const url = substituteReloadVariables(this.entry.url, [], this.deps.context);
    try {
      // 无副作用探测(KODE-AUD-009):probe 与真实 fire 请求分离——连通性
      // 测试发 GET 无体请求(HTTP 安全方法),不携带重载载荷(不用配置的
      // 重载 method、不发 body/${files} 占位),端点不会因探测而实际重载;
      // headers 保留(可能带鉴权),url 不替换文件占位。若端点仅认重载
      // method,探测如实报非 2xx,不再误触发重载。
      const response = await this.deps.run({
        url,
        method: 'GET',
        headers: this.entry.headers,
        body: ''
      });
      const ok = response.status >= 200 && response.status < 300;
      return {
        ok,
        detail: ok
          ? `端点可达(HTTP ${response.status})`
          : `端点不可达(HTTP ${response.status} 非 2xx)`
      };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async send(
    _target: ReloadTarget,
    fileSet: readonly string[],
    onReceipt: (receipt: ReloadReceipt) => void
  ): Promise<ReloadSendSummary> {
    const substitute = (text: string): string =>
      substituteReloadVariables(text, fileSet, this.deps.context);
    const request: ReloadHttpRequest = {
      url: substitute(this.entry.url),
      method: this.entry.method,
      headers: Object.fromEntries(
        Object.entries(this.entry.headers).map(([key, value]) => [key, substitute(value)])
      ),
      body: substitute(this.entry.body)
    };
    let response: ReloadHttpResponse;
    try {
      response = await this.deps.run(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const receipts = fileSet.map(file => ({ status: 'failed' as const, file, reason }));
      for (const receipt of receipts) {
        onReceipt(receipt);
      }
      return { kind: this.kind, receipts };
    }
    if (response.status < 200 || response.status >= 300) {
      const reason = `HTTP ${response.status}:非 2xx 送达失败`;
      const receipts = fileSet.map(file => ({ status: 'failed' as const, file, reason }));
      for (const receipt of receipts) {
        onReceipt(receipt);
      }
      return { kind: this.kind, receipts };
    }
    const receipts = parseReloadHttpReceipts(response.body, fileSet);
    for (const receipt of receipts) {
      onReceipt(receipt);
    }
    return { kind: this.kind, receipts };
  }
}

/* ------------------------------------------------------------------ */
/* KBEngine 官方通道                                                   */
/* ------------------------------------------------------------------ */

export interface ReloadOfficialConfig {
  host: string;
  port: number;
  password?: string;
  /** 全量重载(默认 true);false=增量 */
  fullReload?: boolean;
  /** 控制台命令;缺省 KBEngine.reloadScript(<fullReload>) */
  command?: string;
}

/** 控制台连接的极简面:真实实现由接线方用 KBEngineTelnetClient 适配 */
export interface ReloadTelnetConnection {
  connect(): void;
  disconnect(): void;
  isReady(): boolean;
  sendCommand(command: string): boolean;
  onData(listener: (text: string) => void): void;
  onClose(listener: (hadError: boolean) => void): void;
}

export type ReloadTelnetConnector = (config: ReloadOfficialConfig) => ReloadTelnetConnection;

export interface ReloadOfficialDeps {
  connect?: ReloadTelnetConnector;
  /** 等待控制台就绪;缺省轮询 isReady(默认 3s 超时) */
  waitForReady?: (conn: ReloadTelnetConnection, timeoutMs: number) => Promise<boolean>;
  /** 等待控制台回显的窗口(默认 800ms);0=不等回显 */
  awaitEchoMs?: number;
  timeoutMs?: number;
}

/** 默认连接器:包一层 KBEngineTelnetClient(纯 node net,无 vscode) */
export const defaultReloadTelnetConnector: ReloadTelnetConnector = config => {
  let dataListener: ((text: string) => void) | undefined;
  let closeListener: ((hadError: boolean) => void) | undefined;
  const client = new KBEngineTelnetClient({
    host: config.host,
    port: config.port,
    ...(config.password !== undefined ? { password: config.password } : {}),
    events: {
      onData: text => dataListener?.(text),
      onClose: hadError => closeListener?.(hadError)
    }
  });
  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    isReady: () => client.state === 'ready',
    sendCommand: command => client.sendCommand(command),
    onData: listener => {
      dataListener = listener;
    },
    onClose: listener => {
      closeListener = listener;
    }
  };
};

/** 默认就绪等待:轮询 isReady 至超时 */
export const defaultReloadWaitForReady = async (
  conn: ReloadTelnetConnection,
  timeoutMs: number
): Promise<boolean> => {
  const startedAt = Date.now();
  return new Promise(resolve => {
    const poll = (): void => {
      if (conn.isReady()) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(poll, 20);
    };
    conn.connect();
    poll();
  });
};

export class KbengineOfficialTransport implements ReloadTransport {
  readonly kind = 'kbengine-official' as const;

  constructor(
    private readonly config: ReloadOfficialConfig,
    private readonly deps: ReloadOfficialDeps = {}
  ) {}

  private readonly connector = (): ReloadTelnetConnector =>
    this.deps.connect ?? defaultReloadTelnetConnector;

  private readonly waitForReady = (conn: ReloadTelnetConnection): Promise<boolean> =>
    (this.deps.waitForReady ?? defaultReloadWaitForReady)(conn, this.deps.timeoutMs ?? 3000);

  private readonly command = (): string =>
    this.config.command ?? `KBEngine.reloadScript(${this.config.fullReload === false ? 'False' : 'True'})`;

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const conn = this.connector()(this.config);
    try {
      const ready = await this.waitForReady(conn);
      return ready
        ? { ok: true, detail: `控制台可连(${this.config.host}:${this.config.port})` }
        : { ok: false, detail: `控制台不可连(${this.config.host}:${this.config.port}):连接/就绪超时` };
    } finally {
      conn.disconnect();
    }
  }

  /** 等第一次回显(命令发送后 awaitEchoMs 窗口),超时/关闭返回空串 */
  private readonly captureEcho = (conn: ReloadTelnetConnection): Promise<string> => {
    const awaitEchoMs = this.deps.awaitEchoMs ?? 800;
    if (awaitEchoMs <= 0) {
      return Promise.resolve('');
    }
    return new Promise(resolve => {
      let done = false;
      let buffer = '';
      const finish = (): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve(buffer.trim());
      };
      conn.onData(text => {
        buffer += text;
        finish();
      });
      conn.onClose(() => finish());
      const timer = setTimeout(finish, awaitEchoMs);
    });
  };

  async send(
    _target: ReloadTarget,
    fileSet: readonly string[],
    onReceipt: (receipt: ReloadReceipt) => void
  ): Promise<ReloadSendSummary> {
    const conn = this.connector()(this.config);
    try {
      const ready = await this.waitForReady(conn);
      if (!ready) {
        const reason = `控制台不可用(${this.config.host}:${this.config.port}):连接/就绪超时`;
        const receipts = fileSet.map(file => ({ status: 'failed' as const, file, reason }));
        for (const receipt of receipts) {
          onReceipt(receipt);
        }
        return { kind: this.kind, receipts };
      }
      const command = this.command();
      if (!conn.sendCommand(command)) {
        const reason = '控制台未接受命令(非 ready 态或命令被拒)';
        const receipts = fileSet.map(file => ({ status: 'failed' as const, file, reason }));
        for (const receipt of receipts) {
          onReceipt(receipt);
        }
        return { kind: this.kind, receipts };
      }
      const echo = await this.captureEcho(conn);
      const detail = `命令已发送: ${command}${echo.length > 0 ? ` | 回显: ${echo}` : ''}(引擎无回执协议,不 claim applied)`;
      const receipts = fileSet.map(file => ({ status: 'sent' as const, file, detail }));
      for (const receipt of receipts) {
        onReceipt(receipt);
      }
      return { kind: this.kind, receipts };
    } finally {
      conn.disconnect();
    }
  }
}

/* ------------------------------------------------------------------ */
/* 通道选择                                                           */
/* ------------------------------------------------------------------ */

export interface ReloadChannelConfig {
  readonly channel: ReloadTransportKind;
  readonly http?: HttpRequestEntry;
  readonly official?: ReloadOfficialConfig;
}

export interface ReloadTransportDeps {
  http?: ReloadHttpDeps;
  official?: ReloadOfficialDeps;
}

/**
 * 按部署配置选择通道:channel='http' 且给 http 条目 → HTTP 通道;
 * channel='kbengine-official' 且给 official 参数 → 官方通道;
 * 未配(undefined)或字段缺失/未知 channel → null(调用方回落既有
 * actionName quick action 通道,行为与现状一致)。
 */
export function resolveReloadTransport(
  config: ReloadChannelConfig | undefined,
  deps: ReloadTransportDeps = {}
): ReloadTransport | null {
  if (!config) {
    return null;
  }
  if (config.channel === 'http' && config.http) {
    return new HttpReloadTransport(config.http, deps.http ?? { run: defaultReloadHttpRunner });
  }
  if (config.channel === 'kbengine-official' && config.official) {
    return new KbengineOfficialTransport(config.official, deps.official ?? {});
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 通道配置持久化校验(IDE-HOT-102)                                      */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 校验/归一 ReloadChannelConfig(IDE-HOT-102:profile 持久化读回):
 * 只认已记录字段,未知字段忽略;channel 未知或对应参数段缺失/畸形
 * 返回 undefined(调用方如实按「未配」处理,不猜测)。
 * 字段逐项宽松校验:缺省可省字段用类型默认,必填缺失即判畸形。
 */
export function normalizeReloadChannelConfig(value: unknown): ReloadChannelConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const channel = value.channel;
  if (channel !== 'http' && channel !== 'kbengine-official') {
    return undefined;
  }
  if (channel === 'http') {
    const http = value.http;
    if (!isRecord(http)) {
      return undefined;
    }
    if (typeof http.url !== 'string' || http.url.length === 0) {
      return undefined;
    }
    const headers: Record<string, string> = {};
    if (isRecord(http.headers)) {
      for (const [key, headerValue] of Object.entries(http.headers)) {
        if (typeof headerValue === 'string') {
          headers[key] = headerValue;
        }
      }
    }
    const entry: HttpRequestEntry = {
      name: typeof http.name === 'string' ? http.name : 'hot-reload',
      url: http.url,
      method: typeof http.method === 'string' ? http.method : 'POST',
      headers,
      body: typeof http.body === 'string' ? http.body : '',
      enabled: typeof http.enabled === 'boolean' ? http.enabled : true,
      keybinding: typeof http.keybinding === 'string' ? http.keybinding : ''
    };
    return { channel, http: entry };
  }
  const official = value.official;
  if (!isRecord(official)) {
    return undefined;
  }
  if (typeof official.host !== 'string' || official.host.length === 0) {
    return undefined;
  }
  const port = official.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  return {
    channel,
    official: {
      host: official.host,
      port,
      password: typeof official.password === 'string' ? official.password : undefined,
      fullReload: typeof official.fullReload === 'boolean' ? official.fullReload : undefined,
      command: typeof official.command === 'string' ? official.command : undefined
    }
  };
}
