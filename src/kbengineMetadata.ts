export interface KBEngineMetadataItem {
  name: string;
  detail: string;
  documentation: string;
}

// 这里保留插件当前支持的常见类型集合，标志与细节级别则严格按 KBEngine 源码校准。
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
  { name: 'BOOL', detail: '布尔值', documentation: '取值为 true 或 false。' },
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
  { name: 'ARRAY', detail: '数组容器', documentation: '由内部 Type 节点声明元素类型。' },
  { name: 'FIXED_DICT', detail: '固定字典容器', documentation: '需要 Properties 子节点，支持 implementedBy。' },
  { name: 'TUPLE', detail: '元组容器', documentation: '固定顺序的复合类型。' }
];

// 来源: kbe/src/lib/entitydef/entitydef.cpp 与 common.cpp
export const KBENGINE_FLAGS: KBEngineMetadataItem[] = [
  {
    name: 'CELL_PUBLIC',
    detail: 'Cell 广播',
    documentation: '对应 ED_FLAG_CELL_PUBLIC，可广播到相关 cell。'
  },
  {
    name: 'CELL_PRIVATE',
    detail: '当前 Cell 私有',
    documentation: '对应 ED_FLAG_CELL_PRIVATE，仅当前 cell 可见。'
  },
  {
    name: 'ALL_CLIENTS',
    detail: '同步到所有客户端',
    documentation: '对应 ED_FLAG_ALL_CLIENTS。'
  },
  {
    name: 'CELL_PUBLIC_AND_OWN',
    detail: 'Cell 广播并同步给拥有者客户端',
    documentation: '对应 ED_FLAG_CELL_PUBLIC_AND_OWN。'
  },
  {
    name: 'OWN_CLIENT',
    detail: '仅同步给拥有者客户端',
    documentation: '对应 ED_FLAG_OWN_CLIENT。'
  },
  {
    name: 'BASE_AND_CLIENT',
    detail: 'Base 与客户端',
    documentation: '对应 ED_FLAG_BASE_AND_CLIENT。'
  },
  {
    name: 'BASE',
    detail: '仅 Base',
    documentation: '对应 ED_FLAG_BASE。'
  },
  {
    name: 'OTHER_CLIENTS',
    detail: '同步给其他客户端',
    documentation: '对应 ED_FLAG_OTHER_CLIENTS。'
  },
  {
    name: 'CELL',
    detail: 'CELL_PUBLIC 别名',
    documentation: 'KBEngine 在 entitydef.cpp 中映射到 CELL_PUBLIC。'
  },
  {
    name: 'CELL_AND_CLIENT',
    detail: 'CELL_PUBLIC_AND_OWN 别名',
    documentation: 'KBEngine 在 entitydef.cpp 中映射到 CELL_PUBLIC_AND_OWN。'
  },
  {
    name: 'CELL_AND_CLIENTS',
    detail: 'ALL_CLIENTS 别名',
    documentation: 'KBEngine 在 entitydef.cpp 中映射到 ALL_CLIENTS。'
  },
  {
    name: 'CELL_AND_OTHER_CLIENTS',
    detail: 'OTHER_CLIENTS 别名',
    documentation: 'KBEngine 在 entitydef.cpp 中映射到 OTHER_CLIENTS。'
  }
];

// 来源: kbe/src/lib/entitydef/entitydef.cpp::loadDetailLevelInfo
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
