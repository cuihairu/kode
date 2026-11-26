/**
 * py-spy profiling (IDE-PDBG-003): behind the debug icon in the serverControl
 * tree, the $(pulse) entry runs `py-spy dump` against the target component
 * process and writes the Python call stack into the "KBEngine py-spy" output
 * channel; process selection reuses the existing component-selector criterion.
 * When py-spy is not installed locally, it is installed with pip against the
 * selected interpreter in one click -- a failed install surfaces its reason
 * honestly and never retries in a bombardment; dump runs only once installed /
 * already in place.
 *
 * Permission criterion (kept in sync with the docs): py-spy reads the target
 * process's stack via ptrace. Linux's default kernel.yama.ptrace_scope=1 only
 * allows parent-child mutual probing, and the component process is not py-spy's
 * child -- so ptrace_scope=0 (sysctl) or sudo / matching owner + capability is
 * needed; inside a container, --cap-add=SYS_PTRACE is required. With
 * insufficient permissions py-spy itself errors out and the dump-failure
 * channel appends the ptrace guidance after the reason: nothing swallowed,
 * nothing guessed.
 */

import { killProcessTree, spawnProcess } from './processManager';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathApiFor } from './workspacePath';
import type { InterpreterResolution } from '../profileInterpreter';

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Spawn injection face: the real implementation is defaultSpawnRunner; tests inject a stand-in that never actually runs py-spy */
export type SpawnRunner = (
  command: string,
  args: string[],
  timeoutMs: number
) => Promise<CommandRunResult>;

/** Real spawn: stdout/stderr collected separately; on timeout the process is killed and reported as exit -1; never throws */
export const defaultSpawnRunner: SpawnRunner = (command, args, timeoutMs) =>
  new Promise(resolve => {
    try {
      const child = spawnProcess(command, args, {
        windowsHide: true,
        // On POSIX make the process a group leader (same criterion as
        // ProcessManager): the timeout kills by group so that grandchild
        // processes spawned by py-spy are not left behind as orphans
        detached: process.platform !== 'win32'
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (exitCode: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode });
      };
      const timer = setTimeout(() => {
        // Group kill (matching the ProcessManager.killProcessTree criterion):
        // spawned grandchildren do not linger; the single-process fallback falls
        // back to child.kill
        void killProcessTree(child.pid ?? 0, 'SIGKILL', child);
        finish(-1);
      }, timeoutMs);
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
      });
      child.stderr.on('data', chunk => {
        stderr += String(chunk);
      });
      child.on('error', error => {
        stderr += String(error);
        finish(-1);
      });
      child.on('close', exitCode => finish(exitCode));
    } catch (error) {
      resolve({ stdout: '', stderr: String(error), exitCode: -1 });
    }
  });

export interface PyspyPresence {
  installed: boolean;
  /** Version reported by `py-spy --version` (e.g. 0.3.14); null when not installed */
  version: string | null;
  /** One-line reason it is not installed (command missing / timeout), so the issue can be located */
  detail: string;
}

/**
 * Locate the py-spy executable next to the interpreter: pip installs entry
 * scripts into the script directory of the interpreter's environment (venv's
 * bin/ or Scripts/, pip --user's ~/.local/bin), and the extension host's PATH
 * usually lacks those directories -- probing PATH only would misjudge an
 * installed py-spy as missing, so the "one-click install" would complete and
 * still not be detected, popping the install dialog over and over (observed by
 * the user on 2026-10-30). Candidates in order: the interpreter's own
 * directory, then ~/.local/bin; a relative-name interpreter (e.g. 'python3' on
 * an ssh remote) and a missing interpreter both return null, and the caller
 * falls back to the bare PATH command.
 */
export function resolvePyspyCommand(
  interpreterPath: string | null | undefined,
  exists: (candidate: string) => boolean = fs.existsSync
): string | null {
  if (!interpreterPath || !path.isAbsolute(interpreterPath)) {
    return null;
  }
  const exe = process.platform === 'win32' ? 'py-spy.exe' : 'py-spy';
  // WIN-3: pick the path API by the interpreter path style -- a POSIX
  // interpreter (leading /) keeps / style joining, a win drive letter takes the
  // platform join; otherwise win32 joins /proj/.venv/bin into backslash form,
  // mismatching the probe/fixture.
  const P = pathApiFor(interpreterPath);
  const candidates = [
    P.join(P.dirname(interpreterPath), exe),
    P.join(os.homedir(), '.local', 'bin', exe)
  ];
  return candidates.find(candidate => exists(candidate)) ?? null;
}

