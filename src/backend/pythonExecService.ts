import { ChildProcessWithoutNullStreams } from 'child_process';

import { spawnProcess } from './processManager';

/**
 * RUST-002 criterion ③: script execution must be an independent, reusable
 * execution service.
 *
 * Current gap (2026-11-15 audit): the Python script execution face is entirely
 * "spawn a fresh interpreter per call and wait for it to exit" -- the hot-
 * reload save syntax gate spawns an interpreter to run compile() on every
 * finalize. This module swaps the most frequent, stateless face for a
 * **resident interpreter + stdin/stdout frame protocol**: one process carries
 * any number of compilations, rebuilt only on exit / fault / timeout. Same
 * shape as the Rust Core (kodeCoreClient single process + stdio LSP
 * multiplexing).
 *
 * Frame protocol (bidirectional): `<decimal byte length>\n<exactly that many
 * bytes>\n`.
 * - the length prefix carries multi-line source losslessly across frames; newlines
 *   are only separators and never part of the payload (the length is the boundary);
 * - the length is always a **utf-8 byte count**. When the interpreter side replies
 *   with `ensure_ascii=False` the payload may contain non-ASCII (Chinese / smart
 *   quotes syntax-error text), so bytes > characters -- the receive side buffers
 *   and splits on the raw Buffer byte stream throughout (KODE-FULL-001: the old
 *   implementation called setEncoding into a string and then sliced by character,
 *   so a non-ASCII reply could never be cut into an equal-length payload, syntax
 *   errors got mis-bundled into an infrastructure timeout, and the hot-reload
 *   syntax gate then failed open).
 *
 * Concurrency and timeout semantics: the protocol is one request, one reply.
 * Concurrent commands go into a **queue** and are served in FIFO order
 * (never rejected, never reordered). **A timeout does not dequeue** -- a late
 * frame would land on the next request and misalign everything, so a timeout
 * tears down the child process and settles it as a fault; the next runCompile
 * lazily rebuilds: one extra process-startup cost is preferred over a
 * misaligned verdict.
 *
 * Executor semantic red line: **compile() only, never execute** -- user code
 * never runs (carried over from the one-shot compilation module; the scope of
 * authority must not widen).
 */

/** A single compilation command */
export interface PythonCompileTask {
  readonly content: string;
}

/**
 * Execution service verdict result. When ok=false, error is an interpreter-side
 * error line.
 * infra=true distinguishes "the execution service itself is at fault" from "a
 * genuine syntax error" -- the caller (the hot-reload syntax gate) uses this to
 * fail-open (a fault lets the hot-reload through), while a syntax error blocks.
 */
export interface PythonExecOutcome {
  readonly ok: boolean;
  readonly error?: string;
  /** Failure class (process exit / timeout / not ready / unparsable reply); never set for a syntax error */
  readonly infra?: boolean;
}

/** Service handle */
export interface PythonExecService {
  runCompile(task: PythonCompileTask): Promise<PythonExecOutcome>;
  /** Permanent shutdown: subsequent calls report honestly "not started"; never rebuilt */
  dispose(): void;
  /** Current resident child process pid; 0 when not started or already reclaimed */
  pid(): number;
  /** Number of commands queued waiting for a reply (including in-flight ones) */
  pendingCount(): number;
}

export interface PythonExecServiceOptions {
  /** Per-command wait cap; defaults to 5000ms (same criterion as the old one-shot compilation path) */
  readonly timeoutMs?: number;
  /** Handshake-frame wait cap; defaults to 2000ms */
  readonly handshakeTimeoutMs?: number;
  /** Interpreter executable; defaults to python3. Changing it requires a new service (the old process's interpreter is stale) */
  readonly interpreter?: string;
  /** Injected for tests; defaults to spawnProcess (really starts a child process) */
  readonly spawn?: typeof spawnProcess;
}

/** Default wait window, same criterion as the old one-shot compilation path */
export const PYTHON_EXEC_TIMEOUT_MS = 5000;
/** Default cap for the handshake (waiting for the ready frame) */
export const PYTHON_EXEC_HANDSHAKE_TIMEOUT_MS = 2000;

/**
 * Executor source running inside the resident service. Protocol: read source
 * frame by frame from stdin -> compile() -> reply frame by frame on stdout with
 * `{ok:true}` or `{ok:false,error:<error line>}`.
 *
 * Only imports json/sys/traceback -- zero side effects, never executes user
 * code; compile()'s filename keeps the diagnostic filename for locating errors.
 * stdin stays on a binary buffer throughout (never mixed with a text wrapper
 * layer, avoiding interleaved readline/read corruption).
 */
