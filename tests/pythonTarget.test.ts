import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ENGINE_BIN_SCAN_LIMIT,
  PYTHON_TARGET_SETTING,
  DEBUGPY_EXTENSION_ID,
  debugExtensionCompatFor,
  debugExtensionOn37Line,
  debugpyInstallSpecFor,
  debugpyPolicyFor,
  debugpyVersionSatisfiesPolicy,
  normalizeVersionText,
  pythonLineOf,
  pythonTargetDeps,
  readDebugpyExtensionVersion,
  resolvePythonTarget,
  scanPythonVersionCandidates,
  setWorkspaceConfigSourceForTests,
  voteEnginePythonVersion,
  type PythonTargetDeps
} from '../src/backend/pythonTarget';
import { setActiveProfile } from '../src/activeProfile';
import { ProjectProfileStore } from '../src/projectProfiles';

// DBG-COMPAT-01/02:引擎目标 Python 版本来源(显式设置 > 引擎二进制扫描
// > 诚实未知)与 debugpy 兼容策略表(3.7 严格锁 1.7.0 / 3.8→1.8.1 /
// 3.9→1.8.13 / 3.10+ 下限 1.8.0 / 未知无策略)。旧全局常量
// EMBEDDED_PYTHON_VERSION '3.12.13' + MIN 1.8.0 对所有工程一刀切的口径
// 由本模块废除。

class MemoryMemento implements vscode.Memento {
  private readonly map = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.map.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.map.has(key) ? (this.map.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }
}

afterEach(() => {
  setWorkspaceConfigSourceForTests(null);
});

describe('normalizeVersionText / pythonLineOf', () => {
  it('三段版本规范化;非 x.y.z 如实 null', () => {
    expect(normalizeVersionText('3.7.3')).toBe('3.7.3');
    expect(normalizeVersionText('  3.12.13  ')).toBe('3.12.13');
    expect(normalizeVersionText('3.7')).toBeNull();
    expect(normalizeVersionText('v3.7.3')).toBeNull();
    expect(normalizeVersionText('abc')).toBeNull();
  });

  it('pythonLineOf 取 minor 行;null 与非三段 null', () => {
    expect(pythonLineOf('3.7.3')).toBe('3.7');
    expect(pythonLineOf('3.12.13')).toBe('3.12');
    expect(pythonLineOf(null)).toBeNull();
    expect(pythonLineOf('3.7')).toBeNull();
  });
});

