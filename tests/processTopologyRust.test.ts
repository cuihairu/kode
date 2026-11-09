import { describe, expect, it } from 'vitest';
import { validateProcessTopologyInRust } from '../src/backend/processTopologyRust';
import type { KodeCoreGate } from '../src/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';

// C-17 进程拓扑校验 Rust 主路径:validateProcessTopologyInRust 经命令级 RPC
// ($/kode/processTopology/validate)调 Rust 核心;Rust 不可用(无 gate/调用失败/
// 形状不合规/异常)返回 null,调用方零发现静默。契约:参数形状
// (manifestText/entitiesXmlText/defs)与 findings 数组断言是重点。

const params = () => ({
  manifestText: '<processTopology></processTopology>',
  entitiesXmlText: '<root></root>',
  defs: [
    { name: 'Avatar', category: 'entity', filePath: '/defs/entity_defs/Avatar.def', text: '<root></root>' }
  ]
});

const cannedFinding = () => ({
  target: 'def',
  filePath: '/defs/entity_defs/Avatar.def',
  line: 5,
  severity: 2,
  message: '实体 Avatar 有 cell 内容,但进程拓扑缺少 cellapp',
  code: 'kbengine.processTopologyMissingCellapp',
  related: [{ filePath: '<manifest>', line: 1, message: '缺 cellapp' }]
});

describe('validateProcessTopologyInRust(进程拓扑校验 Rust 主路径)', () => {
  it('Rust 核心在场:契约参数含 manifestText/entitiesXmlText/defs,返回 findings', async () => {
    let calledMethod = '';
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (method: string, p: unknown) => {
        calledMethod = method;
        calledParams = p;
        return { ok: true, result: { findings: [cannedFinding()] } };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await validateProcessTopologyInRust(params());
      expect(result).not.toBeNull();
      expect(result?.findings).toHaveLength(1);
      expect(result?.findings[0].code).toBe('kbengine.processTopologyMissingCellapp');
      expect(calledMethod).toBe('$/kode/processTopology/validate');
      const p = calledParams as {
        manifestText: string;
        entitiesXmlText: string;
        defs: unknown[];
      };
      expect(p.manifestText).toContain('processTopology');
      expect(p.entitiesXmlText).toBe('<root></root>');
      expect(p.defs).toHaveLength(1);
      expect((p.defs[0] as { category: string }).category).toBe('entity');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('entitiesXmlText 缺省时传空串', async () => {
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (_method: string, p: unknown) => {
        calledParams = p;
        return { ok: true, result: { findings: [] } };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      await validateProcessTopologyInRust({ manifestText: '<x/>', defs: [] });
      expect((calledParams as { entitiesXmlText: string }).entitiesXmlText).toBe('');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 不可用(无 gate)返回 null', async () => {
    setKodeCoreShadowGate(null);
    const result = await validateProcessTopologyInRust(params());
    expect(result).toBeNull();
  });

  it('Rust 调用失败(!ok)返回 null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: false, reason: 'no serverPath' })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await validateProcessTopologyInRust(params());
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 结果形状不合规(findings 缺失)返回 null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: true, result: {} })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await validateProcessTopologyInRust(params());
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 结果单条 finding 缺字段返回 null', async () => {
    const fakeGate = {
      runInRust: async () => ({
        ok: true,
        result: { findings: [{ target: 'def', line: 1 }] }
      })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await validateProcessTopologyInRust(params());
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });
});
