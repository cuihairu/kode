/*
 * Call Chain webview 侧脚本(浏览器面,不进 tsc 主编译):
 * esbuild 以 --bundle 打包为离线单文件 IIFE,产 media/defCallChainViewer.js——
 * 不拆包、无 CDN、无运行时动态加载,离线包即时可用。
 *
 * mermaid 采用官方小体积发行版 @mermaid-js/tiny(≈全量一半):无 KaTeX/Mindmap/
 * Architecture/ELK/懒加载,flowchart 布局回落 dagre——正是调用链图需要的渲染面。
 * tiny 是纯 IIFE,以普通 <script> 语义加载后赋值 globalThis.mermaid,无 default
 * export——且其内部顶层 var 依赖全局脚本作用域,不能被 esbuild 再包一层 IIFE
 * (实测会 "Cannot read properties of undefined"),故入口不做 import,由构建脚本
 * 把 tiny dist 原样前置于打包产物(与官方 <script> 用法等价,仍单文件离线);
 * 类型沿用全量 mermaid 包的 .d.ts(仅 import type,不进包)。
 * 纯逻辑(tab 解析/回落判定)来自 ../defCallChainViewLogic,与 vitest 同源。
 */
import type mermaidType from 'mermaid';
import {
  handleCallChainGraphRenderFailure,
  normalizeCallChainTab,
  resolveInitialCallChainTab,
  type CallChainTab
} from '../defCallChainViewLogic';

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
    if (!mermaid) {
      throw new Error('mermaid tiny bundle did not publish globalThis.mermaid');
    }
    // tiny 构建不含 ELK,布局只有 dagre(默认);显式钉在 dagre 上走经典流程图布局。
    // 图内若显式请求 elk(如 init 指令),tiny 会静默回落 dagre,不抛错。
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
