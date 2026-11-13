// KODE-MCP-HOST:内置 MCP 服务器定义装配(vscode 面;2026-11-13 用户令
// 「内置 mcp,点击开启,默认开启」)。
//
// - 经 VS Code 原生 MCP 扩展 API 注册 definition provider:MCP 服务器列表
//   随扩展内建出现,默认开启(kbengine.mcp.enabled 默认 true);
// - 运行时 feature-detect(vscode.lm.registerMcpServerDefinitionProvider /
//   vscode.McpStdioServerDefinition,VS Code ≥1.101 引入,引擎基线 1.82 的
//   @types 无此 API → 本地最小类型面 + 探测,老宿主静默不注册回落现状);
// - 状态栏 MCP 项点击 = kbengine.mcp.toggle(翻转 enabled);配置变化经
//   onDidChangeMcpServerDefinitions 通知宿主刷新列表。

import * as vscode from 'vscode';
import { buildKodeMcpServerSpecs } from './backend/kodeMcpDefinitions';
import { resolveAssetsRootForWorkspace } from './scanRoots';

/** 原生 MCP API 最小类型面(@types/vscode 1.82 尚无;形状按官方 sample 钉)。 */
interface McpLmApi {
  registerMcpServerDefinitionProvider?: (
    id: string,
    provider: {
      onDidChangeMcpServerDefinitions: vscode.Event<void>;
      provideMcpServerDefinitions: () => Promise<unknown[]>;
    }
  ) => vscode.Disposable;
}

interface McpStdioCtor {
  new (label: string, command: string, args?: string[], env?: Record<string, string>): unknown;
}

export const KODE_MCP_PROVIDER_ID = 'kodeMcpServers';
export const KODE_MCP_TOGGLE_COMMAND = 'kbengine.mcp.toggle';
export const KODE_MCP_ENABLED_SETTING = 'kbengine.mcp.enabled';

export interface KodeMcpHostDeps {
  /** kode-mcp 二进制路径;'' = 未构建/未发现 */
  probeMcpBinary: () => string;
}

/** 原生 MCP API 是否可用(feature-detect;引擎基线 1.82 的宿主无 lm 面)。 */
export function nativeMcpApiAvailable(): boolean {
  const lm = (vscode as unknown as { lm?: McpLmApi }).lm;
  const ctor = (vscode as unknown as { McpStdioServerDefinition?: McpStdioCtor })
    .McpStdioServerDefinition;
  return typeof lm?.registerMcpServerDefinitionProvider === 'function' && typeof ctor === 'function';
}

export function setupKodeMcpHost(
  context: vscode.ExtensionContext,
  deps: KodeMcpHostDeps
): void {
  if (!nativeMcpApiAvailable()) {
    // 老宿主:无原生 MCP API,不注册(状态栏回落二进制在位探测口径)。
    return;
  }
  const lm = (vscode as unknown as { lm: McpLmApi }).lm;
  const stdioCtor = (vscode as unknown as { McpStdioServerDefinition: McpStdioCtor })
    .McpStdioServerDefinition;

  const didChange = new vscode.EventEmitter<void>();

  const buildSpecs = (): ReturnType<typeof buildKodeMcpServerSpecs> =>
    buildKodeMcpServerSpecs({
      workspaceFolders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
      binaryPath: deps.probeMcpBinary(),
      enabled: vscode.workspace
        .getConfiguration('kbengine')
        .get<boolean>('mcp.enabled', true),
      resolveAssetsRoot: resolveAssetsRootForWorkspace
    });

  const registration = lm.registerMcpServerDefinitionProvider!(KODE_MCP_PROVIDER_ID, {
    onDidChangeMcpServerDefinitions: didChange.event,
    provideMcpServerDefinitions: async () =>
      buildSpecs().map(spec => new stdioCtor(spec.label, spec.command, spec.args))
  });

  // enabled 翻转(状态栏点击/设置页)→ 宿主刷新服务器列表。
  const configListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(KODE_MCP_ENABLED_SETTING)) {
      didChange.fire();
    }
  });
  context.subscriptions.push(registration, didChange, configListener);
}

/** 翻转 kbengine.mcp.enabled(全局;默认开启,点击即关/再开)。 */
export async function toggleKodeMcpEnabled(): Promise<void> {
  const config = vscode.workspace.getConfiguration('kbengine');
  const current = config.get<boolean>('mcp.enabled', true);
  await config.update(KODE_MCP_ENABLED_SETTING, !current, vscode.ConfigurationTarget.Global);
}
