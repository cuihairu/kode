/**
 * HTTP 快捷请求执行层(批105):
 * - 默认 transport 走 node http/https(URL 协议二选一,超时到点中止,
 *   回包截顶防大响应刷屏;HR-HTTP-006/RUST-348:keepAlive 连接池复用
 *   同目标连接 + 条目级最大响应体上限);
 * - 服务层:启停过滤、模板变量装配、OUTPUT 面板流水(▶ 请求行 /
 *   ✓ 成功状态·耗时·回包 / ✗ 失败标记)与失败错误弹窗。
 *   OUTPUT 通道无着色 API(engines 1.50 基线),失败以 ✗ 标记 + 错误弹窗
 *   呈现,不做红色字面。
 */

import * as http from 'http';
import * as https from 'https';
import { executeHttpRequest } from './httpRequestExecutor';
import { createHttpTargetQueue, type HttpTargetQueue } from './httpRequestQueue';
import {
  buildHttpRequest,
  buildOfficialVariableContext,
  buildTemplateVars,
  HttpRequestEntry,
  PackageDirProbe,
  TemplateEditorContext
} from './httpRequests';

export const DEFAULT_HTTP_TIMEOUT_MS = 10000;

/** 回包进面板的截顶长度(字符),超出部分标注省略 */
export const RESPONSE_PREVIEW_LIMIT = 4000;

export interface HttpExecutionResult {
  ok: boolean;
  status: number;
  durationMs: number;
  body: string;
  bodyTruncated?: true;
  /** 失败原因(仅 ok=false 时有) */
  error?: string;
}

export interface OutgoingHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /**
   * HR-HTTP-006(RUST-348)最大响应体(字节):收到的回包截到此上限即止,
   * 超出部分如实丢弃;缺省=既有截顶窗口(RESPONSE_PREVIEW_LIMIT×4)。
   * 由条目 maxResponseBytes 透传;默认热更面不设,走缺省窗口。
   */
  maxResponseBytes?: number;
  /**
   * HR-HTTP-008(RUST-350)取消信号:中止当前请求(destroy),结算报「已取消」。
   * 取消≠远端撤销:请求可能已达远端(甚至已应用),远端状态如实未知(uncertain),
   * 不冒充失败也不冒充成功;缺省无信号=不可取消(既有行为不变)。
   */
  signal?: AbortSignal;
}

/** 可注入的执行通道(测试用脚本化应答) */
export type HttpTransport = (request: OutgoingHttpRequest) => Promise<HttpExecutionResult>;

/**
 * HR-HTTP-006(RUST-348)连接池:keepAlive agent 复用同协议同主机连接。
 * 默认 node 传输面无 agent 时每次请求新建 TCP 连接(逐条/逐文件重复握手);
 * 同目标串行热更由此复用空闲连接。进程级懒建单例(http/https 各一),
 * 随扩展宿主进程退出一并释放,无需显式销毁。
 */
let pooledHttpAgent: http.Agent | undefined;
let pooledHttpsAgent: https.Agent | undefined;
const pooledAgent = (protocol: string): http.Agent =>
  protocol === 'https:'
    ? (pooledHttpsAgent ??= new https.Agent({ keepAlive: true }))
    : (pooledHttpAgent ??= new http.Agent({ keepAlive: true }));

