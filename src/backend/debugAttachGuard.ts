/**
 * Deadline and cancellation for debug connections (IDE-DBG-007): when
 * attaching to a port nobody is listening on, the Promise returned by
 * vscode.debug.startDebugging may stay unsettled for a long time (the
 * connection hangs until the OS-level TCP timeout), so the debug entry
 * point would wait forever. attachWithDeadline gives it two gates --
 * (1) deadline: on timeout it stops the stuck session and reports the truth
 * instead of waiting it out; (2) cancellation: when the user cancels the
 * progress notification it goes through the same stop path. Both paths stop
 * exactly once and never retry; any late start result (success or error)
 * arriving after the deadline/cancellation returns is swallowed.
 * Pure logic surface: start / stop / notify / cancel subscription and timers
 * are all injected, so tests replay timing precisely with manual timers and
 * never touch real timers.
 */

/** Default deadline in milliseconds (shares the same default as kbengine.debug.attachTimeoutMs) */
export const DEBUG_ATTACH_TIMEOUT_DEFAULT_MS = 15_000;

export type AttachGuardOutcome =
  | { status: 'completed'; success: boolean }
  | { status: 'timeout' }
  | { status: 'cancelled' };

export interface AttachGuardOptions {
  /** User-facing target label (carried by the notification text, e.g. `cellapp (debugpy 5679)`) */
  label: string;
  /** Deadline in milliseconds; <=0 means no deadline (wait it out; the cancel surface stays available) */
  timeoutMs: number;
  /** Start the attach (production: vscode.debug.startDebugging); may never settle on an unreachable port */
  start(): Promise<boolean>;
  /** Stop the stuck session on deadline/cancellation (production: vscode.debug.stopSession()) */
  stop(): void;
  /** IDE-REV-003: callback as soon as start settles (exactly once per gate):
   * late = it settled only after the gate already returned (a late success is
   * correlated to this session by the caller and cleaned up once; a late error
   * is likewise reported only through here and never escapes as an unhandled
   * rejection); a timely settle also callbacks, so the caller can release
   * resources that live with the gate until it settles (such as the session
   * tracking subscription). */
  onStartSettled?(late: boolean, success: boolean): void;
  /** User-facing notification (one each for timeout / cancellation, stating it has stopped and will not retry) */
  notify(message: string): void;
  /** Optional external cancellation surface (production: an adaptation of withProgress's CancellationToken) */
  onCancel?(listener: () => void): { dispose(): void };
}

/** Timer injection surface (tests fire / clear precisely with manual timers) */
export interface AttachGuardTimers {
  set(handler: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: AttachGuardTimers = {
  set: (handler, ms) => setTimeout(handler, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export async function attachWithDeadline(
  options: AttachGuardOptions,
  timers: AttachGuardTimers = defaultTimers
): Promise<AttachGuardOutcome> {
  return new Promise<AttachGuardOutcome>((resolve, reject) => {
    let finished = false;
    let timerHandle: unknown;
    let cancelSubscription: { dispose(): void } | undefined;

    const cleanup = (): void => {
      if (timerHandle !== undefined) {
        timers.clear(timerHandle);
      }
      cancelSubscription?.dispose();
    };

    // Start synchronously inside the executor (the Promise handed to the caller
    // is already being listened to; a synchronous throw from start is
    // converted into a rejection and goes through the same error channel)
    let startPromise: Promise<boolean>;
    try {
      startPromise = options.start();
    } catch (error) {
      startPromise = Promise.reject(error);
    }
    // Swallow guard: after the deadline/cancellation has returned, a late
    // settle (success or error) must not become an unhandled rejection and must
    // not trigger any downstream action
    startPromise.then(() => undefined, () => undefined);

    startPromise.then(
      success => {
        if (finished) {
          options.onStartSettled?.(true, success);
          return;
        }
        finished = true;
        cleanup();
        options.onStartSettled?.(false, success);
        resolve({ status: 'completed', success });
      },
      error => {
        if (finished) {
          options.onStartSettled?.(true, false);
          return;
        }
        finished = true;
        cleanup();
        options.onStartSettled?.(false, false);
        reject(error);
      }
    );

    if (options.timeoutMs > 0) {
      timerHandle = timers.set(() => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        options.stop();
        options.notify(
          `附加调试 ${options.label} 超时(${Math.round(options.timeoutMs / 1000)} 秒)已停止:端口未在期限内连上,请确认 debugpy 已监听;本次不再重试`
        );
        resolve({ status: 'timeout' });
      }, options.timeoutMs);
    }

    if (options.onCancel) {
      cancelSubscription = options.onCancel(() => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        options.stop();
        options.notify(`附加调试 ${options.label} 已取消,已停止调试会话;本次不再重试`);
        resolve({ status: 'cancelled' });
      });
    }
  });
}
