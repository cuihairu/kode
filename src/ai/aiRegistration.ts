// AI 命令惰性注册(AI-001):默认全关——未配置 kbengine.ai.baseUrl 且宿主
// 无 vscode.lm 模型时,一个 AI 命令都不注册(零成本,不进命令面板)。可用
// 时注册 key 管理两命令与对话面板(AI-002):key 只进 SecretStorage
// (AI_API_KEY_SECRET),绝不落 settings.json;输入框 password 形态,空输入
// 不落盘。注册失败静默——AI 面不碍主链(activate fire-and-forget)。
import * as vscode from 'vscode';

import { AI_API_KEY_SECRET, isAiFaceAvailable, type AiSecretsStore } from './aiClient';
import { openAiChatPanel } from './aiChatPanel';
import { registerAiExplainFix } from './aiExplainFix';
import { registerAiStubSuggest } from './aiStubSuggest';

export interface AiRegistrationResult {
  registered: boolean;
  commands: string[];
}

export async function registerAiCommands(
  context: vscode.ExtensionContext,
  secrets: AiSecretsStore
): Promise<AiRegistrationResult> {
  if (!(await isAiFaceAvailable())) {
    return { registered: false, commands: [] };
  }
  const disposables = [
    vscode.commands.registerCommand('kbengine.ai.setApiKey', async () => {
      const value = await vscode.window.showInputBox({
        password: true,
        prompt: 'API key for kbengine.ai endpoint (stored in SecretStorage, never in settings.json)',
        ignoreFocusOut: true
      });
      if (typeof value === 'string' && value.length > 0) {
        await secrets.store(AI_API_KEY_SECRET, value);
      }
    }),
    vscode.commands.registerCommand('kbengine.ai.clearApiKey', async () => {
      await secrets.delete(AI_API_KEY_SECRET);
    }),
    vscode.commands.registerCommand('kbengine.ai.chat', () => openAiChatPanel(secrets))
  ];
  context.subscriptions.push(...disposables);
  // AI-003 建议层:CodeAction provider(python+kbengine-def)+ explainFix
  // 命令+只读虚拟 scheme,与命令同惰性块注册(未配置时零注册)
  registerAiExplainFix(context, secrets);
  // AI-004 建议层:suggestStub 命令+只读虚拟 scheme(模板真源零写入)
  registerAiStubSuggest(context, secrets);
  return {
    registered: true,
    commands: ['kbengine.ai.setApiKey', 'kbengine.ai.clearApiKey', 'kbengine.ai.chat']
  };
}
