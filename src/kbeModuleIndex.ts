// kbe 模块符号索引(批108,kbe.KBEntity 导航缺失修复):
// 用户项目以 `class GameObject(kbe.KBEntity)` 的形态继承内置基类,但 kbe
// 模块符号此前无任何来源——kode 无内置索引,python 扩展只认真实 import
// 路径,go-to-definition/completion 全部落空。本模块提供 kode 内置的
// kbe/KBEngine 模块符号索引(桩文档跳转源 + 补全表):
// - 符号面以 KBEngine 引擎源码 typings 包为唯一事实源(各条目带
//   sourceFile:sourceLine,tests/kbeModuleIndex.test.ts 的引擎源码条件
//   用例逐条回验;引擎检出缺席时该组用例 skip,与 hooks/metadata 同口径);
// - KBEntity 是 kode 提供的别名条目(对齐项目侧 `kbe.KBEntity` 基类习惯,
//   实体指向引擎 Entity 基类),桩文档里如实标注,不伪装成引擎原生符号;
// - 纯模块,不 import vscode;跳转目标以 { scheme, path, line } 交给
//   languageProviders 装配成 vscode.Location,桩内容由 extension.ts 的
//   TextDocumentContentProvider 按 scheme 提供。

export const KBE_SCHEME = 'kbe-stub';
export const KBE_STUB_PATH = '/KBEngine.pyi';

export type KbeSymbolKind = 'class' | 'function';

export interface KbeSymbolEntry {
  name: string;
  kind: KbeSymbolKind;
  /** 桩文档与补全详情里展示的签名 */
  signature: string;
  /** 一句话说明,中文(桩文档 docstring 与补全 documentation 复用) */
  summary: string;
  /** 一句话说明,英文(GEN-DEF-1d:双语必填,缺一不可,TS 构建校验) */
  summaryEn: string;
  /** 引擎 typings 内的锚点文件(相对引擎仓库根) */
  sourceFile: string;
  /** 引擎 typings 内 class/def 声明行(1 起) */
  sourceLine: number;
  /** kode 别名条目指向的正式符号名(KBEntity → Entity) */
  aliasOf?: string;
  /**
   * Python 暴露名 ≠ C++ 类名时的 C++ 类名(如 Vector3 → ScriptVector3)。
   * 引擎源码锚点回验按此名匹配 `class <cppClassName>` 声明行。
   */
  cppClassName?: string;
  /**
   * KB-VER-002 版本分层归属:官方 3.7.3 基线 / fork 3.12+ 新增 / 待取证。
   * 缺省(省略)即 baseline——3.7.3 基线。非基线条目须显式标注,标注依据
   * 是各 api-*.md 的「3.7 source material vs fork 3.12 deviations」表,
   * 不得凭猜测改标。
   */
  version?: EngineApiVersion;
}

/** KB-VER-002 版本分层标注的三档值(见 KbeSymbolEntry.version) */
export type EngineApiVersion = 'baseline' | 'fork' | 'pending';

const COMMON_STUB = 'typings/_KBEngine_common.pyi';
const BASEAPP_STUB = 'typings/_KBEngine_baseapp.pyi';
const CELLAPP_STUB = 'typings/_KBEngine_cellapp.pyi';

