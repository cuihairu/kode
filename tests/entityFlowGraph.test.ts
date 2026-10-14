import { describe, expect, it } from 'vitest';
import type {
  DefinitionMethod,
  DefinitionProperty,
  ResolvedDefinitionSemantics
} from '../src/definitionSemantics';
import {
  ED_FLAG_BITS,
  FLOW_ACTOR_LABELS,
  PROPERTY_FLAG_BITS,
  buildEntityFlowGraph,
  describePropertyFlagSemantics,
  renderEntityFlowMarkdown,
  renderEntityFlowMermaid
} from '../src/entityFlowGraph';
import type { EntityFlowGraph } from '../src/entityFlowGraph';

// 纯流程图模型(批124):旗标位语义、图构建、mermaid/markdown 渲染。
// 位值与映射表逐项锁死引擎 entitydef/common.h L19-28 与 entitydef.cpp L161-174,
// 防止后续改表时静默漂移。buildEntityFlowGraph 只读
// owner / effectiveProperties / effectiveMethodsBySection,其余字段以最小占位满足类型。

const OWNER = {
  kind: 'entity',
  name: 'Hero',
  filePath: '/ws/entities/Hero.def'
} as const;

const prop = (over: Partial<DefinitionProperty> = {}): DefinitionProperty => ({
  name: 'hp',
  fullPath: 'hp',
  line: 3,
  typeName: 'UINT32',
  flags: 'BASE',
  persistent: false,
  owner: OWNER,
  source: { kind: 'local', chain: ['Hero'], label: 'Hero.def 本地' },
  children: [],
  ...over
});

const method = (
  over: Partial<DefinitionMethod> = {}
): DefinitionMethod => ({
  name: 'doIt',
  line: 5,
  section: 'BaseMethods',
  args: [],
  argTypes: [],
  exposed: false,
  utype: null,
  owner: OWNER,
  source: { kind: 'local', chain: ['Hero'], label: 'Hero.def 本地' },
  ...over
});

const semantics = (
  over: Partial<ResolvedDefinitionSemantics> = {}
): ResolvedDefinitionSemantics => ({
  category: 'entity',
  owner: OWNER,
  local: {} as ResolvedDefinitionSemantics['local'],
  inheritanceGroups: [],
  effectiveProperties: [],
  effectiveMethodsBySection: { BaseMethods: [], CellMethods: [], ClientMethods: [] },
  components: [],
  ...over
});

const flow = (
  methods: {
    base?: DefinitionMethod[];
    cell?: DefinitionMethod[];
    client?: DefinitionMethod[];
  } = {},
  properties: DefinitionProperty[] = [],
  hasCell = true
): EntityFlowGraph =>
  buildEntityFlowGraph({
    semantics: semantics({
      effectiveProperties: properties,
      effectiveMethodsBySection: {
        BaseMethods: methods.base ?? [],
        CellMethods: methods.cell ?? [],
        ClientMethods: methods.client ?? []
      }
    }),
    hasCell
  });

describe('ED_FLAG_BITS 与 PROPERTY_FLAG_BITS 对齐引擎位值', () => {
  it('8 个旗标位与 common.h 枚举一致', () => {
    expect(ED_FLAG_BITS).toEqual({
      CELL_PUBLIC: 1,
      CELL_PRIVATE: 2,
      ALL_CLIENTS: 4,
      CELL_PUBLIC_AND_OWN: 8,
      OWN_CLIENT: 16,
      BASE_AND_CLIENT: 32,
      BASE: 64,
      OTHER_CLIENTS: 128
    });
  });

  it('映射表覆盖引擎 12 个拼写,别名落在目标位上', () => {
    expect(PROPERTY_FLAG_BITS).toEqual({
      BASE: ED_FLAG_BITS.BASE,
      BASE_AND_CLIENT: ED_FLAG_BITS.BASE_AND_CLIENT,
      CELL: ED_FLAG_BITS.CELL_PUBLIC,
      CELL_PUBLIC: ED_FLAG_BITS.CELL_PUBLIC,
      CELL_PRIVATE: ED_FLAG_BITS.CELL_PRIVATE,
      ALL_CLIENTS: ED_FLAG_BITS.ALL_CLIENTS,
      CELL_AND_CLIENTS: ED_FLAG_BITS.ALL_CLIENTS,
      CELL_PUBLIC_AND_OWN: ED_FLAG_BITS.CELL_PUBLIC_AND_OWN,
      CELL_AND_CLIENT: ED_FLAG_BITS.CELL_PUBLIC_AND_OWN,
      OWN_CLIENT: ED_FLAG_BITS.OWN_CLIENT,
      OTHER_CLIENTS: ED_FLAG_BITS.OTHER_CLIENTS,
      CELL_AND_OTHER_CLIENTS: ED_FLAG_BITS.OTHER_CLIENTS
    });
  });
});

