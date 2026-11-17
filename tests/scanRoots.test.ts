import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { Uri } from './fake-vscode/core';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';
import {
  findFilesAcrossRoots,
  getIndexScanRoots,
  getExternalScanRoots,
  getScanRootForFile,
  resolveAssetsRootForWorkspace,
  resetScanRootCache,
  setActiveProfileScanRoot
} from '../src/scanRoots';
import * as discoveryModule from '../src/workspaceDiscovery';
import * as configDeriveModule from '../src/configDerive';

// 扫描根口径(用户 2026-10-16):workspace 顶层 ∪ assetsRoot,去重;
// assetsRoot 未配置/不存在时回退 workspace,任何读取异常都不外抛。

const tmpRoots: string[] = [];
const makeTmpDir = (label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kode-scanroots-${label}-`));
  tmpRoots.push(dir);
  return dir;
};

const setAssetsRoot = (value: string | undefined): void => {
  if (value === undefined) {
    configurationOverrides.delete('kbengine');
  } else {
    configurationOverrides.set('kbengine', { assetsRoot: value });
  }
  resetScanRootCache();
};

describe('getIndexScanRoots:workspace ∪ assetsRoot(去重/回退/不抛)', () => {
  it('仅工作区:无 assetsRoot 配置 → [workspace]', () => {
    const ws = makeTmpDir('ws-only');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    try {
      setAssetsRoot(undefined);
      expect(getIndexScanRoots()).toEqual([ws]);
      expect(getExternalScanRoots()).toEqual([]);
    } finally {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('配置了 workspace 外的 assetsRoot → 两个根都入列(外部根可被手工遍历)', () => {
    const ws = makeTmpDir('ws-ext');
    const assets = makeTmpDir('assets-ext');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    try {
      setAssetsRoot(assets);
      const roots = getIndexScanRoots();
      expect(roots).toContain(ws);
      expect(roots).toContain(assets);
      expect(getExternalScanRoots()).toEqual([assets]);
      // 文件归属:assetsRoot 下文件归 assetsRoot,工作区文件归工作区
      expect(getScanRootForFile(path.join(assets, 'scripts', 'a.py'))).toBe(assets);
      expect(getScanRootForFile(path.join(ws, 'scripts', 'a.py'))).toBe(ws);
      expect(getScanRootForFile(path.join(makeTmpDir('outside'), 'x.py'))).toBeNull();
    } finally {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });


  it('assetsRoot 已包含在工作区内 → 包含去重,只留 workspace(不重复扫)', () => {
    const ws = makeTmpDir('ws-inner');
    const inner = path.join(ws, 'flyff_assets');
    fs.mkdirSync(inner, { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    try {
      setAssetsRoot(inner);
      expect(getIndexScanRoots()).toEqual([ws]);
      expect(getExternalScanRoots()).toEqual([]);
    } finally {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('assetsRoot 指向不存在目录 → 回退 workspace(不失败)', () => {
    const ws = makeTmpDir('ws-ghost');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    try {
      setAssetsRoot(path.join(ws, 'ghost-root'));
      expect(getIndexScanRoots()).toEqual([ws]);
    } finally {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('无工作区 + 配置 assetsRoot → 只有 assetsRoot;两者皆无 → 空数组(不抛)', () => {
    const assets = makeTmpDir('assets-only');
    try {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(assets);
      expect(getIndexScanRoots()).toEqual([assets]);
      setAssetsRoot(path.join(os.tmpdir(), `kode-ghost-${Date.now()}`));
      expect(getIndexScanRoots()).toEqual([]);
    } finally {
      setAssetsRoot(undefined);
    }
  });

  it('${workspaceFolder} 占位展开后参与判定', () => {
    const base = makeTmpDir('expand');
    const ws = path.join(base, 'ws');
    const assets = path.join(base, 'ext_assets');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(assets, { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    try {
      setAssetsRoot('${workspaceFolder}/../ext_assets');
      const roots = getIndexScanRoots();
      expect(roots).toContain(ws);
      expect(roots).toContain(assets);
    } finally {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('自动发现抛错 → 兜底 null,不外抛(101)', () => {
    // 约定链/深扫描抛错(只读枚举被拒等):发现结果置 null,回退 workspace,
    // 不打断索引扫描(与「读取异常不外抛」同口径)。
    const ws = makeTmpDir('disc-throw');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    const spy = vi.spyOn(discoveryModule, 'resolveDiscoveredConfigRoot').mockImplementation(() => {
      throw new Error('discovery enumeration failed');
    });
    try {
      setAssetsRoot(undefined);
      expect(getIndexScanRoots()).toEqual([ws]);
    } finally {
      spy.mockRestore();
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('审核发现:派生 scripts 根存在时不排除外部 assetsRoot(scripts 之外仍被索引)', () => {
    const base = makeTmpDir('derived-external');
    const ws = path.join(base, 'ws');
    const assets = path.join(base, 'ext_assets');
    const scripts = path.join(assets, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(assets, { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    const spy = vi.spyOn(configDeriveModule, 'getConfigDerivedScanRoot').mockReturnValue(scripts);
    try {
      setAssetsRoot(assets);
      const roots = getIndexScanRoots();
      // 外部 assetsRoot 保留(scripts 之外的 res/entity_defs 仍被索引)
      expect(roots).toContain(assets);
      // 派生 scripts 根被 assetsRoot 包含 → 去重后不重复入列(不重复扫)
      expect(roots).not.toContain(scripts);
    } finally {
      spy.mockRestore();
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });
});

describe('findFilesAcrossRoots:workspace 结果 + 外部根手工遍历(去重/exclude)', () => {
  it('合并两源并按路径去重;外部根命中 glob,exclude 目录被跳过', async () => {
    const ws = makeTmpDir('merge-ws');
    const assets = makeTmpDir('merge-assets');
    // assetsRoot 布局:实体定义、字段类型、脚本 + 一个应被 exclude 掉的目录
    fs.mkdirSync(path.join(assets, 'scripts', 'entity_defs'), { recursive: true });
    fs.mkdirSync(path.join(assets, 'scripts', 'base'), { recursive: true });
    fs.mkdirSync(path.join(assets, 'scripts', 'node_modules', 'junk'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'scripts', 'entity_defs', 'Account.def'), '<root/>');
    fs.writeFileSync(path.join(assets, 'scripts', 'entities.xml'), '<root/>');
    fs.writeFileSync(path.join(assets, 'scripts', 'base', 'Account.py'), 'class Account:\n    pass\n');
    fs.writeFileSync(path.join(assets, 'scripts', 'node_modules', 'junk', 'skip.def'), '<root/>');
    // workspace 内同名文件(与外部 walk 相同路径时去重;这里用 workspace canned 结果模拟)
    const dupUri = Uri.file(path.join(assets, 'scripts', 'entities.xml'));

    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    const original = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (pattern?: string) =>
      pattern && pattern.includes('entities.xml') ? [dupUri] : []) as typeof stubWorkspace.findFiles;
    try {
      setAssetsRoot(assets);
      await expectations();
    } finally {
      stubWorkspace.findFiles = original;
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }

    async function expectations(): Promise<void> {
      const exclude = '**/{node_modules,build}/**';
      const defs = await findFilesAcrossRoots('**/*.def', exclude);
      expect(defs.map(u => u.fsPath).filter(p => p.includes('merge-assets')), 'exclude 目录不进结果')
        .toEqual([path.join(assets, 'scripts', 'entity_defs', 'Account.def')]);

      const entities = await findFilesAcrossRoots('**/entities.xml', exclude);
      expect(entities.length, 'canned 与外部 walk 同一文件去重后只留一条').toBe(1);
      expect(entities[0].fsPath).toBe(path.join(assets, 'scripts', 'entities.xml'));

      const py = await findFilesAcrossRoots('**/*.py', exclude);
      expect(py.map(u => u.fsPath)).toEqual([path.join(assets, 'scripts', 'base', 'Account.py')]);
    }
  });

  it('托管目录(.kbengine/inferred)副本不进结果(防镜像双计,CFG-017)', async () => {
    const ws = makeTmpDir('mirror-ws');
    const original = Uri.file(path.join(ws, 'scripts', 'base', 'Account.py'));
    const mirror = Uri.file(path.join(ws, '.kbengine', 'inferred', 'scripts', 'base', 'Account.py'));
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async () => [original, mirror]) as typeof stubWorkspace.findFiles;
    try {
      const py = await findFilesAcrossRoots('**/*.py', null);
      expect(py.map(u => u.fsPath)).toEqual([original.fsPath]);
    } finally {
      stubWorkspace.workspaceFolders = [];
    }
  });

  it('外部根目录读取挂起期间可取消，取消后不继续遍历子目录', async () => {
    const ws = makeTmpDir('cancel-ws');
    const assets = makeTmpDir('cancel-assets');
    fs.mkdirSync(path.join(assets, 'nested'));
    fs.writeFileSync(path.join(assets, 'nested', 'Late.py'), 'class Late: pass\n');
    const originalFind = stubWorkspace.findFiles;
    const originalReaddir = fs.promises.readdir;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async () => []) as typeof stubWorkspace.findFiles;
    setAssetsRoot(assets);
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let childReads = 0;
    fs.promises.readdir = (async (...args: Parameters<typeof originalReaddir>) => {
      if (String(args[0]) === assets) { entered(); await gate; }
      if (String(args[0]) === path.join(assets, 'nested')) { childReads += 1; }
      return originalReaddir(...args);
    }) as typeof fs.promises.readdir;
    const token = { isCancellationRequested: false } as { isCancellationRequested: boolean };
    try {
      const result = findFilesAcrossRoots('**/*.py', null, token as never);
      await reading;
      token.isCancellationRequested = true;
      release();
      expect(await result).toEqual([]);
      expect(childReads).toBe(0);
    } finally {
      release();
      fs.promises.readdir = originalReaddir;
      stubWorkspace.findFiles = originalFind;
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('取消令牌:遍历外部根前置取消 → 循环首根即断,不手工走(279)', async () => {
    const ws = makeTmpDir('cancel-pre-ws');
    const assets = makeTmpDir('cancel-pre-assets');
    const originalFind = stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async () => []) as typeof stubWorkspace.findFiles;
    setAssetsRoot(assets);
    try {
      const result = await findFilesAcrossRoots(
        '**/*.py',
        null,
        { isCancellationRequested: true } as never
      );
      expect(result).toEqual([]);
    } finally {
      stubWorkspace.findFiles = originalFind;
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });
});

// RUST-171 发现优先级钉:资产根合成序=profile 选定根 > kbengine.assetsRoot
// 设置 > 自动发现;环境变量按关注点分道(KBENGINE_ROOT=引擎源码树,
// KBENGINE_HOME=bin 路径回退),不参与资产根发现——env 值即使长成引擎树
// 样子也不入资产根链。
describe('RUST-171 发现优先级:profile > 设置 > 自动发现;env 不参与资产根', () => {
  it('profile 选定根存在 → 优先于 assetsRoot 设置与自动发现', () => {
    const ws = makeTmpDir('rust171-ws');
    const assets = makeTmpDir('rust171-assets');
    const profile = makeTmpDir('rust171-profile');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    try {
      setAssetsRoot(assets);
      setActiveProfileScanRoot(profile);
      expect(resolveAssetsRootForWorkspace(ws)).toBe(profile);
      expect(getExternalScanRoots()).toEqual([profile]);
    } finally {
      setActiveProfileScanRoot(null);
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('profile 选定根不存在 → 如实落空走设置链(不占位)', () => {
    const ws = makeTmpDir('rust171-ghost-ws');
    const assets = makeTmpDir('rust171-real-assets');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    try {
      setAssetsRoot(assets);
      setActiveProfileScanRoot(path.join(os.tmpdir(), `kode-rust171-ghost-${Date.now()}`));
      expect(resolveAssetsRootForWorkspace(ws)).toBe(assets);
    } finally {
      setActiveProfileScanRoot(null);
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('KBENGINE_ROOT/KBENGINE_HOME 即使指向引擎树形状也不入资产根链', () => {
    const ws = makeTmpDir('rust171-env-ws');
    const envRoot = makeTmpDir('rust171-envroot');
    fs.mkdirSync(path.join(envRoot, 'kbe/src/lib/common'), { recursive: true });
    fs.writeFileSync(path.join(envRoot, 'kbe/src/lib/common/version.h'), '#define KBENGINE_VERSION "9.9"\n');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    const savedRoot = process.env.KBENGINE_ROOT;
    const savedHome = process.env.KBENGINE_HOME;
    process.env.KBENGINE_ROOT = envRoot;
    process.env.KBENGINE_HOME = envRoot;
    try {
      setAssetsRoot(undefined);
      // 资产根合成序无 env 道:解析落空返回空串(工作区回退在 getIndexScanRoots 组合层)
      expect(resolveAssetsRootForWorkspace(ws)).toBe('');
      expect(getIndexScanRoots()).toEqual([ws]);
    } finally {
      if (savedRoot === undefined) delete process.env.KBENGINE_ROOT; else process.env.KBENGINE_ROOT = savedRoot;
      if (savedHome === undefined) delete process.env.KBENGINE_HOME; else process.env.KBENGINE_HOME = savedHome;
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });
});
