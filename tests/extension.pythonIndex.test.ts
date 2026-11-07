import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PythonClassIndex } from '../src/pythonClassIndex';
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
} from '../src/pythonReturnTypeInference';
import {
  getOperationSummary,
  resetLanguageServiceMetrics
} from '../src/languageServiceMetrics';
import { getDatabaseSchemaSnapshot, locateDatabaseSchemaLine } from '../src/databaseSchema';
import { createDatabaseSchemaUri, parseDatabaseSchemaRoot } from '../src/databaseSchemaPresentation';
import { getDiagnosticScheduler } from '../src/diagnosticScheduler';
import { KBE_SCHEME, buildKbeStubDocument } from '../src/kbeModuleIndex';
import { parseDebugConfigText } from '../src/debugConfigBootstrap';
import { setKodeCoreShadowGate, getKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
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

describe('Python index lifecycle wiring', () => {
  it('watches external assets, refreshes changed files, and releases closed documents', async () => {
    const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-external-watch-'));
    const context = makeContext();
    const originalCreate = workspace.createFileSystemWatcher;
    const watches: Array<{ pattern: unknown; disposed: boolean; watcher: ReturnType<typeof originalCreate> }> = [];
    const create = vi.spyOn(workspace, 'createFileSystemWatcher').mockImplementation(((pattern: unknown) => {
      const watcher = originalCreate();
      const record = { pattern, disposed: false, watcher };
      const dispose = watcher.dispose.bind(watcher);
      watcher.dispose = () => { record.disposed = true; dispose(); };
      watches.push(record);
      return watcher;
    }) as typeof originalCreate);
    const invalidate = vi.spyOn(PythonClassIndex.prototype, 'invalidate');
    const changed = vi.spyOn(PythonClassIndex.prototype, 'onFileChanged').mockResolvedValue(undefined);
    const closed = vi.spyOn(PythonClassIndex.prototype, 'onDocumentClosed');
    configurationOverrides.set('kbengine', { assetsRoot: assets });
    try {
      activate(context);
      const watch = watches.find(item => (item.pattern as { base?: string })?.base === assets);
      expect(watch, 'external assetsRoot has a RelativePattern watcher').toBeTruthy();
      const file = Uri.file(path.join(assets, 'scripts/cell/Avatar.py'));
      watch!.watcher.fireCreate(file);
      // 新建文件走 onFileChanged 直接装载进索引;invalidate 对未索引文件是
      // 刻意空转(不得重启扫描),故 create 必须不触发 invalidate
      expect(changed).toHaveBeenCalledWith(file.fsPath);
      expect(invalidate, 'unindexed create must not restart the scan').not.toHaveBeenCalled();
      watch!.watcher.fireChange(file);
      expect(changed).toHaveBeenCalledWith(file.fsPath);
      watch!.watcher.fireDelete(file);
      expect(invalidate).toHaveBeenLastCalledWith(file.fsPath);
      const document = makeTextDocument('class Avatar: pass', { fileName: file.fsPath });
      workspaceEvents.documentClosed.fire(document);
      expect(closed).toHaveBeenCalledWith(document);
      // assets 同 base 的活 watcher 数(扩展装配面 1 件+entityMapping 外部根
      // 三件套,IDE-ACC-011 起后者也以 RelativePattern 注册)。测试内 manager
      // 单例在 import 期构造,彼时 kbengine 覆盖未生效,外部三件套由首个配置
      // 事件补挂——泄漏锁取「整组重建后再刷新,活集不增长」,不取首次前后等值
      const liveAssetsWatchers = (): number =>
        watches.filter(item => (item.pattern as { base?: string })?.base === assets && !item.disposed).length;
      const fireAssetsRootChanged = (): void => {
        workspaceEvents.configurationChanged.fire({ affectsConfiguration: section => section === 'kbengine' || section === 'kbengine.assetsRoot' });
      };
      fireAssetsRootChanged();
      const count = invalidate.mock.calls.length;
      watch!.watcher.fireCreate(file);
      expect(invalidate.mock.calls.length, 'old watchers are disposed when roots change').toBe(count);
      const liveAfterRefresh = liveAssetsWatchers();
      expect(liveAfterRefresh, 'assets root has live watchers after refresh').toBeGreaterThan(0);
      fireAssetsRootChanged();
      expect(liveAssetsWatchers(), 'watcher group rebuild does not leak live watchers').toBe(liveAfterRefresh);
    } finally {
      disposeAll(context);
      create.mockRestore(); invalidate.mockRestore(); changed.mockRestore(); closed.mockRestore();
      configurationOverrides.delete('kbengine');
      fs.rmSync(assets, { recursive: true, force: true });
    }
  });
});

describe('Python index edit coalescing', () => {
  it('reindexes one burst once after typing settles', async () => {
    vi.useFakeTimers();
    workspace.workspaceFolders = [{ uri: Uri.file('/workspace'), name: 'ws', index: 0 }];
    const context = makeContext();
    const changed = vi.spyOn(PythonClassIndex.prototype, 'onDocumentChanged')
      .mockResolvedValue(undefined);
    const document = makeTextDocument('class Avatar: pass', {
      fileName: '/workspace/avatar.py',
      languageId: 'python'
    }) as never;
    try {
      activate(context);
      for (let index = 0; index < 10; index += 1) {
        workspaceEvents.documentChanged.fire({
          document,
          contentChanges: [{ range: undefined, rangeOffset: 0, rangeLength: 0, text: 'x' }],
          reason: undefined
        });
      }
      expect(changed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledWith(document);
    } finally {
      vi.useRealTimers();
      disposeAll(context);
      changed.mockRestore();
      workspace.workspaceFolders = [];
    }
  });
});
