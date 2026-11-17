import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as vscode from 'vscode';

import {
  commandRegistry,
  commands,
  configurationOverrides,
  makeTextDocument,
  messages as windowMessages,
  workspaceState
} from './helpers/vscodeStub';

import {
  AI_EXPLAIN_FIX_COMMAND,
  buildExplainFixPayload,
  disposeAiExplainFixForTests,
  KBEngineAiExplainFixCodeActionProvider
} from '../src/ai/aiExplainFix';
import { registerAiCommands } from '../src/ai/aiRegistration';

// AI-003 explainFix 建议层测试:引擎判定不变——诊断正确性不依赖 AI,AI 面
// 全离线可用(未配置时 CodeAction 不出);动作只携带命令,网络调用发生在
// 用户显式执行时(提供 CodeAction 路径零外发);建议只走只读虚拟 scheme
// diff 预览,零落盘;片段最小化=只喂诊断行文本+诊断消息。fetch 注入桩,
// 零真实外发。

const secretsStore = (): {
  map: Map<string, string>;
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
} => {
  const map = new Map<string, string>();
  return {
    map,
    get: async (key: string) => map.get(key),
    store: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    }
  };
};

const subscriptions: unknown[] = [];
const registerAi = async (): Promise<void> => {
  await registerAiCommands({ subscriptions } as never, secretsStore());
};

const doc = makeTextDocument(
  ['import KBEngine', '', 'class Avatar:', '    def onTimer(self, tid):', '        self.cell.teleport()', ''].join('\n'),
  { fileName: '/w/Avatar.py', languageId: 'python', version: 1 }
);

const diagAt = (line: number, code: string, message = 'receiver may be None'): vscode.Diagnostic => {
  const d = new vscode.Diagnostic(
    new vscode.Range(line, 8, line, 20),
    message,
    vscode.DiagnosticSeverity.Warning
  );
  (d as { code?: string }).code = code;
  return d as vscode.Diagnostic;
};

const provider = new KBEngineAiExplainFixCodeActionProvider();

/** 命中诊断行(第 4 行 self.cell.teleport())的请求区间 */
const diagHitRange = (): vscode.Range => new vscode.Range(4, 8, 4, 20);

const diffCalls: Array<{ command: string; args: unknown[] }> = [];

beforeEach(() => {
  commands.registerCommand('vscode.diff', (...args: unknown[]) => {
    diffCalls.push({ command: 'vscode.diff', args });
    return undefined;
  });
});

afterEach(() => {
  disposeAiExplainFixForTests();
  commandRegistry.reset();
  subscriptions.length = 0;
  diffCalls.length = 0;
  configurationOverrides.delete('kbengine.ai');
  delete (vscode as { lm?: unknown }).lm;
});

describe('AI-003 buildExplainFixPayload(片段最小化,外来诊断不外发)', () => {
  it('kbengine.* 诊断出 payload:消息+码+文件+行+行文本', () => {
    const payload = buildExplainFixPayload(doc, diagAt(4, 'kbengine.receiverNone'));
    expect(payload).toEqual({
      message: 'receiver may be None',
      code: 'kbengine.receiverNone',
      file: '/w/Avatar.py',
      line: 4,
      lineText: '        self.cell.teleport()'
    });
  });

  it('外来诊断码不出(不外发)', () => {
    expect(buildExplainFixPayload(doc, diagAt(4, 'pyright'))).toBeNull();
    expect(buildExplainFixPayload(doc, diagAt(4, 42))).toBeNull();
    expect(buildExplainFixPayload(doc, diagAt(4, 'KbEngine.receiverNone'))).toBeNull();
  });

  it('空行诊断不出(无片段可喂,不猜)', () => {
    expect(buildExplainFixPayload(doc, diagAt(1, 'kbengine.receiverNone'))).toBeNull();
  });
});

