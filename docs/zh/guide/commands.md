# 命令与面板


本页整理 Kode 在 VSCode 中暴露的主要命令、入口位置和适用场景。

## 命令面板中的命令

可以通过 `Cmd/Ctrl + Shift + P` 打开命令面板，按标题关键词查找，如
`Server`、`Entity`、`Log`（命令标题不带 `Kode:`/`KBEngine:` 前缀）。

## 实体浏览器

### `kbengine.refreshExplorer`

- 标题：`Refresh`
- 作用：刷新实体浏览器列表
- 入口：
  - 实体浏览器标题栏按钮
  - 命令面板

### `kbengine.entity.open`

- 标题：`Open Entity Definition`
- 作用：打开指定实体的 `.def` 文件
- 入口：
  - 点击实体浏览器中的实体项
  - 命令面板

### `kbengine.entity.method.open`

- 标题：`Open Entity Method`
- 作用：打开方法符号的定义或 Python 实现
- 入口：
  - 点击实体浏览器中的方法条目
  - 命令面板

### `kbengine.defMethodConsistency.revalidate`

- 标题：`Revalidate Def Method Consistency`
- 作用：重算某 `.def` 文档的 def↔Python 方法一致性诊断(正向 `def-method-missing-in-python` 与反向 `python-method-not-in-def`);一键生成实现 CodeAction 应用编辑后自动触发,诊断不等保存即消除——带 `.def` URI 参数(命令面板裸跑为 no-op)
- 入口：
  - 自动：由 `.def` 方法符号上的一键生成实现 CodeAction 附加
  - 命令面板

### `kbengine.database.open`

- 标题：`Open Database Schema`
- 作用：打开实体属性对应的数据库表结构虚拟文档（中文标签渲染：头部给 `数据库: 库名@host:端口` 连接行与「读图方式」图例，每表标 `表类型` / `定义来源` 并分「引擎列（引擎自动建，.def 无需声明）」与「属性列（.def 里声明的）」两组，属性列行尾 `← 文件:行 <属性>` 标 def 落点；每表尾部给可直接粘贴进外部 MySQL 客户端的 SQL：全列 SELECT、只含 def 属性列的 `SQL(属性列)`，子表另有按 `parentID` 关联父表的 `SQL(子表 JOIN)`；表前缀可由 `kbengine.db.tablePrefix` 覆盖）
- 入口：
  - 活动栏 KBEngine Explorer → **Entities** 视图 → 展开实体 → `Database` 分组 → 点击表或字段条目
  - 命令面板：`Open Database Schema` 无参直开时取当前活动 `.def` 推断实体；无活动 `.def` 时提示「请先打开一个实体 .def 文件」，不静默无反应

### `kbengine.database.simulate`

- 标题：`Simulate Entity Database`
- 作用：在 schema 之上模拟建表与行数据，打开数据库模拟虚拟文档（DDL、模拟行 JSON、INSERT 语句与引擎差异说明一体展示）；不传实体名时取当前活动 `.def` 文件推断
- 入口：
  - 命令面板
- 详见：[数据库模拟](database-simulation.md)

### `kbengine.database.exportSimulation`

- 标题：`Export Entity Database Simulation`
- 作用：把当前打开的数据库模拟虚拟文档导出为 Markdown 文件；需先打开 `.dbsim` 模拟文档
- 入口：
  - 命令面板
- 详见：[数据库模拟](database-simulation.md)

### `kbengine.database.checkDrift`

- 标题：`Check Database Drift`
- 作用：用真实表结构反向校验 `.def` 推导出的虚拟表结构，逐表比对缺表、缺列、多列、型别不符与残留表，报告写进「KBEngine 数据库漂移」输出面板；不传实体名时取当前活动 `.def` 文件推断
- 前置条件：引擎配置里的数据库账号密码需明文存放（`<encrypt>false</encrypt>`）；密码为 RSA 密文或连不上时降级为「未校验」提示，不报错
- 超时/取消（IDE-REV-017）：建连与每条查询都在 `kbengine.databaseQueryTimeoutMs` 时限和可取消的进度通知下运行——超时或取消即按该原因返回（原因随未校验报告展示），连接等底层查询结算后释放（挂死的强制销毁），入口不会永久等待
- 证据（IDE-REV-020）：真实执行（报告 checked）按引擎版本把漂移证据落 workspace state 并在输出通道尾附结论行——实际查询面（真实 MySQL）与模拟面（def 推导基准，标非实测）分开记录；引擎版本探不到记 `unknown`、结论保持 unknown-version 不宣称兼容；未校验（连不上/读不到结构）不落证据并在通道如实说明
- 入口：
  - 命令面板
- 详见：[数据库漂移校验](database-drift-check.md)

### `kbengine.database.showDriftEvidence`

- 标题：`Show Drift Evidence`
- 作用：在「KBEngine 数据库漂移」输出面板重查已保存的漂移校验证据（IDE-REV-020）——按引擎版本一块、最新在前，各带分类结论（`compatible-verified` / `unverified` / `unknown-version` / `drift-found`）、实际查询面摘要（真实 MySQL）、模拟面摘要（def 推导基准，标非实测）与记录时间
- 行为：
  - 只有真实执行落证据（`kbengine.database.checkDrift` / `checkAllDrift` 报告 checked）；未校验不落——模拟面单独存在也不冒充联调结果
  - 尚无证据时如实说明（通道+信息提示），不虚构任何记录
- 入口：命令面板

### `kbengine.database.checkAllDrift`

- 标题：`Check All Database Drift`
- 作用：检查所有工作区实体的真实 MySQL 表结构，一次连接并将全部实体表合并判断残留表
- 前置条件：同 `kbengine.database.checkDrift`
- 超时/取消：与 `kbengine.database.checkDrift` 同一时限与进度通知取消（逐建连/逐查询），共用一条守卫连接
- 证据（IDE-REV-020）：真实执行同样按引擎版本落证据并在通道尾附结论行（口径同 `kbengine.database.checkDrift`）；未校验改为如实说明不落证据
- 入口：命令面板
- 详见：[数据库漂移校验](database-drift-check.md)

### `kbengine.database.previewTable`

- 标题：`Preview Table Data`
- 作用：单表只读预览（IDE-REV-016）——选一张表，「KBEngine 数据库预览」输出通道里看到最多 100 行；实际执行的语句恒为白名单固定形 `SELECT * FROM \`表\` LIMIT N`（执行前再过只读语句门自证，连接本身也以只读会话打开）
- 入口：命令面板
- 行为：
  - 连接与漂移校验命令同源（per-profile 台账）；读不到引擎数据库配置就如实说明、什么都不执行
  - 表选择器列出 `SHOW TABLES` 结果；清单拿不到（权限）或库里没表时退手输表名，标识符口径与预览语句一致
  - 选择器（或手输）取消不发预览查询；数据库连不上如实报连接原因、不产出输出
  - 建连与每条查询都在 `kbengine.databaseQueryTimeoutMs` 时限和可取消的进度通知下运行（IDE-REV-017）：超时或取消即按该原因返回并释放连接——正在释放的连接上不再退手输面
  - 超上限的行被裁并在尾注标「已截断」，尾注同时给出实际执行的 SQL
  - 列来源（IDE-REV-018）：表格之后附「列来源」段，把每个结果列关联回声明——推导列给出真实 `.def`/`types.xml` 声明处的 `filePath:line`（输出面板可点击定位，附声明类型原文），引擎结构列如实说明为合成列、无声明处可跳，虚拟 schema 外的列保持如实未知；整表不在任何工作区实体推导面内时整段如实说明，不猜邻居表

### `kbengine.database.previewSchemaImpact`

- 标题：`Preview Schema Impact`
- 作用：单实体结构影响只读预览（IDE-REV-019）——把该实体真实表结构（`SHOW FULL COLUMNS` 只读查询）与 def 推导虚拟 schema 对照，「KBEngine 结构影响预览」输出通道里给出按当前 def 同步库会发生的新增 / 移除 / 类型变化清单；命令内不存在任何 DDL 或写库通路
- 入口：命令面板；可带实体名参数
- 行为：
  - 实体选择：命令参数 → 活动 `.def` 文件 → 工作区注册实体选择器；取消或注册表为空时如实不执行
  - 对照前归一整数显示宽度（`int(10) unsigned` 与 `int unsigned` 视为一致，与漂移校验同口径）；引擎结构列（id / sm_autoLoad / …）按 def 侧 synthetic 名单两侧同口径剔除，不会报成「移除」
  - 表还不在库里时如实说明「整表新建」并给出 def 推导列数，不虚构对照
  - 连接与漂移校验命令同源（per-profile 台账）；读不到引擎数据库配置就如实说明、什么都不执行
  - 建连与查询都在 `kbengine.databaseQueryTimeoutMs` 时限和可取消的进度通知下运行（IDE-REV-017）：超时或取消即按该原因返回；所有分支收尾都关连接
  - 报告头部明示只读范围；无差异如实写「无结构差异」

### `kbengine.database.showManagement`

- 标题：`Show Database Management`
- 作用：打开常驻只读数据库管理 WebView，MySQL/Redis 双标签——派生数据库档案解析到哪种后端（`mysql` / `redis` / `none`）就展示哪一面；MySQL 标签列 `SHOW TABLES` 并网格预览单表，Redis 标签枚举 `kbe_*` 键并经 `HGETALL` 预览哈希
- 行为：
  - 活动标签跟随档案后端；`none` 档案（未读取到派生档案）如实出「未读取到引擎数据库档案」注记并禁能两个后端按钮，不虚构连接
  - 全程只读：MySQL 走与漂移校验同源的只读执行器（`SET SESSION TRANSACTION READ ONLY` + 语句白名单），Redis 走内建 RESP2 客户端只读命令（`SCAN`/`HGETALL`）——无写、无 DDL、无删除
  - 连接 open-per-operation（建连→工作→`finally` 关闭），不持长驻连接；切标签 / 关面板弃置在途结果，不把旧结果渲染进新视图
  - 密码不可读（`<encrypt>` 非 `false`，引擎 RSA 密文）在单点门禁出「密码不可读」——面板绝不尝试空密码连接
  - 建连失败与超时（10 秒）降级为面板内错误条，另一标签仍可用
  - 表名先经 `[A-Za-z0-9_$]` 校验再建连；预览语句保持白名单形状 `SELECT * FROM \`table\` LIMIT N`
  - Redis 键枚举有页上限（`REDIS_SCAN_PAGE_LIMIT`）并如实报告截断，不静默装完整
- 入口：命令面板

## 玩家数据克隆

### `kbengine.clone.configureSource`

- 标题：`Configure Clone Source Connection`
- 作用：保存玩家数据导出用的只读源库台账（CLONE-P5）
- 入口：命令面板
- 行为：
  - 分步向导（UX-REVIEW-005a/005c）：主机、端口（仅数字，留空 = 3306）、用户名、密码（只存 SecretStorage、任何摘要都不回显；留空 = 清除已存密码）、数据库名。每步标题带角色与步骤序号（如 `Source 2/5`）；非密码字段按已存台账预填，保存过的连接可再次运行修改
  - 任一步取消即结束，什么都不保存
  - 输入完成后给出不含密码的摘要（主机/端口/用户/数据库 + 密码状态），提供「保存 / 测试连接 / 返回修改 / 取消」，已存密钥且本次密码留空时另有「保留已存密码」（「保存」在密码留空时清除已存密钥；「保留」保存连接但 SecretStorage 旧密钥原样不动）：只有「保存 / 保留」落盘；「测试连接」用草稿值建连（密码留空按保存语义取已存密钥），成功报服务器版本、失败报原始原因，测试不落盘；「返回修改」选中字段重填并预填当前草稿值；密钥面写失败如实报错，台账不动、不虚报已保存

### `kbengine.clone.configureTarget`

- 标题：`Configure Clone Target Connection`
- 作用：保存玩家数据导入用的可写目标库台账（CLONE-P5）
- 入口：命令面板
- 行为：
  - 与源台账同一套向导（含环境选择共 6 步），另加环境选择器——只认 `local` / `test`,prod / staging 在此配置闸即拒（不等 Rust 规划器 fail-closed 复核）；摘要同时列出所选环境
  - 密码只进 SecretStorage；清除配置即同时清除密钥

### `kbengine.clone.testSource`

- 标题：`Test Clone Source Connection`
- 作用：用真实 `SELECT VERSION()` 验证已存的源台账（CLONE-P5）
- 入口：命令面板
- 行为：
  - 成功回报服务器版本；失败如实报连接原因；未配置台账如实说明、不建连接

### `kbengine.clone.testTarget`

- 标题：`Test Clone Target Connection`
- 作用：用真实 `SELECT VERSION()` 验证已存的目标台账（CLONE-P5）
- 入口：命令面板
- 行为：
  - 成功回报服务器版本；失败如实报连接原因；未配置台账如实说明、不建连接

### `kbengine.clone.export`

- 标题：`Export Player Data to Archive`
- 作用：把一个玩家实体的已持久化行导出为 `.kdpclone` 归档（CLONE-P5）
- 入口：命令面板
- 行为：
  - 预检先于一切信息收集（UX-REVIEW-004b）：Rust 后端可用性（缺席如实报错、不弹任何输入）、真实源连接测试（失败如实报因，提供重试 / 配置连接入口；配置走完向导后流程续接；关闭对话框即中止）、实体表结构推导检查——全部前置于 DBID 输入，绝不先丢已输入的 DBID
  - 选注册实体、输根 DBID（仅数字）、选保存路径（`.kdpclone`）
  - 源会话只读打开;物理表经 `information_schema` 探测（标识符校验），只读 SELECT 计划来自 Rust 核心（`$/kode/dbClone/planExport`）；Rust 后端缺席时命令如实报告、不假装算过
  - 计划预览（表 / 行预算 / 缺失表）写进「KBEngine Player Clone」通道，显式确认后才执行；执行可取消（只读面取消即停，无回滚问题）
  - 敏感列写归档时默认脱敏；DBID 零行如实不导出

### `kbengine.clone.inspectArchive`

- 标题：`Inspect Player Clone Archive`
- 作用：查看 `.kdpclone` 归档清单（CLONE-P5）
- 入口：命令面板；资源管理器 `.kdpclone` 文件右键
- 行为：
  - 只回实体、格式/版本、逐表行数、加密位、`checksums.json` / `redaction-report.json` 存在性——不回显任何行值
  - 每次查看都重复告示：这是数据库已持久化数据副本（Persisted copy），不代表在线当前状态（Live state）

### `kbengine.clone.import`

- 标题：`Import Player Data from Archive`
- 作用：把 `.kdpclone` 归档导入已配置的本地/测试目标库（CLONE-P5）
- 入口：命令面板；资源管理器 `.kdpclone` 文件右键
- 行为：
  - 预检（在任何信息收集前）：Target 连接必须已配置——未配置时提供「配置 Target 连接」向导入口（拒绝或取消向导则不再收集后续信息）；Target 环境必须为 `local`/`test`（其余一律拒绝——导入绝不写生产/预发布）；探测会话建立后先跑真实 `SELECT VERSION()` 连接检查——失败如实报因并注明「导入未开始」，不登记防重、不生成计划、不写入
  - 两遍计划：pass-1 定列序 → 归档内实际出现的唯一值有界 `WHERE IN` 只读探测 → pass-2 冲突预演（本地重建 `_imported` 后缀）
  - 预览通道给出逐表语句、ID 变更类别、唯一冲突、账号绑定、未解决引用风险与告警——随后需要两次显式确认（继续、确认对本地库真实写入）
  - 整份计划以 mysql2 单事务执行：新键绑 NULL 交 AUTO_INCREMENT、insertId 回填进键引用，任何失败或取消即回滚——绝不留半个角色；随后逐表 COUNT 复核、生成但不执行的逆拓扑清理计划、`.kode/clone-runs/` 审计 JSON
  - 引擎侧原生加载验证如实未接线（`load_verification.attempted=false`）；已接线复核面是 COUNT 核对

### `kbengine.clone.showAudit`

- 标题：`Show Player Clone Import Audits`
- 作用：回放 `.kode/clone-runs/` 里的历史导入审计 JSON（CLONE-P5）
- 入口：命令面板
- 行为：
  - 在既有审计文件中选择并打印到「KBEngine Player Clone」通道；暂无审计如实说明
## 服务器控制

### `kbengine.server.start`

- 标题：`Start Server`
- 作用：
  - 传入组件时启动单个组件
  - 不传组件时按 `kbengine.autoStart` 启动一组组件

### `kbengine.server.stop`

- 标题：`Stop Server`
- 作用：
  - 传入组件时停止单个组件
  - 不传组件时停止全部组件

### `kbengine.server.restart`

- 标题：`Restart Server`
- 作用：重启单个组件

### `kbengine.server.showLogs`

- 标题：`Show Logs`
- 作用：聚焦某个组件的日志上下文

