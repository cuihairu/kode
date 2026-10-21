/**
 * Entity 内建属性表(用户令 2026-10-21,实现单见
 * docs/review/2026-10-21-entity-builtin-properties.md §4):按组件分面的
 * `self.<属性>` 悬停/补全数据源。纯逻辑层,不 import vscode/entityMapping。
 *
 * 数据全部取证自仓内事实源,零自创:
 * - 读写性与引擎注册面 → 报告 §2(file:line 记在每项 source);
 * - 类型 → docs/reference/kbengine-typings-2026-10-21/ 修正版引擎 pyi
 *   (common Entity: id: int / position: Vector3Like / shouldAutoBackup:
 *   Union[bool, int] 等;client 面 bots Entity: velocity: float / clientapp: Any)。
 *
 * 组件面判定(§4-3):base/cell/client 目录域规则与 entityMapping 的
 * scriptFoldersForRole/getSectionFolder 同源;def 归属由 EntityMappingManager
 * 的 owner 文件段位提供(接线路在 languageProviders,本模块只收结果)。
 * 目录与 def 归属都判不出 → 非实体脚本不接管;判为实体但面歧义 → 只给宏公共 3 项。
 */

/** 组件面(报告 §2:baseapp/cellapp/client 各一套 getset 表) */
export type EntityComponentFace = 'baseapp' | 'cellapp' | 'client';

export interface EntityBuiltinProperty {
  /** 属性名(引擎注册名) */
  name: string;
  /** true = 仅 GET(只读);false = GET+SET(可写) */
  readonly: boolean;
  /** 脚本可见类型(对齐修正版 pyi) */
  type: string;
  /** 引擎取证(报告 §2 file:line) */
  source: string;
}

/**
 * 宏公共三项(报告 §2.1:lib/entitydef/entity_macro.h:33-35,所有实体类继承)。
 * 「无法判定面」时的兜底集(用户令 ④)。
 */
export const ENTITY_BUILTIN_COMMON_PROPERTIES: readonly EntityBuiltinProperty[] = [
  { name: 'id', readonly: true, type: 'int', source: 'lib/entitydef/entity_macro.h:33' },
  { name: 'isDestroyed', readonly: true, type: 'bool', source: 'lib/entitydef/entity_macro.h:34' },
  { name: 'className', readonly: true, type: 'str', source: 'lib/entitydef/entity_macro.h:35' }
];

const BASEAPP_FACE_PROPERTIES: readonly EntityBuiltinProperty[] = [
  ...ENTITY_BUILTIN_COMMON_PROPERTIES,
  { name: 'cell', readonly: true, type: 'Union[EntityCall, None]', source: 'server/baseapp/entity.cpp:36' },
  { name: 'client', readonly: true, type: 'Union[EntityCall, None]', source: 'server/baseapp/entity.cpp:37' },
  { name: 'databaseID', readonly: true, type: 'int', source: 'server/baseapp/entity.cpp:38' },
  { name: 'databaseInterfaceName', readonly: true, type: 'str', source: 'server/baseapp/entity.cpp:39' },
  { name: 'shouldAutoBackup', readonly: false, type: 'Union[bool, int]', source: 'server/baseapp/entity.cpp:40' },
  { name: 'shouldAutoArchive', readonly: false, type: 'Union[bool, int]', source: 'server/baseapp/entity.cpp:41' }
];

const CELLAPP_FACE_PROPERTIES: readonly EntityBuiltinProperty[] = [
  ...ENTITY_BUILTIN_COMMON_PROPERTIES,
  { name: 'base', readonly: true, type: 'Union[EntityCall, None]', source: 'server/cellapp/entity.cpp:74' },
  { name: 'client', readonly: true, type: 'Union[EntityCall, None]', source: 'server/cellapp/entity.cpp:75' },
  { name: 'allClients', readonly: true, type: 'Any', source: 'server/cellapp/entity.cpp:76' },
  { name: 'otherClients', readonly: true, type: 'Any', source: 'server/cellapp/entity.cpp:77' },
  { name: 'isWitnessed', readonly: true, type: 'bool', source: 'server/cellapp/entity.cpp:78' },
  { name: 'hasWitness', readonly: true, type: 'bool', source: 'server/cellapp/entity.cpp:79' },
  { name: 'isOnGround', readonly: true, type: 'bool', source: 'server/cellapp/entity.cpp:80' },
  { name: 'spaceID', readonly: true, type: 'int', source: 'server/cellapp/entity.cpp:81' },
  { name: 'layer', readonly: false, type: 'int', source: 'server/cellapp/entity.cpp:82' },
  { name: 'position', readonly: false, type: 'Vector3Like', source: 'server/cellapp/entity.cpp:83' },
  { name: 'direction', readonly: false, type: 'Vector3Like', source: 'server/cellapp/entity.cpp:84' },
  { name: 'topSpeed', readonly: false, type: 'float', source: 'server/cellapp/entity.cpp:85' },
  { name: 'topSpeedY', readonly: false, type: 'float', source: 'server/cellapp/entity.cpp:86' },
  { name: 'controlledBy', readonly: false, type: 'Any', source: 'server/cellapp/entity.cpp:87' },
  { name: 'volatileInfo', readonly: false, type: 'Any', source: 'server/cellapp/entity.cpp:88' }
];