export const defaultTransport: HttpTransport = request =>
  new Promise<HttpExecutionResult>(resolve => {
    const startedAt = Date.now();
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      resolve({
        ok: false,
        status: 0,
        durationMs: 0,
        body: '',
        error: `URL 无法解析: ${request.url}`
      });
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      resolve({
        ok: false,
        status: 0,
        durationMs: Date.now() - startedAt,
        body: '',
        error: `不支持的协议: ${parsed.protocol}`
      });
      return;
    }
    // KODE-FULL-013:请求级墙钟 deadline——DNS/连接/响应读取全程计入总预算。
    // req.setTimeout 只是 socket 空闲超时,drip-feed 服务端(每隔小于
    // timeoutMs 发一字节且永不结束)永不触发空闲,请求可无限占住调用方。
    // 首次结算(finish)即清定时器;到点 destroy 沿用既有超时文案收口。
    // HR-HTTP-008(RUST-350):取消信号中止即结算「已取消」——取消≠远端撤销,
    // 请求可能已达远端(甚至已应用),远端状态如实未知(uncertain),不冒充
    // 失败也不冒充成功;取消与响应/超时同走 finish,finish 里摘除监听
    // (取消后再无副作用;到点超时先结算则取消监听自然失效)。
    let removeAbortListener: (() => void) | undefined;
    const finish = (result: HttpExecutionResult): void => {
      clearTimeout(deadline);
      removeAbortListener?.();
      resolve(result);
    };
    // HR-HTTP-008:调用即已中止——不发请求,直接如实结算取消(远端状态未知)
    if (request.signal?.aborted) {
      resolve({
        ok: false,
        status: 0,
        durationMs: Date.now() - startedAt,
        body: '',
        error: '请求已取消(调用方中止)'
      });
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      parsed,
      {
        method: request.method,
        headers: request.headers,
        // HR-HTTP-006(RUST-348):keepAlive 连接池复用同目标连接(懒建单例)
        agent: pooledAgent(parsed.protocol)
      },
      res => {
        const chunks: Buffer[] = [];
        let received = 0;
        // HR-HTTP-006(RUST-348):接收窗口=条目级最大响应体,缺省=既有截顶窗口
        const maxResponseBytes = request.maxResponseBytes ?? RESPONSE_PREVIEW_LIMIT * 4;
        const finishResponse = (bodyTruncated?: true): void => {
          finish({
            ok: true,
            status: res.statusCode ?? 0,
            durationMs: Date.now() - startedAt,
            body: Buffer.concat(chunks).toString('utf8'),
            ...(bodyTruncated ? { bodyTruncated } : {})
          });
        };
        res.on('data', (chunk: Buffer) => {
          const room = maxResponseBytes - received;
          if (chunk.length > room) {
            if (room > 0) {
              chunks.push(chunk.subarray(0, room));
            }
            finishResponse(true);
            res.destroy();
            return;
          }
          if (room > 0) {
            chunks.push(chunk);
          }
          received += chunk.length;
        });
        // 响应侧中断(服务端提前断开):实测 node 在响应流上以 'aborted'
        // 呈现,而 req 随 socket 已销毁——req.on('error') 不再触发,原先
        // 「由 req.on('error') 统一收口」的前提不成立,传输 promise 会永久
        // 不结算(超时也无法自救:req 已 destroyed,destroy(err) 不再发
        // error)。在此显式收口为失败;Promise 只认首次 resolve,后到的
        // 重复调用天然无效,无需额外哨兵。
        res.on('aborted', () => {
          finish({
            ok: false,
            status: 0,
            durationMs: Date.now() - startedAt,
            body: '',
            error: '响应中断:服务端提前断开连接(aborted)'
          });
        });
        res.on('error', (err: Error) => {
          finish({
            ok: false,
            status: 0,
            durationMs: Date.now() - startedAt,
            body: '',
            error: err.message
          });
        });
        res.on('end', () => finishResponse());
      }
    );
    const deadline = setTimeout(() => {
      req.destroy(new Error(`请求超时(${request.timeoutMs}ms)`));
    }, Math.max(1, request.timeoutMs));
    deadline.unref?.();
    req.on('error', (err: Error) => {
      finish({
        ok: false,
        status: 0,
        durationMs: Date.now() - startedAt,
        body: '',
        error: err.message
      });
    });
    // HR-HTTP-008(RUST-350):取消信号→destroy 请求,错误面统一走「请求已取消」
    // 文案(与超时同构,由 req.on('error') 收口结算);finish 摘除监听,取消后
    // 再无副作用。同同步块内 pre-guard 已验过未中止,注册后无异步缺口。
    if (request.signal) {
      const onAbort = (): void => {
        req.destroy(new Error('请求已取消(调用方中止)'));
      };
      request.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => request.signal?.removeEventListener('abort', onAbort);
    }
    if (request.body.length > 0) {
      req.write(request.body);
    }
    req.end();
  });

