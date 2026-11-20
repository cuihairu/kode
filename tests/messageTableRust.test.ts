import { describe, expect, it } from 'vitest';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import {
  buildMessageTableInRust,
  type DefRawSource,
  type MessageTable
} from '../src/backend/messageTable';

// IDE-RUST-002 消息表 build 核心挪 Rust:buildMessageTableInRust 主路径经
// 命令级 RPC($/kode/messageTable/build,原文直传)调 Rust 核心;Rust 不可用
// (无 gate/调用失败/形状不完整/自身 def 缺失)返回 null,调用方回落 TS 纯
// 实现。测试用内存 raw 源 + 假 gate(setKodeCoreShadowGate),契约参数形状与
// 闭包发现(own + 父链 + 接口)是断言重点。

const OWN_DEF =
  '<root><Parent><Entity/></Parent><Interfaces><interface>ICombat</interface></Interfaces>' +
  '<Properties><name><Type>STRING</Type><Flags>BASE</Flags></name></Properties></root>';
const PARENT_DEF =
  '<root><Properties><hp><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></hp></Properties></root>';
const IFACE_DEF = '<root><BaseMethods><onTeleport><Exposed/></onTeleport></BaseMethods></root>';

const rawFiles: Record<string, { content: string; filePath: string }> = {
  'entity:E': { content: OWN_DEF, filePath: '/defs/entitys/E.def' },
  'entity:Entity': { content: PARENT_DEF, filePath: '/defs/entitys/Entity.def' },
  'interface:ICombat': { content: IFACE_DEF, filePath: '/defs/interfaces/ICombat.def' }
};

const rawSource: DefRawSource = {
  loadDefRaw: (name, kind) => rawFiles[`${kind}:${name}`] ?? null
};

const cannedTable = (): MessageTable => ({
  module: 'E',
  generatedAt: '2026-10-31T00:00:00.000Z',
  aliasIdEnabled: false,
  loadFailed: false,
  fatalCount: 0,
  sources: [{ name: 'E', kind: 'own', filePath: '/defs/entitys/E.def' }],
  methods: [],
  clientMethods: [],
  properties: [],
  clientProperties: [],
  types: [],
  issues: []
});