### `kbengine.server.retry`

- 标题：`Retry Failed Target`
- 作用：
  - 带元件参数时重试该单个失败目标
  - 不带时给出组启动失败目标的选择器（含失败原因），重试所选
  - 已就绪目标报已在运行，不重启

## 日志相关

### `kbengine.logs.showViewer`

- 标题：`Show Log Viewer`
- 作用：打开日志 WebView

### `kbengine.logs.connect`

- 标题：`Connect to Logger`
- 作用：连接 KBEngine logger 端口

### `kbengine.logs.disconnect`

- 标题：`Disconnect from Logger`
- 作用：断开日志连接

### `kbengine.logs.clear`

- 标题：`Clear Logs`
- 作用：清空当前日志面板缓存

### `kbengine.logs.export`

- 标题：`Export Logs`
- 作用：导出日志内容

### `kbengine.logs.scanErrors`

- 标题：`Scan Raw Log Errors`
- 作用：选择原始日志文件或文件夹（文件夹只扫一层 `.log`/`.txt`/`.out`），扫描其中的 `ERROR`/`CRITICAL` 行并按「组件 + 归一签名」聚合计数，在 WebView 面板展示计数/级别/组件/签名/最近时间；点击命中行打开源文件对应行，「重新扫描」按上一批文件重跑

## 调试相关

> **Python 3.7.3 版本约束：**引擎包锁定 `debugpy==1.7.0`，VS Code 调试器锁定 `ms-python.debugpy@2024.0.0`，Python 扩展复现基线为 `2024.0.1`。现有自动安装/同步路径仍假定新版 Python，不能用于该目标；请按[固定版本安装说明](python-debugger-compatibility.md)手工准备。

### `kbengine.debug.updateLaunchJson`

- 标题：`Update launch.json`
- 作用：根据 `.kbengine/debug.json` 的 `pathMappings` 生成或更新 VSCode 的 PID attach 配置；已配置 `kbengine.debug.remoteTargets` 时，同时把远程目标以 debugpy `connect` 形式追加进去；`debug.json` 里配置了 `debugpyPort`（或已记住端口模式）的组件，另各生成一条指向其实际端口的 debugpy `connect` 条目（与端口模式动态写入口同名同体，重跑不会把端口模式的 F5 落点刷掉）
- 行为：只替换 `KBEngine:` 前缀的条目，用户自建条目与 `inputs` 原样保留；`.vscode/launch.json` 带注释（JSONC）或语法坏掉时拒绝改写并如实说明（改写会丢内容），绝不盲写；读-改-写走串行闸，与端口模式动态写入并发也不丢条目

### `kbengine.debug.createConfig`

- 标题：`Create Debug Config Template`
- 作用：创建示例调试配置文件 `.kbengine/debug.json`

### `kbengine.debug.start`

- 标题：`Start Debugging`
- 作用：显示目标组件的 telnet 调试提示，然后进入附加流程；配置了 `debugpyPort` 的组件跳过简报直连该端口（IDE-PDBG-001）

### `kbengine.debug.attach`

- 标题：`Attach to Component`
- 作用：附加到已开启调试的 KBEngine 组件进程——配置了 `debugpyPort` 的组件直接 connect 该端口（端口模式）；未配置时按记住的模式走：端口模式（组件默认端口表，表外 5678）或进程附加（本机进程选择器）
- 行为：
  - 未配置端口且第一次使用会先问选端口模式还是进程附加模式（记入工作区状态；`kbengine.debug.resetAttachMode` 清除）
  - 端口模式先对 debugpy 端口做 TCP 探测（IDE-PDBG-002）：端口通零多余弹窗直接附加；不通分开说原因，本机解释器链没装/过老 debugpy 时给一键 `pip install -U debugpy` 或手装指引——装完再探一次端口（装包本身不会开端口）
  - 端口仍不开即进「下一步」引导（不再是死路）：提示带最新未开原因、三条起监听路径与 launch.json 落点，三个控件——`起监听并附加`（先确保 debugpy 已同步进 `<assets>/scripts/common/debugpy`，再等该组件 telnet 就绪经 `:python` 层发 `debugpy.listen`，成功后重探端口并立即附加；失败如实报错不假成功）、`重试附加`（直接重探，端口已从别处起来就接上）、`起监听指引`（三条路径 + 可复制的 `python -m debugpy --listen 127.0.0.1:<口> --wait-for-client <入口脚本>`）
  - 端口模式每次附加都把该组件 `host:port` 的 connect 条目幂等写进 `.vscode/launch.json`（`type`/`request`/`connect` 三件套；用户条目与手改字段原样保留，同组件旧端口的生成条目回收；文件带注释或语法坏则拒绝改写并说明）——Run and Debug 里可直接 F5 附加
  - 匹配目标组件名的进程置顶并标 ✓，其余按系统进程清单原序排列
  - 选中后以该进程 PID 直接组装 debugpy attach 配置，不再手输 PID
  - 获取不到进程列表时明示报错，不空转

### `kbengine.debug.attachRemote`

- 标题：`Attach to Remote Component`
- 作用：附加到远程机器上已开启调试的 KBEngine 组件进程（debugpy `connect` 模式，直连远端 debugpy 监听端口）
- 前提：在设置 `kbengine.debug.remoteTargets` 里配置目标列表（名称 + IP + debugpy 端口，端口缺省 5678）；远端组件需先经 telnet 发开启调试命令并起好 debugpy 监听
- 行为：
  - 未配置目标时提示去设置，不空转
  - 弹出目标选择，模态确认后以 `connect: {host, port}` 组装附加配置；目标条目带成对 `localRoot`/`remoteRoot` 时才写 `pathMappings`

### `kbengine.debug.resetAttachMode`

- 标题：`Reset Debug Attach Mode Choice`
- 作用：清除记住的附加模式选择（IDE-PDBG-001），下次 `Attach to Component` 重新在端口模式与进程附加模式之间询问
- 行为：
  - 只清工作区状态里的键并弹确认提示，本身不发起任何附加
  - 配置了 `debugpyPort` 的组件不受记忆影响，恒走端口模式

### `kbengine.debug.debugpyInject`

- 标题：`Inject debugpy Listener and Attach`（注入 debugpy 并附加）
- 作用：debugpy 一键注入（KODE-DBG-001，docs/design/debugpy-attach.md 提案的方案②控制台注入）——经组件 telnet 的 `:python` 层发送 `debugpy.listen`，随后走端口模式附加；不改引擎、零文件改动
- 入口：命令面板
- 行为：
  - 列出运行中组件（默认实例按组件名，命名实例为 `component#实例`）；取消选择则什么都不做
  - 端口：逐组件分配表（baseapp 5678/cellapp 5679/loginapp 5680/dbmgr 5681/logger 5682，表外回落 5678），只绑 `127.0.0.1`
  - 起监听：复用既有单发通路——资产树缺 debugpy 包先同步，等 telnet 就绪后经短命 telnet 客户端注入；起监听失败如实报原因，绝不硬附加
  - 附加：监听就绪后复用 `Attach to Component` 的端口模式（探端口→connect）；附加未完成时报错指回 `Attach to Component` 重试
  - 受 `kbengine.debug.debugpyInject` 开关控制（默认开）；关闭时命令只提示不动作
  - 启动最早期断点不属本命令——用 `kbengine.debug.waitAtStartup`（同一提案的方案①引导块）

### `kbengine.debug.pyspyDump`

- 标题：`Profile Component with py-spy`
- 作用：py-spy 性能分析入口（IDE-PDBG-003），在服务器树 debug 附加图标后inline 呈现（`$(pulse)`）；对目标组件进程跑 `py-spy dump` 把 Python 调用栈写进「KBEngine py-spy」输出通道
- 入口：服务器树 inline 图标（debug 图标后）或命令面板
- 行为：
  - 进程选择复用既有选择器（组件名命中置顶标 ✓），选中的 PID 交给 `py-spy dump --pid <pid> --nonblocking`——nonblocking 不暂停目标进程，生产组件不卡服
  - 本机未装 py-spy 先问一次：一键安装按所选解释器链跑 `<解释器> -m pip install -U py-spy`；装失败如实弹 pip 退出码与输出尾，绝不循环重试
  - dump 失败原因进输出通道；权限类失败拼 ptrace 指引——Linux 需 `kernel.yama.ptrace_scope=0`（或 sudo/能力位），容器内需 `--cap-add=SYS_PTRACE`，Windows 需管理员或同用户会话
- 行为（远程，IDE-PDBG-004/005）：组件分派到远程服务器时，py-spy 经 `ssh <host> -- …` 在远端跑，进程清单同样经 ssh 上的 `ps` 取得——选择器保持本地形状（组件名命中置顶 ✓）；清单取不到如实报主机与 ssh 原因、不弹选择器（绝不拿本地清单顶替）
- 前提：目标进程是 py-spy 可见的 Python 进程；ptrace 权限按上面口径

### `kbengine.debug.pyspyFlamegraph`

- 标题：`Collect Flame Graph with py-spy`
- 作用：py-spy 火焰图采集入口（IDE-PYSPY-001），服务器树 debug 图标后 flame 图标呈现（`$(flame)`）；对目标组件进程跑 `py-spy record --format flamegraph` 把采样窗口内的调用栈落盘为 SVG 火焰图并在编辑器打开
- 入口：服务器树 inline 图标（dump 图标后）或命令面板
- 行为：
  - 傻瓜化默认参数：窗口 10s、采样率 100/s、`--nonblocking`（不暂停目标进程）——一键即采
  - 定时/周期采集：两次输入框配置「每 N 秒采 X 次」（缺省 1 次/每 5 秒，整数校验）；X>1 时逐次落盘 `flame-<时间戳>-<序号>.svg`（输出目录 `~/.tmp/kode-pyspy-flamegraphs`），任一次失败即止并保留已成功文件
  - 未装 py-spy 复用一键安装（与 dump 同链）；采集成功在编辑器打开 SVG（VS Code 原生图像预览），逐次结果进「KBEngine py-spy」输出通道
- 行为（远程）：火焰图 record 暂仅支持本地组件——远程分派时如实提示先用 `py-spy dump` 拿调用栈（远端文件回传待后续）
- 前提：目标进程是 py-spy 可见的 Python 进程；ptrace 权限同 dump

### `kbengine.remoteServers.select`

- 标题：`Select Remote Server`
- 作用：选定 debug 与 py-spy 的执行服务器（IDE-PDBG-004）——点 Remote Servers 视图节点，或从面板打开选择器
- 入口：Remote Servers 视图节点点击，或命令面板
- 行为：
  - 视图列出 `~/.ssh/config` 主机（逐 Host 块收 HostName/User/Port/ProxyJump；通配与 negated 别名不列；`Include` 不展开——被 include 文件里的主机不出现）加手动添加项，「本地(直接执行)」恒第一且默认选中
  - 选择落工作区状态，分派按 组件 `sshHost` > `debug.defaultSshHost` > 视图选中 > 本地 的优先级生效
  - 选远程主机后，端口模式附加走 `ssh -N -L` 隧道、py-spy 经 `ssh <host> -- …` 远端执行；选本地则都回到本机直接执行
  - 无效 id 或选择器取消：不动现有选择

### `kbengine.remoteServers.add`

- 标题：`Add Remote Server`
- 作用：往 Remote Servers 视图手动添加远程主机（IDE-PDBG-004）——主机没写进 `~/.ssh/config` 时用
- 入口：Remote Servers 视图标题栏 `+`，或命令面板
- 行为：
  - 输入主机名（ssh 别名或 `user@host` 形）；ProxyJump 等参数请写 `~/.ssh/config`——手动项按裸主机名连
  - 重复项自动去重（与 config 同名的不会列两遍）；删除手动项绝不碰 config 文件

### `kbengine.remoteServers.remove`

- 标题：`Remove Remote Server`
- 作用：从 Remote Servers 视图移除手动添加的主机（IDE-PDBG-004）
- 入口：手动项节点上的 inline 垃圾桶图标（右键亦可），或命令面板
- 行为：
  - 只作用于手动项——来自 `~/.ssh/config` 的主机没有移除入口（改 config 文件）
  - 删的是当前选中项时选择回落本地，分派不悬空指向不存在的主机

### `kbengine.remoteServers.refresh`

- 标题：`Refresh Remote Servers`
- 作用：重读 `~/.ssh/config` 重建 Remote Servers 视图（IDE-PDBG-004）
- 入口：Remote Servers 视图标题栏刷新图标，或命令面板
- 行为：
  - 报告从 `~/.ssh/config` 读到几台主机；文件不存在也照直说（视图只剩本地与手动项）

## 配置相关

### `kbengine.config.showFinal`

- 标题：`Show Final Server Config`
- 作用：按默认视图打开「最终生效配置」——`kbengine.finalConfigView` 决定打开面：`gui`（默认）打开配置合并可视化面板；`text` 打开下方只读合成文档（2026-11-12 用户令：图形界面为默认；两个面同一 resolve 数据源，不二次解析）
- 行为：
  - 默认（`kbengine.showFinalConfigOnOpen`）激活后按默认视图在后台自动打开；定位不到 defaults 时自动路径静默跳过、手动命令明示报错
  - 可视化面板工具栏有「文本视图」按钮，可直接打开合成文档

### `kbengine.config.showFinalText`

- 标题：`Show Final Server Config (Text)`
- 作用：恒开文本合成视图（不随 `kbengine.finalConfigView`）——按引擎装载规则合成：先载引擎默认 `kbengine_defaults.xml`（经 `kbengine.binPath` 推导），再以元件 `kbengine.xml`（`kbengine.assetsRoot` 下优先，其次约定路径 `kbengine.xml`/`res/server/kbengine.xml`/`assets/res/server/kbengine.xml`）同键覆盖（子键按名对齐）
- 行为：
  - 合成文件不落盘，虚拟文档 `kbengine-final.xml`，字段可悬浮看作用说明
  - 文档头注标明 defaults 与元件配置的来源路径
  - 定位不到 defaults 时明示报错
  - telnet 端口/密码等服务参数与该合成口径同源读取

### `kbengine.config.visualize`

- 标题：`Config Merge Visualization`
- 作用：打开配置合并可视化面板——把配置 resolve 管线的 defaults/custom/merged 三棵树逐键投影成「仅默认/被覆盖/仅覆盖文件新增」三态（KODE-CFG-VIZ-001；与 `kbengine.config.showFinal` 同一 resolve 数据源的纯投影，不二次解析）
- 行为：
  - 左树段分组：引擎 10 进程段一组、其余全局段一组；中列键清单带逐键状态徽标，全量键 DTO 一次随包以支撑本地搜索/筛选；右栏详情懒加载三值对照（默认/覆盖/最终）、文案库含义与 `file:line` 出处、源注释、可复制的最终 XML 片段
  - 重名 `<item>` 表以 1-based `name[k]` 路径寻址，整表替换在详情注明；长值仅列表截断到 120 字符（详情保完整值）
  - 无自定义配置时出「仅默认」诚实警示条；空态/错误态（无工作区、无可解析配置、RPC 失败）如实呈现，不伪造投影
  - 刷新强制重取；快速刷新后的旧代回包经画代守卫弃置

### `kbengine.lintRules.showReport`

- 标题：`Show Lint Rules Capability Report`
- 作用：在输出通道 `Kode Lint Rules` 输出 lint 规则能力清单——每条规则的规范编号/诊断 code/严重度/适用角色/配置开关/触发入口/修复支持/证据源码模块/实现状态，按「已实现/仅提示/待实现」分组并逐条标注当前配置下的启用/停用态（IDE-LINT-011；清单单一事实源 `src/lintRuleRegistry.ts`，规则编号与 `kbengine-lint-rules.md` 规则总表对应）

### `kbengine.metrics.showSummary`

- 标题：`Show Language Service Metrics Summary`
- 作用：打开「Kode Language Service Metrics」输出通道，给出聚合性能记录报告（PR1 观测层，无行为变化）
- 行为：
  - 每个事件族一行（`hover`、`definition`、`completion`、`diagnostics`、`python-index-scan`、`python-composition-roots`、`entity-mapping-scan`、`semantic-query`、`type-registry-query`、`file-discovery`、`document-parse`）
  - 每行报告请求数、P50/P95/P99/max/avg 耗时（单调时钟，ms）、缓存命中率、等待初始化数、文件发现/读取/解析总量与状态计数
  - 逐请求明细采样默认关；开启 `kbengine.metrics.detailed` 后 `[kode-lsm]` 样本同时流入日志时间线

### `kbengine.metrics.startCpuProfile`

- 标题：`Kode: Start Extension Host CPU Profile`
- 作用：在扩展宿主进程启动 V8 CPU 采样（IDE-MET-007 卡顿证据入口）
- 行为：
  - 经 Node inspector `Profiler` 域以 1000us 采样间隔运行；运行中再次启动以警告拒绝
  - 输出目录为扩展全局存储（不可用时回落系统临时目录）

