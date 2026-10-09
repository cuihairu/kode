import * as vscode from 'vscode';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import {
  BUILTIN_QUICK_COMMANDS,
  isCommandAllowed,
  KBEngineTelnetClient,
  TelnetClientState
} from './telnetClient';

/**
 * telnet 探测与联动服务(工单:telnet 探测+联动):
 * - 目标解析优先级:kode 设置(kbengine.telnet.host/port/password)→
 *   元件 kbengine.xml 的 <telnet_service> 段(未显式指定 xml 路径时按约定
 *   路径探测工作区根);批111 用户令:两处配置都未开启 telnet(无显式端口
 *   且 xml 无 <telnet_service> 段)→ 空目标,telnet 状态灯/树项/面板入口
 *   全部不出现,不再回落引擎默认端口表;
 * - 每 probeInterval 秒一轮 TCP connect(低频,不刷流量);
 * - 状态:unconfigured(无目标)/ closed(端口未开)/ open(端口开)/
 *   auth-required(端口开但未配密码,不自动登录)/ auth-rejected(密码拒)/
 *   connected(持久会话在)。状态灯优先级:密码拒 > 未开 > 开启;
 * - 开启时面板可建立持久会话:自动握手登录(密码只写 socket 不落日志)、
 *   白名单命令输入、内置只读快捷命令、输出流回显;
 * - 运行中断线自动回到探测态,重连由用户点面板再建立,面板不崩。
 */

/**
 * 引擎各组件 telnet 默认端口(kbengine_defaults.xml <telnet_service><port/>)。
 * 批111 用户令后仅在配置显式开启 telnet(kbengine.xml 有 <telnet_service> 段)
 * 但未指定端口时使用,不再作为「什么都没配」时的兜底展示。
 */
export const ENGINE_DEFAULT_TELNET_PORTS: ReadonlyArray<{ component: string; port: number }> = [
  { component: 'loginapp', port: 31000 },
  { component: 'dbmgr', port: 32000 },
  { component: 'interfaces', port: 33000 },
  { component: 'logger', port: 34000 },
  { component: 'baseapp', port: 40000 },
  { component: 'cellapp', port: 50000 },
  { component: 'bots', port: 51000 }
];

export interface TelnetSettingsInput {
  host: string;
  /** 0 = 未显式指定,回落引擎默认组件端口表 */
  port: number;
  /** 空 = 不自动登录(状态灯停在 auth-required) */
  password: string;
  enableCommands: string[];
}

export interface TelnetTarget {
  key: string;
  label: string;
  component: string;
  host: string;
  port: number;
  password: string;
  enableCommands: string[];
}

/**
 * 解析元件 kbengine.xml 的 <telnet_service> 段:
 * <port>/<password>/<default_layer> 文本值;无该段返回 null。
 */
