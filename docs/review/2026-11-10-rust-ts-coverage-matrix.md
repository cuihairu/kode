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

Rust 注册面（server.rs 直读；2026-11-10 wire×2 摘除后 20，同日 AUDIT-005 首批 `$/kode/lint/analyzeTraps` 与批 2 `$/kode/lint/analyzeRoleMisuse` 加入后）：**22 个 `$` RPC 方法 + 4 个 LSP 原生面**（hover/completion/definition/diagnostic，handle_hover:382/handle_completion:425/handle_definition:470/handle_diagnostic:507）+ did_open/did_change/did_close 通知。

TS 消费状态（2026-11-10）：

- **生产消费中（20 RPC + 4 LSP 面）**：config/resolve、config/derive、databaseSchema/build、dbClone×5、def/md5、dependency/graph、lint/analyzeDef、lint/analyzeTraps（AUDIT-005 首批 f30348f8，trap 三规则）、lint/analyzeRoleMisuse（AUDIT-005 批 2，KBE-PY-008）、messageTable/build、processTopology/validate、python/callgraph、python/symbols、ruff/lint、sdk/generate、workspace/scanAnchors；LSP 四面经 serveFromRust。
- **判定不切（1）**：apiDocs/lookup（见上表）。
- **已摘注册（2026-11-10 AUDIT-004 ①，bb405936）**：`$/kode/wire/encode`、`$/kode/wire/decode`（零 TS 消费者，kode-mcp 直接复用 wire_codec 库不经 RPC；注册面摘除+handler 删除+RPC 边界烟测清理，库面与 golden 往返测试原样保留）；`$/kode/echo` 保留（TS 测试夹具消费的传输健康探针，rpc.rs 注释已标明非用户功能面）。注册面 22→20。

## 三、功能域覆盖分类（缺口量化）

### A. Rust 已覆盖（计算核心在 Rust，TS 消费/回退）

def 结构分析（14 条 lint 规则：duplicate-definition/missing-type/unknown-type-reference/missing-flags/heavy-sync-broadcast 等，crates/kode-server/src/lint/rules.rs）、消息表构建、依赖图、数据库 schema、克隆五 RPC、进程拓扑校验、python symbols/callgraph、ruff lint、client_sdk 生成、workspace 锚点扫描、config resolve/derive、def 引擎 MD5、语料 hover、LSP 四面。TS 侧保留同源兜底双胞胎（databaseSchemaCore/messageTableEngine+Entity/dependencyGraph.ts/defAnalyzer TS 路径）——**设计如此，非缺口**。

### B. TS-only 计算面 = 真实覆盖缺口（Rust 无对应实现）

按 backend 域 sweep（198 文件中 21 个 Rust-wired，其余为 TS 计算/宿主面），缺口集中在两族：

**B1. Python 语义分析族（约 22 模块，最大缺口）**
pythonParser(+WorkerHost)/pythonClassIndex/pythonLiteralTypes/pythonReturnTypeInference/pythonSelfScope/selfAttributeFlowTypes/selfAttributeNoneDiagnostics/selfPropertyTypeInference/pythonLexicalMask/pythonRoleRoots/pythonScanRules/pyreflyInfer/defPythonParity/inferredEnrichment/inferredCopy/userTypeContract(+Source)/semanticIndex/globalDataIndexCore(+src/flowVersionKey.ts)。
Rust 侧 kode-python 仅有 symbols/callgraph 两面；**类型推断、self 属性流敏感分析（KODE-PERF-001 流敏感引擎）、None 诊断、userTypeContract、语义索引全部 TS-only**。这是「Rust 覆盖 TS 功能点」的最大未迁移块。

