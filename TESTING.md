# Kode 测试说明

本项目采用**双层测试架构**,所有断言都必须基于真实行为,严禁为凑覆盖率写假断言。

## 架构划分

| 层 | 框架 | 位置 | 职责 |
|----|------|------|------|
| 纯逻辑层 | vitest | `tests/` | 不依赖 vscode API 的模块:def 解析、元数据、钩子数据、片段、日志解析、Python 补全上下文等 |
| vscode 集成层 | mocha + @vscode/test-electron | `src/test/suite/` | 需要真实 vscode API 的用例:补全/hover/诊断提供者、explorer、扩展激活、require 缓存隔离的集成测试 |

两套用 vitest 的 `include: ['tests/**/*.test.ts']` 与 tsconfig 的 `exclude: ["tests"]` 严格隔离。

## 运行

```bash
pnpm test           # 全量: vitest + 编译 + @vscode/test-electron mocha
pnpm test:unit      # 仅 vitest
pnpm test:coverage  # vitest + v8 覆盖率(输出 coverage/)
```

## 引擎源码条件测试

`tests/helpers/engineRoot.ts` 解析 KBEngine 源码根目录:优先环境变量 `KBENGINE_ROOT`,
否则按同级检出约定 `../kbengine`。存在时,以下"数据 vs 引擎源码"校验用例会真实执行
(本地检出 `/home/cui/workspaces/kbengine` 下全部通过);源码不存在时自动 skip:

- **hooks**:36 个回调名逐条在引擎 `cellapp/entity.cpp`、`baseapp/entity.cpp`、
  `baseapp/proxy.cpp`、`cellapp/witness.cpp` 中以字符串字面量出现;每条
  `sourceLocation` 的 file:line 打开后该行必须正好包含对应回调名(逐行配对验证)。
- **类型**:补全宣称的每个类型名必须在 `DataTypes::initialize` 注册表中有
  `addDataType("...")` 字面量;`ARRAY` 必须有 `<of>` 解析路径;`FIXED_DICT` 必须只经
  `DataTypes::loadTypes`(types.xml 别名)入口;`BOOL`/`TUPLE` 必须在
  `kbe/src/lib/entitydef/` 全目录中不存在带引号字面量。
- **Flags / DetailLevel**:每个名称在 `entitydef.cpp` 中有对应字面量。

> 本地复现 CI 口径:设 `KBENGINE_ROOT=off` 强制 `resolveEngineRoot()` 返回 null
> (本地同级 kbengine 检出会使命令式 fallback 命中,仅"不设环境变量"复现不了 CI)。
> skipIf 的 describe 回调体在注册期仍会执行,各条件 suite 顶部对 null root 有
> 显式 guard,收集阶段不会触碰任何引擎文件路径。

## 当前覆盖率(v8,全 `src/**` 口径,如实统计,不做剔除美化)

vitest 覆盖率(2026-09-24,`pnpm test:coverage`):

| 指标 | 值 |
|------|-----|
| Statements | 70.92% |
| Branches | 62.68% |
| Functions | 78.15% |
| Lines | 70.78% |

纯逻辑层明细:

| 模块 | Lines | Branch |
|------|-------|--------|
| hooks.ts | 100% | 100% |
| kbengineMetadata.ts | 100% | 100% |
| pythonLanguageUtils.ts | 100% | 90.9% |
| workspacePath.ts | 100% | 100% |
| defParser.ts | 91.8% | 84.7% |
| definitionSemantics.ts | 93.1% | 84.7% |
| logParser.ts | 100% | 98.3% |
| kbengineProtocol.ts | 84.5% | 56.2% |
| entityMapping.ts | 89.4% | 79.2% |
| languageProviders.ts | 64.2% | 55.9% |
| monitoringCollector.ts | 38.1% | 32.0% |
| entityDependency.ts | 94.2% | 84.3% |
| databaseSchema.ts | 65.8% | 48.1% |
| logCollector.ts | 68.9% | 41.9% |
| codeGenerator.ts | 51.3% | 48.6% |
| definitionWorkspace.ts | 88.8% | 78.8% |
| serverCommandTarget.ts | 100% | 100% |
| serverManager.ts | 31.5% | 32.4% |
| logWebView.ts | 38.5% | 37.5% |
| monitoringWebView.ts | 50.4% | 51.8% |
| entityDependencyWebView.ts | 39.4% | 33.3% |
| debugConfig.ts | 63.3% | 54.0% |
| explorerProviders.ts | 74.2% | 65.4% |

