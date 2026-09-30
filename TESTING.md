# Kode 测试说明

本项目采用**两 runner 分层测试架构**(vitest 承载 L1-L3 全量 + mocha 承载编译产物烟测),所有断言都必须基于真实行为,严禁为凑覆盖率写假断言。

## 架构划分

| 层 | 框架 | 位置 | 职责 |
|----|------|------|------|
| 纯逻辑层 | vitest | `tests/` | 不依赖 vscode API 的模块:def 解析、元数据、钩子数据、片段、日志解析、Python 补全上下文等 |
| 仿真器层 | vitest | `tests/sim/` | 本地 KBEngine 仿真基座:MachineSimulator(UDP 发现应答)、WatcherSimulator(组件 watcher TCP 服务)、SimCluster(一键拓扑)、FakeComponentBin(可编程假组件二进制);端口全部动态分配,组件包/watcher 帧复用生产侧编解码器(buildComponentInfo/buildWatcher*FrameBody),见 docs/redesign.md |
| vscode 替身层 | vitest | `tests/fake-vscode/` | 可编程 vscode 替身:core(值类型)/workspaceState(文档集合+可 fire 事件)/windowState(消息/通道/状态栏/树视图登记)/commandRegistry(registerCommand 记账+executeCommand 真分发)/languages(provider 注册记账)/panelRegistry(记录型假 WebviewPanel);tests/helpers/vscodeStub.ts 是它们的兼容 re-export 薄壳,monkey-patch 语义不变 |
| 装配/面板层 | vitest | `tests/extension.test.ts`、`tests/*Panel.test.ts` | fake-vscode 之上整体装配 extension.ts(注册面与 package.json 双向一致、命令真分发、dispose 链)与 WebView 面板生命周期(panelRegistry 驱动) |
| 编译产物烟测 | mocha(纯 Node) | `src/test/suite/` | 验证 tsc 产物与打包形态(main: ./out/extension.js):manifest 贡献点、out/extension.js 经 fake-vscode 编译副本整体激活与 dispose 链、补全/悬停最小应答。不下载 VSCode、不依赖引擎 |

vitest 用 `include: ['tests/**/*.test.ts']` 与主 tsconfig 的 `exclude: ["tests"]` 严格隔离;
`tsconfig.mocha.json` 单独把 tests/fake-vscode + tests/helpers/vscodeStub 编译到
`out/tests/`(test 链中的 `tsc -p tsconfig.mocha.json` 步骤),供 mocha 烟测经
module._load 注入——两个 runner 消费同一份替身实现(P12 的双替身分叉已消除)。

## 运行

