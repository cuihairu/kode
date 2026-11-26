/**
 * Operation entry for retrying failed targets (IDE-REV-026, formerly
 * IDE-HOT-007): the batch ledger only picks targets with outcome=failed and
 * resends them through the real action entry — the confirmed-success side
 * (applied/accepted/sent-unverified, all already sent) is never resent, the
 * send count does not grow (resending = duplicate delivery); the cancel
 * token is probed before each hop is initiated, and targets not yet
 * initiated after cancellation are not sent. Resend recording goes through
 * the same HOT-002..004 existing faces as the fire path: the no-response
 * face records sent-unverified/failed, the HTTP response is classified by
 * transport facts (2xx = unconfirmed delivery / non-2xx = failed), a 2xx
 * reply is promoted level by level toward accepted/applied with a parallel
 * verification window settle — after a successful resend the ledger
 * honestly flips over and does not stay on the old failed entry
 * masquerading as still unrecovered.
 */

import { createHash } from 'crypto';

import { retryFailedHotReloadTargets, type HotReloadRetryAction, type HotReloadSendResult } from './hotReloadRetry';
import { summarizeHotReloadBatch } from './hotReloadBatchSummary';
import {
  HOT_RELOAD_APPLIED_SETTLE_MS,
  type HotReloadHttpResponse,
  type HotReloadSendOptions,
  type HotReloadTargetStateWiring,
  type HotReloadTimerDeps
} from '../hotReload';
import type { DefGateCheckVerdict } from './hotReloadDefGate';
import type { HotReloadTargetKey, HotReloadTargetStateStore } from './hotReloadTargetState';
import type { ReloadTransport } from './hotReloadTransport';
import { sendFilesViaReloadChannel } from './hotReloadChannelSend';
import { recordHttpDelivery } from './hotReloadDelivery';
import { applyAcceptedReceipt } from './hotReloadReceipt';
import { settleAppliedStatus, verifyAppliedReceipt } from './hotReloadAppliedCheck';

export interface HotReloadResendDeps {
  /** The real action entry (real wiring = the unattended quickActionManager.runByName channel) */
  runAction(actionName: string, sendOptions?: HotReloadSendOptions): void | Promise<unknown>;
  /** targetId → action name reverse lookup (real wiring scans the quick action tree; unresolved = null, that target is honestly not resent) */
  resolveActionNameForTarget(targetId: string): string | null | Promise<string | null>;
  /** Ledger wiring (same injection face as the fire path); without injection the resend is not recorded */
  readonly targetState?: HotReloadTargetStateWiring;
  /** IDE-REV-027 engine digest evidence port: resend reply bodies feed the evidence ledger (same as the fire path) */
  readonly noteEngineDigest?: (
    key: { rootId: string; targetId: string },
    file: string,
    body: string | undefined
  ) => void;
  readonly timers: HotReloadTimerDeps;
  /** Set of applied verification window settle handles, cleared when the command is disposed (same convention as the fire path) */
  readonly settleHandles: Set<unknown>;
  /** Clock injection port (for tests); defaults to the real Date.now */
  readonly now?: () => number;
  /**
   * def structure gate (RT-3 / IDE-HOT-005): shares the same instance and
   * the same session baseline ledger with the fire path (hotReloadDefGate).
   * Injected means the gate runs before resending — structural def changes/
   * missing baseline/unreadable are never sent (a block is a conservative
   * block, not a delivery failure, and is not recorded), non-structural def
   * and pure Python batches resend as usual. Without injection there is no
   * defense (compatible with the existing assembly; real wiring must inject).
   * F1: the gate's commit port rolls the baseline forward with this batch's
   * token when a retry passes and really resends (optional, defaults to not
   * rolling); a blocked batch's token claims no snapshot.
   */
  readonly defGate?: {
    check(files: readonly string[]): Promise<DefGateCheckVerdict>;
    commit?(token: number): Promise<void>;
  };
  /** Structure-gate block notification (the wiring side marks the files into the state machine's RESTART_REQUIRED presentation face) */
  readonly onRestartRequired?: (
    targetId: string,
    files: readonly string[],
    reasons: readonly string[]
  ) => void;
  /**
   * Cross fix (2026-11-05 second review round): deploy channel send port
   * (same injection face as the fire path). Deploy channel targets are
   * profile IDs, which the quick action reverse lookup cannot find — when
   * the failed-retry target is the current deploy channel target it must be
   * routed back to the same send channel (resolveChannelTransport), or the
   * retry either finds no action (the retry is a no-op) or takes the wrong
   * channel. Without injection or on a target mismatch, fall back to the
   * existing action reverse lookup path, behavior unchanged.
   */
  readonly resolveChannelTransport?: () => { transport: ReloadTransport; targetId: string } | null;
}

