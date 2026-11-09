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
import { getDiagnosticScheduler } from '../src/backend/diagnosticScheduler';
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

describe('extension activate 原始日志 ERROR 扫描装配(盘点 G6)', () => {
  it('scanErrors 命令:取消不建面板;选文件扫出聚合面板;重扫与点击行走默认链', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalShowOpenDialog = windowish.showOpenDialog;
    memoryFileSystem.set(
      '/ws/logs/server.log',
      [
        '   ERROR dbmgr01 1000 2000 30000 [2026-03-26 18:21:11 001] - saveAvatar(1001) failed: not found',
        '[2026-03-26 18:23:00][ERROR][cellapp] loadBalance failed',
        '   INFO dbmgr01 1000 2000 30001 [2026-03-26 18:23:01 002] - normal line'
      ].join('\n')
    );
    workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const context = makeContext();
    try {
      activate(context);

      // 对话框默认取消(fake 默认 undefined):不建面板
      await commands.executeCommand('kbengine.logs.scanErrors');
      expect(panelRegistry.panels).toHaveLength(0);

      // 选中日志文件:扫出 ERROR 聚合面板
      windowish.showOpenDialog = async () => [Uri.file('/ws/logs/server.log')];
      await commands.executeCommand('kbengine.logs.scanErrors');
      expect(panelRegistry.panels).toHaveLength(1);
      const panel = panelRegistry.panels[0];
      expect(panel.viewType).toBe('kbengine.logErrorScan');
      expect(panel.webview.html).toContain('saveAvatar(N) failed: not found');
      expect(panel.webview.html).toContain('loadBalance failed');

      // 点击命中行:默认打开链把选区落在命中行
      const before = windowState.showTextDocumentCalls.length;
      panelRegistry.fireMessage(panel, { command: 'open', file: '/ws/logs/server.log', line: 2 });
      await until(() => windowState.showTextDocumentCalls.length > before);

      // 重扫:内容更新后回到同一面板
      memoryFileSystem.set(
        '/ws/logs/server.log',
        [
          '   ERROR dbmgr01 1000 2000 30000 [2026-03-26 18:21:11 001] - saveAvatar(1001) failed: not found',
          '[2026-03-26 19:00:00][CRITICAL][baseapp] disk full on volume 7'
        ].join('\n')
      );
      panelRegistry.fireMessage(panel, { command: 'rescan' });
      await until(() => panel.webview.html.includes('disk full on volume N'));
      expect(panelRegistry.panels).toHaveLength(1);
    } finally {
      windowish.showOpenDialog = originalShowOpenDialog;
      disposeAll(context);
    }
  }, 8000);
});

describe('extension activate 客户端实体 SDK 生成装配(盘点 G4)', () => {
  it('clientSdk.generate 命令:选语言+输出目录+跳过策略后按 entities.xml 落盘', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalQuickPick = windowish.showQuickPick;
    const originalInputBox = windowish.showInputBox;
    const originalInfoCount = messages.info.length;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sdk-activate-'));
    const defsDir = path.join(root, 'scripts', 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'scripts', 'entities.xml'),
      '<root><Avatar hasBase="true"/></root>',
      'utf8'
    );
    fs.writeFileSync(
      path.join(defsDir, 'Avatar.def'),
      '<root><Properties><hp><Type>UINT32</Type><Flags>OWN_CLIENT</Flags></hp></Properties></root>',
      'utf8'
    );
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const context = makeContext();
    try {
      activate(context);

      const picks: Array<Array<{ value: string }>> = [
        [{ value: 'typescript' }],
        [{ value: 'skip' }]
      ];
      let pickCalls = 0;
      windowish.showQuickPick = async (): Promise<unknown> => {
        const next = picks[pickCalls];
        pickCalls += 1;
        return next;
      };
      windowish.showInputBox = async (): Promise<string | undefined> => 'scripts/client_entities';

      await commands.executeCommand('kbengine.clientSdk.generate');

      expect(pickCalls).toBe(2);
      const filePath = path.join(root, 'scripts', 'client_entities', 'Avatar.ts');
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('export class Avatar');
      expect(content).toContain('public hp: number');
      expect(content).toContain('protected onBaseOutgoing');
      expect(messages.info[messages.info.length - 1]).toContain('Avatar.ts');
    } finally {
      windowish.showQuickPick = originalQuickPick;
      windowish.showInputBox = originalInputBox;
      messages.info.length = originalInfoCount;
      disposeAll(context);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 8000);
});

