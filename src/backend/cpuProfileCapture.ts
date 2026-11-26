// IDE-MET-007: extension-host CPU profile capture entry point. Acceptance
// contract: the steps from stutter trigger to profile on disk are
// reproducible -- kbengine.metrics.startCpuProfile starts the capture,
// stopCpuProfile stops it and writes the V8 CPU profile as .cpuprofile;
// a same-stem .window.txt records the window start/end ISO timestamps and
// duration, plus a language-service metric snapshot, tying this profile
// to the request window (which operations ran during the stutter, what
// the latency histogram looks like).
// The inspector session is injected through a factory: production = a real
// inspector.Session, tests = a fake session pinning the lifecycle and the
// on-disk surface, without depending on live profiler timing jitter.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import inspector from 'inspector';
import { getLanguageServiceSummaryReport } from '../languageServiceMetrics';
import { getEventLoopDelayReport } from './hostVitals';

/** Minimal inspector session surface (post with callbacks; same shape as the Node native one, easy to stub) */
export interface CpuProfilerSessionLike {
  connect(): void;
  disconnect(): void;
  post(
    method: string,
    params?: object,
    callback?: (err: Error | null, result?: { profile?: unknown }) => void
  ): void;
}

export interface CpuProfileCaptureResult {
  profilePath: string;
  windowPath: string;
}

const post = <T>(session: CpuProfilerSessionLike, method: string, params?: object): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    session.post(method, params, (err: Error | null, result?: { profile?: unknown }) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(result as unknown as T);
    });
  });

let sessionFactory: () => CpuProfilerSessionLike = () => new inspector.Session();
let outputDirectory: string | null = null;

interface ActiveCapture {
  session: CpuProfilerSessionLike;
  startedAtMs: number;
  startedIso: string;
}

let active: ActiveCapture | null = null;

/** Test injection surface: replace the inspector session factory */
export function setCpuProfileSessionFactory(factory: () => CpuProfilerSessionLike): void {
  sessionFactory = factory;
}

/** Output directory (production = globalStorage; falls back to the system temp directory by default) */
export function setCpuProfileDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  outputDirectory = directory;
}

export function isCpuProfileRunning(): boolean {
  return active !== null;
}

/** Start capturing; returns false when already capturing or on start failure (on failure the session is disconnected immediately, leaving no running state) */
export async function startCpuProfile(): Promise<boolean> {
  if (active) {
    return false;
  }
  const session = sessionFactory();
  session.connect();
  try {
    await post(session, 'Profiler.enable');
    // Sampling interval 1000us: fine enough granularity for stutter forensics, negligible overhead
    await post(session, 'Profiler.setSamplingInterval', { interval: 1000 });
    await post(session, 'Profiler.start');
  } catch {
    session.disconnect();
    return false;
  }
  active = {
    session,
    startedAtMs: Date.now(),
    startedIso: new Date().toISOString()
  };
  return true;
}

const isoCompact = (date: Date): string =>
  date.toISOString().replace(/[:.]/g, '-');

/** Stop capturing and write to disk: .cpuprofile + .window.txt (window-correlation surface); returns null when not capturing */
export async function stopCpuProfile(): Promise<CpuProfileCaptureResult | null> {
  if (!active) {
    return null;
  }
  const capture = active;
  active = null;
  try {
    const stopped = await post<{ profile: unknown }>(capture.session, 'Profiler.stop');
    const directory = outputDirectory ?? os.tmpdir();
    fs.mkdirSync(directory, { recursive: true });
    const stem = path.join(directory, `kode-cpu-profile-${isoCompact(new Date())}`);
    const profilePath = `${stem}.cpuprofile`;
    const windowPath = `${stem}.window.txt`;
    const endedAtMs = Date.now();
    const endedIso = new Date().toISOString();
    fs.writeFileSync(profilePath, JSON.stringify(stopped.profile), 'utf8');
    const sidecar = [
      'kode cpu profile window',
      `start: ${capture.startedIso}`,
      `end: ${endedIso}`,
      `duration: ${endedAtMs - capture.startedAtMs}ms`,
      '---',
      getLanguageServiceSummaryReport(),
      getEventLoopDelayReport()
    ].join('\n');
    fs.writeFileSync(windowPath, sidecar, 'utf8');
    return { profilePath, windowPath };
  } finally {
    capture.session.disconnect();
  }
}

/** Test surface: clear runtime state and injections (does not touch files already written to disk) */
export function resetCpuProfileCapture(): void {
  if (active) {
    active.session.disconnect();
    active = null;
  }
  sessionFactory = () => new inspector.Session();
  outputDirectory = null;
}
