# Rust↔TS 功能覆盖矩阵 · 2026-11-10 状态增量

用户令（2026-11-10）：「继续查找问题吧，至少 rust 要覆盖 ts 的功能点吧」。
本文是 `docs/review/2026-11-08-ts-rust-migration-verification.md`（133 命令/27 provider/13 诊断集/22 RPC 全量账）的**状态增量**：把 11-08 之后的状态变化对账，并按功能域量化「Rust 尚未覆盖的 TS 计算面」。

方法：全量 grep sweep（`runInRust|kodeCoreGate` 21 文件命中 / `$/kode/...` RPC 字面量 / provider 模块逐个 gate-refs 清点）+ `crates/kode-server/src/server.rs:107-121` 注册块直读 + 关键文件 import 链人工复核。全部结论可由本文所列 file:line 复验。

## 一、相对 11-08 矩阵的状态增量（3 项）

| 项 | 11-08 判词 | 2026-11-10 现状 | 证据 |
| --- | --- | --- | --- |
| `$/kode/def/md5` | 死 RPC（包装器≠接线） | **已接线**：命令 `kbengine.def.checkEngineMd5`，TS 收集 def 闭包（打开缓冲区优先）→ Rust 计算 → 与 kbcmd 盖章对拍 | src/defMd5Check.ts:34 `import { computeDefMd5InRust }`；97c5b112 |
| serveFromRust 服务轨道 | 恒 false、无 'rust' 值 | **已生效**：validation/completion/hover/navigation 四面 Rust 优先 + TS 回退；服务轨道已易帜「直接切 rust」 | kodeCoreGate.ts:314 `mode==='rust' && serverPath!==''`；04a3fada/e9703cca/e66f527f/bc55988f |
| `$/kode/apiDocs/lookup` | 未核实 | **判定不切**（对拍锁定：全语料成员×域面×en/zh 一致；热路径零 RPC 依赖；语料生成器 --check 门禁锁零漂移） | b8e6b2b9；tests/apiDocsRustParity.test.ts |

## 二、当前 RPC/服务面总账

Rust 注册面（server.rs:107-121 直读）：**22 个 `$` RPC 方法 + 4 个 LSP 原生面**（hover/completion/definition/diagnostic，handle_hover:382/handle_completion:425/handle_definition:470/handle_diagnostic:507）+ did_open/did_change/did_close 通知。

TS 消费状态（2026-11-10）：

- **生产消费中（18 RPC + 4 LSP 面）**：config/resolve、config/derive、databaseSchema/build、dbClone×5、def/md5、dependency/graph、lint/analyzeDef、messageTable/build、processTopology/validate、python/callgraph、python/symbols、ruff/lint、sdk/generate、workspace/scanAnchors；LSP 四面经 serveFromRust。
- **判定不切（1）**：apiDocs/lookup（见上表）。
- **死 RPC（3）**：`$/kode/wire/encode`、`$/kode/wire/decode`（零 TS 消费者，kode-mcp 直接复用 Rust 编解码库不经 RPC）、`$/kode/echo`（测试入口，非用户功能）。

## 三、功能域覆盖分类（缺口量化）

### A. Rust 已覆盖（计算核心在 Rust，TS 消费/回退）

def 结构分析（14 条 lint 规则：duplicate-definition/missing-type/unknown-type-reference/missing-flags/heavy-sync-broadcast 等，crates/kode-server/src/lint/rules.rs）、消息表构建、依赖图、数据库 schema、克隆五 RPC、进程拓扑校验、python symbols/callgraph、ruff lint、client_sdk 生成、workspace 锚点扫描、config resolve/derive、def 引擎 MD5、语料 hover、LSP 四面。TS 侧保留同源兜底双胞胎（databaseSchemaCore/messageTableEngine+Entity/dependencyGraph.ts/defAnalyzer TS 路径）——**设计如此，非缺口**。

### B. TS-only 计算面 = 真实覆盖缺口（Rust 无对应实现）

按 backend 域 sweep（198 文件中 21 个 Rust-wired，其余为 TS 计算/宿主面），缺口集中在两族：

**B1. Python 语义分析族（约 22 模块，最大缺口）**
pythonParser(+WorkerHost)/pythonClassIndex/pythonLiteralTypes/pythonReturnTypeInference/pythonSelfScope/selfAttributeFlowTypes/selfAttributeNoneDiagnostics/selfPropertyTypeInference/pythonLexicalMask/pythonRoleRoots/pythonScanRules/pyreflyInfer/defPythonParity/inferredEnrichment/inferredCopy/userTypeContract(+Source)/semanticIndex/globalDataIndexCore(+src/flowVersionKey.ts)。
Rust 侧 kode-python 仅有 symbols/callgraph 两面；**类型推断、self 属性流敏感分析（KODE-PERF-001 流敏感引擎）、None 诊断、userTypeContract、语义索引全部 TS-only**。这是「Rust 覆盖 TS 功能点」的最大未迁移块。