```bash
pnpm test           # 全量: vitest + 编译(src + mocha 替身副本)+ mocha 烟测
pnpm test:unit      # 仅 vitest(无引擎、无 VSCode 下载环境即可全绿)
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

vitest 覆盖率(2026-09-27,`pnpm test:coverage`,批54 起 extension.ts 计入分母,
批58 起 defRenamer.ts 计入分母,批62 起全 `src/**` 行/语句/函数三项 100%,
批63 起 defParser.ts 分支 100%,批64 起 definitionWorkspace.ts 与
languageProviders.ts 分支 100%,批65 起 pythonLanguageUtils.ts 分支 100%,
批66 起 monitoringWebView.ts、entityDependency.ts 与 definitionSemantics.ts
分支 100%,批67 起 codeGenerator.ts 分支 100%,批68 起 debugConfig.ts 与
defRenamer.ts 分支 100%,批69 起 databaseSchema.ts 分支 100%,批70 起
logWebView.ts 分支 100%,批71 起 logParser.ts 分支 100%,批72 起
extension.ts、entityMapping.ts、kbengineProtocol.ts、explorerProviders.ts
分支 100%,批73 起 serverManager.ts 分支 100%):

| 指标 | 值 |
|------|-----|
| Statements | 100% (4798/4798) |
| Branches | 100% (2692/2692) |
| Functions | 100% (838/838) |
| Lines | 100% (4689/4689) |

纯逻辑层明细(批62 后全部模块 Lines 100%;Lines 口径含 64 处
`/* istanbul ignore start */` 区间——批62 的 25 处 + 批63 在 defParser.ts
新增 3 处 + 批64 在 definitionWorkspace.ts 新增 9 处、languageProviders.ts
新增 5 处并合并扩展批62 既有区间 1 处 + 批65 在 pythonLanguageUtils.ts
新增 1 处 + 批66 在 entityDependency.ts 新增 3 处、definitionSemantics.ts
新增 1 处 + 批67 在 codeGenerator.ts 新增 2 处 + 批68 在 debugConfig.ts
新增 2 处、defRenamer.ts 新增 1 处 + 批69 在 databaseSchema.ts 新增 3 处 +
批71 在 logParser.ts 新增 1 处 + 批72 在 extension.ts 新增 1 处、
entityMapping.ts 新增 4 处、kbengineProtocol.ts 新增 1 处、
explorerProviders.ts 新增 2 处,
逐处理由见"批62 行覆盖专项""批63
分支覆盖专项""批64 分支覆盖专项""批65 分支覆盖专项""批66 分支覆盖
专项""批67 分支覆盖专项""批68 分支覆盖专项""批69 分支覆盖专项""批70
分支覆盖专项""批71 分支覆盖专项""批72 分支覆盖专项"与"批73 分支覆盖
专项"):

| 模块 | Lines | Branch |
|------|-------|--------|
| hooks.ts | 100% | 100% |
| kbengineMetadata.ts | 100% | 100% |
| pythonLanguageUtils.ts | 100% | 100% |
| workspacePath.ts | 100% | 100% |
| defParser.ts | 100% | 100% |
| defRenamer.ts | 100% | 100% |
| definitionSemantics.ts | 100% | 100% |
| logParser.ts | 100% | 100% |
| kbengineProtocol.ts | 100% | 100% |
| entityMapping.ts | 100% | 100% |
| languageProviders.ts | 100% | 100% |
| monitoringCollector.ts | 100% | 100% |
| entityDependency.ts | 100% | 100% |
| databaseSchema.ts | 100% | 100% |
| logCollector.ts | 100% | 100% |
| codeGenerator.ts | 100% | 100% |
| definitionWorkspace.ts | 100% | 100% |
| serverCommandTarget.ts | 100% | 100% |
| serverManager.ts | 100% | 100% |
| logWebView.ts | 100% | 100% |
| monitoringWebView.ts | 100% | 100% |
| entityDependencyWebView.ts | 100% | 100% |
| debugConfig.ts | 100% | 100% |
| explorerProviders.ts | 100% | 100% |
| extension.ts | 100% | 100% |

logParser 的语句与函数已全覆盖,分支自批71 起 100%(唯一未覆盖臂为
parseBatch 的判空假臂,契约性不可达,见"批71 分支覆盖专项");
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
标记。kbengineProtocol 其余取值类型分支、身份探测回落与 TCP 帧缺口已在
真实回环补齐(tests/kbengineProtocolReaders.test.ts,7 用例,另见下)。

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
window.showTextDocument 与可 fire 的 FileSystemWatcher(记录回调)。批75
核对:原「真实事件行为由 mocha 层覆盖」声明已过期——watcher 事件行为与
原 10.6% 剩余(接口/组件符号的索引回溯、绑定未命中 owner 文件扫描
fallback、零散防御分支)均已由 vitest 收口:entityMappingManager.test.ts
「watcher and lifecycle」(fireChange 重扫 owner/无关路径 no-op/dispose
幂等)、entityMappingFallback.test.ts「walks from an interface symbol back
to the referencing entity index」「regex-scans owner candidate files when
no python binding matches」、entityMappingGaps.test.ts「resolves a
component owner through the referencing entity index」,防御分支见
entityMappingBranches.test.ts(模块 270/270 臂 100%,批72-73 收口)。

monitoringCollector 的状态机(暂停/恢复、刷新间隔、启动前后安全的
stop/dispose)、按组件的历史切片、系统总览聚合、watcher 值数值归一
(resolveNumber/resolveBooleanLabel)与 uint64 安全钳制已覆盖;refresh
全链路已在**本机回环零 mock 集成测试**中覆盖(tests/
monitoringCollectorSocket.test.ts,6 用例,UDP machine 应答端 + 每组件
独立 TCP watcher 服务端):baseapp 全指标聚合(fullName+groupOrderID、
entityCount/connections 取 extradata[1]、load/uptime/messagesPerSecond
取 watcher 值、详情五项、summary 'watcher 数据完整'、诊断 root=N 项
stats=M 项、历史入列、onMetricsUpdate 触发、请求 msgid 41001+路径
''/'stats');cellapp 对象池(Witness/EntityRef 四路查询 msgid 41002、
池内存/大小求和、详情 UID+11 项裁剪为 10、isDestroyed 布尔→'是');
多组件按 fullName localeCompare 排序、logger(10) fullName 不追加序号、
速率取 secsNumlogs、msgid 41008;watcher 端口拒连 → '仅 machine 可见,
watcher 无返回' warning 级 + summary 追加 PARTIAL_DATA_WARNING + 详情
只剩 UID;discovery 空结果 → 指标清空 + machine 源 error 诊断;恶意
广播包 → collector 源 error 诊断且 status 与诊断消息一致。批52 起
machine/watcher 对端统一由 tests/sim 仿真器提供(MachineSimulator/
WatcherSimulator/SimCluster,端口全部动态分配、组件包与 watcher 帧
复用生产侧 buildComponentInfo/buildWatcher*FrameBody 编码器),
vitest 恢复文件级并行(全量 36s→约 13s),不再依赖固定端口 20086。
原 7.7% 剩余(startTimer 的定时器驱动的 refresh 循环与零散防御分支)批75
核对已由 vitest 收口:monitoringCollectorGaps.test.ts「starts a repeating
timer that survives several ticks」(start(40) 真间隔连跑多轮)、
monitoringCollectorBranches.test.ts「start 在暂停态只记间隔,不起定时器也
不刷新」「collapses concurrent refresh calls with an in-flight guard」;
事件行为经真实订阅覆盖(monitoringCollectorSocket.test.ts 的
onMetricsUpdate 订阅断言、monitoringPanel.test.ts collector 推送实时进
html)。原「定时器/真实事件行为由 mocha 域覆盖」声明已过期(批56 后
mocha 层仅余编译产物烟测)。vscodeStub 相应补了最小 EventEmitter
与 ExtensionContext 占位。

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
类链路不可达:该递归臂的行与分支条目已于批62 判不可达并包进 ignore 区间
(理由与"内层字段引用永远走不到"的成因见批62 注),其契约行为另由私有
接缝的真实用例锁定;文件剩余未覆盖项只在分支口径(94.1%),行覆盖 100%。

databaseSchema 的虚拟文档 URI/文档识别、schema 文本渲染、表/字段行定位、
mysql 表生成(合成 position/direction 列、ARRAY 子表、FIXED_DICT 平铺
前缀列、VECTOR 展开列、同名去重)与 `scripts/entity_defs` 端到端快照
(真实 def 文件 → 快照 → tbl_Hero/sm_hp/tbl_Hero_bag)已覆盖,并锁定
mysql 列型映射事实(UINT32 → `int unsigned`)。深解析与 Provider 已在
tests/databaseSchemaDeep.test.ts 覆盖(17 用例):真实临时 def 树上的
Parent 子元素继承与自引用短路、Interfaces 同名属性 merge 补齐
(Identifier/Index/DatabaseLength)、Components 节组件(含 Type 缺失/
def 文件缺失仍建空组件表、同 Type 二次走 componentCache)、
FIXED_DICT 嵌套平铺与 ARRAY-of-FIXED_DICT 子表(表名取数组属性名)、
CELL_AND_CLIENT 旗标归一、无 Flags 属性剔除、无元素 root 返回 null;
以及 Provider 生命周期(decode 实体名渲染、refresh 两分支)、渲染文本
字段定位向上回溯、source 定位三态、target 反查(路径归一/前缀规则/
dedupe)。剩余 4.8% 为类型别名映射长尾与零散防御分支。

logCollector 的状态机(初始未连接、connect 按实现现状拒绝 logger
watcher 协议并落 Error 状态、断开/销毁安全与幂等)、状态事件序列、
环形缓冲截断(maxBufferSize 裁掉最老条目)、按级别/组件过滤、大小写
不敏感与正则检索(非法正则降级为空列表)已覆盖。socket 辅助路径已在
tests/logCollectorSocket.test.ts 覆盖(14 用例):deregister 703 帧
4 字节与 heartbeat 701 帧字 14 字节布局逐字节断言(fake socket 记录
write)、心跳 setInterval 每秒一发且 stopHeartbeat/re-start 不叠定时器
(vitest fake timers)、重连调度三短路(autoReconnect 关/手动断开/
已在排程)与到点重试 connect 拒绝后复位、UID 探测链(getuid → env
uid → env UID → -1)、Connected/Connecting 状态文本(全角标点逐字
断言)、dispose 拆除 socket 与双定时器且重复安全。logCollector 达
100% 全覆盖。

codeGenerator 的纯生成器已覆盖(entities.xml 注册行、def 属性/方法块
含 Exposed/Arg/Default/Persistent/DatabaseLength/DetailLevel/Identifier
各可选的渲染与省略、Python 方法签名与 docstring、def 文档骨架、Python
类名按域取后缀 Cell/Base/原样、onEnterWorld 仅 Cell 实体、Base/Cell
方法段、输出路径解析三态:绝对原样/无关相对原样/scripts/entity_defs
解析到定义根且无目录时回落约定绝对路径、五个内置模板与未知模板回落)。
文件落盘与命令编排层已在**真实临时工作区树上覆盖**(tests/
codeGeneratorFiles.test.ts,21 用例):generateDefFile/generatePythonFile
落盘路径与内容全量比对(内嵌生成时间戳归一化后比较)、无工作区拒绝;
registerInEntitiesXml 在 </root> 前精确插行、重复注册走 warning 且文件
原样、坏 XML(无闭 root)/entities.xml 缺失(报具体路径)/无工作区三类
拒绝;showWizard 全流程(可脚本化窗口 stub:showInputBox 记录 options、
showQuickPick 接受数组或 Promise——向导第 3 步传入异步实体列表)——
名称校验正则、类型取消/名称取消提前返回、Base+Cell 全流程生成 def
(Parent 块+示例属性+BaseMethods)+python(HeroCell 后缀+onEnterWorld)
+注册 entities.xml+四条 info 消息、生成失败走 error 通道(register 前
def/py 已成功各推一条 info);showTemplates 模板取消/名称取消提前返回、
account 模板改名生成全链路(login/createAvatar 带 Exposed、MyAccountBase
后缀、注册行三域旗标);loadConfig 无工作区回落默认值、有工作区解析到
定义根绝对路径;getExistingEntities 从 def 文件集取 basename、无工作区
空表;dispose 无副作用。原 7.6% 剩余(向导的零散分支组合)批75 核对已由
vitest 收口:codeGeneratorGaps.test.ts「showWizard sample property branches」
(Cell/Client-only 示例属性分支)、「creates missing output directories
recursively」「reports 生成失败 when the workspace is gone」与
codeGeneratorBranches.test.ts 的 showWizard/showTemplates 编排用例——原
「由 mocha 层补充覆盖」声明已过期。私有生成方法经实例直调,测真实行为,
零 mock。

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
合并、registered 优先后按名排序)。分支自批64 起 100%(不可达空值臂家族与
sort 比较方向臂已定性入 ignore,可达的哨兵/兜底臂补真实用例,逐臂判定见
"批64 分支覆盖专项"),行覆盖自批62 起 100%——
mapDefinitionFiles 的"非普通文件"条目由真实符号链接用例覆盖,两处根缺失
守卫判不可达入 ignore。批18 的 languageProviders 用例经真实文件树引用
进一步抬升,该文件行覆盖同样自批62 起 100%。

serverCommandTarget 的目标解析已全覆盖(直名/嵌套 component 载荷/非对象/
未知名/非字符串名,100%);serverManager 的纯逻辑面已覆盖:组件常量表
(10 组件严格启动序、name=executable、required 集合、per 组件 cid 与
gus=order 且 bots 例外只带 gus)、ServerStatus 五态、启动前全 stopped、
输出通道按知名组件显隐、二进制探测(真实临时树命中 `../kbengine/kbe/bin/
server` 候选)、kbe 根剥离(KBE_ROOT 环境变量优先/`kbe/bin/server` 后缀
剥根/其余为空)与组件环境构造(KBE_RES_PATH 四段 delimiter 拼接、
KBE_BIN_PATH 补尾分隔符、无根时省略环境变量)。批24 又把真实 spawn/
停止/重启编排搬进**真实子进程集成测试**(tests/serverManagerProcesses
.test.ts,18 用例,零 mock):启动前检查链五连(已在
运行 warning、可执行文件缺失、配置目录空/不存在/是文件各报具体路径)、
真实进程启动后 Starting 宽限期 1 秒转 Running(事件计数、PID、info 提示、
stdout 日志含 cwd 与 KBE_BIN_PATH 注入值)、stderr 进 [ERROR] 通道、
秒退进程走 exit 处理器(code=3 透传且不触发"启动成功")、chmod 000 的
EACCES 走 error 事件清条目、stopComponent 对未运行组件 false、SIGTERM
正常停止(进程真死以 kill(pid,0) 验证)、**忽略 SIGTERM 的进程 5 秒后
升级 SIGKILL**、startAutoComponents 按配置启动、stopAll 全停、
restartComponent 对未知名 false/空闲组件直启/运行中组件换新 PID、
dispose 清通道杀残进程。测试基建两处关键:stopXxx 的消息记录 stub 必须
直接 push(首批误写成返回函数的函数,调用后什么都没记);批53 起子进程
统一由 tests/sim/fakeComponentBin 生成(node 脚本假二进制,跨平台),
ignore-sigterm 行为先装 SIGTERM 处理器再打标记,结构性消除批24 的
"信号抢在 bash trap 安装前送达"竞态。批53 同时给 serverManager 加了
ProcessRunner 注入点(默认透传 spawn),tests/serverManagerRunner
.test.ts 专项验证参数透传与同步 throw 走 catch,spawn 同步 throw 的
catch 分支由此可达。
94.9% 的剩余为无 workspaceFolder 的探测分支与单组件时的排序比较器。logWebView 的过滤与渲染纯逻辑
已覆盖(级别/组件/关键词组合过滤、非法正则退回不过滤、空过滤原样返回、
level 类名与图标、组件颜色映射与灰色回落、escapeHtml 五字符转义、
title 属性按实现现状直插未转义 raw 的不对称事实、HTML 骨架含真实
collector 状态摘要、collector 条目订阅累积)。批25 把 WebviewPanel 生命
周期也搬进 vitest(tests/logWebViewPanel.test.ts,16 用例,monkey-patch
面板工厂+保存对话框+可控假 collector):show 的面板创建参数
(viewType/title/ViewColumn.Two/enableScripts)与初始渲染、**panel 是
实例私有状态——同一实例二次 show 走 reveal、不同实例各自建面板**(首批
用例误跨实例断言 reveal);onDidDispose 置空后同实例重建新面板;面板
打开期间 collector 新日志实时进 html;六类消息全走捕获的
onDidReceiveMessage handler——filter 整体替换 filter 对象、search 改写
keyword/useRegex 叠加过滤、clear 清空+通知 collector+空状态重渲染、
disconnect 直通、connect 成功静默/失败报"日志连接不可用: <原因>";
exportLogs 经 showSaveDialog:txt 走 LogParser.formatLogEntry 逐行拼接、
.json 走 pretty JSON(toISOString 归一后深比对)、**只导出当前过滤子
集**、对话框取消不落盘无消息、writeFile 抛错报"导出日志失败"。stub 新增
ViewColumn 枚举(模块命名空间 frozen,常量必须由 stub 导出);导出内容
经 stub 内存文件系统(memoryFileSystem.files)断言。95.2% 的剩余为
updateWebView 的 panel 空守卫与零散分支。

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
原 50.4% 的剩余部分(WebviewPanel 生命周期、定时刷新与导出)已由 vitest
覆盖。批27 把 monitoringWebView 的面板生命周期搬进 vitest
(tests/monitoringPanel.test.ts,17 用例,注入可控假 collector):show 的
面板参数与 collector.start(默认 2000ms)联动、同实例二次 show 走
reveal、onDidDispose 停采集并重建时重新 start、面板打开期间 collector
推送实时进 html;六类消息——refresh 触发 refreshNow、setFilters 字符串
过滤重渲染且非字符串强制回落空串、setRefreshInterval/setHistoryWindow
正数才生效(0/负数/非数字不动且不转发 collector)、togglePause 未暂停
pause+重渲染/暂停中 resume;exportMetrics 落盘 pretty JSON
(overview/filters/metrics/diagnostics/history 五键,filters 与当前过滤
状态一致)、取消不落盘、writeFile 抛错报"导出监控数据失败"。实现现状
如实记录:dispose 仅对 panel 有守卫,collector.dispose 在守卫外无条件
调用,重复 dispose 会重复转发。假 collector 须补 getMetricsHistory
(getHtml→buildHistorySeries 链路调用,漏配则 updateWebView 全体炸)。
96.2% 的剩余为 updateWebView 空守卫与零散分支。entityDependencyWebView
的 mermaid 图生成已覆盖(节点 emoji 类型
标签与 '-'→'_' id、边箭头含空标签管道段、classDef 三色与按类型分配、
空图仅头部+classDef、HTML 骨架嵌入图源)。批26 把面板生命周期与导出路径
也搬进 vitest(tests/entityDependencyPanel.test.ts,18 用例):show 的
面板参数与初始分析→mermaid→html 链路(含统计卡片渲染)、同实例二次
show 走 reveal、onDidDispose 后同实例重建、analyze 抛错进 error 通道与
outputChannel 双路(html 保持空串);消息域——refresh 重析重渲染、
openEntity 对已知实体 openTextDocument/showTextDocument 串起 defFile、
未知实体 warning、文档打开抛错报"打开实体定义失败"、export 经保存对话
框握手 beginExport postMessage、取消静默、currentGraph 为 null 时
warning;导出落盘——svg 走 utf8、png 走 base64 解码、无 pendingExport
的 exportData 静默忽略、data null 与 format 不匹配各报"导出 X 失败"、
writeFile 抛错报"写入导出文件失败";dispose 幂等。批28 再把 debugConfig
的调试会话编排搬进 vitest(tests/debugConfigAttach.test.ts,9 用例,stub
新增 debug.startDebugging):startDebugging 的 modal 提示两分支——有
telnetEnableCommands 时消息含 telnet 命令/password/layer/命令行全文,
确认('继续附加')后进 attach,取消不发;attachToComponent 组装
DebugConfiguration(name/request=attach/processId/pathMappings 透传组件
配置/justMyCode=false)→ startDebugging 结果透传,false 与抛错
('附加调试失败')各走一路;promptForProcessId 校验链——负号先被
/^\d+$/ 拦进"PID 必须是正整数"(格式错误优先于数值错误),'0' 与超
MAX_SAFE_INTEGER 归"PID 必须是有效的正整数",取消 PID 则整个 attach
不发;createExampleConfig/updateLaunchJson 的写盘失败各报具体原因。
91.7% 的剩余为 watcher 回调与零散防御分支。analyzer 在构造内
自建,测试经 internals 替换为假例(analyze/getEntityNode 可控)。
97.9% 的剩余为 refreshGraph 的 panel 空守卫与 mermaid 的未知类型分支。

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
原 63.3% 的剩余部分(startDebugging 的 vscode.debug 会话与 PID 输入框)
批75 核对已由 vitest 收口:debugConfigAttach.test.ts「DebugConfigManager
.startDebugging」(modal 简报两分支/telnet 命令清单/startDebugging false
传播与失败进 error 通道)与「DebugConfigManager.promptForProcessId」(非
数字与超安全整数拒绝、取消中止、合法 pid attach)——原「由 mocha 层覆盖」
声明已过期。vscodeStub 相应补了 Uri.joinPath 与内存 fs
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
原 74.2% 的剩余部分(type 深结构渲染 createTypeStructureItems/
createTypePropertyItem 递归、方法条目命令构造与 getChildren 的
section→group→leaf 逐层展开)批75 核对已由 vitest 收口:explorerTreeDeep
.test.ts「expands type definitions with alias, properties and python
sections」「expands grouped sections via DefinitionGroupItem and ungrouped
sections directly」(叶命令断言 kbengine.database.open)、
explorerProvidersBranches.test.ts 的方法命令/别名回落/身份组装各用例——
原「由 mocha 层覆盖」声明已过期。vscodeStub 相应补了
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
Position(line-1, 0)、未知词与 python 文档 null)。原 64.2% 的剩余部分
批75 核对已由 vitest 收口:validateDefStructure 结构诊断规则集(缺
DetailLevel/重复声明等;经 validateDocument 诊断用例驱动,实现于
src/languageProviders.ts 由 validateDocument 调用)、方法符号 → Python
实现跳转(entityMappingManager 路径;languageProvidersInternals.test.ts
「def method implementation jumps」之「jumps to the python implementation
when the identity resolves」)、数据库 schema 虚拟文档跳转
(languageProvidersInternals.test.ts「database schema cross jumps」正反向
各用例)与各链条防御分支(languageProvidersBranches.test.ts 跳转 null/
jump 各臂)——原「由 mocha 域与后续批次覆盖」声明已过期。

explorerProviders 的树形下钻与缺口分支已在真实临时 workspace 上覆盖(16 用例,
vscodeStub 补 workspaceFolders 桩——getWorkspaceRootForDocument 无参时回落
workspaceFolders[0],即可驱动 getChildren 全链):五层 instanceof 下钻(根四组
Types/Entities/Interfaces/Components 实时计数、Entities 组→def 条目、定义→
summary+八视图段精确序列、summary→汇总叶、exposed/database 组走
DefinitionGroupItem 而方法段直出 items、叶与未知元素空数组收口)、type 深分支
(WIDGET 无 Properties 子节点则 properties 段缺席;BAGSPEC 的 typeProperties
来自类型节点直接子级 Properties,五引用解析 description 精确串 'UINT32 ·
Built-in'/'BAGSPEC · Type'/'HealthComp · Component'/'Hero · Entity'/
'NoSuchType123 · Unresolved';python 段取 scripts/user_type/ 下 implementedBy
模块路径点转斜杠文件)、internals 缺口分支(readDefinitionStats 把入参当
workspaceRoot 用——name 取 basename(root)、category 按 /interfaces//components/
路径特征判定,坏文件回落六键空 shape;resolveTypeReference 五分支;
createTypeStructureItems(undefined)→[];描述文案 'UINT16, implementedBy:
game.widget, Python Missing' 与实体 'Base, Cell, Unregistered')、
pickServerComponent(SERVER_COMPONENTS 全量经 monkey-patch 捕获,
placeHolder 直通)与 ServerControlProvider(假 manager 注入,Running/Starting/
Stopping/Error 四状态描述 'PID: 4321'/'启动中...'/'停止中...'/'错误',
getTreeItem 透传、带元素无子)。原 96.7% 剩余的树控件装配(extension.ts
两处 registerTreeDataProvider)批75 核对已由 vitest extension.test.ts
覆盖(treeRegistrations 与 manifest 声明视图双向核对),并与 mocha 激活
烟测「registers the tree views declared by the manifest」双口径一致——
原「树控件装配与 mocha 域」声明已过期。
CellMethods 全 exposed 时整段缺席(批17 已知现状),夹具以非 exposed move 保住该段。

kbengineProtocol 的剩余分支已在真实回环上补齐(tests/
kbengineProtocolReaders.test.ts,7 用例):parseWatcherFrame 全取值类型
矩阵(UINT16/UINT32/UINT64 含 9007199254740993n→MAX_SAFE_INTEGER 钳制/
INT8/INT16/INT32/INT64/FLOAT/CHAR/COMPONENT_TYPE,BufferCursor 各宽度
读取器经此触达);discoverLocalComponents 的身份探测回落链(patch
process.getuid=undefined + env 三组对照——uid 优先于 UID、用户名
USER→LOGNAME→'unknown'、不可解析 uid 得 -1,均以动态端口的
MachineSimulator 捕获原始请求帧逐字节断言(不信仿真器解码),端口
字段回填客户端源端口的 swapUint16);queryWatcherPath 三缺口——帧头
声明 1000 字节只到帧头时
while 在长度不足处 break 等超时收尾 resolve [](残包不进解析器)、
非 65502 msgid 帧静默跳过其余帧照常入列、对端在 connect→resetTimeout
之后 resetAndDestroy 发真 RST(Node 的 destroy 会先读空内核缓冲只送
FIN,不会触发 error)走 error→clearTimeout→reject。剩余 4.5% 为
dgram/UDP error 处理与 finish 重入守卫等不可稳定触发的防御路径。

entityMapping 的实现解析回落链已在真实临时 workspace 上覆盖
(tests/entityMappingFallback.test.ts,6 用例):resolveMethodImplementationByIdentity
的 ensureIndexForOwner 三层——实体名直查未中时按 pythonOwnerFiles 的
ownerKind+ownerName 回溯引用实体索引(接口符号 MoveIface → Hero 索引
绑定直查命中 MoveIface.py 第 2 行第 8 列)、回溯也未中时重扫
scanEntityMappings 后仍空返回 undefined;绑定直查失败的正则回退
findPythonMethodLine——扫描时脚本全缺席的 Ghost 在落盘第二前缀
assets/scripts/base/Ghost.py 后按候选序先 existsSync 拒掉缺失的
scripts/ 侧、再对 assets/ 侧 `def <名>(` 正则命中(第 2 行第 8 列),
文件存在但无该 def 时未命中返回 null;openMethodTarget 遗留路径三分支
——实体无索引 false、实现与定义双缺 false、仅 def 有定义时打开
Ghost.def 的 <vanish/> 行(0 基行 3 列 0,selection Range 断言)。
剩余 4.9% 为 getPythonCandidates 的 componentSlotName 尾分支(当前
DefinitionSemanticCategory 类型联合下不可达)与读文件异常防御。

debugConfig 的配置 watcher 生命周期已覆盖(tests/debugConfigWatcher.test.ts,
4 用例):createFileSystemWatcher 以记录型假例替换(on* 注册进闭包数组 +
fire 方法驱动),真实走 stub 内存 fs 的 `.kbengine/debug.json`——挂载后
pattern 含目标路径、初始读到默认配置;writeFile 落盘 + fireChange →
重载生效(defaultTelnetPort 0→12345)且提示"KBEngine 调试配置已更新";
fireCreate 报"已创建";fs.delete + fireDelete 报"已删除,已恢复默认配置"
且端口回落 0;dispose 恰好拆除 watcher 一次。

definitionWorkspace 的守卫与枚举缺口已覆盖(tests/
definitionWorkspaceGaps.test.ts,13 用例):document 目标在无工作区时的
八入口归一 null 守卫(findCustomTypeInfo/findCustomTypeDeclarationInfo/
findCustomTypePythonImplementationFile/findEntityDefinitionFile/
findEntityDefinitionsRoot/findEntitiesXmlFile/getEntityRuntimeProfile/
findDefinitionEntryByCategory);坏 XML 短路(entities.xml 有文本无元素→
getRegisteredEntities []、types.xml 同态→快照 null、types.xml 整树缺失→
findCustomTypeDeclarationInfo 与 category='type' 查找 null、无元素 types.xml
→ getRegisteredCustomTypes 空)、未闭合元素使 parseDefDocument throw→
parseXmlDocument catch 归一 null;路径分支——win32 风格根 'C:\ws' 走
path.join(entityDefsRoot 含反斜杠)、配置 entityDefsPath 为绝对路径时
resolveWorkspacePath 直返(fixture 根下真实存在的绝对目录,从候选中胜出);
FIXED_DICT 结构渲染——types.xml 值内嵌 `<meta/>` 自闭合与 `<of>UINT8</of>`
嵌套元素,renderStructureNode/getInnerXml 递归产出原样子串;
readTextFile 逐候选 catch-continue 后耗尽返回 null(patch fs.readFileSync
全 throw);listDefinitionFiles 的 readdirSync 降级链(patch 机制:fs 模块
命名空间不可重定义,经 vi.hoisted + vi.mock getter 注入)——属性缺失→
磁盘枚举无贡献只剩注册实体、带 withFileTypes throw 降级读字符串目录项
(只收 .def 后缀)、全部尝试 throw 后放弃(注册实体仍并入且 exists 按真实
磁盘判定)、dirent 列表跳过无名条目与子目录。98.9% 的剩余为 entityDefsRoot
null 守卫与 findExistingLookupPath 非字符串分支(当前调用图下不可达)及
v8 语句映射粒度。

defParser 的遍历工具与文本定位缺口已覆盖(tests/defParserGaps.test.ts,
14 用例):getDirectTextNodes/getElementText 的空参守卫与文本子节点收集
(含 CDATA 与相邻文本拼接 'xy'、text 节点 parent 回指);findAncestorElement
的 null 守卫、从文本节点经 parent 链上溯(字符串名与数组名两形态)与
链耗尽 null;assignTextNodePosition 的两个回退分支经真实 parseDefDocument
触达——`&quot;` 解码为 `"` 后解码产物在原文中不存在,indexOf 落空回退
searchOffset(开标结束处,start=end=9)、`<![CDATA[]]>` 产空文本节点
保留在 searchOffset;批63 另补 getScalarChildValue 的空白标量回落与顶层
非元素节点下 findFirstElement 的跳节点/null 两臂。该文件历史遗留的
"非对象项 continue""':@' 键 continue"两条行缺口:前者已于批62 判 vendor
fxp 不可达并包进 ignore 区间,后者由带属性元素的解析真实走到;行/语句/
函数自批62 起 100%,分支自批63 起 100%(逐臂判定见"批63 分支覆盖专项")。

codeGenerator 的剩余缺口已覆盖(tests/codeGeneratorGaps.test.ts,7 用例):
generateDefContent 的 CellMethods/ClientMethods 段渲染(exposed 标记只在
base/cell 侧,client 侧 supportsExposed=false 无 `<Exposed/>`,Arg 行直出
类型);generatePythonFile 的无工作区 throw('没有打开的工作区')与深输出
目录递归创建(gen/out/deep 落盘断言);showWizard 的 Cell-only 分支
(sampleFlags CELL_PRIVATE + cellProperties/cellMethods 赋值 + entities.xml
注册)与 Client-only 分支(OTHER_CLIENTS;实现现状只赋 clientProperties
不赋 clientMethods,ClientMethods 段缺席,如实断言);生成后 '是否打开
生成的文件？' 应答 '是' 时 openTextDocument+showTextDocument 打开 def 文件;
generateFromTemplate 在工作区消失时经 generateDefFile throw 走 catch 报
'生成失败: … 没有打开的工作区'。语句 100%、函数 100%,剩余 4.9% 分支为
配置回退与属性渲染的粒度组合。

definitionSemantics 的解析与继承合并缺口已覆盖(tests/
definitionSemanticsGaps.test.ts,7 用例):Interfaces 三种引用形态——
`<Interface/>` 自闭合无名跳过、`<Interface><Monster/></Interface>` 取首子
元素名(getNodeValue 的子元素回退)、`<MoveIface/>` 直取标签名;
parseOptionalBoolean 未知拼写('maybe')→ undefined;ARRAY of 的 `<Type>`
元素内嵌 `<Properties>` 递归解析(元素子属性 fullPath 为 `bag[].x`);
坏 XML(未闭合元素)使 parseLocalDefinition throw 后 negative 结果缓存,
二次调用直接命中缓存;接口与父链的组件槽去重——IA/IB 两接口同名 slot
"pack" 只保留一个、SlotP3→SlotP2→SlotP1 父链同槽合并;纯继承链
TopE→MidE→BaseE 上 BaseE 组零属性时来源链从方法段回溯,继承组标签
'Parent · MidE / BaseE'。99.5% 的剩余一行(buildInheritanceLabel 的空
chain 分支)在当前调用图下不可达——所有 interface/parent 来源的 chain
都至少含引用名或父名。

monitoringCollector 的剩余分支已在真实回环上补齐(tests/
monitoringCollectorGaps.test.ts,5 用例):dbmgr(type 1)经 msgid 41006
采集写/删/查实体数与建账号数详情;watcher 端口不可达且 uid=0 时 UID 行
仍以 '0' 入列——details.length===0 的 'Watcher · 无返回' 占位分支在当前
取值域下不可达(如实记录);start(40) 定时器多轮 tick 不抛错且 stop/
dispose 干净;refresh 的 in-flight 重入守卫并发折叠;向内部历史 Map 预置
301 条假历史后一次成功采集触发 300 环形截断(getMetricsHistory 默认只回
最近 60 条,须直读内部 Map 验证)。98.9% 的剩余为 case 5 break 的 v8
语句映射粒度与上述死分支。
(批61 更新:占位分支改由 discovery 接缝以无 uid 组件锁定两臂文案与短路
顺序,已计入覆盖;"machine 发现链上 uid 恒为 number、该分支链路不可达"
的结论不变,详见批61 注。)

entityDependency 的剩余分支已补齐(tests/entityDependencyGaps.test.ts,
8 用例):注册口径只有 Base 的实体从 def 的 CellMethods/ClientMethods
方法区块补齐 Cell/Client 类型;entities.xml 注册但 def 文件缺失的实体
被跳过不入图;悬空 parent(父名无节点)的祖先遍历走 else break 返回空;
FIXED_DICT<X> 容器形态产出 fixed_dict 引用,未知容器(TUPLE<X>)经
mapContainerType default 回落 null 丢弃;无工作区直接调 loadFromEntitiesXml
提前返回;解析阶段 readFile 抛错被 catch——节点保留、引用为空。两条死
分支如实记录:calculateMaxDepth 的向上递归(L330,调用条件 !node.parent
与递归条件 node.parent 矛盾,恒不可达,maxDepth 恒为 1);属性内嵌
<Properties> 的递归展开(L465-471,嵌套 Properties 使顶层 section 提取
在首个同名闭标截断、属性整块丢失,内层闭合块反被当成顶层属性,故属性
body 永不含 Properties section,递归入口结构上不可达)。97.4% 的剩余
即这两处。

serverManager 的配置解析与环境装配已补齐(tests/serverManagerGaps.test.ts,
11 用例):binPath 空配置走 detectBinPath 候选探测(真实建第一候选目录
命中)与全候选落空返回空串;${env:} 变量替换;无工作区早退;KBE_ROOT
环境变量优先、kbe/bin/server 后缀推导与其他形态拒绝;buildComponentEnvironment
装配 KBE_ROOT/KBE_RES_PATH 四段 delimiter 串与 KBE_BIN_PATH 尾分隔符,
空 binPath 走 ensureTrailingSeparator 空串早退;startAutoComponents 乱序
声明按 order 升序编排;getAllServers 暴露组件目录;showComponentLogs 的
无效名 false 与有效名开通道 true。spawn 同步 throw 的启动失败 catch 经
模块级 getter 工厂(批34 套路)以抛错假例驱动——参数校验后同步 throw
在真实取值域下几乎不可抛,L326 的 defaultArgs join 又先于 try 执行,
getter-args 方案到不了 spawn(如实记录)。语句与函数 100%,分支剩余为
探测候选的短路组合。

logWebView 的面板状态守卫已补齐(tests/logWebViewGaps.test.ts,3 用例):
updateWebView 在无面板时早退且不触发面板创建;show 建面板后 dispose
释放面板对象并置空实例引用,二次 dispose 幂等;二次 show 走 reveal 不
重建面板。logWebView.ts 语句与函数 100%。

databaseSchema 的守卫与合并缺口已补齐(tests/databaseSchemaGaps.test.ts,
12 用例):实体 def 是目录(find 命中但 readFileSync 抛 EISDIR)时快照
返回 null;父链 def 缺失/无 root/不可读三种形态均回落空属性、实体自身
照常成表;scope 全被可用性拒绝(hasCell=false 的 CELL_PUBLIC)与缺 Type
的属性被丢弃;父链同名属性 identifier 提升;CELL_AND_CLIENTS/
CELL_AND_OTHER_CLIENTS 归一为 ALL_CLIENTS/OTHER_CLIENTS 后获得有效
scope;FIXED_DICT 同名子属性同列去重,无 Type 与 Persistent false 的
子属性在 children 层跳过;组件 def 缺失(ghost)、目录(CompC)、无
root 内容(CompD)均落空组件表,无 Cell/Client 方法段的组件走方法段
continue,带 ClientMethods 的注册 client scope。两条死分支如实记录:
snapshot 入口的 entityDefsRoot null 守卫(L174,layout 恒回落
preferredEntityDefsRoot 非空首选候选);getPropertyScopes 的 switch
default(L913,RuntimeScope 联合仅 base/cell/client)。99.4% 的剩余即
这两处。

entityMapping 的索引与解析缺口已补齐(tests/entityMappingGaps.test.ts,
8 用例):组件槽 rebased 属性覆盖 children 递归(FIXED_DICT 实体侧与
组件 rebase 侧)与 ARRAY 元素,未解析组件槽(MissingComp)整槽跳过;
同名实体属性与组件槽让 rebased 路径重复,propertyDefinitions 收两条
而 toLegacyMapping 只保留先到的实体侧定义;def 方法无 python 绑定时
回退正则查找;索引建好后删文件(存在性检查先返)与换成目录(读取
EISDIR 被 catch 吞)均容错返 null;python owner 文件是目录时整体解析
失败被 parseDefFile 捕获(vitest v5 默认 clearMocks 会在用例间清空
mock.calls,错误记录用自持数组承载);调用图里未定义被调的入边被丢
弃;组件符号经引用实体索引回溯解析(findByOwner)。四条死分支如实
记录:scanEntityMappings/buildIndex 的 loader 守卫(L128/L167,调用
处路径恒非空)、push 的 null 早退(L205,调用恒传对象)、
getPythonCandidates/score 的 componentSlotName 分支(L324-330/L889,
批33 类型级锁定,selectMethodDefinition 调用均不传槽名)、
collectPythonMethods 的存在性早退(L449,收集层候选恒已过存在性
检查)。97.9% 的剩余即这几处。

kbengineProtocol 的 socket 失败路径已补齐(tests/
kbengineProtocolGaps.test.ts,5 用例),语句/函数/行 100%:
discoverLocalComponents 的 UDP socket error 事件拒绝、绑定回调报告
string 地址的绑定失败形态;queryWatcherPath 的 TCP socket error 拒绝
与"完成后再来的迟到帧重置计时器让 finish 二次触发"的 settled 守卫
(TCP 的 error 处理会清除计时器,迟到 finish 只能经 data 重置链路到
达);无 watcher 消息 id 的组件类型返回空结果。真实回环里这些失败
形态不可稳定触发(批32 结论),用 vi.mock('dgram'/'net') getter
工厂注入受控假例(TCP 经 new 构造,假例须以 class 形态提供),超时
计时器用 fake timers 精确控制(真实 20ms 计时会在等待期间先 settle);
纯真实 UDP/TCP 路径仍由回环集成测试覆盖。

monitoringWebView 的 updateWebView 无面板早退已补(tests/
monitoringWebViewGaps.test.ts,1 用例):不 show 直接调用守卫早退,
不触碰 collector 数据读取。一条实现现状如实记录:updateTimer 字段
只有声明与两处清理(面板 onDidDispose 与 dispose),没有任何调度
赋值点,恒为 null,清理分支内部语句(L81-82/L1115-1116)为结构
死分支。96.9% 的剩余即这四处。

explorerProviders 的统计与层级回落缺口已补齐(tests/explorerProvidersGaps
.test.ts,3 用例):readDefinitionStats 把入参整体当工作区根、本地名取
basename——用临时目录名与 `<目录名>.def` 同名命中真实解析路径,ARRAY-of
属性(bag)走扁平化 arrayElement 分支且元素子属性(`bag[]`)被
toStatsFromProperties 的 '.'/'[]' 过滤滤出名单,普通属性 focus 保留;
buildDefinitionDescription 的未注册实体徽章回落(无 runtimeProfile 走
else 拼 Base/Cell/Client + Unregistered);readDefinitionHierarchyStats
对 def 文件缺失的条目 loadResolved 返 null,回落 local-only(经
readDefinitionStats 的 catch 全吞返空 shape)。三条死分支如实记录:
createMethodSectionDescriptor 的 groups 空守卫(L741,进入前置是
inheritedGroups 非空,groups 恒非空)、readDefinitionStats 的 loader
空守卫(L982)与 readDefinitionHierarchyStats 的 loader 空守卫
(L1027,入参路径恒非空)。97.6% 的剩余即这几处与 v8 语句分裂伪影
(L578/L647/L731/L735/L1003-1004,邻行覆盖即必经)。

批47 把上述"伪影"重新甄别为**可达组合分支**并全部命中(tests/
explorerProvidersGaps.test.ts 扩至 6 用例):分支数据(if 两侧计数)
显示 L574 假侧(无继承组+有属性)、L730 真侧(有继承组+自身非 exposed
方法)、L646 真侧(快照 null)从未走过——不是伪影,是现有夹具没凑出
组合。四个新用例:无父类实体 P1 让 properties section 直出 items(不
经 groups 包装);父类 PBase 与子类 P2 都带非 exposed Base 方法(父组
零方法会被 items 空过滤,Own 与继承组并存);def 是目录的 GhostDir 让
数据库快照 EISDIR 被.catch、database section 整段缺席;同名命中 def
补 Interfaces/Components 段让 readDefinitionStats 成功 return 的映射
回调真实执行。explorerProviders 97.5%→99.2% lines,剩余 3 行即上述
三处死分支。教训:v8 分支计数(if counts=[0,N])是甄别伪影与可达
组合的准绳,语句 count=0 只说明该实例未走,须查分支两侧再下结论。

批48 以同一准绳复审其余"死分支"定案并修正一处(测试文件 defParser
Gaps.test.ts 扩至 10 用例):批35 归为伪影的 defParser L278-279
(isNonElementXmlNode continue)实为可达——fxp preserveOrder 对
`<?pi?>` 产出 '?pi' 键(实验验证),顶层或子节点含处理指令即命中;
新用例以顶层+子节点双处理指令的 def 驱动,节点树只保留元素。L268
(rawNode 空守卫)维持死分支:fxp preserveOrder 数组元素恒为对象,
契约性不可达。monitoringCollector L402(case 5 break)复核为纯 v8
语句粒度伪影:switch 分支计数显示 case 5 真侧走过 5 次,break 语句
实例记账为 0。defParser 98.7%→99.4% lines,剩余 1 行即 L268。至此
除 languageProviders(64.2%,并行会话文件)外,全部源码文件的剩余
未覆盖行均已定案:结构死分支、类型级死分支或 v8 记账伪影。

并行会话收尾后 languageProviders 解锁,批49 开补其 provider 入口层
(tests/languageProvidersGaps.test.ts,16 用例):标签栈的闭合回退
与自闭合跳过、方法段直接子级与深层嵌套的空回落、importlib. 前缀的
reload 补全;Type 值内 types.xml 自定义类型悬停、types.xml 元素名
悬停(词不在 Type 值内的另一入口)、entities.xml 实体注册悬停(带
Base/Cell/Client 运行时行)、python 文档钩子悬停与热更函数悬停及未知
词 null;定义跳转的 types.xml 元素名定位、类型值引用定位(GIFT 的
`<Type>DOLL</Type>` 跳 DOLL 定义行)与无词位置 null;结构诊断的未知
顶层段跳过、带子元素 Type 节点早退、别名 Flags 归一(CELL_AND_CLIENTS
→CELL_PUBLIC_AND_OWN、CELL_AND_OTHER_CLIENTS→OTHER_CLIENTS)与无
root 空文档。钩子名以 KBENGINE_HOOKS[0].name 动态构造(批18 铁律,
猜 'onSave'/'onInit' 两度落空)。剩余为悬停内部工具、数据库 schema
双向跳转与 python 自补全/调用层级链路,后续批次继续。

批50 开补悬停内部工具与数据库 schema 双向跳转(tests/
languageProvidersInternals.test.ts,40 用例;vscodeStub 扩展 Uri 的
scheme/parse/joinPath、makeTextDocument 的 uri 注入与
configurationOverrides 配置覆写):symbol 悬停的 DetailLevel/
DatabaseLength/Identifier 附加行与 Args/Exposed 方法行、reload 函数
悬停与 showValueDocs=false 的值文档关断;Type 值引用悬停(Entity/
Component 类型与 runtime 档案行、FIXED_DICT 的 Properties 详情与
UNKNOWN 回落)、entities.xml 注册悬停(declared enabled/disabled、
inferred from script、not declared no script、无 workspace 回落)、
诊断重复定义的父类/接口/组件/易变同步四区块标签与自定义类型在无
workspace/空 workspace 下的 unverifiable 回落;定义跳转的
implementedBy → python、坏 xml null、无 python 文件 null、属性值词
null、当前文档自含定义优先(types.xml 文档内 LOCALX 定义行)、类型
值 → 实体 def 与全落空 null;schema 双向跳转的 def 属性 → 虚拟
schema 文档、schema 字段/表行 → def 源行、无 def 实体的 schema 文档
null、非字段行 null、快照缺字段 null、无快照实体 null、无 schema
目标属性 null;def 内引用跳转的 Arg 值 → 实体 def、Parent 子标签 →
兄弟 def(components/ 文档内走组件目录分支)、自引用 def 无行号
null、无 manager 的方法符号 null;诊断区间回落(注释拆分值文本时
indexOf 落空,回落到节点值区间)。剩余未覆盖行全部定案:死分支
L407(hook 尾部命中——earlyHook 同词先行,showValueDocs=false 时
整段关闭,两条件互斥)、L1216(runtimeProfile null 与 entityInfo
null 同条件,L1179 已挡)、L1303/L1308(getDefNodeAtWord 入口与内部
同 position 同 /\w+/ 幂等)、L1363(customTypes.has 与
findCustomTypeDeclarationInfo 同 snapshot 恒等)、L1553(types.xml
顶级元素恒在类型注册表)、L1558(parseDefAst 对 types.xml 恒成功)、
L1578(需 parseDefDocument 成功且 root 缺失且光标有词的组合矛盾)、
L1764(同参二次解析恒同)、L1799(前级两 then 恒返回 Location),
及牵强组合 L1548(属性值词须同时绕过四处入口且值词与元素名错位,
无自然场景)。languageProviders 73.1%→85.3% lines,总覆盖
94.33%→96.57% lines。剩余为 python 侧链路(自补全/定义/调用层级,
L1888-2147),批51 继续。

批51 开补 python 侧链路(tests/pythonProvidersInternals.test.ts,
25 用例;vscodeStub 补 SymbolKind/CallHierarchyItem/Incoming/
OutgoingCall 四件套)。PythonDefinitionProvider:self 属性访问按
fullPath+rootSymbol 跳 def 属性定义、嵌套访问(bag.coins)整路径
解析、属性解析 null 回落方法定义、def 方法声明行跳转、声明解析
null 与光标在 def 关键字上(名字外)的 null;KBEngineCallHierarchy
Provider:python 文档按 1-based 行号解析方法位置产出 CallHierarchy
Item、def 方法桥接到 python 实现(resolveDefinitionSymbolAtPosition
→resolveMethodImplementationByIdentity 两跳)、非 method 区块 null、
identity null、implementation null、无词位置 null、其他语言 null、
incoming/outgoing 调用清单(caller/callee item 与 from/to ranges,
区间长度=方法名长度);PythonCompletionProvider:非 self 行 null、
无 mapping null、self. 顶级补全(属性带点路径跳过、空方法表跳过、
exposed detail 区分)、partial 前缀过滤、嵌套 self.bag. 补全
(Nested Entity Property)、嵌套 partial 过滤、空段跳过与同段去重;
KBEngineCompletionProvider 的 <Type> 前缀已知类型建议(内建 +
types.xml 自定义 + entities.xml 实体三元合一,补此前批次漏网)。批51
新增死分支定案:L1969(prepareCallHierarchy 的 !ast 早退——
symbolInfo 非 null 已证 parseDefAst 成功,同参二次解析恒同)。至此
languageProviders 全文件仅剩 11 行死分支(L407/L1216/L1303/L1308/
L1363/L1553/L1558/L1578/L1764/L1799/L1969),functions 全项目 100%,
languageProviders 85.3%→98.6% lines,总覆盖 96.57%→98.99% lines。

批54 落地重设计阶段 3(tests/fake-vscode/ 五模块 + tests/extension.test.ts
6 用例):vscodeStub.ts 改为纯 re-export 薄壳——值类型迁 core.ts,workspace/
window 状态化(workspaceState/windowState:消息三通道入账、输出通道/状态栏/
树视图登记、textDocuments、可 fire 的三个工作区事件、contentProvider 记账),
新增 commandRegistry(registerCommand 记账 + executeCommand 真分发)、
languages(provider 注册记账)与 panelRegistry(记录型假 WebviewPanel,阶段 4
消费)。33 个既有文件的 import 路径与 monkey-patch 语义零改动。extension.ts
装配测试断言:注册面与 package.json 贡献点双向一致(21 命令/2 视图/6 语言
注册/schema provider/状态栏)、21 条命令真分发(含 FakeComponentBin 真实进程
的 start/stop/restart/showLogs 与状态栏运行数联动、debug 选中分支、三类
打开命令的 catch 与空目标早退)、dispose 链逐项拆除、工作区初始扫描与
documentChanged/documentOpened/configurationChanged 事件联动。两个教训:
真实 vscode 未打开文件夹时 workspaceFolders === undefined,而空数组是
truthy——置 [] 会误入"有工作区"分支,须显式 undefined;假组件经 shebang
启动 node,并行负载下 stdout 标记可能晚于 1 秒 Running 宽限期到达,断言须
轮询等待。批54 由装配测试修出真实缺陷:kbengine.entity.method.open 的空目标
守卫位于 label 拼接之后,命令面板无参调用在守卫前抛 TypeError——守卫上移。
extension.ts 99.5% lines / 100% functions,总覆盖 98.99%→99.01% lines。
批54 顺带固化两处进程时序易碎点(全量并行下复现):serverManagerProcesses
的 Running 断言后 stdout 三段输出(标记/cwd/环境回显)改为轮询等待;秒退
行为的假组件在 POSIX 下改用 /bin/sh 脚本——node 解释器冷启动可能超过 1 秒
启动宽限期,"秒退不触发启动成功提示"的断言不再依赖启动速度。

批55 落地重设计阶段 4 第一步:三个 WebView 面板测试(logWebViewPanel/
monitoringPanel/entityDependencyPanel,51 用例)从各自内联的 monkey-patch
面板工厂迁到 panelRegistry 默认假面板,断言语义不变。替换点:本地
StubPanel → FakeWebviewPanel(创建参数入 panels 注册表、
onDidReceiveMessage/onDidDispose 监听捕获于面板本体、fireMessage/
fireDispose 驱动消息与销毁、postMessage 入 postedMessages 账) ;
revealCalls/disposeCalls 计数 → revealed/disposed 布尔(FakeWebviewPanel
.dispose 幂等,二次调用不再触发销毁监听,断言随之收紧);消息三通道与
showTextDocument 直接消费 windowState 入账(messages/
showTextDocumentCalls),每文件只剩 showSaveDialog 应答队列与
workspace.fs.writeFile 故障注入两类 patch。src 的 createWebviewPanel
消费面实际为三个(logWebView/monitoringWebView/entityDependencyWebView),
redesign 原文"四个 WebView"计数有误,已更正。

批56 落地重设计阶段 4 收尾:mocha 层从 19 文件 4930 行/110 用例裁到编译
产物烟测集(3 文件 10 用例)——manifest 贡献点、out/extension.js 装配激活
(注册面与 package.json 双向一致/状态栏/命令真分发到 panelRegistry/dispose
链逐项拆除)、out/languageProviders.js 补全+悬停最小应答(期望序列与 vitest
层同规格)。其余 17 个套件与 vitest 层同构(P7:所谓"集成层"实际在纯 Node
里跑,并不更真实),全部退役;testUtils.ts 的 Fake* 值类型退役,统一复用
fake-vscode 的编译副本——新增 tsconfig.mocha.json 把 tests/fake-vscode +
tests/helpers/vscodeStub 编译到 out/tests/(注意路径深度:从 out/test/suite
出发是 `../../tests/helpers/vscodeStub`,两级 .. 到 out/,首版误写三级),
test 链插入 `tsc -p tsconfig.mocha.json` 步骤。从未被调用的
@vscode/test-electron 依赖移除(P7 定案:runTest.ts 实为纯 Mocha;若未来
需要 L4a 真机烟测,再显式引入并独立于提交门槛)。烟测集的独立价值=验证
tsc 产物与完整模块图在打包形态(main: ./out/extension.js)下可装配,这是
vitest(消费 TS 源)给不了的。

批57 为重设计终验收尾:test:coverage 复跑核对总体覆盖率与批54 表格一致
(99.03/91.76/100/99.01,批55/56 未动生产代码,分母不变);redesign.md 对
两处"图里有、未立项"的项补定案——LoggerSimulator(插件侧 logger 协议未
适配,真 TCP 对端无可验证语义,状态机结论已由假 socket 用例覆盖,协议适配
批次再落地)与 SocketFactory/src/ports/ 目录(发现地址经批52 参数注入、
socket 失败路径经 vi.mock 覆盖,无消费者的抽象违背最小侵入原则)。

批58 落地 COMPLETED_FEATURES「重构支持」:.def 属性/方法重命名
(tests/defRenamer.test.ts,29 用例 + providerSmoke 烟测 1 用例)。新增纯模块
src/defRenamer.ts(符号解析:光标须落在顶层 Properties/方法段直接子元素的
开或闭标签名上;引用编辑:同文件同名符号 + Parent 链与 Interfaces 传递闭包
后代 def 的同名复述,每文件至多读盘一次;定义根从目标文件向上找 entities.xml
推导,KBEngine 常规布局 entities.xml 在 entity_defs 父目录、非常规内嵌布局
取所在目录)与 languageProviders 的 KBEngineRenameProvider(原生 F2,无命令
贡献点),extension.ts 以 def 选择器注册。覆盖:同文件 Flags 变体全部命中、
方法段命名空间隔离(同文件跨段与后代其他段不动)、接口传递闭包(含
<Interface><X/></Interface> 包裹形态)、复述处发起只向下传播(祖先源头
不动,如实边界)、无 entities.xml 退化同文件、非法/同名新名拒绝、悬空
Parent/Interfaces 引用、坏 XML 与不可读(chmod 000)/不可枚举(目录 chmod
000)后代跳过、越界光标与非符号位置 null、WorkspaceEdit 跨文件区间按各自
文件行表换算(曾审出借目标文档行表换算的设计错误,改为 edits 携带基准
文本)。fake-vscode 相应补 TextEdit/WorkspaceEdit 值类型与
registerRenameProvider 记账。defRenamer 99.5% lines,唯一未盖行 L143 为
getTagNameRange 的 !match 防御分支——标签文本与元素名同源自 tokenizer,
正则必中,契约性不可达,如实记录。总体覆盖率 99.06/91.91/100/99.03,
vitest 60 文件 753 用例、mocha 烟测 11 用例。

批59 分支覆盖专项:压总分支缺口最低三文件(以 coverage-summary 解析
为据:extension.ts 79.0%、serverManager.ts 82.6%、debugConfig.ts
87.3%)。逐分支补测——extension.ts:非 def 文档的变更/打开/配置重扫
三处 isDefDocument 假分支;method.open 字符串形态缺省 method/section
与 identity 形态缺省 section 的 label 空串兜底;成功侧 didOpen true
(fake findFiles 桩按真实落盘树应答,索引异步落地留节拍后单发,无
Python 实现走 def 兜底打开);database.open 真实 def+entities.xml
快照命中(显式表名与默认 tbl_<实体名> 两路,期望行与命令内部同源
计算)与 catch 模板表名/字段名三真值组合。serverManager.ts:
ensureTrailingSeparator 幂等分支、${env:} 未设变量展开空串、
KBENGINE_HOME 两候选(server 目录优先/缺 server 回落 kbe/bin)、
defaultArgs 缺失组件的 '(none)' 日志与空参 spawn(注入 fake child)、
启动定时器清空后的二次 error/exit(else 分支)、process.platform
补丁驱动 win32 判定两路(win 风格 binPath 加 .exe/posix 风格守卫不加,
forks 池每文件独占进程,补丁区间无 await)。debugConfig.ts:
generateLaunchConfigurations 无工作区空串映射根;launch.json 缺
configurations/inputs/version 键兜底与无 name 用户条目保留;
startDebugging 长 briefing(debug.json 配 telnetEnableCommands)、
显式空 telnet 字段走文档默认、合并层空主机串触发提示层字面量兜底。
定性 4 条(不凑数):serverManager L398 定时器回调 else 结构性不可达
——先于 1s 回调删除运行表条目的 error/exit 处理器都会同步先清定时器,
stopComponent 的 5s 强杀晚于回调,回调触发时条目必在;debugConfig
L296/L299/L300 提示层 || 右侧契约不可达——getComponentConfig 输出
恒定义 telnetEnableCommands(数组恒真值),telnetPassword/
telnetDefaultLayer 已在合并层用同一非空字面量兜底,提示层输入恒真值。
另:extension.ts L236 隐式 else 为 v8 记账伪影——成功侧行为已由
断言锁定(静默无 warning 且打开 Avatar.def),v8 对 async 重入区域的
无 else if 推导计数为负([4,-2]),非真实缺口,如实记录。分支覆盖
extension 79.0%→98.4%(61/62)、serverManager 82.6%→98.6%(68/69)、
debugConfig 87.3%→95.2%(60/63),总分支 91.91%→92.89%(2642/2844),
statements/lines/functions 持平(99.06/99.03/100)。vitest 60 文件
766 用例(两种引擎口径全绿),mocha 烟测 11 用例。

批60 分支覆盖专项:压批59 后分支最弱三文件(coverage-summary 为据:
entityMapping.ts 88.7%、explorerProviders.ts 88.5%、kbengineProtocol.ts
91.2%)。逐分支补测——entityMapping.ts(tests/entityMappingBranches.test.ts,
12 用例):无工作区根的两级回落(getWorkspaceRoot 工作区外文件走第二
startsWith 求值/无文件夹返 null、collectPythonOwnerFiles 空根布局返空表、
toLegacyMapping 回落相对 scripts/base/<实体名>.py);私有工具直驱
(buildIndex 空 def 路径返 null、collectPythonMethods 跳过缺失 owner 文件、
bindPythonMethods 对非 .py 且不含 components/interfaces 段的文件按
entity/interface/component 三键兜底且不绑定、rebasePropertyPath 点开头
路径 split 落空回退整节点替换并递归 arrayElement、scoreMethodDefinition
四选项全短路的 0 分与 local 命中的 110 分);真实索引上的解析未命中
(按位置解析属性/方法两路 null、resolveMethodImplementation 无定义 null);
身份缺 propertyPath 的直入表索引(类型上可选)在属性解析与按位置解析中的
归一空路径比较。explorerProviders.ts(tests/explorerProvidersBranches.test.ts,
13 用例):存在的接口/组件定义条目进视图模型后非实体侧分支才可达——属性
描述取类别标签前缀(Interface/Component Property)、数据库模型零值、无
database/runtime 段、组件方法条目命令回落"打开定义"(vscode.open)而接口
仍走方法打开命令;只继承属性无自身属性的实体不建 Own 组;悬空 Parent 引用
描述退化为引用名且无命令;readDefinitionStats 的 interfaces/components
路径特征归类(嵌套目录使 basename 与 <目录名>.def 同名命中真实解析);
类型条目兜底(aliasType 缺失时描述与汇总回落 ALIAS、rawValue 缺失时 alias
段整段不建、深结构为空时回落单条目标签取 || 右侧、属性 typeName 缺失走
UNKNOWN、叶子结构 rawValue 与名不等时描述带值前缀);工作区根自身的
relative 为空回落绝对路径;方法条目 exposed 侧描述与图标、身份缺失时
按条目类别组装兜底身份(entity/interface/component 三形态与透传侧)。
kbengineProtocol.ts(tests/kbengineProtocolGaps.test.ts 扩至 12 用例):
目录帧尾部无 NUL 段的 readCString 收口、buildComponentInfo/parseComponentInfo
往返下畸形地址(段数不足与非数字段)双双回落 127.0.0.1 而正常地址按字节
还原、getuid 与 uid/UID 环境变量全缺席时请求帧 uid i32LE 为 -1、UDP 落定
后迟到坏包与 error 事件命中守卫不二次 close/reject、绑定回调在落定后报
string 地址只直接返回、TCP 落定后的迟到 error 不改判也不二次 destroy。
定性 17 条(不凑数):entityMapping L127 loader 守卫(scanEntityMappings 根
恒非空)、L204/L208 push 闭包契约(调用点恒传对象且 section 真值)、L311
else 侧与 L324 双侧(DefinitionSemanticCategory 联合被 entity/component/
interface 三分支穷尽,批33 类型级锁定)、L641 隐式 else(v8 对 async 重入
区域的推导计数,成功侧行为已由断言锁定,与批59 extension L236 同类)、
L836 隐式 else(计数 [2,-1] 负值伪影)、L866 `|| null` 右值(matches.length
=== 0 已前置早退)、L888 双侧(options.componentSlotName 无调用点传入,
短路使右操作数恒不求值);explorerProviders L212/L1100(段描述符构造侧
恒保证 items 与 groups 至少一侧非空,`|| []` 与末个 `?? 0` 为契约防御)、
L740/L981/L1026(批43 登记维持:groups 恒非空、loader 入参路径恒非空);
kbengineProtocol L598(finish 的真实调用恒发生在 timeout 赋值之后,落定后
再调用直接早退,else 侧为声明顺序防御)。另修正批34 的两条登记:
buildIndex 的 loader 守卫(今 L166)与 collectPythonMethods 的存在性早退
(今 L448)只是公开调用图到不了,私有接缝接受的是合法类型输入(空 def
路径、缺失 owner 文件),已改判为可达并真实覆盖,行为断言在案。分支覆盖
entityMapping 88.7%→96.1%(273/284)、explorerProviders 88.5%→98.1%
(255/260)、kbengineProtocol 91.2%→98.9%(90/91),总分支
92.89%→94.76%(2695/2844),statements 99.06→99.12、lines 99.03→99.10、
functions 持平 100。vitest 62 文件 798 用例(两种引擎口径全绿),
mocha 烟测 11 用例。

批61 分支覆盖专项:压批60 后分支最弱单文件(monitoringCollector.ts
90.3%,104 分支缺 10 条路径)。新增 tests/monitoringCollectorBranches.test.ts
(6 用例)逐分支补齐——start() 的暂停态分支(只记间隔、不起定时器、不发
首轮刷新,resume 后间隔生效且首轮刷新立即发生);refresh catch 对非 Error
抛出值的归一(String 化后 message 即原值)与 Error 值原样采用的对照;
bots(type 11)在可监控白名单内但协议表无 watcher 查询消息 id → 两路查询
零结果 → queryWatcherValues 的 values 回落空表(binary 右侧)与 buildDetails
的 switch default(不匹配任何 case,仅剩 UID 行),同端口热换 baseapp(6)
作正向对照(load/uptime 按帧解码);logger(type 10)的 stats 缺 secsNumlogs
时 ?? 0 回落、存在时按该键取(不经 messagesPerSecond);details 全空时的
'Watcher' 占位行两臂与 || 短路顺序(根值空而 stats 有值 → 取 stats 键数
出 '已响应';两路全空 → '无返回')。
定性 0 条(本文件):10 条路径全部计入覆盖,分支 90.3%→100%(104/104)、
statements 98.91→100、lines 98.9→100。接缝与真实链路的界线如实划清:
bots/logger 两例走 tests/sim 仿真器的真实 UDP 发现 + TCP watcher 回环;
非 Error 抛出与"无 uid 组件"两例经 vi.mock('../src/kbengineProtocol') 的
getter 工厂局部替换 discoverLocalComponents(其余导出透传实际实现)——
前者是语言合法而真实实现不产生的抛出值,后者是 `uid: number` 契约外的
畸形报文形态(makeSimComponentInfo 显式过滤 undefined 覆写,故该组件由
测试自行构造并在注释标注契约边界),两者只锁定消费端的归一/防御行为,
**不代表发现链可产出该输入**;批41 的"machine 发现链上 uid 恒为 number
(0 也以 '0' 入列),占位分支链路上不可达"结论维持,批41 注已加指针。
另登记一处实现现状(非缺陷):type 11(bots)虽在可监控白名单内,却因
WATCHER_QUERY_MSG_IDS 无该键而永远拿不到 watcher 指标,状态恒为"仅 machine
可见"(引擎侧 bots 不起 watcher 服务,与该表一致)。本批未暴露真实缺陷,
'由测试发现并修复的真实缺陷'一节无新增条目。总分支
94.76%→95.11%(2705/2844),statements
99.12→99.16、lines 99.10→99.14、functions 持平 100。vitest 63 文件
804 用例(两种引擎口径全绿),mocha 烟测 11 用例。

批62 行覆盖专项:基线 lines 99.14%(4743/4784,缺 41 行)推到 100%。
逐行判定 41 处缺口(languageProviders 11、entityMapping 7、entityDependency 5、
monitoringWebView 4、definitionWorkspace 3、entityDependencyWebView 2,其余零星
1-2 行),结论是 **11 行可达并补真实用例 + 30 行不可达并加 ignore**:

可达侧(每处一条以上真断言,无空测试)——definitionWorkspace.ts L895
`mapDefinitionFiles` 跳过"非普通文件"条目:真实文件系统落两个符号链接
(指向目录的 Loop.def、指向文件的 Linked.def)与 entity_defs 下一个
Ghost.def 链接,断言清单只收普通 .def、链接名既不列入也不作为未注册定义补入,
其余字段口径照常(new tests/definitionWorkspaceLines.test.ts,2 用例);
entityDependency.ts L471-477 FIXED_DICT 的嵌套 `<Properties>` 递归:按私有函数
契约直驱 `extractReferencesFromProperty('pos', <体内带完整闭合嵌套段的体>)`,
断言内层字段引用名为 `pos.target`(点前缀)、类型按内层 `<Type>` 判定为 array,
且同一体内 `<Type>` 的扁平扫描不看层级会再以父属性名 `pos` 记一条(dedupe 键为
"实体:类型:属性名"三元组,两条不同故都保留——实现现状),另以"未跑 analyze 的
实例"断言 `isEntityReference` 闸门使结果为空;entityDependencyWebView.ts L80
`refreshGraph` 的 `!panel` 守卫:先捕获面板的消息回调再 `fireDispose`,复现
"在途 refresh 消息在销毁之后送达"的时序,断言不重新分析(analyze 调用数 0)、
`webview.html` 逐字不变、无 error 也无输出行;entityMapping.ts L903
`scoreMethodDefinition` 的 componentSlotName 两臂:直驱打分函数,槽名命中 140、
不命中 110、定义自身无槽名而传了选项 110(批33 已登记该选项不被候选收集使用,
本例只锁打分契约);explorerProviders.ts L986/L1031 两处"工作区根为空串":
`readDefinitionHierarchyStats('')` 退化为只出本地一节(inherited 空、local 仍含
hp/move)、`readDefinitionStats('')` 回落六键全空表且不抛给调用方;extension.ts
L242 `kbengine.entity.method.open` 的 catch:令 `openTextDocument` 抛错,字符串与
identity 两种入参各出一条带原因的 warning,断言两种 label 形态同文;
languageProviders.ts L1577 `findCustomTypeInfo` 未命中:在工作区放第二份
types.xml 副本(backups/types.xml,不在布局候选路径上),副本独有类型名 BETA 的
悬停与定义双双为 null,同名 DOLL 仍按**布局那份**解析(hover 出 item.doll 而非
副本写的 item.other),跳转行号取当前文档第 5 行。

不可达侧(25 处 `/* istanbul ignore start */ … stop */` 区间,理由逐处写在
源码注释里,此处登记口径)——languageProviders.ts 10 处:hover 的
hook 二段判定(同开关下 earlyHook 命中即返)、`!runtimeProfile`
(entityInfo 与 profile 同源于同一 workspaceRoot 快照)、getDefNodeAtWord 两条
回落臂(四个调用面都用同一条 `/\w+/` 在同一 document+position 取词后原样传入)、
`!declarationInfo`(集合命中必有节点)、findCustomTypeAtPosition 的 `!ast`
与 findCurrentDocumentCustomTypeReference 的 `!ast?.root`(二者都建立在
同一 document 同一次同步解析已取到 AST 的前提上)、
findMethodImplementationLocationInDef 的 `!ast || !symbolInfo`、外层 then 的
位置兜底(内层两臂都返回 Location)、prepareCallHierarchy 的 `!ast`
(symbolInfo 非空即证明解析成功);entityMapping.ts 3 处:loader 工厂的
`!loader`(工作区文件夹 uri.fsPath 恒为绝对路径)、push 闭包的 `!candidate`
(三处调用都在 fs.existsSync 命中分支里传字面量对象)、getPythonCandidates 尾部
(componentSlotName 候选臂 + 末次 return,需要类型外的 kind 才能到达,
批33 登记的重复形态);monitoringWebView.ts 2 处:`updateTimer` 的两段清理
(本类无任何赋值点,自动刷新定时器未接线,守卫恒为假);definitionWorkspace.ts
2 处:`!layout.entityDefsRoot`(候选列表恒含非空相对路径,该值只能是字符串)与
findExistingLookupPath 的 `typeof candidatePath !== 'string'`(唯一非串来源
是 entityDefsRoot/interfacesRoot/componentsRoot 为 null,而上者恒为串);
databaseSchema.ts 2 处:`!layout.entityDefsRoot`(同源理由)、
FLAG_SCOPE_MAP 的 switch `default`(RuntimeScope 三员已穷尽);
entityDependency.ts 1 处(calculateDepth 递归臂,见下"实现现状")、
entityDependencyWebView.ts 1 处(mermaid 类型标签 switch 的 `default`,
EntityType 三员穷尽)、defParser.ts 1 处(`!rawNode || typeof rawNode !== 'object'`,
vendor fxp 在 preserveOrder 下对注释/声明/doctype/CDATA/PI/纯文本/混合元素
八种输入实测均产出对象元素)、defRenamer.ts 1 处(getTagNameRange 的正则失配臂,
tagStart/tagEnd/name 同源同一次解析,切片必以该标签名开头)、
definitionSemantics.ts 1 处(buildInheritanceLabel 的空链臂,五处调用传入的
chain 均以字面量名打头,`createSource` 的 `[]` 默认值只与 kind='local' 同现)、
explorerProviders.ts 1 处(段描述符 `groups.length === 0`,上方已早退)。

机制发现(本批 ignore 形态统一为区间的因):vitest 5.0.1 +
@vitest/coverage-v8 5.0.1 + ast-v8-to-istanbul 1.0.7 下,`/* istanbul ignore
next */` 只对 SwitchCase 生效——放在 IfStatement 之前、块内 `return` 之前、
标签同行右侧等共 9 种放置法逐一实测,语句/行计数均不变;能同时移出行与分支
条目的形态只有 `/* istanbul ignore start */ … /* istanbul ignore stop */`
行区间。故全仓 ignore 一律用区间,区间上方保留中文理由行。

登记两处实现现状(只登记不修,修正属功能改动):① entityDependency.ts
`calculateMaxDepth` 的种子循环只对 `!node.parent` 的实体调用 `calculateDepth`,
被选中节点的 parent 恒为空,递归臂永不进入 → `stats.maxDepth` 在任何继承链上都
只到 1(链深未被真正计算);② `extractTagBodies(text, 'Properties')` 非贪婪,
顶层段在首个同名闭标处截断,段内不可能出现成对的 `<Properties>…</Properties>`,
后果是 FIXED_DICT 内层字段的引用永远走不到(本批 L471-477 只能按契约直驱),
且含嵌套 Properties 的顶层属性整块丢失、其内层字段反被当成顶层属性提取
(名与路径错位;批60 的 'loses the nested property but hoists the inner block'
用例已锁该现状)。

修正批54 的一处定性:extension.ts L242 曾被记为"openMethodTarget 永不抛错
(内部自带 catch)导致的防御 catch"——不成立,`openFileAtLocation` 不 catch,
`openTextDocument` 失败会冒到命令层,本批已按该真实路径补测,该说法在下方"说明"
里同步改掉。本批未暴露需要改动生产代码的缺陷,'近期由测试发现并修复的真实缺陷'
一节无新增条目。总行分母 4784→4733(移出 51 行 = 30 处缺口行 + 同区间内原本
已覆盖的 21 行),lines 99.14%→100%、statements 99.16%→100%、functions 持平 100、
branches 95.11%→96.2%(2705/2844→2686/2792,分母缩小系 ignore 区间同时移出分支
条目;区间外未覆盖分支 106 条维持逐批定性的口径)。vitest 64 文件 812 用例
(两种引擎口径全绿),mocha 烟测 11 用例。

批63 分支覆盖专项:defParser.ts 分支 92.6%(87/94 臂)→100%(86/86 臂),
行/语句/函数维持 100%。逐臂判定该文件 7 条未覆盖臂,结论是
**2 臂可达并补真实用例 + 5 臂(4 个条目)不可达并加 ignore**:

可达侧(tests/defParserGaps.test.ts 由 10 用例增至 14 用例,全部走真实
parseDefDocument 产物,未放宽任何断言;覆盖率表旧注"9 用例"系批5x 遗留计数,
一并改正)——L137 `getScalarChildValue` 的 `return value || undefined` 右臂:
`<hp><DetailLevel>   </DetailLevel><Name>NEAR</Name></hp>` 里先断言子元素
确实存在(`getDirectChildElement` 命中)且 `getElementText` 逐字为 `'   '`
(排除 `!child` 早退,命中点只能是 trim 后空串),标量值 undefined;自闭合
`<DetailLevel/>` 的 `children` 为 `[]`、`getElementText` 得 `''`,同样回落
undefined;正向对照 `<Name>NEAR</Name>` 返回 `'NEAR'`,缺标签对照返回
undefined。L443 `findFirstElement` 循环的"跳过非元素节点"臂:顶层 CDATA 是
fxp 唯一会进树的非元素节点(注释不产出、`<?pi?>` 被 `isNonElementXmlNode`
跳过、顶层纯文本被 fxp 丢弃,三种输入逐一实测),故
`<![CDATA[leading]]><root><a>1</a></root>` 的 `nodes` 序为 `['text','element']`,
循环必须跳过文本节点才拿到 `<root>`(逐字断言 kinds、`root.name`、顶层文本的
`text` 与 `document.text.slice(startOffset, endOffset)` 定位、`root.children`
不受影响);`<![CDATA[only]]>` 整树无元素 → `root === null`,锁
findFirstElement 走完循环后的 null 回落。

不可达侧(新增 3 处区间,移出 4 个条目 / 8 条臂)——L294 `#text` 值的
`typeof value === 'string' ? value : ''`:fxp 把文本与 CDATA 一律产成
`{"#text":"字符串"}`,且 `#text` 作标签名被 fxp 直接拒绝(`Invalid tag name`),
非字符串值无从进入本行;L320 元素 children 的 `Array.isArray(value) ? … : []`:
preserveOrder 的元素值恒为数组(空元素 `[]`、文本元素 `[{"#text":…}]`),
标量元素值只在 `parseTagValue:true` 等非本仓库配置下出现;L345
`normalizeAttributes` 的 `typeof value === 'string' ? value : String(value ?? '')`
及其内 `??` 双臂:`:@` 表里每个 `@_` 属性值原样留作字符串(含空串属性 `@=""`
与实体/数字引用)。三处同因:归一化层收到的形状完全由 vendor fxp 决定——
为定案该结论,批63 以约 40 种输入形态(顶层/内联注释、xml 声明、doctype、
CDATA、PI、纯文本、混合元素、空元素、自闭合、空属性值、重复属性、命名空间
前缀属性名、实体引用等)逐一 dump fxp 在固定
`{preserveOrder:true, ignoreAttributes:false, trimValues:false, parseTagValue:false}`
下的产物,无一产出非字符串 `#text`、非数组元素值或非字符串属性值。区间上方
逐处写明理由,中文注释行按批62 定的机制统一用 `start … stop` 形态。

分母口径(如实记,不美化):3 处区间移出 8 条臂 = 5 条本批判不可达的缺口臂 +
3 条原已覆盖的臂(L294 的 string 臂、L320 的数组臂、L345 的 string 臂);
L320 与 L345 的三元与所在赋值语句同起一行,而区间按行生效,故这两条**已覆盖**
语句连同其行一并移出分母——statements 4843→4841、lines 4733→4731(仍报 100%,
但这两行是"被移出"而非"被补测覆盖",在此登记)。总分支
96.2%→96.44%(2686/2792→2685/2784:分母 -8,分子 -3+2)。另附带修正
defParser.ts 一处 5 空格缩进(批62 插标记时的排版残留,无行为变化)。
本批未暴露需要改动生产代码的缺陷,'近期由测试发现并修复的真实缺陷'一节无新增
条目。vitest 64 文件 816 用例(两种引擎口径全绿),mocha 烟测 11 用例。

批64 分支覆盖专项:definitionWorkspace.ts 分支 92.8%(193/208 臂)→100%
(178/178 臂)、languageProviders.ts 分支 95.2%(520/546 臂)→100%
(534/534 臂),两文件行/语句/函数维持 100%,总分支 96.44%→97.88%
(2685/2784→2684/2742)。

可达侧(新增 tests/definitionWorkspaceBranches.test.ts 3 用例、
tests/languageProvidersBranches.test.ts 17 用例,全部真实临时文件树/真实
parseDefDocument 产物,未放宽任何断言,点亮 22 条缺口臂)——
definitionWorkspace.ts 2 臂:`extractCustomTypeRawValue` 的 `|| 'ALIAS'`
哨兵臂(仅 `<implementedBy>` 子元素的类型元素无文本块 ⇒ chunks 空 ⇒
'ALIAS',对照 `<OK><Type>UINT8</Type></OK>` 照常渲染;aliasType 对 '<'
开头的 rawValue 无标识符前缀、如实断言归一 'ALIAS');`parseCustomTypeStructure`
的 root-null 兜底臂(`<LT>a &lt; b</LT>` 经实体解码得裸 `'a < b'`,再包装
`<root>a < b</root>` tokenize 抛错 ⇒ parseXmlDocument 归 null ⇒
`children: []`,先用 `expect(() => parseDefDocument(...)).toThrow()` 证明
守卫条件)。其余 20 臂在 languageProviders.ts:错配闭标 `</zzz>` 的"逐项
失配不弹栈"臂(补全仍归顶层 9 标签);非 .py/.def 文件 `KBEngine.`/
`importlib.` 补全空回落;`hover.showSymbolDocs`/`hover.showTagDocs` 关断臂
(默认正对照 + 关断断言 null,finally 还原);entities.xml 定义跳转的
`if (defPath)` 假臂(布局候选恒取 scripts/entities.xml,assets 下同名文件
不进注册快照,`<Oddball/>` 无 Oddball.def ⇒ null,Hero 正对照命中 Hero.def);
enableStructureDiagnostics 关断后属性区块重复定义诊断消失而标量未知类型
诊断保留(重复判定按 Flags 作用域,fixture 带 `<Flags>CELL_PUBLIC</Flags>`);
DetailLevel 的 NEAR 合法臂、空值臂与 `diagnostics.checkUnknownDetailLevels`
关断臂(BLAH 报错正对照);属性无 `<Type>` 子元素时悬停省略 Type 行;方法
无 `<Arg>`/`<Exposed>` 时省略 Args/Exposed 行(带 Arg/Exposed 正对照);
entities.xml 悬停的 `getRegisteredEntityInfo` `|| null` 右臂(未注册实体
无 **Base** 运行时行,Hero 正对照);implementedBy 即文档根时
`findAncestorElement(...)?.parent || null` 右臂(hover/definition 双 null);
`isPositionInsideChildTag` 的文本节点→父元素臂与 Arg/Interfaces/Parent 三处
未命中回落(含 components/ 目录下 `<Parent Unknown/>` 穿透实体查找的回落,
Known.def/Iface1.def/Hero 正对照);补全去重的两处 `!suggestions.has` 假臂
(自定义 UINT32 与内建同名保留内建 detail、自定义 Hero 与注册实体同名保留
自定义 detail、仅注册实体的 NoDef 走实体 detail 对照);
PythonDefinitionProvider 属性/方法双解析失败的 null 回落(假
EntityMappingManager)。

不可达侧(definitionWorkspace.ts 新增 9 处区间、languageProviders.ts 新增
5 处区间并合并扩展批62 既有区间 1 处,合计移出 42 条臂 = 19 条不可达臂 +
23 条原已覆盖臂)——definitionWorkspace.ts:布局空值臂家族 13 个条目
(`entityDefsCandidates[0] || null` 右臂、entityDefsRoot/entityScriptsRoot/
interfacesRoot/componentsRoot/scriptRoot/scriptPath 各 ternary 的 null/''
臂、entities.xml/types.xml/user_type 候选的 `: ''` 臂、entity `.def` 的
回退 `${name}.def` 臂,连同各自条目内已覆盖的对侧臂):candidates 由
buildWorkspaceCandidates 生成,首项为 resolveWorkspacePath(root, 配置路径),
相对路径经 path.join 的最小结果是 '.',恒非空 ⇒ entityDefsRoot/
entityScriptsRoot 恒为非空字符串(批62 已据同一事实把
`!layout.entityDefsRoot` 守卫判不可达),所有依赖二者的空值臂同因不可达;
`findCustomTypePythonFileByImplementation` 的 `if (normalizedModule)` 假臂:
外层 `implementedBy?.trim()` 为真 ⇒ 非空字符串经 replace(/\./g,'/') 仍非空;
其嵌套 `if (firstSegment)` 假臂在 implementedBy 以 '.' 开头(如 '.doll')
时**实际可达**,但 istanbul ignore 只支持整行区间、该分支条目与外层同落
一个区间被连带摘除——已以前导点用例('.a.b' 不产生首段候选而 'a.b' 产生,
a.py 命中对照)锁定行为,未裸奔;`compareDefinitionEntries` 的 if 条目与
`left.registered ? -1` 真臂:唯一 registered 混排输入是 entity 类目,entries
按 Map 插入序先 registered 后 unregistered 且 unregistered 侧已按名排序,
V8 sort 比较方向恒为 (后元素, 前元素),混排对的 left 恒为 unregistered
(节点探针 12/12、25/25、40/40、60/60 多种命名序均仅触发假臂),type/
interface/component 类目全部 registered 不进本 if(if 条目本身两臂全被
覆盖,随区间一并移出)。languageProviders.ts:`if (fn)` 假臂
(KBENGINE_RELOAD_FUNCTIONS 模块级静态白名单恒含 'importlib.reload');
`status === 'missingTypeRegistration'` 判定条目(CustomTypeResolutionStatus
共四值,resolved/unverifiable/missingPythonFile 在上方 continue 穷尽,到达
即第四值;区间只摘分支条目,诊断构造保持被覆盖计入分母);
createHookHover 的 `if (hook.sourceLocation)`/`if (hook.example)` 假臂
(KBENGINE_HOOKS 全部 36 个 hook 均带 sourceLocation 与 example 的数据
不变式,引擎侧用例亦锁定 sourceLocation);`registeredCustomTypes ??
getRegisteredCustomTypes` 右臂(唯一调用方 validateTypeNode 恒传非空集合);
findMethodImplementationLocationInDef 尾部 `if (reference)` 判定与兜底
return(合并扩展批62 区间:内层两臂恒返回 Location ⇒ 外层 reference 恒真,
假臂与兜底均无触发路径)。

分母口径(如实记,不美化):14 处新区间 + 1 处合并扩展共移出 42 条臂
(19 条不可达 + 23 条已覆盖;19 条中 1 条 firstSegment 假臂可达但因行区间
嵌套规则被连带摘除,已有行为锁定用例看住),另有 22 条原缺口臂被新用例
点亮(2 + 20);区间内被覆盖的赋值/return 语句连同行一并移出分母——
statements 4841→4821、lines 4731→4711(仍报 100%,但这部分是"被移出"而非
"被补测覆盖",在此登记);分支分母 2784→2742(-42),分子 2685-23+22=2684。
本批一次源码编辑曾误删 `const normalizedModule` 声明,被新增用例当场红掉
后即补回,最终态无行为变化,未暴露生产代码缺陷,'近期由测试发现并修复的
真实缺陷'一节无新增条目。vitest 66 文件 836 用例(两种引擎口径全绿),
mocha 烟测 11 用例。

批65 分支覆盖专项:pythonLanguageUtils.ts 分支 90.9%(20/22 臂)→100%
(18/18 臂),行/语句/函数维持 100%,总分支 97.88%→97.95%
(2684/2742→2682/2738)。coverage-summary 显示全库仅剩该文件两位数缺口,
逐臂判定 2 条未覆盖臂,结论是 **0 臂可达 + 2 臂(2 个条目)契约性不可达
并加 ignore**:

不可达侧(新增 1 处区间,移出 2 个条目 / 4 条臂)——`getPythonSelfCompletionContext`
尾部的 `partialSymbol`/`rootSymbol` 两个 `segments.length > 0 ? … : ''/null`
三元:能走到 L71+ 必是"正则 `\bself\.(\w+(?:\.\w+)*)?\.?$` 命中且行不以
'.' 结尾"——组1 未匹配时命中串只能是 'self.'/'self..'(双点亦被 `\.?` 吞掉),
均以 '.' 结尾而走上方 `endsWithDot` 早退;组1 命中则 accessPath 至少含一个
\w 段,segments 恒非空。两个三元恒取真臂,''/null 兜底无触发路径(节点探针
10 种输入形状逐一实测:'self.'、'self..'、'self.a'、'self.a.'、'self.a..'、
'x = self.'、'self.a.b.c'、'self.a.b.c.'、前导空格 ' self..'、尾随制表符
'self..\t')。批63 已实测 `ignore else` 不被 ast-v8-to-istanbul 采纳,本批
延续 `start … stop` 区间形态,区间上方逐条写明理由。

可达侧行为锁定(tests/pythonLanguageUtils.test.ts 由 7 用例增至 8 用例,
全部真实字符串直调,未放宽任何断言)——'self..' 双点输入仍归 endsWithDot
早退形状(rootSymbol null、fullPath '');'self.a..' 尾随多余点令 $ 锚定
失败整体归 null。两条锁死通往 ignore 区间的输入形状,兜底语义未裸奔。

分母口径(如实记,不美化):1 处区间移出 4 条臂 = 2 条不可达缺口臂 + 2 条
原已覆盖臂;两条被覆盖的三元赋值语句连同行一并移出分母——statements
4821→4819、lines 4711→4709(仍报 100%,但这是"被移出"而非"被补测覆盖",
在此登记);分支分母 2742→2738(-4),分子 2684-2=2682。本批未改动任何
生产逻辑,未暴露需要改动生产代码的缺陷,'近期由测试发现并修复的真实缺陷'
一节无新增条目。vitest 66 文件 837 用例(两种引擎口径全绿),mocha 烟测
11 用例。

批66 分支覆盖专项:先以 `pnpm test:coverage` 刷新 coverage-summary,按实测
压当时分支最低三件——monitoringWebView.ts 93.4%(99/106 臂)、
entityDependency.ts 94.1%(80/85 臂)、definitionSemantics.ts 94.8%
(128/135 臂),逐臂补测到 100%,行/语句/函数维持 100%;总分支
97.95%→98.64%(2682/2738→2693/2730)。三文件合计判定 15 条未覆盖臂,
其中 **11 臂可达 + 4 臂(4 个条目)契约性不可达并加 ignore**:

可达侧(新增 tests/monitoringWebViewBranches.test.ts 5 用例、
tests/entityDependencyBranches.test.ts 2 用例、
tests/definitionSemanticsBranches.test.ts 6 用例,全部真实例/真实临时文件
树,未放宽任何断言)——monitoringWebView 7 臂:onMetricsUpdate 回调在面板
未打开时的 no-op 臂(捕获式 fake collector 直接触发回调,panel 为 null 不
得触达 updateWebView)、诊断过滤器 'warning'/'error' 的下拉选中态
(`value="warning" selected`)、刷新间隔 1000/10000 选中态(真实
collector.setRefreshInterval 驱动 getHtml 读取)、历史窗口 120 选中态、
formatDiagnostic 的 error 分级臂(`diagnostic-item error` class)。另以
info 对照臂防误报。entityDependency 2 臂:entities.xml 只给 hasClient 的
注册实体(loadFromEntitiesXml 的 hasBase 假臂,types 保持 ['Client'],
对照 FDMix hasBase 真臂);FIXED_DICT implementedBy 内的非实体标量
`<Type>UINT32</Type>`(isEntityReference 的实体表 miss 假臂——'UINT32' 过
标识符正则但不在实体表),正对照注册实体引用照常产生引用与 fixed_dict 边。
definitionSemantics 6 臂:本地重复 `<hp>`/`<ping>` 在 loadResolved 生效
映射合并循环的 has() 真臂(parseProperties/parseMethods 解析不去重,第二条
撞 fullPath/方法名被跳过,首条保留);接口同名方法让位于实体自有方法
(自有 shared 先占位,IMix 的 shared 被跳过、onlyI 照常并入);父链同名
让位(自有 hp UINT8/ping 先占位,Par2 的 hp/ping 撞属性与方法 has() 真臂,
pp/other 照常并入);无 `<Type>` 子元素的属性(typeNode 为 null,typeName
与 arrayElement 走 `: undefined` 假臂)。

不可达侧(新增 4 处精确区间,移出 4 个分支条目 / 8 条臂 = 4 条不可达缺口
臂 + 4 条原已覆盖臂;真臂行为均由既有/本批正对照用例锁定)——
entityDependency 三处 has→get 不变式守卫:①L192 `if
(this.entities.has(reference.entityName))`:references 每条目都经
isEntityReference(`/^[A-Z]…$/.test(name) && this.entities.has(name)`)同步
过滤,且 analyze() 双遍扫描——第一遍(loadFromEntitiesXml + 逐文件
parseEntityFile)先建全实体表,第二遍 parseDependencies 才取引用,期间无
任何删除路径 ⇒ has() 恒真;②L201 `if (targetNode)` 与 ③L221
`if (parentNode)`:均在 has() 判真后立刻 get(),期间无表变更 ⇒ 恒非空。
三处区间只包 `if` 头一行,块体(建边/计数)保持在分母内继续被测。
definitionSemantics 一处:L596(现 L603)`const nestedArrayPropertiesNode
= typeNode ? getDirectChildElement(typeNode, 'Properties') : undefined`——
位于 `if (arrayOfType)` 块内,而 arrayOfType 只能由上一行三元取 typeNode
非空臂得到,typeNode 是不可变 const ⇒ 重检恒走真臂,`: undefined` 假臂无
触发路径;整条语句随区间移出分母。批63 已实测 `ignore else` 不被
ast-v8-to-istanbul 采纳,本批延续 `start … stop` 区间形态,区间上方逐条
写明理由。

分母口径(如实记,不美化):4 处区间移出 8 条臂 = 4 条不可达缺口臂 + 4 条
原已覆盖臂;4 条被覆盖语句连同行一并移出分母(entityDependency 3 个 `if`
语句 + definitionSemantics 1 条三元赋值)——statements 4819→4815、lines
4709→4705(仍报 100%,但这是"被移出"而非"被补测覆盖",在此登记);分支
分母 2738→2730(-8),分子 2682+15(新点亮)-4(移出的已覆盖臂)=2693。
本批未改动任何生产逻辑,未暴露需要改动生产代码的缺陷,'近期由测试发现并
修复的真实缺陷'一节无新增条目。vitest 69 文件 849 用例(两种引擎口径全
绿),mocha 烟测 11 用例。

