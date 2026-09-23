import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DETAIL_LEVELS,
  KBENGINE_FLAGS,
  KBENGINE_RELOAD_FUNCTIONS,
  KBENGINE_TYPES,
  KBEngineMetadataItem
} from '../src/kbengineMetadata';
import { resolveEngineRoot } from './helpers/engineRoot';

const engineRoot = resolveEngineRoot();

function uniqueNames(items: KBEngineMetadataItem[]): string[] {
  return items.map(item => item.name);
}

describe('KBEngine metadata tables', () => {
  it('has unique, documented type entries', () => {
    const names = uniqueNames(KBENGINE_TYPES);

    expect(new Set(names).size).toBe(names.length);
    for (const item of KBENGINE_TYPES) {
      expect(item.detail.length, item.name).toBeGreaterThan(0);
      expect(item.documentation.length, item.name).toBeGreaterThan(0);
    }
  });

  it('advertising only types the engine registers', () => {
    const names = new Set(uniqueNames(KBENGINE_TYPES));

    for (const registered of [
      'UINT8', 'UINT16', 'UINT32', 'UINT64',
      'INT8', 'INT16', 'INT32', 'INT64',
      'STRING', 'UNICODE', 'FLOAT', 'DOUBLE',
      'PYTHON', 'PY_DICT', 'PY_TUPLE', 'PY_LIST',
      'ENTITYCALL', 'BLOB', 'VECTOR2', 'VECTOR3', 'VECTOR4'
    ]) {
      expect(names.has(registered), registered).toBe(true);
    }

    // 引擎注册表之外:BOOL 未注册,TUPLE 在引擎源码中根本不存在;
    // FIXED_DICT 只能经 types.xml 别名声明。
    expect(names.has('BOOL')).toBe(false);
    expect(names.has('TUPLE')).toBe(false);
    expect(names.has('ARRAY')).toBe(true);
    expect(names.has('FIXED_DICT')).toBe(true);
  });

  it('documents flags with their engine enum names', () => {
    const names = uniqueNames(KBENGINE_FLAGS);

    expect(new Set(names).size).toBe(names.length);
    for (const item of KBENGINE_FLAGS) {
      expect(item.documentation).toContain(item.name === 'CELL'
        ? 'CELL_PUBLIC'
        : item.name === 'CELL_AND_CLIENT'
          ? 'CELL_PUBLIC_AND_OWN'
          : item.name === 'CELL_AND_CLIENTS'
            ? 'ALL_CLIENTS'
            : item.name === 'CELL_AND_OTHER_CLIENTS'
              ? 'OTHER_CLIENTS'
              : item.name);
    }
  });

  it('lists detail levels and reload functions', () => {
    expect(DETAIL_LEVELS).toEqual(['NEAR', 'MEDIUM', 'FAR']);
    expect(uniqueNames(KBENGINE_RELOAD_FUNCTIONS)).toEqual([
      'KBEngine.reloadScript',
      'importlib.reload'
    ]);
  });
});

describe.skipIf(!engineRoot)('KBEngine metadata vs engine source', () => {
  // skipIf 只把用例标记为跳过,describe 回调体在注册期仍会同步执行;
  // CI 上没有引擎源码(engineRoot 为 null),必须在这里挡住目录访问,
  // 否则下面的 path.join/readFileSync 在收集阶段就抛 TypeError。
  if (!engineRoot) {
    return;
  }

  const entityDefDir = path.join(engineRoot, 'kbe', 'src', 'lib', 'entitydef');

  function readEngineSource(relative: string): string {
    return fs.readFileSync(path.join(entityDefDir, relative), 'utf8');
  }

  const initializeSource = readEngineSource('datatypes.cpp');

  it('registers every advertised base type name', () => {
    const baseTypes = KBENGINE_TYPES.filter(
      item => item.name !== 'ARRAY' && item.name !== 'FIXED_DICT'
    );

    for (const item of baseTypes) {
      expect(
        initializeSource.includes(`addDataType("${item.name}"`),
        `${item.name} must be registered by DataTypes::initialize`
      ).toBe(true);
    }
  });

  it('keeps ARRAY/FIXED_DICT with engine-only usage paths', () => {
    const datatypeSource = readEngineSource('datatype.cpp');

    // ARRAY: 属性加载路径特判 + FixedArrayType::initialize 强制 <of>
    expect(datatypeSource).toContain('strType == "ARRAY"');
    expect(datatypeSource).toContain('enterNode(node, "of")');

    // FIXED_DICT: 只经 DataTypes::loadTypes(types.xml 别名)入口
    expect(initializeSource).not.toContain('addDataType("FIXED_DICT"');
    expect(initializeSource).toContain('type == "FIXED_DICT"');
  });

  it('never advertises BOOL/TUPLE which the engine does not know', () => {
    for (const dir of fs.readdirSync(entityDefDir)) {
      if (!dir.endsWith('.cpp') && !dir.endsWith('.h')) {
        continue;
      }
      const source = readEngineSource(dir);
      expect(source).not.toContain('"BOOL"');
      expect(source).not.toContain('"TUPLE"');
    }
  });

  it('matches engine flag enum names in entitydef.cpp', () => {
    const entityDefSource = readEngineSource('entitydef.cpp');

    for (const item of KBENGINE_FLAGS) {
      // 别名条目按"映射到 X"格式记录目标,其余按"对应 ED_FLAG_X"格式记录枚举名
      const citesEngine = item.documentation.includes(`"${item.name}"`) ||
        /ED_FLAG_\w+/.test(item.documentation) ||
        item.documentation.includes('映射到');
      expect(citesEngine, `${item.name} documentation must cite its engine mapping`).toBe(true);
      expect(entityDefSource.includes(`"${item.name}"`), `${item.name} literal must exist`).toBe(true);
    }
  });

  it('matches engine detail level names in entitydef.cpp', () => {
    const entityDefSource = readEngineSource('entitydef.cpp');

    for (const level of DETAIL_LEVELS) {
      expect(entityDefSource).toContain(`"${level}"`);
    }
  });
});