### `kbengine.metrics.stopCpuProfile`

- 标题：`Kode: Stop Extension Host CPU Profile`
- 作用：停止采样并把捕获连同请求窗上下文落盘
- 行为：
  - 写 `kode-cpu-profile-<timestamp>.cpuprofile`（可在 VS Code / Chrome DevTools 打开）及同级 `.window.txt`
  - `.window.txt` 记录窗口起止 ISO 时间、时长、语言服务指标汇总与事件循环延迟报告，把 profile 与请求窗关联

### `kbengine.metrics.showActiveTasks`

- 标题：`Kode: Show Active Language Service Tasks`
- 作用：导出待处理与取消后残留在途任务数（IDE-MET-008）
- 行为：
  - 逐族列出在途语言服务操作（started..ended 台账；取消的收尾也留台账）与诊断调度器 queued/inFlight 负载
  - 读该台账对比取消请求前后的活跃任务数；不要从 provider 空返回值推断工作已停

### `kbengine.python.debugpySync`

- 标题：`Copy System debugpy into Assets`
- 作用：`kbengine.debug.autoDebugpy` 的一次性接线——把系统 pip 的 `debugpy` 包复制到 `<assets>/scripts/common/debugpy`，让引擎组件里 `import debugpy` 可解析（该目录在引擎模块搜索路径第一位，`python_app.cpp:167`；`site_import=0` 不影响）
- 入口：命令面板 `Copy System debugpy into Assets`
- 行为：
  - 按序探测取包解释器：所选解释器（`kbengine.python.interpreterPath` → PATH 链，与调试预检同一条链）→ `python3` → `python`，以 `-c "import debugpy"` 定位；未安装/目录不可读时如实报告，零复制
  - 当前实现限制：同步闸硬编码 Python 3.12.13/debugpy ≥1.8.0，不代表所有引擎版本；它会错误拒绝 Python 3.7.3 所需的 1.7.0。目标版本感知校验实现前，使用上方固定版本手工流程
  - 只动自己键：非本扩展写入的目标目录（workspaceState 无记账）不论什么版本一律视为用户手放、绝不动；同版本在位零写入跳过；自己的旧版本升级
  - 永不抛——结果（已复制/跳过/已升级/失败及原因）作为命令结果消息如实播报
- 边界：本命令只放包；起监听是 `kbengine.debug.autoDebugpy` 启动联动的事，附加调试是生成的 launch.json 条目的事

### `kbengine.debug.waitAtStartup.on`

- 标题：`debugpy: Wait for Debugger at Startup (On)`
- 作用：显式 opt-in 的「启动前等待调试器连接」——让引擎组件停在最早的 Python 处（用户入口脚本的早期断点之前），不依赖启动后的 telnet 注入
- 入口：命令面板
- 行为：
  - 在活动资产根下定位 `scripts/entity_defs` 同级的入口脚本 `scripts/kbengine.py`；找不到如实报错，零写入
  - 在模块 docstring 之后插入带标记的引导块：读环境变量 `KODE_DEBUGPY_WAIT_PORT` 并执行 `debugpy.listen` + `debugpy.wait_for_client()`；无该变量、没有 debugpy 包或任何异常都静默放行，绝不阻塞引擎启动
  - 把 `kbengine.debug.waitAtStartup` 设为 true；此后 serverManager 启动表内组件（baseapp/cellapp/loginapp/dbmgr/logger）的默认实例时带上 `KODE_DEBUGPY_WAIT_PORT`=该组件的分配表端口——组件停住，直到 VS Code 附加对应的 debugpy attach 配置
  - 插入幂等（块已在=零写入），块外的用户编辑原样保留
- 边界：命名实例仍走 telnet 注入路径（逐实例口来自启动联动窗口分配，等待模式暂不覆盖，如实写明）；等待模式开启期间，默认实例的 telnet 注入跳过并记一条日志（启动引导已持有表口监听）

### `kbengine.debug.waitAtStartup.off`

- 标题：`debugpy: Wait for Debugger at Startup (Off)`
- 作用：关闭启动等待模式并还原入口脚本
- 入口：命令面板
- 行为：逐字节删除引导块还原原文（无块=零写入）并把 `kbengine.debug.waitAtStartup` 设为 false；入口脚本定位不到时设置照关并提示
- 边界：与 On 命令对称；已在运行的组件保持既有监听不变

### `kbengine.debug.focusTarget`

- 标题：`debugpy: Focus Debug Target`
- 作用：从 Debug Targets 视图定位某个调试目标（IDE-DBG-008）——每个运行中的目标一行，四态各自可辨：未注入 / 监听（带 debugpy 端口）/ 已附加（带会话数）/ 失败（带失败细节）；注入回报、调试会话起止、进程变化三面都会刷新视图
- 入口：点击 Debug Targets 视图中的行（命令面板直接调用则提示去视图点击）
- 行为：
  - 已附加：打开 Run and Debug 视图（`workbench.view.debug`）并给出会话条目名（调用堆栈在该视图可见；视图内选中哪个会话是编辑器自身的选择面，如实写明）
  - 监听：报告 debugpy 端口并给出两个下一步控件——`立即附加`（走端口模式整条链，端口不开自动进下一步引导）与 `打开 launch.json`（先动态写好该口的 connect 条目再打开，写不成如实说明）；命名实例行（`组件#实例`）只给 `打开 launch.json`（附加按组件配置的口走，直接附加会指错实例，如实不给）
  - 失败：展示失败细节（预检拦截 / telnet 一直不就绪 / 端口窗口耗尽 / 注入被拒）与重试途径
  - 未注入：说明两条 opt-in 路径（`kbengine.debug.autoDebugpy` 启动联动注入、启动等待模式）并说明需重启组件
  - serverKey 已不在运行：如实提示进程已停
- 边界：视图只列运行中的目标（进程停了行即消失）；已附加压过监听/失败——有在挂会话说明注入必然曾成功

### `kbengine.jsoncAssociation.off`

- 标题：`Turn Off debug.json JSONC Association`
- 作用：关掉 debug.json 的 JSONC 接线并回收本扩展写入的条目——`.kbengine/debug.json` 是 JSONC（带注释，解析端 `stripJsonComments`），按 json 处理注释会划红线
- 入口：命令面板 `Turn Off debug.json JSONC Association`
- 行为：
  - 把 `kbengine.jsoncAssociation` 在用户级（Global）翻成 `false`，之后激活不再接线
  - 逐工作区只回收 kode 自己写进 `files.associations` 的那个 glob 键（workspaceState 记账）；你后来改过值的键、或你手填的键，原样保留；其他关联键一个不动
  - 没找到 kode 写过的条目时如实说明，开关照翻（现有值一律未动）
  - 重新启用：把 `kbengine.jsoncAssociation` 设回 `true` 并重载窗口
- 边界：关联只改变编辑器对该文件的处理（jsonc 着色、容忍注释）；解析端接受面不变——单引号/无引号键/尾逗号（JSON5 习惯）依旧按坏配置处理

## 可视化面板

### `kbengine.consoleLogTail.show`

- 标题：`KBEngine Console: Show Live Log Tail`
- 作用：打开「KBEngine Console 日志」输出通道,呈现引擎 logger 的 65501 实时推流(guiconsole 链,KB-GC-001)

### `kbengine.consoleLogTail.toggle`

- 标题：`KBEngine Console: Start/Stop Live Log Tail`
- 作用：启动/停止 tail 长连(702 注册 / 703 注销)。显式用户意图可越过 `kbengine.consoleLogTail.enabled` 的默认开启闸(配置缺失视为开,只有显式 `false` 才关)

### `kbengine.consoleComponentPanel.refresh`

- 标题：`Refresh Component Status`
- 作用：跑一轮 machined 发现并重绘组件状态视图(与 tail 同一 hub;视图标题栏刷新按钮同款)

### `kbengine.monitoring.show`

- 标题：`Show Monitoring Panel`
- 作用：打开监控面板

### `kbengine.dependency.show`

- 标题：`Show Entity Dependency Graph`
- 作用：打开实体依赖关系图

依赖图面板支持：

- 刷新依赖图
- 在图中打开实体定义
- 导出 SVG
- 导出 PNG

### `kbengine.pythonCallGraph.show`

- 标题：`Show Python Call Graph`
- 作用：打开 Python 方法级调用图（与实体依赖图同一面板，callgraph 模式）

callgraph 模式面板支持：

- 收集工作区根下全部 `*.py`（排除 `node_modules`/`out`/`.vscode-test`/`.git`）并把文本送入 Rust 核心
- 方法级调用边分 8 类（local / method / self-method / kbe-broadcast / kbe-base-clients / kbe-cross-process / kbe-api / unknown），各有专属箭头与颜色
- 未解析被调渲染为桩节点（`ext:` / `kbe:` 前缀），调用点绝不丢
- 跨文件调用方（经 `reverseIndex`）喂给 kode-scheduler 失效 DAG
- 点击节点打开对应 `.py` 文件
- 导出 SVG / PNG

### `kbengine.flow.show`

- 标题：`Show Entity Flow Graph`
- 作用：打开实体架构流程图——客户端到 baseapp/cellapp 的方法调用与属性自动同步关系

流程图面板支持：

- 实体名缺省取活动 .def 编辑器；无法定位时提示打开实体定义文件
- 图上边语义按属性 Flags 位标注，逐边列出引擎出处（文件:行号）与成员声明位置
- 点击成员行回跳 .def 声明处
- 未 Exposed 的 BaseMethods 单列「客户端调不到的方法」
- 刷新重读磁盘上的 def/entities.xml
- 导出 Markdown（直写文件）
- 导出 SVG/PNG（经 webview 渲染后导出）

### `kbengine.flow.openCallGraph`

