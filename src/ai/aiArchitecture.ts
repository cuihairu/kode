// AI-005 架构框架分析(analyzeArchitecture):把 Rust 引擎结构化摘要
// ($/kode/dependency/graph 既有数据面——依赖图/继承/has-a,非源码全文)喂
// LLM 生成叙述性架构报告(Markdown,只读虚拟 scheme 预览面板)。数据真源
// 在引擎,LLM 只做总结;prompt 与报告都显式声明截断策略(超限工程按预算
// 截断,绝不静默)。零落盘:报告走只读虚拟文档;AI 面未配置时命令不出
// (惰性注册判据同 AI-001,handler 二次闸防注册后配置被清空)。
import * as vscode from 'vscode';
import { AI_API_KEY_SECRET, AiSecretsStore, isAiFaceAvailable, sendAiMessage } from './aiClient';
import type { DependencyGraphRust } from '../backend/dependencyGraphRust';

export const AI_ANALYZE_ARCHITECTURE_COMMAND = 'kbengine.ai.analyzeArchitecture';
const ARCH_SCHEME = 'kbengine-ai-architecture';

/** 摘要预算(字符):超限截断,prompt 与报告都显式声明,绝不静默 */
export const ARCHITECTURE_DIGEST_BUDGET = 12000;

export interface ArchitectureDigest {
  digest: string;
  truncated: boolean;
}

export interface ArchitectureDeps {
  buildGraph: (root: string) => Promise<DependencyGraphRust | null>;
}

/**
 * 依赖图→结构化摘要文本(计数行+实体清单+按 kind 分组的边示例)。
 * 超预算硬截断并打 truncated=true——喂给 LLM 的就是这段文本,不发散源码。
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

/** 报告只读虚拟文档(scheme 惰性注册,内容随每次分析换新) */
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
 * 注册 AI-005 分析面(AI 面惰性块内调用):analyzeArchitecture 命令。
 * 报告零落盘(只读虚拟 scheme);deps 注入面供测试替换 buildGraph。
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

/** 测试清理面:虚拟文档 provider 与报告内容一并弃 */
export function disposeAiArchitectureForTests(): void {
  if (archProvider) {
    archProvider.dispose();
    archProvider = null;
  }
  lastReport = '';
}
