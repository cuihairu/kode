# kode-mcp 上 npm：平台包打包机制

**日期**：2026-11-12
**范围**：`crates/kode-mcp`（Rust stdio MCP 二进制）的 npm 分发机制；**未发布**——包 tarball 已能产出与验证，上传留给显式触发且由人工给版本号。

## 0. 为什么不能「直接发一个 npm 包」

`kode-mcp` 是 Rust 编译的**原生二进制**，不是 JS。一个 npm 包里塞不进「所有平台的同一个二进制」：一台 linux-x64 机器装到 darwin-arm64 的 ELF 只会报 `exec format error`。工业界对此只有两条正路：

| 路线 | 形态 | 代价 |
|---|---|---|
| **A 平台包**（本方案） | 主包只含 launcher；二进制按 `os/cpu` 拆成 6 个 optionalDependencies 平台包，npm 只装命中的那个 | 维护 6 个包 + 六平台 CI 矩阵 |
| B 薄包装器 | 主包 `postinstall` 从 GitHub Releases 拉平台二进制 | 装包要联网；依赖 Release 产物存在 |

A 是 esbuild / `@swc/core` 的形态，也是本仓库已有 nightly 七平台矩阵能直接复用的形态，故取 A。

## 1. 包结构

```
packages/kode-mcp/
  package.json            @cuihairu/kode-mcp —— 只发 bin/kode-mcp 一个文件
  bin/kode-mcp            launcher（CommonJS，无需构建）
  mcp-linux-x64/          @cuihairu/mcp-linux-x64 —— os:["linux"], cpu:["x64"]
  mcp-linux-arm64/
  mcp-darwin-x64/
  mcp-darwin-arm64/
  mcp-win32-x64/
  mcp-win32-arm64/
  .gitignore              mcp-*/bin/ —— 暂存二进制与 digest 是构建产物
```

平台包目录进版本库的只有 `package.json`（让包布局可评审）；`bin/` 里的二进制与
`manifest.json` 由 CI 暂存、被 `.gitignore` 挡住（单平台 294 MB，绝不该进树）。
仓库里平台包保持 `"private": true`——未暂存时不可误发，CI 跑 `prepare` 才解锁。

## 2. launcher 的三级定位

`bin/kode-mcp` 用 `child_process.spawn` 透传 argv 与 stdio，客户端因此看到的是一个
稳定的命令名，不关心 npm 装了哪个平台包：

1. `KODE_MCP_BINARY`（绝对路径）——离线安装、或 IDE 已持有构建时用；
2. 从 launcher 所在目录**向上**逐层找 `node_modules/@cuihairu/mcp-<os>-<arch>/bin/kode-mcp`
   （覆盖 `npx`、全局安装、workspace 根），再退回客户端 cwd；
3. `createRequire(__filename).resolve('…/package.json')` 兜底。

两处刻意的收窄：

- **`ARCH` 表里没有的 `os/arch` 组合不猜**。表里查不到就报
  `no prebuilt binary for <os>-<arch>`——硬塞一个错误架构的二进制只会让用户拿到
  `exec format error`，而一个明确的报错是可用状态。
- 非 Windows 下若二进制不可执行，`chmod 0o755`（压缩包与部分包管理器不保留文件位），
  chmod 失败则继续，让 `spawn` 报真实错误。

退出码与信号原样透传（`close` 里 `process.kill(process.pid, signal)`），
launcher 不回吞子进程退出码——否则 MCP 客户端无从区分「服务起了又崩」与「参数写错」。

## 3. 关键坑：MCP stdio 不是 LSP 帧

第一版 smoke 用 `Content-Length:` 帧发请求，服务回
`Error: ConnectionClosed("initialize request")`。

原因是**把 `kode-server`（LSP）的帧格式套到了 MCP 上**。核实
`rmcp-3.8.0` 的 `transport::io::StdioReader`：MCP stdio 是**每行一条 JSON**，
没有 `Content-Length` 头。改正后 `initialize` 正常返回
`serverInfo {"name":"kode-mcp","version":"0.2.0"}`，`tools/list` 返回 25 个工具，
进程干净退出（status 0）。

