# 功能概览


## 语言能力

- `.def` 语法高亮（内建 XML 语法委托 + 引擎语义着色）
- 类型、Flags、DetailLevel 智能提示
- 标签、值、自定义符号 Hover
- `entities.xml` 与 `.def` 跳转
- entities.xml 实体登记悬停带清单序号（批147，`**Utype**` 行：引擎按 entities.xml 清单顺序分配 utype，序号取首次出现位置）
- def 链合并悬停（批148，source-analysis D5 收口）：`.def` 内悬停根级 `<Parent>` 元素呈现该 def 的继承闭包三面——Parent 链递归、`interfaces/` 平铺、`components/` 挂接，与引擎归并口径一致；父名/接口/组件缺 def 文件如实标注，环被 visited 截断并标注（引擎 loadParentClass 无防环，kode 不照抄）
- `.def` 内实体引用跳转
- Python 与 `.def` 双向导航
- RPC 方法标记（Python 实现脚本里命中 def 方法声明的函数出一行可点 CodeLens，点击跳回 def 声明）
- `.def` 属性/方法 F2 重命名（同文件声明 + 后代 def 复述，见语言能力页边界说明）

## 诊断能力

- 未知类型检查
- 未知 Flags 检查
- 未知 DetailLevel 检查
- 重复定义检查
- 缺失 `Type` / `Flags` 检查
- entities.xml 同名重复登记检查（批147）：同名实体条目引擎按首条静默合并、后续条目不生效，kode 在重复条目上给出 warning；受 `kbengine.enableDiagnostics` 总开关控制

## 工具面板

- 实体浏览器
- 服务器控制面板
- 日志查看器
- 监控面板
- 实体依赖关系图
- 实体架构流程图

说明：
日志查看器当前尚未完成官方 logger watcher 协议适配。
监控面板在 watcher 无响应时只保留 machine 返回的基础状态。

## 原始日志 ERROR 扫描（盘点 G6）

- `Scan Raw Log Errors` 命令选原始日志文件或文件夹（文件夹只扫一层 `.log`/`.txt`/`.out`，按名排序、去重），经与日志面板同一个解析器挑出 `ERROR`/`CRITICAL` 行
- 按「组件 + 归一签名」聚合计数（数字折成 `N`、空白压缩、签名截 160 字符），面板给计数 / 级别 / 组件 / 签名 / 最近时间，点行打开源文件对应行，「重新扫描」按上一批文件重跑
- 不依赖 logger watcher 协议：logger 通道没连上时这条路径照样能用；单文件 64MB 上限，超限或读失败记 readError，不中断其余文件

## Telnet 探测与会话联动

- 配置显式开启 telnet（设置显式端口，或 kbengine.xml 有 `<telnet_service>` 段）才展示 telnet 相关内容；两处都没配时不探测、不展示，状态灯、独立树视图与面板命令入口全部隐藏。引擎 defaults 里虽有 `<telnet_service>` 段，但 defaults 只供数值回落，不单独把 telnet 打开
- 状态栏与服务器控制面板状态灯：已连接 / 已开启·未配密码 / 密码被拒 / 未开启 / 未配置
- 目标解析链：kode 设置（`kbengine.telnet.host/port/password`）→ 元件 `kbengine.xml` 的 `<telnet_service>` 段（`kbengine.telnet.configXmlPath` 指定，未指定时 `kbengine.assetsRoot/kbengine.xml` 优先，再按约定路径探测工作区根：`kbengine.xml`、`res/server/kbengine.xml`、`assets/res/server/kbengine.xml`）→ 引擎 `kbengine_defaults.xml`（经 `kbengine.binPath` 推导）。端口与密码都按这个顺序取第一个非空值；`.kbengine/debug.json` 不参与 telnet 探测
- 探测默认 5 秒一轮，单端口 1.5 秒超时，探完即毁不占连接
- 端口开启时自动握手登录；密码只经 socket 提交，不进日志
- 面板命令输入走白名单加内置只读快捷命令，`:quit` 恒被拒绝
- 断线状态翻转可重连，掉线不崩面板

