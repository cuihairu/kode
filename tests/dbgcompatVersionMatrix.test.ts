/**
 * DBG-COMPAT-06 版本分支回归矩阵:目标 Python × debugpy/扩展版本 × 生产
 * 入口(安装参数/同步/预检/放行/注入闸扩展核查/远端口径)的组合账本——
 * 各分支单例在各自套件里有深钉,本文件把「哪个目标该配哪个版本、哪个
 * 入口在哪个组合下放行/拒绝」钉成一张矩阵,防修一处面时另一分支悄悄
 * 变卦。同步入口走真 fs 流(真复制落位、用户手放保护),不是纯替身。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  debugExtensionCompatFor,
  debugpyInstallSpecFor,
  type PythonTarget
} from '../src/backend/pythonTarget';
import { readDebugpyVersionFromSource, syncDebugpyPackage, type DebugpySyncDeps } from '../src/autoDebugpy';
import {
  checkInterpreterDebugpy,
  debugpyPreflightAllowsInjection,
  type DebugpyPreflightDeps
} from '../src/backend/debugpyPreflight';
import { buildPortClosedGuidance } from '../src/backend/debugpyPortProbe';

const targetAt = (version: string | null): PythonTarget => ({
  version,
  source: 'setting',
  detail: version === null ? '矩阵未知目标' : `矩阵目标 ${version}`
});

const tempRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'dbgcompat-matrix-'));

const realFsSyncDeps = (probeJson: object): DebugpySyncDeps => ({
  runPython: async () => ({ stdout: JSON.stringify(probeJson), exitCode: 0 }),
  exists: candidate => fs.existsSync(candidate),
  readFileText: candidate => fs.readFileSync(candidate, 'utf8'),
  copyTree: async (from, to) => {
    fs.cpSync(from, to, { recursive: true, force: true });
  }
});

/** 造一个 debugpy 布局的可复制源目录(真 fs) */
const makeDebugpySource = (root: string, version: string): string => {
  const dir = path.join(root, `debugpy-src-${version}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '__init__.py'), `__version__ = '${version}'\n`);
  return dir;
};

const preflightDepsWith = (interpreterPath: string, stdout: string): DebugpyPreflightDeps => ({
  resolveInterpreter: () => ({ interpreterPath, source: 'setting' }),
  runInterpreterCode: async () => ({ stdout, exitCode: 0 })
});

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) {
    fs.rmSync(cleanup.pop() as string, { recursive: true, force: true });
  }
});

describe('矩阵:安装入口(debugpyInstallSpecFor 全分支表)', () => {
  it('3.7→==1.7.0;3.8→==1.8.1;3.9→==1.8.13;3.10+→>=1.8.0;3.6/未知→不给参数', () => {
    expect(debugpyInstallSpecFor('3.7.3')).toEqual(['install', 'debugpy==1.7.0']);
    expect(debugpyInstallSpecFor('3.8.10')).toEqual(['install', 'debugpy==1.8.1']);
    expect(debugpyInstallSpecFor('3.9.7')).toEqual(['install', 'debugpy==1.8.13']);
    expect(debugpyInstallSpecFor('3.10.4')).toEqual(['install', 'debugpy>=1.8.0']);
    expect(debugpyInstallSpecFor('3.12.13')).toEqual(['install', 'debugpy>=1.8.0']);
    expect(debugpyInstallSpecFor('3.6.9')).toBeNull();
    expect(debugpyInstallSpecFor(null)).toBeNull();
  });
});

describe('矩阵:同步入口(真 fs 流)', () => {
  const mementoLike = () => {
    const store = new Map<string, unknown>();
    return {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      }
    };
  };

  it('3.7.3 + 1.7.0 → synced 且真复制落位可读回版本', async () => {
    const root = tempRoot();
    cleanup.push(root);
    const src = makeDebugpySource(root, '1.7.0');
    const assets = path.join(root, 'assets');
    fs.mkdirSync(path.join(assets, 'scripts', 'common'), { recursive: true });
    const result = await syncDebugpyPackage(
      { workspaceState: mementoLike() as never },
      assets,
      targetAt('3.7.3'),
      realFsSyncDeps({ version: '1.7.0', dir: src, python: '3.7.3' })
    );
    expect(result.status).toBe('synced');
    const onDisk = readDebugpyVersionFromSource(
      fs.readFileSync(path.join(assets, 'scripts', 'common', 'debugpy', '__init__.py'), 'utf8')
    );
    expect(onDisk).toBe('1.7.0');
  });

  it('3.7.3 + 1.8.0 → 严格拒(1.8.0 起要求 ≥3.8),资产树零写入', async () => {
    const root = tempRoot();
    cleanup.push(root);
    const src = makeDebugpySource(root, '1.8.0');
    const assets = path.join(root, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    const result = await syncDebugpyPackage(
      { workspaceState: mementoLike() as never },
      assets,
      targetAt('3.7.3'),
      realFsSyncDeps({ version: '1.8.0', dir: src, python: '3.7.3' })
    );
    expect(result.status).toBe('error');
    expect(result.message).toContain('1.8.0 起要求 ≥3.8');
    expect(fs.existsSync(path.join(assets, 'scripts', 'common', 'debugpy'))).toBe(false);
  });

  it('3.7.3 目标 + 源解释器 3.8 → ABI 行不一致拒(真复制前拦下)', async () => {
    const root = tempRoot();
    cleanup.push(root);
    const src = makeDebugpySource(root, '1.7.0');
    const assets = path.join(root, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    const result = await syncDebugpyPackage(
      { workspaceState: mementoLike() as never },
      assets,
      targetAt('3.7.3'),
      realFsSyncDeps({ version: '1.7.0', dir: src, python: '3.8.10' })
    );
    expect(result.status).toBe('error');
    expect(result.message).toContain('Python 3.8');
    expect(fs.existsSync(path.join(assets, 'scripts', 'common', 'debugpy'))).toBe(false);
  });

  it('3.12.13 + 1.6.7 → modern 下限拒;3.12.13 + 1.8.0 → synced', async () => {
    const root = tempRoot();
    cleanup.push(root);
    const srcLow = makeDebugpySource(root, '1.6.7');
    const srcOk = makeDebugpySource(root, '1.8.0');
    const assets = path.join(root, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    const refused = await syncDebugpyPackage(
      { workspaceState: mementoLike() as never },
      assets,
      targetAt('3.12.13'),
      realFsSyncDeps({ version: '1.6.7', dir: srcLow, python: '3.12.13' })
    );
    expect(refused.status).toBe('error');
    expect(refused.message).toContain('>= 1.8.0');
    const synced = await syncDebugpyPackage(
      { workspaceState: mementoLike() as never },
      assets,
      targetAt('3.12.13'),
      realFsSyncDeps({ version: '1.8.0', dir: srcOk, python: '3.12.13' })
    );
    expect(synced.status).toBe('synced');
  });

  it('未知目标 → 拒盲同步(不触探测不给版本)', async () => {
    const root = tempRoot();
    cleanup.push(root);
    let probed = false;
    const deps = realFsSyncDeps({ version: '1.7.0', dir: path.join(root, 'x'), python: '3.7.3' });
    deps.runPython = async () => {
      probed = true;
      return { stdout: '', exitCode: 0 };
    };
    const assets = path.join(root, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    const result = await syncDebugpyPackage(
      { workspaceState: mementoLike() as never },
      assets,
      targetAt(null),
      deps
    );
    expect(result.status).toBe('error');
    expect(result.message).toContain('kbengine.debug.pythonTarget');
    expect(probed).toBe(false);
  });

  it('用户手放目录(有版本无记账)→ skipped-user 原样不动', async () => {
    const root = tempRoot();
    cleanup.push(root);
    const src = makeDebugpySource(root, '1.7.0');
    const assets = path.join(root, 'assets');
    const pkgDir = path.join(assets, 'scripts', 'common', 'debugpy');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, '__init__.py'), "__version__ = '1.9.9'\n");
    const result = await syncDebugpyPackage(
      { workspaceState: mementoLike() as never },
      assets,
      targetAt('3.7.3'),
      realFsSyncDeps({ version: '1.7.0', dir: src, python: '3.7.3' })
    );
    expect(result.status).toBe('skipped-user');
    expect(readDebugpyVersionFromSource(fs.readFileSync(path.join(pkgDir, '__init__.py'), 'utf8'))).toBe('1.9.9');
  });
});

describe('矩阵:预检入口(目标 × 探测版本)', () => {
  const probe = (python: string, version: string): string => `${python}\n${version}\n`;

  it('3.7.3 + 1.7.0 → ok 且给精确 pin;3.7.3 + 1.8.0 → incompatible', async () => {
    const ok = await checkInterpreterDebugpy(
      preflightDepsWith('/usr/bin/python37', probe('3.7.3', '1.7.0')),
      targetAt('3.7.3')
    );
    expect(ok.kind).toBe('ok');
    expect(ok.installSpec).toEqual(['install', 'debugpy==1.7.0']);
    const bad = await checkInterpreterDebugpy(
      preflightDepsWith('/usr/bin/python37', probe('3.7.3', '1.8.0')),
      targetAt('3.7.3')
    );
    expect(bad.kind).toBe('debugpy-incompatible');
    expect(bad.installSpec).toEqual(['install', 'debugpy==1.7.0']);
  });

  it('3.12.13 + 1.8.0 → ok;3.12.13 + 1.6.7 → incompatible(下限)', async () => {
    const ok = await checkInterpreterDebugpy(
      preflightDepsWith('/usr/bin/python3', probe('3.12.13', '1.8.0')),
      targetAt('3.12.13')
    );
    expect(ok.kind).toBe('ok');
    const low = await checkInterpreterDebugpy(
      preflightDepsWith('/usr/bin/python3', probe('3.12.13', '1.6.7')),
      targetAt('3.12.13')
    );
    expect(low.kind).toBe('debugpy-incompatible');
    expect(low.installSpec).toEqual(['install', 'debugpy>=1.8.0']);
  });

  it('未知目标 + 有包 → target-unknown 不给安装参数;3.6 → 无支持线拒', async () => {
    const unknown = await checkInterpreterDebugpy(
      preflightDepsWith('/usr/bin/python3', probe('3.9.1', '1.9.0')),
      targetAt(null)
    );
    expect(unknown.kind).toBe('target-unknown');
    expect(unknown.installSpec).toBeNull();
    const noLine = await checkInterpreterDebugpy(
      preflightDepsWith('/usr/bin/python36', probe('3.6.9', '1.7.0')),
      targetAt('3.6.9')
    );
    expect(noLine.kind).toBe('debugpy-incompatible');
    expect(noLine.installSpec).toBeNull();
  });
});

describe('矩阵:注入放行入口(预检 × 资产树包版本)', () => {
  const okStatus = { kind: 'ok' } as const;

  it('预检 ok 直接放行;3.7 资产树 1.7.0 放行 / 1.8.0 拦下 / 读不出拦下', () => {
    expect(debugpyPreflightAllowsInjection(okStatus, targetAt('3.7.3'), null)).toBe(true);
    expect(debugpyPreflightAllowsInjection({ kind: 'debugpy-missing' }, targetAt('3.7.3'), '1.7.0')).toBe(true);
    expect(debugpyPreflightAllowsInjection({ kind: 'debugpy-missing' }, targetAt('3.7.3'), '1.8.0')).toBe(false);
    expect(debugpyPreflightAllowsInjection({ kind: 'debugpy-missing' }, targetAt('3.7.3'), null)).toBe(false);
  });

  it('未知目标:资产树可读放行(不背书)/读不出拦下;3.6 恒不放行', () => {
    expect(debugpyPreflightAllowsInjection({ kind: 'debugpy-missing' }, targetAt(null), '1.9.0')).toBe(true);
    expect(debugpyPreflightAllowsInjection({ kind: 'debugpy-missing' }, targetAt(null), null)).toBe(false);
    expect(debugpyPreflightAllowsInjection({ kind: 'debugpy-missing' }, targetAt('3.6.9'), '1.7.0')).toBe(false);
  });
});

describe('矩阵:宿主新扩展 × 引擎旧目标(注入闸扩展核查面)', () => {
  it('引擎 3.7.3 + 扩展 2024.1.1 → off-line(账本反例);2024.0.7 → ok', () => {
    const off = debugExtensionCompatFor(targetAt('3.7.3'), '2024.1.1');
    expect(off.kind).toBe('extension-off-line');
    expect(off.message).toContain('2024.0');
    expect(debugExtensionCompatFor(targetAt('3.7.3'), '2024.0.7').kind).toBe('ok');
  });

  it('引擎 3.12.13 + 新线扩展 → ok;扩展缺失 + 3.7.3 → 诚实缺失', () => {
    expect(debugExtensionCompatFor(targetAt('3.12.13'), '2024.1.1').kind).toBe('ok');
    expect(debugExtensionCompatFor(targetAt('3.7.3'), null).kind).toBe('extension-missing');
  });
});

describe('矩阵:远程/端口口径(connect 附加的 closed 指引)', () => {
  const closedProbe = { open: false, reason: 'refused' as const, detail: 'ECONNREFUSED' };

  it('远端端口不通 + 本机包不兼容 → 指引给安装动作,文案报实测/目标版本无 -U', () => {
    const guidance = buildPortClosedGuidance(closedProbe, {
      kind: 'debugpy-incompatible',
      interpreterPath: '/usr/bin/python37',
      version: '1.8.0',
      python: '3.7.3',
      target: targetAt('3.7.3'),
      installSpec: ['install', 'debugpy==1.7.0'],
      message: 'x'
    });
    expect(guidance.cause).toBe('debugpy-incompatible');
    expect(guidance.installAction).toBeDefined();
    expect(guidance.message).toContain('1.8.0');
    expect(guidance.message).toContain('3.7.3');
    expect(guidance.message).not.toContain('-U');
  });

  it('远端端口不通 + 目标未知 → 无安装动作,指引先设目标', () => {
    const guidance = buildPortClosedGuidance(closedProbe, {
      kind: 'target-unknown',
      interpreterPath: '/usr/bin/python3',
      version: '1.9.0',
      python: '3.9.1',
      target: targetAt(null),
      installSpec: null,
      message: 'x'
    });
    expect(guidance.cause).toBe('target-unknown');
    expect(guidance.installAction).toBeUndefined();
    expect(guidance.message).toContain('kbengine.debug.pythonTarget');
  });
});
