import { describe, expect, it } from 'vitest';
import {
  checkInterpreterDebugpy,
  debugpyPreflightAllowsInjection
} from '../src/debugpyPreflight';
import { debugpySyncSourceCandidates } from '../src/autoDebugpy';
import type { InterpreterResolution } from '../src/profileInterpreter';

// IDE-DBG-003 调试前解释器 debugpy 预检:注入消费的 debugpy 包由「所选
// 解释器」同步而来——注入前先在该解释器上探 debugpy(缺解释器/缺包/
// 版本过老各给可操作状态),不等注入阶段才在引擎里 Traceback 出未知
// 失败。资产树已同步过包时引擎导入不依赖本机解释器,照常放行。

const resolveWith = (resolution: InterpreterResolution) => (): InterpreterResolution => resolution;

describe('checkInterpreterDebugpy(注入前预检)', () => {
  const deps = (
    resolution: InterpreterResolution,
    probe: { stdout: string; exitCode: number | null }
  ) => ({
    resolveInterpreter: resolveWith(resolution),
    runInterpreterCode: async () => probe
  });

  it('解释器在位且 debugpy 版本达标:kind=ok,文案带路径与版本', async () => {
    const status = await checkInterpreterDebugpy(
      deps(
        { interpreterPath: '/opt/py/python3', interpreterSource: 'setting' },
        { stdout: '1.8.0\n', exitCode: 0 }
      )
    );

    expect(status.kind).toBe('ok');
    expect(status.interpreterPath).toBe('/opt/py/python3');
    expect(status.version).toBe('1.8.0');
    expect(status.message).toContain('/opt/py/python3');
    expect(status.message).toContain('1.8.0');
  });

  it('未找到所选解释器:kind=interpreter-missing,文案给设置键补救入口,不执行探测', async () => {
    let probeCalls = 0;
    const status = await checkInterpreterDebugpy({
      resolveInterpreter: resolveWith({ interpreterPath: null, interpreterSource: 'missing' }),
      runInterpreterCode: async () => {
        probeCalls += 1;
        return { stdout: '', exitCode: 0 };
      }
    });

    expect(status.kind).toBe('interpreter-missing');
    expect(probeCalls).toBe(0);
    expect(status.version).toBeNull();
    expect(status.message).toContain('kbengine.python.interpreterPath');
  });

  it('解释器在位但没有 debugpy:kind=debugpy-missing,文案给安装命令', async () => {
    const status = await checkInterpreterDebugpy(
      deps(
        { interpreterPath: '/opt/py/python3', interpreterSource: 'path' },
        { stdout: 'Traceback (most recent call last):\nModuleNotFoundError: No module named \'debugpy\'\n', exitCode: 1 }
      )
    );

    expect(status.kind).toBe('debugpy-missing');
    expect(status.version).toBeNull();
    expect(status.message).toContain('/opt/py/python3');
    expect(status.message).toContain('pip install');
  });

  it('版本过老:kind=debugpy-outdated,文案带两版本号', async () => {
    const status = await checkInterpreterDebugpy(
      deps(
        { interpreterPath: '/opt/py/python3', interpreterSource: 'path' },
        { stdout: '1.7.0\n', exitCode: 0 }
      )
    );

    expect(status.kind).toBe('debugpy-outdated');
    expect(status.version).toBe('1.7.0');
    expect(status.message).toContain('1.7.0');
    expect(status.message).toContain('1.8.0');
  });

  it('探测退出码 0 但输出无版本行:如实按缺包处理', async () => {
    const status = await checkInterpreterDebugpy(
      deps(
        { interpreterPath: '/opt/py/python3', interpreterSource: 'path' },
        { stdout: '\n\n', exitCode: 0 }
      )
    );

    expect(status.kind).toBe('debugpy-missing');
  });
});

describe('debugpyPreflightAllowsInjection(放行判定)', () => {
  const ok = { kind: 'ok' as const };
  const missing = { kind: 'debugpy-missing' as const };

  it('预检通过:无论资产树有没有包都放行', () => {
    expect(debugpyPreflightAllowsInjection(ok, false)).toBe(true);
    expect(debugpyPreflightAllowsInjection(ok, true)).toBe(true);
  });

  it('预检不过但资产树已同步包:放行(引擎导入的是资产树包,不依赖本机解释器)', () => {
    expect(debugpyPreflightAllowsInjection(missing, true)).toBe(true);
  });

  it('预检不过且资产树无包:拦下(注入必在引擎里 Traceback,提前给状态)', () => {
    expect(debugpyPreflightAllowsInjection(missing, false)).toBe(false);
  });
});

describe('debugpySyncSourceCandidates(同步源候选)', () => {
  it('所选解释器排第一,PATH 候选 python3/python 随后;缺失时不排', () => {
    expect(debugpySyncSourceCandidates('/opt/py/python3')).toEqual([
      '/opt/py/python3',
      'python3',
      'python'
    ]);
    expect(debugpySyncSourceCandidates(null)).toEqual(['python3', 'python']);
  });
});
