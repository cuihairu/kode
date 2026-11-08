# Rust 方向态势评估：已兑现价值、诚实缺口、分发通道与剩余量（2026-11-08）

缘起：用户问「这样继续开发 rust 就感觉没有什么意义了」。本文不对齐结论、
只对齐事实——把 Rust 面的在役价值、诚实缺口、剩余清单、分发通道工作量
一次盘清，方向决策权在用户。证据全部是仓库内真实路径，禁吹牛规范适用。

## 一、已兑现价值（在役面盘点）

### 1. LSP 服务四面（主价值面，开发者形态已生效）

definition / completion / hover / diagnostic 全部 Rust-first + TS 兜底，
扩展激活即用（backend 默认 rust，serverPath 空走 `target/{debug,release}`
自动发现）：

- definition（e9703cca）+ def 方法段声明词回落 TS 脚本层（cc8b974a）
- completion（e66f527f，含语料全量镜像 `src/kodeCoreCorpusMirror.ts`）
- diagnostic（bc55988f，message 键归并 + 六开关门）
- hover（04a3fada，语料文档镜像→请求→markdown 直出）
- shadow compare 面：definition + diagnostic 在档；completion/hover 未接
  （serving ≠ shadow，如实区分）

**这四面在「源码树形态」（你自己的开发机 + CI + 从源构建的用户）下每时
每刻都在跑 Rust**——不是期货，是现状。

### 2. RPC 能力面（kode-server 承载，TS 消费）

