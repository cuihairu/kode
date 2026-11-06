/**
 * 核验单目标 applied 状态(IDE-HOT-004):已记录协议的 applied 回执=
 * JSON {"status":"applied","file":"<与所发文件逐字一致的回显>",
 * "digest":"<所发内容的 sha256 hex>"}——digest 用现成原语(node:crypto
 * sha256,与 hotReloadDefHash 同源)对所发内容重算比对,对得上才标
 * applied(可信 digest+已验证回执双证);digest 缺失/不符/回执不合规
 * (非 JSON/状态非 applied/回显不一致)一律不升格,台账原样保留。
 * 超时结算(settleAppliedStatus):仍未确认的保持未确认
 * (unconfirmed-timeout),不冒充失败也不冒充 applied;revision 证据
 * 标签语义是 HOT-008 的面,本级只认 digest。
 */

import { createHash } from 'crypto';

import type { HotReloadDeliveryRecord, HotReloadTargetKey, HotReloadTargetStateStore } from './hotReloadTargetState';

/**
 * applied 核验窗口(IDE-REV-023):到点仍未确认只注解超时,不冒充任何终态。
 * 常量落在本模块(结算语义的归属地),hotReload/通道发送/重试路径共用同一值。
 */
export const HOT_RELOAD_APPLIED_SETTLE_MS = 10_000;

export type AppliedReceiptVerdict =
  | { kind: 'applied'; digest: string }
  | { kind: 'not-applied'; reason: string }
  | { kind: 'stale' };

export interface AppliedVerifyOptions {
  /** 所发文件原始内容(digest 比对基准)——sentDigest 未给时用它现算 */
  sentContent?: string;
  /** 发送时点冻结的内容 sha256(IDE-AUD-006):优先用它,不 re-read 文件当前内容冒充所发 */
  sentDigest?: string;
  now?: number;
  /**
   * 所属发送代际(IDE-AUD-005):绑定该回执属于哪次发送。与当前记录代际
   * 不符=旧代异步回执,绝不写回(返回 stale);未给(纯单测/无代际面)
   * 走旧行为直接写回。
   */
  attempt?: number;
}

/** 逐字段核验:协议符合且 digest 与所发内容一致才 applied */
export function verifyAppliedReceipt(
  store: HotReloadTargetStateStore,
  key: HotReloadTargetKey,
  file: string,
  body: string,
  options: AppliedVerifyOptions
): AppliedReceiptVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: 'not-applied', reason: '回执非 JSON:未知结构不升格' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'not-applied', reason: '回执不是 JSON 对象:未知结构不升格' };
  }
  const receipt = parsed as Record<string, unknown>;
  if (receipt.status !== 'applied') {
    return { kind: 'not-applied', reason: `回执状态非 applied(得到 ${JSON.stringify(receipt.status) ?? 'undefined'}):不升格` };
  }
  if (typeof receipt.file !== 'string' || receipt.file !== file) {
    return { kind: 'not-applied', reason: '回执 file 回显缺失或与所发文件不一致:不升格' };
  }
  if (receipt.targetId !== undefined && receipt.targetId !== key.targetId) {
    return { kind: 'not-applied', reason: '回执 targetId 与目标不一致:不升格' };
  }
  if (typeof receipt.digest !== 'string' || receipt.digest.length === 0) {
    return { kind: 'not-applied', reason: '回执无 digest:无可信 revision/digest 证据,不升格' };
  }
  // 现成原语重算比对:所发内容 UTF-8 sha256(hotReloadDefHash 同源,不自创)。
  // IDE-AUD-006:优先用发送时点冻结的基准(传入 sentDigest),不再拿响应后文件
  // 当前内容冒充所发版本;两者都没有=无基准(如实不升格,注解阻塞)。
  const expected =
    options.sentDigest ??
    (options.sentContent !== undefined
      ? createHash('sha256').update(Buffer.from(options.sentContent, 'utf8')).digest('hex')
      : undefined);
  if (expected === undefined) {
    return { kind: 'not-applied', reason: '发送时点内容基准缺失,digest 无基准' };
  }
  if (receipt.digest !== expected) {
    return { kind: 'not-applied', reason: '回执 digest 与所发内容不符:可疑回执不升格' };
  }
  const updated = store.record(key, file, 'applied', {
    detail: `回执 applied 且 digest 一致(${expected.slice(0, 12)}…):已应用`,
    now: options.now,
    attempt: options.attempt
  });
  // IDE-AUD-005:绑定代际写回被拒=更新的发送已接管该记录,旧代回执作废
  if (!updated) {
    return { kind: 'stale' };
  }
  return { kind: 'applied', digest: expected };
}

export type AppliedSettleStatus = 'applied' | 'unconfirmed-timeout' | 'pending' | 'failed';

/**
 * 超时结算:applied→applied;failed 如实 failed;其余在截止前 pending,
 * 过了截止仍未确认→unconfirmed-timeout(保持未确认语义,不冒充失败
 * 也不冒充 applied)。
 */
export function settleAppliedStatus(
  record: HotReloadDeliveryRecord | undefined,
  options: { deadlineMs: number; now(): number }
): AppliedSettleStatus {
  if (!record) {
    return 'unconfirmed-timeout';
  }
  if (record.outcome === 'applied') {
    return 'applied';
  }
  if (record.outcome === 'failed') {
    return 'failed';
  }
  return options.now() > options.deadlineMs ? 'unconfirmed-timeout' : 'pending';
}
