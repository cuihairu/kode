import { afterEach, describe, expect, it, vi } from 'vitest';

import { Position, makeTextDocument } from './fake-vscode/core';
import { KBEngineCompletionProvider, lspCompletionToVscode } from '../src/languageProviders/completion';
import { KodeCoreGate, type ShadowClientLike } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';

// 2026-11-08 用户令「直接切到 rust」:补全 provider 服务轨道 Rust 优先。
// 验收:Rust 非空条目集即用(Rust 优先);Rust 空集/未判定回 TS 既有链路;
// 非服务轨道零 Rust 调用;LSP→vscode kind 转换(method=2→Method 等)。

const DEF_URI = '/workspace/demo/scripts/entity_defs/Avatar.def';

function makeStubClient() {
  const calls: { method: string; params?: unknown }[] = [];
  const responses = new Map<string, unknown>();
  const client: ShadowClientLike & { calls: { method: string; params?: unknown }[] } = {
    calls,
    start: vi.fn(async () => ({})),
    request: vi.fn(async (method: string) => {
      calls.push({ method: `request:${method}` });
      if (responses.has(method)) {
        return responses.get(method);
      }
      throw new Error(`no stub for ${method}`);
    }),
    dispose: vi.fn(async () => undefined),
    openDocument: vi.fn(() => undefined),
    changeDocument: vi.fn(() => undefined),
    closeDocument: vi.fn(() => undefined),
  };
  return { client, responses };
}

function makeGate(client: ShadowClientLike, backend = 'rust'): KodeCoreGate {
  const gate = new KodeCoreGate({ clientFactory: () => client });
  gate.setConfig({ backend, serverPath: 'node:stub', shadowTimeoutMs: 500 });
  return gate;
}

function makeDefDocument(lineText: string) {
  return makeTextDocument(lineText + '\n', {
    fileName: DEF_URI,
    languageId: 'kbengine-def',
    version: 1
  });
}

afterEach(() => {
  setKodeCoreShadowGate(null);
});

describe('补全服务轨道 Rust 优先', () => {
  it('Rust 非空条目集:provider 返回转换后的 vscode 项(Rust 优先,不落 TS)', async () => {
    const { client, responses } = makeStubClient();
    responses.set('textDocument/completion', {
      isIncomplete: false,
      items: [
        { label: 'hp', kind: 10, detail: 'int' },
        { label: 'onEnterWorld', kind: 2 },
        { label: 'Avatar', kind: 7 },
      ],
    });
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineCompletionProvider();
    const document = makeDefDocument('        <Properties>');
    const items = (await provider.provideCompletionItems(document, new Position(0, 19))) as {
      label: string;
      kind?: number;
      detail?: string;
    }[];
    expect(items.map(item => item.label)).toEqual(['hp', 'onEnterWorld', 'Avatar']);
    // kind 转换:LSP method=2 → vscode Method(1);property=10 → Property(9);Class=7 → 6
    expect(items[0].kind).toBe(9);
    expect(items[1].kind).toBe(1);
    expect(items[2].kind).toBe(6);
    expect(items[0].detail).toBe('int');
    // 请求与镜像已发;未落 TS 路径(只有一次 completion 请求)
    expect(client.calls.some(call => call.method === 'request:textDocument/completion')).toBe(true);
    expect(client.calls.filter(call => call.method === 'request:textDocument/completion')).toHaveLength(1);
  });

  it('Rust 空集(items=[]):回 TS 既有链路(Rust 判了上下文但无条目 → TS 接管)', async () => {
    const { client, responses } = makeStubClient();
    responses.set('textDocument/completion', { isIncomplete: false, items: [] });
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineCompletionProvider();
    // def 顶层 `<` → TS getDefTagCompletionLabels(非 Rust 面,Rust 空集回 TS)
    const document = makeDefDocument('    <');
    const items = (await provider.provideCompletionItems(document, new Position(0, 5))) as {
      label: string;
    }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some(item => item.label === 'Parent')).toBe(true);
  });

  it('Rust 未判定(null):回 TS 既有链路', async () => {
    const { client, responses } = makeStubClient();
    responses.set('textDocument/completion', null);
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineCompletionProvider();
    const document = makeDefDocument('    <');
    const items = (await provider.provideCompletionItems(document, new Position(0, 5))) as {
      label: string;
    }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some(item => item.label === 'Parent')).toBe(true);
  });

  it('非服务轨道(ts):零 Rust 调用,走 TS 链路', async () => {
    const { client } = makeStubClient();
    setKodeCoreShadowGate(makeGate(client, 'ts'));
    const provider = new KBEngineCompletionProvider();
    const document = makeDefDocument('    <');
    const items = (await provider.provideCompletionItems(document, new Position(0, 5))) as {
      label: string;
    }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some(item => item.label === 'Parent')).toBe(true);
    expect(client.calls.some(call => call.method === 'request:textDocument/completion')).toBe(false);
  });

  it('门未装配:零 Rust 调用,走 TS 链路', async () => {
    const provider = new KBEngineCompletionProvider();
    const document = makeDefDocument('    <');
    const items = (await provider.provideCompletionItems(document, new Position(0, 5))) as {
      label: string;
    }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some(item => item.label === 'Parent')).toBe(true);
  });

  it('Rust 请求失败:serveInRust 兜底 null → TS 接管,不抛', async () => {
    const { client } = makeStubClient();
    // 不设 response → request 抛 'no stub'
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineCompletionProvider();
    const document = makeDefDocument('    <');
    const items = (await provider.provideCompletionItems(document, new Position(0, 5))) as {
      label: string;
    }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some(item => item.label === 'Parent')).toBe(true);
  });
});

describe('lspCompletionToVscode 转换', () => {
  it('kind 数值映射:2→Method(1)/7→Class(6)/10→Property(9)/其他→Class(6)', () => {
    const items = lspCompletionToVscode({
      isIncomplete: false,
      items: [
        { label: 'm', kind: 2 },
        { label: 't', kind: 7 },
        { label: 'p', kind: 10 },
        { label: 'x', kind: 99 },
      ],
    });
    expect(items.map(item => item.kind)).toEqual([1, 6, 9, 6]);
  });

  it('detail 透传;无 detail 不设', () => {
    const items = lspCompletionToVscode({
      isIncomplete: false,
      items: [
        { label: 'a', kind: 10, detail: 'int' },
        { label: 'b', kind: 2 },
      ],
    });
    expect(items[0].detail).toBe('int');
    expect(items[1].detail).toBeUndefined();
  });
});
