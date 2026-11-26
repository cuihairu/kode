/**
 * HTTP quick request execution layer (batch 105):
 * - the default transport goes through node http/https (the URL protocol must
 *   be one of the two, the request aborts when the timeout expires, and the
 *   response is capped to keep large payloads from flooding the panel;
 *   HR-HTTP-006/RUST-348: a keepAlive connection pool reuses connections to the
 *   same target + an entry-level maximum response body limit);
 * - the service layer: enabled/disabled filtering, template variable assembly,
 *   the OUTPUT panel stream (▶ request line / ✓ success status·duration·
 *   response / ✗ failure marker) and an error popup on failure.
 *   The OUTPUT channel has no coloring API (engines 1.50 baseline), so failure
 *   is presented as a ✗ marker + error popup, never as red text.
 */

import * as http from 'http';
import * as https from 'https';
import { executeHttpRequest } from './httpRequestExecutor';
import { createHttpTargetQueue, type HttpTargetQueue } from './httpRequestQueue';
import { decideHttpEndpoint } from './httpEndpointPolicy';
import {
  buildHttpRequest,
  buildOfficialVariableContext,
  buildTemplateVars,
  HttpRequestEntry,
  PackageDirProbe,
  TemplateEditorContext
} from './httpRequests';

export const DEFAULT_HTTP_TIMEOUT_MS = 10000;

/** Cap length (in characters) for responses shown in the panel; the overflow is marked as omitted */
export const RESPONSE_PREVIEW_LIMIT = 4000;

export interface HttpExecutionResult {
  ok: boolean;
  status: number;
  durationMs: number;
  body: string;
  bodyTruncated?: true;
  /** Failure reason (present only when ok=false) */
  error?: string;
}

export interface OutgoingHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /**
   * HR-HTTP-006 (RUST-348) maximum response body (bytes): the received
   * response is truncated at this limit and the excess is honestly discarded;
   * defaults to the existing cap window (RESPONSE_PREVIEW_LIMIT×4).
   * Passed through from the entry's maxResponseBytes; the default hot reload
   * face leaves it unset and uses the default window.
   */
  maxResponseBytes?: number;
  /**
   * HR-HTTP-008 (RUST-350) cancellation signal: aborts the current request
   * (destroy) and settles as "cancelled".
   * Cancelling is not a remote rollback: the request may already have reached
   * the remote (even been applied), so the remote state is honestly unknown
   * (uncertain) — it is neither impersonated as a failure nor as a success.
   * No signal by default = not cancellable (existing behaviour unchanged).
   */
  signal?: AbortSignal;
}

/** Injectable execution channel (tests supply scripted responses) */
export type HttpTransport = (request: OutgoingHttpRequest) => Promise<HttpExecutionResult>;

/**
 * HR-HTTP-006 (RUST-348) connection pool: a keepAlive agent reuses
 * same-protocol same-host connections.
 * Without an agent the default node transport face opens a new TCP connection
 * per request (re-handshaking per entry / per file); serial hot reloads to the
 * same target reuse an idle connection through it. A process-level lazy
 * singleton (one each for http/https), released when the extension host
 * process exits — no explicit disposal needed.
 */
let pooledHttpAgent: http.Agent | undefined;
let pooledHttpsAgent: https.Agent | undefined;
const pooledAgent = (protocol: string): http.Agent =>
  protocol === 'https:'
    ? (pooledHttpsAgent ??= new https.Agent({ keepAlive: true }))
    : (pooledHttpAgent ??= new http.Agent({ keepAlive: true }));

