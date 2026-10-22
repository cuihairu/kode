# 配置说明


Kode 的配置分两摊:`kbengine.*` 设置项(VSCode `settings.json`)和服务端 XML 配置(`kbengine_defaults.xml`、元件 `kbengine.xml`)。设置项**按功能分区**介绍(诊断、悬停、CodeLens 与 inlay、跳转、路径、配置视图、服务与日志、远程调试、Python、生成器、telnet、HTTP、热重载、数据库)——每区一张小表给出类型、默认值与说明,表后是该区改动影响与常见误配;服务端配置怎么分层合并、telnet 端口/密码从哪来,先读「服务端配置的三层」。

设置项默认值均取自本扩展 package.json 贡献点,引擎侧取值取自 `kbengine_defaults.xml`;两处都查不到的,标「来源未考」。

## 服务端配置的三层

引擎装载服务端配置的规则:先读引擎默认配置,再读元件配置,同键覆盖。Kode 的 telnet 探测和「最终配置」视图都按这个口径取值。

| 层 | 文件 | 定位方式 |
| --- | --- | --- |
| 1 引擎默认 | `kbe/res/server/kbengine_defaults.xml` | 由 `kbengine.binPath`(指向 `kbe/bin/server`)向上推导 |
| 2 元件覆盖 | `kbengine.xml` | `kbengine.assetsRoot` 下的 `kbengine.xml` 与其 `res/server/kbengine.xml` 优先;未设或未命中时发现出的资产根(批128)参与;最后按约定路径探测工作区根:`kbengine.xml` → `res/server/kbengine.xml` → `assets/res/server/kbengine.xml`,取第一个存在的 |
| 3 最终生效 | (合成,不落盘) | 第 1 层先载,第 2 层同键覆盖 |

层的定位设置 `kbengine.binPath` 与 `kbengine.assetsRoot` 都是支持 VS Code 变量的目录:值先做变量展开(`${workspaceFolder}`/`${env:NAME}` 等),相对路径按工作区根拼接;展开为空串按「未配置」处理,照常走自动发现。

覆盖口径:

- 同名键两边都有:取元件配置的值;
- 只有默认有:保留默认;
- 只有元件有:新增;
- 容器段两边都有:递归下钻,子键按名字对齐;
- 重复名列表(如 `<addresses>` 下多个地址):元件配置整表替换,不与默认表交错。

前后对照:

| 键 | 引擎默认 | 元件 kbengine.xml | 最终生效 |
| --- | --- | --- | --- |
| `baseapp/telnet_service/port` | 40000 | 41000 | 41000(覆盖) |
| `baseapp/telnet_service/password` | `pwd123456` | (未写) | `pwd123456`(仅默认有,保留) |
| `baseapp/archivePeriod` | 300 | 600 | 600(覆盖) |
| `baseapp/externalAddress` | (未写) | `10.0.0.9` | 10.0.0.9(新增) |

### 查看最终配置

三个入口,内容相同,都是只读虚拟文档 `kbengine-final.xml`,不落盘:

- 侧栏 KBEngine → Config 视图的「最终配置」节点,点击即开;
- 命令面板 `Show Final Server Config`(`kbengine.config.showFinal`);
- 扩展激活且能定位 defaults 时自动在后台打开(设置 `kbengine.showFinalConfigOnOpen`,默认开;找不到 defaults 静默跳过)。

文档头部注释标明 defaults 与元件配置的来源路径。defaults 或元件 `kbengine.xml` 保存、新增、删除后自动重算(`kbengine.autoRefreshFinalConfig`,默认开)。对字段悬浮可看作用说明。

### telnet 端口/密码怎么读

telnet 没有独立一套参数,就是上面三层加一个显式设置层,按序取第一个非空值:

| 参数 | 取值顺序 |
| --- | --- |
| 端口 | 设置 `kbengine.telnet.port`(>0)→ 元件 `kbengine.xml` `<telnet_service>` 的 `port` → 引擎 defaults 该组件的端口 |
| 密码 | 设置 `kbengine.telnet.password` → 元件段 `password` → 引擎 defaults `password` → 空(不自动登录) |
| 主机 | 设置 `kbengine.telnet.host`,留空用 `127.0.0.1` |

两条边界:

- 元件 `kbengine.xml` 没有 `<telnet_service>` 段且设置没给端口 → 不探测,telnet 面板、状态灯、独立树视图都不出现。引擎 defaults 里虽有 `<telnet_service>` 段,但 defaults 只供数值回落,不会单独把 telnet「打开」;
- 元件段存在但没写端口 → 按引擎默认组件端口表逐组件探测:loginapp 31000 / dbmgr 32000 / interfaces 33000 / logger 34000 / baseapp 40000 / cellapp 50000 / bots 51000;defaults 里写了端口的组件以 defaults 为准。

`.kbengine/debug.json` 与这条链无关,它只服务调试流程(见「调试配置文件」一节)。

## kbengine.* 设置项总览(按功能分区)

54 项设置按功能分区,每区一张小表(配置项/类型/默认值/说明),表后紧接该区的改动影响与常见误配——不再是一张 54 行的大表。找一个设置,先按功能定位分区,再在区内对行。

