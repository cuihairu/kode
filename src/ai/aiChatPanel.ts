// AI chat panel (AI-002, webview chat form): conversational interaction reuses
// the existing webview infrastructure — nonce CSP with zero outbound links (the
// webviewSecurity precedent), the KODE-PERF-005 generation guard semantics
// (concurrent asks / stale-generation chunks after the panel closes are dropped
// at the write surface; dispose means cancelling in-flight work).
// Output is never written straight to disk: code suggestions always go through a
// diff preview + confirm button, and apply rides the normal WorkspaceEdit channel
// (undoable); the diff preview of suggestion content goes through a
// TextDocumentContentProvider virtual scheme, zero disk footprint. The multi-turn
// conversation history lives in panel memory, discarded on dispose, never on disk.
// Streaming output is interruptible: the lm route renders chunk by chunk and
// interruption stops collecting while keeping what was received; the endpoint
// route renders the whole body when it arrives, interruption = abort. When the AI
// surface is unconfigured (no baseUrl and no host lm model) the command is not
// registered (the aiRegistration lazy criterion), and the panel entry also gates
// a second time.
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

/** ```lang ... ``` fenced code block extraction (AI suggestion surface; unterminated fences are not collected, no guessing) */
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
  current = null; // conversation history lives in the panel, discarded on dispose, never on disk
  session.cts.cancel();
  session.cts.dispose();
  session.disposables.forEach(d => d.dispose());
  session.panel.dispose(); // onDidDispose→closeSession re-entry sees current already null, harmless
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
  // KODE-PERF-005 generation guard: a new ask cancels the old generation; old-generation chunks/results are dropped at the write surface
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
          return; // stale generation or already advanced: drop at the write surface
        }
        post(session, { type: 'chunk', gen, text: chunk });
      }
    );
    if (gen !== session.gen || current !== session) {
      return;
    }
    if (token.isCancellationRequested) {
      // interruption stops collecting: the received part is kept via the stream callback; post a cancelled wrap-up here (unlock the panel)
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
 * Open the AI chat panel (singleton; reveals an already-open one). Reports an
 * honest error instead of opening the panel when the AI surface is unconfigured
 * (same criterion as the lazy command registration; a second gate defending the
 * case where the configuration is cleared after registration).
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
        // The virtual document locates the suggestion by index in the uri query; out of range = empty string (no guessing)
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

/** Cleanup surface for tests and unload: closes the panel and the virtual document provider */
export function disposeAiChatPanelForTests(): void {
  closeSession();
  if (suggestionProvider) {
    suggestionProvider.dispose();
    suggestionProvider = null;
  }
}