**B2. def/entity 细粒度分析族（约 27 模块）**
defParser(+WorkerHost)/defChain/defCallChain(+ViewLogic)/defReferenceGraph/defMethodConsistency/defRenamer/definitionSemantics/definitionWorkspaceXml/entitiesXmlAnalysis/entityBuiltinProperties/entityFlowGraph/entityStubRegen/entityWizard/eventIndexTypes/fixedDictMutationDiagnostics/propertyDirectionDiagnostics/propertyCodeLens/propertyInitOrderLens/rpcArgCountDiagnostics/receiverNoneDiagnostics/roleMisuseDiagnostics/spaceNavDiagnostics/timerCleanupDiagnostics/postDestroyDiagnostics/destroyedEntityCaptureDiagnostics/readOnlyWriteDiagnostics/exceptionSourceLocator。
对照：TS lintRuleRegistry 登记 37 条规则，Rust lint 仅 14 条结构规则；**trap 诊断族（rpcArgCount/receiverNone/roleMisuse/timerCleanup/spaceNav/postDestroy/destroyedCapture/readOnlyWrite/fixedDictMutation/propertyDirection/selfAttributeNone）与 callChain/referenceGraph/renamer/semantics 全部 TS-only**（消费入口 src/lintRuleRegistry.ts、src/trapDiagnosticsWiring.ts:161、src/activate/diagnostics.ts，self-contained 不经 Rust）。11-08 未核实清单 #2 已归类：「其余 collection 计算面全 TS」——本文给出模块级清单。

**B3. 残留包装器（1）**：hotReloadDefHash.ts `negotiateEngineDigest` 仍零生产消费（defMd5Check.ts:5 注释坐实「包装器≠接线」）；def/md5 命令链走的是 computeDefMd5InRust，热更引擎摘要协商腿仍未接。

**B4. 纯 TS 形态保真缺口（反向缺口，2026-11-10 走查实锤）**：`$/kode/config/resolve` **无 TS 回退实现**——serverConfigResolve.ts:366-379 `!gate`/`no serverPath` 直接 `ok:false` 不缓存，无 TS 合并臂。后果：纯 TS 通用包里 dbInterface/telnetSummary 恒 null，四个消费模块降级（面板诚实显示「not found」不造假，但能力缺失）：
- playerDataPanel.ts:172 `buildPlayerDatabaseView` → Player Data 出「Database config section not found」而非 DSN（009c Linux 走查困惑点 10 的根因，跨形态行为分歧实锤）；
- telnetService.ts:119-151 → 引擎 telnet 密码/端口自动配置面丢失；
- backend/profileDatabaseConnection.ts → 克隆档案连接派生降级；
- configDerive.ts:200-203 → 派生扫描根数据库面降级。
TS 侧已有合并引擎（serverConfigMerge.ts buildConfigTreePair 树面在纯 TS 包工作），缺的是 dbInterface/telnetSummary 提取的 TS 实现。处置登记 RUST-MIGRATION-AUDIT-007（补 TS 回退 or 文档声明纯 TS 能力边界，待用户定）。

### C. 宿主面（设计如此，不是缺口）

git shell 族（gitRunner/gitHistory/gitRangeTimeline/gitQueryGate 等 7 模块，shell-out git）、进程/连接族（processManager/remoteConnection/remoteProcessList/sshConfig/telnetClient/debugpyPortProbe/pyspyDump/venvDiscovery 等，OS io）、VS Code API 绑定面（task/debug/webview/tree/documentStore/diagnosticScheduler/indexScheduler 调度）、hotReload 传输族（telnet/payload 投递，协议 io）。这些是 io/宿主边界，收编 Rust 无净收益；其**计算核心**（如 hotReloadDefHash/DefStructure 的哈希与结构 diff）属 B 类可议。

## 四、处置建议（登记 todo，待用户点火）

1. **wire 孤儿处置**：`$/kode/wire/encode|decode` 死 RPC——要么给 TS 消费面（协议工具面板），要么从注册面摘除/标注 MCP-only。现状挂在注册面易误导「能力已迁移」。
2. **B3 补接**：negotiateEngineDigest 接入热更链或明确废弃。
3. **B1/B2 收编为分批车道**（大工程，每批单独对拍+切换+回退三面证据，沿 AUDIT-002 纪律）：优先级建议 B2 trap 诊断族先行（与 Rust lint 14 规则同域、输入同 def parse，Rust 已有 kode-parser 底座），B1 python 语义族次之（kode-python 需新增类型推断/流敏感面，跨度最大）。
4. 本矩阵只证接线不证行为对等；B 类收编每批必须对拍（沿 tests/defAnalyzerRustParity.test.ts / dependencyGraphParity.test.ts 先例）。

## 五、未验证（如实）

- 本文静态接线审计，未跑真实二进制对拍（A 类行为对等由 11-08 矩阵 #4 已收口的对拍面背书）。
- B 类规模按文件清点（22+27+1），「模块=功能点」粒度；单模块内多诊断面未逐一展开（13 诊断集触发面已在 11-08 #2 逐一核实）。