describe('scanPythonVersionCandidates(二进制横幅扫描)', () => {
  const banner = (...versions: string[]): Buffer =>
    Buffer.from(`... ${versions.map(v => `Python ${v} (embedded, ...`).join(' ... ')} ...`, 'latin1');

  it('扫出版本串候选并去重,按出现序', () => {
    expect(scanPythonVersionCandidates(banner('3.7.3', '3.7.3', '3.7.3'))).toEqual(['3.7.3']);
    expect(scanPythonVersionCandidates(banner('3.7.3', '3.8.1'))).toEqual(['3.7.3', '3.8.1']);
  });

  it('明显不是 Python 版本的形态按噪声滤掉(minor≥40 / patch≥100)', () => {
    expect(scanPythonVersionCandidates(Buffer.from('OpenSSL 3.55.9 zlib 3.7.200', 'latin1')))
      .toEqual([]);
    expect(scanPythonVersionCandidates(Buffer.from('ratio 3.12.100', 'latin1'))).toEqual([]);
  });

  it('latin1 零位移:含高位字节的横幅不误切 ASCII 版本串', () => {
    expect(scanPythonVersionCandidates(Buffer.from(' \xb5 Python 3.7.3 \xff ', 'latin1')))
      .toEqual(['3.7.3']);
  });
});

describe('voteEnginePythonVersion(跨二进制投票)', () => {
  it('≥2 个二进制同现一个候选:可信', () => {
    expect(voteEnginePythonVersion([['3.7.3'], ['3.7.3'], ['3.7.3']])).toBe('3.7.3');
    expect(voteEnginePythonVersion([['3.7.3', '3.9.7'], ['3.7.3']])).toBe('3.7.3');
  });

  it('两个二进制各持不同候选(互斥证据):未知,不猜', () => {
    expect(voteEnginePythonVersion([['3.7.3'], ['3.8.1']])).toBeNull();
    expect(voteEnginePythonVersion([['3.7.3', '3.8.1'], ['3.7.3', '3.8.1']])).toBeNull();
  });

  it('只扫了一个二进制且恰有一个候选:降级认(单证弱证据)', () => {
    expect(voteEnginePythonVersion([['3.7.3']])).toBe('3.7.3');
  });

  it('单二进制多候选 / 全空:未知', () => {
    expect(voteEnginePythonVersion([['3.7.3', '3.8.1']])).toBeNull();
    expect(voteEnginePythonVersion([[]])).toBeNull();
    expect(voteEnginePythonVersion([['3.7.3'], []])).toBeNull();
  });
});

const depsWith = (overrides: Partial<PythonTargetDeps> = {}): PythonTargetDeps => ({
  configValue: () => undefined,
  engineRoot: () => null,
  listServerBinaries: () => [],
  readBinaryHead: () => null,
  ...overrides
});

describe('resolvePythonTarget(来源优先级)', () => {
  it('显式设置优先:引擎探测根本不发起', () => {
    const deps = depsWith({
      configValue: () => '3.7.3',
      engineRoot: () => {
        throw new Error('设置在场时不该走引擎探测');
      }
    });
    const target = resolvePythonTarget(deps);
    expect(target).toEqual({
      version: '3.7.3',
      source: 'project-setting',
      detail: `设置 ${PYTHON_TARGET_SETTING}=3.7.3`
    });
  });

  it('设置写了非法形态:按未知处理,来源面如实带设置原文', () => {
    const target = resolvePythonTarget(depsWith({ configValue: () => 'three-seven' }));
    expect(target.version).toBeNull();
    expect(target.source).toBe('project-setting');
    expect(target.detail).toContain('three-seven');
    expect(target.detail).toContain(PYTHON_TARGET_SETTING);
  });

  it('无设置无引擎根:none(未知),不回落任何常量', () => {
    const target = resolvePythonTarget(depsWith());
    expect(target).toMatchObject({ version: null, source: 'none' });
    expect(target.detail).toContain(PYTHON_TARGET_SETTING);
  });

  it('引擎根下无服务二进制:none,detail 给显式设置出口', () => {
    const target = resolvePythonTarget(depsWith({
      engineRoot: () => '/opt/kbengine',
      listServerBinaries: () => []
    }));
    expect(target).toMatchObject({ version: null, source: 'none' });
    expect(target.detail).toContain('/opt/kbengine');
  });

  it('多二进制投票判定:engine-binary 来源,detail 带参与数', () => {
    const binaries = ['/e/kbe/bin/server/a', '/e/kbe/bin/server/b'];
    const target = resolvePythonTarget(depsWith({
      engineRoot: () => '/e',
      listServerBinaries: root => (root === '/e' ? binaries : []),
      readBinaryHead: candidate =>
        Buffer.from(`KBEngine built with Python 3.7.3 on ${candidate}`, 'latin1')
    }));
    expect(target).toEqual({
      version: '3.7.3',
      source: 'engine-binary',
      detail: '引擎二进制扫描(2 个投票)判定 Python 3.7.3'
    });
  });

  it('单二进制单候选:降级判定,detail 如实标注弱证据', () => {
    const target = resolvePythonTarget(depsWith({
      engineRoot: () => '/e',
      listServerBinaries: () => ['/e/kbe/bin/server/only'],
      readBinaryHead: () => Buffer.from('Python 3.7.3', 'latin1')
    }));
    expect(target.version).toBe('3.7.3');
    expect(target.source).toBe('engine-binary');
    expect(target.detail).toContain('证据较弱');
  });

  it('扫描无单一可信候选:engine-binary 来源的未知态(不猜)', () => {
    const target = resolvePythonTarget(depsWith({
      engineRoot: () => '/e',
      listServerBinaries: () => ['/e/a', '/e/b'],
      readBinaryHead: candidate => Buffer.from(candidate.includes('a') ? '3.7.3' : '3.8.1', 'latin1')
    }));
    expect(target).toMatchObject({ version: null, source: 'engine-binary' });
    expect(target.detail).toContain(PYTHON_TARGET_SETTING);
  });

  it(`扫描扇出上限 ${ENGINE_BIN_SCAN_LIMIT}:只读前 N 个二进制`, () => {
    const read: string[] = [];
    resolvePythonTarget(depsWith({
      engineRoot: () => '/e',
      listServerBinaries: () => ['/e/a', '/e/b', '/e/c', '/e/d', '/e/e2'],
      readBinaryHead: candidate => {
        read.push(candidate);
        return Buffer.from('Python 3.7.3', 'latin1');
      }
    }));
    expect(read).toHaveLength(ENGINE_BIN_SCAN_LIMIT);
  });
});

describe('pythonTargetDeps(生产装配)', () => {
  it('configValue 读 kbengine.debug.pythonTarget(注入配置源)', () => {
    setWorkspaceConfigSourceForTests(() => ({
      get: <T,>(_section: string, _fallback?: T): T => '3.7.3' as unknown as T
    }));
    expect(pythonTargetDeps().configValue()).toBe('3.7.3');
  });

  it('engineRoot 取活动 profile 的引擎根(逐工作区 memento)', async () => {
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const profile = await store.create({
      displayName: '引擎 3.7 工程',
      assetsRoot: '/ws/assets',
      engineRoot: '/opt/kbengine-37'
    });
    await setActiveProfile(memento, profile.id);
    expect(pythonTargetDeps(memento).engineRoot()).toBe('/opt/kbengine-37');
  });

  it('无活动 profile:engineRoot null(未知,不猜)', () => {
    expect(pythonTargetDeps(new MemoryMemento()).engineRoot()).toBeNull();
    expect(pythonTargetDeps().engineRoot()).toBeNull();
  });
});

// 生产装配的两个真盘面(引擎二进制投票的实际取数路径):
// listServerBinaries = kbe/bin/server 目录的**文件**按名确定序(子目录不入,
// 目录缺失/不可读如实空表,不炸调用方);readBinaryHead = 读头部字节(不足则
// 给实读长度,读不了如实 null)。此处用 mkdtemp 真盘跑一遍,锁住
// path.join 组装与 isFile 过滤的确定序(投票面只接受确定序)。
describe('pythonTargetDeps(生产真盘面:kbe/bin/server 与二进制头部)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pythontarget-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const serverDir = (): string => path.join(root, 'kbe', 'bin', 'server');

  it('listServerBinaries:目录文件按名确定序(跨平台无后缀过滤),子目录不入', () => {
    const dir = serverDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'base'), 'x', 'utf8');
    fs.writeFileSync(path.join(dir, 'cell'), 'x', 'utf8');
    fs.writeFileSync(path.join(dir, 'login'), 'x', 'utf8');
    fs.mkdirSync(path.join(dir, 'subdir'));

    const deps = pythonTargetDeps();
    expect(deps.listServerBinaries(root)).toEqual([
      path.join(dir, 'base'),
      path.join(dir, 'cell'),
      path.join(dir, 'login')
    ]);
  });

  it('listServerBinaries:目录缺失/不可读 → 空表(未知,不炸)', () => {
    const deps = pythonTargetDeps();
    expect(deps.listServerBinaries(root)).toEqual([]);
    expect(deps.listServerBinaries(path.join(root, 'no-such-root'))).toEqual([]);
  });

  it('readBinaryHead:按实读长度给头部字节;读不了如实 null', () => {
    const file = path.join(root, 'banner.bin');
    fs.writeFileSync(file, 'KBEngine built with Python 3.7.3 tail', 'utf8');
    const deps = pythonTargetDeps();
    const head = (target: string, max: number): Buffer => {
      const buffer = deps.readBinaryHead(target, max);
      expect(buffer).not.toBeNull();
      return Buffer.from(buffer!);
    };

    expect(head(file, 200)).toEqual(Buffer.from('KBEngine built with Python 3.7.3 tail', 'utf8'));
    expect(head(file, 9)).toEqual(Buffer.from('KBEngine ', 'utf8'));
    expect(deps.readBinaryHead(path.join(root, 'missing.bin'), 64)).toBeNull();
    // 目录不可当文件读:同样如实 null(不炸)
    expect(deps.readBinaryHead(root, 64)).toBeNull();
  });
});