logParser 的语句与函数已全覆盖(剩余 1.7% 分支为 v8 汇总的边界粒度);
其中锁定了一个实现现状:`getLevelName` 的 switch 无 default 分支,越界
级别值返回 undefined,而 `getLevelIcon`/`getLevelColor` 有 default——
三函数不一致,测试如实记录,是否统一留待后续决策。

kbengineProtocol 的编解码纯函数(帧构造、组件广播包解析、watcher 帧解析)已
全覆盖;两个真实 UDP/TCP socket 客户端已在**本机回环零 mock 集成测试**中
覆盖(tests/kbengineProtocolSocket.test.ts,5 用例):discoverLocalComponents
以真实 dgram 应答端验证——请求帧 msgid=4(MACHINE_MSG_QUERY_ALL_INTERFACES)、
body 为 uid i32LE+username cstring+swapUint16(bindPort) u16LE 且帧内回填
端口与数据报源端口一致、按 parseComponentInfo 29 字段线序伪造的组件包
(baseapp=6/cellapp=5,含 intaddr/intport swap 还原、cpu float、componentID
bigint)解析正确、type:componentID:pid 重复包去重、恶意截断包走 catch →
reject;queryWatcherPath 以真实 net server 验证——未知组件类型直接 [],
请求帧 msgid=WATCHER_QUERY_MSG_IDS[type] 且 body 为路径 cstring、**服务端
分片发送(先 3 字节再延时补齐两帧)客户端流式重组正确**,type 0 值帧
(首字节 type 标记 + path/name cstring + watcherId u16 + valueType u8 +
值,UINT32=3)与 type 1 目录帧(rootPath '/' 归一为 ''+keys cstring 串)
双帧 results≥2 提前结束,连接拒绝 rejects。协议测试里另有引擎条件用例:
COMPONENT_NAMES 逐项对齐 `COMPONENT_TYPE` 枚举(common.h)、广播端口
20086=KBE_PORT_START+86 与 watcher 回调 msgid 65502 的源码字面验证——
并已据此修出真实缺陷:原 COMPONENT_NAMES 缺 TOOL_TYPE=14('tool')。
集成测试另锁定两处引擎语义:type 5/6 的 fullName 为
`componentName+groupOrderID` 多实例编号;watcher 帧 body 首字节为 type
标记。kbengineProtocol 剩余 15.5% 为 parseWatcherFrame 部分值类型分支与
零散防御路径。

entityMapping 的底部纯函数池(方法归属绑定键、八字段身份比对含
propertyPath/sourceChain 归一、Python 文件路径推断组件/接口/实体与方法段、
路径去重、正则转义、行号/列号、`def` 块与 `self.*` 调用提取)已覆盖。
EntityMappingManager 类本体已在真实临时文件树上覆盖(32 用例):构造即
扫描(scripts/entity_defs 三实体入索引,interfaces/components 的 def 不作
根)、python watcher 注册进 context.subscriptions、legacy 映射(pythonFile
取首个 owner 文件,pythonFiles 含实体 base/cell/client 与混入接口、组件
共 5 个 owner 文件,无 owner 文件时回落 scripts/base/<Entity>.py 单元素)、
按实体名/python owner 文件双查、属性按 fullPath 解析与 rootSymbol 回退、
方法解析按 ownerKind/ownerName/section/sourceKind 打分(同名跨 section 时
base 推断选中 BaseMethods、exposed 旗标透传)、resolveDefinitionSymbolAtPosition
按 defFile+line+propertyPath/section 三元定位属性与方法身份(无 path 无
section 或未知 def 为 null)、python 方法位置解析(方法名起始列为
`'    def x'.indexOf(name)`,首行 character 小于起始列不命中、块内后续行
命中)、调用图(outgoing 的 self.* 调用去重并解析到同索引方法、未解析调用
跳过;incoming 带 callLine/callCharacter,无索引为空)、实现解析经绑定直取
(line/character 为真实文件行列)与 legacy 三参入口(无实现实体 null)、
openMethodTarget 双形态(identity → 打开 python 实现,selection 为
line-1/character;字符串 legacy → 无实现时打开 def 文件;编辑器拒开返回
false;不完整 legacy 身份短路 false)、jumpToDef property/method 双分支、
watcher fire 变更重扫 owner 实体、无关路径 no-op、dispose 幂等且查询仍
可用、无 workspaceFolders 时构造/解析/dispose 全安全。stub 相应补了
window.showTextDocument 与可 fire 的 FileSystemWatcher(记录回调,真实
事件行为仍由 mocha 层覆盖)。10.6% 的剩余部分是接口/组件符号的索引回溯
(ensureIndexForOwner 的 findByOwner 分支)、绑定未命中时的 owner 文件
扫描 fallback 与零散防御分支,由 mocha 域与后续批次覆盖。

