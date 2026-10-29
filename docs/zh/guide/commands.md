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
- 入口：
  - 命令面板
- 详见：[数据库漂移校验](database-drift-check.md)

### `kbengine.database.checkAllDrift`

- 标题：`Check All Database Drift`
- 作用：检查所有工作区实体的真实 MySQL 表结构，一次连接并将全部实体表合并判断残留表
- 前置条件：同 `kbengine.database.checkDrift`
- 超时/取消：与 `kbengine.database.checkDrift` 同一时限与进度通知取消（逐建连/逐查询），共用一条守卫连接
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

### `kbengine.debug.updateLaunchJson`

- 标题：`Update launch.json`
- 作用：根据 `.kbengine/debug.json` 的 `pathMappings` 生成或更新 VSCode 的 PID attach 配置；已配置 `kbengine.debug.remoteTargets` 时，同时把远程目标以 debugpy `connect` 形式追加进去

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
- 作用：打开「最终生效配置」只读视图——按引擎装载规则合成：先载引擎默认 `kbengine_defaults.xml`（经 `kbengine.binPath` 推导），再以元件 `kbengine.xml`（`kbengine.assetsRoot` 下优先，其次约定路径 `kbengine.xml`/`res/server/kbengine.xml`/`assets/res/server/kbengine.xml`）同键覆盖（子键按名对齐）
- 行为：
  - 合成文件不落盘，虚拟文档 `kbengine-final.xml`，字段可悬浮看作用说明
  - 文档头注标明 defaults 与元件配置的来源路径
  - 定位不到 defaults 时明示报错；默认（`kbengine.showFinalConfigOnOpen`，可用 `kbengine.autoRefreshFinalConfig` 关联动）激活后自动在后台打开
  - telnet 端口/密码等服务参数与该合成口径同源读取

### `kbengine.python.debugpySync`

- 标题：`Copy System debugpy into Assets`
- 作用：`kbengine.debug.autoDebugpy` 的一次性接线——把系统 pip 的 `debugpy` 包复制到 `<assets>/scripts/common/debugpy`，让引擎组件里 `import debugpy` 可解析（该目录在引擎模块搜索路径第一位，`python_app.cpp:167`；`site_import=0` 不影响）
- 入口：命令面板 `Copy System debugpy into Assets`
- 行为：
  - 按序探测取包解释器：所选解释器（`kbengine.python.interpreterPath` → PATH 链，与调试预检同一条链）→ `python3` → `python`，以 `-c "import debugpy"` 定位；未安装/目录不可读时如实报告，零复制
  - 版本闸：引擎内嵌 Python 为 3.12.13，debugpy 自 1.8.0 起支持 3.12——更老的系统版本说明原因后拒绝（`pip install -U debugpy`），绝不盲复制
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
  - 监听：报告 debugpy 端口并指向 launch.json 里对应的 attach 配置
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

## 代码生成器

### `kbengine.generator.wizard`

- 标题：`Create Entity from Wizard`
- 作用：通过向导逐步创建实体

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

## 性能分析

### `kbengine.def.analyze`

- 标题：`Analyze Def Performance`
- 作用：对工作区全部 `.def` 文件做静态检查并输出优化建议
- 输出：
  - 报告写入「KBEngine Def 分析」输出面板
  - 诊断落入问题列表（`kbengine-def-analysis`）

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

### `kbengine.hotReload.showLog`

- 标题：`Show Hot Reload Log`
- 作用：打开「KBEngine 热更」OUTPUT 通道——热更状态栏项(HR-UI-001)背后的审计日志
- 行为：
  - 状态栏项 `$(eye…) 热更: …` 即监视状态机:关(`kbengine.hotReload.enabled=false` 或 globs 为空)→ 就绪(watcher 建好)→ 发送中(去抖到点、动作已触发)→ 已发送(未确认)→ 失败;点击状态栏项即执行本命令
  - 诚实口径:动作完成且无错只记「已发送(未确认)」——不校验业务回执,界面绝不声称模块已生效(回执校验属 HR-STATE 系列,另立项)
  - 每次触发记 time/触发文件(去抖合并到的)/去抖值,外加结果行(已发送未确认/失败/未配动作名跳过);日志行即时落账,不随状态栏节流合并
  - 不进命令面板(`when: false`)——状态栏项才是正入口

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

### `kbengine.python.serviceStatus`

- 标题：`Check Python Language Service Status`
- 用途：报告 Python 语言服务（`ms-python.vscode-pylance`）是否可用，三态之一：已激活／未启用（已安装但当前窗口未激活——被禁用或未参与本窗口）／未安装（既未注册也无磁盘证据）
- 判定输入：`vscode.extensions.all` 注册、其 `isActive` 标记、本地用户扩展目录下的 `<id>-<version>` 安装目录（被禁用的扩展不进 `extensions.all`，磁盘探测是兜底证据）
- 诚实口径：`python.analysis.extraPaths` 是否写入永不参与可用判定；有值时消息附明确警示「extraPaths 已写入不等于语言服务可用」

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
- 作用：把工作区发现的 KBEngine scripts 根写入 `python.analysis.extraPaths`（WorkspaceFolder 级），让 Python 扩展（Pylance/pyright）能解析实体脚本里的 `import KBEngine`、`import common.*`
- 入口：命令面板 `Sync Python Extra Paths`；扩展激活时也会自动同步一次（`kbengine.python.extraPathsSync` 默认开，激活期全程静默零提示）
- 行为：
  - scripts 根候选与实体索引同口径：`<工作区>/scripts`、`<工作区>/assets/scripts`、`<工作区>/server_assets/scripts`、一级 `<xxx>_assets/scripts`（批129 资产根约定）；只收磁盘上真实存在的
  - `.kbengine/stubs`（存根导出目录）在 `kbengine.python.stubExport` 开且 `KBEngine.pyi` 在盘时一并并入管理段；`kbengine.python.stubDir` 配置的用户目录不并入管理段
  - 经带资源域的 `getConfiguration('python', folder).update(...)` 写入（WorkspaceFolder 级），settings.json 里的注释由宿主保全；只在发现结果与现值不同时写，无变化不碰文件
  - 只管理本扩展写入的那一段：上次写入的集合记在 workspaceState，再同步时先剔除再写新集合，用户手填的路径永不被动
  - 设置 `kbengine.python.extraPathsSync: false` 可整体关闭（关闭后命令只说明不写）；手动重跑会播报写入结果，激活期自动同步不打扰

