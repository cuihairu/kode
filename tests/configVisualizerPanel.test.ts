// configVisualizerPanel:控制器行为(docs/design/config-visualization.md
// §5.4/§5.5/§6/§8,KODE-CFG-VIZ-001)。经契约门替身走真实
// ensureConfigResolved 缓存/失效路径;面板由 fake-vscode panelRegistry
// 默认工厂创建。断言面=六态分流(errorKind 只属两空态)、刷新 invalidate
// 强制重取、画代守卫弃置旧代回包、键详情懒取(文案库命中)、复制入剪贴板、
// 出处文件打开、面板销毁后静默弃置。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigVisualizerPanel } from '../src/configVisualizerPanel';
import { resetConfigResolveForTests } from '../src/serverConfigResolve';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { makeContractGate, type ContractGateCall } from './helpers/configCoreContract';
import {
  envState,
  memoryFileSystem,
  panelRegistry,
  windowState,
  workspace as stubWorkspace,
  workspaceState,
  type FakeWebviewPanel
} from './helpers/vscodeStub';
import { configurationOverrides } from './fake-vscode/workspaceState';

const DEFAULTS_XML = [
  '<root>',
  '  <baseapp>',
  '    <archivePeriod> 20 </archivePeriod>',
  '    <debugMode> 0 </debugMode>',
  '  </baseapp>',
  '</root>',
  ''
].join('\n');

const tmpRoots: string[] = [];
let defaultsPath = '';

/** 布真实 defaults 文件 + binPath 指向 <root>/kbe/bin/server;customXml 无来源 → defaultsOnly */
const installRealDefaults = (): void => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cfgviz-'));
  tmpRoots.push(root);
  const serverDir = path.join(root, 'kbe', 'res', 'server');
  fs.mkdirSync(serverDir, { recursive: true });
  defaultsPath = path.join(serverDir, 'kbengine_defaults.xml');
  fs.writeFileSync(defaultsPath, DEFAULTS_XML);
  configurationOverrides.set('kbengine', { binPath: path.join(root, 'kbe', 'bin', 'server') });
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
};

const contractCalls: ContractGateCall[] = [];

const resolveCalls = (): number =>
  contractCalls.filter(call => call.method === '$/kode/config/resolve').length;

const showPanel = async (): Promise<FakeWebviewPanel> => {
  const controller = new ConfigVisualizerPanel();
  await controller.show();
  return panelRegistry.panels[panelRegistry.panels.length - 1];
};

const until = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

/** postedMessages 入账形态是 {message} 包装,按 command 拆包过滤 */
const posted = (panel: FakeWebviewPanel, command: string): Array<Record<string, unknown>> =>
  panel.webview.postedMessages
    .map(entry => entry.message as Record<string, unknown>)
    .filter(message => message.command === command);

const send = (panel: FakeWebviewPanel, message: unknown): void => {
  panelRegistry.fireMessage(panel, message);
};

/** 受控门:每次 runInRust 挂起,返回放行器数组(用例手动按序放行) */
const deferredGate = (): { pending: Array<(value: unknown) => void> } => {
  const pending: Array<(value: unknown) => void> = [];
  setKodeCoreShadowGate({
    runInRust: async () =>
      new Promise(resolve => {
        pending.push(resolve);
      })
  } as never);
  return { pending };
};

const clipboardWrites: string[] = [];