**B2. def/entity 细粒度分析族（约 27 模块；首批 3 模块已收编 2026-11-10 f30348f8，批 2 roleMisuse / 批 2b spaceNav cbdfbd56 / 批 3 receiverNone 772fe666 / 批 4 postDestroy 468d3bb5 / 批 5 readOnlyWrite 04a08277 / 批 6 attributeNone e2760895 均收编 2026-11-10；批 7 propertyDirection 221732c1 收编 2026-11-11）**
defParser(+WorkerHost)/defChain/defCallChain(+ViewLogic)/defReferenceGraph/defMethodConsistency/defRenamer/definitionSemantics/definitionWorkspaceXml/entitiesXmlAnalysis/entityBuiltinProperties/entityFlowGraph/entityStubRegen/entityWizard/eventIndexTypes/fixedDictMutationDiagnostics/propertyCodeLens/propertyInitOrderLens/rpcArgCountDiagnostics/receiverNoneDiagnostics/roleMisuseDiagnostics/spaceNavDiagnostics/timerCleanupDiagnostics/postDestroyDiagnostics/destroyedEntityCaptureDiagnostics/readOnlyWriteDiagnostics/exceptionSourceLocator。
**首批收编（AUDIT-005，f30348f8）：trap 三规则 fixedDictMutationDiagnostics/destroyedEntityCaptureDiagnostics/timerCleanupDiagnostics → `$/kode/lint/analyzeTraps`（crates/kode-server/src/trap_lints.rs 手移植，消息渲染留 TS，Rust-first + 畸形整面作废回退；对拍 tests/trapLintsRustParity.test.ts 真实二进制全量深等 + prove-red 验证）**。
**批 2 收编（AUDIT-005，2026-11-10）：roleMisuseDiagnostics（KBE-PY-008）→ `$/kode/lint/analyzeRoleMisuse`（crates/kode-server/src/role_misuse.rs；共享 python_lexical_mask.rs 掩码 **UTF-16 码元基底**——TS `match.index` 是 UTF-16 码元列、`split('')` 按码元，字节计数对非 ASCII 会越界 panic+漂移，u16 逐码元与 TS 对拍一致；`\bself\.(\w+)(?![\w.])` lookaround 手工展开；Rust 入参 face=TS 解析（目录域优先/def 归属唯一面/歧义非实体 null 零产出），回结构面 code/line/character/length+propertyName/registeredFaces，消息渲染与引擎取证留 TS=renderRoleMisuseMessage+sourceFor 单源；畸形/语义矛盾整面作废回退；对拍 tests/roleMisuseRustParity.test.ts 真实二进制全量深等×三面 + prove-red（破 `(?![\w.])` 恰红 boundaries[baseapp]）+ 兜底六面单测）**。
**批 2b 收编（AUDIT-005，2026-11-10 cbdfbd56）：spaceNavDiagnostics → `$/kode/lint/analyzeSpaceNav`（crates/kode-server/src/space_nav.rs；对拍 tests/spaceNavRustParity.test.ts 真实二进制全量深等 + prove-red + 兜底单测，消息渲染留 TS）**。
**批 3 收编（AUDIT-005，2026-11-10 772fe666）：receiverNoneDiagnostics → `$/kode/lint/analyzeReceiverNone`（crates/kode-server/src/receiver_none.rs；guard 全族手移植（正向真值/`is not None`/`not(is None)`/`kbe.isValid`/早退 return|raise/别名+重绑失效/嵌套作用域不跨界/同行 if+三元），UTF-16 码元基底；语义面 TS 供给（方法区间=parsePythonFile、declarations=mapping.methods 投影，零线索不发 RPC 不取解析）；段错配 declared 由 TS 同一 mapping 重算=语义矛盾整面作废；对拍 tests/receiverNoneRustParity.test.ts 真实二进制全量深等（合成 22 样本+fixtures 全部 .py）+ prove-red（破正向守卫分支恰红）+ 兜底八面单测 tests/receiverNoneRust.test.ts；接线 src/activate/diagnostics.ts receiver 臂，不可用/失败/畸形整面回 TS 异步兜底）**。
**批 4 收编（AUDIT-005，2026-11-10 468d3bb5）：postDestroyDiagnostics（KBE-PY-010）→ `$/kode/lint/analyzePostDestroy`（crates/kode-server/src/post_destroy.rs；块/销毁/早退/访问点分析手移植，UTF-16 码元基底；语句面 TS 供给=pythonStatements 掩码拼接文本原样直传，行掩码=pythonCodeLines 等价移植（引号态跨行/反斜杠双格/f-string 整段掩码，与 mask_python_non_code 语义不同）；面/动态分派闸在 TS 装配面短路，declared Rust 防线保留；对拍 tests/postDestroyRustParity.test.ts 真实二进制全量深等（合成 18 样本+fixtures 全部 .py，首跑即绿）+ prove-red（破 same_block 恰红）+ 兜底十面单测 tests/postDestroyRust.test.ts；接线 src/activate/diagnostics.ts postDestroy 臂）**。
**批 5 收编（AUDIT-005，2026-11-10 04a08277）：readOnlyWriteDiagnostics（IDE-LINT-007 只读内建属性写入）→ `$/kode/lint/analyzeReadOnlyWrite`（crates/kode-server/src/readonly_write.rs；掩码扫描+写入形态分类全族手移植（assign/augmented 两字+三字 ops/annotated 顶层=判定/套件冒号左扫右到左括号深度配对 13 复合关键字/del 整词+attr-chain 与下标先排除），UTF-16 码元基底，starts_with 手工逐码元 walk（复用 postDestroy `Iterator::eq` 等长陷阱教训，eq_u16 加长度闸）；语义闸 TS 供给 readonlyNames=face 表 readonly 名集，引擎属性表单一来源留 TS；renderRustReadOnlyWriteItems 逐字段校验+resolveEntityBuiltinPropertyHit 重解析完整性校验（未命中/非只读=矛盾整面作废）；非实体合法空面 [] 不发 RPC；对拍 tests/readOnlyWriteRustParity.test.ts 真实二进制全量深等（合成 19 样本+fixtures 全部 .py，首跑即绿；非实体短路对齐生产装配序）+ prove-red（破 assign 分类恒 None 恰红 2 例）+ 兜底十面单测 tests/readOnlyWriteRust.test.ts；接线 src/activate/diagnostics.ts readOnlyWrite 臂，不可用/失败/畸形整面回 TS 兜底）**。
**批 6 收编（AUDIT-005，2026-11-10 e2760895）：selfAttributeNoneDiagnostics（LANG-NAR-1 自管属性可能 None）成员扫描面 → `$/kode/lint/analyzeAttributeNone`（crates/kode-server/src/attribute_none.rs；**分工=词法面在 Rust、流敏感证据留 TS 单一来源**——入参 text 为 TS 预掩码文本，Rust 只做 `\bself.<attr>.<member>` 手工展开+内建 receiver 跳过+行列计算（UTF-16 码元基底；greedy attr 回溯无效证明；成员列逐字对齐 TS `match[0].indexOf(member)` 首次出现语义），流引擎 inferSelfAttributeFlow（类型推断/守卫窄化）不收编归 B1 车道；renderAttributeNoneRustItems 逐字段校验+流证据 (行,属性) 记忆化裁定（窄化剔除但面合法，内建漂移整面作废）；原文零 `self.` 线索短路不发 RPC；对拍 tests/attributeNoneRustParity.test.ts 真实二进制全量深等（合成 13 样本+fixtures 全部 .py，首跑即绿；versionKey 每样本唯一防流解析缓存撞键）+ prove-red（破内建跳过恰红 2 例）+ 兜底十面单测 tests/attributeNoneRust.test.ts；接线 src/activate/diagnostics.ts attributeNone 臂，versionKey 直传 KODE-PERF-001 版本键控解析缓存）**。

