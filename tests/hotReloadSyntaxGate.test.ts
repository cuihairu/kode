import { describe, expect, it } from 'vitest';
import { createPythonSyntaxGate } from '../src/backend/hotReloadSyntaxGate';

// HR-WATCH-012 语法闸装配核单测(纯内存替身,零 vscode):fail-open 语义钉死——
// 检查器自身故障(解释器解析不到/编译子进程异常)至多通知一次且放行不拦热更;
// 只有检查器明确报语法错误(ok=false)才原样透传给热更管线拦下。

describe('createPythonSyntaxGate 装配核(HR-WATCH-012 fail-open)', () => {
  it('解释器解析不到:创建即通知一次,闸放行(不拦热更)', () => {
    const unavailable: string[] = [];
    const check = createPythonSyntaxGate({
      resolveInterpreter: () => null,
      compile: async () => {
        throw new Error('不该走到编译面');
      },
      onUnavailable: (reason) => unavailable.push(reason)
    });
    expect(unavailable).toEqual(['解释器解析不到,检查器放行不拦热更']);
    expect(check('value = 1')).toEqual({ ok: true });
  });

  it('编译子进程异常(Error):通知含原因并放行;再次故障不重复通知', async () => {
    const unavailable: string[] = [];
    let failures = 0;
    const check = createPythonSyntaxGate({
      resolveInterpreter: () => '/usr/bin/python3',
      compile: async () => {
        failures += 1;
        if (failures <= 2) {
          throw new Error('boom');
        }
        return { ok: true };
      },
      onUnavailable: (reason) => unavailable.push(reason)
    });
    // 连续两次子进程故障:通知只发一次(至多一次),两次都放行。
    expect(await check('value = 1')).toEqual({ ok: true });
    expect(await check('value = 2')).toEqual({ ok: true });
    expect(unavailable).toEqual(['编译子进程故障(boom),检查器放行不拦热更']);
    // 恢复后正常透传(不再有通知)。
    expect(await check('value = 3')).toEqual({ ok: true });
    expect(unavailable).toHaveLength(1);
  });

  it('编译子进程异常(非 Error):String(error) 形态进通知', async () => {
    const unavailable: string[] = [];
    const check = createPythonSyntaxGate({
      resolveInterpreter: () => '/usr/bin/python3',
      compile: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain string failure';
      },
      onUnavailable: (reason) => unavailable.push(reason)
    });
    expect(await check('value = 1')).toEqual({ ok: true });
    expect(unavailable).toEqual(['编译子进程故障(plain string failure),检查器放行不拦热更']);
  });

  it('检查器明确报语法错误:原样透传(拦热更),不触发不可用通知', async () => {
    const unavailable: string[] = [];
    const verdict = { ok: false, errors: ['unterminated-string at line 1'] } as const;
    const check = createPythonSyntaxGate({
      resolveInterpreter: () => '/usr/bin/python3',
      compile: async () => verdict,
      onUnavailable: (reason) => unavailable.push(reason)
    });
    expect(await check("value = 'abc\n")).toEqual(verdict);
    expect(await check("value = 'abc\n")).toEqual(verdict);
    expect(unavailable).toHaveLength(0);
  });

  it('健康文件:编译结果原样透传(ok=true)', async () => {
    const check = createPythonSyntaxGate({
      resolveInterpreter: () => '/usr/bin/python3',
      compile: async (interpreter, content) => {
        expect(interpreter).toBe('/usr/bin/python3');
        expect(content).toBe('value = 1\n');
        return { ok: true };
      },
      onUnavailable: () => {
        throw new Error('健康路径不该通知');
      }
    });
    expect(await check('value = 1\n')).toEqual({ ok: true });
  });
});
