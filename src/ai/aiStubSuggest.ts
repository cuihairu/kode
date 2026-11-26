// AI-004 stub/typings suggestion layer (suggestStub): for a member section of the
// stub template source of truth, the AI adds docstrings/usage examples, output
// only as a suggestion layer rendered into a diff preview — it never replaces the
// template source of truth (the typings/ directory is pinned to the fork commit;
// that source-of-truth contract is unchanged, a user design-asset red line; this
// layer writes nothing to the source-of-truth files). Both sides of the diff are
// read-only virtual documents: left = the original section, right = the AI
// suggested section, and the user hand-copies it after confirming — no one-click
// write surface is offered. Snippet minimization: only the selected member
// section is sent, never the whole template. When the AI surface is
// unconfigured the command does not appear (lazy registration criterion same as
// AI-001, plus a handler-side second gate against the configuration being
// cleared after registration).
import * as vscode from 'vscode';
import { AI_API_KEY_SECRET, AiSecretsStore, isAiFaceAvailable, sendAiMessage } from './aiClient';
import { extractCodeSuggestions } from './aiChatPanel';
import { resolveKbengineStubTemplateRoot } from '../pythonStubExport';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const AI_SUGGEST_STUB_COMMAND = 'kbengine.ai.suggestStub';
const STUB_SCHEME = 'kbengine-ai-stub';

interface StubSuggestionState {
  /** Original source-of-truth section (read-only diff left side) */
  source: string;
  /** AI suggested section (read-only diff right side) */
  suggestion: string;
}

let stubState: StubSuggestionState | null = null;
let stubProvider: vscode.Disposable | null = null;

/**
 * Extract a member section from the template source-of-truth text: from the
 * `def <name>(` / `class <name>` line up to (but not including) the next
 * definition line at the same or shallower indentation — when a name has
 * multiple definitions take the first; returns null when not found (no guessing).
 * Top-level decorator lines (@...) sitting above the definition line are folded
 * into the section start (so the signature is complete enough to feed).
 */
export function extractStubTemplateSection(
  templateText: string,
  memberName: string
): { startLine: number; endLine: number; text: string } | null {
  const lines = templateText.split('\n');
  const headerRe = new RegExp(`^\\s*(class|def)\\s+${memberName}\\b`);
  let headerLine = -1;
  let startLine = -1;
  let indent = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!headerRe.test(line)) {
      continue;
    }
    headerLine = index;
    startLine = index;
    indent = line.match(/^\s*/)?.[0].length ?? 0;
    // Top-level member: fold in the consecutive decorator lines directly above (the signature only becomes complete with @overload etc.)
    let decorator = startLine - 1;
    while (decorator >= 0 && /^\s*@/.test(lines[decorator])) {
      startLine = decorator;
      decorator -= 1;
    }
    break;
  }
  if (headerLine < 0) {
    return null;
  }
  // Section end = the first definition line after the header at the same or a
  // shallower indentation (exclusive; searching from headerLine+1 after folding
  // in decorators, so its own def line is not misjudged)
  const bodyDefRe = /^\s*(class|def|@)\b/;
  let endLine = lines.length;
  for (let index = headerLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
    if (lineIndent <= indent && bodyDefRe.test(line)) {
      endLine = index;
      break;
    }
  }
  // Shrink the section end past trailing blank lines (they do not belong to the member section)
  while (endLine > headerLine + 1 && !lines[endLine - 1].trim()) {
    endLine -= 1;
  }
  return { startLine, endLine, text: lines.slice(startLine, endLine).join('\n') };
}

function renderStubPrompt(
  memberName: string,
  sectionText: string
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        '你是 KBEngine 插件的 typings 助手。为下面的 stub 成员补 docstring 与使用示例:' +
        '输出修复后的完整段落放在一个围栏代码块里(标注 python),签名与类型必须原样保留,只加注释与示例,不改签名。' +
        '块外最多一句话说明。'
    },
    {
      role: 'user',
      content: `成员: ${memberName}\n当前 stub 段:\n${sectionText}`
    }
  ];
}

