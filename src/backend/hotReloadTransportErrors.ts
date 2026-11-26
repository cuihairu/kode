/**
 * RUST-419 (HR-QA-007) transport error five-way classification: an
 * unreachable endpoint / certificate error / proxy error / target restart
 * each yield an actionable error (classification + action advice + raw
 * cause); a partial-success case is carried by the per-file failed detail in
 * the ledger (see hotReloadChannelSend). Pure function, zero vscode. Input =
 * the raw error text caught at the transport layer (node http/https
 * err.message / stringified timeouts / interrupted responses), all mockable
 * in tests, no real environment required.
 *
 * The matching order is semantic: certificate/proxy precede the connection
 * classes (an ECONNREFUSED on a proxy tunnel points at the proxy itself); the
 * interrupt class (target restart) precedes the unreachable class (a
 * disconnect after a connection was established != never reachable).
 */

export type ReloadTransportErrorKind =
  | 'endpoint-unreachable'
  | 'certificate'
  | 'proxy'
  | 'target-restart'
  | 'unknown';

export interface ClassifiedReloadTransportError {
  readonly kind: ReloadTransportErrorKind;
  /** Actionable error: classification verdict + action advice (excluding the raw cause, assembled by the display layer itself) */
  readonly message: string;
}

const CERTIFICATE_ERROR = /cert|eproto|证书/i;
const PROXY_ERROR = /proxy|tunnel|代理|407/i;
const TARGET_RESTART_ERROR =
  /econnreset|epipe|econnaborted|socket hang up|aborted|提前断开|连接中断/i;
const ENDPOINT_UNREACHABLE_ERROR =
  /econnrefused|enotfound|eai_again|etimedout|ehostunreach|enetunreach|fetch failed|不可达|无法解析|不支持的协议|超时/i;

/**
 * Raw error text -> five-way classification. No family matched -> 'unknown'
 * (honestly, never guessed); the classification only qualifies the error and
 * never swallows the raw cause — the actionable error output = message + the
 * raw text.
 */
export function classifyReloadTransportError(raw: string): ClassifiedReloadTransportError {
  const text = raw ?? '';
  if (CERTIFICATE_ERROR.test(text)) {
    return {
      kind: 'certificate',
      message: '证书校验失败:端点证书不受信任/已过期/与地址不匹配,检查端点证书或受信 CA 配置'
    };
  }
  if (PROXY_ERROR.test(text)) {
    return {
      kind: 'proxy',
      message: '代理错误:检查代理地址/端口可达性与鉴权(407 需凭据)'
    };
  }
  if (TARGET_RESTART_ERROR.test(text)) {
    return {
      kind: 'target-restart',
      message: '目标连接中断:疑似 target 重启或中途断开,可用热更失败重试命令重发'
    };
  }
  if (ENDPOINT_UNREACHABLE_ERROR.test(text)) {
    return {
      kind: 'endpoint-unreachable',
      message: '端点不可达:检查地址/端口与目标服务是否在监听'
    };
  }
  return { kind: 'unknown', message: '传输失败:见原始原因' };
}

/** The complete actionable error output of classification + raw cause (the ledger detail / failed reason can be stored directly) */
export function formatReloadTransportError(raw: string): string {
  const classified = classifyReloadTransportError(raw);
  return `${classified.message}(原始:${raw})`;
}

/** Convenience form: an unknown error object (the throw face) -> actionable error text */
export function formatReloadTransportThrownError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return formatReloadTransportError(raw);
}
