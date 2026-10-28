# 开发与发布


本页面向维护者，说明如何本地开发、调试、构建文档和控制版本策略。

## 环境要求

- Node.js `^20.19.0 || >=22.12.0`（推荐直接使用 `.nvmrc` 中的版本）
- pnpm 以 `package.json` 的 `packageManager` 字段为准（当前 pnpm 12.10.1）
- VSCode 1.61.0 或更高版本

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

## 改了代码但行为没变？先确认 VS Code 跑的是哪份产物

「改了没生效」绝大多数不是逻辑问题,而是 VS Code 还在跑旧产物。按序排查:

1. **已装扩展**:`%USERPROFILE%\.vscode\extensions` 下应存在
   `cuihairu.kode-kbengine-*` 目录(扩展 id 由 `kode` 改名为 `kode-kbengine`,目录尾段随版本);没有就是没装(你测的不是这份代码)。
   ```powershell
   Get-ChildItem $env:USERPROFILE\.vscode\extensions -Filter '*kode*'
   ```
2. **开发主机(F5)的产物**:入口是 `package.json` 的 `main` = `./out/extension.js`。
   重建后确认新代码真在产物里(以跳转修复的符号为例):
   ```bash
   pnpm run vscode:prepublish
   pnpm exec node -e "console.log(require('fs').readFileSync('out/extension.js','utf8').includes('resolveSelfMethodCandidates'))"
   # 必须输出 true;false 说明编译未跑/跑的是旧编译
   ```
3. **重建并安装**(最短步骤;`out/`、`*.vsix` 均已 gitignore):
   ```bash
   pnpm install
   pnpm run package        # vsce 自动执行 vscode:prepublish = compile + bundle
   code --install-extension kode-kbengine-*.vsix
   ```
   装完执行 `Developer: Reload Window` 再测。
4. **确认扩展已激活**:激活事件只有 `workspaceContains:**/*.def` 与打开 `.def`
   文件,**没有 `onLanguage:python`**——只开纯 Python 子目录(全树无 `.def`)时
   扩展不激活,Python 跳转提供者也就不存在。先打开任意 `.def` 或切到含 `.def`
   的工作区根再测。
5. **不需要新增配置**:`contributes.configuration` 41 项里没有任何跳转/mixin/索引
   开关;Python 定义提供者在 `src/extension.ts:205` 无条件注册。

## 测试

测试不依赖真实 KBEngine 环境与 VSCode 下载:vitest(`tests/`)承载全部功能
测试——纯逻辑、本地仿真器(`tests/sim/`)、fake-vscode 替身(`tests/fake-vscode/`)
上的装配与面板测试;mocha(`src/test/suite/`)只做编译产物烟测(打包形态的
`out/extension.js` 激活/命令/补全)。分层与运行方式详见
[TESTING.md](https://github.com/cuihairu/kode/blob/main/TESTING.md) 与
[重设计说明](../redesign.md)。

## 文档开发

VitePress 文档入口在 `docs/`。

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
5. 打包出的 VSIX 是否包含 parser worker——`vsce package` 后解包确认 `extension/out/pythonParserWorker.js` 在，再用 `node` 从解包路径启动（`new Worker(<解包>/extension/out/pythonParserWorker.js)`）并确认一条解析请求能收到 `id`/`revision`/`parsed` 回包。结构守卫在 `tests/vsixPackaging.test.ts`：`.vscodeignore` 必须先排除 `out/**` 再保留 `!out/pythonParserWorker.js`、`bundle` 脚本必须保留 worker 的 esbuild 入口、worker/parser 源码不得 import `vscode`（worker 从包内路径启动不依赖扩展宿主）。2026-10-29 已在本地打包产物上核验通过（REL-003）。

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
