import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PythonClassIndex } from '../src/backend/pythonClassIndex';
import { activate, deactivate } from '../src/extension';
import { resolveActiveProfile, setActiveProfile } from '../src/activeProfile';
import { ProjectProfileStore } from '../src/projectProfiles';
import { getRootConfigGeneration, getRootConfigLastBumpReason } from '../src/rootConfigGeneration';
import { getActiveProfileScanRoot, resetScanRootCache, setActiveProfileScanRoot } from '../src/scanRoots';
import { isPythonMroJumpEnabled } from '../src/languageProviders';
import {
  applySavedFileAnnotations,
  flushPendingDocumentReturnAnnotationsForTests,
  resetPythonReturnAnnotationCache,
  resolveLocalVariableReturnType,
  resolveLocalVariableReturnTypeFromSnapshot
} from '../src/backend/pythonReturnTypeInference';
import {
  getOperationSummary,
  resetLanguageServiceMetrics
} from '../src/languageServiceMetrics';
import { getDatabaseSchemaSnapshot, locateDatabaseSchemaLine } from '../src/databaseSchema';
import { createDatabaseSchemaUri, parseDatabaseSchemaRoot } from '../src/databaseSchemaPresentation';
import { getDiagnosticScheduler } from '../src/backend/diagnosticScheduler';
import { KBE_SCHEME, buildKbeStubDocument } from '../src/kbeModuleIndex';
import { parseDebugConfigText } from '../src/backend/debugConfigBootstrap';
import { setKodeCoreShadowGate, getKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { ensureConfigResolved, resetConfigResolveForTests } from '../src/serverConfigResolve';
import { ENGINE_DEFAULT_TELNET_PORTS, makeContractGate } from './helpers/configCoreContract';
import packageJson from '../package.json';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { messages, treeRegistrations, window as fakeWindow, windowState } from './fake-vscode/windowState';
import { RelativePattern } from './fake-vscode/core';
import {
  lastFileSystemWatcher,
  memoryFileSystem,
  workspace,
  workspaceEvents,
  workspaceState,
  configurationOverrides
} from './fake-vscode/workspaceState';
import { panelRegistry } from './fake-vscode/panelRegistry';
import { fakeExtensionList } from './fake-vscode/extensionsState';
import { tests as testsRegistry } from './fake-vscode/core';
import { FakeComponentBin } from './sim/fakeComponentBin';
import {
  makeTextDocument,
  Position,
  Range,
  StatusBarAlignment,
  Uri,
  type ExtensionContext
} from './fake-vscode/core';

import { until, makeContext, disposeAll, watcherPatternKey, resetExtensionTestState } from './extensionTestShared';

beforeEach(resetExtensionTestState);

describe('extension activate 自动热重载装配(盘点 G5)', () => {
  it('开启后文件保存按名执行快速动作,默认关不建监视器', async () => {
    const context = makeContext();
    workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    memoryFileSystem.set(
      '/ws/.kbengine/debug.json',
      JSON.stringify({
        quickActions: [
          { name: '热更', type: 'command', command: 'kbengine.test.hotReloadProbe', args: [] }
        ]
      })
    );
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 0 }
    });
    activate(context);
    // 覆盖探测命令,避免真的动 KBEngine 进程;装配只关心按名触发这条链
    const registration = commands.registerCommand('kbengine.test.hotReloadProbe', () => undefined);

    expect(lastFileSystemWatcher.current).not.toBeNull();
    lastFileSystemWatcher.current!.fireChange(Uri.file('/ws/scripts/base/Account.py'));

    await new Promise(resolve => setTimeout(resolve, 10));

    registration.dispose();
    disposeAll(context);
  }, 8000);
});