export const KBE_SYMBOLS: KbeSymbolEntry[] = [
  {
    name: 'KBEntity',
    kind: 'class',
    signature: 'class KBEntity(Entity)',
    summary:
      'kode 内置别名:对齐项目侧 `kbe.KBEntity` 基类习惯,实体指向引擎 Entity 基类(非引擎原生符号)。' +
      '实体脚本继承它即可获得 id/className/cell/base 等实体属性与生命周期钩子。',
    summaryEn: 'kode built-in alias: aligns with the project-side `kbe.KBEntity` base-class convention, pointing entities at the engine Entity base (not an engine-native symbol). Inheriting from it in an entity script gives id/className/cell/base attributes and lifecycle hooks.',
    sourceFile: COMMON_STUB,
    sourceLine: 67,
    aliasOf: 'Entity'
  },
  {
    name: 'Entity',
    kind: 'class',
    signature: 'class Entity',
    summary:
      '引擎实体基类(baseapp/cellapp 侧实体脚本基类):id/className/client/cell/base/databaseID 属性与 ' +
      'addTimer/destroy 等实体方法,以及 onDestroy 等生命周期钩子。',
    summaryEn: 'Engine entity base class (base class for entity scripts on baseapp/cellapp): id/className/client/cell/base/databaseID attributes, entity methods like addTimer/destroy, and lifecycle hooks like onDestroy.',
    sourceFile: COMMON_STUB,
    sourceLine: 67
  },
  {
    name: 'Proxy',
    kind: 'class',
    signature: 'class Proxy(Entity)',
    summary: '账号代理实体基类,携带 __ACCOUNT_NAME__/__ACCOUNT_PASSWORD__ 协议字段。',
    summaryEn: 'Base class for account proxy entities, carrying the __ACCOUNT_NAME__/__ACCOUNT_PASSWORD__ protocol fields.',
    sourceFile: COMMON_STUB,
    sourceLine: 204
  },
  {
    name: 'Space',
    kind: 'class',
    signature: 'class Space(Entity)',
    summary: '空间实体基类。',
    summaryEn: 'Base class for space entities.',
    sourceFile: COMMON_STUB,
    sourceLine: 224
  },
  {
    name: 'EntityComponent',
    kind: 'class',
    signature: 'class EntityComponent',
    summary: '实体组件基类:client/cell/base EntityCall 引用与实体生命周期钩子。',
    summaryEn: 'Base class for entity components: client/cell/base EntityCall references and entity lifecycle hooks.',
    sourceFile: COMMON_STUB,
    sourceLine: 227
  },
  {
    name: 'Entities',
    kind: 'class',
    signature: 'class Entities(Dict[int, Entity])',
    summary: '实体表:entityID → Entity 映射。',
    summaryEn: 'Entity table: entityID → Entity mapping.',
    sourceFile: COMMON_STUB,
    sourceLine: 240
  },
  {
    name: 'EntityCall',
    kind: 'class',
    signature: 'class EntityCall',
    summary: '实体远程调用句柄基类:getComponent 取组件 EntityCall。',
    summaryEn: 'Base class for entity remote-call handles: getComponent returns a component EntityCall.',
    sourceFile: COMMON_STUB,
    sourceLine: 32
  },



  {
    name: 'EntityComponentCall',
    kind: 'class',
    signature: 'class EntityComponentCall(EntityCall)',
    summary: '实体组件远程调用句柄。',
    summaryEn: 'Entity component remote-call handle.',
    sourceFile: COMMON_STUB,
    sourceLine: 43
  },
  {
    name: 'MemoryStream',
    kind: 'class',
    signature: 'class MemoryStream',
    summary: '二进制流:append/pop 按 dataType 读写,常用于自定义协议打包。',
    summaryEn: 'Binary stream: append/pop read-write by dataType, commonly used for custom protocol packing.',
    sourceFile: COMMON_STUB,
    sourceLine: 45,
    // KB-VER-002:api-baseapp.md deviation 表实测 baseapp(EntityApp)注册链
    // 无此构造器,仅 PythonApp 工具链注册(python_app.cpp:271 在,
    // entity_app.h:407-453 无)——运行时归属待取证。
    version: 'pending'
  },
  {
    name: 'address',
    kind: 'function',
    signature: 'def address() -> Address',
    summary: '当前组件进程的监听地址。',
    summaryEn: 'Listen address of the current component process.',
    sourceFile: BASEAPP_STUB,
    sourceLine: 21
  },
  {
    name: 'time',
    kind: 'function',
    signature: 'def time() -> int',
    summary: '引擎游戏时间(秒,游戏节拍)。',
    summaryEn: 'Engine game time (seconds, game tick).',
    sourceFile: BASEAPP_STUB,
    sourceLine: 22
  },
  {
    name: 'isShuttingDown',
    kind: 'function',
    signature: 'def isShuttingDown() -> bool',
    summary: '进程是否正在关闭。',
    summaryEn: 'Whether the process is shutting down.',
    sourceFile: BASEAPP_STUB,
    sourceLine: 23
  },
  {
    name: 'getWatcher',
    kind: 'function',
    signature: 'def getWatcher(path: str) -> WatcherValue',
    summary: '读取 watcher 指标值(监控面板数据源同款)。',
    summaryEn: 'Read a watcher metric value (same data source as the monitoring panel).',
    sourceFile: BASEAPP_STUB,
    sourceLine: 24
  },
  {
    name: 'getWatcherDir',
    kind: 'function',
    signature: 'def getWatcherDir(path: str) -> Tuple[str, ...]',
    summary: '列出 watcher 目录下的组件/路径。',
    summaryEn: 'List components/paths under a watcher directory.',
    sourceFile: BASEAPP_STUB,
    sourceLine: 25
  },
  {
    name: 'addWatcher',
    kind: 'function',
    signature: 'def addWatcher(path: str, dataType: str, getFunction: Callable[[], WatcherValue]) -> None',
    summary: '注册自定义 watcher 指标。',
    summaryEn: 'Register a custom watcher metric.',
    sourceFile: BASEAPP_STUB,
    sourceLine: 26
  },
  {
    name: 'delWatcher',
    kind: 'function',
    signature: 'def delWatcher(path: str) -> None',
    summary: '注销自定义 watcher 指标。',
    summaryEn: 'Unregister a custom watcher metric.',
    sourceFile: BASEAPP_STUB,
    sourceLine: 31
  },
  {
    name: 'setAppFlags',
    kind: 'function',
    signature: 'def setAppFlags(flags: int) -> None',
    summary: '设置进程 flags 位。',
    summaryEn: 'Set process flags bits.',
    sourceFile: BASEAPP_STUB,
    sourceLine: 32
  },
  {
    name: 'getAppFlags',
    kind: 'function',
    signature: 'def getAppFlags() -> int',
    summary: '读取进程 flags 位。',
    summaryEn: 'Read process flags bits.',
    sourceFile: BASEAPP_STUB,
    sourceLine: 33
  },
  {
    name: 'reloadScript',
    kind: 'function',
    signature: 'def reloadScript(fullReload: bool = False) -> None',
    summary: '热更脚本(与 kode 热更新支持面板同一入口)。',
    summaryEn: 'Hot-reload scripts (same entry as the kode hot-update support panel).',
    sourceFile: BASEAPP_STUB,
    sourceLine: 34
  },
  {
    name: 'quantumPassedPercent',
    kind: 'function',
    signature: 'def quantumPassedPercent() -> int',
    summary: '当前时间片推进百分比。',
    summaryEn: 'Current time-slice advancement percentage.',
    sourceFile: BASEAPP_STUB,
    sourceLine: 35
  },
  {
    name: 'createEntity',
    kind: 'function',
    signature: 'def createEntity(entityType: str, params: Union[Dict[str, Any], None] = None) -> Union[Entity, None]',
    summary: '本地创建实体(同步返回)。',
    summaryEn: 'Create an entity locally (returns synchronously).',
    sourceFile: BASEAPP_STUB,
    sourceLine: 36
  },
  {
    name: 'createEntityLocally',
    kind: 'function',
    signature: 'def createEntityLocally(entityType: str, params: Union[Dict[str, Any], None] = None) -> Union[Entity, None]',
    summary: '在本进程创建实体(同步返回)。',
    summaryEn: 'Create an entity in this process (returns synchronously).',
    sourceFile: BASEAPP_STUB,
    sourceLine: 40
  },
  {
    name: 'createEntityAnywhere',
    kind: 'function',
    signature: 'def createEntityAnywhere(entityType: str, params: Union[Dict[str, Any], None] = None, callback: Union[Callback, None] = None) -> None',
    summary: '在任意合适进程创建实体(回调返回)。',
    summaryEn: 'Create an entity in any suitable process (returns via callback).',
    sourceFile: BASEAPP_STUB,
    sourceLine: 44
  },
  {
    name: 'createEntityRemotely',
    kind: 'function',
    signature: 'def createEntityRemotely(entityType: str, baseMB: EntityCall, params: Union[Dict[str, Any], None] = None, callback: Union[Callback, None] = None) -> None',
    summary: '在指定 base 实体所在进程创建实体(回调返回)。',
    summaryEn: 'Create an entity in the process hosting a specified base entity (returns via callback).',
    sourceFile: BASEAPP_STUB,
    sourceLine: 49
  },
  {
    name: 'createEntityFromDBID',
    kind: 'function',
    signature: 'def createEntityFromDBID(entityType: str, dbID: int, callback: Union[Callback, None] = None, dbInterfaceName: str = "default") -> None',
    summary: '按数据库 ID 创建实体(回调返回)。',
    summaryEn: 'Create an entity by database ID (returns via callback).',
    sourceFile: BASEAPP_STUB,
    sourceLine: 55
  },
  {
    name: 'createEntityAnywhereFromDBID',
    kind: 'function',
    signature: 'def createEntityAnywhereFromDBID(entityType: str, dbID: int, callback: Union[Callback, None] = None, dbInterfaceName: str = "default") -> None',
    summary: '按数据库 ID 在任意进程创建实体(回调返回)。',
    summaryEn: 'Create an entity by database ID in any process (returns via callback).',
    sourceFile: BASEAPP_STUB,
    sourceLine: 61
  },
  {
    name: 'createEntityRemotelyFromDBID',
    kind: 'function',
    signature: 'def createEntityRemotelyFromDBID(entityType: str, dbID: int, baseMB: EntityCall, callback: Union[Callback, None] = None, dbInterfaceName: str = "default") -> None',
    summary: '按数据库 ID 在指定 base 实体所在进程创建实体(回调返回)。',
    summaryEn: 'Create an entity by database ID in the process hosting a specified base entity (returns via callback).',
    sourceFile: BASEAPP_STUB,
    sourceLine: 67
  },
  {
    name: 'charge',
    kind: 'function',
    signature: 'def charge(ordersID: str, dbID: int, byteDatas: bytes, pycallback: Union[Callback, None] = None) -> None',
    summary: '提交计费订单(回调返回计费结果)。',
    summaryEn: 'Submit a billing order (returns the billing result via callback).',
    sourceFile: BASEAPP_STUB,
    sourceLine: 75
  },
  {
    name: 'deleteEntityByDBID',
    kind: 'function',
    signature: 'def deleteEntityByDBID(entityType: str, dbID: int, callback: Union[Callback, None] = None, dbInterfaceName: str = "default") -> None',
    summary: '按数据库 ID 删除实体(回调返回)。',
    summaryEn: 'Delete an entity by database ID (returns via callback).',
    sourceFile: BASEAPP_STUB,
    sourceLine: 81
  },
  {
    name: 'lookUpEntityByDBID',
    kind: 'function',
    signature: 'def lookUpEntityByDBID(entityType: str, dbID: int, callback: Callback, dbInterfaceName: str = "default") -> None',
    summary: '按数据库 ID 查找已存在实体(回调返回 EntityCall)。',
    summaryEn: 'Look up an existing entity by database ID (returns an EntityCall via callback).',
    sourceFile: BASEAPP_STUB,
    sourceLine: 87
  },
  // ---- SP-2: cellapp 空间/导航模块函数(api-cellapp.md 行摘要) ----
  {
    name: 'addSpaceGeometryMapping',
    kind: 'function',
    signature:
      'def addSpaceGeometryMapping(spaceID: int, mapper: Any, path: str, shouldLoadOnServer: bool = True, params: Union[Dict[int, str], None] = None) -> None',
    summary:
      '为空间绑定 navmesh/几何数据;params 为 layer→navmesh 文件映射(如 {0:"xx.navmesh"});' +
      'shouldLoadOnServer=True 时经线程池异步加载,完成回调 onSpaceGeometryLoaded/onAllSpaceGeometryLoaded' +
      '(cellapp.cpp:180 → SpaceMemory::__py_AddSpaceGeometryMapping)。',
    summaryEn:
      'Bind navmesh/geometry to a space; params maps layers to navmesh files (e.g. {0:"xx.navmesh"}); ' +
      'with shouldLoadOnServer=True loads async on the thread pool, completion callbacks ' +
      'onSpaceGeometryLoaded/onAllSpaceGeometryLoaded (cellapp.cpp:180 → SpaceMemory::__py_AddSpaceGeometryMapping).',
    sourceFile: CELLAPP_STUB,
    sourceLine: 40
  },
  {
    name: 'getSpaceGeometryMapping',
    kind: 'function',
    signature: 'def getSpaceGeometryMapping(spaceID: int) -> str',
    summary: '查询空间当前绑定的几何映射路径(cellapp.cpp:181)。',
    summaryEn: "Query the space's current geometry mapping path (cellapp.cpp:181).",
    sourceFile: CELLAPP_STUB,
    sourceLine: 47
  },
  {
    name: 'setSpaceData',
    kind: 'function',
    signature: 'def setSpaceData(spaceID: int, key: str, value: str) -> None',
    summary:
      '写入空间键值字符串(SpaceData);变更经 SpaceMemory::onSpaceDataChanged 广播,' +
      '入口脚本回调 onSpaceData(cellapp.cpp:182)。',
    summaryEn:
      'Write a space key/value string (SpaceData); changes broadcast via SpaceMemory::onSpaceDataChanged, ' +
      'entry-script callback onSpaceData (cellapp.cpp:182).',
    sourceFile: CELLAPP_STUB,
    sourceLine: 48
  },
  {
    name: 'getSpaceData',
    kind: 'function',
    signature: 'def getSpaceData(spaceID: int, key: str) -> str',
    summary: '读取空间键值字符串(cellapp.cpp:183)。',
    summaryEn: 'Read a space key/value string (cellapp.cpp:183).',
    sourceFile: CELLAPP_STUB,
    sourceLine: 49
  },
  {
    name: 'delSpaceData',
    kind: 'function',
    signature: 'def delSpaceData(spaceID: int, key: str) -> None',
    summary:
      '删除空间键值;变更同样经 onSpaceDataChanged 广播(del 路径 value 为 None),' +
      '入口脚本回调 onSpaceData(cellapp.cpp:184)。',
    summaryEn:
      'Delete a space key; the change also broadcasts via onSpaceDataChanged (delete path passes value=None), ' +
      'entry-script callback onSpaceData (cellapp.cpp:184).',
    sourceFile: CELLAPP_STUB,
    sourceLine: 50
  },
  {
    name: 'raycast',
    kind: 'function',
    signature:
      'def raycast(spaceID: int, layer: int, src: Vector3Like, dst: Vector3Like) -> Tuple[Vector3Like, ...]',
    summary:
      '几何射线检测(3 或 4 参,3 参形式 layer 默认 0);要求空间已经 addSpaceGeometryMapping 装载几何' +
      '(cellapp.cpp:187,实现 cellapp.cpp:2158)。',
    summaryEn:
      'Geometry ray cast (3 or 4 args; the 3-arg form defaults layer to 0); requires the space to have ' +
      'geometry loaded via addSpaceGeometryMapping (cellapp.cpp:187, impl cellapp.cpp:2158).',
    sourceFile: CELLAPP_STUB,
    sourceLine: 54
  },
  {
    name: 'FixedArray',
    kind: 'class',
    signature: 'class FixedArray(Generic[T])',
    summary: 'def ARRAY 属性的运行时容器(script::Sequence):元素类型受检,append/extend/insert/remove 返回 bool,pop 返回被弹出元素。',
    summaryEn: 'Runtime container for def ARRAY properties (script::Sequence): element types are checked, append/extend/insert/remove return bool, pop returns the popped element.',
    sourceFile: 'kbe/src/lib/entitydef/fixedarray.h',
    sourceLine: 13
  },
  {
    name: 'FixedDict',
    kind: 'class',
    signature: 'class FixedDict(Mapping[str, Any])',
    summary: 'def FIXED_DICT 属性的运行时容器(script::Map):键集合按 def 固定,属性注解用 TypedDict 精确表达,本类是它的容器基面。',
    summaryEn: 'Runtime container for def FIXED_DICT properties (script::Map): the key set is fixed by def; the property annotation is expressed precisely as a TypedDict; this class is its container base surface.',
    sourceFile: 'kbe/src/lib/entitydef/fixeddict.h',
    sourceLine: 15
  },
  {
    name: 'Vector2',
    kind: 'class',
    signature: 'class Vector2',
    summary: 'KBEngine 二维向量(ScriptVector2,pyscript/vector2.h):x/y 分量、length/lengthSquared 只读、distTo/distSqrTo/cross2D/dot/scale/normalise/tuple/list/set,序列与算术协议。def VECTOR2 属性注解用本类。',
    summaryEn: 'KBEngine 2D vector (ScriptVector2, pyscript/vector2.h): x/y components, read-only length/lengthSquared, distTo/distSqrTo/cross2D/dot/scale/normalise/tuple/list/set, sequence and arithmetic protocols. def VECTOR2 property annotations use this class.',
    sourceFile: 'kbe/src/lib/pyscript/vector2.h',
    sourceLine: 12,
    cppClassName: 'ScriptVector2'
  },
  {
    name: 'Vector3',
    kind: 'class',
    signature: 'class Vector3',
    summary: 'KBEngine 三维向量(ScriptVector3,pyscript/vector3.h):x/y/z 分量、length/lengthSquared 只读、flatDistTo/flatDistSqrTo/distTo/distSqrTo/cross2D/dot/scale/normalise/tuple/list/set,序列与算术协议。def VECTOR3 属性注解用本类。',
    summaryEn: 'KBEngine 3D vector (ScriptVector3, pyscript/vector3.h): x/y/z components, read-only length/lengthSquared, flatDistTo/flatDistSqrTo/distTo/distSqrTo/cross2D/dot/scale/normalise/tuple/list/set, sequence and arithmetic protocols. def VECTOR3 property annotations use this class.',
    sourceFile: 'kbe/src/lib/pyscript/vector3.h',
    sourceLine: 12,
    cppClassName: 'ScriptVector3'
  },
  {
    name: 'Vector4',
    kind: 'class',
    signature: 'class Vector4',
    summary: 'KBEngine 四维向量(ScriptVector4,pyscript/vector4.h):x/y/z/w 分量、length/lengthSquared 只读、distTo/distSqrTo/dot/scale/normalise/tuple/list/set,序列与算术协议。def VECTOR4 属性注解用本类。',
    summaryEn: 'KBEngine 4D vector (ScriptVector4, pyscript/vector4.h): x/y/z/w components, read-only length/lengthSquared, distTo/distSqrTo/dot/scale/normalise/tuple/list/set, sequence and arithmetic protocols. def VECTOR4 property annotations use this class.',
    sourceFile: 'kbe/src/lib/pyscript/vector4.h',
    sourceLine: 12,
    cppClassName: 'ScriptVector4'
  }
];

