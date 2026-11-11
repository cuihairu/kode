import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkInterpreterDebugpy,
  debugpyPreflightAllowsInjection,
  readAssetsDebugpyVersion,
  type DebugpyPreflightStatus
} from '../src/backend/debugpyPreflight';
import { debugpySyncSourceCandidates } from '../src/autoDebugpy';
import { PYTHON_TARGET_SETTING, type PythonTarget } from '../src/backend/pythonTarget';
import type { InterpreterResolution } from '../src/profileInterpreter';

// IDE-DBG-003 调试前解释器 debugpy 预检(DBG-COMPAT-03/04 重铸):版本
// 判定按「引擎目标 Python」策略(pythonTarget.ts),不再拿全局常量
// 3.12.13+MIN 1.8.0 一刀切;放行判定对资产树包从「查存在」升级为
// 「读 __init__.__version__ 核对策略」。

const targetAt = (version: string | null): PythonTarget => ({
  version,
  source: version === null ? 'none' : 'project-setting',
  detail: version === null ? '引擎 Python 版本未知' : `设置 ${PYTHON_TARGET_SETTING}=${version}`
});

const resolveWith = (resolution: InterpreterResolution) => (): InterpreterResolution => resolution;

describe('checkInterpreterDebugpy(注入前预检)', () => {
  const deps = (
    resolution: InterpreterResolution,
    probe: { stdout: string; exitCode: number | null }
  ) => ({
    resolveInterpreter: resolveWith(resolution),
    runInterpreterCode: async () => probe
  });

  it('解释器在位且 debugpy 满足目标策略:kind=ok,文案带路径/版本/目标', async () => {
    const status = await checkInterpreterDebugpy(
      deps(
        { interpreterPath: '/opt/py37/python3', interpreterSource: 'setting' },
        { stdout: '3.7.3\n1.7.0\n', exitCode: 0 }
      ),
      targetAt('3.7.3')
    );

    expect(status.kind).toBe('ok');
    expect(status.interpreterPath).toBe('/opt/py37/python3');
    expect(status.version).toBe('1.7.0');
    expect(status.python).toBe('3.7.3');
    expect(status.installSpec).toEqual(['install', 'debugpy==1.7.0']);
    expect(status.message).toContain('/opt/py37/python3');
    expect(status.message).toContain('1.7.0');
    expect(status.message).toContain('3.7.3');
  });

  it('未找到所选解释器:kind=interpreter-missing,文案给设置键补救入口,不执行探测', async () => {
    let probeCalls = 0;
    const status = await checkInterpreterDebugpy({
      resolveInterpreter: resolveWith({ interpreterPath: null, interpreterSource: 'missing' }),
      runInterpreterCode: async () => {
        probeCalls += 1;
        return { stdout: '', exitCode: 0 };
      }
    }, targetAt('3.7.3'));

    expect(status.kind).toBe('interpreter-missing');
    expect(probeCalls).toBe(0);
    expect(status.version).toBeNull();
    expect(status.message).toContain('kbengine.python.interpreterPath');
  });

  it('解释器在位但没有 debugpy:kind=debugpy-missing,安装建议按目标策略给精确 pin', async () => {
    const status = await checkInterpreterDebugpy(
      deps(
        { interpreterPath: '/opt/py37/python3', interpreterSource: 'path' },
        { stdout: 'Traceback (most recent call last):\nModuleNotFoundError: No module named \'debugpy\'\n', exitCode: 1 }
      ),
      targetAt('3.7.3')
    );

    expect(status.kind).toBe('debugpy-missing');
    expect(status.version).toBeNull();
    expect(status.installSpec).toEqual(['install', 'debugpy==1.7.0']);
    expect(status.message).toContain('/opt/py37/python3');
    expect(status.message).toContain('pip install debugpy==1.7.0');
    // 不再盲推 -U 装最新(旧口径会把 3.7 工程推上 1.8.x)
    expect(status.message).not.toContain('-U');
  });

  it('3.7 目标 + debugpy 1.8.0:kind=debugpy-incompatible(严格锁版,过高也拒)', async () => {
    const status = await checkInterpreterDebugpy(
      deps(
        { interpreterPath: '/opt/py37/python3', interpreterSource: 'path' },
        { stdout: '3.7.3\n1.8.0\n', exitCode: 0 }
      ),
      targetAt('3.7.3')
    );

    expect(status.kind).toBe('debugpy-incompatible');
    expect(status.version).toBe('1.8.0');
    expect(status.message).toContain('1.8.0');
    expect(status.message).toContain('1.7.0');
  });

  it('modern 目标 + debugpy 1.7.0:kind=debugpy-incompatible(低于下限 1.8.0)', async () => {
    const status = await checkInterpreterDebugpy(
      deps(
        { interpreterPath: '/opt/py312/python3', interpreterSource: 'path' },
        { stdout: '3.12.13\n1.7.0\n', exitCode: 0 }
      ),
      targetAt('3.12.13')
    );

    expect(status.kind).toBe('debugpy-incompatible');
    expect(status.message).toContain('1.8.0');
    expect(status.installSpec).toEqual(['install', 'debugpy>=1.8.0']);
  });

  it('目标未知:kind=target-unknown 诚实态——只报装没装,不判兼容不给安装建议', async () => {
    const status = await checkInterpreterDebugpy(
      deps(
        { interpreterPath: '/usr/bin/python3', interpreterSource: 'path' },
        { stdout: '3.12.13\n1.8.13\n', exitCode: 0 }
      ),
      targetAt(null)
    );

    expect(status.kind).toBe('target-unknown');
    expect(status.version).toBe('1.8.13');
    expect(status.installSpec).toBeNull();
    expect(status.message).toContain(PYTHON_TARGET_SETTING);
    expect(status.message).toContain('未知');
  });

  it('已知版本但无已核实支持线(3.6):kind=debugpy-incompatible,不自动安装', async () => {
    const status = await checkInterpreterDebugpy(
      deps(
        { interpreterPath: '/opt/py36/python3', interpreterSource: 'path' },
        { stdout: '3.6.9\n1.8.0\n', exitCode: 0 }
      ),
      targetAt('3.6.9')
    );

    expect(status.kind).toBe('debugpy-incompatible');
    expect(status.installSpec).toBeNull();
    expect(status.message).toContain('支持线');
  });

  it('探测退出码 0 但输出无版本行:如实按缺包处理', async () => {
    const status = await checkInterpreterDebugpy(
      deps(
        { interpreterPath: '/opt/py/python3', interpreterSource: 'path' },
        { stdout: '\n\n', exitCode: 0 }
      ),
      targetAt('3.12.13')
    );

    expect(status.kind).toBe('debugpy-missing');
  });

  it('探测只回一行(旧式单行输出):版本取该行,python 如实 null', async () => {
    const status = await checkInterpreterDebugpy(
      deps(
        { interpreterPath: '/opt/py312/python3', interpreterSource: 'path' },
        { stdout: '1.8.0\n', exitCode: 0 }
      ),
      targetAt('3.12.13')
    );

    expect(status.kind).toBe('ok');
    expect(status.version).toBe('1.8.0');
    expect(status.python).toBeNull();
  });
});