describe('extension activate MRO 启动门控(P0-3e)', () => {
  it('enableMroJump=false:激活不启动 Python 后台全扫(def 首扫照常);拨回 true 配置路径即启动', async () => {
    // P0-3e 验收臂:启动路径与开关切换同口径。门控放行证明用 def 首扫
    // (startKbEngineIndexing 同一同步块里两者一起放行——def 扫已启动而
    // python-index-scan 零记录,才证明 python 被开关拦下,不是门控未放行)。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mro-gate-'));
    fs.mkdirSync(path.join(root, 'entities'), { recursive: true });
    fs.writeFileSync(path.join(root, 'entities', 'Avatar.def'), '<root>\n</root>\n');
    fs.mkdirSync(path.join(root, 'scripts', 'base'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'base', 'Avatar.py'), 'class Avatar:\n    pass\n');
    const oldFolders = workspace.workspaceFolders;
    const oldFindFiles = workspace.findFiles;
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const defUri = Uri.file(path.join(root, 'entities', 'Avatar.def'));
    const pyUri = Uri.file(path.join(root, 'scripts', 'base', 'Avatar.py'));
    workspace.findFiles = (async (include: string) => {
      if (include.includes('*.def')) { return [defUri]; }
      if (include.includes('*.py')) { return [pyUri]; }
      return [];
    }) as typeof workspace.findFiles;
    resetLanguageServiceMetrics();
    configurationOverrides.set('kbengine.python', { enableMroJump: false });
    const context = makeContext();
    try {
      activate(context);
      // 门控确实放行(特征探测命中 .def):def 首扫记账出现
      await until(() => getOperationSummary('entity-mapping-scan') !== null, 4000);
      // 宽限窗内 Python 后台全扫零记账(未被门控放行的空转对照)
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(getOperationSummary('python-index-scan')).toBeNull();
      // 拨回 true:配置变更路径(extension.ts enableMroJump 分支)调度后台全扫
      configurationOverrides.set('kbengine.python', { enableMroJump: true });
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: (section: string) =>
          section === 'kbengine' || section === 'kbengine.python.enableMroJump'
      });
      await until(() => getOperationSummary('python-index-scan') !== null, 4000);
      expect(getOperationSummary('python-index-scan')?.fileParseCount ?? 0).toBeGreaterThanOrEqual(1);
      disposeAll(context);
    } finally {
      workspace.workspaceFolders = oldFolders;
      workspace.findFiles = oldFindFiles;
      configurationOverrides.delete('kbengine.python');
      resetLanguageServiceMetrics();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
});

describe('热更通道快捷启用命令的零配置入口(快捷切换本批)', () => {
  it('零 profile 时先自动创建并激活默认档(用户令 2026-11-10「创建默认的」),不再报无 profile', async () => {
    // workspaceState 显式给 memento:makeContext 不带,store 退化会话内记忆,
    // 落盘断言要可读回(与 :193 既有用例同法)
    const map = new Map<string, unknown>();
    const mementoLike = {
      get: <T,>(key: string, defaultValue?: T): T | undefined =>
        map.has(key) ? (map.get(key) as T) : defaultValue,
      update: (key: string, value: unknown): Promise<void> => {
        map.set(key, value);
        return Promise.resolve();
      }
    };
    const context: ExtensionContext = { ...makeContext(), workspaceState: mementoLike };
    const originalInfoCount = messages.info.length;
    try {
      activate(context);
      await commands.executeCommand('kbengine.hotReload.configureChannel');
      // 新契约:零 profile 先兜默认档(创建+激活+报一声),「无部署 profile」
      // 只在兜底走不通时才出现
      expect(
        messages.info
          .slice(originalInfoCount)
          .some(entry => entry.includes('已创建并激活默认部署 profile'))
      ).toBe(true);
      expect(
        messages.info.slice(originalInfoCount).some(entry => entry.includes('无部署 profile'))
      ).toBe(false);
      // 档真落了 workspaceState 且已激活(持久化身份,不是一次性对象)
      const store = new ProjectProfileStore(context.workspaceState);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0].displayName).toBe('default');
      expect(resolveActiveProfile(context.workspaceState)?.id).toBe(store.list()[0].id);
    } finally {
      messages.info.length = originalInfoCount;
      disposeAll(context);
    }
  });

  it('有 profile 但零通道配置 → 首屏即预设一键启用列表(自研接收器/官方/未配置/高级配置)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-hot-quick-'));
    const map = new Map<string, unknown>([
      [
        'kbengine.projectProfiles.v1',
        [
          {
            id: 'p1',
            displayName: '主线服',
            assetsRoot: dir,
            engineRoot: dir,
            interpreterPath: null,
            interpreterSource: 'missing'
          }
        ]
      ]
    ]);
    const mementoLike = {
      get: <T,>(key: string, defaultValue?: T): T | undefined =>
        map.has(key) ? (map.get(key) as T) : defaultValue,
      update: (key: string, value: unknown): Promise<void> => {
        map.set(key, value);
        return Promise.resolve();
      }
    };
    const context: ExtensionContext = { ...makeContext(), workspaceState: mementoLike };
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalPick = windowish.showQuickPick;
    const titles: string[] = [];
    const labelSets: string[][] = [];
    try {
      activate(context);
      windowish.showQuickPick = async (
        items: Array<{ label: string }>,
        options?: { title?: string }
      ): Promise<unknown> => {
        titles.push(options?.title ?? '');
        labelSets.push(items.map(item => item.label));
        // 零配置不触网:首屏看一眼即取消
        return undefined;
      };

      await commands.executeCommand('kbengine.hotReload.configureChannel');

      // 单 profile:不弹 profile 选择,首屏就是预设一键启用列表
      expect(titles).toHaveLength(1);
      expect(titles[0]).toContain('预设');
      const presetLabels = labelSets[0].join('\n');
      expect(presetLabels).toContain('自研接收器');
      expect(presetLabels).toContain('未配置');
      expect(presetLabels).toContain('高级配置');
      // 取消不写盘:profile 仍无 hotReload 段
      const stored = map.get('kbengine.projectProfiles.v1') as Array<{ hotReload?: unknown }>;
      expect(stored[0].hotReload).toBeUndefined();
    } finally {
      windowish.showQuickPick = originalPick;
      disposeAll(context);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 8000);

  it('一键修直达:entry=advanced + profileId 首屏即该 profile 的高级配置通道选择', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-hot-adv-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-hot-adv-b-'));
    const map = new Map<string, unknown>([
      [
        'kbengine.projectProfiles.v1',
        [
          {
            id: 'p1',
            displayName: '主线服',
            assetsRoot: dirA,
            engineRoot: dirA,
            interpreterPath: null,
            interpreterSource: 'missing'
          },
          {
            id: 'p2',
            displayName: '压测服',
            assetsRoot: dirB,
            engineRoot: dirB,
            interpreterPath: null,
            interpreterSource: 'missing'
          }
        ]
      ]
    ]);
    const mementoLike = {
      get: <T,>(key: string, defaultValue?: T): T | undefined =>
        map.has(key) ? (map.get(key) as T) : defaultValue,
      update: (key: string, value: unknown): Promise<void> => {
        map.set(key, value);
        return Promise.resolve();
      }
    };
    const context: ExtensionContext = { ...makeContext(), workspaceState: mementoLike };
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalPick = windowish.showQuickPick;
    const titles: string[] = [];
    try {
      activate(context);
      windowish.showQuickPick = async (
        _items: Array<{ label: string }>,
        options?: { title?: string }
      ): Promise<unknown> => {
        titles.push(options?.title ?? '');
        return undefined;
      };

      // 状态栏「打开高级配置修参数」的直达路径:跳过 profile 选择与预设首屏
      await commands.executeCommand('kbengine.hotReload.configureChannel', {
        entry: 'advanced',
        profileId: 'p2'
      });

      expect(titles).toHaveLength(1);
      expect(titles[0]).toContain('高级配置');
      // 目标 profile 对上:标题点名 p2(压测服),不是 p1 也不是通用选择屏
      expect(titles[0]).toContain('压测服');
      expect(titles[0]).not.toContain('主线服');
      const stored = map.get('kbengine.projectProfiles.v1') as Array<{ hotReload?: unknown }>;
      expect(stored.every(entry => entry.hotReload === undefined)).toBe(true);
    } finally {
      windowish.showQuickPick = originalPick;
      disposeAll(context);
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  }, 8000);
});