describe('describePropertyFlagSemantics', () => {
  it('空串与缺省都归零,不误判任何域', () => {
    expect(describePropertyFlagSemantics('').flags).toBe('');
    expect(describePropertyFlagSemantics().flags).toBe('');
    for (const flags of ['', undefined]) {
      const out = describePropertyFlagSemantics(flags);
      expect(out).toEqual({
        flags: '',
        bits: 0,
        base: false,
        cell: false,
        client: false,
        broadcastCells: false,
        broadcastOtherClients: false,
        broadcastOwnClient: false,
        unknownFlags: []
      });
    }
  });

  it('BASE 只注册 base 域,不触发任何广播', () => {
    expect(describePropertyFlagSemantics('BASE')).toMatchObject({
      flags: 'BASE',
      bits: 64,
      base: true,
      cell: false,
      client: false,
      broadcastCells: false,
      broadcastOtherClients: false,
      broadcastOwnClient: false,
      unknownFlags: []
    });
  });

  it('CELL_PRIVATE 只注册 cell 域:留在当前 cell,不广播', () => {
    expect(describePropertyFlagSemantics('CELL_PRIVATE')).toMatchObject({
      cell: true,
      base: false,
      client: false,
      broadcastCells: false,
      broadcastOtherClients: false,
      broadcastOwnClient: false
    });
  });

  it('BASE_AND_CLIENT 同步到自己的客户端但不广播其它客户端', () => {
    expect(describePropertyFlagSemantics('BASE_AND_CLIENT')).toMatchObject({
      base: true,
      client: true,
      cell: false,
      broadcastCells: false,
      broadcastOtherClients: false,
      broadcastOwnClient: true
    });
  });

  it('OWN_CLIENT 走 cell 面同步给自己的客户端,不跨 cell', () => {
    expect(describePropertyFlagSemantics('OWN_CLIENT')).toMatchObject({
      cell: true,
      client: true,
      broadcastCells: false,
      broadcastOtherClients: false,
      broadcastOwnClient: true
    });
  });

  it('CELL_PUBLIC 与 CELL_PUBLIC_AND_OWN 需广播给其它 cell', () => {
    for (const flags of ['CELL_PUBLIC', 'CELL_PUBLIC_AND_OWN']) {
      expect(describePropertyFlagSemantics(flags).broadcastCells).toBe(true);
    }
    expect(describePropertyFlagSemantics('CELL_PUBLIC').broadcastOtherClients).toBe(false);
    expect(describePropertyFlagSemantics('CELL_PUBLIC_AND_OWN')).toMatchObject({
      client: true,
      broadcastOwnClient: true
    });
  });

  it('ALL_CLIENTS 与 OTHER_CLIENTS 同时命中跨 cell 与其它客户端广播', () => {
    for (const flags of ['ALL_CLIENTS', 'OTHER_CLIENTS']) {
      expect(describePropertyFlagSemantics(flags)).toMatchObject({
        cell: true,
        client: true,
        broadcastCells: true,
        broadcastOtherClients: true
      });
    }
    expect(describePropertyFlagSemantics('OTHER_CLIENTS').broadcastOwnClient).toBe(false);
  });

  it('大小写无关并归一成大写旗标串', () => {
    expect(describePropertyFlagSemantics('cell_public')).toMatchObject({
      flags: 'CELL_PUBLIC',
      cell: true
    });
  });

  it('别名拼写落到与目标旗标同一位', () => {
    expect(describePropertyFlagSemantics('CELL').bits).toBe(ED_FLAG_BITS.CELL_PUBLIC);
    expect(describePropertyFlagSemantics('CELL_AND_CLIENT').bits).toBe(
      ED_FLAG_BITS.CELL_PUBLIC_AND_OWN
    );
    expect(describePropertyFlagSemantics('CELL_AND_CLIENTS').bits).toBe(ED_FLAG_BITS.ALL_CLIENTS);
    expect(describePropertyFlagSemantics('CELL_AND_OTHER_CLIENTS').bits).toBe(
      ED_FLAG_BITS.OTHER_CLIENTS
    );
  });

  it('组合旗标按位或叠加', () => {
    const out = describePropertyFlagSemantics('CELL_PUBLIC|OWN_CLIENT');
    expect(out.flags).toBe('CELL_PUBLIC|OWN_CLIENT');
    expect(out.bits).toBe(ED_FLAG_BITS.CELL_PUBLIC | ED_FLAG_BITS.OWN_CLIENT);
    expect(out).toMatchObject({
      cell: true,
      client: true,
      broadcastCells: true,
      broadcastOwnClient: true,
      broadcastOtherClients: false
    });
  });

  it('未知拼写单列保留,不吞掉同串里的合法旗标', () => {
    expect(describePropertyFlagSemantics('BOGUS').unknownFlags).toEqual(['BOGUS']);
    expect(describePropertyFlagSemantics('BASE|BOGUS')).toMatchObject({
      base: true,
      unknownFlags: ['BOGUS']
    });
    // 重复未知拼写去重
    expect(describePropertyFlagSemantics('BOGUS|BOGUS').unknownFlags).toEqual(['BOGUS']);
  });

  it('纯空白片段被丢弃', () => {
    expect(describePropertyFlagSemantics('BASE || OWNER ')).toMatchObject({
      flags: 'BASE|OWNER',
      base: true,
      unknownFlags: ['OWNER']
    });
  });
});

