// 激活链低覆盖命令面补测(覆盖率 98% 目标批次):serverControls 的
// playerData/telnet/bots、databaseManagementWebView 消息面、hotReload
// configureChannel/confirmDefBaseline/filterByState/showFileState、
// utilityCommands selectInterpreter/createVenv/ruffLint 的取消与如实
// 降级路径。与 covExtensionCommands 同一 fake-vscode 装配手法:activate
// 一次,再逐命令以取消应答驱动诚实降级分支。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { channels, messages, window as fakeWindow, windowState } from './fake-vscode/windowState';
import { panelRegistry } from './fake-vscode/panelRegistry';
import { configurationOverrides, workspace, workspaceEvents, workspaceState } from './fake-vscode/workspaceState';
import { makeTextDocument, Uri, type ExtensionContext } from './fake-vscode/core';
import {
  readOnlyQueryCheckConnectionLabel,
  readOnlyQueryOpenReportLabel
} from '../src/playerDataPanel';

// 本文件的命令面全部按「本机无 KBEngine 组件」的诚实降级臂编写。真机
// 口径下 discoverLocalComponents 走 UDP 广播(127.0.0.1:20086),一旦本机
// 起了真实引擎进程组(profile.start 的预置前提被打破),profile.start 会
// 进入真实 5s 采样而超时。注入哑 socket(绑定成功、永不回包)锁定空发现
// 分支,测试不再依赖宿主机当时的进程状态。
vi.mock('dgram', () => ({
  createSocket: () => ({
    on: () => undefined,
    bind: (_port: number, _addr: string, cb: () => void) => cb(),
    setBroadcast: () => undefined,
    address: () => ({ address: '127.0.0.1', family: 'ipv4', port: 40000 }),
    send: () => undefined,
    close: () => undefined
  })
}));

let root = '';
let extDir = '';
let gsDir = '';
let context: ExtensionContext;

const makeMemento = (store: Map<string, unknown>) => ({
  get: <T,>(key: string, defaultValue?: T): T | undefined => {
    if (!store.has(key)) {
      return defaultValue;
    }
    return store.get(key) as T | undefined;
  },
  update: (key: string, value: unknown): Promise<void> => {
    if (value === undefined) {
      store.delete(key);
    } else {
      store.set(key, value);
    }
    return Promise.resolve();
  }
});

const disposeContext = (target: ExtensionContext): void => {
  for (const disposable of target.subscriptions) {
    disposable.dispose();
  }
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-wiring-'));
  const defsRoot = path.join(root, 'scripts', 'entity_defs');
  fs.mkdirSync(defsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(defsRoot, 'Avatar.def'),
    [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE_AND_CLIENT</Flags>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'scripts', 'entities.xml'),
    '<root>\n  <Avatar> <hasClient/></Avatar>\n</root>\n',
    'utf8'
  );
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-wiring-manifest-'));
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: 'kode', version: '0.2.0', engines: { vscode: '^1.84.0' } }),
    'utf8'
  );
  fs.mkdirSync(path.join(extDir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'out', 'extension.js'), '', 'utf8');
  gsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-wiring-gs-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.rmSync(gsDir, { recursive: true, force: true });
});

