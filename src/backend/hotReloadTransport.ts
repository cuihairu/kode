/**
 * Reload channel abstraction (IDE-HOT-101): the ReloadTransport interface + two built-in implementations.
 * Design: docs/design/hot-reload-design.md §4.
 *
 * Channel = the transport face that "delivers a set of files to the target instance to trigger a reload". Two built-in implementations:
 * - 'kbengine-official' = the KBEngine official approach: via the KBEngineTelnetClient console run
 *   KBEngine.reloadScript(fullReload) against baseapp/cellapp. The engine has no HTTP receipt
 *   protocol (AUD-007 field survey); this implementation only provides "command sent / console echoed" level evidence,
 *   and a plain engine stays unconfirmed; a process with the demo observer can return an execution receipt carrying fingerprints.
 * - 'http' = the HTTP/xreload approach: reuses the HttpRequestEntry template (url/method/headers/
 *   body), extending the ${files} (file list JSON) / ${fileList} (comma-separated) placeholders; the response body goes through
 *   the existing accepted/applied protocol (HOT-003/004) parsing; the official channel via the demo
 *   observer can also return an identically-shaped verification receipt.
 *
 * Channel selection: resolveReloadTransport(hotReload section under the deployment config) -> channel implementation,
 * unconfigured/unknown -> null (the caller falls back to the existing actionName quick action channel).
 *
 * Structurally-def batches enter no channel: the caller (the HOT-005 structural gate in setupHotReload)
 * intercepts before the channel's send, and this module is unaware of def structure (design §4.4). Wiring the channel
 * into the fire path + the config panel is the scope of IDE-HOT-102; this level delivers the abstraction + implementations + selection.
 */

import { defaultTransport as httpDefaultTransport, DEFAULT_HTTP_TIMEOUT_MS } from './httpRequestService';
import { decideHttpEndpoint } from './httpEndpointPolicy';
import { formatReloadTransportThrownError } from './hotReloadTransportErrors';
import { sendErrorToEndpointHealth, sendStatusToEndpointHealth } from './hotReloadEndpointHealth';
import type { HttpRequestEntry } from './httpRequests';
import { BUILTIN_HTTP_REQUEST_EXAMPLE } from './httpRequests';
import { resolveVariableExpression, type VariableContext } from './variableSubstitution';
import { KBEngineTelnetClient } from './telnetClient';
import { randomUUID } from 'crypto';

export type ReloadTransportKind = 'kbengine-official' | 'http';

/** Delivery target: rootId (the file-ownership scan root) + targetId (the service instance, e.g. baseapp/cellapp) */
export interface ReloadTarget {
  readonly rootId: string;
  readonly targetId: string;
}

/**
 * Receipt stream entry. 'sent' = sent / console-echoed level evidence (official channel; the engine has no receipt
 * protocol, so it never claims applied); 'accepted'/'applied' = the HTTP channel parsed per the HOT-003/004 protocol
 * (only recognized when the response body echoes the sent file verbatim); 'failed' = delivery failed.
 */
export type ReloadReceipt =
  | { status: 'sent'; file?: string; detail: string; requestId?: string }
  | {
      status: 'accepted';
      file: string;
      digest?: string;
      note?: string;
      /** F4: receipt carries an explicit targetId (a receipt that disagrees with the expected target is rejected at the parse layer) */
      targetId?: string;
      /**
       * RUST-420 (HR-QA-008): endpoint policy security warning (carried along with the receipt when a non-loopback
       * endpoint is authorized, visible per-send in the ledger). Absent by default; kept separate from the protocol-side note, no mixing.
       */
      detail?: string;
      /** F5 (correlation id): the correlation identifier of the send request this receipt belongs to (generated per send on the sending side) */
      requestId?: string;
    }
  | {
      status: 'applied';
      file: string;
      digest?: string;
      revision?: number;
      /** F4: receipt carries an explicit targetId (a receipt that disagrees with the expected target is rejected at the parse layer) */
      targetId?: string;
      /**
       * RUST-420 (HR-QA-008): endpoint policy security warning (same as accepted -- applied has no protocol
       * text field, so the security warning is carried here). Absent by default.
       */
      detail?: string;
      /** F5 (correlation id): the correlation identifier of the send request this receipt belongs to (generated per send on the sending side) */
      requestId?: string;
    }
  | { status: 'failed'; file?: string; reason: string; targetId?: string; requestId?: string };

export interface ReloadSendSummary {
  readonly kind: ReloadTransportKind;
  readonly receipts: ReloadReceipt[];
}

export interface ReloadTransport {
  readonly kind: ReloadTransportKind;
  /** Connectivity test (config panel button): HTTP = endpoint reachable; official = console connectable */
  probe(): Promise<{ ok: boolean; detail: string }>;
  /**
   * Send a set of files to reload. Receipts are pushed one by one via onReceipt; returns the summary (the same batch of receipts).
   * Implementation guarantees: the official channel never produces applied; the HTTP channel produces
   * accepted/applied only when the response protocol matches, and unrecognized files land as 'sent' (delivered, no protocol receipt).
   * F3 third round: senderDigests = the content sha256 frozen at send time (file -> hex, optional) --
   * delivered with the message (sender_digests field); the receiver can only return
   * applied after verifying the application artifact against it; if not given, the receiver cannot verify against the sender's frozen baseline and will not return applied.
   */
  send(
    target: ReloadTarget,
    fileSet: readonly string[],
    onReceipt: (receipt: ReloadReceipt) => void,
    senderDigests?: ReadonlyMap<string, string>
  ): Promise<ReloadSendSummary>;
}

