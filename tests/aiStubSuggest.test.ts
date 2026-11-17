import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  AI_SUGGEST_STUB_COMMAND,
  disposeAiStubSuggestForTests,
  extractStubTemplateSection
} from '../src/ai/aiStubSuggest';
import { registerAiCommands } from '../src/ai/aiRegistration';

// AI-004 stub/typings 建议层测试:模板真源(typings/ 钉死 fork commit)口径
// 不动——本层对真源文件零写入,建议只进只读虚拟 scheme 的 diff 预览(左=
// 真源原段,右=AI 建议段);片段最小化=只发选中成员段。fetch 注入桩,零
// 真实外发;模板真源用 tmpdir 替身(extensionPath 注入),真字节断言不变。

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

const makeExtension = (): { extensionPath: string; templateFile: string; templateText: string } => {
  const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ai004-'));
  const templateRoot = path.join(extensionPath, 'typings');
  fs.mkdirSync(templateRoot, { recursive: true });
  const templateText = [
    '# KBEngine.pyi — kode generated',
    'class Avatar:',
    '    def foo(self) -> None: ...',
    '',
    'def registerEvent(entity: object, event: str, callback: object) -> None:',
    '    ...',
    '',
    'def deregisterEvent(entity: object, event: str) -> None:',
    '    ...',
    ''
  ].join('\n');
  const templateFile = path.join(templateRoot, 'KBEngine.pyi');
  fs.writeFileSync(templateFile, templateText);
  return { extensionPath, templateFile, templateText };
};

const stubDoc = makeTextDocument(
  ['def registerEvent(entity, event, callback):', '    ...', ''].join('\n'),
  { fileName: '/w/.kbengine/stubs/KBEngine.pyi', languageId: 'python', version: 1 }
);

const mountStubEditorAt = (line: number, character: number): void => {
  (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
    document: stubDoc,
    selection: { active: new vscode.Position(line, character) }
  };
};

const diffCalls: Array<{ command: string; args: unknown[] }> = [];

const runSuggestStub = async (): Promise<void> => {
  await commands.executeCommand(AI_SUGGEST_STUB_COMMAND, 'registerEvent');
  await new Promise(resolve => setTimeout(resolve, 40));
};