| 面 | 证据 |
|---|---|
| message_table / client_sdk（含组件槽 IDE-RUST-006） | crates/kode-server/src/message_table.rs、client_sdk.rs |
| def 依赖图（IDE-RUST-007，webview Rust-first） | crates/kode-server/src/dependency_graph.rs |
| Python callgraph/dataflow/symbols（C-20，kode-python crate） | crates/kode-python/（ruff_python_parser，无手写解析器） |
| database_schema（IDE-RUST-008） | crates/kode-server/src/database_schema.rs |
| ruff lint shell-out（IDE-RUST-005 A 形态） | crates/kode-server/src/ruff_lint.rs |
| KBEngine API docs hover（C-21，双语库） | crates/kode-server/src/api_docs.rs |
| 玩家克隆（$/kode/dbClone/*，chacha20poly1305 + FileKeyStore） | crates/kode-server/src/db_clone.rs、crates/kode-db-clone/ |
| def MD5（**缺口见下节**） | src/defMd5Rust.ts、src/hotReloadDefHash.ts |
| 失效 DAG（改被调者只重算调用者） | crates/kode-scheduler/src/invalidation.rs |

### 3. 独立 Rust 交付物（不依赖 VSIX 分发）

- **kode-kbengine CLI**（PA-003/004/005）：schema validate/build/diff/inspect、
  decode、capture analyze、分析引擎（关联/延迟/异常/时间线）——pcap 分析
  零 ABI 面任何系统可用
- **Wireshark 插件**（PA-006）：独立 GPL crate，真实 pcap 端到端验收过，
  与 CLI 逐帧同源
- **kode-mcp**（KB-001 工具面 + KB-002 P1）：覆盖率 99.84%，Python 语义
  模型核心在途（P2 并发会话进行中）

### 4. 性能账（已测量的部分）

- 内存：R1 审计 9.3×–33.8× 优势（docs/perf 侧报告）
- 服务态：spawn P50 5.5ms / 镜像 0.02-0.03ms/doc / 稳态 RTT 0.72–2.93ms
  （docs/perf/2026-11-08-serving-state.md；测量期负载 20-25，绝对值膨胀
  相对结论有效）
- KODE-PERF-001..007：流敏感缓存键/平方级行号消除/收敛提交位释放/
  callgraph 收集重铸/刷新代际守卫/拓扑诊断成本/2026 基线
- 大文件放大（2026-baseline）：big-py hover P50 3.38ms 为 large 的 ~26x
  ——**该基线是 v0.2 TS+Rust 合体线实测**，放大面仍是已知风险，不是
  「Rust 已解决」

## 二、诚实缺口（Rust 面的欠账，不是功劳）

1. **defMd5InRust 无生产消费链**（RUST-MIGRATION-AUDIT-003，P1）：
   `src/defMd5Rust.ts` 的 `computeDefMd5InRust` 与 hotReloadDefHash 的
   `negotiateEngineDigest` 仅见定义与测试调用——函数存在 ≠ 接线，未接通
   前不能以「Rust 有此能力」勾账。
2. **迁移矩阵未逐项过完**（RUST-MIGRATION-AUDIT-002，P1）：原功能/
   非保存缓冲区/取消/失败降级/版本正确性的对拍-切换流程未逐项收口。
3. **市场分发通道不存在**（本文第四节主体）：市场用户拿不到 Rust 面，
   自动发现只覆盖源码树形态。
4. **completion/hover 的 shadow 对拍未接**：等价性证据面比 definition/
   diagnostic 少两腿。

## 三、todo.md 未勾清单（全仓仅 7 项，按性质分类）

| 项 | 性质 | 与 Rust 的关系 |
|---|---|---|
| PA-006 余量 | Rust 插件增量 | 字段树（Header derive）+ Win/macOS 实机 |
| PA-007 余量 | TS 集成面 | 消费 Rust CLI，本体是 TS（Schema 生成/监听/面板/诊断） |
| KODE-MCP-KB-002 | Rust MCP 增量 | P2 并发在途；P3 向量/P4 Excel 未启 |
| KODE-CFG-017-R | Rust 核心 + TS 消费 | write_scope 硬不变式 + hover/inlay 富化 |
| SRC-012 | 重构（TS 为主） | 含 client_sdk.rs/archive.rs 两个 .rs 拆分 |
| RUST-MIGRATION-AUDIT-002 | 审计（Rust 核心） | P1，矩阵逐项对拍补齐 |
| RUST-MIGRATION-AUDIT-003 | 审计（Rust 接线） | P1，defMd5 生产链接通 |

（2026-11-08 修正：早前记忆「用户新登记 6 项待调研」已过时——
IDE-RUST-005/IDE-BOT-001/IDE-PROP-001/IDE-DB-001/IDE-I18N-002/IDE-PYSPY-001
已全部勾账，见 docs/review/2026-11-08-todo-completed-history.md done-0332 起。）

**Rust 泳道不是无底洞**：未勾 7 项里真正的 Rust 新功能面只有 PA-006 余量、
KB-002 P3/P4、CFG-017-R 三处，其余是审计收口与重构。

## 四、分发通道：三方案工作量评估（「最后一公里」主体）

前提红线：nightly 资产 = 允许交付面；marketplace 上架 = 正式发版 = 用户
触发；GPL Wireshark 插件永不进 VSIX（许可证边界）；VSIX 内打包 kode-server
/ kode-kbengine 均为 Apache-2.0 crate 产物，无许可证冲突。

### 方案 A：平台化 VSIX（二进制进展内，推荐）

- 做法：`vsce package --target linux-x64 / win32-x64 / darwin-x64 /
  darwin-arm64`（市场按用户平台自动发对应包，rust-analyzer 同形态）；
  release 产物放扩展内 `resources/<target>/`；发现逻辑在现有
  `discoverKodeServerBinary`/`discoverKodeCliBinary` 候选链加一条
  「扩展内 resources/<target>」——小改 + 测试。
- CI：三 OS release build + 分目标打包（现有 nightly 全链基础上加 job）。
- 工作量：**约 2-3 批次**（打包脚本+发现接线 1 批；CI 矩阵+产物验收 1 批；
  装机端到端验收 1 批）。
- 代价：VSIX 体积 +30-60MB/平台（kode-server release 二进制为主）。
- 效果：市场用户装完即得 Rust 四面 + CLI + pcap 分析，零额外步骤——
  「用户零手动配置」的 PA-007 验收口径在市场形态下成立。

### 方案 B：激活按需下载

- 做法：激活时无二进制 → 从 GitHub Release/nightly 资产下载对应平台
  产物（PA-007 版本检测骨架已在位）→ SHA256 校验 → 落 globalStorage →
  发现链加该候选位。
- 工作量：**约 3-4 批次**（下载/校验/落盘/重试/失败如实面比 A 多一套）。
- 代价：依赖网络与资产渠道；首用体验多一次下载等待。
- 适用：A 的 VSIX 体积不可接受时。

### 方案 C：文档引导（最轻）

- 做法：README/指南写明源码构建或独立下载步骤，发现链不动。
- 工作量：**约 1 批次**；体验最差（等于维持现状+说明书）。

### 共同前置（无论选哪个）

- 三 OS 构建矩阵的可复现验收（当前 CI 只有 Linux 跑全链；Windows/macOS
  构建从未在 CI 验证过——这是 A/B 都绕不开的真实工作量）。
- 发版动作本身（tag/Release/marketplace 上架）全部等待用户明示。

## 五、可选路线（供决策，不代决）

1. **先铺通道再继续功能**（回应「没意义」的直接解）：A 方案 2-3 批 →
   已有全部 Rust 成果即刻具备到达用户路径 → 之后每批 Rust 自动有意义。
2. **先收审计缺口再铺通道**：AUDIT-002/003（两个 P1，诚实欠账）先行，
   通道随后——发版前的验收证据更扎实。
3. **冻结 Rust 功能面**：7 项未勾中只保留审计/集成，PA-006 字段树、
   KB-002 P3/P4、CFG-017-R 挂起，转 TS 面或验收面。
4. 任意组合/重排序——用户定。

## 六、一句话事实基线

Rust 在源码树形态已全量在役（四面服务 + 十余个 RPC 面 + 三个独立交付物）；
「市场用户拿不到」是分发通道未铺 + 发版未触发的流程状态，不是 Rust 的
价值判定；剩余 Rust 新功能面只有 3 处，审计欠账 2 处（P1）。
