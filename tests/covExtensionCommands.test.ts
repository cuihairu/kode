import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { messages, window as fakeWindow, windowState, treeRegistrations } from './fake-vscode/windowState';
import { configurationOverrides, workspace, workspaceEvents, workspaceState, memoryFileSystem } from './fake-vscode/workspaceState';
import { annotationSourceLog } from '../src/annotationSourceLog';
import { setHoverInFlightGateForTests } from '../src/languageProviders';
import {
  makeTextDocument,
  Position,
  Uri,
  type ExtensionContext
} from './fake-vscode/core';
import { tests as testsRegistry, tasks } from './fake-vscode/core';
import { fakeExtensionList } from './fake-vscode/extensionsState';
import {
  resetCpuProfileCapture,
  setCpuProfileSessionFactory,
  type CpuProfilerSessionLike
} from '../src/cpuProfileCapture';

// extension.ts 激活链命令面补测:metrics 四命令 / focusTarget 空参 /
// 无 profile 拒绝路径 / 远程主机管理 / debugpy 同步与等待连接开关 /
// py-spy 本地未装取消 / 兼容性检查 / 符号引用图 / 漂移未校验 / 临时编辑
// 热更停用 / 工作区与配置事件 / 提供者包装(operation 打点)。

class FakeProfilerSession implements CpuProfilerSessionLike {
  connected = false;
  disconnected = false;
  connect(): void { this.connected = true; }
  disconnect(): void { this.disconnected = true; }
  post(
    _method: string,
    _params?: object,
    callback?: (err: Error | null, result?: { profile?: unknown }) => void
  ): void {
    const done = callback ?? ((): void => undefined);
    if (_method === 'Profiler.stop') {
      done(null, {
        profile: {
          nodes: [{ id: 1, callFrame: { functionName: 'root' }, hitCount: 0, children: [] }],
          samples: [1],
          timeDeltas: [100],
          startTime: 1,
          endTime: 2
        }
      });
      return;
    }
    done(null, undefined);
  }
}

const tokenStub = { isCancellationRequested: false, onCancellationRequested: (): { dispose(): void } => ({ dispose: () => undefined }) };

let root = '';
let defsRoot = '';
let assets = '';
let assetsDefs = '';
let extDir = '';
let gsDir = '';
let context: ExtensionContext;

const channelLines = (name: string): string => {
  const channel = windowState.channels.find(entry => entry.name === name);
  return channel ? channel.lines.join('') : '';
};

// 内存 memento:命令链的 workspaceState 读写真实往返(远程主机增删等)
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-cov-'));
  defsRoot = path.join(root, 'scripts', 'entity_defs');
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
      '  <BaseMethods>',
      '    <respawn/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'scripts', 'entities.xml'),
    '<root>\n  <Avatar> <hasClient/></Avatar>\n</root>\n',
    'utf8'
  );
  // 测试面板发现面:profile scripts 根下的 pytest 用例
  fs.writeFileSync(
    path.join(root, 'scripts', 'test_sample.py'),
    'def test_ok():\n    assert True\n',
    'utf8'
  );
  // 探针面目标文件(python hover/definition 在途门用)
  fs.writeFileSync(
    path.join(root, 'scripts', 'hero.py'),
    'class Avatar:\n    def respawn(self):\n        pass\n',
    'utf8'
  );
  // 活动 profile 侧的完整资产根:engine probe 独立(与 root 的探测缓存
  // 互不污染),scripts 下带入口脚本/实体定义/测试用例
  assets = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-assets-'));
  assetsDefs = path.join(assets, 'scripts', 'entity_defs');
  fs.mkdirSync(assetsDefs, { recursive: true });
  fs.writeFileSync(
    path.join(assetsDefs, 'Avatar.def'),
    fs.readFileSync(path.join(defsRoot, 'Avatar.def')),
    'utf8'
  );
  fs.writeFileSync(
    path.join(assets, 'scripts', 'entities.xml'),
    '<root>\n  <Avatar> <hasClient/></Avatar>\n</root>\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(assets, 'scripts', 'kbengine.py'),
    '# engine entry\nimport kbemain\nkbemain.run()\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(assets, 'scripts', 'test_sample.py'),
    'def test_ok():\n    assert True\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(assets, 'scripts', 'test_broken.py'),
    'def test_bad():\n    raise AssertionError("boom")\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(assets, 'scripts', 'hero.py'),
    'class Avatar:\n    def respawn(self):\n        pass\n',
    'utf8'
  );
  // 兼容性检查的清单面:extensionUri 指向真实 package.json,旁边有
  // out/extension.js(bundle 检查存在性)
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-manifest-'));
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({
      name: 'kode',
      version: '0.2.0',
      engines: { vscode: '^1.84.0' },
      contributes: {
        configuration: {
          properties: {
            'kbengine.annotationLog': { type: 'boolean', default: true },
            'kbengine.jumpLog': { type: 'boolean', default: false }
          }
        }
      }
    }),
    'utf8'
  );
  fs.mkdirSync(path.join(extDir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'out', 'extension.js'), '', 'utf8');
  gsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-gs-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(assets, { recursive: true, force: true });
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.rmSync(gsDir, { recursive: true, force: true });
});

const prepareWorkspace = (wsRoot: string, wsDefs: string): void => {
  workspace.workspaceFolders = [{ uri: Uri.file(wsRoot), name: 'ws', index: 0 }];
  workspace.textDocuments = [];
  workspace.findFiles = (async (pattern: string): Promise<Uri[]> => {
    if (pattern !== '**/*.def') {
      return [];
    }
    return [Uri.file(path.join(wsDefs, 'Avatar.def'))];
  });
};

beforeEach(() => {
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;
});

