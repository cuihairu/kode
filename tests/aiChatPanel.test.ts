import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as vscode from 'vscode';

import {
  commandRegistry,
  commands,
  configurationOverrides,
  makeTextDocument,
  messages as windowMessages,
  panelRegistry,
  workspaceState
} from './helpers/vscodeStub';

// applyEditCalls 是 workspaceState 导出对象内的记账数组(非顶层导出)
const { applyEditCalls } = workspaceState;

import { disposeAiChatPanelForTests, extractCodeSuggestions, openAiChatPanel } from '../src/ai/aiChatPanel';

// AI-002 对话面板测试:webview chat 形态的消息协议、代际守卫(KODE-PERF-005
// 口径)、中断语义、diff 预览与 WorkspaceEdit 应用、会话不落盘。钉值:
// 输出永不直写盘——建议只走 diff 预览+确认应用两步,应用走 WorkspaceEdit
// (可撤销);会话历史驻留面板内存,dispose 即弃。fetch 注入桩,零真实外发。

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

const lastMessage = (): Record<string, unknown> => {
  const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
  const list = panel.webview.postedMessages.map(entry => entry.message as Record<string, unknown>);
  expect(list.length, '面板应有出站消息').toBeGreaterThan(0);
  return list[list.length - 1];
};

const messagesOf = (): Array<Record<string, unknown>> => {
  const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
  return panel.webview.postedMessages.map(entry => entry.message as Record<string, unknown>);
};

const fire = (message: unknown): void => {
  const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
  panelRegistry.fireMessage(panel as never, message);
};

const editorDoc = makeTextDocument('old content', { fileName: '/w/Avatar.def', languageId: 'kbengine-def', version: 1 });

const mountEditor = (): void => {
  (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = { document: editorDoc };
  if (!(vscode.workspace.textDocuments as unknown[]).includes(editorDoc)) {
    (vscode.workspace.textDocuments as unknown[]).push(editorDoc);
  }
};

const withEndpointFetch = async (reply: string, body: () => Promise<void>): Promise<void> => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<unknown> => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: reply } }] })
  })) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = origFetch;
  }
};

const diffCalls: Array<{ command: string; args: unknown[] }> = [];

beforeEach(() => {
  delete (vscode.window as { activeTextEditor?: unknown }).activeTextEditor;
  (vscode.workspace as { textDocuments: unknown[] }).textDocuments = [];
  commands.registerCommand('vscode.diff', (...args: unknown[]) => {
    diffCalls.push({ command: 'vscode.diff', args });
    return undefined;
  });
});

afterEach(() => {
  disposeAiChatPanelForTests();
  commandRegistry.reset();
  diffCalls.length = 0;
  configurationOverrides.delete('kbengine.ai');
});

describe('AI-002 extractCodeSuggestions(建议面,未闭合不收)', () => {
  it('提取 ```lang 围栏代码块,捕获语言与正文', () => {
    const reply = ['前置说明', '', '```python', 'def a():', '    return 1', '```', '', '```kbengine-def', '<root/>', '```'].join('\n');
    const out = extractCodeSuggestions(reply);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ lang: 'python', code: 'def a():\n    return 1\n' });
    expect(out[1]).toEqual({ lang: 'kbengine-def', code: '<root/>\n' });
  });

  it('未闭合围栏不收,不猜', () => {
    expect(extractCodeSuggestions('```python\ndef a():\n')).toEqual([]);
  });

  it('无围栏回复=零建议', () => {
    expect(extractCodeSuggestions('纯文本回复,没有代码建议')).toEqual([]);
  });
});

