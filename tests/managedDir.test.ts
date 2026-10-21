import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MANAGED_DIR_DEFAULT,
  MANAGED_DIR_SETTING_FULL,
  resolveManagedDirName
} from '../src/managedDir';
import {
  exportKbeStubs,
  fileSystemStubExportDeps,
  managedDirPath,
  kbeStubDir,
  readManagedDirSetting,
  resolveStubDir
} from '../src/pythonStubExport';
import {
  debugConfigPath,
  debugConfigRelativeSegments,
  ensureDebugConfig,
  fileSystemBootstrapDeps
} from '../src/debugConfigBootstrap';
import {
  configurationOverrides,
  Uri,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// 托管目录可配置 + 默认自动重建(任务 B,用户令 2026-10-21):
// - 新键 kbengine.managedDir 统一收拢 kode 托管目录,默认值就是 .kbengine;
// - 旧键不废:kbengine.python.stubDir(设置 > 环境变量 > 默认约定)语义原样,
//   仍优先于「托管目录/stubs」;
// - debugConfigBootstrap 的固定段改走同一默认/配置解析;
// - 目录被删后,下一次导出链执行(激活/watcher 事件)即重建全链(缺失即生成,
//   内容一致零写),不需重载窗口。

const ROOT = '/ws/main';

describe('resolveManagedDirName(默认/配置解析)', () => {
  it('未配置/空串/非字符串 → 默认 .kbengine', () => {
    expect(resolveManagedDirName()).toEqual({ name: '.kbengine', fromDefault: true });
    expect(resolveManagedDirName(undefined)).toEqual({ name: '.kbengine', fromDefault: true });
    expect(resolveManagedDirName('   ')).toEqual({ name: '.kbengine', fromDefault: true });
    expect(resolveManagedDirName(42)).toEqual({ name: '.kbengine', fromDefault: true });
    expect(MANAGED_DIR_DEFAULT).toBe('.kbengine');
  });

  it('配置值剥空白与尾部斜杠;fromDefault=false', () => {
    expect(resolveManagedDirName('.kbe2')).toEqual({ name: '.kbe2', fromDefault: false });
    expect(resolveManagedDirName('  kode-managed/ ')).toEqual({
      name: 'kode-managed',
      fromDefault: false
    });
  });

  it('设置键收拢为 kbengine.managedDir', () => {
    expect(MANAGED_DIR_SETTING_FULL).toBe('kbengine.managedDir');
  });
});

describe('托管目录落点(pythonStubExport 面)', () => {
  afterEach(() => {
    configurationOverrides.clear();
  });

  it('managedDirPath / kbeStubDir:默认 .kbengine/stubs,配置后同迁', () => {
    expect(managedDirPath(ROOT)).toBe(`${ROOT}/.kbengine`);
    expect(kbeStubDir(ROOT)).toBe(`${ROOT}/.kbengine/stubs`);
    expect(managedDirPath(ROOT, '.kbe2')).toBe(`${ROOT}/.kbe2`);
    expect(kbeStubDir(ROOT, '.kbe2')).toBe(`${ROOT}/.kbe2/stubs`);
  });

  it('resolveStubDir 默认约定随托管目录同迁,仍标 kode 自管', () => {
    const resolved = resolveStubDir(ROOT, { managedDir: '.kbe2' });
    expect(resolved.dir).toBe(`${ROOT}/.kbe2/stubs`);
    expect(resolved.source).toBe('default');
    expect(resolved.origin).toBe('.kbe2/stubs');
    expect(resolved.userOwned).toBe(false);
  });

  it('旧键不废:kbengine.python.stubDir 设置仍优先,且不受 managedDir 影响', () => {
    const resolved = resolveStubDir(ROOT, { setting: 'typings/stubs', managedDir: '.kbe2' });
    expect(resolved.dir).toBe(`${ROOT}/typings/stubs`);
    expect(resolved.source).toBe('setting');
    expect(resolved.userOwned).toBe(true);
  });

  it('readManagedDirSetting 读 kbengine 段的 managedDir 键(装配层)', () => {
    expect(readManagedDirSetting()).toBe(MANAGED_DIR_DEFAULT);
    configurationOverrides.set('kbengine', { managedDir: '.kbe2' });
    expect(readManagedDirSetting()).toBe('.kbe2');
  });

  it('导出链按配置目录落盘(默认 .kbengine 之外的 managedDir)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-managed-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      configurationOverrides.set('kbengine', { managedDir: '.kbe2' });
      const written = await exportKbeStubs(fileSystemStubExportDeps, { silent: true });
      expect(written).toEqual(['ws']);
      expect(fs.existsSync(path.join(root, '.kbe2', 'stubs', 'KBEngine.pyi'))).toBe(true);
      expect(fs.existsSync(path.join(root, '.kbengine'))).toBe(false);
    } finally {
      configurationOverrides.clear();
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('debugConfigBootstrap 托管目录段(同一默认/配置解析)', () => {
  it('debugConfigRelativeSegments / debugConfigPath:默认段不变,配置段随 managedDir', () => {
    expect(debugConfigRelativeSegments()).toEqual(['.kbengine', 'debug.json']);
    expect(debugConfigRelativeSegments('.kbe2')).toEqual(['.kbe2', 'debug.json']);
    expect(debugConfigPath(ROOT)).toBe(`${ROOT}/.kbengine/debug.json`);
    expect(debugConfigPath(ROOT, '.kbe2')).toBe(`${ROOT}/.kbe2/debug.json`);
  });

  it('ensureDebugConfig 带 managedDirName 写自定义目录;缺省仍写 .kbengine', () => {
    const seen: string[] = [];
    const deps = {
      ...fileSystemBootstrapDeps,
      exists: (): boolean => false,
      mkdir: (dir: string): void => {
        seen.push(`mkdir:${dir}`);
      },
      writeFile: (target: string): void => {
        seen.push(`write:${target}`);
      }
    };
    ensureDebugConfig(deps, { workspaceFolders: [{ name: 'ws', fsPath: ROOT }], managedDirName: '.kbe2' });
    expect(seen).toEqual([
      `mkdir:${ROOT}/.kbe2`,
      `write:${ROOT}/.kbe2/debug.json`
    ]);

    const plain: string[] = [];
    ensureDebugConfig(
      {
        ...fileSystemBootstrapDeps,
        exists: (): boolean => false,
        mkdir: (dir: string): void => plain.push(dir),
        writeFile: (target: string): void => plain.push(target)
      },
      { workspaceFolders: [{ name: 'ws', fsPath: ROOT }] }
    );
    expect(plain).toEqual([`${ROOT}/.kbengine`, `${ROOT}/.kbengine/debug.json`]);
  });

  it('默认自动重建:debug.json 被删后再次执行即重建(缺失即生成)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-regen-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      const deps = fileSystemBootstrapDeps;
      const options = { workspaceFolders: [{ name: 'ws', fsPath: root }] };
      expect(ensureDebugConfig(deps, options).status).toBe('created');
      expect(fs.existsSync(path.join(root, '.kbengine', 'debug.json'))).toBe(true);
      expect(ensureDebugConfig(deps, options).status).toBe('exists');
      // 目录被整个删掉(watcher 事件的后果):不重载,下一次相关事件重建
      fs.rmSync(path.join(root, '.kbengine'), { recursive: true, force: true });
      expect(ensureDebugConfig(deps, options).status).toBe('created');
      expect(fs.existsSync(path.join(root, '.kbengine', 'debug.json'))).toBe(true);
    } finally {
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
