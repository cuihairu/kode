import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';

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
  /** 单轮 poll 读取总量上限(AUD-024):突增按有限总量拆多轮让出,非一次吃全量。 */
  maxPollBytesPerRound?: number;
  /** 单轮 poll 同步阻塞时间片(AUD-024):到点即中断循环,让宿主心跳可走。 */
  pollTimeSliceMs?: number;
  /** 上游 pending 事件数上限(AUD-025):快生产慢消费时超限丢弃最旧。 */
  maxPendingEvents?: number;
  /** 上游 pending 字节上限(AUD-025):与事件数双限额,先超先丢。 */
  maxPendingBytes?: number;
}

const DEFAULT_CAPACITY = 10000;
const DEFAULT_FLUSH_INTERVAL_MS = 40;
const DEFAULT_MAX_BATCH_BYTES = 128 * 1024;
const DEFAULT_DEDUPE_WINDOW_MS = 1000;
const DEFAULT_MAX_POLL_BYTES_PER_ROUND = 64 * 1024;
const DEFAULT_POLL_TIME_SLICE_MS = 25;
const DEFAULT_MAX_PENDING_EVENTS = 10000;
const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** 文件监控单批读取上限(IDE-RES-005):日志突增时分批读,不一次分配等于
 *  全部增量的 Buffer;批边界可能切在行中间,未换行尾巴拼进下一批。 */
const MAX_READ_CHUNK_BYTES = 1024 * 1024;

/** 文件监控 poll 量规(AUD-024):单轮最大连续阻塞与轮数,测试面可读。 */
export interface LogPollGauge {
  polls: number;
  maxPollMs: number;
  lastPollMs: number;
}

export function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

interface FileWatcherState {
  offset: number;
  timer?: NodeJS.Timeout;
  /** 行尾跨块尾巴:非末批把未换行行拼进下一批。 */
  partialLine: string;
  /** UTF-8 跨块解码器(AUD-024):多字节字符被读界切开时保留不完整字节。 */
  decoder: StringDecoder;
}

export class LogHub implements LogHubLike {
  private readonly pending: LogEvent[] = [];
  private readonly retained: LogEvent[] = [];
  private readonly recentOrigins = new Map<string, { timestamp: number; event: LogEvent }>();
  private readonly fileWatchers = new Map<string, FileWatcherState>();
  private readonly events = new EventEmitter();
  private readonly capacity: number;
  private readonly flushIntervalMs: number;
  private readonly maxBatchBytes: number;
  private readonly dedupeWindowMs: number;
  private readonly maxPollBytesPerRound: number;
  private readonly pollTimeSliceMs: number;
  private readonly maxPendingEvents: number;
  private readonly maxPendingBytes: number;
  private readonly pollGauge: LogPollGauge = { polls: 0, maxPollMs: 0, lastPollMs: 0 };
  private dropped = 0;
  private pendingBytes = 0;
  private pendingDropped = 0;
  private flushTimer?: NodeJS.Timeout;