describe('AI-002 对话面板(真实消息协议)', () => {
  it('未配置 AI 面时不开面板,诚实报错', async () => {
    await openAiChatPanel(secretsStore());
    expect(panelRegistry.panels).toHaveLength(0);
    expect(windowMessages.error.some(text => text.includes('AI 面未配置'))).toBe(true);
  });

  it('配置 endpoint 后开面板:nonce CSP 零外联;二次调用 reveal 不新建', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    const secrets = secretsStore();
    await openAiChatPanel(secrets);
    expect(panelRegistry.panels).toHaveLength(1);
    const panel = panelRegistry.panels[0];
    expect(panel.viewType).toBe('kbengine.ai.chat');
    expect(panel.webview.html).toContain('Content-Security-Policy');
    expect(panel.webview.html).toContain('nonce="');
    expect(panel.webview.html).not.toMatch(/src="http/);
    await openAiChatPanel(secrets);
    expect(panelRegistry.panels).toHaveLength(1);
    expect(panel.revealed).toBe(true);
  });

  it('ask→endpoint 整段上屏:chunk+done,建议面入账', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    await withEndpointFetch('```python\nprint(1)\n```', async () => {
      await openAiChatPanel(secretsStore());
      fire({ type: 'ask', text: '给个示例' });
      await new Promise(resolve => setTimeout(resolve, 60));
    });
    const all = messagesOf();
    expect(all.some(m => m.type === 'chunk')).toBe(true);
    const done = all.find(m => m.type === 'done') as { suggestions?: Array<{ lang: string; code: string }> };
    expect(done).toBeDefined();
    expect(done.suggestions).toEqual([{ lang: 'python', code: 'print(1)\n' }]);
  });

  it('中断:cancel 后 aborted→cancelled 消息,不上假 done', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      })) as typeof fetch;
    try {
      await openAiChatPanel(secretsStore());
      fire({ type: 'ask', text: '慢问题' });
      await new Promise(resolve => setTimeout(resolve, 20));
      fire({ type: 'cancel' });
      await new Promise(resolve => setTimeout(resolve, 40));
    } finally {
      globalThis.fetch = origFetch;
    }
    const all = messagesOf();
    expect(all.some(m => m.type === 'cancelled')).toBe(true);
    expect(all.some(m => m.type === 'done')).toBe(false);
  });

  it('代际守卫:旧代在途被新问取消,旧代结果不上屏', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    const origFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
      calls += 1;
      if (calls === 1) {
        // 第一问:挂起,直到被 abort(代际取消)才拒绝
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        }) as unknown as Promise<Response>;
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'second answer' } }] })
      }) as unknown as Promise<Response>;
    }) as typeof fetch;
    try {
      await openAiChatPanel(secretsStore());
      fire({ type: 'ask', text: '第一问(挂起)' });
      await new Promise(resolve => setTimeout(resolve, 20));
      fire({ type: 'ask', text: '第二问(立即回)' });
      await new Promise(resolve => setTimeout(resolve, 60));
    } finally {
      globalThis.fetch = origFetch;
    }
    const all = messagesOf();
    const done = all.find(m => m.type === 'done') as { gen?: number } | undefined;
    expect(done, '第二问应完成').toBeDefined();
    expect(done!.gen).toBe(2);
    expect(all.filter(m => m.type === 'done')).toHaveLength(1);
  });

  it('lm 路线流式逐 chunk 上屏,中断停收保留已收部分', async () => {
    let token: { isCancellationRequested: boolean } | null = null;
    const makeStream = (): AsyncIterable<{ content?: string }> =>
      ({
        async *[Symbol.asyncIterator]() {
          yield { content: 'part1-' };
          yield { content: 'part2' };
          // 挂起等取消:中断停收,已收部分保留
          while (!token?.isCancellationRequested) {
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          yield { content: 'SHOULD_NOT_APPEAR' };
        }
      }) as AsyncIterable<{ content?: string }>;
    (vscode as { lm?: unknown }).lm = {
      selectChatModels: async () => [
        {
          sendRequest: async (_messages: unknown[], t?: { isCancellationRequested: boolean }) => {
            token = t ?? null;
            return { text: makeStream() };
          }
        }
      ]
    };
    try {
      await openAiChatPanel(secretsStore());
      fire({ type: 'ask', text: '流式问题' });
      await new Promise(resolve => setTimeout(resolve, 40));
      fire({ type: 'cancel' });
      await new Promise(resolve => setTimeout(resolve, 60));
    } finally {
      delete (vscode as { lm?: unknown }).lm;
    }
    const all = messagesOf();
    const chunks = all.filter(m => m.type === 'chunk').map(m => String((m as { text?: string }).text));
    expect(chunks).toEqual(['part1-', 'part2']);
    expect(all.some(m => m.type === 'cancelled')).toBe(true);
    expect(all.some(m => m.type === 'done')).toBe(false);
  });

  it('diff 预览:vscode.diff 携带活动文档与虚拟建议文档,零落盘', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    mountEditor();
    await withEndpointFetch('```python\nprint(1)\n```', async () => {
      await openAiChatPanel(secretsStore());
      fire({ type: 'ask', text: '建议一下' });
      await new Promise(resolve => setTimeout(resolve, 60));
      fire({ type: 'preview', index: 0 });
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(diffCalls).toHaveLength(1);
    const [, right, title] = diffCalls[0].args as [unknown, { scheme?: string; query?: string }, string];
    expect(right.scheme).toBe('kbengine-ai-suggestion');
    expect(right.query).toBe('index=0');
    expect(String(title)).toContain('不落盘');
    const all = messagesOf();
    expect(all.some(m => m.type === 'preview')).toBe(true);
  });

  it('应用:WorkspaceEdit 全文替换活动文档,Ctrl+Z 可撤销的常规通道', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    mountEditor();
    // 建议面来自围栏代码块(无围栏=零建议=无 apply 入口,extract 钉另有专例)
    await withEndpointFetch('```python\nnew content from AI\n```', async () => {
      await openAiChatPanel(secretsStore());
      fire({ type: 'ask', text: '重写这个文件' });
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(applyEditCalls).toHaveLength(0);
      fire({ type: 'apply', index: 0 });
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(applyEditCalls).toHaveLength(1);
    expect(editorDoc.getText()).toBe('new content from AI\n');
    const all = messagesOf();
    const applied = all.find(m => m.type === 'applied') as { uri?: string } | undefined;
    expect(applied).toBeDefined();
    expect(String(applied!.uri)).toContain('Avatar.def');
  });

  it('会话不落盘:历史驻留面板,dispose 即弃;key 不出 SecretStorage 写入面', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    const secrets = secretsStore();
    await secrets.store('kbengine.ai.apiKey', 'sk-test');
    await withEndpointFetch('答', async () => {
      await openAiChatPanel(secrets);
      fire({ type: 'ask', text: '问1' });
      await new Promise(resolve => setTimeout(resolve, 60));
      fire({ type: 'ask', text: '问2' });
      await new Promise(resolve => setTimeout(resolve, 60));
    });
    expect(secrets.map.get('kbengine.ai.apiKey')).toBe('sk-test');
    disposeAiChatPanelForTests();
    expect(panelRegistry.panels[0].disposed).toBe(true);
    // dispose 后重开=全新空会话(历史不复活、不落盘):新首问正常回答
    await openAiChatPanel(secrets);
    await withEndpointFetch('新答', async () => {
      fire({ type: 'ask', text: '新会话首问' });
      await new Promise(resolve => setTimeout(resolve, 60));
    });
    const done = lastMessage();
    expect(done.type).toBe('done');
  });
});