describe('buildEntityFlowGraph 方法面', () => {
  it('Exposed 方法画客户端→服务端边,非 Exposed 进 blocked 清单', () => {
    const graph = flow({
      base: [method({ name: 'doA', exposed: true }), method({ name: 'doB', exposed: false })],
      cell: [method({ name: 'move', section: 'CellMethods', exposed: true })],
      client: []
    });

    const toBase = graph.edges.find(edge => edge.id === 'method-client-base');
    expect(toBase).toMatchObject({
      from: 'client',
      to: 'base',
      kind: 'method',
      semantic: '客户端远程调用 base 方法(1 个 Exposed)',
      flags: []
    });
    expect(toBase?.members).toEqual([
      {
        name: 'doA',
        kind: 'method',
        exposed: true,
        source: 'Hero.def 本地',
        filePath: '/ws/entities/Hero.def',
        line: 5
      }
    ]);
    // 客户端直达 base 实体 + Exposed 闸门两处出处
    expect(toBase?.citations.map(citation => citation.file)).toEqual([
      'kbe/src/server/baseapp/baseapp_interface.h',
      'kbe/src/server/baseapp/entity.cpp'
    ]);

    const toCell = graph.edges.find(edge => edge.id === 'method-client-cell');
    expect(toCell?.citations.map(citation => citation.file)).toEqual([
      'kbe/src/server/baseapp/baseapp.cpp',
      'kbe/src/server/cellapp/cellapp_interface.h',
      'kbe/src/server/cellapp/entity.cpp'
    ]);
    expect(toCell?.semantic).toContain('经 baseapp 转发');

    expect(graph.blocked).toEqual([
      {
        method: 'doB',
        section: 'BaseMethods',
        source: 'Hero.def 本地',
        filePath: '/ws/entities/Hero.def',
        line: 5,
        reason: '未标 <Exposed>,客户端远程调用会被引擎拒绝',
        citation: {
          file: 'kbe/src/server/baseapp/entity.cpp',
          line: 960,
          note: expect.any(String)
        }
      }
    ]);
    expect(graph.stats.blockedCalls).toBe(1);
  });

  it('blockedCalls 计数按区块分别累积', () => {
    const graph = flow({
      base: [method({ name: 'localB' })],
      cell: [method({ name: 'localC', section: 'CellMethods' })],
      client: []
    });

    expect(graph.stats.blockedCalls).toBe(2);
    expect(graph.blocked.map(entry => entry.method)).toEqual(['localB', 'localC']);
    expect(graph.blocked[1].citation.file).toBe('kbe/src/server/cellapp/entity.cpp');
    expect(graph.edges).toEqual([]);
  });

  it('ClientMethods 画服务端→客户端回调边,有 cell 面时 cell 侧同样能调', () => {
    const withCell = flow({ client: [method({ name: 'onTick', section: 'ClientMethods' })] });
    expect(withCell.edges.map(edge => edge.id)).toContain('method-base-client');
    expect(withCell.edges.map(edge => edge.id)).toContain('method-cell-client');
    const cellSide = withCell.edges.find(edge => edge.id === 'method-cell-client');
    expect(cellSide?.semantic).toBe('cell 调用客户端回调方法(1 个 ClientMethods)');
    expect(cellSide?.citations.map(citation => citation.file)).toEqual([
      'kbe/src/lib/client_lib/client_interface.h',
      'kbe/src/lib/client_lib/clientobjectbase.cpp'
    ]);

    const withoutCell = flow(
      { client: [method({ name: 'onTick', section: 'ClientMethods' })] },
      [],
      false
    );
    expect(withoutCell.edges.map(edge => edge.id)).toEqual(['method-base-client']);
  });

  it('无 ClientMethods 时不画任何回调边', () => {
    const graph = flow({}, [prop()]);
    expect(graph.edges.every(edge => edge.kind !== 'method')).toBe(true);
    expect(graph.stats.clientCallbacks).toBe(0);
  });

  it('空实体给出空图与全零统计', () => {
    const graph = flow({}, [], false);
    expect(graph.edges).toEqual([]);
    expect(graph.actors).toEqual([]);
    expect(graph.blocked).toEqual([]);
    expect(graph.stats).toEqual({
      properties: 0,
      methods: 0,
      exposedCalls: 0,
      clientCallbacks: 0,
      persistentProperties: 0,
      blockedCalls: 0
    });
    expect(graph.hasCell).toBe(false);
    expect(graph.defFilePath).toBe('/ws/entities/Hero.def');
  });
});

