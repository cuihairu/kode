import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PythonClassIndex } from '../src/backend/pythonClassIndex';
import { activate, deactivate } from '../src/extension';
import { setActiveProfile } from '../src/activeProfile';
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
import { getDiagnosticScheduler } from '../src/diagnosticScheduler';
import { KBE_SCHEME, buildKbeStubDocument } from '../src/kbeModuleIndex';
import { parseDebugConfigText } from '../src/debugConfigBootstrap';
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

describe('激活期项目导入命令装配(IDE-PRJ-003)', () => {
  it('project.import 命令:选资产根 + 确认导入后建立 profile', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalOpenDialog = windowish.showOpenDialog;
    const originalQuickPick = windowish.showQuickPick;
    const originalInfoCount = messages.info.length;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-import-'));
    const assetsRoot = path.join(base, 'proj');
    fs.mkdirSync(path.join(assetsRoot, 'scripts', 'entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(assetsRoot, 'scripts', 'entities.xml'), '<root>\n</root>\n', 'utf8');
    const persisted: Array<[string, unknown]> = [];
    const context: ExtensionContext = {
      ...makeContext(),
      workspaceState: {
        get: <T,>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: (key: string, value: unknown): Promise<void> => {
          persisted.push([key, value]);
          return Promise.resolve();
        }
      }
    };
    workspace.workspaceFolders = [{ uri: Uri.file(base), name: 'ws', index: 0 }];
    try {
      activate(context);

      windowish.showOpenDialog = async () => [Uri.file(assetsRoot)];
      windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
        const resolved = (await items) as Array<{ label: string }>;
        return resolved.find(item => item.label === '导入');
      };

      await commands.executeCommand('kbengine.project.import');

      // 命令接线到位:确认导入后 profile 落进 workspaceState 持久层
      // (激活期还有别的键写 workspaceState,只看 profile 键)
      const profileWrites = persisted.filter(([key]) => key === 'kbengine.projectProfiles.v1');
      expect(profileWrites).toHaveLength(1);
      const profiles = profileWrites[0][1] as Array<Record<string, string>>;
      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({ displayName: 'proj', assetsRoot, engineRoot: '' });
      expect(messages.info.some(info => info.includes('已导入项目 profile'))).toBe(true);
    } finally {
      windowish.showOpenDialog = originalOpenDialog;
      windowish.showQuickPick = originalQuickPick;
      messages.info.length = originalInfoCount;
      disposeAll(context);
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 8000);
});

describe('激活期最小项目创建命令装配(IDE-PRJ-008)', () => {
  it('project.create 命令:选目标根 + 确认生成后落盘并建档', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalOpenDialog = windowish.showOpenDialog;
    const originalQuickPick = windowish.showQuickPick;
    const originalInfoCount = messages.info.length;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-create-'));
    const targetRoot = path.join(base, 'fresh');
    const persisted: Array<[string, unknown]> = [];
    const context: ExtensionContext = {
      ...makeContext(),
      workspaceState: {
        get: <T,>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: (key: string, value: unknown): Promise<void> => {
          persisted.push([key, value]);
          return Promise.resolve();
        }
      }
    };
    workspace.workspaceFolders = [{ uri: Uri.file(base), name: 'ws', index: 0 }];
    try {
      activate(context);

      windowish.showOpenDialog = async () => [Uri.file(targetRoot)];
      windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
        const resolved = (await items) as Array<{ label: string }>;
        return resolved.find(item => item.label === 'Confirm generation');
      };

      await commands.executeCommand('kbengine.project.create');

      // 模板落盘 + 命令接线建档(只看 profile 键,激活期别的键不入账)
      expect(fs.existsSync(path.join(targetRoot, 'scripts', 'entities.xml'))).toBe(true);
      const profileWrites = persisted.filter(([key]) => key === 'kbengine.projectProfiles.v1');
      expect(profileWrites).toHaveLength(1);
      const profiles = profileWrites[0][1] as Array<Record<string, string>>;
      expect(profiles[0]).toMatchObject({ displayName: 'fresh', assetsRoot: targetRoot });
      expect(messages.info.some(entry => entry.includes('已创建最小项目 profile'))).toBe(true);
    } finally {
      windowish.showOpenDialog = originalOpenDialog;
      windowish.showQuickPick = originalQuickPick;
      messages.info.length = originalInfoCount;
      disposeAll(context);
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 8000);
});

describe('激活期活动 profile 选择命令装配(IDE-PRJ-010)', () => {
  it('project.selectActive 命令:无 profile 时如实说明并跳过选择器', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalPick = windowish.showQuickPick;
    let pickCalls = 0;
    const originalInfoCount = messages.info.length;
    const context = makeContext();
    try {
      activate(context);

      windowish.showQuickPick = async (): Promise<unknown> => {
        pickCalls += 1;
        return undefined;
      };

      await commands.executeCommand('kbengine.project.selectActive');

      expect(pickCalls).toBe(0);
      expect(messages.info.slice(originalInfoCount).some(entry => entry.includes('No project profiles'))).toBe(true);
    } finally {
      windowish.showQuickPick = originalPick;
      messages.info.length = originalInfoCount;
      disposeAll(context);
    }
  }, 8000);
});

describe('激活期 profile 健康汇总命令装配(IDE-PRJ-009)', () => {
  it('profile.health 命令:无活动 profile 时如实说明', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalPick = windowish.showQuickPick;
    let pickCalls = 0;
    const originalInfoCount = messages.info.length;
    const context = makeContext();
    try {
      activate(context);

      windowish.showQuickPick = async (): Promise<unknown> => {
        pickCalls += 1;
        return undefined;
      };

      await commands.executeCommand('kbengine.profile.health');

      expect(pickCalls).toBe(0);
      expect(messages.info.slice(originalInfoCount).some(entry => entry.includes('未选择活动 project profile'))).toBe(true);
    } finally {
      windowish.showQuickPick = originalPick;
      messages.info.length = originalInfoCount;
      disposeAll(context);
    }
  }, 8000);
});

