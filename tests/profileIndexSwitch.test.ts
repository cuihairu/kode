import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Uri } from './fake-vscode/core';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';
import {
  getActiveProfileScanRoot,
  getIndexScanRoots,
  resetScanRootCache,
  setActiveProfileScanRoot
} from '../src/scanRoots';
import { bumpRootConfigGeneration, getRootConfigGeneration, resetRootConfigGenerationForTests } from '../src/rootConfigGeneration';
import { EntityMappingManager } from '../src/entityMapping';

// IDE-PRJ-011:语言索引响应 profile 切换。索引输入切到活动 profile 的选定
// 根(优先于 assetsRoot 设置/自动发现);切换使根配置 generation 前进,
// 旧 profile 在途扫描批次经代闸整体不再写入当前快照(扫描输入已过期,
// 新输入由新扫描重建)。

const write = (base: string, relative: string, content: string): void => {
  const target = path.join(base, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const until = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`timeout waiting for ${label}`);
};

describe('active profile scan root precedence (IDE-PRJ-011)', () => {
  const tmpDirs: string[] = [];
  const makeTmpDir = (label: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kode-prj11-${label}-`));
    tmpDirs.push(dir);
    return dir;
  };

  afterAll(() => {
    setActiveProfileScanRoot(null);
    configurationOverrides.delete('kbengine');
    stubWorkspace.workspaceFolders = [];
    resetScanRootCache();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the selected profile root becomes the index input, ahead of the configured assetsRoot', () => {
    const ws = makeTmpDir('ws');
    const configured = makeTmpDir('configured');
    const profileRoot = makeTmpDir('profile');
    // 只扫 assetsRoot/scripts 令:扫描根是选定根的 scripts 子目录
    const configuredScripts = path.join(configured, 'scripts');
    const profileScripts = path.join(profileRoot, 'scripts');
    fs.mkdirSync(configuredScripts, { recursive: true });
    fs.mkdirSync(profileScripts, { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    configurationOverrides.set('kbengine', { assetsRoot: configured });
    resetScanRootCache();
    try {
      setActiveProfileScanRoot(profileRoot);
      expect(getActiveProfileScanRoot()).toBe(profileRoot);
      const roots = getIndexScanRoots();
      // 输入切换:选定根的 scripts 入列,配置根被选定根取代(显式选择优先)
      expect(roots).toContain(profileScripts);
      expect(roots).not.toContain(configuredScripts);
    } finally {
      setActiveProfileScanRoot(null);
      configurationOverrides.delete('kbengine');
      resetScanRootCache();
      stubWorkspace.workspaceFolders = [];
    }
  });

  it('clearing the selection restores the configured assetsRoot input', () => {
    const ws = makeTmpDir('ws2');
    const configured = makeTmpDir('configured2');
    const profileRoot = makeTmpDir('profile2');
    const configuredScripts = path.join(configured, 'scripts');
    const profileScripts = path.join(profileRoot, 'scripts');
    fs.mkdirSync(configuredScripts, { recursive: true });
    fs.mkdirSync(profileScripts, { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    configurationOverrides.set('kbengine', { assetsRoot: configured });
    resetScanRootCache();
    try {
      setActiveProfileScanRoot(profileRoot);
      expect(getIndexScanRoots()).not.toContain(configuredScripts);
      setActiveProfileScanRoot(null);
      // 清选择后回落配置根(仍按 scripts 子目录扫)
      expect(getIndexScanRoots()).toContain(configuredScripts);
    } finally {
      setActiveProfileScanRoot(null);
      configurationOverrides.delete('kbengine');
      resetScanRootCache();
      stubWorkspace.workspaceFolders = [];
    }
  });

  it('a selected root that is gone from disk is dropped honestly, the configured root stands', () => {
    const ws = makeTmpDir('ws3');
    const configured = makeTmpDir('configured3');
    const configuredScripts = path.join(configured, 'scripts');
    fs.mkdirSync(configuredScripts, { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    configurationOverrides.set('kbengine', { assetsRoot: configured });
    resetScanRootCache();
    try {
      setActiveProfileScanRoot(path.join(os.tmpdir(), 'kode-prj11-not-there'));
      // 幽灵选定根如实落空 → 回落配置根的 scripts 子目录(只扫 scripts 令)
      expect(getIndexScanRoots()).toEqual([configuredScripts]);
    } finally {
      setActiveProfileScanRoot(null);
      configurationOverrides.delete('kbengine');
      resetScanRootCache();
      stubWorkspace.workspaceFolders = [];
    }
  });
});

describe('profile switch gates in-flight scan writes by generation (IDE-PRJ-011)', () => {
  beforeAll(() => {
    resetRootConfigGenerationForTests();
  });
  afterAll(() => {
    resetRootConfigGenerationForTests();
    setActiveProfileScanRoot(null);
    stubWorkspace.workspaceFolders = [];
    stubWorkspace.findFiles = async () => [] as Uri[];
    resetScanRootCache();
  });

  it('a scan started under the old profile writes nothing after the switch; a fresh scan under the new input builds', async () => {
    const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-prj11-flight-a-'));
    const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-prj11-flight-b-'));
    try {
      write(wsA, 'scripts/entity_defs/HeroA.def',
        '<root>\n  <BaseMethods>\n    <onA/>\n  </BaseMethods>\n</root>');
      write(wsA, 'scripts/base/HeroA.py', 'class HeroA(object):\n    def onA(self):\n        pass\n');
      write(wsB, 'scripts/entity_defs/HeroB.def',
        '<root>\n  <BaseMethods>\n    <onB/>\n  </BaseMethods>\n</root>');
      write(wsB, 'scripts/base/HeroB.py', 'class HeroB(object):\n    def onB(self):\n        pass\n');

      const originalFolders = stubWorkspace.workspaceFolders;
      const originalFind = stubWorkspace.findFiles;
      // 初始扫描根 = profile A 的 scripts 根(2026-11-23 只扫 assetsRoot/scripts 令):
      // 扫描根是 {profile}/scripts,不是整个 profile 或双工作区。
      stubWorkspace.workspaceFolders = [{ uri: Uri.file(wsA), name: 'wsA', index: 0 }];
      setActiveProfileScanRoot(wsA);
      resetScanRootCache();
      const walkDirs = (bases: string[]): Uri[] => {
        const results: Uri[] = [];
        const walk = (dir: string): void => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name.endsWith('.def')) { results.push(Uri.file(full)); }
          }
        };
        for (const base of bases) { walk(base); }
        return results;
      };
      // 发现快照在进闸门前取好(模型:清单已交给扫描,批执行窗口用代闸卡住)
      let releaseDiscovery!: () => void;
      const discoveryGate = new Promise<void>(resolve => { releaseDiscovery = resolve; });
      let discoveryEntered = false;
      stubWorkspace.findFiles = (async () => {
        const snapshot = walkDirs([wsA]);
        discoveryEntered = true;
        await discoveryGate;
        return snapshot;
      }) as typeof stubWorkspace.findFiles;

      const staleManager = new EntityMappingManager({ subscriptions: [] });
      try {
        await until(() => discoveryEntered, 'discovery snapshot taken');
        // 扫描在途:profile 切到 B(输入只剩 B),generation 前进
        setActiveProfileScanRoot(wsB);
        resetScanRootCache();
        const generationBeforeSwitch = getRootConfigGeneration();
        bumpRootConfigGeneration('profile-switch');
        expect(getRootConfigGeneration()).toBeGreaterThan(generationBeforeSwitch);
        releaseDiscovery();
        await staleManager.waitForInitialScan();
        await new Promise(resolve => setImmediate(resolve));

        // 旧输入(A)的在途结果整体不写入:扫描按旧输入(仅 A)起步,代已前进,
        // A 与 B 都不落当前快照(新输入由新扫描重建)
        expect(staleManager.getMapping('HeroA')).toBeUndefined();
        expect(staleManager.getMapping('HeroB')).toBeUndefined();
      } finally {
        staleManager.dispose();
      }

      // 新扫描(新代起步,输入=选定根 B):B 正常建立
      stubWorkspace.findFiles = (async () => walkDirs([wsB])) as typeof stubWorkspace.findFiles;
      const freshManager = new EntityMappingManager({ subscriptions: [] });
      try {
        await freshManager.waitForInitialScan();
        await new Promise(resolve => setImmediate(resolve));
        expect(freshManager.getMapping('HeroB')).toBeDefined();
      } finally {
        freshManager.dispose();
        stubWorkspace.findFiles = originalFind;
        stubWorkspace.workspaceFolders = originalFolders;
        setActiveProfileScanRoot(null);
        resetScanRootCache();
      }
    } finally {
      fs.rmSync(wsA, { recursive: true, force: true });
      fs.rmSync(wsB, { recursive: true, force: true });
    }
  }, 20000);
});
