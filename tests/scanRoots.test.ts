import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Uri } from './fake-vscode/core';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';
import {
  findFilesAcrossRoots,
  getIndexScanRoots,
  getExternalScanRoots,
  getScanRootForFile,
  resetScanRootCache
} from '../src/scanRoots';

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
});
