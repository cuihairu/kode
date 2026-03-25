# 开发与发布

本页面向维护者，说明如何本地开发、调试、构建文档和控制版本策略。

## 环境要求

- Node.js 20.x 或更高版本
- pnpm 8.x
- VSCode 1.60.0 或更高版本

## 本地开发

```bash
pnpm install
pnpm run watch
code .
```

然后在 VSCode 中按 `F5` 启动扩展开发主机。

## 常用脚本

```bash
pnpm run compile
pnpm run watch
pnpm run lint
pnpm test
pnpm run docs:dev
pnpm run docs:build
pnpm run package
```

## 文档开发

VuePress 文档入口在 `docs/`。

### 本地预览

```bash
pnpm run docs:dev
```

### 构建静态站点

```bash
pnpm run docs:build
```

## 发布前检查

建议至少检查以下项目：

1. `README.md`、`docs/`、`CHANGELOG.md` 是否同步
2. `package.json` 中的命令、配置项、版本号是否正确
3. `.def` 语言能力是否与文档描述一致
4. 依赖图、实体浏览器、日志、调试等入口是否可打开

## 版本策略

当前项目仍处于 `0.1.x` 修复与完善阶段。

### 什么时候继续使用 `0.1.x`

以下变更默认属于补丁版本：

- 修复 bug
- 优化文档
- 完善已有功能
- 增加配置项但不改变已有默认行为
- 改进 hover、诊断、高亮、导航体验

### 什么时候考虑 `0.2.0`

只有在出现明显阶段升级时再考虑，例如：

- 引入大型新模块
- 大范围调整默认行为
- 引入需要迁移的配置变化
- 对外能力边界明显变化

## 推荐的发布节奏

### 日常修复

- 版本号：`0.1.x`
- 更新 `CHANGELOG.md`
- 提交后推送到 `main`

### 阶段发布

1. 汇总文档与功能变更
2. 确认截图、说明、版本号
3. 执行 `pnpm run package`
4. 再决定是否发布到 Marketplace

## 当前文档维护原则

- `README.md` 负责仓库首页概览
- `docs/` 负责长期维护的结构化文档
- `CHANGELOG.md` 负责版本变更记录
- `resources/docs/` 里的设计文档保留为设计沉淀，不再当作唯一使用文档
