# kode-db-clone — 能力边界与克隆全链路

> 本页是玩家数据克隆核心 crate 的**权威口径页**。以下每条能力均以
> `crates/kode-db-clone/src/` 实际源码为准，附 `file:line` 依据；设计口径见
> [docs/design/v0.2.1-player-data-clone-plan.md](../design/v0.2.1-player-data-clone-plan.md)
> （下称「计划书」）。同目录姊妹页：[引擎侧事实取证 source-evidence](/player-clone/source-evidence)
> （引擎持久化事实取证）、[运维与安全 ops-and-security](/player-clone/ops-and-security)
> （运维、敏感数据、留存销毁）。计划书中有而**未落地**的能力一律如实列出——本文不含愿景式表述。

## 1. 这是什么

`crates/kode-db-clone` 是计划书 §3 架构落地的 Rust 核心，为**自包含 crate、不依赖
kode-server**（def 推导的表结构以数据形态接入，接线只是机械字段映射——`lib.rs:1-7`）。
一句话：把**已持久化的玩家实体数据**从一个已授权的源 MySQL 库，经规划、脱敏、加密、
可审计的归档，克隆进 local/test 的目标 MySQL 库。

计划书 §3 组件名与实际模块的对应：

| 计划书 §3 组件 | 实际模块 | 入口 |
|---|---|---|
| SchemaResolver | `schema.rs` + `wire.rs` + `information_schema.rs` | `SchemaResolver::resolve` `schema.rs:171`；wire 接入 `CloneSchema::from_derivation` `wire.rs:51` |
| RelationGraph | `relations.rs` | `RelationGraph::build` `relations.rs:63` |
| ExportPlanner | `planner.rs` | `ExportPlanner::plan` `planner.rs:96` |
| ExportExecutor | `reader.rs` | `SourceReader::export` `reader.rs:144` |
| ArchiveCodec | `archive.rs` + `keystore.rs` + `redact.rs` + `value.rs` | `write_archive` `archive.rs:697` |
| ImportPlanner | `import.rs` + `idmap.rs` + `target.rs` | `ImportPlanner::plan` `import.rs:198` |
| ImportExecutor | `apply.rs` | `ImportApplier::apply` `apply.rs:234` |
| ImportValidator | `apply.rs`（Verify 期） | 提交后 `SELECT COUNT` 复核 `apply.rs:488` |

## 2. 克隆全链路

```text
源 MySQL（只读）                                  目标 MySQL（仅 local/test）
   │                                                     ▲
   ▼                                                     │ 单事务
[1 定结构] → [2 规划] → [3 只读导出] → [4 脱敏+加密归档] → [5 导入规划] → [6 事务写入+复核]
 wire.rs /        planner.rs    reader.rs    archive.rs    import.rs        apply.rs
 information_     relations.rs               keystore.rs   idmap.rs         （ID 回填）
 schema           rules.rs                   redact.rs     target.rs
 schema.rs
```

### 环节 1 — 结构解析（派生↔物理双面校验）

- def 推导的表结构以 kode-server `$/kode/databaseSchema/build` 的 camelCase JSON
  形态输入，机械转换为 `CloneSchema`（`wire.rs:51`）；只取计划所需字段，展示元数据
  忽略（`wire.rs:1-7`）。
- 物理侧经只读 TABLES/COLUMNS/STATISTICS 查询读 `information_schema`
  （`information_schema.rs:60-83`，行组装 `read_all` `information_schema.rs:93`），
  包装为 `PhysicalSchema`（`information_schema.rs:88`）。schema 名以引号字符串字面量
  比对，不作标识符（`information_schema.rs:60-83`）。
- `SchemaResolver::resolve`（`schema.rs:171`）fail-closed：类型规范化不一致 →
  `DriftMismatch`；非 InnoDB 拒绝；物理独有、未在派生侧的表（如 `kbe_*`）进
  `denied`（`DeniedTable` `schema.rs:156`），不猜测。

### 环节 2 — 导出规划（只读 SELECT 计划，零 I/O）

- `RelationGraph::build`（`relations.rs:63`）按引擎 `parentID` 约定建子表边，
  `topological_order`（`relations.rs:112`）保证父先子后；有环即拒。关系类别对齐
  计划书 §4.2 A–E（`RelationKind` `relations.rs:14`）：引擎生成 / 外键（预留；引擎
  DDL 无外键）/ 项目显式声明 / 未明（pickle blob，不触碰）/ 外部（`kbe_*`，排除）。