**批 7 收编（AUDIT-005，2026-11-11 221732c1）：propertyDirectionDiagnostics（GEN-DEF-1e ④ 方向违规 + 2026-11-10 影子/cellData 两流）词法三扫描束 → `$/kode/lint/analyzePropertyDirection`（crates/kode-server/src/property_direction.rs；**分工=词法三扫描束在 Rust、判定核/def 解析/消息渲染留 TS 单一来源，两流完整保留**——入参 text 为**原文**（无掩码，本批三扫描全在原文）；① `self.<path>` 访问（后缀算术列）② `def __init__` 赋值+RHS cellData 键（TS `split('\n')` raw 视图；**`(.*)$` 尾锚语义=携尾 \r 行整匹配失败——crlf 对拍抓出的真分歧**）③ cellData 键访问（`split(/\r?\n/)` stripped 视图，末行孤尾 \r 保留；**JS `\s` 全类**含 NBSP/全角空格；indexOf 首现语义）；TS 面 propertyDirectionDiagnostics.ts 重铸为扫描束驱动（`PropertyDirectionScanBundle`+`scanBundleOf` 本地束缺省，判定核与兜底同一份），两个消费面（diagnostics.ts propertyDirection 臂 + inlay.ts KBEnginePropertyShadowInlayHintsProvider）Rust-first 束供给，零线索合法空束不发 RPC，畸形整面作废回本地扫描束；对拍 tests/propertyDirectionRustParity.test.ts 真实二进制全量深等（**束面五份 Set/Map 结构等 + 判定核两流一次全覆盖**，合成 19 样本+fixtures 全部 .py）+ prove-red（破尾锚语义恰红 crlf-corpus 2 例）+ 兜底八面单测 tests/propertyDirectionRust.test.ts）**。
对照：TS lintRuleRegistry 登记 37 条规则，Rust lint 14 条结构规则 + trap 4 条；**trap 诊断族其余 1 条（rpcArgCount；同步 compute 缝需调度形态手术，延批 3）与 callChain/referenceGraph/renamer/semantics 仍 TS-only**（消费入口 src/lintRuleRegistry.ts、src/trapDiagnosticsWiring.ts:161、src/activate/diagnostics.ts，self-contained 不经 Rust）。11-08 未核实清单 #2 已归类：「其余 collection 计算面全 TS」——本文给出模块级清单。