这条坑已写进 `scripts/npm-package.mjs` 的注释，并由
`tests/npmPackage.test.ts` 用字符串断言锁死（脚本里不得出现 `Content-Length: `），
防止将来有人照 `platform-vsix.mjs::smokeBinaries` 抄回去。

第二坑是**握手期间关 stdin**：rmcp 在 initialize 未完成时读到 EOF 就按连接关闭报错。
所以 smoke 把 initialize / notifications/initialized / tools/list 放进**同一批**输入，
而不是先发 initialize 再等回执。

## 4. 脚本与闸门

`scripts/npm-package.mjs` 六个子命令，按危险度分层：

| 命令 | 危险度 | 说明 |
|---|---|---|
| `verify` | 无 | launcher `node --check` + 可执行位 + `bin` 入口 + optionalDependencies 恰为 6 平台包 + 版本一致 + 暂存 digest 校验 + 体积闸 |
| `smoke` | 无 | 在暂存二进制上跑真实 MCP 握手（喂 `tests/fixtures/kbengine-demo-assets` 让索引非空） |
| `sizes` | 无 | 汇报 tarball 与二进制体积 |
| `pack` | 无 | `npm pack --pack-destination dist/npm` 全平台 + 主包，产出 `npm-index.json` |
| `build` | 低 | 把已编译的 release 二进制暂存进平台包并记 digest |
| `prepare` | 中 | 解锁平台包（删 `private`、加 `publishConfig.access`、对齐版本） |
| `publish` | **高** | 双重闸：`KODE_NPM_PUBLISH=1` **且** 上传的是 `pack` 产出的 tarball |

三道防误发：

1. **`KODE_NPM_PUBLISH=1`**——不设即拒绝执行。构建流水线永远走不到 registry。
2. **体积闸 `MAX_PUBLISHED_BINARY_BYTES = 200 MB`**——实测本仓 debug 构建为
   308 MB，`verify` 会直接拒绝，避免未裁剪产物上 registry。
3. **publish 上传 tarball 而非重打包**——离开本机的字节与 `pack` 校验过的一字不差。

`.github/workflows/npm.yml` 只 `workflow_dispatch`，`permissions: contents: read`，
`concurrency: kode-npm-publish`，输入 `version`（必须逐字等于已提交的 `package.json`
版本）与 `publish`（默认 false 只校验）。六平台矩阵复用 `platform-vsix.yml` 的
runner / rust target / musl `rust-lld` 配方；`prepare` 任务在下载回的 tarball 上重跑
`verify-npm-set.mjs`（六平台 + 主包齐全且无多余、无空包）。

## 5. 实测（本地，linux-x64）

用**本地 debug 二进制**走通全链路（仅验证管道，非发布产物）：

| 环节 | 结果 |
|---|---|
| `pack` | 主包 `cuihairu-kode-mcp-0.2.0.tgz` 2 538 B；平台包 69 044 605 B；`npm-index.json` 落 `dist/npm/`（`dist/` 已被 `.gitignore` 忽略） |
| 真实 `npm install` | 临时消费工程装主包 → `node_modules/.bin/kode-mcp` shim 生成；装平台包 → `@cuihairu/mcp-linux-x64/bin/kode-mcp` 就位 |
| 经 shim 真调用 | `initialize` 返回 `serverInfo {"name":"kode-mcp","version":"0.2.0"}`；`tools/list` 25 工具；退出码 0 |
| 体积闸 | debug 308 MB 被 `verify` 正确拒绝；模拟「无暂存」时不误报（0 staged 通过） |
| git 卫生 | `git check-ignore` 确认 `packages/kode-mcp/.gitignore` 挡住 294 MB 暂存二进制 |

## 6. 凭据与环境变量（文档同文）

| 变量 / secret | 位置 | 用途 |
|---|---|---|
| `NODE_AUTH_TOKEN` | 仅 CI，由 `NPM_TOKEN` 注入 | **不是 npm 认的变量**——只是 setup-node 写进生成 `.npmrc` 的占位符，见下节 |
| `NPM_TOKEN` | GitHub Actions secret | Granular access token，范围 All packages、权限 Read and write。**classic token 不能用于自动化发布** |
| `KODE_NPM_PUBLISH=1` | 本地或 CI | `publish` 的显式闸门 |
| `KODE_MCP_BINARY` | 客户端运行时 | 覆盖平台包查找的二进制绝对路径 |
| `RUST_LOG=off` | smoke 脚手架 | 握手检查期间让二进制安静 |

