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
  text: string;
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

function postTab(tab: CallChainTab): void {
  // acquireVsCodeApi may only be called once per lifetime; skip silently when the host is absent (tests)
  if (typeof window.acquireVsCodeApi === 'function') {
    window.acquireVsCodeApi().postMessage({ type: 'callChainTab', tab });
  }
}

async function activate(): Promise<void> {
  const payload = readPayload();
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
      postTab(target);
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
