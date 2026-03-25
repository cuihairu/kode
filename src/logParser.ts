/**
 * KBEngine 日志解析器
 * 解析 KBEngine logger.exe 发送的日志格式
 */

/**
 * 日志级别枚举
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3,
  CRITICAL = 4
}

/**
 * 日志类型（KBEngine 内部定义）
 */
export enum LogType {
  LOG_TYPE_NORMAL = 0,
  LOG_TYPE_SCRIPT = 1,
  LOG_TYPE_ASSERT = 2
}

/**
 * 日志条目接口
 */
export interface LogEntry {
  id: number;
  timestamp: Date;
  component: string;
  level: LogLevel;
  type: LogType;
  message: string;
  sourceLocation?: string;
  raw: string;
}

/**
 * KBEngine LOG_ITEM 结构（参考 KBEngine 源码）
 * kbe/src/lib/helper/debug_helper.h
 */
interface LogItemStruct {
  id: number;
  logType: number;
  componentType: number;
  severity: number;
  message: string;
  timestamp: number;
}

/**
 * 日志解析器类
 */
export class LogParser {
  private static nextId = 0;

  /**
   * 组件类型到名称的映射
   */
  private static readonly COMPONENT_NAMES: { [key: number]: string } = {
    1: 'machine',
    2: 'dbmgr',
    3: 'baseappmgr',
    4: 'cellappmgr',
    5: 'loginapp',
    6: 'baseapp',
    7: 'cellapp',
    8: 'client',
    9: 'bots',
    10: 'logger',
    11: 'interface',
    12: 'upload'
  };

  /**
   * 解析 logger 消息
   * @param data 从 logger 接收的原始数据
   * @returns 解析后的日志条目
   */
  static parseLoggerMessage(data: string): LogEntry | null {
    try {
      // logger 发送的格式通常是文本格式
      // 示例: [2024-03-25 14:30:00] [INFO] [component] message
      const regex = /^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s*\[([A-Z]+)\]\s*(?:\[([^\]]+)\])?\s*(.+)$/;

      const match = data.match(regex);
      if (!match) {
        // 如果不符合标准格式，尝试其他格式
        return this.parseNonStandardFormat(data);
      }

      const [, timestamp, levelStr, component, message] = match;

      return {
        id: ++this.nextId,
        timestamp: new Date(timestamp),
        component: component || 'unknown',
        level: this.parseLogLevel(levelStr),
        type: LogType.LOG_TYPE_NORMAL,
        message: message.trim(),
        raw: data
      };
    } catch (error) {
      console.error('Failed to parse log message:', error);
      return null;
    }
  }

  /**
   * 解析二进制格式的 LOG_ITEM
   * @param buffer 二进制数据
   * @returns 解析后的日志条目
   */
  static parseBinaryLogItem(buffer: Buffer): LogEntry | null {
    try {
      // 简化的二进制解析（实际需要根据 KBEngine 源码中的结构定义）
      let offset = 0;

      // 读取 ID (4 bytes)
      const id = buffer.readUInt32LE(offset);
      offset += 4;

      // 读取 logType (1 byte)
      const logType = buffer.readUInt8(offset);
      offset += 1;

      // 读取 componentType (1 byte)
      const componentType = buffer.readUInt8(offset);
      offset += 1;

      // 读取 severity (1 byte)
      const severity = buffer.readUInt8(offset);
      offset += 1;

      // 读取 timestamp (8 bytes)
      const timestamp = buffer.readDoubleLE(offset);
      offset += 8;

      // 读取消息长度 (4 bytes)
      const messageLength = buffer.readUInt32LE(offset);
      offset += 4;

      // 读取消息内容
      const message = buffer.toString('utf8', offset, offset + messageLength);

      return {
        id: ++this.nextId,
        timestamp: new Date(timestamp * 1000),
        component: this.COMPONENT_NAMES[componentType] || `component_${componentType}`,
        level: severity,
        type: logType,
        message,
        raw: buffer.toString('hex')
      };
    } catch (error) {
      console.error('Failed to parse binary log item:', error);
      return null;
    }
  }

  /**
   * 解析日志级别字符串
   */
  private static parseLogLevel(levelStr: string): LogLevel {
    switch (levelStr.toUpperCase()) {
      case 'DEBUG':
        return LogLevel.DEBUG;
      case 'INFO':
      case 'PRINT':
        return LogLevel.INFO;
      case 'WARNING':
      case 'WARN':
        return LogLevel.WARNING;
      case 'ERROR':
        return LogLevel.ERROR;
      case 'CRITICAL':
      case 'FATAL':
        return LogLevel.CRITICAL;
      default:
        return LogLevel.INFO;
    }
  }

  /**
   * 解析非标准格式的日志
   */
  private static parseNonStandardFormat(data: string): LogEntry {
    // 简单的启发式解析
    const now = new Date();
    let level = LogLevel.INFO;
    let component = 'unknown';
    let message = data;

    // 尝试检测日志级别
    const lowerData = data.toLowerCase();
    if (lowerData.includes('error') || lowerData.includes('failed')) {
      level = LogLevel.ERROR;
    } else if (lowerData.includes('warning') || lowerData.includes('warn')) {
      level = LogLevel.WARNING;
    } else if (lowerData.includes('critical') || lowerData.includes('fatal')) {
      level = LogLevel.CRITICAL;
    } else if (lowerData.includes('debug')) {
      level = LogLevel.DEBUG;
    }

    // 尝试提取组件名
    const componentMatch = data.match(/\[?(\w+app)\]?/i);
    if (componentMatch) {
      component = componentMatch[1].toLowerCase();
    }

    return {
      id: ++this.nextId,
      timestamp: now,
      component,
      level,
      type: LogType.LOG_TYPE_NORMAL,
      message: data.trim(),
      raw: data
    };
  }

  /**
   * 批量解析日志
   */
  static parseBatch(data: string): LogEntry[] {
    const entries: LogEntry[] = [];
    const lines = data.split(/\r?\n/);

    for (const line of lines) {
      if (line.trim()) {
        const entry = this.parseLoggerMessage(line);
        if (entry) {
          entries.push(entry);
        }
      }
    }

    return entries;
  }

  /**
   * 格式化日志条目为可读字符串
   */
  static formatLogEntry(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = LogLevel[entry.level].padEnd(8);
    const component = entry.component.padEnd(12);
    return `[${timestamp}] [${level}] [${component}] ${entry.message}`;
  }

  /**
   * 获取日志级别的显示名称
   */
  static getLevelName(level: LogLevel): string {
    return LogLevel[level];
  }

  /**
   * 获取日志级别的图标
   */
  static getLevelIcon(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG:
        return '🔍';
      case LogLevel.INFO:
        return 'ℹ️';
      case LogLevel.WARNING:
        return '⚠️';
      case LogLevel.ERROR:
        return '❌';
      case LogLevel.CRITICAL:
        return '🔥';
      default:
        return '📝';
    }
  }

  /**
   * 获取日志级别的颜色
   */
  static getLevelColor(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG:
        return '#888888';
      case LogLevel.INFO:
        return '#2196F3';
      case LogLevel.WARNING:
        return '#FF9800';
      case LogLevel.ERROR:
        return '#F44336';
      case LogLevel.CRITICAL:
        return '#D32F2F';
      default:
        return '#000000';
    }
  }
}
