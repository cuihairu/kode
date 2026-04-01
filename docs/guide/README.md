# 快速开始

## 安装依赖

```bash
pnpm install
```

## 启动扩展开发

```bash
pnpm run watch
code .
```

然后在 VSCode 中按 `F5` 启动 Extension Development Host。

## 文档站点

本项目使用 VitePress 生成文档站点。

```bash
pnpm run docs:dev
```

构建产物：

```bash
pnpm run docs:build
```

## 版本策略

当前阶段使用 `0.1.x` 作为持续修复版本线。

- `0.1.x`
  - 用于修复问题、补充文档、增强现有功能、完善交互
- `0.2.0`
  - 只在出现明确的功能级升级或兼容性边界变化时再考虑

如果你正在参与发布或维护，默认不要因为“继续完善”就直接升级到 `0.2.0`。

## 推荐的 KBEngine 项目结构

```text
your-project/
├── scripts/
│   ├── entities.xml
│   ├── entity_defs/
│   │   ├── Avatar.def
│   │   └── Account.def
│   └── base/
├── server/
└── kbengine/
```

## 扩展能力概览

- `.def` 语法高亮、Hover、诊断、跳转
- Python 与 `.def` 双向导航
- 实体浏览器与服务器控制面板
- 日志查看、监控面板、依赖图
- 实体代码生成器

补充：
日志查看和监控面板都依赖 KBEngine 运行态协议。
如果 logger/watcher 响应异常，这两块会退化成部分能力可用，而不是完整遥测。

详细能力见 [功能概览](./features.md)。

## 下一步阅读建议

- 想调行为和路径：看 [配置说明](./configuration.md)
- 想知道命令入口和面板用途：看 [命令与面板](./commands.md)
- 想了解 `.def` 的语言能力：看 [语言能力](./language.md)
- 想看日志、依赖图和生成器：看 [日志查看](./logging.md)、[实体依赖图](./dependency-graph.md)、[代码生成器](./generator.md)
- 想参与维护和发布：看 [开发与发布](./development.md)
