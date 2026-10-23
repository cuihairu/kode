/*
 * Call Chain webview 侧脚本(浏览器面,不进 tsc 主编译):
 * esbuild 以 --bundle 打包 mermaid(npm 依赖)为单文件 IIFE,产
 * media/defCallChainViewer.js——离线可用,禁止任何 CDN 加载。
 * 纯逻辑(tab 解析/回落判定)来自 ../defCallChainViewLogic,与 vitest 同源。
 */
import mermaid from 'mermaid';
import {
  handleCallChainGraphRenderFailure,
  normalizeCallChainTab,
  resolveInitialCallChainTab,
  type CallChainTab
} from '../defCallChainViewLogic';

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
  // acquireVsCodeApi 全生命周期只可调用一次;测试宿主缺失时静默跳过
  if (typeof window.acquireVsCodeApi === 'function') {
    window.acquireVsCodeApi().postMessage({ type: 'callChainTab', tab });
  }
}

async function activate(): Promise<void> {
  const payload = readPayload();
  let tab = resolveInitialCallChainTab(payload.configView, payload.storedTab);

  const graphPane = document.querySelector<HTMLElement>('[data-call-chain-pane="graph"]');
  try {
    // mermaid@12 全局默认 layout 是 "elk"(elk.js 已从离线包裁剪),显式钉在
    // dagre 上走经典流程图布局;若未来显式请求 elk 会抛 stub 诊断错误并回落 Text
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', layout: 'dagre' });
    const { svg } = await mermaid.render('kbengine-call-chain-graph', payload.mermaid);
    if (graphPane) {
      graphPane.innerHTML = svg;
    }
  } catch (reason) {
    // 渲染失败自动回落 Text,面板头说明原因
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