### 诊断

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.enableDiagnostics` | boolean | `true` | `.def` 诊断总开关(批147 起同管 entities.xml 同名重复登记检查) |
| `kbengine.enableStructureDiagnostics` | boolean | `true` | 结构化校验开关(重复属性/方法、子标签位置、缺字段、字段重复定义) |
| `kbengine.diagnostics.checkUnknownTypes` | boolean | `true` | 检查未知类型名 |
| `kbengine.diagnostics.checkUnknownFlags` | boolean | `true` | 检查未知 Flags 值 |
| `kbengine.diagnostics.checkUnknownDetailLevels` | boolean | `true` | 检查非法 DetailLevel 值 |
| `kbengine.diagnostics.checkDuplicateDefinitions` | boolean | `true` | 检查重名属性/方法 |
| `kbengine.diagnostics.checkMissingPropertyFields` | boolean | `true` | 检查属性缺 `Type`/`Flags` 或字段重复 |

| 配置项 | 关掉会怎样 | 常见误配 |
| --- | --- | --- |
| `enableDiagnostics` | `.def` 的类型、Flags、结构问题与 entities.xml 同名重复登记全部不再提示 | 忘了重开,以为代码没写错 |
| `enableStructureDiagnostics` | 重复属性/方法、子标签位置错、缺 `Type`/`Flags`、字段重复定义都不报 | 与上一项搞混:这项只管结构,类型名拼错归 `checkUnknownTypes` |
| `diagnostics.checkUnknownTypes` | 类型名拼错不再报 | 自定义类型要能找到才不误报:先查 `entity_defs/types.xml`、`scripts/entity_defs/types.xml`、`assets/scripts/entity_defs/types.xml`,再到 `user_type/<Type>.py`、`scripts/user_type/<Type>.py`、`assets/scripts/user_type/<Type>.py` |
| `diagnostics.checkUnknownFlags` | Flags 拼错不再报 | — |
| `diagnostics.checkUnknownDetailLevels` | DetailLevel 非法值不再报 | — |
| `diagnostics.checkDuplicateDefinitions` | 真重名漏报 | 提示过多的项目可关,代价是漏掉真重名 |
| `diagnostics.checkMissingPropertyFields` | 缺 `Type`/`Flags` 的属性不报 | — |

诊断只在打开或编辑 `.def` 文件时触发,`kbengine.*` 配置变化后会重扫已打开的 `.def`。

### 悬停

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.hover.showTagDocs` | boolean | `true` | `<Type>`、`<Flags>`、`<Properties>` 这类标签的悬停说明(出现频率最高,嫌提示多优先关它) |
| `kbengine.hover.showValueDocs` | boolean | `true` | `UINT32`、`BASE_AND_CLIENT`、`FAR` 这类值的悬停说明 |
| `kbengine.hover.showSymbolDocs` | boolean | `true` | 悬停自定义属性名/方法名显示当前定义的 `Type`、`Flags`、`Arg` 等上下文 |
| `kbengine.hover.typeStorage` | boolean | `true` | `.def`/`types.xml` 里 types.xml 自定义类型的存储悬停(落库表/列/类型与形态) |
| `kbengine.hover.implementedBy` | boolean | `true` | python 侧悬停被 types.xml `implementedBy` 引用的符号时的反链 |
| `kbengine.hover.entityRegistration` | boolean | `true` | 悬停 `entities.xml` 实体名时的注册信息(`Utype`/清单位置) |
| `kbengine.hover.defChain` | boolean | `true` | 悬停 `Parent`/`Interfaces` 等声明元素时的归并 def 链 |
| `kbengine.hover.eventStats` | boolean | `true` | python 侧悬停事件名时的注册/触发统计 |
| `kbengine.hover.serverConfig` | boolean | `true` | 悬停 `kbengine.xml` 服务配置字段时的取值与说明(批112 悬停面整体关断) |

前三项全关后 `.def` 悬停只剩语法高亮。批154(2026-10-20)起其余六面按功能各一枚独立开关,不设总闸一刀切——只关吵的那一面,其余照常。

### CodeLens 与 inlay hints

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.codeLens.rpc` | boolean | `true` | Python 实现脚本里 def 声明的方法声明行上方的 RPC 标记(批126) |
| `kbengine.codeLens.eventCallbacks` | boolean | `true` | 事件回调标记——`addEvent`/`registerEvent` 的回调 def 声明处标事件名,`emitEvent` 处标监听数(批154 起从 RPC 镜链拆出独立注册) |
| `kbengine.codeLens.property` | boolean | `true` | Python 脚本 `self.<属性>` 访问处的属性标记(批135) |
| `kbengine.codeLens.typesXml` | boolean | `true` | types.xml 类型声明行的落库镜链(批134) |
| `kbengine.inlayHints.typeData` | boolean | `true` | python 侧 `self.<属性>` 访问处以内联提示显示 def 声明的 `<Type>` 数据类型(types.xml 自定义别名或内建),与属性 F12 同一解析索引(批154) |

四类 CodeLens 开关变更即时生效,不用重载窗口;inlay 无变更事件,关掉后下一次渲染生效。

### 跳转与导航

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.jumpLog` | boolean | `false` | 跳转决策路径日志开关(输出面板 KBEngine Navigation,过滤 `[kode-jump]`;关闭时零开销) |
| `kbengine.python.enableMroJump` | boolean | `true` | Python 跳转层2(跨文件 C3-MRO + 组合根解析 mixin/基类方法)开关;关闭时层2 记 skip、不做全仓扫描,跳转回落层1(`.def` 派生索引)与层3(当前文件类作用域) |
| `kbengine.python.callChainHints` | boolean | `true` | Python 实体方法 Call Chain 镜链与 `Show Call Chain` 命令;关闭后不显示链入口,命令也不生成预览 |
| `kbengine.python.apiMetadata` | boolean | `true` | KBEngine API 引擎版本/源码提交标识与原始声明位置;取不到源码标识显示 `unknown`,不硬造 |

`kbengine.python.enableMroJump` 改动即时生效(不重载窗口);关闭后层2 只在跳转轨迹里记 skip、不做全仓 `.py` 扫描,`.py` 变更也不再投喂索引。方法使用处优先寻找 Python 实现，`.def` 方法声明会暂存为回退目标；属性访问和方法声明处保持 `.def` 导航。索引区分模块与 base/cell 同名类，并使用未保存的编辑器内容。逐层轨迹与排障口径见「日志」文档的 `[kode-jump]` 决策路径一节。引擎源码配置同时服务 `kbengine.python.apiMetadata`;元数据在激活期派生,不把本机路径写进代码。