describe('debugpyPolicyFor(兼容策略表)', () => {
  it('3.7:严格锁 1.7.0(过高也拒)', () => {
    expect(debugpyPolicyFor('3.7.3')).toEqual({
      line: '3.7',
      pin: '1.7.0',
      strict: true,
      floor: '1.7.0'
    });
  });

  it('3.8/3.9:按已核实支持线 pin,下限闸(接受更高)', () => {
    expect(debugpyPolicyFor('3.8.10')).toMatchObject({ line: '3.8', pin: '1.8.1', strict: false });
    expect(debugpyPolicyFor('3.9.7')).toMatchObject({ line: '3.9', pin: '1.8.13', strict: false });
  });

  it('3.10+:无精确 pin,下限 1.8.0', () => {
    expect(debugpyPolicyFor('3.12.13')).toEqual({ line: '3.12', pin: null, strict: false, floor: '1.8.0' });
    expect(debugpyPolicyFor('3.13.0')).toMatchObject({ line: '3.13', floor: '1.8.0' });
  });

  it('未知 / 无已核实支持线的行:无策略', () => {
    expect(debugpyPolicyFor(null)).toBeNull();
    expect(debugpyPolicyFor('3.6.9')).toBeNull();
  });
});

describe('debugpyVersionSatisfiesPolicy(同一裁决闸)', () => {
  const strict37 = debugpyPolicyFor('3.7.3')!;
  const modern = debugpyPolicyFor('3.12.13')!;

  it('strict:必须恰等 pin', () => {
    expect(debugpyVersionSatisfiesPolicy('1.7.0', strict37)).toBe(true);
    expect(debugpyVersionSatisfiesPolicy('1.8.0', strict37)).toBe(false);
    expect(debugpyVersionSatisfiesPolicy('1.6.9', strict37)).toBe(false);
  });

  it('floor:达到下限即满足(更高也行)', () => {
    expect(debugpyVersionSatisfiesPolicy('1.8.0', modern)).toBe(true);
    expect(debugpyVersionSatisfiesPolicy('1.8.13', modern)).toBe(true);
    expect(debugpyVersionSatisfiesPolicy('1.7.0', modern)).toBe(false);
  });
});

