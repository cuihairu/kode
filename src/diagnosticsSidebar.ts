import * as vscode from 'vscode';

export const DIAGNOSTICS_TOOLS_VIEW = 'kbengine.diagnosticsTools';
export const MEMORY_MONITOR_VIEW = 'kbengine.memoryMonitorView';
export const CALL_CHAIN_VIEW = 'kbengine.callChainView';
export const DIAGNOSTICS_SIDEBAR_CONTEXT = 'kode.diagnosticsSidebarSupported';

// The secondarySidebar contribution point first shipped in VS Code 1.106.
export function supportsDiagnosticsSidebar(): boolean {
  const [major, minor] = (vscode.version ?? '').split('.').map(Number);
  return (major > 1 || (major === 1 && minor >= 106)) &&
    typeof vscode.window.registerWebviewViewProvider === 'function';
}
