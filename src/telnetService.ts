import * as vscode from 'vscode';
import * as net from 'net';
import {
  BUILTIN_QUICK_COMMANDS,
  isCommandAllowed,
  KBEngineTelnetClient,
  TelnetClientState
} from './telnetClient';
import { expandWorkspacePlaceholders } from './backend/workspacePath';
import {
  ensureConfigResolved,
  getConfigResolved,
  type ConfigResolveOverrides
} from './serverConfigResolve';
export { deriveEngineDefaultsXmlPath } from './serverConfigResolve';

/**
 * telnet 探测与联动服务(工单:telnet 探测+联动):
 * - 目标解析优先级:kode 设置(kbengine.telnet.host/port/password)→
 *   元件 kbengine.xml 的 <telnet_service> 段(未显式指定 xml 路径时按约定
 *   路径探测工作区根)→ 引擎 kbengine_defaults.xml(批112 用户令:经
 *   kbengine.binPath 推导 <引擎根>/kbe/res/server/kbengine_defaults.xml,
 *   解析各组件 <telnet_service> 段的真实端口/密码,替代写死的默认端口表);
 *   批111 用户令:显式端口与元件 xml 段都没有 → 空目标,telnet 状态灯/
 *   树项/面板入口全部不出现(引擎 defaults 只补值,不当开启开关);
 * - 每 probeInterval 秒一轮 TCP connect(低频,不刷流量);
 * - 状态:unconfigured(无目标)/ closed(端口未开)/ open(端口开)/
 *   auth-required(端口开但未配密码,不自动登录)/ auth-rejected(密码拒)/
 *   connected(持久会话在)。状态灯优先级:密码拒 > 未开 > 开启;
 * - 开启时面板可建立持久会话:自动握手登录(密码只写 socket 不落日志)、
 *   白名单命令输入、内置只读快捷命令、输出流回显;
 * - 运行中断线自动回到探测态,重连由用户点面板再建立,面板不崩。
 */

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
 * 目标集 settings 半(KODE-CFG-009 拆分口径落定):显式 kbengine.telnet.port
 * > 0 → 单个「自定义目标」;否则空目标。配置读值(元件 kbengine.xml 段与
 * 引擎 defaults 端口/密码)由 core 派生半单一供给(telnetDeriveTargets 经
 * `derive.telnet`);旧路径的本地 XML 解析已随 parseKbengineXmlTelnet/
 * parseKbengineDefaultsTelnet 下线(core 是唯一解析实现),派生不可用时的
 * 兜底只保留 settings 半,不再自行猜配置。
 */
export function buildTelnetTargets(settings: TelnetSettingsInput): TelnetTarget[] {
  const host = settings.host.trim() || '127.0.0.1';
  const enableCommands = [...settings.enableCommands];
  if (settings.port > 0) {
    return [
      {
        key: `${host}:${settings.port}`,
        label: '自定义目标',
        component: '自定义目标',
        host,
        port: settings.port,
        password: settings.password,
        enableCommands
      }
    ];
  }
  // 配置未显式指定端口且 core 派生不可用:不猜不兜底(批111 口径)
  return [];
}

export type TelnetProbeState =
  | 'unconfigured'
  | 'closed'
  | 'open'
  | 'auth-required'
  | 'auth-rejected'
  | 'connected';

/** kode 设置读取(kbengine.telnet.*):host/port/password/enableCommands(CFG-007 抽出共用) */
export function readTelnetSettings(): TelnetSettingsInput {
  const config = vscode.workspace.getConfiguration('kbengine');
  return {
    host: config.get<string>('telnet.host', '127.0.0.1'),
    port: config.get<number>('telnet.port', 0),
    password: config.get<string>('telnet.password', ''),
    enableCommands: config.get<string[]>('telnet.enableCommands', [])
  };
}

export function readTelnetTargetsFromSettings(): TelnetTarget[] {
  const settings = readTelnetSettings();
  const host = settings.host.trim() || '127.0.0.1';
  const enableCommands = [...settings.enableCommands];
  if (settings.port > 0) {
    return buildTelnetTargets(settings);
  }
  // KODE-CFG-009:配置读值半由 core 供给——显式 telnet.configXmlPath 时
  // core 解析的就是那份文件(派生半只认标准发现链,两半不分口的审核修复
  // 保留);取数未就绪即触发重取(派生半同款先例:首取空,下一轮探测即用)。
  const config = vscode.workspace.getConfiguration('kbengine');
  const rawPath = config.get<string>('telnet.configXmlPath', '').trim();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const overrides: ConfigResolveOverrides =
    rawPath.length > 0
      ? { customXmlPath: expandWorkspacePlaceholders(rawPath, workspaceRoot) }
      : {};
  void ensureConfigResolved(overrides).catch(() => {});
  const state = getConfigResolved(overrides);
  if (!state || !state.ok) {
    // 门未接线/core 不可知:如实空目标,不本地猜配置
    return [];
  }
  const customTelnet = state.customTelnet;
  if (!customTelnet) {
    // 元件配置缺失或无 telnet_service 段:不开(批111:段不当开关的存在臂)
    return [];
  }
  // 密码链(旧口径):设置 > 元件段 > 引擎 defaults 速览首非空
  const defaultsPassword =
    state.telnetSummary.find(entry => entry.password !== null)?.password ?? null;
  const password = settings.password || customTelnet.password || defaultsPassword || '';
  if (customTelnet.port !== null) {
    return [
      {
        key: `${host}:${customTelnet.port}`,
        label: 'kbengine.xml',
        component: 'kbengine.xml',
        host,
        port: customTelnet.port,
        password,
        enableCommands
      }
    ];
  }
  // 段在而无端口:逐组件端口 = 合成速览值 ?? 引擎写死表(core 唯一真源;
  // defaults 缺席时合成速览为空,写死表项即全量组件面)
  const summaryByComponent = new Map(
    state.telnetSummary.map(entry => [entry.component, entry])
  );
  return Object.entries(state.telnetDefaultPorts).map(([component, defaultPort]) => {
    const port = summaryByComponent.get(component)?.port ?? defaultPort;
    return {
      key: `${host}:${port}`,
      label: component,
      component,
      host,
      port,
      password,
      enableCommands
    };
  });
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
    for (const target of this.targets) {
      if (!this.states.has(target.key)) {
        this.states.set(target.key, 'closed');
      }
    }
    // KODE-CFG-009:目标读值半经 core 解析(`$/kode/config/resolve`),首取
    // 可能未就绪(核心服务冷启动/测试替身在 activate 后才装)——定时器照挂,
    // 下一轮 probeOnce 重读目标集即用(readTelnetTargetsFromSettings 口径
    // 「首取空,下一轮探测即用」);无目标轮询只有一次缓存读,零成本。
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
