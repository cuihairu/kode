/*
 * Call Chain viewer script on the webview (browser) side, outside the main
 * tsc compile: esbuild bundles it with --bundle into the offline single-file
 * IIFE media/defCallChainViewer.js — no code splitting, no CDN, no runtime
 * dynamic loading, so the offline bundle is immediately usable.
 *
 * mermaid uses the official small @mermaid-js/tiny distribution (about half
 * the full build): no KaTeX/Mindmap/Architecture/ELK/lazy loading, and
 * flowchart layout falls back to dagre — exactly the rendering surface a
 * call-chain graph needs.
 * tiny is a plain IIFE: loaded with ordinary <script> semantics it assigns
 * globalThis.mermaid and has no default export — and its internal top-level
 * var relies on global script scope, so it must not be wrapped in another
 * IIFE by esbuild (measured to fail with
 * "Cannot read properties of undefined"). Hence the entry point does no
 * import; the build script prepends the tiny dist verbatim to the bundle
 * (equivalent to the official <script> usage, still one offline file).
 * Types reuse the full mermaid package .d.ts (import type only, not bundled).
 * The pure logic (tab parsing / fallback decision) comes from
 * ../defCallChainViewLogic and is shared with vitest.
 */
import type mermaidType from 'mermaid';
import {
  handleCallChainGraphRenderFailure,
  normalizeCallChainTab,
  resolveInitialCallChainTab,
  type CallChainTab
} from '../backend/defCallChainViewLogic';

const mermaid = (globalThis as { mermaid?: typeof mermaidType }).mermaid;

interface CallChainPayload {
  mermaid: string;
  version: number;
  sourceNodes?: number[];
  sourceAction: string;
  configView: string | null;
  storedTab: string | null;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

function readPayload(): CallChainPayload {
  const element = document.getElementById('call-chain-payload');
  if (!element || !element.textContent) {
    throw new Error('call chain payload is missing');
  }
  return JSON.parse(element.textContent) as CallChainPayload;
}

function selectTab(tab: CallChainTab): void {
  for (const tabButton of document.querySelectorAll<HTMLButtonElement>('[data-call-chain-tab]')) {
    tabButton.setAttribute('aria-selected', tabButton.dataset.callChainTab === tab ? 'true' : 'false');
  }
  for (const pane of document.querySelectorAll<HTMLElement>('[data-call-chain-pane]')) {
    pane.hidden = pane.dataset.callChainPane !== tab;
  }
}

function showNotice(notice: string): void {
  const element = document.getElementById('call-chain-notice');
  if (element) {
    element.textContent = notice;
    element.hidden = false;
  }
}

async function activate(): Promise<void> {
  const payload = readPayload();
  const api = window.acquireVsCodeApi?.();
  const openSource = (node: number | 'origin') => {
    api?.postMessage({ type: 'callChainSource', version: payload.version, node });
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-source-node]')) {
    const node = button.dataset.sourceNode;
    button.addEventListener('click', () => openSource(node === 'origin' ? node : Number(node)));
  }

  let tab = resolveInitialCallChainTab(payload.configView, payload.storedTab);

  const graphPane = document.querySelector<HTMLElement>('[data-call-chain-pane="graph"]');
  try {
    if (!mermaid) {
      throw new Error('mermaid tiny bundle did not publish globalThis.mermaid');
    }
    // The tiny build has no ELK, so the only layout is dagre (the default); pin
    // it explicitly to get the classic flowchart layout. If a diagram asks for
    // elk outright (e.g. an init directive), tiny silently falls back to dagre
    // without throwing.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', layout: 'dagre' });
    const { svg } = await mermaid.render('kbengine-call-chain-graph', payload.mermaid);
    if (graphPane) {
      graphPane.innerHTML = svg;
      for (const index of payload.sourceNodes ?? []) {
        const node = graphPane.querySelector<SVGGElement>(`g.node.call-chain-target-${index}`);
        if (!node) {
          continue;
        }
        node.classList.add('call-chain-source-node');
        node.setAttribute('role', 'button');
        node.setAttribute('tabindex', '0');
        node.setAttribute('aria-label', `${payload.sourceAction} ${node.querySelector('.nodeLabel')?.textContent ?? ''}`);
        node.addEventListener('click', () => openSource(index));
        node.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openSource(index);
          }
        });
      }
    }
  } catch (reason) {
    // On render failure fall back to Text and let the pane header explain why
    const failure = handleCallChainGraphRenderFailure(reason);
    tab = failure.tab;
    showNotice(failure.notice);
  }

  selectTab(tab);

  for (const tabButton of document.querySelectorAll<HTMLButtonElement>('[data-call-chain-tab]')) {
    tabButton.addEventListener('click', () => {
      const target = normalizeCallChainTab(tabButton.dataset.callChainTab);
      if (!target) {
        return;
      }
      selectTab(target);
      api?.postMessage({ type: 'callChainTab', tab: target });
    });
  }

  window.addEventListener('message', event => {
    const message = event.data as { type?: string; tab?: unknown };
    if (message?.type === 'callChainTab') {
      const target = normalizeCallChainTab(message.tab);
      if (target) {
        selectTab(target);
      }
    }
  });
}

void activate();
