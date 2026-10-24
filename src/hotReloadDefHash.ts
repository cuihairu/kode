/**
 * .def Hash/Digest 三路径(书 docs/kode2/KODE_2_COMPLETE_TODO.md §19,委托书
 * HR-PR-03 口径):传输 ok / accepted / applied 三条接受判定 + 客户端 .def
 * 内容 hash + 引擎 Digest 协商描桩,并复用 HR-PR-02(tempEdit)回执链路回显。
 *
 * 铁律(书 §19.1 HTTP 成功分类 / §19.4 安全约束):
 * - transport_success ≠ accepted ≠ applied,三层各自取证、不得互相冒充;
 * - applied 只信引擎明确回执(evidence === 'confirmed'),未知(unknown)与
 *   否认(denied)一律 false——unknown 即 false,不猜、不升级、不绿显;
 * - 客户端 hash 只用现成原语(node:crypto sha256),不自创哈希;
 * - 引擎 Digest 算法在本仓库无任何证据(HR-AUDIT-008,唯一 sha256 在
 *   logHub.ts 日志去重):协商接口恒返回 algorithm='unknown' / negotiated=false,
 *   unknown 算法禁止与客户端 hash 比对,不替引擎猜算法;
 * - .def / types.xml / entities.xml 不得默认自动应用(书 §19.4 安全约束),
 *   本模块只做指纹与判定,不提供任何「.def 已热更」的结论面。
 * 纯逻辑无 vscode 依赖,单测用例直驱;执行编排仍归 hotReloadTempEdit.ts。
 */

import { createHash } from 'crypto';

import type { TempEditReloadOutcome } from './hotReloadTempEdit';

/** 客户端 .def 内容 hash:sha256 hex(现成原语,禁自创) */
export interface DefContentHash {
  /** 恒 'sha256':仓库内既有原语(logHub.ts 同源 node:crypto) */
  readonly algorithm: 'sha256';
  /** 原始内容 UTF-8 字节摘要,64 位小写 hex */
  readonly digest: string;
  /** 摘要输入字节数(供回显/日志对账,不参与判定) */
  readonly byteLength: number;
}

/**
 * 客户端 .def 内容 hash(纯函数):对给定原始文本做 UTF-8 sha256。
 * 边界声明:这是**客户端原始内容指纹**——BOM/换行归一化、引擎侧 canonical
 * 形式均 unknown(HR-AUDIT-008),因此该 hash 只用于本地对账(变更检测/
 * lastRequestedHash 之类),在 Digest 协商成功前不得与任何引擎摘要比对。
 */
