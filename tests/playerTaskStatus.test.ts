// UX-REVIEW-008a 状态账本纯逻辑(backend/playerTaskStatus,零 vscode):
// 六态区分、每任务保留最近一次、结果时间与结果入口、终态约束。
import { describe, expect, it } from 'vitest';
import {
  PLAYER_TASK_OUTCOME_LABELS,
  PLAYER_TASK_RESULT_COMMAND,
  PlayerTaskStatusStore,
  formatPlayerTaskTime
} from '../src/backend/playerTaskStatus';

describe('PlayerTaskStatusStore(UX-REVIEW-008a)', () => {
  it('未运行 = 无记录(get undefined),呈现面按未运行渲染', () => {
    const store = new PlayerTaskStatusStore();
    expect(store.get('query')).toBeUndefined();
    expect(store.get('connection')).toBeUndefined();
    expect(store.recorded()).toEqual([]);
  });

  it('begin = 进行中(无结果时间无入口);finish 记录终态+结果时间+结果入口', () => {
    const store = new PlayerTaskStatusStore();
    const running = store.begin('query', '等待输入 DBID(只读查询 tbl_Account)');
    expect(running.outcome).toBe('running');
    expect(running.finishedAt).toBeUndefined();
    expect(running.detailCommandId).toBeUndefined();
    expect(store.get('query')?.outcome).toBe('running');

    const done = store.finish('query', 'empty', '查询完成:0 行', 1762732800000);
    expect(done.outcome).toBe('empty');
    expect(done.finishedAt).toBe(1762732800000);
    expect(done.detailCommandId).toBe(PLAYER_TASK_RESULT_COMMAND);
    expect(store.get('query')?.outcome).toBe('empty');
  });

  it('六态各有所指:labels 覆盖 not-run/running/empty/success/failed/cancelled', () => {
    expect(Object.keys(PLAYER_TASK_OUTCOME_LABELS).sort()).toEqual(
      ['cancelled', 'empty', 'failed', 'not-run', 'running', 'success'].sort()
    );
    expect(PLAYER_TASK_OUTCOME_LABELS['not-run']).toBe('未运行');
    expect(PLAYER_TASK_OUTCOME_LABELS.running).toBe('进行中');
    expect(PLAYER_TASK_OUTCOME_LABELS.empty).toBe('空结果');
    expect(PLAYER_TASK_OUTCOME_LABELS.success).toBe('成功');
    expect(PLAYER_TASK_OUTCOME_LABELS.failed).toBe('失败');
    expect(PLAYER_TASK_OUTCOME_LABELS.cancelled).toBe('已取消');
  });

  it('查询与连接检查各自保留最近一次,互不覆盖;finish 覆盖同任务旧记录', () => {
    const store = new PlayerTaskStatusStore();
    store.begin('query', '进行中');
    store.finish('connection', 'success', '连接成功', 1762732800000);
    expect(store.get('query')?.outcome).toBe('running');
    expect(store.get('connection')?.outcome).toBe('success');

    store.finish('query', 'success', '查询完成:1 行', 1762732801000);
    expect(store.get('query')?.summary).toBe('查询完成:1 行');
    store.finish('query', 'failed', '查询失败:ECONNREFUSED', 1762732802000);
    expect(store.get('query')?.outcome).toBe('failed');
    expect(store.get('query')?.finishedAt).toBe(1762732802000);
    expect(store.recorded().sort()).toEqual(['connection', 'query']);
  });

  it('结果时间格式钉死(本地时区 YYYY-MM-DD HH:mm:ss)', () => {
    // 2026-11-10 08:00:00 本地时区(epoch 按时区换算)
    const d = new Date(2026, 10, 10, 8, 0, 0);
    expect(formatPlayerTaskTime(d.getTime())).toBe('2026-11-10 08:00:00');
    const d2 = new Date(2026, 0, 3, 5, 7, 9);
    expect(formatPlayerTaskTime(d2.getTime())).toBe('2026-01-03 05:07:09');
  });

  it('clear 复位全部记录与尝试序号(测试隔离用)', () => {
    const store = new PlayerTaskStatusStore();
    store.begin('query', 'a');
    store.begin('connection', 'b');
    expect(store.attemptsForTests()).toBe(2);
    store.clear();
    expect(store.attemptsForTests()).toBe(0);
    expect(store.recorded()).toEqual([]);
  });

  it('每次 begin 单调递增尝试序号(008c 过期结果守卫的预留基础)', () => {
    const store = new PlayerTaskStatusStore();
    store.begin('query', '1');
    const before = store.attemptsForTests();
    store.begin('query', '2');
    expect(store.attemptsForTests()).toBe(before + 1);
  });
});

describe('过期异步结果守卫(UX-REVIEW-008c)', () => {
  it('迟到终态不覆盖新任务:begin #1 后 begin #2,#1 的 finish 被守卫丢弃,#2 状态完好', () => {
    const store = new PlayerTaskStatusStore();
    const first = store.begin('query', '等待输入 DBID');
    store.begin('query', '正在重查 dbid 42'); // 新任务接棒
    const stale = store.finish('query', 'success', '查询完成:1 行', 1762732800000, first.attempt);
    expect(stale).toBeNull(); // 过期结果被拒
    expect(store.get('query')?.outcome).toBe('running'); // 新任务状态不被覆盖
    expect(store.get('query')?.summary).toBe('正在重查 dbid 42');

    // 新尝试自己的终态照常入账
    const second = store.begin('connection', '正在检查连接');
    const done = store.finish('connection', 'failed', '连接失败:ECONNREFUSED', 1762732801000, second.attempt);
    expect(done?.outcome).toBe('failed');
    expect(store.get('connection')?.summary).toBe('连接失败:ECONNREFUSED');
  });

  it('attempt 凭据随 begin 返回且单调递增;无凭据的 finish 照常入账(008a 兼容)', () => {
    const store = new PlayerTaskStatusStore();
    const a = store.begin('query', '1');
    const b = store.begin('query', '2');
    expect(b.attempt).toBe(a.attempt + 1);
    const done = store.finish('query', 'empty', '查询完成:0 行', 1762732800000);
    expect(done).not.toBeNull();
    expect(store.get('query')?.outcome).toBe('empty');
  });
});
