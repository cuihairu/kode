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
批58 起 defRenamer.ts 计入分母):

| 指标 | 值 |
|------|-----|
| Statements | 99.16% |
| Branches | 95.11% |
| Functions | 100% |
| Lines | 99.14% |

纯逻辑层明细:

| 模块 | Lines | Branch |
|------|-------|--------|
| hooks.ts | 100% | 100% |
| kbengineMetadata.ts | 100% | 100% |
| pythonLanguageUtils.ts | 100% | 90.9% |
| workspacePath.ts | 100% | 100% |
| defParser.ts | 99.4% | 91.8% |
| defRenamer.ts | 99.5% | 94.5% |
| definitionSemantics.ts | 99.5% | 94.2% |
| logParser.ts | 100% | 98.3% |
| kbengineProtocol.ts | 100% | 98.9% |
| entityMapping.ts | 98.4% | 96.1% |
| languageProviders.ts | 98.6% | 93.5% |
| monitoringCollector.ts | 100% | 100% |
| entityDependency.ts | 97.4% | 93.3% |
| databaseSchema.ts | 99.4% | 94.4% |
| logCollector.ts | 100% | 100% |
| codeGenerator.ts | 100% | 95.1% |
| definitionWorkspace.ts | 98.9% | 91.5% |
| serverCommandTarget.ts | 100% | 100% |
| serverManager.ts | 100% | 98.6% |
| logWebView.ts | 100% | 96.9% |
| monitoringWebView.ts | 96.9% | 91.8% |
| entityDependencyWebView.ts | 97.9% | 95.2% |
| debugConfig.ts | 100% | 95.2% |
| explorerProviders.ts | 99.2% | 98.1% |
| extension.ts | 99.5% | 98.4% |

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
window.showTextDocument 与可 fire 的 FileSystemWatcher(记录回调,真实
事件行为仍由 mocha 层覆盖)。10.6% 的剩余部分是接口/组件符号的索引回溯
(ensureIndexForOwner 的 findByOwner 分支)、绑定未命中时的 owner 文件
扫描 fallback 与零散防御分支,由 mocha 域与后续批次覆盖。

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
7.7% 剩余为 startTimer 的定时器驱动的 refresh 循环与零散防御分支
(定时器行为由 mocha 域覆盖)。vscodeStub 相应补了最小 EventEmitter
与 ExtensionContext 占位(真实事件行为仍由 mocha 层覆盖)。

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
空表;dispose 无副作用。7.6% 剩余为向导的零散分支组合,由 mocha 层补充
覆盖。私有生成方法经实例直调,测真实行为,零 mock。

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
50.4% 的剩余部分是 WebviewPanel 生命周期、定时刷新与导出,由 mocha 层
覆盖。批27 又把 monitoringWebView 的面板生命周期搬进 vitest
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
getTreeItem 透传、带元素无子)。96.7% 的剩余部分是树控件装配与 mocha 域。
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
9 用例):getDirectTextNodes/getElementText 的空参守卫与文本子节点收集
(含 CDATA 与相邻文本拼接 'xy'、text 节点 parent 回指);findAncestorElement
的 null 守卫、从文本节点经 parent 链上溯(字符串名与数组名两形态)与
链耗尽 null;assignTextNodePosition 的两个回退分支经真实 parseDefDocument
触达——`&quot;` 解码为 `"` 后解码产物在原文中不存在,indexOf 落空回退
searchOffset(开标结束处,start=end=9)、`<![CDATA[]]>` 产空文本节点
保留在 searchOffset。98.7% 的剩余两行(非对象项/':@' 键 continue)为
v8 语句映射粒度——带属性元素的解析每次必经,实际已执行。

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

说明:

- 批54(重设计阶段 3)起 extension.ts 进 vitest 覆盖率分母:activate/
  deactivate 由 tests/extension.test.ts 的 fake-vscode 装配测试驱动
  (6 用例,详见 docs/redesign.md 阶段 3),99.5% lines / 100% functions,
  唯一未盖 L242(批58 行号漂移前为 L234)是 openMethodTarget 永不抛错
  (内部自带 catch)导致的防御 catch,如实记录。批56 起 mocha 层裁为
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
