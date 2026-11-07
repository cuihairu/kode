/**
 * .py 源码 lint via ruff(IDE-RUST-005,A 案:shell out,零 API 耦合)。
 *
 * Rust 侧 `$/kode/ruff/lint`(kode-server ruff_lint.rs)负责探测/spawn/解析:
 * 恒 `--target-version py37`(KBEngine 3.7.3 锁死)+`--no-cache`(不写用户
 * 工作区);缺二进制如实 `available:false`(回退不报)。本文件只做:
 * - 桥(runRuffLint:载荷契约 files/ruffPath);
 * - 命令编排(runRuffLintCommand):收集工作区 .py(有界)→ Rust lint →
 *   诊断发布;缺 ruff 时**同意式**安装(选定的解释器 `python -m pip install
 *   ruff`),安装失败如实报错并**亮出手动安装命令**让用户自己跑,pip 原始
 *   输出进输出通道;绝不静默安装、绝不假装已装。
 * - 无 vscode import:UI/进程/诊断面全经 deps 注入(单测驱动纯编排)。
 */

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import { l10nText } from './nlsRuntime';

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

/** 单次命令的文件上限(与 Rust MAX_FILES_PER_CALL 同值;超出如实提示分批)。 */
export const RUFF_MAX_FILES = 2000;

/** `$/kode/ruff/lint` 桥:files 直传;ruffPath 可选(解释器 bin 定位后传入)。 */
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

/** 解释器路径 → 同 bin 目录下的 ruff 可执行(pip 装完落这里)。 */
export function ruffExePathForInterpreter(interpreterPath: string, sep = '/'): string {
  const idx = Math.max(interpreterPath.lastIndexOf(sep), interpreterPath.lastIndexOf('\\'));
  const dir = idx >= 0 ? interpreterPath.slice(0, idx) : '.';
  const exe = sep === '\\' || dir.includes('\\') || /^[A-Za-z]:/.test(dir) ? 'ruff.exe' : 'ruff';
  return `${dir}${dir.endsWith('/') || dir.endsWith('\\') ? '' : sep}${exe}`;
}

/** 手动安装命令文案(安装失败时亮给用户自己跑;带空格加引号)。 */
export function installCommandText(interpreterPath: string): string {
  const quoted = /\s/.test(interpreterPath) ? `"${interpreterPath}"` : interpreterPath;
  return `${quoted} -m pip install ruff`;
}

export interface RuffLintCommandDeps {
  /** 收集工作区 .py 文件(有界;实现方决定排除面)。 */
  getWorkspacePythonFiles(): Promise<string[]>;
  /** 当前选定解释器路径(null=未选定)。 */
  getInterpreterPath(): string | null;
  /** pip 安装(同意后调用);ok=false 时 output 携原始 stdout/stderr。 */
  runPipInstall(interpreterPath: string): Promise<{ ok: boolean; output: string }>;
  showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
  showErrorMessage(message: string): Thenable<unknown>;
  /** 诊断发布面(file → diags;空数组=清该文件)。 */
  setDiagnostics(entries: Array<{ file: string; diags: RuffDiag[] }>): void;
  channel: { appendLine(line: string): void; show(preserveFocus?: boolean): void };
}

const INSTALL_ACTION = l10nText('Install (via pip)');
const MANUAL_ACTION = l10nText('Show manual install command');

/**
 * `kbengine.python.ruffLint`:lint 工作区 .py 并发布诊断。缺 ruff → 同意式
 * pip 安装;失败如实报错并亮手动命令(用户令 2026-11-06)。返回摘要行
 * (供测试断言);不可继续时返回如实的失败说明。
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
    // 缺 ruff:同意式安装,绝不静默装。
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
 * `kbengine.python.installRuff`:手动安装入口(选定解释器 pip 装 ruff)。
 * 失败如实报错并亮手动命令(用户令 2026-11-06);成功后复检可用性。
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
