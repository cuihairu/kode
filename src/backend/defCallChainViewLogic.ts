/**
 * Pure logic for the Call Chain dual tabs (docs/redesign.md batch 157, user
 * question #4): tab resolution/fallback decisions never touch the vscode DOM,
 * so both the webview script (translated verbatim by esbuild) and vitest can
 * reuse them. For the panel assembly surface see defCallChainProvider.ts.
 */

export type CallChainTab = 'graph' | 'text';

/** workspaceState persistence key: the tab choice follows the workspace and is replayed when the panel is reopened */
export const CALL_CHAIN_TAB_STATE_KEY = 'kbengine.defCallChain.activeTab';

/** Unknown values (leftovers from older versions / hand-edited config) are always treated as unselected */
export function normalizeCallChainTab(value: unknown): CallChainTab | null {
  return value === 'graph' || value === 'text' ? value : null;
}

/**
 * Initial tab resolution: persisted choice > config kbengine.python.callChainView
 * > default graph. The tab the user switched to this session takes priority over
 * the config default, matching the "workspace state memory" semantics.
 */
export function resolveInitialCallChainTab(configView: unknown, storedTab: unknown): CallChainTab {
  return normalizeCallChainTab(storedTab) ?? normalizeCallChainTab(configView) ?? 'graph';
}

export interface CallChainRenderFailure {
  /** On render failure, always fall back to Text */
  tab: 'text';
  /** Panel-header notice (carries the reason; the error is not swallowed) */
  notice: string;
}

/** Graph render failure (mermaid throws / syntax not recognized) -> switch to Text automatically and surface a panel-header notice */
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
