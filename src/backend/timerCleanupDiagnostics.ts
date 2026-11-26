// C-23 delivery (2), the third rule (KBE-PY-017): the timer cancellation lint inside
// onDestroy.
// Data source = KB-001 lifecycle §Timers (docs/knowledge/traps-index.md
// §Timers & controllers; src/knowledge/trapsKnowledge.ts
// detection='timer-cancel-on-destroy'). KB-001 fact: `destroy()` is
// `scriptTimers_.cancelAll()` — engine destruction already cancels every timer of
// this entity, so delTimer again inside onDestroy is redundant cleanup; moreover
// delTimer on a stale/nonexistent id silently returns -1 (the fork ruling). Note:
// the task sheet originally proposed "an addTimer handle not cancelled in
// onDestroy", corrected per the KB-001 truth to "delTimer inside onDestroy is
// redundant" — the original shape would report an action the knowledge base
// deems unnecessary as a missing action, self-contradicting the data source.
//
// Pure logic layer, no vscode import. Judging (the conservative face): the real
// `self.delTimer(` statements inside a `def onDestroy(self…)` method block
// (indentation greater than the method header and not closed below the header's
// indentation); other methods, comment-shaped lookalikes, and files without
// onDestroy do not report.

import { l10nText } from '../nlsRuntime';

export const TIMER_CLEANUP_ON_DESTROY_DIAGNOSTIC_CODE = 'kbengine.timerCleanupOnDestroy';

/** One redundant destroy-time timer cancellation */
export interface TimerCleanupFinding {
  line: number;
  /** 0-based column within the line of the `self.delTimer` start (the statement's first non-whitespace column) */
  character: number;
  length: number;
  message: string;
}

const ON_DESTROY_HEADER = /^(\s*)(?:async\s+)?def\s+onDestroy\s*\(\s*self\b/;
const DEL_TIMER_CALL = /\bself\.delTimer\s*\(/;

/** Diagnostic text (the l10n template single source; the Rust structural face renders through this function via the wiring layer) */
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
      // Block closed: a non-empty line's indentation returns to/below the method header indentation
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
