/**
 * KBEngine 日志收集器
 * 连接到 KBEngine logger.exe 并收集日志
 */

import * as net from 'net';
import * as vscode from 'vscode';
import { LogParser, LogEntry, LogLevel } from './logParser';

/**
 * 日志收集器配置
 */
export interface LogCollectorConfig {
  host: string;
  port: number;
  autoReconnect: boolean;
  reconnectInterval: number;
  maxBufferSize: number;
}

/**
 * 日志收集器状态
 */
export enum CollectorStatus {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Error = 'error'
}

/**
 * KBEngine 日志收集器
 * 连接到 logger.exe (默认端口 20022) 并收集所有组件的日志
 */
export class KBEngineLogCollector {
  private socket: net.Socket | null = null;
  private status: CollectorStatus = CollectorStatus.Disconnected;
  private buffer: Buffer = Buffer.alloc(0);
  private reconnectTimer: NodeJS.Timeout | null = null;

  private _onDidChangeStatus = new vscode.EventEmitter<CollectorStatus>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private _onLogEntry = new vscode.EventEmitter<LogEntry>();
  readonly onLogEntry = this._onLogEntry.event;

  private _onError = new vscode.EventEmitter<Error>();
  readonly onError = this._onError.event;

  private logEntries: LogEntry[] = [];
  private outputChannel: vscode.OutputChannel;

  constructor(
    private config: LogCollectorConfig,
    private context: vscode.ExtensionContext
  ) {
    this.outputChannel = vscode.window.createOutputChannel('KBEngine Logs');
  }

  /**
   * 连接到 logger.exe
   */
  async connect(): Promise<void> {
    if (this.status === CollectorStatus.Connected || this.status === CollectorStatus.Connecting) {
      return;
    }

    this.status = CollectorStatus.Connecting;
    this._onDidChangeStatus.fire(this.status);

    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      this.socket.on('connect', () => {
        this.status = CollectorStatus.Connected;
        this._onDidChangeStatus.fire(this.status);
        this.outputChannel.appendLine('[INFO] 已连接到 KBEngine Logger');
        vscode.window.showInformationMessage(`已连接到 KBEngine Logger (${this.config.host}:${this.config.port})`);
        resolve();
      });

      this.socket.on('data', (data: Buffer) => {
        this.handleData(data);
      });

      this.socket.on('error', (error: Error) => {
        this.status = CollectorStatus.Error;
        this._onDidChangeStatus.fire(this.status);
        this._onError.fire(error);
        this.outputChannel.appendLine(`[ERROR] Socket 错误: ${error.message}`);
        reject(error);
      });

      this.socket.on('close', () => {
        this.status = CollectorStatus.Disconnected;
        this._onDidChangeStatus.fire(this.status);
        this.outputChannel.appendLine('[INFO] 与 KBEngine Logger 的连接已关闭');

        if (this.config.autoReconnect) {
          this.scheduleReconnect();
        }
      });

      this.socket.connect(this.config.port, this.config.host);
    });
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.status = CollectorStatus.Disconnected;
    this._onDidChangeStatus.fire(this.status);
  }

  /**
   * 获取当前状态
   */
  getStatus(): CollectorStatus {
    return this.status;
  }

  /**
   * 获取所有收集的日志
   */
  getLogEntries(): LogEntry[] {
    return this.logEntries;
  }

  /**
   * 清空日志缓冲
   */
  clearLogs(): void {
    this.logEntries = [];
  }

  /**
   * 获取日志数量
   */
  getLogCount(): number {
    return this.logEntries.length;
  }

  /**
   * 按级别过滤日志
   */
  getLogsByLevel(level: LogLevel): LogEntry[] {
    return this.logEntries.filter(entry => entry.level === level);
  }

  /**
   * 按组件过滤日志
   */
  getLogsByComponent(component: string): LogEntry[] {
    return this.logEntries.filter(entry => entry.component === component);
  }

  /**
   * 搜索日志
   */
  searchLogs(keyword: string, useRegex: boolean = false): LogEntry[] {
    if (useRegex) {
      try {
        const regex = new RegExp(keyword, 'i');
        return this.logEntries.filter(entry => regex.test(entry.message));
      } catch (error) {
        return [];
      }
    } else {
      return this.logEntries.filter(entry =>
        entry.message.toLowerCase().includes(keyword.toLowerCase())
      );
    }
  }

  /**
   * 处理接收到的数据
   */
  private handleData(data: Buffer): void {
    // 将新数据添加到缓冲区
    this.buffer = Buffer.concat([this.buffer, data]);

    // 尝试解析日志条目
    this.parseBuffer();

    // 防止缓冲区无限增长
    if (this.buffer.length > this.config.maxBufferSize) {
      this.buffer = this.buffer.slice(-this.config.maxBufferSize);
    }
  }

  /**
   * 解析缓冲区中的数据
   */
  private parseBuffer(): void {
    // KBEngine logger 发送的可能是文本或二进制格式
    // 这里假设是文本格式（每行一条日志）
    const dataStr = this.buffer.toString('utf8');
    const lines = dataStr.split(/\r?\n/);

    // 找到最后一个完整的行
    let lastCompleteLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) {
        lastCompleteLine = i;
      }
    }

    // 处理完整的行
    for (let i = 0; i <= lastCompleteLine; i++) {
      const line = lines[i].trim();
      if (line) {
        const entry = LogParser.parseLoggerMessage(line);
        if (entry) {
          this.addLogEntry(entry);
        }
      }
    }

    // 保留未完成的部分
    if (lastCompleteLine < lines.length - 1) {
      const remainingLines = lines.slice(lastCompleteLine + 1);
      this.buffer = Buffer.from(remainingLines.join('\n'));
    } else {
      this.buffer = Buffer.alloc(0);
    }
  }

  /**
   * 添加日志条目
   */
  private addLogEntry(entry: LogEntry): void {
    this.logEntries.push(entry);

    // 触发事件
    this._onLogEntry.fire(entry);

    // 同时输出到输出通道
    const formatted = LogParser.formatLogEntry(entry);
    this.outputChannel.appendLine(formatted);

    // 维护缓冲区大小
    if (this.logEntries.length > this.config.maxBufferSize) {
      this.logEntries.shift();
    }
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(error => {
        console.error('重连失败:', error);
      });
    }, this.config.reconnectInterval);
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.disconnect();
    this.outputChannel.dispose();
    this._onDidChangeStatus.dispose();
    this._onLogEntry.dispose();
    this._onError.dispose();
  }
}
