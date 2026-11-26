// KODE-IDXREL-001 (IDX-REL-002 / KBE-PY-031): static tracking of cached
// entity references.
//
// Engine fact (docs/knowledge/entity-lifecycle-reference.md:43-93): once the
// registry drops its strong ref (`_entities.erase`), the entity object's
// lifetime is decided entirely by the OTHER CPython references (script
// closures, lists, timers). garbages only logs a leak warning after 3600 s.
// The correct pattern is to store `entity.id` and look it up through
// `KBEngine.entities.get(id)` (with a None check) when needed.
//
// Pure logic layer, no vscode import. Conservative surface — zero false
// positives takes priority. A token is a PROVABLE entity reference only if
// seeded by one of:
//   - a lifecycle hook parameter named `entity`/`nearbyEntity`, taken from
//     the fixed KBENGINE_HOOKS signature roster (four hooks:
//     onTeleportSuccess/onEnterTrap/onLeaveTrap/onEnteredView). A user
//     function's `entity` parameter outside the roster is NOT seeded:
//     demo KodeHotReload.py has `ensure_heartbeat(entity)`, so seeding by
//     name alone would break the zero-false-positive requirement.
//   - `KBEngine.entities.get(...)` / `KBEngine.entities[...]` queries, whose
//     results are strong references.
//   - an assignment chain `name = <entity expr>` / `self.<attr> = <entity
//     expr>` earlier in the same file (file-wide self attributes give the
//     cross-function chain both assignments report).
// NOT seeded: createEntity*/createEntityLocally results (demo Spaces.py
// caches a legitimate locally-created Space at line 42), `for` loop targets,
// `entity.id` reads, dynamic calls, bare unseeded names.
//
// Faces (single-line statements only; comments/strings masked by
// pythonCodeLines, bracket continuations folded by pythonStatements):
//   1. class-attr hold: `self.<attr> = <entity expr>` -> report the attr;
//   2. module-container hold: append/add/extend/update/subscript stores whose
//      argument IS an entity expression (bare self stays with KBE-PY-016);
//   3. closure capture: `KBEngine.addTimer(...)` (engine timer form) whose
//      argument references a seeded entity, and nested def bodies reading an
//      enclosing def's entity. `self.addTimer` is SAFE per KB-001 (destroy
//      cancels all timers) and is never reported.
//   4. variable chain propagation: `e = self.tmp; self.ref = e` reports both
//      assignments (per-def scope for locals, file-wide set for self attrs).
//
// Honest boundaries: multi-line RHS statements do not report (columns would
// drift in the folded text), compound `;` lines are outside the surface,
// f-string interpolations are masked as part of the string, and a renamed
// hook parameter is not guessed.

import { l10nText } from '../nlsRuntime';
import { KBENGINE_HOOKS } from '../hooks';
import { pythonCodeLines, pythonStatements } from './pythonParser';

export const ENTITY_REFERENCE_CACHE_CODE = 'kbengine.entityReferenceCache';

/** Toggle default (registered in package.json) */
export const ENTITY_REFERENCE_CACHE_DIAGNOSTICS_ENABLED_DEFAULT = true;

export interface EntityReferenceCacheFinding {
  line: number;
  character: number;
  length: number;
  message: string;
}

export const ENTITY_REFERENCE_CACHE_MESSAGE = 'Caching an entity reference blocks the engine from releasing the entity after destroy (entity_garbages warns only after 3600s); store entity.id and look it up with KBEngine.entities.get(id)';

/** Diagnostic message (single source for the l10n template) */
export function renderEntityReferenceCacheMessage(): string {
  return l10nText(ENTITY_REFERENCE_CACHE_MESSAGE);
}

/**
 * Quick fix text: `self.ref = entity` -> `self.ref_id = entity.id`.
 * Only single-line direct assignments whose RHS is a bare name or an
 * `entities.get(<name>)` call are rewritten; an attr already ending in `_id`
 * is not suffixed twice, and downstream reads are intentionally left
 * untouched (the provider title states the half-change).
 */