describe('debugpyInstallSpecFor(精确安装参数)', () => {
  it('已知行给 ==pin;modern 行给 >=floor;未知 null', () => {
    expect(debugpyInstallSpecFor('3.7.3')).toEqual(['install', 'debugpy==1.7.0']);
    expect(debugpyInstallSpecFor('3.8.10')).toEqual(['install', 'debugpy==1.8.1']);
    expect(debugpyInstallSpecFor('3.9.7')).toEqual(['install', 'debugpy==1.8.13']);
    expect(debugpyInstallSpecFor('3.12.13')).toEqual(['install', 'debugpy>=1.8.0']);
    expect(debugpyInstallSpecFor(null)).toBeNull();
    expect(debugpyInstallSpecFor('3.6.9')).toBeNull();
  });
});

describe('debugExtensionOn37Line(3.7 调试扩展支持线)', () => {
  it('2024.0.x 在线(实测核实线);其余线离线;未知 null', () => {
    expect(debugExtensionOn37Line('2024.0.0')).toBe(true);
    expect(debugExtensionOn37Line('2024.0.7')).toBe(true);
    // 2024.1 起该扩展线已移除 3.7 支持——离线,不放宽
    expect(debugExtensionOn37Line('2024.1.1')).toBe(false);
    expect(debugExtensionOn37Line('2025.5.1')).toBe(false);
    expect(debugExtensionOn37Line('2023.9.0')).toBe(false);
    expect(debugExtensionOn37Line(null)).toBeNull();
    expect(debugExtensionOn37Line('junk')).toBeNull();
  });
});

describe('readDebugpyExtensionVersion(扩展宿主版本探测)', () => {
  const registryWith = (version: unknown) => ({
    getExtension: (id: string) =>
      id === DEBUGPY_EXTENSION_ID ? { packageJSON: { version } } : undefined
  });

  it('已装扩展读实测版本;未装/版本异常 → null(诚实未知)', () => {
    expect(readDebugpyExtensionVersion(registryWith('2024.0.7'))).toBe('2024.0.7');
    expect(readDebugpyExtensionVersion(registryWith('2024.1.1'))).toBe('2024.1.1');
    expect(readDebugpyExtensionVersion({ getExtension: () => undefined })).toBeNull();
    expect(readDebugpyExtensionVersion(registryWith(undefined))).toBeNull();
    expect(readDebugpyExtensionVersion(registryWith(42))).toBeNull();
    // registry 抛异常也按未知处理,不炸调用面
    expect(
      readDebugpyExtensionVersion({
        getExtension: () => {
          throw new Error('host unavailable');
        }
      })
    ).toBeNull();
  });
});

