# RUST-182 验收纪要:Debug Adapter 边界——Python debug/远端 attach/engine session 生命周期在 TS,Core 不兼任 debugger

日期:2026-11-17。本纪要对账 RUST-182(旧 KBE-012,主 todo 排队项)的验收口径与既有交付证据,并补齐命名钉。结论:**三块调试面均已交付且编排归属 TS 扩展宿主,语义 Core 零 debug 承载,本批补命名验收钉 `crates/kode-server/tests/core_not_debugger.rs`(2 例)后勾行。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| Python debug | debugpy 经 VS Code debug API 驱动(外部进程,非 Core 内嵌):①一键注入(KODE-DBG-001)「telnet :python 层发 debugpy.listen + connect 附加」,复用 autoDebugpy 注入本体单发形态,开关 `kbengine.debug.debugpyInject` 缺省 true;②调试启动即 attach 三件套(用户令 2026-10-27 ③):`kbengine.python.debugpySync` 资产树同步(引擎目标 Python 解析,DBG-COMPAT-01/02 不再全局 3.12.13 一刀切)、组件 telnet 就绪即注入、updateLaunchJson 每组件 attach 配置;③早期断点:`kbengine.debug.waitAtStartup` 入口脚本引导块 listen+wait_for_client,不依赖 telnet 注入时机 | `src/debugpyInjectCommand.ts`;`src/autoDebugpy.ts`;`src/debugpyWaitAtStartup.ts`;`docs/design/debugpy-attach.md`;`tests/autoDebugpy.test.ts` |
| 远端 attach | `attachViaDebugpyPort` 探端口→connect(含隧道/分诊);`attachWithDeadline`(IDE-DBG-007)两道闸:截止超时停会话如实提示、进度通知取消同一路径,只停一次绝不重试,晚到的 start 结果一律吞;超时 `kbengine.debug.attachTimeoutMs` 缺省 15s | `src/backend/debugAttachGuard.ts`(纯逻辑,计时器注入);`src/debugConfig.ts`;`tests/debugAttachGuard.test.ts` / `debugConfigAttach*.test.ts` |
| engine session 生命周期 | serverManager 组件 server key(buildServerKey/parseServerKey)、依赖等待 deadline(resolveDependencyWaitDeadline)、就绪探针(createComponentReadinessProbe);注入时机=组件 telnet 就绪即刻(局限如实记录:entitydef 装载已过,早期断点归 waitAtStartup);端口表 DEBUGPY_PORT_TABLE 逐组件、表外回落 5678 | `src/serverManager.ts`;`src/autoDebugpy.ts`;`tests/cov-debug-process.test.ts` |
| Core 不兼任 debugger | ①RPC 注册表面:`$/kode/*` 生产注册表零 debug 承载方法;②源面:kode-server(131 文件)与 kode-python(12 文件)源码零 debugger 实现记号(debugpy/breakpoint/DebugAdapter/debug_adapter/startDebugging,grep 实测零命中);kode-mcp 的 debugpy 字样仅为入口脚本事实描述(config_qa/server.rs 文档字符串),非编排 | **本批钉** `rpc_registry_exposes_no_debugging_methods` + `core_crates_source_carries_no_debugger_tokens` |

## 本批增量

- `crates/kode-server/tests/core_not_debugger.rs`(新,2 例):
  - 注册表面钉:`$/kode/*` 快照 ≥20 非空守卫 + `$/kode/databaseSchema/build` 基准面(注:`textDocument/hover` 是 LSP 面不进 `$/kode` 注册表,基准面不能用它)+ 零方法名含 debug;
  - 源面陈旧防:两核 crate 源码记号扫描,`//` 注释行豁免(头注可如实描述「调试面在 TS」的架构事实,实现记号不许出现在代码里),文件数下限 kode-server ≥100 / kode-python ≥10 防静默走空目录造假绿;
  - prove-red 双变异(注册表断言取反→每方法即红 RC=101;记号表加必定命中的 `serde`→源面红 RC=101),cp+cmp 字节还原。
- TS 侧零改动:debugpy 三件套/attach 闸/serverManager 均有既有钉(17+ 测试文件),本批不重复。

## 诚实条款

- 「不兼任」是**编排归属属性**:调试编排(注入/attach/会话生命周期)全在 TS 扩展宿主,经 VS Code debug API 驱动外部 debugpy 进程;Core 的 RPC 面与源面零开口是结构事实(本批钉),不是「Core 物理不可能实现调试」的保证。
- 源面陈旧防豁免 `//` 注释行;非注释实现记号一出现即红。`/* */` 块注释未特殊处理(仓库两核 crate 无此风格带记号的先例)。
- Python debug / 远端 attach / engine session 生命周期本体均为既往批次交付(KODE-DBG-001 / IDE-PDBG-001、002 / IDE-DBG-007 / autoDebugpy 用户令 2026-10-27 ③),本批不重复实现,只做验收对账与命名钉。
- debugpy 资产同步依赖系统 pip 与引擎目标 Python 兼容(DBG-COMPAT-01/02),不兼容时如实报错不静默降级——细节在 autoDebugpy 面与其文档。
