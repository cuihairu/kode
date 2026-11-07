import { describe, expect, it } from 'vitest';

import {
  analyzeTimerCleanupOnDestroy,
  TIMER_CLEANUP_ON_DESTROY_DIAGNOSTIC_CODE
} from '../src/timerCleanupDiagnostics';

// C-23 交付②第三条规则:onDestroy 内定时器注销(KBE-PY-017,数据源=
// KB-001 生命周期 §Timers)。KB-001 事实:`destroy()` 即
// `scriptTimers_.cancelAll()`——引擎销毁已取消本实体全部定时器,onDestroy
// 里再 delTimer 是多余清理;且对已不存在/陈旧 id 的 delTimer 静默返回 -1
// (fork 口径,3.7 材料的「报错」说法不成立)。注:本条把任务书原拟的
// 「addTimer 句柄未在 onDestroy 注销」按 KB-001 真值修正为「onDestroy 内
// delTimer 冗余」——原形态会把 KB-001 判定的不必要动作当成缺失动作报,
// 与知识库自相矛盾。判定面:onDestroy 方法体内(块缩进内)的
// `self.delTimer(...)` 实语句;其他方法/注释同形不报。

describe('analyzeTimerCleanupOnDestroy(KBE-PY-017)', () => {
  it('正例:onDestroy 体内 delTimer 实语句报 Information 面提示', () => {
    const text = [
      'class Avatar:',
      '    def __init__(self):',
      '        self.timerID = self.addTimer(1, 0, 0)',
      '',
      '    def onDestroy(self):',
      '        self.delTimer(self.timerID)',
      '        pass',
      ''
    ].join('\n');
    const findings = analyzeTimerCleanupOnDestroy(text);
    expect(findings.map(f => [f.line])).toEqual([[5]]);
    expect(findings[0].message).toContain('cancelAll');
    expect(TIMER_CLEANUP_ON_DESTROY_DIAGNOSTIC_CODE).toBe('kbengine.timerCleanupOnDestroy');
  });

  it('反例:其他方法内 delTimer 不报;onDestroy 内注释同形不报(误报=0)', () => {
    const text = [
      'class Avatar:',
      '    def onTimer(self, timerID, userArg):',
      '        self.delTimer(timerID)',
      '',
      '    def early(self):',
      '        self.delTimer(self.timerID)',
      '',
      '    def onDestroy(self):',
      '        # self.delTimer(self.timerID)',
      '        pass',
      ''
    ].join('\n');
    expect(analyzeTimerCleanupOnDestroy(text)).toEqual([]);
  });

  it('无 onDestroy 的文件零产出', () => {
    expect(analyzeTimerCleanupOnDestroy('class Avatar:\n    def onTimer(self, t, u):\n        self.delTimer(t)\n')).toEqual([]);
    expect(analyzeTimerCleanupOnDestroy('')).toEqual([]);
  });
});