批67 分支覆盖专项:审计计划 15 个功能块全部「已完成」、无 todo 可推进,
整体覆盖率转入收官——全库已无 0% 模块(行/语句/函数三项自批62 起全量
100%),按"覆盖率最低的 src 模块"取 codeGenerator.ts(95.1%,137/144 臂,
全库最低),逐臂补测到 100%,行/语句/函数维持 100%;总分支 98.64%→98.89%
(2693/2730→2695/2725)。共 7 条未覆盖臂,其中 **5 臂可达 + 2 臂(2 个
条目)契约性不可达并加 ignore**:

可达侧(新增 tests/codeGeneratorBranches.test.ts 4 用例,真实临时工作区树
+ 可脚本化窗口 stub,未放宽任何断言)——①generateDefFile 的
`path.isAbsolute(defOutputPath)` 假臂:internals 注入相对
defOutputPath('custom/defs'),落盘
`path.join(workspaceRoot,'custom/defs','Hero.def')` 并断言真实文件内容;
②showWizard 的 `if (this.config.generatePython)` 假臂与
`if (this.config.registerInEntitiesXml)` 假臂(关断双开关跑完整向导:只写
.def、不产 .py、entities.xml 未动、成功消息恰 2 条);③generateFromTemplate
的同名双开关关断臂(模板流:只写 .def、无额外提示)。另以裸工作区用例
锁定 resolveDefOutputPath 在无 entity_defs 目录时的"返回首选候选拼接
路径"行为(该用例不贡献分支分母,见下)。

