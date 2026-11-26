/**
 * KODE-MCP-HOST pure core: assembling the built-in MCP server definitions (user order
 * 2026-11-13 "built-in mcp, enabled by a click, on by default", overturning the 2026-11-10
 * "not hosted" accounting).
 *
 * The extension uses the VS Code native MCP extension API
 * (vscode.lm.registerMcpServerDefinitionProvider, McpStdioServerDefinition, VS Code >=1.101)
 * to **ship the kode-mcp server definitions built into the extension**: once installed they
 * appear in the MCP server list (on by default), and the user toggles them on/off either in
 * the native MCP UI or with one click on the status-bar item; the API is feature-detected at
 * runtime, leaving the 1.82 engine baseline untouched -- an older VS Code without this API
 * falls back to the status quo (only the status-bar binary presence probe).
 *
 * The pure core only reduces (the vscode face is in src/kodeMcpHost.ts):
 * - enabled=false or a missing binary -> zero definitions (honest: do not offer a server that
 *   cannot run);
 * - one server per workspace folder: command=the kode-mcp binary, args=[the assets root]
 *   (the kode-mcp CLI contract: the first argument = the asset root,
 *   docs/guide/kode-mcp-enablement.md);
 * - an assets-root resolution that comes up empty -> that folder is skipped (never fabricate a
 *   root);
 * - folders with the same name (different paths) get a sequence number appended to the label to
 *   dedupe, in folder order (deterministic).
 */

/** A single built-in MCP server definition (the vscode face constructs it via McpStdioServerDefinition). */
export interface KodeMcpServerSpec {
  label: string;
  command: string;
  args: string[];
}

export function buildKodeMcpServerSpecs(input: {
  workspaceFolders: string[];
  binaryPath: string;
  enabled: boolean;
  resolveAssetsRoot: (workspaceRoot: string) => string;
}): KodeMcpServerSpec[] {
  if (!input.enabled || input.binaryPath === '') {
    return [];
  }
  const specs: KodeMcpServerSpec[] = [];
  const labelSeen = new Map<string, number>();
  for (const folder of input.workspaceFolders) {
    const assetsRoot = input.resolveAssetsRoot(folder);
    if (!assetsRoot) {
      continue;
    }
    const base = folder.split('/').pop() || folder;
    const seen = labelSeen.get(base) ?? 0;
    labelSeen.set(base, seen + 1);
    const label = seen === 0 ? `Kode MCP: ${base}` : `Kode MCP: ${base} (${seen + 1})`;
    specs.push({ label, command: input.binaryPath, args: [assetsRoot] });
  }
  return specs;
}