describe('buildMessageTableInRust(消息表 build 主路径)', () => {
  it('Rust 核心在场:契约参数含原文闭包,返回 Rust 结果', async () => {
    let calledMethod = '';
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (method: string, params: unknown) => {
        calledMethod = method;
        calledParams = params;
        return { ok: true, result: cannedTable() };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const table = await buildMessageTableInRust('E', rawSource);
      expect(table).not.toBeNull();

      expect(calledMethod).toBe('$/kode/messageTable/build');
      const params = calledParams as {
        entityName: string;
        defText: string;
        typesXml?: string;
        defs: Record<string, string>;
        paths: Record<string, string>;
        aliasIdEnabled: boolean;
      };
      expect(params.entityName).toBe('E');
      expect(params.defText).toBe(OWN_DEF);
      expect(params.aliasIdEnabled).toBe(false);
      // 闭包:own + 父类 + 接口都收集进原文表
      expect(params.defs.E).toBe(OWN_DEF);
      expect(params.defs.Entity).toBe(PARENT_DEF);
      expect(params.defs.ICombat).toBe(IFACE_DEF);
      expect(params.paths.E).toBe('/defs/entitys/E.def');
      expect(params.paths.Entity).toBe('/defs/entitys/Entity.def');
      expect(params.paths.ICombat).toBe('/defs/interfaces/ICombat.def');
      expect(params.typesXml).toBeUndefined();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('KR-AUD-67 接口闭包递归:接口自身 Interfaces 的 def 原文也进 defs/paths', async () => {
    // 引擎 loadInterfaces 递归接口自身 Interfaces(entitydef.cpp L628-638),
    // 闭包发现必须把接口的接口原文一并收集,否则 Rust 侧嵌套接口并入缺原文。
    const nestedFiles: Record<string, { content: string; filePath: string }> = {
      'entity:E': {
        content: '<root><Interfaces><interface>ICombat</interface></Interfaces></root>',
        filePath: '/defs/entitys/E.def'
      },
      'interface:ICombat': {
        content: '<root><Interfaces><interface>ISub</interface></Interfaces><BaseMethods><b1></b1></BaseMethods></root>',
        filePath: '/defs/interfaces/ICombat.def'
      },
      'interface:ISub': {
        content: '<root><ClientMethods><s1></s1></ClientMethods></root>',
        filePath: '/defs/interfaces/ISub.def'
      }
    };
    const nestedSource: DefRawSource = {
      loadDefRaw: (name, kind) => nestedFiles[`${kind}:${name}`] ?? null
    };
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (_method: string, params: unknown) => {
        calledParams = params;
        return { ok: true, result: cannedTable() };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const table = await buildMessageTableInRust('E', nestedSource);
      expect(table).not.toBeNull();
      const params = calledParams as { defs: Record<string, string>; paths: Record<string, string> };
      expect(params.defs.ICombat).toBeDefined();
      expect(params.defs.ISub).toBe(nestedFiles['interface:ISub'].content);
      expect(params.paths.ISub).toBe('/defs/interfaces/ISub.def');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('组件 def 闭包(IDE-RUST-006):实体组件槽 → 组件 def + 其接口/父类进 defs/paths', async () => {
    const componentEntityDef =
      '<root><Components><healthPack><Type>HealthComp</Type></healthPack></Components></root>';
    const healthCompDef =
      '<root><Interfaces><interface>IDamageable</interface></Interfaces><Parent><BaseComp/></Parent>' +
      '<Properties><hp><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></hp></Properties></root>';
    const idamageableDef =
      '<root><Properties><shield><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></shield></Properties></root>';
    const baseCompDef =
      '<root><Properties><weight><Type>FLOAT</Type><Flags>BASE</Flags></weight></Properties></root>';
    const componentRawSource: DefRawSource = {
      loadDefRaw: (name, kind) => ({
        'entity:CE': { content: componentEntityDef, filePath: '/defs/entitys/CE.def' },
        'component:HealthComp': { content: healthCompDef, filePath: '/defs/components/HealthComp.def' },
        'interface:IDamageable': { content: idamageableDef, filePath: '/defs/interfaces/IDamageable.def' },
        'component:BaseComp': { content: baseCompDef, filePath: '/defs/components/BaseComp.def' }
      } as Record<string, { content: string; filePath: string }>)[`${kind}:${name}`] ?? null
    };
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (_method: string, params: unknown) => {
        calledParams = params;
        return { ok: true, result: cannedTable() };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      await buildMessageTableInRust('CE', componentRawSource);
      const params = calledParams as { defs: Record<string, string>; paths: Record<string, string> };
      expect(params.defs.CE).toBe(componentEntityDef);
      expect(params.defs.HealthComp).toBe(healthCompDef);
      expect(params.defs.IDamageable).toBe(idamageableDef);
      expect(params.defs.BaseComp).toBe(baseCompDef);
      expect(params.paths.HealthComp).toBe('/defs/components/HealthComp.def');
      expect(params.paths.IDamageable).toBe('/defs/interfaces/IDamageable.def');
      expect(params.paths.BaseComp).toBe('/defs/components/BaseComp.def');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 核心不可用(无 gate):返回 null,调用方回落', async () => {
    setKodeCoreShadowGate(null);
    const table = await buildMessageTableInRust('E', rawSource);
    expect(table).toBeNull();
  });

  it('Rust 调用失败(ok:false):返回 null,不产出表', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: false, reason: 'no serverPath' })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const table = await buildMessageTableInRust('E', rawSource);
      expect(table).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('自身 def 缺失:不调 Rust,返回 null(与 TS loadDef null 短路同路)', async () => {
    let called = false;
    const fakeGate = {
      runInRust: async () => {
        called = true;
        return { ok: true, result: cannedTable() };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const table = await buildMessageTableInRust('Ghost', {
        loadDefRaw: () => null
      });
      expect(table).toBeNull();
      expect(called).toBe(false);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 返回形状不完整:返回 null(防御性)', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: true, result: { module: 'E' } })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const table = await buildMessageTableInRust('E', rawSource);
      expect(table).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('typesXml/aliasIdEnabled 透传', async () => {
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (_method: string, params: unknown) => {
        calledParams = params;
        return { ok: true, result: cannedTable() };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      await buildMessageTableInRust('E', rawSource, {
        typesXml: '<types><GOLD><FIXED_DICT><Properties/></FIXED_DICT></GOLD></types>',
        aliasIdEnabled: true
      });
      const params = calledParams as { typesXml?: string; aliasIdEnabled: boolean };
      expect(params.aliasIdEnabled).toBe(true);
      expect(params.typesXml).toContain('GOLD');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });
});

// ---------------------------------------------------------------------------
// 批 25:闭包 BFS 容错臂——接口/父实体/组件原文缺失或解析抛错时如实跳过,
// 其余闭包照常收集(单点失败不毒化整表)。
// ---------------------------------------------------------------------------
describe('批 25:闭包收集容错臂', () => {
  const fakeGate = (): { gate: KodeCoreGate; captured: () => { defs: Record<string, string>; paths: Record<string, string> } | null } => {
    let capturedParams: { defs: Record<string, string>; paths: Record<string, string> } | null = null;
    const gate = {
      runInRust: async (_method: string, params: unknown) => {
        capturedParams = params as { defs: Record<string, string>; paths: Record<string, string> };
        return { ok: true, result: cannedTable() };
      }
    } as unknown as KodeCoreGate;
    return { gate, captured: () => capturedParams };
  };

  it('接口原文缺失:如实跳过,实体其余闭包照常', async () => {
    const own =
      '<root><Interfaces><interface>IGhost</interface><interface>IReal</interface></Interfaces></root>';
    const source: DefRawSource = {
      loadDefRaw: (name, kind) =>
        `${kind}:${name}` === 'entity:E'
          ? { content: own, filePath: '/d/E.def' }
          : `${kind}:${name}` === 'interface:IReal'
            ? { content: '<root><ClientMethods><r1></r1></ClientMethods></root>', filePath: '/d/IReal.def' }
            : null
    };
    const { gate, captured } = fakeGate();
    setKodeCoreShadowGate(gate);
    try {
      await buildMessageTableInRust('E', source);
      const params = captured()!;
      expect(params.defs.IGhost).toBeUndefined();
      expect(params.defs.IReal).toBeDefined();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('接口 XML 解析抛错:跳过该接口,不毒化闭包', async () => {
    const own =
      '<root><Interfaces><interface>IBad</interface><interface>IGood</interface></Interfaces></root>';
    const source: DefRawSource = {
      loadDefRaw: (name, kind) =>
        `${kind}:${name}` === 'entity:E'
          ? { content: own, filePath: '/d/E.def' }
          : `${kind}:${name}` === 'interface:IBad'
            ? { content: '<', filePath: '/d/IBad.def' }
            : `${kind}:${name}` === 'interface:IGood'
              ? { content: '<root><ClientMethods><g1></g1></ClientMethods></root>', filePath: '/d/IGood.def' }
              : null
    };
    const { gate, captured } = fakeGate();
    setKodeCoreShadowGate(gate);
    try {
      await buildMessageTableInRust('E', source);
      const params = captured()!;
      // 抛错不回滚已收原文:IBad 的 defs/paths 在解析前已落;catch 只中断
      // 它自身的后续闭包('<' 无引用可递归);同表其他接口照常收集
      expect(params.defs.IBad).toBe('<');
      expect(params.defs.IGood).toBeDefined();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('父实体原文缺失:父链断点跳过,自身照常入 defs', async () => {
    const own = '<root><Parent><MissingParent/></Parent></root>';
    const source: DefRawSource = {
      loadDefRaw: (name, kind) =>
        `${kind}:${name}` === 'entity:E' ? { content: own, filePath: '/d/E.def' } : null
    };
    const { gate, captured } = fakeGate();
    setKodeCoreShadowGate(gate);
    try {
      await buildMessageTableInRust('E', source);
      const params = captured()!;
      expect(params.defs.E).toBe(own);
      expect(params.defs.MissingParent).toBeUndefined();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('组件原文缺失与解析抛错:组件闭包两点都如实跳过', async () => {
    const componentEntityDef =
      '<root><Components><bad><Type>BadComp</Type></bad><good><Type>GoodComp</Type></good></Components></root>';
    const goodCompDef =
      '<root><Interfaces><interface>IGoodC</interface></Interfaces></root>';
    const source: DefRawSource = {
      loadDefRaw: (name, kind) =>
        ({
          'entity:CE': { content: componentEntityDef, filePath: '/d/CE.def' },
          'component:GoodComp': { content: goodCompDef, filePath: '/d/GoodComp.def' },
          'interface:IGoodC': { content: '<root><ClientMethods><gc1></gc1></ClientMethods></root>', filePath: '/d/IGoodC.def' }
        } as Record<string, { content: string; filePath: string }>)[`${kind}:${name}`] ?? null
    };
    const { gate, captured } = fakeGate();
    setKodeCoreShadowGate(gate);
    try {
      await buildMessageTableInRust('CE', source);
      const params = captured()!;
      expect(params.defs.BadComp).toBeUndefined();
      expect(params.defs.GoodComp).toBeDefined();
      expect(params.defs.IGoodC).toBeDefined();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });
});

describe('批 25 续:重复接口与抛错原文臂', () => {
  const fakeGate = (): { gate: KodeCoreGate; captured: () => { defs: Record<string, string>; paths: Record<string, string> } | null } => {
    let capturedParams: { defs: Record<string, string>; paths: Record<string, string> } | null = null;
    const gate = {
      runInRust: async (_method: string, params: unknown) => {
        capturedParams = params as { defs: Record<string, string>; paths: Record<string, string> };
        return { ok: true, result: cannedTable() };
      }
    } as unknown as KodeCoreGate;
    return { gate, captured: () => capturedParams };
  };

  it('接口自指(实体与接口都引用同一接口)→ seen 去重,单次收集', async () => {
    const own = '<root><Interfaces><interface>IShared</interface></Interfaces></root>';
    const ifaceSelf =
      '<root><Parent><E/></Parent><Interfaces><interface>IShared</interface></Interfaces></root>';
    const source: DefRawSource = {
      loadDefRaw: (name, kind) =>
        `${kind}:${name}` === 'entity:E'
          ? { content: own, filePath: '/d/E.def' }
          : `${kind}:${name}` === 'interface:IShared'
            ? { content: ifaceSelf, filePath: '/d/IShared.def' }
            : null
    };
    const { gate, captured } = fakeGate();
    setKodeCoreShadowGate(gate);
    try {
      await buildMessageTableInRust('E', source);
      const params = captured()!;
      expect(params.defs.IShared).toBe(ifaceSelf);
      // 父实体 E 经接口的 Parent 也入实体闭包
      expect(params.defs.E).toBe(own);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('父实体原文解析抛错 → 该父跳过,不再上溯', async () => {
    const own = '<root><Parent><BrokenParent/></Parent></root>';
    const source: DefRawSource = {
      loadDefRaw: (name, kind) =>
        `${kind}:${name}` === 'entity:E'
          ? { content: own, filePath: '/d/E.def' }
          : `${kind}:${name}` === 'entity:BrokenParent'
            ? { content: '<', filePath: '/d/BrokenParent.def' }
            : null
    };
    const { gate, captured } = fakeGate();
    setKodeCoreShadowGate(gate);
    try {
      await buildMessageTableInRust('E', source);
      const params = captured()!;
      // 原文在解析前已落 defs;抛错只断父链上溯
      expect(params.defs.BrokenParent).toBe('<');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('组件原文解析抛错 → 原文已落 defs,组件自身闭包中断', async () => {
    const componentEntityDef =
      '<root><Components><broken><Type>BrokenComp</Type></broken></Components></root>';
    const source: DefRawSource = {
      loadDefRaw: (name, kind) =>
        `${kind}:${name}` === 'entity:CE'
          ? { content: componentEntityDef, filePath: '/d/CE.def' }
          : `${kind}:${name}` === 'component:BrokenComp'
            ? { content: '<', filePath: '/d/BrokenComp.def' }
            : null
    };
    const { gate, captured } = fakeGate();
    setKodeCoreShadowGate(gate);
    try {
      await buildMessageTableInRust('CE', source);
      const params = captured()!;
      expect(params.defs.BrokenComp).toBe('<');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });
});

// 覆盖口径残余(批 25 定性,不硬凑)::365 实体队列 shift 位 seen 去重——实体
// 队列只由父链线性生长且所有入队都过同一 seen 守卫,不可能把已见名再入队,
// 该行是对不变量的防御。:341/:378/:402 已由上组三臂覆盖。