monitoringCollector 的状态机(暂停/恢复、刷新间隔、启动前后安全的
stop/dispose)、按组件的历史切片、系统总览聚合、watcher 值数值归一
(resolveNumber/resolveBooleanLabel)与 uint64 安全钳制已覆盖;38.1%
的剩余部分是 refresh/refreshNow 等真实发起 machine discovery 与
watcher 查询的 socket 路径(回环集成测试套路已在 kbengineProtocol
批次验证可行,后续批次照搬)。vscodeStub 相应补了
最小 EventEmitter 与 ExtensionContext 占位(真实事件行为仍由 mocha 层覆盖)。

entityDependency 底部四个 XML 解析纯函数(标签体提取、保留名子块提取、
标签剥离、引用三元组去重)已覆盖,并锁定实现语义:非贪婪匹配在首个同名
闭标签截断;保留名包裹块(如 BaseMethods)整体跳过、内层不再展开——
这正是类内"先取 Properties body 再解析子块"两段式调用成立的前提。
EntityDependencyAnalyzer 类本体已在真实临时文件树 + memoryFileSystem 双写
上覆盖(14 用例;注册解析走真实磁盘,workspace.fs.readFile 走 stub 内存):
analyze 两遍扫描(注册实体经 entities.xml 先行入图,含 Cell→Base→Client
类型序;未注册 def 经 findFiles 入图且类型只从方法区块推断)、ARRAY<X>
容器引用(ArrAy 边)与 FIXED_DICT+implementedBy 引用(FixedDict 边)、
Parent 自闭合子标签语法 → 继承边 label '继承' 并计入 referencedBy、
引擎内联 ARRAY<of>X</of> 不产生引用(锁定现状)、同属性重复引用去重、
referencedBy 跨边种类累计、stats(total/base/cell/client、mostReferenced
并列时先入序者胜、maxDepth 实现现状恒为 1——深度只从无 parent 根节点
起算且父链方向不展开)、不可读 def 不产生节点但注册实体间引用边照常解析
(节点未经 parseEntityFile 无 parent,继承边缺席)、getEntityNode/
getChildren/getAncestors 查询与 loadFromEntitiesXml 幂等(types 不翻倍)、
无 workspaceFolders 返回空图。嵌套 Properties 属性因顶层同名闭标截断在
类链路不可达,其递归分支与 mapContainerType default 共 5.8% 未覆盖,
由 mocha 域与后续批次覆盖。

databaseSchema 的虚拟文档 URI/文档识别、schema 文本渲染、表/字段行定位、
mysql 表生成(合成 position/direction 列、ARRAY 子表、FIXED_DICT 平铺
前缀列、VECTOR 展开列、同名去重)与 `scripts/entity_defs` 端到端快照
(真实 def 文件 → 快照 → tbl_Hero/sm_hp/tbl_Hero_bag)已覆盖,并锁定
mysql 列型映射事实(UINT32 → `int unsigned`);34.2% 的剩余部分是
def→属性描述符的深解析(parsePropertyNode 递归等,由端到端用例间接穿透)
与 Provider 生命周期。

