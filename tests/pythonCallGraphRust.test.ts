import { describe, expect, it } from 'vitest';
import {
  buildPythonCallGraphInRust,
  buildPythonSymbolsInRust,
  normalizeCallGraphPath
} from '../src/backend/pythonCallGraphRust';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';

// C-20 调用图/符号表 Rust 主路径:buildPythonCallGraphInRust /
// buildPythonSymbolsInRust 经命令级 RPC 调 Rust 核心;Rust 不可用(无 gate/
// 调用失败/形状不合规/异常)返回 null。契约:参数形状(files/manifestXmlText)
// 与输出形状(nodes/edges/reverseIndex/stats)断言是重点。

const params = () => ({
  files: [{ path: '/scripts/cell/Avatar.py', text: 'class Avatar:\n    def act(self):\n        pass\n' }],
  manifestXmlText: '<processTopology><process name="c1" role="cellapp"></process></processTopology>'
});

const cannedGraph = () => ({
  nodes: [
    {
      id: 'Avatar.act',
      kind: 'method',
      className: 'Avatar',
      name: 'act',
      filePath: '/scripts/cell/Avatar.py',
      line: 1,
      isAsync: false,
      params: []
    }
  ],
  edges: [
    {
      caller: 'act',
      callerClass: 'Avatar',
      callerLine: 2,
      callee: 'notify',
      receiver: 'self',
      kind: 'self-method',
      filePath: '/scripts/cell/Avatar.py'
    }
  ],
  reverseIndex: { '/scripts/cell/Avatar.py': [] },
  dataflow: [
    { filePath: '/scripts/cell/Avatar.py', class: 'Avatar', method: 'act', chains: [] }
  ],
  processRoles: ['cellapp'],
  stats: {
    fileCount: 1,
    nodeCount: 1,
    edgeCount: 1,
    dataflowCount: 1,
    errorCount: 0,
    byKind: { 'self-method': 1 }
  }
});

const cannedSymbols = () => [
  {
    filePath: '/scripts/cell/Avatar.py',
    lineCount: 4,
    classes: [
      {
        name: 'Avatar',
        qualifiedName: 'Avatar',
        bases: [],
        startLine: 0,
        endLine: 3,
        decorators: [],
        methods: [
          {
            name: 'act',
            line: 1,
            character: 4,
            isAsync: false,
            decorators: [],
            params: [],
            endLine: 3,
            calls: [{ methodName: 'notify', line: 2, character: 8 }]
          }
        ],
        attributes: []
      }
    ],
    functions: [],
    imports: [],
    errors: []
  }
];

