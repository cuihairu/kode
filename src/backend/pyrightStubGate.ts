/**
 * IDE-STUB-002 (user-ordered batch): wire the generated tier to pyright --
 * after stub generation, invoke the pyright CLI (prefer `pyright`, fall back
 * to `npx --no-install pyright`; the CLI preference of the todo's original
 * "pyright --createstub/npx pyright" lands here: probing walks the candidate
 * order looking for a usable CLI, no network download), and validate the type
 * face of the generated stubs with pyright diagnostics (`--outputjson`). When
 * probing is unavailable, degrade to pure generation and only notice it in the
 * output panel, without an error.
 *
 * This module has zero vscode dependencies: the runner is injected by the
 * caller (wiring layer child_process.execFile, tests inject a mock), and the
 * tier gate lives on the call side (serves the generated tier only; the
 * real-source tier's copy artifacts are not validated by this module).
 */
import { execFile } from 'child_process';

export interface PyrightRunResult {
  file: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type PyrightCommandRunner = (
  file: string,
  args: string[]
) => Promise<PyrightRunResult>;

/**
 * CLI probe candidate order: directly installed pyright first, npx (no network
 * install) as fallback. On Windows the npm global install is a .cmd shim and
 * execFile without a shell cannot launch the bare name, so candidates take the
 * shim name per platform.
 */
export const PYRIGHT_CLI_CANDIDATES: readonly string[][] =
  process.platform === 'win32'
    ? [['pyright.cmd'], ['npx.cmd', '--no-install', 'pyright']]
    : [['pyright'], ['npx', '--no-install', 'pyright']];

export interface PyrightCommand {
  file: string;
  /** Argument prefix always carried beyond the version probe (['pyright'] in the npx form) */
  args: string[];
}

/**
 * Run `--version` per candidate; the first to exit 0 wins; return null when
 * all fail (degrade to pure generation).
 */
export async function detectPyrightCommand(
  run: PyrightCommandRunner,
  candidates: readonly string[][] = PYRIGHT_CLI_CANDIDATES
): Promise<PyrightCommand | null> {
  for (const candidate of candidates) {
    const [file, ...prefix] = candidate;
    try {
      const result = await run(file, [...prefix, '--version']);
      if (result.exitCode === 0) {
        return { file, args: prefix };
      }
    } catch {
      // The process failing to start (spawn ENOENT etc.) counts as a candidate failure; try the next one
    }
  }
  return null;
}

export interface PyrightDiagnostic {
  file: string;
  severity: string;
  message: string;
  line: number;
}

export interface PyrightDiagnosticsReport {
  ran: true;
  errorCount: number;
  warningCount: number;
  informationCount: number;
  diagnostics: PyrightDiagnostic[];
}

export interface PyrightSkippedReport {
  ran: false;
  /** Why the run did not happen (probe failure / process failure with no JSON), for honest reporting */
  reason: string;
}

export type PyrightReport = PyrightDiagnosticsReport | PyrightSkippedReport;

interface PyrightOutputJson {
  summary?: {
    errorCount?: number;
    warningCount?: number;
    informationCount?: number;
  };
  generalDiagnostics?: Array<{
    file?: string;
    severity?: string;
    message?: string;
    range?: { start?: { line?: number } };
  }>;
}

/** Output panel one-line summary (diagnostic counts + per-diagnostic lines); the caller is responsible for writing to the channel */
export function summarizePyrightReport(report: PyrightReport): string[] {
  if (!report.ran) {
    return [`[pyright] 未接入: ${report.reason}`];
  }
  const lines = [
    `[pyright] 诊断汇总: error ${report.errorCount} / warning ${report.warningCount} / information ${report.informationCount}`
  ];
  for (const diagnostic of report.diagnostics) {
    lines.push(
      `[pyright] ${diagnostic.file}:${diagnostic.line + 1} ${diagnostic.severity}: ${diagnostic.message}`
    );
  }
  return lines;
}

/** Run `--outputjson <files...>` and parse it; ran=false when the process fails and there is no JSON */
export async function runPyrightDiagnostics(
  run: PyrightCommandRunner,
  command: PyrightCommand,
  files: readonly string[]
): Promise<PyrightReport> {
  const args = [...command.args, '--outputjson', ...files];
  let result: PyrightRunResult;
  try {
    result = await run(command.file, args);
  } catch (error) {
    return {
      ran: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const parsed = parsePyrightOutputJson(result.stdout);
  if (!parsed) {
    return {
      ran: false,
      reason: `pyright 进程退出码 ${result.exitCode}${result.stderr ? `: ${result.stderr.trim()}` : ',且无 --outputjson 输出'}`
    };
  }
  const diagnostics: PyrightDiagnostic[] = (parsed.generalDiagnostics ?? []).map(entry => ({
    file: entry.file ?? '',
    severity: entry.severity ?? 'error',
    message: entry.message ?? '',
    line: entry.range?.start?.line ?? 0
  }));
  return {
    ran: true,
    errorCount: parsed.summary?.errorCount ?? 0,
    warningCount: parsed.summary?.warningCount ?? 0,
    informationCount: parsed.summary?.informationCount ?? 0,
    diagnostics
  };
}

function parsePyrightOutputJson(stdout: string): PyrightOutputJson | null {
  try {
    const parsed = JSON.parse(stdout) as PyrightOutputJson;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * In the win32 shell form, cmd.exe expands `%VAR%` environment variables and
 * double quotes do not stop it -- arguments containing % (such as workspace
 * paths in %TEMP% form) get rewritten. Such arguments cannot be handed to a
 * shell safely, so the caller treats them as unsafe (degrade honestly instead
 * of feeding pyright a rewritten path).
 */
export function argUnsafeForCmdShell(arg: string): boolean {
  return /%/.test(arg);
}

/** Wiring layer default runner: child_process.execFile (both exit codes and
 * exceptions come back as results, nothing is thrown).
 * On Windows a .cmd shim cannot start without a shell (Node refuses a
 * shell-less batch file for a CVE), so win32 goes through a shell and quotes
 * arguments containing spaces/special characters by hand (posix passes
 * arguments as-is without a shell); arguments containing % return as failure on
 * win32 outright (see argUnsafeForCmdShell). */
export const childProcessPyrightRunner: PyrightCommandRunner = (file, args) =>
  new Promise(resolve => {
    const useShell = process.platform === 'win32';
    if (useShell && args.some(argUnsafeForCmdShell)) {
      resolve({
        file,
        args,
        exitCode: 1,
        stdout: '',
        stderr: 'win32 shell 实参含 %(cmd 会做环境变量展开),拒绝传参,跳过本次校验'
      });
      return;
    }
    const argv = useShell
      ? args.map(arg => (/[\s"^&|<>]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg))
      : args;
    execFile(file, argv, {
      shell: useShell,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => {
      const exitCode = error && typeof (error as { code?: unknown }).code === 'number'
        ? (error as { code: number }).code
        : error
          ? 1
          : 0;
      resolve({ file, args, exitCode, stdout: String(stdout), stderr: String(stderr) });
    });
  });
