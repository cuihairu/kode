/**
 * KODE-MCP-HOST 纯核:内置 MCP 服务器定义装配(2026-11-13 用户令
 * 「内置 mcp,点击开启,默认开启」,推翻 2026-11-10「不托管」口径)。
 *
 * 扩展经 VS Code 原生 MCP 扩展 API(vscode.lm.registerMcpServerDefinitionProvider,
 * McpStdioServerDefinition,VS Code ≥1.101)把 kode-mcp 服务器定义**随扩展内建
 * 提供**:装上即在 MCP 服务器列表出现(默认开启),用户在原生 MCP UI 或点击
 * 状态栏项一键启停;运行时 feature-detect,引擎基线 1.82 不动——老 VS Code
 * 无此 API 时回落现状(仅状态栏二进制在位探测)。
 *
 * 纯核只做归约(vscode 面见 src/kodeMcpHost.ts):
 * - enabled=false 或二进制缺失 → 零定义(诚实:不提供跑不起来的服务器);
 * - 每工作区文件夹一服务器:command=kode-mcp 二进制、args=[assets 根]
 *   (kode-mcp CLI 契约:首参=资产根,docs/guide/kode-mcp-enablement.md);
 * - assets 根解析落空 → 该文件夹跳过(不硬造根);
 * - 同名文件夹(不同路径)label 加序号去重,顺序=文件夹序(确定性)。
 */

/** 单个内建 MCP 服务器定义(vscode 面经 McpStdioServerDefinition 构造)。 */
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
