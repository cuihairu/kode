/**
 * One-click .py formatting via ruff format (2026-11-18 batch A, inspection sheet
 * kode-ruff-format-statusbar.md). Plan A shells out with zero API coupling, the
 * same ruling as ruffLint: the Rust side `$/kode/ruff/format`
 * (kode-server ruff_format.rs) handles probing/spawn/the stdin->stdout pipe; a
 * missing binary is honestly `available:false` (falls back, does not report).
 * This file only does:
 * - the bridge (runRuffFormat: the payload contract content/fileName/ruffPath);
 * - command orchestration (runRuffFormatCommand): active .py -> format ->
 *   full-text replace; missing ruff is opt-in installed (the mature ruffLint
 *   precedent), a refusal shows the manual command, never installs silently;
 * - provider registration orchestration (ensureRuffFormatterRegistered): once ruff
 *   is probed, auto-register both document/range providers (**never grabs the
 *   default**: editor.defaultFormatter is untouched; only when the user has no
 *   python formatter configured at all is there a one-time "set as default"
 *   prompt, and it only applies when clicked);
 * - generator passthrough (formatGeneratedPython): multi-line only when ruff is
 *   probed; when unavailable, return verbatim (single-line compatibility).
 * - no vscode imports: the UI/process faces are all injected via deps (unit
 *   tests drive the pure orchestration).
 */

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import { l10nText } from '../nlsRuntime';
import type { RustCall } from './ruffLint';

export interface RuffFormatResult {
  available: boolean;
  version?: string;
  formatted?: string;
}

/** `$/kode/ruff/format` bridge: content/fileName passed straight through (the stdin pipe is handled by the Rust side). */
export async function runRuffFormat(
  content: string,
  fileName: string,
  ruffPath?: string
): Promise<RustCall<RuffFormatResult>> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return { status: 'no-gate' };
  }
  const response = await gate.runInRust('$/kode/ruff/format', { content, fileName, ruffPath });
  if (!response.ok) {
    return { status: 'error', reason: response.reason };
  }
  const record = response.result as Record<string, unknown>;
  if (typeof record !== 'object' || record === null || typeof record.available !== 'boolean') {
    return { status: 'error', reason: 'ruffFormat: unexpected result shape from rust backend' };
  }
  if (record.available && typeof record.formatted !== 'string') {
    return { status: 'error', reason: 'ruffFormat: available face must carry formatted text' };
  }
  return {
    status: 'ok',
    result: {
      available: record.available,
      version: record.version as string | undefined,
      formatted: record.formatted as string | undefined
    }
  };
}

export interface RuffFormatCommandDeps {
  /** The active editor file (.py only; non-.py / no editor = null). */
  getActivePythonFile(): { fileName: string; content: string } | null;
  /** Apply the formatted full text (an edit replacement). */
  applyFormattedText(text: string): void;
  /** Currently selected interpreter path (null = none selected). */
  getInterpreterPath(): string | null;
  /** Locate ruff under the interpreter bin (null = fall back to PATH); probing and formatting share one source so a probe hit cannot miss at format time. */
  getRuffPath?(): string | undefined;
  /** pip install (called after consent); when ok=false, output carries the raw stdout/stderr. */
  runPipInstall(interpreterPath: string): Promise<{ ok: boolean; output: string }>;
  showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
  showErrorMessage(message: string): Thenable<unknown>;
  channel: { appendLine(line: string): void; show(preserveFocus?: boolean): void };
}

const INSTALL_ACTION = l10nText('Install (via pip)');
const SKIP_ACTION = l10nText('Not now');

/**
 * `kbengine.python.ruffFormat`: format the current .py. When available, replace the
 * full text; missing ruff -> opt-in install (one automatic retry once installed);
 * on install failure/refusal honestly show the manual command, no crash.
 */
export async function runRuffFormatCommand(deps: RuffFormatCommandDeps): Promise<void> {
  const active = deps.getActivePythonFile();
  if (!active) {
    void deps.showInformationMessage(l10nText('Open a Python file to format it with ruff.'));
    return;
  }
  let call = await runRuffFormat(active.content, active.fileName, deps.getRuffPath?.());
  if (call.status === 'ok' && !call.result.available) {
    const interpreter = deps.getInterpreterPath();
    if (interpreter) {
      const choice = await deps.showInformationMessage(
        l10nText('ruff is not installed. Install it now via pip?'),
        INSTALL_ACTION,
        SKIP_ACTION
      );
      if (choice === INSTALL_ACTION) {
        const install = await deps.runPipInstall(interpreter);
        deps.channel.appendLine(install.output);
        if (install.ok) {
          call = await runRuffFormat(active.content, active.fileName, deps.getRuffPath?.());
        } else {
          deps.channel.show(true);
          void deps.showErrorMessage(
            l10nText('pip install failed. Run it manually: {cmd}', {
              cmd: `${interpreter} -m pip install ruff`
            })
          );
          return;
        }
      } else {
        void deps.showErrorMessage(
          l10nText('Manual install command: {cmd}', { cmd: `${interpreter} -m pip install ruff` })
        );
        return;
      }
    }
  }
  if (call.status !== 'ok') {
    void deps.showErrorMessage(
      l10nText('ruff format failed: {reason}', {
        reason: call.status === 'error' ? call.reason : 'rust backend unavailable'
      })
    );
    return;
  }
  if (!call.result.available || call.result.formatted === undefined) {
    // No interpreter to install with / still not installed: show the manual command so the user installs it themselves, no retry storm.
    void deps.showErrorMessage(l10nText('ruff is not installed. Install it and retry.'));
    return;
  }
  deps.applyFormattedText(call.result.formatted);
}