export const KBE_SYMBOL_CATALOG = 'partial';
export const KBE_SYMBOL_CATALOG_NOTE =
  'KBE_SYMBOLS is a curated engine subset, not a complete engine API catalog.';

const KBE_SYMBOL_BY_NAME = new Map(KBE_SYMBOLS.map(entry => [entry.name, entry]));

export function getKbeSymbol(name: string): KbeSymbolEntry | null {
  return KBE_SYMBOL_BY_NAME.get(name) ?? null;
}

/**
 * GEN-DEF-1d:按 IDE 显示语言选 API 条目的 summary 文案。zh 前缀(zh-cn/
 * zh-tw 等)取中文,其余取英文;任何缺位回落英文(双字段类型级强制,
 * 这里只做防御)。传入 `vscode.env.language`。
 */
export function summaryForLanguage(
  entry: Pick<KbeSymbolEntry, 'summary' | 'summaryEn'>,
  ideLanguage?: string
): string {
  if (ideLanguage?.startsWith('zh')) {
    return entry.summary || entry.summaryEn;
  }
  return entry.summaryEn || entry.summary;
}

/**
 * KB-VER-002:按条目版本归属与当前引擎版本设置计算补全/悬停的版本标注。
 * 返回标注文案(按 IDE 语言)或 null(无标注)。
 * - baseline:无标注(基线符号不噪音)。
 * - pending:恒标注「待取证」——归属未定案,与引擎版本无关。
 * - fork:仅当当前引擎版本不是 fork- 前缀(默认 3.7.3 官方基线)时标注
 *   「需 fork」;fork- 前缀预设(fork-3.12 等)视为魔改 fork 已含该符号。
 *   自定义 fork 版本未用 fork- 前缀时按保守口径仍标注(宁多提示不漏报),
 *   口径见 configuration.md。
 */