beforeEach(() => {
  panelRegistry.reset();
  windowState.reset(); // language → 'zh-cn'
  workspaceState.reset();
  configurationOverrides.clear();
  stubWorkspace.workspaceFolders = [];
  resetConfigResolveForTests();
  contractCalls.length = 0;
  clipboardWrites.length = 0;
  setKodeCoreShadowGate(makeContractGate(contractCalls));
  (envState as { clipboard?: { writeText: (text: string) => Promise<void> } }).clipboard = {
    writeText: async (text: string) => {
      clipboardWrites.push(text);
    }
  };
});

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('六态分流(§8)', () => {
  it('ready:resolve 成功送达投影,defaultsOnly/路径/分组事实齐', async () => {
    installRealDefaults();
    const panel = await showPanel();
    expect(panel.viewType).toBe('kbengine.configVisualizer');
    expect(panel.title).toBe('配置合并可视化');

    send(panel, { command: 'ready' });
    await until(() => posted(panel, 'resolveState').length === 1);
    const message = posted(panel, 'resolveState')[0];
    expect(message.generation).toBe(1);
    const result = message.result as {
      ok: boolean;
      data?: {
        defaultsOnly: boolean;
        defaultsPath: string | null;
        groups: Array<{ id: string; sections: Array<{ id: string; keyCount: number; keys: Array<{ state: string }> }> }>;
      };
      errorKind?: string;
    };
    expect(result.ok).toBe(true);
    expect(result.data!.defaultsOnly).toBe(true);
    expect(result.data!.defaultsPath).toBe(defaultsPath);
    expect(result.data!.groups[0].sections[0].id).toBe('baseapp');
    expect(result.data!.groups[0].sections[0].keyCount).toBe(2);
    expect(
      result.data!.groups[0].sections[0].keys.every(key => key.state === 'defaults-only')
    ).toBe(true);
  });

  it('无工作区:errorKind=no-workspace,不触门', async () => {
    const panel = await showPanel();
    send(panel, { command: 'ready' });
    await until(() => posted(panel, 'resolveState').length === 1);
    const result = posted(panel, 'resolveState')[0].result as { ok: boolean; errorKind?: string };
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('no-workspace');
    expect(contractCalls).toHaveLength(0);
  });

  it('RPC 失败:error 态如实降级,不带空态 errorKind', async () => {
    installRealDefaults();
    setKodeCoreShadowGate({ runInRust: async () => ({ ok: false, reason: 'boom' }) } as never);
    const panel = await showPanel();
    send(panel, { command: 'ready' });
    await until(() => posted(panel, 'resolveState').length === 1);
    const result = posted(panel, 'resolveState')[0].result as {
      ok: boolean;
      error?: string;
      errorKind?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
    expect(result.errorKind).toBeUndefined();
  });

  it('core ok 但树缺失:errorKind=no-config,不伪造三态', async () => {
    installRealDefaults();
    setKodeCoreShadowGate({ runInRust: async () => ({ ok: true, result: {} }) } as never);
    const panel = await showPanel();
    send(panel, { command: 'ready' });
    await until(() => posted(panel, 'resolveState').length === 1);
    const result = posted(panel, 'resolveState')[0].result as { ok: boolean; errorKind?: string };
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('no-config');
  });
});

describe('刷新与画代守卫(§5.5)', () => {
  it('refresh:invalidate 后强制重取(resolve 门调用数前进)', async () => {
    installRealDefaults();
    const panel = await showPanel();
    send(panel, { command: 'ready' });
    await until(() => posted(panel, 'resolveState').length === 1);
    expect(resolveCalls()).toBe(1);

    send(panel, { command: 'refresh' });
    await until(() => posted(panel, 'resolveState').length === 2);
    expect(resolveCalls()).toBe(2);
    expect(posted(panel, 'resolveState')[1].generation).toBe(2);
  });

  it('画代守卫:旧代回包被换代即弃置,只落最新代', async () => {
    installRealDefaults();
    const { pending } = deferredGate();
    const panel = await showPanel();
    send(panel, { command: 'ready' }); // 代 1
    send(panel, { command: 'refresh' }); // 代 2(换代)
    expect(pending).toHaveLength(2);

    pending[0]({ ok: true, result: {} });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(posted(panel, 'resolveState')).toHaveLength(0); // 旧代弃置

    pending[1]({ ok: true, result: {} });
    await until(() => posted(panel, 'resolveState').length === 1);
    expect(posted(panel, 'resolveState')[0].generation).toBe(2);
  });

  it('面板销毁后回包静默弃置;dispose 幂等', async () => {
    installRealDefaults();
    const { pending } = deferredGate();
    const controller = new ConfigVisualizerPanel();
    await controller.show();
    const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
    send(panel, { command: 'ready' });
    panelRegistry.fireDispose(panel);
    expect(pending).toHaveLength(1);
    pending[0]({ ok: true, result: {} });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(posted(panel, 'resolveState')).toHaveLength(0);
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe('键详情/复制/出处(§6 出站)', () => {
  it('selectKey 装配详情(文案库命中);copyFragment 入剪贴板;openSource 打开 defaults,custom 缺失不动作', async () => {
    installRealDefaults();
    const panel = await showPanel();
    send(panel, { command: 'ready' });
    await until(() => posted(panel, 'resolveState').length === 1);

    send(panel, { command: 'selectKey', sectionId: 'baseapp', path: 'archivePeriod' });
    await until(() => posted(panel, 'keyDetail').length === 1);
    const result = posted(panel, 'keyDetail')[0].result as {
      ok: boolean;
      data?: { catalogSource: string; finalValue: string; fragmentXml: string };
    };
    expect(result.ok).toBe(true);
    expect(result.data!.catalogSource).toBe('kbe/res/server/kbengine_defaults.xml:618');
    expect(result.data!.finalValue).toBe('20');

    send(panel, { command: 'copyFragment', sectionId: 'baseapp', path: 'archivePeriod' });
    await until(() => posted(panel, 'copyDone').length === 1);
    expect((posted(panel, 'copyDone')[0].result as { ok: boolean }).ok).toBe(true);
    expect(clipboardWrites[0]).toContain('<archivePeriod> 20 </archivePeriod>');

    send(panel, { command: 'openSource', file: 'defaults' });
    await until(() => workspaceState.openTextDocumentCalls.length === 1);
    send(panel, { command: 'openSource', file: 'custom' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(workspaceState.openTextDocumentCalls).toHaveLength(1);
  });
});
