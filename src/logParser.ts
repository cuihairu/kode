/**
 * KBEngine 日志解析器
 * 解析 KBEngine logger 发送的日志格式
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
      const trimmed = data.trimEnd();

      // KBEngine logger.cpp 组装格式:
      // "   INFO dbmgr01 1000 12345 [2026-03-26 18:21:11 001] - message"
      const kbengineMatch = trimmed.match(
        /^\s*([A-Z_]+)\s+([a-z_]+?)(\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+\[(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{1,3})\]\s+-\s+([\s\S]*)$/i
      );

      if (kbengineMatch) {
        const [, levelStr, component, , , , , year, month, day, hour, minute, second, ms, message] =
          kbengineMatch;

        return {
          id: ++this.nextId,
          timestamp: new Date(
            Number(year),
            Number(month) - 1,
            Number(day),
            Number(hour),
            Number(minute),
            Number(second),
            Number(ms)
          ),
          component: component.toLowerCase(),
          level: this.parseLogLevel(levelStr),
          type: this.parseLogType(levelStr),
          message: message.trim(),
          raw: data
        };
      }

      const standardMatch = trimmed.match(
        /^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s*\[([A-Z_]+)\]\s*(?:\[([^\]]+)\])?\s*(.+)$/
      );

      if (standardMatch) {
        const [, timestamp, levelStr, component, message] = standardMatch;

        return {
          id: ++this.nextId,
          timestamp: new Date(timestamp),
          component: (component || 'unknown').toLowerCase(),
          level: this.parseLogLevel(levelStr),
          type: this.parseLogType(levelStr),
          message: message.trim(),
          raw: data
        };
      }

      return this.parseNonStandardFormat(trimmed);
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
      buffer.readUInt32LE(offset);
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
      case 'S_DBG':
        return LogLevel.DEBUG;
      case 'INFO':
      case 'PRINT':
      case 'S_INFO':
      case 'S_NORM':
        return LogLevel.INFO;
      case 'WARNING':
      case 'WARN':
      case 'S_WARN':
        return LogLevel.WARNING;
      case 'ERROR':
      case 'S_ERR':
        return LogLevel.ERROR;
      case 'CRITICAL':
      case 'FATAL':
        return LogLevel.CRITICAL;
      default:
        return LogLevel.INFO;
    }
  }

  private static parseLogType(levelStr: string): LogType {
    return levelStr.toUpperCase().startsWith('S_')
      ? LogType.LOG_TYPE_SCRIPT
      : LogType.LOG_TYPE_NORMAL;
  }

  /**
   * 解析非标准格式的日志
   */
  private static parseNonStandardFormat(data: string): LogEntry {
    // 简单的启发式解析
    const now = new Date();
    let level = LogLevel.INFO;
    let component = 'unknown';
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
    const componentMatch = data.match(/\b(machine|logger|dbmgr|baseappmgr|cellappmgr|loginapp|baseapp|cellapp|bots|interfaces|client)\d*\b/i);
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
