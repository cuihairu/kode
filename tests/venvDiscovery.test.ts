import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRUNED_DIRECTORY_NAMES,
  MAX_VENV_SCAN_DEPTH,
  hasEnvMarker,
  parsePythonVersionOutput,
  scanVenvs,
  shouldPruneVenvScanDirectory,
  venvBinaryCandidates,
  verifyVenvDirectory
} from '../src/backend/venvDiscovery';

// venv 自动发现(PY-ENV 二期):扫描 workspaceRoot 下的虚拟环境——venv 以
// pyvenv.cfg 为证、conda 环境以 conda-meta/ 为证,并要求解释器二进制真实
// 在盘才认(只做存在性探测,不执行);深度封顶剪枝(node_modules/target/
// .git 等绝不进入),Windows 走 Scripts/python.exe、unix 走 bin/python;
// 与 pythonScanRules(Python 源码类索引)完全解耦,不共享任何扫描面。

const rm = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });

/** 在 dir 下造一个「验证过的 venv」布局,返回解释器路径 */
const makeVenvLayout = (
  dir: string,
  platform: NodeJS.Platform = 'linux',
  opts: { marker?: boolean; python?: boolean; conda?: boolean } = {}
): string => {
  const binDir = path.join(dir, platform === 'win32' ? 'Scripts' : 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, platform === 'win32' ? 'python.exe' : 'python');
  if (opts.python !== false) {
    fs.writeFileSync(exe, '', 'utf8');
  }
  if (opts.marker !== false) {
    fs.writeFileSync(path.join(dir, 'pyvenv.cfg'), 'home = /usr\n', 'utf8');
  }
  if (opts.conda) {
    fs.mkdirSync(path.join(dir, 'conda-meta'), { recursive: true });
  }
  return exe;
};

describe('venv scan pruning rules (pure)', () => {
  it('prunes dependency/build directories but never venv-like dot directories', () => {
    expect(shouldPruneVenvScanDirectory('node_modules')).toBe(true);
    expect(shouldPruneVenvScanDirectory('target')).toBe(true);
    expect(shouldPruneVenvScanDirectory('.git')).toBe(true);
    expect(shouldPruneVenvScanDirectory('__pycache__')).toBe(true);
    // .venv/venv/.kbenv 是合法候选,绝不进剪枝清单
    expect(shouldPruneVenvScanDirectory('.venv')).toBe(false);
    expect(shouldPruneVenvScanDirectory('venv')).toBe(false);
    expect(DEFAULT_PRUNED_DIRECTORY_NAMES).toContain('node_modules');
    expect(DEFAULT_PRUNED_DIRECTORY_NAMES).toContain('target');
  });

  it('has a bounded scan depth constant', () => {
    expect(MAX_VENV_SCAN_DEPTH).toBeGreaterThanOrEqual(1);
    expect(MAX_VENV_SCAN_DEPTH).toBeLessThanOrEqual(5);
  });
});

describe('env marker and verification (existence probing only)', () => {
  it('pyvenv.cfg proves venv, conda-meta proves conda, nothing proves nothing', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-marker-'));
    const venvDir = path.join(base, 'v');
    makeVenvLayout(venvDir);
    const condaDir = path.join(base, 'c');
    fs.mkdirSync(path.join(condaDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(condaDir, 'conda-meta'), { recursive: true });
    fs.writeFileSync(path.join(condaDir, 'bin', 'python'), '', 'utf8');
    const plainDir = path.join(base, 'p');
    fs.mkdirSync(plainDir, { recursive: true });

    expect(hasEnvMarker(venvDir)).toBe('venv');
    expect(hasEnvMarker(condaDir)).toBe('conda');
    expect(hasEnvMarker(plainDir)).toBeNull();

    rm(base);
  });

  it('verifyVenvDirectory unix layout returns the interpreter path', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-verify-'));
    const exe = makeVenvLayout(path.join(base, '.venv'));
    expect(verifyVenvDirectory(path.join(base, '.venv'), 'linux')).toBe(exe);
    rm(base);
  });

  it('verifyVenvDirectory windows layout probes Scripts/python.exe', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-verify-win-'));
    const exe = makeVenvLayout(path.join(base, '.venv'), 'win32');
    expect(verifyVenvDirectory(path.join(base, '.venv'), 'win32')).toBe(exe);
    rm(base);
  });

  it('a broken env is not claimed: marker without python, python without marker', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-broken-'));
    // pyvenv.cfg 在但解释器二进制不在:损坏,不认
    makeVenvLayout(path.join(base, 'no-py'), 'linux', { python: false });
    expect(verifyVenvDirectory(path.join(base, 'no-py'), 'linux')).toBeNull();
    // bin/python 在但没有任何环境标记:只是个普通目录,不认
    makeVenvLayout(path.join(base, 'no-marker'), 'linux', { marker: false });
    expect(verifyVenvDirectory(path.join(base, 'no-marker'), 'linux')).toBeNull();
    rm(base);
  });
});

