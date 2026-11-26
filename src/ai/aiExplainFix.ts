// AI-003 quick-fix suggestion layer (explainFix): feeds the diagnostic code plus
// the diagnostic line snippet to the LLM to produce fix suggestions, output only
// as a suggestion layer rendered into a diff preview — engine rulings are
// unchanged, diagnostic correctness does not depend on AI (the AI surface works
// fully offline; when unconfigured the CodeAction simply never appears, with a
// provider-side gate plus a command-handler second gate against the
// configuration being cleared after registration). Output is never written
// straight to disk: suggestions ride a read-only virtual scheme (kbengine-ai-fix)
// diff preview; this layer only provides an "explain + suggest" preview, the
// apply action is left to the user via the chat panel (AI-002) or a manual
// channel — no one-click write surface is offered. Snippet minimization: only
// the diagnostic line text and the diagnostic message are sent, never the whole
// file (zero-telemetry contract: only the snippet the command needs goes out).
import * as vscode from 'vscode';
import { AI_API_KEY_SECRET, AiSecretsStore, isAiFaceAvailable, sendAiMessage } from './aiClient';
import { extractCodeSuggestions } from './aiChatPanel';

export const AI_EXPLAIN_FIX_COMMAND = 'kbengine.ai.explainFix';
const FIX_SCHEME = 'kbengine-ai-fix';

/** Minimal snippet fed to the LLM (diagnostic metadata + diagnostic line text, nothing else from the file) */
export interface AiExplainFixPayload {
  message: string;
  code: string;
  file: string;
  /** Diagnostic start line (0-based) */
  line: number;
  lineText: string;
}

interface FixSuggestion {
  lang: string;
  code: string;
}

let lastSuggestion: FixSuggestion | null = null;
let fixProvider: vscode.Disposable | null = null;

/** Only kode's own diagnostics enter the AI suggestion layer (foreign diagnostics are never sent out, snippet minimization) */
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

/** CodeAction request surface: when the AI surface is available, offers suggestion-layer actions for range-intersecting kbengine.* diagnostics */
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
    // When the AI surface is unconfigured the CodeAction does not appear (engine rulings unchanged, diagnostics do not depend on AI)
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
      // Suggestion layer: the action only carries a command; the network call
      // happens when the user explicitly runs it (the CodeAction-providing path
      // makes zero outbound requests)
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
    // Honest: say so plainly when the AI reply contains no code suggestion; no guessing, no fabrication
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
 * Register the AI-003 suggestion layer (called inside the lazy AI block, zero-cost
 * surface): CodeAction provider (python + kbengine-def dual selector) + the
 * explainFix command + the read-only virtual scheme provider.
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

/** Test cleanup surface: provider/commands/virtual scheme and lastSuggestion are discarded together */
export function disposeAiExplainFixForTests(): void {
  if (fixProvider) {
    fixProvider.dispose();
    fixProvider = null;
  }
  lastSuggestion = null;
}