export function buildEntityReferenceCacheFix(lineText: string, attr?: string): string | null {
  const trimmed = lineText.trim();
  const match = /^self\.([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const name = attr ?? match[1];
  const rhs = match[2].trim();
  const bare = /^[A-Za-z_]\w*$/.exec(rhs);
  const query = /^KBEngine\.entities\.get\(([A-Za-z_]\w*)\)\s*$/.exec(rhs);
  let idExpr: string;
  if (bare) {
    idExpr = `${bare[0]}.id`;
  } else if (query) {
    idExpr = query[1];
  } else {
    return null;
  }
  const suffix = name.endsWith('_id') ? '' : '_id';
  const indent = lineText.length - trimmed.length;
  return `${' '.repeat(indent)}self.${name}${suffix} = ${idExpr}`;
}

/**
 * Fixed hook -> entity-param roster (KBE-PY-031 seeds), parsed from the
 * KBENGINE_HOOKS signatures. Test pins the exact four-name roster so a
 * future hook-table change cannot silently widen the analyzer.
 */
export function collectHookEntityParams(): ReadonlyMap<string, string> {
  const roster = new Map<string, string>();
  for (const hook of KBENGINE_HOOKS) {
    const signature = String(hook.signature ?? '');
    const match = /def\s+\w+\s*\(([^)]*)\)/.exec(signature);
    if (!match) {
      continue;
    }
    for (const raw of match[1].split(',')) {
      const name = raw.split('=')[0].trim();
      if (name === 'entity' || name === 'nearbyEntity') {
        roster.set(hook.name, name);
      }
    }
  }
  return roster;
}

const HOOK_ENTITY_PARAMS = collectHookEntityParams();

interface DefScope {
  indent: number;
  /** Local entity-valued names assigned inside this def */
  names: Set<string>;
}

interface SeedScope {
  /** Local (per-def) plus module-level entity-valued names */
  names: ReadonlySet<string>;
  selfAttrs: ReadonlySet<string>;
}

interface EntityToken {
  name: string;
  offset: number;
}

/**
 * Strict entity expression (whole text): a bare seeded name, `self.<attr>`
 * of a seeded attribute, or an entities query. Anything else — member reads
 * like `target.id`, calls like `getattr(target, ...)`, conditionals — is not
 * a stored entity reference.
 */
function strictEntityToken(text: string, scope: SeedScope): EntityToken | null {
  const trimmed = text.trim();
  const bare = /^[A-Za-z_]\w*$/.exec(trimmed);
  if (bare && scope.names.has(bare[0])) {
    return { name: bare[0], offset: text.indexOf(trimmed) };
  }
  const member = /^self\.([A-Za-z_]\w*)$/.exec(trimmed);
  if (member && scope.selfAttrs.has(member[1])) {
    return { name: trimmed, offset: text.indexOf(trimmed) };
  }
  const query = /^KBEngine\.entities\.(?:get\([^)]*\)|\[[^\]]*\])$/.exec(trimmed);
  if (query) {
    return { name: 'KBEngine.entities', offset: text.indexOf(trimmed) };
  }
  return null;
}

/**
 * Capture token (closure semantics): any reference to a seeded variable,
 * including member reads (`entity.id` still captures `entity` for the
 * closure's lifetime). `self.<attr>` of a seeded attribute counts too.
 */
function captureToken(text: string, scope: SeedScope): EntityToken | null {
  const candidates: EntityToken[] = [];
  for (const name of scope.names) {
    const match = new RegExp(`(?<![\\w.])${name}(?![\\w])`).exec(text);
    if (match) {
      candidates.push({ name, offset: match.index });
    }
  }
  for (const attr of scope.selfAttrs) {
    const match = new RegExp(`(?<![\\w.])self\\.${attr}(?![\\w])`).exec(text);
    if (match) {
      candidates.push({ name: `self.${attr}`, offset: match.index });
    }
  }
  return candidates.sort((a, b) => a.offset - b.offset || b.name.length - a.name.length)[0] ?? null;
}

/** First top-level comma-separated argument that is exactly an entity expr */
function entityArgToken(argsText: string, scope: SeedScope): EntityToken | null {
  let depth = 0;
  let current = '';
  const parts: Array<{ text: string; offset: number }> = [];
  let partStart = 0;
  for (let index = 0; index < argsText.length; index += 1) {
    const ch = argsText[index];
    if ('([{'.includes(ch)) { depth += 1; }
    if (')]}'.includes(ch)) { depth = Math.max(0, depth - 1); }
    if (ch === ',' && depth === 0) {
      parts.push({ text: current, offset: partStart });
      current = '';
      partStart = index + 1;
      continue;
    }
    current += ch;
  }
  parts.push({ text: current, offset: partStart });
  for (const part of parts) {
    const local = strictEntityToken(part.text, scope);
    if (local) {
      return { name: local.name, offset: part.offset + local.offset };
    }
  }
  return null;
}

const DEF_HEADER = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const CONTAINER_INIT = /^([A-Za-z_]\w*)\s*=\s*(\[\]|\{\}|set\(\))\s*$/;
const CONTAINER_CALL = /^([A-Za-z_]\w*)\.(append|add|extend|update)\((.+)\)/;
const CONTAINER_SUBSCRIPT = /^([A-Za-z_]\w*)\[[^\]]*\]\s*=(?!=)\s*(.+)/;
const KBENGINE_ADD_TIMER = /^KBEngine\.addTimer\((.*)\)\s*$/;

/**
 * Analyze cached entity references. Re-scans the whole text in statement
 * order on every call: no cache, no cross-document state.
 */
