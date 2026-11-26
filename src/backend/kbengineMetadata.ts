export interface KBEngineMetadataItem {
  name: string;
  detail: string;
  documentation: string;
}

// The type set is calibrated strictly against the KBEngine engine sources:
// - base type registry: kbe/src/lib/entitydef/datatypes.cpp
//   `DataTypes::initialize`
//   (UINT8..UINT64, INT8..INT64, STRING, UNICODE, FLOAT, DOUBLE, PYTHON,
//    PY_DICT, PY_TUPLE, PY_LIST, ENTITYCALL, BLOB, VECTOR2/3/4)
// - ARRAY: the .def property inline form
//   `<Type>ARRAY<of>element type</of></Type>`
//   (kbe/src/lib/entitydef/entitydef.cpp property loading special-cases
//    "ARRAY"; FixedArrayType::initialize requires an <of> child node)
// - FIXED_DICT: only supported as an alias declaration in
//   scripts/entity_defs/types.xml
//   (DataTypes::loadTypes special-cases "FIXED_DICT";
//    FixedDictType::initialize requires a <Properties> child node; fields
//    support Type/Persistent/DatabaseLength); .def properties reference it
//   by the alias name. The engine does not parse a FIXED_DICT inlined in a
//   def property.
// Types absent from the engine registry (e.g. BOOL, TUPLE) are not listed,
// so completion never generates definitions the engine cannot load.
/** Engine def type name constant: FIXED_DICT (the types.xml alias declaration shape; every judgement/comparison site in the repo references this instead of writing its own literal) */
export const FIXED_DICT_TYPE_NAME = 'FIXED_DICT';

export const KBENGINE_TYPES: KBEngineMetadataItem[] = [
  { name: 'UINT8', detail: '8 位无符号整数', documentation: '范围 0-255。' },
  { name: 'UINT16', detail: '16 位无符号整数', documentation: '范围 0-65535。' },
  { name: 'UINT32', detail: '32 位无符号整数', documentation: '范围 0-4294967295。' },
  { name: 'UINT64', detail: '64 位无符号整数', documentation: '范围 0-18446744073709551615。' },
  { name: 'INT8', detail: '8 位有符号整数', documentation: '范围 -128-127。' },
  { name: 'INT16', detail: '16 位有符号整数', documentation: '范围 -32768-32767。' },
  { name: 'INT32', detail: '32 位有符号整数', documentation: '范围 -2147483648-2147483647。' },
  { name: 'INT64', detail: '64 位有符号整数', documentation: '范围 -9223372036854775808-9223372036854775807。' },
  { name: 'FLOAT', detail: '单精度浮点数', documentation: '32 位 IEEE 754 浮点数。' },
  { name: 'DOUBLE', detail: '双精度浮点数', documentation: '64 位 IEEE 754 浮点数。' },
  { name: 'STRING', detail: '字符串', documentation: '变长字符串类型。' },
  { name: 'UNICODE', detail: 'Unicode 字符串', documentation: 'Unicode 字符串类型。' },
  { name: 'VECTOR2', detail: '二维向量', documentation: '包含 x、y 两个分量。' },
  { name: 'VECTOR3', detail: '三维向量', documentation: '包含 x、y、z 三个分量。' },
  { name: 'VECTOR4', detail: '四维向量', documentation: '包含 x、y、z、w 四个分量。' },
  { name: 'ENTITYCALL', detail: '实体引用', documentation: '实体调用或实体引用类型。' },
  { name: 'PYTHON', detail: 'Python 对象', documentation: '由 KBEngine 序列化的 Python 对象。' },
  { name: 'PY_DICT', detail: 'Python 字典对象', documentation: '由 KBEngine 序列化的 Python dict。' },
  { name: 'PY_TUPLE', detail: 'Python 元组对象', documentation: '由 KBEngine 序列化的 Python tuple。' },
  { name: 'PY_LIST', detail: 'Python 列表对象', documentation: '由 KBEngine 序列化的 Python list。' },
  { name: 'BLOB', detail: '二进制流', documentation: '字节流类型，常用于原始二进制数据。' },
  { name: 'ARRAY', detail: '数组容器', documentation: '内联写法 <Type>ARRAY<of>元素类型</of></Type>,元素类型放在 <of> 子节点。' },
  { name: FIXED_DICT_TYPE_NAME, detail: '固定字典容器', documentation: '在 scripts/entity_defs/types.xml 中以别名声明,需 <Properties> 子节点;.def 属性通过别名名引用。' }
];