export function parseKbengineXmlTelnet(xml: string): { port?: number; password?: string; defaultLayer?: string } | null {
  const section = xml.match(/<telnet_service>([\s\S]*?)<\/telnet_service>/);
  if (!section) {
    return null;
  }
  const pick = (tag: string): string | undefined => {
    const value = section[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return value ? value[1].trim() : undefined;
  };
  const portText = pick('port');
  const password = pick('password');
  const defaultLayer = pick('default_layer');
  return {
    port: portText !== undefined && portText.length > 0 ? Number(portText) : undefined,
    password: password !== undefined && password.length > 0 ? password : undefined,
    defaultLayer: defaultLayer !== undefined && defaultLayer.length > 0 ? defaultLayer : undefined
  };
}

/**
 * 目标集(批111 用户令:telnet 端口从配置读取,配置未开启就不展示):
 * 设置显式 port > 0 或 kbengine.xml <telnet_service> 段在 → 有目标
 * (段在而无端口 → 引擎默认表逐组件);两处都没开 → 空目标,telnet 全族
 * 入口(状态灯/树项/面板)随之隐藏。
 */
export function buildTelnetTargets(
  settings: TelnetSettingsInput,
  xmlTelnet: { port?: number; password?: string; defaultLayer?: string } | null
): TelnetTarget[] {
  const host = settings.host.trim() || '127.0.0.1';
  const enableCommands = [...settings.enableCommands];
  const explicitPort = settings.port > 0 ? settings.port : xmlTelnet?.port;
  if (explicitPort !== undefined) {
    const label = settings.port > 0 ? '自定义目标' : 'kbengine.xml';
    return [
      {
        key: `${host}:${explicitPort}`,
        label,
        component: label,
        host,
        port: explicitPort,
        password: settings.password || xmlTelnet?.password || '',
        enableCommands
      }
    ];
  }
  if (xmlTelnet) {
    return ENGINE_DEFAULT_TELNET_PORTS.map(({ component, port }) => ({
      key: `${host}:${port}`,
      label: component,
      component,
      host,
      port,
      password: settings.password,
      enableCommands
    }));
  }
  // 配置未开 telnet(无显式端口且 xml 无 <telnet_service> 段):不猜不兜底
  return [];
}

export type TelnetProbeState =
  | 'unconfigured'
  | 'closed'
  | 'open'
  | 'auth-required'
  | 'auth-rejected'
  | 'connected';

/**
 * 配置未显式指定 kbengine.xml 时的约定探测路径(工作区根相对):
 * 官方 server assets 布局 res/server/kbengine.xml、其 assets/ 嵌套变体、
 * 以及直接置于工作区根的布局。取第一个存在的文件为准,不深入猜测。
 */
const KBENGINE_XML_CANDIDATE_PATHS = [
  'kbengine.xml',
  'res/server/kbengine.xml',
  'assets/res/server/kbengine.xml'
];

/**
 * 从 kode 设置读取探测目标(kbengine.telnet.*):显式 configXmlPath 指向的
 * 元件 kbengine.xml(未设置时按约定路径探测工作区根)解析 <telnet_service>
 * 段作端口/密码回落;配置未开 telnet → 空目标(批111 用户令,不展示)。
 */
export function readTelnetTargetsFromSettings(): TelnetTarget[] {
  const config = vscode.workspace.getConfiguration('kbengine');
  const settings: TelnetSettingsInput = {
    host: config.get<string>('telnet.host', '127.0.0.1'),
    port: config.get<number>('telnet.port', 0),
    password: config.get<string>('telnet.password', ''),
    enableCommands: config.get<string[]>('telnet.enableCommands', [])
  };
  let xmlTelnet: ReturnType<typeof parseKbengineXmlTelnet> = null;
  const configXmlPath = config.get<string>('telnet.configXmlPath', '');
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let candidatePaths: string[] = [];
  if (configXmlPath) {
    candidatePaths = [configXmlPath.replace(/\$\{workspaceFolder\}/g, workspaceRoot || '')];
  } else if (workspaceRoot) {
    candidatePaths = KBENGINE_XML_CANDIDATE_PATHS.map(relative => path.join(workspaceRoot, relative));
  }
  for (const candidate of candidatePaths) {
    try {
      xmlTelnet = parseKbengineXmlTelnet(fs.readFileSync(candidate, 'utf8'));
      break; // 第一个存在的文件即元件配置;其无段=未开,不换路径再猜
    } catch {
      xmlTelnet = null; // 缺失/不可读:试下一个约定路径,不猜内容
    }
  }
  return buildTelnetTargets(settings, xmlTelnet);
}

/**
 * telnet 状态灯文案(状态栏):优先级 密码拒 > 未开 > 开启/连接(工单口径)。
 * 无目标时隐藏;点击灯打开 telnet 面板。
 */
export function updateTelnetStatusBar(
  service: TelnetService,
  item: vscode.StatusBarItem
): void {
  const targets = service.getTargets();
  if (targets.length === 0) {
    item.hide();
    return;
  }
  item.command = 'kbengine.telnet.showPanel';
  if (targets.some(target => service.getState(target.key) === 'auth-rejected')) {
    item.text = '$(plug) Telnet: 密码被拒';
  } else {
    const openCount = targets.filter(target => {
      const state = service.getState(target.key);
      return state === 'open' || state === 'connected' || state === 'auth-required';
    }).length;
    if (openCount > 0) {
      const connected = targets.some(target => service.getState(target.key) === 'connected');
      item.text = connected
        ? '$(plug) Telnet: 已连接'
        : `$(plug) Telnet: ${openCount}/${targets.length} 开启`;
    } else {
      item.text = '$(plug) Telnet: 未开启';
    }
  }
  item.show();
}

export interface TelnetServiceDeps {
  getTargets(): TelnetTarget[];
  /** TCP 探测:端口可连即 true(默认 net.connect 实现,1.5s 超时) */
  probeOne?(host: string, port: number): Promise<boolean>;
  /** 探测轮询间隔毫秒(默认 5000,低频) */
  intervalMs?: number;
  timers?: {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

export interface TelnetOutputLine {
  key: string;
  text: string;
}

/**
 * 探测单端口:timeoutMs 内连通判开,超时/拒绝判关。
 * connect 可注入——超时臂用停摆 socket 确定性覆盖,不依赖运行环境的路由行为
 * (真实网络下「连不上」既可能是超时也可能是瞬时 ENETUNREACH,后者不触发超时回调)。
 */
export const makeProbeOne =
  (
    timeoutMs: number,
    connect: (options: { host: string; port: number }) => net.Socket = net.connect
  ) =>
  (host: string, port: number): Promise<boolean> =>
    new Promise(resolve => {
      const socket = connect({ host, port });
      const finish = (open: boolean): void => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(timeoutMs, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });

const defaultProbeOne = makeProbeOne(1500);

const defaultTimers = {
  setInterval: (callback: () => void, ms: number): unknown => setInterval(callback, ms),
  clearInterval: (handle: unknown): void => clearInterval(handle as NodeJS.Timeout)
};

const MAX_OUTPUT_LINES = 500;

export class TelnetService {
  private targets: TelnetTarget[] = [];
  private readonly states = new Map<string, TelnetProbeState>();
  private readonly clients = new Map<string, KBEngineTelnetClient>();
  private readonly outputs = new Map<string, string[]>();
  private timer: unknown = null;
  private disposed = false;
  private probing = false;
  private readonly probeOne: (host: string, port: number) => Promise<boolean>;
  private readonly intervalMs: number;
  private readonly timers: NonNullable<TelnetServiceDeps['timers']>;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly _onOutput = new vscode.EventEmitter<TelnetOutputLine>();
  readonly onOutput = this._onOutput.event;

  constructor(private readonly deps: TelnetServiceDeps) {
    this.probeOne = deps.probeOne ?? defaultProbeOne;
    this.intervalMs = deps.intervalMs ?? 5000;
    this.timers = deps.timers ?? defaultTimers;
  }

  getTargets(): TelnetTarget[] {
    return this.targets;
  }

  getState(key: string): TelnetProbeState {
    return this.states.get(key) ?? 'closed';
  }

  getSessionState(key: string): TelnetClientState | null {
    return this.clients.get(key)?.state ?? null;
  }

  getOutput(key: string): string[] {
    return this.outputs.get(key) ?? [];
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.targets = this.deps.getTargets();
    if (this.targets.length === 0) {
      return;
    }
    for (const target of this.targets) {
      if (!this.states.has(target.key)) {
        this.states.set(target.key, 'closed');
      }
    }
    void this.probeOnce();
    this.timer = this.timers.setInterval(() => void this.probeOnce(), this.intervalMs);
  }

  /** 单轮探测:目标集重读(设置可能变),逐目标 TCP connect */
  async probeOnce(): Promise<void> {
    if (this.disposed || this.probing) {
      return;
    }
    this.probing = true;
    try {
      this.targets = this.deps.getTargets();
      let changed = false;
      for (const target of this.targets) {
        if (this.clients.has(target.key)) {
          // 持久会话在,会话状态即灯色,无需 TCP 探测
          continue;
        }
        const open = await this.probeOne(target.host, target.port);
        const next: TelnetProbeState = open
          ? target.password
            ? 'open'
            : 'auth-required'
          : 'closed';
        if (this.states.get(target.key) !== next) {
          this.states.set(target.key, next);
          changed = true;
        }
      }
      if (this.targets.length === 0 && this.states.size > 0) {
        this.states.clear();
        changed = true;
      }
      if (changed) {
        this._onDidChange.fire();
      }
    } finally {
      this.probing = false;
    }
  }

  /** 面板命令白名单 = 用户 enableCommands + 内置只读快捷命令;:quit 恒拒 */
  isAllowed(key: string, command: string): boolean {
    const target = this.targets.find(item => item.key === key);
    const whitelist = [
      ...(target?.enableCommands ?? []),
      ...BUILTIN_QUICK_COMMANDS.map(entry => entry.command)
    ];
    return isCommandAllowed(command, whitelist);
  }

  /** 建立持久会话(自动握手登录);已存在则先断旧 */
  connectTarget(key: string): void {
    const target = this.targets.find(item => item.key === key);
    if (!target || this.disposed) {
      return;
    }
    this.disconnectTarget(key);
    const client = new KBEngineTelnetClient({
      host: target.host,
      port: target.port,
      password: target.password || undefined,
      events: {
        onStateChange: state => {
          const next: TelnetProbeState =
            state === 'ready'
              ? 'connected'
              : state === 'awaiting-password'
                ? target.password
                  ? 'open'
                  : 'auth-required'
                : state === 'auth-rejected'
                  ? 'auth-rejected'
                  : 'closed';
          if (this.states.get(key) !== next) {
            this.states.set(key, next);
            this._onDidChange.fire();
          }
        },
        onData: text => {
          const lines = this.outputs.get(key) ?? [];
          for (const line of text.split(/\r?\n/)) {
            if (line.trim().length > 0) {
              lines.push(line);
            }
          }
          while (lines.length > MAX_OUTPUT_LINES) {
            lines.shift();
          }
          this.outputs.set(key, lines);
          this._onOutput.fire({ key, text });
        },
        onClose: () => {
          // 断线:会话拆除,状态回落由下一轮探测刷新(掉线不崩面板)。
          // 只拆自己:重连断旧建新时,旧 socket 的 close 事件晚到,
          // 不得误删新会话
          if (this.clients.get(key) === client) {
            this.clients.delete(key);
          }
        }
      }
    });
    this.clients.set(key, client);
    client.connect();
  }

  disconnectTarget(key: string): void {
    const client = this.clients.get(key);
    if (!client) {
      return;
    }
    this.clients.delete(key);
    client.disconnect();
  }

  /** 发送命令:白名单闸在服务层,未过闸/无会话返回 false */
  sendCommand(key: string, command: string): boolean {
    if (!this.isAllowed(key, command)) {
      return false;
    }
    const client = this.clients.get(key);
    if (!client) {
      return false;
    }
    return client.sendCommand(command);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
    }
    for (const key of [...this.clients.keys()]) {
      this.disconnectTarget(key);
    }
    this._onDidChange.dispose();
    this._onOutput.dispose();
  }
}
