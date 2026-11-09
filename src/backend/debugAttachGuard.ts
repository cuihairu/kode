/**
 * 调试连接的截止与取消(IDE-DBG-007):attach 到无人监听的端口时
 * vscode.debug.startDebugging 返回的 Promise 可能长时间不落定(连接
 * 挂起到 OS 级 TCP 超时为止),调试入口就此永久等待。attachWithDeadline
 * 给它两道闸——①截止:超时即停掉卡住的会话并如实提示,不等到底;
 * ②取消:用户在进度通知上取消走同一停止路径。两条路径都只停一次、
 * 绝不重试;截止/取消返回后晚到的 start 结果(成功或异常)一律吞掉。
 * 纯逻辑面:发起/停止/提示/取消订阅与计时器全部注入,测试用手动
 * 计时器精确回放,不碰真定时器。
 */

/** 默认截止毫秒数(kbengine.debug.attachTimeoutMs 缺省同源) */
export const DEBUG_ATTACH_TIMEOUT_DEFAULT_MS = 15_000;

export type AttachGuardOutcome =
  | { status: 'completed'; success: boolean }
  | { status: 'timeout' }
  | { status: 'cancelled' };

export interface AttachGuardOptions {
  /** 用户面目标标签(提示文案携带,如 `cellapp (debugpy 5679)`) */
  label: string;
  /** 截止毫秒数;<=0 不限时(等到底,取消面仍可用) */
  timeoutMs: number;
  /** 发起附加(生产:vscode.debug.startDebugging);不可达端口下可能永不落定 */
  start(): Promise<boolean>;
  /** 截止/取消时停掉卡住的会话(生产:vscode.debug.stopSession()) */
  stop(): void;
  /** IDE-REV-003:start 落定即回调(每闸恰一次):late=闸已返回后才落定
   * (迟到成功由调用方关联本次会话并清理一次,迟到异常同样只经此通知,
   * 不外泄成 unhandled rejection);timely 落定也回调,供调用方释放随闸
   * 存活到落定为止的资源(如会话追踪订阅)。 */
  onStartSettled?(late: boolean, success: boolean): void;
  /** 用户面提示(超时/取消各一条,写明已停止、不再重试) */
  notify(message: string): void;
  /** 可选外部取消面(生产:withProgress 的 CancellationToken 适配) */
  onCancel?(listener: () => void): { dispose(): void };
}

/** 计时器注入面(测试用手动计时器精确触发/清位) */
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

    // 执行器内同步发起(调用方拿到的 Promise 已在监听;start 同步抛错
    // 兜成 rejection 走同一错误通道)
    let startPromise: Promise<boolean>;
    try {
      startPromise = options.start();
    } catch (error) {
      startPromise = Promise.reject(error);
    }
    // 吞咽守卫:截止/取消先返回后,晚到的落定(成功或异常)不得变成
    // unhandled rejection,也不得触发任何下游动作
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