/** The annotation only appends block/timeout reasons to still-unverified records and never touches accepted/applied/failed (same as the fire path); IDE-AUD-005: bound to its own send generation, annotations from an older generation are rejected */
const noteStillUnverified = (
  wiring: HotReloadTargetStateWiring,
  key: HotReloadTargetKey,
  file: string,
  reason: string,
  attempt: number
): void => {
  const current = wiring.store.get(key, file);
  if (!current || current.outcome !== 'sent-unverified' || (current.detail ?? '').includes(reason)) {
    return;
  }
  wiring.store.record(key, file, 'sent-unverified', {
    detail: [current.detail, reason].filter(Boolean).join(' | '),
    now: current.recordedAt,
    attempt
  });
};

/**
 * Initiates one real resend for a single failed target and records it per
 * the existing faces: file face = every recorded file under that target
 * (the action takes the instance as receiver, so the resend delivers the
 * whole unit); response face semantics align word for word with the fire
 * path. An unresolvable action / a thrown action both honestly return
 * ok=false, never masquerading as sent.
 */
export async function resendHotReloadTarget(
  store: HotReloadTargetStateStore,
  key: HotReloadTargetKey,
  deps: HotReloadResendDeps
): Promise<HotReloadSendResult> {
  const files = store.files(key);
  // RT-3 (IDE-HOT-005): the def structure gate runs before resending, same
  // verdict and same session baseline ledger as the fire path. Structural
  // def changes/missing baseline/unreadable never send a plain reload (a
  // block is a conservative block, not a delivery failure: nothing is
  // recorded, the ledger keeps the old failed entry as-is), and it issues
  // the restart-required notification.
  if (deps.defGate) {
    const verdict = await deps.defGate.check(files);
    if (verdict.reasons.length > 0) {
      deps.onRestartRequired?.(key.targetId, files, verdict.reasons);
      const first = verdict.reasons[0] ?? 'def 结构待核';
      return {
        ok: false,
        detail: `结构性 def 变更需要重启,重试不发普通 reload:${first}${verdict.reasons.length > 1 ? ` 等 ${verdict.reasons.length} 项` : ''}`
      };
    }
    // F1: a retry passing means a real resend — the baseline rolls forward
    // with this batch's token to what is being sent now (same convention as
    // the fire path); blocked batches never reach here and are not in the
    // claim queue, the baseline stays at the engine's loaded version, and
    // repeated retries keep blocking.
    try {
      await deps.defGate.commit?.(verdict.token);
    } catch {
      // A failed roll-forward does not block the resend (the next verdict conservatively blocks on the old baseline)
    }
  }
  const wiring = deps.targetState;
  const now = deps.now ?? Date.now;
  // Cross fix (round two): deploy channel targets are profile IDs the quick
  // action lookup cannot find — when the retry target is the current deploy
  // channel target it routes back to the same send channel; the send core
  // (hotReloadChannelSend) is shared with the fire path: generation
  // creation/frozen digest/applied dual-evidence verification/generation-
  // bound settle all share the same semantics.
  const channelHandle = deps.resolveChannelTransport?.() ?? null;
  if (channelHandle && channelHandle.targetId === key.targetId) {
    const outcome = await sendFilesViaReloadChannel({
      transport: channelHandle.transport,
      targetId: channelHandle.targetId,
      files,
      resolveRootId: file => wiring?.resolveRootId(file) ?? null,
      store: wiring?.store,
      readFileContent: wiring?.readFileContent,
      timers: deps.timers,
      settleHandles: deps.settleHandles,
      now,
      source: 'retry'
    });
    if (outcome.failedCount > 0 && outcome.sentCount === 0) {
      return {
        ok: false,
        detail: `部署通道重发失败(${outcome.failedCount} 个文件未送达)`
      };
    }
    return {
      ok: outcome.failedCount === 0,
      detail: outcome.failedCount > 0
        ? `部署通道部分失败(${outcome.failedCount} 失败/${outcome.sentCount} 已发)`
        : `已重新发送(部署通道 ${channelHandle.transport.kind},未校验业务回执)`
    };
  }
  const actionName = await deps.resolveActionNameForTarget(key.targetId);
  if (actionName === null) {
    return { ok: false, detail: `找不到以 ${key.targetId} 为接收方的动作,无法重发` };
  }
  const sentAt = now();
  // IDE-AUD-006: freeze the content verification baseline before sending —
  // read the content once before runAction and compute sha256; all post-
  // response verification uses it and carries it into the ledger sentDigest;
  // never re-read the file's current content after the response and pass it
  // off as the sent version. A failed read = no baseline (honestly
  // undefined, the verification face annotates it as blocked).
  const baselineReader = wiring?.readFileContent;
  const baselineReads = new Map<string, Promise<string | undefined>>();
  if (baselineReader) {
    for (const file of files) {
      baselineReads.set(
        file,
        Promise.resolve(baselineReader(file))
          .then(content =>
            content === null
              ? undefined
              : createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
          )
          .catch(() => undefined)
      );
    }
  }
  let responseSeen = false;
  const handleResponse = (response: HotReloadHttpResponse): void => {
    responseSeen = true;
    if (!wiring) {
      return;
    }
    for (const file of files) {
      // IDE-REV-027: resend reply bodies feed the engine digest evidence
      // ledger (protocol and attribution are judged inside the ledger)
      deps.noteEngineDigest?.(key, file, response.body);
      // The observer only fires when a response arrives → the transport
      // succeeded, classification follows status
      const record = recordHttpDelivery(wiring.store, key, file, { ok: true, status: response.status }, {});
      // IDE-AUD-005: resend generation — receipts/annotations/verification
      // settles bind to it, an older generation's async results never change
      // the new generation's record
      const attempt = record.attempt;
      if (record.outcome === 'sent-unverified' && typeof response.body === 'string' && response.body.length > 0) {
        applyAcceptedReceipt(wiring.store, key, file, response.body, { attempt });
        if (!baselineReader) {
          noteStillUnverified(wiring, key, file, 'applied 核验阻塞:无内容读取通道,digest 无基准', attempt);
        } else {
          // When the receipt's file is not in this send batch (anomalous or
          // forged receiver reply) baselineReads has no such key — the old
          // implementation took .then on undefined, throwing TypeError and
          // interrupting the receipt callback batch; fall back to "no
          // baseline stays unverified" instead of crashing.
          const sentDigestPromise = baselineReads.get(file);
          if (sentDigestPromise === undefined) {
            noteStillUnverified(
              wiring,
              key,
              file,
              'applied 核验阻塞:发送批无该文件基准,保持未确认',
              attempt
            );
          } else {
            void sentDigestPromise.then(sentDigest => {
              if (sentDigest === undefined) {
                noteStillUnverified(
                  wiring,
                  key,
                  file,
                  'applied 核验阻塞:发送时点内容基准不可读,digest 无基准',
                  attempt
                );
                return;
              }
              // IDE-AUD-006: the baseline frozen at send time goes into the
              // ledger (auditable); under the generation guard it only writes
              // in the current generation (a generation change refuses, an
              // old generation's baseline never pollutes new generation
              // records), and it never rewrites an already promoted outcome
              // (accepted/applied stay as-is)
              const currentAtWrite = wiring.store.get(key, file);
              if (currentAtWrite) {
                wiring.store.record(key, file, currentAtWrite.outcome, { sentDigest, attempt });
              }
              const verdict = verifyAppliedReceipt(wiring.store, key, file, response.body as string, {
                sentDigest,
                attempt
              });
              if (verdict.kind === 'not-applied') {
                noteStillUnverified(wiring, key, file, `applied 核验阻塞:${verdict.reason}`, attempt);
              }
            });
          }
        }
        // The verification window settles on its deadline: still-unverified
        // only gets a timeout annotation, never masquerading as any terminal
        // state; a generation mismatch leaves it untouched
        const handle = deps.timers.set(() => {
          deps.settleHandles.delete(handle);
          const current = wiring.store.get(key, file);
          if (!current || current.attempt !== attempt) {
            return;
          }
          const verdict = settleAppliedStatus(current, {
            deadlineMs: sentAt + HOT_RELOAD_APPLIED_SETTLE_MS,
            now
          });
          if (verdict === 'unconfirmed-timeout') {
            noteStillUnverified(
              wiring,
              key,
              file,
              `applied 核验超时(${Math.round(HOT_RELOAD_APPLIED_SETTLE_MS / 1000)}s 窗口):保持未确认`,
              attempt
            );
          }
        }, HOT_RELOAD_APPLIED_SETTLE_MS);
        deps.settleHandles.add(handle);
      }
    }
  };
  const sendOptions: HotReloadSendOptions | undefined = wiring ? { onHttpResponse: handleResponse } : undefined;
  try {
    // AUD-053: on the quick action channel false = not executed/failed while
    // resolve does not reject — the old implementation recorded
    // sent-unverified right after the await and returned ok:true, passing
    // false off as a successful resend; it must honestly be ok=false plus a
    // failed record.
    const echoed = await Promise.resolve(deps.runAction(actionName, sendOptions));
    if (echoed === false) {
      const message = 'quick action 回执 false:未执行/失败';
      if (!responseSeen && wiring) {
        for (const file of files) {
          wiring.store.record(key, file, 'failed', { detail: message });
        }
      }
      return { ok: false, detail: message };
    }
    if (!responseSeen && wiring) {
      // No response face (script/command actions): transport/execution
      // success != applied success, record unverified only
      for (const file of files) {
        wiring.store.record(key, file, 'sent-unverified', {});
      }
    }
    return {
      ok: true,
      detail: responseSeen ? '已重新发送(响应已按传输事实落账)' : '已重新发送(未确认——无回执面)'
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!responseSeen && wiring) {
      for (const file of files) {
        wiring.store.record(key, file, 'failed', { detail: message });
      }
    }
    return { ok: false, detail: message };
  }
}