## 调试支持

- 调试配置只读工作区 `.kbengine/debug.json`：`telnetHost`/`telnetPort`/`telnetEnableCommands` 仅服务 `Start Debugging` 的提示语，`pathMappings` 用于生成 launch.json；telnet 探测/面板/状态灯走上面的三层链，不读这个文件
- 生成的启动配置是 `debugpy` 的 attach 形态；本地附加由扩展列出本机进程（匹配组件名的置顶标 ✓），选中即以 PID 组装配置，不再手输 PID
- 远程附加（`kbengine.debug.attachRemote`）的目标来自设置 `kbengine.debug.remoteTargets`，以 debugpy `connect` 模式直连远端 debugpy 监听端口
- 调试模型：先经 telnet 向组件输入开启调试命令，再附加目标进程
- 编辑期校验（批136 G3）：kode 随包贡献 `.kbengine/debug.json` 的 JSON Schema（`contributes.jsonValidation` 匹配 `**/.kbengine/debug.json`），VS Code 的 JSON 扩展在保存前就把类型写错、`telnetPort` 写成字符串、`pathMappings` 缺 `localRoot`/`remoteRoot`、`method` 不在白名单等问题标红；校验只作提示，解析器逐条剔除与类型回落的规则不变
- 缺失即自动生成（批143）：工作区里找不到 `.kbengine/debug.json` 时，激活期在生效工作目录建 `.kbengine/` 并写一份带注释的骨架；骨架按 JSONC 写（允许 `//` 与块注释，同 `tsconfig.json` 口径），kode 读配置前统一剥注释，你自己写的注释不会让配置读不动。**已存在的文件绝不覆盖**，目录不可写只往「KBEngine 配置」输出通道如实说明，不影响其余能力

说明：
KBEngine 组件是 C++ 进程内嵌 Python 运行时，调试走 attach，不存在「扩展直接启动 Python 脚本」的形态。

## 最终配置视图

- 按引擎装载规则合成最终生效配置：先载引擎默认 `kbengine_defaults.xml`，再以元件 `kbengine.xml` 同键覆盖（子键按名对齐），只读虚拟文档 `kbengine-final.xml`，不落盘
- 三个入口：侧栏 Config 视图的「最终配置」节点、命令面板 `Show Final Server Config`、激活后自动后台打开（`kbengine.showFinalConfigOnOpen`，默认开）
- defaults 或元件 `kbengine.xml` 保存后自动重算（`kbengine.autoRefreshFinalConfig`，默认开）；字段悬浮可看作用说明
- 分层口径与前后对照见 [配置说明](./configuration.md) 的「服务端配置的三层」

## 属性 → 数据库提示与 Schema 视图