export interface HttpRequestServiceDeps {
  getEntries: () => HttpRequestEntry[];
  transport?: HttpTransport;
  /** OUTPUT 面板流水(每行一条) */
  log: (line: string) => void;
  /** 失败弹窗 */
  notifyError: (message: string) => void;
  /** 模板上下文(活动编辑器)提取 */
  getTemplateContext?: () => TemplateEditorContext;
  /** Python 包目录探针(含 __init__.py 判定),${module} 包边界扫描用(批153) */
  isPackageDir?: PackageDirProbe;
  timeoutMs?: number;
  /**
   * HR-HTTP-007(RUST-349)按目标有界并发队列(同目标默认串行、异目标独立、
   * 全局上限);缺省=模块级单例(生产快捷请求面共用)。注入具名实例用于
   * 测试确定性。
   */
  queue?: HttpTargetQueue;
  /**
   * RUST-422(HR-QA-010)工作区信任探针:执行前逐次读取,未信任(返回 false)
   * 禁止配置驱动快捷请求(SSRF/数据泄露/路径穿越面)并落可审查阻止行;
   * 缺省不注入=视为可信(零配置不回归)。装配注入 `() => vscode.workspace
   * .isTrusted`;执行时读而非装配时读——信任状态可随用户「信任工作区」
   * 变化,以执行时刻为准(与 HR-HTTP-005 自动热更信任闸同模式)。
   */
  isWorkspaceTrusted?: () => boolean;
}

/** HR-HTTP-007:快捷请求面共享队列——同端点用户请求串行,异端点并发,全局封顶 */
const sharedHttpRequestQueue = createHttpTargetQueue();

export class HttpRequestService {
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;
  private readonly queue: HttpTargetQueue;

  constructor(private readonly deps: HttpRequestServiceDeps) {
    this.transport = deps.transport ?? defaultTransport;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.queue = deps.queue ?? sharedHttpRequestQueue;
  }

  /** 已启用条目(quick pick 面板数据源) */
  listEnabled(): HttpRequestEntry[] {
    return this.deps.getEntries().filter(entry => entry.enabled);
  }

  /**
   * 按名运行一条快捷请求:不存在或已停用如实回执 false(不猜不空转);
   * 流水进 OUTPUT,失败附错误弹窗。
   */
  async runByName(name: string): Promise<boolean> {
    const entry = this.deps.getEntries().find(item => item.name === name && item.enabled);
    if (!entry) {
      this.deps.notifyError(`HTTP 快捷请求「${name}」不存在或已停用`);
      return false;
    }
    return this.runEntry(entry);
  }

