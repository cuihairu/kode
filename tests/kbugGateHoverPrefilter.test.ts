import { afterEach, describe, expect, it, vi } from 'vitest';

import { Position, makeTextDocument } from './fake-vscode/core';
import { KBEngineHoverProvider } from '../src/languageProviders/hover';
import { KodeCoreGate, type ShadowClientLike } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { hasLocalReturnCandidate, matchingAssignments } from '../src/backend/pythonReturnTypeInference';

// KBUG-GATE(账本 2026-11-12,审计基线 10f4b85e):hover 预检「单层调用」
// 正则在生产入口吞掉 Rust 已支持的别名链(x = alias)与链式调用
// (x = build().load())——Rust 根本收不到查询。修复 = 预检改存在性口径
// (作用域内有同名写点即放行,形态裁定归 Rust);伪赋值(字符串/注释,掩码)
// 与非法查询仍零 RPC 快跳;miss 后重入恰一次(无重复查询);大文件无候选
// 零请求有界耗时,重复查询请求量恒定。

const PY_URI = '/workspace/demo/scripts/base/Avatar.py';

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

function makePyDoc(text: string) {
  return makeTextDocument(text, {
    fileName: PY_URI,
    languageId: 'python',
    version: 1
  });
}

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

const ALIAS_DOC = 'alias = build_original()\nx = alias\n';

afterEach(() => {
  setKodeCoreShadowGate(null);
});

describe('KBUG-GATE:悬停预检放行 Rust 腿(provider 层)', () => {
  it('别名链写点放行:Rust 面被调用且结果直出 hover(GATE-01)', async () => {
    const { client, responses } = makeStubClient();
    responses.set('$/kode/rpc', { ret: { target: 'x', annotation: 'PAYLOAD', methodName: 'build_original' } });
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineHoverProvider();
    const spy = vi.spyOn(provider, 'provideHoverTimed');
    const document = makePyDoc(ALIAS_DOC);
    const hover = await provider.provideHoverTimed(document, new Position(1, 0));

    // 修前:预检 parseLocalAssignmentCall('x = alias') 为空 → 零 RPC,
    // 别名链面在生产入口被吞(账本缺陷本体)
    expect(client.calls.filter(call => call.method === 'request:$/kode/rpc')).toHaveLength(1);
    expect(client.calls.filter(call => call.method === 'request:textDocument/hover')).toHaveLength(0);
    expect(hoverText(hover)).toBe('**x: PAYLOAD**\n\n推导自 build_original() 返回注解');
    // 命中无 TS 重入
    expect(spy.mock.calls).toHaveLength(1);
  });

  it('链式调用写点放行:Rust 面被调用且结果直出 hover(GATE-01)', async () => {
    const { client, responses } = makeStubClient();
    responses.set('$/kode/rpc', { ret: { target: 'x', annotation: 'DATA', methodName: 'load' } });
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineHoverProvider();
    const document = makePyDoc('x = build().load()\n');
    const hover = await provider.provideHoverTimed(document, new Position(0, 0));

    // 修前:rhs 含点号被 SIMPLE/ATTRIBUTE 双正则否决 → 零 RPC
    expect(client.calls.filter(call => call.method === 'request:$/kode/rpc')).toHaveLength(1);
    expect(hoverText(hover)).toBe('**x: DATA**\n\n推导自 load() 返回注解');
  });

  it('伪赋值快跳:字符串/注释体内同名写不触发 Rust 腿(GATE-02)', async () => {
    const { client } = makeStubClient();
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineHoverProvider();
    const spy = vi.spyOn(provider, 'provideHoverTimed');
    const document = makePyDoc('s = "x = build_original()"\n# x = build_original()\n');
    await provider.provideHoverTimed(document, new Position(0, 5));
    await provider.provideHoverTimed(document, new Position(1, 2));

    // 掩码后无真实同名写点:零请求,预检关闭不重入(spy 每 hover 一次)
    expect(client.calls).toHaveLength(0);
    expect(spy.mock.calls).toHaveLength(2);
  });

  it('非法查询快跳:常量名走 RPC 装配守卫零请求,下游照走(GATE-02)', async () => {
    const { client } = makeStubClient();
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineHoverProvider();
    const spy = vi.spyOn(provider, 'provideHoverTimed');
    const document = makePyDoc('CACHE = build_original()\n');
    await provider.provideHoverTimed(document, new Position(0, 3));

    // 预检放行(写点存在,存在性口径不克隆形态判定),常量守卫在 RPC
    // 装配面(inferLocalReturnTypeFromRust)零请求;TS 链常量守卫同空 →
    // 重入下游恰一次,无伪类型面
    expect(client.calls).toHaveLength(0);
    expect(spy.mock.calls).toHaveLength(2);
    expect(spy.mock.calls[1][5]).toBe(true);
  });

  it('作用域内无同名写点零请求(GATE-02)', async () => {
    const { client } = makeStubClient();
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineHoverProvider();
    const spy = vi.spyOn(provider, 'provideHoverTimed');
    const document = makePyDoc('print(x)\n');
    const result = await provider.provideHoverTimed(document, new Position(0, 6));

    expect(client.calls).toHaveLength(0);
    expect(spy.mock.calls).toHaveLength(1);
    expect(result ?? null).toBeNull();
  });

  it('Rust null:重入下游恰一次,无重复查询、无伪类型(GATE-04)', async () => {
    const { client, responses } = makeStubClient();
    responses.set('$/kode/rpc', { ret: null });
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineHoverProvider();
    const spy = vi.spyOn(provider, 'provideHoverTimed');
    const document = makePyDoc(ALIAS_DOC);
    const result = await provider.provideHoverTimed(document, new Position(1, 0));

    // miss 只查一次 Rust;重入参数 localReturnAttempted=true 防再入环
    expect(client.calls.filter(call => call.method === 'request:$/kode/rpc')).toHaveLength(1);
    expect(spy.mock.calls).toHaveLength(2);
    expect(spy.mock.calls[1][4]).toBeUndefined();
    expect(spy.mock.calls[1][5]).toBe(true);
    // 双链推不出 → 诚实无类型段(不显 Any/不显空类型)
    expect(result ?? null).toBeNull();
  });

  it('同版本重复查询:请求量恒定每 hover 恰一次(GATE-05)', async () => {
    const { client, responses } = makeStubClient();
    responses.set('$/kode/rpc', { ret: { target: 'x', annotation: 'PAYLOAD', methodName: 'build_original' } });
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineHoverProvider();
    const document = makePyDoc(ALIAS_DOC);
    for (let i = 0; i < 5; i += 1) {
      await provider.provideHoverTimed(document, new Position(1, 0));
    }

    // 无重入累积/无查询放大:5 次 hover = 5 次 RPC(每次 1 次扫描 + 1 次请求)
    expect(client.calls.filter(call => call.method === 'request:$/kode/rpc')).toHaveLength(5);
  });

  it('大文件无同名写点:零请求且有界耗时(GATE-05)', async () => {
    const { client } = makeStubClient();
    setKodeCoreShadowGate(makeGate(client));
    const provider = new KBEngineHoverProvider();
    const lines: string[] = [];
    for (let i = 0; i < 20000; i += 1) {
      lines.push(`data_${i} = make_${i}()`);
    }
    lines.push('print(ghost)');
    const document = makePyDoc(lines.join('\n') + '\n');
    const started = Date.now();
    const result = await provider.provideHoverTimed(document, new Position(20000, 6));
    const elapsedMs = Date.now() - started;

    // ghost 无同名写点:预检关闭零 RPC;掩码+上扫单次有界(非逐 hover 无界放大)
    expect(client.calls).toHaveLength(0);
    expect(result ?? null).toBeNull();
    // 宽松上界防无界重扫回归;实测值打印留痕(20k 行掩码一次 + 向上单趟)
    // eslint-disable-next-line no-console
    console.log(`[kbug-gate] 20k 行无候选 hover 耗时 ${elapsedMs}ms`);
    expect(elapsedMs).toBeLessThan(5000);
  });
});

