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
  /** Per-round poll total read limit (AUD-024): a burst is split into multiple yielding rounds of bounded total, not consumed in one go. */
  maxPollBytesPerRound?: number;
  /** Per-round poll synchronous-blocking time slice (AUD-024): the loop is interrupted when it expires so the host heartbeat can proceed. */
  pollTimeSliceMs?: number;
  /** Upstream pending event-count limit (AUD-025): with a fast producer and a slow consumer, the oldest is dropped once over the limit. */
  maxPendingEvents?: number;
  /** Upstream pending byte limit (AUD-025): a second limit alongside the event count; whichever trips first drops first. */
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

/** Per-batch read limit for file watching (IDE-RES-005): a log burst is read in batches rather
 *  than allocating a Buffer equal to the whole increment at once; a batch boundary may split a
 *  line, and a non-newline tail is joined into the next batch. */
const MAX_READ_CHUNK_BYTES = 1024 * 1024;

/** File-watch poll gauges (AUD-024): the max consecutive blocking and the round count per poll, readable on the test face. */
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
  /** Cross-chunk tail at end-of-line: a non-final batch joins the non-newline line into the next batch. */
  partialLine: string;
  /** Cross-chunk UTF-8 decoder (AUD-024): keeps incomplete bytes when a multibyte character is split by the read boundary. */
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
    // The upstream pending dual limits (AUD-025): pending must not grow without bound with a
    // fast producer and a slow consumer; once over the limit the oldest is dropped (shift off
    // the queue head), with the drop count and bytes both booked so the gauges stay readable.
    // retained is unaffected: the history buffer still keeps capacity entries; only the
    // not-yet-flushed queue is trimmed.
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

  /** Upstream pending-queue gauge (AUD-025): undrained events/bytes plus the cumulative over-limit drops. */
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
          // Batched reading (IDE-RES-005) + a per-round budget (AUD-024): the allocation peak is
          // decoupled from the increment's total size, and per round the total bytes read is
          // <= maxPollBytesPerRound and the synchronous blocking is <= pollTimeSliceMs;
          // interrupted when the budget/time slice expires, with offset already advanced, the
          // next interval round continuing, and no data lost.
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
              // Yield to the host as soon as the time slice expires (the heartbeat can proceed) rather than reading the whole increment in one block
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
              // StringDecoder keeps the multibyte characters split by the read boundary, so toString no longer produces a replacement character
              const text = watcher.decoder.write(buffer.subarray(0, read));
              const chunk = watcher.partialLine + text;
              watcher.partialLine = '';
              const lines = chunk.split('\n');
              const tail = lines.pop();
              // The batch boundary can split a line: a non-final batch joins the non-newline tail
              // into the next batch;
              // the final batch's tail is ingested immediately (matching the old read-everything-in-
              // one-go behaviour, so the file's last line does not linger in a buffer)
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
    // Dispose drains everything (AUD-025): the pending queue and bytes are both cleared to zero, so cancel/dispose leaves nothing behind.
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.events.removeAllListeners();
  }
}