describe('激活期语言索引响应 profile 切换(IDE-PRJ-011)', () => {
  it('激活即应用持久化选择,切换事件切换索引输入并前进 generation', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-prj11-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-prj11-b-'));
    const map = new Map<string, unknown>([
      ['kbengine.projectProfiles.v1', [
        { id: 'p1', displayName: 'A', assetsRoot: dirA, engineRoot: '', interpreterPath: null, interpreterSource: 'missing' },
        { id: 'p2', displayName: 'B', assetsRoot: dirB, engineRoot: '', interpreterPath: null, interpreterSource: 'missing' }
      ]],
      ['kbengine.activeProfileId.v1', 'p1']
    ]);
    const mementoLike = {
      get: <T,>(key: string, defaultValue?: T): T | undefined =>
        map.has(key) ? (map.get(key) as T) : defaultValue,
      update: (key: string, value: unknown): Promise<void> => {
        map.set(key, value);
        return Promise.resolve();
      }
    };
    const context: ExtensionContext = {
      ...makeContext(),
      workspaceState: mementoLike
    };
    const generationBefore = getRootConfigGeneration();
    try {
      activate(context);

      // 激活期:持久化的选择落到索引输入
      expect(getActiveProfileScanRoot()).toBe(dirA);

      // 切换事件:输入换到选定根,generation 前进(旧输入在途批次由此判过期)
      await setActiveProfile(mementoLike, 'p2');
      expect(getActiveProfileScanRoot()).toBe(dirB);
      expect(getRootConfigGeneration()).toBeGreaterThan(generationBefore);
      expect(getRootConfigLastBumpReason()).toBe('profile-switch');
    } finally {
      disposeAll(context);
      setActiveProfileScanRoot(null);
      resetScanRootCache();
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  }, 8000);
});
