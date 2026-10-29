/**
 * 远程连接分派(IDE-PDBG-004):debug.json 声明组件走本地还是哪台
 * ssh/config 主机(默认本地),debug 与 py-spy 按所选主机分派——远程 =
 * ssh 前缀跑命令 / -L 隧道转发端口,连不上如实报错不假成功。
 */

import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { defaultTcpConnect, type TcpConnectFn } from './debugpyPortProbe';
import { dedupeSshHosts, parseSshConfig, type SshHostEntry } from './sshConfig';

/** 'local' = 本地直跑(默认);否则经该 ssh 主机 */
export type ServerConnection = 'local' | { ssh: SshHostEntry };

/**
 * 连接分派解析,优先级:组件级 sshHost(debug.json,工程内共享)> debug.json
 * 全局 defaultSshHost > 视图选中的服务器(本会话态)> 本地。空串/'local'
 * 都归本地;别名不在 ~/.ssh/config 里也按裸主机名连(HostName 缺省 =
 * 别名,ssh 语义)。
 */
export function resolveComponentConnection(
  componentSshHost: string | undefined,
  globalSshHost: string | undefined,
  sshHosts: SshHostEntry[],
  selectedServer?: string
): ServerConnection {
  const declared = (
    componentSshHost && componentSshHost.trim().length > 0
      ? componentSshHost
      : globalSshHost && globalSshHost.trim().length > 0
        ? globalSshHost
        : selectedServer && selectedServer.trim().length > 0
          ? selectedServer
          : 'local'
  ).trim();
  if (declared === 'local') {
    return 'local';
  }
  const entry = sshHosts.find(item => item.host === declared);
  return { ssh: entry ?? { host: declared } };
}

/** ssh 公共旗标:BatchMode 免交互(密钥/agent 就绪才连得上,卡密码就是失败) */
function sshCommonArgs(entry: SshHostEntry): string[] {
  const args = ['-o', 'BatchMode=yes'];
  if (entry.proxyJump) {
    args.push('-J', entry.proxyJump);
  }
  if (entry.port) {
    args.push('-p', String(entry.port));
  }
  const target = entry.user ? `${entry.user}@${entry.host}` : entry.host;
  args.push(target);
  return args;
}

/**
 * 远程命令:`ssh [-o BatchMode=yes] [-J 跳板] [-p 端口] [user@]host -- <命令…>`
 * —— py-spy 探测/安装/dump 都经它跑在远端。
 */
export function buildSshExecArgs(entry: SshHostEntry, remoteCommand: string[]): string[] {
  return [...sshCommonArgs(entry), '--', ...remoteCommand];
}

/**
 * 端口隧道:`ssh … -N -L localPort:127.0.0.1:remotePort` —— 端口模式
 * connect 附加经隧道打到远端 debugpy 监听口。
 */
export function buildSshTunnelArgs(entry: SshHostEntry, localPort: number, remotePort: number): string[] {
  return [...sshCommonArgs(entry), '-N', '-L', `${localPort}:127.0.0.1:${remotePort}`];
}

/** 首选端口被占则换临时口:先探再试(远端口的本地形状最可读);preferred=0 = 直接要临时口 */
export function pickFreeLocalPort(preferred: number): Promise<number> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => {
      // 首选被占:让内核分个临时口
      const fallback = net.createServer();
      fallback.once('error', () => resolve(0));
      fallback.listen(0, '127.0.0.1', () => {
        const port = (fallback.address() as net.AddressInfo).port;
        fallback.close(() => resolve(port));
      });
    });
    server.listen(preferred, '127.0.0.1', () => {
      // 回实际绑定口:preferred=0 时内核分的就是这里的口
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

export interface SshTunnel {
  localPort: number;
  /** 杀隧道进程(附加结束/失败都调,不留后台 ssh) */
  stop(): void;
}

export interface TunnelDeps {
  /** 注入面:真实 spawn ssh;测试替身记账 */
  spawnTunnel?(args: string[]): { onExit(cb: () => void): void; kill(): void };
  probe?: TcpConnectFn;
  /** 本地隧道端口起等的窗口(默认 3s) */
  waitMs?: number;
}

export type TunnelOutcome =
  | { ok: true; tunnel: SshTunnel }
  | { ok: false; reason: string };

const defaultSpawnTunnel = (args: string[]): { onExit(cb: () => void): void; kill(): void } => {
  const child: ChildProcess = spawn('ssh', args, { windowsHide: true, detached: false });
  return {
    onExit: cb => {
      child.once('exit', cb);
      child.once('error', cb);
    },
    kill: () => {
      child.kill();
    }
  };
};

/**
 * 起 -L 隧道并等本地端口真开(ssh 连不上跳板/目标时 -N 进程退出、本地
 * 口不会开——窗口内没开就如实报失败,不朝空隧道附加)。
 */
export async function openSshTunnel(
  entry: SshHostEntry,
  remotePort: number,
  deps: TunnelDeps = {}
): Promise<TunnelOutcome> {
  const spawnTunnel = deps.spawnTunnel ?? defaultSpawnTunnel;
  const probe = deps.probe ?? defaultTcpConnect;
  const waitMs = deps.waitMs ?? 3000;
  const localPort = await pickFreeLocalPort(remotePort);
  if (localPort === 0) {
    return { ok: false, reason: `本地端口分配失败(首选 ${remotePort} 被占且临时口拿不到)` };
  }
  const args = buildSshTunnelArgs(entry, localPort, remotePort);
  const child = spawnTunnel(args);
  let exited = false;
  child.onExit(() => {
    exited = true;
  });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (exited) {
      child.kill(); // 已退出的进程再 kill 是 no-op,记账面统一走这里
      return {
        ok: false,
        reason: `ssh 隧道进程退出:${entry.host} 的 ${remotePort} 隧道未建立(检查跳板链/主机可达/免密登录 BatchMode)`
      };
    }
    const check = await probe('127.0.0.1', localPort, 500);
    if (check.open) {
      return {
        ok: true,
        tunnel: {
          localPort,
          stop: () => {
            child.kill();
          }
        }
      };
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  child.kill();
  return {
    ok: false,
    reason: `ssh 隧道 ${waitMs}ms 内未就绪:${entry.host} 的 127.0.0.1:${localPort}→${remotePort}(检查跳板链/主机可达)`
  };
}

export interface SshHostsSnapshot {
  hosts: SshHostEntry[];
  /** 读的配置文件路径(tooltip/报错可定位) */
  configPath: string;
  /** 文件在不在(不在 = 空表,正常事——视图只剩本地+手动项) */
  configExists: boolean;
}

/** 读 ssh config 主机表(注入读函数;文件不存在 = 空表,不抛) */
export async function readSshHosts(
  readFile: (path: string) => Promise<string>,
  configPath: string
): Promise<SshHostsSnapshot> {
  try {
    const text = await readFile(configPath);
    return { hosts: dedupeSshHosts(parseSshConfig(text)), configPath, configExists: true };
  } catch {
    return { hosts: [], configPath, configExists: false };
  }
}

/** 真实读面:~/.ssh/config */
export async function readSshHostsFromHome(
  readFile: (path: string) => Promise<string>,
  homeDir: string
): Promise<SshHostsSnapshot> {
  return readSshHosts(readFile, path.join(homeDir, '.ssh', 'config'));
}