### 路径与工作区发现

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.entityDefsPath` | string | `scripts/entity_defs` | 实体定义目录(实体浏览器列表、`entities.xml` 跳转、生成器 `.def` 输出) |
| `kbengine.entitiesXmlPath` | string | `scripts/entities.xml` | `entities.xml` 路径(依赖图读取与实体注册) |
| `kbengine.binPath` | string | `${workspaceFolder}/../kbe/bin/server` | 引擎二进制目录;兼推引擎根(`KBE_ROOT`)与引擎默认配置路径 |
| `kbengine.assetsRoot` | string | `""` | 资产根目录(其下含 `res/`、`scripts/`),留空自动发现 |

四项都是「可选覆盖」:配置了就照配置,没配就按发现链找,详见下文「路径类配置的自动发现」。逐项细节:

#### `kbengine.entityDefsPath`

- 类型:string;默认 `scripts/entity_defs`(相对工作区根)
- 用途:实体浏览器列表、`entities.xml` 跳转、生成器 `.def` 输出
- 批125 起未配置/默认路径不存在时自动发现(约定布局 → 深扫描唯一命中 → 多候选激活期询问一次并记忆),配置只作覆盖
- 误配:指错目录则实体浏览器为空

#### `kbengine.entitiesXmlPath`

- 类型:string;默认 `scripts/entities.xml`
- 用途:依赖图读取与实体注册。项目把注册文件放在自定义位置时改这项
- 批125 起约定候选全 miss 时深扫描兜底(优先 def 根同父目录),配置只作覆盖

#### `kbengine.binPath`

- 类型:string;默认 `${workspaceFolder}/../kbe/bin/server`
- 支持占位符:`${workspaceFolder}`、`${env:VAR}`
- 用途:① 启动/停止组件进程;② 推导引擎根(`KBE_ROOT`)与引擎默认配置路径——把路径末尾的 `kbe/bin/server` 换成 `kbe/res/server/kbengine_defaults.xml`
- 批125 起未配置时优先按引擎源码根锚点(`kbe/src/lib/entitydef/entitydef.cpp`、`entity_table_mysql.cpp` 等)推导 `kbe/bin/server`,再退兄弟目录猜测
- 误配:没指到 `kbe/bin/server` 这一级 → 服务器启动失败,最终配置视图和 defaults 数值回落也不可用;此时 `kbengine.config.showFinal` 会明示报错,激活自动打开则静默跳过

#### `kbengine.assetsRoot`

- 类型:string;默认 `""`(留空 = 自动发现)。批131(2026-10-15)自 `kbengine.configPath` 更名:与引擎领域术语对齐(引擎资产树就叫 assets,约定扫描也是 `*_assets`,见 `kbemain.h:133-137` 的 `../../../assets/res/server/`);同时废默认值 `${workspaceFolder}/server`——旧默认形同把未配置伪装成显式配置,空串才让代码里的「未设 → 自动发现」路径真实生效
- 这是资产根(assets root,引擎资产树根,如 `flyff_assets`),三处生效:
  1. 组件进程的工作目录(cwd)——引擎按相对路径找资产时以这里为基准;
  2. 进程环境 `KBE_RES_PATH` 的项目侧条目:完整顺序为 `KBE_ROOT/kbe/res`、资产根、`资产根/res`、`资产根/scripts`;
  3. 元件 `kbengine.xml` 的首选定位处:`资产根/kbengine.xml`。
- 批128 起自动发现:原值未过引擎装载探针(其下无 `res/server/kbengine.xml`)时,按 约定链 → 多候选记忆选择 → 深扫描唯一命中 兜底;发现出的根同样供 telnet 探测与最终配置视图取元件 `kbengine.xml`。约定链批129 起含工作区一级 `*_assets` 目录(如 `flyff_assets`)——目录名只是准入,命中仍以探针验收
- 探针只验用户副本 `kbengine.xml`,不要求 `kbengine_defaults.xml` 在场:引擎对两份配置各在各的树里装载(kbemain.h:71-74 先载 defaults 再载用户副本覆盖;引擎注释 kbemain.h:133-137 示例即 defaults 在引擎 res 树、用户副本在资产树),资产根的锚点就是用户副本——引擎 `getPyUserResPath()` 也以 `matchRes("server/kbengine.xml")` 定位资产树。扩展同口径:defaults 从 binPath/引擎源码根推导(`deriveEngineDefaultsXmlPath`),用户副本从资产根找,两树独立
- 启动前会校验:发现与显式都落空时空串、目录不存在、路径不是目录都会报错并中止启动;目录在而探针文件缺 → 输出通道留 `[WARN]` 不拦截(批127)
- 误配:指到仓库根而不是资产目录 → 探针不通过,自动发现接管;发现也落空时引擎在 `res`/`scripts` 子目录下找不到脚本,组件起不来;元件 `kbengine.xml` 定位不到时 telnet 与最终配置退回纯默认

### 最终配置视图

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.showFinalConfigOnOpen` | boolean | `true` | 扩展激活且能定位 defaults 时,自动在后台打开 `kbengine-final.xml`(preview 标签,不抢焦点);定位失败静默跳过,不弹错。关闭后仍可用命令或侧栏 Config 视图的「最终配置」节点手动打开 |
| `kbengine.autoRefreshFinalConfig` | boolean | `true` | defaults 或元件 `kbengine.xml` 保存、新增、删除后,自动重算已打开的合成文档。关闭后需重开文档或重跑命令 |

### 服务器与日志

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.autoStart` | string[] | `["machine","logger","dbmgr"]` | 不带参数启动时拉起的组件。合法值取自组件注册表(`src/serverManager.ts`):`machine`、`logger`、`interfaces`、`dbmgr`、`baseappmgr`、`cellappmgr`、`loginapp`、`baseapp`、`cellapp`、`bots` |
| `kbengine.loggerPort` | number | `20022` | 日志收集器连接端口,须与引擎 logger 的监听端口一致;不一致时面板连不上(内部按间隔重连) |
| `kbengine.logAutoConnect` | boolean | `true` | 激活即尝试连接一次 logger;失败静默,走重连 |
| `kbengine.webviewConsoleLogs` | boolean | `true` | 采集日志面板页面 `console` 输出与未捕获异常,并入同一日志流 |
| `kbengine.maxLogEntries` | number | `10000` | 日志 WebView 缓存上限(条)。日志量大调低省内存,想留更长历史调高 |

### 远程调试

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.debug.remoteTargets` | array | `[]` | 远程调试目标列表,`Attach to Remote Component` 的目标选择源;`Update launch.json` 把它们以 debugpy `connect` 形式追加进 `launch.json` |

每个条目:

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 目标显示名(选择器里的标识) |
| `host` | string | 是 | 远端 IP 或主机名 |
| `port` | number | 否 | debugpy 监听端口,缺省 `5678` |

- 前提:远端组件先经 telnet 发开启调试命令,并起好 debugpy 监听;扩展以 `connect: {host, port}` 附加,不写 `pathMappings`
- 误配:`host` 填错 → 附加失败走错误通道;`port` 不对 → 连不上 debugpy;`name`/`host` 为空的条目不收录

