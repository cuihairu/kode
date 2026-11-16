# RUST-183 验收纪要:运行时 Process/Telnet/Watcher/Log 走 service adapter,语义 Core 零承载

日期:2026-11-17。本纪要对账 RUST-183(旧 KBE-013,主 todo 排队项)的验收口径与既有交付证据,并补齐命名钉。结论:**四面编排均已交付且归属 TS 扩展宿主 adapter 层,Core 零连接/派生承载,本批补命名验收钉 `crates/kode-server/tests/core_runtime_free.rs`(2 例)后勾行。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| service adapter 分离 | 协议/纯核层零 vscode:`src/backend/telnetClient.ts`(KBEngine telnet 协议客户端,对齐引擎 telnet_server.cpp + telnet_handler.cpp:密码协商、五条 IAC、提示符态机)、`src/backend/consoleLogTail.ts`;接线层:`telnetService.ts`/`telnetTree.ts`/`telnetWebView.ts`/`kbengineConsoleHub.ts`/`webviewConsoleBridge.ts`;Process=`processManager.ts`/`pythonProcessConfig.ts`;Log=`logCollector.ts`/`logWebView.ts`/`loggingWiring.ts`/`logErrorScan.ts`;Watcher=实体映射/调试配置 watch 测试族 | `src/backend/` 纯核 vs `src/` 接线的分层;`tests/processManager*.test.ts` 等 |
| 权限校验 | telnet 密码协商(有密码组件 `password:` 流程,密码错停 PASSWD 态);`isCommandAllowed` 命令白名单;`::quit` 恒拒(会关服务端进程,白名单层拒绝) | `src/backend/telnetClient.ts`(协议面);`src/telnetService.ts`(消费) |
| 断线重连 | telnet:运行中断线自动回到探测态,重连由用户点面板再建立,面板不崩;log:`autoReconnect` 可配置 + `reconnectTimer` + `isManualDisconnect` 手动断开不自动重连 | `src/telnetService.ts`;`src/logCollector.ts` |
| 资源清理 | `dispose`/`destroy` 面:telnetService「只拆自己」(重连断旧建新时旧 socket 的 close 事件晚到,不误拆新 socket);logCollector 计时器/连接收尾;consoleLogTail/telnetClient 各自收尾 | `src/telnetService.ts:392`;`src/logCollector.ts`(dispose/destroy ×10) |
| Core 零承载 | ①RPC 注册表零连接/派生类方法(telnet/connect/spawn 片段);②两核 crate 源面零引擎侧传输记号(TcpStream/TcpListener/tokio::net)——Core 与引擎的天系只有 LSP stdio 与 ruff 工具调起 | **本批钉** `rpc_registry_exposes_no_runtime_management_methods` + `core_crates_source_carries_no_engine_transport_tokens` |

## 本批增量

- `crates/kode-server/tests/core_runtime_free.rs`(新,2 例):
  - 注册表面钉:`$/kode/*` 快照 ≥20 非空守卫 + `$/kode/databaseSchema/build` 基准面 + 零 telnet/connect/spawn 方法名 + process 相关方法**唯一白名单面**正控断言(`$/kode/processTopology/validate` 必须在册,出现第二个 process 方法即红);
  - 源面陈旧防:两核 crate 传输记号扫描(`//` 注释豁免,文件数下限 100/10);
  - prove-red 双变异(禁入片段加 topology→白名单面自身红 RC=101;源面记号加 `pub fn`→RC=101),cp+cmp 字节还原。
- **侦察被现实纠正两次(钉子比预想更准)**:①`$/kode/processTopology/validate` 已注册——读它定案为定义期静态校验面(校验 process_topology.xml 部署清单出 lint 预警,C-17,读声明文件零活体进程接触),不是运行时管理,故改白名单正控而非误杀;②`ruff_lint.rs` 有 `Command::new`——派生 ruff lint 工具是合法工具调起(IO 泳道),记号表收窄为纯引擎侧传输,不误伤。

## 诚实条款

- 「分离」是**编排归属属性**:运行时四面编排(连接/命令/重连/清理)全在 TS 扩展宿主 adapter 面;Core 注册表零连接派生方法 + 源面零引擎传输记号是结构事实(本批钉),不是「Core 永不可能实现」的物理保证。
- `$/kode/processTopology/validate` 是定义期静态校验(读部署清单文件出 warning,可 CI 拦截),不接触活体进程;它注册在 Core 不构成越界,本批把它钉成 process 相关的唯一合法面。
- 断线语义两面如实分述:telnet 断线回探测态、由用户再建立(**不自动重连**);自动重连只在 logCollector(`autoReconnect` 可配置,手动断开除外)。
- 权限校验/重连/清理的本体与钉均为既往交付(telnetClient 协议钉、processManager 族、logCollector 族),本批不重复实现,只做验收对账与 Core 零承载命名钉。
- 门禁附记:全量 unit 首轮 hotfixSpellingGate 5s 预算超时(整仓拼写扫描 18.9s,load 15.8 满载抖动族),solo 复跑 2/2 绿定案。
