# 功能概览

## 语言能力

- `.def` 语法高亮
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