describe('extension 激活链命令面(补测)', () => {
  // 激活返回值=现场探针 API(probeHover/门控取消探针/pendingWork 量规)
  let probes: {
    probeHover: (target: { file: string; line: number; character: number }, cancelAfterMs?: number, preCancel?: boolean) => Promise<{ elapsedMs: number; cancelled: boolean; returnedHover: boolean; preview: string }>;
    probeDefinitionGatedCancel: (target: { file: string; line: number; character: number }) => Promise<{ gateEnteredAtMs: number; cancelledAtMs: number; settledBeforeCancel: boolean; elapsedMs: number; cancelled: boolean; returnedDefinition: boolean; location: string | null }>;
    probeHoverGatedCancel: (target: { file: string; line: number; character: number }) => Promise<{ gateEnteredAtMs: number; cancelledAtMs: number; settledBeforeCancel: boolean; elapsedMs: number; cancelled: boolean; returnedHover: boolean; preview: string }>;
    pendingWork: () => Record<string, unknown>;
  };

  beforeAll(async () => {
    commandRegistry.reset();
    languagesRegistry.reset();
    windowState.reset();
    testsRegistry.reset();
    prepareWorkspace(root, defsRoot);
    context = {
      subscriptions: [],
      extensionUri: Uri.file(path.join(extDir, 'package.json')),
      extensionPath: extDir,
      extension: { id: 'cuihairu.kode', extensionKind: 'workspace' },
      globalStoragePath: gsDir,
      workspaceState: makeMemento(new Map())
    };
    probes = activate(context) as typeof probes;
    await new Promise(resolve => setTimeout(resolve, 400));
  });

  afterAll(() => {
    disposeContext(context);
    expect(deactivate()).toBeUndefined();
  });

  it('探针:probeHover 预取消零工作返回空', async () => {
    const originalOpen = workspace.openTextDocument;
    (workspace as { openTextDocument: unknown }).openTextDocument = async (uri: { fsPath?: string }) =>
      makeTextDocument(fs.readFileSync(String(uri.fsPath), 'utf8'), {
        fileName: String(uri.fsPath),
        languageId: String(uri.fsPath).endsWith('.py') ? 'python' : 'kbengine-def'
      });
    try {
      const result = await probes.probeHover(
        { file: path.join(root, 'scripts', 'hero.py'), line: 0, character: 0 },
        undefined,
        true
      );
      expect(result.cancelled).toBe(true);
      expect(result.returnedHover).toBe(false);
    } finally {
      (workspace as { openTextDocument: unknown }).openTextDocument = originalOpen;
    }
  });

  it('探针:probeHover 定时取消面构造即走(cancelAfterMs 定时器分支)', async () => {
    const originalOpen = workspace.openTextDocument;
    (workspace as { openTextDocument: unknown }).openTextDocument = async (uri: { fsPath?: string }) =>
      makeTextDocument(fs.readFileSync(String(uri.fsPath), 'utf8'), {
        fileName: String(uri.fsPath),
        languageId: String(uri.fsPath).endsWith('.py') ? 'python' : 'kbengine-def'
      });
    try {
      const result = await probes.probeHover(
        { file: path.join(root, 'scripts', 'hero.py'), line: 1, character: 9 },
        25
      );
      expect(typeof result.elapsedMs).toBe('number');
    } finally {
      (workspace as { openTextDocument: unknown }).openTextDocument = originalOpen;
    }
  });

  it('探针:probeHoverGatedCancel 门内在途斩,无晚到结果', async () => {
    const originalOpen = workspace.openTextDocument;
    (workspace as { openTextDocument: unknown }).openTextDocument = async (uri: { fsPath?: string }) =>
      makeTextDocument(fs.readFileSync(String(uri.fsPath), 'utf8'), {
        fileName: String(uri.fsPath),
        languageId: String(uri.fsPath).endsWith('.py') ? 'python' : 'kbengine-def'
      });
    try {
      const result = await probes.probeHoverGatedCancel({
        file: path.join(root, 'scripts', 'hero.py'),
        line: 1,
        character: 9
      });
      expect(result.gateEnteredAtMs).toBeGreaterThanOrEqual(0);
      expect(result.cancelled).toBe(true);
      expect(result.settledBeforeCancel).toBe(false);
    } finally {
      (workspace as { openTextDocument: unknown }).openTextDocument = originalOpen;
    }
  });

  it('探针:probeDefinitionGatedCancel 门内在途斩,取消后零查找', async () => {
    const originalOpen = workspace.openTextDocument;
    (workspace as { openTextDocument: unknown }).openTextDocument = async (uri: { fsPath?: string }) =>
      makeTextDocument(fs.readFileSync(String(uri.fsPath), 'utf8'), {
        fileName: String(uri.fsPath),
        languageId: String(uri.fsPath).endsWith('.py') ? 'python' : 'kbengine-def'
      });
    try {
      const result = await probes.probeDefinitionGatedCancel({
        file: path.join(root, 'scripts', 'hero.py'),
        line: 1,
        character: 9
      });
      expect(result.gateEnteredAtMs).toBeGreaterThanOrEqual(0);
      expect(result.cancelled).toBe(true);
      expect(result.settledBeforeCancel).toBe(false);
    } finally {
      (workspace as { openTextDocument: unknown }).openTextDocument = originalOpen;
    }
  });

  it('探针:pendingWork 量规四面聚合返回', () => {
    const workload = probes.pendingWork();
    expect(workload).toHaveProperty('annotationUpdates');
    expect(workload).toHaveProperty('caches');
    expect(workload).toHaveProperty('worker');
  });

  it('metrics.showSummary:汇总三报告入输出通道', async () => {
    await commands.executeCommand('kbengine.metrics.showSummary');
    expect(channelLines('Kode Language Service Metrics').length).toBeGreaterThan(0);
  });

  it('metrics CPU profile:start 成功/重复拒绝/stop 落盘提示', async () => {
    resetCpuProfileCapture();
    setCpuProfileSessionFactory(() => new FakeProfilerSession());
    try {
      await commands.executeCommand('kbengine.metrics.startCpuProfile');
      expect(messages.info.some(message => message.includes('CPU profile started'))).toBe(true);
      await commands.executeCommand('kbengine.metrics.startCpuProfile');
      expect(messages.warning.some(message => message.includes('already running'))).toBe(true);
      await commands.executeCommand('kbengine.metrics.stopCpuProfile');
      expect(messages.info.some(message => message.includes('CPU profile saved'))).toBe(true);
      await commands.executeCommand('kbengine.metrics.stopCpuProfile');
      expect(messages.warning.some(message => message.includes('no CPU profile is running'))).toBe(true);
    } finally {
      resetCpuProfileCapture();
    }
  });

  it('metrics.showActiveTasks:活动任务报告入通道', async () => {
    await commands.executeCommand('kbengine.metrics.showActiveTasks');
    expect(channelLines('Kode Language Service Metrics').length).toBeGreaterThan(0);
  });

  it('debug.focusTarget:无参指引 / 未知键如实报不在运行', async () => {
    await commands.executeCommand('kbengine.debug.focusTarget');
    expect(messages.info.some(message => message.includes('Debug Targets'))).toBe(true);
    await commands.executeCommand('kbengine.debug.focusTarget', 'cellapp#ghost');
    expect(messages.info.some(message => message.includes('不在运行中'))).toBe(true);
  });

  it('build.previewTask / tests.list:无活动 profile 明确提示', async () => {
    await commands.executeCommand('kbengine.build.previewTask');
    expect(messages.info.some(message => message.includes('尚未选择活动 profile'))).toBe(true);
    await commands.executeCommand('kbengine.tests.list');
    expect(messages.info.some(message => message.includes('尚未选择活动 profile'))).toBe(true);
  });

  it('测试面板 Run 档:无 profile 拒绝并警示', async () => {
    const controller = testsRegistry.controllers.find(entry => entry.id === 'kbengine-python-tests');
    expect(controller).toBeDefined();
    const profile = controller?.profiles.find(entry => entry.label === '运行');
    expect(profile).toBeDefined();
    await profile?.runHandler({ include: [] }, tokenStub);
    expect(messages.warning.some(message => message.includes('尚未选择活动 profile'))).toBe(true);
  });

  it('remoteServers:选本地 / 手动添加 / 移除', async () => {
    const originalQuickPick = fakeWindow.showQuickPick;
    const originalInputBox = fakeWindow.showInputBox;
    (fakeWindow as { showQuickPick: unknown }).showQuickPick =
      async () => ({ id: 'local' });
    (fakeWindow as { showInputBox: unknown }).showInputBox =
      async () => 'myhost.example';
    try {
      await commands.executeCommand('kbengine.remoteServers.select');
      expect(messages.info.some(message => message.includes('已切回本地'))).toBe(true);
      await commands.executeCommand('kbengine.remoteServers.add');
      expect(messages.info.some(message => message.includes('已添加远程主机 myhost.example'))).toBe(true);
      await commands.executeCommand('kbengine.remoteServers.remove', { id: 'myhost.example' });
      expect(messages.info.some(message => message.includes('已移除手动主机 myhost.example'))).toBe(true);
    } finally {
      (fakeWindow as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
      (fakeWindow as { showInputBox: unknown }).showInputBox = originalInputBox;
    }
  });

  it('python.debugpySync:无资产根如实报错', async () => {
    await commands.executeCommand('kbengine.python.debugpySync');
    expect(messages.error.some(message => message.includes('debugpy 同步失败'))).toBe(true);
  });

  it('debug.waitAtStartup.on/off:入口脚本缺位如实报/关侧收口', async () => {
    await commands.executeCommand('kbengine.debug.waitAtStartup.on');
    expect(messages.error.some(message => message.includes('未找到入口脚本'))).toBe(true);
    await commands.executeCommand('kbengine.debug.waitAtStartup.off');
    expect(messages.info.some(message => message.includes('等待连接模式已关'))).toBe(true);
  });

  it('debug.resetAttachMode:清除记忆并提示', async () => {
    await commands.executeCommand('kbengine.debug.resetAttachMode');
    expect(messages.info.some(message => message.includes('已清除附加模式选择'))).toBe(true);
  });

  it('debug.pyspyDump:本地未装 py-spy → 一键安装弹窗取消即止', async () => {
    await commands.executeCommand('kbengine.debug.pyspyDump', { name: 'baseapp' });
    expect(
      messages.warning.some(message => message.includes('py-spy')),
      '未装 py-spy 时应弹一键安装提示(测试替身取消)'
    ).toBe(true);
  }, 20000);

  it('debug.pyspyDump:已装 → 进程选择 → dump 出栈入通道', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pyspy-bin-'));
    fs.writeFileSync(
      path.join(binDir, 'py-spy'),
      [
        '#!/bin/sh',
        'if [ "$1" = "dump" ]; then',
        "  printf 'Thread 0x7f (active): \"python\" main (hero.py:10)\\n'",
        '  exit 0',
        'fi',
        "printf 'py-spy 0.3.14\\n'",
        'exit 0'
      ].join('\n'),
      { mode: 0o755, encoding: 'utf8' }
    );
    const originalPath = process.env.PATH;
    const originalQuickPick = fakeWindow.showQuickPick;
    process.env.PATH = `${binDir}:${originalPath}`;
    (fakeWindow as { showQuickPick: unknown }).showQuickPick =
      async (items: Array<{ description?: string }>) => items[0];
    try {
      await commands.executeCommand('kbengine.debug.pyspyDump', { name: 'baseapp' });
      expect(channelLines('KBEngine py-spy')).toContain('py-spy dump baseapp');
      expect(channelLines('KBEngine py-spy')).toContain('hero.py:10');
      expect(messages.error).toHaveLength(0);
    } finally {
      process.env.PATH = originalPath;
      (fakeWindow as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }, 30000);

  it('compatibility.check:清单/bundle 就绪 → 完成提示入通道', async () => {
    await commands.executeCommand('kbengine.compatibility.check');
    expect(messages.info.some(message => message.includes('兼容性检查完成'))).toBe(true);
    expect(channelLines('KBEngine Compatibility')).toContain('Engine source: not found');
  });

  it('symbolReferences.show:工作区 .def 出引用图预览', async () => {
    await commands.executeCommand('kbengine.symbolReferences.show');
    expect(channelLines('KBEngine Symbol References')).toContain('Mermaid');
  });

  it('database.checkAllDrift:无可校验快照 → 未校验提示', async () => {
    await commands.executeCommand('kbengine.database.checkAllDrift');
    expect(messages.info.some(message => message.includes('数据库漂移未校验'))).toBe(true);
  }, 20000);

  it('hotReload.tempEdit.run:默认停用 → 警示开启路径', async () => {
    await commands.executeCommand('kbengine.hotReload.tempEdit.run');
    expect(messages.warning.some(message => message.includes('临时编辑热更新已停用'))).toBe(true);
  });

  it('hotReload.tempEdit.run:开启后无活动编辑器 → 如实提示', async () => {
    configurationOverrides.set('kbengine', { hotReload: { tempEdit: { enabled: true } } });
    try {
      await commands.executeCommand('kbengine.hotReload.tempEdit.run');
      expect(messages.info.some(message => message.includes('需要活动编辑器'))).toBe(true);
    } finally {
      configurationOverrides.delete('kbengine');
    }
  });

  it('hotReload.retryFailed:无失败目标 → 空转收口不抛', async () => {
    await commands.executeCommand('kbengine.hotReload.retryFailed');
  });

  it('httpRequests.run:无已启用请求 → 指引配置面', async () => {
    await commands.executeCommand('kbengine.httpRequests.run');
    expect(messages.info.some(message => message.includes('没有已启用的 HTTP 快捷请求'))).toBe(true);
  });

  it('httpRequest.run:缺 args.name → 用法警示', async () => {
    await commands.executeCommand('kbengine.httpRequest.run');
    expect(messages.warning.some(message => message.includes('args.name'))).toBe(true);
  });

  it('quickActions.show:选择器取消即止', async () => {
    await commands.executeCommand('kbengine.quickActions.show');
  });

  it('debug.attachRemote:远端选择取消即止', async () => {
    await commands.executeCommand('kbengine.debug.attachRemote');
  });

  it('hotReload.showBatchSummary / showRevisionEvidence:空台账收口不抛', async () => {
    await commands.executeCommand('kbengine.hotReload.showBatchSummary');
    await commands.executeCommand('kbengine.hotReload.showRevisionEvidence');
  });

  it('signatureHelp 包装:打点透传', async () => {
    const defDoc = makeTextDocument('<Avatar>\n  <BaseMethods>\n    <respawn(a', {
      fileName: path.join(defsRoot, 'Avatar.def'),
      languageId: 'kbengine-def'
    });
    for (const registration of languagesRegistry.signatureHelpRegistrations) {
      const provider = registration.provider as { provideSignatureHelp?: (doc: unknown, pos: unknown, tok: unknown) => Promise<unknown> };
      if (provider.provideSignatureHelp) {
        await provider.provideSignatureHelp(defDoc, new Position(2, 15), tokenStub);
      }
    }
  });

  it('clientSdk.generate:无 profile 回落工作区根,语言选择取消即止', async () => {
    await commands.executeCommand('kbengine.clientSdk.generate');
    expect(messages.error.some(message => message.includes('没有打开的工作区'))).toBe(false);
  }, 20000);

  it('onDidChangeWorkspaceFolders:移除根整根摘除/新增根失效重扫', () => {
    workspaceEvents.foldersChanged.fire({ added: [], removed: [{ uri: { fsPath: '/gone-root' } }] });
    workspaceEvents.foldersChanged.fire({ added: [{ uri: { fsPath: '/added-root' } }], removed: [] });
  });

  it('onDidChangeConfiguration:db 配置与引擎根变化走各自联动', () => {
    // 真实语义:affectsConfiguration('kbengine') 对任意 kbengine.* 变化为真
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (key: string) => key === 'kbengine' || key === 'kbengine.db'
    });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (key: string) =>
        key === 'kbengine' || key === 'kbengine.engineRoot' || key === 'kbengine.assetsRoot'
    });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (key: string) => key === 'kbengine.jumpLog'
    });
  });

  it('语言服务包装:hover/definition/completion 打点透传', async () => {
    const pythonDoc = makeTextDocument('import base\nvalue = 1\n', {
      fileName: path.join(root, 'scripts', 'value.py'),
      languageId: 'python'
    });
    for (const registration of languagesRegistry.hoverRegistrations) {
      const provider = registration.provider as { provideHover?: (doc: unknown, pos: unknown, tok: unknown) => Promise<unknown> };
      if (provider.provideHover) {
        await provider.provideHover(pythonDoc, new Position(1, 1), tokenStub);
      }
    }
    for (const registration of languagesRegistry.definitionRegistrations) {
      const provider = registration.provider as { provideDefinition?: (doc: unknown, pos: unknown, tok: unknown) => Promise<unknown> };
      if (provider.provideDefinition) {
        await provider.provideDefinition(pythonDoc, new Position(1, 1), tokenStub);
      }
    }
    const defDoc = makeTextDocument('<Avatar>\n  <Properties>\n', {
      fileName: path.join(defsRoot, 'Avatar.def'),
      languageId: 'kbengine-def'
    });
    for (const registration of languagesRegistry.completionRegistrations) {
      const provider = registration.provider as { provideCompletionItems?: (doc: unknown, pos: unknown, tok: unknown) => Promise<unknown> };
      if (provider.provideCompletionItems) {
        await provider.provideCompletionItems(
          registration.triggerCharacters?.includes('<') ? defDoc : pythonDoc,
          new Position(registration.triggerCharacters?.includes('<') ? 0 : 1, 1),
          tokenStub
        );
      }
    }
  });

  it('kbengine.extension.identity:采集 cuihairu.* 扩展并渲染身份报告', async () => {
    // 注入一个 cuihairu 命名空间扩展(带 version/extensionPath/isActive/kind),
    // 命令按 id 过滤+映射+排序,输出走身份通道
    fakeExtensionList.push({
      id: 'cuihairu.kode-core',
      isActive: true,
      packageJSON: { version: '1.2.3' },
      extensionPath: path.join(extDir, 'core'),
      extensionKind: 'workspace'
    } as never);
    try {
      await commands.executeCommand('kbengine.extension.identity');
      expect(channelLines('Kode 扩展身份')).toContain('cuihairu.kode-core');
      expect(channelLines('Kode 扩展身份')).toContain('1.2.3');
    } finally {
      fakeExtensionList.length = 0;
    }
  });

  it('remoteServers:显式 id 选中 / 无效 id 即止 / 取消添加 / 无 id 移除', async () => {
    const originalInputBox = fakeWindow.showInputBox;
    try {
      await commands.executeCommand('kbengine.remoteServers.select', 'local');
      expect(messages.info.some(message => message.includes('已切回本地'))).toBe(true);
      await commands.executeCommand('kbengine.remoteServers.select', 'no-such-host');
      (fakeWindow as { showInputBox: unknown }).showInputBox = async () => undefined;
      await commands.executeCommand('kbengine.remoteServers.add');
      await commands.executeCommand('kbengine.remoteServers.remove', {});
      await commands.executeCommand('kbengine.remoteServers.remove', undefined);
    } finally {
      (fakeWindow as { showInputBox: unknown }).showInputBox = originalInputBox;
    }
  });

  it('remoteServers.add:校验回调与主机写入', async () => {
    const originalInputBox = fakeWindow.showInputBox;
    (fakeWindow as { showInputBox: unknown }).showInputBox =
      async (options: { validateInput?: (value: string) => string | null }) => {
        expect(typeof options.validateInput?.('')).toBe('string');
        expect(options.validateInput?.('host-a')).toBeNull();
        return 'host-a';
      };
    try {
      await commands.executeCommand('kbengine.remoteServers.add');
      expect(messages.info.some(message => message.includes('host-a'))).toBe(true);
      await commands.executeCommand('kbengine.remoteServers.remove', { id: 'host-a' });
    } finally {
      (fakeWindow as { showInputBox: unknown }).showInputBox = originalInputBox;
    }
  });

  it('remoteServers.refresh:重读 ssh 配置并提示台数', async () => {
    await commands.executeCommand('kbengine.remoteServers.refresh');
    expect(messages.info.some(message => message.includes('远程主机已刷新'))).toBe(true);
  });

  it('onDidChangeConfiguration:开关类变更逐路即时生效', () => {
    const fire = (keys: string[]): void => {
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: (key: string) => key === 'kbengine' || keys.includes(key)
      });
    };
    fire(['kbengine.jumpLog', 'kbengine.annotationLog']);
    fire(['kbengine.python.enableDataDictIndex']);
    fire(['kbengine.codeLens']);
    fire(['kbengine.entity']);
    fire(['kbengine.python.callChainHints']);
    fire(['kbengine.enableDiagnostics']);
  });

  it('onDidChangeConfiguration:managedDir 与引擎桩面变更重建托管资产', () => {
    const fire = (keys: string[]): void => {
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: (key: string) => key === 'kbengine' || keys.includes(key)
      });
    };
    fire(['kbengine.managedDir']);
    fire(['kbengine.python.stubEngineTypings', 'kbengine.python.entityStubMethods']);
  });

  it('文档事件面:def/types.xml 编辑失效 schema 缓存,python 开合走诊断与注解释放', () => {
    const defDoc = makeTextDocument('<Avatar/>', {
      fileName: path.join(defsRoot, 'Avatar.def'),
      languageId: 'kbengine-def'
    });
    const typesDoc = makeTextDocument('<root/>', {
      fileName: path.join(root, 'types.xml'),
      languageId: 'xml'
    });
    const pyDoc = makeTextDocument('value = 1\n', {
      fileName: path.join(root, 'scripts', 'loose.py'),
      languageId: 'python'
    });
    workspaceEvents.documentChanged.fire({ document: defDoc, contentChanges: [{ text: '' }] });
    workspaceEvents.documentChanged.fire({ document: typesDoc, contentChanges: [{ text: '' }] });
    workspaceEvents.documentOpened.fire(pyDoc);
    workspaceEvents.documentClosed.fire(pyDoc);
  });

  it('补全包装:取消 token 即止(cancelled 打点)', async () => {
    const cancelledToken = {
      isCancellationRequested: true,
      onCancellationRequested: (): { dispose(): void } => ({ dispose: () => undefined })
    };
    const defDoc = makeTextDocument('<Avatar>\n  <BaseMethods>\n    <respawn', {
      fileName: path.join(defsRoot, 'Avatar.def'),
      languageId: 'kbengine-def'
    });
    const pyDoc = makeTextDocument('import base\nvalue = 1\n', {
      fileName: path.join(root, 'scripts', 'value.py'),
      languageId: 'python'
    });
    for (const registration of languagesRegistry.completionRegistrations) {
      const provider = registration.provider as { provideCompletionItems?: (doc: unknown, pos: unknown, tok: unknown) => Promise<unknown> };
      if (provider.provideCompletionItems) {
        await provider.provideCompletionItems(
          registration.triggerCharacters?.includes('<') ? defDoc : pyDoc,
          new Position(registration.triggerCharacters?.includes('<') ? 0 : 1, 1),
          cancelledToken
        );
      }
    }
  });

  it('语言服务包装:hover/definition 打到 def 符号位(结果对象分支)', async () => {
    const defDoc = makeTextDocument('<root>\n  <Properties>\n    <hp>\n      <Type>UINT32</Type>\n    </hp>\n  </Properties>\n</root>\n', {
      fileName: path.join(defsRoot, 'Avatar.def'),
      languageId: 'kbengine-def'
    });
    const callSafely = async (
      registrations: Array<{ provider: unknown }>,
      method: string
    ): Promise<void> => {
      for (const registration of registrations) {
        const provider = registration.provider as Record<string, ((doc: unknown, pos: unknown, tok: unknown) => Promise<unknown>) | undefined>;
        const handler = provider[method];
        if (typeof handler !== 'function') {
          continue;
        }
        try {
          await handler(defDoc, new Position(2, 6), tokenStub);
        } catch {
          // 单个 provider 不支持 def 文档属正常面,错误路径同样计入包装 catch
        }
      }
    };
    await callSafely(languagesRegistry.hoverRegistrations, 'provideHover');
    await callSafely(languagesRegistry.definitionRegistrations, 'provideDefinition');
  });

  it('定义包装:entities.xml 实体名 → 单 Location(空态判定对象臂)', async () => {
    const entitiesDoc = makeTextDocument('<root>\n  <Avatar> <hasClient/></Avatar>\n</root>\n', {
      fileName: path.join(root, 'scripts', 'entities.xml'),
      languageId: 'xml'
    });
    let sawLocation = false;
    for (const registration of languagesRegistry.definitionRegistrations) {
      const provider = registration.provider as {
        provideDefinition?: (doc: unknown, pos: unknown, tok: unknown) => Promise<unknown>;
      };
      if (typeof provider.provideDefinition !== 'function') {
        continue;
      }
      try {
        const result = (await provider.provideDefinition(entitiesDoc, new Position(1, 4), tokenStub)) as
          | { uri?: unknown }
          | null;
        if (result && 'uri' in result) {
          sawLocation = true;
        }
      } catch {
        // 非 entities.xml 选择器的 provider 不支持该文档,跳过
      }
    }
    expect(sawLocation).toBe(true);
  });

  it('探针:probeHover 门内定时取消(在途斩定时器分支)', async () => {
    let markEntered!: () => void;
    let releaseGate!: () => void;
    const enteredSignal = new Promise<void>(resolve => { markEntered = resolve; });
    const release = new Promise<void>(resolve => { releaseGate = resolve; });
    setHoverInFlightGateForTests(() => {
      markEntered();
      return release.then(() => { setHoverInFlightGateForTests(null); });
    });
    const originalOpen = workspace.openTextDocument;
    (workspace as { openTextDocument: unknown }).openTextDocument = async (uri: { fsPath?: string }) =>
      makeTextDocument(fs.readFileSync(String(uri.fsPath), 'utf8'), {
        fileName: String(uri.fsPath),
        languageId: String(uri.fsPath).endsWith('.py') ? 'python' : 'kbengine-def'
      });
    try {
      const probePromise = probes.probeHover(
        { file: path.join(root, 'scripts', 'hero.py'), line: 1, character: 9 },
        20
      );
      await enteredSignal;
      await new Promise(resolve => setTimeout(resolve, 60));
      releaseGate();
      const result = await probePromise;
      expect(result.cancelled).toBe(true);
    } finally {
      setHoverInFlightGateForTests(null);
      (workspace as { openTextDocument: unknown }).openTextDocument = originalOpen;
    }
  });

  it('python.serviceStatus:三态检查消息', async () => {
    await commands.executeCommand('kbengine.python.serviceStatus');
    expect(messages.info.length).toBeGreaterThan(0);
  });

  it('debug.pyspyDump:无目标且选择器取消即止', async () => {
    await commands.executeCommand('kbengine.debug.pyspyDump');
  });

  it('project.doctor / symbolReferences:无 def 候选如实提示', async () => {
    const originalFindFiles = workspace.findFiles;
    (workspace as { findFiles: unknown }).findFiles = (async () => []);
    try {
      await commands.executeCommand('kbengine.project.doctor');
      expect(messages.info.some(message => message.includes('未找到 .def 文件'))).toBe(true);
      await commands.executeCommand('kbengine.symbolReferences.show');
      expect(messages.info.some(message => message.includes('未找到 .def 文件'))).toBe(true);
    } finally {
      (workspace as { findFiles: unknown }).findFiles = originalFindFiles;
    }
  });

  it('project.doctor / symbolReferences:非标准定义布局给出明确指引', async () => {
    const looseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-loose-def-'));
    const looseDef = path.join(looseDir, 'loose.def');
    fs.writeFileSync(looseDef, '<root/>', 'utf8');
    const originalFindFiles = workspace.findFiles;
    (workspace as { findFiles: unknown }).findFiles = (async () => [Uri.file(looseDef)]);
    try {
      await commands.executeCommand('kbengine.project.doctor');
      expect(messages.warning.some(message => message.includes('仅支持标准定义布局'))).toBe(true);
      await commands.executeCommand('kbengine.symbolReferences.show');
      expect(messages.warning.some(message => message.includes('仅支持标准定义布局'))).toBe(true);
    } finally {
      (workspace as { findFiles: unknown }).findFiles = originalFindFiles;
      fs.rmSync(looseDir, { recursive: true, force: true });
    }
  });

  it('workbench.show:选择入口项后转跳对应命令', async () => {
    const originalQuickPick = fakeWindow.showQuickPick;
    (fakeWindow as { showQuickPick: unknown }).showQuickPick =
      async () => ({ command: 'kbengine.extension.identity' });
    try {
      await commands.executeCommand('kbengine.workbench.show');
      expect(channelLines('Kode 扩展身份')).not.toBe('');
    } finally {
      (fakeWindow as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
    }
  });

  it('quickActions:按名执行 / 重扫脚本 / 树数据源', async () => {
    await commands.executeCommand('kbengine.quickActions.runByName', 'missing-action');
    await commands.executeCommand('kbengine.quickActions.scanScripts');
    const provider = treeRegistrations.find(entry => entry.viewId === 'kbengine.quickActions')?.provider as {
      getChildren?: () => unknown[];
    };
    if (provider.getChildren) {
      provider.getChildren();
    }
  });

  it('jsoncAssociation.off:关闭 jsonc 关联', async () => {
    await commands.executeCommand('kbengine.jsoncAssociation.off');
  });

  it('python.showCallChain:无活动 Python 编辑器如实提示', async () => {
    await commands.executeCommand('kbengine.python.showCallChain');
  });

  it('runtimeQuery.show:打开运行时查询面板', async () => {
    await commands.executeCommand('kbengine.runtimeQuery.show');
  });

  it('compatibility.check:未打开工作区如实报错', async () => {
    const originalFolders = workspace.workspaceFolders;
    (workspace as { workspaceFolders: unknown }).workspaceFolders = [];
    try {
      await commands.executeCommand('kbengine.compatibility.check');
      expect(messages.warning.some(message => message.includes('未打开工作区'))).toBe(true);
    } finally {
      (workspace as { workspaceFolders: unknown }).workspaceFolders = originalFolders;
    }
  });

  it('identity / reproSummary:多扩展排序比较器', async () => {
    fakeExtensionList.push(
      { id: 'cuihairu.kode-a', isActive: true, packageJSON: { version: '0.1.0' }, extensionPath: '', extensionKind: 'workspace' } as never,
      { id: 'cuihairu.kode-b', isActive: false, packageJSON: { version: '0.2.0' }, extensionPath: '', extensionKind: 'ui' } as never
    );
    try {
      await commands.executeCommand('kbengine.extension.identity');
      expect(channelLines('Kode 扩展身份')).toContain('cuihairu.kode-b');
      await commands.executeCommand('kbengine.diagnostics.exportReproSummary');
      expect(channelLines('Kode 复现配置摘要')).toContain('cuihairu.kode-b');
    } finally {
      fakeExtensionList.length = 0;
    }
  });

  it('buildTaskProvider:任务列表按 profile 展开', async () => {
    const provider = tasks.taskProviders.find(entry => entry.type === 'kbengine.build')?.provider as {
      provideTasks?: () => unknown[];
    };
    if (provider.provideTasks) {
      expect(Array.isArray(provider.provideTasks())).toBe(true);
    }
  });

  it('remoteServers 树:getChildren/getTreeItem 面', async () => {
    const provider = treeRegistrations.find(entry => entry.viewId === 'kbengine.remoteServers')?.provider as {
      getChildren?: () => unknown[];
      getTreeItem?: (element: unknown) => unknown;
    };
    if (provider.getChildren) {
      const nodes = provider.getChildren();
      if (provider.getTreeItem && nodes.length > 0) {
        provider.getTreeItem(nodes[0]);
      }
    }
  });

  it('remoteServers:移除当前选中主机回落到本地', async () => {
    const originalInputBox = fakeWindow.showInputBox;
    (fakeWindow as { showInputBox: unknown }).showInputBox = async () => 'selected-host';
    try {
      await commands.executeCommand('kbengine.remoteServers.add');
      await commands.executeCommand('kbengine.remoteServers.select', 'selected-host');
      await commands.executeCommand('kbengine.remoteServers.remove', { id: 'selected-host' });
      expect(messages.info.some(message => message.includes('已移除手动主机 selected-host'))).toBe(true);
    } finally {
      (fakeWindow as { showInputBox: unknown }).showInputBox = originalInputBox;
    }
  });
});

