# 为 AI 代理启用 kode-mcp 服务器

`kode-mcp` 是向 AI 编码代理暴露 KBEngine 项目知识的 MCP 服务器：实体 def、
类型、配置含义、协议帧、Python 符号与跨格式引用图。它是本工作区的 Rust
二进制（`crates/kode-mcp`），以 KBEngine 资产根目录为首个参数调用，可加
可选的知识额外路径。

同一服务器在 Roo Code、VS Code Copilot Chat、Claude Code 与 Cursor 下通用
——每个代理读一个 JSON 配置文件。工具列表相同，仅配置文件位置与格式不同。

## 前置：构建（或经 cargo 运行）

服务器是本仓库的普通 Rust 二进制：

```
cargo build -p kode-mcp --release
# -> crates/kode-mcp/target/release/kode-mcp
```

开发期可经 cargo 直接运行（启动较慢）：

```
cargo run -p kode-mcp -- <assets-root>
```

## 参数

- **`<assets-root>`**（首个，必填）：KBEngine 资产根——含
  `scripts/entity_defs/`（`.def`、`types.xml`、`alias.xml`）与
  `scripts/**/*.py` 的目录。
- **额外路径**（可选）：资产根之外要索引的附加知识目录或文件（如项目
  `.md` 文档、Excel）。

## 从 npm 安装（打包机制已建，尚未发布）

二进制按 `esbuild`、`@swc/core` 同款方式发布：`@cuihairu/kode-mcp` 里只有
一个 launcher 脚本，平台二进制走 per-platform 的可选依赖
（`@cuihairu/mcp-linux-x64`、`-linux-arm64`、`-darwin-x64`、`-darwin-arm64`、
`-win32-x64`、`-win32-arm64`）。npm 只会装其中一个，因此客户端配置在任何系统上
都是同一个稳定命令：

```
npm install @cuihairu/kode-mcp
# 配置里指向 launcher 而非 cargo 构建：
{ "command": "kode-mcp", "args": ["/abs/path/to/assets"] }
```

**这些 tarball 还没上 registry。** 打包机制已在仓库内建好并验证——
`scripts/npm-package.mjs`（`build`/`pack`/`verify`/`smoke`/`prepare`/`publish`）
与手动的 `npm.yml` workflow 会为六个目标交叉编译 `kode-mcp`、打包，并在每个
native runner 上跑真实 MCP 握手（`initialize` + `tools/list` 返回 25 个工具）。
发布刻意留给显式触发且由人工给版本号，与本项目的发版口径一致。在那之前，用
上面的 cargo 构建，或用 `KODE_MCP_BINARY` 指向已有二进制——launcher 优先听它。

## 发布：所需环境变量与凭据

需要凭据的有三样，且刻意分开，使构建本身永远无法碰到 registry。

### 环境变量

| 变量 | 位置 | 用途 |
|---|---|---|
| `NODE_AUTH_TOKEN` | 仅 CI，由 `NPM_TOKEN` secret 注入 | 它只是 `.npmrc` 里一个**被展开的占位符**；npm 自己从不读这个名字，见下节。 |
| `NPM_TOKEN` | GitHub Actions 仓库 secret | Granular access token，范围 **All packages**，权限 **Read and write**。classic token 不能用于自动化发布。 |
| `KODE_NPM_PUBLISH=1` | 本地或 CI | 显式闸门。`scripts/npm-package.mjs publish` 未设此变量即拒绝执行，构建不会误发。 |
| `KODE_MCP_BINARY` | 客户端运行时 | `kode-mcp` 二进制的绝对路径。优先于平台包查找——离线安装、或 IDE 已持有构建时用。 |
| `RUST_LOG=off` | smoke 脚手架 | 握手检查期间让暂存二进制安静。 |

### 注意：`NODE_AUTH_TOKEN` 是 `.npmrc` 占位符，不是 npm 变量

对照 npm 11.19.0 与 `actions/setup-node` 实测核实：

- 在整个 npm 安装里 grep `NODE_AUTH_TOKEN`、`NPM_TOKEN`，**命中 0 处**。npm 只从
  config 读 `_authToken`。
- 只设 `NODE_AUTH_TOKEN` 时 `npm publish` 报 `ENEEDAUTH / need auth … using
  npm adduser`——**在任何网络请求之前**就本地拒绝了。
- `setup-node` 的 `authutil.ts` 把 `//<host>/:_authToken=${NODE_AUTH_TOKEN}` 写进
  生成的 `.npmrc`；npm 读取时展开那个 `${...}`。

对本 workflow 的三条推论：

1. `setup-node` **必须给 `registry-url`**——不给就不会写 `.npmrc`，令牌等于摆设。
   `npm.yml` 里已配。
2. 令牌**不要**写进本仓库自己的 `.npmrc`：那会被提交。setup-node 生成的
   `.npmrc` 落在 runner 的临时目录，不出仓库。
3. 本地等价做法是 `npm config set //registry.npmjs.org/:_authToken <token>`，或写在
   用户级 `~/.npmrc`——**永远不写仓库文件**。

