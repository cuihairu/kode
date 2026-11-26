/**
 * Lint .py sources via ruff (IDE-RUST-005, plan A: shell out, zero API coupling).
 *
 * The Rust side `$/kode/ruff/lint` (kode-server ruff_lint.rs) handles probing /
 * spawning / parsing: always `--target-version py37` (KBEngine 3.7.3 locked) +
 * `--no-cache` (never writes into the user workspace); a missing binary is
 * honestly `available:false` (falls back, does not report). This file only does:
 * - the bridge (runRuffLint: the payload contract files/ruffPath);
 * - command orchestration (runRuffLintCommand): collect workspace .py files
 *   (bounded) -> Rust lint -> publish diagnostics; when ruff is missing,
 *   **opt-in** install (the selected interpreter's `python -m pip install ruff`),
 *   on failure report honestly and **show the manual install command** so the
 *   user can run it themselves, with pip's raw output going to the output channel;
 *   never install silently, never pretend it is installed.
 * - no vscode imports: the UI/process/diagnostics faces are all injected via
 *   deps (unit tests drive the pure orchestration).
 */

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import { l10nText } from '../nlsRuntime';

export type RustCall<T> =
  | { status: 'ok'; result: T }
  | { status: 'no-gate' }
  | { status: 'error'; reason: string };

export interface RuffDiag {
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  code: string;
  message: string;
  severity: 'error' | 'warning';
  fixable: boolean;
}

export interface RuffLintResult {
  available: boolean;
  version?: string;
  diags: RuffDiag[];
}

/** File cap for a single command (same value as the Rust MAX_FILES_PER_CALL; exceeding it honestly prompts for batching). */
export const RUFF_MAX_FILES = 2000;

/** `$/kode/ruff/lint` bridge: files passed straight through; ruffPath optional (passed in once the interpreter bin is located). */
export async function runRuffLint(
  files: string[],
  ruffPath?: string
): Promise<RustCall<RuffLintResult>> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return { status: 'no-gate' };
  }
  const response = await gate.runInRust('$/kode/ruff/lint', { files, ruffPath });
  if (!response.ok) {
    return { status: 'error', reason: response.reason };
  }
  const record = response.result as Record<string, unknown>;
  if (typeof record !== 'object' || record === null || typeof record.available !== 'boolean') {
    return { status: 'error', reason: 'ruffLint: unexpected result shape from rust backend' };
  }
  const diags = Array.isArray(record.diags) ? (record.diags as RuffDiag[]) : [];
  return {
    status: 'ok',
    result: { available: record.available, version: record.version as string | undefined, diags }
  };
}

/** Interpreter path -> the ruff executable in the same bin directory (where pip installs it). */
export function ruffExePathForInterpreter(interpreterPath: string, sep = '/'): string {
  const idx = Math.max(interpreterPath.lastIndexOf(sep), interpreterPath.lastIndexOf('\\'));
  const dir = idx >= 0 ? interpreterPath.slice(0, idx) : '.';
  const exe = sep === '\\' || dir.includes('\\') || /^[A-Za-z]:/.test(dir) ? 'ruff.exe' : 'ruff';
  return `${dir}${dir.endsWith('/') || dir.endsWith('\\') ? '' : sep}${exe}`;
}

/** Manual install command text (shown for the user to run themselves on install failure; quoted when it contains spaces). */
export function installCommandText(interpreterPath: string): string {
  const quoted = /\s/.test(interpreterPath) ? `"${interpreterPath}"` : interpreterPath;
  return `${quoted} -m pip install ruff`;
}

export interface RuffLintCommandDeps {
  /** Collect workspace .py files (bounded; the implementation decides the exclusion face). */
  getWorkspacePythonFiles(): Promise<string[]>;
  /** Currently selected interpreter path (null = none selected). */
  getInterpreterPath(): string | null;
  /** pip install (called after consent); when ok=false, output carries the raw stdout/stderr. */
  runPipInstall(interpreterPath: string): Promise<{ ok: boolean; output: string }>;
  showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
  showErrorMessage(message: string): Thenable<unknown>;
  /** Diagnostics publish face (file -> diags; an empty array clears that file). */
  setDiagnostics(entries: Array<{ file: string; diags: RuffDiag[] }>): void;
  channel: { appendLine(line: string): void; show(preserveFocus?: boolean): void };
}

const INSTALL_ACTION = l10nText('Install (via pip)');
const MANUAL_ACTION = l10nText('Show manual install command');

/**
 * `kbengine.python.ruffLint`: lint workspace .py files and publish diagnostics.
 * Missing ruff -> opt-in pip install; on failure report honestly and show the
 * manual command (user order 2026-11-06). Returns a summary line (for test
 * assertions); when it cannot proceed, returns an honest failure description.
 */