### Python 集成

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.python.extraPathsSync` | boolean | `true` | 自动把工作区发现的 KBEngine scripts 根写入 `python.analysis.extraPaths`(WorkspaceFolder 级;只管理本扩展写入的那一段,用户手填路径不动;无变化不写)。关掉后 `kbengine.python.syncExtraPaths` 命令只说明不写 |
| `kbengine.python.stubExport` | boolean | `true` | 自动把内置 KBEngine Python API 索引(与补全/悬停/跳转同源)导出为 `KBEngine.pyi` 存根,并把 types.xml 自定义类型导出为 `kbe_types.py` 类型桩(`FIXED_DICT`→`TypedDict`、别名→类型名),配合 extraPaths 接线供 Pylance 解析 `import KBEngine`/`import kbe_types`(虚拟桩文档 Python 扩展看不见)。激活期静默自动一次,`kbengine.python.exportStubs`/`kbengine.python.exportTypeStubs` 手动入口 |
| `kbengine.python.stubDir` | string | 空 | `.pyi` 存根目录,三级解析:设置 > 环境变量 `KBENGINE_STUB_DIR` > 默认约定 `.kbengine/stubs`。支持 `${workspaceFolder}`/`${env:NAME}` 等 VS Code 变量;相对路径按工作区根拼接,绝对路径原样使用 |
| `kbengine.python.stubEngineTypings` | boolean | `true` | `KBEngine.pyi` 导出优先拼接本地引擎 checkout 的 typings 全量 API(默认开);关掉回落 kode 自带精选目录。总闸仍是 `kbengine.python.stubExport` |
| `kbengine.python.entityStubMethods` | boolean | `true` | `entity_types.pyi` 实体存根包含 def 方法面(Base/Cell/ClientMethods,默认开);关掉回落只含属性面 |

### 实体脚本增强(2026-10-21)

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.entity.builtinProperties` | boolean | `true` | 实体脚本 `self.<内建属性>` 的悬停标注与 `self.` 补全(按 base/cell/client 分面);关掉整体让位,回落普通符号链 |
| `kbengine.entity.receiverSections` | boolean | `true` | `self.cell.`/`self.base.`/`self.client.` 调用按接收者段过滤 def 候选(悬停/F12/RPC 镜链,默认开);关掉回归不感知段的旧解析,def 形参/类型闸门不受影响 |
| `kbengine.python.builtinTypeInlayHints` | boolean | `true` | 实体脚本 `self.<内建属性>` 访问处行内 `: <类型>` 提示(与悬停同一命中底座,默认开);受总闸 `kbengine.entity.builtinProperties` 与本键双控,任一关闭都不渲染内建属性 inlay |
| `kbengine.types.aliasDiscovery` | boolean | `true` | 从 `scripts/entity_defs/alias.xml` 发现自定义类型并入类型表(默认开);关掉回落只认 `types.xml` |

`kbengine.python.stubDir` 留空(默认)时目录是 kode 自管的 `.kbengine/stubs`:内容一致零写、陈旧(索引更新后)自动重写、手改不保留,建议在 `.gitignore` 里忽略。**配了目录则目录归用户所有**:kode 只扫描不覆盖——目录里已有任何 `.pyi` 一律当用户资产不碰,没有 `.pyi` 才生成一份;目录读不到(不存在/无权限)如实提示,不盲写。

边界:extraPaths 的管理段只认默认约定目录 `.kbengine/stubs`(导出开且 `KBEngine.pyi` 或 `kbe_types.py` 在盘时并入,两份生成物同居一个目录);用户配置的 `kbengine.python.stubDir` 目录不并入管理段,需要时自行加入 `python.analysis.extraPaths`。

### 代码生成器

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.generator.defOutputPath` | string | `scripts/entity_defs` | 生成的 `.def` 写到哪;默认值即发现出的 def 根,配置只作覆盖 |
| `kbengine.generator.pythonOutputPath` | string | `scripts` | 生成的 Python 写到哪;默认值时从发现出的 def 根父目录推导(如 `assets/scripts`),配置只作覆盖 |
| `kbengine.generator.generatePython` | boolean | `true` | 向导/模板创建实体时是否同时生成 Python 文件 |
| `kbengine.generator.registerInEntitiesXml` | boolean | `true` | 生成后自动写入 `entities.xml`(写的是 `entitiesXmlPath` 指向的文件) |

#### `kbengine.clientSdk.outputDir`

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.clientSdk.outputDir` | string | `scripts/client_entities` | 客户端实体 SDK 生成器(`kbengine.clientSdk.generate`)的输出目录,TypeScript / C# 骨架与伴随文件都写到这里;相对工作区根 |

语言清单与覆盖策略在命令内的 quick pick 里选择,默认不覆盖已存在的文件;详见 [客户端实体 SDK 生成](./client-sdk.md)。

### telnet 探测

telnet 的展示面(独立树视图、状态灯、面板)只在配置显式开 telnet 时出现,取值链见「telnet 端口/密码怎么读」。

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.telnet.host` | string | `127.0.0.1` | 探测目标主机。远端机器填其 IP |
| `kbengine.telnet.port` | number | `0` | 显式端口。>0 时锁定单一目标(不再逐组件探测);0 = 未显式指定,按元件 `kbengine.xml` 段与 defaults 回落 |
| `kbengine.telnet.password` | string | 空 | 自动握手登录用,只写 socket 不写日志。留空则不自动登录,状态灯停「端口开·未配密码」 |
| `kbengine.telnet.enableCommands` | string[] | `[]` | telnet 面板可发送的命令白名单(精确匹配或「命令 + 空格 + 参数」前缀匹配)。内置只读快捷命令(实体数量/实体清单/全局数据键/`:help`)默认放行;`:quit` 会关闭服务端进程,配进白名单也恒被拒绝 |
| `kbengine.telnet.configXmlPath` | string | 空 | 显式指定元件 `kbengine.xml`(支持 `${workspaceFolder}`),优先于自动探测;设置显式端口 >0 时端口以设置为准 |
| `kbengine.telnet.probeIntervalSeconds` | number | `5` | 探测轮询间隔(秒),低于 1 按 1 秒执行 |

### HTTP 快捷请求

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.httpRequests` | array | 见下文 | HTTP 快捷请求列表(默认含一条停用示例) |