export const defaultTransport: HttpTransport = request =>
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
    // KODE-FULL-013: a request-level wall-clock deadline — DNS/connection/response
    // reading are all counted against the total budget.
    // req.setTimeout is only a socket idle timeout; a drip-feed server (sending one
    // byte every interval shorter than timeoutMs and never finishing) never trips
    // the idle check, so the request could hold the caller hostage forever.
    // The first settlement (finish) clears the timer; destroying at the deadline
    // reuses the existing timeout wording to close things out.
    // HR-HTTP-008 (RUST-350): an aborting cancellation signal settles as
    // "cancelled" immediately — cancelling is not a remote rollback, the request
    // may already have reached the remote (even been applied), and the remote
    // state is honestly unknown (uncertain), impersonating neither failure nor
    // success; cancellation shares finish with response/timeout, and finish
    // detaches the listener (no side effects after cancelling; if the timeout
    // settles first at the deadline, the cancel listener naturally becomes inert).
    let removeAbortListener: (() => void) | undefined;
    const finish = (result: HttpExecutionResult): void => {
      clearTimeout(deadline);
      removeAbortListener?.();
      resolve(result);
    };
    // HR-HTTP-008: already aborted at call time — no request is sent, it settles directly as cancelled (remote state unknown)
    if (request.signal?.aborted) {
      resolve({
        ok: false,
        status: 0,
        durationMs: Date.now() - startedAt,
        body: '',
        error: '请求已取消(调用方中止)'
      });
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      parsed,
      {
        method: request.method,
        headers: request.headers,
        // HR-HTTP-006 (RUST-348): keepAlive connection pool reusing the connection to the same target (lazy singleton)
        agent: pooledAgent(parsed.protocol)
      },
      res => {
        const chunks: Buffer[] = [];
        let received = 0;
        // HR-HTTP-006 (RUST-348): the receiving window = the entry-level maximum response body, defaulting to the existing cap window
        const maxResponseBytes = request.maxResponseBytes ?? RESPONSE_PREVIEW_LIMIT * 4;
        const finishResponse = (bodyTruncated?: true): void => {
          finish({
            ok: true,
            status: res.statusCode ?? 0,
            durationMs: Date.now() - startedAt,
            body: Buffer.concat(chunks).toString('utf8'),
            ...(bodyTruncated ? { bodyTruncated } : {})
          });
        };
        res.on('data', (chunk: Buffer) => {
          const room = maxResponseBytes - received;
          if (chunk.length > room) {
            if (room > 0) {
              chunks.push(chunk.subarray(0, room));
            }
            finishResponse(true);
            res.destroy();
            return;
          }
          if (room > 0) {
            chunks.push(chunk);
          }
          received += chunk.length;
        });
        // Response-side interruption (the server disconnects early): in practice node surfaces it as 'aborted'
        // on the response stream, while req has already been destroyed with the socket — req.on('error') no longer fires, so
        // the original assumption of "letting req.on('error') close things out uniformly" does not hold, and the
        // transport promise would never settle (the timeout cannot save itself either: req is already destroyed, and destroy(err)
        // no longer emits error). Settle it explicitly as a failure here; a Promise only honours its first resolve, so
        // later duplicate calls are naturally inert and need no extra sentinel.
        res.on('aborted', () => {
          finish({
            ok: false,
            status: 0,
            durationMs: Date.now() - startedAt,
            body: '',
            error: '响应中断:服务端提前断开连接(aborted)'
          });
        });
        res.on('error', (err: Error) => {
          finish({
            ok: false,
            status: 0,
            durationMs: Date.now() - startedAt,
            body: '',
            error: err.message
          });
        });
        res.on('end', () => finishResponse());
      }
    );
    const deadline = setTimeout(() => {
      req.destroy(new Error(`请求超时(${request.timeoutMs}ms)`));
    }, Math.max(1, request.timeoutMs));
    deadline.unref?.();
    req.on('error', (err: Error) => {
      finish({
        ok: false,
        status: 0,
        durationMs: Date.now() - startedAt,
        body: '',
        error: err.message
      });
    });
    // HR-HTTP-008 (RUST-350): cancellation signal → destroy the request; the error face uniformly uses the
    // "request cancelled" wording (isomorphic to the timeout, settled by req.on('error')); finish detaches the listener, so after
    // cancelling there are no further side effects. The pre-guard in the same synchronous block already verified no abort, so there is no async gap after registration.
    if (request.signal) {
      const onAbort = (): void => {
        req.destroy(new Error('请求已取消(调用方中止)'));
      };
      request.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => request.signal?.removeEventListener('abort', onAbort);
    }
    if (request.body.length > 0) {
      req.write(request.body);
    }
    req.end();
  });

