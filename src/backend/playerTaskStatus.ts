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
  /** 一句话摘要(不含密码与连接要素明文) */
  readonly summary: string;
  /** 完成时刻(epoch ms);not-run/running 无 */
  readonly finishedAt?: number;
  /** 结果入口:打开结果详情输出通道的命令 id;not-run/running 无 */
  readonly detailCommandId?: string;
}

/** 结果入口命令:打开玩家数据只读输出通道(结果详情的唯一落点) */
export const PLAYER_TASK_RESULT_COMMAND = 'kbengine.playerData.showResult';

export const PLAYER_TASK_OUTCOME_LABELS: Record<PlayerTaskOutcome, string> = {
  'not-run': '未运行',
  running: '进行中',
  empty: '空结果',
  success: '成功',
  failed: '失败',
  cancelled: '已取消'
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
  private attempts = 0;

  /** 任务开始(进行中;等待输入/建连/执行都算进行中) */
  begin(task: PlayerTaskKind, summary: string): PlayerTaskStatus {
    this.attempts += 1;
    const status: PlayerTaskStatus = { task, outcome: 'running', summary };
    this.latest.set(task, status);
    return status;
  }

  /** 任务完成(终态;记录结果时间与结果入口) */
  finish(
    task: PlayerTaskKind,
    outcome: Extract<PlayerTaskOutcome, 'empty' | 'success' | 'failed' | 'cancelled'>,
    summary: string,
    finishedAt: number = Date.now()
  ): PlayerTaskStatus {
    const status: PlayerTaskStatus = {
      task,
      outcome,
      summary,
      finishedAt,
      detailCommandId: PLAYER_TASK_RESULT_COMMAND
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
    this.attempts = 0;
  }

  attemptsForTests(): number {
    return this.attempts;
  }
}
