// QA-001b (2026-11-22): Proxy session-semantics checking face (two
// divergence arms; rulings sourced from docs/knowledge/proxy-session-semantics.md
// §4/§6, engine head 55a66552):
//   - the onLogOnAttempt return-value matrix: the switch gives only
//     LOG_ON_ACCEPT an independent branch (takeover + rebuild the proxy
//     chain); LOG_ON_WAIT_FOR_DESTROY shares the default branch
//     (baseapp.cpp:4020-4021) → loginBaseappFailed
//     (SERVER_ERR_ACCOUNT_IS_ONLINE) = effectively a rejection. The only
//     returns a script can reliably depend on are accept/reject; returning
//     WAIT_FOR_DESTROY is the divergence arm depending on ideal semantics
//     that are not implemented → report;
//   - the five giveClientTo pre-check boundaries: source destroyed / source
//     has no client / target destroyed / target is self / target already has
//     a client; a failure triggers onGiveClientToFailure (not a mid-migration
//     network failure). The statically provable shape = the target is self
//     (`giveClientTo(self)`) → the pre-check must fail → report; the other
//     four pre-checks are not statically provable → do not guess.
//
// Takes over only baseapp entity scripts (the Proxy session domain); unclear
// faces / non-baseapp yield nothing (no guessing for plain Python classes
// and cellapp/client). Pure logic layer, does not import vscode; the Rust
// face has not absorbed this family yet (absorption belongs to a later
// batch).

import { maskPythonNonCode } from './pythonLexicalMask';
import { l10nText } from '../nlsRuntime';
import type { EntityComponentFace } from './entityBuiltinProperties';

export const PROXY_SESSION_DIAGNOSTIC_CODE = 'kbengine.proxySessionSemantics';
export const PROXY_SESSION_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** One Proxy session-semantics finding (the minimal information the diagnostic face needs) */
export interface ProxySessionFinding {
  /** Line (0-based) */
  line: number;
  /** Start column (0-based) */
  character: number;
  /** Highlight length */
  length: number;
  kind: 'logon-attempt-wait-for-destroy' | 'give-client-to-self';
  message: string;
}

/**
 * Arm 1 message: WAIT_FOR_DESTROY has not landed as an independent queued
 * flow; it is effectively the same as a rejection.
 */
export function renderLogOnAttemptWaitForDestroyMessage(): string {
  return l10nText(
    'onLogOnAttempt returns LOG_ON_WAIT_FOR_DESTROY: the current engine does not implement a queued-login flow for this value (baseapp.cpp:4020-4021 shares the default branch, effectively a rejection); only LOG_ON_ACCEPT / LOG_ON_REJECT are stable return values'
  );
}

/**
 * Arm 2 message: the target is the caller itself = the pre-check must fail.
 */
export function renderGiveClientToSelfMessage(): string {
  return l10nText(
    'giveClientTo(self): the caller itself is the target, a giveClientTo pre-check violation (the engine raises onGiveClientToFailure for this, not a mid-migration network failure)'
  );
}

/**
 * Proxy session-semantics ruling (pure function): the provable shapes of the
 * two divergence arms.
 * faces is provided by the caller (getEntityComponentFacesForPythonFile);
 * takeover happens only when it includes baseapp (the Proxy session
 * domain) — an unclear face (null/empty) or non-baseapp yields nothing.
 */
export function findProxySessionFindings(
  text: string,
  faces: readonly EntityComponentFace[] | null
): ProxySessionFinding[] {
  if (!faces?.includes('baseapp')) {
    return [];
  }
  const masked = maskPythonNonCode(text);
  const lines = masked.split(/\r?\n/);
  const findings: ProxySessionFinding[] = [];

  // Arm 1: a return inside the onLogOnAttempt method body referencing
  // LOG_ON_WAIT_FOR_DESTROY.
  // Method boundary = indentation falling back (locating per method, so no
  // cross-method false positives).
  for (let i = 0; i < lines.length; i += 1) {
    const defMatch = /^\s*def\s+onLogOnAttempt\s*\(/.exec(lines[i]);
    if (!defMatch) {
      continue;
    }
    const defIndent = (defMatch[0].match(/^\s*/) ?? [''])[0].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (/^\s*$/.test(line)) {
        continue;
      }
      const indent = (line.match(/^\s*/) ?? [''])[0].length;
      if (indent <= defIndent) {
        break;
      }
      if (/return\s+.*\bLOG_ON_WAIT_FOR_DESTROY\b/.test(line)) {
        const column = line.indexOf('LOG_ON_WAIT_FOR_DESTROY');
        findings.push({
          line: j,
          character: column,
          length: 'LOG_ON_WAIT_FOR_DESTROY'.length,
          kind: 'logon-attempt-wait-for-destroy',
          message: renderLogOnAttemptWaitForDestroyMessage()
        });
      }
    }
  }

  // Arm 2: giveClientTo(self) (the target is self; the pre-check must fail for any receiver).
  const givePattern = /\bgiveClientTo\s*\(\s*self\s*\)/;
  for (let i = 0; i < lines.length; i += 1) {
    const match = givePattern.exec(lines[i]);
    if (match) {
      findings.push({
        line: i,
        character: match.index,
        length: match[0].length,
        kind: 'give-client-to-self',
        message: renderGiveClientToSelfMessage()
      });
    }
  }
  return findings;
}

/** Diagnostic item (pure data; the extension side converts to vscode.Diagnostic, tests stay vscode-free) */
export interface ProxySessionDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/** findings → diagnostic items (pure data; tests stay vscode-free) */
export function proxySessionFindingsToItems(
  findings: readonly ProxySessionFinding[]
): ProxySessionDiagnosticItem[] {
  return findings.map(finding => ({
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning' as const,
    source: 'kbengine' as const,
    code: PROXY_SESSION_DIAGNOSTIC_CODE
  }));
}
