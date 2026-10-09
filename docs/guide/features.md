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

- 状态栏与服务器控制面板状态灯：已连接 / 已开启·未配密码 / 密码被拒 / 未开启 / 未配置
- 目标解析三级：设置项 → `kbengine.xml` 的 `<telnet_service>` 段 → 引擎七组件默认端口表
- 探测默认 5 秒一轮，单端口 1.5 秒超时，探完即毁不占连接
- 端口开启时自动握手登录；密码只经 socket 提交，不进日志
- 面板命令输入走白名单加内置只读快捷命令，`:quit` 恒被拒绝
- 断线状态翻转可重连，掉线不崩面板

## 调试支持

- 调试配置统一读取工作区 `.kbengine/debug.json`：telnet 地址/端口/开启命令，加 attach 用的 `pathMappings`
- 生成的启动配置是 `debugpy` 的 `processId` attach 形态
- 调试模型：先经 telnet 向组件输入开启调试命令，再按 PID 附加

说明：
KBEngine 组件是 C++ 进程内嵌 Python 运行时，调试走 attach，不存在「扩展直接启动 Python 脚本」的形态。

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