### `kbengine.python.exportStubs`

- 标题：`Export KBEngine Python Stubs`
- 作用：把内置 KBEngine Python API 符号索引（与 kode 的补全/悬停/跳转同源）导出为真实 `.pyi` 文件，配合 extraPaths 接线让 Pylance 解析 `import KBEngine`（虚拟桩文档 Python 扩展看不见）
- 覆盖口径：`KBEngine.pyi` 是精选引擎符号子集，不是完整引擎 API；页头逐批声明覆盖状态，每个符号保留引擎 typings 的原始 `file:line` 锚点
- 存根目录三级解析（批142）：`kbengine.python.stubDir` 设置 > 环境变量 `KBENGINE_STUB_DIR` > 默认约定 `<工作区>/.kbengine/stubs`；支持 `${workspaceFolder}`/`${env:NAME}` 等 VS Code 变量
- 入口：命令面板 `Export KBEngine Python Stubs`；扩展激活时也会自动导出一次（`kbengine.python.stubExport` 默认开，激活期全程静默）
- 行为：
  - 默认约定目录归 kode 自管：内容与磁盘一致时零写；内容陈旧（索引更新后）自动重写覆盖，手改不保留
  - 配置的用户目录只进不出：目录里已有任何 `.pyi` 一律按用户资产不覆盖，没有 `.pyi` 才生成；目录读不到（不存在/无权限）如实提示，不盲写
  - 建议在 `.gitignore` 里忽略 `.kbengine/stubs/`（生成物，随 kode 索引更新）；用户自配目录的既有 `.pyi` 属于用户资产，kode 不改不删
  - 目录不可写（只读挂载等）时告警并继续其余工作区文件夹
  - 导出成功后链一次 extraPaths 同步，新存根目录即刻生效
  - 设置 `kbengine.python.stubExport: false` 可整体关闭

### `kbengine.python.exportTypeStubs`

- 标题：`Export KBEngine Python Type Stubs`
- 作用：把 `entity_defs/types.xml` 里的自定义类型（utype）导出成 Python 类型桩模块 `kbe_types.py`——`FIXED_DICT` → `TypedDict` 类、`ARRAY` → `List[元素]`、别名 → 目标类型名，配合 extraPaths 接线让实体脚本与工具脚本获得 `import kbe_types` 的真实类型来源（立项分析见 [def-pyi-stubs 可行性](../design/def-pyi-stubs.md)）
- 选择真 `.py` 而非 `.pyi`：纯 `.pyi` 没有运行时形态，Python 侧 `import kbe_types` 拿不到值；真模块既能当 Pylance 的类型来源也能被运行时导入
- 引用关系与来源：`FIXED_DICT` 属性可引用其他自定义类型（如 `PLAYER_ID`），生成器保留名字引用且逐类/逐属性写入 `# source: types.xml:<line>`；禁止用生成行号反推原始行号
- 实体级类型：`.def` 属性引用 `types.xml` 自定义类型时，激活期同时生成 `entity_types.pyi`，逐实体落成 `Avatar.profile: ITEM_INFO` 这类声明；来源注释保留 `.def` 与 `types.xml` 双原始行
- 目录与开关与 `kbengine.python.exportStubs` 同一套：`kbengine.python.stubDir` 三级解析、共用 `kbengine.python.stubExport` 开关；扩展激活时在 KBEngine.pyi 之后自动导出一次（静默）
- 行为：
  - 内容确定：同输入生成逐字节一致的内容（头部无时间戳），与 KBEngine.pyi 同一套「内容一致零写、陈旧重写」纪律
  - 别名赋值是模块级急切求值，按依赖拓扑排序发射；`types.xml` 指引为空或别名成环的类型跳过并在提示里说明原因，绝不生成引用未定义名字的赋值
  - 内置类型映射与 TS 生成器同表：整型 → `int`、浮点 → `float`、字符串 → `str`、向量 → 定长 `Tuple`、`PY_DICT/PY_TUPLE/PY_LIST` → typing 泛型、无对应物 → `Any`（有损但合法）
  - 配置的用户目录里已有同名 `kbe_types.py` 按用户资产不覆盖；默认目录 `.kbengine/stubs` 归 kode 自管
  - 工作区没有自定义类型时不生成文件、不提示打扰；导出成功后链一次 extraPaths 同步
- `types.xml` 落盘即自动重生成：保存/新建/删除后由 watcher 静默重导出（不设去抖、不加开关——零写纪律保证重复触发无副作用；`kbengine.python.stubExport` 关掉时实际停摆）
- 设置 `kbengine.python.stubExport: false` 可整体关闭（与 KBEngine.pyi 存根共用开关）

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