  /**
   * Execute a caller-selected entry after its source/index identity was resolved.
   * HR-HTTP-008(RUST-350):第四参=取消信号——中止在途请求,按「已取消·远端
   * 状态未知(uncertain)」展示(取消≠远端撤销)。缺省无信号=不可取消。
   */
  async runEntry(
    entry: HttpRequestEntry,
    execute?: () => Promise<void>,
    onHttpResponse?: (response: { status: number; body: string }) => void,
    signal?: AbortSignal
  ): Promise<boolean> {
    // RUST-422(HR-QA-010)工作区信任闸:未信任工作区里的配置驱动快捷请求
    // 一律阻止——配置来自不受信工作区(如克隆仓库)时,其 URL 模板可能探测
    // 内网/元数据端点或外带本地路径(SSRF/数据泄露面);trusted 工作区里
    // 指向 localhost 引擎是本功能本意,不加白名单。fire 时读取(用户可随
    // 「信任工作区」变化),缺省未注入=视为可信(零配置不回归)。
    if (this.deps.isWorkspaceTrusted?.() === false) {
      this.deps.log(`工作区未信任,HTTP 快捷请求「${entry.name}」已阻止(SSRF/数据泄露防护)`);
      this.deps.notifyError(`当前工作区不受信任,HTTP 快捷请求「${entry.name}」已阻止`);
      return false;
    }
    if (!entry.enabled) {
      this.deps.notifyError(`HTTP 快捷请求「${entry.name}」不存在或已停用`);
      return false;
    }
    if (execute) {
      try { await execute(); return true; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.notifyError(`HTTP 快捷请求「${entry.name}」失败: ${message}`);
        return false;
      }
    }
    const editorContext = this.deps.getTemplateContext?.() ?? {};
    const vars = buildTemplateVars(editorContext, this.deps.isPackageDir);
    // 批152:官方变量族(${workspaceFolder}/${fileBasenameNoExtension}/
    // ${env:NAME} 等)与自定义占位单趟合并插值
    const request = buildHttpRequest(entry, vars, buildOfficialVariableContext(editorContext));
    this.deps.log(`▶ [${entry.name}] ${request.method} ${request.url}`);

    // HR-HTTP-001(HR-PR-03):传输走通用执行器(关联 id + 结构化分类
    // 在 outcome 上),服务层分支仍按 transportOk=传输面原始 ok 布尔,
    // 日志/弹窗/布尔契约逐字不变,通用 HTTP 功能零回归。
    const outcome = await executeHttpRequest(
      {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
        timeoutMs: this.timeoutMs,
        ...(entry.maxResponseBytes !== undefined ? { maxResponseBytes: entry.maxResponseBytes } : {})
      },
      {
        transport: this.transport,
        queue: this.queue,
        ...(signal !== undefined ? { signal } : {})
      }
    );

    // AUD-054(R2-F27):真实响应到达即上报观察者(回执解析面)——2xx/非 2xx/
    // 传输失败(status=0)都按真实事实回调,观察者分类落账不靠猜;仅 hook
    // 直连本服务时生效(execute 终端闭包路径拿不到 status/body,不回调)。
    // HR-HTTP-008:取消不回调观察者(无真实响应可报),走 uncertain 分支。
    if (outcome.kind !== 'cancelled') {
      onHttpResponse?.({ status: outcome.status, body: outcome.bodyTruncated ? '' : outcome.body });
    }

    // HR-HTTP-008(RUST-350):已取消——取消≠远端撤销,请求可能已达远端
    // (甚至已应用),远端状态如实未知(uncertain);不冒充失败(不弹错窗、
    // 不标 ✗ 失败),也不冒充成功,如实记录「已取消·远端状态未知」。
    if (outcome.kind === 'cancelled') {
      this.deps.log(`⚠ [${entry.name}] ${request.method} ${request.url} · 已取消:远端状态未知(uncertain)——取消≠远端撤销`);
      return false;
    }

    if (outcome.transportOk) {
      this.deps.log(`✓ ${outcome.status} · ${outcome.durationMs}ms`);
      this.deps.log(this.previewBody(outcome.body, outcome.bodyTruncated));
      return true;
    }
    this.deps.log(`✗ [${entry.name}] ${request.method} ${request.url} · ${outcome.durationMs}ms · ${outcome.errorMessage ?? '未知错误'}`);
    this.deps.notifyError(`HTTP 快捷请求「${entry.name}」失败: ${outcome.errorMessage ?? '未知错误'}`);
    return false;
  }

  private previewBody(body: string, bodyTruncated = false): string {
    const preview = body.slice(0, RESPONSE_PREVIEW_LIMIT);
    if (bodyTruncated) {
      return `${preview}${body.length > preview.length ? '…' : ''} (响应体已截断)`;
    }
    return body.length > preview.length
      ? `${preview}…(截断,共 ${body.length} 字符)`
      : preview || '(空回包)';
  }
}