**B3. 残留包装器（1）→ 已接线（2026-11-10 AUDIT-004 ②，768f4c81）**：`negotiateEngineDigest` 接入 def/md5 核查链——DefMd5CheckOutcome 携带 handshake（Rust 重算出 workspaceMd5 即协商为 md5/已协商；Rust 不可用退 unknown/未协商），报告增「Digest 协商」逐行可断言行；unknown 恒拒绝与客户端 sha256 互比（compareEngineDigest 闸门语义不变）。

**B4. 纯 TS 形态保真缺口（反向缺口，2026-11-10 走查实锤，同日实机证实）**：`$/kode/config/resolve` **无 TS 回退实现**——serverConfigResolve.ts:366-379 `!gate`/`no serverPath` 直接 `ok:false` 不缓存，无 TS 合并臂。后果：纯 TS 通用包里 dbInterface/telnetSummary 恒 null，四个消费模块降级（面板诚实显示「not found」不造假，但能力缺失）。**实机证据（2026-11-10 15:01-15:35 imac Windows 纯 TS 包腿，~/pa007-evidence/009c-windows-purets-report.md）**：Player Data 逐字显示 `No dbmgr/databaseInterfaces/default section found in the engine kbengine.xml / kbengine_defaults.xml.`（pt_05）而非 DSN，与静态审计预判一致；纯 TS 证认同腿完成（日志 rust 零命中/无二进制/backend 默认 ts）。
- playerDataPanel.ts:172 `buildPlayerDatabaseView` → Player Data 出「Database config section not found」而非 DSN（009c Linux 走查困惑点 10 的根因，跨形态行为分歧实锤）；
- telnetService.ts:119-151 → 引擎 telnet 密码/端口自动配置面丢失；
- backend/profileDatabaseConnection.ts → 克隆档案连接派生降级；
- configDerive.ts:200-203 → 派生扫描根数据库面降级。
TS 侧已有合并引擎（serverConfigMerge.ts buildConfigTreePair 树面在纯 TS 包工作），缺的是 dbInterface/telnetSummary 提取的 TS 实现。处置登记 RUST-MIGRATION-AUDIT-007（补 TS 回退 or 文档声明纯 TS 能力边界，待用户定）。

### C. 宿主面（设计如此，不是缺口）

git shell 族（gitRunner/gitHistory/gitRangeTimeline/gitQueryGate 等 7 模块，shell-out git）、进程/连接族（processManager/remoteConnection/remoteProcessList/sshConfig/telnetClient/debugpyPortProbe/pyspyDump/venvDiscovery 等，OS io）、VS Code API 绑定面（task/debug/webview/tree/documentStore/diagnosticScheduler/indexScheduler 调度）、hotReload 传输族（telnet/payload 投递，协议 io）。这些是 io/宿主边界，收编 Rust 无净收益；其**计算核心**（如 hotReloadDefHash/DefStructure 的哈希与结构 diff）属 B 类可议。

## 四、处置建议（登记 todo，待用户点火）

1. **wire 孤儿处置 → 已完成（bb405936）**：`$/kode/wire/encode|decode` 从注册面摘除（零消费者，kode-mcp 走库不走 RPC）；echo 保留并在 rpc.rs 标明「测试/传输健康探针，非用户功能面」。
2. **B3 补接 → 已完成（768f4c81）**：negotiateEngineDigest 接入 def/md5 核查链（见 §B3）。
3. **B1/B2 收编为分批车道**（大工程，每批单独对拍+切换+回退三面证据，沿 AUDIT-002 纪律）：优先级建议 B2 trap 诊断族先行（与 Rust lint 14 规则同域、输入同 def parse，Rust 已有 kode-parser 底座），B1 python 语义族次之（kode-python 需新增类型推断/流敏感面，跨度最大）。**B2 首批已落地（2026-11-10 f30348f8）：trap 三规则（fixedDictMutation/destroyedEntityCapture/timerCleanup）→ `$/kode/lint/analyzeTraps`，对拍+切换+回退三面齐（tests/trapLintsRustParity.test.ts + trapDiagnosticsWiring.test.ts）；批 2 已落地（2026-11-10）：roleMisuse → `$/kode/lint/analyzeRoleMisuse`（tests/roleMisuseRustParity.test.ts + roleMisuseDiagnostics.test.ts 兜底六面），B2 剩余约 23 模块续批**。
4. 本矩阵只证接线不证行为对等；B 类收编每批必须对拍（沿 tests/defAnalyzerRustParity.test.ts / dependencyGraphParity.test.ts 先例）。

## 五、未验证（如实）

- 本文静态接线审计，未跑真实二进制对拍（A 类行为对等由 11-08 矩阵 #4 已收口的对拍面背书）。
- B 类规模按文件清点（22+27+1），「模块=功能点」粒度；单模块内多诊断面未逐一展开（13 诊断集触发面已在 11-08 #2 逐一核实）。
