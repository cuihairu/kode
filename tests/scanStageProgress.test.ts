import { afterEach, describe, expect, it } from 'vitest';
import {
  createScanStageProgressReporter,
  SCAN_STAGE_PROGRESS_MIN_INTERVAL_MS,
  SCAN_STAGE_PROGRESS_REPORT_EVERY,
  setScanStageProgressClockForTests
} from '../src/backend/scanStageProgress';

// WARM-VISIBILITY-004 刀 A:首扫阶段内节流进度上报器契约。
//   - 计数闸:距上次上报 ≥ SCAN_STAGE_PROGRESS_REPORT_EVERY 个文件;
//   - 时间闸:距上次上报 ≥ SCAN_STAGE_PROGRESS_MIN_INTERVAL_MS(首报例外);
//   - 终报恒发(N/N 收口);
//   - 频率上限:大仓(几百文件)不刷屏(上报数 ≤ 文件数/计数闸 + 终报)。
// 时钟注入固定值:断言确定性(真实 Date.now 下快机/慢机分叉)。

afterEach(() => {
  setScanStageProgressClockForTests(null);
});

describe('createScanStageProgressReporter 契约', () => {
  it('双闸:计数边界过了但时间未到 → 不报;终报不受双闸', () => {
    setScanStageProgressClockForTests(() => 1000);
    const lines: string[] = [];
    const r = createScanStageProgressReporter({ label: '实体发现链 def', total: 30, report: d => lines.push(d) });
    for (let i = 0; i < 10; i += 1) { r.step(); }
    // 首报:lastTime 初始 0,1000-0 ≥ 500 → 计数边界 10 立即放行
    expect(lines).toEqual(['实体发现链 def 10/30']);
    for (let i = 10; i < 30; i += 1) { r.step(); }
    // 时钟钉在 1000:后续计数边界(20)全被时间闸拦
    expect(lines).toEqual(['实体发现链 def 10/30']);
    r.finish();
    // 终报恒发,不受双闸
    expect(lines).toEqual(['实体发现链 def 10/30', '实体发现链 def 30/30']);
  });

  it('时间闸推进后恢复上报:500ms 后的计数边界照报', () => {
    let clock = 1000;
    setScanStageProgressClockForTests(() => clock);
    const lines: string[] = [];
    const r = createScanStageProgressReporter({ label: '事件/方法索引', total: 40, report: d => lines.push(d) });
    for (let i = 0; i < 10; i += 1) { r.step(); }
    clock = 1600; // +600ms ≥ 500
    for (let i = 10; i < 22; i += 1) { r.step(); }
    expect(lines).toEqual(['事件/方法索引 10/40', '事件/方法索引 20/40']);
    r.finish();
    expect(lines[lines.length - 1]).toBe('事件/方法索引 22/40');
  });

  it('频率上限:600 文件大仓,上报数 ≤ 600/计数闸+终报,不逐文件刷屏', () => {
    let clock = 0;
    setScanStageProgressClockForTests(() => clock);
    const lines: string[] = [];
    const r = createScanStageProgressReporter({ label: '事件/方法索引', total: 600, report: d => lines.push(d) });
    for (let i = 0; i < 600; i += 1) {
      clock += 10; // 时间闸全放行,只剩计数闸约束
      r.step();
    }
    r.finish();
    expect(lines.length).toBeLessThanOrEqual(600 / SCAN_STAGE_PROGRESS_REPORT_EVERY + 1);
    expect(lines.every(l => l.startsWith('事件/方法索引 '))).toBe(true);
    // 进度只增不减
    const nums = lines.map(l => Number(l.split(' ')[1].split('/')[0]));
    for (let i = 1; i < nums.length; i += 1) {
      expect(nums[i]).toBeGreaterThanOrEqual(nums[i - 1]);
    }
  });

  it('step 支持批量计数(恢复路径整块推进)与零文件收尾', () => {
    setScanStageProgressClockForTests(() => 1000);
    const lines: string[] = [];
    const r = createScanStageProgressReporter({ label: '事件/方法索引', total: 12, report: d => lines.push(d) });
    r.step(12);
    expect(lines).toEqual(['事件/方法索引 12/12']);
    r.finish();
    expect(lines).toEqual(['事件/方法索引 12/12', '事件/方法索引 12/12']);

    const empty: string[] = [];
    const r0 = createScanStageProgressReporter({ label: '事件/方法索引', total: 0, report: d => empty.push(d) });
    r0.finish();
    // 零文件:只有终报一条 0/0(阶段确实跑过的可见信号)
    expect(empty).toEqual(['事件/方法索引 0/0']);
  });

  it('常量契约:计数闸 10、时间闸 500ms(文档引用同一组值)', () => {
    expect(SCAN_STAGE_PROGRESS_REPORT_EVERY).toBe(10);
    expect(SCAN_STAGE_PROGRESS_MIN_INTERVAL_MS).toBe(500);
  });
});
