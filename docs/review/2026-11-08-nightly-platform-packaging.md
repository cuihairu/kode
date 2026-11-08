# Nightly 多平台交付

每日构建并行运行原有完整 TS 测试与 lint，以及 `platform-vsix.yml` 的各平台验证；发布任务同时依赖两侧成功。全量 TS 测试使用单 worker，避免并行测试争抢 CPU 导致墙钟预算误判；保留原预算、不重试或跳过失败测试，之后仍执行原有 mocha 烟测。六个平台在各自原生 runner 上执行 Rust 库测试、协议 CLI 集成测试、扩展二进制发现测试，构建 release 可执行文件后打包。Linux 使用 musl 目标和 Rust 自带的 rust-lld/CRT，避免链接构建机的 glibc 或混用发行版 musl 启动文件。

| 包后缀 | 平台 | 内容 |
|---|---|---|
| linux-x64 | Linux x64 | TS + Rust |
| linux-arm64 | Linux ARM64 | TS + Rust |
| win32-x64 | Windows x64 | TS + Rust |
| win32-arm64 | Windows ARM64 | TS + Rust |
| darwin-x64 | macOS Intel | TS + Rust |
| darwin-arm64 | macOS Apple Silicon | TS + Rust |
| pure-ts | 通用 | 默认 TS 后端，不携带二进制 |

每个混合包只携带 `bin/kode-server[.exe]`、`bin/kode-kbengine[.exe]` 和构建清单。扩展优先发现 `bin/`，源码开发时仍可发现 `target/debug` 与 `target/release`。使用远程扩展宿主时，在远程系统构建的包中启动对应后台。

打包器在临时目录收集运行文件，不扫描源码树/worktrees，不修改工作区的 package.json。Python 和 DEF 的解析 worker 均随包交付；Rust 源码、构建缓存和独立的 GPL Wireshark 插件不进入 VSIX。

混合包验证读取最终 ZIP 的平台标识、版本、构建提交、可执行权限和二进制 SHA256；再从 ZIP 解出二进制，在当前平台完成 initialize→didOpen→真实定义跳转→shutdown→exit，以及 CLI 版本和示例工程 schema validate。纯 TS 包验证后端默认值、扩展与两个 worker 的存在、无平台限制及无原生二进制。

七个产物全部成功后才进入发布任务；精确核对文件名集合，生成 SHA256SUMS，统一更新 nightly。一个平台失败或缺包均阻止发布。新资产验证成功后清除旧版本 VSIX，避免用户下载过期通用包。48 小时无提交时只跳过定时任务，手动任务仍运行。正式商店发布流程暂未切换。

纯 TS 包与混合包使用同一扩展 ID，安装时互相替换；现有用户显式配置的 backend 优先于包内默认值。纯 TS 版本不保证 Rust 独有命令可用，不会自行下载或编译 Rust。

本地命令（需先安装 pnpm 依赖；混合包要求对应原生系统及 Rust target/linker）：

```bash
node scripts/package-pure-ts.mjs
node scripts/platform-vsix.mjs linux-x64
node scripts/verify-platform-vsix.mjs dist/kode-0.2.0-linux-x64.vsix linux-x64
```

输出位于 `dist/`。Windows/macOS 的真实验证以对应 CI job 成功为准，不能用本机 Linux 结果替代。测试覆盖的是原生计算、通信与打包路径，不等于所有 IDE 交互均完成实机人工验收。WASM/web、Alpine 商店专属包与独立 MCP 客户端插件不是本批交付物。

## 已完成的 CI 验收

- 被测源码提交：`024a81492a2c0e6f503c8246fccb74ec5c24c22f`。
- [运行 42463793704](https://github.com/cuihairu/kode/actions/runs/42463793704)：完整 TS 回归及 mocha 烟测、七个包的独立验证、统一发布、上传资产核对和版本 tag 检查全部成功。
- 六个平台均完成原生 Rust/CLI 测试、Windows 文档路径 RPC 回归、TS 发现测试以及最终 VSIX 二进制解包运行检查。纯 TS 包独立验证无二进制且默认后端为 TS。
- [nightly 资产](https://github.com/cuihairu/kode/releases/tag/nightly)：七个 `kode-0.2.0-*.vsix` 和 `SHA256SUMS` 已发布，旧 VSIX 已清理。纯 TS 包约 3.35MiB；混合包约 5.88–6.52MiB。

多平台实跑期间修复：Windows/macOS 测试的 Linux 宿主假设、Unix 专属进程测试工具、macOS 不支持的 GNU touch 参数、Linux x64 musl 启动段错误（改用 Rust 自带链接器/CRT 后验证通过），以及 **Windows 盘符被误当 URI scheme 导致 LSP 文档未入库、跳转返回 null** 的真实功能缺陷。完整回归还发现并补齐了四个协议命令的显式 activation events。

失败轮次均被发布门禁阻止；上面的成功运行重新从同一源码提交构建全部七包，没有混用不同提交的旧产物。
