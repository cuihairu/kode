/**
 * 端口模式前置探测(IDE-PDBG-002):connect 附加前先探 debugpy 端口的
 * TCP 可达性。端口通 → 直接附加零多余弹窗;端口不通 → 分开说两种原因:
 * ① 端口未开(引擎进程还没起 debugpy 监听——autoDebugpy 注入 /
 * waitAtStartup 引导 / 代码内 debugpy.listen 都是起监听的路径);② 本机
 * 解释器链没装 debugpy(既有 debugpyPreflight 面)→ 给一键安装动作与
 * 手装指引。装好包本身不会把端口开起来——引擎侧起监听的事如实说明,
 * 装完/端口开了才附加,绝不假成功。
 */

import { spawn } from 'child_process';
import * as net from 'net';
import type { DebugpyPreflightStatus } from './debugpyPreflight';
import { killProcessTree } from './processManager';

/** 端口探测超时:与 telnet 探测同口径(1.5s),不通就分类,不干等 */
export const DEBUGPY_PORT_PROBE_TIMEOUT_MS = 1500;

export interface TcpProbeResult {
  open: boolean;
  /** !open 时的未开归类:refused=没人监听 / timeout=网络不通或被防火墙静默 /
   * unresolved-host=主机名解析不了 / unknown=其它(带 detail) */
  reason?: 'refused' | 'timeout' | 'unresolved-host' | 'unknown';
  detail?: string;
}

export type TcpConnectFn = (
  host: string,
  port: number,
  timeoutMs: number
) => Promise<TcpProbeResult>;

/** 真实探测:net.connect,通即开;异常按 code 归类;超时杀套接字;永不抛 */
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
        } else {
          finish({ open: false, reason: 'unknown', detail: error.code ?? String(error) });
        }
      });
      socket.connect(port, host);
    } catch (error) {
      resolve({ open: false, reason: 'unknown', detail: String(error) });
    }
  });

/** 未开原因的一行口径(弹窗/日志共用,不各说各话) */
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

/** 引擎侧起监听的三条现成路径(端口未开时的指引口径,单一真源) */
const LISTEN_GUIDANCE =
  '引擎进程需先起 debugpy 监听:kbengine.debug.autoDebugpy 启动注入 / kbengine.debug.waitAtStartup 启动等待引导 / 代码内 debugpy.listen(端口)';

export type PortClosedCause =
  | 'port-not-listening'
  | 'debugpy-missing'
  | 'debugpy-outdated'
  | 'interpreter-missing';

export interface PortClosedGuidance {
  /** 未开主因口径(端口未开与未装 debugpy 分开说) */
  cause: PortClosedCause;
  /** 弹窗一行文案 */
  message: string;
  /** 解释器在位且缺包/过老时的一键安装动作名;其余 undefined */
  installAction?: string;
}

/**
 * 端口不通时的主因判定:本机解释器链没装/过老 debugpy → 归因缺包(给
 * 安装动作);解释器缺位 → 归因解释器(给设置指引);预检在位可用 →
 * 归因端口未开(引擎侧没起监听,给起监听指引)。preflight null(探测面
 * 不可用)按端口未开说,不猜。
 */