export interface HttpRequestServiceDeps {
  getEntries: () => HttpRequestEntry[];
  transport?: HttpTransport;
  /** OUTPUT panel stream (one line each) */
  log: (line: string) => void;
  /** Failure popup */
  notifyError: (message: string) => void;
  /** Template context (active editor) extraction */
  getTemplateContext?: () => TemplateEditorContext;
  /** Python package dir probe (including the __init__.py check), used by the ${module} package-boundary scan (batch 153) */
  isPackageDir?: PackageDirProbe;
  timeoutMs?: number;
  /**
   * HR-HTTP-007 (RUST-349) bounded per-target concurrency queue (same target
   * serial by default, different targets independent, a global ceiling);
   * defaults to the module-level singleton (shared by the production quick
   * request face). A named instance is injected for test determinism.
   */
  queue?: HttpTargetQueue;
  /**
   * RUST-422 (HR-QA-010) workspace trust probe: read on every execution; an
   * untrusted workspace (returning false) forbids configuration-driven quick
   * requests (the SSRF/data-leak/path-traversal faces) and lands an auditable
   * block line; not injected by default = treated as trusted (zero-config, no
   * regression). Wiring injects `() => vscode.workspace
   * .isTrusted`; it is read at execution time, not at wiring time — trust can
   * change as the user "trusts the workspace", so the moment of execution is
   * authoritative (the same pattern as the HR-HTTP-005 auto hot reload trust gate).
   */
  isWorkspaceTrusted?: () => boolean;
  /**
   * RUST-420 (HR-QA-008) explicit authorization for non-loopback endpoints:
   * by default only confirmed loopback targets (the local engine) are allowed;
   * returning true = the user has explicitly authorized (kbengine.http.allowNonLoopback),
   * and each non-loopback request lands a security warning before going
   * through. Not injected by default = unauthorized (non-loopback is always
   * blocked) — an out-of-bounds endpoint is a dangerous face, so the secure
   * default must be tight, the opposite of the trust gate's "defaults to
   * trusted". Read at execution time (the same convention as the trust gate:
   * authorization can change with settings).
   */
  allowNonLoopback?: () => boolean;
}

/** HR-HTTP-007: the shared queue of the quick request face — same-endpoint user requests serialize, different endpoints run concurrently, with a global ceiling */
const sharedHttpRequestQueue = createHttpTargetQueue();

export class HttpRequestService {
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;
  private readonly queue: HttpTargetQueue;

  constructor(private readonly deps: HttpRequestServiceDeps) {
    this.transport = deps.transport ?? defaultTransport;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.queue = deps.queue ?? sharedHttpRequestQueue;
  }

  /** Enabled entries (the data source of the quick pick panel) */
  listEnabled(): HttpRequestEntry[] {
    return this.deps.getEntries().filter(entry => entry.enabled);
  }

  /**
   * Run a quick request by name: nonexistent or disabled honestly reports a
   * false receipt (no guessing, no busy work); the stream goes to OUTPUT and
   * failures add an error popup.
   */
  async runByName(name: string): Promise<boolean> {
    const entry = this.deps.getEntries().find(item => item.name === name && item.enabled);
    if (!entry) {
      this.deps.notifyError(`HTTP 快捷请求「${name}」不存在或已停用`);
      return false;
    }
    return this.runEntry(entry);
  }

