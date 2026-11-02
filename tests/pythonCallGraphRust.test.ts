import { describe, expect, it } from 'vitest';
import {
  buildPythonCallGraphInRust,
  buildPythonSymbolsInRust
} from '../src/pythonCallGraphRust';
import type { KodeCoreGate } from '../src/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';

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