describe('buildPythonCallGraphInRust(调用图 Rust 主路径)', () => {
  it('Rust 核心在场:契约参数含 files/manifestXmlText,返回完整形状', async () => {
    let calledMethod = '';
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (method: string, p: unknown) => {
        calledMethod = method;
        calledParams = p;
        return { ok: true, result: cannedGraph() };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await buildPythonCallGraphInRust(params());
      expect(result).not.toBeNull();
      expect(result?.nodes).toHaveLength(1);
      expect(result?.edges[0].kind).toBe('self-method');
      expect(result?.stats.edgeCount).toBe(1);
      expect(calledMethod).toBe('$/kode/python/callgraph');
      const p = calledParams as { files: unknown[]; manifestXmlText: string };
      expect(p.files).toHaveLength(1);
      expect(p.manifestXmlText).toContain('processTopology');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('manifestXmlText 缺省时传空串', async () => {
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (_method: string, p: unknown) => {
        calledParams = p;
        return { ok: true, result: cannedGraph() };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      await buildPythonCallGraphInRust({ files: [] });
      expect((calledParams as { manifestXmlText: string }).manifestXmlText).toBe('');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 不可用(无 gate)返回 null', async () => {
    setKodeCoreShadowGate(null);
    const result = await buildPythonCallGraphInRust(params());
    expect(result).toBeNull();
  });

  it('Rust 调用失败(!ok)返回 null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: false, reason: 'no serverPath' })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await buildPythonCallGraphInRust(params());
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 结果形状不合规(nodes 缺失)返回 null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: true, result: { edges: [], reverseIndex: {}, dataflow: [], processRoles: [], stats: {} } })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await buildPythonCallGraphInRust(params());
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 结果单条 node 缺字段返回 null', async () => {
    const bad = cannedGraph();
    bad.nodes = [{ id: 'Avatar.act', kind: 'method', name: 'act' } as never];
    const fakeGate = {
      runInRust: async () => ({ ok: true, result: bad })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await buildPythonCallGraphInRust(params());
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 结果 stats.byKind 缺失返回 null', async () => {
    const bad = cannedGraph();
    (bad.stats as Record<string, unknown>).byKind = undefined;
    const fakeGate = {
      runInRust: async () => ({ ok: true, result: bad })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await buildPythonCallGraphInRust(params());
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });
});

describe('buildPythonSymbolsInRust(符号表 Rust 主路径)', () => {
  it('契约参数 files,返回每文件符号表(含方法自身调用)', async () => {
    let calledMethod = '';
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (method: string, p: unknown) => {
        calledMethod = method;
        calledParams = p;
        return { ok: true, result: cannedSymbols() };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await buildPythonSymbolsInRust(params().files);
      expect(result).not.toBeNull();
      expect(result?.[0].classes[0].methods[0].calls[0].methodName).toBe('notify');
      expect(calledMethod).toBe('$/kode/python/symbols');
      expect((calledParams as { files: unknown[] }).files).toHaveLength(1);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 不可用(无 gate)返回 null', async () => {
    setKodeCoreShadowGate(null);
    const result = await buildPythonSymbolsInRust(params().files);
    expect(result).toBeNull();
  });

  it('Rust 调用失败(!ok)返回 null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: false, reason: 'no serverPath' })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await buildPythonSymbolsInRust(params().files);
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 结果非数组返回 null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: true, result: { filePath: 'x' } })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await buildPythonSymbolsInRust(params().files);
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 结果元素缺 filePath 返回 null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: true, result: [{ classes: [] }] })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await buildPythonSymbolsInRust(params().files);
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });
});


