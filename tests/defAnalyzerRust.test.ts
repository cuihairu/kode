import { afterEach, describe, expect, it, vi } from 'vitest';

import { KodeCoreGate, type ShadowClientLike } from '../src/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
import {
  analyzeDefDocumentInRust,
  analyzeDefDocumentWithRust,
  type InheritedNames
} from '../src/defAnalyzer';

// 命令面 Rust-first 接线单测(批:lint 注册表收口):经 gate.runInRust 走
// `$/kode/rpc {method: $/kode/lint/analyzeDef, params}`。覆盖:ok:true 直用
// Rust findings、ok:false 回退 TS 同步面、无门/未配 serverPath 的 Rust-only
// 面返回 null、inheritedNames 序列化(Set→数组)。

afterEach(() => {
  setKodeCoreShadowGate(null);
});

const RUST_FINDING = {
  check: 'heavy-sync-broadcast',
  code: 'heavy-sync-broadcast',
  severity: 'warning',
  line: 4,
  offset: 30,
  length: 10,
  message: '属性 memo(STRING)以 ALL_CLIENTS 对全体客户端同步',
  range: { offset: 30, length: 10 }
};

const PROP_DEF = '<root>\n\t<Properties>\n\t\t<memo>\n\t\t\t<Type>STRING</Type>\n\t\t\t<Flags>ALL_CLIENTS</Flags>\n\t\t</memo>\n\t</Properties>\n</root>\n';

interface RpcCall {
  method: string;
  params?: Record<string, unknown>;
}

/** 可编程替身:记录 $/kode/rpc 调用,按脚本返回/抛错 */
function makeStubClient(handler: (call: RpcCall) => unknown) {
  const calls: RpcCall[] = [];
  const client: ShadowClientLike = {
    start: vi.fn(async () => ({})),
    request: vi.fn(async (method: string, params?: unknown) => {
      if (method !== '$/kode/rpc') {
        throw new Error(`unexpected method ${method}`);
      }
      const call = params as RpcCall;
      calls.push(call);
      return handler(call);
    }),
    dispose: vi.fn(async () => undefined)
  };
  return { client, calls };
}

function makeGate(client: ShadowClientLike, backend = 'shadow'): KodeCoreGate {
  const gate = new KodeCoreGate({ clientFactory: () => client });
  gate.setConfig({ backend, serverPath: 'node:stub', shadowTimeoutMs: 500 });
  return gate;
}

describe('analyzeDefDocumentWithRust 命令面', () => {
  it('ok:true 时直用 Rust findings(映射为 TS 面)', async () => {
    const { client, calls } = makeStubClient(() => ({ findings: [RUST_FINDING] }));
    setKodeCoreShadowGate(makeGate(client));

    const findings = await analyzeDefDocumentWithRust(PROP_DEF);

    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('heavy-sync-broadcast');
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].offset).toBe(30);
    expect(findings[0].length).toBe(10);
    expect(findings[0].message).toContain('ALL_CLIENTS');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('$/kode/lint/analyzeDef');
    expect(calls[0].params?.text).toBe(PROP_DEF);
  });

  it('ok:false 时回退 TS 同步面(幻影类型仍命中)', async () => {
    const { client } = makeStubClient(() => {
      throw new Error('rust unavailable');
    });
    setKodeCoreShadowGate(makeGate(client));

    const findings = await analyzeDefDocumentWithRust(PROP_DEF);
    expect(findings.length).toBeGreaterThan(0);
  });

  it('无门时回退 TS 同步面(不调 Rust)', async () => {
    const findings = await analyzeDefDocumentWithRust(PROP_DEF);
    expect(findings.length).toBeGreaterThan(0);
  });
});

describe('analyzeDefDocumentInRust Rust-only 面', () => {
  it('ok:true 返回 Rust findings', async () => {
    const { client, calls } = makeStubClient(() => ({ findings: [RUST_FINDING] }));
    setKodeCoreShadowGate(makeGate(client));

    const findings = await analyzeDefDocumentInRust(PROP_DEF);
    expect(findings).toHaveLength(1);
    expect(calls[0].method).toBe('$/kode/lint/analyzeDef');
  });

  it('ok:false 返回 null(调用方自行回退)', async () => {
    const { client } = makeStubClient(() => {
      throw new Error('boom');
    });
    setKodeCoreShadowGate(makeGate(client));

    expect(await analyzeDefDocumentInRust(PROP_DEF)).toBeNull();
  });

  it('无门返回 null', async () => {
    expect(await analyzeDefDocumentInRust(PROP_DEF)).toBeNull();
  });

  it('未配 serverPath 返回 null(默认 ts 零开销)', async () => {
    const { client } = makeStubClient(() => ({ findings: [] }));
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'ts', serverPath: '', shadowTimeoutMs: 500 });
    setKodeCoreShadowGate(gate);

    expect(await analyzeDefDocumentInRust(PROP_DEF)).toBeNull();
  });
});

describe('inheritedNames 序列化', () => {
  it('Set 收束为数组并按 camelCase 传给 Rust', async () => {
    const { client, calls } = makeStubClient(() => ({ findings: [] }));
    setKodeCoreShadowGate(makeGate(client));

    const inherited: InheritedNames = new Map([
      [
        'hp',
        {
          propertyDomains: new Set(['base']),
          componentDomains: new Set(['cell']),
          methodSections: new Set(['base', 'client']),
          propertySources: ['Base.def'],
          componentSources: [],
          methodSources: ['Client.def']
        }
      ]
    ]);

    await analyzeDefDocumentInRust(PROP_DEF, inherited);
    const params = calls[0].params as Record<string, unknown>;
    expect(params.inheritedNames).toEqual({
      hp: {
        propertyDomains: ['base'],
        componentDomains: ['cell'],
        methodSections: ['base', 'client'],
        propertySources: ['Base.def'],
        componentSources: [],
        methodSources: ['Client.def']
      }
    });
  });

  it('knownTypes 透传(有值才带键)', async () => {
    const { client, calls } = makeStubClient(() => ({ findings: [] }));
    setKodeCoreShadowGate(makeGate(client));

    await analyzeDefDocumentInRust(PROP_DEF, new Map(), { knownTypes: ['GHOST'] });
    const params = calls[0].params as Record<string, unknown>;
    expect(params.knownTypes).toEqual(['GHOST']);
  });
});
