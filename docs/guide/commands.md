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
- 作用：打开实体属性对应的数据库表结构虚拟文档
- 入口：
  - 点击实体浏览器中的数据库条目
  - 命令面板

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

## 调试相关

### `kbengine.debug.updateLaunchJson`

- 标题：`Update launch.json`
- 作用：根据 `.kbengine/debug.json` 的 `pathMappings` 生成或更新 VSCode 的 PID attach 配置；已配置 `kbengine.debug.remoteTargets` 时，同时把远程目标以 debugpy `connect` 形式追加进去

### `kbengine.debug.createConfig`

- 标题：`Create Debug Config Template`
- 作用：创建示例调试配置文件 `.kbengine/debug.json`

### `kbengine.debug.start`

- 标题：`Start Debugging`
- 作用：显示目标组件的 telnet 调试提示，然后进入进程选择器 attach 流程

### `kbengine.debug.attach`

- 标题：`Attach to Component`
- 作用：列出本机进程供选择，附加到已开启调试的 KBEngine 组件进程
- 行为：
  - 匹配目标组件名的进程置顶并标 ✓，其余按系统进程清单原序排列
  - 选中后以该进程 PID 直接组装 debugpy attach 配置，不再手输 PID
  - 获取不到进程列表时明示报错，不空转

### `kbengine.debug.attachRemote`

- 标题：`Attach to Remote Component`
- 作用：附加到远程机器上已开启调试的 KBEngine 组件进程（debugpy `connect` 模式，直连远端 debugpy 监听端口）
- 前提：在设置 `kbengine.debug.remoteTargets` 里配置目标列表（名称 + IP + debugpy 端口，端口缺省 5678）；远端组件需先经 telnet 发开启调试命令并起好 debugpy 监听
- 行为：
  - 未配置目标时提示去设置，不空转
  - 弹出目标选择，模态确认后以 `connect: {host, port}` 组装附加配置，不写 `pathMappings`

## 配置相关

### `kbengine.config.showFinal`

- 标题：`Show Final Server Config`
- 作用：打开「最终生效配置」只读视图——按引擎装载规则合成：先载引擎默认 `kbengine_defaults.xml`（经 `kbengine.binPath` 推导），再以元件 `kbengine.xml`（`kbengine.configPath` 下优先，其次约定路径 `kbengine.xml`/`res/server/kbengine.xml`/`assets/res/server/kbengine.xml`）同键覆盖（子键按名对齐）
- 行为：
  - 合成文件不落盘，虚拟文档 `kbengine-final.xml`，字段可悬浮看作用说明
  - 文档头注标明 defaults 与元件配置的来源路径
  - 定位不到 defaults 时明示报错；默认（`kbengine.showFinalConfigOnOpen`，可用 `kbengine.autoRefreshFinalConfig` 关联动）激活后自动在后台打开
  - telnet 端口/密码等服务参数与该合成口径同源读取

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

## 代码生成器

### `kbengine.generator.wizard`

- 标题：`Create Entity from Wizard`
- 作用：通过向导逐步创建实体

### `kbengine.generator.templates`

- 标题：`Create Entity from Template`
- 作用：从预定义模板快速生成实体（账号、角色、NPC、物品、怪物、场景、公会、队伍、邮件、空实体共 10 个）

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
  - 同名片段条目覆盖并给出警告
  - 片段文件被手改出注释/坏 JSON 时拒绝改写并提示
  - 片段文件读/写 IO 失败（权限、路径被目录/文件占位等）时报错并带文件路径，不裸抛命令错误

### `kbengine.telnet.showPanel`

- 标题：`Show Telnet Panel`
- 作用：打开 telnet 控制面板（探测状态灯 + 命令会话）
- 目标解析链：kode 设置（`kbengine.telnet.host/port/password`）→ 元件 `kbengine.xml` 的 `<telnet_service>` 段（`kbengine.telnet.configXmlPath` 指定，未指定时按 `kbengine.configPath` 与约定路径探测）→ 引擎 `kbengine_defaults.xml`（经 `kbengine.binPath` 推导）；`.kbengine/debug.json` 不参与 telnet 探测
- 行为：
  - 面板按目标列出状态灯：未配置 / 未开启 / 已开启（未接会话）/ 端口开·未配密码 / 密码被拒 / 已连接
  - 已开启目标可建立持久会话（自动握手登录），提供白名单内命令输入、内置只读快捷命令与输出回显
  - 未开启目标如实提示开启方法（附 kbengine.xml `<telnet_service>` 配置片段），不空转
  - 运行中断线自动拆除会话并翻转状态灯，面板保留可重连

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

配置了 `kbengine.debug.remoteTargets` 时，`Update launch.json` 会把每个远程目标以 debugpy `connect` 形式追加为独立配置（`connect: {host, port}`，不写 `pathMappings`）。

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