/** ${files} file-list placeholder (JSON array) and ${fileList} (comma-separated) */
export const RELOAD_FILES_PLACEHOLDER = '${files}';
export const RELOAD_FILE_LIST_PLACEHOLDER = '${fileList}';
/** F4: ${targetId} = send target identifier (substituted on the channel side, so requests can distinguish/address the target instance) */
export const RELOAD_TARGET_ID_PLACEHOLDER = '${targetId}';

/**
 * Substitute the reload-specific placeholders + the existing variable table:
 * ${files} = the JSON array of fileSet; ${fileList} = comma-separated; any other ${...} goes through the existing
 * variable resolution, and unknown placeholders are preserved as-is (batch 105 convention), not swallowed.
 */
export function substituteReloadVariables(
  text: string,
  fileSet: readonly string[],
  context: VariableContext = { folders: [] }
): string {
  const filesJson = JSON.stringify(fileSet);
  const fileList = fileSet.join(',');
  return text.replace(/\$\{([^${}]*)\}/g, (raw, expression: string) => {
    const trimmed = expression.trim();
    if (trimmed === 'files') {
      return filesJson;
    }
    if (trimmed === 'fileList') {
      return fileList;
    }
    const resolved = resolveVariableExpression(expression, context);
    return resolved === undefined ? raw : resolved;
  });
}

/* ------------------------------------------------------------------ */
/* HTTP channel                                                        */
/* ------------------------------------------------------------------ */

export interface ReloadHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  maxResponseBytes?: number;
}

export interface ReloadHttpResponse {
  status: number;
  body: string;
  bodyTruncated?: true;
}

export type ReloadHttpRunner = (request: ReloadHttpRequest) => Promise<ReloadHttpResponse>;

/**
 * F5 (correlation id): the correlation identifier generated per send on the sending side. A JSON object request body gets
 * request_id automatically attached (not overwritten if the template already gives it explicitly); the receiver echoes it
 * verbatim per the contract, and the sending side uses it to attribute receipts precisely to the send they belong to (out-of-order/late
 * receipts across sends no longer rely on guessing via targetId+file). Monotonic sequence + clock + random tail, unique lower bound = no repetition within the same process lifetime.
 */