logCollector 的状态机(初始未连接、connect 按实现现状拒绝 logger
watcher 协议并落 Error 状态、断开/销毁安全与幂等)、状态事件序列、
环形缓冲截断(maxBufferSize 裁掉最老条目)、按级别/组件过滤、大小写
不敏感与正则检索(非法正则降级为空列表)已覆盖;31.1% 的剩余部分是
sendHeartbeat/sendDeregister 的 socket 写路径与心跳/重连定时器,
不属纯逻辑可测域。

codeGenerator 的纯生成器已覆盖(entities.xml 注册行、def 属性/方法块
含 Exposed/Arg/Default/Persistent/DatabaseLength/DetailLevel/Identifier
各可选的渲染与省略、Python 方法签名与 docstring、def 文档骨架、Python
类名按域取后缀 Cell/Base/原样、onEnterWorld 仅 Cell 实体、Base/Cell
方法段、输出路径解析三态:绝对原样/无关相对原样/scripts/entity_defs
解析到定义根且无目录时回落约定绝对路径、五个内置模板与未知模板回落)。
48.7% 的剩余部分是向导编排(showWizard/QuickPick/写文件/注册 entities.xml),
由 mocha 层覆盖。私有生成方法经实例直调,测真实行为,零 mock。

definitionWorkspace 的纯工作区解析已在真实临时文件树上覆盖(22 用例):
目录布局(entityDefsRoot 候选解析与"目录不存在回落约定路径"、存在性文件
entities.xml/types.xml 无回落保持 null、entityScriptsRoot=定义根父目录、
user_type 根候选序列)、entities.xml 实体注册解析(文档序、按名去重、
has*Declared=属性存在性与 has*=值语义分离)、运行时档案三态(declared/
inferred/disabled:声明值直接生效、未声明由脚本存在推断、显式 false 归
disabled;runtimeRoles 拼接、Client Entity/Server Only 与 Registered on/
Registered, but no runtime role enabled 标签)、types.xml 自定义类型
(aliasType/rawValue 剔除 implementedBy/Properties、属性按名排序、声明行
号、implementedBy→user_type python 实现文件解析)、entity def 文件与
四类别(type/entity/interface/component)条目解析(注册实体与未注册 def
合并、registered 优先后按名排序)。未覆盖部分是依赖 vscode 文档定位的
getWorkspaceRootForDocument 分支与条目结构渲染细节。批18 的
languageProviders 用例经真实文件树引用进一步抬升至 88.8%。

serverCommandTarget 的目标解析已全覆盖(直名/嵌套 component 载荷/非对象/
未知名/非字符串名,100%);serverManager 的纯逻辑面已覆盖:组件常量表
(10 组件严格启动序、name=executable、required 集合、per 组件 cid 与
gus=order 且 bots 例外只带 gus)、ServerStatus 五态、启动前全 stopped、
输出通道按知名组件显隐、二进制探测(真实临时树命中 `../kbengine/kbe/bin/
server` 候选)、kbe 根剥离(KBE_ROOT 环境变量优先/`kbe/bin/server` 后缀
剥根/其余为空)与组件环境构造(KBE_RES_PATH 四段 delimiter 拼接、
KBE_BIN_PATH 补尾分隔符、无根时省略环境变量);31.5% 的剩余部分是真实
spawn/停止/重启编排,不属纯逻辑可测域。logWebView 的过滤与渲染纯逻辑
已覆盖(级别/组件/关键词组合过滤、非法正则退回不过滤、空过滤原样返回、
level 类名与图标、组件颜色映射与灰色回落、escapeHtml 五字符转义、
title 属性按实现现状直插未转义 raw 的不对称事实、HTML 骨架含真实
collector 状态摘要、collector 条目订阅累积);38.5% 的剩余部分是
WebviewPanel 生命周期(show/消息处理/导出),由 mocha 层覆盖。