export function engineApiVersionAnnotation(
  entry: Pick<KbeSymbolEntry, 'version'>,
  engineVersion: string,
  ideLanguage?: string
): string | null {
  const version = entry.version ?? 'baseline';
  if (version === 'pending') {
    return ideLanguage?.startsWith('zh')
      ? '版本归属待取证(官方 3.7.3 基线与 fork 3.12 间尚未定案)'
      : 'version attribution to be evidenced (not yet settled between official 3.7.3 and fork 3.12)';
  }
  if (version === 'fork') {
    if (engineVersion.trim().toLowerCase().startsWith('fork')) {
      return null;
    }
    return ideLanguage?.startsWith('zh')
      ? '需 fork(fork-3.12 新增,官方 3.7.3 基线无此符号)'
      : 'requires fork (added in fork 3.12; absent from the official 3.7.3 baseline)';
  }
  return null;
}

/**
 * KB-VER-002:补全 documentation 的单一装配口——summary(按语言)+ 原始
 * 声明锚点 + 版本标注(KB-VER-002)。provider 与单测共用,保证补全面
 * 版本标注与单测同源。
 */
export function kbeCompletionDocumentation(
  entry: KbeSymbolEntry,
  ideLanguage: string | undefined,
  engineVersion: string
): string {
  const base = `${summaryForLanguage(entry, ideLanguage)}\n\n原始声明: \`${entry.sourceFile}:${entry.sourceLine}\``;
  const note = engineApiVersionAnnotation(entry, engineVersion, ideLanguage);
  return note ? `${base}\n\n${note}` : base;
}

/**
 * KB-VER-002:桩文档(.pyi)docstring 的版本归属注——桩是静态文档,无
 * 引擎版本语境,直接标归属(与 api-*.md deviation 表同源),hover 到桩上
 * 即见。
 */