不可达侧(新增 2 处精确区间,移出 2 个条目 / 4 条臂 = 2 条不可达缺口臂 + 2
条原已覆盖臂;真臂行为均由既有流程与本批裸工作区用例锁定)——①resolveDef
OutputPath 的 `findEntityDefinitionsRoot(workspaceRoot) || configuredPath`
兜底臂:findEntityDefinitionsRoot 的返回值即
getDefinitionWorkspaceLayout(workspaceRoot).entityDefsRoot,恒为非空字符串
(候选列表首项由 path.join 生成,相对路径最小结果是 '.',批62/64 已据同一
事实把该族空值臂判不可达;目录不存在时返回首选候选拼接路径而非 null)
⇒ `|| configuredPath` 无触发路径;②showWizard 类型链末端
`else if (selectedType.hasClient)` 判假臂:步骤 2 的类型选项为固定 7 项
字面量,每项 hasBase/hasCell/hasClient 至少一真,链式判断走到第三臂时
前两域必为假而 hasClient 必真 ⇒ 判假臂(不赋 clientProperties)无触发路径。
两处区间上方均逐条写明理由,批63 已实测 `ignore else` 不被
ast-v8-to-istanbul 采纳,延续 `start … stop` 形态。

分母口径(如实记,不美化):2 处区间移出 2 个条目,另 hasCell 条目
(`else if (selectedType.hasCell)`)的隐式 else 臂定位即被移除的 hasClient
行,随区间一并移出——合计 5 条臂离开分母 = 2 条不可达缺口臂 + 3 条原已
覆盖臂;2 条被覆盖语句连同行一并移出(return 语句 + hasClient if 语句)
——statements 4815→4813、lines 4705→4703(仍报 100%,但这是"被移出"
而非"被补测覆盖",在此登记);分支分母 2730→2725(-5),分子
2693+5(新点亮)-3(移出的已覆盖臂)=2695。本批未改动任何生产逻辑,未
暴露需要改动生产代码的缺陷,'近期由测试发现并修复的真实缺陷'一节无新增
条目。vitest 70 文件 854 用例(两种引擎口径全绿),mocha 烟测 11 用例。

