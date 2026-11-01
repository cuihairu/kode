import { describe, expect, it } from 'vitest';
import { computeDefMd5InRust } from '../src/defMd5Rust';
import type { KodeCoreGate } from '../src/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';

// C-18 引擎官方 def MD5 的 Rust 权威接线:computeDefMd5InRust 主路径经命令级
// RPC($/kode/def/md5)调 Rust 重放器(引擎 EntityDef::md5 字节序镜像);Rust
// 不可用(无 gate/调用失败/形状不合规)返回 null,调用方回落到「不协商引擎
// Digest」(unknown 不猜)。契约:参数形状(typesXml/entitiesXml/defs/
// aliasXml/componentScripts)与 md5/streamHex/trace 输出是断言重点。

const params = () => ({
  typesXml: '<root></root>',
  entitiesXml: '<root><Gate hasCell="true"></Gate></root>',
  defs: {
    Gate:
      '<root><Properties><level><Type> UINT32 </Type><Flags> BASE </Flags></level></Properties></root>'
  },
  aliasXml: '',
  componentScripts: []
});

const cannedResult = () => ({
  md5: '7D30F640C07CD601D0E5B4083EFC6E40',
  algorithm: 'md5' as const,
  streamHex: '0100020003000400',
  trace: [{ field: 'module-name', source: 'scriptdef_module.cpp:60', bytes: '47617465' }]
});

describe('computeDefMd5InRust(引擎复合 MD5 Rust 主路径)', () => {
  it('Rust 核心在场:契约参数含 typesXml/entitiesXml/defs/aliasXml/componentScripts,返回结果', async () => {
    let calledMethod = '';
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (method: string, p: unknown) => {
        calledMethod = method;
        calledParams = p;
        return { ok: true, result: cannedResult() };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await computeDefMd5InRust(params());
      expect(result).not.toBeNull();
      expect(result?.md5).toBe('7D30F640C07CD601D0E5B4083EFC6E40');
      expect(result?.algorithm).toBe('md5');
      expect(result?.trace).toHaveLength(1);
      expect(calledMethod).toBe('$/kode/def/md5');
      const p = calledParams as {
        typesXml: string;
        entitiesXml: string;
        defs: Record<string, string>;
        aliasXml: string;
        componentScripts: string[];
      };
      expect(p.typesXml).toContain('<root>');
      expect(p.entitiesXml).toContain('Gate');
      expect(p.defs.Gate).toContain('level');
      expect(p.aliasXml).toBe('');
      expect(p.componentScripts).toEqual([]);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 不可用(无 gate)返回 null', async () => {
    setKodeCoreShadowGate(null);
    const result = await computeDefMd5InRust(params());
    expect(result).toBeNull();
  });

  it('Rust 调用失败(!ok)返回 null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: false, reason: 'no serverPath' })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await computeDefMd5InRust(params());
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 结果算法非 md5 或形状不合规返回 null', async () => {
    for (const malformed of [
      { md5: 'abc', algorithm: 'md5', streamHex: '', trace: [] }, // md5 非 32hex
      { md5: '7D30F640C07CD601D0E5B4083EFC6E40', algorithm: 'sha256' as const, streamHex: '', trace: [] }, // 算法不符
      { md5: '7D30F640C07CD601D0E5B4083EFC6E40', algorithm: 'md5' }, // 缺 streamHex/trace
      { md5: '7D30F640C07CD601D0E5B4083EFC6E40', algorithm: 'md5', streamHex: '', trace: 'no' } // trace 非数组
    ]) {
      const fakeGate = {
        runInRust: async () => ({ ok: true, result: malformed })
      } as unknown as KodeCoreGate;
      setKodeCoreShadowGate(fakeGate);
      try {
        const result = await computeDefMd5InRust(params());
        expect(result).toBeNull();
      } finally {
        setKodeCoreShadowGate(null);
      }
    }
  });
});
