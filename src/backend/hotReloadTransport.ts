/**
 * 重载通道抽象 (IDE-HOT-101):ReloadTransport 接口 + 两个内置实现。
 * 设计:docs/design/hot-reload-design.md §4。
 *
 * 通道 = 把一组文件「送达目标实例触发重载」的传输面。两个内置实现:
 * - 'kbengine-official' = KBEngine 官方方案:经 KBEngineTelnetClient 控制台对
 *   baseapp/cellapp 执行 KBEngine.reloadScript(fullReload)。引擎无 HTTP 回执
 *   协议(AUD-007 实勘),本实现只给「命令已发送/控制台已回显」级证据,
 *   普通引擎保持未确认；带 demo observer 的进程可返回带指纹的执行回执。
 * - 'http' = HTTP/xreload 方案:复用 HttpRequestEntry 模板(url/method/headers/
 *   body),扩展 ${files}(文件列表 JSON)/${fileList}(逗号分隔)占位;回包体走
 *   既有 accepted/applied 协议(HOT-003/004)解析；官方通道通过 demo
 *   observer 也可返回同形核验回执。
 *
 * 通道选择:resolveReloadTransport(部署配置下挂的 hotReload 段)→ 通道实现,
 * 未配/未知 → null(调用方回落既有 actionName quick action 通道)。
 *
 * 结构性 def 批不进任何通道:调用方(setupHotReload 的 HOT-005 结构闸)在
 * 通道 send 之前拦截,本模块不感知 def 结构(设计 §4.4)。接入火线(把通道
 * 送进 fire 路径)+ 配置面板是 IDE-HOT-102 的范围,本级交付抽象+实现+选择。
 */

import { defaultTransport as httpDefaultTransport, DEFAULT_HTTP_TIMEOUT_MS } from './httpRequestService';
import { decideHttpEndpoint } from './httpEndpointPolicy';
import { formatReloadTransportThrownError } from './hotReloadTransportErrors';
import { sendErrorToEndpointHealth, sendStatusToEndpointHealth } from './hotReloadEndpointHealth';
import type { HttpRequestEntry } from './httpRequests';
import { BUILTIN_HTTP_REQUEST_EXAMPLE } from './httpRequests';
import { resolveVariableExpression, type VariableContext } from './variableSubstitution';
import { KBEngineTelnetClient } from './telnetClient';
import { randomUUID } from 'crypto';

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
  | { status: 'sent'; file?: string; detail: string; requestId?: string }
  | {
      status: 'accepted';
      file: string;
      digest?: string;
      note?: string;
      /** F4:回执显式 targetId(与预期目标不一致的回执在解析层被拒绝) */
      targetId?: string;
      /**
       * RUST-420(HR-QA-008):端点策略安全警告(已授权非 loopback 时随回执
       * 携带,台账逐次可见)。缺省不带;与协议侧 note 分开,不互混。
       */
      detail?: string;
      /** F5(关联 id):该回执所属发送请求的关联标识(发送侧逐发送生成) */
      requestId?: string;
    }
  | {
      status: 'applied';
      file: string;
      digest?: string;
      revision?: number;
      /** F4:回执显式 targetId(与预期目标不一致的回执在解析层被拒绝) */
      targetId?: string;
      /**
       * RUST-420(HR-QA-008):端点策略安全警告(同 accepted——applied 无协议
       * 文本字段,安全警告经此携带)。缺省不带。
       */
      detail?: string;
      /** F5(关联 id):该回执所属发送请求的关联标识(发送侧逐发送生成) */
      requestId?: string;
    }
  | { status: 'failed'; file?: string; reason: string; targetId?: string; requestId?: string };

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
   * F3 三轮:senderDigests=发送时点冻结的内容 sha256(file → hex,可选)——
   * 随报文下发(sender_digests 字段),接收端据此对应用产物核验后才能回
   * applied;不给则接收端无法按发送方冻结基准核验,不会回 applied。
   */
  send(
    target: ReloadTarget,
    fileSet: readonly string[],
    onReceipt: (receipt: ReloadReceipt) => void,
    senderDigests?: ReadonlyMap<string, string>
  ): Promise<ReloadSendSummary>;
}

