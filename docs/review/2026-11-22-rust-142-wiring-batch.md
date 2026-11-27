# RUST-142 批 3:诊断管线生产接线(脏文档 → 四层核 → 主 collection)

2026-11-22。kode2 LSP 族 Rust 收编批第 4 条(批 3 生产接线)。承接批 1
(诊断调度状态机回放核,`diagnostic_pipeline.rs` 四族独立节流)与批 2
(分级装配决策核 `diagnostic_layering.rs`:15 码税表 → 四层路由 → 合流)。
> 更新 2026-11-28:CREATE-05 接线批把税表扩到 18 码(.py 面 creation-API params 三码:celldata-not-dict 入 localSyntax;undeclared/type-suspicious 入 semantic),本文其余为批时点记录不改写。
本批把管线接到**生产** didOpen/didChange/didClose 与 LSP 诊断主面。

## 交付面

- **发射面(脏集 + 预算切片)**`crates/kode-server/src/server.rs`:
  - `ServerState` 增 `diagnostics_pipelines`(四层 `LayeredSchedulers`)+
    `diagnostics_dirty: BTreeMap<String, i64>`(uri → 最新版本)。
  - `handle_did_open` / `handle_did_change` 各在索引侧同刻标脏(uri → 版本);
    `handle_did_close` 摘脏 + 四层 `release_document`。
  - `flush_diagnostics_pipeline(state, deadline)`(主循环空闲 tick 调):
    按 `DIAGNOSTIC_FLUSH_MAX_DOCS`(8)+ 墙钟界(`DIAGNOSTIC_FLUSH_BUDGET_MS`=16ms)
    **双界切片**,界外余量原样回脏集由后续 tick 追平。每脏文档经
    `open_buffer` → `analyze_def_with_python`(已知类型集取 `hover.type_context()`
    实体∪自定义;`PythonParityInput::default()` 零产出)→ `route_findings`
    → 每非空层 `core(layer).request(uri, version, TaskSpec{items: 桶下标…})`。
    发射面 = 层核 sink 的「本 flush 已请求 (layer, uri) 最新记录」——
    换代旧 items 不虚报(批 1 语义);跨 flush 旧记录因「本 flush 未请求」
    被跳过,不重放。
  - 通知 `$/kode/publishDiagnostics`(非标准 LSP,自定义 method):
    `{uri, version, layer, findings}`,findings 为 `Finding`(camelCase,
    check/code/severity/line/offset+length/name?/message/range/related?)。
- **泵接线**`crates/kode-server/src/main.rs`: `flush_diagnostics` 只在
  **空闲 tick**(`RecvTimeoutError::Timeout` 臂)调起,与索引 flush 同刻;
  帧(chunk)臂零调用——RESP-001 验收实测,见坑账。
- **消费面(TS 生产)**:
  - `src/backend/kodeCoreClient.ts`: client 级 `onNotification` 选项 +
    `setNotificationHandler` 后置装配(client 懒建,handler 必须可后设);
    `dispatchMessage` 把非响应消息按 `method` 派给 handler。
  - `src/backend/kodeCoreGate.ts`: gate 级 `setNotificationHandler`
    (记 handler + 透传已建 client);`ensureClient` 建 client 后即挂 handler。
  - `src/languageProviders/validation.ts`: `applyRustDiagnosticsPush(params,
    diagnostics, textDocuments)` —— 只吃 `localSyntax` 层且 `version` 为数;
    按 `doc.uri.fsPath` 定位文档(生产镜像 `shadowMirrorCorpusDocument` 发
    fsPath 原串);`document.version !== params.version` 丢弃(与 pull 腿同
    护栏);归并复用 `mergeRustDefFindings`(position-key 去重,同步面重置
    由 `validateDocument` 承担——空 findings 不重入)。
    `wireDiagnosticsPush(gate, diagnostics, () => vscode.workspace.textDocuments)`
    按 method 分叉(`$/kode/publishDiagnostics` 才解析)。
  - `src/activate/diagnostics.ts`: 主 collection 建后即
    `wireDiagnosticsPush(getKodeCoreShadowGate(), …)`(gate 于 L0
    `setupKodeCoreGate` 先于 L3 `activateDiagnostics` 存在)。

## 诚实边界(登记,不冒充)

- **仅 `localSyntax` 真接**——它是唯一有真实 Rust 发现源的族(15 码 lint);
  `semantic` / `engineCompat` / `runtimeConfig` 的**真占员**尚在各自家族
  车道(semantic 待家族规则、engineCompat = def md5 兼容面、runtimeConfig =
  configContract 族),批 2 已登记:三座位是目标设计面,家族迁移由 TS 装配
  批翻表 + 双侧 golden 重生成。消费面 `applyRustDiagnosticsPush` 对异层
  直接 return,三族归各自车道,零冒充。
- **C-19(def↔Python 一致性)留在 TS pull 腿**:`def-method-missing-in-python`
  需要 TS 侧 `collectDefPythonParityInput`(盘读 Python)——push 面以缺省
  parity 输入跑(零产出),诚实边界:C-19 仍走 `observeRustDefFindings` 拉腿,
  本面不重复发射(push/pull 经 `mergeRustDefFindings` 位置键去重,不双报)。
- **knownTypes 对账不必**:仅 `unknown-type-reference` 依赖 knownTypes,且
  已排除在 `RUST_LIVE_MERGE_CODES` 外;push 用 `hover.type_context()`
  (entity_types + custom_types)作已知集,与 golden dump 同口径。

## 坑账