export const PYTHON_EXEC_SERVICE_SOURCE = `import json
import sys
import traceback

def read_line():
    return sys.stdin.buffer.readline()

def read_bytes(n):
    buf = b""
    while len(buf) < n:
        chunk = sys.stdin.buffer.read(n - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf

def read_frame():
    size_line = read_line()
    if size_line == b"":
        return None
    length = int(size_line.strip())
    payload = read_bytes(length)
    read_line()
    return payload.decode("utf-8")

def write_frame(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    out = sys.stdout.buffer
    out.write(("%d\\n" % len(data)).encode("ascii"))
    out.write(data)
    out.write(b"\\n")
    out.flush()

write_frame({"ready": True})

while True:
    source = read_frame()
    if source is None:
        break
    try:
        compile(source, "<kbengine-hotreload>", "exec")
        write_frame({"ok": True})
    except SyntaxError:
        last_line = traceback.format_exc(limit=0).strip().splitlines()[-1]
        write_frame({"ok": False, "error": last_line})
    except Exception as error:
        write_frame({"ok": False, "error": str(error)})
`;

/** Frame encoding: byte-length prefix + payload + newline separator */
function encodeFrame(payload: string): string {
  return `${Buffer.byteLength(payload, 'utf8')}\n${payload}\n`;
}

interface PendingCall {
  resolve: (outcome: PythonExecOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * Build a resident Python execution service.
 *
 * Lifecycle: **lazy spawn** (started on the first runCompile) -> wait for the
 * `ready` frame -> serve requests frame by frame in FIFO order -> on
 * exit / fault / timeout, tear down and the next call rebuilds. dispose is a
 * permanent shutdown.
 */
export function createPythonExecService(options: PythonExecServiceOptions = {}): PythonExecService {
  const timeoutMs = options.timeoutMs ?? PYTHON_EXEC_TIMEOUT_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? PYTHON_EXEC_HANDSHAKE_TIMEOUT_MS;
  const spawn = options.spawn ?? spawnProcess;
  const interpreter = options.interpreter ?? 'python3';

  let disposed = false;
  let child: ChildProcessWithoutNullStreams | null = null;
  let stdoutBytes: Buffer = Buffer.alloc(0);
  let stderrTail = '';
  let ready = false;
  const queue: PendingCall[] = [];
  let handshake: Promise<boolean> | null = null;

  const settle = (index: number, outcome: PythonExecOutcome): void => {
    const call = queue[index];
    if (!call) {
      return;
    }
    clearTimeout(call.timer);
    queue.splice(index, 1);
    call.resolve(outcome);
  };

  const settleAll = (error: string): void => {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      settle(index, { ok: false, error, infra: true });
    }
  };

  /** Tear down the current child process and fail in-flight requests honestly; always rebuildable except when disposed */
  const teardown = (reason?: string): void => {
    if (!child) {
      ready = false;
      handshake = null;
      return;
    }
    const target = child;
    const exitCode = target.exitCode ?? '?';
    const signal = target.signalCode ?? '—';
    child = null;
    ready = false;
    handshake = null;
    stdoutBytes = Buffer.alloc(0);
    settleAll(
      reason ?? `解释器进程退出(code=${exitCode}, signal=${signal})${stderrTail.trim() ? `: ${lastLine(stderrTail)}` : ''}`
    );
    if (target.exitCode === null && target.signalCode === null) {
      // Still running (a timeout/fault-triggered teardown) so kill it;
      // a child that already exited naturally is not killed again
      try {
        target.kill('SIGKILL');
      } catch {
        // Killing an already-exited child process fails: harmless
      }
    }
  };

  const drainFrames = (): void => {
    for (;;) {
      const decoded = decodeFrame(stdoutBytes);
      if (decoded === null) {
        return;
      }
      stdoutBytes = decoded.remainder;
      if (!ready) {
        ready = true;
        continue; // first frame = handshake evidence, not a request reply
      }
      if (queue.length === 0) {
        continue; // a late frame with no in-flight request: dropped honestly, never impersonating a result
      }
      let parsed: { ok?: boolean; error?: string };
      try {
        parsed = JSON.parse(decoded.body) as { ok?: boolean; error?: string };
      } catch {
        settle(0, { ok: false, error: '执行服务回包不可解析', infra: true });
        continue;
      }
      settle(0, parsed.ok === false ? { ok: false, error: parsed.error ?? '解释器回包异常' } : { ok: true });
    }
  };

  const wire = (proc: ChildProcessWithoutNullStreams): void => {
    // KODE-FULL-002: generation guard -- once a timeout/fault teardown has
    // replaced the old process (child !== proc), a late exit/error/stdout
    // frame from the old process no longer belongs to this generation and is
    // ignored outright; otherwise the old exit would take the new process down
    // with it, and stale residual bytes would pollute the new generation's
    // frame buffer
    const stale = (): boolean => child !== proc;
    // KODE-FULL-001: stdout stays a byte stream (no setEncoding) -- frame
    // boundaries are judged by bytes, and a multibyte character split across
    // chunks is not corrupted by per-chunk utf8 decoding
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      if (stale()) { return; }
      stdoutBytes = Buffer.concat([stdoutBytes, chunk as Buffer]);
      drainFrames();
    });
    proc.stderr.on('data', chunk => {
      if (stale()) { return; }
      // Bounded tail (error lines take the last line); it never grows
      // unboundedly over a long session
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-2048);
    });
    proc.on('error', error => {
      if (stale()) { return; }
      teardown(error.message);
    });
    proc.on('exit', () => {
      if (stale()) { return; }
      teardown();
    });
  };

  /** Lazy-spawn the process and wait for the handshake frame; returns false on failure (the caller reports "not started" honestly) */
  const ensureStarted = async (): Promise<boolean> => {
    if (disposed) {
      return false;
    }
    if (child && ready) {
      return true;
    }
    if (!child) {
      stderrTail = '';
      stdoutBytes = Buffer.alloc(0);
      ready = false;
      child = spawn(interpreter, ['-c', PYTHON_EXEC_SERVICE_SOURCE], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      wire(child);
    }
    if (!handshake) {
      handshake = new Promise<boolean>(resolve => {
        const timer = setTimeout(() => {
          if (ready) {
            resolve(true);
            return;
          }
          teardown(`握手超时(${handshakeTimeoutMs}ms)`);
          resolve(false);
        }, handshakeTimeoutMs);
        timer.unref?.();
        const poll = (): void => {
          if (ready) {
            clearTimeout(timer);
            resolve(true);
            return;
          }
          if (!child) {
            clearTimeout(timer);
            resolve(false);
            return;
          }
          setTimeout(poll, 5);
        };
        poll();
      }).then(ok => {
        handshake = null;
        return ok;
      });
    }
    return handshake;
  };

  return {
    async runCompile(task): Promise<PythonExecOutcome> {
      const started = await ensureStarted();
      if (!started || disposed || !child) {
        return { ok: false, error: disposed ? '执行服务已关闭' : '执行服务未就绪', infra: true };
      }
      let resolveCall: (outcome: PythonExecOutcome) => void = (): void => undefined;
      const promise = new Promise<PythonExecOutcome>(resolve => {
        resolveCall = resolve;
      });
      const call: PendingCall = {
        resolve: outcome => resolveCall(outcome),
        timer: setTimeout(() => {
          // Timeout = stuck: dequeueing would misalign frames, so the service is
          // torn down directly (the other in-flight requests fail in the same
          // batch), and the next call rebuilds -- no misalignment, no hang
          const index = queue.indexOf(call);
          if (index >= 0) {
            settle(index, { ok: false, error: `编译超时(${timeoutMs}ms)`, infra: true });
          }
          teardown(`编译超时(${timeoutMs}ms)`);
        }, timeoutMs)
      };
      queue.push(call);
      child.stdin.write(encodeFrame(task.content));
      return promise;
    },
    dispose(): void {
      disposed = true;
      teardown('执行服务已关闭');
    },
    pid(): number {
      return child?.pid ?? 0;
    },
    pendingCount(): number {
      return queue.length;
    }
  };
}