批68 分支覆盖专项:按收官顺序压当时最低的 debugConfig.ts(95.2%,60/63 臂)
与 defRenamer.ts(95.2%,120/126 臂),逐臂补测到 100%,行/语句/函数维持
100%;总分支 98.89%→99.22%(2695/2725→2696/2717)。两文件合计 9 条未覆盖
臂,其中 **5 臂可达 + 4 臂(4 个条目)契约性不可达并加 ignore**:

可达侧(新增 tests/defRenamerBranches.test.ts 2 用例、
tests/debugConfigBranches.test.ts 1 用例,真实临时文件树/内存 fs 配置装载
+ 可脚本化窗口与 debug stub,未放宽任何断言)——defRenamer 5 臂:
listDefFilesRecursive 的非 .def 文件后缀过滤假臂(定义树混入 notes.txt);
parseDefFileSemantics 的无名 `<Interface/>` 跳过臂(`<Interfaces>` 内
无名自闭合引用与实名引用并存);闭包行走两处 seen 去重守卫假臂(父链成环
CycleA↔CycleB 且共享 SharedI 接口,第二次命中 CycleA 与 SharedI 时各触发
一次);loadSemantics 的 `content === null` 假臂(Ghosty.def chmod 000,
外层循环按 null 内容跳过它,但 Distant→Mid→Ghosty 的闭包行走把它从
ownerIndex 入队,绕过外层守卫真实命中)。可达臂全部在 defRenamer 侧;
debugConfig 侧 3 条未覆盖臂经逐条复核均为下述契约性不可达(批前
arms_dump 曾把 telnetHost 兜底臂误报为未覆盖,复测 coverage-final 计数
证实其早已覆盖,未覆盖者实为 telnetEnableCommands/Password/Layer 三处
同族兜底)。debugConfigBranches 新增用例不贡献分支分母,系行为锁定——
用户配置把 defaultTelnetHost 与组件 telnetHost 同时置空串,断言归一化
结果为 '' 且简报真实出现 'telnet 127.0.0.1 0'(telnetHost 兜底臂的
输入-输出双侧锁定)。

