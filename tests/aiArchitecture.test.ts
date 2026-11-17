import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as vscode from 'vscode';

import {
  commandRegistry,
  commands,
  configurationOverrides,
  messages as windowMessages,
  workspaceState
} from './helpers/vscodeStub';

import {
  AI_ANALYZE_ARCHITECTURE_COMMAND,
  ARCHITECTURE_DIGEST_BUDGET,
  disposeAiArchitectureForTests,
  registerAiArchitecture,
  summarizeDependencyGraph
} from '../src/ai/aiArchitecture';
import type { DependencyGraphRust } from '../src/backend/dependencyGraphRust';

// AI-005 架构分析测试:summarizeDependencyGraph 纯函数面(计数行/实体清单/
// 边按 kind 分组+label/预算截断显式声明)+ 命令臂(deps 注入假图,零真实
// 依赖图构建;fetch 注入桩零真实外发;报告走只读虚拟 scheme 预览零落盘)。

const fakeGraph = (over: Partial<DependencyGraphRust> = {}): DependencyGraphRust => ({
  nodes: [
    { id: 'entity:Avatar', kind: 'entity', name: 'Avatar', filePath: '/w/scripts/avatar.py' },
    { id: 'entity:Base', kind: 'entity', name: 'Base', filePath: '/w/scripts/base.py' },
    { id: 'def:foo', kind: 'def', name: 'foo', filePath: '/w/scripts/foo.py' }
  ],
  edges: [
    { from: 'Avatar', to: 'Base', kind: 'inherit', label: 'Avatar.base' },
    { from: 'Avatar', to: 'BaseAccount', kind: 'has-a' }
  ],
  reverseEdges: {},
  paths: { entitiesXml: '/w/res/scripts/entities.xml', defsRoot: '/w/scripts', typesXml: '' },
  stats: {
    nodeCount: 3,
    edgeCount: 2,
    entityCount: 2,
    defCount: 1,
    interfaceCount: 0,
    componentCount: 0,
    typeCount: 0,
    pythonCount: 0
  },
  ...over
});

const subscriptions: unknown[] = [];

const previewCalls: Array<{ command: string; args: unknown[] }> = [];

interface CapturedRequest {
  url: string;
  body: { messages: Array<{ role: string; content: string }> };
}

/** fetch 替身:记录 POST body 以断言摘要真实喂入;按需可令其失败 */
const withFetch = async (
  impl: (() => Promise<unknown> | unknown) | Record<string, unknown>,
  body: (calls: CapturedRequest[]) => Promise<void>
): Promise<void> => {
  const calls: CapturedRequest[] = [];
  const step = typeof impl === 'function' ? impl : () => impl;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit): Promise<unknown> => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as CapturedRequest['body']
    });
    return step();
  }) as typeof fetch;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = origFetch;
  }
};

const runCommand = async (): Promise<void> => {
  await commands.executeCommand(AI_ANALYZE_ARCHITECTURE_COMMAND);
  await new Promise(resolve => setTimeout(resolve, 40));
};

