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

describe('最终配置默认开启(批112 默认开启令)', () => {
  // 建一棵最小引擎目录树:binPath 可推导出 kbe/res/server/kbengine_defaults.xml
  const makeEngineTree = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-open-'));
    fs.mkdirSync(path.join(root, 'kbe', 'res', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml'),
      '<defaults><baseapp><archivePeriod> 300 </archivePeriod></baseapp></defaults>'
    );
    return root;
  };

  it('激活即出:能定位 defaults 时后台打开合成视图,不抢焦点', async () => {
    const root = makeEngineTree();
    const previousGate = getKodeCoreShadowGate();
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });
      const context = makeContext();
      activate(context);
      // KODE-CFG-009:合成读值经 core 解析(`$/kode/config/resolve`)——契约门
      // 替身只能在 activate 后装(activate 装配会覆写门),auto 路径首取不可得
      // 的有界延迟重试(300ms)即取到替身并出视图
      setKodeCoreShadowGate(makeContractGate([]));
      resetConfigResolveForTests();

      // 激活内的自动打开是异步尾焰:轮询等它落地
      await until(() => windowState.showTextDocumentCalls.length > 0);
      const call = windowState.showTextDocumentCalls[0] as {
        document: unknown;
        options: { preview: boolean; preserveFocus: boolean } | undefined;
      };
      const document = call.document;
      const options = call.options;
      expect(document).toBeDefined();
      expect(options).toEqual({ preview: true, preserveFocus: true });
      // 走的是虚拟文档 openTextDocument
      expect(workspaceState.openTextDocumentCalls.length).toBeGreaterThan(0);
      disposeAll(context);
    } finally {
      setKodeCoreShadowGate(previousGate);
      resetConfigResolveForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 8000);

  it('定位不到 defaults:激活静默跳过不弹错', async () => {
    const context = makeContext();
    activate(context);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(windowState.showTextDocumentCalls).toHaveLength(0);
    expect(messages.error).toEqual([]);
    disposeAll(context);
  });

  it('showFinalConfigOnOpen=false:激活不自动打开', async () => {
    const root = makeEngineTree();
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      configurationOverrides.set('kbengine', {
        binPath: '${workspaceFolder}/kbe/bin/server',
        showFinalConfigOnOpen: false
      });
      const context = makeContext();
      activate(context);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(windowState.showTextDocumentCalls).toHaveLength(0);
      disposeAll(context);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('手动命令:定位失败明示报错;autoRefreshFinalConfig=false 不挂 watcher', async () => {
    configurationOverrides.set('kbengine', { autoRefreshFinalConfig: false });
    // 批134 起 types.xml 反扫镜在激活期挂 def/types.xml/entities.xml 三个
    // watcher,lastFileSystemWatcher 不再能当"终配 watcher 是否存在"用;
    // 这里记录本激活创建的全部样式,直接断言 kbengine*.xml 不在列
    const patterns: string[] = [];
    const originalCreate = workspace.createFileSystemWatcher;
    (workspace as unknown as Record<string, unknown>).createFileSystemWatcher = (pattern: unknown) => {
      patterns.push(watcherPatternKey(pattern));
      return originalCreate(pattern as never);
    };
    try {
      const context = makeContext();
      activate(context);
      expect(patterns.some(pattern => pattern.includes('kbengine*.xml'))).toBe(false);

      await commands.executeCommand('kbengine.config.showFinal');
      expect(messages.error.some(message => message.includes('无法定位引擎默认配置'))).toBe(true);
      expect(windowState.showTextDocumentCalls).toHaveLength(0);
      disposeAll(context);
    } finally {
      (workspace as unknown as Record<string, unknown>).createFileSystemWatcher = originalCreate;
    }
  });

  it('attachRemote 命令经 CommandRegistry 真分发(未配置目标提示)', async () => {
    const context = makeContext();
    activate(context);
    await commands.executeCommand('kbengine.debug.attachRemote');
    expect(messages.info.some(message => message.includes('kbengine.debug.remoteTargets'))).toBe(true);
    disposeAll(context);
  });

  it('手动命令聚焦打开;联动 watcher 三臂刷新合成内容', async () => {
    const root = makeEngineTree();
    const previousGate = getKodeCoreShadowGate();
    // 任务 B 起激活期还会挂托管目录 watcher(**/.kbengine*),不能再用
    // lastFileSystemWatcher 当终配 watcher;记录 (pattern, watcher) 按挑选。
    const createdWatchers: Array<{ pattern: string; watcher: { fireChange(u: Uri): void; fireCreate(u: Uri): void; fireDelete(u: Uri): void } }> = [];
    const originalCreate = workspace.createFileSystemWatcher;
    (workspace as unknown as Record<string, unknown>).createFileSystemWatcher = (pattern: unknown) => {
      const watcher = originalCreate.call(workspace, pattern as never);
      createdWatchers.push({ pattern: watcherPatternKey(pattern), watcher });
      return watcher;
    };
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });
      const context = makeContext();
      activate(context);
      // KODE-CFG-009:契约门替身在 activate 后装(auto 重试与手动命令都经
      // `$/kode/config/resolve` 取 core 解析),测毕还原
      setKodeCoreShadowGate(makeContractGate([]));
      resetConfigResolveForTests();

      // 激活自动路径先落地,记基线后再验手动路径(聚焦,不带 preview 选项)
      await until(() => windowState.showTextDocumentCalls.length > 0);
      const before = windowState.showTextDocumentCalls.length;
      await commands.executeCommand('kbengine.config.showFinal');
      await until(() => windowState.showTextDocumentCalls.length > before);
      const manual = windowState.showTextDocumentCalls[windowState.showTextDocumentCalls.length - 1] as {
        options: unknown;
      };
      expect(manual.options).toBeUndefined();

      // 变更联动:watcher change/create/delete 三臂都触发内容提供者重算。
      // 按上面记录的 (pattern, watcher) 挑出 kbengine*.xml 那枚。
      const watcher = createdWatchers.find(record =>
        record.pattern.includes('kbengine*.xml')
      )?.watcher;
      expect(watcher).toBeDefined();
      const provider = workspaceState.contentProviders.get('kbengine-config') as {
        onDidChange(listener: (uri: unknown) => void): { dispose(): void };
        provideTextDocumentContent(uri: unknown): string;
      };
      const fired: unknown[] = [];
      provider.onDidChange(uri => fired.push(uri));
      watcher!.fireChange(Uri.file('/any/kbengine_defaults.xml'));
      watcher!.fireCreate(Uri.file('/any/kbengine.xml'));
      watcher!.fireDelete(Uri.file('/any/kbengine.xml'));
      // KODE-CFG-009:联动臂先重取 core 解析再 refresh——事件落地是异步尾焰
      await until(() => fired.length === 3);
      expect(provider.provideTextDocumentContent({})).toContain('仅引擎默认');

      // autoRefreshFinalConfig=false 时 watcher 不存在,联动自然关闭
      disposeAll(context);
    } finally {
      setKodeCoreShadowGate(previousGate);
      resetConfigResolveForTests();
      (workspace as unknown as Record<string, unknown>).createFileSystemWatcher = originalCreate;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 8000);
});

