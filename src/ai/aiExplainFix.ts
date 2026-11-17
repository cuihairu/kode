// AI-003 快速修复建议层(explainFix):诊断码+诊断行片段喂 LLM 生成修复
// 建议,只作建议层输出到 diff 预览——引擎判定不变,诊断正确性不依赖 AI
// (AI 面全离线可用;未配置时该 CodeAction 根本不出,provider 闸一次+
// 命令 handler 二次闸防注册后配置被清空)。输出永不直写盘:建议走只读
// 虚拟 scheme(kbengine-ai-fix)diff 预览;本层只做「解释+建议」预览,
// 应用动作留给用户在对话面板(AI-002)或手工通道完成,不提供一键写入
// 面。片段最小化:只喂诊断行文本与诊断消息,不发整个文件(遥测零口径:
// 只发该命令所需片段)。
import * as vscode from 'vscode';
import { AI_API_KEY_SECRET, AiSecretsStore, isAiFaceAvailable, sendAiMessage } from './aiClient';
import { extractCodeSuggestions } from './aiChatPanel';

export const AI_EXPLAIN_FIX_COMMAND = 'kbengine.ai.explainFix';
const FIX_SCHEME = 'kbengine-ai-fix';

/** 喂给 LLM 的最小片段(诊断元数据+诊断行文本,不含文件其余部分) */
export interface AiExplainFixPayload {
  message: string;
  code: string;
  file: string;
  /** 诊断起始行(0 基) */
  line: number;
  lineText: string;
}

interface FixSuggestion {
  lang: string;
  code: string;
}

let lastSuggestion: FixSuggestion | null = null;
let fixProvider: vscode.Disposable | null = null;

/** kode 自家诊断才进 AI 建议层(外来诊断不外发,片段最小化) */
function isKodeDiagnosticCode(code: vscode.Diagnostic['code'] | undefined): code is string {
  return typeof code === 'string' && code.startsWith('kbengine.');
}

export function buildExplainFixPayload(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): AiExplainFixPayload | null {
  if (!isKodeDiagnosticCode(diagnostic.code)) {
    return null;
  }
  const lineText = document.lineAt(diagnostic.range.start.line).text;
  if (!lineText.trim()) {
    return null;
  }
  return {
    message: diagnostic.message,
    code: diagnostic.code,
    file: document.fileName,
    line: diagnostic.range.start.line,
    lineText
  };
}

function renderPrompt(payload: AiExplainFixPayload): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        '你是 KBEngine 插件的修复助手。根据诊断信息解释问题并给出修复后的完整代码。' +
        '把修复后的完整代码放在一个围栏代码块里(标注语言),块外最多一句话原因。不要重写无关代码。'
    },
    {
      role: 'user',
      content: [
        `文件: ${payload.file}`,
        `诊断码: ${payload.code}`,
        `诊断消息: ${payload.message}`,
        `第 ${payload.line + 1} 行: ${payload.lineText}`
      ].join('\n')
    }
  ];
}

/** CodeAction 请求面:AI 面可用时,对范围相交的 kbengine.* 诊断出建议层动作 */
export class KBEngineAiExplainFixCodeActionProvider implements vscode.CodeActionProvider {
  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token?: vscode.CancellationToken
  ): Promise<vscode.CodeAction[]> {
    if (token?.isCancellationRequested) {
      return [];
    }
    // 未配置 AI 面时该 CodeAction 不出(引擎判定不变,诊断不依赖 AI)
    if (!(await isAiFaceAvailable())) {
      return [];
    }
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      const start = diagnostic.range.start;
      const end = diagnostic.range.end;
      const positionValue = (position: vscode.Position): number => position.line * 1_000_000 + position.character;
      const intersects = positionValue(start) <= positionValue(range.end)
        && positionValue(range.start) <= positionValue(end);
      if (!intersects) {
        continue;
      }
      const payload = buildExplainFixPayload(document, diagnostic);
      if (!payload) {
        continue;
      }
      const action = new vscode.CodeAction(
        vscode.l10n.t('AI explain / fix suggestion'),
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [diagnostic];
      // 建议层:动作只携带命令,网络调用发生在用户显式执行时(提供
      // CodeAction 的路径零外发)
      action.command = {
        command: AI_EXPLAIN_FIX_COMMAND,
        title: vscode.l10n.t('AI explain / fix suggestion'),
        arguments: [payload]
      };
      actions.push(action);
    }
    return actions;
  }
}

async function handleExplainFix(payload: AiExplainFixPayload, secrets: AiSecretsStore): Promise<void> {
  if (!(await isAiFaceAvailable())) {
    void vscode.window.showErrorMessage('AI 面未配置:设置 kbengine.ai.baseUrl(OpenAI 兼容端点)或宿主提供语言模型后可用');
    return;
  }
  let apiKey: string | null = null;
  try {
    apiKey = (await secrets.get(AI_API_KEY_SECRET)) ?? null;
  } catch {
    apiKey = null;
  }
  let reply: string;
  try {
    reply = await sendAiMessage({ messages: renderPrompt(payload), apiKey });
  } catch (error) {
    void vscode.window.showErrorMessage(`AI 修复建议失败: ${(error as Error).message}`);
    return;
  }
  const suggestions = extractCodeSuggestions(reply);
  if (suggestions.length === 0) {
    // 诚实:AI 回复没给出代码建议就明说,不猜不硬造
    void vscode.window.showInformationMessage('AI 回复未包含代码建议,仅有文字说明');
    return;
  }
  lastSuggestion = suggestions[0];
  const target = vscode.Uri.file(payload.file);
  const virtual = vscode.Uri.parse(`${FIX_SCHEME}:suggestion.${lastSuggestion.lang || 'txt'}`);
  await vscode.commands.executeCommand(
    'vscode.diff',
    target,
    virtual,
    vscode.l10n.t('AI fix suggestion (read-only, nothing written)')
  );
}

/**
 * 注册 AI-003 建议层(在 AI 面惰性块内调用,零成本面):CodeAction provider
 * (python + kbengine-def 双 selector)+ explainFix 命令 + 只读虚拟 scheme
 * provider。
 */
export function registerAiExplainFix(
  context: vscode.ExtensionContext,
  secrets: AiSecretsStore
): vscode.Disposable {
  const disposables = [
    vscode.languages.registerCodeActionsProvider(
      'python',
      new KBEngineAiExplainFixCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),
    vscode.languages.registerCodeActionsProvider(
      'kbengine-def',
      new KBEngineAiExplainFixCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),
    vscode.commands.registerCommand(AI_EXPLAIN_FIX_COMMAND, (payload?: AiExplainFixPayload) => {
      if (!payload) {
        return;
      }
      void handleExplainFix(payload, secrets);
    }),
    vscode.workspace.registerTextDocumentContentProvider(FIX_SCHEME, {
      provideTextDocumentContent(): string {
        return lastSuggestion?.code ?? '';
      }
    })
  ];
  context.subscriptions.push(...disposables);
  fixProvider = { dispose: (): void => disposables.forEach(d => d.dispose()) };
  return fixProvider;
}

/** 测试清理面:provider/命令/虚拟 scheme 与 lastSuggestion 一并弃 */
export function disposeAiExplainFixForTests(): void {
  if (fixProvider) {
    fixProvider.dispose();
    fixProvider = null;
  }
  lastSuggestion = null;
}