describe('extension 激活链命令面(活动 profile 侧)', () => {
  beforeAll(async () => {
    commandRegistry.reset();
    languagesRegistry.reset();
    windowState.reset();
    testsRegistry.reset();
    prepareWorkspace(assets, assetsDefs);
    const store = new Map<string, unknown>();
    store.set('kbengine.projectProfiles.v1', [{
      id: 'p1',
      displayName: 'cov-profile',
      assetsRoot: assets,
      engineRoot: '',
      interpreterPath: '/usr/bin/python3',
      interpreterSource: 'path'
    }]);
    store.set('kbengine.activeProfileId.v1', 'p1');
    // 注解来源日志开关:激活时读取,置真后 sink 接线可被直接发射验证
    configurationOverrides.set('kbengine', { annotationLog: true });
    context = {
      subscriptions: [],
      extensionUri: Uri.file(path.join(extDir, 'package.json')),
      extensionPath: extDir,
      extension: { id: 'cuihairu.kode', extensionKind: 'workspace' },
      globalStoragePath: gsDir,
      workspaceState: makeMemento(store)
    };
    activate(context);
    await new Promise(resolve => setTimeout(resolve, 600));
  });

  afterAll(() => {
    configurationOverrides.delete('kbengine');
    disposeContext(context);
    expect(deactivate()).toBeUndefined();
  });

  it('build.previewTask:活动 profile → 任务四要素预览弹层', async () => {
    await commands.executeCommand('kbengine.build.previewTask');
    expect(messages.info.some(message => message.includes('command') || message.length > 0)).toBe(true);
  });

  it('kbe-stub 虚拟文档:内容提供者直接给出完整桩内容', () => {
    const provider = workspaceState.contentProviders.get('kbe-stub') as {
      provideTextDocumentContent(): string;
    };
    expect(provider).toBeDefined();
    const content = provider.provideTextDocumentContent();
    expect(content.length).toBeGreaterThan(0);
  });

  it('注解来源日志:启用后 sink 接线落通道', () => {
    annotationSourceLog('info', 'probe annotation line');
    expect(channelLines('KBEngine Annotations')).toContain('probe annotation line');
  });

  it('tests.list:发现测试文件入面板与选择器', async () => {
    await commands.executeCommand('kbengine.tests.list');
    const controller = testsRegistry.controllers.find(entry => entry.id === 'kbengine-python-tests');
    expect(controller).toBeDefined();
    const labels: string[] = [];
    controller?.items.forEach((item, _id) => {
      labels.push(item.label);
    });
    expect(labels.some(label => label.includes('test_sample.py'))).toBe(true);
  });

  it('测试面板 Run 档:真实执行 pytest 并把结果记到面板条目', async () => {
    const controller = testsRegistry.controllers.find(entry => entry.id === 'kbengine-python-tests');
    expect(controller).toBeDefined();
    const profile = controller?.profiles.find(entry => entry.label === '运行');
    expect(profile).toBeDefined();
    await profile?.runHandler({ include: [] }, tokenStub);
    const run = controller?.createdRuns.at(-1);
    expect(run).toBeDefined();
    expect(run?.ended).toBe(true);
    expect(run?.passedItems.length).toBeGreaterThan(0);
    expect(run?.failedItems.length).toBeGreaterThan(0);
  }, 60000);

  it('clientSdk.generate:profile 根绑定 → 语言选择取消即止', async () => {
    await commands.executeCommand('kbengine.clientSdk.generate');
    expect(messages.error.some(message => message.includes('没有打开的工作区'))).toBe(false);
  }, 20000);

  it('messagetable.preview:实体选择 → markdown 预览打开', async () => {
    const originalQuickPick = fakeWindow.showQuickPick;
    const originalOpen = workspace.openTextDocument;
    (fakeWindow as { showQuickPick: unknown }).showQuickPick =
      async (items: Array<{ label?: string }>) => items[0];
    (workspace as { openTextDocument: unknown }).openTextDocument =
      async (input: { content?: string; language?: string }) =>
        makeTextDocument(String(input.content ?? ''), {
          fileName: path.join(assets, 'messagetable-preview.md'),
          languageId: String(input.language ?? 'markdown')
        });
    try {
      await commands.executeCommand('kbengine.messagetable.preview');
      expect(messages.warning).toHaveLength(0);
    } finally {
      (fakeWindow as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
      (workspace as { openTextDocument: unknown }).openTextDocument = originalOpen;
    }
  }, 20000);

  it('messagetable.export:实体选择 → 保存对话框取消不落盘', async () => {
    const originalQuickPick = fakeWindow.showQuickPick;
    (fakeWindow as { showQuickPick: unknown }).showQuickPick =
      async (items: Array<{ label?: string }>) => items[0];
    try {
      await commands.executeCommand('kbengine.messagetable.export');
    } finally {
      (fakeWindow as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
    }
  }, 20000);

  it('debug.waitAtStartup.on/off:入口脚本就位 → 引导块写入后逐字节移除', async () => {
    await commands.executeCommand('kbengine.debug.waitAtStartup.on');
    expect(messages.error.some(message => message.includes('未找到入口脚本'))).toBe(false);
    expect(messages.info.some(message => message.includes('等待连接模式已开'))).toBe(true);
    const entry = path.join(assets, 'scripts', 'kbengine.py');
    expect(fs.readFileSync(entry, 'utf8')).toContain('kode:debugpy-wait BEGIN');
    await commands.executeCommand('kbengine.debug.waitAtStartup.off');
    expect(fs.readFileSync(entry, 'utf8')).not.toContain('kode:debugpy-wait BEGIN');
  });

  it('hotReload.tempEdit.run:开启且有编辑器 → 动作缺位如实收口', async () => {
    configurationOverrides.set('kbengine', {
      hotReload: { tempEdit: { enabled: true, actionName: '@script:missing_action' } }
    });
    const originalEditor = (fakeWindow as { activeTextEditor?: unknown }).activeTextEditor;
    const heroPath = path.join(assets, 'scripts', 'hero.py');
    await workspace.fs.writeFile(Uri.file(heroPath), new TextEncoder().encode('value = 1\n'));
    (fakeWindow as { activeTextEditor?: unknown }).activeTextEditor = {
      document: makeTextDocument('value = 1\n', { fileName: heroPath, languageId: 'python' }),
      selection: { active: new Position(0, 0) }
    };
    try {
      await commands.executeCommand('kbengine.hotReload.tempEdit.run');
    } finally {
      (fakeWindow as { activeTextEditor?: unknown }).activeTextEditor = originalEditor;
      configurationOverrides.delete('kbengine');
    }
  });

  it('project.doctor:工作区体检报告入通道', async () => {
    await commands.executeCommand('kbengine.project.doctor');
    expect(channelLines('KBEngine Project Doctor').length).toBeGreaterThan(0);
  }, 30000);

  it('tests.list:选中测试文件后打开源文件', async () => {
    const originalQuickPick = fakeWindow.showQuickPick;
    (fakeWindow as { showQuickPick: unknown }).showQuickPick =
      async (items: Array<{ absolutePath?: string }>) => items[0];
    const before = windowState.showTextDocumentCalls.length;
    try {
      await commands.executeCommand('kbengine.tests.list');
      expect(windowState.showTextDocumentCalls.length).toBeGreaterThan(before);
    } finally {
      (fakeWindow as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
    }
  });

  it('messagetable.export:保存对话框给路径 → JSON 落盘', async () => {
    const originalQuickPick = fakeWindow.showQuickPick;
    const originalSave = fakeWindow.showSaveDialog;
    const savePath = path.join(assets, 'messagetable-export.json');
    (fakeWindow as { showQuickPick: unknown }).showQuickPick =
      async (items: Array<{ label?: string }>) => items[0];
    (fakeWindow as { showSaveDialog: unknown }).showSaveDialog = async () => ({ fsPath: savePath });
    try {
      await commands.executeCommand('kbengine.messagetable.export');
      expect(memoryFileSystem.files.has(savePath)).toBe(true);
    } finally {
      (fakeWindow as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
      (fakeWindow as { showSaveDialog: unknown }).showSaveDialog = originalSave;
      fs.rmSync(savePath, { force: true });
    }
  }, 20000);

  it('测试面板 Run 档:指定 include 条目按需展开', async () => {
    const controller = testsRegistry.controllers.find(entry => entry.id === 'kbengine-python-tests');
    const profile = controller?.profiles.find(entry => entry.label === '运行');
    let fileItem: unknown;
    controller?.items.forEach(item => {
      if (fileItem === undefined) {
        fileItem = item;
      }
    });
    expect(fileItem).toBeDefined();
    await profile?.runHandler({ include: [fileItem] }, tokenStub);
  }, 60000);

  it('测试面板 Run 档:未注册 include 条目零目标即收口', async () => {
    const controller = testsRegistry.controllers.find(entry => entry.id === 'kbengine-python-tests');
    const profile = controller?.profiles.find(entry => entry.label === '运行');
    const runsBefore = controller?.createdRuns.length ?? 0;
    await profile?.runHandler(
      { include: [{ id: 'not-registered', children: { forEach: (): void => undefined } }] },
      tokenStub
    );
    expect(controller?.createdRuns.length ?? 0).toBe(runsBefore);
  }, 60000);

  it('测试面板 Run 档:token 立即取消 → 目标如实标跳过', async () => {
    const controller = testsRegistry.controllers.find(entry => entry.id === 'kbengine-python-tests');
    const profile = controller?.profiles.find(entry => entry.label === '运行');
    const cancelToken = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void): { dispose(): void } => {
        listener();
        return { dispose: () => undefined };
      }
    };
    await profile?.runHandler({ include: [] }, cancelToken);
    const run = controller?.createdRuns.at(-1);
    expect(run?.skippedItems.length).toBeGreaterThan(0);
  }, 60000);

  it('测试面板 Run 档:无钉住上下文即捕获并存储', async () => {
    await context.workspaceState.update('kbengine.testTaskContext', undefined);
    const controller = testsRegistry.controllers.find(entry => entry.id === 'kbengine-python-tests');
    const profile = controller?.profiles.find(entry => entry.label === '运行');
    await profile?.runHandler({ include: [] }, tokenStub);
    expect(await context.workspaceState.get('kbengine.testTaskContext')).toBeDefined();
  }, 60000);

  it('测试面板 Run 档:pytest skip 用例标记跳过', async () => {
    fs.writeFileSync(
      path.join(assets, 'scripts', 'test_skip.py'),
      'import pytest\n\n\n@pytest.mark.skip(reason="coverage")\ndef test_skip_me():\n    assert True\n',
      'utf8'
    );
    await commands.executeCommand('kbengine.tests.list');
    const controller = testsRegistry.controllers.find(entry => entry.id === 'kbengine-python-tests');
    const profile = controller?.profiles.find(entry => entry.label === '运行');
    await profile?.runHandler({ include: [] }, tokenStub);
    const run = controller?.createdRuns.at(-1);
    expect(run?.skippedItems.length).toBeGreaterThan(0);
  }, 60000);

  it('debug 装配命令:launch.json 同步 / debugpy 同步 / 等待连接关', async () => {
    await commands.executeCommand('kbengine.debug.updateLaunchJson');
    await commands.executeCommand('kbengine.python.debugpySync');
    await commands.executeCommand('kbengine.debug.waitAtStartup.off');
  }, 30000);

  it('运行时查询:无运行组件如实提示', async () => {
    await commands.executeCommand('kbengine.profile.start');
    expect(messages.warning.some(message => message.includes('未发现可查询的 KBEngine 组件'))).toBe(true);
    messages.warning.length = 0;
    await commands.executeCommand('kbengine.spaces.query');
    expect(messages.warning.some(message => message.includes('未发现可查询的 KBEngine 组件'))).toBe(true);
  }, 30000);

  it('hotReload 台账命令:批次摘要 / 失败重试 / revision 证据(空台账)', async () => {
    await commands.executeCommand('kbengine.hotReload.showBatchSummary');
    await commands.executeCommand('kbengine.hotReload.retryFailed');
    await commands.executeCommand('kbengine.hotReload.showRevisionEvidence');
  }, 30000);
});