- 标题：`Open Call Graph (G2 swimlanes)`
- 作用：为活动 Python 编辑器中的函数打开静态调用路径走查（G2），按进程角色分泳道呈现
- 入口：命令面板（活动编辑器须为 Python 实体脚本）；入口函数取自该文件解析出的函数清单（单函数免快选）
- 泳道头恒标注「静态角色（非运行实例）」——静态分析没有运行中实例；带组件 ID 的运行实例属 G3/TRACE 泳道
- def 声明与实现经实体映射解析（实体 × 段 × 方法）；声明缺失时发送边保持未连接、如实呈现（不虚构路径）
- 每条边带 EV 编号可回查证据索引；来源标签恒为「静态可能路径(G2)」，步序是走查轨迹而非执行顺序
- 默认视图是业务主路径（泳道走查）；每帧的本地调用树（入口 → helper）默认折叠，原生展开收起（零脚本 `<details>`）
- 每条链接分别标注「调用点」与「声明」；点击任一标注跳转编辑器对应行（python 声明 0 基 +1 展示；def 文件声明按 1 基原样）
- 跨进程链接显示方向（方向 from→to）并带 def 声明的 `<Arg>` 类型与 `<ReturnType>`（来源标注 (def)）；未声明的方法如实记「参数:def 未声明(不猜)」；广播不进 def 契约面（不虚构接收帧）
- 服务端 → client 的消息带「回调」徽标——仅是方向事实，不是执行顺序断言
- 光标入口：光标所在函数（上方最近 `def` 行语法锚）在图面时免快选直开；叶函数回退函数快选（不虚构入口）
- 节点反查：点击候选帧即触发全工作区反查——上游调用者（本地按节点身份精确匹配；跨进程发送者按角色+方法名匹配，同名异实体并列「实体待证」候选）、下游被调者、未解析面（原因码+细节）——未知与歧义可查看，不裁定
- 导航历史：反查视图「打开图」跳转时旧入口入栈，「返回上一视图」出栈回退（反查视图返回泳道走查不走栈）；关闭面板即清空
- 有界初装（按需展开）：初次走查按固定深度界（6）装配——超界帧标注「截断边界」并给「继续展开」入口（以边界帧的文件+函数名续开新场景）；面板绝不假装一次呈现整张大图
- 面板工具条（仅面板层注入；生成工件仍零脚本）：搜索框按文本过滤行、回车定位首个匹配；放大/缩小/重置按钮（body zoom 0.5–2 夹取）
- 装配可取消：进度通知可取消——装配核在阶段间（文件读取/三元组收集/def+实现解析）检查令牌并停止后台扩展；取消报告「调用图装配已取消」（与装配失败分开如实提示）
- 文本路径：工具条「图/文本」切换，把同一次装配的样本渲染成纯文本走查（图和文本消费同一模型——不重新解析、不新造证据）；文本面保留全部走查行、帧内本地调用、分支候选、未解析/未连接原因和完整 EV 证据索引，截断如实标注
- 错误恢复：装配失败保留既有视图与全部已留存状态（状态只在装配成功后变更）；错误消息带「重试」动作，选中即重开同一入口；尚无装配时切文本面如实提示「没有已装配的调用图场景」
- 键盘可用：交互桥元素（跳转/打开图/返回/视图切换/节点）可聚焦，Enter/Space 等效点击；面板文案经 webview locale 设置中英文双语
- 真实业务流转验收（登录/创建角色入场/一次战斗）：三个场景端到端钉在真实项目资产上（scripts/{base,cell,client}/*.py + entity_defs/*.def）——注册表运行时从真实文件推导（def 沿 `<Parent>` 链、实现沿 owner 链带 inheritedFrom）；诚实面保持诚实：引擎驱动转场（createEntityLocally/giveClientTo）走查如实停在引擎边界（不虚构远端执行帧），getattr 中继接收者与 entities.get 奖励发送保持「未连接」（unknown-receiver），演示工程缺失的客户端实现（onMonsterNear）只立发送步、不虚构执行帧

## 代码生成器

### `kbengine.generator.wizard`

- 标题：`Create Entity from Wizard`
- 作用：通过向导逐步创建实体

### `kbengine.entity.new`

- 标题：`New KBEngine Entity`
- 作用：三步（名称 → 属性模板 → 实体形态）生成一个可直接被引擎加载的新实体
- 入口：命令面板，或资源管理器目录右键（仅 `entity_defs` 目录；其它目录给提示后中止）
- 一次生成：
  - `entity_defs/<Name>.def` 骨架：常用示例属性（`name`/`hp`/`position`）加一个 TEMP 属性（`Persistent=false`），再加一个属性模板示例：简单 `UINT32`、内联 `ARRAY<of UINT32>`、或 FIXED_DICT 命名类型
  - 按段脚本（引擎约定：类名与实体名逐字一致、继承 `KBEngine.Entity`）落盘到 `scripts/base/<Name>.py` / `scripts/cell/<Name>.py`（钩子：`onTimer`、base 段 `onWriteToDB(self, cellData)`、cell 段 `onEnterWorld`/`onLeaveWorld`）
  - 所选形态含 Client 时生成 `scripts/client/<Name>.py` 客户端 stub
  - FIXED_DICT 模板自动在 `types.xml` 登记其命名类型（不带 `implementedBy`，默认序列化即可加载）
  - `entities.xml` 登记 `<Name>`
- `__init__` 守卫遵循 GEN-DEF-1 口径：仅 ARRAY/FIXED_DICT 属性生成 `if self.<prop> is None:`，且只出现在该属性 Flags 域所在的段；简单类型无守卫，绝不生成 `if not self.` 形态
- 项目级模板覆盖内置骨架：`.kode/templates/new-entity.def`、`new-entity.base.py`、`new-entity.cell.py`、`new-entity.client.py`，占位符 `{{Name}}`/`{{ClassName}}`（未识别占位符原样保留）
- 行为：任一目标已存在即预检整体中止（不写半套）、确认屏列出全部落点、失败回滚已创建文件（含 `types.xml` 插入）、提交后刷新实体树让新 def/脚本对立即入索引

### `kbengine.generator.templates`

- 标题：`Create Entity from Template`
- 作用：从预定义模板快速生成实体（账号、角色、NPC、物品、怪物、场景、公会、队伍、邮件、空实体共 10 个）

### `kbengine.generator.formWizard`

- 标题：`Create Def Form from Wizard`
- 作用：生成实体向导之外的定义形态，一次一种（代理 / 空间 / 组件 / 固定字典类型）
- 各形态落点与附带改写：
  - 代理：`scripts/proxy_defs/<实体名>Proxy.def`，`<Parent>` 指向 `<实体名>Proxy`；方法名按逗号分隔填写，方法声明在 `BaseMethods` 还是 `CellMethods` 由命令内选（引擎按版本装载面不同，生成器不替引擎断言）
  - 空间：`entity_defs/<名称>.def`（父类 `Space` + 进出空间回调），并在 `entities.xml` 插一行 `hasBase="true" hasCell="true"`
  - 组件：`entity_defs/components/<名称>.def`，可选挂载——在所选实体的 `<Properties>` 段末插一条 `<Type>COMPONENT</Type>` 属性
  - 固定字典：`types.xml` 里插一个 `FIXED_DICT` 类型块（含 `<Properties>` 字段，可选 `implementedBy`）
- 行为：已存在的 def 文件默认不覆盖，只给说明；`entities.xml` / `types.xml` 重复登记只记说明不改写；`types.xml` 不存在时新建最小根；实体 def 没有 `<Properties>` 段时不硬插，报说明
- 落盘目录按当前工作区的定义布局解析（`entity_defs` / `components` / `types.xml` 随批125 自动发现），解析不到时如实说明不写盘

### `kbengine.clientSdk.generate`

- 标题：`Generate Client Entity SDK`
- 作用：按 `entities.xml` 登记的实体生成客户端实体骨架，语言在命令内勾选（TypeScript / C# 可多选），详见 [客户端实体 SDK 生成](./client-sdk.md)
- profile 绑定：有活动 profile 时，实体注册顺序与类型数据只取该 profile 的资产根（`src/sdkGenerationProfile.ts`）；其他扫描根的同名实体拒收并在完成通知里逐个点名，绝不静默合并；无活动 profile 回落工作区首根
- 引擎溯源：每个生成文件头部记录输入引擎的版本与提交（`src/sdkGenerationTrace.ts`，经 `readEngineApiMetadata` 探测，profile 记录的引擎根优先）；定位不到引擎时两行如实写 `unknown`

### `kbengine.project.doctor`

- 标题：`Run Project Doctor`
- 作用：审计 def 引用图并报告结构问题

### `kbengine.symbolReferences.show`

- 标题：`Show Symbol References Graph`
- 作用：以 Mermaid 与纯文本预览展示 def 符号引用图

### `kbengine.profile.start`

- 标题：`Start Runtime Profile`
- 作用：查询运行中 KBEngine 元件的 profile 数据并展示响应

### `kbengine.spaces.query`

- 标题：`Query Spaces`
- 作用：向本地 cellappmgr 查询当前 space 记录

### `kbengine.runtimeQuery.show`

- 标题：`Show Runtime Query Panel`
- 作用：从一个面板发现运行元件、查询 cellappmgr spaces、查询 watcher 值

### `kbengine.python.showCallChain`

- 标题：`Show Call Chain`
- 作用：为选中方法生成配置的 Python 调用链预览

### `kbengine.compatibility.check`

- 标题：`Check Engine Compatibility`
- 作用：把扩展预期的引擎面与定位到的引擎 checkout 做对比

### `kbengine.workbench.show`

- 标题：`Show KBEngine Workbench`
- 作用：展示一个命令启动器，覆盖发现、运行时查询、schema、SDK 与兼容性工具

## 性能分析

### `kbengine.def.analyze`

- 标题：`Analyze Def Performance`
- 作用：对工作区全部 `.def` 文件做静态检查并输出优化建议
- 输出：
  - 报告写入「KBEngine Def 分析」输出面板
  - 诊断落入问题列表（`kbengine-def-analysis`）

### `kbengine.def.checkEngineMd5`

- 标题：`Check Engine Def MD5 Consistency`
- 作用：以 Rust `$/kode/def/md5` 权威实现计算工作区 def 闭包的引擎格式 MD5，与 kbcmd 写入客户端 SDK 的摘要盖章逐一对拍
- 输入（引擎喂入序，与 Rust 收集器同布局）：`scripts/entities.xml`、`entity_defs/{types.xml,alias.xml}`、`entity_defs/*.def`（实体）、`entity_defs/interfaces/*.def`、`entity_defs/components/*.def`，以及组件脚本存在性（`scripts/{base,cell}/components/*.py` → `base:X`/`cell:X`）；def 原文打开缓冲区优先（未保存编辑参与摘要）
- 行为：
  - 缺失喂入文件按空串入流（与引擎自身装载同口径）并如实记入备注
  - Rust 实现不可用时，工作区摘要保持未知，SDK 盖章逐个标「无法比对」——不猜、不用客户端侧哈希顶替
  - 盖章失配 = SDK 生成后 def 集改过（重新生成 SDK 即重新盖章）；引擎在登录握手（`onHelloCB`）下发同一摘要，失配客户端会中止
- 输出：报告写入「KBEngine Def 分析」输出面板；通知汇总一致/失配/未知数量

### `kbengine.def.fingerprintInspector`

- 标题：`查看 Def 指纹详情`
- 作用：对活动 `.def` 文件做指纹快照（sha256 文件哈希 + 结构语义指纹），与会话台账里的上次快照并排展示，给出三路判定（文件哈希 / 语义指纹 / 引擎已应用摘要）
- 行为：
  - 要求活动编辑器为 `.def`；读面优先复用打开缓冲区字节（VFS 复用——未保存编辑参与指纹；来源 document/disk 如实标注）
  - 首见文件只存底（记基线），如实说明、不伪造变更结论
  - 引擎已应用维度如实「未知」：def 文件没有逐文件运行时回执；工作区闭包 MD5 面（SDK 盖章）是另一账——若跑过 `kbengine.def.checkEngineMd5`，面板如实转显其最近结果，绝不冒充逐文件 applied 结论
  - 完整报告同步写入「KBEngine Def 分析」输出面板

### `kbengine.hotReload.historyPanel`

- 标题：`打开热更历史面板`
- 作用：打开热更历史面板——页头（监听模式 / 目标 / 显示与总行数）、过滤条（fullModule 子串 / 目标 id / 状态）与最新在前的表格（模块按 `fullModule` 显示,双名不同时并列发送名 requestModule,另有文件/目标/状态/时间/请求 id/错误摘要列），带「加载更多」分页
- 行为：
  - 数据来自投递台账的逐条投影(台账是事实源,面板绝不造行)
  - 关闭面板不停止热更流水线——feed 照常记录,树照常节流刷新
  - 过滤/加载更多按钮经 webview 消息回装配,从台账背书的历史库重渲染

### `kbengine.hotReload.historySearch`

- 标题：`搜索热更历史`
- 作用：按 `fullModule` 子串过滤热更历史树(大小写不敏);留空清除过滤
- 行为：作用于树的三组(最近更新 / 按文件 / 按目标);仅目标不同的行保持分行

## 代码片段生成

### `kbengine.snippets.generateFromSelection`

- 标题：`Generate Snippet from Selection`
- 作用：把编辑器选区文本做片段语法转义（`$`/`\`）并剥离公共缩进，经名称/前缀/描述三步输入后合并写入 `.vscode/kbengine-custom.code-snippets`
- 行为：
  - 公共缩进按编辑器 `tabSize` 列语义剥离，tab/空格混用的选区仍保相对层级
  - 同名片段条目覆盖并给出警告
  - 片段文件被手改出注释/坏 JSON 时拒绝改写并提示
  - 片段文件读/写 IO 失败（权限、路径被目录/文件占位等）时报错并带文件路径，不裸抛命令错误

### `kbengine.telnet.showPanel`

- 标题：`Show Telnet Panel`
- 作用：打开 telnet 控制面板（探测状态灯 + 命令会话）
- 目标解析链：kode 设置（`kbengine.telnet.host/port/password`）→ 元件 `kbengine.xml` 的 `<telnet_service>` 段（`kbengine.telnet.configXmlPath` 指定，未指定时按 `kbengine.assetsRoot` 与约定路径探测）→ 引擎 `kbengine_defaults.xml`（经 `kbengine.binPath` 推导）；`.kbengine/debug.json` 不参与 telnet 探测
- 行为：
  - 面板按目标列出状态灯：未配置 / 未开启 / 已开启（未接会话）/ 端口开·未配密码 / 密码被拒 / 已连接
  - 已开启目标可建立持久会话（自动握手登录），提供白名单内命令输入、内置只读快捷命令与输出回显
  - 未开启目标如实提示开启方法（附 kbengine.xml `<telnet_service>` 配置片段），不空转
  - 运行中断线自动拆除会话并翻转状态灯，面板保留可重连
  - 面板内 `Ctrl+]` / `Ctrl+D` 断开会话（telnet 标准转义，仅面板聚焦时生效），命令见 `kbengine.telnet.disconnect`

### `kbengine.telnet.disconnect`

- 标题：`Disconnect Telnet Session`
- 作用：主动断开当前 telnet 会话。扩展断开的是自己的连接，不发送引擎 `:quit`——`:quit` 会关闭整个服务端进程，白名单层恒拒
- 入口：telnet 树标题栏按钮、命令面板、telnet 面板内 `Ctrl+]` / `Ctrl+D`
- 行为：
  - 优先断开会话面板当前选中的目标；未选中或选中目标无会话时取首个已连接目标
  - 没有已连接的会话时如实提示，不空转

### `kbengine.bots.add`

- 标题：`KBEngine: Add Bots (telnet addBots)`
- 作用：驱动引擎 `bots` 进程（模拟客户端压测工具）在运行时添加模拟客户端——本地单机闭环（IDE-BOT-001）；bots 进程自带 telnet python 层（默认端口 51000），无需重启进程
- 输入：机器人总数（≥1，必填）；可选分批——每批数量（≥1）与批次间隔秒（≥0，留空按 0）；每批数量留空则一次性添加
- 行为：
  - 命令串严格镜像引擎 API 形态：一次性 `KBEngine.addBots(5)`，分批 `KBEngine.addBots(1000, 5, 10)`
  - 白名单闸不绕：addBots 是写操作（批量登录），`kbengine.telnet.enableCommands` 缺 `"KBEngine.addBots"` 时拒绝发送并报出该加的条目
  - 计数命令也在白名单（`"len(KBEngine.bots)"`）时，添加后随即查询当前 bot 数并写入输出通道
  - 诚实边界：引擎无逐个销毁 API（`KBEngine.bots` 字典只读）——减员 = 停止 bots 进程；每次发送都把这一点写进输出通道，不编造逐机器人指标
  - 失败形态如实：无 bots telnet 目标（telnet 未配置，或显式单一端口不含组件目标）→ 提示目标派生方式；有界等待内会话未就绪 → 如实报告，不发送

### `kbengine.bots.count`

- 标题：`KBEngine: Query Bot Count (len(KBEngine.bots))`
- 作用：经 bots telnet python 层查询当前机器人数量
- 行为：
  - 在 bots 目标会话上发送 `len(KBEngine.bots)`，有界等待（约 2 秒）内读结果行；解析出的数字写入输出通道
  - 到时未读到数字行就如实说未读到，不编造数量
  - 需 `kbengine.telnet.enableCommands` 含 `"len(KBEngine.bots)"`（只读，但不在内置快捷命令内）；缺项时错误信息点名该条目

### `kbengine.playerData.refresh`

- 标题：`Refresh Player Data Profile`
- 作用：从引擎配置重新推导 MySQL 连接 profile 并刷新只读「Player Data」树
- 真相源：Rust `derive_database` 从元件 `kbengine.xml` + 引擎 `kbengine_defaults.xml` 读 `dbmgr/databaseInterfaces/default`（叶子默认值随引擎：host `localhost`、port 0 → 3306、用户 `kbe`、库 `kbe`、字符集 `utf8mb4`）
- 只读约束：视图不提供任何可编辑字段——连接事实只来自引擎配置

### `kbengine.playerData.testConnection`

> UX-REVIEW-008B:拒绝/失败走警告面并给与真实原因对应的动作——缺引擎配置加「打开发现与定位报告」(配置定位),任何失败给「重试」(重跑本检查)与「查看详情」(打开结果通道;原始诊断已做密码遮蔽)。每任务最近一次状态(未运行/进行中/空结果/成功/失败/已取消)带完成时间常驻玩家数据树可回看(UX-REVIEW-008A)。

- 标题：`Test Database Connection (Read-Only SELECT 1)`
- 作用：对推导出的 MySQL 端点经只读执行器（`SET SESSION TRANSACTION READ ONLY` + 语句白名单）探一条白名单 `SELECT 1`
- 行为：
  - 成功报 host:port/database 与时延；失败如实降级为消息（绝不阻塞其他功能）
  - 引擎密码为 RSA 加密（`<encrypt>` 非 `false`）时绝不解密——命令如实报「未测试」，不猜

### `kbengine.playerData.queryByDbid`

- 标题：`Query Player by DBID (Read-Only)`
- 作用：执行单条只读 ``SELECT * FROM `tbl_Account` WHERE `id` = <dbid>``（表前缀取 `kbengine.db.tablePrefix`，默认 `tbl_`），把行打印进「KBEngine 玩家数据(只读)」输出通道
- 输入校验：dbid 必须是十进制正整数；其余在任何连接前拒绝
- 缺配置闸：未派生出引擎数据库配置时如实降级（绝不把克隆 Source/Target 台账当成查询配置来源），并提供两个真实恢复入口——打开发现与定位报告、重新派生并检查连接
- 只读约束：结果仅展示；无编辑、无导出副作用（导出/导入走玩家数据克隆专道）

### `kbengine.playerData.showResult`

- 标题：`Show Last Player Query Result`
- 作用：打开「KBEngine 玩家数据(只读)」输出通道，让最近一次查询/连接检查结果可回看（UX-REVIEW-008A）
- 行为：
  - 玩家数据树为每个任务保留最近一次状态——未运行/进行中/空结果/成功/失败/已取消——带完成时间与结果入口（点击状态行即本命令）
  - 详情（执行的 SQL、JSON 行、连接结果与耗时）都追加进该通道；信息消息保留，但不再是唯一记录

### `kbengine.httpRequests.run`

- 标题：`Run HTTP Quick Request`
- 作用：从「已启用」的 HTTP 快捷请求列表中选取一条并执行（快捷请求在设置 `kbengine.httpRequests` 里增删改与启停）
- 行为：
  - 无启用条目时如实提示，不空转
  - 执行流水进 OUTPUT 面板「KBEngine HTTP 快捷请求」：`▶` 请求行（模板替换后）→ `✓` 状态码 · 耗时 → 回包（超 4000 字符截断标注全长）
  - 失败以 `✗` 标记 + 错误弹窗呈现（OUTPUT 通道无着色 API，不做红色字面）

### `kbengine.httpRequest.run`

- 标题：`Run Named HTTP Quick Request`
- 作用：按名称直接运行一条启用的快捷请求，需要以 `args.name` 传参
- 行为：
  - 专为本命令配键盘快捷键设计：在「键盘快捷方式」里为它绑定按键并在 `args` 里带 `{"name": "请求名"}`，即可「打开 .py 按快捷键直发热更新」
  - 未带 `args.name` 时如实警告并指路 `kbengine.httpRequests.run`；名称不存在或条目已停用时错误回执，不空转
- 模板变量（URL/请求体/请求头值通用，按字面替换、不做 URL 编码）：
  - `${module}`：当前文件的工作区相对模块路径（`entities/fight/FightAI.py` → `entities.fight.FightAI`；不在工作区内则退文件名）
  - `${file}`：文件名（`FightAI.py`）
  - `${line}`：光标行（1 起）
  - `${sel}`：选中文本
  - 无活动编辑器时各变量替换为空串

### `kbengine.httpRequest.preview`

- 标题：`预览热更 HTTP 请求(不发送)`
- 作用：对活动文件展示「将会发出什么」——覆盖 kbengine.httpRequests 配置条目与零配置默认热更面——只构造不发送
- 行为：
  - 需要活动编辑器；没有时如实提示（绝不猜文件）
  - 每行给出条目名、来源、模板替换后的方法/URL/请求头/请求体，以及三个模块名并列（`fullModule`/`requestModule` 双名 + legacy `${module}` 语义值）；停用条目也如实列出并带原因，绝不静默丢弃
  - 输出进「KBEngine HTTP 快捷请求」通道并自动打开；`kbengine.hotReload.allowRootLevelStem`（HR-MOD-008）在默认面行与真实发送逐字同口径

### `kbengine.httpRequests.migrateLegacyModule`

- 标题：`迁移旧配置 ${module} 模板(双名面)`
- 作用：对仍在用旧 `${module}` 占位的已保存 URL 模板做兼容迁移（HR-MOD-013）——建议换成双名面的 `${fullModule}`（HR-MOD-012）
- 行为：
  - 扫描原始已存条目，逐条列出含 `${module}` 的条目与逐字段出现次数（url/请求体/请求头值）
  - 绝不静默改写：先选条目、再显式确认写入；任意一步取消都不改任何配置
  - 改写只动确认条目的模板字符串——其余条目（含解析器不认识的自定义字段）逐字保留
  - 未配置 `kbengine.hotReload.tempEdit.scriptRoot` 时拒绝迁移并说明原因（`${fullModule}` 会展开空串——先配脚本资源根）

### `kbengine.hotReload.tempEdit.run`

- 标题：`Temp-Edit Hot Reload (Active File)`
- 作用：对活动文件做临时编辑热更——写入临时编辑（一行尾注标记）→ 可选恢复原文 → 按名触发配置的重载快速动作 → 回显结果
- 行为：
  - 默认**关闭**门控（`kbengine.hotReload.tempEdit.enabled`）；关闭时命令如实拒绝
  - 重载步骤复用既有快速动作通道（HTTP 与终端动作一致）——不另起第二套 HTTP 实现
  - 回显进输出通道「KBEngine HTTP 快捷请求」与问题面板（文件上的诊断；成功即清除）
  - 成功语义保持诚实：可用的传输回执只是「已发送(未确认)」——没有可信 applied 回执，UI 绝不声称模块已热更（accepted ≠ applied）
  - 自动恢复失败时中止重载（绝不发送带标记的临时内容），并报告文件停留在临时编辑态

### `kbengine.hotReload.showLog`

- 标题：`Show Hot Reload Log`
- 作用：打开「KBEngine 热更」OUTPUT 通道——热更状态栏项(HR-UI-001)背后的审计日志
- 行为：
  - 状态栏项 `$(eye…) 热更: …` 即监视状态机:关(`kbengine.hotReload.enabled=false` 或 globs 为空)→ 就绪(watcher 建好)→ 发送中(去抖到点、请求已发)→ 已发送(未确认)→ 失败;点击状态栏项执行 `kbengine.hotReload.toggle`(一键关/开),开关提示里的「打开日志」按钮打开本日志
  - 诚实口径:动作完成且无错只记「已发送(未确认)」——不校验业务回执,界面绝不声称模块已生效(回执校验属 HR-STATE 系列,另立项)
  - 每次触发记 time/触发文件(去抖合并到的)/去抖值,外加请求行与结果行(已发送未确认/失败);日志行即时落账,不随状态栏节流合并
  - 运行本命令时先重采盘上版本,再把 HOT-VER 版本台账(在监视范围的已跟踪文件:基线版本、盘上版本,随后逐条版本跃迁的时间/attempt/digest 前 8 位/accepted-applied-failed 回执)追加进通道再打开;无已跟踪文件时不追加
  - 不进命令面板(`when: false`)——从开关提示的「打开日志」按钮或首激活提示进入

### `kbengine.hotReload.toggle`

- 标题：`Hot Reload: Toggle Auto Watch On/Off`
- 作用：热更一键关/开——把 `kbengine.hotReload.enabled` **写回配置**（窗口有工作区文件写工作区设置，否则写用户设置），不是内存开关
- 行为：
  - 热更**默认开启**（用户令 2026-11-06）；命令取反写回，配置变更监听随即拆除/重建 watcher，即时生效不必重启窗口
  - 绑定在状态栏「热更」项上，点状态栏即一键关；非模态提示告知新状态并给「打开日志」入口
  - `kbengine.hotReload.actionName` 留空时，保存 .py 即发默认热更请求 `POST http://127.0.0.1:8090/hotfix?module_name=<模块名>`，body 同带 `module_name=<模块名>`（query 与 body 双带）；引擎不可达如实显示**失败**（状态栏 + 日志），绝不假成功
  - 写回配置失败如实上报（日志 + 错误提示），不改状态机脸面


### `kbengine.hotReload.releasePreview`

- 标题：`Release Hot Reload Preview Batch`
- 作用：显式放行预览滞留的热更批次(HR-WATCH-016 / HR-PR-04):`kbengine.hotReload.batchPreviewThreshold` 滞留批次后,不发送任何内容,直到本命令放行——滞留在日志可见(批量预览滞留 行,HR-WATCH-017 诊断面),放行是用户决定,绝不自动冲掉
- 行为：
  - 滞留批经合并池整批一次发出;滞留期间新批次并入同批,一次放行全发
  - 无滞留时如实报告(没有滞留的热更预览批次),不假装放行
  - 阈值按批计数,到阈值需先成批(`kbengine.hotReload.batchFlushMs > 0`);`batchPreviewThreshold: 0` = 一律滞留


### `kbengine.hotReload.showBatchSummary`

- 标题：`Show Hot Reload Batch Summary`
- 作用：把多目标热更批次聚合结果渲染进「KBEngine 热更新」通道并打开——每个目标一块、逐文件原因可查（IDE-REV-025 / HOT-006）
- 行为：
  - 聚合台账全部目标（所有有记录的 (rootId, targetId)——不只最近一次发送）：有败有成的批次显示 部分成功（partial）点名每个失败目标与原因；全败显示 全部失败；无败显示 全部目标发出面成功，并明示应用确认态以逐目标明细为准、批次文案不冒充
  - 每个目标不论成败都渲染逐文件块（`rootId::targetId(outcome):` 后随 `file → outcome(detail)` 行），同目标内最差面胜出（failed > sent-unverified > accepted > applied），绿灯文件不盖红灯文件
  - 空台账如实渲染 无投递记录，通道照样打开
  - 成功只到发出面口径：sent-unverified 绝不冒充 applied

### `kbengine.hotReload.retryFailed`

- 标题：`Retry Failed Hot Reload Targets`
- 作用：把热更台账里的失败目标经真实 quick action 入口重新发送（IDE-REV-026 / HOT-007）；已确认成功侧（applied / accepted / sent-unverified——均已发出）不重发，发送次数不增加（重发=重复投递）
- 行为：
  - 在可取消的进度通知下执行，每跳发起前探取消令牌——取消后剩余目标标 跳过(已取消) 不再发送（已完成的动作保留，未发起的不冒充已发）
  - 重发动作经 quick action 树反查（具名注册动作与扫描脚本优先，按索引对齐的 `@http:` 殿后）；反查不到动作的目标如实报告（找不到以 … 为接收方的动作）并跳过，不执行任何动作
  - 重发落账与 fire 路径同走既有面：无响应面动作记 sent-unverified / failed；真实 HTTP 响应按传输事实分类（2xx=未确认送达，非 2xx=failed）；2xx 回包走 accepted/applied 升格与核验窗口结算——重发成功后台账如实翻面，不留 failed 旧账
  - 报告（重发/不重发/取消跳过计数 + 逐目标行含重发结果）落「KBEngine 热更新」通道并打开；空台账如实报告 无投递记录，没有可重试的目标

### `kbengine.hotReload.showRevisionEvidence`

- 标题：`Show Hot Reload Revision Evidence`
- 作用：把真实发送结果的 revision 证据逐（目标,文件）渲染进「KBEngine 热更新」通道——每类证据自带来源标签点名，绝不互相冒充（IDE-REV-027 / HOT-008）
- 行为：
  - 三类证据各自点名来源：fileHash（本地文件内容哈希重算）——对文件当前内容做 sha256 重算（与 applied 核验 digest 基准同一读取通道）；semanticHash（结构语义指纹）——仅 `.def` 文件，结构指纹（属性 `{Type,Flags}` + 方法 Arg 签名面）的 sha256，注释/空白/顺序不影响；engineDigest（运行时回执报告）——运行时回执报告的 digest，会话证据册只把它归到回执逐字回显的文件名下
  - 跨类绝不比较：本地哈希不是运行时证据，值巧合相同也只是两条各自来源的行——跨类不判「一致」（同类比对是协议内验证手段，不在此面做）
  - 缺的种类如实缺席：内容读不到就没有 fileHash/semanticHash 行，运行时没回执过就没有 engineDigest 行，`.py` 文件没有 semanticHash 行——不填空不冒充
  - 两条发送路径都喂证据册：fire 路径与失败目标重发都把真实 HTTP 回包体转给它；空台账如实报 无投递记录

### `kbengine.hotReload.filterByState`

- 标题：`Hot Reload: Show Changed Files (Dirty/Sent)`
- 作用：把热更关注集——改了还没（重）载的文件——渲染进「KBEngine 热更新」通道并打开（IDE-HOT-100 / 设计 §3.4）
- 行为：
  - 关注集 = 仅 DIRTY ∪ SENT（「看哪些改了还没重载」）；FAILED 与 RESTART_REQUIRED 各有专属命令面，绝不混进本过滤
  - 状态从交付台账（rootId × targetId × file）以内容 sha256 为变更基准推导——绝不用 mtime，touch/纯权限改动不会标脏
  - 每个列出的文件显示状态、基线 hash 前缀与台账明细（发送代次 / accepted 注记）——关注集为空时如实报无待处理文件
  - 对命令面板隐藏（`when: false`）——状态栏项才是预期入口

### `kbengine.hotReload.showFileState`

- 标题：`Hot Reload: Show File State`
- 作用：把单文件的热更生命周期状态按引用它的全部目标渲染（从 CodeLens 状态点调起；IDE-HOT-100）
- 行为：
  - 状态点（CodeLens）从同一台账派生状态机取色：CLEAN（无标记）/ DIRTY（橙）/ SENT（蓝）/ APPLIED（绿）/ FAILED（红）/ RESTART_REQUIRED（紫）
  - 工作区根内的文件按目标逐行显示状态、基线 hash 前缀、发送代次与明细；根外文件如实报不在工作区根内
  - RESTART_REQUIRED 即 HOT-005 结构 def 闸：结构性 def 变更拦下整批并呈现为需重启（保守滞留，绝不冒充失败）——原因文本点名该闸

### `kbengine.hotReload.configureChannel`

- 标题：`Hot Reload: Configure Deployment Channel`
- 默认键位：`ctrl+alt+r`（macOS `cmd+alt+r`），**不带 `when` 收窄**——编辑器/工作区任意位置可用，扩展装上即生效，无需用户自己配。避让依据：`ctrl+alt+h` 已是配置指南里 `kbengine.httpRequest.run` 的既有示例键位，`ctrl+]`/`ctrl+d` 是 telnet 面板键位，故热更快捷启用改用 `ctrl+alt+r`
- 改键：在「键盘快捷方式」里改，或在 `keybindings.json` **先解除默认绑定再绑新键**（只加一条同命令的新绑定并不会自动删掉默认键）——
  ```json
  [
    { "key": "ctrl+alt+r", "command": "-kbengine.hotReload.configureChannel" },
    { "key": "ctrl+shift+r", "command": "kbengine.hotReload.configureChannel" }
  ]
  ```
  macOS 的**用户**键位规则同样用 `key` 字段写（`keybindings.json` 是用户规则，不写 `mac`）：
  ```json
  [
    { "key": "cmd+alt+r", "command": "-kbengine.hotReload.configureChannel" },
    { "key": "cmd+shift+r", "command": "kbengine.hotReload.configureChannel" }
  ]
  ```
- 冲突口径：同一键位还绑着别的命令时，VS Code「键盘快捷方式」把两条并列标冲突；按键绑定规则**自下而上取第一条命中 `when` 的规则**——用户规则排在默认规则之后，故用户自绑（或上方解除行）优先，同一层再以实际顺序与上下文为准；本扩展自身的键位互不冲突（有测试锁）
- 作用：按 ProjectProfile 的部署级热更通道面板——**首屏三预设一键启用**（自研接收器[推荐] / KBEngine 官方 / 未配置 + 「高级配置」入口），选预设即按默认参数（本机端口/路径）自动填好并**一键探活，通过即启用**（单 profile 直接进预设首屏、多 profile 先选 profile，合计 ≤2 步、零输入框）；多步流（选通道 → 逐项收参数 → 保存或连通性测试）保留在「高级配置」（IDE-HOT-102 / 设计 §5.1）
- 行为：
  - 通道按 profile 存（`profile.hotReload`）；**未配** 恢复回落既有 `kbengine.hotReload.actionName` quick action 通道（未配行为与现状一致）
  - 两通道：`kbengine-official`（**依赖引擎 `reloadScript`**，经控制台——host/port/可选密码）与 `http`（**自研接收器**，本仓 `scripts/hot-reload-receiver/referenceReceiver.mjs`，accepted/applied 回执契约——URL 模板可含 `${files}`/`${fileList}`、方法、请求体模板、可选 headers）
  - **预设一键启用**：自研接收器默认 `http://127.0.0.1:8000/reload`、POST、请求体 `{"files":${files}}`（**JSON 对象体**——只有对象体才会被 transport 自动附上 `targetId`/`sender_digests`，接收端核对 digest 后才回 `applied`；裸 `${files}` 数组体到不了 applied）；同通道已配过的参数优先沿用，不冲回默认。选中即跑 `transport.probe()`，**探活通过才写盘启用**；不通如实报「探活不通,未启用」并指回「高级配置」核对端口/路径，绝不静默启用
  - 接收器端口要与预设对齐：参考接收器 `scripts/hot-reload-receiver/referenceReceiver.mjs` 默认 `--port 0`（随机端口），快捷启用按 **`node referenceReceiver.mjs --port 8000 --root <暂存根> --mode apply`** 启动，否则预设 URL 的 8000 端口探活会如实报不通
  - **连通性测试**（高级配置内）对收集到的配置跑 `transport.probe()`，不保存（探测绝不写 profile）；畸形配置如实报（通道配置不完整）不猜
  - 每步可取消，最后一步「保存」前零写入——任一步取消返回 false 且 profile 原样
  - 面板走 quick-pick + input 流（仓内 profile 编辑既有模式）；未知 id 报 保存失败，绝不静默新建
  - **零配置可直接调起**：无 profile 时先自动创建并激活一条默认档（默认部署 profile 兜底，2026-11-10 用户令——种子取 assetsRoot 发现链/布局判定/解释器解析，判不出如实空串），只有兜底走不通（未注入/建档返回 null）才保留如实提示「无部署 profile」；单 profile 未配通道时首屏就是预设列表（多 profile 才先选 profile），带 `{ entry: 'advanced', profileId }` 参数则直达该 profile 的高级配置——不因未配置而静默失败
- 激活 profile 配了通道时，fire 路径整批走 `transport.send`（回执直喂双维台账）不再走 quick action；未配通道则 actionName 路径原样

### `kbengine.hotReload.switchChannel`

- 标题：`Hot Reload: Switch Channel (Status Bar Quick Switch)`
- 作用：状态栏通道灯的点击入口——三选 QuickPick（自研接收器[推荐] / KBEngine 官方 / 未配置）一键切换激活 profile 的热更通道，选中即探活
- 行为：
  - 通道灯显示当前通道：`热更:自研HTTP` / `热更:KBEngine官方` / `热更:未配置`；无激活 profile 如实显示未配置
  - 无激活 profile 时点击先走默认部署 profile 兜底（自动创建+激活一条 default 档，2026-11-10 用户令）再进三选；兜底走不通（未注入/建档返回 null）才保留「无激活部署 profile」如实报错
  - 三选项带「(当前)」标记；选中写的是激活 profile 的 `hotReload` 段（与 `configureChannel` 同一保存面）
  - **探活反馈**：通 = 默认底 + `$(plug)` + 「探活通过」信息提示并落盘；不通 = `$(error)` + 状态栏错误色（红底）+ 错误提示带「打开高级配置修参数」**一键修**按钮——**直达该 profile 的高级配置**（跳过 profile/预设首屏），通道不切换、不写盘
  - 灯上文字**始终显示当前已配置的通道**：探活失败时配置没动，文字仍是原通道，红标与 tooltip 才点名这次试的通道——未落盘的通道不冒充当前状态
  - 绿/红只反映最近一次探活结论；结论按「激活 profile + 该 profile 通道配置身份」归属，profile 切换、改参数、面板写盘都会让它作废；探活等待期间 profile 被切换则该次结果直接作废（不写盘）
  - 探活期间状态若变（切 profile/改通道），本次结果如实作废并提示，不把旧状态的结论写到新状态上
  - 既有发送态灯（`kbengine.hotReload.showLog` 背后那盏）只渲染发送态；两灯优先级不同（96 / 98），不抢位不抢色

### `kbengine.hotReload.confirmDefBaseline`

- 标题：`Hot Reload: Confirm Restart (Rebuild def Structure Baselines)`
- 作用：真实重启引擎后重建 def 结构闸基线（F1，2026-11-05 评审）——基线代表目标引擎实际加载的结构版本，只随真实发送（`commit`）或本次显式重启确认前进
- 行为：
  - 把闸本会话见过的每个 def 文件按当前盘上内容重定基线，在热更日志 + 信息提示报告确认文件数
  - 被拦批次（结构变更 / 无基线 / 不可读）永不前进基线——无重启确认时同一被拦内容的第二次保存仍被拦，不会借滚动基线静默放行
  - 不可读文件跳过（不伪造）；报告数就是实际重定基线的文件数
  - 同时清掉全部已知 `(rootId, targetId)` 键上的 `RESTART_REQUIRED` 标记并刷呈现面（角标 + 文件顶部状态点）——重启本身就是解除「需重启」拦下的确认，紫色 `R` 不应在重启后仍挂着（2026-11-12 用户报障：本命令原先只重建基线、从不清标记）。`.py` 的 DIRTY/SENT/FAILED 是投递事实、不是重启事实，本命令不动——那些要靠窗口重载清掉（热更状态全在内存，不落地）

### `kbengine.hotReload.materializeGlobs`

- 标题：`Hot Reload: Generate Watch Glob Default (Write into Settings)`
- 作用：把原本靠派生得出的监视范围写进 `kbengine.hotReload.globs`，给用户一个可见可改的值，不必先去配 `kbengine.assetsRoot` 再靠插件默默派生（2026-11-12 用户令）
- 行为：
  - 写入 `<assetsRoot>/**/*.py` 一条——**绝对路径形态**，绝不写派生口径的 `${workspaceFolder}/...` 形态。显式 globs 是原样交给文件监视器注册口的，而该注册口不展开 `${workspaceFolder}`（派生口径靠 `RelativePattern` 才落地）；把变量形态写回=按字面匹配绝对路径，监视范围静默落空
  - globs 已显式写过就原样不动——含显式空数组（那是另一态「不监视任何模式」）——不覆盖用户意图，如实提示已可改
  - 解不到 `assetsRoot` 就如实跳过并报缺根，绝不写全扫形态
  - 写值触发配置变更事件，watcher 按既有签名判据重建，无需额外接线

### `kbengine.core.showShadowDiffLog`

- 标题：`Kode Core Shadow: Show Diff Log`
- 作用：打开承载双轨 shadow diff 日志的「KBEngine Core Shadow」输出通道（kode2 PR-012）。仅 `kbengine.core.backend=shadow` 模式下才有条目：TS 照常服务，同参数请求镜像发给 kode-server，逐请求记录结果（match / diff / rust-error / rust-timeout / rust-unavailable）
- 行为：
  - `shadow` 模式：展示通道（首条 shadow 条目时创建）；还没有条目时如实报告汇总
  - `ts`/`rust` 模式：通道不存在——信息提示当前 `backend` 取值且日志为空；不创建任何东西
  - 任何模式下 Rust 结果都不影响用户可见行为；该日志是 parity 扩量与回滚演练的诊断证据，不是服务路径

### `kbengine.mcp.toggle`

- 标题：`Toggle Kode MCP`
- 作用：翻转 `kbengine.mcp.enabled`——内建 Kode MCP 服务器定义（2026-11-13 用户令「内置 mcp，点击开启，默认开启」，推翻 2026-11-10「不托管」口径）。状态栏 `$(plug) Kode MCP` 项绑定本命令
- 行为：
  - 开启（默认）且 `kode-mcp` 二进制在位（扩展根 bin/ 或 target/{debug,release}）：扩展经 VS Code 原生 MCP API（`vscode.lm.registerMcpServerDefinitionProvider`，VS Code ≥1.101）按工作区文件夹逐个注册 stdio 服务器——command=二进制路径、args=[资产根]；服务器默认出现在 VS Code 原生 MCP 服务器列表
  - 切到关闭：definition provider 返回空并发射变化事件，原生 MCP 列表摘除服务器；状态栏项显示「已关闭」
  - 二进制缺失：不注册不硬造（诚实无服务器），状态保持「未构建」
  - 老版 VS Code 无原生 MCP API：激活时 feature-detect 跳过注册，命令仍翻转设置与状态栏态——绝不静默拉起 MCP 进程
  - 每文件夹资产根走与扫描器同一发现链（`kbengine.assetsRoot` 配置 → 约定链 → 深探针）；解析落空的文件夹跳过，不硬造根

### `kbengine.discovery.report`

- 标题：`Show Discovery Report`
- 作用：生成「发现与定位」诊断报告并展示在 OUTPUT 面板「KBEngine 发现与定位」通道，报告可整段复制回传维护者，不必贴工作区文件树
- 报告内容（逐键摊开，失败不再静默）：
  - 三个 def 树锚点（entity_defs / entities.xml / types.xml）与派生目录（interfaces / components）：最终取用值及来源（显式配置 / 记忆选择 / 约定链 / 深扫描 / 回落候选首项）、显式配置原值与存在性、约定链命中与未命中、深扫描命中、记忆选择
  - 资产根 `kbengine.assetsRoot`（按引擎装载口径验 `res/server/kbengine.xml`，批129 起约定链含工作区一级 `*_assets` 目录如 `flyff_assets`，命中仍以探针验收）与引擎二进制 `kbengine.binPath`（含 kbe 源码根自动检测）、引擎消息表（批129 双名：用户副本 `messages_fixed.xml` 与缺省 `messages_fixed_defaults.xml`，四级优先级对齐引擎装载序——工作区用户副本 → 引擎源码根用户副本 → 工作区缺省 → 引擎源码根缺省；纯资产工作区两者皆无为常态，报告标 `informational` 不计入问题，只有找到引擎源码根却两份皆缺才报问题）
  - 有界深扫描元信息：访问条目数、是否触顶截断（截断即标注「命中集可能不全」）
  - 问题清单：每项附一句补救建议（缺 entities.xml → 指 `kbengine.entitiesXmlPath`；资产根缺探针文件 → 指期望形态等）
- 行为：
  - 未打开工作区时警告提示，不空转
  - 存在问题时弹警告指路 OUTPUT 面板；全部正常时信息提示
  - 激活期自动发现完成后也会静默落一份报告到同一通道（有问题时才弹提示）

### `kbengine.start.retryDiscovery`

- 标题：`Rescan Project`
- 用途：侧栏「开始」视图的重试入口——对当前工作区重新跑一次项目识别（与激活期同一流程：回放记忆选择、多候选询问一次、有界深扫描），并如实更新视图状态：已就绪 / 未找到（带缺失锚点清单）/ 识别失败（带原始错误）
- 行为：
  - 同一工作区识别在途时重入直接忽略（不叠扫）
  - 已切换走的工作区根的结论一律弃置，绝不渲染给新根
  - 成功路径（已就绪 / 未找到）照激活期口径把发现报告落进「KBEngine 发现与定位」通道（有问题才弹提示）；失败路径不落报告——扫描刚抛错，详情在「开始」视图里

### `kbengine.python.serviceStatus`

- 标题：`Check Python Language Service Status`
- 用途：报告 Python 语言服务（`ms-python.vscode-pylance`）是否可用，三态之一：已激活／未启用（已安装但当前窗口未激活——被禁用或未参与本窗口）／未安装（既未注册也无磁盘证据）
- 判定输入：`vscode.extensions.all` 注册、其 `isActive` 标记、本地用户扩展目录下的 `<id>-<version>` 安装目录（被禁用的扩展不进 `extensions.all`，磁盘探测是兜底证据）
- 诚实口径：`python.analysis.extraPaths` 是否写入永不参与可用判定；有值时消息附明确警示「extraPaths 已写入不等于语言服务可用」

### `kbengine.python.selectInterpreter`

- 标题：`Select Python Interpreter`
- 用途：解释器状态栏项的点击目标——状态栏项本身显示当前解释器（venv 目录名、探测成功时的 Python 版本、来源徽标：`auto` = 工作区发现、`configured` = `kbengine.python.interpreterPath` 设置、`PATH` = PATH 上的解释器；解释器缺失时明说缺失）
- QuickPick 内容：当前生效解释器打头（✓），其后是工作区扫描验真的每个环境（证据：venv 的 `pyvenv.cfg` / conda 的 `conda-meta`，外加盘上真实的解释器二进制 `bin/python`、Windows `Scripts/python.exe`——两者不全的损坏环境绝不列出），再后是 PATH 解释器，列表尾为「创建新 venv…」
- 效果：选中条目把 `kbengine.python.interpreterPath` 写入 workspace 级并即刻生效（解析链每次读实时配置，无需重载）；Esc 零写入

### `kbengine.python.createVenv`

- 标题：`Create Virtual Environment (venv)`
- 用途：一键创建 venv：选目标目录（默认 `<workspaceRoot>/.venv`）→ 在进度通知里跑 `python -m venv <目录>` → 直接对目标目录验真（`pyvenv.cfg` + 解释器二进制，不依赖扫描范围，深层/工作区外目标照常选用）→ 自动选用并把新解释器写入 `kbengine.python.interpreterPath`
- 诚实口径：基础解释器只走设置→PATH 链（绝不走工作区发现——那可能正是要被重建的环境）；PATH 上没有 python3/python 时在任何 spawn 之前如实拒绝并给出提示；目标目录已存在且非空则在任何写入前中止；`venv` 命令非零退出报出 stderr 尾部；建成但验不过的目录（缺 `pyvenv.cfg` 或缺解释器二进制）如实报告且绝不选用

### `kbengine.python.ruffLint`

- 标题：`Ruff Lint Python Files (py37)`
- 用途：经 Rust 后端（`$/kode/ruff/lint`，crates/kode-server/src/ruff_lint.rs）lint 工作区 `.py` 文件：后端 spawn ruff，`--target-version py37` 锁死（KBEngine 3.7.3）+`--no-cache`（绝不向工作区写 `.ruff_cache`），结果发布为 VS Code 诊断（E9xx → error，其余 → warning；无发现的文件清空诊断）
- 有界：单次至多 2000 个文件（TS/Rust 两侧同值）；超出时如实报出实际数量与上限并不执行；工作区没有 `.py` 文件时如实说明并不执行
- 诚实口径：ruff 缺失如实上报（后端返回 `available:false`——绝不静默装作零问题）；后端不可用（kode-server 未连上）如实报为后端问题，不冒充「没有问题」
- 同意式安装（绝不静默装）：ruff 缺失时先询问——「安装(Install via pip)」执行 `<选定解释器> -m pip install ruff`（成功后按解释器自身 bin 目录定位 ruff 并带其路径复跑 lint），「手动安装命令(Show command)」把准确的手动命令打进「KBEngine Ruff」输出通道；安装失败时报错并附同一条手动命令供自行执行，pip 原始输出始终落通道

### `kbengine.python.installRuff`

- 标题：`Install Ruff via pip (Selected Interpreter)`
- 用途：手动安装入口——执行 `<选定解释器> -m pip install ruff`，随后复检 ruff 并如实报出版本（检不出就报未检出）
- 诚实口径：未选定解释器时前置拒绝（指向 `Select Python Interpreter`，不瞎猜某个 python）；安装失败时报错并附准确的手动命令（`"<python>" -m pip install ruff`，路径带空格时加引号）供自行执行；pip 完整日志留在「KBEngine Ruff」输出通道

### `kbengine.project.import`

- 标题：`Import Existing KBEngine Project`
- 用途：把现有 KBEngine 项目导入扩展的项目 profile：选择资产根、核对识别结果、确认后建立带持久稳定 ID 的 profile
- 识别口径（只做存在性探测，不写盘）：`entities`（entities.xml）、`defs`（entity_defs）、`scripts` 三面走与发现报告同一份约定链；`scripts` 取 entities.xml 所在目录（entities.xml 在根上时即根本身）；`engine` 面探测资产根/父目录/祖父目录下的 `kbe/` 源码锚点（引擎仓通常是资产根的兄弟）
- 预览：QuickPick 逐面列出识别结果与准确路径；未命中的面如实显示「未识别」
- 行为：
  - 选「导入」建立 profile（显示名取资产根目录名）并报出其 ID 与 Python 解释器状态（设置存在才采用 → PATH → 如实缺失）；任一步取消（Esc/关闭对话框）零写入
  - entities/defs/scripts 全空的目录在预览前就被拒绝并给出警告（不产生垃圾 profile）

### `kbengine.project.create`

- 标题：`Create Minimal KBEngine Project`
- 用途：按最小模板清单一次生成可被导入的 KBEngine 空项目，并直接建立项目 profile
- 模板清单：固定目录与文件清单（scripts 布局与共享发现约定对齐——scripts/entities.xml、scripts/entity_defs/types.xml，另有 scripts/base、scripts/cell 两个服务端角色目录）；引擎仓不属模板，engineRoot 如实记空
- 生成器保护，全部继承：
  - 冲突拒绝：任何预览之前逐条探测目标路径；任一目标已存在（文件或目录）即按准确路径上报并整体中止，一个文件都不写
  - 预览：与生成器共用的 QuickPick 确认面逐条列出清单项（新增目录/新增文件 + 准确绝对路径）；只有选「确认生成」才落盘，Esc 零写入
  - 原子写与回收：文件走原子写（临时文件 + rename）；任一步失败即回收本次新增的全部内容（先逆序删文件，再逆序删目录，目标根本身是本次隐式建出且此前不存在时一并回收）并报出失败
- 行为：创建成功后走与导入命令同一识别链和身份存储建立 profile（显示名取目标目录名），消息报出 profile ID 与 Python 解释器状态（设置存在才采用 → PATH → 如实缺失）

### `kbengine.project.selectActive`

- 标题：`Select Active Project Profile`
- 用途：选择哪条 project profile 是活动 profile；选择按稳定 ID 持久化（workspaceState），每次真实切换恰发一次切换事件（其他功能订阅该事件响应 profile 切换）
- 选择器：QuickPick 逐条列出全部 profile 的显示名与稳定 ID；选中即持久化并报出
- 诚实口径：
  - 选择以稳定 ID 记忆——显示名改名不丢选择；重选已是活动的 profile 不算切换，不发事件
  - 未知 ID 拒绝（不落盘不发事件）；选择对应的记录后来被删除时如实解析为 null，不伪装有效
  - 完全没有 profile 时如实说明，不打开选择器

### `kbengine.profile.health`

- 标题：`Show Active Profile Health`
- 用途：把活动 profile 的健康状态汇总到工作台，逐类问题一行并带具体定位入口；活动 profile 经稳定 ID 选择解析（见 `kbengine.project.selectActive`）
- 问题类别与入口（每类问题各带自己的入口）：
  - 根歧义（profile 的资产根已不在盘上）→ 重跑 `kbengine.project.import`
  - 缺引擎（引擎根未记录，或已不在盘上）→ 重跑 `kbengine.project.import`
  - 缺解释器（未记录，或已不在盘上）→ 打开 `kbengine.python.interpreterPath` 设置
  - 缺语言服务（PRJ-005 三态判定非已激活）→ 运行 `kbengine.python.serviceStatus`
- 行为：
  - 无活动 profile → 如实说明并指向选择命令，不开选择器
  - 全部健康 → 一条健康消息，无警告无选择器
  - 有问题 → 警告报出问题数，QuickPick 逐条列出（标签=类别，description=判定事实，detail=定位入口）；选中一行跳到对应入口（命令或设置），Esc 只看不跳

### `kbengine.extension.identity`

- 标题：`Show Extension Identity Report`
- 作用：报告本发布者下每个已安装扩展的身份与宿主位置，让 bug 报告能说清用户跑的是哪个构建
- 报告内容（输出通道「Kode 扩展身份」，整段可复制）：
  - 宿主位置：设置了 `vscode.env.remoteName` 时为 `remote(<name>)`，否则 `local`，外加宿主应用名
  - 每个匹配安装（按发布者前缀的扩展 ID 排序）：完整 ID 与版本；`installed=yes|no`——安装目录当前是否存在于文件系统（目录消失如实报告）；`active=yes|no`——当前窗口是否已激活（安装与激活是两个正交事实，绝不合并）；`side=workspace host|ui host`——哪个扩展宿主在跑
  - 无匹配安装时如实说明，不出空清单
- 行为：命令从不扫描工作区；只读 `vscode.extensions.all` 并 stat 安装目录

### `kbengine.quickActions.show`

- 标题：`Run Quick Actions`
- 作用：弹出「快速执行动作」清单并执行选中的那条。动作清单写在工作区的 `.kbengine/debug.json` 顶层 `quickActions` 数组里，跟着 KBEngine 工程走，不进 VS Code 设置、不进 `launch.json`
- 入口：「快速执行」独立视图逐行动作；Servers 视图标题栏按钮、`.def` / Python / XML 编辑器右上角按钮、命令面板 `Run Quick Actions`
- 三类后端（白名单，不提供任意 shell 入口）：
  - `command`：VS Code 命令 id，`args` 原样透传（字符串项支持变量），复用被调命令自身的报错
  - `script`：执行配置里显式声明的脚本；`background: true` 表示起服类不等退出码（进程活着即报「已启动」）
  - `http`：请求配置里写死的 URL，不接受运行时拼接
- 变量（执行时替换，作用于配置字面串）：`${workspaceFolder}`（生效快速动作配置根，通常是首个工作区根）、`${workspaceFolder:名字}`（按名取根）、`${env:变量名}`。未知变量直接报错中止并指名变量，不做静默空串替换
- 行为：
  - 动作缺省弹 modal 确认框（`confirm: false` 跳过）；执行流水进 OUTPUT 面板「KBEngine 快速执行动作」，脚本的 stdout/stderr 原样进通道
  - 失败一次性弹窗（动作名 + 退出码 / 状态码 / 原因），脚本 stdout/stderr 同时留在通道
  - 配置条目非法（如白名单外的 `type`、缺必填字段）逐条剔除并计数提示，不整表失败
  - 缺配置时自动扫配置根与 `assetsRoot` 顶层 `.bat` / `.ps1` 并写进新配置；扫描生成的动作以脚本所在目录作为 `cwd`。已有空配置时启动期提供登记选择
  - `.ps1` 使用 PowerShell 执行；script 可配置 `venv: { enabled: true, path?: "${workspaceFolder}/.venv" }`，启用后把虚拟环境加入子进程 PATH
  - 清单按后端分组：同类型连续段共用一条组名分隔线，不重排配置顺序

### `kbengine.quickActions.runDefault`

- 标题：`Run Default Quick Action`
- 作用：一键执行「上次实际执行过的动作」；从未执行过就取清单第一条。工作区没有任何可执行动作时提示「未发现可执行脚本」并指路 `.kbengine/debug.json`
- 入口：命令面板；ENTITIES 标题栏不再显示快速执行入口
- 行为：
  - 记忆键 `kbengine.quickActions.lastRun` 存在本工作区的 workspaceState 里；清单中选过的动作立即成为 ▶ 的默认目标，与该次执行成败无关
  - 记忆的动作被删掉/改坏时回落到清单第一条，不报错
  - 执行链与 `kbengine.quickActions.show` 完全一致（变量替换 → 确认 → 分发 → 流水）

### `kbengine.quickActions.runByName`

- 标题：`执行快速动作`
- 作用：按名字精确执行某条快速动作；名字以命令参数形式传入（命令面板「运行选定命令」、键绑定或程序化 `commands.executeCommand`）。HTTP 抓取登记过的名字先经 HTTP 请求服务解析，再回落到常规快速动作清单
- 入口：带参数的命令面板；内部调用方（如 HTTP 抓取动作的再执行路径）
- 行为：执行链与 `kbengine.quickActions.show` 完全一致（变量替换 → 确认 → 派发 → 日志）；给定名字匹配不到任何动作时以同样的缺脚本风格报错

### `kbengine.quickActions.scanScripts`

- 标题：`Rescan Scripts for Quick Actions`
- 作用：重新扫描生效工作目录和 `assetsRoot` 顶层的 `.bat` / `.ps1`，按选择结果刷新扫描生成的动作，保留手工动作与其他调试配置
- 脚本运行目录：扫描生成的动作以脚本所在目录为 `cwd`
- 入口：「快速执行」视图标题栏重新扫描按钮、空态行、命令面板

### `kbengine.quickActions.runByName`

- 标题：`执行快速动作`
- 作用：按动作名执行 `.kbengine/debug.json` 的 `quickActions` 条目，由「快速执行」视图的动作行调用

### `kbengine.python.syncExtraPaths`

- 标题：`Sync Python Extra Paths`
- 作用：把工作区发现的 KBEngine scripts 根写入 `python.analysis.extraPaths`（WorkspaceFolder 级），让 Python 扩展（Pylance/pyright）能解析实体脚本里的 `import KBEngine`、`import common.*`；存根布局是进程档模板（`<存根目录>/base/KBEngine/__init__.pyi` 在盘）时，同一同步还维护工作区 `pyrightconfig.json`
- 入口：命令面板 `Sync Python Extra Paths`；扩展激活时也会自动同步一次（`kbengine.python.extraPathsSync` 默认开，激活期全程静默零提示）
- 行为：
  - scripts 根候选与实体索引同口径：`<工作区>/scripts`、`<工作区>/assets/scripts`、`<工作区>/server_assets/scripts`、一级 `<xxx>_assets/scripts`（批129 资产根约定）；只收磁盘上真实存在的
  - `.kbengine/stubs`（存根导出目录）在 `kbengine.python.stubExport` 开且 `KBEngine.pyi` 在盘时一并并入管理段；`kbengine.python.stubDir` 配置的用户目录不并入管理段
  - 经带资源域的 `getConfiguration('python', folder).update(...)` 写入（WorkspaceFolder 级），settings.json 里的注释由宿主保全；只在发现结果与现值不同时写，无变化不碰文件
  - 只管理本扩展写入的那一段：上次写入的集合记在 workspaceState，再同步时先剔除再写新集合，用户手填的路径永不被动
  - pyrightconfig 面（进程桩在盘时）：按 scripts 根 × 进程角色生成 `executionEnvironments`（对应进程桩包排各环境 `extraPaths` 首位），全局 `stubPath` = `<managedDir>/stubs/_shared`，`reportMissingModuleSource: false`——工作区里直接跑 `pyright` 与 Pylance 同口径
  - pyrightconfig 面只管理自己记忆的那一段：用户键、用户 `extraPaths`、用户 executionEnvironments 一律原样保留；`pyproject.toml` 的 `[tool.pyright]` 段、`extends` 继承配置、冲突的用户全局 stubPath 一律不碰——同步如实播报并保留原文件
  - `kbengine.managedDir` 或 `kbengine.python.stubDir` 变更即按新位置重导存根并静默重同步整套接线（settings 键 + `pyrightconfig.json`），挪动存根位置后无需重载窗口或手动重跑
  - 设置 `kbengine.python.extraPathsSync: false` 可整体关闭（关闭后命令只说明不写）；手动重跑会播报写入结果，激活期自动同步不打扰

### `kbengine.python.exportStubs`

- 标题：`Export KBEngine Python Stubs`
- 作用：把插件内置 KBEngine 桩包（仓库顶层 `typings/` 模板，派生自 cuihairu/kbengine fork typings，钉点 commit 见 `typings/README.md`）复制到项目存根目录成真实 `KBEngine/` 包，配合 stubPath/extraPaths 接线让 Pylance 解析 `import KBEngine`
- 布局：`KBEngine/__init__.pyi` 带显式重导出顺序（进程层星导入在前、一类一文件重导出殿后——服务端 Entity/Proxy 模型压过 bots 层同名客户端模型），含逐类分件、`hooks.pyi` 回调协议、kode 独有运行时向量类（`Vector2/3/4`）与引擎进程层文件
- 存根目录三级解析（批142）：`kbengine.python.stubDir` 设置 > 环境变量 `KBENGINE_STUB_DIR` > 默认约定 `<工作区>/<managedDir>/stubs`；支持 `${workspaceFolder}`/`${env:NAME}` 等 VS Code 变量
- 入口：命令面板 `Export KBEngine Python Stubs`；扩展激活时也会自动复制一次（`kbengine.python.stubExport` 默认开，激活期全程静默）
- 行为（copy-if-absent 零覆盖）：
  - 已在盘的文件一个字节不动——对项目副本的修改/魔改在每次导出后都保留；覆盖只走显式重置命令且要用户确认
  - kode 自管目录里带 kode 生成标记的旧单文件 `KBEngine.pyi` 一次性迁移移除（`KBEngine/` 桩包取代）；无标记的同名文件是用户资产，不碰
  - 目录不可写（只读挂载等）时告警并继续其余工作区文件夹
  - 复制成功后链一次 extraPaths 同步，存根目录即刻生效
  - 设置 `kbengine.python.stubExport: false` 可整体关闭

### `kbengine.python.resetStubs`

- 标题：`Reset KBEngine Python Stubs`
- 作用：唯一覆盖通道——删除存根目录里与模板集同名的文件后按内置模板重新复制；插件更新带了新模板或项目副本与模板漂移时使用
- 确认：执行前弹模态确认（`重置` 才动手）；取消零动作
- 范围：只动与模板集同名的文件；模板集之外的文件（用户自加内容）一律不碰；kode 自管目录里带生成标记的旧 `KBEngine.pyi` 一并回收
- 重置成功后链一次 extraPaths 同步

### `kbengine.python.exportTypeStubs`

- 标题：`Export KBEngine Python Type Stubs`
- 作用：把 `entity_defs/types.xml` 里的自定义类型（utype）导出成 Python 类型桩模块 `kbe_types.py`——`FIXED_DICT` → `TypedDict` 类、`ARRAY` → `List[元素]`、别名 → 目标类型名，配合 extraPaths 接线让实体脚本与工具脚本获得 `import kbe_types` 的真实类型来源（立项分析见 [def-pyi-stubs 可行性](../design/def-pyi-stubs.md)）
- 选择真 `.py` 而非 `.pyi`：纯 `.pyi` 没有运行时形态，Python 侧 `import kbe_types` 拿不到值；真模块既能当 Pylance 的类型来源也能被运行时导入
- 引用关系与来源：`FIXED_DICT` 属性可引用其他自定义类型（如 `PLAYER_ID`），生成器保留名字引用且逐类/逐属性写入 `# source: types.xml:<line>`；禁止用生成行号反推原始行号
- 实体级类型：`.def` 属性引用 `types.xml` 自定义类型时，激活期同时生成 `entity_types.pyi`，逐实体落成 `Avatar.profile: ITEM_INFO` 这类声明；来源注释保留 `.def` 与 `types.xml` 双原始行
- 目录与开关与 `kbengine.python.exportStubs` 同一套：`kbengine.python.stubDir` 三级解析、共用 `kbengine.python.stubExport` 开关；扩展激活时在 KBEngine.pyi 之后自动导出一次（静默）
- 行为：
  - 内容确定：同输入生成逐字节一致的内容（头部无时间戳），kode 自管目录内「内容一致零写、陈旧重写」
  - 别名赋值是模块级急切求值，按依赖拓扑排序发射；`types.xml` 指引为空或别名成环的类型跳过并在提示里说明原因，绝不生成引用未定义名字的赋值
  - 内置类型映射与 TS 生成器同表：整型 → `int`、浮点 → `float`、字符串 → `str`、`VECTOR2/3/4` → `KBEngine.Vector2/3/4`、`PY_DICT/PY_TUPLE/PY_LIST` → `dict`/`tuple`/`list`（有 `<Default>` 时按字面量精化）、`PYTHON` → def 声明了 `impl` 时按 impl 类否则 `Any`、`ENTITYCALL` → `KBEngine.EntityCall`、`BLOB` → `bytes`、无对应物 → `Any`（有损但合法）
  - 配置的用户目录里已有同名 `kbe_types.py` 按用户资产不覆盖；默认目录 `.kbengine/stubs` 归 kode 自管
  - 工作区没有自定义类型时不生成文件、不提示打扰；导出成功后链一次 extraPaths 同步