function engineApiVersionStubNote(entry: Pick<KbeSymbolEntry, 'version'>): string | null {
  const version = entry.version ?? 'baseline';
  if (version === 'pending') {
    return '待取证 / to be evidenced: 该符号在 baseapp 注册链的归属未实证(见 api-baseapp deviation 表)';
  }
  if (version === 'fork') {
    return 'fork-3.12 新增 / fork-3.12 addition: 官方 3.7.3 基线无此符号';
  }
  return null;
}

/**
 * 识别本文档引入的 kbe/KBEngine 模块别名(import X / import X as Y),
 * 返回别名集合。无任何引入时返回空集——此时不接管导航/补全,交回 python
 * 扩展,避免误吞普通标识符。
 * R4-F12(AUD-077):from KBEngine import X 只引入符号 X,不绑定模块别名
 * ——from-import 的模块名是来源不是绑定名,不得当 alias 用(否则接受并不
 * 存在的 KBEngine.globalData 访问)。from-import 符号走
 * getKbeFromImportedSymbols,与本集无关。
 */
export function getKbeAliases(documentText: string): Set<string> {
  const aliases = new Set<string>();
  // KR-AUD-33:先取整条 import 名单(逗号可混排其他模块),再逐名识别 kbe/
  // KBEngine——旧正则要求 kbe 紧跟 `import`,`import os, kbe` 整行落空。
  const importPattern = /^\s*import\s+([^\n#]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(documentText)) !== null) {
    for (const part of match[1].split(',')) {
      const name = /^\s*(KBEngine|kbe)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (name) {
        aliases.add(name[2] ?? name[1]);
      }
    }
  }
  return aliases;
}

/**
 * 识别 from-import 引入的 kbe/KBEngine 符号名(from kbe import KBEntity,
 * 支持逗号多名字与括号跨名字面),供类继承头裸名(`class X(KBEntity)`)
 * 的桩定位使用。引擎类名注册口径要求实体类继承 KBEngine 基类子孙
 * (entitydef.cpp:2317-2325,见 docs/source-analysis.md),故继承头里的
 * kbe 裸名按模块符号解析。
 */
export function getKbeFromImportedSymbols(documentText: string): Set<string> {
  const symbols = new Set<string>();
  const collect = (raw: string): void => {
    for (const rawName of raw.replace(/[()\\]/g, '').split(',')) {
      const name = rawName.trim();
      if (/^[A-Za-z_]\w*$/.test(name)) {
        symbols.add(name);
      }
    }
  };

  // 括号字面(可跨行):from kbe import (A,\n  B)
  const parenPattern = /^\s*from\s+(?:KBEngine|kbe)\s+import\s*\(([^)]*)\)/gm;
  let match: RegExpExecArray | null;
  while ((match = parenPattern.exec(documentText)) !== null) {
    collect(match[1]);
  }

  // 单行形态:from kbe import A, B
  const linePattern = /^\s*from\s+(?:KBEngine|kbe)\s+import\s+(.+)$/gm;
  while ((match = linePattern.exec(documentText)) !== null) {
    collect(match[1]);
  }

  return symbols;
}

/**
 * 类继承头基类定位:class X(A, B) 行,position 落在基类标识符(含首尾列)
 * 上时返回该基类名;落在类名上或括号外返回 null。单行口径——多行继承表
 * 不在本行,交回 python 扩展。
 */
export function getPythonClassBaseAtPosition(
  lineText: string,
  character: number
): string | null {
  const header = /^\s*class\s+[A-Za-z_]\w*\s*\(([^()]*)\)/.exec(lineText);
  if (!header) {
    return null;
  }

  const basesStart = header.index + header[0].length - header[1].length - 1;
  const identPattern = /[A-Za-z_]\w*/g;
  let ident: RegExpExecArray | null;
  while ((ident = identPattern.exec(header[1])) !== null) {
    const start = basesStart + ident.index;
    const end = start + ident[0].length;
    if (character >= start && character <= end) {
      return ident[0];
    }
  }
  return null;
}

export interface KbeAccess {
  alias: string;
  symbol: string;
  /** 符号在行内的 0 起始列区间(用于位置命中判断与悬停范围) */
  symbolStart: number;
  symbolEnd: number;
}

/**
 * 解析行内 `alias.Symbol` 访问:alias 必须在已引入集合内,且 position 落在
 * 符号首段上(kbe.KBEntity 的 KBEntity)。嵌套段(kbe.Entity.id 的 id)不属
 * 模块面,返回 null 交回常规链路。
 */
export function resolveKbeAccessAtPosition(
  lineText: string,
  character: number,
  aliases: Set<string>
): KbeAccess | null {
  if (aliases.size === 0) {
    return null;
  }
  const accessPattern = /\b(\w+)\.(\w+(?:\.\w+)*)/g;
  let match: RegExpExecArray | null;
  while ((match = accessPattern.exec(lineText)) !== null) {
    const alias = match[1];
    if (!aliases.has(alias)) {
      continue;
    }
    // 别名前若是 '.',说明是 self.kbe 这类属性访问而非模块访问,不接管
    if (match.index > 0 && lineText[match.index - 1] === '.') {
      continue;
    }
    const symbol = match[2].split('.')[0];
    const symbolStart = match.index + alias.length + 1;
    const symbolEnd = symbolStart + symbol.length;
    if (character >= symbolStart && character <= symbolEnd) {
      return { alias, symbol, symbolStart, symbolEnd };
    }
  }
  return null;
}

/**
 * 补全语境:行前缀以已引入别名加 '.'(可带未完成符号段)结尾时命中,
 * 返回待过滤的部分符号;否则 null。
 */
export function getKbeCompletionContext(
  linePrefix: string,
  aliases: Set<string>
): { alias: string; partialSymbol: string } | null {
  for (const alias of aliases) {
    const pattern = new RegExp(`\\b${alias}\\.(\\w*)$`);
    const match = pattern.exec(linePrefix);
    // 别名前若是 '.',说明是 self.kbe 这类属性访问而非模块访问,不接管
    // (\b 在 '.' 与首字母之间仍成立,与 resolveKbeAccessAtPosition 同款守卫)
    if (match && !(match.index > 0 && linePrefix[match.index - 1] === '.')) {
      return { alias, partialSymbol: match[1] };
    }
  }
  return null;
}

/** 按部分符号过滤索引(前缀匹配,大小写不敏感;空串返回全量) */
export function filterKbeSymbols(partialSymbol: string): KbeSymbolEntry[] {
  const partialLower = partialSymbol.toLowerCase();
  if (!partialLower) {
    return KBE_SYMBOLS;
  }
  return KBE_SYMBOLS.filter(entry => entry.name.toLowerCase().startsWith(partialLower));
}

