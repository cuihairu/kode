/**
 * KB-GC-001 guiconsole 期一·日志实时 tail:Logger::registerLogWatcher(702)
 * 注册后 logger 以 CONSOLE_LOG_MSGID 65501 经同一条 TCP 长连推流
 * (logwatcher.cpp:104-112),关闭连接即断流——这是长连客户端,不是 kode
 * 既有的一次性短连查询(queryWatcherPath 模式)。
 *
 * 工程面(设计文档 §5「channel shape」):连接生命周期是主要成本——
 * machined/logger 不在时如实提示不硬试(waiting-machined,随 hub 轮询
 * 自动就绪),断线指数退避重连(1s 起步,×2,封顶 30s,连上即清零),
 * 连接期间按 701 onAppActiveTick 保活(guiconsole timer3 同款,20s;此处
 * 10s)。错误级行接 IDE-LIV-007 exceptionSourceLocator 提供跳转落点。
 */

import * as net from 'net';
import { l10nText } from '../nlsRuntime';
import {
  CONSOLE_LOG_MSG_ID,
  KBELOG_TYPES_MASK,
  LOGGER_APP_ACTIVE_TICK_MSG_ID,
  LOGGER_DEREGISTER_LOG_WATCHER_MSG_ID,
  LOGGER_REGISTER_LOG_WATCHER_MSG_ID,
  SERVER_COMPONENT_TYPES,
  buildAppActiveTickBody,
  buildFixedFrame,
  buildFrame,
  buildLogWatcherRequestBody,
  parseConsoleLogBody,
  parseLogStream,
  type ParsedLogStream
} from './kbengineProtocol';
import { parseExceptionSourceLocation, type ExceptionSourceLocation } from './exceptionSourceLocator';
import type { ConsoleHubDepsLike } from '../kbengineConsoleHub';

export type TailState = 'disabled' | 'waiting-machined' | 'connecting' | 'connected' | 'backoff';

export interface TailOutputLike {
  appendLine(line: string): void;
  show(): void;
}

export interface TailStatusItemLike {
  /** 真实 vscode.StatusBarItem 的可写 text 属性(非方法) */
  text: string;
  show(): void;
  hide(): void;
}

export interface ConsoleLogTailDeps {
  hub: Pick<ConsoleHubDepsLike, 'getLogger' | 'getMachinedState' | 'onDidChange'>;
  /** 工作区根(跳转落点解析用) */
  workspaceRoots: () => string[];
  /** 源码落点解析(生产=resolveExceptionSource;测试注入) */
  resolveSource: (
    workspaceRoots: string[],
    location: ExceptionSourceLocation
  ) => { absolutePath: string } | null;
  output: TailOutputLike;
  statusItem: TailStatusItemLike;
  /** 配置访问器:每次调用重读,保证「下次重连生效」不取激活期快照(生产=consoleConfig.get) */
  getConfig: () => {
    enabled: boolean;
    /** kbengine.consoleLogTail.components:组件类型名过滤(如 cellapp/baseapp) */
    components: string[];
  };
  /** 测试注入;生产=net.connect */
  createConnection?: (options: { host: string; port: number }) => net.Socket;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  tickIntervalMs?: number;
}

export interface TailJumpTarget {
  raw: string;
  parsed: ParsedLogStream;
  location: ExceptionSourceLocation;
}

const ERROR_LEVELS = new Set(['ERROR', 'S_ERR', 'CRITICAL']);
const JUMP_TARGET_LIMIT = 50;

/** 输出行格式:引擎时间戳 + 归一级别 + 组件实例(引擎侧恒带两位序号,logger.cpp:268-269)+ 消息体 */
export function formatTailLine(raw: string): string {
  const parsed = parseLogStream(raw);
  if (!parsed) {
    return raw;
  }
  const instance = `${parsed.component}${String(parsed.groupOrder).padStart(2, '0')}`;
  return `${parsed.timestamp} [${parsed.level}] ${instance}: ${parsed.message}`;
}

export interface TailJumpAction {
  title: string;
  file: string;
  line: number;
}

/**
 * 错误行(code action 语义):仅 ERROR/S_ERR/CRITICAL 且原始行可解析出
 * file:line、且源码在工作区真实存在才给跳转落点——解析不到就如实不给,
 * 不猜邻近文件(exceptionSourceLocator 同一口径)。
 */
export function buildTailCodeActions(
  raw: string,
  resolve: (workspaceRoots: string[], location: ExceptionSourceLocation) => { absolutePath: string } | null,
  workspaceRoots: string[] = []
): TailJumpAction[] {
  const parsed = parseLogStream(raw);
  if (!parsed || !ERROR_LEVELS.has(parsed.level)) {
    return [];
  }
  const location = parseExceptionSourceLocation(parsed.message);
  if (!location) {
    return [];
  }
  const resolved = resolve(workspaceRoots, location);
  if (!resolved) {
    return [];
  }
  return [
    {
      title: l10nText('KBEngine: jump to exception source {file}:{line}', {
        file: resolved.absolutePath,
        line: location.line
      }),
      file: resolved.absolutePath,
      line: location.line
    }
  ];
}

