import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  KodeCoreGate,
  ShadowDiffLog,
  type ShadowClientLike,
} from '../src/kodeCoreGate';
import {
  diagnosticsToLspFace,
  getKodeCoreShadowGate,
  locationToLspFace,
  serveCompletionFromRust,
  serveDefinitionFromRust,
  serveDiagnosticsFromRust,
  serveHoverFromRust,
  setKodeCoreShadowGate,
  shadowCompareDefinition,
  shadowMirrorCorpusDocument,
  shadowObserveDefDocument,
  shadowReleaseCorpusDocument,
} from '../src/kodeCoreShadowFaces';

// kode2 Phase2 首片:definition/diagnostics 影子对拍接线单测。
// 适配面(vscode 形状 → LSP 形状)、shadow-only 门控、verdict 记账、
// 语料镜像腿(open/change/close-重开)与 fire-and-forget 不上浮。

const DEF_URI = '/workspace/demo/scripts/entity_defs/Avatar.def';

afterEach(() => {
  // 每个用例结束撤门引用,避免跨用例串扰(vitest 每文件单进程,双保险)。
  setKodeCoreShadowGate(null);
});

/** 可编程替身:记录调用,不 spawn */
function makeStubClient() {
  const calls: { method: string; params?: unknown }[] = [];
  const responses = new Map<string, unknown>();
  const client: ShadowClientLike & { calls: { method: string; params?: unknown }[] } = {
    calls,
    start: vi.fn(async () => {
      calls.push({ method: 'start' });
      return {};
    }),
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
    }),
    changeDocument: vi.fn((uri: string, version: number, text: string) => {
      calls.push({ method: 'changeDocument', params: { uri, version, text } });
    }),
    closeDocument: vi.fn((uri: string) => {
      calls.push({ method: 'closeDocument', params: { uri } });
    })
  };
  return { client, responses };
}

function makeGate(client: ShadowClientLike, backend = 'shadow'): { gate: KodeCoreGate; diffLog: ShadowDiffLog } {
  const diffLog = new ShadowDiffLog();
  const gate = new KodeCoreGate({ clientFactory: () => client, diffLog });
  gate.setConfig({ backend, serverPath: 'node:stub', shadowTimeoutMs: 500 });
  return { gate, diffLog };
}

const makeDocument = (overrides: Record<string, unknown> = {}) => ({
  uri: { fsPath: DEF_URI },
  languageId: 'kbengine-def',
  version: 1,
  getText: () => '<root>\n</root>\n',
  ...overrides
});

describe('LSP 面适配', () => {
  it('locationToLspFace:vscode.Location 形状 → fsPath + range 面', () => {
    const face = locationToLspFace({
      uri: { fsPath: '/w/Mob.def' },
      range: { start: { line: 3, character: 2 }, end: { line: 3, character: 4 } }
    });
    expect(face).toEqual({
      uri: '/w/Mob.def',
      range: { start: { line: 3, character: 2 }, end: { line: 3, character: 4 } }
    });
  });

  it('locationToLspFace:null/数组取首/坏形状一律 null', () => {
    expect(locationToLspFace(null)).toBeNull();
    expect(locationToLspFace(undefined)).toBeNull();
    expect(
      locationToLspFace([
        { uri: { fsPath: '/w/a.def' }, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }
      ])
    ).toEqual({
      uri: '/w/a.def',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
    });
    expect(locationToLspFace({ uri: { fsPath: '/w/a.def' } })).toBeNull();
    expect(
      locationToLspFace({ uri: { fsPath: '/w/a.def' }, range: { start: {}, end: {} } })
    ).toBeNull();
  });

  it('diagnosticsToLspFace:severity 0 基 → LSP 1 基,kind=full', () => {
    const face = diagnosticsToLspFace([
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
        severity: 0,
        message: '未知的 DetailLevel: ULTRA'
      },
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
        severity: 1,
        message: '属性区块中存在重复定义: hp (Base)'
      }
    ]);
    expect(face.kind).toBe('full');
    expect(face.items.map(item => item.severity)).toEqual([1, 2]);
    expect(face.items[0].message).toBe('未知的 DetailLevel: ULTRA');
  });

  it('diagnosticsToLspFace:越界 severity 收敛 Error(不产出 4 基外值)', () => {
    const face = diagnosticsToLspFace([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        severity: 9,
        message: 'x'
      }
    ]);
    expect(face.items[0].severity).toBe(1);
  });
});