const setWorkspace = (root: string | null): void => {
  (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = root
    ? [{ uri: { fsPath: root, scheme: 'file' }, name: 'w', index: 0 }]
    : [];
};

beforeEach(() => {
  commands.registerCommand('markdown.showPreview', (...args: unknown[]) => {
    previewCalls.push({ command: 'markdown.showPreview', args });
    return undefined;
  });
});

afterEach(() => {
  disposeAiArchitectureForTests();
  commandRegistry.reset();
  subscriptions.length = 0;
  previewCalls.length = 0;
  configurationOverrides.delete('kbengine.ai');
  setWorkspace(null);
});

describe('AI-005 summarizeDependencyGraph(纯函数面)', () => {
  it('计数行+实体清单+边按 kind 分组(label 优先)', () => {
    const { digest, truncated } = summarizeDependencyGraph(fakeGraph());
    expect(truncated).toBe(false);
    expect(digest).toContain(
      'Graph stats: 3 nodes (2 entities, 1 defs, 0 interfaces, 0 components, 0 types, 0 python), 2 edges.'
    );
    expect(digest).toContain('Entities (2): Avatar, Base');
    expect(digest).toContain('Edges has-a (first 1): Avatar -[has-a]-> BaseAccount');
    expect(digest).toContain('Edges inherit (first 1): Avatar -[Avatar.base]-> Base');
  });

  it('kind 分组按字典序出牌', () => {
    const graph = fakeGraph({
      edges: [
        { from: 'A', to: 'B', kind: 'inherit' },
        { from: 'A', to: 'C', kind: 'has-a' }
      ]
    });
    const { digest } = summarizeDependencyGraph(graph);
    expect(digest.indexOf('Edges has-a')).toBeLessThan(digest.indexOf('Edges inherit'));
  });

  it('每 kind 最多 60 条示例(预算受控)', () => {
    const edges = Array.from({ length: 65 }, (_, i) => ({ from: 'A', to: `T${i}`, kind: 'link' }));
    const { digest } = summarizeDependencyGraph(fakeGraph({ edges, stats: { ...fakeGraph().stats, edgeCount: 65 } }));
    expect(digest).toContain('Edges link (first 60)');
    expect(digest).not.toContain('Edges link (first 65)');
  });

  it('超预算截断显式声明(绝不静默)', () => {
    const { digest, truncated } = summarizeDependencyGraph(fakeGraph(), 100);
    expect(truncated).toBe(true);
    expect(digest.endsWith('...[truncated]')).toBe(true);
    expect(digest.length).toBe(100 + '\n...[truncated]'.length);
    expect(ARCHITECTURE_DIGEST_BUDGET).toBe(12000);
  });
});

describe('AI-005 analyzeArchitecture 命令(假图注入,报告零落盘)', () => {
  it('成功臂:摘要作为 user 消息喂入,报告进只读虚拟 scheme 预览', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    setWorkspace('/w');
    const graph = fakeGraph();
    registerAiArchitecture({ subscriptions } as never, {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined
    }, { buildGraph: async () => graph });
    const reply = '# 架构报告\n\nAvatar 继承 Base。';
    await withFetch(
      { ok: true, json: async () => ({ choices: [{ message: { content: reply } }] }) },
      async calls => {
        await runCommand();
        // 摘要确实作为 user 消息喂入(数据真源在引擎,prompt 不发散源码)
        expect(calls).toHaveLength(1);
        expect(calls[0].body.messages[0].role).toBe('system');
        expect(calls[0].body.messages[0].content).toContain('数据真源在引擎');
        expect(calls[0].body.messages[1].role).toBe('user');
        expect(calls[0].body.messages[1].content).toBe(summarizeDependencyGraph(graph).digest);
      }
    );
    const providers = workspaceState.contentProviders as Map<string, { provideTextDocumentContent(uri: unknown): string }>;
    const provider = providers.get('kbengine-ai-architecture');
    expect(provider).toBeDefined();
    expect(provider!.provideTextDocumentContent({})).toBe(reply);
    expect(previewCalls).toHaveLength(1);
    const [uri, options] = previewCalls[0].args as [{ scheme?: string }, { preserveFocus?: boolean }];
    expect(uri.scheme).toBe('kbengine-ai-architecture');
    expect(options.preserveFocus).toBe(true);
  });

  it('无工作区:诚实提示,不建图不外发', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    setWorkspace(null);
    let built = 0;
    registerAiArchitecture({ subscriptions } as never, {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined
    }, { buildGraph: async () => { built += 1; return fakeGraph(); } });
    await withFetch({ ok: true, json: async () => ({}) }, async () => {
      await runCommand();
    });
    expect(built).toBe(0);
    expect(previewCalls).toHaveLength(0);
    expect(windowMessages.info.some(text => text.includes('没有打开的工作区'))).toBe(true);
  });

  it('依赖图不可用(null):诚实提示零外发', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    setWorkspace('/w');
    registerAiArchitecture({ subscriptions } as never, {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined
    }, { buildGraph: async () => null });
    let fetched = 0;
    await withFetch(() => {
      fetched += 1;
      return { ok: true, json: async () => ({}) };
    }, async () => {
      await runCommand();
    });
    expect(fetched).toBe(0);
    expect(previewCalls).toHaveLength(0);
    expect(windowMessages.info.some(text => text.includes('依赖图不可用'))).toBe(true);
  });

  it('AI 失败:诚实报错,零预览零落盘', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    setWorkspace('/w');
    registerAiArchitecture({ subscriptions } as never, {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined
    }, { buildGraph: async () => fakeGraph() });
    await withFetch(() => {
      throw new Error('connection refused');
    }, async () => {
      await runCommand();
      // 重试退避(250ms 起步)等错误落地
      await new Promise(resolve => setTimeout(resolve, 700));
    });
    expect(previewCalls).toHaveLength(0);
    expect(windowMessages.error.some(text => text.includes('AI 架构分析失败'))).toBe(true);
  });

  it('二次闸:注册后配置清空,handler 拒绝执行', async () => {
    configurationOverrides.set('kbengine.ai', { baseUrl: 'http://127.0.0.1:9' });
    setWorkspace('/w');
    let built = 0;
    registerAiArchitecture({ subscriptions } as never, {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined
    }, { buildGraph: async () => { built += 1; return fakeGraph(); } });
    configurationOverrides.delete('kbengine.ai');
    await runCommand();
    expect(built).toBe(0);
    expect(previewCalls).toHaveLength(0);
    expect(windowMessages.error.some(text => text.includes('AI 面未配置'))).toBe(true);
  });
});