不可达侧(新增 3 处精确区间,移出 4 个分支条目 / 8 条臂 = 4 条不可达缺口
臂 + 4 条原已覆盖臂)——debugConfig 三处同族:startDebugging 组装 telnet
简报时 config 出自 getComponentConfig,其 telnetEnableCommands/
telnetPassword/telnetDefaultLayer 均已做同款 `||` 归一化且产出恒为真值
(`userConfig?.x || []/'pwd123456'/'python'`)⇒ 简报处的 `||` 兜底右臂
无触发路径(telnetLines 语句一处区间;password/default-layer 两个模板串
共处一个数组字面量,合并一处区间)。defRenamer 一处:collectRenameEdits
InText 的 `if (open)` 判空假臂——open 侧 tagStart/tagEnd 出自 defParser
tokenizeXml 的令牌回填,恒满足 tagStart ≥ 0、tagEnd > tagStart、不越界
⇒ 范围守卫对 open 侧恒假(close 侧由自闭合元素真实走到,批62 已定性其
正则臂不可达,本臂为同族范围守卫契约)。两处区间上方均逐条写明理由,
延续 `start … stop` 形态(批63 已实测 `ignore else` 不被采纳)。

分母口径(如实记,不美化):3 处区间移出 8 条臂 = 4 条不可达缺口臂 + 4 条
原已覆盖臂;2 条被覆盖语句连同行一并移出(debugConfig 的 telnetLines
语句与 defRenamer 的 if 语句;password/default-layer 两个模板串与所在
数组同属一个语句区,不另计独立条目,以 coverage-final 实测归账)——
statements 4813→4811、lines 4703→4701(仍报 100%,但这是"被移出"而非
"被补测覆盖",在此登记);分支分母 2725→2717(-8),分子
2695+5(新点亮)-4(移出的已覆盖臂)=2696。本批未改动任何生产逻辑,
未暴露需要改动生产代码的缺陷,'近期由测试发现并修复的真实缺陷'一节无
新增条目。vitest 72 文件 857 用例(两种引擎口径全绿),mocha 烟测 11 用例。

批69 分支覆盖专项:压当时剩余缺口序首位的 databaseSchema.ts(95.3%,
201/211 臂;复查 arms 数据,211 臂中 10 条未覆盖,与上轮自报一致),逐臂
补测到 100%,行/语句/函数维持 100%;总分支 99.22%→99.59%
(2696/2717→2700/2711)。10 条未覆盖臂中 **7 臂可达 + 3 臂(3 个条目)
契约性不可达并加 ignore**:

可达侧(新增 tests/databaseSchemaBranches.test.ts 4 用例,真实临时 def
树,点亮 7 条臂,全部以行为锁断言语义正当)——组件槽带
`<Persistent>false</Persistent>`:`children: isPersistent ? … : []` 的空数组
臂(组件不成表,断言之);组件类目 Parent:CompParent.def 自身带
`<Parent><GhostComp/></Parent>`,`parentCategory = category === 'component' ?
'component' : 'entity'` 的 component 臂 + (findDefinitionFileByCategory
落空后)三目 `parentCategory === 'entity' ? findEntityDefinitionFile(…) :
null` 的 null 尾臂(复核 coverage-final 确认该条目实为三目整体,条件假臂
位于 `null` 字面,此前未覆盖只因无组件类目父链用例;Lost/BadP/DirP 等实体
类目用具例走的是查找命中或 `||` 短路,不进此尾臂)——parentCategory 恒
'component' 时条件假、两路查找都已落空,parentPath 为 null,只损失父链
属性不崩;可用性门控:实体 hasClient=false + 组件 ClientMethods 非空,
registerScope('client', false) 走 `if (enabled)` 假臂(域不注册,组件表
照常建、域内属性正常入列);FIXED_DICT 内层 `<Type>ENTITY_COMPONENT</Type>`
(模块合成类型名出现在解析面,children 保持 undefined):追加层
`property.children || []` 兜底右臂(组件空表照建,反之不崩);未知旗标
`<Flags>TOTALLY_UNKNOWN</Flags>`:FLAG_SCOPE_MAP 查找落空的 `|| []` 兜底
臂(scopes 空 → 属性整体丢弃,断言列缺失);非数值的
`<DatabaseLength>abc</DatabaseLength>`:`Number.isFinite` 假 → undefined
回落臂(元素列继承 undefined 长度,断言之)。arms_dump 的条目行号经
coverage-final 原文复核(批68 同款流程),无误标。

不可达侧(新增 3 处精确单行区间,移出 3 个条目 / 6 条臂 = 3 条不可达缺口
臂 + 3 条原已覆盖臂)——① parsePropertyNode 的 `parentPath ? 嵌套名 :
平名` 模板串臂:parsePropertyNode 唯一调用点是 parsePropertySection(L515
透传),其唯一调用点在 L412 且未传 parentPath、落默认实参 '' ⇒ 左操作数
恒空串,模板串臂无触发路径(嵌套路径由 parseFixedDictChildren 的 childPath
独立构造,不经此三目);② FIXED_DICT 追加层的 `property.children || []`
右臂:FIXED_DICT 描述符的 children 由全部三个构造点
(parsePropertyNode/parseArrayElementDescriptor/parseFixedDictChildren)
恒赋为数组(至少为 []),clone 路径亦保持数组(注:此结论仅对 FIXED_DICT
成立,ENTITY_COMPONENT 侧无此保证,故该侧兜底臂按可达处理,见上);
③ createArrayTable 的 `property.name || 'values'` 右臂:元素名出自
defParser tokenizeXml,标签名正则 `[A-Za-z_][A-Za-z0-9_]*` 要求至少一个
字符,ARRAY 描述符名恒非空(顶层属性名来自标签名,ARRAY 内层元素名恒为
'value')。三处区间上方均逐条写明理由,延续 `start … stop` 形态。

分母口径(如实记,不美化):3 处区间移出 6 条臂 = 3 条不可达缺口臂 + 3 条
原已覆盖臂;3 条被覆盖语句连同行一并移出(L551 propertyPath 语句、
L819 for 语句、L844 tableName 语句)——
statements 4811→4808、lines 4701→4698(仍报 100%,但这是"被移出"而非
"被补测覆盖",在此登记);分支分母 2717→2711(-6),分子
2696+7(新点亮)-3(移出的已覆盖臂)=2700。本批未改动任何生产逻辑,
未暴露需要改动生产代码的缺陷,'近期由测试发现并修复的真实缺陷'一节无
新增条目。vitest 73 文件 861 用例(两种引擎口径全绿),mocha 烟测 11 用例。

批70 分支覆盖专项:按剩余缺口队列序位压 logWebView.ts(96.9%,31/32 臂),
逐臂补测到 100%,行/语句/函数维持 100%;总分支 99.59%→99.63%
(2700/2711→2701/2711)。未覆盖臂仅 1 条(arms_dump 与 coverage-final 原文
复核一致),为**可达臂,纯测试点亮,本批零 ignore、零生产改动**:

connectCollector 的 catch 兜底臂:collector.connect() 以**裸字符串拒绝**
(非 Error 实例)时 `error instanceof Error` 假臂 → `String(error)` 归一
(既有用例只覆盖了 Error 实例拒绝走 message 路径)。新增
tests/logWebViewPanel.test.ts 1 用例:以裸字符串拒绝的假 collector 替代
模块级 fake,走 show → 'connect' 消息 → panelRegistry 三通道入账,断言
error 通道出现 '日志连接不可用: port closed'——与既有 Error 路径共用同一
消息前缀,归一语义锁定。

分母口径(如实记,不美化):本批无 ignore 区间,分母 2711 不变,分子
2700+1=2701,无"被移出"条目。本批未改动任何生产逻辑,未暴露需要改动
生产代码的缺陷,'近期由测试发现并修复的真实缺陷'一节无新增条目。
vitest 73 文件 862 用例(两种引擎口径全绿),mocha 烟测 11 用例。

