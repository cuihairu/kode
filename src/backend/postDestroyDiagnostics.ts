// IDE-LINT-010: the access-after-entity-destruction lint (KBE-PY-010) -- a direct `self.<member>`
// access after a determinable `self.destroy()` within the same function reports a Warning; the
// cross-callback / exception / dynamic dispatch / cross-block cases are marked as unanalyzed and
// deliberately produce no file-wide false positives.
//
// A pure logic layer, no vscode import. Engine facts:
//   - `destroy` is a public method of the per-face entity macro (entity_macro.h:20
//     `SCRIPT_METHOD_DECLARE("destroy", pyDestroyEntity, ...)`), and `self.destroy()` destroys
//     the entity itself;
//   - after destruction the getters (such as Entity::pyGetCellEntityCall) check destroyed and
//     access raises -- so any member access after destruction is a misuse.
//
// The determination (minimal, reliable, straight through a single block):
//   - not an entity script (no def attribution on the path face) -> not taken over (no guessing
//     for an ordinary Python class);
//   - the role is unclear (the path face is null and def attribution is empty / ambiguously
//     multi-faced) -> no guessing;
//   - inside the same function body and the same block (the same indent, with no dedent in
//     between), a destroy statement (a whole `self.destroy()` statement or
//     `x = self.destroy()`) precedes the access statement, and there is no same-level
//     `return`/`break`/`continue`/`raise` between the two (an unconditional early exit, making
//     the access dead code) -> report a Warning;
//   - the member set: `id`/`isDestroyed`/`className` are excluded (identity/state items that
//     are still readable after destruction -- reading `isDestroyed` is exactly how destruction
//     is confirmed), along with `destroy` (a repeated destruction is not the access misuse this
//     lint targets) -- any other member (property/method/EntityCall) access is reported;
//   - the destroy statement comes after the access statement, the destruction is conditional
//     (inside an if/while), or it is in a different block from the access (the destruction in an
//     ancestor block / a nested block / a callback) -> not reported (unanalyzed, see below).
//
// Known boundary (consistent with the sibling self-property lint): the destruction in an ancestor
// block, the access in a nested block, cross-function / cross-callback (destroyed in one
// callback, accessed in another), the exception path (the destruction raised and never
// completed), dynamic dispatch (the def declares a `destroy` method/property, so
// `self.destroy()` may not be the engine's destruction) -- none of these are analyzed, and none
// is passed off as implemented; `self.<prop>` only matches the single-segment `self.` prefix
// (`other.destroy` and `self.cell.destroy` do not destroy the entity itself and do not count).

import { pythonCodeLines, pythonStatements } from './pythonParser';
import { l10nText } from '../nlsRuntime';
import { resolveEntityComponentFaceFromPath, type EntityComponentFace } from './entityBuiltinProperties';

export const POST_DESTROY_DIAGNOSTIC_CODE = 'kbengine.postDestroy';
export const POST_DESTROY_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** Members that stay readable/harmless after destruction (identity, state, a repeated destruction); every other access is reported */
const SAFE_MEMBERS = new Set(['id', 'isDestroyed', 'className', 'destroy']);