/** Probe py-spy with `<command> --version` (the version usually arrives on stderr); the command is resolved next to the interpreter first, falling back to the bare PATH command */
export async function checkPyspyInstalled(
  runner: SpawnRunner,
  pyspyCommand?: string | null
): Promise<PyspyPresence> {
  const run = await runner(pyspyCommand ?? 'py-spy', ['--version'], 5000);
  const text = `${run.stdout} ${run.stderr}`.trim();
  const match = text.match(/py-spy\s+(\d+(?:\.\d+)*)/i);
  if (match) {
    return { installed: true, version: match[1], detail: `py-spy ${match[1]} 已安装` };
  }
  return {
    installed: false,
    version: null,
    detail: run.exitCode === -1 && /ENOENT/i.test(text)
      ? 'PATH 上没有 py-spy'
      : `py-spy 探测失败(${text.length > 0 ? text.split(/\r?\n/)[0] : '无输出'})`
  };
}

export interface PyspyInstallResult {
  ok: boolean;
  /** On success the output tail; on failure the reason (exit code + output tail), reporting honestly instead of faking success */
  detail: string;
}

const INSTALL_TIMEOUT_MS = 120_000;

/** One-click install: `<interpreter> -m pip install -U py-spy`; a failure to start / timeout / non-zero exit all count as failure */
export async function installPyspy(
  runner: SpawnRunner,
  interpreterPath: string
): Promise<PyspyInstallResult> {
  const run = await runner(interpreterPath, ['-m', 'pip', 'install', '-U', 'py-spy'], INSTALL_TIMEOUT_MS);
  const tail = (text: string): string =>
    text.trim().split(/\r?\n/).filter(line => line.length > 0).slice(-3).join(' | ');
  const output = `${run.stdout}\n${run.stderr}`.trim();
  if (run.exitCode === 0) {
    return { ok: true, detail: tail(output) || 'pip install -U py-spy 完成' };
  }
  return {
    ok: false,
    detail: `pip 退出码 ${run.exitCode}: ${tail(output) || '无输出'}`
  };
}

/** ptrace permission criterion (single source of truth: the dump-failure channel and the docs share this same paragraph) */
export const PYSPY_PTRACE_GUIDANCE =
  'py-spy 经 ptrace 读目标进程栈:Linux 默认 ptrace_scope=1 只允许父子互探,需 sysctl kernel.yama.ptrace_scope=0 或 sudo 运行;容器内需 --cap-add=SYS_PTRACE;Windows 需管理员或相同用户会话';

export interface PyspyDumpResult {
  ok: boolean;
  /** The call stack itself (success) or the failure reason + guidance (failure), passed verbatim into the output channel */
  output: string;
}

/** Dialog injection face (used by ensurePyspyReady; the extension side wires vscode.window, tests record the texts).
 * The return type is widened to unknown: the vscode dialog face is a Thenable
 * rather than a Promise, values are normalized through await, and only warn's
 * picked action string is consumed. */
export interface PyspyUi {
  warn(message: string, ...actions: string[]): unknown;
  info(message: string): unknown;
  error(message: string): unknown;
}

/**
 * py-spy readiness orchestration: already in place -> let it through with zero
 * dialogs; not installed -> pop the one-click install (cancel stops there) and
 * pip install against the selected interpreter (same chain as PRG-004); a
 * failed install surfaces its reason honestly with no retry bombardment; a
 * missing interpreter gets setup guidance. Only true means dump may continue.
 */
