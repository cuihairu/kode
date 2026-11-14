# RUST-013/014/015 审计:0.3 不做的事情(范围边界)三条核验

日期:2026-11-15。审计对象:todo.md 0.3 节三条范围声明。方法:crates 清单+全仓扫描+边界读法登记。**结论:三条全部成立(边界未被越过),零生产码改动。**

## RUST-013 不重写 VS Code UI 为 Rust GUI:成立

- 16 个 crate 全清单(kode-parser/protocol/python/server/index/kbengine/mcp/scheduler/vfs/schema/analyzer/db-clone/corpus/types/kbengine-protocol/root):全部是解析/协议/语义索引/服务/开发工具域,无 GUI 框架依赖(grep Cargo.toml 零 tauri/iced/egui)。
- 全部 UI 面 = VS Code 原生(webview 树视图/状态栏/面板)由 TS 渲染;kode-server 只经 stdio LSP 对话。UI 重写无任何在途或残留面。

## RUST-014 不从零重写完整 Python 解释器或 Python 语言服务器:成立

- 无解释器:kode-python 只用 ruff_python_parser 做 AST 静态分析(容错解析+符号模型),永不执行 Python;TS 侧 pythonExecService 只 `compile()` 不执行(compile-only 红线注释在 pythonExecService.ts:24,执行器源只 import json/sys/traceback)。
- 无独立 Python 语言服务器重写:扩展以 vscode 语言提供者 API 注册 KBEngine 感知的 provider 集(悬停/补全/定义/诊断),通用 Python 工具链仍交给 Pylance/ruff shell-out(选定解释器环境),不做 LSAPI 重实现。

## RUST-015 不把服务器部署、集群调度、云资源与游戏业务运维塞入语言服务核心:成立

- 全仓扫描零 kubernetes/k8s/terraform/ansible/云资源面;无远程部署编排、无集群调度逻辑。
- 边界读法登记:本地的引擎进程控制(serverControls 启停/状态)与 telnet/HTTP 集成面是**本地开发调试工具**,对话目标是用户已在跑的引擎,不构成「部署/运维」;游戏业务逻辑(实体脚本本身)永远是用户资产,本工具只做静态分析与热更通道,不生成、不托管业务运维。

## 门禁

纯审计零生产码;引用事实(crates 清单/compile-only 红线/configuration.md 默认值)全部现役可核。
