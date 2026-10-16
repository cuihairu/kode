import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { Uri } from './fake-vscode/core';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { expandWorkspacePlaceholders } from '../src/workspacePath';
import { KBEngineServerManager } from '../src/serverManager';
import { getIndexScanRoots, getScanRootForFile, resetScanRootCache } from '../src/scanRoots';
import { EntityMappingManager } from '../src/entityMapping';

// 相对路径锚定(用户令 2026-10-16):相对一律以仓库根(或其声明的 assetsRoot)
// 为基准解析,任何一处相对 cwd 解析都是 bug。逐点锁:中央展开、assetsRoot
// 扫描根、serverManager 二进制/资产根、owner 文件收集的无根跳过。

const tmpDirs: string[] = [];
const makeTmpDir = (label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kode-anchoring-${label}-`));
  tmpDirs.push(dir);
  return dir;
};

const setFolders = (roots: string[]): void => {
  stubWorkspace.workspaceFolders = roots.map((fsPath, index) => ({
    uri: Uri.file(fsPath),
    name: path.basename(fsPath),
    index
  }));
};

const setConfig = (table: Record<string, unknown> | undefined): void => {
  if (table === undefined) {
    configurationOverrides.delete('kbengine');
  } else {
    configurationOverrides.set('kbengine', table);
  }
  resetScanRootCache();
};

afterAll(() => {
  setConfig(undefined);
  setFolders([]);
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('中央展开 expandWorkspacePlaceholders:相对 → 仓库根,无根 → 空串', () => {
  it('相对 join(root);绝对/空原样;无根不落 cwd', () => {
    expect(expandWorkspacePlaceholders('assets/kbengine.xml', '/proj')).toBe('/proj/assets/kbengine.xml');
    expect(expandWorkspacePlaceholders('/abs/x', '/proj')).toBe('/abs/x');
    expect(expandWorkspacePlaceholders('', '/proj')).toBe('');
    expect(expandWorkspacePlaceholders('assets/x', undefined)).toBe('');
  });
});

describe('serverManager:相对 binPath / assetsRoot 锚定仓库根', () => {
  it('getBinPath 相对值 join(workspace);无工作区 → 空串', () => {
    const root = makeTmpDir('bin');
    try {
      setFolders([root]);
      setConfig({ binPath: 'kbe/bin/server' });
      expect(new KBEngineServerManager({} as never).getBinPath()).toBe(
        path.join(root, 'kbe', 'bin', 'server')
      );
      setFolders([]);
      expect(new KBEngineServerManager({} as never).getBinPath()).toBe('');
    } finally {
      setConfig(undefined);
      setFolders([]);
    }
  });

  it('getConfigPath 相对值 join(workspace);无工作区 → 空串', () => {
    const root = makeTmpDir('cfg');
    try {
      setFolders([root]);
      // 相对且探测/发现都 miss → 返回按仓库根锚定后的值(不再原样相对值)
      setConfig({ assetsRoot: 'ghost_assets' });
      expect(new KBEngineServerManager({} as never).getConfigPath()).toBe(
        path.join(root, 'ghost_assets')
      );
      setFolders([]);
      expect(new KBEngineServerManager({} as never).getConfigPath()).toBe('');
    } finally {
      setConfig(undefined);
      setFolders([]);
    }
  });
});

describe('扫描根:相对 assetsRoot 的锚定', () => {
  it('相对值按仓库根解析(外部目录入列),无工作区 → 空根', () => {
    const ws = makeTmpDir('scan-ws');
    const ext = makeTmpDir('scan-ext');
    try {
      setFolders([ws]);
      // 相对形式表达的 workspace 外目录:join(workspaceRoot, rel) 才能得到它
      setConfig({ assetsRoot: path.relative(ws, ext) });
      const roots = getIndexScanRoots().map(root => path.resolve(root));
      expect(roots).toContain(path.resolve(ws));
      expect(roots, '相对 assetsRoot 锚定仓库根后应解析到外部目录').toContain(path.resolve(ext));
      expect(getScanRootForFile(path.join(ext, 'scripts', 'a.py'))).toBe(ext);

      setFolders([]);
      expect(getIndexScanRoots(), '无工作区 + 相对 assetsRoot → 不落 cwd、不失败').toEqual([]);
    } finally {
      setConfig(undefined);
      setFolders([]);
    }
  });
});

describe('owner 文件收集:无锚定根时不做相对 cwd 的探测', () => {
  it('cwd 下恰有同名脚本也不收集(getWorkspaceRoot 为 null → [])', () => {
    const anchor = makeTmpDir('cwd-anchor');
    const ghostScript = path.join(anchor, 'scripts', 'base', 'Ghost.py');
    fs.mkdirSync(path.dirname(ghostScript), { recursive: true });
    fs.writeFileSync(ghostScript, 'class Ghost:\n    pass\n', 'utf8');

    const previousCwd = process.cwd();
    try {
      process.chdir(anchor);
      setFolders([]);
      setConfig(undefined);

      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      (manager as unknown as { getWorkspaceRoot: (filePath: string) => string | null }).getWorkspaceRoot =
        () => null;
      const semantics = {
        owner: { kind: 'entity', name: 'Ghost', filePath: path.join(anchor, 'entity_defs', 'Ghost.def') },
        effectiveProperties: [],
        effectiveMethodsBySection: { BaseMethods: [], CellMethods: [], ClientMethods: [] },
        components: []
      } as never;
      const files = (manager as unknown as {
        collectPythonOwnerFiles: (value: never) => unknown[];
      }).collectPythonOwnerFiles(semantics);
      expect(files, '无锚定根 → 一律不收集(相对候选曾会按 cwd 命中)').toEqual([]);
      manager.dispose();
    } finally {
      process.chdir(previousCwd);
    }
  });
});
