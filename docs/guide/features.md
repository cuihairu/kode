# 功能概览

## 语言能力

- `.def` 语法高亮
- 类型、Flags、DetailLevel 智能提示
- 标签、值、自定义符号 Hover
- `entities.xml` 与 `.def` 跳转
- `.def` 内实体引用跳转
- Python 与 `.def` 双向导航

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
- 预置模板
- 自动生成 `.def`
- 自动生成 Python
- 自动注册到 `entities.xml`

说明：
生成器会受 `kbengine.generator.*` 和 `kbengine.entitiesXmlPath` 配置影响。