export interface KbeStubDocument {
  content: string;
  /** 符号名 → 桩文档内 class/def 声明行(0 起) */
  symbolLines: Record<string, number>;
}

/** 逐符号发射桩体(class/def + docstring + 引擎 typings 锚点),
 *  虚拟桩文档与导出 .pyi(盘点 G2)共用同一发射器,内容保证同源 */
/** 容器类型(KBE_CONTAINER_CLASSES)不进普通符号发射,由
 *  emitKbeContainerStubClasses 以完整方法体发射(补全/悬停走 KBE_SYMBOLS
 *  条目,桩文档与导出 .pyi 走方法体,两处共用同一 signature 对齐声明行)。 */
const KBE_CONTAINER_CLASSES = new Set(['FixedArray', 'FixedDict']);
/** 运行时向量类型(GEN-DEF-1c):同容器不进普通符号发射,由
 *  emitKbeVectorStubClasses 以完整方法体发射。 */
const KBE_VECTOR_CLASSES = new Set(['Vector2', 'Vector3', 'Vector4']);

function emitKbeStubBody(lines: string[]): Record<string, number> {
  const symbolLines: Record<string, number> = {};
  let lastKind: KbeSymbolKind | null = null;
  for (const entry of KBE_SYMBOLS) {
    if (KBE_CONTAINER_CLASSES.has(entry.name) || KBE_VECTOR_CLASSES.has(entry.name)) {
      continue;
    }
    if (lastKind !== entry.kind) {
      lines.push('');
      lastKind = entry.kind;
    }
    symbolLines[entry.name] = lines.length;
    lines.push(`${entry.signature}:`);
    // GEN-DEF-1d:docstring 双语——中文段后空行 + `EN:` 段(Pylance 静态桩
    // 无 IDE 语言语境,双语言并陈;hover/补全的动态面按语言单选)
    for (const docLine of wrapSummary(entry.summary)) {
      lines.push(`    """${docLine}"""`);
    }
    lines.push('    """"""');
    const enDoc = wrapSummary(entry.summaryEn);
    enDoc.forEach((docLine, index) => {
      lines.push(`    """${index === 0 ? 'EN: ' : ''}${docLine}"""`);
    });
    // KB-VER-002:非基线条目在桩 docstring 末尾追加版本归属注
    const versionNote = engineApiVersionStubNote(entry);
    if (versionNote) {
      lines.push(`    """版本标注 / version: ${versionNote}"""`);
    }
    if (entry.aliasOf) {
      lines.push(`    # kode 别名:实体指向 ${entry.aliasOf}`);
    }
    lines.push(`    # 源码: ${entry.sourceFile}:${entry.sourceLine}`);
  }
  return symbolLines;
}

/** 逐行发射 KBEngine 运行时容器类型(script::Sequence / script::Map 语义):
 *  FixedArray[T] 与 FixedDict 是 def 容器在 Python 侧的真实运行时类型
 *  (fixedarray.h / fixeddict.h),def 属性注解用它们替代有损 list/dict,方法
 *  签名逐条对齐引擎 py 接口(append/extend/insert/remove 返回 bool,pop 返回
 *  被弹出元素——非 Python list 的 None 语义)。只进桩文档与导出 .pyi,与
 *  KBE_SYMBOLS 同源两处共用同一发射器;声明行恰为 `${entry.signature}:`,
 *  撑起 buildKbeStubDocument 的「每个符号声明行即签名」纪律。 */
function emitKbeContainerStubClasses(
  lines: string[],
  symbolLines: Record<string, number>
): void {
  lines.push('');
  lines.push('# KBEngine 运行时容器类型(script::Sequence / script::Map 语义)');
  lines.push('# 方法签名逐条对齐 kbe/src/lib/entitydef/fixedarray.h、fixeddict.h 的 py 接口。');
  lines.push('# FixedArray 元素类型受检:创建/装载线由引擎灌入,恒非 None。');
  lines.push('');
  lines.push('T = TypeVar(\'T\')');
  lines.push('');
  symbolLines['FixedArray'] = lines.length;
  lines.push('class FixedArray(Generic[T]):');
  lines.push('    """KBEngine 固定数组(script::Sequence 语义)。');
  lines.push('    元素类型受检(isSameItemType);append/extend/insert/remove 返回 bool,');
  lines.push('    pop 返回被弹出元素;支持整数/切片下标、迭代与成员检测。"""');
  lines.push('    def append(self, item: T) -> bool: ...');
  lines.push('    def count(self, item: T) -> int: ...');
  lines.push('    def extend(self, iterable: Iterable[T]) -> bool: ...');
  lines.push('    def index(self, item: T) -> int: ...');
  lines.push('    def insert(self, index: int, item: T) -> bool: ...');
  lines.push('    def pop(self, index: int = -1) -> T: ...');
  lines.push('    def remove(self, item: T) -> bool: ...');
  lines.push('    def clear(self) -> None: ...');
  lines.push('    @overload');
  lines.push('    def __getitem__(self, index: int) -> T: ...');
  lines.push('    @overload');
  lines.push('    def __getitem__(self, index: slice) -> List[T]: ...');
  lines.push('    def __setitem__(self, index: int, value: T) -> None: ...');
  lines.push('    def __len__(self) -> int: ...');
  lines.push('    def __iter__(self) -> Iterator[T]: ...');
  lines.push('    def __contains__(self, item: T) -> bool: ...');
  lines.push('    def __add__(self, other: Iterable[T]) -> FixedArray[T]: ...');
  lines.push('    def __mul__(self, count: int) -> FixedArray[T]: ...');
  lines.push('    def __iadd__(self, other: Iterable[T]) -> FixedArray[T]: ...');
  lines.push('    def __imul__(self, count: int) -> FixedArray[T]: ...');
  lines.push('');
  symbolLines['FixedDict'] = lines.length;
  lines.push('class FixedDict(Mapping[str, Any]):');
  lines.push('    """KBEngine 固定字典(script::Map 语义):键集合按 def 固定。');
  lines.push('    def 属性注解用 TypedDict(固定键精确),本类是它的运行时容器基面;');
  lines.push('    keys/values/items/get/update 逐条对齐 fixeddict.h。"""');
  lines.push('    def has_key(self, key: str) -> bool: ...');
  lines.push('    def keys(self) -> KeysView[str]: ...');
  lines.push('    def values(self) -> ValuesView[Any]: ...');
  lines.push('    def items(self) -> ItemsView[str, Any]: ...');
  lines.push('    def get(self, key: str, default: Any = None) -> Any: ...');
  lines.push('    def update(self, *args: Any, **kwargs: Any) -> None: ...');
  lines.push('    def __getitem__(self, key: str) -> Any: ...');
  lines.push('    def __setitem__(self, key: str, value: Any) -> None: ...');
  lines.push('    def __len__(self) -> int: ...');
  lines.push('    def __iter__(self) -> Iterator[str]: ...');
  lines.push('    def __contains__(self, key: str) -> bool: ...');
}

