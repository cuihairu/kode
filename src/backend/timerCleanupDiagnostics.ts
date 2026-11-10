// C-23 交付②第三条规则(KBE-PY-017):onDestroy 内定时器注销 lint。
// 数据源 = KB-001 生命周期 §Timers(docs/knowledge/traps-index.md
// §Timers & controllers;src/knowledge/trapsKnowledge.ts
// detection='timer-cancel-on-destroy')。KB-001 事实:`destroy()` 即
// `scriptTimers_.cancelAll()`——引擎销毁已取消本实体全部定时器,onDestroy
// 里再 delTimer 是多余清理;且对陈旧/不存在 id 的 delTimer 静默返回 -1
// (fork 口径)。注:任务书原拟「addTimer 句柄未在 onDestroy 注销」按
// KB-001 真值修正为「onDestroy 内 delTimer 冗余」——原形态会把知识库判定
// 为不必要的动作当成缺失动作报,与数据源自相矛盾。
//
// 纯逻辑层,不 import vscode。判定(保守面):`def onDestroy(self…)` 方法
// 块(缩进大于方法头且未低于方法头缩进闭合)内的 `self.delTimer(` 实语句;
// 其他方法、注释同形、无 onDestroy 文件不报。

import { l10nText } from '../nlsRuntime';

export const TIMER_CLEANUP_ON_DESTROY_DIAGNOSTIC_CODE = 'kbengine.timerCleanupOnDestroy';

/** 一处冗余的销毁期定时器注销 */
export interface TimerCleanupFinding {
  line: number;
  /** `self.delTimer` 起点所在行内 0 起列(语句首非空白列) */
  character: number;
  length: number;
  message: string;
}

const ON_DESTROY_HEADER = /^(\s*)(?:async\s+)?def\s+onDestroy\s*\(\s*self\b/;
const DEL_TIMER_CALL = /\bself\.delTimer\s*\(/;

/** 诊断文案(l10n 模板单一来源;Rust 结构面经 wiring 层用本函数渲染) */
export function renderTimerCleanupMessage(): string {
  return l10nText(
    'delTimer inside onDestroy is unnecessary: destroy() already cancels all timers (scriptTimers_.cancelAll(); stale ids silently return -1)'
  );
}

export function analyzeTimerCleanupOnDestroy(text: string): TimerCleanupFinding[] {
  const findings: TimerCleanupFinding[] = [];
  const lines = text.split(/\r?\n/);
  let onDestroyIndent: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (onDestroyIndent !== null) {
      // 块闭合:非空行缩进回到/低于方法头缩进
      if (trimmed && indent <= onDestroyIndent) {
        onDestroyIndent = null;
      }
    }
    if (onDestroyIndent === null) {
      const header = ON_DESTROY_HEADER.exec(raw);
      if (header) {
        onDestroyIndent = header[1].length;
      }
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const call = DEL_TIMER_CALL.exec(trimmed);
    if (call) {
      findings.push({
        line: index,
        character: indent + call.index,
        length: call[0].length,
        message: renderTimerCleanupMessage()
      });
    }
  }
  return findings;
}
