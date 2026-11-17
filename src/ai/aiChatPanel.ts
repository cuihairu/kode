// AI 对话面板(AI-002,webview chat 形态):会话式交互复用既有 webview
// 基建——nonce CSP 零外联(webviewSecurity 先例)、KODE-PERF-005 代际守卫
// 口径(并发提问/关面板后旧代 chunk 在写入面被弃,dispose 即取消在途)。
// 输出永不直写盘:代码建议一律 diff 预览 + 确认按钮,应用走 WorkspaceEdit
// 正常通道(可撤销);建议内容的 diff 预览走 TextDocumentContentProvider
// 虚拟 scheme,零落盘。多轮会话历史驻留面板内存,dispose 即弃,不落盘。
// 流式输出可中断:lm 路线逐 chunk 上屏、中断停收保留已收;endpoint 路线
// 整段到达上屏,中断=abort。未配置 AI 面(未配 baseUrl 且宿主无 lm 模型)
// 时命令不注册(aiRegistration 惰性判据),面板入口也二次闸一次。
import * as vscode from 'vscode';
import { AI_API_KEY_SECRET, AiSecretsStore, isAiFaceAvailable, resolveAiEndpointConfig, sendAiMessageStream } from './aiClient';
import { renderAiChatPanelHtml } from './aiChatPanelHtml';
import { randomNonce } from '../webviewSecurity';

interface AiChatSessionMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AiSuggestion {
  lang: string;
  code: string;
}

interface AiChatSession {
  panel: vscode.WebviewPanel;
  gen: number;
  cts: vscode.CancellationTokenSource;
  messages: AiChatSessionMessage[];
  suggestions: AiSuggestion[];
  disposables: vscode.Disposable[];
}

const SUGGESTION_SCHEME = 'kbengine-ai-suggestion';

let current: AiChatSession | null = null;
let suggestionProvider: vscode.Disposable | null = null;

/** ```lang ... ``` 围栏代码块提取(AI 建议面;未闭合围栏不收,不猜) */
export function extractCodeSuggestions(reply: string): AiSuggestion[] {
  const out: AiSuggestion[] = [];
  const pattern = /```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)```/g;
  let match = pattern.exec(reply);
  while (match !== null) {
    out.push({ lang: match[1], code: match[2] });
    match = pattern.exec(reply);
  }
  return out;
}

function post(session: AiChatSession, message: Record<string, unknown>): void {
  void Promise.resolve(session.panel.webview.postMessage(message)).catch(() => undefined);
}

function closeSession(): void {
  const session = current;
  if (!session) {
    return;
  }
  current = null; // 会话历史驻留面板,dispose 即弃,不落盘
  session.cts.cancel();
  session.cts.dispose();
  session.disposables.forEach(d => d.dispose());
  session.panel.dispose(); // onDidDispose→closeSession 重入时 current 已 null,无害
}

async function handlePreview(session: AiChatSession, index: number): Promise<void> {
  const suggestion = session.suggestions[index];
  if (!suggestion) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    post(session, { type: 'error', message: '没有活动编辑器,建议无处对照(diff 需要一个打开的文档)' });
    return;
  }
  const target = editor.document.uri;
  const virtual = vscode.Uri.parse(`${SUGGESTION_SCHEME}:suggestion-${index}.${suggestion.lang || 'txt'}?index=${index}`);
  await vscode.commands.executeCommand('vscode.diff', target, virtual, `AI 建议 #${index + 1}(只读,不落盘)`);
  post(session, { type: 'preview' });
}

async function handleApply(session: AiChatSession, index: number): Promise<void> {
  const suggestion = session.suggestions[index];
  if (!suggestion) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    post(session, { type: 'error', message: '没有活动编辑器,应用需要一个打开的文档' });
    return;
  }
  const target = editor.document.uri;
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    editor.document.positionAt(0),
    editor.document.positionAt(editor.document.getText().length)
  );
  edit.replace(target, fullRange, suggestion.code);
  const applied = await vscode.workspace.applyEdit(edit);
  if (applied) {
    post(session, { type: 'applied', uri: target.toString() });
  } else {
    post(session, { type: 'error', message: '应用失败(编辑未生效)' });
  }
}

