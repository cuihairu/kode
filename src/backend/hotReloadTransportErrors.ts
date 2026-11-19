/**
 * RUST-419(HR-QA-007)传输错误五分类:endpoint 不可达/证书错误/代理错误/
 * target 重启各自输出可用错误(分类 + 动作建议 + 原始原因);部分节点成功
 * 由台账逐文件 failed 明细承载(见 hotReloadChannelSend)。纯函数零 vscode,
 * 输入=传输层捕到的原始错误文本(node http/https err.message / 文案化
 * 超时/响应中断),全部可在测试里 mock 构造,不需要真环境。
 *
 * 匹配次序有语义:证书/代理先于连接类(代理隧道的 ECONNREFUSED 指向代理
 * 本身);中断类(target 重启)先于不可达类(已建连后断开≠从未可达)。
 */

export type ReloadTransportErrorKind =
  | 'endpoint-unreachable'
  | 'certificate'
  | 'proxy'
  | 'target-restart'
  | 'unknown';

export interface ClassifiedReloadTransportError {
  readonly kind: ReloadTransportErrorKind;
  /** 可用错误:分类定性 + 动作建议(不含原始原因,展示层自行拼接) */
  readonly message: string;
}

const CERTIFICATE_ERROR = /cert|eproto|证书/i;
const PROXY_ERROR = /proxy|tunnel|代理|407/i;
const TARGET_RESTART_ERROR =
  /econnreset|epipe|econnaborted|socket hang up|aborted|提前断开|连接中断/i;
const ENDPOINT_UNREACHABLE_ERROR =
  /econnrefused|enotfound|eai_again|etimedout|ehostunreach|enetunreach|fetch failed|不可达|无法解析|不支持的协议|超时/i;

/**
 * 原始错误文本 → 五分类定性。未命中任何族 → 'unknown'(如实不猜);
 * 分类只做定性,绝不吞原始原因——可用错误输出 = message + 原始文本。
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

/** 分类 + 原始原因的完整可用错误输出(台账 detail/failed reason 直接可存) */
export function formatReloadTransportError(raw: string): string {
  const classified = classifyReloadTransportError(raw);
  return `${classified.message}(原始:${raw})`;
}

/** 便捷形态:未知错误对象(throw 面)→ 可用错误文本 */
export function formatReloadTransportThrownError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return formatReloadTransportError(raw);
}
