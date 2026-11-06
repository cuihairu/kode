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

const INSTALL_ACTION = '安装(Install via pip)';
const MANUAL_ACTION = '手动安装命令(Show command)';

/**
 * `kbengine.python.ruffLint`:lint 工作区 .py 并发布诊断。缺 ruff → 同意式
 * pip 安装;失败如实报错并亮手动命令(用户令 2026-11-06)。返回摘要行
 * (供测试断言);不可继续时返回如实的失败说明。
 */
export async function runRuffLintCommand(deps: RuffLintCommandDeps): Promise<string> {
  const files = await deps.getWorkspacePythonFiles();
  if (files.length === 0) {
    return '工作区没有 .py 文件(未执行 ruff lint)。';
  }
  if (files.length > RUFF_MAX_FILES) {
    deps.setDiagnostics([]);
    return `工作区 .py 文件 ${files.length} 个,超单次上限 ${RUFF_MAX_FILES}(Rust 侧有界拒绝);请缩小范围分批执行。`;
  }

  const interpreter = deps.getInterpreterPath();
  const ruffPathHint = interpreter ? ruffExePathForInterpreter(interpreter) : undefined;
  let call = await runRuffLint(files, ruffPathHint);

  if (call.status === 'ok' && !call.result.available) {
    // 缺 ruff:同意式安装,绝不静默装。
    const choice = await deps.showInformationMessage(
      `未找到 ruff(.py lint 不可用)。用选定解释器 pip 安装?${interpreter ? '' : '(未选定解释器,先选)'}`,
      INSTALL_ACTION,
      MANUAL_ACTION
    );
    if (choice === MANUAL_ACTION) {
      const cmd = interpreter
        ? installCommandText(interpreter)
        : 'python3 -m pip install ruff';
      deps.channel.appendLine(`[ruff] 手动安装命令:\n  ${cmd}`);
      deps.channel.show(true);
      return `手动安装命令已显示(输出通道):${cmd}`;
    }
    if (choice === INSTALL_ACTION && interpreter) {
      deps.channel.appendLine(`[ruff] ${installCommandText(interpreter)} 安装中…`);
      const install = await deps.runPipInstall(interpreter);
      deps.channel.appendLine(install.output.trim() || '[ruff] pip 无输出。');
      if (!install.ok) {
        const manual = installCommandText(interpreter);
        await deps.showErrorMessage(
          `ruff 安装失败,请手动执行(输出通道有 pip 完整日志):${manual}`
        );
        deps.channel.appendLine(`[ruff] 安装失败。请手动执行:\n  ${manual}`);
        deps.channel.show(true);
        return `ruff 安装失败;手动命令已亮出:${manual}`;
      }
      deps.channel.appendLine('[ruff] 安装完成,复检可用性…');
      call = await runRuffLint(files, ruffExePathForInterpreter(interpreter));
    }
  }

  if (call.status === 'no-gate') {
    return 'ruff lint 需要 Rust 后端(kode-server)可用:请检查 kode-core server 配置。';
  }
  if (call.status === 'error') {
    await deps.showErrorMessage(`ruff lint 失败:${call.reason}`);
    return `ruff lint 失败:${call.reason}`;
  }
  if (!call.result.available) {
    return 'ruff 不可用(未安装/未选定解释器);未执行 lint。';
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
  return `ruff ${call.result.version ?? ''} lint 完成:${files.length} 文件,` +
    `${call.result.diags.length} 条(warning ${call.result.diags.length - errors}/error ${errors})。`;
}

/**
 * `kbengine.python.installRuff`:手动安装入口(选定解释器 pip 装 ruff)。
 * 失败如实报错并亮手动命令(用户令 2026-11-06);成功后复检可用性。
 */
export async function runInstallRuffCommand(deps: RuffLintCommandDeps): Promise<string> {
  const interpreter = deps.getInterpreterPath();
  if (!interpreter) {
    await deps.showErrorMessage('未选定 Python 解释器;先运行「Select Python Interpreter」再装 ruff。');
    return '未选定解释器,未安装。';
  }
  const manual = installCommandText(interpreter);
  deps.channel.appendLine(`[ruff] ${manual} 安装中…`);
  deps.channel.show(true);
  const install = await deps.runPipInstall(interpreter);
  deps.channel.appendLine(install.output.trim() || '[ruff] pip 无输出。');
  if (!install.ok) {
    await deps.showErrorMessage(`ruff 安装失败,请手动执行(输出通道有 pip 完整日志):${manual}`);
    deps.channel.appendLine(`[ruff] 安装失败。请手动执行:\n  ${manual}`);
    deps.channel.show(true);
    return `ruff 安装失败;手动命令已亮出:${manual}`;
  }
  const probe = await runRuffLint([], ruffExePathForInterpreter(interpreter));
  const version =
    probe.status === 'ok' && probe.result.available ? (probe.result.version ?? '已安装') : '未检出';
  return `ruff 安装完成(${version});可运行「Ruff Lint Python Files」。`;
}
