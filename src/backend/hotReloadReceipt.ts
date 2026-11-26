/**
 * Parse a single-target accepted receipt (IDE-HOT-003): the recorded
 * protocol is a JSON object
 * {"status":"accepted","file":"<an echo byte-identical to the file sent>"},
 * with optional "targetId" (if present it must match the target) and
 * "request_id" (the F5 correlation id; if present it must match this
 * send's correlation marker); extra fields are ignored and only the
 * recorded fields are recognized.
 * Only a field-by-field match of that contract promotes the ledger record
 * to accepted; unknown structures (not JSON / JSON that is not an object /
 * a status value other than 'accepted' / a missing or mismatching file echo)
 * and any other status value ('applied' is HOT-004's verification surface,
 * 'ok'/'queued' are unrecorded) are all kept unconfirmed -- never guessed
 * at and never promoted.
 */

import type { HotReloadTargetKey, HotReloadTargetStateStore } from './hotReloadTargetState';

export interface HotReloadReceiptExpectation {
  /** Absolute path of the file sent (the receipt only counts if it echoes it byte for byte) */
  file: string;
  /** Target instance id; if the receipt carries a targetId it must match */
  targetId?: string;
  /** F5 correlation id: this send's correlation marker; if the receipt carries a request_id it must match */
  requestId?: string;
}

export type HotReloadReceiptParse =
  | { kind: 'accepted'; file: string }
  | { kind: 'not-accepted'; reason: string };

/** Only the recorded protocol is recognized; anything nonconforming stays unconfirmed */
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
  if (receipt.request_id !== undefined && receipt.request_id !== expected.requestId) {
    return { kind: 'not-accepted', reason: '回执 request_id 与本次发送关联标识不一致:不升格' };
  }
  return { kind: 'accepted', file: receipt.file };
}

/**
 * Promotion happens on the spot: if the protocol matches, the
 * (rootId,targetId,file) record is promoted to accepted; if it does not,
 * the ledger is left as it is, unconfirmed (no existing record touched).
 * Carrying an attempt (IDE-AUD-005) means writing back bound to the owning
 * send generation -- if the record has already moved to a new generation the
 * write is refused and nothing is touched.
 */
export function applyAcceptedReceipt(
  store: HotReloadTargetStateStore,
  key: HotReloadTargetKey,
  file: string,
  body: string,
  options: { now?: number; attempt?: number } = {}
): HotReloadReceiptParse {
  const verdict = parseHotReloadAcceptedReceipt(body, { file, targetId: key.targetId });
  if (verdict.kind === 'accepted') {
    store.record(key, file, 'accepted', {
      detail: '回执 accepted:file 回显一致(应用仍需 HOT-004 核验)',
      now: options.now,
      attempt: options.attempt
    });
  }
  return verdict;
}
