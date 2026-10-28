/**
 * 解析单目标 accepted 回执(IDE-HOT-003):已记录协议=JSON 对象
 * {"status":"accepted","file":"<与所发文件逐字一致的回显>"},可选
 * "targetId"(给了就必须与目标一致);额外字段忽略,只认已记录字段。
 * 只有逐字段符合该契约才把台账记录升格 accepted;未知结构(非 JSON/
 * JSON 非对象/状态值不是 'accepted'/file 回显缺失或不一致)与其他
 * 状态值('applied' 是 HOT-004 的核验面、'ok'/'queued' 未记录)一律
 * 保留未确认,不猜、不升格。
 */

import type { HotReloadTargetKey, HotReloadTargetStateStore } from './hotReloadTargetState';

export interface HotReloadReceiptExpectation {
  /** 所发文件绝对路径(回执必须逐字回显它才认) */
  file: string;
  /** 目标实例 id;回执给了 targetId 就必须一致 */
  targetId?: string;
}

export type HotReloadReceiptParse =
  | { kind: 'accepted'; file: string }
  | { kind: 'not-accepted'; reason: string };

/** 只认已记录协议;一切不符合保留未确认 */
export function parseHotReloadAcceptedReceipt(
  body: string,
  expected: HotReloadReceiptExpectation
): HotReloadReceiptParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: 'not-accepted', reason: '回执非 JSON:未知结构保留未确认' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'not-accepted', reason: '回执不是 JSON 对象:未知结构保留未确认' };
  }
  const receipt = parsed as Record<string, unknown>;
  if (receipt.status !== 'accepted') {
    return {
      kind: 'not-accepted',
      reason: `回执状态非 accepted(得到 ${JSON.stringify(receipt.status) ?? 'undefined'}):保留未确认`
    };
  }
  if (typeof receipt.file !== 'string' || receipt.file !== expected.file) {
    return { kind: 'not-accepted', reason: '回执 file 回显缺失或与所发文件不一致:不升格' };
  }
  if (receipt.targetId !== undefined && receipt.targetId !== expected.targetId) {
    return { kind: 'not-accepted', reason: '回执 targetId 与目标不一致:不升格' };
  }
  return { kind: 'accepted', file: receipt.file };
}

/**
 * 升格即入账:协议符合 → 该 (rootId,targetId,file) 记录升格
 * accepted;不符合 → 台账原样保留未确认(不动既有记录)。
 */
export function applyAcceptedReceipt(
  store: HotReloadTargetStateStore,
  key: HotReloadTargetKey,
  file: string,
  body: string,
  options: { now?: number } = {}
): HotReloadReceiptParse {
  const verdict = parseHotReloadAcceptedReceipt(body, { file, targetId: key.targetId });
  if (verdict.kind === 'accepted') {
    store.record(key, file, 'accepted', {
      detail: '回执 accepted:file 回显一致(应用仍需 HOT-004 核验)',
      now: options.now
    });
  }
  return verdict;
}