- `types.xml` 落盘即自动重生成：保存/新建/删除后由 watcher 静默重导出（不设去抖、不加开关——零写纪律保证重复触发无副作用；`kbengine.python.stubExport` 关掉时实际停摆）
- `.def` 新建/修改/删除自动再生 `entity_types.pyi`（C-22）：400ms 尾沿去抖把连发合并为一次再生,共用 `kbengine.python.stubExport` 总闸与内容比对零写纪律;再生成功后 `entity_types.pyi` 来源镜 CodeLens 计划原地刷新(失败不刷新)。口径:只盯 `.def`——`entities.xml` 未接线
- 设置 `kbengine.python.stubExport: false` 可整体关闭（与 KBEngine.pyi 存根共用开关）

### `kbengine.source.reveal`

- 标题：`Reveal Source Location`
- 作用：内部导航助手，对定义跳转目标强制编辑器 reveal。定义 provider 用 `vscode.open` 打开一个本已是活动编辑器的文档时，VS Code 会跳过 reveal——表现为「返回后再点同一 def 链接没反应」；本命令打开文档并转发选区，目标行必然露出（批159 def 链镜像链接）
- 行为：
  - 第二参数收 `{ selection: vscode.Range }`，经 `showTextDocument(uri, { selection })` 应用
  - 无 URI 调用为 no-op
  - 为定义 provider 而存在，不是用户入口：与其他贡献命令一样注册（含 `onCommand:` 激活事件），面板保持为空，程序化跳转可靠依赖它