describe('scanVenvs (depth-bounded, pruned, verified)', () => {
  it('finds the root-level .venv at depth 0', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-scan-'));
    const exe = makeVenvLayout(path.join(root, '.venv'));
    const found = scanVenvs(root, { platform: 'linux' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      rootPath: path.join(root, '.venv'),
      name: '.venv',
      interpreterPath: exe,
      envKind: 'venv',
      depth: 0
    });
    rm(root);
  });

  it('finds nested envs within the depth cap and honours a smaller cap', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-nested-'));
    const nested = path.join(root, 'envs', 'team');
    const exe = makeVenvLayout(nested);
    const found = scanVenvs(root, { platform: 'linux' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      rootPath: nested,
      interpreterPath: exe,
      depth: 1
    });
    // 深度封顶收紧后,超深度的环境不再出现(不是报错,是如实不收录)
    expect(scanVenvs(root, { platform: 'linux', maxDepth: 0 })).toHaveLength(0);
    rm(root);
  });

  it('never descends into node_modules/target even when they hold venv-like dirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-prune-'));
    makeVenvLayout(path.join(root, 'node_modules', 'pkg', '.venv'));
    makeVenvLayout(path.join(root, 'target', 'debug', 'venv'));
    expect(scanVenvs(root, { platform: 'linux' })).toHaveLength(0);
    rm(root);
  });

  it('excludes broken env directories instead of claiming them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-scan-broken-'));
    makeVenvLayout(path.join(root, '.venv'), 'linux', { python: false });
    makeVenvLayout(path.join(root, 'venv'), 'linux', { marker: false });
    expect(scanVenvs(root, { platform: 'linux' })).toHaveLength(0);
    rm(root);
  });

  it('windows discovery resolves Scripts/python.exe end to end', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-scan-win-'));
    const exe = makeVenvLayout(path.join(root, '.venv'), 'win32');
    const found = scanVenvs(root, { platform: 'win32' });
    expect(found).toHaveLength(1);
    expect(found[0].interpreterPath).toBe(exe);
    rm(root);
  });

  it('recognizes conda environments by their conda-meta marker', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-conda-'));
    const exe = makeVenvLayout(path.join(root, 'py38'), 'linux', {
      marker: false,
      conda: true
    });
    const found = scanVenvs(root, { platform: 'linux' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      rootPath: path.join(root, 'py38'),
      interpreterPath: exe,
      envKind: 'conda'
    });
    rm(root);
  });

  it('orders shallow environments first, then by name at equal depth', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-order-'));
    makeVenvLayout(path.join(root, 'zeta'));
    makeVenvLayout(path.join(root, 'alpha'));
    makeVenvLayout(path.join(root, 'envs', 'deep'));
    const found = scanVenvs(root, { platform: 'linux' });
    expect(found.map(env => env.name)).toEqual(['alpha', 'zeta', 'deep']);
    rm(root);
  });

  it('binary candidates follow the platform layout', () => {
    const dir = '/some/env';
    expect(venvBinaryCandidates(dir, 'linux')).toEqual([
      path.join(dir, 'bin', 'python'),
      path.join(dir, 'bin', 'python3')
    ]);
    expect(venvBinaryCandidates(dir, 'win32')).toEqual([
      path.join(dir, 'Scripts', 'python.exe'),
      path.join(dir, 'Scripts', 'python3.exe')
    ]);
    // Windows 的 conda 环境解释器常在环境根目录:按 envKind 追加根级候选
    expect(venvBinaryCandidates(dir, 'win32', 'conda')).toEqual([
      path.join(dir, 'python.exe'),
      path.join(dir, 'python3.exe'),
      path.join(dir, 'Scripts', 'python.exe'),
      path.join(dir, 'Scripts', 'python3.exe')
    ]);
    expect(venvBinaryCandidates(dir, 'linux', 'conda')).toEqual([
      path.join(dir, 'bin', 'python'),
      path.join(dir, 'bin', 'python3')
    ]);
  });

  it('windows conda environments with a root-level python.exe are verified', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-conda-win-'));
    const env = path.join(root, 'py38');
    fs.mkdirSync(path.join(env, 'conda-meta'), { recursive: true });
    const exe = path.join(env, 'python.exe');
    fs.writeFileSync(exe, '', 'utf8');
    expect(verifyVenvDirectory(env, 'win32')).toBe(exe);
    expect(scanVenvs(root, { platform: 'win32' })[0].envKind).toBe('conda');
    rm(root);
  });

  it('a candidate that is a directory is not claimed as an interpreter', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-dir-cand-'));
    // bin/python 是目录:存在性为真但不是文件,不认
    const env = path.join(root, '.venv');
    fs.mkdirSync(path.join(env, 'bin', 'python'), { recursive: true });
    fs.writeFileSync(path.join(env, 'pyvenv.cfg'), 'home = /usr\n', 'utf8');
    expect(verifyVenvDirectory(env, 'linux')).toBeNull();
    expect(scanVenvs(root, { platform: 'linux' })).toHaveLength(0);
    rm(root);
  });
});

describe('version output parsing (pure)', () => {
  it('parses "Python 3.x.y" and refuses garbage', () => {
    expect(parsePythonVersionOutput('Python 3.12.13')).toBe('3.12.13');
    expect(parsePythonVersionOutput('Python 3.11.9 (main, Apr 2 2026, 00:00:00)')).toBe('3.11.9');
    expect(parsePythonVersionOutput('')).toBeNull();
    expect(parsePythonVersionOutput('not python at all')).toBeNull();
  });
});