/**
 * Frame decoding (byte pipeline): return null when no complete frame; consume
 * a decoded frame and return the payload plus the remainder.
 * KODE-FULL-001: length = byte count; buffering, slicing and the remainder all
 * live on Buffer -- a payload sliced out by bytes is then utf8-decoded as a
 * whole, so non-ASCII payloads and multibyte characters split across chunks are
 * lossless.
 */
function decodeFrame(buffer: Buffer): { body: string; remainder: Buffer } | null {
  const headerEnd = buffer.indexOf(0x0a);
  if (headerEnd < 0) {
    return null;
  }
  const sizeText = buffer.subarray(0, headerEnd).toString('ascii');
  if (!/^\d{1,10}$/.test(sizeText)) {
    // The frame boundary has been destroyed: clear the buffer to avoid a deadlock
    return { body: '', remainder: Buffer.alloc(0) };
  }
  const size = Number(sizeText);
  const payloadStart = headerEnd + 1;
  // A complete frame = the payload's `size` bytes plus the 1-byte frame-ending newline have arrived
  if (buffer.length < payloadStart + size + 1) {
    return null;
  }
  const payload = buffer.subarray(payloadStart, payloadStart + size).toString('utf8');
  return { body: payload, remainder: buffer.subarray(payloadStart + size + 1) };
}

/** Take the last non-empty text line (for error-line display) */
function lastLine(text: string): string {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}