beforeAll(async () => {
  commandRegistry.reset();
  // 视图聚焦是 workbench 内建命令面(不经 registerCommand;views.ts 空态
  // focus 调用为浮动 promise)——镜像登记免测试外未处理拒绝。
  commands.registerCommand('kbengine.gitRangeHistory.focus', async () => undefined);
  languagesRegistry.reset();
  windowState.reset();
  panelRegistry.reset();
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  workspace.textDocuments = [];
  workspace.findFiles = async (pattern: string): Promise<Uri[]> =>
    pattern === '**/*.def' ? [Uri.file(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'))] : [];
  context = {
    subscriptions: [],
    extensionUri: Uri.file(extDir),
    extensionPath: extDir,
    extension: { id: 'cuihairu.kode', extensionKind: 'workspace' },
    globalStoragePath: gsDir,
    workspaceState: makeMemento(new Map())
  };
  activate(context);
  await new Promise(resolve => setTimeout(resolve, 400));
});

afterAll(() => {
  disposeContext(context);
  expect(deactivate()).toBeUndefined();
});

beforeEach(() => {
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;
});

const lastInfo = (): string => messages.info[messages.info.length - 1] ?? '';

describe('激活链低覆盖命令面(wiring 补测)', () => {
  it('playerData.refresh:派生失败吞错,面板刷新不抛', async () => {
    await commands.executeCommand('kbengine.playerData.refresh');
    expect(messages.error).toHaveLength(0);
  });

  it('playerData.testConnection:无引擎档案 → 如实未测试(008b:拒绝走警告面+配置定位动作)', async () => {
    await commands.executeCommand('kbengine.playerData.testConnection');
    expect(messages.warning[messages.warning.length - 1]).toContain('Database config section not found');
    expect(messages.warning[messages.warning.length - 1]).toContain('not tested');
  });

  it('playerData.queryByDbid:缺配置闸降级;拒绝恢复动作即止', async () => {
    await commands.executeCommand('kbengine.playerData.queryByDbid');
    expect(messages.warning[messages.warning.length - 1]).toContain('unrelated to clone Source/Target profiles');
  });

  it('playerData.queryByDbid:选「重新派生并检查连接」→ 走连接测试降级文案', async () => {
    const original = fakeWindow.showWarningMessage;
    let gateCalls = 0;
    fakeWindow.showWarningMessage = (async (message: string) => {
      messages.warning.push(message);
      gateCalls += 1;
      // 首答选「重新派生并检查连接」;降级后的拒绝警告不再选任何动作
      return gateCalls === 1 ? readOnlyQueryCheckConnectionLabel() : undefined;
    }) as typeof fakeWindow.showWarningMessage;
    try {
      await commands.executeCommand('kbengine.playerData.queryByDbid');
    } finally {
      fakeWindow.showWarningMessage = original;
    }
    // 008b:连接测试降级走警告面(拒绝=failed,带查看详情等动作)
    expect(messages.warning[messages.warning.length - 1]).toContain('not tested');
  });

  it('playerData.queryByDbid:选「打开发现与定位报告」→ 执行报告命令', async () => {
    const original = fakeWindow.showWarningMessage;
    fakeWindow.showWarningMessage = async () => readOnlyQueryOpenReportLabel();
    const executed: string[] = [];
    const originalExecute = commands.executeCommand;
    commands.executeCommand = async (command: string, ...args: unknown[]) => {
      executed.push(command);
      return originalExecute(command, ...args);
    };
    try {
      await commands.executeCommand('kbengine.playerData.queryByDbid');
    } finally {
      fakeWindow.showWarningMessage = original;
      commands.executeCommand = originalExecute;
    }
    expect(executed).toContain('kbengine.discovery.report');
  });

  it('playerData.previewRedisKeyspace:无档案 → 如实降级不崩', async () => {
    await commands.executeCommand('kbengine.playerData.previewRedisKeyspace');
    expect(lastInfo().length).toBeGreaterThan(0);
    expect(messages.error).toHaveLength(0);
  });

  it('database.showManagement:none 档案如实注记;消息面逐条降级不崩', async () => {
    await commands.executeCommand('kbengine.database.showManagement');
    const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
    expect(panel.viewType).toBe('kbengine.databaseManagement');
    expect(panel.webview.html).toContain('未读取到引擎数据库档案');
    panelRegistry.fireMessage(panel, { command: 'setTab', tab: 'mysql' });
    panelRegistry.fireMessage(panel, { command: 'loadTables' });
    panelRegistry.fireMessage(panel, { command: 'previewTable', table: 'tbl_Account' });
    panelRegistry.fireMessage(panel, { command: 'scanKeys' });
    panelRegistry.fireMessage(panel, { command: 'previewKey', key: 'kbe_entitylog:1:2' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(panel.webview.postedMessages.length).toBeGreaterThanOrEqual(4);
    for (const posted of panel.webview.postedMessages) {
      const result = (posted.message as { result?: { ok?: boolean; kind?: string } }).result;
      if (result && 'ok' in result) {
        expect(result.ok).toBe(false);
      } else if (result && 'kind' in result) {
        // 表格预览面错误并入 result.kind(非 ok 布尔)
        expect(result.kind).toBe('error');
      }
    }
    panel.dispose();
  });

  it('telnet.showPanel / telnet.disconnect:空目标下开面板与断开不抛', async () => {
    await commands.executeCommand('kbengine.telnet.showPanel');
    await commands.executeCommand('kbengine.telnet.disconnect');
    expect(panelRegistry.panels.length).toBeGreaterThan(0);
  });

  it('bots.add / bots.count:无 bots telnet 目标 → 如实报错不崩', async () => {
    await commands.executeCommand('kbengine.bots.add');
    await commands.executeCommand('kbengine.bots.count');
    expect(messages.error.length + messages.info.length).toBeGreaterThan(0);
  });

  it('python.ruffLint:未配置 → 如实提示不空转', async () => {
    await commands.executeCommand('kbengine.python.ruffLint');
    expect(messages.info.length + messages.warning.length + messages.error.length).toBeGreaterThan(0);
  });

  it('python.createVenv:目录选择取消即止', async () => {
    await commands.executeCommand('kbengine.python.createVenv');
    expect(messages.info.join('')).not.toContain('创建完成');
  });

  it('python.selectInterpreter:选择器取消即止,状态条仍刷新', async () => {
    await commands.executeCommand('kbengine.python.selectInterpreter');
    expect(messages.error).toHaveLength(0);
  });

  it('hotReload.configureChannel:输入取消即止不落台账', async () => {
    await commands.executeCommand('kbengine.hotReload.configureChannel');
    expect(messages.error).toHaveLength(0);
  });

  it('hotReload.confirmDefBaseline:空基线 → 0 个文件的完成提示', async () => {
    await commands.executeCommand('kbengine.hotReload.confirmDefBaseline');
    expect(lastInfo()).toContain('def 结构基线已对齐当前内容(0 个文件)');
  });

  it('hotReload.confirmDefBaseline:重启确认后清 RESTART_REQUIRED 标记(2026-11-12 用户问「重启后怎么清状态」)', async () => {
    // 装配层此前的缺口:命令只重建 def 基线,从不清状态机的 RESTART_REQUIRED
    // 标记(全仓只有测试调 clearRestartRequired)。角标/状态点的紫色 R 在重启
    // 后仍挂着。断言两条只在新接线里存在的文案——去掉清除分支即红。
    await commands.executeCommand('kbengine.hotReload.confirmDefBaseline');
    expect(lastInfo()).toContain('「需重启」标记已清除');
    const logLines =
      channels.find(channel => channel.name === 'KBEngine 热更新')?.lines ?? [];
    expect(logLines.some(line => line.includes('个被拦文件解除需重启标记'))).toBe(true);
  });

  it('hotReload.filterByState / showFileState:取消即止不抛', async () => {
    await commands.executeCommand('kbengine.hotReload.filterByState');
    await commands.executeCommand('kbengine.hotReload.showFileState');
    expect(messages.error).toHaveLength(0);
  });
});

describe('配置联动与文档诊断面(覆盖补测)', () => {
  const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const fire = (keys: string[]): void => {
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (key: string) => key === 'kbengine' || keys.includes(key)
    });
  };

  it('enableDiagnostics 主开关:全管线 setEnabled;子开关变更失效重算', async () => {
    configurationOverrides.set('kbengine', { enableDiagnostics: true });
    fire(['kbengine.enableDiagnostics']);
    await settle(120);
    fire([
      'kbengine.enableStructureDiagnostics',
      'kbengine.diagnostics',
      'kbengine.receiverNoneDiagnostics',
      'kbengine.attributeNoneDiagnostics',
      'kbengine.propertyDirectionDiagnostics',
      'kbengine.readOnlyWriteDiagnostics',
      'kbengine.roleMisuseDiagnostics',
      'kbengine.postDestroyDiagnostics',
      'kbengine.startupScriptDiagnostics',
      'kbengine.diagnostics.checkDefMethodMissingInPython',
      'kbengine.diagnostics.checkPythonMethodNotInDef',
      'kbengine.entity.methodStubBody',
      'kbengine.diagnostics.checkProcessTopology'
    ]);
    await settle(120);
    expect(messages.error).toHaveLength(0);
  });

  it('在册各类文档 × 配置变更:各调度臂按文档类型即时重算', async () => {
    const defDoc = makeTextDocument('<Avatar/>', {
      fileName: path.join(root, 'scripts', 'entity_defs', 'Avatar.def'),
      languageId: 'kbengine-def'
    });
    const entitiesDoc = makeTextDocument('<root>\n  <Avatar> <hasClient/></Avatar>\n</root>', {
      fileName: path.join(root, 'scripts', 'entities.xml'),
      languageId: 'xml'
    });
    const pyDoc = makeTextDocument('class Avatar:\n    def onEnterCell(self):\n        pass\n', {
      fileName: path.join(root, 'scripts', 'avatar_cell.py'),
      languageId: 'python'
    });
    const topoDoc = makeTextDocument('<root/>', {
      fileName: path.join(root, 'process_topology.xml'),
      languageId: 'xml'
    });
    const shellDoc = makeTextDocument('#!/bin/sh\nexit 0\n', {
      fileName: path.join(root, 'start.sh'),
      languageId: 'shellscript'
    });
    workspace.textDocuments = [defDoc, entitiesDoc, pyDoc, topoDoc, shellDoc];
    configurationOverrides.set('kbengine', { enableDiagnostics: true });
    fire([
      'kbengine.enableDiagnostics',
      'kbengine.enableStructureDiagnostics',
      'kbengine.diagnostics.checkProcessTopology',
      'kbengine.diagnostics.checkDefMethodMissingInPython',
      'kbengine.propertyDirectionDiagnostics',
      'kbengine.readOnlyWriteDiagnostics',
      'kbengine.roleMisuseDiagnostics',
      'kbengine.postDestroyDiagnostics'
    ]);
    await settle(150);
    // 关闭主开关:各 collection 清空、调度器停算
    configurationOverrides.set('kbengine', { enableDiagnostics: false });
    fire(['kbengine.enableDiagnostics']);
    await settle(120);
    configurationOverrides.delete('kbengine');
    expect(messages.error).toHaveLength(0);
  });

  it('文档打开/变更/保存/关闭事件:各类型文档走注册事件面', async () => {
    const pyDoc = makeTextDocument('value = 1\n', {
      fileName: path.join(root, 'scripts', 'wiring_loose.py'),
      languageId: 'python'
    });
    const defDoc = makeTextDocument('<Avatar/>', {
      fileName: path.join(root, 'scripts', 'entity_defs', 'Wiring.def'),
      languageId: 'kbengine-def'
    });
    workspaceEvents.documentOpened.fire(pyDoc);
    workspaceEvents.documentChanged.fire({ document: defDoc, contentChanges: [{ text: '' }] });
    workspaceEvents.documentSaved.fire(pyDoc);
    workspaceEvents.documentClosed.fire(pyDoc);
    await settle(120);
    expect(messages.error).toHaveLength(0);
  });
});

describe('monitoring 与 git 历史命令面(覆盖补测)', () => {
  const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  it('profile.start:本机无组件 → 如实警示', async () => {
    await commands.executeCommand('kbengine.profile.start');
    expect(messages.warning[messages.warning.length - 1]).toContain('未发现可查询的 KBEngine 组件');
  });

  it('liveObservation.openExceptionSource:无参/原始串解析失败如实保留原文', async () => {
    await commands.executeCommand('kbengine.liveObservation.openExceptionSource');
    expect(messages.warning[messages.warning.length - 1]).toContain('无原始信息');
    await commands.executeCommand('kbengine.liveObservation.openExceptionSource', {
      raw: 'Traceback: boom.py:1'
    });
    expect(messages.warning[messages.warning.length - 1]).toContain('boom.py');
  });

  it('liveObservation.openExceptionSource:可解析定位 → 打开真实文件并跳行', async () => {
    const target = path.join(root, 'scripts', 'wiring_loose.py');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'value = 1\n', 'utf8');
    await commands.executeCommand('kbengine.liveObservation.openExceptionSource', {
      file: target,
      line: 1
    });
    expect(messages.warning).toHaveLength(0);
  });

  it('git.showHistory:无活动文件 → 如实提示不查询', async () => {
    await commands.executeCommand('kbengine.git.showHistory');
    expect(messages.info[messages.info.length - 1]).toContain('无活动文件可查看历史');
  });

  it('git.showRangeHistory:无选区 → 空态入视图,不查询', async () => {
    await commands.executeCommand('kbengine.git.showRangeHistory');
    expect(messages.error).toHaveLength(0);
  });

  it('git.historyNextPage:空台账空转不抛', async () => {
    await commands.executeCommand('kbengine.git.historyNextPage');
    expect(messages.error).toHaveLength(0);
  });

  it('git.openVersionDiff / openVersionContent / openRangeHistoryDiff:参数不完整/上下文不符如实提示', async () => {
    await commands.executeCommand('kbengine.git.openVersionDiff');
    expect(messages.info[messages.info.length - 1]).toContain('参数不完整');
    await commands.executeCommand('kbengine.git.openVersionContent', { kind: 'other' });
    expect(messages.info[messages.info.length - 1]).toContain('上下文不是提交记录');
    await commands.executeCommand('kbengine.git.openRangeHistoryDiff', { kind: 'other' }, 'f', 'r', 'p');
    expect(messages.info[messages.info.length - 1]).toContain('上下文不是修改记录');
  });
});

describe('数据库与克隆命令面(覆盖补测)', () => {
  it('database.showDriftEvidence:无证据 → 如实提示', async () => {
    await commands.executeCommand('kbengine.database.showDriftEvidence');
    expect(messages.info.length + messages.warning.length).toBeGreaterThan(0);
  });

  it('database.previewTable:选择取消即止', async () => {
    await commands.executeCommand('kbengine.database.previewTable');
    expect(messages.error).toHaveLength(0);
  });

  it('database.previewSchemaImpact:无实体上下文 → 如实提示不崩', async () => {
    await commands.executeCommand('kbengine.database.previewSchemaImpact');
    expect(messages.error).toHaveLength(0);
  });

  it('dependency.show / pythonCallGraph.show:面板打开,消息监听在位', async () => {
    await commands.executeCommand('kbengine.dependency.show');
    await commands.executeCommand('kbengine.pythonCallGraph.show');
    expect(panelRegistry.panels.length).toBeGreaterThan(0);
  });

  it('clone.testSource:未配置 Source → 如实提示不建连', async () => {
    await commands.executeCommand('kbengine.clone.testSource');
    expect(messages.info.length + messages.warning.length + messages.error.length).toBeGreaterThan(0);
  });

  it('clone.showAudit:暂无审计 → 如实说明', async () => {
    await commands.executeCommand('kbengine.clone.showAudit');
    expect(messages.info.length + messages.warning.length).toBeGreaterThan(0);
  });

  it('clone.inspectArchive:未选归档即止', async () => {
    await commands.executeCommand('kbengine.clone.inspectArchive');
    expect(messages.error).toHaveLength(0);
  });

  it('clone.export:实体选择取消即止', async () => {
    await commands.executeCommand('kbengine.clone.export');
    expect(messages.error).toHaveLength(0);
  });

  it('clone.import:Target 未配置 → 提供配置入口(取消即止不写入)', async () => {
    await commands.executeCommand('kbengine.clone.import');
    expect(messages.warning.length).toBeGreaterThan(0);
  });

  it('clone.configureTarget:向导输入取消 → 不落台账', async () => {
    await commands.executeCommand('kbengine.clone.configureTarget');
    expect(messages.error).toHaveLength(0);
  });
});