describe('debugpyPreflightAllowsInjection(放行判定,资产树版本核对)', () => {
  const ok: Pick<DebugpyPreflightStatus, 'kind'> = { kind: 'ok' };
  const missing: Pick<DebugpyPreflightStatus, 'kind'> = { kind: 'debugpy-missing' };

  it('预检通过:放行', () => {
    expect(debugpyPreflightAllowsInjection(ok, targetAt('3.7.3'), null)).toBe(true);
    expect(debugpyPreflightAllowsInjection(ok, targetAt('3.7.3'), '1.7.0')).toBe(true);
  });

  it('预检不过但资产树包满足目标策略:放行(引擎导入的是资产树包)', () => {
    expect(debugpyPreflightAllowsInjection(missing, targetAt('3.7.3'), '1.7.0')).toBe(true);
    expect(debugpyPreflightAllowsInjection(missing, targetAt('3.12.13'), '1.8.0')).toBe(true);
    expect(debugpyPreflightAllowsInjection(missing, targetAt('3.12.13'), '1.8.13')).toBe(true);
  });

  it('DBG-COMPAT-04:资产树包存在但版本不满足策略——拦下(存在 ≠ 兼容)', () => {
    // 旧口径只查目录存在,1.8.0 的资产树包给 3.7 工程放行=引擎里 import 即崩
    expect(debugpyPreflightAllowsInjection(missing, targetAt('3.7.3'), '1.8.0')).toBe(false);
    expect(debugpyPreflightAllowsInjection(missing, targetAt('3.12.13'), '1.7.0')).toBe(false);
  });

  it('资产树目录在但读不出版本(非 debugpy 布局/用户手放):拦下如实说明', () => {
    expect(debugpyPreflightAllowsInjection(missing, targetAt('3.7.3'), null)).toBe(false);
  });

  it('目标未知:无策略可判,资产树包可读即放行(兼容性不背书,状态面如实说)', () => {
    expect(debugpyPreflightAllowsInjection(missing, targetAt(null), '1.8.0')).toBe(true);
    expect(debugpyPreflightAllowsInjection(missing, targetAt(null), null)).toBe(false);
  });

  it('已知版本但无支持线(3.6):资产树包也不放行(拦下,不赌引擎)', () => {
    expect(debugpyPreflightAllowsInjection(missing, targetAt('3.6.9'), '1.8.0')).toBe(false);
  });
});

describe('readAssetsDebugpyVersion(资产树包实测版本)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-assets-ver-'));
  const pkg = path.join(dir, 'scripts', 'common', 'debugpy');

  afterEach(() => {
    fs.rmSync(pkg, { recursive: true, force: true });
  });

  it('真布局:读 __init__.__version__;非 debugpy 布局/缺目录/空根 null', () => {
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, '__init__.py'), "__version__ = '1.7.0'\n", 'utf8');
    expect(readAssetsDebugpyVersion(dir)).toBe('1.7.0');

    fs.writeFileSync(path.join(pkg, '__init__.py'), '# 用户手放,无版本行\n', 'utf8');
    expect(readAssetsDebugpyVersion(dir)).toBeNull();

    fs.rmSync(pkg, { recursive: true, force: true });
    expect(readAssetsDebugpyVersion(dir)).toBeNull();
    expect(readAssetsDebugpyVersion('')).toBeNull();
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