describe('buildEntityFlowGraph 属性面', () => {
  it('带 cell 位的属性画 cell→base 自动备份边', () => {
    const graph = flow(
      {},
      [prop({ name: 'hp', flags: 'CELL_PRIVATE' }), prop({ name: 'pos', flags: 'ALL_CLIENTS' })],
      true
    );
    const edge = graph.edges.find(item => item.id === 'property-cell-base');
    expect(edge).toMatchObject({
      from: 'cell',
      to: 'base',
      kind: 'property',
      flags: ['ALL_CLIENTS', 'CELL_PRIVATE']
    });
    expect(edge?.citations.map(citation => [citation.file, citation.line])).toEqual([
      ['kbe/src/server/cellapp/entity.cpp', 1129],
      ['kbe/src/server/baseapp/baseapp.cpp', 4674]
    ]);
  });

  it('BASE_AND_CLIENT 属性由 base 侧推自己的客户端', () => {
    const graph = flow({}, [prop({ name: 'score', flags: 'BASE_AND_CLIENT' })]);
    expect(graph.edges.map(edge => edge.id)).toContain('property-base-client');
    expect(graph.edges.map(edge => edge.id)).not.toContain('property-cell-client');
    const edge = graph.edges.find(item => item.id === 'property-base-client');
    expect(edge?.citations.map(citation => citation.file)).toEqual([
      'kbe/src/server/baseapp/entity.cpp',
      'kbe/src/lib/client_lib/client_interface.h'
    ]);
  });

  it('只在 cell 面同步的客户端可见属性画 cell→client 边', () => {
    const graph = flow({}, [prop({ name: 'speed', flags: 'OWN_CLIENT' })]);
    const ids = graph.edges.map(edge => edge.id);
    expect(ids).toContain('property-cell-client');
    expect(ids).not.toContain('property-base-client');
    expect(graph.edges.find(edge => edge.id === 'property-cell-client')?.citations[0].line).toBe(851);
  });

  it('ALL_CLIENTS 属性广播 AOI 内其它客户端与其它 cellapp', () => {
    const graph = flow({}, [prop({ name: 'pos', flags: 'ALL_CLIENTS' })], true);
    const ids = graph.edges.map(edge => edge.id);
    expect(ids).toContain('property-cell-aoi');
    expect(ids).toContain('property-cell-othercell');
    expect(graph.edges.find(edge => edge.id === 'property-cell-othercell')?.citations[0]).toMatchObject({
      file: 'kbe/src/lib/entitydef/common.h',
      line: 47
    });
  });

  it('无 cell 面时不出跨 cellapp 广播边', () => {
    const containsOtherCell = expect.arrayContaining([
      expect.objectContaining({ id: 'property-cell-othercell' })
    ]);
    expect(flow({}, [prop({ flags: 'ALL_CLIENTS' })], true).edges).toEqual(containsOtherCell);
    expect(flow({}, [prop({ flags: 'ALL_CLIENTS' })], false).edges).not.toEqual(containsOtherCell);
  });

  it('CELL_PUBLIC 只广播其它 cellapp,不推客户端', () => {
    const graph = flow({}, [prop({ name: 'hp', flags: 'CELL_PUBLIC' })], true);
    const ids = graph.edges.map(edge => edge.id);
    expect(ids).toContain('property-cell-othercell');
    expect(ids).not.toContain('property-cell-aoi');
    expect(ids).not.toContain('property-base-client');
    expect(ids).not.toContain('property-cell-client');
  });

  it('容器属性结构进成员:ARRAY 落 [].value,FIXED_DICT 落子键', () => {
    const graph = flow({}, [
      prop({
        name: 'slots',
        flags: 'BASE_AND_CLIENT',
        arrayElement: prop({ name: 'value', line: 9 })
      }),
      prop({
        name: 'bag',
        flags: 'BASE_AND_CLIENT',
        children: [prop({ name: 'gold', line: 11 }), prop({ name: 'gem', line: 13 })]
      })
    ]);
    const members = graph.edges.flatMap(edge => edge.members);
    expect(members.find(item => item.name === 'slots')?.structure).toEqual(['[].value']);
    expect(members.find(item => item.name === 'bag')?.structure).toEqual(['gold', 'gem']);
  });

  it('成员旗标走归一化串,持久标记只取 true', () => {
    const graph = flow({}, [
      prop({ name: 'a', flags: 'cell', persistent: true }),
      prop({ name: 'b', flags: 'BASE_AND_CLIENT', persistent: false })
    ]);
    const members = graph.edges.flatMap(edge => edge.members);
    expect(members.find(item => item.name === 'a')).toMatchObject({
      name: 'a',
      kind: 'property',
      flags: 'CELL',
      persistent: true,
      structure: []
    });
    expect(members.find(item => item.name === 'b')?.persistent).toBe(false);
  });
});

