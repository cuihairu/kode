import { describe, expect, it } from 'vitest';
import { cellToTypedValue, typedValueToBind, tvBigUInt } from '../src/playerDataCloneWire';

describe('clone value safety', () => {
  it('round trips binary bytes and rejects malformed hex', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 128, 1])]) {
      expect(typedValueToBind(cellToTypedValue(bytes, 'blob'))).toEqual(bytes);
    }
    expect(() => typedValueToBind({ t: 'bytes', v: '0xz' })).toThrow(/hexadecimal/);
  });

  it('rejects integers outside the safe wire range instead of rounding', () => {
    expect(() => cellToTypedValue('9007199254740993', 'bigint unsigned')).toThrow(/unsafe/);
    expect(() => tvBigUInt(9007199254740993n)).toThrow(/without loss/);
    expect(() => typedValueToBind({ t: 'big-u-int', v: 9007199254740992 })).toThrow(/without loss/);
    expect(typedValueToBind({ t: 'double', v: 1.5 })).toBe(1.5);
  });
});