  /**
   * Execute a caller-selected entry after its source/index identity was resolved.
   * HR-HTTP-008 (RUST-350): the fourth parameter = cancellation signal — aborts
   * the in-flight request, presented as "cancelled · remote state unknown
   * (uncertain)" (cancelling is not a remote rollback). No signal by default =
   * not cancellable.
   */
  async runEntry(
    entry: HttpRequestEntry,
    execute?: () => Promise<void>,
    onHttpResponse?: (response: { status: number; body: string }) => void,
    signal?: AbortSignal
  ): Promise<boolean> {
    // RUST-422 (HR-QA-010) workspace trust gate: configuration-driven quick
    // requests from an untrusted workspace are always blocked — when the
    // configuration comes from an untrusted workspace (e.g. a cloned repo), its
    // URL template could probe intranet/metadata endpoints or exfiltrate local
    // paths (SSRF/data-leak faces); in a trusted workspace, pointing at the
    // localhost engine is the very intent of this feature, so no whitelist is
    // added. Read at fire time (the user can change it via "trust workspace");
    // not injected by default = treated as trusted (zero-config, no regression).
    if (this.deps.isWorkspaceTrusted?.() === false) {
      this.deps.log(`工作区未信任,HTTP 快捷请求「${entry.name}」已阻止(SSRF/数据泄露防护)`);
      this.deps.notifyError(`当前工作区不受信任,HTTP 快捷请求「${entry.name}」已阻止`);
      return false;
    }
    if (!entry.enabled) {
      this.deps.notifyError(`HTTP 快捷请求「${entry.name}」不存在或已停用`);
      return false;
    }
    if (execute) {
      try { await execute(); return true; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.notifyError(`HTTP 快捷请求「${entry.name}」失败: ${message}`);
        return false;
      }
    }
    const editorContext = this.deps.getTemplateContext?.() ?? {};
    const vars = buildTemplateVars(editorContext, this.deps.isPackageDir);
    // Batch 152: the official variable family (${workspaceFolder}/${fileBasenameNoExtension}/
    // ${env:NAME} etc.) and custom placeholders interpolate in a single merged pass
    const request = buildHttpRequest(entry, vars, buildOfficialVariableContext(editorContext));
    // RUST-420 (HR-QA-008) endpoint gate: the real URL after template
    // interpolation passes the endpoint policy before the request goes out —
    // by default only loopback is allowed; unauthorized non-loopback is always
    // blocked (no request is sent; a user-auditable block line + popup is
    // landed), while an authorized one lands a security warning per request
    // before going through. Placed before the ▶ line: a blocked request never
    // leaves behind the false impression of "was sent".
    const endpoint = decideHttpEndpoint(request.url, this.deps.allowNonLoopback?.() ?? false);
    if (endpoint.action === 'block') {
      this.deps.log(`⛔ [${entry.name}] ${endpoint.message}`);
      this.deps.notifyError(`HTTP 快捷请求「${entry.name}」已阻止:${endpoint.message}`);
      return false;
    }
    if (endpoint.message !== null) {
      this.deps.log(endpoint.message);
    }
    this.deps.log(`▶ [${entry.name}] ${request.method} ${request.url}`);

    // HR-HTTP-001 (HR-PR-03): transport goes through the generic executor (the
    // correlation id + structured classification ride on the outcome); the
    // service-layer branching still follows transportOk = the transport face's
    // raw ok boolean, so the log/popup/boolean contract is unchanged word for
    // word and the generic HTTP feature has zero regression.
    const outcome = await executeHttpRequest(
      {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
        timeoutMs: this.timeoutMs,
        ...(entry.maxResponseBytes !== undefined ? { maxResponseBytes: entry.maxResponseBytes } : {})
      },
      {
        transport: this.transport,
        queue: this.queue,
        ...(signal !== undefined ? { signal } : {})
      }
    );

    // AUD-054 (R2-F27): report to the observer as soon as a real response
    // arrives (the receipt parsing face) — 2xx, non-2xx and transport failure
    // (status=0) are all called back with the actual facts, so the observer
    // classifies and lands them in the ledger without guessing; this only takes
    // effect when the hook is wired directly to this service (the execute
    // terminal-closure path cannot reach status/body, so it does not call back).
    // HR-HTTP-008: a cancellation does not call back the observer (there is no
    // real response to report) and takes the uncertain branch.
    if (outcome.kind !== 'cancelled') {
      onHttpResponse?.({ status: outcome.status, body: outcome.bodyTruncated ? '' : outcome.body });
    }

    // HR-HTTP-008 (RUST-350): cancelled — cancelling is not a remote rollback;
    // the request may have already reached the remote (even been applied), so
    // the remote state is honestly unknown (uncertain); it is neither
    // impersonated as a failure (no error popup, no ✗ failure marker) nor as a
    // success, and is honestly recorded as "cancelled · remote state unknown".
    if (outcome.kind === 'cancelled') {
      this.deps.log(`⚠ [${entry.name}] ${request.method} ${request.url} · 已取消:远端状态未知(uncertain)——取消≠远端撤销`);
      return false;
    }

    if (outcome.transportOk) {
      this.deps.log(`✓ ${outcome.status} · ${outcome.durationMs}ms`);
      this.deps.log(this.previewBody(outcome.body, outcome.bodyTruncated));
      return true;
    }
    this.deps.log(`✗ [${entry.name}] ${request.method} ${request.url} · ${outcome.durationMs}ms · ${outcome.errorMessage ?? '未知错误'}`);
    this.deps.notifyError(`HTTP 快捷请求「${entry.name}」失败: ${outcome.errorMessage ?? '未知错误'}`);
    return false;
  }

  private previewBody(body: string, bodyTruncated = false): string {
    const preview = body.slice(0, RESPONSE_PREVIEW_LIMIT);
    if (bodyTruncated) {
      return `${preview}${body.length > preview.length ? '…' : ''} (响应体已截断)`;
    }
    return body.length > preview.length
      ? `${preview}…(截断,共 ${body.length} 字符)`
      : preview || '(空回包)';
  }
}