- **RESP-001 回归(本批最大坑)**:首版 `flush_diagnostics_pipeline` 一次
  **排空全量脏集**——resp001 风暴(30×~200KB didOpen)后首个空闲 tick 对
  30 脏文档各跑一遍 lint(不可抢占),主循环阻塞数秒,health/hover 回合被
  逐片排队。实测 `health p99 超护栏: n=20 p99=3388ms`(全量套件并行口径),
  与「帧路径不跑 ingest」同族根因——**单任务超支不可抢占,切片时间界才
  约束得了响应时间**。修复 = 同 `pump_budgeted_until` 双界(条数 + 墙钟),
  界外余量回脏集;resp001 三连绿(p99 恢复 ~20ms 级)。教训:任何主循环上
  的不可抢占批处理必须带墙钟界,只按条数界不够。
- 帧路径(chunk 臂)不跑诊断 flush(RESP-001 实测同因):与 ingest 同口径
  登记在 `main.rs` 注释。

## 判例

- **budget_slice_keeps_remainder_dirty**:`DIAGNOSTIC_FLUSH_MAX_DOCS + 4`
  脏文档一次切片只消费条数界,界外 4 条原样回脏集(不丢)。
- **did_open / did_change 换版发射**:didOpen v1 → flush 版本 1;didChange
  v2 → flush 版本 2(最新版),换代后仍单条 missing-flags。
- **version_bump_to_clean_def_emits_nothing**:v1 缺 Flags 出 1 条,v2 补
  Flags 零通知(同步面重置由 TS 承担)。
- **空脏集零发射** + **didClose 摘脏并释放四层**。
- TS 消费面:`wireDiagnosticsPush` 只按 `$/kode/publishDiagnostics` 分叉;
  版本不符/文档关闭/version 非数/异层 → 零触碰;空 findings 不重入。

## 门禁

- `cargo test -p kode-server -- --test-threads=1`:**1527 绿 / 0 红**
  (串行口径;dispatch 并行假红判例见记忆)。
- `cargo clippy -p kode-server --all-targets` 0(修两处 `i64::from` 同型无用
  转换——didOpen/didChange 的 `text_document.version` 本就是 `i64`)。
- `npx tsc --noEmit -p tsconfig.json` 0。
- `npx vitest run tests/perfCallChainDoc.test.ts tests/kodeDiagnosticsPush.test.ts`:
  2 文件 10 测试绿(锚点锁步后真位验证)。
- **锚点锁步**(判例:本批插行致 perfCallChainDoc 承重锚点漂移,按
  真位重探 + baseline 锁步修复)——diagnostics.ts 打点锚 +1(顶部 import,
  wire 装配块在锚后)、validation.ts validateEntitiesXmlDocument 265→329、
  'entities-analysis' 缓存 278→342(+64,推送消费面块在锚前);
  `docs/perf/2026-baseline.md` §7 出处同刻锁步。
- **并发会话两轮重基锚点累计**(2026-11-22):QA-001a +9 → QA-001b +9
  (proxySession 导入块 +6 与两处接口条目 +3)+ 本批 +1 → 两处打点锚
  216/229 累计 **+19 至 235/248**(真位重探,非累加算术——以合并树实际
  `grep -n` 为准);validation.ts 329/342 未受 QA-001b 影响(真位复核);
  `docs/perf/2026-baseline.md` §7 CALC 出处与注记同刻锁步至 235/248。
- **全量 `npx vitest run --coverage` 满载抖动族归因**(两轮,负载 25-80/14 核):
  - 轮 1:12305 绿 / 4 红——globalDataIndex.lifecycle AUD-076、indexGapsE2e
    RUST-133、selfAttributeNoneDiagnosticsPerf KODE-PERF-002、
    typeStorageColdBuildPhased IDE-REV-013。
  - 轮 2:12306 绿 / 3 红——globalDataIndex.lifecycle AUD-076、
    kodeCoreE2E CORE-015/016(SIGKILL respawn)、selfAttributeNoneDiagnosticsPerf。
  - 判据:**两轮受害者集不同**(6 个唯一文件,仅 2 重叠)、全部受害者
    **单跑全绿**(两轮各 71/71)、受害者文件**均不在本批 diff**、
    全部为墙钟/spawn/真盘 E2E 型用例、其中 AUD-076 与 KODE-PERF-002
    在本批入树前的会话全量跑中亦为受害者(先例在案)。→ 满载抖动族,
    非本批引入。覆盖率表因套件测试红未 emitted(vitest 配置无硬阈值,
    信息性口径)。

## 余界

四族真占员入表(engineCompat = def md5 族、runtimeConfig = configContract
族)+ TS 生产装配翻表 + C-19 推/拉双腿双面 —— 各归对应家族车道与 TS 装配
批;本批零冒充(诚实边界登记)。todo.md RUST-142 行按批 3 收官勾行。

### 设计裁定收口(2026-11-22,用户令)

用户对批 3a 登记的「TS 生产装配翻表 + 四核独立节流留设计裁定」拍板
**「收编残差,不建抽象」**:TS 四核调度器与 ~19 处 `layer:'local'` 翻表是
「建抽象」,不建;残差即终形 = Rust 侧四层节流(批 1/2 设计,本批生产接线)
+ TS `localSyntax` 薄消费。semantic 三码(批 3a 移入)归各自车道——push 面
被消费面丢弃、pull 腿仍展示,零显示回归。批 3a「不单方定」冲突按此定案,
RUST-142 闭行(载体 9b37c80a + 8377a0cc,均 main)。
