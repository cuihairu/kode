/**
 * Remote connection dispatch (IDE-PDBG-004): whether a component declared in
 * debug.json runs locally or on which ssh/config host (local by default);
 * debug and py-spy are dispatched by the chosen host -- remote = run the
 * command under an ssh prefix / forward the port with an -L tunnel, and a
 * connection failure is reported honestly rather than faked as a success.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { defaultTcpConnect, type TcpConnectFn } from './debugpyPortProbe';
import { dedupeSshHosts, parseSshConfig, type SshHostEntry } from './sshConfig';

/** 'local' = run locally (default); otherwise go through that ssh host */
export type ServerConnection = 'local' | { ssh: SshHostEntry };

/**
 * Connection dispatch resolution, priority: component-level sshHost
 * (debug.json, shared within the project) > the debug.json global
 * defaultSshHost > the server selected in the view (this session's state) >
 * local. An empty string / 'local' both map to local; an alias absent from
 * ~/.ssh/config is still connected to as a bare hostname (HostName defaulting
 * to the alias is ssh's semantics).
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

/**
 * Defense line against ssh positional-argument injection: the target / jump
 * host come from project-shared, half-trusted input (.kbengine/debug.json,
 * ~/.ssh/config). ssh positional arguments do not depend on shell tokenizing,
 * so a target shaped like `-oProxyCommand=...` gets parsed as an option
 * executed locally instead of a hostname, and whitespace or control characters
 * likewise split out extra tokens. A leading '-' and any whitespace / control
 * character are rejected outright.
 */
function sshTokenProblem(token: string, label: string): string | null {
  if (token.length === 0) { return `${label} 为空`; }
  if (token.startsWith('-')) { return `${label} 以 '-' 开头(会被 ssh 当选项解析):${token}`; }
  // Code point verdict (no character-class regex, eslint no-control-regex):
  // whitespace splits the token, and C0/DEL control characters in an ssh
  // positional argument are meaningless and carry injection-shape risk
  let control = false;
  for (const ch of token) {
    const code = ch.charCodeAt(0);
    if (/\s/.test(ch) || code < 32 || code === 127) { control = true; break; }
  }
  if (control) { return `${label} 含空白或控制字符:${token}`; }
  return null;
}

/** Non-null when the target declaration is illegal; returns null when it is legal */
export function validateSshEntry(entry: SshHostEntry): string | null {
  const problems = [
    sshTokenProblem(entry.host, 'host'),
    entry.user ? sshTokenProblem(entry.user, 'user') : null,
    entry.proxyJump ? sshTokenProblem(entry.proxyJump, 'proxyJump') : null
  ].filter((problem): problem is string => problem !== null);
  return problems.length > 0 ? problems.join('; ') : null;
}

/** Common ssh flags: BatchMode is non-interactive (it only connects once the key/agent is ready, and hanging on a password prompt means failure) */
function sshCommonArgs(entry: SshHostEntry): string[] {
  const problem = validateSshEntry(entry);
  if (problem) {
    throw new RangeError(`ssh 目标声明非法:${problem}`);
  }
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
 * Remote command: `ssh [-o BatchMode=yes] [-J jump host] [-p port] [user@]host
 * -- <command...>` -- py-spy probing/installing/dumping all run remotely
 * through it.
 */
export function buildSshExecArgs(entry: SshHostEntry, remoteCommand: string[]): string[] {
  return [...sshCommonArgs(entry), '--', ...remoteCommand];
}

/**
 * Port tunnel: `ssh ... -N -L localPort:127.0.0.1:remotePort` -- the connect
 * attach in port mode reaches the remote debugpy listening port through the
 * tunnel.
 */
export function buildSshTunnelArgs(entry: SshHostEntry, localPort: number, remotePort: number): string[] {
  return [...sshCommonArgs(entry), '-N', '-L', `${localPort}:127.0.0.1:${remotePort}`];
}

/** If the preferred port is taken, switch to a temporary port: probe first, then try (the local shape of the remote port is the most readable); preferred=0 = ask for a temporary port directly */
export function pickFreeLocalPort(preferred: number): Promise<number> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => {
      // The preferred port is taken: let the kernel hand out a temporary port
      const fallback = net.createServer();
      fallback.once('error', () => resolve(0));
      fallback.listen(0, '127.0.0.1', () => {
        const port = (fallback.address() as net.AddressInfo).port;
        fallback.close(() => resolve(port));
      });
    });
    server.listen(preferred, '127.0.0.1', () => {
      // Return the actually bound port: when preferred=0, this is exactly the port the kernel assigned
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

export interface SshTunnel {
  localPort: number;
  /** Kill the tunnel process (called both when the attach ends and on failure, leaving no background ssh behind) */
  stop(): void;
}

export interface TunnelDeps {
  /** Injection surface: really spawn ssh; a test stand-in records the calls */
  spawnTunnel?(args: string[]): { onExit(cb: () => void): void; kill(): void };
  probe?: TcpConnectFn;
  /** Window to wait for the local tunnel port to come up (default 3s) */
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
 * Bring up the -L tunnel and wait for the local port to really open (when ssh
 * cannot reach the jump host / target, the -N process exits and the local
 * port never opens -- if it has not opened within the window, report failure
 * honestly instead of attaching to an empty tunnel).
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
      child.kill(); // killing an already-exited process is a no-op; the bookkeeping surface goes through this spot uniformly
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
  /** Path of the config file that was read (a tooltip / error can point at it) */
  configPath: string;
  /** Whether the file exists (absent = an empty table, which is normal -- the view is left with local + manual entries) */
  configExists: boolean;
}

/** Read the ssh config host table (the reading function is injected; a missing file = an empty table, no throw) */
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

/** The real reading surface: ~/.ssh/config */
export async function readSshHostsFromHome(
  readFile: (path: string) => Promise<string>,
  homeDir: string
): Promise<SshHostsSnapshot> {
  return readSshHosts(readFile, path.join(homeDir, '.ssh', 'config'));
}
