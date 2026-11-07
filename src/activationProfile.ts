import { performance } from 'perf_hooks';
import * as fs from 'fs';

// 激活期分阶段计时(KODE-PERF 激活排查):activate 是同步函数,视图注册与
// 重活都在同步体内完成;用户侧「There is no data provider registered」与
// 「一直在扫描」需要火焰级证据——哪些装配段各花多久。本模块只在设置了
// KODE_ACTIVATE_PROFILE_OUT(输出文件路径)时记录:markActivateStage 落标签,
// flushActivateProfile 在 activate 返回前把各段 step/total 耗时追加写入。
// 未设置环境变量时全部调用零开销直通(常态门禁与生产零影响)。

const PROFILE_OUT = process.env.KODE_ACTIVATE_PROFILE_OUT ?? '';

let stageMarks: Array<[string, number]> = [];

/** 记录一个激活阶段标记(相对 activate-enter 的 performance.now 时间戳) */
export function markActivateStage(label: string): void {
  if (!PROFILE_OUT) { return; }
  stageMarks.push([label, performance.now()]);
}

/** activate 返回前落盘:每行 stage\t<标签>\tstep=..\ttotal=.. */
export function flushActivateProfile(): void {
  if (!PROFILE_OUT || stageMarks.length === 0) { return; }
  const t0 = stageMarks[0][1];
  const lines = stageMarks.map(([label, at], index): string => {
    const previous = index === 0 ? at : stageMarks[index - 1][1];
    const stepMs = (at - previous).toFixed(2);
    const totalMs = (at - t0).toFixed(2);
    return `stage\t${label}\tstep=${stepMs}ms\ttotal=${totalMs}ms`;
  });
  try {
    fs.appendFileSync(PROFILE_OUT, lines.join('\n') + '\n');
  } catch {
    /* 诊断输出失败不影响激活 */
  }
  stageMarks = [];
}
