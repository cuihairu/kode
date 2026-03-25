# Kode - KBEngine Development Environment

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS_Code-1.60.0+-blue.svg)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.x-blue.svg)](https://www.typescriptlang.org/)

> **Kode** (KBEngine IDE) - 完整的 KBEngine 游戏服务器开发环境支持

## 📖 简介

**Kode** 是一个为 [KBEngine](https://github.com/kbengine/kbengine) 游戏服务器框架提供完整语言支持的 VSCode 扩展。

KBEngine 是一个开源的 MMO 游戏服务器框架，采用独特的分布式架构。Kode 为 KBEngine 的实体定义（`.def`）文件提供专业的开发工具支持。

## ✨ 核心功能

### 🎨 语法高亮
- ✅ 完整的 `.def` 文件语法高亮
- ✅ 16 种基础类型支持
- ✅ 容器类型（ARRAY, FIXED_DICT, TUPLE）高亮
- ✅ 8 种 Flags 标志高亮

### 💡 智能提示 (IntelliSense)
- ✅ 类型自动补全
- ✅ Flags 智能提示
- ✅ DetailLevel 提示
- ✅ XML 标签提示
- ✅ **钩子方法自动补全 (30+ hooks)**

### 📝 代码片段
- ✅ 17 个常用代码模板
- ✅ 一键插入属性定义
- ✅ 快速生成方法定义

### 📚 悬停文档
- ✅ 类型详细说明
- ✅ Flags 用途解释
- ✅ 使用建议
- ✅ **钩子完整文档** (调用时机、函数签名、使用示例、源码位置)

### 🔍 跳转定义
- ✅ 从 `entities.xml` 跳转到 `.def` 文件
- ✅ 快速定位实体定义

### ✅ 语法检查
- ✅ 实时语法验证
- ✅ Flags 组合冲突检测
- ✅ 类型有效性检查

### 🌲 实体浏览器
- ✅ 侧边栏显示所有实体
- ✅ 实体类型标识（Cell/Base/Client）
- ✅ 快速导航

### 🔗 钩子系统 (Hooks System)
- ✅ 30+ KBEngine 钩子支持
- ✅ 12 个分类：生命周期、网络、数据库、移动、空间、视野、位置、传送、陷阱、Cell、脚本、系统
- ✅ 完整的钩子文档和使用示例
- ✅ 源码位置标注

### 🔥 热更新支持
- ✅ 热更新代码片段（4个）
- ✅ KBEngine.reloadEntityDef() 智能提示
- ✅ KBEngine.isReload() 状态检查
- ✅ importlib.reload() Python 脚本热更新
- ✅ 完整的悬停文档和使用示例

### 🖥️ 服务器管理
- ✅ 9个组件启动/停止控制
- ✅ 实时状态显示（停止/启动中/运行中）
- ✅ 进程 PID 显示
- ✅ 组件独立日志输出
- ✅ 状态栏显示运行数量
- ✅ 支持自定义路径和环境变量

### 📊 日志查看集成
- ✅ 实时日志收集（连接到 logger.exe）
- ✅ WebView 可视化界面
- ✅ 多级过滤（级别、组件、关键词）
- ✅ 正则表达式搜索
- ✅ 日志导出（txt/log/json 格式）
- ✅ 彩色日志级别显示

### 🐛 Python 调试支持
- ✅ 自定义调试配置（.kbengine/debug.json）
- ✅ 组件特定调试设置
- ✅ 自动生成 launch.json
- ✅ 支持启动调试和附加到进程
- ✅ 路径映射和环境变量配置

### 📈 监控面板
- ✅ 实时性能数据收集
- ✅ CPU、内存、网络、实体数量监控
- ✅ 系统概览卡片
- ✅ 组件详细指标卡片
- ✅ 可视化图表（柱状图、曲线图）
- ✅ 数据导出（JSON 格式）

### 🔗 Python ↔ Def 双向跳转
- ✅ 实体定义映射管理器
- ✅ 从生成的 Python 文件跳转回 .def 定义
- ✅ Python 文件智能提示（自动补全属性和方法）
- ✅ 自动扫描和建立映射关系
- ✅ 支持多个 Python 生成路径配置

### 📊 实体依赖关系图
- ✅ 自动分析实体继承关系
- ✅ 可视化实体依赖图（使用 Mermaid.js）
- ✅ 显示 Base/Cell/Client 实体类型
- ✅ 统计信息面板（实体数量、最大深度、最常引用实体）
- ✅ 从图跳转到实体定义文件
- ✅ 支持导出图表（PNG/SVG 格式）

### 🛠️ 代码生成器
- ✅ 实体创建向导（逐步引导）
- ✅ 5 个预定义模板（账号、角色、NPC、物品、空实体）
- ✅ 自动生成 .def 文件（符合 KBEngine 格式）
- ✅ 自动生成 Python 文件（包含钩子方法）
- ✅ 自动在 entities.xml 中注册实体
- ✅ 支持自定义属性和方法定义
- ✅ 可配置输出路径和选项

## 🚀 安装

### 从 VSCode Marketplace 安装

```bash
code --install-extension cuihairu.kode
```

或在 VSCode 中搜索 `Kode - KBEngine Development Environment`

### 手动安装

```bash
# 克隆仓库
git clone https://github.com/cuihairu/kode.git

# 安装依赖
cd kode
pnpm install

# 编译
pnpm run compile

# 打包
pnpm run package

# 安装
code --install-extension kode-0.1.0.vsix
```

## 📘 文档

- 配置与使用文档位于 [docs/](./docs/)
- 配置说明重点见 [docs/guide/configuration.md](./docs/guide/configuration.md)
- 本项目已添加 VuePress 文档骨架，可通过 `pnpm run docs:dev` 本地预览

## 🔖 版本策略

当前阶段默认沿用 `0.1.x` 作为修复与完善版本线。

- 修复问题、补充文档、增强现有功能：继续使用 `0.1.x`
- 只有在出现明确的新阶段功能升级时，才考虑提升到 `0.2.0`

## 📸 截图

### 语法高亮和智能提示
```
正在添加...
```

### 实体浏览器
```
正在添加...
```

## 🛠️ 开发

### 环境要求

- Node.js 14.x 或更高版本
- Git
- VSCode 1.60.0 或更高版本

### 开发步骤

```bash
# 1. 克隆仓库
git clone git@github.com:cuihairu/kode.git

# 2. 安装依赖
cd kode
pnpm install

# 3. 在 VSCode 中打开项目
code .

# 4. 按 F5 启动调试
# 会打开一个新的 VSCode 窗口（扩展开发主机）

# 5. 在新窗口中测试功能
```

### 项目结构

```
kode/
├── src/
│   ├── extension.ts              # 主入口文件
│   ├── languageProviders.ts      # 语言能力
│   ├── explorerProviders.ts      # 树视图与导航
│   ├── kbengineMetadata.ts       # KBEngine 元数据
│   └── ...
├── syntaxes/
│   └── kbengine.tmLanguage.json  # 语法高亮规则
├── snippets/
│   └── kbengine.json             # 代码片段
├── resources/
│   └── docs/                     # 项目文档
├── .vscode/
│   └── launch.json               # 调试配置
├── package.json                  # 扩展配置
├── tsconfig.json                 # TypeScript 配置
└── README.md                     # 本文件
```

### 测试

```bash
# 运行测试
pnpm test

# 编译
pnpm run compile

# 监听模式编译
pnpm run watch

# 文档
pnpm run docs:dev
```

## 📖 使用文档

详细的使用文档和开发指南，请查看：

- [VuePress 文档](./docs/README.md) - 新版文档入口
- [设计文档](./resources/docs/vscode-extension-design.md) - 完整的设计方案
- [快速开始](./resources/docs/vscode-extension-summary.md) - 开发者指南
- [命名方案](./resources/docs/plugin-name-suggestions.md) - 品牌设计

## 🤝 贡献

欢迎贡献代码！请查看 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解详情。

### 贡献指南

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 📝 许可证

本项目采用 Apache-2.0 许可证 - 详见 [LICENSE](LICENSE) 文件

## 🙏 致谢

- [KBEngine](https://github.com/kbengine/kbengine) - 优秀的游戏服务器框架
- [VS Code](https://github.com/microsoft/vscode) - 强大的代码编辑器
- 所有贡献者

## 📞 联系方式

- GitHub Issues: [https://github.com/cuihairu/kode/issues](https://github.com/cuihairu/kode/issues)
- Email: cuihairu@gmail.com

## 🌟 Star History

如果这个项目对你有帮助，请给一个 Star ⭐

---

**Kode** - 让 KBEngine 开发更高效！ 🚀
