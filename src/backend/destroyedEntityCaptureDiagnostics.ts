// C-23 deliverable 2, second rule (KBE-PY-016): lint for stale references to
// destroyed entities.
// Data source = KB-001 lifecycle/memory topic (docs/knowledge/traps-index.md
// §Memory & references; src/knowledge/trapsKnowledge.ts
// detection='destroyed-entity-container-capture'). KB-001 fact: the real
// reference hazard is not timers (destroy cancels all of them immediately and
// handlers hold no strong Python reference), but scripts storing the entity
// reference (self) into a **module-level container** that outlives the
// entity — after destroy the reference lingers and the engine emits a
// garbages leak warning after 3600 s; the correct move is to drop the
// reference in onDestroy, and `KBEngine.entities.garbages.items()` finds the
// lingering holders.
//
// Pure logic layer, no vscode import. Detection (conservative surface,
// zero false positives takes priority):
//   - Module-level containers: list/dict/set declared at column 0
//     (indent 0) via `NAME = []` / `NAME = {}` / `NAME = set()`
//     (non-container globals such as scalars/lambdas are not considered);
//   - Statements inside a class body (indent > 0) storing `self` into a
//     container: append/add/extend/update calls (argument containing a
//     standalone self token) and `NAME[...] = …self…` subscript assignment;
//   - Not reported: local containers, non-self arguments, read operations
//     (`in` checks), and comment lines shaped the same way;
//   - Closure escape (`lambda: self`), function attributes and similar
//     surfaces are not analyzed — honest boundary, no overclaiming.

import { l10nText } from '../nlsRuntime';

export const DESTROYED_ENTITY_REFERENCE_DIAGNOSTIC_CODE = 'kbengine.destroyedEntityReference';

/** A single stale entity reference finding */
export interface DestroyedEntityCaptureFinding {
  line: number;
  /** Start column (0-based) of the `self` token */
  character: number;
  length: number;
  container: string;
  /** Container operation (append/add/extend/update/subscript) */
  method: string;
  message: string;
}

const CONTAINER_INIT = /^([A-Za-z_]\w*)\s*=\s*(\[\]|\{\}|set\(\))\s*$/;
const CALL_CAPTURE = /\b([A-Za-z_]\w*)\.(append|add|extend|update)\((.+)\)/;
const SUBSCRIPT_CAPTURE = /\b([A-Za-z_]\w*)\[[^\]]+\]\s*=\s*(.+)/;

/** Diagnostic message (single source for the l10n template; the Rust structure surface renders through this function via the wiring layer) */
export function renderDestroyedEntityReferenceMessage(container: string): string {
  return l10nText(
    'Storing self in a module-level container keeps the entity alive after destroy (garbages leak); drop the reference in onDestroy',
    { container }
  );
}

export function analyzeDestroyedEntityCaptures(text: string): DestroyedEntityCaptureFinding[] {
  const findings: DestroyedEntityCaptureFinding[] = [];
  const lines = text.split(/\r?\n/);
  const containers = new Set<string>();
  for (const raw of lines) {
    const init = CONTAINER_INIT.exec(raw);
    if (init) {
      containers.add(init[1]);
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || !raw.startsWith(' ')) {
      continue;
    }
    const call = CALL_CAPTURE.exec(trimmed);
    if (call && containers.has(call[1])) {
      const argOffset = trimmed.indexOf(call[3]);
      const selfOffset = standaloneSelfOffset(call[3]);
      if (selfOffset >= 0) {
        const lineIndent = raw.length - raw.trimStart().length;
        findings.push({
          line: index,
          character: lineIndent + argOffset + selfOffset,
          length: 'self'.length,
          container: call[1],
          method: call[2],
          message: renderDestroyedEntityReferenceMessage(call[1])
        });
      }
      continue;
    }
    const subscript = SUBSCRIPT_CAPTURE.exec(trimmed);
    if (subscript && containers.has(subscript[1]) && standaloneSelfOffset(subscript[2]) >= 0) {
      const targetLength = subscript[0].length - subscript[2].length;
      const lineIndent = raw.length - raw.trimStart().length;
      findings.push({
        line: index,
        character: lineIndent + targetLength + standaloneSelfOffset(subscript[2]),
        length: 'self'.length,
        container: subscript[1],
        method: 'subscript',
        message: renderDestroyedEntityReferenceMessage(subscript[1])
      });
    }
  }
  return findings;
}

/** 0-based column of a standalone `self` token in the argument/rvalue text; -1 if absent (member reads such as self.id do not count) */
function standaloneSelfOffset(text: string): number {
  const match = /(?<![\w.])self(?![\w.])/.exec(text);
  return match ? match.index : -1;
}