async function handleAsk(session: AiChatSession, secrets: AiSecretsStore, text: string): Promise<void> {
  // KODE-PERF-005 代际守卫:新问取消旧代,旧代 chunk/结果在写入面被弃
  session.gen += 1;
  const gen = session.gen;
  session.cts.cancel();
  session.cts.dispose();
  session.cts = new vscode.CancellationTokenSource();
  const token = session.cts.token;
  session.messages.push({ role: 'user', content: text });
  const endpoint = resolveAiEndpointConfig();
  let apiKey: string | null = null;
  try {
    apiKey = (await secrets.get(AI_API_KEY_SECRET)) ?? null;
  } catch {
    apiKey = null;
  }
  try {
    const full = await sendAiMessageStream(
      { messages: session.messages, endpoint, apiKey, token },
      chunk => {
        if (gen !== session.gen || current !== session) {
          return; // 旧代或已换代:写入面弃用
        }
        post(session, { type: 'chunk', gen, text: chunk });
      }
    );
    if (gen !== session.gen || current !== session) {
      return;
    }
    if (token.isCancellationRequested) {
      // 中断停收:已收部分保留在流回调里,这里补 cancelled 收尾(面板解锁)
      post(session, { type: 'cancelled', gen });
      return;
    }
    session.messages.push({ role: 'assistant', content: full });
    session.suggestions = extractCodeSuggestions(full);
    post(session, { type: 'done', gen, suggestions: session.suggestions });
  } catch (error) {
    if (gen !== session.gen || current !== session) {
      return;
    }
    const message = (error as Error).message ?? String(error);
    if (token.isCancellationRequested || message.includes('cancelled')) {
      post(session, { type: 'cancelled', gen });
    } else {
      post(session, { type: 'error', gen, message });
    }
  }
}

/**
 * 打开 AI 对话面板(单例;已开 reveal)。未配置 AI 面时诚实报错不开面板
 * (与命令惰性注册同判据,二次闸防御注册后配置被清空的情形)。
 */
export async function openAiChatPanel(secrets: AiSecretsStore): Promise<void> {
  if (!(await isAiFaceAvailable())) {
    void vscode.window.showErrorMessage(
      'AI 面未配置:设置 kbengine.ai.baseUrl(OpenAI 兼容端点)或宿主提供语言模型后可用'
    );
    return;
  }
  if (current) {
    current.panel.reveal();
    return;
  }
  if (!suggestionProvider) {
    suggestionProvider = vscode.workspace.registerTextDocumentContentProvider(SUGGESTION_SCHEME, {
      provideTextDocumentContent(uri: vscode.Uri): string {
        // 虚拟文档按 uri query 的建议序号定位;越界=空串(不猜)
        const index = Number(uri.query) || 0;
        const session = current;
        return session?.suggestions[index]?.code ?? '';
      }
    });
  }
  const panel = vscode.window.createWebviewPanel('kbengine.ai.chat', 'KBEngine AI 对话', vscode.ViewColumn.Beside, {
    enableScripts: true,
    localResourceRoots: []
  });
  panel.webview.html = renderAiChatPanelHtml({ nonce: randomNonce() });
  const session: AiChatSession = {
    panel,
    gen: 0,
    cts: new vscode.CancellationTokenSource(),
    messages: [],
    suggestions: [],
    disposables: [
      panel.webview.onDidReceiveMessage((message: unknown) => {
        const m = (message ?? {}) as { type?: string; text?: string; index?: number };
        if (m.type === 'ask' && typeof m.text === 'string' && m.text.trim()) {
          void handleAsk(session, secrets, m.text);
        } else if (m.type === 'cancel') {
          session.cts.cancel();
        } else if (m.type === 'preview') {
          void handlePreview(session, Number(m.index ?? 0));
        } else if (m.type === 'apply') {
          void handleApply(session, Number(m.index ?? 0));
        }
      }),
      panel.onDidDispose(() => {
        closeSession();
      })
    ]
  };
  current = session;
}

/** 测试与卸载清理面:关闭面板与虚拟文档 provider */
export function disposeAiChatPanelForTests(): void {
  closeSession();
  if (suggestionProvider) {
    suggestionProvider.dispose();
    suggestionProvider = null;
  }
}