### `kbengine.git.showHistory`

- 标题：`Kode: 查看文件历史 (View File History)`
- 作用：打开文件历史视图（IDE-GIT-001 门控，IDE-GIT-005）。仅 `kbengine.gitHistory.enabled` 开启时入口可见（资源管理器文件右键、编辑器右键/标签右键、命令面板）；它只是入口——历史只在用户打开时按需查询，激活、打开文件、移动光标、改变选区都不触发，无预取无轮询
- 行为：
  - 同一开关门控：功能关闭时命令从菜单隐藏，直接调用不跑任何 Git
  - 从调用参数（右键 URI）或活动编辑器解析目标；按需定位所属 Git 仓库，把第 0 页查进 `kbengine.gitHistory` 侧边栏树并聚焦
  - 树行显示 subject + `author · time` 与 tooltip（hash、作者邮箱、时间、body）；行尾「加载下一页」仅在点击时追加下一页；视图标题标明文件与基线提交（`a.py @ 01234567`）
  - 查询沿重命名追踪（IDE-GIT-007）：重命名前后提交都列出，每行带该提交时点的路径；追踪以复制/删除而非干净重命名收尾时，如实给出 copy-or-move 边界行，不假装历史连续
  - 空闲视图显示引导行、零 Git 调用；终态（untracked / staged-no-history / 空仓库 / 定位失败 / 有界执行器结果）如实报告