- `ExportPlanner::plan`（`planner.rs:96`）逐表产出参数化 SELECT：根表
  `WHERE id = ?`、子表 `WHERE parentID = ?`（`planner.rs:40-42`，渲染在
  `planner.rs:223-240`）。列投影恒保结构列（`RuleSet::project` `rules.rs:76`）；
  业务关系仅按显式规则 Follow/Skip/Error（`rules.rs:93`、`RelationRuleAction`
  `rules.rs:12`）。行数估计超预算 → `BudgetExceeded`（`planner.rs:173`）诚实拒绝，
  不静默截断。`DryRun`（`planner.rs:72`）与计划同路径、零 I/O。

### 环节 3 — 源库只读导出

- 源执行器是 `ReadOnlyExecutor` trait（`reader.rs:34`），**根本不存在 DML 方法**；
  `validate_readonly`（`reader.rs:42`)再做语句白名单（放行
  SELECT/SHOW/DESCRIBE/EXPLAIN 与会话/事务控制）——双防线。
- 导出（`reader.rs:144`）先 `SET SESSION TRANSACTION READ ONLY`（`reader.rs:158`），
  再开一致性快照事务（`START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`，
  驱动不支持时回退 5.x 形态，`reader.rs:161-166`），按计划 DFS 父先子后遍历
  （`walk` `reader.rs:206`）。行/字节/墙钟预算（`ExportBudget` `reader.rs:69`）与
  取消旗标（`ExportControl` `reader.rs:87`）逐行检查；任何错误路径回滚快照事务。
- 行按有类型值编码，保留 NULL / 有符号 / 无符号 / 64 位 / 浮点 / decimal /
  二进制（十六进制）/ datetime（`TypedValue::parse` `value.rs:48`、`TypedRow`
  `value.rs:40`），64 位 id 与 DECIMAL 精确往返不丢。

### 环节 4 — 脱敏与加密归档

- 列敏感度按关键词分类（`SensitivityPolicy::classify` `redact.rs:46`）：凭据列掩码为
  `***`（`redact.rs:82`），个人敏感列只留首尾，日志中凭据形 `key=value` 一并掩掉
  （`redact_log` `redact.rs:92`）。`RedactingSink`（`redact.rs:152`）位于导出与归档
  之间，产出 `RedactionReport`（`redact.rs:249`）。
- 密钥独立存 `FileKeyStore`，0600 权限写盘（`keystore.rs:42`、`keystore.rs:100`）；
  密钥目录落在归档内即拒绝（`ensure_key_outside_archive` `keystore.rs:111`）。
- 归档为帧式容器：魔数 `KDPCLONE1` + 版本 + 标志位（`archive.rs:36`）；每帧含帧名、
  nonce、明文字节长、明文 SHA-256 与（可选）chacha20poly1305 密文，帧头整体作 AEAD
  关联数据（`archive.rs:3-7`）。逻辑文件为 `manifest.json`（最后写入——截断即缺清单，
  `archive.rs:292`）、`data/<表>.rows.jsonl`、`relations.json`、
  `redaction-report.json`、`checksums.json`。写入走临时文件 + `sync_all` + 原子
  rename；`Drop` 清场半成品（`archive.rs:345`）。`write_archive`（`archive.rs:697`）
  是「只读→脱敏→归档」一站式入口；`Archive::open`（`archive.rs:364`）复验
  魔数/版本/大小上限/解密/逐帧 SHA/帧集与清单互核/逐表校验和；`Archive::inspect`
  （`archive.rs:406`）只读元数据、不展示行值。

### 环节 5 — 导入规划（Prepare 期，不触库）

- 目标先过静态闸：`TargetEnvironment::from_str` 只认 `local`/`test`，
  `prod`/`staging` 与一切未知拼写 fail-closed 拒绝（`target.rs:22`）；
  `TargetProfile::validate_for_import`（`target.rs:66`）再要求接口 `mysql` 且显式
  声明可写。
- `ImportPlanner::plan`（`import.rs:198`）先校验归档表 ⊆ 目标已解析表、行宽 = 投影
  列数、逐值类型相容（`import.rs:219-262`），再生成计划。