export interface RuffFormatterRegisterDeps {
  /** Probe ruff availability (interpreter bin/PATH; no UI is shown). */
  probeRuffAvailable(): Promise<boolean>;
  registerDocumentFormattingEditProvider(
    selector: unknown,
    provider: unknown
  ): unknown;
  registerDocumentRangeFormattingEditProvider(
    selector: unknown,
    provider: unknown
  ): unknown;
  /** The user's current editor.defaultFormatter value (unset = undefined). */
  getDefaultFormatter(): string | undefined;
  /** The actual write face after the user clicks "Set as default" (injected by the wiring layer; not injected = ask but never set). */
  setDefaultFormatter?(): void;
  /** Locate ruff under the interpreter bin (null/not injected = fall back to PATH); the probe and the provider share one source. */
  getRuffPath?(): string | undefined;
  showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
}

const SET_DEFAULT_ACTION = l10nText('Set as default formatter');

/**
 * Probe-and-register at activation (never grabs the default): when ruff is probed
 * -> register both document/range providers (python); not probed -> no
 * registration, zero intrusion. Only when the user has no defaultFormatter
 * configured at all, a one-time "set as default" prompt — it applies only when
 * clicked, never changes anything automatically.
 */
export async function ensureRuffFormatterRegistered(deps: RuffFormatterRegisterDeps): Promise<boolean> {
  const available = await deps.probeRuffAvailable();
  if (!available) {
    return false;
  }
  const documentProvider = makeRuffFormatProvider(deps.getRuffPath);
  deps.registerDocumentFormattingEditProvider({ language: 'python' }, documentProvider);
  deps.registerDocumentRangeFormattingEditProvider({ language: 'python' }, documentProvider);
  if (!deps.getDefaultFormatter()) {
    void deps.showInformationMessage(
      l10nText('Kode (ruff) can format Python files. Set it as the default formatter?'),
      SET_DEFAULT_ACTION
    ).then(choice => {
      // "Set only when clicked": the wiring layer wires up the actual set face;
      // this only orchestrates the question, the set action is injected by the
      // deps consumer (keeping this core zero-vscode).
      if (choice === SET_DEFAULT_ACTION) { deps.setDefaultFormatter?.(); }
    });
  }
  return true;
}

/** Provider body: shared by document/range — content -> runRuffFormat -> a full-text TextEdit replacement. */
function makeRuffFormatProvider(
  getRuffPath?: () => string | undefined
): {
  provideDocumentFormattingEdits(document: { fileName: string; getText(): string }): Promise<Array<{ range: unknown; newText: string }> | undefined>;
  provideDocumentRangeFormattingEdits(document: { fileName: string; getText(): string }): Promise<Array<{ range: unknown; newText: string }> | undefined>;
} {
  const format = async (document: { fileName: string; getText(): string }) => {
    const call = await runRuffFormat(document.getText(), document.fileName, getRuffPath?.());
    if (call.status !== 'ok' || !call.result.available || call.result.formatted === undefined) {
      return undefined;
    }
    return [{ range: undefined, newText: call.result.formatted }];
  };
  return {
    provideDocumentFormattingEdits: format,
    provideDocumentRangeFormattingEdits: format
  };
}

export interface FormatGeneratedPythonDeps {
  /** The format face (production = runRuffFormat's available gate; tests inject a multi-line stand-in). */
  runFormat(content: string, fileName: string): Promise<{ available: boolean; formatted?: string }>;
}

/**
 * Generator passthrough (root fix): after a config py is generated, multi-line it
 * via ruff format — FIXED_DICT/ARRAY long defaults no longer squeeze onto one line
 * and stay debug-readable. ruff not probed / any failure -> return verbatim (the
 * single-line output stays untouched), and the generation chain is never blocked by
 * the formatting face.
 */
export async function formatGeneratedPython(
  content: string,
  fileName: string,
  deps: FormatGeneratedPythonDeps
): Promise<string> {
  try {
    const result = await deps.runFormat(content, fileName);
    if (result.available && typeof result.formatted === 'string') {
      return result.formatted;
    }
  } catch {
    // Any exception in the formatting face must not drag down the generation chain
  }
  return content;
}
