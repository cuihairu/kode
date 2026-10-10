# 功能概览

## 语言能力

- `.def` 语法高亮（内建 XML 语法委托 + 引擎语义着色）
- 类型、Flags、DetailLevel 智能提示
- 标签、值、自定义符号 Hover
- `entities.xml` 与 `.def` 跳转
- `.def` 内实体引用跳转
- Python 与 `.def` 双向导航
- `.def` 属性/方法 F2 重命名（同文件声明 + 后代 def 复述，见语言能力页边界说明）

## 诊断能力

- 未知类型检查
- 未知 Flags 检查
- 未知 DetailLevel 检查
- 重复定义检查
- 缺失 `Type` / `Flags` 检查

## 工具面板

- 实体浏览器
- 服务器控制面板
- 日志查看器
- 监控面板
- 实体依赖关系图

说明：
日志查看器当前尚未完成官方 logger watcher 协议适配。
监控面板在 watcher 无响应时只保留 machine 返回的基础状态。

## Telnet 探测与会话联动

- 配置显式开启 telnet（设置显式端口，或 kbengine.xml 有 `<telnet_service>` 段）才展示 telnet 相关内容；两处都没配时不探测、不展示，状态灯、独立树视图与面板命令入口全部隐藏。引擎 defaults 里虽有 `<telnet_service>` 段，但 defaults 只供数值回落，不单独把 telnet 打开
- 状态栏与服务器控制面板状态灯：已连接 / 已开启·未配密码 / 密码被拒 / 未开启 / 未配置
- 目标解析链：kode 设置（`kbengine.telnet.host/port/password`）→ 元件 `kbengine.xml` 的 `<telnet_service>` 段（`kbengine.telnet.configXmlPath` 指定，未指定时 `kbengine.configPath/kbengine.xml` 优先，再按约定路径探测工作区根：`kbengine.xml`、`res/server/kbengine.xml`、`assets/res/server/kbengine.xml`）→ 引擎 `kbengine_defaults.xml`（经 `kbengine.binPath` 推导）。端口与密码都按这个顺序取第一个非空值；`.kbengine/debug.json` 不参与 telnet 探测
- 探测默认 5 秒一轮，单端口 1.5 秒超时，探完即毁不占连接
- 端口开启时自动握手登录；密码只经 socket 提交，不进日志
- 面板命令输入走白名单加内置只读快捷命令，`:quit` 恒被拒绝
- 断线状态翻转可重连，掉线不崩面板

## 调试支持

- 调试配置只读工作区 `.kbengine/debug.json`：`telnetHost`/`telnetPort`/`telnetEnableCommands` 仅服务 `Start Debugging` 的提示语，`pathMappings` 用于生成 launch.json；telnet 探测/面板/状态灯走上面的三层链，不读这个文件
- 生成的启动配置是 `debugpy` 的 attach 形态；本地附加由扩展列出本机进程（匹配组件名的置顶标 ✓），选中即以 PID 组装配置，不再手输 PID
- 远程附加（`kbengine.debug.attachRemote`）的目标来自设置 `kbengine.debug.remoteTargets`，以 debugpy `connect` 模式直连远端 debugpy 监听端口
- 调试模型：先经 telnet 向组件输入开启调试命令，再附加目标进程

说明：
KBEngine 组件是 C++ 进程内嵌 Python 运行时，调试走 attach，不存在「扩展直接启动 Python 脚本」的形态。

## 最终配置视图

- 按引擎装载规则合成最终生效配置：先载引擎默认 `kbengine_defaults.xml`，再以元件 `kbengine.xml` 同键覆盖（子键按名对齐），只读虚拟文档 `kbengine-final.xml`，不落盘
- 三个入口：侧栏 Config 视图的「最终配置」节点、命令面板 `Show Final Server Config`、激活后自动后台打开（`kbengine.showFinalConfigOnOpen`，默认开）
- defaults 或元件 `kbengine.xml` 保存后自动重算（`kbengine.autoRefreshFinalConfig`，默认开）；字段悬浮可看作用说明
- 分层口径与前后对照见 [配置说明](./configuration.md) 的「服务端配置的三层」

## HTTP 快捷请求

- 设置 `kbengine.httpRequests` 列表：名称 / URL 模板 / method / 请求头 / 请求体 / 启停 / 键位展示串
- 模板变量 `${module}` / `${file}` / `${line}` / `${sel}`，按字面替换、不做 URL 编码；`${module}` 取工作区相对模块路径（`entities/fight/FightAI.py` → `entities.fight.FightAI`）
- 触发两路：命令面板 quick pick；经 keybindings.json 为 `kbengine.httpRequest.run` 配 `args.name` 键位直发
- 执行流水进 OUTPUT 面板「KBEngine HTTP 快捷请求」；失败以 `✗` 标记加错误弹窗呈现

字段与变量表见 [配置说明](./configuration.md)，命令细节见 [命令与面板](./commands.md)。

## 依赖图能力

- Mermaid 可视化
- 继承与 `ENTITYCALL` 关系展示
- 图中跳转到实体定义
- 导出 SVG
- 导出 PNG

## 代码生成

- 实体创建向导
- 预置模板（10 个：账号、角色、NPC、物品、怪物、场景、公会、队伍、邮件、空实体）
- 自动生成 `.def`
- 自动生成 Python
- 自动注册到 `entities.xml`

说明：
生成器会受 `kbengine.generator.*` 和 `kbengine.entitiesXmlPath` 配置影响。

## 性能分析

- 工作区全量 `.def` 静态检查（`Analyze Def Performance` 命令）
- 优化建议写入输出面板，并以诊断落入问题列表

## 代码片段生成

- 选区生成自定义片段（`Generate Snippet from Selection` 命令）
- 片段语法转义并剥离公共缩进，合并写入 `.vscode/kbengine-custom.code-snippets`
