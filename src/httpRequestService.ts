/**
 * HTTP 快捷请求执行层(批105):
 * - 默认 transport 走 node http/https(URL 协议二选一,超时到点中止,
 *   回包截顶防大响应刷屏);
 * - 服务层:启停过滤、模板变量装配、OUTPUT 面板流水(▶ 请求行 /
 *   ✓ 成功状态·耗时·回包 / ✗ 失败标记)与失败错误弹窗。
 *   OUTPUT 通道无着色 API(engines 1.50 基线),失败以 ✗ 标记 + 错误弹窗
 *   呈现,不做红色字面。
 */

import * as http from 'http';
import * as https from 'https';
import {
  buildHttpRequest,
  buildTemplateVars,
  HttpRequestEntry,
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
  /** 失败原因(仅 ok=false 时有) */
  error?: string;
}

export interface OutgoingHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/** 可注入的执行通道(测试用脚本化应答) */
export type HttpTransport = (request: OutgoingHttpRequest) => Promise<HttpExecutionResult>;

const defaultTransport: HttpTransport = request =>
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
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      parsed,
      {
        method: request.method,
        headers: request.headers
      },
      res => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          // 接收窗口封顶:窗口内有多少收多少,末块裁剪(整块超窗也保住前段)
          const room = RESPONSE_PREVIEW_LIMIT * 4 - received;
          if (room > 0) {
            chunks.push(room < chunk.length ? chunk.subarray(0, room) : chunk);
          }
          received += chunk.length;
        });
        // 响应侧中断(服务端提前断开)在 req 上以 error(ECONNRESET)呈现,
        // 由下方 req.on('error') 统一收口;此处只处理正常收尾。
        // end 触发时响应头必已解析(statusCode 实况恒有值);类型上
        // number|undefined 以解构默认值收口为 0(与失败路径的「无状态码」
        // 语义一致),不引入覆盖率的 ?? 死臂。
        res.on('end', () => {
          const { statusCode = 0 } = res;
          resolve({
            ok: true,
            status: statusCode,
            durationMs: Date.now() - startedAt,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.setTimeout(request.timeoutMs, () => {
      req.destroy(new Error(`请求超时(${request.timeoutMs}ms)`));
    });
    req.on('error', (err: Error) => {
      resolve({
        ok: false,
        status: 0,
        durationMs: Date.now() - startedAt,
        body: '',
        error: err.message
      });
    });
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
  timeoutMs?: number;
}

export class HttpRequestService {
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;

  constructor(private readonly deps: HttpRequestServiceDeps) {
    this.transport = deps.transport ?? defaultTransport;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
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
    const vars = buildTemplateVars(this.deps.getTemplateContext?.() ?? {});
    const request = buildHttpRequest(entry, vars);
    this.deps.log(`▶ [${entry.name}] ${request.method} ${request.url}`);

    const result = await this.transport({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      timeoutMs: this.timeoutMs
    });

    if (result.ok) {
      this.deps.log(`✓ ${result.status} · ${result.durationMs}ms`);
      this.deps.log(this.previewBody(result.body));
      return true;
    }
    this.deps.log(`✗ [${entry.name}] ${request.method} ${request.url} · ${result.durationMs}ms · ${result.error ?? '未知错误'}`);
    this.deps.notifyError(`HTTP 快捷请求「${entry.name}」失败: ${result.error ?? '未知错误'}`);
    return false;
  }

  private previewBody(body: string): string {
    if (body.length <= RESPONSE_PREVIEW_LIMIT) {
      return body.length > 0 ? body : '(空回包)';
    }
    return `${body.slice(0, RESPONSE_PREVIEW_LIMIT)}…(截断,共 ${body.length} 字符)`;
  }
}
