import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { EventEmitter } from 'events';

export enum RuntimeLogLevel {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3,
  CRITICAL = 4
}

export type LogSource = 'stdout' | 'stderr' | 'file' | 'process' | 'collector' | 'webview';

export interface LogEvent {
  id: string;
  timestamp: number;
  level: RuntimeLogLevel;
  source: LogSource;
  component: string;
  text: string;
  origin: string;
  line?: number;
  duplicateCount: number;
}

export interface LogInput {
  source: LogSource;
  component: string;
  text: string;
  level?: RuntimeLogLevel;
  origin?: string;
  line?: number;
  timestamp?: number;
}

export interface LogBatch {
  events: readonly LogEvent[];
  dropped: number;
  capacity: number;
}

export interface LogHubLike {
  stdout(input: LogInput): void;
  stderr(input: LogInput): void;
  info(input: LogInput): void;
  warning(input: LogInput): void;
  error(input: LogInput): void;
  flush?(): void;
}

export interface LogHubOptions {
  capacity?: number;
  flushIntervalMs?: number;
  maxListeners?: number;
  maxBatchBytes?: number;
  dedupeWindowMs?: number;
}

const DEFAULT_CAPACITY = 10000;
const DEFAULT_FLUSH_INTERVAL_MS = 40;
const DEFAULT_MAX_BATCH_BYTES = 128 * 1024;
const DEFAULT_DEDUPE_WINDOW_MS = 1000;

/** 文件监控单批读取上限(IDE-RES-005):日志突增时分批读,不一次分配等于
 *  全部增量的 Buffer;批边界可能切在行中间,未换行尾巴拼进下一批。 */
const MAX_READ_CHUNK_BYTES = 1024 * 1024;

export function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

export class LogHub implements LogHubLike {
  private readonly pending: LogEvent[] = [];
  private readonly retained: LogEvent[] = [];
  private readonly recentOrigins = new Map<string, { timestamp: number; event: LogEvent }>();
  private readonly fileWatchers = new Map<string, { offset: number; timer?: NodeJS.Timeout; partial: string }>();
  private readonly events = new EventEmitter();
  private readonly capacity: number;
  private readonly flushIntervalMs: number;
  private readonly maxBatchBytes: number;
  private readonly dedupeWindowMs: number;
  private dropped = 0;
  private flushTimer?: NodeJS.Timeout;

  constructor(options: LogHubOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.events.setMaxListeners(options.maxListeners ?? 64);
  }

  stdout(input: LogInput): void { this.ingest(input, RuntimeLogLevel.INFO); }
  stderr(input: LogInput): void { this.ingest(input, RuntimeLogLevel.ERROR); }
  info(input: LogInput): void { this.ingest(input, RuntimeLogLevel.INFO); }
  warning(input: LogInput): void { this.ingest(input, RuntimeLogLevel.WARNING); }
  error(input: LogInput): void { this.ingest(input, RuntimeLogLevel.ERROR); }

  ingest(input: LogInput, fallbackLevel?: RuntimeLogLevel): void {
    const text = normalizeText(input.text);
    if (!text) return;
    const origin = input.origin ?? `${input.source}:${input.component}`;
    const timestamp = input.timestamp ?? Date.now();
    const fingerprint = createHash('sha256').update(`${origin}\0${text}`).digest('hex');
    const recent = this.recentOrigins.get(fingerprint);
    const deduped = this.dedupeWindowMs > 0 && recent !== undefined &&
      timestamp - recent.timestamp < this.dedupeWindowMs;
    if (deduped && recent) {
      recent.event.duplicateCount += 1;
      this.scheduleFlush();
      return;
    }
    if (this.recentOrigins.size > this.capacity) {
      this.recentOrigins.delete(this.recentOrigins.keys().next().value as string);
    }
    const event: LogEvent = {
      id: randomUUID(),
      timestamp,
      level: input.level ?? fallbackLevel ?? RuntimeLogLevel.INFO,
      source: input.source,
      component: input.component,
      text,
      origin,
      line: input.line,
      duplicateCount: 1
    };
    this.recentOrigins.set(fingerprint, { timestamp, event });
    this.append(event);
  }

