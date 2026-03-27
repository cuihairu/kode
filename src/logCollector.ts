import * as vscode from 'vscode';
import * as net from 'net';
import { LogEntry, LogLevel } from './logParser';
import { LogParser } from './logParser';

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
    if (this.status === CollectorStatus.Connecting || this.status === CollectorStatus.Connected) {
      return;
    }

    this.isManualDisconnect = false;
    this.clearReconnectTimer();
    this.disposeSocket();
    this.receiveBuffer = Buffer.alloc(0);
    this.lastError = null;
    this.updateStatus(CollectorStatus.Connecting);

    await new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;

      socket.setKeepAlive(true);

      socket.once('connect', () => {
        this.socket = socket;
        this.registerToLogger();
        this.startHeartbeat();
        this.updateStatus(CollectorStatus.Connected);
        this.outputChannel.appendLine(
          `[INFO] 已连接 KBEngine logger (${this.config.host}:${this.config.port})`
        );

        settled = true;
        resolve();
      });

      socket.on('data', data => {
        this.handleData(data);
      });

      socket.on('error', error => {
        this.lastError = error;
        this.outputChannel.appendLine(`[ERROR] ${error.message}`);
        this._onError.fire(error);

        if (!settled) {
          settled = true;
          this.updateStatus(CollectorStatus.Error);
          reject(error);
          return;
        }

        this.updateStatus(CollectorStatus.Error);
      });

      socket.on('close', hadError => {
        this.stopHeartbeat();
        this.socket = null;

        if (!this.isManualDisconnect) {
          this.updateStatus(hadError || this.lastError ? CollectorStatus.Error : CollectorStatus.Disconnected);
          this.scheduleReconnect();
          return;
        }

        this.updateStatus(CollectorStatus.Disconnected);
      });

      socket.connect(this.config.port, this.config.host);
    });
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

  searchLogs(keyword: string, useRegex: boolean = false): LogEntry[] {
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
      return this.lastError.message;
    }

    if (this.status === CollectorStatus.Connected) {
      return '';
    }

    return '尚未连接 KBEngine logger。';
  }

  getStatusSummary(): string {
    switch (this.status) {
      case CollectorStatus.Connected:
        return `已连接 ${this.config.host}:${this.config.port}`;
      case CollectorStatus.Connecting:
        return `正在连接 ${this.config.host}:${this.config.port}`;
      case CollectorStatus.Error:
        return this.lastError?.message || '日志连接失败';
      case CollectorStatus.Disconnected:
      default:
        return `未连接 ${this.config.host}:${this.config.port}`;
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

  private handleData(data: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    while (this.receiveBuffer.length >= 4) {
      const messageId = this.receiveBuffer.readUInt16LE(0);
      const bodyLength = this.receiveBuffer.readUInt16LE(2);
      const frameLength = 4 + bodyLength;

      if (this.receiveBuffer.length < frameLength) {
        return;
      }

      const body = this.receiveBuffer.subarray(4, frameLength);
      this.receiveBuffer = this.receiveBuffer.subarray(frameLength);

      if (messageId !== 65501) {
        this.outputChannel.appendLine(
          `[WARN] 收到未处理的 logger 消息: id=${messageId}, len=${bodyLength}`
        );
        continue;
      }

      if (body.length < 4) {
        continue;
      }

      const logLength = body.readUInt32LE(0);
      if (body.length < 4 + logLength) {
        continue;
      }

      const text = body.toString('utf8', 4, 4 + logLength);
      const entries = LogParser.parseBatch(text);
      for (const entry of entries) {
        this.pushLogEntry(entry);
      }
    }
  }

  private pushLogEntry(entry: LogEntry): void {
    this.logEntries.push(entry);

    if (this.logEntries.length > this.config.maxBufferSize) {
      this.logEntries.splice(0, this.logEntries.length - this.config.maxBufferSize);
    }

    this._onLogEntry.fire(entry);
  }

  private registerToLogger(): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }

    const componentCount = 14;
    const bodyLength = 4 + 4 + 4 + 4 + 1 + 1 + 1 + componentCount * 4 + 1 + 1;
    const buffer = Buffer.alloc(4 + bodyLength);
    let offset = 0;

    buffer.writeUInt16LE(702, offset);
    offset += 2;
    buffer.writeUInt16LE(bodyLength, offset);
    offset += 2;

    buffer.writeInt32LE(this.getDefaultUid(), offset);
    offset += 4;
    buffer.writeUInt32LE(0xffffffff, offset);
    offset += 4;
    buffer.writeInt32LE(0, offset);
    offset += 4;
    buffer.writeInt32LE(0, offset);
    offset += 4;

    buffer.writeUInt8(0, offset++);
    buffer.writeUInt8(0, offset++);
    buffer.writeUInt8(componentCount, offset++);

    for (let i = 0; i < componentCount; i++) {
      buffer.writeInt32LE(i, offset);
      offset += 4;
    }

    buffer.writeUInt8(0, offset++);
    buffer.writeUInt8(1, offset++);

    socket.write(buffer);
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
