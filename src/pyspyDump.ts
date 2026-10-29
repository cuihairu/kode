/**
 * py-spy 性能分析(IDE-PDBG-003):serverControl 树 debug 图标后的
 * $(pulse) 入口,对目标组件进程跑 `py-spy dump` 把 Python 调用栈写进
 * 「KBEngine py-spy」输出通道;进程选择复用既有组件选择器口径。
 * 本机未装 py-spy 时按所选解释器 pip 一键安装——装失败如实弹原因,
 * 绝不重试轰炸;装好/已在位才跑 dump。
 *
 * 权限口径(文档同步):py-spy 经 ptrace 读目标进程栈。Linux 默认
 * kernel.yama.ptrace_scope=1 只允许父子进程互探,组件进程不是 py-spy
 * 的子进程——需要 ptrace_scope=0(sysctl)或 sudo/属主一致+cap;容器里
 * 要 --cap-add=SYS_PTRACE。权限不足时 py-spy 自身报错,dump 失败通道
 * 把 ptrace 指引拼在原因后面,不吞不猜。
 */

import { spawn } from 'child_process';
import type { InterpreterResolution } from './profileInterpreter';

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** spawn 注入面:真实现见 defaultSpawnRunner,测试注入替身不真跑 py-spy */
export type SpawnRunner = (
  command: string,
  args: string[],
  timeoutMs: number
) => Promise<CommandRunResult>;

/** 真实 spawn:stdout/stderr 分收,超时杀进程按 -1 退出;永不抛 */
export const defaultSpawnRunner: SpawnRunner = (command, args, timeoutMs) =>
  new Promise(resolve => {
    try {
      const child = spawn(command, args, { windowsHide: true });
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
        child.kill();
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
  /** `py-spy --version` 输出的版本(如 0.3.14);未装为 null */
  version: string | null;
  /** 未装原因一行(命令不存在/超时),可定位 */
  detail: string;
}

/** 探测 PATH 链上的 py-spy:`py-spy --version`(版本号常走 stderr) */
export async function checkPyspyInstalled(runner: SpawnRunner): Promise<PyspyPresence> {
  const run = await runner('py-spy', ['--version'], 5000);
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
  /** 成功给输出尾;失败给原因(退出码+输出尾),如实报错不假成功 */
  detail: string;
}

const INSTALL_TIMEOUT_MS = 120_000;

/** 一键安装:`<解释器> -m pip install -U py-spy`;起不来/超时/非零退出都算失败 */
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

/** ptrace 权限口径(单一真源:dump 失败通道与文档同一段话) */
export const PYSPY_PTRACE_GUIDANCE =
  'py-spy 经 ptrace 读目标进程栈:Linux 默认 ptrace_scope=1 只允许父子互探,需 sysctl kernel.yama.ptrace_scope=0 或 sudo 运行;容器内需 --cap-add=SYS_PTRACE;Windows 需管理员或相同用户会话';

export interface PyspyDumpResult {
  ok: boolean;
  /** 调用栈本体(成功)或失败原因+指引(失败),原样进输出通道 */
  output: string;
}

/** 弹窗注入面(ensurePyspyReady 用;扩展侧接 vscode.window,测试记文案)。
 * 返回类型放宽到 unknown:vscode 弹窗面是 Thenable 不是 Promise,取值经
 * await 规整,只有 warn 的选择字符串被消费。 */
export interface PyspyUi {
  warn(message: string, ...actions: string[]): unknown;
  info(message: string): unknown;
  error(message: string): unknown;
}

/**
 * py-spy 就位编排:已在位 → 直接放行零弹窗;未装 → 弹一键安装(取消即止),
 * 按所选解释器(PRG-004 同链)pip 安装;装失败如实弹原因不重试轰炸;解释器
 * 缺位给设置指引。放行=true 才继续 dump。
 */
export async function ensurePyspyReady(
  runner: SpawnRunner,
  ui: PyspyUi,
  resolveInterpreter: () => InterpreterResolution
): Promise<boolean> {
  const presence = await checkPyspyInstalled(runner);
  if (presence.installed) {
    return true; // 已装:零多余弹窗
  }
  const pick = await ui.warn(
    `本机未安装 py-spy(${presence.detail}),按所选 Python 解释器安装?`,
    '一键安装 py-spy'
  );
  if (pick !== '一键安装 py-spy') {
    return false;
  }
  const resolution = resolveInterpreter();
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

/** 权限类失败特征(py-spy 报错文案):命中即拼 ptrace 指引 */
const PTRACE_FAILURE_MARKERS = [
  'Operation not permitted',
  'permission denied',
  'Failed to suspend',
  'insufficient permissions'
];

/**
 * `py-spy dump --pid <pid> --nonblocking`:拿目标进程的 Python 调用栈。
 * --nonblocking 不暂停目标进程(生产组件优先不卡服);失败把 ptrace 指引
 * 拼在原因后面,权限类报错一眼能定位。
 */
export async function runPyspyDump(runner: SpawnRunner, pid: number): Promise<PyspyDumpResult> {
  const run = await runner('py-spy', ['dump', '--pid', String(pid), '--nonblocking'], 30_000);
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