export async function ensurePyspyReady(
  runner: SpawnRunner,
  ui: PyspyUi,
  resolveInterpreter: () => InterpreterResolution
): Promise<boolean> {
  // Probe before any dialog, locating the command via the selected interpreter
  // (already installed next to the interpreter = zero dialogs); a remote ssh
  // relative-name interpreter cannot be located, so this falls back to the bare
  // PATH command, consistent with the remote criterion
  const resolution = resolveInterpreter();
  const pyspyCommand = resolvePyspyCommand(resolution.interpreterPath);
  const presence = await checkPyspyInstalled(runner, pyspyCommand);
  if (presence.installed) {
    return true; // already installed: zero extra dialogs
  }
  const pick = await ui.warn(
    `本机未安装 py-spy(${presence.detail}),按所选 Python 解释器安装?`,
    '一键安装 py-spy'
  );
  if (pick !== '一键安装 py-spy') {
    return false;
  }
  if (!resolution.interpreterPath) {
    ui.error('未找到所选 Python 解释器,先在设置 kbengine.python.interpreterPath 指定后再装 py-spy');
    return false;
  }
  const install = await installPyspy(runner, resolution.interpreterPath);
  if (!install.ok) {
    ui.error(`py-spy 安装失败: ${install.detail}`);
    return false;
  }
  ui.info(`py-spy 安装完成: ${install.detail}`);
  return true;
}

/** Permission-class failure markers (py-spy error text): a match appends the ptrace guidance */
const PTRACE_FAILURE_MARKERS = [
  'Operation not permitted',
  'permission denied',
  'Failed to suspend',
  'insufficient permissions'
];

/**
 * `py-spy dump --pid <pid> --nonblocking`: fetch the target process's Python
 * call stack. --nonblocking does not pause the target process (production
 * components get priority over stalling the server); on failure the ptrace
 * guidance is appended after the reason so permission-class errors can be
 * located at a glance.
 */
export async function runPyspyDump(
  runner: SpawnRunner,
  pid: number,
  pyspyCommand?: string | null
): Promise<PyspyDumpResult> {
  const run = await runner(pyspyCommand ?? 'py-spy', ['dump', '--pid', String(pid), '--nonblocking'], 30_000);
  if (run.exitCode === 0 && run.stdout.trim().length > 0) {
    return { ok: true, output: run.stdout.trim() };
  }
  const cause = run.stderr.trim() || run.stdout.trim() || `py-spy 退出码 ${run.exitCode}`;
  const needsPtraceHint = PTRACE_FAILURE_MARKERS.some(marker =>
    cause.toLowerCase().includes(marker.toLowerCase())
  );
  return {
    ok: false,
    output: needsPtraceHint ? `${cause}\n${PYSPY_PTRACE_GUIDANCE}` : cause
  };
}

// ---- IDE-PYSPY-001: py-spy record flamegraph face (record --format flamegraph)----
//
// Division of labor with the dump face: dump fetches the current call stack as
// text (a seconds-level snapshot), record samples at a sampling rate over a
// duration window and writes a flamegraph to disk. record's output goes to the
// --output file rather than stdout; the success criterion = exit code 0 and a
// file that exists and is non-empty (fileExistsNonEmpty is injected for test
// stand-ins).

/** Fool-proof record defaults: 10s window, 100 samples/s, flamegraph, non-blocking */
export const PYSPY_RECORD_DEFAULTS = {
  durationSec: 10,
  rateHz: 100,
  format: 'flamegraph',
  nonblocking: true
} as const;

export type PyspyRecordFormat = 'flamegraph' | 'raw' | 'speedscope' | 'chrometrace';

export interface PyspyRecordOptions {
  durationSec?: number;
  rateHz?: number;
  format?: PyspyRecordFormat;
  nonblocking?: boolean;
  native?: boolean;
  threads?: boolean;
}

/** Pure argument assembly (mirrors the py-spy record --help flags of v0.4.3; faithful, nothing invented) */
export function buildPyspyRecordArgs(
  pid: number,
  outFile: string,
  options: PyspyRecordOptions = {}
): string[] {
  const opts = { ...PYSPY_RECORD_DEFAULTS, ...options };
  const args = [
    'record',
    '--pid',
    String(pid),
    '--format',
    opts.format,
    '--output',
    outFile,
    '--duration',
    String(opts.durationSec),
    '--rate',
    String(opts.rateHz)
  ];
  if (opts.nonblocking) {
    args.push('--nonblocking');
  }
  if (opts.native) {
    args.push('--native');
  }
  if (opts.threads) {
    args.push('--threads');
  }
  return args;
}