/** 逐行发射 KBEngine 运行时向量类型(GEN-DEF-1c):Vector2/3/4 是 def
 *  VECTOR2/3/4 属性在 Python 侧的真实运行时类型(pyscript/vectorN.h,
 *  Python 暴露名经 tp_name 注册,与 C++ 类名 ScriptVectorN 不同)。方法面
 *  逐条对齐引擎 py 接口:scale 返回新向量(非就地),normalise/set 就地
 *  返回 None,distTo/distSqrTo/cross2D/dot 返回 float,tuple()/list() 返回
 *  定长元组/列表;序列(__len__/__getitem__/__setitem__)与算术协议
 *  (nb_add/subtract/multiply/divide/negative/positive/nonzero/inplace_*)
 *  同样导出。只进桩文档与导出 .pyi,声明行恰为 `${entry.signature}:`。 */
/** 官方 typings 未覆盖的运行时向量类型(Vector2/3/4),拼接引擎 checkout 时
 * 追加;官方 typings 只有 Vector3Like 别名,无 Vector2/3/4 类。 */
export function emitKbeVectorStubClasses(
  lines: string[],
  symbolLines: Record<string, number>
): void {
  lines.push('');
  lines.push('# KBEngine 运行时向量类型(pyscript/vector2.h、vector3.h、vector4.h)');
  lines.push('# 方法签名逐条对齐引擎 py 接口;def VECTOR2/3/4 属性注解用本组类。');
  lines.push('');
  symbolLines['Vector2'] = lines.length;
  lines.push('class Vector2:');
  lines.push('    """KBEngine 二维向量(ScriptVector2):x/y 分量;');
  lines.push('    scale 返回新向量,normalise/set 就地返回 None。"""');
  lines.push('    x: float');
  lines.push('    y: float');
  lines.push('    length: float');
  lines.push('    lengthSquared: float');
  lines.push('    def __init__(self, x: float, y: float) -> None: ...');
  lines.push('    def distTo(self, other: Vector2) -> float: ...');
  lines.push('    def distSqrTo(self, other: Vector2) -> float: ...');
  lines.push('    def cross2D(self, other: Vector2) -> float: ...');
  lines.push('    def scale(self, factor: float) -> Vector2: ...');
  lines.push('    def dot(self, other: Vector2) -> float: ...');
  lines.push('    def normalise(self) -> None: ...');
  lines.push('    def tuple(self) -> Tuple[float, float]: ...');
  lines.push('    def list(self) -> List[float]: ...');
  lines.push('    def set(self, *args: float) -> None: ...');
  lines.push('    def __len__(self) -> int: ...');
  lines.push('    def __getitem__(self, index: int) -> float: ...');
  lines.push('    def __setitem__(self, index: int, value: float) -> None: ...');
  lines.push('    def __add__(self, other: Vector2) -> Vector2: ...');
  lines.push('    def __sub__(self, other: Vector2) -> Vector2: ...');
  lines.push('    def __mul__(self, factor: float) -> Vector2: ...');
  lines.push('    def __rmul__(self, factor: float) -> Vector2: ...');
  lines.push('    def __truediv__(self, factor: float) -> Vector2: ...');
  lines.push('    def __neg__(self) -> Vector2: ...');
  lines.push('    def __pos__(self) -> Vector2: ...');
  lines.push('    def __bool__(self) -> bool: ...');
  lines.push('    def __iadd__(self, other: Vector2) -> Vector2: ...');
  lines.push('    def __isub__(self, other: Vector2) -> Vector2: ...');
  lines.push('    def __imul__(self, factor: float) -> Vector2: ...');
  lines.push('    def __itruediv__(self, factor: float) -> Vector2: ...');
  lines.push('');
  symbolLines['Vector3'] = lines.length;
  lines.push('class Vector3:');
  lines.push('    """KBEngine 三维向量(ScriptVector3):x/y/z 分量;');
  lines.push('    flatDistTo/flatDistSqrTo 是 XZ 平面距离。"""');
  lines.push('    x: float');
  lines.push('    y: float');
  lines.push('    z: float');
  lines.push('    length: float');
  lines.push('    lengthSquared: float');
  lines.push('    def __init__(self, x: float, y: float, z: float) -> None: ...');
  lines.push('    def flatDistTo(self, other: Vector3) -> float: ...');
  lines.push('    def flatDistSqrTo(self, other: Vector3) -> float: ...');
  lines.push('    def distTo(self, other: Vector3) -> float: ...');
  lines.push('    def distSqrTo(self, other: Vector3) -> float: ...');
  lines.push('    def cross2D(self, other: Vector3) -> float: ...');
  lines.push('    def scale(self, factor: float) -> Vector3: ...');
  lines.push('    def dot(self, other: Vector3) -> float: ...');
  lines.push('    def normalise(self) -> None: ...');
  lines.push('    def tuple(self) -> Tuple[float, float, float]: ...');
  lines.push('    def list(self) -> List[float]: ...');
  lines.push('    def set(self, *args: float) -> None: ...');
  lines.push('    def __len__(self) -> int: ...');
  lines.push('    def __getitem__(self, index: int) -> float: ...');
  lines.push('    def __setitem__(self, index: int, value: float) -> None: ...');
  lines.push('    def __add__(self, other: Vector3) -> Vector3: ...');
  lines.push('    def __sub__(self, other: Vector3) -> Vector3: ...');
  lines.push('    def __mul__(self, factor: float) -> Vector3: ...');
  lines.push('    def __rmul__(self, factor: float) -> Vector3: ...');
  lines.push('    def __truediv__(self, factor: float) -> Vector3: ...');
  lines.push('    def __neg__(self) -> Vector3: ...');
  lines.push('    def __pos__(self) -> Vector3: ...');
  lines.push('    def __bool__(self) -> bool: ...');
  lines.push('    def __iadd__(self, other: Vector3) -> Vector3: ...');
  lines.push('    def __isub__(self, other: Vector3) -> Vector3: ...');
  lines.push('    def __imul__(self, factor: float) -> Vector3: ...');
  lines.push('    def __itruediv__(self, factor: float) -> Vector3: ...');
  lines.push('');
  symbolLines['Vector4'] = lines.length;
  lines.push('class Vector4:');
  lines.push('    """KBEngine 四维向量(ScriptVector4):x/y/z/w 分量。"""');
  lines.push('    x: float');
  lines.push('    y: float');
  lines.push('    z: float');
  lines.push('    w: float');
  lines.push('    length: float');
  lines.push('    lengthSquared: float');
  lines.push('    def __init__(self, x: float, y: float, z: float, w: float) -> None: ...');
  lines.push('    def distTo(self, other: Vector4) -> float: ...');
  lines.push('    def distSqrTo(self, other: Vector4) -> float: ...');
  lines.push('    def scale(self, factor: float) -> Vector4: ...');
  lines.push('    def dot(self, other: Vector4) -> float: ...');
  lines.push('    def normalise(self) -> None: ...');
  lines.push('    def tuple(self) -> Tuple[float, float, float, float]: ...');
  lines.push('    def list(self) -> List[float]: ...');
  lines.push('    def set(self, *args: float) -> None: ...');
  lines.push('    def __len__(self) -> int: ...');
  lines.push('    def __getitem__(self, index: int) -> float: ...');
  lines.push('    def __setitem__(self, index: int, value: float) -> None: ...');
  lines.push('    def __add__(self, other: Vector4) -> Vector4: ...');
  lines.push('    def __sub__(self, other: Vector4) -> Vector4: ...');
  lines.push('    def __mul__(self, factor: float) -> Vector4: ...');
  lines.push('    def __rmul__(self, factor: float) -> Vector4: ...');
  lines.push('    def __truediv__(self, factor: float) -> Vector4: ...');
  lines.push('    def __neg__(self) -> Vector4: ...');
  lines.push('    def __pos__(self) -> Vector4: ...');
  lines.push('    def __bool__(self) -> bool: ...');
  lines.push('    def __iadd__(self, other: Vector4) -> Vector4: ...');
  lines.push('    def __isub__(self, other: Vector4) -> Vector4: ...');
  lines.push('    def __imul__(self, factor: float) -> Vector4: ...');
  lines.push('    def __itruediv__(self, factor: float) -> Vector4: ...');
}