账号侧一次性：浏览器 `npm profile login`（npm 对全账号强制 2FA，令牌从 2FA 页面创建）；
`@cuihairu/*` 归属**个人**账号——npm 无免费组织作用域，故不指望 `@kode/...`；
每个包都带 `"publishConfig": {"access":"public"}`，scoped 包缺它会回 `402`。

### 第 4 个坑：`NODE_AUTH_TOKEN` 不是 npm 认的变量

初版 `npm.yml` 的 publish job 只设了
`env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`，**没配 `registry-url`**。这会让裸
`npm publish` 直接 `ENEEDAUTH` 失败。三层证据（npm 11.19.0 实测 + setup-node 源码）：

| 证据 | 结果 |
|---|---|
| grep 整个 npm 安装 | `NODE_AUTH_TOKEN` **0 命中**、`NPM_TOKEN` **0 命中**；`_authToken` 仅 3 处（全在 `auth.js`，是 config 键名） |
| 只设 `NODE_AUTH_TOKEN` 后真 `npm publish` | `ENEEDAUTH / need auth … using npm adduser`——**在发网络请求前**本地拒绝 |
| `actions/setup-node` `src/authutil.ts` | 写 `//<host>/:_authToken=${NODE_AUTH_TOKEN}` 进生成的 `.npmrc`；`main.ts` 的守卫是 `if (registryUrl) { auth.configAuthentication(registryUrl) }` |

机制是 **npm 的 `.npmrc` 环境变量替换**：setup-node 往 `.npmrc` 写一行占位符，
npm 读取时展开 `${NODE_AUTH_TOKEN}`。**npm 自己从不读这个名字**，它只是 `.npmrc`
里一个待展开的符号。由此两条硬结论：

1. `setup-node` **必须给 `registry-url`**，否则 `.npmrc` 根本不生成，令牌等于摆设。
2. 令牌**不得**写进本仓库的 `.npmrc`（会被提交）；setup-node 生成的那份落在
   runner 临时目录，不出仓库。

`tests/npmPackage.test.ts` 用 **publish job 块**而非全文断言——因为 workflow 里更早的
setup-node（依赖缓存用）也含 `registry-url` 字样，全文匹配会让这道闸永远绿。
prove-red：删掉 publish job 的 `registry-url` 行 → 恰好 1 红 16 绿；补回 17/17 绿。

## 7. 门禁

| 门禁 | 结果 |
|---|---|
| `node --check` × 3（launcher / npm-package / verify-npm-set） | 0 |
| `npm run lint`（eslint src） | 0 |
| `npm run compile`（tsc -p ./） | 0 |
| `tests/npmPackage.test.ts` | 17 例全绿（含 publish job `registry-url` 闸） |
| `npm run test:unit` | 741 文件（740 过 / 1 skip）；8981 例过 / 8 skip；RC=0 |
| `xvfb-run -a npm run test:demo:editor` | 25 passing；RC=0 |
| 真实 `npm install` + shim 端到端握手 | 25 工具，退出 0 |

## 8. 未做 / 边界

- **未发布**：不上传 registry、不打 tag、不建 Release——版本号只能由用户手动给出。
- **未跑正式 release 交叉编译**：本机磁盘余量不足（`target/` 已清 13 GB 增量/覆盖缓存），
  六平台 release 构建留给 CI。本地链路验证用的是 debug 二进制，只证明管道成立。
- **`publish --dry`** 未在真实登录态下跑（需账号令牌），留给用户登录账号后核对。
- **扩展侧不因此改定位逻辑**：`src/backend/nativeBinary.ts` 仍按 `bin/` → `target/debug`
  → `target/release` 找包内二进制，npm 包是**另一条**分发面（给 Claude Code / Codex /
  OpenCode 这类外部 MCP 客户端用），两者不冲突。