### `kbengine.git.historyNextPage`

- 标题：`Kode: 加载下一页文件历史 (Load Next History Page)`
- 作用：`kbengine.gitHistory` 视图的内部树节点动作（IDE-GIT-005）；点击时按需追加下一页有界提交记录。对命令面板隐藏（`when: false`）——不是用户入口
- 行为：
  - 仅当视图处于已加载且 has-more 状态才查询；终态或已到末页不查询
  - 追加下一页不重不漏；下一页失败/为空时保留已加载行并清除 has-more

### `kbengine.git.showRangeHistory`

- 标题：`Kode: 查看选中范围历史 (View Selection History)`
- 作用：打开选区历史入口（IDE-GIT-001 门控，IDE-GIT-010 入口），编辑器右键仅在有选区时显示，命令面板常驻；门控与文件历史入口一致
- 行为：
  - 受 `kbengine.gitHistory.enabled` 门控；功能关闭时入口隐藏，直接调用不跑任何 Git
  - 有选区：把工作副本选区映射到其已提交（HEAD）行跨度（IDE-GIT-008），查询该跨度的逐提交时间线（IDE-GIT-009），展示在 `kbengine.gitRangeHistory` 侧边栏视图——标题写明查询基准（`file @ HEAD 行 N-M`）并保留原始选区用于展示；未提交/未保存的行如实警告，只展示已提交部分
  - 无选区：右键入口隐藏（要求 `editorHasSelection`）；直接调用提示先选中代码，不跑 Git
  - 视图持有自身状态——切换编辑器或移动光标绝不重查询，也绝不把过期选区套到别的编辑器（无激活/文件打开/光标/选区监听）

### `kbengine.git.openRangeHistoryDiff`

- 标题：`Kode: 打开版本差异并定位范围 (Open Version Diff and Locate)`
- 作用：把范围历史条目的提交版本与其父版本以只读 diff 打开，并定位到该版本中条目的行范围（IDE-GIT-010）。绑定 `kbengine.gitRangeHistory` 视图的条目行点击；对命令面板隐藏（`when: false`）
- 行为：
  - 以 `(entry, filePath, repoRoot, parentFilePath?)` 调用；先打开与 `kbengine.git.openVersionDiff` 相同的版本对父版本 diff（IDE-GIT-006 虚拟文档），再在非预览标签打开该提交的版本内容并选中条目行范围（`Range(rangeStart-1, 0, rangeEnd-1, 0)`）
  - 行范围逐条目记录自 `-L` diff hunk 的新侧（`RangeChangeEntry.rangeStart/rangeEnd`），范围在提交间移动也能定位
  - 跨重命名时左侧用父代路径（IDE-GIT-007）；受 `kbengine.gitHistory.enabled` 门控，功能关闭不跑任何 Git

### `kbengine.git.openVersionDiff`

- 标题：`Kode: 打开版本差异 (Open Version Diff)`
- 作用：在编辑器以只读 diff 打开历史提交的文件版本与其父版本（IDE-GIT-006）。绑定 `kbengine.gitHistory` 视图的提交行点击；对命令面板隐藏（`when: false`）
- 行为：
  - 以 `(commit, filePath, repoRoot, parentFilePath?)` 调用；经 `git rev-list --parents -n1` 解析父提交；根提交左侧为空，整文件按新增呈现
  - 跨重命名左侧用父代路径（IDE-GIT-007），纯重命名显示无变化，不伪造整文件新增
  - 两侧都以虚拟文档（`kode-git-version` scheme，按 repo/commit/path 键）打开——绝不覆盖工作区文件或当真实文件打开
  - 该提交时点不存在的路径（已删除或尚未创建）显示空侧；有界读失败如实报错，不静默给空
  - 受 `kbengine.gitHistory.enabled` 门控；功能关闭不跑任何 Git

### `kbengine.git.openVersionContent`