monitoringWebView 的纯过滤/聚合/渲染已覆盖(21 用例批次之一):指标过滤
(组件类型精确匹配、关键词 trim+小写后横扫 component/类型/地址/状态/
details 的 label:value、空过滤返回内容相同的新数组——实现无条件走
filter())、诊断过滤(severity 精确匹配、经 metrics 反查组件类型剔除
跨类组件、无 component 的诊断不被组件过滤剔除、关键词扫 source/component/
message)、总览六字段归并与零值基线、历史序列(真实 collector 历史 →
ISO 时间戳图表点)、指标卡(CPU >80 error / >50 warning 阈值类、
statusLevel 联动、cellapp 的 Object Pools 明细标题与其余 Watcher Details、
对象池行仅在 size/memory 非零时出现且内存以 B 计、uptime 分钟、detail
值转义)、诊断渲染(severity 类名、source:component 作用域、无 component
裸 source 的 "scope | 时间" 格式)、HTML 骨架注入真实卡片与诊断。
50.4% 的剩余部分是 WebviewPanel 生命周期、定时刷新与导出,由 mocha 层
覆盖。entityDependencyWebView 的 mermaid 图生成已覆盖(节点 emoji 类型
标签与 '-'→'_' id、边箭头含空标签管道段、classDef 三色与按类型分配、
空图仅头部+classDef、HTML 骨架嵌入图源);39.4% 的剩余部分是面板生命周期
与 PNG/SVG 导出路径,由 mocha 层覆盖。

debugConfig 的配置装载与 launch 配置生成已覆盖(18 用例):默认组件表
(7 组件 telnet 端口 31000..51000 的种子顺序、共用 host/密码/layer、
logger 是唯一不带工作区 pathMappings 的组件)、.kbengine/debug.json
装载(stub 内存 fs 真实读写:合法文件按 components 覆盖、未覆盖组件继承
文件顶层默认、坏 JSON 回落默认、无工作区不建 watcher、有工作区注册
FileSystemWatcher)、getComponentConfig 的已知/未知组件与显式覆盖值、
debugpy 调试器类型、launch inputs 重建(清除旧 kbengineProcessId、
保留外来 inputs 且顺序在前)、7 个 attach 配置按种子顺序生成(logger
回落工作区映射)、launch.json 合并(版本保留、用户配置在前 KBEngine
配置在后、inputs 过滤重建)与缺失时标准骨架、示例配置三组件写出。
63.3% 的剩余部分是 startDebugging 的 vscode.debug 会话与 PID 输入框,
由 mocha 层覆盖。vscodeStub 相应补了 Uri.joinPath 与内存 fs
(文件缺失按实现语义抛错进 catch),测试 helper 扩展,非产品行为变更。

explorerProviders 的树构建纯逻辑已在真实临时 workspace 上覆盖(20 用例):
parseDefinitionStructure 的 def 结构解析(顶层属性只滤含 '.' 路径——数组壳
保留,与 toStatsFromProperties 的 '.'+'[]' 双滤不同;三方法段 exposed 旗标
与八字段符号身份 ownerName/section/symbolName/sourceKind='local';Parent/
Interfaces/Components 槽位)、四根组实时计数(description 为 String(count)
、组图标与 contextValue)、描述文案(注册实体经运行时档案拼
'BaseApp / CellApp / Client, Client Entity';全禁用实体 'None, Server Only'
;未注册 def 拿不到档案只剩 'Unregistered';type 'UINT16, Python Missing';
interface/component 按文件名或 'Missing')、视图模型(Hero 汇总:混入接口
属性计入 Properties=2 且 'Mixin · MoveIface' 独立组、方法计数 4、exposed=2
、DB 主表+组件子表=2 而子表按实现现状 0 字段、section 键精确序列;Monster
继承展平:父类链与接口混入各占一个 'Mixed In' 组、Parent · Hero 组名;
无 persistent 属性也无条件建空主表 tbl_Monster 0 字段;!exists 短路为
'Definition file not found' + 空 sections + warning 图标无命令)、类别
标签/图标映射、resolveParentCategory(component 不归并)、describeRuntimeFacet
全部五态、服务器树(10 组件按种子序全 Stopped:circle-large-outline、
无 description、tooltip '状态: stopped' 尾缀;带元素无子;refresh 安全)。
74.2% 的剩余部分是 type 深结构渲染(createTypeStructureItems/
createTypePropertyItem 递归)、方法条目命令构造与 getChildren 的
section→group→leaf 逐层展开,由 mocha 层覆盖。vscodeStub 相应补了
TreeItem/ThemeIcon/TreeItemCollapsibleState/Command(树项子类模块求值
即需要基类)。