describe('shadowCompareDefinition 门控与记账', () => {
  it('未装配门(gate=null)时零开销直通,不抛错', () => {
    setKodeCoreShadowGate(null);
    expect(() =>
      shadowCompareDefinition(makeDocument() as never, { line: 1, character: 2 }, null)
    ).not.toThrow();
    expect(getKodeCoreShadowGate()).toBeNull();
  });

  it('ts 模式:compare 直通,不建进程不记日志', async () => {
    const { client } = makeStubClient();
    const { gate, diffLog } = makeGate(client, 'ts');
    setKodeCoreShadowGate(gate);
    shadowCompareDefinition(makeDocument() as never, { line: 1, character: 2 }, null);
    await vi.waitFor(() => {
      expect(diffLog.summary().total).toBe(0);
    });
    expect(client.calls.filter(call => call.method.startsWith('request')).length).toBe(0);
  });

  it('shadow 模式:match 记账;TS 面为真值', async () => {
    const { client, responses } = makeStubClient();
    const { gate, diffLog } = makeGate(client);
    setKodeCoreShadowGate(gate);
    const tsFace = {
      uri: '/w/Mob.def',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    };
    responses.set('textDocument/definition', tsFace);
    shadowCompareDefinition(makeDocument() as never, { line: 1, character: 2 }, {
      uri: { fsPath: '/w/Mob.def' },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    });
    await vi.waitFor(() => {
      expect(diffLog.summary()).toEqual({ total: 1, match: 1, diff: 0, failure: 0 });
    });
  });

  it('shadow 模式:diff 记账含首分歧路径;compare 恒返回 TS 结果原样', async () => {
    const { client, responses } = makeStubClient();
    const { gate, diffLog } = makeGate(client);
    setKodeCoreShadowGate(gate);
    responses.set('textDocument/definition', { uri: '/w/OTHER.def', range: {
      start: { line: 0, character: 0 }, end: { line: 0, character: 0 }
    } });
    const tsLocation = {
      uri: { fsPath: '/w/Mob.def' },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    };
    shadowCompareDefinition(makeDocument() as never, { line: 1, character: 2 }, tsLocation);
    await vi.waitFor(() => {
      expect(diffLog.summary().diff).toBe(1);
    });
    const entry = diffLog.entries()[0];
    expect(entry.verdict).toBe('diff');
    expect(entry.detail).toContain('$');
    // compare 返回值 = 适配后的 TS 面(原样,不经 Rust)。
    const returned = await gate.compare('textDocument/definition', {}, locationToLspFace(tsLocation));
    expect(returned).toEqual(locationToLspFace(tsLocation));
  });

  it('shadow 模式:Rust 侧失败记 rust-error,不上浮', async () => {
    const { client } = makeStubClient();
    const { gate, diffLog } = makeGate(client);
    setKodeCoreShadowGate(gate);
    shadowCompareDefinition(makeDocument() as never, { line: 1, character: 2 }, null);
    await vi.waitFor(() => {
      expect(diffLog.summary().failure).toBe(1);
    });
    expect(diffLog.entries()[0].verdict).toBe('rust-error');
  });

  it('E-3 异步结果:Promise<Location> 解析完成后才对拍,对拍面是解析落点而非 null', async () => {
    const { client, responses } = makeStubClient();
    const { gate, diffLog } = makeGate(client);
    setKodeCoreShadowGate(gate);
    responses.set('textDocument/definition', {
      uri: '/w/OTHER.def',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    });
    shadowCompareDefinition(
      makeDocument() as never,
      { line: 1, character: 2 },
      Promise.resolve({
        uri: { fsPath: '/w/Mob.def' },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
      })
    );
    await vi.waitFor(() => {
      expect(diffLog.summary().diff).toBe(1);
    });
    const detail = diffLog.entries()[0].detail ?? '';
    expect(detail).toContain('/w/Mob.def'); // 对拍用的是解析后的真实落点
    expect(detail).not.toContain('ts=null'); // 未解析即对拍时会得到 null 面
  });

  it('E-3 异步结果:非 Promise 的 thenable 同样解析后再对拍', async () => {
    const { client, responses } = makeStubClient();
    const { gate, diffLog } = makeGate(client);
    setKodeCoreShadowGate(gate);
    responses.set('textDocument/definition', {
      uri: '/w/Mob.def',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    });
    const thenable = {
      then: (resolve: (value: unknown) => void) =>
        resolve({
          uri: { fsPath: '/w/Mob.def' },
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
        })
    };
    shadowCompareDefinition(makeDocument() as never, { line: 1, character: 2 }, thenable);
    await vi.waitFor(() => {
      expect(diffLog.summary().match).toBe(1);
    });
  });

  it('E-3 拒绝路径:不产出对拍,也不产生未处理拒绝', async () => {
    const { client, responses } = makeStubClient();
    const { gate, diffLog } = makeGate(client);
    setKodeCoreShadowGate(gate);
    responses.set('textDocument/definition', {
      uri: '/w/Mob.def',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      shadowCompareDefinition(
        makeDocument() as never,
        { line: 1, character: 2 },
        Promise.reject(new Error('mapping failed'))
      );
      await new Promise(resolve => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(diffLog.summary().total).toBe(0);
    expect(unhandled).toHaveLength(0);
  });

  it('E-3 空结果:同步 null/undefined 仍对拍(null 面),不跳过', async () => {
    const { client, responses } = makeStubClient();
    const { gate, diffLog } = makeGate(client);
    setKodeCoreShadowGate(gate);
    responses.set('textDocument/definition', {
      uri: '/w/Mob.def',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    });
    shadowCompareDefinition(makeDocument() as never, { line: 1, character: 2 }, null);
    shadowCompareDefinition(makeDocument() as never, { line: 1, character: 2 }, undefined);
    await vi.waitFor(() => {
      expect(diffLog.summary().total).toBe(2);
    });
    expect(diffLog.entries().map(entry => entry.verdict)).toEqual(['diff', 'diff']);
  });
});

describe('shadowObserveDefDocument 诊断面 + 语料镜像腿', () => {
  it('非 .def 文档不入对拍(镜像与 compare 都不发)', async () => {
    const { client } = makeStubClient();
    const { gate, diffLog } = makeGate(client);
    setKodeCoreShadowGate(gate);
    shadowObserveDefDocument(
      makeDocument({ uri: { fsPath: '/w/scripts/entities.xml' }, languageId: 'xml' }) as never,
      []
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(client.calls.length).toBe(0);
    expect(diffLog.summary().total).toBe(0);
  });

  it('镜像腿:首见 didOpen,版本前进 didChange,版本回退 close+open', async () => {
    const { client } = makeStubClient();
    const { gate } = makeGate(client);
    setKodeCoreShadowGate(gate);
    const document = makeDocument();
    shadowObserveDefDocument(document as never, []);
    await vi.waitFor(() => {
      expect(client.calls.some(call => call.method === 'openDocument')).toBe(true);
    });
    shadowObserveDefDocument(makeDocument({ version: 2, getText: () => '<root v2/>' }) as never, []);
    await vi.waitFor(() => {
      expect(client.calls.some(call => call.method === 'changeDocument')).toBe(true);
    });
    shadowObserveDefDocument(makeDocument({ version: 1 }) as never, []);
    await vi.waitFor(() => {
      expect(client.calls.some(call => call.method === 'closeDocument')).toBe(true);
    });
    const opens = client.calls.filter(call => call.method === 'openDocument');
    expect(opens.length).toBe(2);
  });

  it('诊断面对拍:TS validateDocument 面 vs Rust 同形 {kind, items}', async () => {
    const { client, responses } = makeStubClient();
    const { gate, diffLog } = makeGate(client);
    setKodeCoreShadowGate(gate);
    responses.set('textDocument/diagnostic', {
      kind: 'full',
      items: [
        {
          range: { start: { line: 3, character: 10 }, end: { line: 3, character: 20 } },
          severity: 1,
          message: '自定义类型 GHOST 未在 types.xml 中注册，请先在 types.xml 注册后再引用'
        }
      ]
    });
    shadowObserveDefDocument(makeDocument() as never, [
      {
        range: { start: { line: 3, character: 10 }, end: { line: 3, character: 20 } },
        severity: 0,
        message: '自定义类型 GHOST 未在 types.xml 中注册，请先在 types.xml 注册后再引用'
      }
    ]);
    await vi.waitFor(() => {
      expect(diffLog.summary()).toEqual({ total: 1, match: 1, diff: 0, failure: 0 });
    });
  });

  it('镜像失败静默(不上浮、不抛错)', async () => {
    const { client } = makeStubClient();
    client.start = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const { gate } = makeGate(client);
    setKodeCoreShadowGate(gate);
    expect(() => shadowObserveDefDocument(makeDocument() as never, [])).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 20));
  });
});

describe('shadowMirrorCorpusDocument 语料镜像腿(E-1)', () => {
  it('types.xml / entities.xml / alias.xml + .def 都进 shadow;非语料文档零镜像', async () => {
    const { client } = makeStubClient();
    const { gate } = makeGate(client);
    setKodeCoreShadowGate(gate);
    const corpusUris = [
      '/w/demo/scripts/entity_defs/types.xml',
      '/w/demo/scripts/entity_defs/entities.xml',
      '/w/demo/scripts/entity_defs/alias.xml',
      DEF_URI
    ];
    for (const uri of corpusUris) {
      shadowMirrorCorpusDocument(
        makeDocument({ uri: { fsPath: uri }, languageId: uri.endsWith('.def') ? 'kbengine-def' : 'xml' }) as never
      );
    }
    // 非语料文档(python / 其他 xml)不镜像
    shadowMirrorCorpusDocument(
      makeDocument({ uri: { fsPath: '/w/demo/scripts/Avatar.py' }, languageId: 'python' }) as never
    );
    shadowMirrorCorpusDocument(
      makeDocument({ uri: { fsPath: '/w/other/config.xml' }, languageId: 'xml' }) as never
    );
    await vi.waitFor(() => {
      expect(client.calls.filter(call => call.method === 'openDocument').length).toBe(4);
    });
    const opened = client.calls
      .filter(call => call.method === 'openDocument')
      .map(call => (call.params as { uri: string }).uri);
    expect(opened).toEqual(corpusUris);
  });

  it('同版本重入不重发:不开 didOpen、不走 close+open、不发 didChange', async () => {
    const { client } = makeStubClient();
    const { gate } = makeGate(client);
    setKodeCoreShadowGate(gate);
    const document = makeDocument();
    shadowMirrorCorpusDocument(document as never);
    // 诊断面刷新腿重入同版本(两条镜像腿共用账本)
    shadowObserveDefDocument(document as never, []);
    await vi.waitFor(() => {
      expect(client.calls.filter(call => call.method === 'openDocument').length).toBe(1);
    });
    expect(client.calls.some(call => call.method === 'closeDocument')).toBe(false);
    expect(client.calls.some(call => call.method === 'changeDocument')).toBe(false);
  });
});

describe('shadowReleaseCorpusDocument 关文档清理腿(E-4)', () => {
  it('语料文档关闭:发一次 didClose 且账本清空,重开走 didOpen;未镜像/非语料零调用', async () => {
    const { client } = makeStubClient();
    const { gate } = makeGate(client);
    setKodeCoreShadowGate(gate);
    const document = makeDocument();
    shadowMirrorCorpusDocument(document as never);
    // 镜像落账是异步的:等 didOpen 落地后再关文档(生产里 open/close 也是两个事件)
    await vi.waitFor(() => {
      expect(client.calls.some(call => call.method === 'openDocument')).toBe(true);
    });
    shadowReleaseCorpusDocument(document as never);
    // 未镜像过的语料文档关闭 = 零调用;非语料文档零调用
    shadowReleaseCorpusDocument(
      makeDocument({ uri: { fsPath: '/w/demo/scripts/entity_defs/types.xml' }, languageId: 'xml' }) as never
    );
    shadowReleaseCorpusDocument(
      makeDocument({ uri: { fsPath: '/w/demo/scripts/Avatar.py' }, languageId: 'python' }) as never
    );
    await vi.waitFor(() => {
      expect(client.calls.some(call => call.method === 'closeDocument')).toBe(true);
    });
    expect(client.calls.filter(call => call.method === 'closeDocument').length).toBe(1);
    // 账本已清:重开同 uri 走 didOpen(同版本也不再是 no-op)
    shadowMirrorCorpusDocument(document as never);
    await vi.waitFor(() => {
      expect(client.calls.filter(call => call.method === 'openDocument').length).toBe(2);
    });
  });
});

describe('serveDefinitionFromRust 服务面(2026-11-08 用户令「直接切」)', () => {
  it('rust 轨道:镜像语料 + 请求定义,返回 Rust 落点(Rust 优先于 TS)', async () => {
    const { client, responses } = makeStubClient();
    responses.set('textDocument/definition', {
      uri: '/workspace/demo/scripts/entity_defs/Parent.def',
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
    });
    const { gate } = makeGate(client, 'rust');
    setKodeCoreShadowGate(gate);
    const location = await serveDefinitionFromRust(makeDocument() as never, {
      line: 4,
      character: 2,
    });
    expect(location).toEqual({
      uri: '/workspace/demo/scripts/entity_defs/Parent.def',
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
    });
    // 语料已镜像(didOpen),请求带 LSP 参数面
    expect(client.calls.some(call => call.method === 'openDocument')).toBe(true);
    expect(client.calls.some(call => call.method === 'request:textDocument/definition')).toBe(true);
  });

  it('Rust 无落点(恒 null):返回 null,调用方回 TS', async () => {
    const { client, responses } = makeStubClient();
    responses.set('textDocument/definition', null);
    const { gate } = makeGate(client, 'rust');
    setKodeCoreShadowGate(gate);
    const location = await serveDefinitionFromRust(makeDocument() as never, {
      line: 3,
      character: 0,
    });
    expect(location).toBeNull();
    expect(client.calls.some(call => call.method === 'request:textDocument/definition')).toBe(true);
  });

  it('非语料文档(schema/python):零请求直通 null', async () => {
    const { client } = makeStubClient();
    const { gate } = makeGate(client, 'rust');
    setKodeCoreShadowGate(gate);
    const location = await serveDefinitionFromRust(
      makeDocument({ uri: { fsPath: '/w/Avatar.py' }, languageId: 'python' }) as never,
      { line: 1, character: 0 }
    );
    expect(location).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it('非服务轨道(ts):零开销返回 null,不拉进程', async () => {
    const { client } = makeStubClient();
    const { gate } = makeGate(client, 'ts');
    setKodeCoreShadowGate(gate);
    const location = await serveDefinitionFromRust(makeDocument() as never, {
      line: 1,
      character: 0,
    });
    expect(location).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it('门未装配:零开销返回 null', async () => {
    const location = await serveDefinitionFromRust(makeDocument() as never, {
      line: 1,
      character: 0,
    });
    expect(location).toBeNull();
  });

  it('Rust 请求失败:gate.serveInRust 兜底 null,不抛', async () => {
    const { client } = makeStubClient();
    // 不设 response → request 抛 'no stub',serveInRust 兜底 null
    const { gate } = makeGate(client, 'rust');
    setKodeCoreShadowGate(gate);
    const location = await serveDefinitionFromRust(makeDocument() as never, {
      line: 1,
      character: 0,
    });
    expect(location).toBeNull();
  });
});

describe('serveCompletionFromRust 服务面(2026-11-08 用户令「直接切」)', () => {
  it('rust 轨道:镜像语料 + 请求补全,返回 Rust 条目集(Rust 优先)', async () => {
    const { client, responses } = makeStubClient();
    responses.set('textDocument/completion', {
      isIncomplete: false,
      items: [
        { label: 'hp', kind: 10, detail: 'int' },
        { label: 'onEnterWorld', kind: 2 },
      ],
    });
    const { gate } = makeGate(client, 'rust');
    setKodeCoreShadowGate(gate);
    const report = await serveCompletionFromRust(makeDocument() as never, {
      line: 3,
      character: 2,
    });
    expect(report).toEqual({
      isIncomplete: false,
      items: [
        { label: 'hp', kind: 10, detail: 'int' },
        { label: 'onEnterWorld', kind: 2 },
      ],
    });
    // 语料已镜像(didOpen),请求带 LSP 参数面
    expect(client.calls.some(call => call.method === 'openDocument')).toBe(true);
    expect(client.calls.some(call => call.method === 'request:textDocument/completion')).toBe(true);
  });

  it('Rust 未判定上下文(null):返回 null,调用方回 TS', async () => {
    const { client, responses } = makeStubClient();
    responses.set('textDocument/completion', null);
    const { gate } = makeGate(client, 'rust');
    setKodeCoreShadowGate(gate);
    const report = await serveCompletionFromRust(makeDocument() as never, {
      line: 3,
      character: 0,
    });
    expect(report).toBeNull();
    expect(client.calls.some(call => call.method === 'request:textDocument/completion')).toBe(true);
  });

  it('Rust 应答缺 items 字段(坏形状):返回 null,不抛', async () => {
    const { client, responses } = makeStubClient();
    responses.set('textDocument/completion', { isIncomplete: false });
    const { gate } = makeGate(client, 'rust');
    setKodeCoreShadowGate(gate);
    const report = await serveCompletionFromRust(makeDocument() as never, {
      line: 3,
      character: 0,
    });
    expect(report).toBeNull();
  });

  it('非语料文档(schema/python):零请求直通 null', async () => {
    const { client } = makeStubClient();
    const { gate } = makeGate(client, 'rust');
    setKodeCoreShadowGate(gate);
    const report = await serveCompletionFromRust(
      makeDocument({ uri: { fsPath: '/w/Avatar.py' }, languageId: 'python' }) as never,
      { line: 1, character: 0 }
    );
    expect(report).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it('非服务轨道(ts):零开销返回 null,不拉进程', async () => {
    const { client } = makeStubClient();
    const { gate } = makeGate(client, 'ts');
    setKodeCoreShadowGate(gate);
    const report = await serveCompletionFromRust(makeDocument() as never, {
      line: 1,
      character: 0,
    });
    expect(report).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it('门未装配:零开销返回 null', async () => {
    const report = await serveCompletionFromRust(makeDocument() as never, {
      line: 1,
      character: 0,
    });
    expect(report).toBeNull();
  });

// ---- 缺口臂:镜像腿拒绝吞没、形状不合规、非服务轨道直通(覆盖率补测) ----

describe('serve 面缺口臂(镜像拒绝/形状不合规/直通 null)', () => {
  /** 素面门:mirrorDocument 可编程拒绝,serveInRust 返回固定结果。 */
  const makePlainGate = (options: {
    serveResult?: unknown;
    mirrorRejects?: boolean;
    compareRejects?: boolean;
  } = {}): KodeCoreGate =>
    ({
      serveFromRust: () => true,
      mirrorDocument: async () => {
        if (options.mirrorRejects) {
          throw new Error('mirror down');
        }
      },
      serveInRust: async () => options.serveResult ?? null,
      compare: async () => {
        if (options.compareRejects) {
          throw new Error('compare down');
        }
        return { verdict: 'match' };
      },
      closeMirroredDocument: () => undefined
    }) as unknown as KodeCoreGate;

  const flush = () => new Promise<void>(resolve => setImmediate(resolve));

  const face = {
    uri: DEF_URI,
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }
  };

  it('serveDefinitionFromRust:镜像拒绝被吞且 Rust 结果照常面世;坏形状如实 null', async () => {
    setKodeCoreShadowGate(makePlainGate({ serveResult: face, mirrorRejects: true }));
    await expect(serveDefinitionFromRust(makeDocument(), { line: 1, character: 0 })).resolves.toEqual(face);
    setKodeCoreShadowGate(makePlainGate({ serveResult: { nope: 1 } }));
    await expect(serveDefinitionFromRust(makeDocument(), { line: 1, character: 0 })).resolves.toBeNull();
  });

  it('serveCompletionFromRust:镜像拒绝被吞,补全面照常面世', async () => {
    const completion = { isIncomplete: false, items: [{ label: 'HP', kind: 10 }] };
    setKodeCoreShadowGate(makePlainGate({ serveResult: completion, mirrorRejects: true }));
    await expect(serveCompletionFromRust(makeDocument(), { line: 1, character: 0 })).resolves.toEqual(completion);
  });

  it('serveHoverFromRust:无门直通 null;镜像拒绝被吞,悬停文本照常面世', async () => {
    setKodeCoreShadowGate(null);
    await expect(serveHoverFromRust(makeDocument(), { line: 1, character: 0 })).resolves.toBeNull();
    setKodeCoreShadowGate(
      makePlainGate({ serveResult: { contents: { value: 'KBEngine 悬停' } }, mirrorRejects: true })
    );
    await expect(serveHoverFromRust(makeDocument(), { line: 1, character: 0 })).resolves.toBe('KBEngine 悬停');
  });

  it('serveDiagnosticsFromRust:无门/非 def 直通 null;镜像拒绝被吞;报告与条目坏形状如实 null', async () => {
    setKodeCoreShadowGate(null);
    await expect(serveDiagnosticsFromRust(makeDocument())).resolves.toBeNull();
    // 语料但非 def(entities.xml)→ 直通 null
    setKodeCoreShadowGate(makePlainGate({ serveResult: { kind: 'full', items: [] } }));
    const xmlDoc = makeDocument({
      uri: { fsPath: '/workspace/demo/scripts/entities.xml' },
      languageId: 'xml'
    });
    await expect(serveDiagnosticsFromRust(xmlDoc)).resolves.toBeNull();
    // 镜像拒绝被吞,报告照常面世
    const report = {
      kind: 'full',
      items: [
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
          severity: 1,
          message: 'bad cell property'
        }
      ]
    };
    setKodeCoreShadowGate(makePlainGate({ serveResult: report, mirrorRejects: true }));
    await expect(serveDiagnosticsFromRust(makeDocument())).resolves.toEqual(report);
    // kind 非 full → null
    setKodeCoreShadowGate(makePlainGate({ serveResult: { kind: 'nope', items: [] } }));
    await expect(serveDiagnosticsFromRust(makeDocument())).resolves.toBeNull();
    // 条目缺 severity → null
    setKodeCoreShadowGate(
      makePlainGate({
        serveResult: {
          kind: 'full',
          items: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, message: 'x' }]
        }
      })
    );
    await expect(serveDiagnosticsFromRust(makeDocument())).resolves.toBeNull();
  });

  it('影子腿 fire-and-forget 拒绝不上浮(compare/compare+mirror)', async () => {
    setKodeCoreShadowGate(makePlainGate({ compareRejects: true }));
    expect(() =>
      shadowCompareDefinition(
        makeDocument(),
        { line: 1, character: 0 },
        Promise.resolve({ uri: { fsPath: DEF_URI }, range: face.range })
      )
    ).not.toThrow();
    await flush();
    setKodeCoreShadowGate(makePlainGate({ mirrorRejects: true }));
    expect(() => shadowMirrorCorpusDocument(makeDocument())).not.toThrow();
    await flush();
    setKodeCoreShadowGate(makePlainGate({ compareRejects: true }));
    expect(() => shadowObserveDefDocument(makeDocument(), [])).not.toThrow();
    await flush();
  });
});


describe('serve 面缺口臂二(直通与坏形状收尾)', () => {
  const makePlainGate = (serveResult: unknown): KodeCoreGate =>
    ({
      serveFromRust: () => true,
      mirrorDocument: async () => undefined,
      serveInRust: async () => serveResult,
      compare: async () => ({ verdict: 'match' }),
      closeMirroredDocument: () => undefined
    }) as unknown as KodeCoreGate;

  it('hover:非语料直通 null;非对象应答与缺 contents 如实 null', async () => {
    const pyDoc = makeDocument({
      uri: { fsPath: '/workspace/demo/scripts/cell/Avatar.py' },
      languageId: 'python'
    });
    setKodeCoreShadowGate(makePlainGate({ contents: { value: 'x' } }));
    await expect(serveHoverFromRust(pyDoc, { line: 0, character: 0 })).resolves.toBeNull();
    setKodeCoreShadowGate(makePlainGate('plain string'));
    await expect(serveHoverFromRust(makeDocument(), { line: 0, character: 0 })).resolves.toBeNull();
    setKodeCoreShadowGate(makePlainGate({ nope: 1 }));
    await expect(serveHoverFromRust(makeDocument(), { line: 0, character: 0 })).resolves.toBeNull();
    setKodeCoreShadowGate(null);
  });

  it('diagnostics:非对象应答如实 null;observe 无门/非 def 文档零请求', async () => {
    setKodeCoreShadowGate(null);
    // 无门:直通零请求
    expect(() => shadowObserveDefDocument(makeDocument(), [])).not.toThrow();
    setKodeCoreShadowGate(makePlainGate(null));
    await expect(serveDiagnosticsFromRust(makeDocument())).resolves.toBeNull();
    const xmlDoc = makeDocument({
      uri: { fsPath: '/workspace/demo/scripts/entities.xml' },
      languageId: 'xml'
    });
    expect(() => shadowObserveDefDocument(xmlDoc, [])).not.toThrow();
    setKodeCoreShadowGate(null);
  });
});

});
