// AI-005 architecture framework analysis (analyzeArchitecture): feeds the Rust
// engine's structured summary ($/kode/dependency/graph existing data surface —
// dependency graph / inheritance / has-a, not the full source) to the LLM to
// produce a narrative architecture report (Markdown, read-only virtual scheme
// preview panel). The data source of truth is in the engine; the LLM only
// summarizes; both the prompt and the report explicitly state the truncation
// strategy (engineering beyond the budget is truncated by budget, never
// silently). Zero disk footprint: the report rides on a read-only virtual
// document; the command does not appear when the AI surface is unconfigured
// (lazy registration criterion same as AI-001, plus a handler-side second gate
// against the configuration being cleared after registration).
import * as vscode from 'vscode';
import { AI_API_KEY_SECRET, AiSecretsStore, isAiFaceAvailable, sendAiMessage } from './aiClient';
import type { DependencyGraphRust } from '../backend/dependencyGraphRust';

export const AI_ANALYZE_ARCHITECTURE_COMMAND = 'kbengine.ai.analyzeArchitecture';
const ARCH_SCHEME = 'kbengine-ai-architecture';

/** Digest budget (characters): truncation on overrun; the prompt and report both declare it explicitly, never silently */
export const ARCHITECTURE_DIGEST_BUDGET = 12000;

export interface ArchitectureDigest {
  digest: string;
  truncated: boolean;
}

export interface ArchitectureDeps {
  buildGraph: (root: string) => Promise<DependencyGraphRust | null>;
}

/**
 * Dependency graph → structured digest text (count lines + entity list +
 * per-kind edge samples). Hard truncation on over-budget with truncated=true —
 * this text is what is fed to the LLM; the source is not allowed to sprawl.
 */
export function summarizeDependencyGraph(
  graph: DependencyGraphRust,
  budget: number = ARCHITECTURE_DIGEST_BUDGET
): ArchitectureDigest {
  const lines: string[] = [];
  const stats = graph.stats;
  lines.push(
    `Graph stats: ${stats.nodeCount} nodes (${stats.entityCount} entities, ${stats.defCount} defs, ` +
    `${stats.interfaceCount} interfaces, ${stats.componentCount} components, ${stats.typeCount} types, ` +
    `${stats.pythonCount} python), ${stats.edgeCount} edges.`
  );
  const entities = graph.nodes.filter(node => node.kind === 'entity').map(node => node.name);
  lines.push(`Entities (${entities.length}): ${entities.join(', ')}`);
  const byKind = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = byKind.get(edge.kind) ?? [];
    if (list.length < 60) {
      list.push(edge.label ? `${edge.from} -[${edge.label}]-> ${edge.to}` : `${edge.from} -[${edge.kind}]-> ${edge.to}`);
    }
    byKind.set(edge.kind, list);
  }
  for (const [kind, samples] of [...byKind.entries()].sort()) {
    lines.push(`Edges ${kind} (first ${samples.length}): ${samples.join('; ')}`);
  }
  let digest = lines.join('\n');
  let truncated = false;
  if (digest.length > budget) {
    digest = `${digest.slice(0, budget)}\n...[truncated]`;
    truncated = true;
  }
  return { digest, truncated };
}

function renderArchitecturePrompt(digest: string, truncated: boolean): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        '你是 KBEngine 插件的架构分析助手。下面是引擎实体依赖图的结构化摘要(节点/边数据来自 Rust 分析面)。' +
        '请写一份简短的中文 Markdown 架构报告:实体组织方式、继承/组合关系、值得注意的结构特征。' +
        '数据真源在引擎,你只做总结——不要编造摘要之外的关系,关系模糊就说不确定。' +
        (truncated ? '注意:摘要因超出预算被截断,报告中必须说明这一点。\n' : '\n') +
        '输出 Markdown 正文(不要围栏包裹整份报告)。'
    },
    { role: 'user', content: digest }
  ];
}

let lastReport = '';
let archProvider: vscode.Disposable | null = null;

/** Read-only virtual document for the report (scheme registered lazily, contents refreshed per analysis) */
function ensureArchProvider(context: vscode.ExtensionContext): vscode.Uri {
  if (!archProvider) {
    archProvider = vscode.workspace.registerTextDocumentContentProvider(ARCH_SCHEME, {
      provideTextDocumentContent(): string {
        return lastReport;
      }
    });
    context.subscriptions.push(archProvider);
  }
  return vscode.Uri.parse(`${ARCH_SCHEME}:architecture-report.md`);
}

/**
 * Register the AI-005 analysis surface (called inside the lazy AI block): the
 * analyzeArchitecture command. Zero disk footprint for the report (read-only
 * virtual scheme); the deps injection surface lets tests replace buildGraph.
 */
export function registerAiArchitecture(
  context: vscode.ExtensionContext,
  secrets: AiSecretsStore,
  deps?: Partial<ArchitectureDeps>
): vscode.Disposable {
  const buildGraph = deps?.buildGraph ?? (async (root: string): Promise<DependencyGraphRust | null> => {
    const { buildDependencyGraphInRust } = await import('../backend/dependencyGraphRust');
    return buildDependencyGraphInRust(root);
  });
  const disposable = vscode.commands.registerCommand(AI_ANALYZE_ARCHITECTURE_COMMAND, () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      void vscode.window.showInformationMessage('没有打开的工作区,无架构可分析');
      return;
    }
    void (async (): Promise<void> => {
      if (!(await isAiFaceAvailable())) {
        void vscode.window.showErrorMessage('AI 面未配置:设置 kbengine.ai.baseUrl(OpenAI 兼容端点)或宿主提供语言模型后可用');
        return;
      }
      const graph = await buildGraph(root);
      if (!graph) {
        void vscode.window.showInformationMessage('依赖图不可用(工作区没有可分析的 def 布局)');
        return;
      }
      const { digest, truncated } = summarizeDependencyGraph(graph);
      let apiKey: string | null = null;
      try {
        apiKey = (await secrets.get(AI_API_KEY_SECRET)) ?? null;
      } catch {
        apiKey = null;
      }
      let reply: string;
      try {
        reply = await sendAiMessage({ messages: renderArchitecturePrompt(digest, truncated), apiKey });
      } catch (error) {
        void vscode.window.showErrorMessage(`AI 架构分析失败: ${(error as Error).message}`);
        return;
      }
      lastReport = reply;
      const uri = ensureArchProvider(context);
      await vscode.commands.executeCommand('markdown.showPreview', uri, { preserveFocus: true });
    })();
  });
  context.subscriptions.push(disposable);
  return disposable;
}

/** Test cleanup surface: the virtual document provider and the report contents are discarded together */
export function disposeAiArchitectureForTests(): void {
  if (archProvider) {
    archProvider.dispose();
    archProvider = null;
  }
  lastReport = '';
}