describe('KBUG-GATE:预检单元面(存在性 vs TS 链调用形态)', () => {
  it('别名/链式:预检放行,TS 链调用形态过滤语义不变(GATE-03)', () => {
    const aliasLines = ['alias = build_original()', 'x = alias'];
    expect(hasLocalReturnCandidate(aliasLines, 1, 'x')).toBe(true);
    expect(matchingAssignments(aliasLines, 1, 'x')).toEqual([]);

    const chainedLines = ['x = build().load()'];
    expect(hasLocalReturnCandidate(chainedLines, 0, 'x')).toBe(true);
    expect(matchingAssignments(chainedLines, 0, 'x')).toEqual([]);
  });

  it('调用形态候选:预检放行,TS 链照常产出候选(GATE-03)', () => {
    const lines = ['data = get_data()'];
    expect(hasLocalReturnCandidate(lines, 0, 'data')).toBe(true);
    expect(matchingAssignments(lines, 0, 'data')).toEqual([{ target: 'data', receiver: null, methodName: 'get_data' }]);

    const attrLines = ['svc = Service()', 'x = svc.fetch()'];
    expect(hasLocalReturnCandidate(attrLines, 1, 'x')).toBe(true);
    expect(matchingAssignments(attrLines, 1, 'x')).toEqual([{ target: 'x', receiver: 'svc', methodName: 'fetch' }]);
  });

  it('伪赋值与非法查询:预检快跳(GATE-02)', () => {
    const masked = ['s = "x = build_original()"', '# x = build_original()'];
    expect(hasLocalReturnCandidate(masked, 0, 'x')).toBe(false);
    expect(hasLocalReturnCandidate(masked, 1, 'x')).toBe(false);
    // 三引号体跨行掩码(KR-AUD-64)
    const triple = ['s = """', 'x = build_original()', '"""'];
    expect(hasLocalReturnCandidate(triple, 1, 'x')).toBe(false);
    expect(hasLocalReturnCandidate(['print(x)'], 0, 'x')).toBe(false);
    expect(hasLocalReturnCandidate(['x = 1'], 0, '')).toBe(false);
    expect(hasLocalReturnCandidate(['x = 1'], -1, 'x')).toBe(false);
  });

  it('跨作用域:兄弟方法体写点不借(GATE-03 共享扫描)', () => {
    const scoped = ['def make():', '    x = make()', '', 'def run():', '    z = x'];
    expect(hasLocalReturnCandidate(scoped, 4, 'x')).toBe(false);
    expect(matchingAssignments(scoped, 4, 'x')).toEqual([]);
    // 兄弟作用域内的自有写点照常命中
    expect(hasLocalReturnCandidate(scoped, 4, 'z')).toBe(true);
    // 模块级写点不受限(Python 全局读语义)
    const mixed = ['def make():', '    y = make()', '', 'y = 5', 'w = y'];
    expect(hasLocalReturnCandidate(mixed, 4, 'y')).toBe(true);
  });

  it('常量/字面量写点:存在性放行,形态裁定归 Rust(GATE-02/03)', () => {
    expect(hasLocalReturnCandidate(['x = 0'], 0, 'x')).toBe(true);
    expect(matchingAssignments(['x = 0'], 0, 'x')).toEqual([]);
  });
});
