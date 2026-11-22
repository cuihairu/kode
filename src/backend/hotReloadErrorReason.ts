/**
 * HR-STATE-010 错误原因七类可操作分类(纯核,零 vscode 零 IO):
 * - 输入=落到台账 record.detail / FAILED reason 的自由文本(发送失败、
 *   语法闸拦下、模块身份诊断、回执核验、def 结构变更等既有各面产出),
 *   输出=七类原因定性 + 中文标签 + 动作建议;
 * - 分类只做定性,绝不吞原文——格式面 = `[标签] 原文(建议:...)`,未知
 *   分类如实原样透传(不猜类别,不凭空加标签);
 * - 与 hotReloadTransportErrors(RUST-419)分工:transport 侧已输出
 *   「定性+动作建议」的消息,这里在其上叠「七类标签」并给其余各面补
 *   动作建议——transport 类目的消息已自带动作,不再叠建议;
 * - 匹配次序有语义:模块冲突/需重启/回执不可信先于配置(具体先于泛化),
 *   HTTP 状态(服务端拒绝)先于传输(请求未达)。
 */

/** 七类可操作原因 + 未知(如实不猜) */
export type HotReloadErrorReason =
  | 'config-error'
  | 'module-conflict'
  | 'syntax-error'
  | 'target-unreachable'
  | 'apply-failed'
  | 'receipt-untrusted'
  | 'restart-required'
  | 'unknown';

/** 分类结果:定性 + 中文标签 + 动作建议(已内嵌建议的消息返回空串) */
export interface HotReloadErrorReasonInfo {
  readonly category: HotReloadErrorReason;
  readonly label: string;
  readonly hint: string;
}

/** 七类中文标签(只述已核实事实;unknown=其他,不猜名) */
export const HOT_RELOAD_ERROR_REASON_LABELS: Record<HotReloadErrorReason, string> = {
  'config-error': '配置错误',
  'module-conflict': '模块冲突',
  'syntax-error': '语法错误',
  'target-unreachable': '目标不可达',
  'apply-failed': '应用失败',
  'receipt-untrusted': '回执不可信',
  'restart-required': '需重启',
  unknown: '其他'
};

/** 各面真实产出信号(源串,随各面语义演进保持逐字可辨;改面须同步测试语料) */
const MODULE_CONFLICT_ERROR = /多个脚本资源根|命中多个脚本|歧义|ambiguous/i;
const RESTART_REQUIRED_ERROR = /需重启|结构性 def 变更|保守按结构性处理/i;
const RECEIPT_UNTRUSTED_ERROR = /回执不可信|不升格|无可信|可疑回执|基准缺失|digest.*不符|digest 缺失/i;
const SYNTAX_ERROR = /语法检查未通过|良构失败|语法错误/i;
const CONFIG_ERROR =
  /未配置|不在任何脚本资源根内|fileUri 为空|user override 非法|invalid-stem|无效/i;
const TARGET_UNREACHABLE_ERROR =
  /端点不可达|证书校验失败|代理错误|目标连接中断|传输失败|HTTP 发送失败|请求超时|拒绝连接/i;
const APPLY_FAILED_ERROR = /HTTP 状态 \d+:非 2xx|应用失败|拒绝应用|服务器.*(拒绝|失败)|apply.*失败/i;

/**
 * 自由文本 → 七类定性(未知如实 unknown,不猜)。只匹配各面真实产出
 * 的逐字信号,匹配次序具体先于泛化;定性绝不吞原文(原文由调用方保留)。
 */
export function classifyHotReloadErrorReason(raw: string): HotReloadErrorReasonInfo {
  const text = raw ?? '';
  if (MODULE_CONFLICT_ERROR.test(text)) {
    return {
      category: 'module-conflict',
      label: HOT_RELOAD_ERROR_REASON_LABELS['module-conflict'],
      hint: '确保文件唯一命中一个脚本资源根'
    };
  }
  if (RESTART_REQUIRED_ERROR.test(text)) {
    return {
      category: 'restart-required',
      label: HOT_RELOAD_ERROR_REASON_LABELS['restart-required'],
      hint: '' // 消息已含「需重启进程后再应用」,不再叠建议
    };
  }
  if (RECEIPT_UNTRUSTED_ERROR.test(text)) {
    return {
      category: 'receipt-untrusted',
      label: HOT_RELOAD_ERROR_REASON_LABELS['receipt-untrusted'],
      hint: '确认目标端热更协议支持回执核验并重试'
    };
  }
  if (SYNTAX_ERROR.test(text)) {
    return {
      category: 'syntax-error',
      label: HOT_RELOAD_ERROR_REASON_LABELS['syntax-error'],
      hint: '修正脚本语法错误后重新保存'
    };
  }
  if (CONFIG_ERROR.test(text)) {
    return {
      category: 'config-error',
      label: HOT_RELOAD_ERROR_REASON_LABELS['config-error'],
      hint: '配置脚本资源根(kbengine.hotReload.tempEdit.scriptRoot)后重试'
    };
  }
  if (TARGET_UNREACHABLE_ERROR.test(text)) {
    return {
      category: 'target-unreachable',
      label: HOT_RELOAD_ERROR_REASON_LABELS['target-unreachable'],
      hint: '' // 消息已含「检查地址/端口/重试」等动作,不再叠建议
    };
  }
  if (APPLY_FAILED_ERROR.test(text)) {
    return {
      category: 'apply-failed',
      label: HOT_RELOAD_ERROR_REASON_LABELS['apply-failed'],
      hint: '查看目标服务日志确认应用失败原因'
    };
  }
  return {
    category: 'unknown',
    label: HOT_RELOAD_ERROR_REASON_LABELS.unknown,
    hint: ''
  };
}

/**
 * 可操作格式面:已知类别 → `[标签] 原文(建议:...)`;未知 → 原文原样
 * (不猜类别,不改用户可见文本)。建议仅当该面消息未内嵌动作时叠加。
 */
export function formatHotReloadErrorReason(raw: string): string {
  const info = classifyHotReloadErrorReason(raw);
  if (info.category === 'unknown') {
    return raw;
  }
  const hintSuffix = info.hint.length > 0 ? `(建议:${info.hint})` : '';
  return `[${info.label}] ${raw}${hintSuffix}`;
}