- Persistent 属性悬停追加「数据库存储」行：完整 `` `db`.`table`.`column` `` 全名 + 引擎 DDL 片段（列型、`not null`、`DEFAULT`）+ 具体取值约束（整型按 MySQL 区间、varchar 按解析后长度；未写 `<DatabaseLength>` 缺省 255，`entity_table_mysql.cpp:1829-1833`）；同 DDL 多列并作一条（向量三列一条）
- ARRAY / 组件属性不在主表：悬停说明去往的子表与 `parentID` 关联，F12 落 schema 的子表行（子表带 `父表：` 注记）
- 连接要素直接读引擎自身配置（不手填）：合成后的 `<dbmgr><databaseInterfaces><default>`（引擎 defaults + 元件 `kbengine.xml` 同键覆盖），端口 `0` 落 MySQL 默认 3306（`db_interface_mysql.cpp:166-167`）；密码仅在 `<encrypt>false</encrypt>`（明文配置）时读出且从不展示，`encrypt=true` 的 RSA 密文不解读。读值按「工作区 + binPath」缓存，`kbengine*.xml` 或配置变更即失效重读
- Schema 视图（`kbengine.database.open`）：中文标签渲染（批133）。头部给实体名、`存储引擎`、`定义文件` 与 `表: N 张 · 列: M（其中 .def 声明 K）` 概览，配置读得时另给 `数据库: 库名@host:端口`，再附「读图方式」图例（`tbl_` / `sm_` 前缀、引擎列不落 def、`parentID` 关联、flags 含义、SQL 粘贴用法）；每表标 `表类型`（实体表 / 组件表 / 数组子表）、`定义来源`（工作区内相对路径）与 `父表：`，字段分「引擎列（引擎自动建，.def 无需声明）」（`id` / `autoLoad` / `parentID` / 位置朝向六列各带固定语义注解）与「属性列（.def 里声明的）」两组，属性列行尾 `← 文件:行 <属性>` 标 def 落点，只有引擎列的表照实提示 `属性列: 无（本表只有引擎列，没有 .def 声明的数据列）`；每表尾部给三行可粘贴 SQL（全列 SELECT、只含 def 属性列的 `SQL(属性列)`、子表的 `SQL(子表 JOIN)` 按 `parentID` 关联父表，`LEFT JOIN` 保住空元素属性行）；均带库表前缀与反引号转义，库名读不到时退化为表级全名，仍合法
- 库表前缀可覆盖：设置 `kbengine.db.tablePrefix`（缺省空 = 引擎默认 `tbl_`），表名与三行 SQL 模板同源替换；ARRAY 子表悬停同样给出可粘贴的 JOIN 语句
- types.xml 类型形态与引用反扫（批134）：类型声明名悬停追加「落库形态」（builtin 落主表单列附列型、FIXED_DICT 平铺成列不成表、ARRAY 成 `tbl_<实体>_<属性>` 子表并递归一层元素落列、未解析明说引擎装载会失败）；声明行上方 CodeLens 逐条反扫真实引用落点（`Hero.itemId → tbl_Hero.sm_itemId`），点击打开该实体 Schema 视图定位到对应列，超 10 处折叠计数镜，`.def`/`types.xml`/`entities.xml` 变更即失效重扫；反扫落点取自 schema 快照（与渲染同一套引擎语义），不另造落库规则
- 数据库漂移校验（`kbengine.database.checkDrift`）：拿真实表结构反向校验 def 推导的虚拟表结构，报缺表 / 缺列 / 多列 / 型别不符 / 残留表；连接信息读引擎配置（`encrypt=false` 明文密码），只放行 `SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN` 且连接以只读会话打开，连不上降级为「未校验」不报错。详见 [数据库漂移校验](./database-drift-check.md)

## 数据库模拟

- 在数据库 schema 快照之上模拟建表与行数据:`.dbsim` 虚拟文档一体展示 DDL、模拟行 JSON、INSERT 语句与引擎差异清单
- DDL 逐条对齐引擎 MySQL 落库实现(表前缀 `tbl_`、`parentID` 子表列、`sm_autoLoad`、逐类型列型别、`(@DATALEN@)` 空宽度剥离、`ENGINE=InnoDB`),出处见 [数据库模拟](./database-simulation.md)
- 行校验走严格引擎语义:任一不过整条拒绝,DELETE 递归级联清子表;UNIQUE 预检是模拟器比引擎多做的事,已如实登记
- 入口:`Simulate Entity Database`(不传实体名时取活动 `.def` 推断)、`Export Entity Database Simulation`(导出 Markdown)

## 配置自动发现

- 干净工作区零配置可用核心功能(打开 `.def` → 实体浏览器/依赖图/流程图/属性面板/数据库 schema/悬停)
- 发现链:显式配置 → 约定布局 → 有界深扫描(限深 7 层/2 万条目,剪 node_modules/.git 等)→ 唯一命中即用,多候选激活期弹一次 quick pick 并按工作区记忆
- 服务器资产根 `kbengine.assetsRoot` 同链发现(批128):原值以引擎装载探针 `res/server/kbengine.xml` 验收,未通过时按约定链(工作区根、assets/、server_assets/)→ 记忆选择 → 深扫描唯一命中兜底,telnet 探测与最终配置视图同步受益
- 纯发现、无配置项:`types.xml`、`messages_fixed(_defaults).xml`、引擎 defaults 的源码根兜底;def 根推出的子路径(interfaces/components/user_type)不进配置
- 定位失败不再静默:`kbengine.discovery.report` 命令在 OUTPUT 面板逐键摊开发现结果(最终取用值与来源、显式配置存在性、约定链命中/未命中、深扫描命中、记忆选择、深扫描截断标注),附逐项补救建议,报告可整段复制回传维护者
- 详见 [配置说明](./configuration.md) 的「路径类配置的自动发现」与全量对照表

