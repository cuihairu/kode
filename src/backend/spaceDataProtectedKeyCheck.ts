/**
 * KSEM-DATA-06 (SEM-047) spaceData protected-key write diagnostics — pure core
 * (zero vscode dependencies).
 *
 * Source of truth (kbengine fork kbe/src/server/cellapp/spacememory.cpp): set and
 * del reject `_mapping` keys case-insensitively (kbe_stricmp) -> AssertionError
 * "key{_mapping} is protected!" (set:740-742 / del:862-864); **get is allowed
 * through** — _mapping is the space geometry mapping path, which the engine writes
 * itself via addSpaceGeometryMapping (:543-554) and getSpaceGeometryMapping reads.
 * The diagnostic is a static rendering of the engine contract, not an invented
 * rule; a get write site is not reported (the engine allows reading).
 *
 * Key protection is orthogonal to spaceID resolvability (the engine checks spaceID
 * first, then key order, but a key rejection necessarily happens once the spaceID
 * exists): set/del(_mapping) with a dynamic spaceID is reported as usual.
 */
import { l10nText } from '../nlsRuntime';
import { findSpaceDataProtectedKeyFindings, type SpaceDataProtectedKeyFinding } from './spaceDataIndexCore';

export const SPACE_DATA_PROTECTED_KEY_DIAGNOSTIC_CODE = 'kbengine.spaceDataProtectedKey';
export const SPACE_DATA_PROTECTED_KEY_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** Message template single source (the engine AssertionError contract, case-insensitive rejection). */
export function renderSpaceDataProtectedKeyMessage(
  fn: 'setSpaceData' | 'delSpaceData',
  key: string
): string {
  return l10nText(
    '{fn}("{key}") raises AssertionError at runtime — "{key}" is a protected spaceData key (space geometry mapping; engine rejects it case-insensitively; reading it via getSpaceData is allowed)',
    { fn, key }
  );
}

/** Diagnostic item (pure data; the extension side converts to vscode.Diagnostic, tests need no vscode dependency). */
export interface SpaceDataProtectedKeyDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Error';
  source: 'kbengine';
  code: string;
}

export function spaceDataProtectedKeyFindingToItem(
  finding: SpaceDataProtectedKeyFinding
): SpaceDataProtectedKeyDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.keyStart },
      end: { line: finding.line, character: finding.keyEnd }
    },
    message: renderSpaceDataProtectedKeyMessage(finding.fn, finding.keyText),
    severity: 'Error',
    source: 'kbengine',
    code: SPACE_DATA_PROTECTED_KEY_DIAGNOSTIC_CODE
  };
}

/** Whole-text analysis entry (aliases are resolved and passed in by the caller; masked stripping of comment/string pseudo-calls happens inside the pure core). */
export function analyzeSpaceDataProtectedKeys(
  text: string,
  aliases: ReadonlySet<string>
): SpaceDataProtectedKeyDiagnosticItem[] {
  return findSpaceDataProtectedKeyFindings(text, aliases).map(spaceDataProtectedKeyFindingToItem);
}