const ACTION_LABELS: Record<HotReloadRetryAction['action'], string> = {
  resent: '已重发',
  'skipped-confirmed': '不重发(已确认侧,重发=重复投递)',
  'skipped-cancelled': '跳过(已取消,未发起不冒充已发)'
};

/** Retry report: header counts + one action line per target (resend results passed through, failures presented honestly) */
export function renderHotReloadRetryReport(actions: HotReloadRetryAction[]): string {
  if (actions.length === 0) {
    return '无投递记录,没有可重试的目标';
  }
  const count = (kind: HotReloadRetryAction['action']): number => actions.filter(a => a.action === kind).length;
  const lines = [
    `失败目标重试:重发 ${count('resent')} 个,不重发(已确认侧) ${count('skipped-confirmed')} 个,取消跳过 ${count('skipped-cancelled')} 个`
  ];
  for (const action of actions) {
    lines.push(`${action.keyId} → ${ACTION_LABELS[action.action]}`);
    if (action.detail !== undefined) {
      lines.push(`  ${action.detail}`);
    }
    if (action.action === 'resent' && action.result) {
      lines.push(`  重发结果: ${action.result.ok ? '已发送' : '失败'}${action.result.detail !== undefined ? `:${action.result.detail}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** Presentation face injection: write the log block + open the channel; test fakes share the shape */
export interface HotReloadRetryView {
  logBlock(text: string): void;
  show(): void;
}

export interface HotReloadRetryCommandDeps extends HotReloadResendDeps {
  /** Cancel probe: probed once before each hop is initiated; real wiring = the withProgress progress notification token */
  isCancelled(): boolean;
}

/** Command body: aggregate the ledger → retry only failed targets → log the report into the "KBEngine Hot Reload" channel; an empty ledger honestly reports nothing to retry */
export async function runHotReloadRetryCommand(
  store: HotReloadTargetStateStore,
  deps: HotReloadRetryCommandDeps,
  view: HotReloadRetryView
): Promise<void> {
  const summary = summarizeHotReloadBatch(store);
  if (summary.status === 'no-targets') {
    view.logBlock(renderHotReloadRetryReport([]));
    view.show();
    return;
  }
  const actions = await retryFailedHotReloadTargets(summary, {
    send: key => resendHotReloadTarget(store, key, deps),
    isCancelled: () => deps.isCancelled()
  });
  view.logBlock(renderHotReloadRetryReport(actions));
  view.show();
}