- 分遍执行：**种子遍**先落全量主键分配/保留账并解决唯一键冲突（`import.rs:365`）；
  冲突值重建为 `{原值}_{seed}{n}`，对「目标已有 ∪ 归档内 ∪ 已重建」三方占位探测
  （`import.rs:403`、`rebuild_unique` `import.rs:646`）；**引用遍**登记 `parentID`
  与 Follow 规则引用（`import.rs:445`）；**渲染遍**只读查账本产出语句
  （`import.rs:565`）——引用到未克隆的父行即 fail-closed。
- 类型化映射账本 `IdMap`（`idmap.rs:151`）以（物理表, 主键列, 旧值）三元组为键
  （`IdMapKey` `idmap.rs:57`）防跨表串改，三去向：`Allocated` 占位 / `Preserved` /
  `Rebuilt`（`MappedId` `idmap.rs:103`）。语句单元格共六种显式去向
  （`PlannedCell` `import.rs:103`）；语句全 `?` 参数化。`AccountBindingPlan`
  （`import.rs:148`）如实报告：无绑定规则时克隆角色对本地登录账号不可见。

### 环节 6 — 事务写入、复核与 ID 映射回填

- `ImportApplier::apply`（`apply.rs:234`）复核目标三闸后过重复指纹闸：归档清单字节
  求 SHA-256（`archive_fingerprint` `apply.rs:220`），同指纹默认 `DuplicateRejected`，
  显式 `allow_duplicate` 才放行（`apply.rs:247-252`）。
- 单事务内（`begin → 按 plan 序逐句 → commit`，`apply.rs:321`）：`NewKey` 单元格绑
  NULL 交 MySQL AUTO_INCREMENT 分配；真实 last-insert id 回填 `resolved_ids`，后续
  `KeyReference` 单元格绑真值——这就是 **ID 映射回填**。执行器错误先回滚再上抛
  （`apply.rs:308`）；`fail_at_statement` 注入面仅供测试（`apply.rs:267`）。
- 提交后逐表只读复核 `SELECT COUNT(*) ... WHERE id IN (...)`（`apply.rs:488`），
  结果进 `VerifyReport`（`apply.rs:142`），失败如实报错。全量 `ImportRun` 审计
  （`apply.rs:189`）记录逐表计数、占位→真值映射、绑定结果、复核与 `CleanupPlan`
  （`apply.rs:172`）——逆拓扑序参数化 DELETE 计划，**只生成、永不执行**
  （`apply.rs:495`）。引擎加载验证由 `LoadVerification`（`apply.rs:150`）承载，
  crate 内如实记 `attempted = false`（见 §3）。

## 3. 能力边界 — 已落与未落

### 3.1 库面无 MySQL 驱动依赖

`crates/kode-db-clone/Cargo.toml` 的 `[dependencies]` 只有
`serde` / `serde_json` / `sha2` / `chacha20poly1305` / `getrandom`。crate 自身不开
socket：源读全走 `ReadOnlyExecutor` trait（`reader.rs:34`），写全走 `WriteExecutor`
（`apply.rs:35`），物理结构读走 `RowSource`（`information_schema.rs:18`）。`mysql`
crate 与 `testcontainers` 只是 **dev-dependencies**，仅供 Docker 门控的集成测试使用。
真实连接装配在 crate 之外：

- server 桥：`crates/kode-server/src/db_clone.rs` 注册 5 个 RPC
  `$/kode/dbClone/{inspectArchive,planExport,export,planImport,readArchiveRows}`
  （`db_clone.rs:40-44`）；
- VS Code 侧：TS mysql2 单事务执行器（`src/playerDataCloneMysql.ts`）与命令/profile
  层（`src/playerDataCloneCommands.ts`、`src/playerDataCloneProfiles.ts`），见
  [ops-and-security（运维与安全）](/player-clone/ops-and-security)；
- 真库演练：仅 `tests/mysql_real.rs`，`#[ignore]` + `KODE_DB_CLONE_MYSQL=1` +
  运行中的 Docker 三重门控（`mysql_real.rs:6-8`、`mysql_real.rs:474`、
  `mysql_real.rs:485`）。普通 `cargo test` 永不触库。

### 3.2 计划书条目 — 已落 / 如实阻塞对照

已落（计划书 §9 已勾 44/53 条）覆盖 Phase 1–4 全核心：结构/关系/规划（`PDC-01xx`）、
导出归档（有类型行、流式归档+SHA-256、脱敏、加密、损坏校验）、导入规划/写入
（目标闸、ID 账本、唯一键重建、单事务、复核、清理计划）、VS Code 命令面
（`PDC-05xx`）、测试矩阵（`PDC-06xx`，含归档加密接线 `PDC-0608` 与导出加密开关
`PDC-0609`）。

