/**
 * Port-mode preflight probe (IDE-PDBG-002): before a connect attach, probe
 * the debugpy port's TCP reachability. Port reachable -> attach directly
 * with zero extra popups; port unreachable -> say the two causes apart:
 * (1) port not open (the engine process has not started a debugpy listener
 * yet -- autoDebugpy injection, waitAtStartup guidance, and debugpy.listen
 * in code are all paths that start a listener); (2) debugpy is missing from
 * the local interpreter chain (the existing debugpyPreflight surface) ->
 * offer a one-click install action plus a manual install guide. Installing
 * the package by itself does not open the port -- the listener must be
 * started on the engine side, stated as it is; attach only once the install
 * is done and the port is open, never a false success.
 */

import * as net from 'net';
import type { DebugpyPreflightStatus } from './debugpyPreflight';
import { killProcessTree, spawnProcess } from './processManager';

/** Port probe timeout: same contract as the telnet probe (1.5s); classify on failure rather than waiting it out */
export const DEBUGPY_PORT_PROBE_TIMEOUT_MS = 1500;

export interface TcpProbeResult {
  open: boolean;
  /** Closed classification when !open: refused=nobody listening / timeout=network unreachable or silently dropped by a firewall /
   * unresolved-host=hostname cannot be resolved / unknown=other (with detail) */
  reason?: 'refused' | 'timeout' | 'unresolved-host' | 'unknown';
  detail?: string;
}

export type TcpConnectFn = (
  host: string,
  port: number,
  timeoutMs: number
) => Promise<TcpProbeResult>;