  constructor(options: LogHubOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.maxPollBytesPerRound = options.maxPollBytesPerRound ?? DEFAULT_MAX_POLL_BYTES_PER_ROUND;
    this.pollTimeSliceMs = options.pollTimeSliceMs ?? DEFAULT_POLL_TIME_SLICE_MS;
    this.maxPendingEvents = options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS;
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
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
    this.pendingBytes += event.text.length;
    this.retained.push(event);
    if (this.retained.length > this.capacity) {
      this.dropped += this.retained.length - this.capacity;
      this.retained.splice(0, this.retained.length - this.capacity);
    }
    // 上游 pending 双限额(AUD-025):快生产慢消费时 pending 不得无限增,
    // 超限丢弃最旧(shift 队首),丢计数与字节一并记账,量规可读。
    // retained 不受影响:历史缓冲仍保 capacity 条,只是未 flush 队列被裁剪。
    while (this.pending.length > this.maxPendingEvents || this.pendingBytes > this.maxPendingBytes) {
      const dropped = this.pending.shift() as LogEvent;
      this.pendingBytes -= dropped.text.length;
      this.pendingDropped += 1;
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
      this.pending.shift();
      this.pendingBytes -= eventBytes;
      events.push(event);
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

  /** 上游 pending 队列量规(AUD-025):未排干事件/字节与超限丢弃累计。 */
  getLogHubGaugeForTests(): { pending: number; pendingBytes: number; pendingDropped: number } {
    return { pending: this.pending.length, pendingBytes: this.pendingBytes, pendingDropped: this.pendingDropped };
  }

  clear(): void {
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.retained.length = 0;
    this.recentOrigins.clear();
    this.dropped = 0;
  }

  watchFile(component: string, filePath: string, pollIntervalMs = 200): void {
    const origin = `file:${filePath}`;
    if (this.fileWatchers.has(origin)) return;
    const watcher: FileWatcherState = { offset: 0, partialLine: '', decoder: new StringDecoder('utf8') };
    this.fileWatchers.set(origin, watcher);
    const poll = (): void => {
      const pollStart = Date.now();
      try {
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
            watcher.partialLine = '';
            watcher.decoder = new StringDecoder('utf8');
          }
          if (stat.size === watcher.offset) return;
          // 分批读取(IDE-RES-005)+单轮预算(AUD-024):分配峰值与增量总量解耦,
          // 且单轮读总字节 ≤maxPollBytesPerRound、同步阻塞 ≤pollTimeSliceMs;
          // 到预算/时间片即中断,offset 已推进,下一轮 interval 继续,无数据丢失。
          const buffer = Buffer.alloc(Math.min(
            MAX_READ_CHUNK_BYTES,
            stat.size - watcher.offset,
            this.maxPollBytesPerRound
          ));
          const descriptor = fs.openSync(filePath, 'r');
          try {
            let pollBytes = 0;
            for (;;) {
              const remaining = stat.size - watcher.offset;
              if (remaining <= 0) break;
              // 时间片到点即让出宿主(心跳可走),不整块读尽增量
              if (Date.now() - pollStart >= this.pollTimeSliceMs) break;
              const budgetRemaining = this.maxPollBytesPerRound - pollBytes;
              if (budgetRemaining <= 0) break;
              const read = fs.readSync(
                descriptor, buffer, 0, Math.min(buffer.length, remaining, budgetRemaining), watcher.offset
              );
              if (read <= 0) break;
              watcher.offset += read;
              pollBytes += read;
              const atEnd = watcher.offset >= stat.size;
              // StringDecoder 保留读界切开的多字节字符,toString 不再产生 �
              const text = watcher.decoder.write(buffer.subarray(0, read));
              const chunk = watcher.partialLine + text;
              watcher.partialLine = '';
              const lines = chunk.split('\n');
              const tail = lines.pop();
              // 批边界切在行中间:非末批把未换行尾巴拼进下一批;
              // 末批尾巴立即入(与旧一次读全量行为一致,文件末行不压缓存)
              if (!atEnd && tail !== undefined) {
                watcher.partialLine = tail;
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
      } finally {
        const elapsed = Date.now() - pollStart;
        this.pollGauge.polls += 1;
        this.pollGauge.lastPollMs = elapsed;
        this.pollGauge.maxPollMs = Math.max(this.pollGauge.maxPollMs, elapsed);
      }
    };
    watcher.timer = setInterval(poll, pollIntervalMs);
    watcher.timer.unref?.();
    poll();
  }

  getLogPollGaugeForTests(): LogPollGauge {
    return { ...this.pollGauge };
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.fileWatchers.forEach(({ timer }) => { if (timer) clearInterval(timer); });
    this.fileWatchers.clear();
    // 释放即排空(AUD-025):pending 队列与字节一并清零,取消/释放不残留。
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.events.removeAllListeners();
  }
}
