import * as assert from 'assert';
import { DETAIL_LEVELS, KBENGINE_FLAGS, KBENGINE_TYPES } from '../../kbengineMetadata';

describe('KBEngine metadata', () => {
  it('contains core KBEngine types', () => {
    const typeNames = new Set(KBENGINE_TYPES.map(item => item.name));

    assert.ok(typeNames.has('UINT32'));
    assert.ok(typeNames.has('VECTOR3'));
    assert.ok(typeNames.has('ARRAY'));
    assert.ok(typeNames.has('FIXED_DICT'));
    assert.ok(typeNames.has('TUPLE'));
  });

  it('contains common flags and detail levels', () => {
    const flagNames = new Set(KBENGINE_FLAGS.map(item => item.name));

    assert.ok(flagNames.has('BASE'));
    assert.ok(flagNames.has('CELL_PUBLIC'));
    assert.ok(flagNames.has('OWN_CLIENT'));
    assert.deepStrictEqual(DETAIL_LEVELS, ['NEAR', 'MEDIUM', 'FAR']);
  });
});
