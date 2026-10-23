import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CallChainController } from '../src/defCallChainProvider';
import {
  CALL_CHAIN_TAB_STATE_KEY,
  handleCallChainGraphRenderFailure,
  normalizeCallChainTab,
  resolveInitialCallChainTab
} from '../src/defCallChainViewLogic';
import { EntityMappingManager } from '../src/entityMapping';
import {
  configurationOverrides,
  panelRegistry,
  Uri,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import * as vscode from 'vscode';

const repoRoot = join(__dirname, '..');

const makeManager = (): EntityMappingManager => {
  const manager = new EntityMappingManager({ subscriptions: [] });
  const index = {
    rootName: 'Hero',
    rootCategory: 'entity',
    rootDefFile: join('/tmp/project', 'scripts', 'entity_defs', 'Hero.def'),
    semantics: {},
    propertyDefinitions: [],
    methodDefinitions: [{
      defFile: join('/tmp/project', 'scripts', 'entity_defs', 'Hero.def'),
      line: 2,
      section: 'BaseMethods',
      exposed: false,
      owner: { kind: 'entity', name: 'Hero', filePath: join('/tmp/project', 'scripts', 'entity_defs', 'Hero.def'), line: 1 },
      declaredArgs: ['UINT32'],
      identity: {
        ownerKind: 'entity', ownerName: 'Hero', sourceKind: 'local',
        sourceChain: ['Hero'], section: 'BaseMethods', symbolName: 'start'
      }
    }],
    pythonOwnerFiles: [],
    pythonMethods: []
  };
  return new Proxy(manager, {
    get(target, property, receiver) {
      if (property === 'getIndexForPythonFile') return () => index;
      if (property === 'waitForInitialScan') return async () => undefined;
      return Reflect.get(target, property, receiver);
    }
  });
};

/** 内存 Memento 替身:模拟 VS Code workspaceState 持久化 */
class FakeMemento {
  readonly store = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }
}

const controllers: CallChainController[] = [];

afterEach(() => {
  controllers.splice(0).forEach(controller => controller.dispose());
  configurationOverrides.delete('kbengine.python');
  panelRegistry.reset();
});

const makeController = (context: ConstructorParameters<typeof CallChainController>[1] = {}) => {
  const controller = new CallChainController(makeManager(), context);
  controllers.push(controller);
  return controller;
};

const showChain = async (controller: CallChainController) => {
  await controller.showForActiveEditor(Uri.file('/tmp/project/scripts/base/Hero.py'), 2, 'start');
  return panelRegistry.panels[0];
};

describe('call chain view logic (tab resolution / fallback)', () => {
  it('defaults to the graph tab when nothing is configured or stored', () => {
    expect(resolveInitialCallChainTab(undefined, undefined)).toBe('graph');
    expect(resolveInitialCallChainTab(null, null)).toBe('graph');
  });

  it('prefers the stored workspace tab over the configured view', () => {
    expect(resolveInitialCallChainTab('graph', 'text')).toBe('text');
    expect(resolveInitialCallChainTab('text', 'graph')).toBe('graph');
  });

  it('falls back to the configured view when nothing is stored', () => {
    expect(resolveInitialCallChainTab('text', null)).toBe('text');
    expect(resolveInitialCallChainTab('graph', 'bogus')).toBe('graph');
  });

  it('normalizes unknown tab values to null', () => {
    expect(normalizeCallChainTab('graph')).toBe('graph');
    expect(normalizeCallChainTab('text')).toBe('text');
    expect(normalizeCallChainTab('diagram')).toBeNull();
    expect(normalizeCallChainTab(42)).toBeNull();
  });

  it('maps render failures to the text tab with a header notice', () => {
    expect(handleCallChainGraphRenderFailure()).toEqual({
      tab: 'text',
      notice: 'Graph render failed; showing text view instead.'
    });
    expect(handleCallChainGraphRenderFailure(new Error('Parse error'))).toEqual({
      tab: 'text',
      notice: 'Graph render failed (Parse error); showing text view instead.'
    });
  });
});

describe('call chain webview tabs (graph default / text fallback config)', () => {
  it('defaults to the graph tab with the bundled viewer and a strict CSP', async () => {
    const panel = await showChain(makeController());
    const html = panel.webview.html;

    expect(/data-call-chain-tab="graph"[^>]*aria-selected="true"/.test(html)).toBe(true);
    expect(/data-call-chain-tab="text"[^>]*aria-selected="false"/.test(html)).toBe(true);
    expect(html).toContain('data-call-chain-pane="graph"');
    expect(html).toContain('data-call-chain-pane="text"');
    // 资产:打包后的本地 viewer(media/defCallChainViewer.js),非 CDN
    expect(html).toContain('src="media/defCallChainViewer.js"');
    expect(html).not.toMatch(/https?:\/\/(cdn|unpkg|jsdelivr)/);
    // CSP:脚本只认扩展 bundle + nonce,default-src 'none'
    expect(html).toContain("default-src 'none'");
    const nonce = /script-src vscode-webview: 'nonce-([0-9a-f]+)'/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}" src="media/defCallChainViewer.js">`);
    expect(panel.options).toMatchObject({ enableScripts: true });
  });

  it('uses the text tab when kbengine.python.callChainView is text', async () => {
    configurationOverrides.set('kbengine.python', { callChainView: 'text' });
    const panel = await showChain(makeController());
    const html = panel.webview.html;

    expect(/data-call-chain-tab="text"[^>]*aria-selected="true"/.test(html)).toBe(true);
    expect(/data-call-chain-pane="text"[^>]*hidden/.test(html)).toBe(false);
    expect(/data-call-chain-pane="graph"[^>]*hidden/.test(html)).toBe(true);
  });

  it('renders node signatures in the text pane and the mermaid source for the graph pane', async () => {
    const panel = await showChain(makeController());
    const html = panel.webview.html;

    expect(html).toContain('BaseMethods.start(UINT32)');
    expect(decodeURIComponent(
      /data-mermaid="([^"]+)/.exec(html)?.[1] ?? ''
    )).toContain('flowchart TD');
    // payload 供打包脚本消费
    const payload = JSON.parse(
      /<script type="application\/json" id="call-chain-payload"[^>]*>([^<]+)<\/script>/.exec(html)?.[1] ?? '{}'
    ) as { mermaid: string; configView: string; storedTab: string };
    expect(payload.mermaid).toContain('flowchart TD');
    expect(payload.configView).toBe('graph');
    expect(payload.storedTab).toBe('graph');
  });
});