describe('buildEntityFlowGraph 落库面', () => {
  it('base 面持久属性由 baseapp 回写,有 cell 面时改走 cell 转写', () => {
    const graph = flow({}, [prop({ name: 'hp', flags: 'BASE', persistent: true })], true);
    const edge = graph.edges.find(item => item.id === 'persistence-base-db');
    expect(edge?.citations.map(citation => [citation.file, citation.line])).toEqual([
      ['kbe/src/server/baseapp/entity.cpp', 102],
      ['kbe/src/server/baseapp/entity.cpp', 1141],
      ['kbe/src/server/baseapp/entity.cpp', 1224]
    ]);
    expect(edge?.semantic).toContain('经 cell 转写');

    const baseOnly = flow({}, [prop({ flags: 'BASE', persistent: true })], false);
    const plain = baseOnly.edges.find(item => item.id === 'persistence-base-db');
    expect(plain?.citations.length).toBe(2);
    expect(plain?.semantic).not.toContain('转写');
  });

  it('只挂 cell 面的持久属性由 cell 回写,不出 base 落库边', () => {
    const graph = flow({}, [prop({ name: 'hp', flags: 'CELL_PRIVATE', persistent: true })], true);
    const ids = graph.edges.map(edge => edge.id);
    expect(ids).toContain('persistence-cell-db');
    expect(ids).not.toContain('persistence-base-db');
    expect(graph.edges.find(edge => edge.id === 'persistence-cell-db')?.citations.map(citation => [
      citation.file,
      citation.line
    ])).toEqual([
      ['kbe/src/server/baseapp/entity.cpp', 102],
      ['kbe/src/server/baseapp/entity.cpp', 1224]
    ]);
  });

  it('无持久属性时不出落库边', () => {
    const graph = flow({}, [prop({ flags: 'BASE', persistent: false })]);
    expect(graph.edges.map(edge => edge.kind)).not.toContain('persistence');
    expect(graph.stats.persistentProperties).toBe(0);
  });
});

