/**
 * IDE-STUB-002(用户令批次):generated 档接 pyright——生成 stub 后调用
 * pyright CLI(优先 `pyright`,回退 `npx --no-install pyright`;todo 原文
 * 「pyright --createstub/npx pyright」的 CLI 优先序落点在此:探测按候选序
 * 找可用 CLI,不做网络下载),用 pyright 诊断(`--outputjson`)校验生成
 * stub 的类型面。探测不可用则降级纯生成,仅在输出面板提示,不报错。
 *
 * 本模块零 vscode 依赖:runner 由调用方注入(装配层 child_process.execFile,
 * 测试注入 mock),档位闸在调用侧(只服务 generated 档,real-source 档的
 * 复制产物不由本模块校验)。
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
 * CLI 探测候选序:直装 pyright 优先,npx(不联网安装)回退。Windows 下 npm
 * 全局装的是 .cmd shim,execFile 无 shell 起不了裸名,候选按平台取 shim 名。
 */
export const PYRIGHT_CLI_CANDIDATES: readonly string[][] =
  process.platform === 'win32'
    ? [['pyright.cmd'], ['npx.cmd', '--no-install', 'pyright']]
    : [['pyright'], ['npx', '--no-install', 'pyright']];

export interface PyrightCommand {
  file: string;
  /** 版本探测之外固定携带的实参前缀(npx 形态时为 ['pyright']) */
  args: string[];
}

/**
 * 逐候选跑 `--version`,第一个 0 退出的即中选;全败返回 null(降级纯生成)。
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
      // 进程起不来(spawn ENOENT 等)等同候选失败,试下一个
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
  /** 未跑成的原因(探测失败/进程失败且无 JSON),如实回话用 */
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

/** 输出面板单行汇总(诊断数 + 逐条),调用方负责落到通道 */
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

/** 跑 `--outputjson <files...>` 并解析;进程失败且无 JSON 时 ran=false */
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
 * win32 shell 形态下 cmd.exe 对 `%VAR%` 做环境变量展开,双引号拦不住——含 %
 * 的实参(如 %TEMP% 形态的工作区路径)会被改写。此类实参不可安全传 shell,
 * 调用方按不安全处理(如实降级,不喂 pyright 被改写的路径)。
 */
export function argUnsafeForCmdShell(arg: string): boolean {
  return /%/.test(arg);
}

/** 装配层默认 runner:child_process.execFile(退出码/异常都按结果回,不抛)。
 * Windows 下 .cmd shim 无 shell 起不了(Node 出于 CVE 拒绝无 shell 批处理),
 * 故 win32 走 shell 且对含空格/特殊字符实参手动加引号(posix 原样传参不经
 * shell);含 % 的实参在 win32 直接按失败回(见 argUnsafeForCmdShell)。 */
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