### 一次性账号配置

1. 浏览器里 `npm profile login`（npm 对每个账号强制 2FA，所以令牌是从账号的
   2FA 页面创建的，而非普通密码）。
2. 发布作用域：`@cuihairu/*` 归属你的**个人** npm 账号。npm 没有免费的组织
   作用域，所以除非 `@kode/...` 本来就是你名下的，否则别指望它能用。
3. 每个包都已带 `"publishConfig": { "access": "public" }`，这是 scoped 包的
   必需项——缺了 npm 会回 `402`。
4. 脚本自动带 `--access public`，包即对所有人可见。

### 从 CI 发布

`.github/workflows/npm.yml` 只手动触发（`workflow_dispatch`），与 `publish.yml`
同构：

```
version:  0.2.0     # 必须等于已提交的 package.json 版本
publish:   false     # 只有为 true 才在全部校验通过后发布
```

`permissions: contents: read` 与 `concurrency: kode-npm-publish` 保证一次运行
不会在 rebase 途中发出去。`prepare` 任务在发货前对下载回的 tarball 重跑
`verify-npm-set.mjs`，`verify` 里的二进制体积上限（200 MB）会挡住未裁剪的
debug 构建。

### 本地发布

```
export KODE_NPM_PUBLISH=1
export NODE_AUTH_TOKEN=<granular token>
node scripts/npm-package.mjs pack            # 产出 dist/npm/*.tgz
node scripts/npm-package.mjs publish --dry   # 先核对确切上传内容
node scripts/npm-package.mjs publish         # 上传
```

`publish` 上传的是打包好的 tarball 而非重新打包目录，因此离开本机的内容与
`pack` 校验过的一字不差。

### 不发任何东西就能验证

```
node scripts/npm-package.mjs verify   # 静态检查，任何时候都安全
node scripts/npm-package.mjs smoke    # 在暂存二进制上跑真实 MCP 握手
node scripts/npm-package.mjs sizes     # tarball 与二进制的体积
```

## Claude Code — `.mcp.json`（项目根）

```json
{
  "mcpServers": {
    "kode-mcp": {
      "command": "cargo",
      "args": ["run", "-p", "kode-mcp", "--", "/abs/path/to/kbengine-assets"]
    }
  }
}
```

改用发布二进制：

```json
{
  "mcpServers": {
    "kode-mcp": {
      "command": "/abs/path/to/crates/kode-mcp/target/release/kode-mcp",
      "args": ["/abs/path/to/kbengine-assets"]
    }
  }
}
```

## Roo Code — `.roo/mcp.json`（项目根）

与 Claude Code 同形：

```json
{
  "mcpServers": {
    "kode-mcp": {
      "command": "cargo",
      "args": ["run", "-p", "kode-mcp", "--", "/abs/path/to/kbengine-assets"]
    }
  }
}
```

## VS Code Copilot Chat — `.vscode/mcp.json`（项目根）

同形：

```json
{
  "servers": {
    "kode-mcp": {
      "command": "cargo",
      "args": ["run", "-p", "kode-mcp", "--", "/abs/path/to/kbengine-assets"]
    }
  }
}
```

## Cursor — `.cursor/mcp.json`（项目根）

与 Claude Code 同形：

```json
{
  "mcpServers": {
    "kode-mcp": {
      "command": "cargo",
      "args": ["run", "-p", "kode-mcp", "--", "/abs/path/to/kbengine-assets"]
    }
  }
}
```

## 可问什么

启用后服务器暴露结构感知项目知识索引。常见查询：

- `search_entities("Avatar")` — 有哪些实体及其 def。
- `get_entity_model("Account")` — 完整模型：属性、方法、标志。
- `find_symbol("level")` — 统一查找（实体 / 属性 / 类型 / Python）。
- `protocol_frame(typeName="SKILL_SLOT")` — 自定义类型的线布局。
- `why_setting("baseapp.archivePeriod")` — 配置值、含义、file:line。
- `list_config_settings(prefix="baseapp.")` — 全部配置含义。
- `search_docs("TrainingAvatar")` — 项目 `.md` 文档（root 是资产根目录时，项目根旁常规 `docs/`/`doc/` 目录自动并入；显式 CLI 附加路径照旧）。
- `search_symbols("Avatar")` — Python 类/函数/方法位置。
- `find_references("SKILL_SLOT")` — 跨格式引用边。
- `query_xml("entity.Avatar.Properties.level")` — XML 元素导航。
- `index_status` — 索引健康与置信度分布。

运行 `cargo test -p kode-mcp` 可对 `tests/fixtures/kbengine-demo-assets`
夹具验证服务器与全部工具。

## file:line 接地

指向项目文件的结果携带 `file`/`line` 对（引用边另有
`fromFile`/`fromLine`）。这些是磁盘上真实文件的 **1 基**源码行——def 属性
声明行、types.xml 类型声明行、Python 类/方法行、或配置键出处行
（`kbengine_defaults.xml:618`），可直接在编辑器跳转。没有合成行；解析器
无法归因的行如实省略而非猜测。