export class ConsoleLogTailController {
  private state: TailState = 'disabled';
  private started = false;
  private socket: net.Socket | null = null;
  private receiveBuffer = Buffer.alloc(0);
  private backoffAttempt = 0;
  private connectedAtMs = 0;
  /** 上一次连接的持续时长(connect→disconnect),用于稳定窗口判定 */
  private lastConnectedDurationMs = 0;
  /** 连接稳定窗:连上并存活超过该时长才清零退避;闪断序列保持指数增长 */
  private static readonly STABILITY_WINDOW_MS = 60000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly tickIntervalMs: number;
  private readonly createConnection: (options: { host: string; port: number }) => net.Socket;
  private readonly jumpTargets: TailJumpTarget[] = [];
  private hubSubscription: { dispose(): void } | null = null;
  private lastNotice = '';

  constructor(private readonly deps: ConsoleLogTailDeps) {
    this.backoffBaseMs = deps.backoffBaseMs ?? 1000;
    this.backoffMaxMs = deps.backoffMaxMs ?? 30000;
    this.tickIntervalMs = deps.tickIntervalMs ?? 10000;
    this.createConnection = deps.createConnection ?? ((options) => net.connect(options.port, options.host));
  }

  start(force = false): void {
    if (this.started) {
      return;
    }
    // 配置开关闸的是「激活期自动 start」;toggle 是显式用户意图,越过缺省关闭
    this.started = true;
    if (!this.deps.getConfig().enabled && !force) {
      this.setState('disabled');
      return;
    }
    this.hubSubscription = this.deps.hub.onDidChange(() => {
      // machined/logger 就绪后从 waiting-machined 立即接续,不空转硬试
      if (this.started && (this.state === 'waiting-machined' || this.state === 'disabled')) {
        void this.attemptConnect();
      }
    });
    void this.attemptConnect();
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.hubSubscription) {
      this.hubSubscription.dispose();
      this.hubSubscription = null;
    }
    this.teardownSocket(true);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoffAttempt = 0;
    this.setState('disabled');
  }

  toggle(): void {
    if (this.started) {
      this.stop();
    } else {
      this.start(true);
    }
  }

  dispose(): void {
    this.stop();
  }

  getState(): TailState {
    return this.state;
  }

  getJumpTargets(): TailJumpTarget[] {
    return [...this.jumpTargets];
  }

  /** 工作区落点解析(面板 code action 生产装配入口) */
  resolveJumpTarget(target: TailJumpTarget): string | null {
    const resolved = this.deps.resolveSource(this.deps.workspaceRoots(), target.location);
    return resolved?.absolutePath ?? null;
  }

  private setState(state: TailState): void {
    this.state = state;
    this.updateStatusItem();
  }

  private updateStatusItem(): void {
    const item = this.deps.statusItem;
    if (!this.started || this.state === 'disabled') {
      item.hide();
      return;
    }
    switch (this.state) {
      case 'connected':
        item.text = '$(radio-tower) KBE 日志';
        break;
      case 'connecting':
        item.text = '$(sync~spin) KBE 日志:连接中';
        break;
      case 'waiting-machined':
        item.text = '$(circle-slash) KBE 日志:待 machined';
        break;
      default:
        // backoff:重连序号从 1 起(首次失败后第 1 次重连),不显示「重连 0」
        item.text = `$(sync~spin) KBE 日志:重连 ${this.backoffAttempt}`;
        break;
    }
    item.show();
  }

  private notice(line: string): void {
    if (this.lastNotice === line) {
      return;
    }
    this.lastNotice = line;
    this.deps.output.appendLine(line);
  }

  private async attemptConnect(): Promise<void> {
    if (!this.started || this.state === 'connected' || this.state === 'connecting') {
      return;
    }
    if (this.deps.hub.getMachinedState() === 'unreachable') {
      this.setState('waiting-machined');
      this.notice(l10nText(
        'KBEngine console log tail: machined is not reachable (no answer on discovery UDP 20086); will attach when it comes back.'
      ));
      return;
    }
    const logger = this.deps.hub.getLogger();
    if (!logger) {
      this.setState('waiting-machined');
      this.notice(l10nText(
        'KBEngine console log tail: no logger component in machined discovery yet; waiting for it to start.'
      ));
      return;
    }
    this.setState('connecting');
    const socket = this.createConnection({ host: logger.intaddr, port: logger.intport });
    this.socket = socket;
    this.receiveBuffer = Buffer.alloc(0);
    socket.once('connect', () => {
      if (this.socket !== socket) {
        socket.destroy();
        return;
      }
      // 稳定窗按「上一次连接实际存活时长」判,不含断线等待(长离线间隙不算稳定,
      // 闪断序列即使中间隔很久也不误清零退避)
      this.backoffAttempt = this.lastConnectedDurationMs >= ConsoleLogTailController.STABILITY_WINDOW_MS
        ? 0
        : this.backoffAttempt;
      this.connectedAtMs = Date.now();
      this.lastConnectedDurationMs = 0;
      this.lastNotice = '';
      // 注册帧:uid 取 logger 组件广播自报的 uid(各组件同用户启动,uid 一致;
      // LogWatcher::onMessage 逐条比对 uid,logwatcher.cpp:88-90)
      const request = buildLogWatcherRequestBody({
        uid: logger.uid,
        logtypes: KBELOG_TYPES_MASK,
        globalOrder: 0,
        groupOrder: 0,
        date: '',
        keyStr: '',
        componentTypes: SERVER_COMPONENT_TYPES,
        isfind: false,
        first: true
      });
      socket.write(buildFrame(LOGGER_REGISTER_LOG_WATCHER_MSG_ID, request));
      this.setState('connected');
      this.startTick(socket, logger.componentID);
      this.deps.output.appendLine(l10nText(
        'KBEngine console log tail: registered on logger {host}:{port} (702 → 65501 push stream).',
        { host: logger.intaddr, port: logger.intport }
      ));
    });
    socket.on('data', data => {
      if (this.socket !== socket) {
        return;
      }
      this.handleData(Buffer.from(data));
    });
    socket.on('error', () => {
      this.handleDisconnect(socket);
    });
    socket.on('close', () => {
      this.handleDisconnect(socket);
    });
  }

  private startTick(socket: net.Socket, componentID: bigint): void {
    this.stopTick();
    // 701 onAppActiveTick:CONSOLE_TYPE(9)+ 自报 componentID(0);长连保活,
    // guiconsole timer3 同款协议(messages_fixed_defaults.xml Logger::onAppActiveTick:701)
    this.tickTimer = setInterval(() => {
      if (this.socket === socket) {
        // 701 为 NETWORK_FIXED_MESSAGE:定长帧无长度字段,须用 buildFixedFrame
        // (buildFrame 会多塞 2 字节长度致引擎参数错位,见 kbengineProtocol.ts buildFixedFrame 注)
        socket.write(buildFixedFrame(LOGGER_APP_ACTIVE_TICK_MSG_ID, buildAppActiveTickBody(9, componentID)));
      }
    }, this.tickIntervalMs);
  }

  private stopTick(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private teardownSocket(sendDeregister: boolean): void {
    this.stopTick();
    const socket = this.socket;
    this.socket = null;
    if (!socket) {
      return;
    }
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
    socket.removeAllListeners('connect');
    if (sendDeregister && !socket.destroyed) {
      // 703 注销,尽力而为:连接已在断流路径上时写不进就算了
      try {
        socket.write(buildFrame(LOGGER_DEREGISTER_LOG_WATCHER_MSG_ID, Buffer.alloc(0)));
      } catch {
        // 断流路径上的注销失败不掩盖原始错误
      }
    }
    socket.destroy();
  }

  private handleDisconnect(socket: net.Socket): void {
    if (this.socket !== socket) {
      return;
    }
    // 记录本次连接实际存活时长(connect→disconnect),供下次 connect 判稳定窗
    if (this.connectedAtMs > 0) {
      this.lastConnectedDurationMs = Date.now() - this.connectedAtMs;
    }
    this.teardownSocket(false);
    if (!this.started) {
      return;
    }
    const delay = Math.min(this.backoffBaseMs * 2 ** this.backoffAttempt, this.backoffMaxMs);
    this.backoffAttempt += 1;
    this.setState('backoff');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptConnect();
    }, delay);
  }

  private handleData(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    while (this.receiveBuffer.length >= 4) {
      const messageId = this.receiveBuffer.readUInt16LE(0);
      const frameLength = this.receiveBuffer.readUInt16LE(2);
      const totalLength = 4 + frameLength;
      if (this.receiveBuffer.length < totalLength) {
        break;
      }
      const body = this.receiveBuffer.subarray(4, totalLength);
      this.receiveBuffer = this.receiveBuffer.subarray(totalLength);
      if (messageId !== CONSOLE_LOG_MSG_ID) {
        continue;
      }
      const texts = parseConsoleLogBody(body);
      if (!texts) {
        continue;
      }
      for (const text of texts) {
        this.emitLogLine(text);
      }
    }
  }

  private emitLogLine(raw: string): void {
    const parsed = parseLogStream(raw);
    // 组件过滤每次读配置(下次重连生效而非激活期快照)
    const components = this.deps.getConfig().components;
    if (parsed && components.length > 0) {
      const wanted = new Set(components);
      if (!wanted.has(parsed.component)) {
        return;
      }
    }
    this.deps.output.appendLine(formatTailLine(raw));
    if (parsed && ERROR_LEVELS.has(parsed.level)) {
      const location = parseExceptionSourceLocation(parsed.message);
      if (location) {
        this.jumpTargets.push({ raw, parsed, location });
        if (this.jumpTargets.length > JUMP_TARGET_LIMIT) {
          this.jumpTargets.splice(0, this.jumpTargets.length - JUMP_TARGET_LIMIT);
        }
      }
    }
  }
}
