// IDE-MET-007:扩展宿主 CPU profile 采集入口。验收口径:从卡顿触发到
// profile 落盘的步骤可复现——kbengine.metrics.startCpuProfile 开采,
// stopCpuProfile 停采并把 V8 CPU profile 写成 .cpuprofile;同名
// .window.txt 记录窗口起止 ISO 与时长,并列语言服务指标快照,把这份
// profile 关联到请求窗口(卡顿期间哪些操作在跑、延迟直方图什么样)。
// inspector 会话经工厂注入:生产=真 inspector.Session,测试=假会话锁
// 生命周期与落盘面,不依赖活体 profiler 的时序抖动。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import inspector from 'inspector';
import { getLanguageServiceSummaryReport } from './languageServiceMetrics';
import { getEventLoopDelayReport } from './hostVitals';

/** inspector 会话最小面(post 回调式,与 Node 原生同形,便于替身) */
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

/** 测试注入面:替换 inspector 会话工厂 */
export function setCpuProfileSessionFactory(factory: () => CpuProfilerSessionLike): void {
  sessionFactory = factory;
}

/** 落盘目录(生产=globalStorage;缺省回落系统临时目录) */
export function setCpuProfileDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  outputDirectory = directory;
}

export function isCpuProfileRunning(): boolean {
  return active !== null;
}

/** 开始采集;已在采/启动失败返回 false(失败时会话当场断开不留运行态) */
export async function startCpuProfile(): Promise<boolean> {
  if (active) {
    return false;
  }
  const session = sessionFactory();
  session.connect();
  try {
    await post(session, 'Profiler.enable');
    // 采样间隔 1000us:卡顿取证粒度足够,开销可忽略
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

/** 停止采集并落盘:.cpuprofile + .window.txt(窗口关联面);未在采返回 null */
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

/** 测试面:清运行态与注入(不动已落盘文件) */
export function resetCpuProfileCapture(): void {
  if (active) {
    active.session.disconnect();
    active = null;
  }
  sessionFactory = () => new inspector.Session();
  outputDirectory = null;
}