## Python 生态接线（盘点 G1 / G2）

- extraPaths 接线（批136 G1）：把工作区发现的 KBEngine scripts 根写入 `python.analysis.extraPaths`（WorkspaceFolder 级），只管理本扩展写入的那一段——用户手填路径永不被动，无变化不写、无可发现根静默；`Sync Python Extra Paths` 命令手动重跑，激活期自动同步一次全程零提示（`kbengine.python.extraPathsSync` 默认开可关）
- `.pyi` 存根导出（批136 G2）：把内置 KBEngine Python API 符号索引（与补全/悬停/跳转同源）导出为真文件 `KBEngine.pyi`——虚拟桩文档 Python 扩展看不见，真文件配合 extraPaths 接线才解析 `import KBEngine`；内容一致零写、索引更新后陈旧才重写，激活期静默自动一次，`Export KBEngine Python Stubs` 手动入口导出后链一次 extraPaths 同步
- 存根目录可配（批142）：`kbengine.python.stubDir` 三级解析——设置 > 环境变量 `KBENGINE_STUB_DIR` > 默认约定 `.kbengine/stubs`。默认目录归 kode 自管（按内容比对刷新）；**用户指定的目录只进不出**：目录里已有任何 `.pyi` 一律当用户资产不覆盖，没有才生成一份，目录读不到如实提示不盲写
- types.xml 类型桩（def-pyi-stubs §6）：把 `entity_defs/types.xml` 自定义类型导出成真 `.py` 模块 `kbe_types.py`（`FIXED_DICT`→`TypedDict`、`ARRAY`→`List[元素]`、别名→类型名，别名按依赖拓扑排序，成环/空指引跳过并说明）——真模块既是 Pylance 类型来源也可被运行时 `import kbe_types`；与 `KBEngine.pyi` 同目录同开关（`kbengine.python.stubExport`），内容确定性保证零写纪律，`Export KBEngine Python Type Stubs` 手动入口导出后链一次 extraPaths 同步，`types.xml` 落盘（保存/新建/删除）后由 watcher 静默自动重生成

## 变量替换（批141）

- 路径类设置、`.kbengine/debug.json` 的 `quickActions` 与 `workspaceRoot`、`kbengine.python.stubDir` 走同一套 VS Code 官方变量替换，不再各处各写一份
- 支持 `${workspaceFolder}`、`${workspaceFolderBasename}`、`${file}`、`${fileBasename}`、`${fileBasenameNoExtension}`、`${fileDirname}`、`${fileExtname}`、`${relativeFile}`、`${relativeFileDirname}`、`${cwd}`、`${userHome}`、`${pathSeparator}`、`${env:NAME}`
- 相对路径族只在文件落于某个工作区根之下时给相对写法，区外回退绝对路径；未知变量按语义分两种口径——quick action 执行期报错并指名变量中止（静默空串会把脚本跑成「路径为空」的假成功），路径类设置回落空串沿既有约定

## HTTP 快捷请求

- 设置 `kbengine.httpRequests` 列表：名称 / URL 模板 / method / 请求头 / 请求体 / 启停 / 键位展示串
- 模板变量 `${module}` / `${file}` / `${line}` / `${sel}`，按字面替换、不做 URL 编码；`${module}` 取工作区相对模块路径（`entities/fight/FightAI.py` → `entities.fight.FightAI`）
- 触发两路：命令面板 quick pick；经 keybindings.json 为 `kbengine.httpRequest.run` 配 `args.name` 键位直发
- 执行流水进 OUTPUT 面板「KBEngine HTTP 快捷请求」；失败以 `✗` 标记加错误弹窗呈现