const DESTROY_STATEMENT = /^(?:[A-Za-z_]\w*\s*=\s*)?self\.destroy\s*\(/;
const EARLY_EXIT_STATEMENT = /^(?:return|break|continue|raise)\b/;
const FUNCTION_HEADER = /^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/;
const ACCESS_PATTERN = /\bself\.(\w+)/g;

/** The single source of the message template (rendered in TS; Rust returns only the structural face) */
export function renderPostDestroyMessage(member: string, destroyLine: number): string {
  return l10nText(
    'self.{member} accessed after self.destroy() (destroyed at line {line}): the entity is dead after destruction; {member} access triggers the engine destroyed check',
    { member, line: destroyLine + 1 }
  );
}

/** One post-destruction access */
export interface PostDestroyFinding {
  line: number;
  character: number;
  length: number;
  member: string;
  /** The destroy statement's position (for evidence) */
  destroyLine: number;
  destroyColumn: number;
  message: string;
}

interface Statement {
  text: string;
  line: number;
  endLine: number;
  indent: number;
}

/** The same block within the same function body: the same indent, with no dedent (an indent below this level) between the two */
function sameBlock(from: Statement, to: Statement, all: readonly Statement[]): boolean {
  if (from.indent !== to.indent) {
    return false;
  }
  for (const stmt of all) {
    if (stmt.line <= from.line) { continue; }
    if (stmt.line >= to.line) { break; }
    if (stmt.indent < from.indent) {
      return false;
    }
  }
  return true;
}

/**
 * The post-destruction access determination (a pure function). pathFace and defFaces come from
 * the caller (the same same-source face determination as the builtin-property hover);
 * isDestroyDeclared says whether the def declares `destroy` (the dynamic-dispatch boundary: when
 * it does, `self.destroy()` may not be the engine's destruction, so the whole file is not
 * analyzed).
 */
export function findPostDestroyFindings(
  text: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null,
  isDestroyDeclared: boolean
): PostDestroyFinding[] {
  // The dynamic-dispatch boundary: the def declares destroy -> never pass it off as the engine's destruction
  if (isDestroyDeclared) {
    return [];
  }
  const isEntityScript = pathFace !== null || (defFaces !== null && defFaces.length > 0);
  if (!isEntityScript) {
    return [];
  }
  const face = pathFace ?? (defFaces !== null && defFaces.length === 1 ? defFaces[0] : null);
  if (face === null) {
    return [];
  }

  const statements = pythonStatements(text);
  const maskedLines = pythonCodeLines(text);
  const findings: PostDestroyFinding[] = [];

  // Only analyze inside function bodies (a module/class body has no self; a top-level match does not hold)
  for (let s = 0; s < statements.length; s += 1) {
    const header = statements[s];
    if (!FUNCTION_HEADER.test(header.text)) {
      continue;
    }
    // The function body = the statements after it whose indent is greater than the def's indent
    const bodyStart = s + 1;
    let bodyEnd = statements.length;
    for (let t = bodyStart; t < statements.length; t += 1) {
      if (statements[t].indent <= header.indent) {
        bodyEnd = t;
        break;
      }
    }
    const body = statements.slice(bodyStart, bodyEnd);

    // Within the same block, look for the destroy statement that precedes each access statement
    for (let a = 0; a < body.length; a += 1) {
      const access = body[a];
      if (!/\bself\./.test(access.text)) {
        continue;
      }
      // Find the destroy statement within this block that precedes access (same block, no same-level early exit)
      let destroy: Statement | null = null;
      for (let d = 0; d < a; d += 1) {
        const candidate = body[d];
        if (!DESTROY_STATEMENT.test(candidate.text.trimStart())) {
          continue;
        }
        if (!sameBlock(candidate, access, body)) {
          continue;
        }
        // A same-level early exit (return/break/continue/raise) between the destruction and the access -> the access is dead code
        let dead = false;
        for (let k = d + 1; k < a; k += 1) {
          const mid = body[k];
          if (mid.indent === access.indent && EARLY_EXIT_STATEMENT.test(mid.text.trimStart())) {
            dead = true;
            break;
          }
        }
        if (!dead) {
          destroy = candidate;
          break;
        }
      }
      if (destroy === null) {
        continue;
      }
      // Hit each `self.<member>` (member outside the safe set): scan the masked lines directly for the
      // position (the mask preserves source positions, and a spurious access inside a string or
      // comment does not hit)
      for (let ln = access.line; ln <= access.endLine; ln += 1) {
        const masked = maskedLines[ln];
        ACCESS_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = ACCESS_PATTERN.exec(masked)) !== null) {
          const member = match[1];
          if (SAFE_MEMBERS.has(member)) {
            continue;
          }
          const destroyColumn = Math.max(0, maskedLines[destroy.line].indexOf('self.destroy'));
          findings.push({
            line: ln,
            character: match.index,
            length: match[0].length,
            member,
            destroyLine: destroy.line,
            destroyColumn,
            message: renderPostDestroyMessage(member, destroy.line)
          });
        }
      }
    }
  }
  // Deduplicate: a nested function body is analyzed both as part of the outer function and as its own function, so the same hit can repeat
  const seen = new Set<string>();
  return findings.filter(finding => {
    const key = `${finding.line}:${finding.character}:${finding.member}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** The diagnostic item (pure data; the extension side converts it to a vscode.Diagnostic, and tests avoid the vscode dependency) */
export interface PostDestroyDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/**
 * The async entry point: pathFace fixes the face by the directory domain; when it cannot be
 * determined, the def attribution face is taken via fetchDefFaces (the same source as the
 * builtin-property inlay provider); isDestroyDeclared is supplied by the caller via
 * getMappingForPythonFile, saying whether the def declares destroy (the dynamic-dispatch
 * boundary).
 */
export async function postDestroyDiagnosticItemsAsync(
  text: string,
  filePath: string,
  fetchDefFaces: () => Promise<readonly EntityComponentFace[] | null>,
  isDestroyDeclared: () => boolean,
  enabled: boolean
): Promise<PostDestroyDiagnosticItem[]> {
  if (!enabled) {
    return [];
  }
  const pathFace = resolveEntityComponentFaceFromPath(filePath);
  let defFaces: readonly EntityComponentFace[] | null = null;
  if (!pathFace) {
    try {
      defFaces = await fetchDefFaces();
    } catch {
      defFaces = null;
    }
  }
  return findPostDestroyFindings(text, pathFace, defFaces, isDestroyDeclared()).map(postDestroyFindingToItem);
}

/** finding -> the diagnostic item (pure data; the extension side converts it to a vscode.Diagnostic) */
export function postDestroyFindingToItem(finding: PostDestroyFinding): PostDestroyDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning',
    source: 'kbengine',
    code: POST_DESTROY_DIAGNOSTIC_CODE
  };
}

// ---- The Rust face (AUDIT-005 B2 lane batch 4: postDestroy absorbed) -------------------------
// `$/kode/lint/analyzePostDestroy` goes through gate.runInRust (the same accounting as
// analyzeReceiverNone/analyzeSpaceNav): Rust returns only the structural face
// (line/character/length/member + destroyLine/destroyColumn), while the message rendering stays
// in this module (the single source for l10n). Any malformed entry returns null (the whole face is
// voided, the caller falls back to TS -- partial adoption is forbidden). Shared by the
// cross-check tests.

/** One structural entry from Rust (a `$/kode/lint/analyzePostDestroy` response; the structure is
 * validated field by field): {code, line, character, length, member, destroyLine, destroyColumn} */
const MEMBER_PATTERN = /^[A-Za-z_]\w*$/;
const SELF_DOT_LENGTH = 'self.'.length;

function renderRustPostDestroyItem(item: unknown): PostDestroyDiagnosticItem | null {
  if (item === null || typeof item !== 'object') {
    return null;
  }
  const record = item as Record<string, unknown>;
  if (record.code !== POST_DESTROY_DIAGNOSTIC_CODE) {
    return null;
  }
  const member = record.member;
  if (typeof member !== 'string' || !MEMBER_PATTERN.test(member) || SAFE_MEMBERS.has(member)) {
    return null;
  }
  const length = record.length;
  if (typeof length !== 'number' || !Number.isInteger(length) || length !== SELF_DOT_LENGTH + member.length) {
    return null;
  }
  for (const value of [record.line, record.character, record.destroyLine, record.destroyColumn]) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return null;
    }
  }
  const line = record.line as number;
  const character = record.character as number;
  const destroyLine = record.destroyLine as number;
  return {
    range: {
      start: { line, character },
      end: { line, character: character + length }
    },
    message: renderPostDestroyMessage(member, destroyLine),
    severity: 'Warning',
    source: 'kbengine',
    code: POST_DESTROY_DIAGNOSTIC_CODE
  };
}

/**
 * The structural array -> the diagnostic array (with the message rendering); any malformed entry
 * returns null (the whole face is voided, the caller falls back to TS -- partial adoption is
 * forbidden). Shared by the cross-check tests.
 */
export function renderRustPostDestroyItems(items: readonly unknown[]): PostDestroyDiagnosticItem[] | null {
  const rendered: PostDestroyDiagnosticItem[] = [];
  for (const item of items) {
    const renderedItem = renderRustPostDestroyItem(item);
    if (!renderedItem) {
      return null;
    }
    rendered.push(renderedItem);
  }
  return rendered;
}
