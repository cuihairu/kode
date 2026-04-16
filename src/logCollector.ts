import * as vscode from 'vscode';
import * as net from 'net';
import { LogEntry, LogLevel } from './logParser';

export interface LogCollectorConfig {
  host: string;
  port: number;
  autoReconnect: boolean;
  reconnectInterval: number;
  maxBufferSize: number;
}

export enum CollectorStatus {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Error = 'error'
}

/**
 * KBEngine logger 不是纯文本 TCP 流。
 * 源码显示需要注册 log watcher 并走内部消息协议，当前插件尚未完成这层实现。
 */
export class KBEngineLogCollector {
  static readonly PROTOCOL_WARNING =
    'KBEngine logger watcher 协议适配尚未完成，当前版本只提供界面与状态提示，不宣称可直接接入官方 logger 协议。';

  private status: CollectorStatus = CollectorStatus.Disconnected;
  private socket: net.Socket | null = null;
  private receiveBuffer = Buffer.alloc(0);
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isManualDisconnect = false;
  private lastError: Error | null = null;

  private _onDidChangeStatus = new vscode.EventEmitter<CollectorStatus>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private _onLogEntry = new vscode.EventEmitter<LogEntry>();
  readonly onLogEntry = this._onLogEntry.event;

  private _onError = new vscode.EventEmitter<Error>();
  readonly onError = this._onError.event;

  private readonly logEntries: LogEntry[] = [];
  private readonly outputChannel: vscode.OutputChannel;

  constructor(
    private config: LogCollectorConfig,
    private context: vscode.ExtensionContext
  ) {
    this.outputChannel = vscode.window.createOutputChannel('KBEngine Logs');
  }

  async connect(): Promise<void> {
    const error = new Error(
      `当前版本未完成 KBEngine logger watcher 协议适配，无法直接连接 ${this.config.host}:${this.config.port}。${KBEngineLogCollector.PROTOCOL_WARNING}`
    );
    this.lastError = error;
    this.updateStatus(CollectorStatus.Error);
    this.outputChannel.appendLine(`[WARN] ${error.message}`);
    this._onError.fire(error);
    throw error;
  }

  disconnect(): void {
    this.isManualDisconnect = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.sendDeregister();
    this.disposeSocket();
    this.updateStatus(CollectorStatus.Disconnected);
  }

  getStatus(): CollectorStatus {
    return this.status;
  }

  getLogEntries(): LogEntry[] {
    return [...this.logEntries];
  }

  clearLogs(): void {
    this.logEntries.length = 0;
  }

  getLogCount(): number {
    return this.logEntries.length;
  }

  getLogsByLevel(level: LogLevel): LogEntry[] {
    return this.logEntries.filter(entry => entry.level === level);
  }

  getLogsByComponent(component: string): LogEntry[] {
    return this.logEntries.filter(entry => entry.component === component);
  }

  searchLogs(keyword: string, useRegex = false): LogEntry[] {
    if (useRegex) {
      try {
        const regex = new RegExp(keyword, 'i');
        return this.logEntries.filter(entry => regex.test(entry.message));
      } catch {
        return [];
      }
    }

    return this.logEntries.filter(entry =>
      entry.message.toLowerCase().includes(keyword.toLowerCase())
    );
  }

  getUnavailableReason(): string {
    if (this.lastError) {
      return `${this.lastError.message} ${KBEngineLogCollector.PROTOCOL_WARNING}`.trim();
    }

    if (this.status === CollectorStatus.Connected) {
      return KBEngineLogCollector.PROTOCOL_WARNING;
    }

    return `尚未连接 KBEngine logger。${KBEngineLogCollector.PROTOCOL_WARNING}`;
  }

  getStatusSummary(): string {
    switch (this.status) {
      case CollectorStatus.Connected:
        return `已连接 ${this.config.host}:${this.config.port}，但 logger watcher 协议仍未完成适配`;
      case CollectorStatus.Connecting:
        return `正在连接 ${this.config.host}:${this.config.port}`;
      case CollectorStatus.Error:
        return this.getUnavailableReason();
      case CollectorStatus.Disconnected:
      default:
        return `未连接 ${this.config.host}:${this.config.port}；${KBEngineLogCollector.PROTOCOL_WARNING}`;
    }
  }

  dispose(): void {
    this.disconnect();
    this.outputChannel.dispose();
    this._onDidChangeStatus.dispose();
    this._onLogEntry.dispose();
    this._onError.dispose();
    void this.context;
  }

  private updateStatus(status: CollectorStatus): void {
    this.status = status;
    this._onDidChangeStatus.fire(this.status);
  }

  private pushLogEntry(entry: LogEntry): void {
    this.logEntries.push(entry);

    if (this.logEntries.length > this.config.maxBufferSize) {
      this.logEntries.splice(0, this.logEntries.length - this.config.maxBufferSize);
    }

    this._onLogEntry.fire(entry);
  }

  private sendDeregister(): void {
    if (!this.socket || this.socket.destroyed) {
      return;
    }

    const buffer = Buffer.alloc(4);
    buffer.writeUInt16LE(703, 0);
    buffer.writeUInt16LE(0, 2);
    this.socket.write(buffer);
  }

  private sendHeartbeat(): void {
    if (!this.socket || this.socket.destroyed) {
      return;
    }

    const buffer = Buffer.alloc(14);
    buffer.writeUInt16LE(701, 0);
    buffer.writeInt32LE(12, 2);
    this.socket.write(buffer);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, 1000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.config.autoReconnect || this.reconnectTimer || this.isManualDisconnect) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        // connect() 内部已经记录错误并在 close/error 中继续重试
      });
    }, this.config.reconnectInterval);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private disposeSocket(): void {
    if (!this.socket) {
      return;
    }

    this.socket.removeAllListeners();
    this.socket.destroy();
    this.socket = null;
  }

  private getDefaultUid(): number {
    if (typeof process.getuid === 'function') {
      return process.getuid();
    }

    const envUid = process.env.uid || process.env.UID;
    const parsed = envUid ? Number(envUid) : NaN;
    return Number.isFinite(parsed) ? parsed : -1;
  }
}
