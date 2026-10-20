import { createHash, randomUUID } from 'crypto';
import { EventEmitter } from 'events';

export enum RuntimeLogLevel {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3,
  CRITICAL = 4
}

export type LogSource = 'stdout' | 'stderr' | 'file' | 'process' | 'collector';

export interface LogEvent {
  id: string;
  timestamp: number;
  level: RuntimeLogLevel;
  source: LogSource;
  component: string;
  text: string;
  origin: string;
  line?: number;
}

export interface LogInput {
  source: LogSource;
  component: string;
  text: string;
  level?: RuntimeLogLevel;
  origin?: string;
  line?: number;
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
}

const DEFAULT_CAPACITY = 10000;
const DEFAULT_FLUSH_INTERVAL_MS = 40;
const DEFAULT_MAX_BATCH_BYTES = 128 * 1024;

export function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

export class LogHub implements LogHubLike {
  private readonly pending: LogEvent[] = [];
  private readonly retained: LogEvent[] = [];
  private readonly recentOrigins = new Map<string, string>();
  private readonly fileWatchers = new Map<string, { offset: number; timer?: NodeJS.Timeout }>();
  private readonly events = new EventEmitter();
  private readonly capacity: number;
  private readonly flushIntervalMs: number;
  private readonly maxBatchBytes: number;
  private dropped = 0;
  private flushTimer?: NodeJS.Timeout;

  constructor(options: LogHubOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
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
    const fingerprint = createHash('sha256').update(`${origin}\0${text}`).digest('hex');
    if (this.recentOrigins.has(fingerprint)) return;
    this.recentOrigins.set(fingerprint, fingerprint);
    if (this.recentOrigins.size > this.capacity) {
      this.recentOrigins.delete(this.recentOrigins.keys().next().value as string);
    }
    this.append({
      id: randomUUID(),
      timestamp: Date.now(),
      level: input.level ?? fallbackLevel ?? RuntimeLogLevel.INFO,
      source: input.source,
      component: input.component,
      text,
      origin,
      line: input.line
    });
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
    const fs = require('fs') as typeof import('fs');
    const origin = `file:${filePath}`;
    if (this.fileWatchers.has(origin)) return;
    const watcher: { offset: number; timer?: NodeJS.Timeout } = { offset: 0 };
    this.fileWatchers.set(origin, watcher);
    const poll = (): void => {
      let stat: import('fs').Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return;
      }
      if (stat.size < watcher.offset) watcher.offset = 0;
      if (stat.size === watcher.offset) return;
      const length = stat.size - watcher.offset;
      const buffer = Buffer.alloc(length);
      const descriptor = fs.openSync(filePath, 'r');
      try {
        const read = fs.readSync(descriptor, buffer, 0, length, watcher.offset);
        watcher.offset += read;
        const chunk = buffer.toString('utf8', 0, read);
        chunk.split('\n').forEach((line, index) => {
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
      } finally {
        fs.closeSync(descriptor);
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