// Sources: kbe/src/lib/entitydef/entitydef.cpp (the g_entityFlagMapping 12
// entries), common.cpp (stringToEntityDataFlags), common.h (the
// EntityDataFlags bits and the EntityDataFlagRelation groups). Per-flag
// runtime semantics = mask membership.
export const KBENGINE_FLAGS: KBEngineMetadataItem[] = [
  {
    name: 'CELL_PUBLIC',
    detail: 'Cell 广播,不进客户端',
    documentation: '对应 ED_FLAG_CELL_PUBLIC(0x01);属性在 cellapp 注册(ENTITY_CELL_DATA_FLAGS 含此位)并跨 cell 广播(ENTITY_BROADCAST_CELL_FLAGS 含此位);任何客户端都收不到(ENTITY_CLIENT_DATA_FLAGS 与 BROADCAST_OWN/OTHER_CLIENT 均不含)。'
  },
  {
    name: 'CELL_PRIVATE',
    detail: '当前 Cell 私有',
    documentation: '对应 ED_FLAG_CELL_PRIVATE(0x02);仅在 cellapp 注册(ENTITY_CELL_DATA_FLAGS 含此位),不跨 cell 广播(ENTITY_BROADCAST_CELL_FLAGS 不含),也进不了任何客户端(ENTITY_CLIENT_DATA_FLAGS 不含)——只在本 cell 进程内可见。'
  },
  {
    name: 'ALL_CLIENTS',
    detail: 'Cell 广播并同步给所有客户端',
    documentation: '对应 ED_FLAG_ALL_CLIENTS(0x04);属性在 cellapp 注册并跨 cell 广播(common.h ENTITY_CELL_DATA_FLAGS/ENTITY_BROADCAST_CELL_FLAGS 均含此位),同步给拥有者与 AOI 内其它客户端(BROADCAST_OWN_CLIENT/BROADCAST_OTHER_CLIENT 均含)。'
  },
  {
    name: 'CELL_PUBLIC_AND_OWN',
    detail: 'Cell 广播并同步给拥有者客户端',
    documentation: '对应 ED_FLAG_CELL_PUBLIC_AND_OWN(0x08);属性在 cellapp 注册并跨 cell 广播(ENTITY_BROADCAST_CELL_FLAGS 含此位),但只同步给拥有者客户端(BROADCAST_OWN_CLIENT_FLAGS 含,ENTITY_BROADCAST_OTHER_CLIENT_FLAGS 不含)——AOI 其它客户端收不到。旧式拼写 CELL_AND_CLIENT 同位(entitydef.cpp:162)。'
  },
  {
    name: 'OWN_CLIENT',
    detail: 'Cell 数据,仅同步给拥有者客户端',
    documentation: '对应 ED_FLAG_OWN_CLIENT(0x10);属性在 cellapp 注册(ENTITY_CELL_DATA_FLAGS 含此位),仅推送给拥有者客户端(BROADCAST_OWN_CLIENT_FLAGS 含),不跨 cell 广播(ENTITY_BROADCAST_CELL_FLAGS 不含)。'
  },
  {
    name: 'BASE_AND_CLIENT',
    detail: 'Base 注册并同步给拥有者客户端',
    documentation: '对应 ED_FLAG_BASE_AND_CLIENT(0x20);属性在 baseapp 注册(ENTITY_BASE_DATA_FLAGS 含此位)并同步给拥有者客户端(BROADCAST_OWN_CLIENT_FLAGS 含此位);不经 cellapp(ENTITY_CELL_DATA_FLAGS 不含)——AOI 其它客户端同样收不到。'
  },
  {
    name: 'BASE',
    detail: '仅 Base',
    documentation: '对应 ED_FLAG_BASE(0x40);仅在 baseapp 注册(ENTITY_BASE_DATA_FLAGS 含此位),无任何客户端面(ENTITY_CLIENT_DATA_FLAGS 不含)。'
  },
  {
    name: 'OTHER_CLIENTS',
    detail: 'Cell 广播并同步给 AOI 其它客户端',
    documentation: '对应 ED_FLAG_OTHER_CLIENTS(0x80);属性在 cellapp 注册并跨 cell 广播(ENTITY_BROADCAST_CELL_FLAGS 含此位),推送给 AOI 内其它客户端(BROADCAST_OTHER_CLIENT_FLAGS 含此位),不含拥有者客户端。'
  },
  {
    name: 'CELL',
    detail: 'CELL_PUBLIC 别名',
    documentation: 'KBEngine 在 entitydef.cpp:161 映射到 CELL_PUBLIC(同一位 0x01):cellapp 注册并跨 cell 广播,不进客户端。'
  },
  {
    name: 'CELL_AND_CLIENT',
    detail: 'CELL_PUBLIC_AND_OWN 别名',
    documentation: 'KBEngine 在 entitydef.cpp:162 映射到 CELL_PUBLIC_AND_OWN(同一位 0x08):cellapp 注册并跨 cell 广播,只同步给拥有者客户端。'
  },
  {
    name: 'CELL_AND_CLIENTS',
    detail: 'ALL_CLIENTS 别名',
    documentation: 'KBEngine 在 entitydef.cpp:163 映射到 ALL_CLIENTS(同一位 0x04):cellapp 注册并跨 cell 广播,同步给所有客户端。'
  },
  {
    name: 'CELL_AND_OTHER_CLIENTS',
    detail: 'OTHER_CLIENTS 别名',
    documentation: 'KBEngine 在 entitydef.cpp:164 映射到 OTHER_CLIENTS(同一位 0x80):cellapp 注册并跨 cell 广播,只同步给 AOI 其它客户端。'
  }
];

// Source: kbe/src/lib/entitydef/entitydef.cpp::loadDetailLevelInfo
export const DETAIL_LEVELS = ['NEAR', 'MEDIUM', 'FAR'];

export const KBENGINE_RELOAD_FUNCTIONS: KBEngineMetadataItem[] = [
  {
    name: 'KBEngine.reloadScript',
    detail: '重新加载当前组件脚本',
    documentation: '对应 baseapp/cellapp 暴露的 `KBEngine.reloadScript(fullReload)`，用于重新加载当前组件内的 Python 脚本。'
  },
  {
    name: 'importlib.reload',
    detail: '重新加载 Python 模块',
    documentation: 'Python 标准库提供的模块重载工具。适用于普通模块重载，不是 KBEngine 专有 API。'
  }
];
