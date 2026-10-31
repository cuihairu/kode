import { describe, expect, it } from 'vitest';
import type { KodeCoreGate } from '../src/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
import {
  buildMessageTableInRust,
  type DefRawSource,
  type MessageTable
} from '../src/messageTable';

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