describe('buildEntityFlowGraph 参与方与统计', () => {
  it('actors 只保留真正出现在边上的参与方', () => {
    const baseOnly = flow({}, [prop({ flags: 'BASE', persistent: true })], false);
    expect(baseOnly.actors).toEqual(['base', 'db']);
    expect(Object.values(FLOW_ACTOR_LABELS)).toEqual([
      '客户端实体',
      'baseapp 实体',
      'cellapp 实体',
      '空间广播（其它 cell / 其它客户端）',
      'dbmgr（MySQL）'
    ]);
  });

  it('统计按 effective 集合与暴露面累加', () => {
    const graph = flow(
      {
        base: [method({ name: 'a', exposed: true }), method({ name: 'b' })],
        cell: [method({ name: 'c', section: 'CellMethods', exposed: true })],
        client: [method({ name: 'cb', section: 'ClientMethods' })]
      },
      [
        prop({ name: 'p1', flags: 'BASE', persistent: true }),
        prop({ name: 'p2', flags: 'ALL_CLIENTS' })
      ]
    );

    expect(graph.stats).toEqual({
      properties: 2,
      methods: 4,
      exposedCalls: 2,
      clientCallbacks: 1,
      persistentProperties: 1,
      blockedCalls: 1
    });
    expect(graph.actors).toEqual(['client', 'base', 'cell', 'aoi', 'db']);
  });
});

describe('renderEntityFlowMermaid', () => {
  it('参与方作节点,边标签带语义,classDef 覆盖所有参与方', () => {
    const graph = flow(
      { base: [method({ name: 'a', exposed: true })] },
      [prop({ flags: 'BASE', persistent: true })]
    );
    const mermaid = renderEntityFlowMermaid(graph);

    expect(mermaid).toBeTypeOf('string');
    expect(mermaid.startsWith('graph LR\n')).toBe(true);
    expect(mermaid).toContain('  client["客户端实体"]');
    expect(mermaid).toContain('  base["baseapp 实体"]');
    expect(mermaid).toContain('  db["dbmgr（MySQL）"]');
    expect(mermaid).toContain('  client -->|"客户端远程调用 base 方法(1 个 Exposed)"| base');
    expect(mermaid).toContain('  classDef client fill:#fff8e1,stroke:#f9a825,stroke-width:2px;');
    expect(mermaid).toContain('  class base base;');
    expect(mermaid.endsWith('\n')).toBe(true);
  });

  it('标签里的引号井号方括号转成全角,mermaid 不断标签', () => {
    const graph: EntityFlowGraph = {
      entityName: 'Hero',
      defFilePath: '/ws/entities/Hero.def',
      hasCell: false,
      actors: ['client', 'base'],
      edges: [
        {
          id: 'e1',
          from: 'client',
          to: 'base',
          kind: 'method',
          semantic: '# " [ ]',
          flags: [],
          members: [],
          citations: []
        }
      ],
      blocked: [],
      stats: {
        properties: 0,
        methods: 0,
        exposedCalls: 0,
        clientCallbacks: 0,
        persistentProperties: 0,
        blockedCalls: 0
      }
    };

    expect(renderEntityFlowMermaid(graph)).toContain(
      '  client -->|"＃ ＂ ［ ］"| base'
    );
  });

  it('无边时只有图头,不留空箭头', () => {
    const graph = flow({}, [], false);
    expect(renderEntityFlowMermaid(graph)).toBe('graph LR\n');
  });
});