let nextRequestSeq = 0;
export function generateReloadRequestId(): string {
  nextRequestSeq += 1;
  return `req-${Date.now().toString(36)}-${nextRequestSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Single source for HTTP channel request construction (RUST-358/HR-HTTP-016): send and preview share
 * the same construction, so the preview and the actual send are byte-for-byte identical in shape (drift prevention). The ${targetId} placeholder is replaced with the send target identifier before variable
 * substitution; a JSON object request body gets targetId auto-attached (F4 second round) and
 * sender_digests (F3 third round, not overwritten if the template already gives it explicitly; when digests are not given, honestly
 * do not attach -- if the preview has no baseline digest, do not fake that field). request_id (F5 correlation id)
 * is attached the same way: if not given (zero sends in preview), do not attach, do not fake a correlation.
 */
export function buildReloadHttpRequest(
  entry: HttpRequestEntry,
  target: ReloadTarget,
  fileSet: readonly string[],
  context?: VariableContext,
  senderDigests?: ReadonlyMap<string, string>,
  requestId?: string
): ReloadHttpRequest {
  const substitute = (text: string): string =>
    substituteReloadVariables(
      text.split(RELOAD_TARGET_ID_PLACEHOLDER).join(target.targetId),
      fileSet,
      context
    );
  const autoAttachTargetId = (text: string): string => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        !('targetId' in (parsed as Record<string, unknown>))
      ) {
        return JSON.stringify({ ...(parsed as Record<string, unknown>), targetId: target.targetId });
      }
    } catch {
      // Not JSON: nowhere to attach, keep as-is
    }
    return text;
  };
  const autoAttachRequestId = (text: string): string => {
    if (requestId === undefined) {
      return text;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        !('request_id' in (parsed as Record<string, unknown>))
      ) {
        return JSON.stringify({ ...(parsed as Record<string, unknown>), request_id: requestId });
      }
    } catch {
      // Not JSON: nowhere to attach, keep as-is
    }
    return text;
  };
  const autoAttachSenderDigests = (text: string): string => {
    const entries =
      senderDigests !== undefined
        ? [...senderDigests.entries()].filter(
            ([file, digest]) => fileSet.includes(file) && typeof digest === 'string' && digest.length > 0
          )
        : [];
    if (entries.length === 0) {
      return text;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        !('sender_digests' in (parsed as Record<string, unknown>))
      ) {
        return JSON.stringify({
          ...(parsed as Record<string, unknown>),
          sender_digests: Object.fromEntries(entries)
        });
      }
    } catch {
      // Not JSON: nowhere to attach, keep as-is
    }
    return text;
  };
  return {
    url: substitute(entry.url),
    method: entry.method,
    headers: Object.fromEntries(
      Object.entries(entry.headers).map(([key, value]) => [key, substitute(value)])
    ),
    body: autoAttachRequestId(autoAttachSenderDigests(autoAttachTargetId(substitute(entry.body)))),
    ...(entry.maxResponseBytes !== undefined ? { maxResponseBytes: entry.maxResponseBytes } : {})
  };
}

/**
 * RUST-357 (HR-HTTP-015) endpoint health observation port: the transport layer honestly reports reachability on every send
 * (disconnect/reconnect updates endpoint health automatically). The facts are only ok/detail -- deliberately carrying no
 * module delivery fields (health success != any module updated successfully); the health display face
 * (channel status bar lamp) and the delivery result face (ledger/receipts) each follow their own axis.
 */
export interface EndpointHealthObserver {
  noteEndpointHealth(kind: ReloadTransportKind, ok: boolean, detail: string): void;
}

export interface ReloadHttpDeps {
  run: ReloadHttpRunner;
  /** Existing variable table context (${module}/${filename}/... etc.); defaults to empty */
  context?: VariableContext;
  /** RUST-357: send-face health observation; injected = report per send, not injected = zero behavior change */
  healthObserver?: EndpointHealthObserver;
  /**
   * RUST-420 (HR-QA-008) explicit authorization for non-loopback endpoints: by default only confirmed loopback
   * targets are allowed (local engine); returning true = the user has explicitly authorized (kbengine.http.allowNonLoopback),
   * and non-loopback is allowed after recording a security warning each time. Default not injected = unauthorized (non-loopback always
   * blocked) -- endpoint overreach is a dangerous face, so the secure default must be tightened, the opposite of the trust gate's "defaults to trusted".
   * Read at execution time (authorization may change with settings, same convention as the trust gate).
   */
  allowNonLoopback?: () => boolean;
}

/**
 * RUST-420 (HR-QA-008) when a non-loopback endpoint is authorized, the security warning lands in the ledger with each receipt:
 * attached to each receipt's reason/detail (the ledger is the channel's per-send record face, visible per send).
 */
function appendEndpointWarnToReceipt(receipt: ReloadReceipt, message: string): ReloadReceipt {
  if (receipt.status === 'failed') {
    return { ...receipt, reason: `${message} | ${receipt.reason}` };
  }
  const detail = receipt.detail !== undefined ? `${receipt.detail} | ${message}` : message;
  return { ...receipt, detail };
}

/** Default HTTP runner: reuses httpRequestService's pure node http/https transport face */
export const defaultReloadHttpRunner: ReloadHttpRunner = request =>
  httpDefaultTransport({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    maxResponseBytes: request.maxResponseBytes
  }).then(result => {
    // RUST-419: a failure result (real causes such as ECONNREFUSED/certificate/proxy/timeout are in the error field)
    // must reach the catch face of send/probe via throw for classified output -- previously ok:false was folded into
    // status:0 and silently dropped, so every network error surfaced as a useless "HTTP 0: non-2xx".
    if (!result.ok) {
      throw new Error(result.error ?? `HTTP ${result.status} 请求失败`);
    }
    return {
      status: result.status,
      body: result.body,
      ...(result.bodyTruncated ? { bodyTruncated: result.bodyTruncated } : {})
    };
  });

/**
 * Parse the HTTP response body into a receipt list (HOT-003/004 protocol convention):
 * - Array = one per entry; single object = one entry; non-JSON = all 'sent' (delivered, no protocol receipt).
 * - Only entries whose file matches the sent file set verbatim are recognized; status is only recognized as
 *   accepted/applied/failed, other unrecorded statuses are not recognized.
 * - F4: when expectedTargetId is given, the targetId explicitly carried by an entry must match it,
 *   an inconsistent receipt is rejected as a whole (that file lands as 'sent', not claim applied) -- a receipt with a
 *   wrong targetId must not be treated as accepted/applied evidence for that target.
 * - F5 (correlation id): when expectedRequestId is given, the request_id explicitly carried by an entry must
 *   match it, an inconsistent receipt is rejected as a whole -- attribute the receipt precisely to the send it belongs to (out-of-order/late
 *   receipts are not attributed to this send, not claim applied).
 * - Files not recognized are filled in as 'sent' (delivered successfully but no matching receipt, not claim applied).
 */
export function parseReloadHttpReceipts(
  body: string,
  fileSet: readonly string[],
  expectedTargetId?: string,
  expectedRequestId?: string
): ReloadReceipt[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fileSet.map(file => ({
      status: 'sent',
      file,
      detail: '回包非 JSON:已送达,无协议回执(不 claim applied)'
    }));
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const receipts: ReloadReceipt[] = [];
  const seen = new Set<string>();
  // rejected file -> real rejection reason (the truth of a whole-entry rejection, targetId/request_id listed separately).
  const mismatched = new Map<string, string>();
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const file = typeof record.file === 'string' ? record.file : undefined;
    if (file === undefined || seen.has(file) || !fileSet.includes(file)) {
      continue;
    }
    // F4: the receipt's explicit targetId disagrees with the expected target -> reject as a whole (don't accept status, don't accept
    // digest); F4 second round: an explicit "non-string" targetId (null/number/object) is a malformed
    // receipt, never normalize to undefined and treat as "not provided" -- likewise reject as a whole. The field
    // being missing is the only real "not provided" (optional field; if given it must be a string matching the target).
    const hasTargetIdField = 'targetId' in record;
    const receiptTargetId = typeof record.targetId === 'string' ? record.targetId : undefined;
    const malformedTargetId = hasTargetIdField && receiptTargetId === undefined;
    if (
      malformedTargetId ||
      (expectedTargetId !== undefined && receiptTargetId !== undefined && receiptTargetId !== expectedTargetId)
    ) {
      mismatched.set(
        file,
        `回执 targetId 与目标 ${expectedTargetId} 不一致:整条拒绝该回执(不 claim applied)`
      );
      continue;
    }
    // F5 (correlation id): the receipt's explicit request_id disagrees with this send's correlation identifier -> reject as a whole
    // (that receipt does not belong to this send, don't accept status / not claim applied) -- attribute the receipt precisely
    // to the send it belongs to, cross-send out-of-order/late receipts no longer rely on guessing via targetId+file. Malformed vs not-provided
    // convention is the same as targetId: an explicit "non-string" is malformed and rejected as a whole; missing is the only "not provided".
    const hasRequestIdField = 'request_id' in record;
    const receiptRequestId = typeof record.request_id === 'string' ? record.request_id : undefined;
    const malformedRequestId = hasRequestIdField && receiptRequestId === undefined;
    if (
      malformedRequestId ||
      (expectedRequestId !== undefined &&
        receiptRequestId !== undefined &&
        receiptRequestId !== expectedRequestId)
    ) {
      mismatched.set(
        file,
        `回执 request_id 与本次发送关联标识${expectedRequestId ?? ''}不一致:整条拒绝该回执(不 claim applied)`
      );
      continue;
    }
    const digest = typeof record.digest === 'string' ? record.digest : undefined;
    const note = typeof record.note === 'string' ? record.note : undefined;
    const revision = typeof record.revision === 'number' ? record.revision : undefined;
    const status = record.status;
    if (status === 'accepted') {
      seen.add(file);
      receipts.push({
        status: 'accepted',
        file,
        ...(digest !== undefined ? { digest } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(receiptTargetId !== undefined ? { targetId: receiptTargetId } : {}),
        ...(receiptRequestId !== undefined ? { requestId: receiptRequestId } : {})
      });
    } else if (status === 'applied') {
      seen.add(file);
      receipts.push({
        status: 'applied',
        file,
        ...(digest !== undefined ? { digest } : {}),
        ...(revision !== undefined ? { revision } : {}),
        ...(receiptTargetId !== undefined ? { targetId: receiptTargetId } : {}),
        ...(receiptRequestId !== undefined ? { requestId: receiptRequestId } : {})
      });
    } else if (status === 'failed') {
      seen.add(file);
      receipts.push({
        status: 'failed',
        file,
        reason: typeof record.reason === 'string' ? record.reason : '回执 failed 无原因',
        ...(receiptTargetId !== undefined ? { targetId: receiptTargetId } : {}),
        ...(receiptRequestId !== undefined ? { requestId: receiptRequestId } : {})
      });
    }
  }
  for (const file of fileSet) {
    const mismatchReason = mismatched.get(file);
    if (mismatchReason !== undefined) {
      receipts.push({
        status: 'sent',
        file,
        detail: mismatchReason
      });
    } else if (!seen.has(file)) {
      receipts.push({
        status: 'sent',
        file,
        detail: '已送达:无匹配 accepted/applied 回执(不 claim applied)'
      });
    }
  }
  return receipts;
}

export class HttpReloadTransport implements ReloadTransport {
  readonly kind = 'http' as const;

  constructor(
    private readonly entry: HttpRequestEntry,
    private readonly deps: ReloadHttpDeps
  ) {}

  /**
   * RUST-357 (HR-HTTP-015): report the endpoint health fact of this send (disconnect/reconnect). Not injecting the
   * observation port = zero behavior change (existing channels with zero injection do not regress). health ok/detail only describe transport-layer
   * reachability and carry no module delivery conclusion.
   */
  private noteEndpointHealth(kind: ReloadTransportKind, ok: boolean, detail: string): void {
    this.deps.healthObserver?.noteEndpointHealth(kind, ok, detail);
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const url = substituteReloadVariables(this.entry.url, [], this.deps.context);
    // RUST-420 (HR-QA-008) endpoint policy gate: probe also passes the gate (probe also sends an HTTP GET to the destination
    // declared in the config). Blocked = honestly report unreachable + reason (no request sent); authorized = allowed but record
    // a security warning each time (attached to detail, the probe result is presented honestly). Read at execution time (the authorization can change with
    // settings), default not injected = not authorized (the secure default tightens).
    const endpoint = decideHttpEndpoint(url, this.deps.allowNonLoopback?.() ?? false);
    if (endpoint.action === 'block') {
      return { ok: false, detail: endpoint.message ?? '非 loopback 端点已阻止' };
    }
    const warnNote =
      endpoint.action === 'warn' && endpoint.message !== null ? ` · ${endpoint.message}` : '';
    try {
      // Side-effect-free probe (KODE-AUD-009): probe is separate from the real fire request -- the connectivity
      // test sends a GET with no body (HTTP safe method), carrying no reload payload (does not use the configured
      // reload method, does not send body/${files} placeholders), so the endpoint does not actually reload because of a probe;
      // headers are kept (may carry auth), and the url is not replaced with file placeholders. If the endpoint only accepts the reload
      // method, the probe honestly reports non-2xx, and no longer mistakenly triggers a reload.
      const response = await this.deps.run({
        url,
        method: 'GET',
        headers: this.entry.headers,
        body: '',
        ...(this.entry.maxResponseBytes !== undefined ? { maxResponseBytes: this.entry.maxResponseBytes } : {})
      });
      const ok = response.status >= 200 && response.status < 300;
      return {
        ok,
        detail:
          (ok
            ? `端点可达(HTTP ${response.status})`
            : `端点不可达(HTTP ${response.status} 非 2xx)`) + warnNote
      };
    } catch (error) {
      // RUST-419: probe failure classified output of a usable error (endpoint/certificate/proxy/interruption)
      return { ok: false, detail: formatReloadTransportThrownError(error) + warnNote };
    }
  }

  /**
   * RUST-358 (HR-HTTP-016): construct the exact request that will be sent (no send, zero side effects). Shares
   * buildReloadHttpRequest with send -- URL/method/headers/body byte-for-byte identical in shape,
   * what the user confirms is exactly the payload that will actually be sent. When senderDigests is not given,
   * sender_digests is not attached (real send attaches per frozen file digest, preview does not fabricate).
   */
  preview(
    target: ReloadTarget,
    fileSet: readonly string[],
    senderDigests?: ReadonlyMap<string, string>
  ): ReloadHttpRequest {
    return buildReloadHttpRequest(this.entry, target, fileSet, this.deps.context, senderDigests);
  }

  async send(
    target: ReloadTarget,
    fileSet: readonly string[],
    onReceipt: (receipt: ReloadReceipt) => void,
    senderDigests?: ReadonlyMap<string, string>
  ): Promise<ReloadSendSummary> {
    // F5 (correlation id): generate a correlation identifier per send -- it goes into the request body (request_id auto-attached) and
    // the receipts (every receipt produced by this send carries it, whether from a wire echo or locally synthesized),
    // so consumers can attribute each receipt precisely to the send it belongs to.
    const requestId = generateReloadRequestId();
    // F4: the ${targetId} placeholder, F4 second round body auto-attached targetId, F3 third round
    // sender_digests, and F5 request_id all live in buildReloadHttpRequest (preview/send
    // single source; preview does not pass requestId = zero sends, no fabricated correlation).
    const request = buildReloadHttpRequest(
      this.entry,
      target,
      fileSet,
      this.deps.context,
      senderDigests,
      requestId
    );
    // RUST-420 (HR-QA-008) endpoint policy gate: the profile-deployment channel's real destination (the URL after template
    // interpolation) passes the endpoint policy before being sent -- by default only loopback is allowed; non-loopback unauthorized
    // is always blocked (no request sent, per-file failed receipts carry the block reason), authorized is allowed but records
    // a security warning each time (attached to the receipt, visible per send in the ledger). Read at execution time (the authorization can change with settings),
    // default not injected = unauthorized (the secure default tightens, the opposite of the trust gate's "defaults to trusted").
    const endpoint = decideHttpEndpoint(request.url, this.deps.allowNonLoopback?.() ?? false);
    if (endpoint.action === 'block') {
      const receipts = fileSet.map(file => ({
        status: 'failed' as const,
        file,
        reason: endpoint.message ?? '非 loopback 端点已阻止'
      }));
      for (const receipt of receipts) {
        onReceipt(receipt);
      }
      return { kind: this.kind, receipts };
    }
    const warnMessage = endpoint.action === 'warn' ? endpoint.message : null;
    // RUST-420: authorized non-loopback -> warn: the security warning is attached to every receipt (the push face and
    // the returned summary are the same batch in the same shape, not talking past each other). F5: all receipts are uniformly stamped with this send's correlation identifier
    // (wire echoes already matched are stamped with the same value, locally synthesized ones get the stamp added -- per-send precise attribution).
    const finish = (receipts: ReloadReceipt[]): ReloadSendSummary => {
      const stamped = receipts.map(r => ({ ...r, requestId }));
      const wrapped =
        warnMessage === null ? stamped : stamped.map(r => appendEndpointWarnToReceipt(r, warnMessage));
      for (const receipt of wrapped) {
        onReceipt(receipt);
      }
      return { kind: this.kind, receipts: wrapped };
    };
    let response: ReloadHttpResponse;
    try {
      response = await this.deps.run(request);
    } catch (error) {
      // RUST-419: transport exception classified output of a usable error (per-file failed receipts share the same cause)
      // RUST-357: disconnect -- no response means the endpoint is unreachable (the health observation port reports the same usable error)
      const health = sendErrorToEndpointHealth(error);
      this.noteEndpointHealth(this.kind, health.ok, health.detail);
      return finish(fileSet.map(file => ({ status: 'failed' as const, file, reason: health.detail })));
    }
    if (response.status < 200 || response.status >= 300) {
      // RUST-357: responded but non-2xx -- endpoint reachable but the channel is unhealthy
      this.noteEndpointHealth(this.kind, false, sendStatusToEndpointHealth(response.status).detail);
      return finish(
        fileSet.map(file => ({
          status: 'failed' as const,
          file,
          reason: `HTTP ${response.status}:非 2xx 送达失败`
        }))
      );
    }
    // RUST-357: 2xx -- endpoint reachable/reconnected (health success only means the endpoint is reachable; it does not mean
    // any module updated successfully: module delivery results live on the receipt/ledger axis)
    this.noteEndpointHealth(this.kind, true, sendStatusToEndpointHealth(response.status).detail);
    // F4: the target is passed into receipt parsing -- receipts whose explicit targetId disagrees with that target are rejected as a whole;
    // F5: the correlation id is passed in -- receipts whose explicit request_id disagrees with this send are rejected as a whole.
    return finish(
      response.bodyTruncated
        ? fileSet.map(file => ({ status: 'sent' as const, file, detail: '响应体已截断，未能核验回执' }))
        : parseReloadHttpReceipts(response.body, fileSet, target.targetId, requestId)
    );
  }
}

/* ------------------------------------------------------------------ */
/* KBEngine official channel                                           */
/* ------------------------------------------------------------------ */

export interface ReloadOfficialConfig {
  host: string;
  port: number;
  password?: string;
  /** Full reload (defaults to true); false = incremental */
  fullReload?: boolean;
  /** Console command; defaults to KBEngine.reloadScript(<fullReload>) */
  command?: string;
}

/** Minimal face over the console connection: the real implementation is adapted by the wiring side via KBEngineTelnetClient */
export interface ReloadTelnetConnection {
  connect(): void;
  disconnect(): void;
  isReady(): boolean;
  sendCommand(command: string): boolean;
  onData(listener: (text: string) => void): void;
  onClose(listener: (hadError: boolean) => void): void;
}

export type ReloadTelnetConnector = (config: ReloadOfficialConfig) => ReloadTelnetConnection;

export interface ReloadOfficialDeps {
  connect?: ReloadTelnetConnector;
  /** Wait for the console to be ready; defaults to polling isReady (3s timeout by default) */
  waitForReady?: (conn: ReloadTelnetConnection, timeoutMs: number) => Promise<boolean>;
  /** Window to wait for the console echo (800ms by default); 0 = do not wait for echo */
  awaitEchoMs?: number;
  timeoutMs?: number;
}

/** Default connector: wraps KBEngineTelnetClient (pure node net, no vscode) */
export const defaultReloadTelnetConnector: ReloadTelnetConnector = config => {
  let dataListener: ((text: string) => void) | undefined;
  let closeListener: ((hadError: boolean) => void) | undefined;
  const client = new KBEngineTelnetClient({
    host: config.host,
    port: config.port,
    ...(config.password !== undefined ? { password: config.password } : {}),
    events: {
      onData: text => dataListener?.(text),
      onClose: hadError => closeListener?.(hadError)
    }
  });
  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    isReady: () => client.state === 'ready',
    sendCommand: command => client.sendCommand(command),
    onData: listener => {
      dataListener = listener;
    },
    onClose: listener => {
      closeListener = listener;
    }
  };
};

/** Default ready wait: polls isReady until timeout */
export const defaultReloadWaitForReady = async (
  conn: ReloadTelnetConnection,
  timeoutMs: number
): Promise<boolean> => {
  const startedAt = Date.now();
  return new Promise(resolve => {
    const poll = (): void => {
      if (conn.isReady()) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(poll, 20);
    };
    conn.connect();
    poll();
  });
};

export class KbengineOfficialTransport implements ReloadTransport {
  readonly kind = 'kbengine-official' as const;

  constructor(
    private readonly config: ReloadOfficialConfig,
    private readonly deps: ReloadOfficialDeps = {}
  ) {}

  private readonly connector = (): ReloadTelnetConnector =>
    this.deps.connect ?? defaultReloadTelnetConnector;

  private readonly waitForReady = (conn: ReloadTelnetConnection): Promise<boolean> =>
    (this.deps.waitForReady ?? defaultReloadWaitForReady)(conn, this.deps.timeoutMs ?? 3000);

  private readonly command = (): string =>
    this.config.command ?? `KBEngine.reloadScript(${this.config.fullReload === false ? 'False' : 'True'})`;

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const conn = this.connector()(this.config);
    try {
      const ready = await this.waitForReady(conn);
      return ready
        ? { ok: true, detail: `控制台可连(${this.config.host}:${this.config.port})` }
        : { ok: false, detail: `控制台不可连(${this.config.host}:${this.config.port}):连接/就绪超时` };
    } finally {
      conn.disconnect();
    }
  }

  /** Listen for the execution result; the default command waits for the complete unique-marker JSON, custom commands keep echo mode. */
  private readonly captureEcho = (conn: ReloadTelnetConnection, marker?: string): Promise<string> => {
    const awaitEchoMs = this.deps.awaitEchoMs ?? 8000;
    if (awaitEchoMs <= 0) {
      return Promise.resolve('');
    }
    return new Promise(resolve => {
      let done = false;
      let buffer = '';
      const finish = (): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve(buffer.trim());
      };
      conn.onData(text => {
        buffer += text;
        if (!marker || buffer.split(/\r?\n/).some(line => {
          if (!line.startsWith(marker)) { return false; }
          try { JSON.parse(line.slice(marker.length)); return true; } catch { return false; }
        })) {
          finish();
        }
      });
      conn.onClose(() => finish());
      const timer = setTimeout(finish, awaitEchoMs);
    });
  };

  async send(
    target: ReloadTarget,
    fileSet: readonly string[],
    onReceipt: (receipt: ReloadReceipt) => void,
    // Demo observer can verify frozen fingerprints; a plain engine without observer only keeps execution-layer evidence.
    senderDigests?: ReadonlyMap<string, string>
  ): Promise<ReloadSendSummary> {
    const conn = this.connector()(this.config);
    try {
      const ready = await this.waitForReady(conn);
      if (!ready) {
        const reason = `控制台不可用(${this.config.host}:${this.config.port}):连接/就绪超时`;
        const receipts = fileSet.map(file => ({ status: 'failed' as const, file, reason }));
        for (const receipt of receipts) {
          onReceipt(receipt);
        }
        return { kind: this.kind, receipts };
      }
      const marker = `KODE_RELOAD_${randomUUID().replace(/-/g, '')}:`;
      const payload = { files: fileSet, targetId: target.targetId, sender_digests: Object.fromEntries(senderDigests ?? []) };
      const script = [
        'import KBEngine, json, importlib.util',
        `payload = json.loads(${JSON.stringify(JSON.stringify(payload))})`,
        'if importlib.util.find_spec("KodeHotReload") is not None:',
        '    import KodeHotReload',
        `    receipts = KodeHotReload.official_reload(payload, ${this.config.fullReload === false ? 'False' : 'True'})`,
        'else:',
        `    ${this.command()}`,
        '    receipts = []',
        `print(${JSON.stringify(marker)} + json.dumps(receipts))`
      ].join('\n');
      const command = this.config.command ?? `exec(${JSON.stringify(script)})`;
      // Enter Python explicitly; readiness alone may refer to the root console layer.
      if (!this.config.command && !conn.sendCommand(':python')) {
        throw new Error('控制台无法进入 Python 层');
      }
      // Subscribe BEFORE sending: a fast response must not be lost.
      const echoPromise = this.captureEcho(conn, this.config.command ? undefined : marker);
      if (!conn.sendCommand(command)) {
        const reason = '控制台未接受命令(非 ready 态或命令被拒)';
        const receipts = fileSet.map(file => ({ status: 'failed' as const, file, reason }));
        for (const receipt of receipts) {
          onReceipt(receipt);
        }
        return { kind: this.kind, receipts };
      }
      const echo = await echoPromise;
      const receiptLine = echo.split(/\r?\n/).find(line => line.startsWith(marker));
      if (receiptLine) {
        const body = receiptLine.slice(marker.length);
        const parsed: unknown = JSON.parse(body);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const receipts = parseReloadHttpReceipts(body, fileSet, target.targetId);
          receipts.forEach(onReceipt);
          return { kind: this.kind, receipts };
        }
      }
      if (/Traceback \(most recent call last\)|(?:SyntaxError|NameError|ImportError|RuntimeError):/.test(echo)) {
        const receipts = fileSet.map(file => ({ status: 'failed' as const, file, reason: `控制台执行失败: ${echo}` }));
        receipts.forEach(onReceipt);
        return { kind: this.kind, receipts };
      }
      const detail = `命令已发送: ${command}${echo.length > 0 ? ` | 回显: ${echo}` : ''}(引擎无回执协议,不 claim applied)`;
      const receipts = fileSet.map(file => ({ status: 'sent' as const, file, detail }));
      for (const receipt of receipts) {
        onReceipt(receipt);
      }
      return { kind: this.kind, receipts };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const receipts = fileSet.map(file => ({ status: 'failed' as const, file, reason }));
      receipts.forEach(onReceipt);
      return { kind: this.kind, receipts };
    } finally {
      conn.disconnect();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Channel selection                                                   */
/* ------------------------------------------------------------------ */

export interface ReloadChannelConfig {
  readonly channel: ReloadTransportKind;
  readonly http?: HttpRequestEntry;
  readonly official?: ReloadOfficialConfig;
}

export interface ReloadTransportDeps {
  http?: ReloadHttpDeps;
  official?: ReloadOfficialDeps;
  /** RUST-357 (HR-HTTP-015): passed through to the HTTP channel's send-face health observation port */
  healthObserver?: EndpointHealthObserver;
  /**
   * RUST-420 (HR-QA-008): passed through to the HTTP channel's explicit non-loopback endpoint authorization (read at execution time).
   * Not injected by default = unauthorized (non-loopback always blocked, the secure default tightens).
   */
  allowNonLoopback?: () => boolean;
}

/**
 * Default deployment channel (user order 2026-11-10 "default is the http approach, provide default config everywhere"):
 * used when no profile is active or the profile has no hotReload section. The endpoint is
 * `http://127.0.0.1:8090/hotfix`; the JSON file set supports targetId/frozen-fingerprint receipts.
 * The old module-only form is kept only on the compatible quick-request path.
 */
export function createDefaultHotReloadChannel(): ReloadChannelConfig {
  const entry: HttpRequestEntry = {
    ...BUILTIN_HTTP_REQUEST_EXAMPLE,
    // The module-only form cannot carry per-file engine receipts or frozen digests.
    url: 'http://127.0.0.1:8090/hotfix',
    headers: { 'Content-Type': 'application/json' },
    body: '{"files":${files}}',
    enabled: true
  };
  return { channel: 'http', http: entry };
}

/**
 * Select the channel per the deployment config: channel='http' with an http entry -> HTTP channel;
 * channel='kbengine-official' with official params -> official channel;
 * unconfigured (undefined) or missing fields / unknown channel -> null (the caller falls back to the existing
 * actionName quick action channel, behavior identical to the status quo).
 */
export function resolveReloadTransport(
  config: ReloadChannelConfig | undefined,
  deps: ReloadTransportDeps = {}
): ReloadTransport | null {
  if (!config) {
    return null;
  }
  if (config.channel === 'http' && config.http) {
    const httpDeps: ReloadHttpDeps = {
      ...(deps.http ?? { run: defaultReloadHttpRunner }),
      ...(deps.healthObserver !== undefined ? { healthObserver: deps.healthObserver } : {}),
      ...(deps.allowNonLoopback !== undefined ? { allowNonLoopback: deps.allowNonLoopback } : {})
    };
    return new HttpReloadTransport(config.http, httpDeps);
  }
  if (config.channel === 'kbengine-official' && config.official) {
    return new KbengineOfficialTransport(config.official, deps.official ?? {});
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Channel config persistence validation (IDE-HOT-102)                 */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate/normalize ReloadChannelConfig (IDE-HOT-102: profile persistence read-back):
 * only recorded fields are recognized, unknown fields ignored; an unknown channel or a missing/malformed
 * corresponding parameter section returns undefined (the caller honestly treats it as "unconfigured", no guessing).
 * Fields are validated loosely item by item: fields that can be omitted fall back to type defaults; a missing required field is judged malformed.
 */
export function normalizeReloadChannelConfig(value: unknown): ReloadChannelConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const channel = value.channel;
  if (channel !== 'http' && channel !== 'kbengine-official') {
    return undefined;
  }
  if (channel === 'http') {
    const http = value.http;
    if (!isRecord(http)) {
      return undefined;
    }
    if (typeof http.url !== 'string' || http.url.length === 0) {
      return undefined;
    }
    const headers: Record<string, string> = {};
    if (isRecord(http.headers)) {
      for (const [key, headerValue] of Object.entries(http.headers)) {
        if (typeof headerValue === 'string') {
          headers[key] = headerValue;
        }
      }
    }
    const entry: HttpRequestEntry = {
      name: typeof http.name === 'string' ? http.name : 'hot-reload',
      url: http.url,
      method: typeof http.method === 'string' ? http.method : 'POST',
      headers,
      body: typeof http.body === 'string' ? http.body : '',
      enabled: typeof http.enabled === 'boolean' ? http.enabled : true,
      ...(typeof http.maxResponseBytes === 'number' &&
      Number.isSafeInteger(http.maxResponseBytes) && http.maxResponseBytes > 0
        ? { maxResponseBytes: http.maxResponseBytes }
        : {}),
      keybinding: typeof http.keybinding === 'string' ? http.keybinding : ''
    };
    return { channel, http: entry };
  }
  const official = value.official;
  if (!isRecord(official)) {
    return undefined;
  }
  if (typeof official.host !== 'string' || official.host.length === 0) {
    return undefined;
  }
  const port = official.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  return {
    channel,
    official: {
      host: official.host,
      port,
      password: typeof official.password === 'string' ? official.password : undefined,
      fullReload: typeof official.fullReload === 'boolean' ? official.fullReload : undefined,
      command: typeof official.command === 'string' ? official.command : undefined
    }
  };
}