- 标题：`Kode: 打开版本内容 (Open Version Content)`
- 作用：只读打开历史提交版本的文件（IDE-GIT-006）。绑定 `kbengine.gitHistory` 视图的提交行右键菜单；对命令面板隐藏（`when: false`）
- 行为：
  - 在非预览编辑器标签打开该 repo/commit/path 的 `kode-git-version` 虚拟文档——不写、不替换任何工作区文件
  - 该提交时点不存在的路径（已删除）打开为空；有界读失败如实报错
  - 受 `kbengine.gitHistory.enabled` 门控；功能关闭不跑任何 Git

## 典型使用流程

### 新建实体

1. 运行 `Create Entity from Wizard`
2. 选择输出配置
3. 生成 `.def` 与可选 Python 文件
4. 如果启用了 `kbengine.generator.registerInEntitiesXml`，写入 `entities.xml`
5. 在实体浏览器中继续编辑

### 查看线上行为

1. 启动需要观察的组件
2. 打开日志查看器
3. 打开监控面板观察资源变化
4. 使用依赖图查看实体关系

注意：
日志与监控都依赖 KBEngine 的协议交互。
日志协议适配当前尚未完成；监控面板在 watcher 无响应时只保留 machine 返回的基础状态。

### 调试某个组件

1. 确认目标组件的 telnet 已开启（地址/端口/密码按解析链确认：kode 设置 `kbengine.telnet.*` → 元件 `kbengine.xml` 的 `<telnet_service>` 段 → 引擎 `kbengine_defaults.xml`）
2. 运行 `Create Debug Config Template`，生成 `.kbengine/debug.json`；其中的 `telnetHost`/`telnetPort`/`telnetEnableCommands` 只用于 `Start Debugging` 的提示语，`pathMappings` 用于 launch.json 生成——都不影响 telnet 探测与面板
3. 运行 `Start Debugging` 查看提示，先通过 telnet 向目标组件输入项目实际使用的开启调试命令
4. 运行 `Attach to Component`，在进程列表里选目标进程（匹配组件名的进程置顶标 ✓）

## 命令是否支持配置联动

支持。很多命令会读取 `kbengine.*` 设置，例如：

- 实体导航读取 `kbengine.entityDefsPath`
- 服务器启动读取 `kbengine.autoStart`
- 日志面板读取 `kbengine.loggerPort`
- 依赖图读取 `kbengine.entitiesXmlPath` 和 `kbengine.entityDefsPath`
- 生成器读取 `kbengine.generator.*`

调试流程是例外。本地附加不再读取旧的 `kbengine.pythonPath`、`kbengine.debugPort`、`kbengine.autoAttachDebug`；`.kbengine/debug.json` 只服务 `Start Debugging` 的提示语与 `pathMappings`，不参与 telnet 探测/面板/状态灯。远程附加（`kbengine.debug.attachRemote`）的目标列表来自设置 `kbengine.debug.remoteTargets`。

## 调试命令说明

### `Attach to Component`

KBEngine 的调试模型不是“启动一个 Python 文件”。这里的 Python 运行时是嵌在 C++ 组件进程里的，因此扩展只保留两步：

1. 通过 telnet 向目标组件输入项目实际使用的开启调试命令
2. 通过 VS Code 内建进程选择器（`${command:pickProcess}`，由 debugpy 解析弹出）选择目标进程附加

扩展生成的 `launch.json` 固定为进程选择器 attach 形式：

```json
{
  "name": "KBEngine: Attach to baseapp",
  "type": "debugpy",
  "request": "attach",
  "processId": "${command:pickProcess}",
  "justMyCode": false,
  "pathMappings": [
    {
      "localRoot": "${workspaceFolder}",
      "remoteRoot": "${workspaceFolder}"
    }
  ]
}
```

旧版本生成的 `${input:kbengineProcessId}` 手输 PID 输入项已废弃；运行 `Update launch.json` 会自动清除该遗留输入。

配置了 `kbengine.debug.remoteTargets` 时，`Update launch.json` 会把每个远程目标以 debugpy `connect` 形式追加为独立配置（`connect: {host, port}`；仅当条目带成对 `localRoot`/`remoteRoot` 时写 `pathMappings`）。

### 推荐使用顺序

1. 确认目标组件 telnet 已开启（kode 设置 `kbengine.telnet.*` 或元件 `kbengine.xml` 的 `<telnet_service>` 段）
2. 运行 `Create Debug Config Template`
3. 在 `.kbengine/debug.json` 中填写开启调试命令与路径映射（`telnetHost`/`telnetPort` 只影响提示语）
4. 运行 `Update launch.json`
5. 运行 `Start Debugging` 查看提示并先开启调试
6. 运行 `Attach to Component`，在弹出的进程列表里选目标进程（匹配组件名的置顶标 ✓）

### 排查要点

如果 `Attach to Component` 失败，优先检查这些点：

1. 目标 KBEngine 组件是否已经通过 telnet 真正开启调试（telnet 地址/端口/密码按解析链确认：kode 设置 `kbengine.telnet.*` → 元件 `kbengine.xml` 的 `<telnet_service>` 段 → 引擎 `kbengine_defaults.xml`）
2. 进程列表里选的是否就是目标组件进程，而不是其他 manager 或辅助进程
3. `.kbengine/debug.json` 中的 `telnetEnableCommands` 是否与项目真实命令一致（只影响 `Start Debugging` 的提示语，不影响 telnet 连接本身）
4. `.kbengine/debug.json` 中的 `pathMappings` 是否映射到当前工作区源码目录
5. 当前机器里是否已经安装并启用 `ms-python.debugpy`

### `kbengine.build.previewTask`

- 标题：`Build: Preview Task Description`
- 作用：预览由活动 profile 派生的构建任务（IDE-TSK-001）——对 profile 资产做脚本编译检查；预览里的命令行、工作目录、环境变量就是任务实际执行的内容，逐字一致（任务列表注册是 TSK-002 的 TaskProvider，按同一描述）
- 入口：命令面板
- 行为：
  - 解析活动 profile（assets 根 + 解释器）并派生任务描述：`<解释器> -m compileall -q <assets>/scripts`，cwd=`<assets>`，env 带 `PYTHONUTF8=1`（compileall 错误行按 UTF-8 稳定输出，GBK 控制台不乱码）
  - profile 未选解释器时回退 PATH 上的 `python3`，回退在预览里如实标注——所见即所跑
  - 预览对话框展示任务类型、名称、`cd` 行、完整命令行（含空格路径按 shell 拆词规则加引号）、env 逐条、解释器来源行
  - 无活动 profile：如实提示先去选一套
- 边界：本命令只预览不执行；执行面是 TSK-002 的任务注册，编译错误定位到源码是 TSK-003 的 problem matcher

### `kbengine.tests.list`

- 标题：`Tests: List Project Python Tests`
- 作用：发现项目声明的 Python 测试（IDE-TSK-004）——QuickPick 列出发现的测试文件，范围严格限定在所选 profile
- 入口：命令面板
- 行为：
  - 解析活动 profile，只扫它的 scripts 根（`<assets>/scripts`，递归）收 `test_*.py` / `*_test.py`——pytest/unittest 通用命名约定；工作区里其他 `*_assets` 根与引擎仓是依赖库，结构性不进清单（发现只从 profile 的 scripts 根起步，不接收别的入口）
  - 隐藏目录与 `__pycache__` 跳过；文件内静态可见的用例（`def test_*` 函数与 `class Test*` 方法，带行号列号）解析成条目的用例数与用例名
  - 选中文件即在编辑器打开；Esc 不打开
  - 一无所获：一条如实提示点名 scripts 根与命名约定——不弹空列表
  - 无活动 profile：如实提示先去选一套
- 边界：本命令只发现与列出；测试面板跑单个测试是 TSK-005

### `kbengine.messagetable.preview`

- 标题：`MessageTable: Preview Entity Message Table`
- 作用：预览单个实体的消息表（IDE-SDK-001）——选实体查看现有计算结果（各方法段、utype、alias 配置、问题清单）的 markdown
- 入口：命令面板
- 行为：
  - 等实体索引首扫完成后，按字典序列出已索引实体名供 QuickPick 选择
  - 选中后用与索引同一套 scan-roots/def-loader 公式构建消息表，渲染 markdown 在预览文档展示
  - 缺声明（该实体的 def 取不到——未登记或 `.def` 文件缺失）：一条如实警告点名实体与原因——不展示空预览、不猜
  - 一个实体都没索引到：如实提示；Esc 静默退出
- 边界：只做预览；JSON 导出是 SDK-002

### `kbengine.messagetable.export`

- 标题：`MessageTable: Export Entity Message Table JSON`
- 作用：导出单个实体的消息表 JSON（IDE-SDK-002）——输出保留方法段、utype、alias 配置与问题清单（renderMessageTableJson 现有面）
- 入口：命令面板
- 行为：
  - 与预览命令同一实体 QuickPick、同一共享构建面
  - 保存对话框默认名 `<实体>.messagetable.json`；取消不创建文件（零写入）
  - 缺声明与预览同样如实警告——不弹保存
  - 写失败如实带原因呈现；成功提示点名写入路径
- 边界：只做导出；预览命令是 SDK-001

### `kbengine.infer.run`

- 标题：`KBEngine: Run pyrefly Infer (无标注函数 stub 推断)`
- 作用：跑 pyrefly 推断管线（KODE-CFG-017）——把 scripts 树镜像到 `.kbengine/inferred/`，以 `.kbengine/stubs`（def/types.xml 验真过的存根）为类型环境对副本跑 `pyrefly infer`，让未标注函数拿到推断注解，不碰用户源码
- 入口：命令面板
- 行为：
  - 已禁用（`kbengine.infer.enabled=false`）：如实提示，不运行
  - 找不到 pyrefly 二进制（未配置、不在 PATH、不在 pipx 默认位置）：如实提示 `pipx install pyrefly` 或设置 `kbengine.infer.pyreflyPath`——功能降级，不抛错
  - 任一 scripts 根非零退出按原文带退出码报告；成功报 scripts 根数
  - 所有写路径先过写域闸——默认 `managed` 域只放行 `.kbengine/**`，写用户源码需显式 `kbengine.infer.sourceWrite=user`
- 边界：只做推断；消费层（native providers 读标注副本）属后续批次

### `kbengine.managedDir.syncExclusions`

- 标题：`KBEngine: Sync .kbengine Exclusions (搜索/watcher/gitignore)`
- 作用：重新落 `.kbengine` 隔离——`search.exclude` 与 `files.watcherExclude` 补上 `.kbengine/**` 条目（只动 kode 自己写过的键，用户条目绝不删），git 仓库根 `.gitignore` 已存在时追加 `.kbengine/` 行
- 入口：命令面板
- 行为：
  - 跑与激活期静默同步同一面，但报告写了什么（哪些工作区拿到 `search.exclude` / `watcherExclude`，哪些 git 根追加了 `.gitignore`）
  - 绝不创建 `.gitignore`（SVN / 无 VCS 工作区不做任何 git 侧写入）
  - 幂等：无变化时二次运行零写入
  - 显式用户请求：本命令绕过激活期的「写一次记忆」，即使 kode 已判定尊重被删除的条目也会补回缺失的 `.kbengine/` 行（改托管目录名后的正规再入口）
- 边界：只做隔离；镜像与推断步骤见 `kbengine.infer.run`

### `kbengine.diagnostics.exportReproSummary`

- 标题：`Export reproduction config summary`
- 作用：导出一页「环境长什么样」的复现配置摘要（IDE-REL-007），随诊断报告一起回传即可复现环境
- 入口：命令面板
- 行为（输出通道「Kode 复现配置摘要」，整页可复制）：
  - 宿主角色：`local` 或 `remote(<名>)` + 当前窗口的扩展宿主侧（workspace host | ui host）
  - 活动版本：每个 `cuihairu.` 名下扩展 `id@version active=yes|no side=…`，另列本安装的构建提交（`out/buildCommit.json`，读不到如实 `unknown`）
  - 根：workspace 目录、索引扫描根、活动 profile（显示名 + 资产根 + 引擎根；未选择 profile 如实写无）
  - 开关：扩展自身 package.json 贡献的全部 `kbengine.*` 布尔设置（自动枚举，与配置面同步增长），逐项 on/off
  - 队列数据：诊断排队/在途、待更新注解、索引任务、schema 冷构建，加语言服务在册操作计数（IDE-MET-008 口径）
  - 连接（已遮蔽）：引擎 dbmgr 数据库接口配置渲染为 `host=… port=… database=… username=*** password=*** encrypt=…`——username/password 永不落值，全文再过一遍把 `password=`/`token=`/`secret=`/`authorization=` 赋值与 URL userinfo 改写为 `***` 的兜底
- 边界：渲染纯函数在 `src/reproductionSummary.ts`；采集只读现有面（引擎数据库配置、活动 profile、扫描根、诊断调度器、语言服务台账）与自身 package.json

## 协议工具链

### `kbengine.protocol.showStatus`

- 标题：`KBEngine: 显示协议工具链状态`
- 作用：探测本机协议工具链（PA-007）并在输出通道「KBEngine Protocol Tooling」给一份如实状态报告——tshark 版本、Wireshark GUI 版本（未装如实标未检出）、个人/全局插件目录、KBEngine Wireshark dissector 插件（PA-006）及其落盘版本线与宿主版本线的核对结果（匹配 / 不匹配（宿主不会加载）/ 未知三态）、kode-kbengine CLI 的路径与版本
- 行为：
  - 每步探测失败都收敛为「未检出」——不报错、不猜测
  - 报告恒带零 ABI 兜底提示：未装插件时 `kode-kbengine capture analyze` 可直接分析 pcap
  - 探测读 `kbengine.protocol.tsharkPath` / `kbengine.protocol.wiresharkPath` / `kbengine.protocol.cliPath`（CLI 空 = `target/{debug,release}` 自动发现，与 kode-server 同款）
  - 报告末尾带 Schema 状态段（PA-007 第四增量），读 `globalStorage/kbengine-schema.json`：已生成 → IR 版本、引擎基线、消息/实体规模、缺失实体（entities.xml 注册但 .def 缺失）与构建诊断原文逐条列出（SYNTAX-005 同规：坏输入保留为诊断，不冒充通过）；未生成 → 给 `kbengine.protocol.buildSchema` 提示；读取失败 → 带归因

### `kbengine.protocol.buildSchema`

- 标题：`KBEngine: 生成 KBEngine 协议 Schema`
- 作用：经 kode-kbengine CLI 从资产根构建协议 Schema（`schema build --project <assetsRoot> --out <globalStorage>/kbengine-schema.json`）——与自动重建面同一建图计划（PA-007 第二增量）
- 行为：
  - 资产根解析复用 `kbengine.assetsRoot` 与既有发现链；CLI 解析复用 `kbengine.protocol.cliPath` + 自动发现；任一环落空给如实警告并带归因（CLI 未检出 / CLI 探测失败 / 资产根未检出）——不猜测
  - 成功以通知给出输出文件路径并落通道「KBEngine Protocol Tooling」；失败以通知带 CLI 自身错误文本（stderr 优先，回落 stdout，再回落退出码）
  - 自动重建面（默认开，`kbengine.protocol.schemaAutoBuild`）在项目根内的协议定义文件事件（`.def` / `types.xml` / `entities.xml` / `alias.xml`）触发，经共享合并器防抖 + 在途串行器合并（只补一轮尾随重建，不排队放大）；Python 文件结构性不在监听范围；激活不主动起子进程——首次生成发生在首个协议文件事件或本命令

### `kbengine.protocol.openPcap`

- 标题：`KBEngine: 在 Wireshark 中打开 PCAP`
- 作用：一键用 Wireshark GUI 打开抓包文件——选文件（`pcap` / `pcapng` / `cap`）后以配置的 `kbengine.protocol.wiresharkPath` 拉起 GUI（PA-007 第三增量）
- 行为：
  - 对话框取消 = 什么都不做（不起进程不出通知）
  - Wireshark 未检出/启动失败如实警告并带配置键提示；GUI 正常打开本身就是成功反馈（不刷通知）
  - 启动记录落「KBEngine Protocol Tooling」通道；GUI 拉起不带超时（检测面 5s 超时会杀掉刚拉起的 GUI——本面自带 runner）

### `kbengine.protocol.analyzePcap`

- 标题：`KBEngine: 用 kode-kbengine 分析 PCAP`
- 作用：跑零 ABI 分析路径——`kode-kbengine capture analyze --pcap <file> --tshark <tsharkPath>`（CLI 驱动 tshark；不需要 KBEngine 插件）并把报告原文落「KBEngine Protocol Tooling」通道
- 行为：
  - 对话框取消不做任何事；CLI 未检出/探测失败如实警告并带归因（与 `buildSchema` 同口径）
  - 分析失败以通知带 CLI 自身错误文本（stderr → stdout → 退出码）；报告原样渲染——不摘要、不再排版
  - 本面带长超时（120s）——大 pcap + tshark 两跳不适用检测面 5s 预算
