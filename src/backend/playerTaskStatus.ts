/**
 * UX-REVIEW-008a 玩家查询/连接检查的最近一次状态保留(纯逻辑,零 vscode):
 * - 六态区分:未运行(not-run)/进行中(running)/空结果(empty)/成功(success)/
 *   失败(failed)/已取消(cancelled);
 * - 每个任务(玩家查询/连接检查)各保留最近一次状态与结果时间,可回看;
 * - 结果入口 = 打开「玩家数据(只读)」输出通道的命令 id(结果详情落通道);
 * - 单调尝试序号 attempts 为 008c(过期异步结果不覆盖新任务)预留守卫基础。
 * 呈现映射(树节点/文案)在 playerDataPanel 胶水面;本模块只管状态事实。
 */

export type PlayerTaskKind = 'query' | 'connection';

export type PlayerTaskOutcome =
  | 'not-run'
  | 'running'
  | 'empty'
  | 'success'
  | 'failed'
  | 'cancelled';

export interface PlayerTaskStatus {
  readonly task: PlayerTaskKind;
  readonly outcome: PlayerTaskOutcome;
  /** 一句话摘要(不含密码与连接要素明文;含目标身份=host:port/db 或 dbid) */
  readonly summary: string;
  /** 完成时刻(epoch ms);not-run/running 无 */
  readonly finishedAt?: number;
  /** 结果入口:打开结果详情输出通道的命令 id;not-run/running 无 */
  readonly detailCommandId?: string;
  /** 单调尝试序号(begin 时分配;008c 过期异步结果守卫的凭据) */
  readonly attempt: number;
}

/** 结果入口命令:打开玩家数据只读输出通道(结果详情的唯一落点) */
export const PLAYER_TASK_RESULT_COMMAND = 'kbengine.playerData.showResult';

/**
 * 六态标签源串(UX-REVIEW-010d):值 = 英文源串,呈现面经 l10nText 调用期
 * 取词(zh-cn bundle 出中文);键集与六态一一对应,供动态键对账。
 */
export const PLAYER_TASK_OUTCOME_LABELS: Record<PlayerTaskOutcome, string> = {
  'not-run': 'Not run',
  running: 'Running',
  empty: 'Empty result',
  success: 'Success',
  failed: 'Failed',
  cancelled: 'Cancelled'
};

/** 结果时间展示(本地时区 YYYY-MM-DD HH:mm:ss;纯函数便于钉格式) */
export function formatPlayerTaskTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * 最近一次状态账本:每任务一条,begin→finish 覆盖;finish 只接受终态
 * (empty/success/failed/cancelled),running/not-run 不是完成态。
 */
export class PlayerTaskStatusStore {
  private readonly latest = new Map<PlayerTaskKind, PlayerTaskStatus>();
  /** 每任务最近一次 begin 的尝试序号(过期 finish 判据) */
  private readonly currentAttempt = new Map<PlayerTaskKind, number>();
  private attempts = 0;

  /** 任务开始(进行中;等待输入/建连/执行都算进行中);返回携带尝试凭据 */
  begin(task: PlayerTaskKind, summary: string): PlayerTaskStatus {
    this.attempts += 1;
    const status: PlayerTaskStatus = {
      task,
      outcome: 'running',
      summary,
      attempt: this.attempts
    };
    this.currentAttempt.set(task, this.attempts);
    this.latest.set(task, status);
    return status;
  }

  /**
   * 任务完成(终态;记录结果时间与结果入口)。
   * UX-REVIEW-008c 过期异步结果守卫:expectedAttempt 与该任务当前尝试
   * 序号不符(期间已有新 begin)→ 拒绝写入返回 null,新任务状态不被
   * 旧尝试的迟到结果覆盖。
   */
  finish(
    task: PlayerTaskKind,
    outcome: Extract<PlayerTaskOutcome, 'empty' | 'success' | 'failed' | 'cancelled'>,
    summary: string,
    finishedAt: number = Date.now(),
    expectedAttempt?: number
  ): PlayerTaskStatus | null {
    if (
      expectedAttempt !== undefined &&
      expectedAttempt !== this.currentAttempt.get(task)
    ) {
      return null;
    }
    const status: PlayerTaskStatus = {
      task,
      outcome,
      summary,
      finishedAt,
      detailCommandId: PLAYER_TASK_RESULT_COMMAND,
      attempt: expectedAttempt ?? this.attempts
    };
    this.latest.set(task, status);
    return status;
  }

  get(task: PlayerTaskKind): PlayerTaskStatus | undefined {
    return this.latest.get(task);
  }

  /** 已有记录的任务(never-run 的任务不在内,呈现面按未运行渲染) */
  recorded(): PlayerTaskKind[] {
    return [...this.latest.keys()];
  }

  /** 测试复位(会话状态不跨测试泄漏) */
  clear(): void {
    this.latest.clear();
    this.currentAttempt.clear();
    this.attempts = 0;
  }

  attemptsForTests(): number {
    return this.attempts;
  }
}