/** ${files} 文件列表占位(JSON 数组)与 ${fileList}(逗号分隔) */
export const RELOAD_FILES_PLACEHOLDER = '${files}';
export const RELOAD_FILE_LIST_PLACEHOLDER = '${fileList}';
/** F4:${targetId}=发送目标标识(通道侧替换,请求可区分/寻址目标实例) */
export const RELOAD_TARGET_ID_PLACEHOLDER = '${targetId}';

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
  maxResponseBytes?: number;
}

export interface ReloadHttpResponse {
  status: number;
  body: string;
  bodyTruncated?: true;
}

export type ReloadHttpRunner = (request: ReloadHttpRequest) => Promise<ReloadHttpResponse>;

/**
 * F5(关联 id):发送侧逐发送生成的关联标识。JSON 对象请求体自动附加
 * request_id(模板已显式给出则不覆盖);接收端按契约逐字回显,发送侧据此
 * 把回执精确归到所属那次发送(跨发送乱序/迟到回执不再靠 targetId+file
 * 猜)。单调序列+时钟+随机尾,唯一下界=同一进程生命周期内不重复。
 */
let nextRequestSeq = 0;
export function generateReloadRequestId(): string {
  nextRequestSeq += 1;
  return `req-${Date.now().toString(36)}-${nextRequestSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * HTTP 通道请求构造单一来源(RUST-358/HR-HTTP-016):send 与 preview 共用
 * 同一构造,预览与实际发送逐字节同形(防漂移)。${targetId} 占位先于变量
 * 替换替换为发送目标标识;JSON 对象请求体自动附加 targetId(F4 二轮)与
 * sender_digests(F3 三轮,模板已显式给出则不覆盖;未给 digests 时如实
 * 不附加——预览无基准 digest 就不伪造该字段)。request_id(F5 关联 id)
 * 同形附加:未给(预览零发送)就不附加,不伪造关联。
 */
export function buildReloadHttpRequest(
  entry: HttpRequestEntry,
  target: ReloadTarget,
  fileSet: readonly string[],
  context?: VariableContext,
  senderDigests?: ReadonlyMap<string, string>,
  requestId?: string
): ReloadHttpRequest {
  const substitute = (text: string): string =>
    substituteReloadVariables(
      text.split(RELOAD_TARGET_ID_PLACEHOLDER).join(target.targetId),
      fileSet,
      context
    );
  const autoAttachTargetId = (text: string): string => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        !('targetId' in (parsed as Record<string, unknown>))
      ) {
        return JSON.stringify({ ...(parsed as Record<string, unknown>), targetId: target.targetId });
      }
    } catch {
      // 非 JSON:无处附加,保持原样
    }
    return text;
  };
  const autoAttachRequestId = (text: string): string => {
    if (requestId === undefined) {
      return text;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        !('request_id' in (parsed as Record<string, unknown>))
      ) {
        return JSON.stringify({ ...(parsed as Record<string, unknown>), request_id: requestId });
      }
    } catch {
      // 非 JSON:无处附加,保持原样
    }
    return text;
  };
  const autoAttachSenderDigests = (text: string): string => {
    const entries =
      senderDigests !== undefined
        ? [...senderDigests.entries()].filter(
            ([file, digest]) => fileSet.includes(file) && typeof digest === 'string' && digest.length > 0
          )
        : [];
    if (entries.length === 0) {
      return text;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        !('sender_digests' in (parsed as Record<string, unknown>))
      ) {
        return JSON.stringify({
          ...(parsed as Record<string, unknown>),
          sender_digests: Object.fromEntries(entries)
        });
      }
    } catch {
      // 非 JSON:无处附加,保持原样
    }
    return text;
  };
  return {
    url: substitute(entry.url),
    method: entry.method,
    headers: Object.fromEntries(
      Object.entries(entry.headers).map(([key, value]) => [key, substitute(value)])
    ),
    body: autoAttachRequestId(autoAttachSenderDigests(autoAttachTargetId(substitute(entry.body)))),
    ...(entry.maxResponseBytes !== undefined ? { maxResponseBytes: entry.maxResponseBytes } : {})
  };
}

/**
 * RUST-357(HR-HTTP-015)端点健康观察口:传输层每次发送的可达性事实上报
 * (断连/重连自动更新 endpoint health)。事实只有 ok/detail——刻意不带
 * 任何模块投递字段(health success ≠ 任何模块已更新成功),健康展示面
 * (通道状态栏灯)与投递结果面(台账/回执)各走各的轴。
 */
export interface EndpointHealthObserver {
  noteEndpointHealth(kind: ReloadTransportKind, ok: boolean, detail: string): void;
}

export interface ReloadHttpDeps {
  run: ReloadHttpRunner;
  /** 既有变量表上下文(${module}/${filename}/... 等);缺省空 */
  context?: VariableContext;
  /** RUST-357:发送面健康观察;注入即逐发送上报,不注入=零行为变化 */
  healthObserver?: EndpointHealthObserver;
  /**
   * RUST-420(HR-QA-008)非 loopback 端点显式授权:默认只放行确认的 loopback
   * 目标(本机引擎);返回 true=用户已显式授权(kbengine.http.allowNonLoopback),
   * 非 loopback 逐次落安全警告后放行。缺省不注入=未授权(非 loopback 一律
   * 阻止)——端点越界是危险面,安全默认必须收紧,与信任闸「缺省视为可信」
   * 相反。执行时读(授权可随设置变化,与信任闸同口径)。
   */
  allowNonLoopback?: () => boolean;
}

/**
 * RUST-420(HR-QA-008)非 loopback 已授权时的安全警告随回执逐次落账:
 * 贴到每条回执的 reason/detail(台账是通道的逐次记录面,逐次可见)。
 */
function appendEndpointWarnToReceipt(receipt: ReloadReceipt, message: string): ReloadReceipt {
  if (receipt.status === 'failed') {
    return { ...receipt, reason: `${message} | ${receipt.reason}` };
  }
  const detail = receipt.detail !== undefined ? `${receipt.detail} | ${message}` : message;
  return { ...receipt, detail };
}

/** 默认 HTTP 执行器:复用 httpRequestService 的纯 node http/https 传输面 */
export const defaultReloadHttpRunner: ReloadHttpRunner = request =>
  httpDefaultTransport({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    maxResponseBytes: request.maxResponseBytes
  }).then(result => {
    // RUST-419:失败结果(ECONNREFUSED/证书/代理/超时等真实原因在 error 字段)
    // 必须以 throw 送达 send/probe 的 catch 面分类输出——原先 ok:false 被折成
    // status:0 静默丢弃,全部网络错误都呈现为无用的「HTTP 0:非 2xx」。
    if (!result.ok) {
      throw new Error(result.error ?? `HTTP ${result.status} 请求失败`);
    }
    return {
      status: result.status,
      body: result.body,
      ...(result.bodyTruncated ? { bodyTruncated: result.bodyTruncated } : {})
    };
  });

/**
 * 解析 HTTP 回包体为回执列表(HOT-003/004 协议口径):
 * - 数组=逐条;单对象=单条;非 JSON=全 'sent'(已送达,无协议回执)。
 * - 只认 file 与所发文件集逐字一致的条目;status 只认
 *   accepted/applied/failed,其余未记录状态不认。
 * - F4:expectedTargetId 给定时,条目显式携带的 targetId 必须与之一致,
 *   不一致的回执整条拒绝(该文件落 'sent',不 claim applied)——回执带
 *   错误 targetId 不得当作该目标的 accepted/applied 证据。
 * - F5(关联 id):expectedRequestId 给定时,条目显式携带的 request_id 必须
 *   与之一致,不一致的回执整条拒绝——把回执精确归到所属发送(乱序/迟到
 *   回执不归本次发送,不 claim applied)。
 * - 未认到的文件补 'sent'(送达成功但无匹配回执,不 claim applied)。
 */
export function parseReloadHttpReceipts(
  body: string,
  fileSet: readonly string[],
  expectedTargetId?: string,
  expectedRequestId?: string
): ReloadReceipt[] {
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
  // 被拒文件 → 真实拒绝原因(整条拒回的真相,targetId/request_id 分列)。
  const mismatched = new Map<string, string>();
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const file = typeof record.file === 'string' ? record.file : undefined;
    if (file === undefined || seen.has(file) || !fileSet.includes(file)) {
      continue;
    }
    // F4:回执显式 targetId 与预期目标不一致 → 整条拒绝(不认状态、不认
    // digest);F4 二轮:显式「非字符串」targetId(null/数字/对象)是畸形
    // 回执,绝不归一化成 undefined 按「未提供」处理——同样整条拒绝。字段
    // 缺失才是真的未提供(可选字段,给了就必须是匹配目标的字符串)。
    const hasTargetIdField = 'targetId' in record;
    const receiptTargetId = typeof record.targetId === 'string' ? record.targetId : undefined;
    const malformedTargetId = hasTargetIdField && receiptTargetId === undefined;
    if (
      malformedTargetId ||
      (expectedTargetId !== undefined && receiptTargetId !== undefined && receiptTargetId !== expectedTargetId)
    ) {
      mismatched.set(
        file,
        `回执 targetId 与目标 ${expectedTargetId} 不一致:整条拒绝该回执(不 claim applied)`
      );
      continue;
    }
    // F5(关联 id):回执显式 request_id 与本次发送的关联标识不一致 → 整条
    // 拒绝(该回执不归本次发送,不认状态/不 claim applied)——把回执精确归
    // 到所属发送,跨发送乱序/迟到回执不再靠 targetId+file 猜。畸形与未提供
    // 口径同 targetId:显式「非字符串」是畸形整条拒绝,缺失才是未提供。
    const hasRequestIdField = 'request_id' in record;
    const receiptRequestId = typeof record.request_id === 'string' ? record.request_id : undefined;
    const malformedRequestId = hasRequestIdField && receiptRequestId === undefined;
    if (
      malformedRequestId ||
      (expectedRequestId !== undefined &&
        receiptRequestId !== undefined &&
        receiptRequestId !== expectedRequestId)
    ) {
      mismatched.set(
        file,
        `回执 request_id 与本次发送关联标识${expectedRequestId ?? ''}不一致:整条拒绝该回执(不 claim applied)`
      );
      continue;
    }
    const digest = typeof record.digest === 'string' ? record.digest : undefined;
    const note = typeof record.note === 'string' ? record.note : undefined;
    const revision = typeof record.revision === 'number' ? record.revision : undefined;
    const status = record.status;
    if (status === 'accepted') {
      seen.add(file);
      receipts.push({
        status: 'accepted',
        file,
        ...(digest !== undefined ? { digest } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(receiptTargetId !== undefined ? { targetId: receiptTargetId } : {}),
        ...(receiptRequestId !== undefined ? { requestId: receiptRequestId } : {})
      });
    } else if (status === 'applied') {
      seen.add(file);
      receipts.push({
        status: 'applied',
        file,
        ...(digest !== undefined ? { digest } : {}),
        ...(revision !== undefined ? { revision } : {}),
        ...(receiptTargetId !== undefined ? { targetId: receiptTargetId } : {}),
        ...(receiptRequestId !== undefined ? { requestId: receiptRequestId } : {})
      });
    } else if (status === 'failed') {
      seen.add(file);
      receipts.push({
        status: 'failed',
        file,
        reason: typeof record.reason === 'string' ? record.reason : '回执 failed 无原因',
        ...(receiptTargetId !== undefined ? { targetId: receiptTargetId } : {}),
        ...(receiptRequestId !== undefined ? { requestId: receiptRequestId } : {})
      });
    }
  }
  for (const file of fileSet) {
    const mismatchReason = mismatched.get(file);
    if (mismatchReason !== undefined) {
      receipts.push({
        status: 'sent',
        file,
        detail: mismatchReason
      });
    } else if (!seen.has(file)) {
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

  /**
   * RUST-357(HR-HTTP-015):上报本次发送的端点健康事实(断连/重连)。未注入
   * 观察口=零行为变化(既有通道零注入不回归)。health ok/detail 只述传输层
   * 可达性,不携带任何模块投递结论。
   */
  private noteEndpointHealth(kind: ReloadTransportKind, ok: boolean, detail: string): void {
    this.deps.healthObserver?.noteEndpointHealth(kind, ok, detail);
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const url = substituteReloadVariables(this.entry.url, [], this.deps.context);
    // RUST-420(HR-QA-008)端点策略闸:探测同样过闸(探测也发 HTTP GET 到配置
    // 声明的目的地)。阻止=如实报不可达+原因(不发请求);已授权=放行但逐次
    // 落安全警告(附在 detail 上,探活结果如实呈现)。执行时读(授权可随
    // 设置变化),缺省未注入=未授权(安全默认收紧)。
    const endpoint = decideHttpEndpoint(url, this.deps.allowNonLoopback?.() ?? false);
    if (endpoint.action === 'block') {
      return { ok: false, detail: endpoint.message ?? '非 loopback 端点已阻止' };
    }
    const warnNote =
      endpoint.action === 'warn' && endpoint.message !== null ? ` · ${endpoint.message}` : '';
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
        body: '',
        ...(this.entry.maxResponseBytes !== undefined ? { maxResponseBytes: this.entry.maxResponseBytes } : {})
      });
      const ok = response.status >= 200 && response.status < 300;
      return {
        ok,
        detail:
          (ok
            ? `端点可达(HTTP ${response.status})`
            : `端点不可达(HTTP ${response.status} 非 2xx)`) + warnNote
      };
    } catch (error) {
      // RUST-419:探测失败分类输出可用错误(endpoint/证书/代理/中断)
      return { ok: false, detail: formatReloadTransportThrownError(error) + warnNote };
    }
  }

  /**
   * RUST-358(HR-HTTP-016):构造将要发出的精确请求(不发送、零副作用)。与
   * send 共用 buildReloadHttpRequest——URL/method/headers/body 逐字节同形,
   * 用户确认的正是实际会发的那份报文。未给 senderDigests 时不附加
   * sender_digests(真实发送按文件冻结 digest 附加,预览不伪造)。
   */
  preview(
    target: ReloadTarget,
    fileSet: readonly string[],
    senderDigests?: ReadonlyMap<string, string>
  ): ReloadHttpRequest {
    return buildReloadHttpRequest(this.entry, target, fileSet, this.deps.context, senderDigests);
  }

  async send(
    target: ReloadTarget,
    fileSet: readonly string[],
    onReceipt: (receipt: ReloadReceipt) => void,
    senderDigests?: ReadonlyMap<string, string>
  ): Promise<ReloadSendSummary> {
    // F5(关联 id):逐发送生成关联标识——进请求体(request_id 自动附加)与
    // 回执(本次发送产生的每条回执都带,不论来自线上回显还是本地合成),
    // 消费方据此把回执精确归到所属发送。
    const requestId = generateReloadRequestId();
    // F4:${targetId} 占位、F4 二轮 body 自动附加 targetId、F3 三轮
    // sender_digests、F5 request_id 全在 buildReloadHttpRequest(预览/发送
    // 单一来源;预览不传 requestId=零发送不伪造关联)。
    const request = buildReloadHttpRequest(
      this.entry,
      target,
      fileSet,
      this.deps.context,
      senderDigests,
      requestId
    );
    // RUST-420(HR-QA-008)端点策略闸:profile 部署通道的真实目的地(模板插值
    // 后 URL)在发出前过端点策略——默认只放行 loopback;非 loopback 未授权
    // 一律阻止(不发请求,逐文件 failed 回执携带阻止原因),已授权放行但逐次
    // 落安全警告(贴在回执上,台账逐次可见)。执行时读(授权可随设置变化),
    // 缺省未注入=未授权(安全默认收紧,与信任闸「缺省可信」相反)。
    const endpoint = decideHttpEndpoint(request.url, this.deps.allowNonLoopback?.() ?? false);
    if (endpoint.action === 'block') {
      const receipts = fileSet.map(file => ({
        status: 'failed' as const,
        file,
        reason: endpoint.message ?? '非 loopback 端点已阻止'
      }));
      for (const receipt of receipts) {
        onReceipt(receipt);
      }
      return { kind: this.kind, receipts };
    }
    const warnMessage = endpoint.action === 'warn' ? endpoint.message : null;
    // RUST-420:已授权非 loopback → warn:安全警告贴在每条回执上(推送面与
    // 返回汇总同批同形,不各说各话)。F5:所有回执统一盖本次发送的关联标识
    // (wire 回显已匹配的按同值盖,本地合成的补盖——逐发送可精确归账)。
    const finish = (receipts: ReloadReceipt[]): ReloadSendSummary => {
      const stamped = receipts.map(r => ({ ...r, requestId }));
      const wrapped =
        warnMessage === null ? stamped : stamped.map(r => appendEndpointWarnToReceipt(r, warnMessage));
      for (const receipt of wrapped) {
        onReceipt(receipt);
      }
      return { kind: this.kind, receipts: wrapped };
    };
    let response: ReloadHttpResponse;
    try {
      response = await this.deps.run(request);
    } catch (error) {
      // RUST-419:传输异常分类输出可用错误(逐文件 failed 回执同因)
      // RUST-357:断连——无响应即端点不可达(健康观察口按同一可用错误上报)
      const health = sendErrorToEndpointHealth(error);
      this.noteEndpointHealth(this.kind, health.ok, health.detail);
      return finish(fileSet.map(file => ({ status: 'failed' as const, file, reason: health.detail })));
    }
    if (response.status < 200 || response.status >= 300) {
      // RUST-357:有响应但非 2xx——端点可达但通道不健康
      this.noteEndpointHealth(this.kind, false, sendStatusToEndpointHealth(response.status).detail);
      return finish(
        fileSet.map(file => ({
          status: 'failed' as const,
          file,
          reason: `HTTP ${response.status}:非 2xx 送达失败`
        }))
      );
    }
    // RUST-357:2xx——端点可达/重连(health success 只说明端点可达,不代表
    // 任何模块已更新成功:模块投递结果另在回执/台账轴)
    this.noteEndpointHealth(this.kind, true, sendStatusToEndpointHealth(response.status).detail);
    // F4:目标传入回执解析——显式 targetId 与该目标不一致的回执整条拒绝;
    // F5:关联 id 传入——显式 request_id 与本次发送不一致的回执整条拒绝。
    return finish(
      response.bodyTruncated
        ? fileSet.map(file => ({ status: 'sent' as const, file, detail: '响应体已截断，未能核验回执' }))
        : parseReloadHttpReceipts(response.body, fileSet, target.targetId, requestId)
    );
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

  /** 监听执行结果；默认命令等待完整的唯一标记 JSON，自定义命令保留回显模式。 */
  private readonly captureEcho = (conn: ReloadTelnetConnection, marker?: string): Promise<string> => {
    const awaitEchoMs = this.deps.awaitEchoMs ?? 8000;
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
        if (!marker || buffer.split(/\r?\n/).some(line => {
          if (!line.startsWith(marker)) { return false; }
          try { JSON.parse(line.slice(marker.length)); return true; } catch { return false; }
        })) {
          finish();
        }
      });
      conn.onClose(() => finish());
      const timer = setTimeout(finish, awaitEchoMs);
    });
  };

  async send(
    target: ReloadTarget,
    fileSet: readonly string[],
    onReceipt: (receipt: ReloadReceipt) => void,
    // Demo observer 可核验冻结指纹；无 observer 的普通引擎只保留执行层证据。
    senderDigests?: ReadonlyMap<string, string>
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
      const marker = `KODE_RELOAD_${randomUUID().replace(/-/g, '')}:`;
      const payload = { files: fileSet, targetId: target.targetId, sender_digests: Object.fromEntries(senderDigests ?? []) };
      const script = [
        'import KBEngine, json, importlib.util',
        `payload = json.loads(${JSON.stringify(JSON.stringify(payload))})`,
        'if importlib.util.find_spec("KodeHotReload") is not None:',
        '    import KodeHotReload',
        `    receipts = KodeHotReload.official_reload(payload, ${this.config.fullReload === false ? 'False' : 'True'})`,
        'else:',
        `    ${this.command()}`,
        '    receipts = []',
        `print(${JSON.stringify(marker)} + json.dumps(receipts))`
      ].join('\n');
      const command = this.config.command ?? `exec(${JSON.stringify(script)})`;
      // Enter Python explicitly; readiness alone may refer to the root console layer.
      if (!this.config.command && !conn.sendCommand(':python')) {
        throw new Error('控制台无法进入 Python 层');
      }
      // Subscribe BEFORE sending: a fast response must not be lost.
      const echoPromise = this.captureEcho(conn, this.config.command ? undefined : marker);
      if (!conn.sendCommand(command)) {
        const reason = '控制台未接受命令(非 ready 态或命令被拒)';
        const receipts = fileSet.map(file => ({ status: 'failed' as const, file, reason }));
        for (const receipt of receipts) {
          onReceipt(receipt);
        }
        return { kind: this.kind, receipts };
      }
      const echo = await echoPromise;
      const receiptLine = echo.split(/\r?\n/).find(line => line.startsWith(marker));
      if (receiptLine) {
        const body = receiptLine.slice(marker.length);
        const parsed: unknown = JSON.parse(body);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const receipts = parseReloadHttpReceipts(body, fileSet, target.targetId);
          receipts.forEach(onReceipt);
          return { kind: this.kind, receipts };
        }
      }
      if (/Traceback \(most recent call last\)|(?:SyntaxError|NameError|ImportError|RuntimeError):/.test(echo)) {
        const receipts = fileSet.map(file => ({ status: 'failed' as const, file, reason: `控制台执行失败: ${echo}` }));
        receipts.forEach(onReceipt);
        return { kind: this.kind, receipts };
      }
      const detail = `命令已发送: ${command}${echo.length > 0 ? ` | 回显: ${echo}` : ''}(引擎无回执协议,不 claim applied)`;
      const receipts = fileSet.map(file => ({ status: 'sent' as const, file, detail }));
      for (const receipt of receipts) {
        onReceipt(receipt);
      }
      return { kind: this.kind, receipts };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const receipts = fileSet.map(file => ({ status: 'failed' as const, file, reason }));
      receipts.forEach(onReceipt);
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
  /** RUST-357(HR-HTTP-015):透传给 HTTP 通道的发送面健康观察口 */
  healthObserver?: EndpointHealthObserver;
  /**
   * RUST-420(HR-QA-008):透传给 HTTP 通道的非 loopback 端点显式授权(执行时读)。
   * 缺省不注入=未授权(非 loopback 一律阻止,安全默认收紧)。
   */
  allowNonLoopback?: () => boolean;
}

/**
 * 默认部署通道(用户令 2026-11-10「默认就是 http 方式,都提供默认配置」):
 * 无激活 profile 或 profile 未配 hotReload 段时用它。端点为
 * `http://127.0.0.1:8090/hotfix`，JSON 文件集支持 targetId/冻结指纹回执。
 * 旧单模块表单只保留在兼容的 quick-request 路径。
 */
export function createDefaultHotReloadChannel(): ReloadChannelConfig {
  const entry: HttpRequestEntry = {
    ...BUILTIN_HTTP_REQUEST_EXAMPLE,
    // The module-only form cannot carry per-file engine receipts or frozen digests.
    url: 'http://127.0.0.1:8090/hotfix',
    headers: { 'Content-Type': 'application/json' },
    body: '{"files":${files}}',
    enabled: true
  };
  return { channel: 'http', http: entry };
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
    const httpDeps: ReloadHttpDeps = {
      ...(deps.http ?? { run: defaultReloadHttpRunner }),
      ...(deps.healthObserver !== undefined ? { healthObserver: deps.healthObserver } : {}),
      ...(deps.allowNonLoopback !== undefined ? { allowNonLoopback: deps.allowNonLoopback } : {})
    };
    return new HttpReloadTransport(config.http, httpDeps);
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
      ...(typeof http.maxResponseBytes === 'number' &&
      Number.isSafeInteger(http.maxResponseBytes) && http.maxResponseBytes > 0
        ? { maxResponseBytes: http.maxResponseBytes }
        : {}),
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