describe('extension activate 消息表类型注册表接线(AUD-060)', () => {
  it('messagetable.preview 读取所选根 types.xml:MY_INT→UINT32 参数不再 unknown-arg-type', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalQuickPick = windowish.showQuickPick;
    const originalFindFiles = workspace.findFiles;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mt-typesxml-'));
    const defsDir = path.join(root, 'scripts', 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), '<root><Hero hasBase="true"/></root>', 'utf8');
    // 实体所属根的 types.xml:自定义别名 MY_INT→UINT32(审计 R3-K01 反例)
    fs.writeFileSync(path.join(defsDir, 'types.xml'), '<root><MY_INT>UINT32</MY_INT></root>', 'utf8');
    const heroDef = path.join(defsDir, 'Hero.def');
    fs.writeFileSync(
      heroDef,
      '<root><BaseMethods><req><Exposed>true</Exposed><Arg>MY_INT</Arg></req></BaseMethods></root>',
      'utf8'
    );
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    // 映射首扫经 findFilesAcrossRoots → workspace.findFiles;替身默认返回 [],
    // 这里让 Hero.def 被扫到(与 defAnalyzerCommand/defParamInlayHints 同式)
    workspace.findFiles = (async (glob?: string) =>
      glob === '**/*.def' ? [Uri.file(heroDef)] : []) as typeof workspace.findFiles;
    const context = makeContext();
    try {
      activate(context);
      windowish.showQuickPick = async (): Promise<unknown> => 'Hero';
      await commands.executeCommand('kbengine.messagetable.preview');
      // 预览经 openTextDocument({content, language}) 展示;取最后一次内容调用
      const markdownCall = [...workspaceState.openTextDocumentCalls]
        .reverse()
        .find(call => typeof call === 'object' && call !== null && 'content' in call) as { content: string } | undefined;
      expect(markdownCall).toBeTruthy();
      expect(markdownCall!.content).toContain('# 消息编号表 — Hero');
      // AUD-060:types.xml 已喂入 → MY_INT 进注册表,参数不报 unknown-arg-type
      expect(markdownCall!.content).not.toContain('dataType[MY_INT] not found');
    } finally {
      windowish.showQuickPick = originalQuickPick;
      workspace.findFiles = originalFindFiles;
      disposeAll(context);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 8000);
});

describe('extension activate 定义形态生成装配(盘点 G7)', () => {
  it('formWizard 命令:选空间形态 + 名称后落 def 并登记 entities.xml', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalQuickPick = windowish.showQuickPick;
    const originalInputBox = windowish.showInputBox;
    const originalInfoCount = messages.info.length;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-forms-activate-'));
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), '<root>\n</root>\n', 'utf8');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const context = makeContext();
    try {
      activate(context);

      let pickCalls = 0;
      windowish.showQuickPick = async (items: unknown[]): Promise<unknown> => {
        const resolved = await items;
        pickCalls += 1;
        // 第一次选空间形态,第二次(IDE-GEN-008 计划确认)选确认生成
        if (pickCalls === 1) {
          return resolved.find(item => (item as { label: string }).label.startsWith('Space Entity'));
        }
        return resolved.find(item => (item as { label: string }).label === 'Confirm generation');
      };
      windowish.showInputBox = async (): Promise<string | undefined> => 'MySpace';

      await commands.executeCommand('kbengine.generator.formWizard');

      expect(pickCalls).toBe(2);
      const defPath = path.join(root, 'scripts', 'entity_defs', 'MySpace.def');
      expect(fs.readFileSync(defPath, 'utf8')).toContain('<Space/>');
      expect(fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8')).toContain(
        '<MySpace hasBase="true" hasCell="true" />'
      );
      expect(messages.info.some(info => info.includes('已生成空间实体'))).toBe(true);
    } finally {
      windowish.showQuickPick = originalQuickPick;
      windowish.showInputBox = originalInputBox;
      messages.info.length = originalInfoCount;
      disposeAll(context);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 8000);
});