export function buildPortClosedGuidance(
  probe: TcpProbeResult,
  preflight: DebugpyPreflightStatus | null
): PortClosedGuidance {
  const reason = portClosedReasonText(probe);
  if (preflight?.kind === 'debugpy-missing' || preflight?.kind === 'debugpy-outdated') {
    const verb = preflight.kind === 'debugpy-missing' ? '没有 debugpy' : `的 debugpy ${preflight.version} 过老`;
    return {
      cause: preflight.kind,
      message: `debugpy 端口未开(${reason}),且本机 Python ${preflight.interpreterPath} ${verb}`,
      installAction: '一键安装 debugpy'
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

/** 装完包端口仍未开的如实口径(下一步引导的基线事实):装包 ≠ 起监听,不附加不假成功;怎么起监听由 buildPortNextStepMessage 接着说 */
export function buildAfterInstallStillClosedMessage(host: string, port: number): string {
  return `debugpy 已装好,但 ${host}:${port} 仍未开——装包不会自己起监听`;
}

/** 手装指引:给可复制的命令行与后续两步(同步进资产树 + 引擎侧起监听) */
export function buildManualInstallGuide(interpreterPath: string, port: number): string {
  return `手动安装:${interpreterPath} -m pip install -U debugpy,再运行 kbengine.python.debugpySync 同步进资产树;端口 ${port} 要等引擎侧起监听才会开`;
}

/**
 * 端口模式「下一步」动作名(IDE-PDBG-002 死路修复):分诊完/装完之后
 * 弹窗上的三个控件文案,分诊、引导与测试共用这一个真源,不各说各话。
 */
export const PORT_NEXT_STEP_ACTIONS = {
  /** 一键经 telnet 发 debugpy.listen 起监听,成功后立刻重探并附加 */
  startListen: '起监听并附加',
  /** 再探一次端口:已从别处起监听(等待引导/自埋代码)时直接接上 */
  retry: '重试附加',
  /** 三条起监听路径 + 资产树同步 + 可复制的单进程命令 */
  listenGuide: '起监听指引'
} as const;

/** 下一步引导的三个动作(顺序即弹窗按钮顺序) */
export const PORT_NEXT_STEP_ACTION_LIST: readonly string[] = [
  PORT_NEXT_STEP_ACTIONS.startListen,
  PORT_NEXT_STEP_ACTIONS.retry,
  PORT_NEXT_STEP_ACTIONS.listenGuide
];

/**
 * 端口仍未开时的下一步引导文案:基线事实(端口未开/装完仍未开)原样在前,
 * 后面接「怎么走到监听」与 launch.json 落点。按钮名不重复写进文案
 * (PORT_NEXT_STEP_ACTIONS 是按钮的单一真源)。
 */
export function buildPortNextStepMessage(baseMessage: string, launchNote: string): string {
  return `${baseMessage};下一步:${LISTEN_GUIDANCE};${launchNote}`;
}

/**
 * 起监听手动指引:引擎内 import 的是资产树包(先 debugpySync),三条现成
 * 监听路径,外加单进程可复制命令——一键面失败/没接线时的兜底口径。
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
  /** 成功给 stdout 末行(版本落点);失败给原因(stderr/stdout 尾部),如实报错不假成功 */
  detail: string;
}

export type DebugpyInstallRunner = (interpreterPath: string) => Promise<DebugpyInstallResult>;

/** pip 安装截止:挂起的 pip 不永久等待,超时组杀不留构建孙进程孤儿。 */
let INSTALL_TIMEOUT_MS = 120_000;

/** 测试注入口:覆写 defaultDebugpyInstallRunner 的截止毫秒数(生产口径 120s)。 */
export function setDebugpyInstallTimeoutMsForTests(ms: number | null): void {
  INSTALL_TIMEOUT_MS = ms ?? 120_000;
}

/** 真实安装:`<解释器> -m pip install -U debugpy`;起不来/超时/非零退出都算失败,永不抛 */
export const defaultDebugpyInstallRunner: DebugpyInstallRunner = interpreterPath =>
  new Promise(resolve => {
    try {
      const child = spawn(interpreterPath, ['-m', 'pip', 'install', '-U', 'debugpy'], {
        windowsHide: true,
        // POSIX 下设进程组长:超时组杀(负 pid 信号)不留 pip 衍生的构建孙进程
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
          finish({ ok: true, detail: tail(output) || 'pip install -U debugpy 完成' });
        } else {
          finish({ ok: false, detail: `pip 退出码 ${exitCode}: ${tail(output) || '无输出'}` });
        }
      });
    } catch (error) {
      resolve({ ok: false, detail: String(error) });
    }
  });