describe('debugExtensionCompatFor(3.7 目标 × 扩展线判定)', () => {
  const target = (version: string | null) => ({
    version,
    source: 'setting' as const,
    detail: version === null ? '测试未知' : `测试 ${version}`
  });

  it('3.7 目标 + 2024.0.x → ok 静默', () => {
    expect(debugExtensionCompatFor(target('3.7.3'), '2024.0.0')).toEqual({ kind: 'ok', message: null });
    expect(debugExtensionCompatFor(target('3.7.3'), '2024.0.7')).toEqual({ kind: 'ok', message: null });
  });

  it('3.7 目标 + 新线扩展 → off-line,给固定版本安装/禁自动更新步骤', () => {
    const compat = debugExtensionCompatFor(target('3.7.3'), '2024.1.1');
    expect(compat.kind).toBe('extension-off-line');
    expect(compat.message).toContain('2024.0');
    expect(compat.message).toContain('安装特定版本');
    expect(compat.message).toContain('忽略升级');
    // 绝不自动降级的承诺写进文案(用户自行操作)
    expect(compat.message).toContain('绝不自动降级');
  });

  it('3.7 目标 + 扩展缺失 → 诚实缺失(不假装能 attach)', () => {
    const compat = debugExtensionCompatFor(target('3.7.3'), null);
    expect(compat.kind).toBe('extension-missing');
    expect(compat.message).toContain(DEBUGPY_EXTENSION_ID);
    expect(compat.message).toContain('未检测到');
  });

  it('非 3.7 目标不看扩展线(新线更好);未知目标也不判', () => {
    expect(debugExtensionCompatFor(target('3.12.13'), '2024.1.1')).toEqual({ kind: 'ok', message: null });
    expect(debugExtensionCompatFor(target('3.9.7'), '2025.5.1')).toEqual({ kind: 'ok', message: null });
    expect(debugExtensionCompatFor(target(null), '2024.1.1')).toEqual({ kind: 'ok', message: null });
    expect(debugExtensionCompatFor(target('3.6.9'), '2024.1.1')).toEqual({ kind: 'ok', message: null });
  });
});

// ---------------------------------------------------------------------------
// 批 15:生产默认依赖(defaultListServerBinaries / defaultReadBinaryHead)——
// 既有臂全部注入替身,这两条真实 fs 路径从未跑过。这里用真临时目录钉住:
// 按名确定序 + 只收普通文件 + 缺目录如实空;读头部按 maxBytes 截断 + 读不了如实 null。
// ---------------------------------------------------------------------------
describe('生产默认依赖(真实文件系统)', () => {
  it('defaultListServerBinaries:kbe/bin/server 下普通文件按名排序,子目录不入列', async () => {
    const { defaultListServerBinaries, pythonTargetDeps } = await import('../src/backend/pythonTarget');
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pytarget-'));
    const bin = path.join(root, 'kbe', 'bin', 'server');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'b_engine'), 'x');
    fs.writeFileSync(path.join(bin, 'a_engine'), 'y');
    fs.mkdirSync(path.join(bin, 'subdir'));
    try {
      const listed = defaultListServerBinaries(root);
      expect(listed.map(p => path.basename(p))).toEqual(['a_engine', 'b_engine']);
      // 缺 kbe/bin/server → 如实空数组(不抛)
      expect(defaultListServerBinaries(path.join(root, 'nowhere'))).toEqual([]);
      // 读头部经 pythonTargetDeps 装配的生产真身(模块未直接导出):按 maxBytes 截断
      const deps = pythonTargetDeps(undefined);
      const head = deps.readBinaryHead(path.join(bin, 'a_engine'), 1);
      expect(head).not.toBeNull();
      expect(head!.length).toBe(1);
      // 读不了(不存在)→ null
      expect(deps.readBinaryHead(path.join(bin, 'missing'), 8)).toBeNull();
      // configValue 生产默认源:未注入替身时走真 vscode.workspace 配置面,
      // 读不到值如实 undefined(零配置工作区的诚实面)
      setWorkspaceConfigSourceForTests(null);
      expect(deps.configValue()).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