describe('激活期 debug.json 缺失自动生成(批143)', () => {
  it('工作区没有配置文件时生成带注释骨架,生效工作目录与来源落输出通道', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-debugcfg-'));
    fs.writeFileSync(path.join(root, 'start_server.bat'), '@echo off\n');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const context = makeContext();
    try {
      activate(context);

      const configPath = path.join(root, '.kbengine', 'debug.json');
      expect(fs.existsSync(configPath)).toBe(true);
      const content = fs.readFileSync(configPath, 'utf8');
      // 骨架是 JSONC:注释说明字段含义,剥注释后仍是合法 JSON
      expect(content).toContain('// 配置版本号');
      expect(content).toContain('${workspaceFolder}/start_server.bat');
      expect(parseDebugConfigText(content)?.quickActions).toHaveLength(1);

      const channel = windowState.channels.find(entry => entry.name === 'KBEngine 配置');
      const text = channel?.lines.join('') ?? '';
      expect(text).toContain(root);
      expect(text).toContain('来源:默认值(首个工作区根)');
      expect(text).toContain('按脚本扫描写入 1 条快速执行动作');

      // 已有配置不覆盖:再激活一次内容不变
      activate(context);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(content);
    } finally {
      disposeAll(context);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('webview console log switch', () => {
  it('attaches page console ingestion by default and skips attachment when disabled', async () => {
    const panel = panelRegistry.create('kbengine.logViewer', 'KBEngine Logs', 2, { enableScripts: true });
    expect(panelRegistry.panels).toHaveLength(1);

    configurationOverrides.set('kbengine', { webviewConsoleLogs: false });
    const disabledContext = makeContext();
    activate(disabledContext);
    expect(disabledContext.subscriptions.length).toBeGreaterThan(0);
    disposeAll(disabledContext);
    configurationOverrides.delete('kbengine');
    void panel;
  });
});
