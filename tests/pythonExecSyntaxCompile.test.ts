import type { PythonExecService } from '../src/backend/pythonExecService';
import { createExecServiceCompile } from '../src/backend/pythonExecSyntaxCompile';
import { describe, expect, it } from 'vitest';

/**
 * RUST-002 判据③ 纯核：常驻执行服务 → 热更语法闸 compile 面的适配。
 * 两路失败语义必须分开——这是闸门 fail-open 语义的根。
 */

const stubService = (next: () => Partial<import('../src/backend/pythonExecService').PythonExecOutcome>): PythonExecService => ({
  runCompile: async () => next(),
  dispose: () => undefined,
  pid: () => 1,
  pendingCount: () => 0
} as unknown as PythonExecService);

/** 共享游标:服务重建后继续同一序列,不复读首帧 */
const make = (outcomes: Array<Partial<import('../src/backend/pythonExecService').PythonExecOutcome>>): {
  handle: ReturnType<typeof createExecServiceCompile>;
  info: () => { created: number; disposed: number };
} => {
  let cursor = 0;
  let created = 0;
  let disposed = 0;
  const handle = createExecServiceCompile({
    resolveInterpreter: () => '/usr/bin/python3',
    createService: () => {
      created += 1;
      return {
        runCompile: async () => outcomes[cursor++] ?? { ok: true },
        dispose: () => { disposed += 1; },
        pid: () => 1,
        pendingCount: () => 0
      } as unknown as PythonExecService;
    }
  });
  return { handle, info: () => ({ created, disposed }) };
};

describe('pythonExecSyntaxCompile(RUST-002 执行服务适配核)', () => {
  it('成功判定透传 ok:true', async () => {
    const { handle } = make([{ ok: true }]);
    expect(await handle.compile('x = 1\n')).toEqual({ ok: true });
    handle.dispose();
  });

  it('真语法错误 resolve ok:false 带错误行,且不拆服务', async () => {
    const { handle, info } = make([{ ok: false, error: 'SyntaxError: bad' }]);
    const verdict = await handle.compile('def f(:\n');
    expect(verdict).toEqual({ ok: false, errors: ['SyntaxError: bad'] });
    // 语法错误不是故障:服务不得被拆
    expect(handle.service() !== null).toBe(true);
    expect(info().created).toBe(1);
    handle.dispose();
  });

  it('执行服务故障 reject(闸门据此 fail-open),并拆掉重建', async () => {
    const { handle, info } = make([
      { ok: false, error: '解释器进程退出(1)', infra: true },
      { ok: true }
    ]);
    await expect(handle.compile('z = 1\n')).rejects.toThrow(/退出/);
    // 故障后服务已拆并重建(下一次 compile 换新句柄)
    expect(handle.service()).toBeNull();
    expect(await handle.compile('ok = 1\n')).toEqual({ ok: true });
    expect(info().created).toBe(2);
    handle.dispose();
  });

  it('解释器解析不到时 reject(不假装成功)', async () => {
    const handle = createExecServiceCompile({
      resolveInterpreter: () => null,
      createService: () => stubService([])
    });
    await expect(handle.compile('q = 1\n')).rejects.toThrow(/解析不到/);
    expect(handle.service()).toBeNull();
    handle.dispose();
  });

  it('懒创建:首次 compile 前不起服务;dispose 后不再建', async () => {
    const { handle, info } = make([]);
    expect(handle.service()).toBeNull();
    await handle.compile('a = 1\n');
    expect(info().created).toBe(1);
    handle.dispose();
    expect(handle.service()).toBeNull();
  });
});