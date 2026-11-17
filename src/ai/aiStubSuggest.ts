// AI-004 stub/typings 建议层(suggestStub):对 stub 模板真源的成员段,AI
// 补 docstring/使用示例,只作建议层输出到 diff 预览——绝不替代模板真源
// (typings/ 目录钉死 fork commit 的真源口径不动,用户设计资产红线;本层
// 对真源文件零写入)。diff 两侧都是只读虚拟文档:左侧=真源原段,右侧=
// AI 建议段,确认后由用户手工誊抄——不提供一键写入面。片段最小化:只发
// 选中的成员段,不发整个模板。AI 面未配置时命令不出(惰性注册判据同
// AI-001,handler 二次闸防注册后配置被清空)。
import * as vscode from 'vscode';
import { AI_API_KEY_SECRET, AiSecretsStore, isAiFaceAvailable, sendAiMessage } from './aiClient';
import { extractCodeSuggestions } from './aiChatPanel';
import { resolveKbengineStubTemplateRoot } from '../pythonStubExport';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const AI_SUGGEST_STUB_COMMAND = 'kbengine.ai.suggestStub';
const STUB_SCHEME = 'kbengine-ai-stub';

interface StubSuggestionState {
  /** 真源原段(只读 diff 左侧) */
  source: string;
  /** AI 建议段(只读 diff 右侧) */
  suggestion: string;
}

let stubState: StubSuggestionState | null = null;
let stubProvider: vscode.Disposable | null = null;

/**
 * 从模板真源文本提取成员段:`def <名>(`/`class <名>` 起行到下一个同级或
 * 更浅缩进的定义行(不含)——同名多定义取首个;找不到返回 null(不猜)。
 * 顶层装饰器行(@...)在定义行上方时并入段落起点(签名完整可喂)。
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
    // 顶层成员:紧邻上方的连续装饰器行并入(签名带 @overload 等才完整)
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
  // 段尾=header 之后第一个同级或更浅缩进的定义行(不含;装饰器并入后
  // 从 headerLine+1 找,自己的 def 行不会被误判)
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
  // 段尾空行回缩(尾随空白行不属于成员段)
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

/** 命令入口的成员名解析:显式参数优先;否则活动 .pyi 光标词;提不出=诚实提示 */
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
  // 真源红线:本层对模板文件零写入——只把原段/建议段挂进只读虚拟文档
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
 * 注册 AI-004 建议层(AI 面惰性块内调用):suggestStub 命令+只读虚拟
 * scheme provider。真源文件零写入。
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

/** 测试清理面 */
export function disposeAiStubSuggestForTests(): void {
  if (stubProvider) {
    stubProvider.dispose();
    stubProvider = null;
  }
  stubState = null;
}
