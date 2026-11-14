import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createPythonExecService, PYTHON_EXEC_SERVICE_SOURCE } from '../src/backend/pythonExecService';

/**
 * RUST-002 判据③：常驻 Python 执行服务的真子进程集成测试。
 * 真起解释器验帧协议（长度前缀 + FIFO 兑现 + 超时即拆 + 惰性重建），
 * 不用替身——协议错位在替身里查不出。
 *
 * PYTHON_EXEC_SERVICE_SKIP_TEST=1 时整体跳过（无 python3 的环境）。
 */
const SKIP = process.env.PYTHON_EXEC_SERVICE_SKIP_TEST === '1';

describe('pythonExecService(RUST-002 可复用执行服务)', () => {
  it('惰性 spawn:首调才起进程,常驻进程承载多条编译且 pid 不变', async () => {
    if (SKIP) { return; }
    const service = createPythonExecService();
    try {
      expect(service.pid()).toBe(0); // 未起:不预占进程
      const multiLine = 'def f(a, b):\n    return a + b\n\nclass C:\n    pass\n';
      const first = await service.runCompile({ content: multiLine });
      expect(first).toEqual({ ok: true });
      const pid = service.pid();
      expect(pid).toBeGreaterThan(0);
      expect(await service.runCompile({ content: 'x = 1\n' })).toEqual({ ok: true });
      expect(await service.runCompile({ content: 'y = 2\n' })).toEqual({ ok: true });
      // 同一进程承载三次编译:pid 不变、无残留排队
      expect(service.pid()).toBe(pid);
      expect(service.pendingCount()).toBe(0);
    } finally {
      service.dispose();
    }
  }, 20000);

  it('语法错误回 ok:false 带解释器错误行,服务继续可用', async () => {
    if (SKIP) { return; }
    const service = createPythonExecService();
    try {
      const bad = await service.runCompile({ content: 'def f(:\n    return\n' });
      expect(bad.ok).toBe(false);
      expect(bad.error).toBeTruthy();
      expect(bad.error).toContain('SyntaxError');
      // 判定错误不致死:紧接一条合法编译仍 ok,且进程未重建
      const pid = service.pid();
      expect(await service.runCompile({ content: 'y = 2\n' })).toEqual({ ok: true });
      expect(service.pid()).toBe(pid);
    } finally {
      service.dispose();
    }
  }, 20000);

  it('并发指令按 FIFO 全部兑现', async () => {
    if (SKIP) { return; }
    const service = createPythonExecService();
    try {
      const results = await Promise.all([
        service.runCompile({ content: 'a = 1\n' }),
        service.runCompile({ content: 'b = 2\n' }),
        service.runCompile({ content: 'c = 3\n' }),
        service.runCompile({ content: 'def g(:\n' })
      ]);
      expect(results[0]).toEqual({ ok: true });
      expect(results[1]).toEqual({ ok: true });
      expect(results[2]).toEqual({ ok: true });
      expect(results[3].ok).toBe(false);
      expect(service.pendingCount()).toBe(0);
    } finally {
      service.dispose();
    }
  }, 20000);

  it('超时即拆进程(不串帧),注入吞帧子进程精确复现', async () => {
    if (SKIP) { return; }
    const stdout = Readable.from(Buffer.from('10\n{"ready":1}\n'));
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        void chunk;
        cb(); // 收下帧但永不应答:模拟卡死
      }
    });
    const fake = {
      pid: 424242,
      stdout,
      stderr: Readable.from([]),
      stdin,
      killed: false,
      exitCode: null,
      signalCode: null,
      on: (): void => undefined,
      kill: (): boolean => true
    } as unknown as ChildProcessWithoutNullStreams;
    const tight = createPythonExecService({ timeoutMs: 30, spawn: () => fake });
    expect(tight.pid()).toBe(0); // 惰性:未起进程
    const first = await tight.runCompile({ content: 'z = 1\n' });
    expect(first.ok).toBe(false);
    expect(first.error).toContain('超时');
    // 超时后进程已拆:不留悬挂半开连接;假子进程 pid 曾真实在册
    expect(tight.pid()).toBe(0);
    expect(tight.pendingCount()).toBe(0);
    expect(fake.pid).toBe(424242);
    tight.dispose();
  }, 20000);

  it('dispose 后如实报已关闭,不假装成功', async () => {
    if (SKIP) { return; }
    const service = createPythonExecService();
    await service.runCompile({ content: 'w = 1\n' });
    expect(service.pid()).toBeGreaterThan(0);
    service.dispose();
    expect(service.pid()).toBe(0);
    const after = await service.runCompile({ content: 'r = 1\n' });
    expect(after.ok).toBe(false);
    expect(after.error).toContain('已关闭');
  }, 20000);

  it('握手失败(解释器 spawn 即失败)如实报未就绪,不悬挂', async () => {
    if (SKIP) { return; }
    let emitError: ((error: Error) => void) | undefined;
    const fake = {
      pid: 0,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
      killed: false,
      exitCode: null,
      signalCode: null,
      on: (event: string, listener: (arg: Error) => void): void => {
        if (event === 'error') { emitError = listener; }
      },
      kill: (): boolean => true
    } as unknown as ChildProcessWithoutNullStreams;
    const service = createPythonExecService({ spawn: () => fake });
    try {
      const probe = service.runCompile({ content: 'k = 1\n' });
      // 下一拍触发 spawn 失败
      await new Promise(resolve => setTimeout(resolve, 20));
      emitError?.(new Error('spawn kode-test ENOENT'));
      const outcome = await probe;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBeTruthy();
      expect(service.pendingCount()).toBe(0);
      expect(service.pid()).toBe(0);
    } finally {
      service.dispose();
    }
  }, 20000);

  it('执行器只编译不执行:源码里的副作用代码不运行', async () => {
    if (SKIP) { return; }
    // 若被执行,文件会留下痕迹——compile() 必须不运行它
    const marker = '/tmp/kode-exec-service-no-exec-marker';
    if (existsSync(marker)) { unlinkSync(marker); }
    const service = createPythonExecService();
    try {
      const outcome = await service.runCompile({
        content: `import os\nopen(${JSON.stringify(marker)}, 'w').close()\n`
      });
      expect(outcome).toEqual({ ok: true });
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (existsSync(marker)) { unlinkSync(marker); }
      service.dispose();
    }
  }, 20000);

  it('执行器源码自检:走 compile 路径且无 exec 调用', () => {
    expect(typeof PYTHON_EXEC_SERVICE_SOURCE).toBe('string');
    expect(PYTHON_EXEC_SERVICE_SOURCE).toContain('compile(source');
    expect(PYTHON_EXEC_SERVICE_SOURCE).not.toContain('exec(');
  });
});