// Lazy registration of AI commands (AI-001): off by default — when
// kbengine.ai.baseUrl is not configured and the host has no vscode.lm model, not
// a single AI command is registered (zero cost, nothing enters the command
// palette). When available, registers the two key-management commands and the
// chat panel (AI-002): the key only goes into SecretStorage
// (AI_API_KEY_SECRET) and never into settings.json; the input box is in password
// form, and an empty input writes nothing to disk. A registration failure is
// silent — the AI surface must not block the main chain (activate is
// fire-and-forget).
import * as vscode from 'vscode';

import { AI_API_KEY_SECRET, isAiFaceAvailable, type AiSecretsStore } from './aiClient';
import { openAiChatPanel } from './aiChatPanel';
import { registerAiExplainFix } from './aiExplainFix';
import { registerAiStubSuggest } from './aiStubSuggest';
import { registerAiArchitecture } from './aiArchitecture';

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
  // AI-003 suggestion layer: CodeAction provider (python + kbengine-def) + the
  // explainFix command + a read-only virtual scheme, registered in the same lazy
  // block as the commands (zero registration when unconfigured)
  registerAiExplainFix(context, secrets);
  // AI-004 suggestion layer: suggestStub command + read-only virtual scheme (zero writes to the template source of truth)
  registerAiStubSuggest(context, secrets);
  // AI-005 analysis surface: the analyzeArchitecture command (structured digest fed to AI, zero disk footprint for the report)
  registerAiArchitecture(context, secrets);
  return {
    registered: true,
    commands: ['kbengine.ai.setApiKey', 'kbengine.ai.clearApiKey', 'kbengine.ai.chat']
  };
}
