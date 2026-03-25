# Contributing to Kode

感谢你有兴趣为 Kode 做贡献！🎉

## 📋 目录

- [行为准则](#行为准则)
- [如何贡献](#如何贡献)
- [开发流程](#开发流程)
- [代码规范](#代码规范)
- [提交规范](#提交规范)

## 🤝 行为准则

- 尊重所有贡献者
- 欢迎不同观点和经验
- 优雅地接受建设性批评
- 专注于对社区最有利的事情
- 对其他社区成员表示同理心

## 💡 如何贡献

### 报告 Bug

1. 检查 [Issues](https://github.com/cuihairu/kode/issues) 确保问题未被报告
2. 创建新 Issue，使用 Bug Report 模板
3. 提供详细的重现步骤、环境和截图

### 提出功能建议

1. 检查 [Issues](https://github.com/cuihairu/kode/issues) 确保建议未被提出
2. 创建 Feature Request Issue
3. 详细说明功能的使用场景和价值

### 提交代码

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 🔧 开发流程

### 环境设置

```bash
# 1. Fork 并克隆你的 fork
git clone https://github.com/YOUR_USERNAME/kode.git

# 2. 添加上游仓库
git remote add upstream https://github.com/cuihairu/kode.git

# 3. 安装依赖
pnpm install

# 4. 在 VSCode 中打开项目
code .
```

### 开发流程

```bash
# 1. 同步上游更改
git fetch upstream
git rebase upstream/master

# 2. 创建新分支
git checkout -b feature/your-feature-name

# 3. 进行开发
pnpm run watch  # 监听模式编译

# 4. 测试更改
# 按 F5 在 VSCode 中启动扩展开发主机

# 5. 提交更改
git add .
git commit -m "feat: add your feature"

# 6. 推送到你的 fork
git push origin feature/your-feature-name
```

## 📝 代码规范

### TypeScript 规范

- 使用 TypeScript 严格模式
- 遵循 ESLint 配置
- 添加适当的类型注解
- 编写有意义的变量和函数名

```typescript
// ✅ 好的例子
async function getEntityDefinition(entityName: string): Promise<EntityDef | null> {
  // ...
}

// ❌ 不好的例子
async function getDef(n: string) {
  // ...
}
```

### 文档规范

- 为公共 API 添加 JSDoc 注释
- 使用清晰的语言解释复杂逻辑
- 添加使用示例

```typescript
/**
 * 解析 KBEngine 实体定义文件
 * @param filePath - .def 文件的路径
 * @returns 实体定义对象，如果解析失败则返回 null
 * @throws {Error} 如果文件不存在或格式错误
 */
async function parseEntityDef(filePath: string): Promise<EntityDef | null> {
  // ...
}
```

### 测试规范

- 为新功能添加单元测试
- 确保测试覆盖核心逻辑
- 测试文件应与源文件同名

```
src/
  extension.ts
  extension.test.ts
  parser.ts
  parser.test.ts
```

## 📨 提交规范

我们使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

### 提交格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type 类型

- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式（不影响功能）
- `refactor`: 重构
- `perf`: 性能优化
- `test`: 测试相关
- `chore`: 构建/工具相关

### 示例

```bash
# 新功能
git commit -m "feat(completion): add support for FIXED_DICT type"

# Bug 修复
git commit -m "fix(parser): handle missing Default value correctly"

# 文档更新
git commit -m "docs(readme): update installation instructions"

# 重构
git commit -m "refactor(parser): extract XML parsing to separate module"
```

## 🎨 Pull Request 指南

### PR 标题

使用与提交消息相同的格式：

```
feat(completion): add support for FIXED_DICT type
```

### PR 描述

```markdown
## 变更类型
- [ ] Bug 修复
- [x] 新功能
- [ ] 破坏性变更
- [ ] 文档更新

## 描述
简要描述你的更改...

## 相关 Issue
Closes #123

## 测试
描述你如何测试这些更改...

## 截图
如果适用，添加截图...
```

### PR 审查清单

- [ ] 代码遵循项目的代码规范
- [ ] 已添加必要的文档
- [ ] 已添加或更新测试
- [ ] 所有测试通过
- [ ] 没有新的警告
- [ ] 提交消息遵循规范

## 📚 资源

- [VS Code 扩展 API](https://code.visualstudio.com/api)
- [TypeScript 文档](https://www.typescriptlang.org/docs/)
- [项目文档](./resources/docs/)

## 💬 获取帮助

如果你有任何问题：

- 查看 [文档](./resources/docs/)
- 查看 [Issues](https://github.com/cuihairu/kode/issues)
- 创建新 Issue 或 Discussion

---

再次感谢你的贡献！🙏
