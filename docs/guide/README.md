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

本项目使用 VuePress 生成文档站点。

```bash
pnpm run docs:dev
```

构建产物：

```bash
pnpm run docs:build
```

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

详细能力见 [功能概览](./features.md)。