/** Real probe: net.connect, reachable means open; errors classified by code; socket killed on timeout; never throws */
export const defaultTcpConnect: TcpConnectFn = (host, port, timeoutMs) =>
  new Promise(resolve => {
    try {
      const socket = new net.Socket();
      let settled = false;
      const finish = (result: TcpProbeResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish({ open: false, reason: 'timeout', detail: `connect timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      socket.once('connect', () => finish({ open: true }));
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED') {
          finish({ open: false, reason: 'refused', detail: 'ECONNREFUSED' });
        } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
          finish({ open: false, reason: 'unresolved-host', detail: error.code });
        } else if (
          // WIN: unreachable/dropped on win32 usually reports
          // ETIMEDOUT/EHOSTUNREACH/ENETUNREACH immediately instead of waiting
          // for the deadline -- same contract as "timeout = network
          // unreachable or dropped by a firewall"; detail keeps the code and
          // notes the probe deadline in ms (callers and assertions both
          // consume the deadline contract).
          error.code === 'ETIMEDOUT' ||
          error.code === 'EHOSTUNREACH' ||
          error.code === 'ENETUNREACH' ||
          error.code === 'EACCES'
        ) {
          finish({ open: false, reason: 'timeout', detail: `${error.code} (deadline ${timeoutMs}ms)` });
        } else {
          finish({ open: false, reason: 'unknown', detail: error.code ?? String(error) });
        }
      });
      socket.connect(port, host);
    } catch (error) {
      resolve({ open: false, reason: 'unknown', detail: String(error) });
    }
  });

/** One-line phrasing for the closed reason (shared by popup and log so they never disagree) */
export function portClosedReasonText(probe: TcpProbeResult): string {
  switch (probe.reason) {
    case 'refused':
      return '连接被拒:该端口没有进程在监听';
    case 'timeout':
      return '连接超时:网络不通或被防火墙静默丢弃';
    case 'unresolved-host':
      return `主机名解析不了(${probe.detail ?? 'ENOTFOUND'})`;
    default:
      return `连接失败(${probe.detail ?? 'unknown'})`;
  }
}

/** The three ready-made paths for starting the listener on the engine side (guidance contract when the port is closed; single source of truth) */
const LISTEN_GUIDANCE =
  '引擎进程需先起 debugpy 监听:kbengine.debug.autoDebugpy 启动注入 / kbengine.debug.waitAtStartup 启动等待引导 / 代码内 debugpy.listen(端口)';

export type PortClosedCause =
  | 'port-not-listening'
  | 'debugpy-missing'
  | 'debugpy-incompatible'
  | 'target-unknown'
  | 'interpreter-missing';

export interface PortClosedGuidance {
  /** Primary-cause contract when closed (port-not-open and debugpy-missing stated separately) */
  cause: PortClosedCause;
  /** One-line popup text */
  message: string;
  /** One-click install action name when the interpreter is present but the package is missing/too old; otherwise undefined */
  installAction?: string;
}

/**
 * Primary-cause decision when the port is unreachable: debugpy missing from
 * the local interpreter chain / version incompatible with the engine target
 * -> attribute to debugpy (offer one-click install only when there is a
 * policy -- install args come from the preflight's exact spec, no blind -U
 * to latest anymore; no install action when the target is unknown);
 * target unknown -> attribute to target-unknown (set
 * kbengine.debug.pythonTarget first); interpreter missing -> attribute to
 * the interpreter (give settings guidance); preflight present and usable
 * -> attribute to port-not-listening (no listener on the engine side, give
 * listener-start guidance). preflight null (probe surface unavailable) is
 * reported as port-not-listening, no guessing.
 */
export function buildPortClosedGuidance(
  probe: TcpProbeResult,
  preflight: DebugpyPreflightStatus | null
): PortClosedGuidance {
  const reason = portClosedReasonText(probe);
  if (preflight?.kind === 'debugpy-missing' || preflight?.kind === 'debugpy-incompatible') {
    const verb = preflight.kind === 'debugpy-missing'
      ? '没有 debugpy'
      : `的 debugpy ${preflight.version} 与引擎目标 Python ${preflight.target.version ?? '?'} 不兼容`;
    return {
      cause: preflight.kind,
      message: `debugpy 端口未开(${reason}),且本机 Python ${preflight.interpreterPath} ${verb}`,
      // No one-click install when the target is unknown / has no supported line (no blind version install); exact pin only with a policy
      installAction: preflight.installSpec === null ? undefined : '一键安装 debugpy'
    };
  }
  if (preflight?.kind === 'target-unknown') {
    return {
      cause: 'target-unknown',
      message: `debugpy 端口未开(${reason});本机 debugpy ${preflight.version ?? ''}已装,` +
        `但引擎目标 Python 版本未知(${preflight.target.detail}),兼容性无法核对——` +
        '先在设置 kbengine.debug.pythonTarget 指定;' + LISTEN_GUIDANCE
    };
  }
  if (preflight?.kind === 'interpreter-missing') {
    return {
      cause: 'interpreter-missing',
      message: `debugpy 端口未开(${reason}),且未找到所选 Python 解释器;先在设置 kbengine.python.interpreterPath 指定并安装 debugpy`
    };
  }
  return {
    cause: 'port-not-listening',
    message: `debugpy 端口未开(${reason});本机 debugpy 已就绪,${LISTEN_GUIDANCE}`
  };
}

/** Honest contract for the port still being closed after install (baseline fact for next-step guidance): installing the package is not the same as starting a listener -- do not attach and do not report false success; how to start the listener is spelled out by buildPortNextStepMessage */
export function buildAfterInstallStillClosedMessage(host: string, port: number): string {
  return `debugpy 已装好,但 ${host}:${port} 仍未开——装包不会自己起监听`;
}

/** Manual install guide: a copyable exact install command (from the preflight installSpec, no longer a hard-coded -U)
 * plus the two follow-up steps (sync into the asset tree + start the listener on the engine side); installCommand null = target
 * unknown, so the guide says to set the target first, no blind install */
export function buildManualInstallGuide(
  interpreterPath: string,
  installCommand: string | null,
  port: number
): string {
  const install = installCommand === null
    ? `先在设置 kbengine.debug.pythonTarget 指定引擎目标 Python 版本(目标未知不盲装),再给 ${interpreterPath} 装对应兼容版 debugpy`
    : `手动安装:${installCommand}`;
  return `${install},再运行 kbengine.python.debugpySync 同步进资产树;端口 ${port} 要等引擎侧起监听才会开`;
}

/**
 * Port-mode "next step" action names (IDE-PDBG-002 dead-end fix): the three
 * control labels on the popup after triage/install; triage, guidance and
 * tests all share this single source of truth so they never disagree.
 */
export const PORT_NEXT_STEP_ACTIONS = {
  /** One-click: send debugpy.listen over telnet to start the listener; re-probe and attach immediately on success */
  startListen: '起监听并附加',
  /** Probe the port again: attach directly when a listener has been started elsewhere (wait guidance / embedded code) */
  retry: '重试附加',
  /** The three listener paths + asset-tree sync + a copyable single-process command */
  listenGuide: '起监听指引'
} as const;

/** The three next-step guidance actions (order matches the popup button order) */
export const PORT_NEXT_STEP_ACTION_LIST: readonly string[] = [
  PORT_NEXT_STEP_ACTIONS.startListen,
  PORT_NEXT_STEP_ACTIONS.retry,
  PORT_NEXT_STEP_ACTIONS.listenGuide
];

/**
 * Next-step guidance text while the port is still closed: the baseline fact
 * (port closed / still closed after install) verbatim up front, followed by
 * "how to reach a listener" and the launch.json landing point. Button names
 * are not repeated in the text (PORT_NEXT_STEP_ACTIONS is the single source
 * of truth for buttons).
 */
export function buildPortNextStepMessage(baseMessage: string, launchNote: string): string {
  return `${baseMessage};下一步:${LISTEN_GUIDANCE};${launchNote}`;
}

/**
 * Manual listener-start guide: what the engine imports is the asset-tree
 * package (run debugpySync first), the three ready-made listener paths, plus
 * a copyable single-process command -- the fallback contract when the
 * one-click surface fails or is not wired up.
 */
export function buildListenManualGuide(port: number): string {
  return (
    `${LISTEN_GUIDANCE};引擎进程要先跑 kbengine.python.debugpySync 把 debugpy 同步进 ` +
    `<assets>/scripts/common/debugpy(import 才能解析);单独进程可复制:` +
    `python -m debugpy --listen 127.0.0.1:${port} --wait-for-client <入口脚本>`
  );
}

export interface DebugpyInstallResult {
  ok: boolean;
  /** On success the last stdout line (where the version landed); on failure the cause (stderr/stdout tail) -- report the error as it is, never a false success */
  detail: string;
}

export type DebugpyInstallRunner = (
  interpreterPath: string,
  /** pip subcommand + args (from the preflight installSpec, e.g. ['install','debugpy==1.7.0'];
   * no longer a uniform -U blind install of latest -- DBG-COMPAT-02) */
  pipArgs: string[]
) => Promise<DebugpyInstallResult>;

/** pip install deadline: a hung pip is never waited on forever; on timeout kill the whole process group so no build grandchild is orphaned. */
let INSTALL_TIMEOUT_MS = 120_000;

/** Test injection point: override the deadline in ms for defaultDebugpyInstallRunner (production contract 120s). */
export function setDebugpyInstallTimeoutMsForTests(ms: number | null): void {
  INSTALL_TIMEOUT_MS = ms ?? 120_000;
}

/** Real install: `<interpreter> -m pip <pipArgs>` (the exact version comes from the target policy); failure to
 * start / timeout / non-zero exit all count as failure, and it never throws */
export const defaultDebugpyInstallRunner: DebugpyInstallRunner = (interpreterPath, pipArgs) =>
  new Promise(resolve => {
    try {
      const child = spawnProcess(interpreterPath, ['-m', 'pip', ...pipArgs], {
        windowsHide: true,
        // POSIX 下设进程组长:超时组杀(负 pid 信号)防 pip 派生的孙进程残留
        detached: process.platform !== 'win32'
      });
      let output = '';
      let settled = false;
      const finish = (result: DebugpyInstallResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        // 与 ProcessManager.killProcessTree 同口径:组杀,不留孙进程孤儿
        void killProcessTree(child.pid ?? 0, 'SIGKILL', child);
        finish({ ok: false, detail: `pip 安装超时(>${INSTALL_TIMEOUT_MS}ms)` });
      }, INSTALL_TIMEOUT_MS);
      const tail = (text: string): string =>
        text.trim().split(/\r?\n/).filter(line => line.length > 0).slice(-3).join(' | ');
      child.stdout.on('data', chunk => {
        output += String(chunk);
      });
      child.stderr.on('data', chunk => {
        output += String(chunk);
      });
      child.on('error', error => finish({ ok: false, detail: `无法启动 ${interpreterPath}: ${error}` }));
      child.on('close', exitCode => {
        if (exitCode === 0) {
          finish({ ok: true, detail: tail(output) || `pip ${pipArgs.join(' ')} 完成` });
        } else {
          finish({ ok: false, detail: `pip 退出码 ${exitCode}: ${tail(output) || '无输出'}` });
        }
      });
    } catch (error) {
      resolve({ ok: false, detail: String(error) });
    }
  });