describe('call chain tab persistence (workspace state)', () => {
  it('stores a webview tab switch into workspace state', async () => {
    const memento = new FakeMemento();
    const panel = await showChain(makeController({ workspaceState: memento as never }));

    panelRegistry.fireMessage(panel, { type: 'callChainTab', tab: 'text' });
    expect(memento.store.get(CALL_CHAIN_TAB_STATE_KEY)).toBe('text');

    panelRegistry.fireMessage(panel, { type: 'callChainTab', tab: 'graph' });
    expect(memento.store.get(CALL_CHAIN_TAB_STATE_KEY)).toBe('graph');
  });

  it('ignores unknown tab values in webview messages', async () => {
    const memento = new FakeMemento();
    const panel = await showChain(makeController({ workspaceState: memento as never }));

    panelRegistry.fireMessage(panel, { type: 'callChainTab', tab: 'diagram' });
    expect(memento.store.has(CALL_CHAIN_TAB_STATE_KEY)).toBe(false);
  });

  it('replays the stored tab as the initial one on the next render', async () => {
    const memento = new FakeMemento();
    await memento.update(CALL_CHAIN_TAB_STATE_KEY, 'text');
    const controller = makeController({ workspaceState: memento as never });
    const panel = await showChain(controller);
    const html = panel.webview.html;

    expect(/data-call-chain-tab="text"[^>]*aria-selected="true"/.test(html)).toBe(true);
    // 回放的 storedTab 一并喂给 webview 脚本
    const payload = JSON.parse(
      /<script type="application\/json" id="call-chain-payload"[^>]*>([^<]+)<\/script>/.exec(html)?.[1] ?? '{}'
    ) as { storedTab: string };
    expect(payload.storedTab).toBe('text');
  });

  it('declares the bundled media directory as a local resource root', async () => {
    const panel = await showChain(makeController({
      extensionUri: vscode.Uri.file('/ext/root'),
      workspaceState: new FakeMemento() as never
    }));
    const options = panel.options as { localResourceRoots?: Array<{ fsPath: string }> };
    expect(options.localResourceRoots?.[0]?.fsPath).toBe('/ext/root/media');
  });
});

describe('call chain webview asset lock (bundled mermaid, no CDN)', () => {
  const bundlePath = join(repoRoot, 'media', 'defCallChainViewer.js');

  it('ships the mermaid bundle as a local file (asset existence lock)', () => {
    const stat = statSync(bundlePath);
    // mermaid 打包体足够大;缺失或被打薄(如误改为 CDN 动态加载)即失败
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(2 * 1024 * 1024);
  });

  it('bundle contains mermaid and the offline render fallback, never a CDN loader', () => {
    const bundle = readFileSync(bundlePath, 'utf8');
    expect(bundle).toContain('mermaid');
    // 渲染失败回落 Text 的面板头说明字符串随包发出(回落链路在包内自洽)
    expect(bundle).toContain('Graph render failed');
    expect(bundle).toContain('callChainTab');
    expect(bundle).not.toMatch(/https?:\/\/(cdn\.jsdelivr\.org|unpkg\.com|cdnjs\.cloudflare\.com)/);
  });

  it('viewer source routes failures through the shared render-failure logic', () => {
    const viewer = readFileSync(join(repoRoot, 'src', 'webview', 'defCallChainViewer.ts'), 'utf8');
    expect(viewer).toContain('handleCallChainGraphRenderFailure');
    // mermaid 采用官方 @mermaid-js/tiny IIFE(构建脚本原样前置,普通 <script> 语义,
    // 赋 globalThis.mermaid);入口只允许 import type,不得在运行时 import mermaid
    expect(viewer).toContain("import type mermaidType from 'mermaid'");
    expect(viewer).toContain('globalThis');
    expect(viewer).not.toMatch(/^import (?!type).*mermaid/m);
    // 禁 CDN:不得出现任何运行时远程脚本注入
    expect(viewer).not.toMatch(/createElement\('script'\)/);
  });

  it('packaging keeps the bundle: media stays in the extension package', () => {
    const ignored = readFileSync(join(repoRoot, '.vscodeignore'), 'utf8');
    expect(ignored).not.toMatch(/^media\/?$/m);
    expect(ignored).not.toMatch(/^media\/\*\*$/m);
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['bundle:webview']).toContain('media/defCallChainViewer.js');
    expect(pkg.scripts.bundle).toContain('bundle:webview');
  });
});
