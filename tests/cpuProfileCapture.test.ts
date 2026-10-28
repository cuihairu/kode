import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  isCpuProfileRunning,
  resetCpuProfileCapture,
  setCpuProfileDirectory,
  setCpuProfileSessionFactory,
  startCpuProfile,
  stopCpuProfile,
  type CpuProfilerSessionLike
} from '../src/cpuProfileCapture';

// IDE-MET-007:扩展宿主 CPU profile 采集入口。验收口径:从卡顿触发到
// profile 落盘可复现——start/stop 命令化,产物 .cpuprofile + 同名
// .window.txt(窗口起止 ISO+时长+语言服务指标快照)把 profile 关联到
// 请求窗口。inspector 会话可注入:测试用假会话锁生命周期与落盘面,
// 不依赖活体 profiler 的时序抖动。

interface RecordedCall {
  method: string;
}

/** 假 Profiler 会话:enable/setSamplingInterval/start 回空,stop 回固定 profile */
class FakeProfilerSession implements CpuProfilerSessionLike {
  readonly calls: RecordedCall[] = [];
  connected = false;
  disconnected = false;
  failOn: string | null = null;

  connect(): void {
    this.connected = true;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  post(
    method: string,
    params?: object,
    callback?: (err: Error | null, result?: { profile?: unknown }) => void
  ): void {
    this.calls.push({ method });
    const done = callback ?? ((): void => undefined);
    if (this.failOn === method) {
      done(new Error(`injected failure on ${method}`));
      return;
    }
    if (method === 'Profiler.stop') {
      done(null, {
        profile: {
          nodeId: 1,
          nodes: [{ id: 1, callFrame: { functionName: 'root' }, hitCount: 0, children: [] }],
          samples: [1],
          timeDeltas: [100],
          startTime: 1,
          endTime: 2
        }
      });
      return;
    }
    done(null, undefined);
  }
}

describe('CPU profile 采集入口(IDE-MET-007)', () => {
  it('完整生命周期:start→落盘 profile+窗口 sidecar→stop 幂等', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cpuprof-'));
    const session = new FakeProfilerSession();
    resetCpuProfileCapture();
    setCpuProfileDirectory(dir);
    setCpuProfileSessionFactory(() => session);

    expect(isCpuProfileRunning()).toBe(false);
    expect(await startCpuProfile(), '首次 start 应成功').toBe(true);
    expect(session.connected).toBe(true);
    expect(session.calls.map(call => call.method)).toContain('Profiler.enable');
    expect(session.calls.map(call => call.method)).toContain('Profiler.start');
    expect(isCpuProfileRunning()).toBe(true);
    expect(await startCpuProfile(), '重复 start 拒绝,不重连新会话').toBe(false);

    // 制造一点窗口时长(卡顿窗口的替身)
    await new Promise(resolve => setTimeout(resolve, 25));
    const result = await stopCpuProfile();
    expect(result, 'stop 应返回产物路径').not.toBeNull();
    expect(session.disconnected).toBe(true);
    expect(isCpuProfileRunning()).toBe(false);

    const profile = JSON.parse(fs.readFileSync(result!.profilePath, 'utf8')) as {
      nodes: unknown[];
    };
    expect(Array.isArray(profile.nodes), 'cpuprofile 应含 nodes 数组').toBe(true);
    expect(profile.nodes.length).toBeGreaterThan(0);
    expect(result!.profilePath.endsWith('.cpuprofile')).toBe(true);

    const sidecar = fs.readFileSync(result!.windowPath, 'utf8');
    expect(sidecar).toContain('kode cpu profile window');
    expect(sidecar).toMatch(/start: \d{4}-\d{2}-\d{2}T/);
    expect(sidecar).toMatch(/end: \d{4}-\d{2}-\d{2}T/);
    expect(sidecar).toMatch(/duration: \d+ms/);
    expect(sidecar, '窗口关联语言服务指标快照').toContain('language service metrics');
    // 再 stop(未运行)→ null,不得产出半截文件
    expect(await stopCpuProfile()).toBeNull();
  });

  it('start 失败如实返回 false,不留运行态', async () => {
    const session = new FakeProfilerSession();
    session.failOn = 'Profiler.start';
    resetCpuProfileCapture();
    setCpuProfileSessionFactory(() => session);
    expect(await startCpuProfile()).toBe(false);
    expect(isCpuProfileRunning()).toBe(false);
    expect(session.disconnected, '失败也要断开会话').toBe(true);
    expect(await stopCpuProfile()).toBeNull();
    resetCpuProfileCapture();
  });

  it('未配置目录时回落系统临时目录,落盘不失败', async () => {
    const session = new FakeProfilerSession();
    resetCpuProfileCapture();
    setCpuProfileSessionFactory(() => session);
    // 不调 setCpuProfileDirectory(上一例的目录也被 reset 清掉)
    expect(await startCpuProfile()).toBe(true);
    const result = await stopCpuProfile();
    expect(result).not.toBeNull();
    expect(fs.existsSync(result!.profilePath)).toBe(true);
    resetCpuProfileCapture();
  });
});