describe('renderEntityFlowMarkdown', () => {
  it('表头给出定义文件、cell 面与统计行', () => {
    const graph = flow({}, [prop({ flags: 'BASE', persistent: true })], false);
    const md = renderEntityFlowMarkdown(graph);

    expect(md).toContain('# KBEngine 架构流程图：Hero');
    expect(md).toContain('定义文件：/ws/entities/Hero.def');
    expect(md).toContain('实体有 cell 面：否');
    expect(md).toContain('属性 1 / 方法 0 / 客户端可调 0 / 客户端回调 0 / 持久属性 1');
  });

  it('逐边输出语义、旗标、引擎出处与成员清单', () => {
    const graph = flow(
      {
        base: [method({ name: 'a', exposed: true })],
        cell: [method({ name: 'b', section: 'CellMethods' })]
      },
      [prop({ name: 'p', flags: 'BASE', persistent: true })],
      true
    );
    const md = renderEntityFlowMarkdown(graph);

    expect(md).toContain('## 客户端实体 → baseapp 实体（method）');
    expect(md).toContain('## baseapp 实体 → dbmgr（MySQL）（persistence）');
    expect(md).toContain('语义：客户端远程调用 base 方法(1 个 Exposed)');
    expect(md).toContain('旗标：`BASE`');
    expect(md).toContain('- `kbe/src/server/baseapp/baseapp_interface.h:306` —');
    expect(md).toContain('- `a`（Exposed）— Hero.def 本地 · `/ws/entities/Hero.def:5`');
    expect(md).toContain('- `p`（BASE · Persistent）— Hero.def 本地 · `/ws/entities/Hero.def:3`');
    expect(md).toContain('## 客户端调不到的方法');
    expect(md).toContain(
      '- `b`（CellMethods，Hero.def 本地）— 未标 <Exposed>,客户端远程调用会被引擎拒绝'
    );
  });

  it('成员结构路径以反引号列出', () => {
    const graph = flow({}, [
      prop({
        name: 'slots',
        flags: 'BASE_AND_CLIENT',
        arrayElement: prop({ name: 'value' })
      })
    ]);
    expect(renderEntityFlowMarkdown(graph)).toContain(
      '`slots`（BASE_AND_CLIENT · 结构 `[].value`）'
    );
  });

  it('空边给出占位说明;缺省可选字段的成员仍可读', () => {
    expect(renderEntityFlowMarkdown(flow({}, [], false))).toContain(
      '（该实体没有可展示的调用或同步关系）'
    );

    const graph: EntityFlowGraph = {
      entityName: 'Ghost',
      defFilePath: '/ws/entities/Ghost.def',
      hasCell: true,
      actors: ['client', 'cell'],
      edges: [
        {
          id: 'e1',
          from: 'cell',
          to: 'client',
          kind: 'property',
          semantic: 'cell 属性推送',
          flags: [],
          members: [
            { name: 'speed', kind: 'property', source: '本地', filePath: '/g.def', line: 2 },
            { name: 'noop', kind: 'method', source: '本地', filePath: '/g.def', line: 3 }
          ],
          citations: []
        }
      ],
      blocked: [],
      stats: {
        properties: 1,
        methods: 1,
        exposedCalls: 0,
        clientCallbacks: 0,
        persistentProperties: 0,
        blockedCalls: 0
      }
    };

    const md = renderEntityFlowMarkdown(graph);
    expect(md).toContain('- `speed`（）— 本地 · `/g.def:2`');
    expect(md).toContain('- `noop`（非 Exposed）— 本地 · `/g.def:3`');
    expect(md).not.toContain('旗标：');
  });
});
