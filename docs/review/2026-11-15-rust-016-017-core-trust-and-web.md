# RUST-016/017 审计:Core 进程信任隔离;不承诺纯浏览器原生 Core

日期:2026-11-15。审计对象:todo.md RUST-016/017。方法:加载通道全谱扫(crates+src)+承诺面扫描(README 双语/features 双语/configuration)。**结论:两条全部成立,零生产码改动。**

## RUST-016 不允许没有协议隔离的第三方插件直接加载到高可信 Core 进程:成立

- **Core 加载面为零**:16 个 crate 无 dlopen/libloading/dylib/plugin-host 机制(kode-scheduler 是任务调度域非插件宿主);kode-server 进程内不存在任何「加载并执行外部代码」的通路。
- **进入 Core 的通道只有两条,皆为数据非代码**:①stdio LSP JSON-RPC(协议隔离=RUST-008 版本门:握手版本不一致即拒绝对话杀进程);②didOpen/didChange 传文件内容(被当作待解析文本,永不被求值)。无配置驱动的代码注入面。
- **spawn 面固定**:生产装配 `new KodeCoreClient({ binaryPath: serverPath })` 无额外 args(kodeCoreGate.ts:426),二进制为自建 kode-server(自动发现/显式配置),非第三方产物。
- **扩展宿主侧零第三方代码装载**:对 ms-python.python/ms-python.debugpy 只读 isActive/版本元数据做兼容性核对(utilityCommands.ts:474/debugExtensionCompatFor),从不 import 其 exports;extension.ts 的 getExtension().exports 是**反向**口——kode 自己导出探针 API 给测试消费。
- **MCP 面**:kode-mcp 为自建独立二进制,经 MCP 协议(数据通道)对话,同一隔离口径。
- 边界读法:第三方 VS Code 扩展本就运行在各自的扩展宿主进程(VS Code 隔离),且不存在任何通往 kode-server 的通道;「协议隔离」已由版本门+纯数据协议双保险,无需新增机制。

## RUST-017 不承诺纯浏览器 VS Code 可以执行原生 Core:成立(不承诺=诚实不支持)

- package.json 无 `browser` 入口 → 非 web 扩展,vscode.dev 下不装载不激活(原生 spawn 在浏览器宿主不可能,事实边界天然成立)。
- 承诺面扫描零命中:README en/zh、features en/zh 无 vscode.dev/web extension/浏览器版/远程部署任何字样——**没有虚假承诺**。
- 未来路径登记(设计注,非承诺):若需 Web 面,两条诚实路线=①Web 降级声明有限功能(TS 纯静态分析子集,无 Core/Rust),或②远端 Core(连接用户自部署的 kode-server 实例);两者都须独立设计立项,当前刻意不建(与 RUST-015 运维边界一致)。

## 门禁

纯审计零生产码;引用事实(crate 清单/spawn 形状/compile-only 红线/RUST-008 版本门)全部现役可核。
