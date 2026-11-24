import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ensureAnchorScanRoot,
  findFilesAcrossRoots,
  findFilesForKbengineSurfaces,
  getIndexScanRoots,
  resetScanRootCache
} from '../src/scanRoots';
import { resetExtensionTestState } from './extensionTestShared';
import { configurationOverrides, workspace } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';

/**
 * 锚点放开腿(2026-11-23 用户令二段「默认目录没有发现才放开范围去扫描」;
 * 引擎源码 resmgr.cpp:489 + entitydef.cpp:159/176-181 钉死 entities.xml /
 * entity_defs 只在 {scripts} 一处)。
 *
 * 场景:workspace 里没有任何 folder 顶层 scripts、也没有 assetsRoot 配置,
 * 资产按引擎默认布局落在 `<ws>/proj/assets/scripts`。收窄主腿全空,唯一允许
 * 的放开 = 按默认布局定位的 scripts 根;此前这里会落进 workspace 裸 glob
 * 兜底(全盘扫),正是用户实测「还是扫描到 scripts 之外」的来源。
 */
const normalize = (p: string): string => p.replace(/\\/g, '/');

const walkReal = (root: string, match: (fsPath: string) => boolean): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== 'node_modules') {
          walk(full);
        }
      } else if (entry.isFile() && match(full)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
};

describe('扫描根锚点腿(引擎默认布局)', () => {
  const ORIGINAL = workspace.findFiles;
  let root = '';

  beforeEach(() => {
    resetExtensionTestState();
    resetScanRootCache();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-anchor-'));
  });

  /** workspace 域 findFiles 按真实目录 walk 模拟;首个双星号之前的字面前缀
   * 段是 vscode findFiles 的隐式子目录域——scoped glob 只在该子目录下匹配,
   * 与生产语义同构 */
  const stubWorkspaceGlob = (): void => {
    workspace.findFiles = (async (pattern?: unknown) => {
      let glob: string;
      let base: string;
      if (pattern && typeof pattern === 'object') {
        // RelativePattern(P1-3 收窄腿):钉在 base 内按 pattern 匹配;
        // pattern 的字面前缀段同样收窄 walk 域(与字符串腿同构)
        const rp = pattern as { base: string | { fsPath: string }; pattern: string };
        glob = rp.pattern;
        const rpBase = typeof rp.base === 'string' ? rp.base : rp.base.fsPath;
        const rpPrefix = glob.split('**')[0].replace(/\/+$/, '');
        base = rpPrefix ? path.join(rpBase, rpPrefix) : rpBase;
      } else {
        // 字符串 glob:首个双星号之前的字面前缀段是隐式子目录域
        glob = String(pattern ?? '');
        const prefix = glob.split('**')[0].replace(/\/+$/, '');
        base = prefix ? path.join(root, prefix) : root;
      }
      const match = glob.includes('entities.xml')
        ? (fsPath: string): boolean => path.basename(fsPath) === 'entities.xml'
        : glob.includes('entity_defs/*.def')
          ? (fsPath: string): boolean =>
              normalize(fsPath).includes('/entity_defs/') && fsPath.endsWith('.def')
          : (fsPath: string): boolean => fsPath.endsWith('.py');
      return walkReal(base, match).map(Uri.file);
    }) as typeof workspace.findFiles;
  };

  const makeDefaultLayout = (): string => {
    const scripts = path.join(root, 'proj', 'assets', 'scripts');
    fs.mkdirSync(path.join(scripts, 'entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(scripts, 'entities.xml'), '<root/>');
    fs.writeFileSync(path.join(scripts, 'entity_defs', 'Avatar.def'), '<root/>');
    fs.writeFileSync(path.join(scripts, 'Avatar.py'), 'class Avatar:\n  pass\n');
    // scripts 之外的诱饵:锚点根定位后不得被扫进来
    fs.mkdirSync(path.join(root, 'proj', 'tools'), { recursive: true });
    fs.writeFileSync(path.join(root, 'proj', 'tools', 'Decoy.py'), 'x = 1\n');
    return scripts;
  };

  it('默认布局命中:根 = scripts 目录,scripts 外文件不入扫描', async () => {
    const scripts = makeDefaultLayout();
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubWorkspaceGlob();
    try {
      // 探测前:主腿全空(folder 顶层无 scripts、无 assetsRoot 配置)
      expect(getIndexScanRoots(), '锚点未探测时主腿为空').toEqual([]);

      const anchor = await ensureAnchorScanRoot();
      expect(normalize(anchor ?? ''), '锚点 = 有 entities.xml 的 scripts 目录').toBe(
        normalize(scripts)
      );

      expect(getIndexScanRoots().map(normalize)).toEqual([normalize(scripts)]);
      const scannedPy = (await findFilesAcrossRoots('**/*.py', null)).map(uri => normalize(uri.fsPath));
      expect(scannedPy).toEqual([normalize(path.join(scripts, 'Avatar.py'))]);
      expect(scannedPy, 'scripts 之外的诱饵不入扫描').not.toContain(
        normalize(path.join(root, 'proj', 'tools', 'Decoy.py'))
      );
    } finally {
      workspace.findFiles = ORIGINAL;
      configurationOverrides.delete('kbengine');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('P2 统一入口 findFilesForKbengineSurfaces:锚点根先行内建于入口(F12/ruff/配置数据三面)', async () => {
    const scripts = makeDefaultLayout();
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubWorkspaceGlob();
    try {
      // 探测前主腿为空;统一入口内部先 ensureAnchorScanRoot 再取根——调用方
      // 不再自持「锚点先行 + 收窄/裸 glob 三元」的本地装配(三面各写一份
      // 正是误配时各自跌回裸 glob 的来源)
      const files = (await findFilesForKbengineSurfaces('**/*.py', null)).map(uri =>
        normalize(uri.fsPath)
      );
      expect(files).toEqual([normalize(path.join(scripts, 'Avatar.py'))]);
      expect(files, 'scripts 之外的诱饵不入扫描').not.toContain(
        normalize(path.join(root, 'proj', 'tools', 'Decoy.py'))
      );
    } finally {
      workspace.findFiles = ORIGINAL;
      configurationOverrides.delete('kbengine');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('默认布局缺席:不放开(空根),不退回 workspace 全量', async () => {
    fs.mkdirSync(path.join(root, 'proj', 'tools'), { recursive: true });
    fs.writeFileSync(path.join(root, 'proj', 'tools', 'Only.py'), 'x = 1\n');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubWorkspaceGlob();
    try {
      expect(await ensureAnchorScanRoot(), '无默认布局 = 无锚点').toBeNull();
      expect(getIndexScanRoots(), '无锚点维持空根').toEqual([]);
    } finally {
      workspace.findFiles = ORIGINAL;
      configurationOverrides.delete('kbengine');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('锚点记忆随 resetScanRootCache 失效', async () => {
    const scripts = makeDefaultLayout();
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubWorkspaceGlob();
    try {
      await ensureAnchorScanRoot();
      expect(getIndexScanRoots().map(normalize)).toEqual([normalize(scripts)]);
      resetScanRootCache();
      expect(getIndexScanRoots(), '记忆清空后回到主腿(空)').toEqual([]);
    } finally {
      workspace.findFiles = ORIGINAL;
      configurationOverrides.delete('kbengine');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