字段与变量表见 [配置说明](./configuration.md)，命令细节见 [命令与面板](./commands.md)。

## 快速执行动作

- 动作清单写在工作区 `.kbengine/debug.json` 顶层 `quickActions` 数组（跟着 KBEngine 工程走，不进 VS Code 设置、不进 `launch.json`）
- 三类后端白名单：`command`（VS Code 命令）、`script`（配置里显式声明的脚本）、`http`（配置里写死的本地热更 URL）；不做任意 shell 入口
- 触发两路：Servers 视图标题栏按钮 + `.def` / Python / XML 编辑器右上角按钮 + 命令面板 `Run Quick Actions`
- 动作缺省弹 modal 确认框，流水进 OUTPUT 面板「KBEngine 快速执行动作」，失败一次性弹窗并留退出码/状态码
- 首装扫一层工作区根的 `.bat` 与 `.ps1`，全部列入多选提示登记（词表只定分类），取消后本工作区不再自动弹

命令细节见 [命令与面板](./commands.md)，配置键与变量表见 [配置说明](./configuration.md)。

## 自动热重载（盘点 G5）

- 文件保存/监视 → 按名触发上面的 `quickActions` 动作。门控 `kbengine.hotReload.enabled` **默认关**防误触：开启前不建任何文件监视，激活期行为零变化；开关改动即时生效，不必重启窗口
- 变更、创建、删除三通道都算保存事件，经去抖合并成一次执行；触发路径跳过执行确认框，动作自身的失败仍照常弹窗报错
- `actionName` 留空或匹配不到任何动作时，事件照常触发但只往 OUTPUT 通道「KBEngine 快速执行动作」落一行流水，不弹窗、不执行

## 依赖图能力

- Mermaid 可视化
- 继承与 `ENTITYCALL` 关系展示
- 图中跳转到实体定义
- 导出 SVG
- 导出 PNG

## 流程图能力

- 客户端到 baseapp/cellapp 的方法调用与属性自动同步关系，Mermaid 可视化
- 边语义按属性 `Flags` 位标注，逐边列出引擎出处（文件:行号）与成员声明位置
- 点击成员行回跳 `.def` 声明处
- 未 Exposed 的 BaseMethods 单列「客户端调不到的方法」
- 刷新重读磁盘上的 `def`/`entities.xml`
- 导出 Markdown、SVG、PNG

## 代码生成

- 实体创建向导
- 预置模板（10 个：账号、角色、NPC、物品、怪物、场景、公会、队伍、邮件、空实体）
- 自动生成 `.def`
- 自动生成 Python
- 自动注册到 `entities.xml`
- 客户端实体 SDK 生成（按 `entities.xml` 登记的实体生成客户端骨架，TypeScript / C# 可多选）
- 定义形态向导（批139，盘点 G7）：实体向导之外一次生成一种形态——代理（`proxy_defs/` 下的 Proxy def，`Parent` 指向同名 Proxy）、空间（`entities.xml` 登记 `hasBase` + `hasCell`）、组件（`components/` 下 def，可选往实体 `<Properties>` 段末挂一条 `COMPONENT` 属性）、固定字典类型（写入 `types.xml`）。已存在的文件默认不覆盖，重复登记与结构异常都如实说明不硬插

说明：
生成器会受 `kbengine.generator.*` 和 `kbengine.entitiesXmlPath` 配置影响；客户端实体 SDK 受 `kbengine.clientSdk.outputDir` 影响。

## 性能分析

- 工作区全量 `.def` 静态检查（`Analyze Def Performance` 命令）
- 优化建议写入输出面板，并以诊断落入问题列表

## 代码片段生成

- 选区生成自定义片段（`Generate Snippet from Selection` 命令）
- 片段语法转义并剥离公共缩进（按编辑器 `tabSize` 列语义，tab/空格混用仍保相对层级），合并写入 `.vscode/kbengine-custom.code-snippets`