/** Injection face for "file exists and is non-empty" (test stand-ins never really write to disk) */
export interface PyspyFileDeps {
  fileExistsNonEmpty: (filePath: string) => boolean;
}

const realFileDeps: PyspyFileDeps = {
  fileExistsNonEmpty: filePath => {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
    } catch {
      return false;
    }
  }
};

/** record timeout = sampling window + 15s grace (record only wraps up once the window is full; the grace guards against slow disks) */
export const PYSPY_RECORD_GRACE_MS = 15_000;

/**
 * `py-spy record --pid <pid> --format <f> --output <file> --duration <d>
 * --rate <r> [--nonblocking] [--native] [--threads]`: sample inside the window
 * and write the flamegraph to disk. Success = exit code 0 and an output file
 * that exists and is non-empty (the output lives in the file, stdout carries
 * nothing); on failure the ptrace permission guidance is appended after the
 * reason (the same paragraph as dump).
 */
export async function runPyspyRecord(
  runner: SpawnRunner,
  pid: number,
  outFile: string,
  options: PyspyRecordOptions = {},
  pyspyCommand?: string | null,
  deps: PyspyFileDeps = realFileDeps
): Promise<PyspyDumpResult> {
  const opts = { ...PYSPY_RECORD_DEFAULTS, ...options };
  const timeoutMs = Math.max(0, opts.durationSec) * 1000 + PYSPY_RECORD_GRACE_MS;
  const run = await runner(
    pyspyCommand ?? 'py-spy',
    buildPyspyRecordArgs(pid, outFile, opts),
    timeoutMs
  );
  if (run.exitCode === 0 && deps.fileExistsNonEmpty(outFile)) {
    return { ok: true, output: outFile };
  }
  const cause = run.stderr.trim() || run.stdout.trim() || `py-spy 退出码 ${run.exitCode}`;
  const needsPtraceHint = PTRACE_FAILURE_MARKERS.some(marker =>
    cause.toLowerCase().includes(marker.toLowerCase())
  );
  return {
    ok: false,
    output: needsPtraceHint ? `${cause}\n${PYSPY_PTRACE_GUIDANCE}` : cause
  };
}

export interface PyspyScheduleOptions extends PyspyRecordOptions {
  /** Number of captures X (one capture every N seconds, X in total) */
  count: number;
/** Gap seconds N between two consecutive captures */
  intervalSec: number;
  /** Output directory (each capture drops one flame-<ts>-<i>.svg) */
  outDir: string;
}

export interface PyspyScheduleRun {
  index: number;
  file: string;
  ok: boolean;
  output: string;
}

export interface PyspyScheduleDeps extends PyspyFileDeps {
  /** Interval-wait injection face (tests never really sleep) */
  sleep: (ms: number) => Promise<void>;
  /** Current-timestamp injection face (tests pin the file names) */
  now: () => number;
}

const realScheduleDeps: PyspyScheduleDeps = {
  ...realFileDeps,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now()
};

/**
 * Periodic capture orchestration: one capture every N seconds, X in total,
 * each landing an independent SVG; the first failure stops the run (once the
 * attached process stops yielding samples, continuing is pointless) while
 * already-successful files are kept. Returns the per-capture results; the
 * caller aggregates and presents them based on ok.
 */
export async function runPyspySchedule(
  runner: SpawnRunner,
  pid: number,
  options: PyspyScheduleOptions,
  pyspyCommand?: string | null,
  deps: PyspyScheduleDeps = realScheduleDeps
): Promise<PyspyScheduleRun[]> {
  const runs: PyspyScheduleRun[] = [];
  const stamp = deps.now();
  for (let index = 0; index < options.count; index++) {
    if (index > 0) {
      await deps.sleep(Math.max(0, options.intervalSec) * 1000);
    }
    const file = path.join(options.outDir, `flame-${stamp}-${index}.svg`);
    const result = await runPyspyRecord(runner, pid, file, options, pyspyCommand, deps);
    runs.push({ index, file, ok: result.ok, output: result.output });
    if (!result.ok) {
      break;
    }
  }
  return runs;
}
