import * as assert from 'assert';
import { DETAIL_LEVELS, KBENGINE_FLAGS, KBENGINE_TYPES } from '../../kbengineMetadata';

describe('KBEngine metadata', () => {
  it('contains core KBEngine types', () => {
    const typeNames = new Set(KBENGINE_TYPES.map(item => item.name));

    assert.ok(typeNames.has('UINT32'));
    assert.ok(typeNames.has('VECTOR3'));
    assert.ok(typeNames.has('ARRAY'));
    assert.ok(typeNames.has('FIXED_DICT'));
  });

  it('does not advertise types absent from the engine type registry', () => {
    // 引擎 DataTypes::initialize 注册表中无 BOOL/TUPLE;.def 属性加载
    // (entitydef.cpp) 对 FIXED_DICT 也只经 types.xml 别名解析,不含内联路径。
    // 宣传这些类型会让补全生成引擎无法加载的定义。
    const typeNames = new Set(KBENGINE_TYPES.map(item => item.name));

    assert.strictEqual(typeNames.has('BOOL'), false, 'BOOL is not registered by DataTypes::initialize');
    assert.strictEqual(typeNames.has('TUPLE'), false, 'TUPLE does not exist anywhere in the engine source');
  });

  it('contains common flags and detail levels', () => {
    const flagNames = new Set(KBENGINE_FLAGS.map(item => item.name));

    assert.ok(flagNames.has('BASE'));
    assert.ok(flagNames.has('CELL_PUBLIC'));
    assert.ok(flagNames.has('OWN_CLIENT'));
    assert.deepStrictEqual(DETAIL_LEVELS, ['NEAR', 'MEDIUM', 'FAR']);
  });
});