function appendCatalogFootnote(lines: string[]): void {
  lines.push('');
  lines.push(`# Coverage: ${KBE_SYMBOL_CATALOG_NOTE}`);
  lines.push(`# Engine typings anchors: ${KBE_SYMBOLS.length} curated symbols.`);
}

/** Append engine identity when a source checkout is available; `unknown` stays explicit. */
export function appendEngineApiMetadata(
  content: string,
  metadata: { version: string; commit: string; describe: string }
): string {
  const header = [
    `# Engine version: ${metadata.version}`,
    `# Source commit: ${metadata.commit}`,
    `# Source describe: ${metadata.describe}`,
    ''
  ].join('\n');
  const [firstLine, ...rest] = content.split('\n');
  return [firstLine, ...header.split('\n'), ...rest].join('\n');
}

/** 生成物头部统一 typing 导入:容器类(Generic/Iterable/ItemsView/Iterator/
 *  KeysView/Mapping/ValuesView/overload)+ 向量类(List/Tuple)+ 体部通用名
 *  (Any) + 签名引用面(Callable/Dict/Union,createEntity 系列/addWatcher 等
 *  签名用到)一单覆盖。跨行加括号隐式续行(不用行尾反斜杠——PEP8 偏好括号续行,
 *  且反斜杠易被编辑器吞行尾空白),导入置生成物首语句,避免「先使用后导入」。 */
const TYPING_IMPORT_LINES: string[] = [
  'from typing import (Any, Callable, Dict, Generic, Iterable, ItemsView, Iterator, KeysView,',
  '    List, Mapping, Tuple, TypeVar, TypedDict, Union, ValuesView, overload)',
  ''
];

/** 引擎域公共类型别名(用户令 2026-11-09):符号签名引用 Address/Callback/
 *  WatcherValue/Vector3Like,此前只引用不定义,生成的 .pyi 满篇未绑定名
 *  (Pylance/mypy 逐条报 undefined,类型面残缺)。别名统一置向量类之后
 *  (Vector3Like 的 RHS 直接引用 Vector3,靠发射序保定义先于使用,不依赖
 *  桩内前向引用求值);语义对齐引擎:Address 是地址整数值,Callback 是
 *  无返回回调,WatcherValue 是监视器读到的任意值,Vector3Like 接受
 *  Vector3 或同形三元序列。 */
function emitKbeDomainAliases(lines: string[]): void {
  lines.push('');
  lines.push('# KBEngine 引擎域公共类型别名(签名引用面,自洽定义)');
  lines.push('Address = int');
  lines.push('Callback = Callable[..., None]');
  lines.push('WatcherValue = Any');
  lines.push('Vector3Like = Union[Vector3, Tuple[float, float, float], List[float]]');
}

/** 生成只读桩文档:逐符号 class/def + docstring + 引擎 typings 锚点 */
export function buildKbeStubDocument(): KbeStubDocument {
  const lines: string[] = [
    '# KBEngine Python API 内置桩(kode 提供,只读)',
    '#',
    '# 跳转目标为本桩文档;各符号下方标注引擎源码 typings 锚点',
    '# (sourceFile:sourceLine,逐条可回验)。',
    '# KBEntity 为 kode 内置别名(= Entity),对齐项目侧 kbe.KBEntity 基类习惯。',
    `# Coverage: ${KBE_SYMBOL_CATALOG_NOTE}`,
    '',
    ...TYPING_IMPORT_LINES
  ];
  const symbolLines = emitKbeStubBody(lines);
  emitKbeContainerStubClasses(lines, symbolLines);
  emitKbeVectorStubClasses(lines, symbolLines);
  emitKbeDomainAliases(lines);
  appendCatalogFootnote(lines);
  return { content: lines.join('\n'), symbolLines };
}

/** 摘要按固定宽度折行,保持桩文档在常规窗口宽度可读 */
function wrapSummary(summary: string, width = 72): string[] {
  const words = summary.split(' ');
  const wrapped: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + 1 + word.length > width) {
      wrapped.push(current);
      current = word;
      continue;
    }
    current = current ? `${current} ${word}` : word;
  }
  // 不可达(批109 定性):summary 全部来自 KBE_SYMBOLS 字面量且均非空,
  // split(' ') 至少产出一个词,循环结束时 current 恒非空,假臂无触发
  // 路径(唯一调用方 buildKbeStubDocument,无外部入参来源)。
  /* istanbul ignore start */
  if (current) {
    wrapped.push(current);
  }
  /* istanbul ignore stop */
  return wrapped;
}

/** 跳转目标的 URI 字符串(装配侧 vscode.Uri.parse 成 Location) */
export function buildKbeStubUriString(): string {
  return `${KBE_SCHEME}:${KBE_STUB_PATH}`;
}
