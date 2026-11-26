// IDE-REV-037: annotation source log (acceptance criterion "the log names the
// source actually used") — when hover inference answers, it emits a [kode-annot]
// line recording "which source was used this time" (the hover-document bucket /
// the other-open-documents bucket / the on-disk annotation snapshot); stale
// misses and controlled rebuild triggers are logged the same way. Cost = one
// line per query. The kbengine.annotationLog switch defaults to off; when off,
// the first line returns immediately and the message is passed in as () => so
// no string concatenation happens (same contract as jumpLog). This module does
// not import vscode (aligned with pythonReturnTypeInference's no-vscode
// constraint): output-panel writing is provided by a sink injected at extension
// activation, and the ring buffer can be read directly by tests/forensics.
export type AnnotationLogLevel = 'info' | 'debug';

export type AnnotationLogSink = (line: string) => void;

const RECENT_LIMIT = 400;
const recentLines: string[] = [];
let enabled = false;
let sink: AnnotationLogSink | undefined;

export function getRecentAnnotationSourceLogs(): readonly string[] {
  return recentLines;
}

export function clearRecentAnnotationSourceLogs(): void {
  recentLines.length = 0;
}

/** Switch injection point: extension activation reads config, config changes refresh it; tests set it directly */
export function setAnnotationSourceLogEnabled(value: boolean): void {
  enabled = value;
}

export function isAnnotationSourceLogEnabled(): boolean {
  return enabled;
}

/** Output panel wiring: injected by the extension (channel created lazily); tests can inject their own line collector */
export function setAnnotationSourceLogSink(next: AnnotationLogSink | undefined): void {
  sink = next;
}

export function annotationSourceLog(
  level: AnnotationLogLevel,
  message: string | (() => string)
): void {
  if (!enabled) { return; }
  const text = typeof message === 'function' ? message() : message;
  const line = `[kode-annot][${level}] ${text}`;
  recentLines.push(line);
  if (recentLines.length > RECENT_LIMIT) { recentLines.shift(); }
  sink?.(line);
}
