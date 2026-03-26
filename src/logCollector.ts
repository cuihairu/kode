import * as vscode from 'vscode';
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
  private status: CollectorStatus = CollectorStatus.Disconnected;

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
    if (this.status === CollectorStatus.Connecting) {
      return;
    }

    this.status = CollectorStatus.Error;
    this._onDidChangeStatus.fire(this.status);

    const error = new Error(
      'KBEngine logger 使用内部 watcher 协议，当前扩展尚未实现注册握手和消息解码。'
    );

    this.outputChannel.appendLine(
      `[ERROR] ${error.message} (${this.config.host}:${this.config.port})`
    );
    this._onError.fire(error);
    throw error;
  }

  disconnect(): void {
    this.status = CollectorStatus.Disconnected;
    this._onDidChangeStatus.fire(this.status);
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
    return '未实现 KBEngine logger watcher 协议。';
  }

  dispose(): void {
    this.disconnect();
    this.outputChannel.dispose();
    this._onDidChangeStatus.dispose();
    this._onLogEntry.dispose();
    this._onError.dispose();
    void this.context;
  }
}