describe('AI-003 CodeAction 建议层', () => {
  it('未配置 AI 面时该 CodeAction 不出(引擎判定不变)', async () => {
    const actions = await provider.provideCodeActions(doc, diagHitRange(), {
      diagnostics: [diagAt(4, 'kbengine.receiverNone')]
    } as vscode.CodeActionContext);
    expect(actions).toEqual([]);
  });

  it('配置后:范围相交的 kbengine.* 诊断出建议层动作(命令型,零编辑)', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    const diagnostic = diagAt(4, 'kbengine.receiverNone');
    const actions = await provider.provideCodeActions(doc, diagHitRange(), {
      diagnostics: [diagnostic]
    } as vscode.CodeActionContext);
    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action.command?.command).toBe(AI_EXPLAIN_FIX_COMMAND);
    expect(action.diagnostics).toEqual([diagnostic]);
    const payload = action.command?.arguments?.[0] as { code?: string; lineText?: string };
    expect(payload.code).toBe('kbengine.receiverNone');
    expect(payload.lineText).toBe('        self.cell.teleport()');
    expect(action.edit).toBeUndefined();
  });

  it('范围不相交或非 kbengine 码诊断不出', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    const actions = await provider.provideCodeActions(doc, diagHitRange(), {
      diagnostics: [diagAt(0, 'kbengine.receiverNone'), diagAt(4, 'external.lint')]
    } as vscode.CodeActionContext);
    expect(actions).toEqual([]);
  });
});

describe('AI-003 explainFix 命令(diff 预览零落盘)', () => {
  it('执行命令:AI 回复围栏建议入虚拟 scheme,vscode.diff 左=原文件右=只读建议', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    await registerAi();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<unknown> => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '原因:cell 可能为 None。\n```python\n        if self.cell:\n            self.cell.teleport()\n```' } }]
      })
    })) as typeof fetch;
    try {
      await commands.executeCommand(AI_EXPLAIN_FIX_COMMAND, {
        message: 'receiver may be None',
        code: 'kbengine.receiverNone',
        file: '/w/Avatar.py',
        line: 4,
        lineText: '        self.cell.teleport()'
      });
      await new Promise(resolve => setTimeout(resolve, 40));
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(diffCalls).toHaveLength(1);
    const [left, right, title] = diffCalls[0].args as [
      { fsPath?: string },
      { scheme?: string },
      string
    ];
    expect(left.fsPath).toBe('/w/Avatar.py');
    expect(right.scheme).toBe('kbengine-ai-fix');
    expect(String(title)).toContain('read-only');
    // 虚拟 provider 内容=建议正文(只读,不落盘)
    const providers = workspaceState.contentProviders as Map<string, { provideTextDocumentContent(): string }>;
    const fixProvider = providers.get('kbengine-ai-fix');
    expect(fixProvider).toBeDefined();
    expect(fixProvider!.provideTextDocumentContent()).toBe('        if self.cell:\n            self.cell.teleport()\n');
    expect(windowMessages.error).toHaveLength(0);
  });

  it('AI 回复无围栏:诚实提示,不出 diff 不造建议', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    await registerAi();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<unknown> => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '只有文字说明,没有代码。' } }] })
    })) as typeof fetch;
    try {
      await commands.executeCommand(AI_EXPLAIN_FIX_COMMAND, {
        message: 'receiver may be None',
        code: 'kbengine.receiverNone',
        file: '/w/Avatar.py',
        line: 4,
        lineText: '        self.cell.teleport()'
      });
      await new Promise(resolve => setTimeout(resolve, 40));
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(diffCalls).toHaveLength(0);
    expect(windowMessages.info.some(text => text.includes('未包含代码建议'))).toBe(true);
  });

  it('AI 请求失败:错误消息带原因,零 diff', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    await registerAi();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<unknown> => {
      throw new Error('connection refused');
    }) as typeof fetch;
    try {
      await commands.executeCommand(AI_EXPLAIN_FIX_COMMAND, {
        message: 'receiver may be None',
        code: 'kbengine.receiverNone',
        file: '/w/Avatar.py',
        line: 4,
        lineText: '        self.cell.teleport()'
      });
      // 网络错误走 maxRetries 重试(默认退避 250ms 起),等足重试+错误落地
      await new Promise(resolve => setTimeout(resolve, 700));
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(diffCalls).toHaveLength(0);
    expect(windowMessages.error.some(text => text.includes('connection refused'))).toBe(true);
  });

  it('命令二次闸:配置被清空后执行命令诚实报错不开 diff', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    await registerAi();
    configurationOverrides.delete('kbengine.ai');
    await commands.executeCommand(AI_EXPLAIN_FIX_COMMAND, {
      message: 'm',
      code: 'kbengine.receiverNone',
      file: '/w/Avatar.py',
      line: 4,
      lineText: '        self.cell.teleport()'
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(diffCalls).toHaveLength(0);
    expect(windowMessages.error.some(text => text.includes('AI 面未配置'))).toBe(true);
  });
});
