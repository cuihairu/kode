/**
 * KBEngine log parser
 * Parses the log format sent by the KBEngine logger
 */

/**
 * Log level enum
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3,
  CRITICAL = 4
}

/**
 * Log type (defined internally by KBEngine)
 */
export enum LogType {
  LOG_TYPE_NORMAL = 0,
  LOG_TYPE_SCRIPT = 1,
  LOG_TYPE_ASSERT = 2
}

/**
 * Log entry interface
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
 * Log parser class
 */
export class LogParser {
  private static nextId = 0;

  /**
   * Mapping from component type to name
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
   * Parse a logger message
   * @param data the raw data received from the logger
   * @returns the parsed log entry
   */
  static parseLoggerMessage(data: string): LogEntry | null {
    try {
      const trimmed = data.trimEnd();

      // The format assembled by KBEngine logger.cpp:
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
   * Parse a binary-format LOG_ITEM
   * @param buffer the binary data
   * @returns the parsed log entry
   */
  static parseBinaryLogItem(buffer: Buffer): LogEntry | null {
    try {
      // Simplified binary parsing (in reality it needs the structure definitions from the KBEngine source)
      let offset = 0;

      // Read the ID (4 bytes)
      buffer.readUInt32LE(offset);
      offset += 4;

      // Read logType (1 byte)
      const logType = buffer.readUInt8(offset);
      offset += 1;

      // Read componentType (1 byte)
      const componentType = buffer.readUInt8(offset);
      offset += 1;

      // Read severity (1 byte)
      const severity = buffer.readUInt8(offset);
      offset += 1;

      // Read the timestamp (8 bytes)
      const timestamp = buffer.readDoubleLE(offset);
      offset += 8;

      // Read the message length (4 bytes)
      const messageLength = buffer.readUInt32LE(offset);
      offset += 4;

      // Read the message body
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
   * Parse a log level string
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
   * Parse a non-standard-format log line
   */
  private static parseNonStandardFormat(data: string): LogEntry {
    // A simple heuristic parse
    const now = new Date();
    let level = LogLevel.INFO;
    let component = 'unknown';
    // Try to detect the log level
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

    // Try to extract the component name
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
   * Parse logs in bulk
   */
  static parseBatch(data: string): LogEntry[] {
    const entries: LogEntry[] = [];
    const lines = data.split(/\r?\n/);

    for (const line of lines) {
      if (line.trim()) {
        const entry = this.parseLoggerMessage(line);
        // Unreachable (determined in batch 71): parseLoggerMessage is total over any string
        // input (inside the try block there are only string methods, regex matching, Date
        // construction and Number() conversion of \d capture groups, none of which throw; the
        // only null path is the catch, and the catch is reachable only for a non-string
        // argument), while parseBatch feeds in the products of split(/\r?\n/) line by line,
        // always strings => the false arm of this null check has no triggering path. The branch
        // entry (including the already-covered true arm) moves out of the denominator with the
        // range, and the true arm's behaviour is pinned by the existing parseBatch cases.
        /* istanbul ignore start */
        if (entry) {
        /* istanbul ignore stop */
          entries.push(entry);
        }
      }
    }

    return entries;
  }

  /**
   * Format a log entry into a readable string
   */
  static formatLogEntry(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = LogLevel[entry.level].padEnd(8);
    const component = entry.component.padEnd(12);
    return `[${timestamp}] [${level}] [${component}] ${entry.message}`;
  }

  /**
   * Get the display name for a log level
   */
  static getLevelName(level: LogLevel): string {
    return LogLevel[level];
  }

  /**
   * Get the icon for a log level
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
   * Get the color for a log level
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