明确**未落**、且各处均如实标注：

- `PDC-0003` — 在真实测试 MySQL 里让引擎自动建表、锁定 Golden Schema；阻塞于无
  Linux 编译引擎服务端（计划书 460 行，仍未勾）。在此之前，引擎事实以
  [source-evidence（引擎侧事实取证）](/player-clone/source-evidence) 的引擎源码取证与 testcontainers 夹具为准。
- `PDC-0007` — `fixtures/` + Golden Schema 交付件中依赖 `PDC-0003` 的部分
  （计划书 491 行；`source-evidence.md` 一半已交付）。
- `PDC-0407` — 引擎原生加载验证：`LoadVerification` 形态已落（`apply.rs:150`），
  但 crate 内恒记 `attempted = false`；接线需要与 `PDC-0003` 同因的引擎实例
  （计划书 698 行）。
- 验收矩阵 #4（FIXED_DICT 引擎对拍）、#11（非事务表层闸）、#13（本地服务进程探测）
  按同因如实记未接线（todo.md `CLONE-P6`）。
- 计划书尾部「接线引擎侧原生加载验证」（计划书 800 行）未做。

账本备注：计划书文本中 `PDC-0201..0207` 仍为未勾，而 todo.md（`CLONE-P2`）记录这些
crate 侧能力已落地；本页以源码为准描述能力，file:line 见上。

### 3.3 非目标（沿计划书 §1.2 不变）

不读在线 BaseApp/CellApp 内存快照、不调 `writeToDB()` 强制存档、不自动克隆共享业务
实体（公会/邮件/好友）、不做引擎迁移、不向生产库写入、不提供 SQL 编辑器、不做账号
impersonation。

## 4. 为什么叫 db-clone

名字就是字面义：克隆**数据库里的玩家数据**——KBEngine 服务器已持久化到 MySQL 的那些
行——从源库到目标库。它**不是**通用数据库工具：没有 SQL 编辑器、没有通用查询浏览器、
不做跨引擎 schema 迁移、库面也没有 MySQL 驱动（§3.1）。它做的一切都被 def 推导的表
结构与计划书导出范围框住：一个持久化实体（根 DBID）及其引擎推导子表。用户侧入口是
`kbengine.clone.*` 命令族与只读的玩家数据面板——查询面与导入面刻意分离。

## 5. 测试面

| 套件 | 用例数 | 锁定内容 |
|---|---|---|
| `tests/golden_plan.rs` | 2 | 代表性 Avatar：黄金表序、列清单、SQL 逐串、预算 within/exceeded、denied 表含原因 |
| `tests/golden_import.rs` | 1 | 归档→导入计划黄金断言：父先子后、占位共享、`hero → hero_imported1` 重建、绑定告警、JSON 可审计 |
| `tests/golden_apply.rs` | 4 | 单事务形状、占位回填（`parentID` = 真实 id）、重复指纹拒绝/显式副本、失败注入→全量回滚恰好一套数据、执行日志零 DELETE |
| `src/*.rs` 单测 | 92 | 各模块不变量（归档 round-trip、无钥/错钥拒、idmap 排序、规则校验、目标闸、wire 解析等） |
| `tests/hardening.rs` | 12 | 单字节篡改、截断、载荷篡改、深父链、深环、30 万行规模、预算 fail-closed、预取消/超时导出、路径怪名归档 |
| `tests/fuzz.rs` | 10 | 随机归档输入永不危险打开 |
| `tests/perf.rs` | 4 | 30 万行导出/导入时限内 |
| `tests/security.rs` | 4 | fail-closed 路径（只读违规、prod 目标、密钥处理） |
| `tests/platform.rs` | 3 | 跨平台路径/权限行为 |
| `tests/error_display.rs` | 2 | 用户可读错误文案 |
| `tests/mysql_real.rs` | 2（`#[ignore]`） | 真实 MySQL 8.0/5.7 testcontainers 往返：information_schema 解析、只读导出、含真实 AUTO_INCREMENT/回滚的事务导入——仅 `KODE_DB_CLONE_MYSQL=1 cargo test -p kode-db-clone --test mysql_real -- --ignored` 时运行 |