/**
 * 客户端面:客户端宏四项(报告 §2.1 客户端宏块 :56-61)而非服务端宏公共三项,
 * 外加 lib/client_lib/entity.cpp:41-46 六项。
 */
const CLIENT_FACE_PROPERTIES: readonly EntityBuiltinProperty[] = [
  { name: 'id', readonly: true, type: 'int', source: 'lib/entitydef/entity_macro.h:58' },
  { name: 'spaceID', readonly: true, type: 'int', source: 'lib/entitydef/entity_macro.h:59' },
  { name: 'isDestroyed', readonly: true, type: 'bool', source: 'lib/entitydef/entity_macro.h:60' },
  { name: 'className', readonly: true, type: 'str', source: 'lib/entitydef/entity_macro.h:61' },
  { name: 'base', readonly: true, type: 'Union[EntityCall, None]', source: 'lib/client_lib/entity.cpp:41' },
  { name: 'cell', readonly: true, type: 'Union[EntityCall, None]', source: 'lib/client_lib/entity.cpp:42' },
  { name: 'clientapp', readonly: true, type: 'Any', source: 'lib/client_lib/entity.cpp:43' },
  { name: 'position', readonly: false, type: 'Vector3Like', source: 'lib/client_lib/entity.cpp:44' },
  { name: 'direction', readonly: false, type: 'Vector3Like', source: 'lib/client_lib/entity.cpp:45' },
  { name: 'velocity', readonly: false, type: 'float', source: 'lib/client_lib/entity.cpp:46' }
];

/** 面属性全集(已含各自的宏公共/客户端宏条目;face=null → 宏公共 3) */
export function getEntityBuiltinPropertiesForFace(
  face: EntityComponentFace | null
): readonly EntityBuiltinProperty[] {
  switch (face) {
    case 'baseapp':
      return BASEAPP_FACE_PROPERTIES;
    case 'cellapp':
      return CELLAPP_FACE_PROPERTIES;
    case 'client':
      return CLIENT_FACE_PROPERTIES;
    default:
      return ENTITY_BUILTIN_COMMON_PROPERTIES;
  }
}

/**
 * 目录域 → 组件面:路径段含 base/cell/client 任一即归面(与 entityMapping
 * collectAllPythonMethodHits 的 domain 目录闸同一规则:filePath 按
 * path.sep 切段 includes 判定)。判不出 → null(交由 def 归属或兜底)。
 * 同路径含多域段时按 base > cell > client 定序(官方布局 base/cell 互斥,
 * client 面目录不与服务器域同居,实测无冲突形态)。
 */
export function resolveEntityComponentFaceFromPath(filePath: string): EntityComponentFace | null {
  const segments = filePath.split(/[\\/]/);
  if (segments.includes('base')) {
    return 'baseapp';
  }
  if (segments.includes('cell')) {
    return 'cellapp';
  }
  if (segments.includes('client')) {
    return 'client';
  }
  return null;
}

export interface EntityBuiltinPropertyHit {
  /** 生效面(null = 面未判定,仅宏公共 3 命中域) */
  face: EntityComponentFace | null;
  property: EntityBuiltinProperty;
}

/**
 * `self.<属性>` 命中解析(用户令 ②④):
 * - pathFace 与 defFaces 都为空 → 非实体脚本 → null(不接管);
 * - 目录域先定面;无目录域时 def 归属唯一面生效,多面歧义 → 只查宏公共 3;
 * - 面内无此属性 → null(落回既有 hover 链,不遮蔽 def 属性/普通符号)。
 */
export function resolveEntityBuiltinPropertyHit(
  attributeName: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null
): EntityBuiltinPropertyHit | null {
  const isEntityScript = pathFace !== null || (defFaces !== null && defFaces.length > 0);
  if (!isEntityScript) {
    return null;
  }
  const face =
    pathFace ??
    (defFaces !== null && defFaces.length === 1 ? defFaces[0] : null);
  const property =
    getEntityBuiltinPropertiesForFace(face).find(item => item.name === attributeName) ?? null;
  return property ? { face, property } : null;
}

/** 悬停/补全共用的单行标注:「KBEngine 内建属性（<组件>面）·只读/可写 · 类型」 */
export function formatEntityBuiltinPropertyDetail(
  face: EntityComponentFace | null,
  property: EntityBuiltinProperty
): string {
  const faceLabel = face ?? '公共';
  return `KBEngine 内建属性（${faceLabel}面）·${property.readonly ? '只读' : '可写'} · ${property.type}`;
}