类型:array;默认含一条停用的示例(热更新示例,`enabled: false`),按本机热更新服务的真实形态给出——等价于命令行:

```bash
curl 'http://127.0.0.1:8000/api/hotfix?relaod=entities.fight.FightAI'
```

增删改走设置界面的列表编辑器,启停 = 条目 `enabled` 开关。每条字段:

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 请求名(quick pick 与日志标识),必填 |
| `url` | string | URL 模板,可含模板变量,必填 |
| `method` | string | HTTP 方法,缺省 `GET` |
| `headers` | object | 请求头(值同样走模板替换) |
| `body` | string | 请求体(非空才随请求发送,同样走模板替换) |
| `enabled` | boolean | 启停开关,缺省启用 |
| `keybinding` | string | 键位展示串(quick pick 详情列显示) |

模板变量(URL/请求体/请求头值通用,按字面替换、不做 URL 编码):

| 变量 | 含义 |
|------|------|
| `${module}` | 按 `__init__.py` 包边界扫出的模块路径:`entities/`、`fight/` 各带 `__init__.py` 时 `entities/fight/FightAI.py` → `entities.fight.FightAI`;KBEngine 脚本所在的 `base/`、`cell/` 是引擎角色目录,没有 `__init__.py`,不算模块段——此时模块名就是文件名去 `.py`(即「没有模块就直接文件名」形态) |
| `${moduleBasename}` | 末段一层模块名:`entities.fight.FightAI` → `FightAI`;无包段形态下与 `${module}` 一致 |
| `${filename}` | 文件名(`FightAI.py`) |
| `${line}` | 光标行(1 起) |
| `${sel}` | 选中文本 |

另支持 VS Code 官方变量族(`${file}`=绝对路径、`${workspaceFolder}`、`${workspaceFolderBasename}`、`${fileBasename}`、`${fileBasenameNoExtension}`、`${fileDirname}`、`${fileExtname}`、`${relativeFile}`、`${relativeFileDirname}`、`${env:NAME}`、`${cwd}`、`${userHome}`、`${pathSeparator}`,多根工作区可用 `${workspaceFolder:Name}` 指名取根)。两表都不认识的占位原样保留(不替换为空串)。

> 历史:批152 之前文件名占位叫 `${file}`(与本扩展当时未接官方变量族有关);批153 起官方变量族接入,`${file}` 归还官方绝对路径语义,文件名请改用 `${filename}`。

无活动编辑器时各变量替换为空串。

快捷键绑定:VS Code 无运行时注册键位的 API,在「键盘快捷方式」里为 `kbengine.httpRequest.run` 绑定按键并在 `args` 里带请求名:

```json
{
  "key": "ctrl+alt+h",
  "command": "kbengine.httpRequest.run",
  "args": { "name": "热更新(示例)" }
}
```

执行流水进 OUTPUT 面板「KBEngine HTTP 快捷请求」:`▶` 请求行 → `✓` 状态码 · 耗时 → 回包(超 4000 字符截断标注全长);失败以 `✗` 标记 + 错误弹窗呈现。

### 自动热重载