  private append(event: LogEvent): void {
    this.pending.push(event);
    this.retained.push(event);
    if (this.retained.length > this.capacity) {
      this.dropped += this.retained.length - this.capacity;
      this.retained.splice(0, this.retained.length - this.capacity);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  flush(): void {
    if (this.pending.length === 0) return;
    const events: LogEvent[] = [];
    let bytes = 0;
    while (this.pending.length > 0) {
      const event = this.pending[0];
      const eventBytes = event.text.length;
      if (events.length > 0 && bytes + eventBytes > this.maxBatchBytes) break;
      events.push(this.pending.shift() as LogEvent);
      bytes += eventBytes;
    }
    this.events.emit('batch', { events, dropped: this.dropped, capacity: this.capacity });
    if (this.pending.length > 0) this.scheduleFlush();
  }

  onBatch(listener: (batch: LogBatch) => void): () => void {
    this.events.on('batch', listener);
    return () => this.events.off('batch', listener);
  }

  getRetained(): readonly LogEvent[] {
    return this.retained;
  }

  clear(): void {
    this.pending.length = 0;
    this.retained.length = 0;
    this.recentOrigins.clear();
    this.dropped = 0;
  }

  watchFile(component: string, filePath: string, pollIntervalMs = 200): void {
    const origin = `file:${filePath}`;
    if (this.fileWatchers.has(origin)) return;
    const watcher: { offset: number; timer?: NodeJS.Timeout; partial: string } = { offset: 0, partial: '' };
    this.fileWatchers.set(origin, watcher);
    const poll = (): void => {
      let stat: import('fs').Stats;
      try {
        stat = fs.statSync(filePath);
      } catch (error) {
        this.ingest({
          source: 'file',
          component,
          text: `日志文件监控失败: ${error instanceof Error ? error.message : String(error)}`,
          origin: `${origin}:error`,
          level: RuntimeLogLevel.ERROR
        });
        return;
      }
      try {
        if (stat.size < watcher.offset) {
          watcher.offset = 0;
          watcher.partial = '';
        }
        if (stat.size === watcher.offset) return;
        // 分批读取(IDE-RES-005):循环内复用同一块 ≤上限的 buffer,
        // 分配峰值与增量总量解耦;读满 2.6MiB 突增也只占 1MiB。
        const buffer = Buffer.alloc(Math.min(MAX_READ_CHUNK_BYTES, stat.size - watcher.offset));
        const descriptor = fs.openSync(filePath, 'r');
        try {
          for (;;) {
            const remaining = stat.size - watcher.offset;
            if (remaining <= 0) break;
            const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), watcher.offset);
            if (read <= 0) break;
            watcher.offset += read;
            const atEnd = watcher.offset >= stat.size;
            const chunk = watcher.partial + buffer.toString('utf8', 0, read);
            watcher.partial = '';
            const lines = chunk.split('\n');
            const tail = lines.pop();
            // 批边界切在行中间:非末批把未换行尾巴拼进下一批;
            // 末批尾巴立即入(与旧一次读全量行为一致,文件末行不压缓存)
            if (!atEnd && tail !== undefined) {
              watcher.partial = tail;
            }
            lines.forEach((line, index) => {
              if (line.trim()) {
                this.ingest({
                  source: 'file',
                  component,
                  text: line,
                  origin,
                  level: RuntimeLogLevel.INFO,
                  line: index + 1
                });
              }
            });
            if (atEnd && tail !== undefined && tail.trim()) {
              this.ingest({
                source: 'file',
                component,
                text: tail,
                origin,
                level: RuntimeLogLevel.INFO,
                line: lines.length + 1
              });
            }
          }
        } finally {
          fs.closeSync(descriptor);
        }
      } catch (error) {
        this.ingest({
          source: 'file',
          component,
          text: `日志文件读取失败: ${error instanceof Error ? error.message : String(error)}`,
          origin: `${origin}:error`,
          level: RuntimeLogLevel.ERROR
        });
      }
    };
    watcher.timer = setInterval(poll, pollIntervalMs);
    watcher.timer.unref?.();
    poll();
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.fileWatchers.forEach(({ timer }) => { if (timer) clearInterval(timer); });
    this.fileWatchers.clear();
    this.events.removeAllListeners();
  }
}
