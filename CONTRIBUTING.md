# Contributing to Kode

感谢你有兴趣为 Kode 做贡献。

## 目录

- [行为准则](#行为准则)
- [如何贡献](#如何贡献)
- [开发流程](#开发流程)
- [代码规范](#代码规范)
- [提交规范](#提交规范)

## 行为准则

- 尊重所有贡献者
- 欢迎不同观点和经验
- 优雅地接受建设性批评
- 专注于对社区最有利的事情
- 对其他社区成员表示同理心

## 如何贡献

### 报告 Bug

1. 检查 [Issues](https://github.com/cuihairu/kode/issues) 确保问题未被报告
2. 创建新 Issue，标题写清现象
3. 提供详细的重现步骤、环境和截图

### 提出功能建议

1. 检查 [Issues](https://github.com/cuihairu/kode/issues) 确保建议未被提出
2. 创建新 Issue，标题写清建议内容
3. 详细说明功能的使用场景和价值

### 提交代码

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 开发流程

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
git rebase upstream/main

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

## 代码规范

### TypeScript 规范

- 使用 TypeScript 严格模式
- 遵循 ESLint 配置
- 添加适当的类型注解
- 编写有意义的变量和函数名

```typescript
// 好的例子
async function getEntityDefinition(entityName: string): Promise<EntityDef | null> {
  // ...
}

// 不好的例子
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
- vitest 测试放 `tests/`，文件名与 `src/` 被测模块对应（如 `src/defParser.ts` → `tests/defParser.test.ts`）
- `src/test/suite/` 只保留编译产物烟测，不写业务断言

```
src/extension.ts
src/defParser.ts
tests/extension.test.ts
tests/defParser.test.ts
src/test/suite/   # mocha 编译产物烟测
```

分层与运行方式见 [TESTING.md](./TESTING.md)。

## 提交规范

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

## Pull Request 指南

### PR 标题

使用与提交消息相同的格式：

```
feat(completion): add support for FIXED_DICT type
```

### PR 描述

GitHub 上创建 PR 时会自动载入 `.github/PULL_REQUEST_TEMPLATE.md`（守卫测试
`tests/pullRequestTemplate.test.ts` 锁四字段齐全），字段如下：

```markdown
## 变更类型
- [ ] Bug 修复
- [ ] 新功能
- [ ] 破坏性变更
- [ ] 文档更新

## 描述
简要描述你的更改...

## 复现脚本
Bug 修复必须附最小复现（脚本/步骤/语料文件皆可）；无法构造复现时，
说明缺陷面与已排除的原因。

## 测试证据
贴测试命令与输出摘要（通过计数/关键断言）；合并前全量门禁必须绿。

## Profile/Perf delta
性能敏感改动附前后对比（bench 数字/profile 截图皆可）；不涉及性能时写「不涉及」。

## 回退计划
出问题如何回退（独立可 revert 的 commit/配置开关/数据面处理）；
写「直接 revert <hash>」亦可。

## 相关 Issue
Closes #123

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

## 发布规则

版本号只能由维护者手动给出，自动化只跟随，不自行发起正式发布：

- **正式 GitHub Release**：维护者手动推送版本号 tag（`v*`）后，`ci.yml` 跟随 tag
  自动创建 Release 并附 VSIX 资产；不给分支建 Release。
- **Marketplace / npm**：仅 `workflow_dispatch` 手动触发（`publish.yml` / `npm.yml`），
  请求版本必须与 `package.json` 一致（不一致直接失败），且 `publish` 输入默认
  `false`（只验证不发布）；发布命令只存在于这两个 workflow。
- **nightly**：每日滚动构建（48 小时无新提交则跳过），tag 恒为 `nightly` 且恒标
  `--prerelease`，不带版本号，不发布到 Marketplace。

守卫测试 `tests/releaseGovernance.test.ts` 锁上述触发面与发布命令通道唯一性，
改动 release governance 会直接红。

## 资源

- [VS Code 扩展 API](https://code.visualstudio.com/api)
- [TypeScript 文档](https://www.typescriptlang.org/docs/)
- [项目文档](./docs/)（`resources/docs/` 为早期设计沉淀，不再维护）

## 获取帮助

如果你有任何问题：

- 查看 [文档](./docs/)
- 查看 [Issues](https://github.com/cuihairu/kode/issues)
- 创建新 Issue

---

再次感谢你的贡献。
