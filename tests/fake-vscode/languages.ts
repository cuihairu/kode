// fake-vscode 语言服务登记层(docs/redesign.md 阶段 3):
// languages.register*Provider 记账(selector + provider + 触发字符)、
// createDiagnosticCollection 产出真实可用的 DiagnosticCollection 并入册。
// extension.ts 的激活链各注册点由此可被逐条断言。

import { DiagnosticCollection } from './core';

interface ProviderRegistration {
  selector: unknown;
  provider: unknown;
  triggerCharacters?: string[];
}

const completionRegistrations: ProviderRegistration[] = [];
const hoverRegistrations: ProviderRegistration[] = [];
const definitionRegistrations: ProviderRegistration[] = [];
const callHierarchyRegistrations: ProviderRegistration[] = [];
const diagnosticCollections: Array<{ name: string; collection: DiagnosticCollection }> = [];

const register = (bucket: ProviderRegistration[]) =>
  (selector: unknown, provider: unknown, ...triggerCharacters: string[]): { dispose(): void } => {
    const registration: ProviderRegistration = triggerCharacters.length
      ? { selector, provider, triggerCharacters }
      : { selector, provider };
    bucket.push(registration);
    return {
      dispose: (): void => {
        const index = bucket.indexOf(registration);
        if (index >= 0) {
          bucket.splice(index, 1);
        }
      }
    };
  };

export const languages = {
  registerCompletionItemProvider: register(completionRegistrations),
  registerHoverProvider: register(hoverRegistrations),
  registerDefinitionProvider: register(definitionRegistrations),
  registerCallHierarchyProvider: register(callHierarchyRegistrations),
  createDiagnosticCollection: (name: string): DiagnosticCollection => {
    const collection = new DiagnosticCollection();
    diagnosticCollections.push({ name, collection });
    return collection;
  }
};

export const languagesRegistry = {
  completionRegistrations,
  hoverRegistrations,
  definitionRegistrations,
  callHierarchyRegistrations,
  diagnosticCollections,
  reset: (): void => {
    completionRegistrations.length = 0;
    hoverRegistrations.length = 0;
    definitionRegistrations.length = 0;
    callHierarchyRegistrations.length = 0;
    diagnosticCollections.length = 0;
  }
};
