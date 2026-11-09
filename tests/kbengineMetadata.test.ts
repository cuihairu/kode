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

  it('states the cell face of client-visible flags per engine truth', () => {
    // 用户报障(2026-11-09):ALL_CLIENTS 只写「同步到所有客户端」,漏 cell 广播
    // 半边——引擎 common.h:22 注释明写「cell广播与所有客户端」,且该位同在
    // ENTITY_CELL_DATA_FLAGS(L43)与 ENTITY_BROADCAST_CELL_FLAGS(L47)。
    const byName = new Map(KBENGINE_FLAGS.map(item => [item.name, item]));
    expect(byName.get('ALL_CLIENTS')?.detail).toContain('Cell 广播并同步给所有客户端');
    expect(byName.get('ALL_CLIENTS')?.documentation).toContain('cellapp 注册');
    expect(byName.get('OWN_CLIENT')?.detail).toContain('Cell 数据');
    expect(byName.get('OWN_CLIENT')?.documentation).toContain('不跨 cell 广播');
    expect(byName.get('OTHER_CLIENTS')?.detail).toContain('Cell 广播并同步给 AOI 其它客户端');
    expect(byName.get('OTHER_CLIENTS')?.documentation).toContain('不含拥有者客户端');
    // 同批补齐的 5 条薄词条:逐旗标语义 = common.h 掩码成员关系,文案要点锁死。
    expect(byName.get('CELL_PUBLIC')?.documentation).toContain('跨 cell 广播');
    expect(byName.get('CELL_PUBLIC')?.documentation).toContain('任何客户端都收不到');
    expect(byName.get('CELL_PRIVATE')?.documentation).toContain('不跨 cell 广播');
    expect(byName.get('CELL_PRIVATE')?.documentation).toContain('进不了任何客户端');
    expect(byName.get('CELL_PUBLIC_AND_OWN')?.documentation).toContain('只同步给拥有者客户端');
    expect(byName.get('CELL_PUBLIC_AND_OWN')?.documentation).toContain('AOI 其它客户端收不到');
    expect(byName.get('BASE_AND_CLIENT')?.detail).toContain('Base 注册并同步给拥有者客户端');
    expect(byName.get('BASE_AND_CLIENT')?.documentation).toContain('不经 cellapp');
    expect(byName.get('BASE')?.documentation).toContain('仅在 baseapp 注册');
    expect(byName.get('BASE')?.documentation).toContain('无任何客户端面');
    // 4 个旧式别名:与 g_entityFlagMapping 同位映射,文案须含位值与目标名。
    expect(byName.get('CELL')?.documentation).toContain('映射到 CELL_PUBLIC');
    expect(byName.get('CELL_AND_CLIENT')?.documentation).toContain('映射到 CELL_PUBLIC_AND_OWN');
    expect(byName.get('CELL_AND_CLIENTS')?.documentation).toContain('映射到 ALL_CLIENTS');
    expect(byName.get('CELL_AND_OTHER_CLIENTS')?.documentation).toContain('映射到 OTHER_CLIENTS');
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

  it('keeps client-flag cell-face claims aligned with common.h bit sets', () => {
    // 文档断言的 cell 面(「cellapp 注册」「跨 cell 广播」)必须与引擎位集
    // 同步:客户端可见三旗标全在 ENTITY_CELL_DATA_FLAGS;跨 cell 广播面
    // ALL_CLIENTS/OTHER_CLIENTS 在 ENTITY_BROADCAST_CELL_FLAGS,
    // OWN_CLIENT 不在。引擎位集一变,这里先红。
    const commonLines = readEngineSource('common.h').split('\n');
    const cellDataLine = commonLines.find(line => line.includes('ENTITY_CELL_DATA_FLAGS'));
    const broadcastCellLine = commonLines.find(line => line.includes('ENTITY_BROADCAST_CELL_FLAGS'));
    expect(cellDataLine).toBeDefined();
    expect(broadcastCellLine).toBeDefined();

    const inCellData = (flag: string): boolean => cellDataLine!.includes(`ED_FLAG_${flag}`);
    const inBroadcastCell = (flag: string): boolean => broadcastCellLine!.includes(`ED_FLAG_${flag}`);

    const byName = new Map(KBENGINE_FLAGS.map(item => [item.name, item]));
    for (const flag of ['ALL_CLIENTS', 'OWN_CLIENT', 'OTHER_CLIENTS']) {
      expect(inCellData(flag), flag).toBe(true);
      expect(byName.get(flag)?.documentation).toContain('cellapp 注册');
    }
    expect(inBroadcastCell('ALL_CLIENTS')).toBe(true);
    expect(inBroadcastCell('OTHER_CLIENTS')).toBe(true);
    expect(inBroadcastCell('OWN_CLIENT')).toBe(false);
    expect(byName.get('OWN_CLIENT')?.documentation).toContain('不跨 cell 广播');
  });

  it('keeps every enriched flag claim aligned with common.h relation masks', () => {
    // 全掩码对账(2026-11-09 flags 文档批次):kbengineMetadata 逐旗标声明的
    // 「在 X 注册/跨 cell 广播/进客户端面」要点,全部与 common.h 位集机器
    // 对账——引擎位集一变,这里先红,文档不允许漂在源码之外。
    const commonLines = readEngineSource('common.h').split('\n');
    const maskLine = (mask: string): string => {
      const line = commonLines.find(l => l.includes(`${mask}\t`) || l.includes(`${mask} `) || l.trimStart().startsWith(mask));
      expect(line, mask).toBeDefined();
      return line!;
    };
    const baseData = maskLine('ENTITY_BASE_DATA_FLAGS');
    const cellData = maskLine('ENTITY_CELL_DATA_FLAGS');
    const clientData = maskLine('ENTITY_CLIENT_DATA_FLAGS');
    const broadcastCell = maskLine('ENTITY_BROADCAST_CELL_FLAGS');
    const broadcastOther = maskLine('ENTITY_BROADCAST_OTHER_CLIENT_FLAGS');
    const broadcastOwn = maskLine('ENTITY_BROADCAST_OWN_CLIENT_FLAGS');
    // 词边界匹配:ED_FLAG_CELL_PUBLIC 是 ED_FLAG_CELL_PUBLIC_AND_OWN 的
    // 前缀,裸 includes 会误命中——后续字符不得是标识符字符。
    const has = (line: string, flag: string): boolean =>
      new RegExp(`ED_FLAG_${flag}(?![A-Z_])`).test(line);

    // CELL_PUBLIC: cell 注册 + 跨 cell 广播 + 无任何客户端面。
    expect(has(cellData, 'CELL_PUBLIC')).toBe(true);
    expect(has(broadcastCell, 'CELL_PUBLIC')).toBe(true);
    expect(has(clientData, 'CELL_PUBLIC')).toBe(false);
    expect(has(broadcastOther, 'CELL_PUBLIC')).toBe(false);
    // CELL_PRIVATE: 仅 cell 注册,不广播、不进客户端。
    expect(has(cellData, 'CELL_PRIVATE')).toBe(true);
    expect(has(broadcastCell, 'CELL_PRIVATE')).toBe(false);
    expect(has(clientData, 'CELL_PRIVATE')).toBe(false);
    // CELL_PUBLIC_AND_OWN: 跨 cell 广播 + 只进拥有者客户端(BROADCAST_OWN 含
    // /BROADCAST_OTHER 不含)。
    expect(has(broadcastCell, 'CELL_PUBLIC_AND_OWN')).toBe(true);
    expect(has(broadcastOwn, 'CELL_PUBLIC_AND_OWN')).toBe(true);
    expect(has(broadcastOther, 'CELL_PUBLIC_AND_OWN')).toBe(false);
    // BASE_AND_CLIENT: base 注册 + 拥有者客户端 + 不经 cell。
    expect(has(baseData, 'BASE_AND_CLIENT')).toBe(true);
    expect(has(broadcastOwn, 'BASE_AND_CLIENT')).toBe(true);
    expect(has(cellData, 'BASE_AND_CLIENT')).toBe(false);
    expect(has(broadcastCell, 'BASE_AND_CLIENT')).toBe(false);
    // BASE: 仅 base 注册,无客户端面。
    expect(has(baseData, 'BASE')).toBe(true);
    expect(has(clientData, 'BASE')).toBe(false);
    expect(has(cellData, 'BASE')).toBe(false);
  });

  it('matches engine detail level names in entitydef.cpp', () => {
    const entityDefSource = readEngineSource('entitydef.cpp');

    for (const level of DETAIL_LEVELS) {
      expect(entityDefSource).toContain(`"${level}"`);
    }
  });
});
