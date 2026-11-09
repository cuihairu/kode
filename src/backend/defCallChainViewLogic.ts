/**
 * Call Chain 双 Tab 纯逻辑(docs/redesign.md 批157 用户第 4 号问题):
 * tab 解析/回落判定不碰 vscode DOM,供 webview 脚本(esbuild 直译)与
 * vitest 双方复用;面板装配面见 defCallChainProvider.ts。
 */

export type CallChainTab = 'graph' | 'text';

/** workspaceState 持久化键:tab 选择跟随工作区,重开面板回放 */
export const CALL_CHAIN_TAB_STATE_KEY = 'kbengine.defCallChain.activeTab';

/** 未知值(旧版本残留/手改配置)一律按未选处理 */
export function normalizeCallChainTab(value: unknown): CallChainTab | null {
  return value === 'graph' || value === 'text' ? value : null;
}

/**
 * 初始 tab 解析:持久化选择 > 配置 kbengine.python.callChainView > 默认 graph。
 * 用户本次会话切过的 tab 优先于配置默认,符合“工作区状态记忆”语义。
 */
export function resolveInitialCallChainTab(configView: unknown, storedTab: unknown): CallChainTab {
  return normalizeCallChainTab(storedTab) ?? normalizeCallChainTab(configView) ?? 'graph';
}

export interface CallChainRenderFailure {
  /** 渲染失败固定回落 Text */
  tab: 'text';
  /** 面板头说明(带原因,不吞错) */
  notice: string;
}

/** Graph 渲染失败(mermaid 抛错/语法不识别)→ 自动切 Text 并给出面板头说明 */
export function handleCallChainGraphRenderFailure(reason?: unknown): CallChainRenderFailure {
  const detail = reason instanceof Error
    ? reason.message
    : typeof reason === 'string' && reason.trim().length > 0
      ? reason.trim()
      : '';
  return {
    tab: 'text',
    notice: detail
      ? `Graph render failed (${detail}); showing text view instead.`
      : 'Graph render failed; showing text view instead.'
  };
}