export function hashDefContent(content: string): DefContentHash {
  const bytes = Buffer.from(content, 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { algorithm: 'sha256', digest, byteLength: bytes.byteLength };
}

/** 单项证据状态:confirmed=明确回执;denied=明确否认;unknown=无证据(默认) */
export type ReceiptEvidence = 'confirmed' | 'denied' | 'unknown';

/** 三路径判定输入:传输回执 + 可选 accepted/applied 证据(缺省即 unknown) */
export interface ThreePathInput {
  /** 传输层回执可用(HTTP 2xx / quick action 通道确认执行) */
  readonly transportOk: boolean;
  /** 服务端「接受」证据;无回执字段即 unknown,不猜 */
  readonly accepted?: ReceiptEvidence;
  /** 引擎「已应用」证据;只有引擎明确回执才允许 confirmed */
  readonly applied?: ReceiptEvidence;
}

/** 三路径判定结果(书 §19.1:transport_success ≠ accepted ≠ applied) */
export interface ThreePathVerdict {
  /** 传输层:回执可用(或上层证据反证传输成功) */
  readonly transportOk: boolean;
  /** accepted 判定:仅 confirmed 为 true */
  readonly accepted: boolean;
  /** applied 判定:仅 confirmed 为 true;unknown/denied 一律 false */
  readonly applied: boolean;
  /** accepted/applied 原始证据状态(回显/日志同源,不丢 unknown 信息) */
  readonly acceptedState: ReceiptEvidence;
  readonly appliedState: ReceiptEvidence;
  /** 最高已达路径:applied > accepted-unverified > sent-unverified > transport-failed */
  readonly path: 'applied' | 'accepted-unverified' | 'sent-unverified' | 'transport-failed';
  /** 结果一句话(回显/详情同源) */
  readonly detail: string;
}

const normalizeEvidence = (value: ReceiptEvidence | undefined): ReceiptEvidence =>
  value === 'confirmed' || value === 'denied' ? value : 'unknown';

/**
 * 三路径接受判定(纯函数):
 * - accepted=true 仅当 accepted 证据 confirmed;
 * - applied=true 仅当 applied 证据 confirmed——unknown 即 false,这是
 *   「未知不谎报已应用」铁律的编译外运行时闸门;
 * - accepted/applied 的 confirmed 回执本身反证传输成功(transportOk 升为 true):
 *   服务端/引擎能回执,传输必然已成功;
 * - applied=true 而 accepted=unknown 时 accepted 仍如实报 false(证据缺失
 *   不因更高层证据而补齐,各路径独立取证)。
 */
export function classifyThreePath(input: ThreePathInput): ThreePathVerdict {
  const acceptedState = normalizeEvidence(input.accepted);
  const appliedState = normalizeEvidence(input.applied);
  const accepted = acceptedState === 'confirmed';
  const applied = appliedState === 'confirmed';
  const transportOk = input.transportOk || accepted || applied;

  if (!transportOk) {
    return {
      transportOk,
      accepted,
      applied,
      acceptedState,
      appliedState,
      path: 'transport-failed',
      detail: '传输失败:请求未送达或通道未确认,不进入 accepted/applied 判定'
    };
  }
  if (applied) {
    return {
      transportOk,
      accepted,
      applied,
      acceptedState,
      appliedState,
      path: 'applied',
      detail: '引擎明确回执已应用(applied=confirmed),接受判定以此为准'
    };
  }
  if (accepted) {
    return {
      transportOk,
      accepted,
      applied,
      acceptedState,
      appliedState,
      path: 'accepted-unverified',
      detail: '服务端已接受(accepted=confirmed),引擎是否 applied 未知,不显示「已热更新」'
    };
  }
  return {
    transportOk,
    accepted,
    applied,
    acceptedState,
    appliedState,
    path: 'sent-unverified',
    detail: '已发送(未确认):传输回执可用,accepted/applied 均无证据,不显示「已热更新」'
  };
}

/**
 * 引擎 Digest 协商描桩(委托书 ③:未知标 unknown 不猜)。
 * HR-AUDIT-008:本仓库内引擎 Digest 算法零证据(唯一 sha256 是 logHub.ts
 * 日志去重,与 .def 无关;KBEngine.reloadEntityDef/isReload 已被审计否定为
 * 不存在的公开 API)。因此协商结果恒为未协商——接口留在莫,等引擎侧证据
 * (HR-AUDIT-009/HR-QA-015)到达后由版本化策略替换实现,签名不变得改。
 */
export const ENGINE_DIGEST_ALGORITHM = 'unknown' as const;

export interface DefDigestHandshake {
  /** 恒 'unknown':引擎 Digest 算法无仓库内证据,不猜 */
  readonly algorithm: typeof ENGINE_DIGEST_ALGORITHM;
  /** 恒 false:未协商成功 */
  readonly negotiated: false;
  /** unknown 边界声明(回显/日志同源) */
  readonly reason: string;
}

/** Digest 协商入口(描桩):恒返回 unknown/未协商,不做任何猜测性匹配 */
export function negotiateEngineDigest(): DefDigestHandshake {
  return {
    algorithm: ENGINE_DIGEST_ALGORITHM,
    negotiated: false,
    reason:
      '引擎 Digest 算法 unknown(HR-AUDIT-008:仓库内无证据);Digest 协商未执行,客户端 hash 不与引擎摘要比对'
  };
}

/** 引擎 Digest 比对请求:algorithm 未协商成功前 comparable 恒 false */
export interface DigestComparison {
  /** 恒 false 直到协商出已知算法;unknown 算法禁止比对 */
  readonly comparable: false;
  readonly reason: string;
}

/**
 * 引擎摘要比对闸门:unknown 算法一律拒绝比对,防止拿客户端 sha256 冒充
 * 引擎 Digest 得出「内容一致/已应用」的假结论。
 */
export function compareEngineDigest(
  handshake: DefDigestHandshake,
  _clientHash: DefContentHash
): DigestComparison {
  if (handshake.algorithm === 'unknown' || !handshake.negotiated) {
    return {
      comparable: false,
      reason: `Digest 算法 ${handshake.algorithm} 未协商,拒绝比对客户端 hash(不猜引擎算法)`
    };
  }
  // 描桩不可达:类型上 algorithm 只有 'unknown';真实现随引擎证据落地时替换。
  return {
    comparable: false,
    reason: `Digest 算法 ${handshake.algorithm} 无比对实现(描桩)`
  };
}

/**
 * HR-PR-02 回执链路接入(委托书 ④):把 tempEdit 的 outcome(回显已走
 * 输出+问题通道)映射为三路径判定。映射口径:
 * - phase='sent-unverified':传输 ok,accepted/applied 取外部证据(缺省
 *   unknown)——这正是 HR-PR-02「已发送(未确认)」语义的三路径化;
 * - 其余 phase(读/写/还原/通道失败):transportOk=false;
 * - applied 依旧只信引擎明确回执,本映射自身永不产生 confirmed。
 */
export function verdictFromTempEditOutcome(
  outcome: TempEditReloadOutcome,
  receipt?: { readonly accepted?: ReceiptEvidence; readonly applied?: ReceiptEvidence }
): ThreePathVerdict {
  return classifyThreePath({
    transportOk: outcome.phase === 'sent-unverified' && outcome.transportOk,
    accepted: receipt?.accepted,
    applied: receipt?.applied
  });
}

/** 三路径回显行(复用 HR-PR-02 的符号口径:✓/✗/●,已发送(未确认)文案) */
export function formatThreePathEcho(
  label: string,
  hash: DefContentHash,
  verdict: ThreePathVerdict
): string {
  const shortDigest = `${hash.digest.slice(0, 12)}…(${hash.byteLength}B)`;
  if (verdict.path === 'transport-failed') {
    return `✗ .def 判定[${label}] sha256=${shortDigest} 三路径:传输失败 · accepted=${verdict.acceptedState} · applied=${verdict.appliedState}`;
  }
  const head =
    verdict.path === 'applied'
      ? '引擎明确回执已应用'
      : verdict.path === 'accepted-unverified'
        ? '已接受(未确认应用)'
        : '已发送(未确认)';
  return `● .def 判定[${label}] sha256=${shortDigest} 三路径:传输✓ ${head} · accepted=${verdict.acceptedState} · applied=${verdict.appliedState}`;
}