const withFetch = async (reply: string, body: () => Promise<void>): Promise<void> => {
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

beforeEach(() => {
  commands.registerCommand('vscode.diff', (...args: unknown[]) => {
    diffCalls.push({ command: 'vscode.diff', args });
    return undefined;
  });
});

afterEach(() => {
  disposeAiStubSuggestForTests();
  commandRegistry.reset();
  subscriptions.length = 0;
  diffCalls.length = 0;
  configurationOverrides.delete('kbengine.ai');
  delete (vscode.window as { activeTextEditor?: unknown }).activeTextEditor;
});

describe('AI-004 extractStubTemplateSection(段边界,不猜)', () => {
  it('顶层 def 段:到下一个同级 def 止(不含;段尾空行回缩)', () => {
    const text = ['def a():', '    ...', '', 'def b():', '    ...', ''].join('\n');
    const section = extractStubTemplateSection(text, 'a');
    expect(section).not.toBeNull();
    expect(section!.text).toBe('def a():\n    ...');
    expect(section!.startLine).toBe(0);
    expect(section!.endLine).toBe(2);
  });

  it('装饰器行并入段起点(签名完整可喂)', () => {
    const text = ['@overload', 'def a(x: int) -> int: ...', '', 'def b(): ...', ''].join('\n');
    const section = extractStubTemplateSection(text, 'a');
    expect(section!.startLine).toBe(0);
    expect(section!.text).toBe('@overload\ndef a(x: int) -> int: ...');
  });

  it('类成员段:到下一个同级定义止,忠实保留原缩进', () => {
    const text = [
      'class Avatar:',
      '    def foo(self) -> None: ...',
      '    def bar(self) -> None: ...',
      '',
      'class Base: ...',
      ''
    ].join('\n');
    const section = extractStubTemplateSection(text, 'foo');
    expect(section!.text).toBe('    def foo(self) -> None: ...');
    expect(section!.startLine).toBe(1);
    expect(section!.endLine).toBe(2);
  });

  it('找不到成员返回 null(不猜)', () => {
    expect(extractStubTemplateSection('def a(): ...', 'missing')).toBeNull();
  });
});

describe('AI-004 suggestStub 命令(真源零写入,diff 只读预览)', () => {
  it('执行:真源段喂 AI,diff 左=真源原段右=AI 建议段,真源字节不变', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    const ext = makeExtension();
    mountStubEditorAt(0, 4);
    const before = fs.readFileSync(ext.templateFile);
    await registerAiCommands({ subscriptions, extensionPath: ext.extensionPath } as never, secretsStore());
    const suggestion = 'def registerEvent(entity: object, event: str, callback: object) -> None:\n    """注册事件回调。"""\n    ...';
    await withFetch(`补注释如下。\n\`\`\`python\n${suggestion}\n\`\`\``, runSuggestStub);
    expect(diffCalls).toHaveLength(1);
    const [left, right, title] = diffCalls[0].args as [
      { scheme?: string; query?: string },
      { scheme?: string; query?: string },
      string
    ];
    expect(left.scheme).toBe('kbengine-ai-stub');
    expect(left.query).toBe('side=source');
    expect(right.scheme).toBe('kbengine-ai-stub');
    expect(right.query).toBe('side=suggestion');
    expect(String(title)).toContain('read-only');
    const providers = workspaceState.contentProviders as Map<string, { provideTextDocumentContent(uri: { query?: string }): string }>;
    const provider = providers.get('kbengine-ai-stub');
    expect(provider).toBeDefined();
    expect(provider!.provideTextDocumentContent({ query: 'side=source' })).toBe(
      'def registerEvent(entity: object, event: str, callback: object) -> None:\n    ...'
    );
    expect(provider!.provideTextDocumentContent({ query: 'side=suggestion' })).toBe(`${suggestion}\n`);
    expect(fs.readFileSync(ext.templateFile).equals(before)).toBe(true);
    fs.rmSync(ext.extensionPath, { recursive: true, force: true });
  });

  it('模板真源不可读:诚实报错零 diff', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    await registerAiCommands({ subscriptions, extensionPath: '/nonexistent-ext' } as never, secretsStore());
    await runSuggestStub();
    expect(diffCalls).toHaveLength(0);
    expect(windowMessages.error.some(text => text.includes('不可读'))).toBe(true);
  });

  it('模板真源缺成员:诚实提示不猜', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    const ext = makeExtension();
    await registerAiCommands({ subscriptions, extensionPath: ext.extensionPath } as never, secretsStore());
    await commands.executeCommand(AI_SUGGEST_STUB_COMMAND, 'nonexistentMember');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(diffCalls).toHaveLength(0);
    expect(windowMessages.info.some(text => text.includes('未找到成员'))).toBe(true);
    fs.rmSync(ext.extensionPath, { recursive: true, force: true });
  });

  it('AI 回复无围栏:诚实提示零 diff', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    const ext = makeExtension();
    await registerAiCommands({ subscriptions, extensionPath: ext.extensionPath } as never, secretsStore());
    await withFetch('只有文字,没有代码。', runSuggestStub);
    expect(diffCalls).toHaveLength(0);
    expect(windowMessages.info.some(text => text.includes('未包含代码建议'))).toBe(true);
    fs.rmSync(ext.extensionPath, { recursive: true, force: true });
  });

  it('AI 请求失败:错误消息带原因零 diff', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    const ext = makeExtension();
    await registerAiCommands({ subscriptions, extensionPath: ext.extensionPath } as never, secretsStore());
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<unknown> => {
      throw new Error('connection refused');
    }) as typeof fetch;
    try {
      // 网络错误走 maxRetries 重试(默认退避 250ms 起),等足重试+错误落地
      await commands.executeCommand(AI_SUGGEST_STUB_COMMAND, 'registerEvent');
      await new Promise(resolve => setTimeout(resolve, 700));
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(diffCalls).toHaveLength(0);
    expect(windowMessages.error.some(text => text.includes('connection refused'))).toBe(true);
    fs.rmSync(ext.extensionPath, { recursive: true, force: true });
  });

  it('命令二次闸:配置被清空后执行诚实报错', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    const ext = makeExtension();
    await registerAiCommands({ subscriptions, extensionPath: ext.extensionPath } as never, secretsStore());
    configurationOverrides.delete('kbengine.ai');
    await runSuggestStub();
    expect(diffCalls).toHaveLength(0);
    expect(windowMessages.error.some(text => text.includes('AI 面未配置'))).toBe(true);
    fs.rmSync(ext.extensionPath, { recursive: true, force: true });
  });

  it('无成员名且无活动 .pyi 编辑器:诚实提示零 diff', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    const ext = makeExtension();
    await registerAiCommands({ subscriptions, extensionPath: ext.extensionPath } as never, secretsStore());
    await commands.executeCommand(AI_SUGGEST_STUB_COMMAND);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(diffCalls).toHaveLength(0);
    expect(windowMessages.info.some(text => text.includes('成员名'))).toBe(true);
    fs.rmSync(ext.extensionPath, { recursive: true, force: true });
  });
});
