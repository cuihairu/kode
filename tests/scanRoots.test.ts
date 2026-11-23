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
import { PY_SCAN_EXCLUDE } from '../src/backend/pythonScanRules';

// 扫描根口径(用户 2026-10-16:「还有 assetsRoot」;2026-11-23:「只需要扫描
// assetsRoot 目录」):扫描根 = assetsRoot(配置派生 scripts 根 → assetsRoot
// 设置 → 自动发现),去重;assetsRoot 完全落空才回退 workspace 文件夹。
// workspace 顶层不再并入——否则 assets 之外的引擎仓/依赖树全进索引(全盘扫)。
// 任何读取异常都不外抛。

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

describe('getIndexScanRoots:只扫 {assets}/scripts(2026-11-23 用户令;找不到 scripts 就不扫)', () => {
  it('无 assetsRoot 配置:文件夹根下有 scripts → 收窄到 scripts;没有 → 不贡献根(③ 收窄)', () => {
    const ws = makeTmpDir('ws-only');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    try {
      setAssetsRoot(undefined);
      // 未配置、无发现:引擎只认 {assets}/scripts(resmgr/entitydef 派生链钉死),
      // 根下无 scripts = 无 KBEngine 脚本源 → 不整文件夹兜底(2026-11-23 用户令)
      expect(getIndexScanRoots()).toEqual([]);
      expect(getExternalScanRoots()).toEqual([]);
      // 根下有 scripts/ → 默认落点命中,收窄到该 scripts(workspace==assets 布局)
      const ws2 = makeTmpDir('ws-assets-shape');
      fs.mkdirSync(path.join(ws2, 'scripts'), { recursive: true });
      stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws2), name: 'ws', index: 0 }];
      expect(getIndexScanRoots()).toEqual([path.join(ws2, 'scripts')]);
      expect(getExternalScanRoots()).toEqual([]);
    } finally {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('配置了 assetsRoot + scripts 存在 → **只**返回 {assets}/scripts', () => {
    const ws = makeTmpDir('ws-ext');
    const assets = makeTmpDir('assets-ext');
    const scripts = path.join(assets, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    try {
      setAssetsRoot(assets);
      expect(getIndexScanRoots()).toEqual([scripts]);
      expect(getExternalScanRoots()).toEqual([scripts]);
      // 文件归属:{assets}/scripts 下文件归 scripts 根;assets 其余部分/workspace 文件不入
      expect(getScanRootForFile(path.join(scripts, 'base', 'a.py'))).toBe(scripts);
      expect(getScanRootForFile(path.join(assets, 'res', 'x.py'))).toBeNull();
      expect(getScanRootForFile(path.join(ws, 'scripts', 'a.py'))).toBeNull();
      expect(getScanRootForFile(path.join(makeTmpDir('outside'), 'x.py'))).toBeNull();
    } finally {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('assetsRoot 在工作区内 → 仍只返回 {assets}/scripts(不再由 workspace 覆盖)', () => {
    const ws = makeTmpDir('ws-inner');
    const inner = path.join(ws, 'flyff_assets');
    const scripts = path.join(inner, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    try {
      setAssetsRoot(inner);
      expect(getIndexScanRoots()).toEqual([scripts]);
    } finally {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('assetsRoot 指向不存在目录 → 空数组(配置不对,不退回 workspace)', () => {
    const ws = makeTmpDir('ws-ghost');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    try {
      setAssetsRoot(path.join(ws, 'ghost-root'));
      expect(getIndexScanRoots()).toEqual([]);
    } finally {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('无工作区 + 配置 assetsRoot(scripts 存在)→ {assets}/scripts;两者皆无 → 空数组(不抛)', () => {
    const assets = makeTmpDir('assets-only');
    const scripts = path.join(assets, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    try {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(assets);
      expect(getIndexScanRoots()).toEqual([scripts]);
      setAssetsRoot(path.join(os.tmpdir(), `kode-ghost-${Date.now()}`));
      expect(getIndexScanRoots()).toEqual([]);
    } finally {
      setAssetsRoot(undefined);
    }
  });

  it('${workspaceFolder} 占位展开后参与判定(扫 {assets}/scripts)', () => {
    const base = makeTmpDir('expand');
    const ws = path.join(base, 'ws');
    const assets = path.join(base, 'ext_assets');
    const scripts = path.join(assets, 'scripts');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(scripts, { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    try {
      setAssetsRoot('${workspaceFolder}/../ext_assets');
      // 只扫 scripts 令:占位展开后 {assets}/scripts 参与判定,workspace 顶层不入列
      expect(getIndexScanRoots()).toEqual([scripts]);
    } finally {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('自动发现抛错 → 兜底 null,不外抛(不打断索引扫描)', () => {
    // 约定链/深扫描抛错(只读枚举被拒等):发现结果置 null,不外抛也不打断
    // 索引扫描;无配置且根下无 scripts = 无 KBEngine 脚本源,③ 收窄不贡献根。
    const ws = makeTmpDir('disc-throw');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    const spy = vi.spyOn(discoveryModule, 'resolveDiscoveredConfigRoot').mockImplementation(() => {
      throw new Error('discovery enumeration failed');
    });
    try {
      setAssetsRoot(undefined);
      expect(getIndexScanRoots()).toEqual([]);
    } finally {
      spy.mockRestore();
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('审核发现:派生 scripts 根与 {assets}/scripts 同目录 → 只入列一个(去重不重复扫)', () => {
    const base = makeTmpDir('derived-external');
    const ws = path.join(base, 'ws');
    const assets = path.join(base, 'ext_assets');
    const scripts = path.join(assets, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    const spy = vi.spyOn(configDeriveModule, 'getConfigDerivedScanRoot').mockReturnValue(scripts);
    try {
      setAssetsRoot(assets);
      const roots = getIndexScanRoots();
      // 只扫 scripts:assetsRoot 本体不入列,res/entity_defs 等不再被扫(用户 2026-11-23 收窄)
      expect(roots).toEqual([scripts]);
      expect(roots).not.toContain(assets);
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

  // 2026-11-23 用户复核(实测:配置 assetsRoot 后仍全盘扫描):扫描根全在
  // workspace 之外时,workspace 腿不得再走裸 glob——裸 glob 按 workspace 全目录
  // 匹配,workspace 文件会漏进结果。本例钉死:外部 assetsRoot 下 workspace 侧
  // .py 零产出,结果只含扫描根(外部遍历)命中。
  it('外部 assetsRoot:workspace 腿零产出(裸 workspace glob 是全盘扫主因)', async () => {
    const ws = makeTmpDir('ext-narrow-ws');
    const assets = makeTmpDir('ext-narrow-assets');
    fs.mkdirSync(path.join(ws, 'scripts', 'base'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'scripts', 'base', 'WorkspaceNoise.py'), 'class WorkspaceNoise:\n    pass\n');
    fs.mkdirSync(path.join(assets, 'scripts', 'base'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'scripts', 'base', 'Account.py'), 'class Account:\n    pass\n');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    const original = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (pattern?: string) =>
      pattern && pattern.endsWith('.py')
        ? [Uri.file(path.join(ws, 'scripts', 'base', 'WorkspaceNoise.py'))]
        : []) as typeof stubWorkspace.findFiles;
    try {
      setAssetsRoot(assets);
      const py = await findFilesAcrossRoots('**/*.py', null);
      expect(py.map(u => u.fsPath), 'workspace 文件不得进结果(外部 assetsRoot)')
        .toEqual([path.join(assets, 'scripts', 'base', 'Account.py')]);
    } finally {
      stubWorkspace.findFiles = original;
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('托管目录(.kbengine/inferred)副本不进结果(防镜像双计,CFG-017)', async () => {
    const ws = makeTmpDir('mirror-ws');
    const original = Uri.file(path.join(ws, 'scripts', 'base', 'Account.py'));
    const mirror = Uri.file(path.join(ws, '.kbengine', 'inferred', 'scripts', 'base', 'Account.py'));
    // scripts 子目录真实存在(只扫 assetsRoot/scripts 令:isDirectory 判真)
    fs.mkdirSync(path.join(ws, 'scripts', 'base'), { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async () => [original, mirror]) as typeof stubWorkspace.findFiles;
    try {
      // 扫描根 = {ws}/scripts;镜像副本按受管根前缀剔出(CFG-017 口径不变)
      setAssetsRoot(ws);
      const py = await findFilesAcrossRoots('**/*.py', null);
      expect(py.map(u => u.fsPath)).toEqual([original.fsPath]);
    } finally {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  // KODE-RESP-008:外部根/多工作区的受管镜像树副本也要剔——旧版只在遍历前
  // 过滤 workspace glob 结果,收尾又只按首个 workspace 受管根前缀过滤,外部
  // 根自己遍历出来的 .kbengine/inferred 副本与第二工作区的副本都会重新进
  // 结果;且遍历不剪枝,镜像子树白白扫盘。
  it('RESP-008:外部根自身受管镜像树副本不进结果,且遍历不进入其子树(readdir 零次)', async () => {
    const ws = makeTmpDir('r8-ext-ws');
    const assets = makeTmpDir('r8-ext-assets');
    fs.mkdirSync(path.join(assets, 'scripts', 'base'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'scripts', 'base', 'Account.py'), 'class Account:\n    pass\n');
    fs.mkdirSync(path.join(assets, '.kbengine', 'inferred', 'scripts', 'base'), { recursive: true });
    fs.writeFileSync(
      path.join(assets, '.kbengine', 'inferred', 'scripts', 'base', 'Account.py'),
      'class Account:\n    pass\n'
    );
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async () => []) as typeof stubWorkspace.findFiles;
    const originalReaddir = fs.promises.readdir;
    let managedReads = 0;
    fs.promises.readdir = (async (...args: Parameters<typeof originalReaddir>) => {
      if (String(args[0]).startsWith(path.join(assets, '.kbengine'))) {
        managedReads += 1;
      }
      return originalReaddir(...args);
    }) as typeof fs.promises.readdir;
    try {
      setAssetsRoot(assets);
      const py = await findFilesAcrossRoots('**/*.py', null);
      expect(py.map(u => u.fsPath)).toEqual([path.join(assets, 'scripts', 'base', 'Account.py')]);
      expect(managedReads).toBe(0);
    } finally {
      fs.promises.readdir = originalReaddir;
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('RESP-008:多工作区——第二工作区受管树副本同样剔除(旧版只登记首个根)', async () => {
    const wsA = makeTmpDir('r8-multi-wsA');
    const wsB = makeTmpDir('r8-multi-wsB');
    const realA = Uri.file(path.join(wsA, 'scripts', 'Account.py'));
    const mirrorB = Uri.file(path.join(wsB, '.kbengine', 'inferred', 'scripts', 'Account.py'));
    // 扫描根 = {wsA}/scripts(只扫 scripts 令):真实存在才判真
    fs.mkdirSync(path.join(wsA, 'scripts'), { recursive: true });
    stubWorkspace.workspaceFolders = [
      { uri: Uri.file(wsA), name: 'wsA', index: 0 },
      { uri: Uri.file(wsB), name: 'wsB', index: 1 }
    ];
    stubWorkspace.findFiles = (async () => [realA, mirrorB]) as typeof stubWorkspace.findFiles;
    try {
      // 扫描根 = 第一个 workspace 作为 assetsRoot;第二工作区不在扫描根内,
      // 受管镜像副本照旧按受管根前缀剔出(旧版只登记首个根的缺口由 CFG-017 覆盖)
      setAssetsRoot(wsA);
      const py = await findFilesAcrossRoots('**/*.py', null);
      expect(py.map(u => u.fsPath)).toEqual([realA.fsPath]);
    } finally {
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });

  it('RESP-008:外部根嵌套 managedDir(tools/.kbengine)口径保留——副本剔除不误伤容器目录', async () => {
    const ws = makeTmpDir('r8-nested-ws');
    const assets = makeTmpDir('r8-nested-assets');
    fs.mkdirSync(path.join(assets, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'scripts', 'Account.py'), 'class Account:\n    pass\n');
    fs.mkdirSync(path.join(assets, 'tools', '.kbengine', 'inferred', 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(assets, 'tools', '.kbengine', 'inferred', 'scripts', 'Account.py'),
      'class Account:\n    pass\n'
    );
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async () => []) as typeof stubWorkspace.findFiles;
    try {
      configurationOverrides.set('kbengine', { assetsRoot: assets, managedDir: 'tools/.kbengine' });
      resetScanRootCache();
      const py = await findFilesAcrossRoots('**/*.py', null);
      expect(py.map(u => u.fsPath)).toEqual([path.join(assets, 'scripts', 'Account.py')]);
    } finally {
      configurationOverrides.delete('kbengine');
      stubWorkspace.workspaceFolders = [];
      resetScanRootCache();
    }
  });

  it('外部根目录读取挂起期间可取消，取消后不继续遍历子目录', async () => {
    const ws = makeTmpDir('cancel-ws');
    const assets = makeTmpDir('cancel-assets');
    // 扫描根 = {assets}/scripts:挂起与子目录都设在 scripts 下
    fs.mkdirSync(path.join(assets, 'scripts', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'scripts', 'nested', 'Late.py'), 'class Late: pass\n');
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
      if (String(args[0]) === path.join(assets, 'scripts')) { entered(); await gate; }
      if (String(args[0]) === path.join(assets, 'scripts', 'nested')) { childReads += 1; }
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
    // 只扫 scripts 令:profile 根的扫描根 = {profile}/scripts
    fs.mkdirSync(path.join(profile, 'scripts'), { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    try {
      setAssetsRoot(assets);
      setActiveProfileScanRoot(profile);
      expect(resolveAssetsRootForWorkspace(ws)).toBe(profile);
      expect(getExternalScanRoots()).toEqual([path.join(profile, 'scripts')]);
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
      // env 不入链 = 无配置无发现,引擎树形状的根无 scripts → ③ 收窄不贡献根
      expect(getIndexScanRoots()).toEqual([]);
    } finally {
      if (savedRoot === undefined) delete process.env.KBENGINE_ROOT; else process.env.KBENGINE_ROOT = savedRoot;
      if (savedHome === undefined) delete process.env.KBENGINE_HOME; else process.env.KBENGINE_HOME = savedHome;
      stubWorkspace.workspaceFolders = [];
      setAssetsRoot(undefined);
    }
  });
});

// P1 扫描面(2026-11-24 用户令):①多根工作区串 glob 泄漏其他项目;②
// assetsRoot 误配仍退回 workspace 裸 glob 全盘扫。用例全部用真实临时目录,
// 在两根中放置相同相对路径的文件,直接断言最终返回的绝对路径。
describe('P1 扫描面:多根泄漏与误配兜底(真实临时目录)', () => {
  /** 真实 vscode findFiles 语义替身:字符串 glob 对每个 workspace 文件夹各
   * 匹配一遍(泄漏通道);RelativePattern 只在其 base 内匹配。清单 = 各根
   * 实际落盘的 .py 相对路径。 */
  const stubFindFilesRealSemantics = (
    pyByRoot: Record<string, string[]>
  ): void => {
    const relGlobMatches = (glob: string, rel: string): boolean => {
      const segs = glob.split('/');
      const parts = rel.split(path.sep);
      const match = (gi: number, si: number): boolean => {
        if (gi === segs.length) {
          return si === parts.length;
        }
        if (segs[gi] === '**') {
          for (let k = si; k <= parts.length; k += 1) {
            if (match(gi + 1, k)) {
              return true;
            }
          }
          return false;
        }
        if (si === parts.length) {
          return false;
        }
        const re = new RegExp(
          `^${segs[gi].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`
        );
        return re.test(parts[si]) && match(gi + 1, si + 1);
      };
      return match(0, 0);
    };
    stubWorkspace.findFiles = (async (
      pattern?: unknown
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<any[]> => {
      const out: any[] = [];
      if (typeof pattern === 'string') {
        for (const folder of stubWorkspace.workspaceFolders ?? []) {
          for (const rel of pyByRoot[folder.uri.fsPath] ?? []) {
            if (relGlobMatches(pattern, rel)) {
              out.push(Uri.file(path.join(folder.uri.fsPath, rel)));
            }
          }
        }
        return out;
      }
      const rp = pattern as { base: string | { fsPath: string }; pattern: string };
      const baseFs = typeof rp.base === 'string' ? rp.base : rp.base.fsPath;
      for (const rel of pyByRoot[baseFs] ?? []) {
        if (relGlobMatches(rp.pattern, rel)) {
          out.push(Uri.file(path.join(baseFs, rel)));
        }
      }
      return out;
    }) as typeof stubWorkspace.findFiles;
  };

  it('P1-3 多根工作区:只 A 根入选,B 根同相对路径文件不得扫入(断言最终绝对路径)', async () => {
    const base = makeTmpDir('multi');
    const dirA = path.join(base, 'proj-a');
    const dirB = path.join(base, 'proj-b');
    const relPy = path.join('assets', 'scripts', 'space', 'mod.py');
    for (const dir of [dirA, dirB]) {
      fs.mkdirSync(path.join(dir, path.dirname(relPy)), { recursive: true });
      fs.writeFileSync(path.join(dir, relPy), 'import KBEngine\n');
    }
    const originalFolders = stubWorkspace.workspaceFolders;
    const originalFind = stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [
      { uri: Uri.file(dirA), name: 'proj-a', index: 0 },
      { uri: Uri.file(dirB), name: 'proj-b', index: 1 }
    ];
    setAssetsRoot('${workspaceFolder}/assets');
    stubFindFilesRealSemantics({
      [dirA]: [relPy],
      [dirB]: [relPy]
    });
    try {
      resetScanRootCache();
      // 前提:assetsRoot 按 ${workspaceFolder} 只锚到首根 → 扫描根只有 A 的
      expect(getIndexScanRoots()).toEqual([path.join(dirA, 'assets', 'scripts')]);
      const files = await findFilesAcrossRoots('**/*.py', PY_SCAN_EXCLUDE);
      // 断言最终绝对路径:只允许 A 根的文件;B 根的同相对路径文件绝不入列
      // (修前:收窄 glob 是字符串形态,跨全部文件夹匹配,B 文件以 A 根身份漏进)
      expect(files.map(u => u.fsPath)).toEqual([path.join(dirA, relPy)]);
    } finally {
      stubWorkspace.workspaceFolders = originalFolders;
      stubWorkspace.findFiles = originalFind;
      setAssetsRoot(undefined);
    }
  });

  it('P1-2 assetsRoot 指向不存在目录:配置无效不退回 workspace 裸 glob(零文件)', async () => {
    const ws = makeTmpDir('misconfig');
    fs.mkdirSync(path.join(ws, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'tools', 'util.py'), 'x = 1\n');
    const originalFolders = stubWorkspace.workspaceFolders;
    const originalFind = stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    setAssetsRoot('${workspaceFolder}/no-such-assets');
    stubFindFilesRealSemantics({ [ws]: [path.join('tools', 'util.py')] });
    try {
      resetScanRootCache();
      // 扫描根空(配置无效,锚点腿也定位不到),此时 workspace 腿必须零产出:
      // 裸 glob 兜底会把 tools/ 全盘扫进来掩盖配置错误
      const files = await findFilesAcrossRoots('**/*.py', PY_SCAN_EXCLUDE);
      expect(files).toEqual([]);
    } finally {
      stubWorkspace.workspaceFolders = originalFolders;
      stubWorkspace.findFiles = originalFind;
      setAssetsRoot(undefined);
    }
  });

  it('P1-2 assetsRoot 在而 scripts 缺:零文件(既有口径)', async () => {
    const ws = makeTmpDir('assets-noscripts');
    fs.mkdirSync(path.join(ws, 'assets', 'res'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'assets', 'res', 'ui.py'), 'x = 1\n');
    const originalFolders = stubWorkspace.workspaceFolders;
    const originalFind = stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    setAssetsRoot('${workspaceFolder}/assets');
    stubFindFilesRealSemantics({ [ws]: [path.join('assets', 'res', 'ui.py')] });
    try {
      resetScanRootCache();
      const files = await findFilesAcrossRoots('**/*.py', PY_SCAN_EXCLUDE);
      expect(files).toEqual([]);
    } finally {
      stubWorkspace.workspaceFolders = originalFolders;
      stubWorkspace.findFiles = originalFind;
      setAssetsRoot(undefined);
    }
  });

  it('P1-2 未配置(普通 Python 工作区):scripts 收窄腿维持既有行为', async () => {
    const ws = makeTmpDir('plain-py');
    fs.mkdirSync(path.join(ws, 'scripts', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'scripts', 'pkg', 'app.py'), 'x = 1\n');
    fs.mkdirSync(path.join(ws, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'tools', 'util.py'), 'x = 1\n');
    const originalFolders = stubWorkspace.workspaceFolders;
    const originalFind = stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    setAssetsRoot(undefined);
    stubFindFilesRealSemantics({
      [ws]: [path.join('scripts', 'pkg', 'app.py'), path.join('tools', 'util.py')]
    });
    try {
      resetScanRootCache();
      expect(getIndexScanRoots()).toEqual([path.join(ws, 'scripts')]);
      const files = await findFilesAcrossRoots('**/*.py', PY_SCAN_EXCLUDE);
      expect(files.map(u => u.fsPath)).toEqual([path.join(ws, 'scripts', 'pkg', 'app.py')]);
    } finally {
      stubWorkspace.workspaceFolders = originalFolders;
      stubWorkspace.findFiles = originalFind;
      setAssetsRoot(undefined);
    }
  });
});