// RUST-077-W:服务端超限切片(edges/nodes/dataflow/reverseIndex 携带
// `*Page` 元信息)→ TS 消费方续取循环。契约:首页不带游标;续取按各维
// nextOffset 带游标;到底(末页 nextOffset 缺席)= 维度收完;取消半页/
// 游标不前进(超大条目卡死)/请求数超限 → null(C-19 降级),绝不把
// 半页冒充全量。全量小结果(无 `*Page` 键)零变化——上文既有钉。
describe('buildPythonCallGraphInRust 分页续取(RUST-077-W)', () => {
  const edge = (caller: string) => ({
    caller, callerLine: 0, callee: 'x', kind: 'local', filePath: '/f.py'
  });
  const fragment = (edges: unknown[], extra: Record<string, unknown> = {}) => ({
    nodes: [],
    edges,
    reverseIndex: {},
    dataflow: [],
    processRoles: ['cellapp'],
    stats: {
      fileCount: 1, nodeCount: 0, edgeCount: edges.length,
      dataflowCount: 0, errorCount: 0, byKind: {}
    },
    ...extra
  });
  const scriptedGate = (pages: Array<Record<string, unknown>>) => {
    const requests: Array<Record<string, unknown>> = [];
    let index = 0;
    const gate = {
      runInRust: async (_method: string, p: unknown) => {
        requests.push({ ...(p as Record<string, unknown>) });
        if (index >= pages.length) {
          return { ok: false, reason: 'script exhausted' };
        }
        const page = pages[index];
        index += 1;
        return { ok: true, result: page };
      }
    } as unknown as KodeCoreGate;
    return { gate, requests };
  };

  it('超限页续取:edges 两页按序拼回全量,完整维幂等,游标严格前进', async () => {
    // stats 是全量分析常量(与切片无关),各页一致;TS 取首页原样透出。
    const fullStats = {
      fileCount: 1, nodeCount: 0, edgeCount: 2, dataflowCount: 0, errorCount: 0, byKind: {}
    };
    const page1 = fragment([edge('a')], {
      stats: fullStats,
      edgePage: { offset: 0, nextOffset: 1, bytesEstimate: 64, total: 2 }
    });
    const page2 = fragment([edge('b')], {
      stats: fullStats,
      edgePage: { offset: 1, bytesEstimate: 64, total: 2 }
    });
    const { gate, requests } = scriptedGate([page1, page2]);
    setKodeCoreShadowGate(gate);
    try {
      const result = await buildPythonCallGraphInRust(params());
      expect(result).not.toBeNull();
      expect(requests).toHaveLength(2);
      expect(requests[0].edgeOffset).toBeUndefined();
      expect(requests[1].edgeOffset).toBe(1);
      expect(result?.edges.map(e => e.caller)).toEqual(['a', 'b']);
      expect(result?.nodes).toHaveLength(0);
      expect(result?.stats.edgeCount).toBe(2);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('四维同页并走:续取同请求携带四游标,reverseIndex 跨页合并且调用方去重', async () => {
    const node = (id: string) => ({ id, kind: 'method', name: id, filePath: '/f.py', line: 0 });
    const page1 = {
      ...fragment([edge('a')], {
        nodes: [node('n1')],
        dataflow: [{ filePath: '/f.py', method: 'a', chains: [] }],
        reverseIndex: { '/g.py': ['/f.py'] },
        edgePage: { offset: 0, nextOffset: 1 },
        nodePage: { offset: 0, nextOffset: 1 },
        dataflowPage: { offset: 0, nextOffset: 1 },
        reversePage: { offset: 0, nextOffset: 1 }
      })
    };
    const page2 = {
      ...fragment([edge('b')], {
        nodes: [node('n2')],
        dataflow: [{ filePath: '/f.py', method: 'b', chains: [] }],
        reverseIndex: { '/g.py': ['/f.py', '/h.py'] },
        edgePage: { offset: 1 },
        nodePage: { offset: 1 },
        dataflowPage: { offset: 1 },
        reversePage: { offset: 1 }
      })
    };
    const { gate, requests } = scriptedGate([page1, page2]);
    setKodeCoreShadowGate(gate);
    try {
      const result = await buildPythonCallGraphInRust(params());
      expect(result).not.toBeNull();
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        edgeOffset: 1, nodeOffset: 1, dataflowOffset: 1, reverseOffset: 1
      });
      expect(result?.nodes.map(n => n.id)).toEqual(['n1', 'n2']);
      expect(result?.dataflow.map(d => d.method)).toEqual(['a', 'b']);
      expect(result?.reverseIndex['/g.py']).toEqual(['/f.py', '/h.py']);
      expect(result?.processRoles).toEqual(['cellapp']);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('超大条目卡死(游标不前进)放弃续取返回 null,不冒充全量', async () => {
    const page1 = fragment([edge('a')], { edgePage: { offset: 0, nextOffset: 0, oversizedAt: 0 } });
    const { gate, requests } = scriptedGate([page1]);
    setKodeCoreShadowGate(gate);
    try {
      const result = await buildPythonCallGraphInRust(params());
      expect(result).toBeNull();
      expect(requests).toHaveLength(1);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('取消半页(cancelled)返回 null', async () => {
    const page1 = fragment([edge('a')], { edgePage: { offset: 0, nextOffset: 5, cancelled: true } });
    const { gate, requests } = scriptedGate([page1]);
    setKodeCoreShadowGate(gate);
    try {
      const result = await buildPythonCallGraphInRust(params());
      expect(result).toBeNull();
      expect(requests).toHaveLength(1);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('续取页调用失败(!ok)返回 null', async () => {
    const page1 = fragment([edge('a')], { edgePage: { offset: 0, nextOffset: 1 } });
    let index = 0;
    const gate = {
      runInRust: async () => {
        if (index === 0) {
          index += 1;
          return { ok: true, result: page1 };
        }
        return { ok: false, reason: 'server died mid-stream' };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(gate);
    try {
      const result = await buildPythonCallGraphInRust(params());
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('游标恒前进的病态服务被请求数上限兜住返回 null', async () => {
    let count = 0;
    const gate = {
      runInRust: async (_method: string, p: unknown) => {
        const sent = (p as { edgeOffset?: number }).edgeOffset ?? 0;
        count += 1;
        return {
          ok: true,
          result: fragment([], { edgePage: { offset: sent, nextOffset: sent + 1 } })
        };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(gate);
    try {
      const result = await buildPythonCallGraphInRust(params());
      expect(result).toBeNull();
      expect(count).toBe(10_000);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('终局维续发 total 空尾页保持终局,完整数组不被重复入账', async () => {
    // 服务端无状态:续取请求若漏带终局维游标,该维会被当新分页重新打开。
    // 契约 = 续取请求恒携带四游标(开启维 nextOffset,终局维 total)。
    const fullNode = (id: string) => ({ id, kind: 'method', name: id, filePath: '/f.py', line: 0 });
    const page1 = fragment(
      [edge('a')],
      { nodes: [fullNode('n1'), fullNode('n2')], edgePage: { offset: 0, nextOffset: 1, total: 2 } }
    );
    const page2 = fragment([edge('b')], { edgePage: { offset: 1, total: 2 } });
    const { gate, requests } = scriptedGate([page1, page2]);
    setKodeCoreShadowGate(gate);
    try {
      const result = await buildPythonCallGraphInRust(params());
      expect(result).not.toBeNull();
      expect(requests).toHaveLength(2);
      // page1 无 nodePage(nodes 全量)→ 终局,续取带 nodeOffset=total=2。
      expect(requests[1].nodeOffset).toBe(2);
      // page2 又携带完整 nodes(无 meta,服务端幂等)→ 终局维不重复入账。
      expect(result?.nodes.map(n => n.id)).toEqual(['n1', 'n2']);
      expect(result?.edges.map(e => e.caller)).toEqual(['a', 'b']);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('终局维被服务端复活(空尾页又给 nextOffset)拒绝返回 null', async () => {
    const page1 = fragment([edge('a')], { edgePage: { offset: 0, nextOffset: 1 } });
    const page2 = fragment([edge('b')], {
      edgePage: { offset: 1 },
      nodePage: { offset: 0, nextOffset: 5 }
    });
    const { gate, requests } = scriptedGate([page1, page2]);
    setKodeCoreShadowGate(gate);
    try {
      const result = await buildPythonCallGraphInRust(params());
      expect(result).toBeNull();
      expect(requests).toHaveLength(2);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });
});

// KR-AUD-89(RSV-8 防回归登记):Rust file_stem 只按 '/' 分割
// (python_callgraph.rs:161)——斜杠归一在 RPC 边界完成,契约由两侧断言锁死。
describe('normalizeCallGraphPath (KR-AUD-89 上游斜杠归一)', () => {
  it('反斜杠路径归一为 /,POSIX 路径不变', () => {
    expect(normalizeCallGraphPath('C:\\ws\\scripts\\cell\\Avatar.py')).toBe(
      'C:/ws/scripts/cell/Avatar.py'
    );
    expect(normalizeCallGraphPath('/already/posix.py')).toBe('/already/posix.py');
  });

  it('buildPythonCallGraphInRust 发出的 files.path 全为 / 分隔', async () => {
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (_method: string, p: unknown) => {
        calledParams = p;
        return { ok: true, result: cannedGraph() };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      await buildPythonCallGraphInRust({
        files: [{ path: 'scripts\\cell\\Avatar.py', text: 'def f():\n    pass\n' }]
      });
      const files = (calledParams as { files: Array<{ path: string }> }).files;
      expect(files[0].path).toBe('scripts/cell/Avatar.py');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });
});

