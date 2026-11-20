import { describe, expect, it } from 'vitest';
import { cellToTypedValue, typedValueToBind, tvBigUInt, tvInt, tvUInt } from '../src/backend/playerDataCloneWire';

describe('clone value safety', () => {
  it('round trips binary bytes and rejects malformed hex', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 128, 1])]) {
      expect(typedValueToBind(cellToTypedValue(bytes, 'blob'))).toEqual(bytes);
    }
    expect(() => typedValueToBind({ t: 'bytes', v: '0xz' })).toThrow(/hexadecimal/);
  });

  it('preserves 64-bit integer strings and rejects rounded numbers', () => {
    expect(cellToTypedValue('18446744073709551615', 'bigint unsigned')).toEqual({ t: 'big-u-int', v: '18446744073709551615' });
    expect(tvBigUInt(9007199254740993n)).toEqual({ t: 'big-u-int', v: '9007199254740993' });
    expect(() => typedValueToBind({ t: 'big-u-int', v: 9007199254740992 })).toThrow(/without loss/);
    expect(typedValueToBind({ t: 'double', v: 1.5 })).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// 批 26 容错臂:整数构造三抛(非整文本/越 64 位/无符号负)、三形状闸的非
// record 拒绝、Date 单元格 ISO 保真、整数列遇非数值抛、date-time 对象解包。
// ---------------------------------------------------------------------------
describe('批 26:wire 容错臂', () => {
  it('tvInt/tvUInt 非整文本与越界如实抛', () => {
    expect(() => tvInt('abc')).toThrow(/invalid integer/);
    expect(() => tvUInt('-1')).toThrow(/outside 64-bit range/);
    expect(() => tvInt('99999999999999999999999')).toThrow(/outside 64-bit range/);
    // 合法边界照常
    expect(tvInt('-9223372036854775808')).toEqual({ t: 'int', v: '-9223372036854775808' });
    expect(tvUInt('18446744073709551615')).toEqual({ t: 'u-int', v: '18446744073709551615' });
  });

  it('三形状闸对非 record(原始值/数组/null)一律 false', async () => {
    const wire = await import('../src/backend/playerDataCloneWire');
    for (const bad of [null, 'x', 42, ['a']]) {
      expect(wire.isArchiveMeta(bad)).toBe(false);
      expect(wire.isImportPlan(bad)).toBe(false);
      expect(wire.isQueryPlan(bad)).toBe(false);
    }
  });

  it('Date 单元格 → ISO 文本保真;整数列遇布尔抛', () => {
    const at = new Date('2026-11-20T08:00:00.000Z');
    expect(cellToTypedValue(at, 'datetime')).toEqual({ t: 'text', v: at.toISOString() });
    expect(() => cellToTypedValue(true, 'int')).toThrow(/invalid integer in int/);
  });

  it('date-time 对象形态解码取 .value;标量形态原样', async () => {
    const wire = await import('../src/backend/playerDataCloneWire');
    const fromObject = wire.typedValueToBind({ t: 'date-time', v: { value: '2026-01-01 00:00:00' } });
    expect(fromObject).toBe('2026-01-01 00:00:00');
    const fromScalar = wire.typedValueToBind({ t: 'date-time', v: '2026-01-01 00:00:00' });
    expect(fromScalar).toBe('2026-01-01 00:00:00');
  });
});
