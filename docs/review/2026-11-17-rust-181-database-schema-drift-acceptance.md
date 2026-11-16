# RUST-181 验收纪要:数据库 schema 视图/drift 与语义 Core 相连,DB driver/SQL 走独立隔离面

日期:2026-11-17。本纪要对账 RUST-181(旧 KBE-011,主 todo 排队项)的验收口径与既有交付证据,并补齐命名钉。结论:**语义 Core 连接与 driver 隔离均已交付,本批补命名验收钉 `crates/kode-server/tests/db_lane_isolation.rs`(2 例)后勾行。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| schema 视图 ↔ 语义 Core | `$/kode/databaseSchema/build`(IDE-RUST-008)Rust 推导表/列;TS 经 `getKodeCoreShadowGate().runInRust` 消费,Rust 不可用/失败/形状不合规返回 null 回落 TS `deriveDatabaseTables`(输入收集留 TS、推导归 Rust,镜像 IDE-RUST-007 边界) | `crates/kode-server/src/database_schema.rs`;`src/backend/databaseSchemaRust.ts`;派发语义钉 `crates/kode-server/tests/database_schema_dispatch.rs`(根表/六列/子表/列型) |
| drift 检查 ↔ 语义 Core | drift 对比两侧同形:一侧是 defs 推导的 `TableSchemaDescriptor`(与 schema 视图同一推导核),另一侧是真实库 information_schema 只读查询;证据纪律 IDE-DB-006 四态诚实分类(compatible-verified / unverified / unknown-version / drift-found),`queried=null` 只给 unverified 不冒充实测,引擎版本未知不宣称兼容 | `src/backend/databaseDrift.ts`(import databaseSchemaCore 形状);`src/backend/databaseDriftEvidence.ts`;`tests/databaseDrift.test.ts` / `tests/databaseDriftEvidence.test.ts` |
| DB driver 隔离(依赖图) | 语言服务器二进制零 DB 客户端:kode-db-clone 的 mysql 驱动只住 `[dev-dependencies]`(PDC-0601 testcontainers + `#[ignore]` + Docker/KODE_DB_CLONE_MYSQL 门控,默认 `cargo test` 不跑);kode-server 生产依赖链无任何驱动,kode-db-clone 生产依赖仅 serde/sha2/chacha20poly1305/getrandom 纯数据处理族 | `crates/kode-db-clone/Cargo.toml`;**本批钉** `db_drivers_stay_out_of_production_dependency_graph` |
| SQL 执行面隔离(进程归属) | SQL 与 socket 全在 TS 扩展宿主:mysql2 动态装载(懒加载,不拖慢激活、无 MySQL 机器不挡扩展);建连即 `SET SESSION TRANSACTION READ ONLY` + 每查询 `assertReadOnlyStatement` 白名单(拒写/拒多语句/拒注释伪装)+ 在途强杀守卫(IDE-AUD-010/IDE-REV-017 撕 socket);事务(Apply)同样 TS 侧驱动 mysql2,Rust 侧只产计划 | `src/backend/databaseDrift.ts`(createMysqlDriftExecutor);`crates/kode-server/src/db_clone.rs` 头注(ExportPlanner 只读 SELECT 计划,执行归 TS;事务执行不在此面——Rust 无 MySQL 客户端);`tests/databaseDrift.test.ts` 只读红线钉 |
| 取数面不被后台化 | schema 推导核注册在生产注册表,归池交互泳道 + 纯 CPU(与 RUST-180 配置取数同规则:用户主动刷新的视图取数不被后台硬顶拦截,不误入 IO 表) | **本批钉** `schema_view_data_face_is_registered_pool_interactive_cpu` |

## 本批增量

- `crates/kode-server/tests/db_lane_isolation.rs`(新,2 例):
  - 依赖图钉:kode-server 生产依赖黑名单(mysql/sqlx/postgres/sqlite/redis/mongodb/diesel/sea-orm 等全族)+ kode-db-clone 生产依赖**白名单**(多一个键即红,隔离按清单钉死不靠口头约定)+ mysql 必须在 `[dev-dependencies]` 存在(防整条测试面被拆后白名单契约空转)+ 解析非空守卫(防静默解析失败造假绿);
  - 取数面钉:`$/kode/databaseSchema/build` 注册存在性 + Pool(Interactive) + (Interactive, Cpu) 双投影一致;
  - prove-red 双变异(白名单删 getrandom→红 RC=101;泳道断言改 Background→红 RC=101),cp+cmp 字节还原。
- TS 侧零改动:只读红线/白名单/证据分类/懒加载均有既有钉(databaseDrift 系 4 个测试文件 + evidence 系 2 个),本批不重复。

## 诚实条款

- 「隔离」是**依赖图与进程归属属性**:语言服务器二进制链接不到任何驱动、不握任何 socket;全部 SQL 在扩展宿主进程。它不是沙箱级安全保证——运行时红线是 TS 语句白名单 + 只读会话双保险,防一面在 `tests/databaseDrift.test.ts`。
- schema 视图/drift 检查本体与证据纪律均为既往批次交付(IDE-RUST-008 / IDE-DB-006 / IDE-AUD-010 / PDC 系列),本批不重复实现,只做验收对账与命名钉。
- kode-db-clone 的 testcontainers 真实 MySQL 集成测试为环境门控(`#[ignore]` + Docker),CI 默认不跑;其存在性由本批 dev-dependencies 钉保护,不在常规门禁内运行。
