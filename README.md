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
- ✅ 13 个常用代码模板
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
npm install

# 编译
npm run compile

# 打包
npm run package

# 安装
code --install-extension kode-0.0.1.vsix
```

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
npm install

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
│   └── extension.ts              # 主入口文件
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
npm test

# 编译
npm run compile

# 监听模式编译
npm run watch
```

## 📖 使用文档

详细的使用文档和开发指南，请查看：

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