export async function runRuffLintCommand(deps: RuffLintCommandDeps): Promise<string> {
  const files = await deps.getWorkspacePythonFiles();
  if (files.length === 0) {
    return l10nText('No .py files in the workspace (ruff lint not executed).');
  }
  if (files.length > RUFF_MAX_FILES) {
    deps.setDiagnostics([]);
    return l10nText(
      'Workspace has {count} .py files, above the single-run limit {limit} (bounded rejection on the Rust side); narrow the scope and run in batches.',
      { count: files.length, limit: RUFF_MAX_FILES }
    );
  }

  const interpreter = deps.getInterpreterPath();
  const ruffPathHint = interpreter ? ruffExePathForInterpreter(interpreter) : undefined;
  let call = await runRuffLint(files, ruffPathHint);

  if (call.status === 'ok' && !call.result.available) {
    // Missing ruff: opt-in install, never install silently.
    const choice = await deps.showInformationMessage(
      l10nText(
        'ruff not found (.py lint unavailable). Install via pip with the selected interpreter?{suffix}',
        { suffix: interpreter ? '' : l10nText(' (no interpreter selected; pick one first)') }
      ),
      INSTALL_ACTION,
      MANUAL_ACTION
    );
    if (choice === MANUAL_ACTION) {
      const cmd = interpreter
        ? installCommandText(interpreter)
        : 'python3 -m pip install ruff';
      deps.channel.appendLine(l10nText('[ruff] manual install command: {cmd}', { cmd: `\n  ${cmd}` }));
      deps.channel.show(true);
      return l10nText('Manual install command shown (output channel): {cmd}', { cmd });
    }
    if (choice === INSTALL_ACTION && interpreter) {
      deps.channel.appendLine(l10nText('[ruff] {cmd} installing…', { cmd: installCommandText(interpreter) }));
      const install = await deps.runPipInstall(interpreter);
      deps.channel.appendLine(install.output.trim() || l10nText('[ruff] pip produced no output.'));
      if (!install.ok) {
        const manual = installCommandText(interpreter);
        await deps.showErrorMessage(
          l10nText(
            'ruff install failed; run it manually (the output channel has the full pip log): {cmd}',
            { cmd: manual }
          )
        );
        deps.channel.appendLine(l10nText('[ruff] install failed. Run it manually: {cmd}', { cmd: `\n  ${manual}` }));
        deps.channel.show(true);
        return l10nText('ruff install failed; manual command shown: {cmd}', { cmd: manual });
      }
      deps.channel.appendLine(l10nText('[ruff] install finished; re-checking availability…'));
      call = await runRuffLint(files, ruffExePathForInterpreter(interpreter));
    }
  }

  if (call.status === 'no-gate') {
    return l10nText('ruff lint requires the Rust backend (kode-server) to be available: check the kode-core server configuration.');
  }
  if (call.status === 'error') {
    await deps.showErrorMessage(l10nText('ruff lint failed: {reason}', { reason: call.reason }));
    return l10nText('ruff lint failed: {reason}', { reason: call.reason });
  }
  if (!call.result.available) {
    return l10nText('ruff unavailable (not installed / no interpreter selected); lint not executed.');
  }

  const byFile = new Map<string, RuffDiag[]>();
  for (const file of files) {
    byFile.set(file, []);
  }
  for (const diag of call.result.diags) {
    const list = byFile.get(diag.file) ?? [];
    list.push(diag);
    byFile.set(diag.file, list);
  }
  deps.setDiagnostics([...byFile.entries()].map(([file, diags]) => ({ file, diags })));
  const errors = call.result.diags.filter(d => d.severity === 'error').length;
  return l10nText(
    'ruff {version} lint finished: {count} files, {total} finding(s) (warning {warnings}/error {errors}).',
    {
      version: call.result.version ?? '',
      count: files.length,
      total: call.result.diags.length,
      warnings: call.result.diags.length - errors,
      errors
    }
  );
}

/**
 * `kbengine.python.installRuff`: the manual install entry (pip-install ruff with
 * the selected interpreter). On failure report honestly and show the manual
 * command (user order 2026-11-06); after success re-check availability.
 */
export async function runInstallRuffCommand(deps: RuffLintCommandDeps): Promise<string> {
  const interpreter = deps.getInterpreterPath();
  if (!interpreter) {
    await deps.showErrorMessage(
      l10nText('No Python interpreter selected; run Select Python Interpreter before installing ruff.')
    );
    return l10nText('No interpreter selected; not installed.');
  }
  const manual = installCommandText(interpreter);
  deps.channel.appendLine(l10nText('[ruff] {cmd} installing…', { cmd: manual }));
  deps.channel.show(true);
  const install = await deps.runPipInstall(interpreter);
  deps.channel.appendLine(install.output.trim() || l10nText('[ruff] pip produced no output.'));
  if (!install.ok) {
    await deps.showErrorMessage(
      l10nText('ruff install failed; run it manually (the output channel has the full pip log): {cmd}', { cmd: manual })
    );
    deps.channel.appendLine(l10nText('[ruff] install failed. Run it manually: {cmd}', { cmd: `\n  ${manual}` }));
    deps.channel.show(true);
    return l10nText('ruff install failed; manual command shown: {cmd}', { cmd: manual });
  }
  const probe = await runRuffLint([], ruffExePathForInterpreter(interpreter));
  const version =
    probe.status === 'ok' && probe.result.available
      ? (probe.result.version ?? l10nText('installed'))
      : l10nText('not detected');
  return l10nText('ruff installed ({version}); you can now run Ruff Lint Python Files.', { version });
}