批71 分支覆盖专项:按剩余缺口队列序位压 logParser.ts(98.3%,59/60 臂),
逐臂收口到 100%,行/语句/函数维持 100%;总分支 99.63%→99.66%
(2701/2711→2700/2709)。唯一未覆盖臂(arms_dump 与 coverage-final 原文
复核一致)为 parseBatch 的 `if (entry)` 判空假臂,**契约性不可达,按既定
口径加 1 处精确单行区间 ignore,零新增测试、零生产改动**(派发约束"不写
不断言的假用例":点亮该臂只能 mock 静态方法返回 null,属假用例,不取):

parseLoggerMessage 对任意字符串输入全函数——try 块内只有字符串方法
(trimEnd/toLowerCase/trim)、正则匹配、Date 构造与 `\d` 捕获组的
Number() 转换,均不抛错;唯一 null 路径是 catch,而 catch 仅对非字符串
入参可达。parseBatch 逐行喂入 `split(/\r?\n/)` 的产物,恒为字符串 ⇒
`if (entry)` 假臂无触发路径。真臂(条目非空入列)行为由既有 parseBatch
用例锁定。区间上方逐条写明理由,延续 `start … stop` 形态。

分母口径(如实记,不美化):1 处区间移出 1 个分支条目 / 2 条臂 = 1 条
不可达缺口臂 + 1 条原已覆盖臂;1 条被覆盖语句(if 语句)连同行一并移出
——statements 4808→4807、lines 4698→4697(仍报 100%,但这是"被移出"
而非"被补测覆盖",在此登记);分支分母 2711→2709(-2),分子
2701-1(移出的已覆盖臂)=2700。本批未改动任何生产逻辑,未暴露需要改动
生产代码的缺陷,'近期由测试发现并修复的真实缺陷'一节无新增条目。
vitest 73 文件 862 用例(两种引擎口径全绿),mocha 烟测 11 用例。

批72 分支覆盖专项:按剩余缺口队列序位收官 entityMapping.ts(98.6%→100%)、
kbengineProtocol.ts(98.9%→100%)、explorerProviders.ts(99.2%→100%)、
extension.ts(98.4%→100%,唯一残差为 v8 负数伪影已登记)。四模块共登记
8 个契约性不可达/伪影臂条目(extension 1、entityMapping 4、
kbengineProtocol 1、explorerProviders 2),新增 8 处精确单行区间 ignore,
并新增 4 个真臂行为锁定用例(extensionBranches 2、entityMappingBranches 2)
——本段四模块收口实际执行于批73 之后的合并提交 2eae752,故其计数自批73
后的 2701/2709 起算(本批自身时点记录见批73 段):总分支 99.66%→100%
(2700/2709 → 2701/2709 → 2692/2692),行/语句/函数维持 100%:

extension.ts——`kbengine.entity.method.open` 的 `if (!didOpen)` 隐式 else 臂
(v8-to-istanbul 负数伪影,[4,-1]):批71 已登记该伪影系结构钉死,本批以 1 处
ignore 登记收口,真臂行为由既有装配用例与新增
tests/extensionBranches.test.ts 2 用例(字符串/identity 双形态)锁定。

entityMapping.ts——
- `getPythonCandidates` 的 interface 检查隐式 else 臂(owner.kind='entity'
  路径,契约上仅 entity 触达,测试难稳定驱动):`/* istanbul ignore */` 登记
  不可达,真臂由既有实体 Python 候选扫描集成用例间接锁定。
- `selectMethodDefinition` 的 `scored[0]?.item || null` 兜底右臂(matches
  长度>0 已守卫,map+sort 产出恒非空):ignore 登记不可达。
- `collectPythonOwnerFiles` 的 `candidate.section || ''` 与 `jumpToDef` 的
  `if (!location)` 隐式 else 臂:前者 section 恒显式传入(契约不可达),
  后者解析成功路径(可达但集成层难稳定复现)均 ignore 登记。

kbengineProtocol.ts——`queryWatcherPath` 中 `finish` 的 `if (timeout)` 隐式 else
臂(初始 setTimeout 竞态触发,connect 前触发概率极低且测试层以 fake timers
先发 connect 覆盖主流):ignore 登记竞态窗口,真臂由既有"lets a late data
frame rearm"与"keeps resolved result"用例锁定。

explorerProviders.ts——`DefinitionSectionItem` 子项展开的
`element.section.items || []` 与描述行渲染的
`section.items?.length ?? 0` 两处兜底右臂:所有
DefinitionSectionDescriptor 构造点均显式提供 items 数组(契约不可达),
ignore 登记,真臂由既有子项展开与描述行用例锁定。

分母口径(如实记,不美化):8 处区间移出 8 个分支条目 / 17 条臂——
逐臂构成为 9 条已覆盖真臂 + 8 条未覆盖死臂(含 2 条负数伪影
[2,-1]/[4,-1]);全仓 8 条未覆盖臂经此全数移出,0 条臂被点亮,新增的
4 个用例均为已覆盖真臂的行为锁定、不改变分母/分子状态(臂级取证:检出
be6ec24 实测 2701/2709,与收口后 coverage-final 按源码行文本做多集匹配
——移出条目恰 8 个、新增 0 个)。statements 4807→4798(-9)、
lines 4697→4689(-8、仍 100%)、branches 分母 2709→2692(-17)、
分子 2701→2692(-9,自批73 后起算;2700 为批71/72 时点,+1 为批73
真臂点亮)。本批未改动任何生产逻辑,未暴露需改动生产代码的缺陷。
vitest 74 文件 868 用例(两种引擎口径全绿),mocha 烟测 11 用例。
门禁四项全绿。

批73 分支覆盖专项:压缺口队列序首位的 serverManager.ts(98.6%,68/69 臂)
逐臂收口到 100%,行/语句/函数维持 100%;本批自身时点总分支 99.66%→99.7%
(2700/2709→2701/2709)——100% 结算由随后的合并提交 2eae752 完成(该收口
细节记于上文批72 段)。唯一未覆盖臂(arms_dump 与 coverage-final 原文复核
一致)为 startComponent 宽限定时器回调的
`if (this.runningServers.has(component.name))` 判空假臂——启动宽限期内
条目被移除且 timer 未被清时,守卫拦下陈旧定时器,不复活状态、不发
"启动成功"提示。既有删除点中 exit/error 处理器都会先 clearTimeout,
唯一不清 timer 的删除点是 `dispose()` 的 `runningServers.clear()`——
构造:注入"吞 kill"的 ProcessRunner 假进程(kill 只翻 killed 标记、
不触发 exit 事件),startComponent('machine') 成功后立即 dispose(),
宽限期(1000ms)过后 timer 到点即命中假臂。

可达侧(新增 tests/serverManager.test.ts 1 用例,真实临时二进制树 +
configPath 配置覆盖 + 注入型 runner)——断言链:startComponent 返回
true 且状态 Starting;dispose 后 runningServers 清空;宽限期过后无
"启动成功"提示、状态保持 Stopped(守卫静默语义锁定)。

分母口径(如实记,不美化):本批零 ignore、零分母变动,分子
2700+1=2701,statements/lines/functions 三项 100% 均无移出。
vitest 73 文件 864 用例(两种引擎口径全绿),mocha 烟测 11 用例。
门禁四项首跑全绿,无瞬态异常。

剩余缺口按序(批73 后):entityMapping(98.6%)、kbengineProtocol(98.9%)、
explorerProviders(99.2%);serverManager 已收官,extension 残差为批72
已登记伪影(上述三者与伪影残差随后由合并提交 2eae752 收口,见上文批72 段)。

批74 分支覆盖专项(复核 + 记账修正):派发目标为 extension.ts(98.4%);
经核该缺口已于批72-73 系列提交收口(52e5db5 / be6ec24 / 2eae752,均已在
origin/main),本批做独立复核与失实记账修正——零生产改动、零新用例、
零新 ignore 区间:

复核(全量覆盖率实测)——总分支 Branches 100%(2692/2692)、Statements
100%(4798/4798)、Functions 100%(838/838)、Lines 100%(4689/4689);
extension.ts 单文件分支 60/60、语句 100%。臂级取证:检出收口前提交
be6ec24 实测 2701/2709,与收口后 coverage-final 按源码行文本做多集匹配
(条目键值随注记插入移位、不可直接比对)——移出条目恰 8 个、新增 0 个,
移出 17 臂 = 9 条已覆盖真臂 + 8 条未覆盖死臂(全仓未覆盖臂恰为 8,全数
移出、0 点亮),分子 2701−9=2692、分母 2709−17=2692 精确闭合。

修正(合并提交 2eae752 重写 TESTING.md 引入的三处失实,按上述实测改正):
- 头部 ignore 计数段:删除「批73 在 serverManager.ts 新增 1 处」子句
  ——serverManager.ts 全文零 istanbul 注记(最后改动停在批53)且批73
  段自述零 ignore;删除后逐批累加恰为 64 处,与 grep 实况一致。
- 批72 段分母口径:「16 条臂 / 12 条不可达 / 4 条可达臂点亮 / 分子
  2700→2692」按臂级取证改正为「17 臂 = 9 覆盖 + 8 未覆盖 / 0 点亮 /
  分子 2701→2692」;开头补记四模块收口落于批73 之后的合并提交。
- 批73 段:恢复其自身时点实测记录(总分支 99.66%→99.7%、分子
  2700+1=2701、vitest 73 文件 864 用例、队列行)——合并提交误写为
  「总分支 100% 维持、2692+1=2692、74 文件 868 用例、队列清零」。

门禁:pnpm lint EXIT=0;npx vitest run 与 KBENGINE_ROOT=off npx vitest run
同为 74 文件 868 用例全绿;pnpm test EXIT=0(mocha 烟测 11 passing)。
无 tag、无 release、无 force push。

剩余缺口按序(批74 后):**无**——全模块 Branches/Statements/Lines/Functions
均已达 100%。后续批次如有新增源码,按同口径增量覆盖。

## 批75:「由 mocha 层覆盖/补充」声明核对(零新用例、零生产改动)

背景:vitest 覆盖率已全 100%(台账 2692/2692 臂),但 TESTING.md 多处残余
段落仍写「由 mocha 层(域)覆盖/补充」——这些声明写于批56 裁剪前,而批56
起 mocha 层已裁为编译产物烟测(3 文件 11 用例:manifest 3、out/extension.js
装配激活 5、out/languageProviders.js 补全/悬停/重命名 3),上述残余区域
无一在册。本批逐条到 mocha 与 vitest 两层找实证,结论:**8 处声明全部过期,
所指区域均已在 vitest 有具名用例,零真缺口、零补测**。

逐条核对结果(已覆盖 → 实证用例名/文件):

1. entityMapping(watcher 事件 + 10.6% 索引回溯/绑定 fallback/防御分支)
   → entityMappingManager.test.ts「watcher and lifecycle」、
   entityMappingFallback.test.ts「walks from an interface symbol back to
   the referencing entity index」「regex-scans owner candidate files when
   no python binding matches」、entityMappingGaps.test.ts「resolves a
   component owner through the referencing entity index」、
   entityMappingBranches.test.ts。模块 270/270 臂 100%。
2. monitoringCollector(startTimer 定时器 refresh 循环 + 事件行为)
   → monitoringCollectorGaps.test.ts「starts a repeating timer that
   survives several ticks」(start(40) 真间隔连跑多轮)、
   monitoringCollectorBranches.test.ts「start 在暂停态只记间隔…」「collapses
   concurrent refresh calls…」;onMetricsUpdate 真实订阅断言在
   monitoringCollectorSocket.test.ts 与 monitoringPanel.test.ts。
3. codeGenerator 向导(7.6% 零散分支组合)→ codeGeneratorGaps.test.ts
   「showWizard sample property branches」等、codeGeneratorBranches.test.ts
   showWizard/showTemplates 编排、codeGeneratorFiles.test.ts 落盘全链。
4. monitoringWebView(50.4% 面板生命周期/定时刷新/导出)→
   monitoringPanel.test.ts 17 用例(批27 搬入,原文第二句已自述,仅删去
   过期归因半句)。
5. debugConfig(63.3% startDebugging 会话与 PID 输入框)→
   debugConfigAttach.test.ts「DebugConfigManager.startDebugging」
   「DebugConfigManager.promptForProcessId」两 describe。
6. explorerProviders(74.2% type 深结构/方法命令/getChildren 下钻)→
   explorerTreeDeep.test.ts(含叶命令断言 kbengine.database.open)、
   explorerProvidersBranches.test.ts。
7. languageProviders(64.2% validateDefStructure/方法实现跳转/schema
   虚拟文档跳转/防御分支)→ validateDefStructure 经 validateDocument
   诊断用例驱动(src/languageProviders.ts 内部调用);方法实现跳转在
   languageProvidersInternals.test.ts「def method implementation jumps」;
   schema 正反向跳转在同文件「database schema cross jumps」;防御臂在
   languageProvidersBranches.test.ts。
8. explorerProviders 树控件装配(96.7% 残余)→ extension.ts 两处
   registerTreeDataProvider 由 vitest extension.test.ts 覆盖
   (treeRegistrations 与 manifest 双向核对),mocha 激活烟测「registers
   the tree views declared by the manifest」同口径互证——此条是唯一
   mocha 层确有实证的声明,现两层齐备。

同步修正:tests/ 下 6 处同源过期注释(codeGenerator/languageProviders/
languageProvidersGaps/entityMappingManager/explorerProviders/databaseSchema
各文件的头部注释)改按实证归属;tests/extension.test.ts 的「只有 mocha 层
间接触达(问题 P14),现在进 vitest 覆盖率分母」为历史叙述,表述属实,保留。
补测判定:被指区域全部两层核查后均有 vitest 实证,按「已覆盖」记账,
无「已补」项,无「不可测」项;产品代码零改动。

门禁:pnpm lint EXIT=0;npx vitest run 与 KBENGINE_ROOT=off npx vitest run
同为 74 文件 868 用例全绿;pnpm test EXIT=0(vitest 全量 + 编译 + mocha
烟测 11 passing)。

剩余缺口按序(批75 后):**无**——本批为声明核对,无覆盖率变化。

## 批76:全量复核 + 无断言用例补真断言(覆盖率无变化,维持 100%)

派发口径要求「挑当前最低覆盖且可离线测的模块补单测」。首手复核
(npx vitest run --coverage 全量,json-summary 逐文件):分母 25 个
src 文件(分母口径 src/**、排除 src/test/**,vitest.config 证实)
Statements/Branches/Functions/Lines 全部 100%——总账 4798/4798、
2692/2692、838/838、4689/4689,与批72-73 收口台账一致。**「最低覆盖
模块」不存在,补测选择前提为空**:对 100% 模块再补用例只能是重复断言
或凑数,违反「不写不断言的假用例」铁律,故本批零盲补。

改做两层真实缺口扫描,发现并收口一处:

- 断言用例扫描(脚本化逐 it 块检查 expect/assert 存在性,77 个测试
  文件全量):仅 tests/monitoringPanel.test.ts「triggers collector
  refresh on the refresh command」只靠 until 超时兜底、无结果断言——
  批76 补真断言:refreshNow 恰触发一次(refreshed===1,防双发)、
  采集器生命周期零副作用(不重发 start、不 stop、不改暂停态)。
- skip/only 扫描:零 it.skip/describe.skip/test.skip/.only;仅
  hooks/kbengineMetadata/kbengineProtocol 三套「vs engine source」
  describe.skipIf 按环境跳过(本机与 CI 均无同级 kbengine 检出,
  离线不可测,已在「引擎源码条件测试」节登记)。

记账说明:本批用例数 868→868(改动为既有用例体内增断言,不新增
it),覆盖率四指标维持 100%,分母无变化。mocha 烟测 11 用例不变。

门禁:pnpm lint EXIT=0;npx vitest run 与 KBENGINE_ROOT=off npx vitest run
同为 74 文件 868 用例全绿;pnpm test EXIT=0(mocha 烟测 11 passing)。

剩余缺口按序(批76 后):**无**——全模块四指标 100% 维持,队列持续为空;
后续批次如有新增源码,按同口径增量覆盖。

## 批77:「由 mocha 层覆盖/补充」声明复核(零新用例、零生产改动)

派发与批75 同题(核对 TESTING.md 内「由 mocha 层覆盖/补充」残余声明)。
开工核查:批75(`3106ab7`)已抽 8 条清单并逐条落 vitest 实证、批76(`0ed994a`)
复核在案,残余表述现均带「已过期」定语,无未核对声明。本批做独立复验:
8 条所指区域逐条 grep 实证(用例名/文件与批75 登记一致,现复述以存证),
结论:**维持批75 定案,零真缺口、零补测**。

复验结果(已覆盖 → 实证用例名/文件,均为本批亲手 grep 确认存在):

1. entityMapping watcher 事件 → entityMappingManager.test.ts
   「watcher and lifecycle」(fireChange 重扫 owner/无关路径 no-op/dispose
   幂等 3 用例);索引回溯/fallback → entityMappingFallback.test.ts
   「walks from an interface symbol back to the referencing entity index」
   「regex-scans owner candidate files when no python binding matches」、
   entityMappingGaps.test.ts「resolves a component owner through the
   referencing entity index」;防御臂 → entityMappingBranches.test.ts。
2. monitoringCollector 定时器/事件 → monitoringCollectorGaps.test.ts
   「starts a repeating timer that survives several ticks」
   「collapses concurrent refresh calls with an in-flight guard」、
   monitoringCollectorBranches.test.ts「start 在暂停态只记间隔,不起定时器
   也不刷新」;onMetricsUpdate 真实订阅在 monitoringCollectorSocket.test.ts
   与 monitoringPanel.test.ts(「pushes collector updates into the live
   panel html」)。
3. codeGenerator 向导 → codeGeneratorGaps.test.ts「showWizard sample
   property branches」「creates missing output directories recursively」
   「reports 生成失败 when the workspace is gone」、
   codeGeneratorBranches.test.ts showWizard/showTemplates 编排、
   codeGeneratorFiles.test.ts 落盘全链。
4. monitoringWebView 面板 → monitoringPanel.test.ts 17 用例(逐 it 计数确认)。
5. debugConfig 会话/PID 框 → debugConfigAttach.test.ts
   「DebugConfigManager.startDebugging」「DebugConfigManager.promptForProcessId」
   两 describe(18 处匹配)。
6. explorerProviders 深结构 → explorerTreeDeep.test.ts「expands type
   definitions with alias, properties and python sections」「expands grouped
   sections via DefinitionGroupItem and ungrouped sections directly」
   (含叶命令 `kbengine.database.open` 断言)、explorerProvidersBranches.test.ts。
7. languageProviders → languageProvidersInternals.test.ts「def method
   implementation jumps」「database schema cross jumps」、
   languageProvidersBranches.test.ts;validateDefStructure 经 validateDocument
   诊断用例驱动(内部调用)。
8. 树控件装配 → vitest extension.test.ts treeRegistrations 与 manifest 双向
   核对 + mocha activationSmoke.test.ts「registers the tree views declared
   by the manifest」——唯一 mocha 层确有实证的声明,两层齐备。mocha 现状
   复核:manifest 3 + activationSmoke 5 + providerSmoke 3 = 11 用例,与批75
   登记一致。

门禁环境注记(瞬态环境问题,非仓库缺陷,按既定口径复跑定性):本批首跑
`npx vitest run` 连续两次 69-70 文件收集失败——vite SSR 缓存写 /tmp 逢
ENOENT、FakeComponentBin 落盘逢 `Unknown system error -122` 写失败。
查因为共享 /tmp(tmpfs 81% 满)写配额耗尽(EDQUOT),与仓库代码无关。
改走 `TMPDIR=/home/cui/.cache/kode-tmp`(宿主盘 644G 空闲)后四门全绿,
复跑稳定,无需代码动作。

门禁:pnpm lint EXIT=0;npx vitest run 与 KBENGINE_ROOT=off npx vitest run
同为 74 文件 868 用例全绿(TMPDIR 隔离后);pnpm test EXIT=0(vitest 全量 +
编译 + mocha 烟测 11 passing)。

剩余缺口按序(批77 后):**无**——本批为声明复核,无覆盖率变化。

## 批78:变异抽检扫「被覆盖但未锁定」缺口(logParser 双存活收口,+1 用例)

派发口径为「找最大未测试模块/分支缺口补真测」。覆盖率数量维度已 exhausted:
HEAD(含并行批77 复验提交)首手全量复测仍四指标 100%,并补做一项此前
未做过的隐身核查——v8 覆盖率只报被加载模块,src/ 实有文件数与报告条目数
25=25 精确吻合,**不存在从未被任何测试加载而隐身于报告的源文件**。

本批改用**变异抽检**度量「未测试的真实缺口」(100% 行/臂覆盖≠行为锁定):
对 7 个模块施放 8 个语义变异(常量/边界/正则/映射四类),逐一精准替换
后先跑最相关测试文件、存活再跑全量确认,完毕即还原。首轮 6 个变异因
脚本引号缺陷未写入文件即误报存活,判废重跑(文件零污染,不计结论)。
有效结果 8 变异:**6 杀**——kbengineProtocol 广播端口 20086±1
(kbengineProtocol.test.ts,非引擎条件套件所杀)、monitoringCollector
默认刷新间隔 2000±1、serverManager bots gus 参数、debugConfig telnet
端口种子、logWebView escapeHtml 实体大小写、workspacePath win32/posix
判别正则各被对应测试文件击杀;**2 存活**(真缺口,均在 logParser,即
「被覆盖但未被锁定」):

- `COMPONENT_NAMES[10]='logger'` 漂移全量不可见——映射表此前只被
  componentType 6(baseapp)与 99(兜底)两处断言,其余 10 个表项
  无任何断言。收口:新增「resolves every known component type to its
  engine name」逐项锁死 12 个引擎组件类型名(19 字节 LOG_ITEM 最小
  缓冲逐项解析断言)。
- `formatLogEntry` 的级别列 `padEnd(8)` 漂移到 12 全量不可见——原
  断言用 `toContain`,对尾随填充天然免疫。收口:改精确 `toBe` 锁定
  「ISO 时间戳 + 级别列 8 宽 + 组件列 12 宽 + 段式拼接」全串,并加
  8 字符级别/超宽组件用例锁「长值不截断」侧。

变异复验:两存活变异重新施放后均被新用例击杀(各恰挂新用例,其余
14 用例不受扰)。执行事故如实记:抽检脚本首轮引号缺陷已判废重跑,
结论以上述有效轮为准。

记账:用例 868→869(净 +1:新增 1 用例,强化 1 用例体);覆盖率重测
四指标维持 100%(4798/4798、2692/2692、838/838、4689/4689),分母
无变化——本批为行为锁定增量,非覆盖率增量。TMPDIR 隔离
(/tmp/kode-b78-tmp)沿用批77 的共享 /tmp 污染规避经验。

门禁:pnpm lint EXIT=0;npx vitest run 与 KBENGINE_ROOT=off npx vitest run
同为 74 文件 869 用例全绿;pnpm test EXIT=0(mocha 烟测 11 passing)。
无 tag、无 release、无 force push。

剩余缺口按序(批78 后):**无**——覆盖率数量维度持续满格;后续覆盖率
批次如无新增源码,建议沿用变异抽检/断言强度扫描类「质量维度」清扫。

## 批79:变异抽检第二轮(8 施 7 杀 1 存活,monitoringWebView CPU 阈值补锁,+1 用例)

延续批78 口径,第二轮变异覆盖批78 未抽的模块(databaseSchema/
entityDependency/monitoringWebView/codeGenerator/logCollector/
languageProviders/explorerProviders/extension),8 个语义变异:

- 7 杀:databaseSchema mysql 列型映射 UINT8→tinyint signed
  (databaseSchemaDeep.test.ts,全量 vitest 层)、entityDependency
  继承边 label '继承'(entityDependencyAnalyzer.test.ts,全量 vitest
  层)、codeGenerator Cell 类名后缀、logCollector 心跳 1000ms、
  languageProviders TOP_LEVEL_DEF_TAGS 顶标签表、explorerProviders
  'Definition file not found'、extension 状态栏 priority 100 各被
  对应测试文件定向击杀。
- 1 存活(真缺口):monitoringWebView `formatMetricCard` 的 CPU 阈值
  `>80` 漂移为 `>81` 全链(vitest 双口径 + mocha)不可见——既有阈值
  用例取值 90/60/10 全在远端,(80,81] 与 (50,51] 边界无断言。收口:
  新增「locks the exact cpu thresholds 80 and 50」四点锁(81 error、
  80 落 warning、51 warning、50 中性),同时锁死 80/50 两阈值;
  变异复验重施被新用例击杀(恰挂新用例,其余 16 用例不受扰)。
- 执行注记:批78 简版回退路径把「pnpm test 内的全量 vitest 击杀」
  误标为 mocha 层,本批对 M9/M10 复核定正(实为 databaseSchemaDeep/
  entityDependencyAnalyzer 所杀);记录归因时以击杀用例文件为准。

记账:用例 869→870(净 +1);覆盖率重测四指标维持 100%(4798/4798、
2692/2692、838/838、4689/4689),分母无变化——行为锁定增量。

门禁:pnpm lint EXIT=0;npx vitest run 与 KBENGINE_ROOT=off npx vitest run
同为 74 文件 870 用例全绿;pnpm test EXIT=0(mocha 烟测 11 passing)。
无 tag、无 release、无 force push。

剩余缺口按序(批79 后):**无**——两轮变异抽检 16 施 13 杀 3 存活
(均已收口),测试行为锁定强度持续加固;后续如无新增源码,可继续
抽样或转向其他质量维度。

## 批80:过期忽略区间审计(64 区全剥离探针,零过期,忽略台账诚实)

覆盖率台账前提核实:全量 coverage 四指标维持 100%(4798/4798、2692/2692、
838/838、4689/4689),台账无剩余可达缺口。本批转向最后一个未审计维度——
「被移出分母的区间」:v8/istanbul `ignore start/stop` 注记把 64 个区间移出
覆盖率分母,若其中有过期者(区间内代码实际可达且已被覆盖),分母即被压低、
100% 名不副实。方法:逐区间机械剥离两条注记行 → 定向测试 + coverage,与
固化基线比对分支/语句分母,判定 OBSOLETE(分母增长且全覆盖→摘除忽略诚实
扩分母)/ DEAD-REAL(分母增长但有未覆盖臂→忽略有真实守护物)/ NO-ARM
(无变化→幽灵注记):

- 结果:64/64 区间(17 文件)全部 **DEAD-REAL**,零 OBSOLETE、零 NO-ARM、
  零语句增长无覆盖——每个忽略区间内都存在测试不可达的真臂(典型形态:
  剥离后分支 +2、覆盖 +1,即区间内恰有一支永不执行)。
- 全局复核排除定向偏差:一次性剥离全部 64 区跑**全量** vitest(rc=0 绿),
  17 个受影响文件全部出现真未覆盖臂——languageProviders 分支 534→566
  (未覆盖 15)、definitionWorkspace 178→212(未覆盖 14)、entityMapping
  270→284(未覆盖 8)、defParser 86→98(未覆盖 6)等,无一文件「增长后
  仍全覆盖」。若摘除全部忽略,分支分母将扩至约 2842、约 114 臂未覆盖,
  100% 即不可达——现有忽略正是 100% 得以诚实成立的原因。
- 附带事实:剥离全部注记后全量测试仍绿——测试行为不依赖覆盖率注记。

环境变化注记:批79 后同级 KBEngine 检出(`../kbengine`,git HEAD 0bc93d5)
在本机就位,引擎条件套件(hooks 回调逐行配对/类型注册表/Flags 字面量,
共 9 用例)首次在本机真实运行并全绿——默认口径由 870 升至 879;
`KBENGINE_ROOT=off` 关引擎口径维持 74 文件 870 用例不变(见「引擎源码
条件测试」节的 CI 口径说明)。

记账:零新用例、零生产改动;覆盖率维持四指标 100%,分母无变化——64 个
忽略区间经审计全部合法保留,忽略台账与分母诚实。

门禁:pnpm lint EXIT=0;npx vitest run 74 文件 879 用例全绿(引擎在位
新口径);KBENGINE_ROOT=off npx vitest run 74 文件 870 用例全绿;
pnpm test EXIT=0(vitest 879 + 编译 + mocha 烟测 11 passing)。
无 tag、无 release、无 force push。

剩余缺口按序(批80 后):**无**——台账 100% + 64 忽略区间审计零过期,
分母内侧(被移出区间)亦无可达缺口;覆盖率维度在无新增源码前提下已无
剩余动作。

## 批81:外部质量轮(lint 复核 + 依赖安全审计 + 文档命令漂移核对,dev 依赖漏洞 16→0)

- pnpm lint 复核:EXIT=0,无告警。
- 依赖安全审计:`pnpm audit --prod` 零漏洞(生产依赖干净);全量审计
  16 项(12 高危 + 4 中危)全部位于 dev 传递依赖——brace-expansion×3
  (展开 DoS)、js-yaml×4(合并键二次方 CPU DoS)、nanoid×3(死循环/
  整数溢出)、postcss×4(任意文件读/路径穿越)、vite×2(server.fs.deny
  绕过、launch-editor NTLMv2 泄露),全部有补丁版本。
- 修复(沿用项目既有 `pnpm.overrides` 钉版机制,均为同 major 内升级):
  brace-expansion 1.1.13→1.1.18、nanoid 3.3.8→3.3.18(存量钉版落后于
  新 advisory 补丁线);新增 js-yaml 4.3.2、postcss 8.5.23、vite 7.3.5
  (原未钉)。复核:双审计(–prod 与全量)均 "No known vulnerabilities
  found"。install 有一条 @types/node peer 警告(vite 7.3.5 声明
  peer ^22||>=24,工程锁 20.19.37;类型层提示,非运行时依赖,不阻塞)。
- README/TESTING 文档与实际命令漂移核对:**零漂移**——README 引用的
  7 个脚本(compile/package/docs:dev/test/watch/test:unit/test:coverage)
  全部存在于 package.json scripts 且描述与实现一致;文件引用 5 处
  (docs/guide/configuration.md、resources/docs 三件、docs/redesign.md)
  全部存在;片段计数 11/4/2 与三个 snippet 文件实数一致;vsix 文件名
  kode-0.1.0.vsix 与 name+version 一致;Node 版本线与 engines 及
  .nvmrc(22.12.0)一致;测试架构段(两 runner 分层、mocha 11 用例)
  与本批门禁输出一致。TESTING.md「运行」三命令
  (test/test:unit/test:coverage)逐字实测通过。

记账:零 src/ 生产改动;依赖面收口——dev 传递依赖漏洞 16→0,
生产依赖维持 0。

门禁:pnpm lint EXIT=0;npx vitest run 879 用例全绿(引擎在位);
KBENGINE_ROOT=off npx vitest run 870 用例全绿;pnpm test EXIT=0
(vitest + 编译 + mocha 烟测 11 passing);另验 pnpm docs:build EXIT=0
(被钉 vite 服务 vitepress 正常构建)。
无 tag、无 release、无 force push。

剩余外部质量动作(批81 后):**无**——lint 干净、依赖漏洞出清、
文档零漂移;后续外部轮按需跟进 dependabot 周期告警与新 advisory。

## 批82:覆盖率确认批次(全 25 源文件 100% 维持,无低覆盖率文件)

本批为**纯确认批次**:全量覆盖率台账显示全部 25 个非生成源文件(`include: ['src/**/*.ts']`, `exclude: ['src/test/**']`)四指标(Statements/Branches/Functions/Lines)均为 **100% (4798/4798 | 2692/2692 | 838/838 | 4689/4689)**;报告条目 25 = 入口文件 25,无隐形模块。行覆盖率最低者即 100%,**无 0% 或 <100% 覆盖率文件**。故"挑行覆盖率最低或 0% 的非生成源文件补单测"这一动作在无新增源码前提下**无对象可施**,不造假用例,仅记账确认。

门禁:pnpm lint EXIT=0;npx vitest run 879 用例全绿(引擎在位);KBENGINE_ROOT=off npx vitest run 870 用例全绿;pnpm test EXIT=0(vitest + 编译 + mocha 烟测 11 passing)。覆盖率四指标全 100% 维持。

无 tag、无 release、无 force push。

剩余覆盖率动作(批82 后):**无**——台账 100% + 64 忽略区间审计零过期(批80) + 变异抽检三轮 16 施 13 杀 3 存活全收口(批78/79);后续覆盖率轮次仅在新增源文件或重构改动时按需跟进。

## 批83:变异抽检第三轮(8 施 6 杀 2 存活,start 缺省参与 Persistent 'yes' 双锁,+2 用例)

前置核实(批80 口径):全量覆盖 25 个非生成源文件四指标 100%
(4798/4798、2692/2692、838/838、4689/4689),无 0% 或 <100% 文件;
忽略区间台账 64 对/17 文件与批80 审计基线一致,其间无 src 改动,
批80 全剥离扫描结论(64/64 DEAD-REAL、零过期)维持有效。批82 号已由
上游并发会话的纯确认批次占用,本批按批次号顺延为批83(非交互假设注明)。

第三轮 8 个语义变异(选样避开批78/79 已抽模块,覆盖 kbengineProtocol/
monitoringCollector/definitionSemantics/entityMapping/defParser):

- 6 杀:MACHINE_BROADCAST_PORT 20086→20087、CONSOLE_WATCHER_CB_MSG_ID
  65502→65503(kbengineProtocol.test.ts)、refreshIntervalMs 默认
  2000→3000(monitoringCollector.test.ts)、sameIdentity 的 sourceChain
  分隔符 ::→##(定向面漏、全量层击杀)、DEF_METHOD_SECTIONS
  'ClientMethods' 改名(定向面漏、全量 37 例击杀)、swapUint16 掩码
  0xff→0xfe(kbengineProtocolSocket.test.ts)。
- 2 存活(真缺口,均经「替换后断言 + 全量 879 绿」严谨复验):
  M4 `start()` 缺省参 1000 无断言(→4000 全量不可见);M5
  parseOptionalBoolean(仅 Persistent 字段走此路径)的 'yes' 拼写无
  断言——既有 Identifier 布尔表是独立解析面(未知值回落 false,与
  本函数回落 undefined 语义不同),删 token 全量不可见。
- 收口(+2 真用例):monitoringCollector.test.ts「defaults the no-arg
  start to the 1000ms interval without waking the loop」(paused 下无参
  start 走缺省参赋值,零副作用锁 1000 与 paused 态不变);
  definitionSemantics.test.ts「maps every Persistent spelling through
  the optional boolean tokens」(true/1/YES→true、false/0/no→false、
  未知→undefined,连带锁 trim+lowercase 归一)。变异复验:重施 M4/M5
  均恰挂新用例击杀,其余用例不受扰。

记账:用例 879→881(引擎在位口径;关引擎 870→872);覆盖率重测四指标
维持 100%,分母无变化——行为锁定增量。coverage/coverage-summary.json
已同步重测,该目录 gitignored 不入库,状态以本台账记录为准。累计变异
抽检 24 施 19 杀 5 存活(全部收口;批82 段「三轮 16 施」系指批78/79
两轮累计,本批起为真实第三轮)。

门禁:pnpm lint EXIT=0;npx vitest run 74 文件 881 用例全绿;
KBENGINE_ROOT=off npx vitest run 74 文件 872 用例全绿;pnpm test
EXIT=0(vitest + 编译 + mocha 烟测 11 passing)。
无 tag、无 release、无 force push。

剩余覆盖率动作(批83 后):**无**——三轮变异累计 24 施 19 杀 5 存活
全收口;后续轮次仅在新增源码或按需抽检时跟进。

## 批84:变异抽检第四轮(9 施 6 杀 3 存活,2 真缺口收口 + 1 语义等价,+3 用例)

批次号:批82/批83 已被并发会话占用并入库(`5c8311f`、`962ac94`),本批
顺延为批84(仓库既有惯例,非交互假设注明)。并发会话的三个测试文件在本批
执行期间已自行修复并提交,本批未纳入、未改写其任何内容。

前提核实(批80/83 口径):全量覆盖 25 个非测试源文件四指标 100%
(4798/4798、2692/2692、838/838、4689/4689),报告条目 25 = 25 无隐形模块;
逐文件行覆盖率最低者即 100%,零文件 <100% —— 「挑行覆盖率最低或 0% 的
非生成源文件补单测」无对象可施,按协议转变异抽检。

第四轮 9 个语义变异(选样避开批78/79/83 已抽模块,覆盖 defParser/
defRenamer/definitionWorkspace/definitionSemantics/entityMapping/
entityDependencyWebView/pythonLanguageUtils):

- 6 杀:M1 defParser `hasTruthyChildTag` 真值表删 'yes'(definitionSemantics
  .test.ts 的 truthy 拼写例,定向面即杀)、M5 entityMapping
  `scoreMethodDefinition` 的 componentSlotName 权重 30→5
  (entityMappingBranches.test.ts)、M6 entityDependencyWebView Cell 类型
  emoji 🟢→🔵(entityDependencyWebView.test.ts + entityDependencyPanel
  .test.ts)、M7 pythonLanguageUtils `self.` 链式访问改为单段
  (pythonLanguageUtils.test.ts)、M8 definitionWorkspace implementedBy
  模块名点号转斜杠反向(definitionWorkspace.test.ts + ...Branches.test.ts)、
  M9 definitionSemantics 缓存键丢弃 allowComponents 维度(新增护栏击杀,
  见下)。
- 2 存活(真缺口,已收口):
  - M2 defRenamer `isIdentifierChar` 的标识符字符类剔除 `_`——既有 fixture
    只有 hp/mp/move 这类无下划线短名,词区间在下划线处截断后与元素名不等,
    蛇形符号(`max_hp`)的重命名解析**直接返回 null**(功能整体失效)却
    四层全不可见。收口:新增「snake_case 符号名整体成一个词…」把光标放在
    下划线**之后**,锁整名解析 + 开/闭两处编辑切名 + 词尾退化位。
  - M3 definitionWorkspace `normalizeXmlText` 空白折叠量词 `\s+`→`\s`——
    既有 rawValue 断言全是单空格串('a < b'/'UINT16'/FIXED_DICT),量词漂移
    后 rawValue 原样保留多空格,四层不可见。收口:新增 fixture `SPACED`
    (行内三连空)与 `MULTILINE`(缩进换行跨行文本),锁 rawValue /
    aliasType / structure.rawValue 三处折成单空格。
- 1 存活(语义等价,**非缺口**,如实登记不补用例):M4 definitionSemantics
  缓存键标签 `'components'` / `'plain'` 互换——`resolvedCache` 是实例私有
  Map,键仅在进程内做 (category,name,allowComponents)→键 的一一映射,标签
  文本无任何外部可观测面(不落日志、不序列化、不跨实例共享),互换后仍是
  双射,原理上不存在能杀死它的用例。变异态下全量 vitest + 编译 + mocha 全绿
  即「无差异」的实证。**但**顺着它发现一处相邻真实隐患:既有两例
  (component-inclusive / component-free)各自新建 loader,只锁单模式结果,
  未锁「同一 loader 上两模式的缓存键判别」。收口:新增「keeps
  component-inclusive and component-free results in separate cache
  entries」在同一 loader 上双向互查,并用 M9(键退化为 `category:name`)
  验证该护栏精确击杀(恰挂新用例,其余用例不受扰)。

变异复验:M2/M3 重施后均被新用例击杀(各恰挂对应新用例)。累计变异抽检
33 施 25 杀 8 存活,其中真缺口 7 个全部收口,语义等价存活 1 个(M4)。

执行事故与归因更正(如实记):M2/M3 首轮曾被判「全量击杀」,复核日志形态
发现那两条 `FAIL tests/databaseSchema.test.ts [ tests/databaseSchema.test.ts ]`
**没有 AssertionError**——是并发会话当时未完成版本里 `await` 出现在非
async 回调的语法错误导致的**收集错误**,恰好把全量回退跑红,归因无效。
在干净树重跑后二者双双存活,如实改判为真缺口并收口。教训入账:变异回退
的「击杀」必须审计 FAIL 行形态(收集错误 `FAIL … [ … ]` vs 断言失败
`FAIL … > 用例名` + AssertionError),二者不可混记——与批79 的 mocha/vitest
层归因事故同类。

记账:用例 881→884(引擎在位口径;关引擎 872→875),净 +3;覆盖率重测四指标
维持 100%,分母无变化——行为锁定增量。coverage/ 已 gitignored 不入库。

门禁:pnpm lint EXIT=0;npx vitest run 74 文件 884 用例全绿(引擎在位);
KBENGINE_ROOT=off npx vitest run 74 文件 875 用例全绿;pnpm test EXIT=0
(vitest 884 + 编译 + mocha 烟测 11 passing);覆盖率门禁四指标 100%。
无 tag、无 release、无 force push。

剩余覆盖率动作(批84 后):**无**——台账 100% + 忽略区间审计零过期(批80),
变异抽检四轮真缺口全收口;后续轮次仅在新增源码或按需抽检时跟进。

## 批85:变异抽检第五轮(5 施 3 杀 2 存活,2 真缺口收口,+1 用例)

批次号:派发任务为批82,但 `5c8311f`(批82)、`962ac94`(批83)、
`99f4b9d`(批84)均已入库,本批顺延为批85(仓库既有惯例,非交互假设注明)。

前提核实(批80/83/84 口径):全量覆盖 25 个非测试源文件四指标 100%
(4798/4798、2692/2692、838/838、4689/4689),报告条目 25 = 25 无隐形模块;
逐文件行覆盖率最低者即 100%,零文件 0% 或 <100% —— 「挑行覆盖率最低或
0% 的非生成源文件补单测」无对象可施,按协议转变异抽检。忽略区间台账
64 对 start/stop、17 文件,逐文件计数与批80 基线完全一致
(languageProviders 15、definitionWorkspace 11、entityMapping 7、
databaseSchema 5、entityDependency 4、defParser 4、explorerProviders 3、
monitoringWebView/definitionSemantics/defRenamer/debugConfig/
codeGenerator 各 2、pythonLanguageUtils/logParser/kbengineProtocol/
extension/entityDependencyWebView 各 1),覆盖率总数亦与基线一致——无过期
忽略,台账诚实。

第五轮 5 个语义变异(选样避开批78/79/83/84 已抽模块,覆盖
monitoringCollector/logCollector/codeGenerator):

- 3 杀:M2 monitoringCollector `statusLevel` 三元 `info/warning` 互换
  (monitoringCollectorBranches.test.ts 3 例,定向层击杀)、M4 logCollector
  非正则检索丢弃关键词侧 `toLowerCase`(logCollector.test.ts 大小写探针,
  定向层击杀)、M5 codeGenerator `resolveDefOutputPath` 的
  `!==`→`===`(codeGenerator.test.ts 3 例 + ...Branches 1 例 + ...Files
  1 例,定向层击杀)。
- 2 存活(真缺口,已收口):
  - M1 monitoringCollector 历史环形缓冲上沿 `> 300`→`> 301`——既有截断例
    只探 302(两阈值双双触发,修枝量 `length-300` 又未被变异),301 边界无
    探针,全量 884 绿。收口:新增「trims per-component history at the
    exact 301 boundary」预置 300 条假历史 + 1 条新采集 = 301,原实现修剪
    至 300(逐出 tick 0),变异体保留 301(批79 CPU 阈值锁同类边界收口)。
  - M3 logCollector 正则检索 `new RegExp(keyword, 'i')`→`'g'`——既有例的
    正则探针全是小写模式('fail'/'created|backup'),大小写标志漂移全量不
    可见(非正则分支的大小写探针 M4 恰能杀死,不在同一代码面)。收口:在既
    有用例内追加大写正则探针 `searchLogs('FAILED', true)`→[2] 与
    `searchLogs('CREATED|BACKUP', true)`→[1, 4],原实现命中,变异体落空。
- 变异复验:重施 M1/M3 均恰挂新用例(新边界例单挂 / 既有用例挂在新增断言
  行 112),其余用例不受扰。

执行事故与归因更正(如实记):本轮首版 harness 用 `npx … | tail` 取日志,
`if` 拿到的是 tail 的退出码(恒 0)——M2 定向层明明 3 例失败却被误判
「定向绿」走向全量分支, verdict 全系 bogus(批79 mocha/vitest 层归因事故
同类管道误读)。已重写 harness v2(不管道,直取 vitest 退出码),M1/M2/M3
全部重跑取真 verdict:M2 改判定向杀,M1/M3 确认真存活后收口。教训入账:
harness 的通过/失败判定必须直取引擎退出码,任何管道后段都会吞码——与批84
「收集错误 vs 断言失败」同属 verdict 形态审计。

记账:用例 884→885(引擎在位口径;关引擎 875→876),净 +1(M1 新增 it 块;
M3 为既有用例内追加断言,不增用例数);覆盖率重测四指标维持 100%,分母无
变化(4798/2692/838/4689)——行为锁定增量。coverage/coverage-summary.json
已同步重测,该目录 gitignored 不入库,状态以本台账记录为准(派发任务要求
的 json 同步即此:落盘刷新 + 台账登记,不提交)。累计变异抽检 38 施 28 杀
10 存活,其中真缺口 9 个全部收口,语义等价存活 1 个(M4,批84)。

门禁:pnpm lint EXIT=0;npx vitest run 74 文件 885 用例全绿(引擎在位);
KBENGINE_ROOT=off npx vitest run 74 文件 876 用例全绿;pnpm test EXIT=0
(vitest 885 + 编译 + mocha 烟测 11 passing);覆盖率门禁四指标 100%。
无 tag、无 release、无 force push。

剩余覆盖率动作(批85 后):**无**——台账 100% + 忽略区间审计零过期(批80
口径复核),变异抽检五轮真缺口全收口;后续轮次仅在新增源码或按需抽检时跟进。

说明:

- 批54(重设计阶段 3)起 extension.ts 进 vitest 覆盖率分母:activate/
  deactivate 由 tests/extension.test.ts 的 fake-vscode 装配测试驱动
  (6 用例,详见 docs/redesign.md 阶段 3),99.5% lines / 100% functions,
  当时唯一未盖的 L242(批58 行号漂移前为 L234)被记为"openMethodTarget
  永不抛错导致的防御 catch"——该定性已于批62 推翻并改正:openFileAtLocation
  不 catch,openTextDocument 失败即冒到命令层,现由真实用例覆盖。批56 起 mocha 层裁为
  编译产物烟测(批58 后 11 用例,见批56/58 注),
  两 runner 覆盖率不做工具级合并。
- 总体百分比的分母包含全部源码文件;随测试推进持续抬升,
  每次抬升后更新本表。

## 近期由测试发现并修复的真实缺陷

- `extension.ts` 的 `kbengine.entity.method.open` 命令空目标守卫位于 label
  拼接之后——命令面板无参调用在守卫前抛 TypeError → 守卫上移(批54 装配
  测试发现)。
- `workspacePath.ts` win32 分支在非 Windows 主机上因平台隐式 `path.join` 产出生
  混合分隔符的路径 → 改为显式 `path.win32.join`。
- `snippets/kbengine.json` 的 `ARRAY<x>` 内联写法引擎不解析(FixedArrayType 强制
  `<of>` 子节点)→ snippet 改为引擎真实语法。
- 片段选择列表与补全元数据中的 `BOOL`/`TUPLE` 在引擎类型注册表中不存在 → 全部剔除,
  并由测试锁定不得回归。
