import { afterEach, describe, expect, it, vi } from 'vitest';

import { Position, makeTextDocument } from './fake-vscode/core';
import { KBEngineHoverProvider } from '../src/languageProviders/hover';
import { KodeCoreGate, type ShadowClientLike } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';

// 2026-11-08 用户令「直接切到 rust」:悬停 provider 服务轨道 Rust 优先。
// 验收:Rust 命中即 markdown 直出 vscode.Hover(不落 TS,镜像以编辑器内容
// 为准);Rust null/畸形应答经 rustHoverAttempted 重入 TS 既有链恰好一次
// (防重入);python 文档零请求直通 TS;非语料文档零请求(语料闸在镜像前);
// 非服务轨道(backend=ts)零 Rust 调用,结果与无门基线一致。

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
    openDocument: vi.fn((uri: string, languageId: string, version: number, text: string) => {
      calls.push({ method: 'openDocument', params: { uri, languageId, version, text } });
      return undefined;
    }),
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

/** Rust 命中面返回的 markdown(kode-server render_markdown 同形) */
const RUST_MARKDOWN = '**hp**\n\n**Type**: `UINT32`\n\n**Flags**: `ALL_CLIENTS`';

const hoverText = (hover: unknown): string => {
  if (!hover || typeof hover !== 'object') {
    return '';
  }
  const contents = (hover as { contents: unknown }).contents;
  if (Array.isArray(contents)) {
    return contents
      .map(item => (typeof item === 'string' ? item : String((item as { value?: string }).value ?? '')))
      .join('');
  }
  if (contents && typeof contents === 'object' && 'value' in contents) {
    return String((contents as { value: string }).value);
  }
  return typeof contents === 'string' ? contents : '';
};

afterEach(() => {
  setKodeCoreShadowGate(null);
});

describe('悬停服务轨道 Rust 优先', () => {
  it('Rust 命中:markdown 直出 vscode.Hover,不落 TS(单请求,镜像编辑器内容)', async () => {
    const { client, responses } = makeStubClient();
    responses.set('textDocument/hover', { contents: { kind: 'markdown', value: RUST_MARKDOWN } });
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineHoverProvider();
    const spy = vi.spyOn(provider, 'provideHoverTimed');
    const document = makeDefDocument('    <hp>');
    const hover = await provider.provideHoverTimed(document, new Position(0, 6));

    expect(hoverText(hover)).toBe(RUST_MARKDOWN);
    expect(client.calls.filter(call => call.method === 'request:textDocument/hover')).toHaveLength(1);
    // 镜像腿:未保存修订以编辑器内容为准(uri/语言/版本/全文直传)
    const mirror = client.calls.find(call => call.method === 'openDocument');
    expect(mirror?.params).toMatchObject({ uri: DEF_URI, languageId: 'kbengine-def', version: 1, text: '    <hp>\n' });
    // Rust 命中即用:无 TS 重入(provideHoverTimed 仅入口一次)
    expect(spy.mock.calls).toHaveLength(1);
  });

  it('Rust null(词未知):重入 TS 链恰好一次,不再重试 Rust', async () => {
    const { client, responses } = makeStubClient();
    responses.set('textDocument/hover', null);
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineHoverProvider();
    const spy = vi.spyOn(provider, 'provideHoverTimed');
    const document = makeDefDocument('    <hp>');
    const result = await provider.provideHoverTimed(document, new Position(0, 6));

    // Rust 只试一次:重入参数 rustHoverAttempted=true,防 miss 循环
    expect(client.calls.filter(call => call.method === 'request:textDocument/hover')).toHaveLength(1);
    expect(spy.mock.calls).toHaveLength(2);
    expect(spy.mock.calls[0][4]).toBeUndefined();
    expect(spy.mock.calls[1][4]).toBe(true);
    // TS 链结果与无门基线一致(本词无 manager 注入,双侧同为 null 面)
    const plain = await new KBEngineHoverProvider().provideHoverTimed(document, new Position(0, 6));
    expect(result).toEqual(plain);
  });

  it('Rust 畸形应答(contents 缺 value):整面作废,重入 TS 链', async () => {
    const { client, responses } = makeStubClient();
    responses.set('textDocument/hover', { contents: { kind: 'markdown' } });
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineHoverProvider();
    const spy = vi.spyOn(provider, 'provideHoverTimed');
    const document = makeDefDocument('    <hp>');
    await provider.provideHoverTimed(document, new Position(0, 6));

    expect(client.calls.filter(call => call.method === 'request:textDocument/hover')).toHaveLength(1);
    expect(spy.mock.calls).toHaveLength(2);
    expect(spy.mock.calls[1][4]).toBe(true);
  });

  it('python 文档:无调用候选零请求(预检闸);调用候选恰一次 localReturnType,零镜像', async () => {
    const { client } = makeStubClient();
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineHoverProvider();
    const spy = vi.spyOn(provider, 'provideHoverTimed');
    // 无调用形写候选(自属性写点):预检闸零成本跳过 Rust 腿——零请求(批 D)
    const attrDoc = makeTextDocument('self.hp = 1\n', {
      fileName: '/workspace/demo/scripts/base/Avatar.py',
      languageId: 'python',
      version: 1
    });
    await provider.provideHoverTimed(attrDoc, new Position(0, 5));
    expect(client.calls).toHaveLength(0);
    expect(spy.mock.calls).toHaveLength(1);

    // 调用形写候选:localReturnType 腿恰一次请求;语料镜像仍零参与
    // (miss 后重入走下游链,spy 计 2 次进面)
    const varDoc = makeTextDocument('data = get_data()\n', {
      fileName: '/workspace/demo/scripts/base/Avatar.py',
      languageId: 'python',
      version: 1
    });
    await provider.provideHoverTimed(varDoc, new Position(0, 2));
    expect(client.calls.filter(call => call.method === 'request:textDocument/hover')).toHaveLength(0);
    expect(client.calls.filter(call => call.method === 'request:$/kode/rpc')).toHaveLength(1);
    // spy 总计 3:attrDoc 1 次 + varDoc 2 次(初试 + miss 重入,无再入环)
    expect(spy.mock.calls).toHaveLength(3);
  });

  it('非语料文档(plaintext):零请求,语料闸在镜像前回落 TS', async () => {
    const { client } = makeStubClient();
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineHoverProvider();
    const spy = vi.spyOn(provider, 'provideHoverTimed');
    const document = makeTextDocument('hello world\n', {
      fileName: '/workspace/notes.txt',
      languageId: 'plaintext',
      version: 1
    });
    await provider.provideHoverTimed(document, new Position(0, 1));

    // 语料闸拦在镜像之前:零镜像零请求;重入 TS 链一次
    expect(client.calls).toHaveLength(0);
    expect(spy.mock.calls).toHaveLength(2);
    expect(spy.mock.calls[1][4]).toBe(true);
  });

  it('非服务轨道(backend=ts):零 Rust 调用,结果与无门基线一致', async () => {
    const { client } = makeStubClient();
    setKodeCoreShadowGate(makeGate(client, 'ts'));
    const provider = new KBEngineHoverProvider();
    const document = makeDefDocument('    <hp>');
    const result = await provider.provideHoverTimed(document, new Position(0, 6));

    expect(client.calls).toHaveLength(0);
    const plain = await new KBEngineHoverProvider().provideHoverTimed(document, new Position(0, 6));
    expect(result).toEqual(plain);
  });
});