languageProviders 的 def 语言特性纯逻辑已在真实临时文件树上覆盖(38 用例,
vscodeStub 新增 CompletionItemKind/CompletionItem/MarkdownString/Hover/
Location/DiagnosticSeverity/Diagnostic/DiagnosticCollection 与 makeTextDocument
最小 TextDocument 工厂,Location 对齐 vscode 真实语义——传 Position 包装为
start=end 的 Range):def 标签补全(顶层 9 标签、属性子标签 9 项、方法段按
Base/Cell=[Arg,Utype,Exposed] 与 Client=[Arg,Utype] 分拆、Interfaces 引用
标签、Volatile 五字段、DetailLevels 三级与其 radius/hyst 子标签、Components/
Parent/Properties 新属性行为空、ARRAY `<` 强制 of、`<Type>` 值补全含 builtin/
custom(detail 'Custom type')/entity(detail 'Entity type')三类且 Class kind、
`<Flags>` 全量无前缀过滤 Enum kind、`<DetailLevel>` Constant kind、方法段
hook 名前缀匹配 Method kind、.py 内 `KBEngine.` reload 函数取短名与
`importlib.` 单 reload)、hover 链(TAG_HOVER_DOCS 标签文档、UINT32/
CELL_PUBLIC/NEAR 元数据条目、hook 名按回调元数据渲染、属性符号标题
'属性区块中的自定义定义' 与 **Type**/**Flags**/**Default** 字段列表、方法
符号 **参数个数**/**Args**/**Exposed**、Type 值内实体引用 'Entity type' +
`**Definition**: \`Monster.def\``、Type 值内自定义类型 **AliasType**、无词
null)、validateDocument 诊断(未知 Flags/未知 DetailLevel Error 含原文值、
归一化拼写 base/CELL_AND_CLIENT 合法零诊断、未注册自定义类型 Error、已注册
但缺 user_type python 文件 Warning 含 `user_type/DOLL.py` 路径而实现文件存在
时零诊断、缺 `<Type>`/`<Flags>` 两条 Error、方法段重复 Warning '方法区块中
存在重复定义' + Information '已定义' 成对、属性段同 Flags 作用域重复成对报
且消息含 '(Base)'/'已在 Base 作用域定义' 而跨作用域重名放行、开关关闭清除
已有诊断、坏 XML 免疫零诊断)、定义跳转(entities.xml 注册名 → Hero.def、
Interfaces 内自闭合 `<MoveIface/>` → interfaces/MoveIface.def、Components
的 Type 值 → components/HealthComp.def、types.xml 自定义类型 → 声明行
Position(line-1, 0)、未知词与 python 文档 null)。64.2% 的剩余部分是
validateDefStructure 结构诊断规则集(缺 DetailLevel/重复声明等)、方法符号
→ Python 实现跳转(entityMappingManager 路径)、数据库 schema 虚拟文档跳转
与各链条防御分支,由 mocha 域与后续批次覆盖。

说明:

- extension.ts 依赖 vscode 激活生命周期,未被任何 vitest 用例 import,
  不进覆盖率报告(报告口径为 vitest 实际加载的 23 个源码文件);其行为由
  mocha/@vscode/test-electron 侧的 110 个用例覆盖,两个 runner 的覆盖率不做
  工具级合并。
- 总体百分比低是因为分母包含全部 23 个源码文件;随纯逻辑测试推进持续抬升,
  每次抬升后更新本表。

## 近期由测试发现并修复的真实缺陷

- `workspacePath.ts` win32 分支在非 Windows 主机上因平台隐式 `path.join` 产出生
  混合分隔符的路径 → 改为显式 `path.win32.join`。
- `snippets/kbengine.json` 的 `ARRAY<x>` 内联写法引擎不解析(FixedArrayType 强制
  `<of>` 子节点)→ snippet 改为引擎真实语法。
- 片段选择列表与补全元数据中的 `BOOL`/`TUPLE` 在引擎类型注册表中不存在 → 全部剔除,
  并由测试锁定不得回归。