文件保存/监视 → 按名触发 `quickActions` 动作。门控**默认关**防误触:开启前不建任何文件监视,装配链与激活期行为零变化;`enabled` 改成 `true` 即刻按 `globs` 建监视、改成 `false` 拆除,配置变更即时生效,不必重启窗口。

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.hotReload.enabled` | boolean | `false` | 总开关,开时按 `globs` 各建一个文件监视 |
| `kbengine.hotReload.actionName` | string | 空 | 要触发的动作名,须在 `quickActions` 数组里存在 |
| `kbengine.hotReload.globs` | string[] | `["**/*.py"]` | 监视模式(VS Code glob),每个模式各建一个文件监视 |
| `kbengine.hotReload.debounceMs` | number | `500` | 触发前去抖毫秒数,`0` 为不去抖 |

行为口径:

- **三通道都触发**:文件的变更、创建、删除都算保存事件,任一触发都进入去抖。
- **去抖合并**:一次触发到下一次触发之间的连发事件合并成一次执行;去抖期间关掉开关会取消尚未触发的计时。
- **无人值守**:触发路径跳过执行确认框(即使动作 `confirm` 为 `true`);动作自身的失败仍照常弹窗报错——那是执行结果,不是交互确认。执行记录照常写入「上次执行」记忆,因此 Explorer 顶栏 ▶ 也指向最近一次触发的动作。
- **找不到名字不打扰**:`actionName` 留空,或匹配不到任何动作时,事件照常触发但只往 OUTPUT 通道「KBEngine 快速执行动作」落一行流水,不弹窗、不执行。
- **配置容错**:类型写错(`enabled` 不是布尔、`globs` 不是数组、`debounceMs` 是负数或非数字)一律回落默认,不报错不中断装配;`globs` 里的空串与非字符串项被剔除,剔空则回落默认 `**/*.py`。

### 数据库

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `kbengine.db.tablePrefix` | string | `""`（空 = 引擎默认 `tbl_`） | 数据库表名前缀，schema 视图与 SQL 模板同源替换 |

设成自定义值（如 `kb_`）后，schema 视图里的表名与三行 SQL 模板同源替换：

| 模板 | 用途 |
| --- | --- |
| `SQL: SELECT * FROM ...` | 全列（引擎结构列 + 属性列） |
| `SQL(属性列): SELECT ...` | 只列 def 属性落成的列，剔掉 `id` / `sm_autoLoad` / `parentID` / 位置朝向六列 |
| `SQL(子表 JOIN): ...` | 仅 ARRAY / 组件子表：按 `parentID` 关联父表，`LEFT JOIN` 保住空元素的属性行 |

子表 JOIN 同样出现在 ARRAY / 组件属性的悬停行里。不改引擎默认前缀的工程留空即可，行为与之前一致。

#### 数据库漂移校验的连接信息

`kbengine.database.checkDrift` 的连接信息**全部来自引擎配置，不新增设置项**：合成后的 `<dbmgr><databaseInterfaces><default>`（引擎 `kbengine_defaults.xml` + 元件 `kbengine.xml` 同键覆盖），端口 `0` 落 MySQL 默认 3306。

账号密码需明文存放（`<encrypt>false</encrypt>`）。引擎默认的 `encrypt=true` 是 RSA 密文，kode 不解读，此时命令如实提示「未校验」——不会为了跑一次校验要求改引擎配置或手填密码。校验口径与只读红线见 [数据库漂移校验](./database-drift-check.md)。

## 调试配置文件(`.kbengine/debug.json`)

这个文件只服务调试流程与快速执行动作。telnet 探测、telnet 面板、状态灯、telnet 树视图都不读它。

### 快速执行动作(`quickActions` 键)

动作是**顶层 `quickActions` 数组**(不进 `debug` 段:动作不是调试配置),跟着 KBEngine 工程走,不新增 `kbengine.*` 设置项。

**编辑器侧校验**:kode 随包贡献了该文件的 JSON Schema(`.kbengine/debug.json` 一路匹配,含各级子文件夹),VS Code 的 JSON 扩展在编辑时直接标红——后端类型写错、`telnetPort` 写成字符串、`pathMappings` 条目缺 `localRoot`/`remoteRoot`、`method` 不在白名单等,都在保存前暴露,不必等执行才发现。Schema 由解析器口径生成(后端枚举与方法枚举取 `quickActionConfig.ts` 的常量),与 `package.json` 内联对象逐字节同源、由测试锁定防漂移。校验是提示,不是门禁:解析器仍然逐条剔除坏条目、逐字段的类型回落规则不变。

| 字段 | 适用类型 | 说明 |
|------|------|------|
| `name` | 全部 | 显示名,必填 |
| `type` | 全部 | `command` / `script` / `http`,白名单外整条剔除 |
| `command` | command | VS Code 命令 id,必填 |
| `args` | command | 参数数组,字符串项走变量替换,缺省 `[]` |
| `script` | script | 脚本路径,必填,支持变量 |
| `cwd` | script | 工作目录,支持变量,缺省工作区根 |
| `venv` | script | 可选 `{ "enabled": true, "path": "${workspaceFolder}/.venv" }`;启用后把环境的 `bin`（Windows 为 `Scripts`）放到子进程 `PATH` 前面并设置 `VIRTUAL_ENV`;省略 `path` 自动查找脚本目录及配置根下的 `.venv` / `venv` |
| `background` | script | `true` 表示起服类不等退出码,缺省 `false` |
| `url` | http | URL,必填,支持变量;只发配置里写死的地址,不接受运行时拼接 |
| `method` | http | `GET` / `POST` / `PUT` / `PATCH` / `HEAD` / `OPTIONS`,缺省 `POST` |
| `body` | http | 请求体(非空才随请求发送),支持变量 |
| `confirm` | 全部 | 执行前 modal 确认框,缺省 `true` |
| `source` | 全部 | `manual` / `scan`,首装扫描生成的条目自动记 `scan` |
| `category` | 全部 | `server` / `export`,仅扫描生成且命中词表时写(词表外脚本省略该字段) |

变量(执行时替换,只作用于配置字面串):

| 变量 | 含义 |
|------|------|
| `${workspaceFolder}` | 快速动作使用生效配置根(通常是首个工作区根) |
| `${workspaceFolder:名字}` | 按视图名取工作区根(多根工程) |
| `${env:变量名}` | 进程环境变量 |

未知变量直接报错中止并指名变量——静默空串替换会把脚本跑成「路径为空」的假成功,比报错更糟。

示例:

```json
{
  "version": "1.0.0",
  "quickActions": [
    { "name": "重启 BaseApp", "type": "command",
      "command": "kbengine.server.restart", "args": ["baseapp"] },
    { "name": "启动全部组件", "type": "script",
      "script": "${workspaceFolder}/start_server.bat", "background": true },
    { "name": "导配置表", "type": "script",
      "script": "${workspaceFolder}/export_tables.bat" },
    { "name": "本地热更", "type": "http",
      "url": "http://127.0.0.1:9000/reload", "method": "POST", "confirm": false }
  ]
}
```

首次缺配置时扫描生效配置根与 `assetsRoot` 顶层的 `.bat` / `.ps1`;命令 `Rescan Scripts for Quick Actions` 可随时重新扫描。扫描生成的路径与 `cwd` 都指向脚本所在目录；脚本默认不启用 venv，可在对应动作里设置 `"venv": { "enabled": true }`，或指定 `path`。重新扫描只替换 `source: "scan"` 动作，保留手工动作和 `debug` 设置。

### 调试字段(`debug` 段)

| 字段 | 用途 |
| --- | --- |
| `debug.defaultTelnetHost` / `defaultTelnetPort` | `Start Debugging` 提示语里的 telnet 地址(仅提示,不参与实际探测) |
| `debug.components.<组件>.telnetHost` / `telnetPort` | 同上,按组件覆盖 |
| `debug.components.<组件>.telnetEnableCommands` | 提示语里列出的「开启调试命令」,提醒你先经 telnet 输入项目实际使用的命令 |
| `debug.components.<组件>.pathMappings` | `Update launch.json` 生成 attach 配置时写入的路径映射 |

本地 attach 不从这里拿进程号:`Attach to Component` 列出本机进程(匹配组件名的置顶标 ✓),选中即以 PID 组装配置。远程附加的目标来自设置 `kbengine.debug.remoteTargets`,也不读这个文件。

推荐结构:

```json
{
  "version": "1.0.0",
  "debug": {
    "defaultTelnetHost": "127.0.0.1",
    "defaultTelnetPort": 0,
    "components": {
      "baseapp": {
        "telnetHost": "127.0.0.1",
        "telnetPort": 0,
        "telnetEnableCommands": [
          "# 先连接 telnet",
          "# 再输入项目实际使用的开启调试命令"
        ],
        "pathMappings": [
          {
            "localRoot": "${workspaceFolder}",
            "remoteRoot": "${workspaceFolder}"
          }
        ]
      }
    }
  }
}
```

#### 缺失即自动生成（批143）

工作区里找不到 `.kbengine/debug.json` 时,扩展激活期直接生成一份带注释的骨架,不用用户先建文件再猜字段含义:

- 骨架按 **JSONC** 写,允许 `//` 与块注释(同 `tsconfig.json` 口径),每个字段都带一行说明;kode 读配置前会剥注释,所以你自己写的注释不会让配置读不动
- 路径示例一律 `${workspaceFolder}/...` 形态,打开即可编辑
- 同时按既有扫描规则(工作目录一层的 `.bat`/`.ps1`,词表只定分类不过滤)把扫到的脚本写进 `quickActions`;一个都没扫到就留空数组
- **已存在的文件绝不覆盖**:重复激活、用户改过的内容都原样保留;目录不可写时只在「KBEngine 配置」输出通道如实说明,不影响其余能力

#### 工作目录与环境变量

生成位置与 `.pyi` 存根目录取同一个「生效工作目录」,优先级从高到低:

| 档位 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 环境变量 `KBENGINE_WORKSPACE` | 支持 VS Code 官方变量替换,如 `${workspaceFolder}/server`;变量名沿用本仓 `KBENGINE_*` 命名风格 |
| 2 | 配置文件顶层 `workspaceRoot` | 骨架里以注释形态给出,取消注释即可接管 |
| 3 | 默认值 | 首个工作区根 |

取值先过变量替换;替换后为空串视作没写,顺位回落下一档。生效值与来源、被盖掉的来源逐条写进骨架注释和「KBEngine 配置」输出通道,不静默取某一档。

## 路径类配置的自动发现(批125)

设计约束:**尽量减少配置项,能自动发现的就自动发现**。核心功能(打开 `.def` → 实体浏览器/依赖图/属性面板/数据库 schema/悬停存储信息)在干净工作区零配置即可用——下面五项路径配置全部退化为「可选覆盖」:配置了就照配置,没配就按发现链找。

发现链(按序取第一个命中):

1. **显式配置**:`kbengine.entityDefsPath` / `kbengine.entitiesXmlPath` / `kbengine.binPath` 的设置值(支持 `${workspaceFolder}`);
2. **约定路径**:引擎/官方资产固定布局,如 `entity_defs`、`scripts/entity_defs`、`assets/scripts/entity_defs`、`server_assets/scripts/entity_defs`;
3. **有界深扫描**:约定全 miss 时扫工作区找锚点(目录名 `entity_defs`、文件名 `entities.xml`/`types.xml`/`messages_fixed.xml`/`messages_fixed_defaults.xml`(批129 双名)、引擎源码锚点 `entitydef.cpp`/`entity_table_mysql.cpp`),限深 7 层、限 2 万条目,剪掉 `node_modules`/`.git`/`out`/`dist`/点目录,结果按工作区缓存;
4. **唯一命中即用,多候选不猜**:同步读路径只认唯一命中——多个候选时宁缺勿猜(猜测会连带改写 interfaces/components/user_type 全套根目录),改由激活期弹**一次** quick pick 让你选,选择按工作区记忆(`workspaceState`),之后不再询问。

能从已存在文件推断的子路径一律不进配置:def 根推出 `interfaces/`、`components/`、`user_type/` 子目录;`types.xml` 优先取 def 根之下;`entities.xml` 优先取 def 根同父;`messages_fixed(_defaults).xml` 批129 起四级优先级对齐引擎装载序(kbemain.h:71-74,defaults 先载打底、用户副本后载覆盖):工作区用户副本 `messages_fixed.xml` → 引擎源码根用户副本 → 工作区 `messages_fixed_defaults.xml` → 引擎源码根缺省;用户副本与缺省各在各的树里(引擎注释 kbemain.h:133-137:defaults 在引擎 res 树、用户副本在资产树),四级独立取用不要求同目录;纯资产工作区两者皆有或皆无为常态,皆无时发现报告标信息性不计问题。

**三类完全无配置项、纯自动发现的资源**(自批125 起):`types.xml`、`messages_fixed(_defaults).xml`、引擎 `kbengine_defaults.xml`(binPath 推导不出时经引擎源码根锚点兜底再推)。

### 全量配置项对照表(批125 盘点 32 项;此后批126 起持续新增,现状 54 项,新设置见上面「kbengine.* 设置项总览(按功能分区)」各分区)

`现在怎么用` = 当前实际取值方式;`能否自动发现` = 该值是否可以从工作区/环境推导;`处置` = 本轮落地的结论与理由。

| 配置项 | 现在怎么用 | 能否自动发现 | 处置 |
| --- | --- | --- | --- |
| `kbengine.entityDefsPath` | 显式配置 → 约定 4 布局 → 深扫描唯一命中 → 多候选 quick pick 记忆 | **能**(约定布局 + 深扫描) | **自动发现**,配置只作覆盖 |
| `kbengine.entitiesXmlPath` | 同上链;另优先取 def 根同父目录 | **能** | **自动发现**,配置只作覆盖 |
| `kbengine.binPath` | 显式配置 → 引擎源码根锚点推 `kbe/bin/server` → 逐个猜兄弟目录/环境变量 | **能**(源码根锚点 `entitydef.cpp`/`entity_table_mysql.cpp`) | **自动发现**,配置只作覆盖 |
| `kbengine.generator.defOutputPath` | 默认值即走发现出的 def 根(`resolveDefOutputPath`) | **能**(复用 def 根发现) | **自动发现**,配置只作覆盖 |
| `kbengine.generator.pythonOutputPath` | 默认值 `scripts` 时从发现出的 def 根父目录推导;推出工作区/空段保持默认 | **能**(def 根父目录) | **自动发现**,配置只作覆盖 |
| `kbengine.assetsRoot` | 显式配置(默认空 = 自动发现);批128 起原值未过 `res/server/kbengine.xml` 探针时自动发现:约定链(工作区根、`assets/`、`server_assets/`,批129 起含工作区一级 `*_assets` 目录如 `flyff_assets`)→ 记忆选择 → 深扫描唯一命中,多候选激活期询问 | **能**(引擎装载探针验收,批128 已做) | **自动发现**,配置只作覆盖;探针口径 = 引擎真实装载位置,猜错起不来的风险由探针验收消除 |
| `kbengine.telnet.port` | 显式 >0 锁定;0 = 按元件段 → 引擎 defaults 链(批112) | **能**(配置链,批112 已做) | **自动取值**,配置只作覆盖 |
| `kbengine.telnet.password` | 设置 → 元件段 → defaults → 空(批112) | **能**(同上) | **自动取值**,配置只作覆盖 |
| `kbengine.telnet.configXmlPath` | 空 = 按 3 个约定位置自动找 `kbengine.xml` | **能**(已是覆盖式) | **自动发现**,配置只作覆盖 |
| `kbengine.enableDiagnostics` | 开关,默认开 | 否(用户偏好,非可发现事实) | **保留**,默认开即零配置可用 |
| `kbengine.enableStructureDiagnostics` | 同上 | 否 | **保留**,理由同上 |
| `kbengine.diagnostics.checkUnknownTypes` | 开关,默认开 | 否 | **保留**(偏好开关,5 项诊断细分同理) |
| `kbengine.diagnostics.checkUnknownFlags` | 同上 | 否 | **保留** |
| `kbengine.diagnostics.checkUnknownDetailLevels` | 同上 | 否 | **保留** |
| `kbengine.diagnostics.checkDuplicateDefinitions` | 同上 | 否 | **保留** |
| `kbengine.diagnostics.checkMissingPropertyFields` | 同上 | 否 | **保留** |
| `kbengine.hover.showTagDocs` | 开关,默认开 | 否 | **保留**(偏好开关,3 项悬停细分同理) |
| `kbengine.hover.showValueDocs` | 同上 | 否 | **保留** |
| `kbengine.hover.showSymbolDocs` | 同上 | 否 | **保留** |
| `kbengine.showFinalConfigOnOpen` | 开关,默认开;定位不到 defaults 静默跳过 | 否 | **保留**,默认开零打扰 |
| `kbengine.autoRefreshFinalConfig` | 开关,默认开 | 否 | **保留** |
| `kbengine.autoStart` | 组件名列表,默认 `["machine","logger","dbmgr"]` | 否(启动策略是决策不是事实) | **保留**,默认即官方最小可跑组合 |
| `kbengine.loggerPort` | 固定 20022(引擎 logger 监听端口) | 否(运行时网络端口,工作区无痕迹) | **保留**,默认值 = 引擎默认端口 |
| `kbengine.logAutoConnect` | 开关,默认开 | 否 | **保留** |
| `kbengine.webviewConsoleLogs` | 开关,默认开 | 否 | **保留**(页面诊断无须额外步骤即可到达) |
| `kbengine.maxLogEntries` | 数值 10000 | 否 | **保留**(内存/历史的权衡偏好) |
| `kbengine.debug.remoteTargets` | 空列表;远端机器+端口 | 否(远端基础设施,工作区不存在) | **保留**,默认空 = 功能不用即不配 |
| `kbengine.generator.generatePython` | 开关,默认开 | 否 | **保留** |
| `kbengine.generator.registerInEntitiesXml` | 开关,默认开 | 否 | **保留** |
| `kbengine.telnet.host` | 默认 `127.0.0.1` | 否(远端填 IP 是用户知识) | **保留**,本地默认开箱即用 |
| `kbengine.telnet.enableCommands` | 空白名单 = 只放行内置只读快捷命令 | 否(安全策略,放行范围是决策) | **保留**,默认全禁是安全底线,不可代猜 |
| `kbengine.telnet.probeIntervalSeconds` | 数值 5 | 否 | **保留**(频率偏好) |
| `kbengine.httpRequests` | 默认一条停用示例(`enabled: false`) | 否(用户业务接口) | **保留**,示例默认停用不产生副作用 |

计数:**32 项全部保留,0 项删除**(删项会破坏既有用户设置,不做);其中 5 项路径配置从「必须配对」降级为「可选覆盖」,3 项 telnet/取值类本就是覆盖式,21 项是偏好/安全/业务开关(默认值即零配置语义)。另新增 3 类**无配置项**的纯发现资源(types.xml、messages_fixed(_defaults).xml、引擎 defaults 的源码根兜底)。批126 起在此表之外新增 10 项设置(`kbengine.db.tablePrefix`、`kbengine.hotReload.*` 4 项、`kbengine.clientSdk.outputDir`、`kbengine.python.extraPathsSync`/`stubExport`/`stubDir`、`kbengine.python.enableMroJump`),均已在总览分区表登记。

## 常见问题

### 为什么设置改了没有立刻生效?

扩展监听 `kbengine.*` 配置变化,正常即时生效。没刷新时:确认改的是当前工作区或用户设置;确认当前打开的是 `.def` 文件;极端情况关闭再打开文件。

### 哪些配置最值得先调?

嫌提示多,先关这四项:

```json
{
  "kbengine.hover.showTagDocs": false,
  "kbengine.diagnostics.checkDuplicateDefinitions": false,
  "kbengine.diagnostics.checkUnknownDetailLevels": false,
  "kbengine.diagnostics.checkMissingPropertyFields": false
}
```

## 调试模型说明

KBEngine 组件是 C++ 进程内嵌 Python 运行时,不是扩展直接启动一个 Python 脚本。调试固定两步:

1. 先通过 telnet 向组件输入项目实际使用的开启调试命令(telnet 地址/端口/密码按「telnet 端口/密码怎么读」的三层链确认)
2. 再附加进程:本地组件用 `Attach to Component`(进程列表,匹配组件名的置顶标 ✓),远程组件用 `Attach to Remote Component`(目标来自 `kbengine.debug.remoteTargets`,debugpy `connect` 模式)

### Attach 报错排查

按这个顺序查:

1. 目标组件是否已经通过 telnet 真正开启调试(telnet 参数按三层链确认,与 `.kbengine/debug.json` 无关)
2. 进程列表里选的是否就是目标组件本身,而不是 machine/logger 等辅助进程
3. `.kbengine/debug.json` 中的 `telnetEnableCommands` 是否与项目真实命令一致(只影响提示语)
4. `.kbengine/debug.json` 中的 `pathMappings` 是否映射到当前源码目录(远程 connect 模式不写 `pathMappings`)
5. 本机是否已安装 `ms-python.debugpy`,VS Code 能否正常通过它附加进程

旧的 `kbengine.pythonPath`、`kbengine.debugPort`、`kbengine.autoAttachDebug` 已移除,`kbengine.pythonDefsPath`、`kbengine.enablePythonNavigation` 也已移除(导航走 `.def` 定义体系,见实体浏览器)。