export function analyzeEntityReferenceHolders(text: string): EntityReferenceCacheFinding[] {
  const findings: EntityReferenceCacheFinding[] = [];
  const seen = new Set<string>();
  const statements = pythonStatements(text);
  const containers = new Set<string>();
  for (const raw of pythonCodeLines(text)) {
    // Module-level container declarations only (indent 0).
    const init = CONTAINER_INIT.exec(raw);
    if (init) {
      containers.add(init[1]);
    }
  }

  const scopes: DefScope[] = [];
  const moduleNames = new Set<string>();
  const selfAttrs = new Set<string>();

  const seedScope = (): SeedScope => {
    const names = new Set(moduleNames);
    for (const scope of scopes) {
      for (const name of scope.names) {
        names.add(name);
      }
    }
    return { names, selfAttrs };
  };

  for (const statement of statements) {
    const { text: statementText, line, indent } = statement;
    // Pop scopes whose body has ended (this statement is at the same or a
    // smaller indent than the def header). Handles nested and sibling defs.
    while (scopes.length > 0 && indent <= scopes[scopes.length - 1].indent) {
      scopes.pop();
    }
    const trimmed = statementText.trim();
    if (!trimmed) {
      continue;
    }
    const defMatch = DEF_HEADER.exec(trimmed);
    if (defMatch) {
      const seedParam = HOOK_ENTITY_PARAMS.get(defMatch[1]);
      scopes.push({ indent, names: seedParam ? new Set([seedParam]) : new Set() });
      continue;
    }
    if (/\bfor\b/.test(trimmed) && /^for\s/.test(trimmed)) {
      // Loop targets are rebinding sites, never seeds.
      continue;
    }
    const scope = seedScope();
    const indentation = leadingIndent(statementText);
    const singleLine = statement.line === statement.endLine;

    // Face 1: self.<attr> = <entity expr> (also feeds the attr chain)
    const attrAssignment = /^self\.([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/.exec(trimmed);
    if (attrAssignment) {
      const rhs = strictEntityToken(attrAssignment[2], scope);
      if (rhs) {
        selfAttrs.add(attrAssignment[1]);
        if (singleLine) {
          pushFinding(findings, seen, line, indentation + 'self.'.length, attrAssignment[1].length);
        }
      } else {
        selfAttrs.delete(attrAssignment[1]);
      }
      continue;
    }

    // Face 4: name = <entity expr> (chain propagation)
    const nameAssignment = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/.exec(trimmed);
    if (nameAssignment) {
      const rhs = strictEntityToken(nameAssignment[2], scope);
      if (rhs) {
        (scopes.length > 0 ? scopes[scopes.length - 1].names : moduleNames).add(nameAssignment[1]);
      } else {
        (scopes.length > 0 ? scopes[scopes.length - 1].names : moduleNames).delete(nameAssignment[1]);
      }
      continue;
    }

    // Face 2: module-level container stores (call and subscript forms)
    const call = CONTAINER_CALL.exec(trimmed);
    if (call && containers.has(call[1])) {
      const token = entityArgToken(call[3], scope);
      if (token && singleLine) {
        const argStart = call[0].indexOf('(') + 1;
        pushFinding(findings, seen, line, indentation + argStart + token.offset, token.name.length);
      }
      continue;
    }
    const subscript = CONTAINER_SUBSCRIPT.exec(trimmed);
    if (subscript && containers.has(subscript[1])) {
      const token = entityArgToken(subscript[2], scope);
      if (token && singleLine) {
        const argStart = subscript[0].length - subscript[2].length;
        pushFinding(findings, seen, line, indentation + argStart + token.offset, token.name.length);
      }
      continue;
    }

    // Face 3a: engine-timer closure capture (self.addTimer is safe, KB-001)
    const addTimer = KBENGINE_ADD_TIMER.exec(trimmed);
    if (addTimer) {
      const token = captureToken(addTimer[1], scope);
      if (token && singleLine) {
        const argStart = addTimer[0].indexOf('(') + 1;
        pushFinding(findings, seen, line, indentation + argStart + token.offset, token.name.length);
      }
      continue;
    }

    // Face 3b: nested def bodies referencing an enclosing def's entity
    if (scopes.length >= 2) {
      const token = captureToken(trimmed, scope);
      if (token && singleLine) {
        pushFinding(findings, seen, line, indentation + token.offset, token.name.length);
      }
    }
  }

  return findings;
}

function leadingIndent(text: string): number {
  return text.length - text.trimStart().length;
}

function pushFinding(
  findings: EntityReferenceCacheFinding[],
  seen: Set<string>,
  line: number,
  character: number,
  length: number
): void {
  const key = `${line}:${character}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  findings.push({ line, character, length, message: renderEntityReferenceCacheMessage() });
}