/** Member-name resolution at the command entry: an explicit argument wins; otherwise the cursor word in the active .pyi; when nothing can be resolved, show an honest hint */
function resolveMemberName(explicit?: string): string | null {
  const trimmed = explicit?.trim();
  if (trimmed) {
    return trimmed;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.toLowerCase().endsWith('.pyi')) {
    return null;
  }
  const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active, /\w+/);
  if (!wordRange) {
    return null;
  }
  const word = editor.document.getText(wordRange);
  return word.trim() || null;
}

async function handleSuggestStub(
  memberName: string,
  extensionPath: string,
  secrets: AiSecretsStore
): Promise<void> {
  if (!(await isAiFaceAvailable())) {
    void vscode.window.showErrorMessage('AI 面未配置:设置 kbengine.ai.baseUrl(OpenAI 兼容端点)或宿主提供语言模型后可用');
    return;
  }
  const templateFile = path.join(resolveKbengineStubTemplateRoot(extensionPath), 'KBEngine.pyi');
  let templateText: string;
  try {
    templateText = fs.readFileSync(templateFile, 'utf8');
  } catch {
    void vscode.window.showErrorMessage(`stub 模板真源不可读: ${templateFile}`);
    return;
  }
  const section = extractStubTemplateSection(templateText, memberName);
  if (!section) {
    void vscode.window.showInformationMessage(`模板真源中未找到成员 ${memberName}(不猜)`);
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
    reply = await sendAiMessage({ messages: renderStubPrompt(memberName, section.text), apiKey });
  } catch (error) {
    void vscode.window.showErrorMessage(`AI stub 建议失败: ${(error as Error).message}`);
    return;
  }
  const suggestions = extractCodeSuggestions(reply);
  if (suggestions.length === 0) {
    void vscode.window.showInformationMessage('AI 回复未包含代码建议,仅有文字说明');
    return;
  }
  // Source-of-truth red line: this layer writes nothing to the template file — it only mounts the original/suggested section into read-only virtual documents
  stubState = { source: section.text, suggestion: suggestions[0].code };
  const left = vscode.Uri.parse(`${STUB_SCHEME}:source.pyi?side=source`);
  const right = vscode.Uri.parse(`${STUB_SCHEME}:suggestion.pyi?side=suggestion`);
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    vscode.l10n.t('AI stub suggestion (template untouched, read-only preview)')
  );
}

/**
 * Register the AI-004 suggestion layer (called inside the lazy AI block): the
 * suggestStub command + the read-only virtual scheme provider. Zero writes to
 * the source-of-truth files.
 */
export function registerAiStubSuggest(
  context: vscode.ExtensionContext,
  secrets: AiSecretsStore
): vscode.Disposable {
  const disposables = [
    vscode.commands.registerCommand(AI_SUGGEST_STUB_COMMAND, (memberName?: string) => {
      const name = resolveMemberName(memberName);
      if (!name) {
        void vscode.window.showInformationMessage('先在 .pyi 中把光标放到成员名上,或输入成员名');
        return;
      }
      void handleSuggestStub(name, context.extensionPath, secrets);
    }),
    vscode.workspace.registerTextDocumentContentProvider(STUB_SCHEME, {
      provideTextDocumentContent(uri: vscode.Uri): string {
        if (!stubState) {
          return '';
        }
        return uri.query === 'side=source' ? stubState.source : stubState.suggestion;
      }
    })
  ];
  context.subscriptions.push(...disposables);
  stubProvider = { dispose: (): void => disposables.forEach(d => d.dispose()) };
  return stubProvider;
}

/** Test cleanup surface */
export function disposeAiStubSuggestForTests(): void {
  if (stubProvider) {
    stubProvider.dispose();
    stubProvider = null;
  }
  stubState = null;
}
