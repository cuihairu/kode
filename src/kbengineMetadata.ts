export interface KBEngineMetadataItem {
  name: string;
  detail: string;
  documentation: string;
}

export const KBENGINE_TYPES: KBEngineMetadataItem[] = [
  { name: 'UINT8', detail: '无符号8位整数', documentation: '范围: 0-255, 占用1字节' },
  { name: 'UINT16', detail: '无符号16位整数', documentation: '范围: 0-65535, 占用2字节' },
  { name: 'UINT32', detail: '无符号32位整数', documentation: '范围: 0-4294967295, 占用4字节' },
  { name: 'UINT64', detail: '无符号64位整数', documentation: '范围: 0-18446744073709551615, 占用8字节' },
  { name: 'INT8', detail: '有符号8位整数', documentation: '范围: -128-127, 占用1字节' },
  { name: 'INT16', detail: '有符号16位整数', documentation: '范围: -32768-32767, 占用2字节' },
  { name: 'INT32', detail: '有符号32位整数', documentation: '范围: -2147483648-2147483647, 占用4字节' },
  { name: 'INT64', detail: '有符号64位整数', documentation: '范围: -9223372036854775808-9223372036854775807, 占用8字节' },
  { name: 'FLOAT', detail: '单精度浮点数', documentation: '32位IEEE 754浮点数' },
  { name: 'DOUBLE', detail: '双精度浮点数', documentation: '64位IEEE 754浮点数' },
  { name: 'BOOL', detail: '布尔值', documentation: 'true 或 false' },
  { name: 'STRING', detail: '字符串', documentation: '变长字符串类型' },
  { name: 'VECTOR2', detail: '2D向量', documentation: '包含 x, y 两个浮点数' },
  { name: 'VECTOR3', detail: '3D向量', documentation: '包含 x, y, z 三个浮点数' },
  { name: 'VECTOR4', detail: '4D向量', documentation: '包含 x, y, z, w 四个浮点数' },
  { name: 'MAILBOX', detail: '实体引用', documentation: '指向其他实体的引用类型' },
  { name: 'ARRAY', detail: '数组', documentation: '动态数组类型: ARRAY<TYPE>' },
  { name: 'FIXED_DICT', detail: '固定字典', documentation: '类Python字典结构，需要定义实现类' },
  { name: 'TUPLE', detail: '元组', documentation: '固定长度元组，每个位置可以指定不同类型' }
];

export const KBENGINE_FLAGS: KBEngineMetadataItem[] = [
  {
    name: 'BASE',
    detail: 'BaseApp存储',
    documentation: '数据存储在BaseApp，不会自动分片'
  },
  {
    name: 'CLIENT',
    detail: '客户端可见',
    documentation: '数据会同步到客户端'
  },
  {
    name: 'BASE_CLIENT',
    detail: 'BaseApp存储 + 客户端可见',
    documentation: '数据存储在BaseApp并同步到客户端（最常用组合）'
  },
  {
    name: 'CELL_PUBLIC',
    detail: 'CellApp公开',
    documentation: '其他实体可以访问该属性'
  },
  {
    name: 'CELL_PRIVATE',
    detail: 'CellApp私有',
    documentation: '只有实体自己可以访问该属性'
  },
  {
    name: 'CELL_PUBLIC_AND_PRIVATE',
    detail: 'CellApp公开+私有',
    documentation: '同时设置CELL_PUBLIC和CELL_PRIVATE标志'
  },
  {
    name: 'ALL_CLIENTS',
    detail: '所有客户端可见',
    documentation: '属性会广播给所有能感知到该实体的客户端'
  },
  {
    name: 'OWN_CLIENT',
    detail: '仅拥有者可见',
    documentation: '属性只同步给控制该实体的客户端'
  }
];

export const DETAIL_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const KBENGINE_RELOAD_FUNCTIONS: KBEngineMetadataItem[] = [
  {
    name: 'KBEngine.reloadEntityDef',
    detail: '重新加载实体定义',
    documentation: '热更新实体定义，使修改后的 .def 文件生效。\n\n**参数**:\n- fullReload (bool): True=完全重新加载所有实体，False=只加载新的实体\n\n**示例**:\n```python\nimport KBEngine\n# 完全重新加载\nKBEngine.reloadEntityDef(True)\n# 或只加载新的\nKBEngine.reloadEntityDef(False)\n```\n\n**注意**:\n- 修改了 .def 文件中的属性或方法定义后需要调用\n- fullReload=True 会重新加载所有实体定义，可能会影响性能\n- 修改后需要重新创建实体才能看到新的属性或方法\n\n**源码位置**: `kbe/src/lib/entitydef/entitydef.cpp:120-150`'
  },
  {
    name: 'KBEngine.isReload',
    detail: '检查是否热更新',
    documentation: '检查当前是否是热更新场景。\n\n**返回值**: bool\n- True: 当前是热更新场景\n- False: 当前是正常启动场景\n\n**示例**:\n```python\nimport KBEngine\n\ndef onEntitiesEnabled(self):\n    if KBEngine.isReload():\n        INFO_MSG("Hot-reloaded!")\n    else:\n        INFO_MSG("Normal startup!")\n```\n\n**使用场景**:\n- 在 onEntitiesEnabled 中区分热更新和正常启动\n- 热更新后需要重新初始化某些状态时使用\n\n**源码位置**: `kbe/src/lib/entitydef/entitydef.cpp:114-117`'
  },
  {
    name: 'importlib.reload',
    detail: 'Python 脚本热更新',
    documentation: '重新加载 Python 模块，用于热更新 Python 脚本代码。\n\n**参数**:\n- module: 要重新加载的模块对象\n\n**返回值**: 重新加载后的模块对象\n\n**示例**:\n```python\nimport importlib\nimport my_module\n\n# 修改了 my_module.py 后\nmy_module = importlib.reload(my_module)\n```\n\n**注意**:\n- 只对修改了 Python 方法的代码有效\n- 如果修改了 .def 文件，需要使用 KBEngine.reloadEntityDef()\n- 重新加载模块后，需要重新导入模块中的类和函数\n- 已存在的实例不会自动更新\n\n**使用场景**:\n- 修改了实体类的 Python 方法\n- 修改了游戏逻辑代码\n- 调试时快速测试代码修改\n\n**限制**:\n- 不能修改属性定义（需要用 reloadEntityDef）\n- 不能修改方法签名（参数、返回值）\n- 不能修改继承关系'
  }
];
