<!--
来源: 用户提供的外部整合任务书（ChatGPT 会话产出 KODE_2_COMPLETE_TODO.md，662 行）。
落库日期: 2026-10-23 · 分支: v0.2（Kode 2.0 开发线，main 保持 0.1.x）
原文逐字保留。执行协议见第 16 章；与既有 todo.md 的映射由 AUDIT-014 统一负责，本文件不自动覆盖旧账本。
-->

# Kode 2.0 — Rust Core 高性能重构与 KBEngine IDE 完整实施账本

> 日期：2026-10-23；定位：面向 Code Agent 的可执行计划（设计提案，尚非已实现事实）。
> 仓库：https://github.com/cuihairu/kode
> 源码核验限制：已检查公开 package.json 和 todo.md；本环境未成功克隆完整仓库，因此代码路径需在 P0 审计确认后记录为事实，**禁止将推测的文件名和调用链视作已经验证**。
> 既有任务迁移：保留旧 todo.md 的 A1–A7 性能治理、B 止血项、C 功能项、D 维护项；本计划是扩展/迁移规划，不自动覆盖旧账本；第 19 章整合 Watch、HTTP 热更新与 Hash。完成项须依 commit、测试和数据核对。

## 0. 目标、范围和红线

### 0.1 产品定位
Kode 是面向 KBEngine 游戏服务端开发的专业 VS Code 集成环境。核心职责：KBEngine 项目识别；`.def` / `types.xml` / `entities.xml` / `alias.xml` / Python 跨语言语义；实体 Cell/Base/Client 分面；组件和继承；补全/引用/诊断/重构；typings；调试与运行时观察；项目工具链；版本适配。可扩展，不绑定游戏业务逻辑，不成为游戏运维平台。

### 0.2 严格设计原则
- [ ] ARCH-001 扩展宿主不得同步执行全仓扫描、语义求解、全量 XML 解析、巨型日志处理。
- [ ] ARCH-002 Core 是常驻进程，语言请求不得 spawn Python/Rust 进程；运行脚本须独立的可复用执行服务。
- [ ] ARCH-003 文件快照按 root + canonical URI + document version 唯一标识；打开文件内存优先。
- [ ] ARCH-004 索引查询无阻塞全量初始化前置；允许明确标注 partial/incomplete，禁止悄悄返回假完整结果。
- [ ] ARCH-005 所有发布到编辑器的结果带请求/文档/索引版本，拒绝旧结果覆盖新结果。
- [ ] ARCH-006 优先局部解析和受影响依赖更新；无理由的「任意改动→全仓重建」视为架构缺陷。
- [ ] ARCH-007 语义正确性、内存上限、稳定性与尾延迟均为发布门槛。
- [ ] ARCH-008 自有协议版本化，公共 API 与内部存储隔离；插件默认无文件写权限、无网络权限、无任意执行权限。
- [ ] ARCH-009 UI 在降级、Core 崩溃、无 KBEngine 引擎源码时仍可用。
- [ ] ARCH-010 支持 Windows/macOS/Linux、x64/arm64 和 Remote SSH/WSL/Containers 的正确执行位置。
- [ ] ARCH-011 索引存储为派生缓存而非数据真相，损坏可以重建，不可静默修改用户文件。
- [ ] ARCH-012 无实验数据不得声称 Rust 性能一定快 N 倍；禁止靠删功能换性能。

### 0.3 不做的事情
- [ ] SCOPE-001 不重写 VS Code UI 为 Rust GUI。
- [ ] SCOPE-002 不从零重写完整 Python 解释器或 Python 语言服务器。
- [ ] SCOPE-003 不把服务器部署、集群调度、云资源与游戏业务运维塞入语言服务核心。
- [ ] SCOPE-004 不允许没有协议隔离的第三方插件直接加载到高可信 Core 进程。
- [ ] SCOPE-005 不承诺纯浏览器 VS Code 可以执行原生 Core；单独设计 Web 降级或远程部署。

## 1. 验收性能预算及方法

> 所有数值为候选预算，必须附硬件、系统、数据集、时间窗口、样本数。P95/P99 与 cold/warm 区分；不要把合成基准误当真实 KBEngine 工程表现。

| 场景 | 候选目标 | 绝对规则 |
|---|---|---|
| 扩展激活（不含 Core 全量索引） | P95 ≤300ms | 不阻塞编辑器 UI |
| Core 热启动至握手完成 | P95 ≤200ms | 启动失败可诊断 |
| 热缓存 Hover | P95 ≤15ms | 禁同步磁盘扫描 |
| 热缓存 Definition | P95 ≤20ms | 不等待全仓 scan |
| 热缓存 Completion | P95 ≤30ms | 响应可取消 |
| References | P95 ≤100ms（指定数据集） | 大查询需进度反馈/分页 |
| 常见文件解析 | P95 ≤10ms（具体文件大小按 fixture） | 大文件单独分层考核 |
| 单文件增量语义传播 | P95 ≤50ms（局部影响情境） | 明确重算结点数 |
| 编辑后的轻量诊断 | P95 ≤100ms | 不发布过期内容 |
| 冷索引 10k 文件 | ≤5s（候选目标） | 真实机器数据先定标 |
| 编辑器卡顿 | 主线程 long task ≤50ms，次数和总阻塞时间设门槛 | 加入压力测试 |
| Core 内存 | 基线与文件数分段拟合并设硬上限 | 防无限增长 |
| 内存泄漏 | 1h 编辑/索引压测稳定 | 有统计与回收证据 |
| 超时/取消 | 旧请求可释放资源，绝无永久 pending | 压测/故障注入 |

- [ ] PERF-001 编写 docs/perf/hardware.md：CPU、核数、RAM、磁盘、OS、VS Code/Node/Rust/KBEngine 版本。
- [ ] PERF-002 fixtures 分 S(200 files)、M(2k)、L(10k)、XL(50k+)、XRoot(3+ resources 根)；附文件大小与符号数统计。
- [ ] PERF-003 fixtures 包含同名实体、跨 root 同名 Python class、深继承、循环别名、不完整 XML、非 ASCII 路径、符号冲突。
- [ ] PERF-004 fixtures 含真实 KBEngine 引擎样例（版权/版本可用时），与可合成开源样例隔离。
- [ ] PERF-005 测量 extension activation、Core spawn、handshake、workspace discovery、parse、resolve、index、publish 的分段时延。
- [ ] PERF-006 延迟结果按 cold/warm、idle/busy、SSD/network FS、local/remote、root 数量分组。
- [ ] PERF-007 每个关键请求采集 P50/P95/P99/max、队列耗时、执行耗时、排队长度、取消率、cache hit/miss。
- [ ] PERF-008 统计文件枚举/读取/解析次数、局部失效节点数、索引版本和 RPC 消息字节数。
- [ ] PERF-009 监测 VS Code extension host event loop delay、Core CPU/内存/线程及磁盘 IO。
- [ ] PERF-010 CI 建立基准报告和可配置回归阈值；有噪声控制和重复执行。
- [ ] PERF-011 自动生成基线 → PR 对比 → 历史趋势，不通过基准不得合并关键核心 PR。
- [ ] PERF-012 做请求风暴：快速连续编辑、切换 tab、批量重命名、依赖变更、并发跳转补全。
- [ ] PERF-013 做 1h soak test、OOM 限额、杀进程恢复、损坏索引自动回建、取消与重试。
- [ ] PERF-014 对超大文件启用 degraded mode 并明示能力限制；不得锁死 UI。
- [ ] PERF-015 跨机器不直接比较绝对速度；主报告使用固定基准机器和统计置信范围。
- [ ] PERF-016 在 docs/perf/decisions.md 记录每一项优化的 profiling 证据、取舍、回退策略。

## 2. 现有代码取证与迁移清单（首个强制阶段）

- [ ] AUDIT-001 固定仓库 commit SHA / tag，保存 working tree 状态；确认旧 TODO 每条任务的真实完成状态。
- [ ] AUDIT-002 抽取 `src/` 模块树、入口 activation、各 provider 注册、manager 生命周期及 import 依赖图。
- [ ] AUDIT-003 标出 `onLanguage:python` 激活是否不必要地初始化 KBEngine 服务；增加无 KBEngine 工作区负案例。
- [ ] AUDIT-004 枚举 `.def` / types.xml / entities.xml / alias.xml 的所有解析器与调用方，找重复 parse/read。
- [ ] AUDIT-005 枚举 PythonClassIndex、EntityMappingManager、type registry、composition root、definitionWorkspace 及实际名称/路径。
- [ ] AUDIT-006 核查所有 `fs.*Sync`、`getText().split`、递归 workspace.findFiles、glob、statSync、首次查询 ensureScanned。
- [ ] AUDIT-007 记录 hover/definition/completion/diagnostics/references 四层真实调用链与等待点。
- [ ] AUDIT-008 枚举全部用户功能、commands、views、configuration、debug provider、test 清单，为迁移建立能力矩阵。
- [ ] AUDIT-009 核查现有 `.pyi` 生成算法与类型来源，是否基于 Python AST、动态运行或文本正则。
- [ ] AUDIT-010 核查代码生成向用户目录的写入行为、覆盖保护、源位置跳转、版本与冲突处理。
- [ ] AUDIT-011 审核 log/terminal/HTTP/telnet/watcher 运行时边界和现存进程/连接生命周期。
- [ ] AUDIT-012 产出 docs/architecture/current-state.md：事实、推断、已测结论分栏标记。
- [ ] AUDIT-013 产出 docs/architecture/migration-inventory.csv：模块、owner、输入、输出、耗时、迁移方式、测试、风险。
- [ ] AUDIT-014 明确旧 A1-A7 对新 Phase 的映射；保留所有当前已修复的永转/超时问题回归测试。
- [ ] AUDIT-015 将产品已有 feature 进行 retained/moved/reworked/deferred 分类，避免重构丢能力。
- [ ] AUDIT-016 执行 HR-AUDIT，确认已有 HTTP/Watch/Hash 代码真相并建立差异清单。

## 3. Repository / 构建 / 发布基础设施

建议的目标树（先做设计审查，确认后生成，不代表仓库当前已有）：

```text
kode/
  extension/                 # TypeScript VS Code extension and UI
    src/{activation,client,views,commands,debug,services,plugins}/
  crates/
    kode-server/             # LSP stdio server, lifecycle
    kode-protocol/           # LSP extension, versioned protocol DTOs
    kode-vfs/                # snapshots, rope, URI, overlays
    kode-syntax/             # XML / DEF CST and incremental parser
    kode-project/            # root discovery, config, engine versions
    kode-semantic/           # symbols, types, entity facets, relations
    kode-index/              # dependency DAG, scheduler, query, cache
    kode-python/             # Python integration and typed bridge
    kode-typings/            # .pyi, source map, SDK generators
    kode-diagnostics/        # validations, rules, quick fixes
    kode-runtime/            # safe runtime adapters, nonlanguage tasks
    kode-plugins-api/        # capability and versioned contracts
    kode-plugin-host/        # isolated out-of-process plugin runtime
  schemas/                   # protocol and workspace configuration
  fixtures/                  # integration, pathological, bench datasets
  benchmarks/                # latency, memory, stress
  docs/{architecture,perf,semantics,plugins,decisions}/
  scripts/                   # builds, package, codegen, verification
```

- [x] BUILD-001 决策记录 ADR-001：LSP stdio 为默认常驻本地/远端通信；扩展协议只处理非标准能力。(PR-003,docs/kode2/adr/ADR-001-stdio-default-transport.md)
- [x] BUILD-002 ADR-002：Rust 解析器/查询核心 vs 现有 TS，先用基准决定是否逐模块替换。(PR-003,docs/kode2/adr/ADR-002-benchmark-first-rust-migration.md)
- [x] BUILD-003 建 Cargo workspace，pin toolchain 与依赖，定义 MSRV；启用 cargo fmt/clippy/test。(PR-003:Cargo.toml+rust-toolchain.toml pin 1.99.0/MSRV 1.82,`cargo clippy --workspace --all-targets -- -D warnings` 过)
- [ ] BUILD-004 Cargo features 分割 optional engines/runtime/plugin host，减小基础包和启动成本。
- [ ] BUILD-005 TS client 统一 transport / reconnection / cancellation / diagnostics 管理。(PR-003 已落最小版 spawn/握手/取消/崩溃重启:src/kodeCoreClient.ts;Provider 接线与 diagnostics 管理留 PR-010)
- [ ] BUILD-006 固定生成的协议 schema；Rust/TS types 从同一规范生成，CI 测兼容。
- [ ] BUILD-007 对多平台目标构建 x64/arm64；单独核查 Windows path/casing 和 macOS 签名/隔离。
- [ ] BUILD-008 VSIX 拆分 target-specific 原生包与统一扩展包的策略，明确 platform fallback。
- [ ] BUILD-009 VS Code Remote：在 extension host 所在机器选择对应平台 Core，勿错误在 UI 本地启动。
- [ ] BUILD-010 Web extension：检测环境后声明有限功能或连接远端 Core，不假装支持本地 native。
- [ ] BUILD-011 发布产物 SHA256/来源审计/SBOM/license scanning，避免可执行文件被替换。
- [ ] BUILD-012 构建缓存、依赖离线策略、可复现版本、CI 并行矩阵。
- [ ] BUILD-013 Crash 报告只含脱敏本地 diagnostics；不默认上传源码、路径或日志。
- [ ] BUILD-014 Profile release LTO/strip/codegen-units 等选项以测量为准，不盲目最大化编译优化。
- [ ] BUILD-015 定义 Rust/TS 协议的版本不匹配提示、自动重启和回退机制。
- [ ] BUILD-016 插件/缓存/临时文件路径兼容多工作区；清理不删除用户文件。

## 4. Rust Core 运行时、请求调度与资源控制

- [x] CORE-001 stdio LSP framed JSON-RPC：Content-Length 正确处理短读/分包/非法帧。(PR-003:crates/kode-protocol FrameDecoder,11 帧Codec单测)
- [x] CORE-002 `initialize` 协商 capabilities、project roots、server version、extension capabilities。(PR-003:kode-server initialize 幂等协商,initializationOptions.restartGeneration 对账)
- [x] CORE-003 所有请求 request_id/span_id；日志与 tracing 可串联扩展↔Core↔后台任务。(PR-003 最小版:request_id 数字/字符串保真贯穿响应/取消/日志(stderr 对账),span/tracing 体系留后续)
- [ ] CORE-004 单实例一个 workspace session；多个 root 配隔离 root_id 与受控共享缓存。
- [ ] CORE-005 工作优先级：打开文档小范围交互 > 直接语义查询 > 局部依赖刷新 > 后台首扫 > 大图/SDK/报表。(PR-009 基础版:crates/kode-scheduler 五级优先级+seq 公平序+交互冷却限流,与 TS indexScheduler 对拍;server 装配接线随 provider 单)
- [ ] CORE-006 队列具备公平性和抗饥饿机制；不可永久推迟后台 indexing。(PR-009 基础版:kode-scheduler 同优 FIFO+有界队列淘汰+后台饥饿上限绕过冷却晋升;server 接线随装配单)
- [ ] CORE-007 按 request/document/root 级 cancel token，传播至文件读取、解析、计算、响应封装。(PR-009 基础版:kode-scheduler CancelToken+句柄/批量取消,运行中不中断;向 IO/解析/响应的传播随 server 装配)
- [ ] CORE-008 去重同文件同版本工作；singleflight 共享解析结果；异步结果晚到必须 version check。(PR-009 基础版:kode-scheduler 同文件同版本合并+过期版本丢弃/取消让位+keyed 单例;singleflight 随 provider 接线)
- [ ] CORE-009 首扫后台完成，同时允许 on-demand target parse；冷请求绝不无期限等待全仓。
- [ ] CORE-010 CPU pool 对交互请求预留容量；后台 worker 并发有硬上限，避免把 CPU 全核占满。
- [ ] CORE-011 IO task 与 CPU task 分离，禁止锁跨 await，审计 contention/priority inversion。
- [ ] CORE-012 大结果限流、分页、stream chunk + cancel；限制 JSON payload 体积。
- [ ] CORE-013 缓存预算配置（resident bytes、LRU、idle aging）与内存压力下主动回收。
- [ ] CORE-014 读写索引时使用一致快照，避免定义和引用来自不同 generation。
- [ ] CORE-015 Core crash/restart 自动恢复，服务不可用时最小语法功能继续使用。(PR-003 已落最小版:TS client 崩溃检测+自动 respawn+重握手(10s 窗口 3 次);「最小语法功能兜底」留 Provider 接线时实现)
- [ ] CORE-016 启动探针、健康状态、索引进度、可观察恢复原因。(PR-003 已落 `$/kode/health` 探针(status/pid/uptime/文档摘要/restartGeneration)+ stderr 诊断留痕;索引进度随索引模块)
- [ ] CORE-017 文件通知合并 debounce + max latency；原子替换/rename、delete/create 合并处理。(PR-009 调度决策面:kode-scheduler StormBuffer 风暴合并(同文件并一/最新版本胜出/超限强制落批);didChange 接线与 debounce 参数随 server 单)
- [ ] CORE-018 建立 long-running fuzz/load/stress CI，检测死锁、永久 pending 和取消泄漏。

## 5. VFS / 文件发现 / 文档快照

- [x] VFS-001 Path identity：URI、大小写规则、符号链接、Unicode normalization、Windows UNC、WSL 路径语义文档。(PR-004 基础版:crates/kode-vfs/src/uri.rs CanonicalUri——percent 解码/词法消解/盘符大写/非 file scheme 拒绝,语义文档化在模块头;PR-006:crates/kode-root/src/platform.rs 落 UNC/WSL(//wsl$ 与 //wsl.localhost 拆 distro 段)/Win+mac 大小写折叠身份比较,APFS case-sensitive 卷误合为已声明边界;Unicode normalization 与 symlink 的 fs 级 canonicalize 属 IO 专项,跟随模式护栏已落 scan.rs)
- [x] VFS-002 root_id + canonical URI + open buffer version 作为查询身份，禁止仅以文件 basename 建索引。(PR-004:crates/kode-vfs/src/store.rs DocumentKey{root_id,uri};RootId::UNROOTED=0 保留)
- [x] VFS-003 Open overlay 优先磁盘；didOpen/didChange/didClose 做正确 version transition。(PR-004:DocumentStore open/change/close,version 严格递增,stale 回 VersionConflict::Stale;kode-server 已切到该 store)
- [x] VFS-004 增量文本编辑坐标 UTF-16 ↔ bytes ↔ line/column 精确转换；覆盖 emoji / CRLF。(PR-004:crates/kode-vfs/src/line_index.rs + tests/coordinates.rs 全坐标对拍,样例表见 docs/kode2/pr-004.md)
- [x] VFS-005 文档 rope/line index，避免每个 hover 全文 split 与复制。(PR-004 基础版:LineIndex 行起点表+二分,查询零 split;编辑整段重建,增量 rope 待基准数据)
- [x] VFS-006 Disk fingerprint 不只依赖 mtime；必要时 size/hash 做一致性校验。(PR-004 基础版:crates/kode-vfs/src/disk.rs mtime_secs+mtime_nanos+size 三元组;hash 留指纹专项)
- [x] VFS-007 工作区 glob：排除 `.git`, `node_modules`, `.venv`, build, generated 及用户排除目录。(PR-004:crates/kode-vfs/src/walk.rs DEFAULT_EXCLUDED_DIRS + 用户通配追加)
- [x] VFS-008 `.def`, `types.xml`, `entities.xml`, `alias.xml`, Python, KBEngine engine source 的独立发现规则。(PR-004 基础版:walk.rs FileKind 路径分类;引擎版本 profile 规则随 PR-005/006)
- [x] VFS-009 资源根顺序显式定义（kbengine.xml/config/环境变量/用户配置/工作区推断），冲突出诊断。(PR-004 基础版:store.rs RootRegistry 注册顺序=优先顺序、最长前缀、overlapping_roots 冲突入口;PR-006:crates/kode-root/src/resolve.rs DiscoveryEngine 落 config/env 前的发现层——约定探针链/深扫描兜底/多根 PlatformRootRegistry 折叠感知归属与冲突入口;config/env 两个来源的接线随 server 装配层)
- [x] VFS-010 遇到网络 FS、不可读取文件、符号链接循环、权限拒绝时安全处理。(PR-004:walk 读失败跳过并计数、目录 symlink 不跟随、深度封顶;disk 非法输入回 Err 不 panic)
- [x] VFS-011 Document parse cache 仅保留最新有效快照并支持 recent successful AST、负缓存。(PR-004:crates/kode-vfs/src/parse_cache.rs `ParseCache<V>` + FNV-1a 输入指纹)
- [x] VFS-012 删除/重命名/跨根移动应移除过期 symbol 与旧 diagnostics。(PR-004:store.rs remove/rename/invalidate_root 返回 RemovedDocument 回执 + ParseCache::invalidate;下游清理随 PR-007 接线)
- [x] VFS-013 测试 100 次编辑、保存竞态、重命名过程、未保存变更、工作区根切换。(PR-004:crates/kode-vfs/tests/vfs.rs 五场景;cargo test --workspace 76 passed)

## 6. KBEngine 专业语法与语义模型

### 6.1 语法数据结构
- [ ] SYNTAX-001 对 `.def`、`types.xml`、`entities.xml`、`alias.xml` 分别建立 grammar spec 和 invalid fixtures。(进行中:PR-005 已落 invalid fixtures/盲样变异;PR-008 pr-008.md 已定型四类文件的语义面口径(decls/aliases/composition/entities 抽取规则+对拍 golden),正式 grammar spec 文档仍待专单)
- [x] SYNTAX-002 明确 XML 解析保持节点/属性/文本精确 Span：不可以只做值解析丢定位。(PR-005:crates/kode-parser/src/xml.rs 开/闭/内容/名称/属性字节 span,伪注释掩码字节长度不变;证据 docs/kode2/pr-005.md)
- [x] SYNTAX-003 CST/AST 支持容错解析（缺闭合标签/临时不完整编辑），诊断精确位置。(PR-005 基础版:截断/坏标签/未闭合结构化诊断 13 码,树前缀不丢,逐字节截断扫描测试;CST 级增量重解析随 PR-007)
- [ ] SYNTAX-004 验证 quick-xml + 自定义位置层 vs rowan CST 的成本与热更新性能；ADR 选型。(PR-005 已裁决 ADR-102:自研零依赖状态机,quick-xml/rowan 未引入;若增量基准证明成瓶颈按 ADR-002 重评)
- [x] SYNTAX-005 AST 对未知字段保留以适应引擎分支/扩展，不因未知标签完全失败。(PR-005:extra_tags/extra_sections 保留 + 遗留拼写容忍)
- [ ] SYNTAX-006 大文件解析/增量与缓存基准，禁止任何 debug build 性能结论代替 release。(进行中:PR-005 release bench 基线已立(P50 6µs/大样本 19.9MB/s/增量二扫零重建),热更新性能与增量 rope 基准随 PR-007/009)

### 6.2 类型与实体语义
- [ ] SEM-001 定义稳定 `SymbolId`、`TypeId`、`EntityId`、`RootId`、`Location`、`Origin`。
- [x] SEM-002 类型 IR：Builtin、Alias、Array、FixedDict、UserType、EntityRef、Component、Optional/Unknown/Error（以真实 KBEngine 支持语义落地）。(基础版:PR-008 crates/kode-types TypeNode 四类节点+六种边;Builtin=21 项引用终点清单,EntityRef/Component 以边种表达,Optional 随 LSP 面)
- [ ] SEM-003 每个类型记录 deklaration/definition/reference/source span、原始 root/version、生成映射。
- [x] SEM-004 解析引擎内建类型与 `types.xml` 自定义类型；alias 链与循环诊断。(PR-008:types.xml 重定向条目(alias 注册)与 alias.xml 条目成 Alias 节点;resolve_alias_chain 环截断 Cycle/终点未注册 Unknown 显式诊断)
- [ ] SEM-005 容器嵌套、数组元素、FixedDict 字段、模块注册、自定义扩展类型解析。(进行中:PR-008 已落数组元素/FixedDict 字段/嵌套 ARRAY of 容器边;模块注册与自定义扩展类型解析随 SEM-008/PY 面)
- [ ] SEM-006 `.def` 方法参数、返回类型、Cell/Base/Client methods、Property flags 与调用权限元数据。
- [ ] SEM-007 组件、组件属性、实体继承、分面语义与方法可见性统一定义。(进行中:PR-008 已落实体继承链(环/未注册父显式诊断)与组件/属性类型引用边;分面语义与方法可见性随 LSP 面)
- [ ] SEM-008 `entities.xml` 注册映射 → `.def` → Python 实现，跨语言可逆导航。
- [ ] SEM-009 支持多个 root 的同名实体/组件/类型，显式查找顺序和歧义 diagnostics。
- [ ] SEM-010 Python base/cell/client 文件与实体 `.def`、组件绑定区分、重复定义检测。
- [ ] SEM-011 引擎关键 API、回调、内建对象、常量作为版本化 metadata layer，外部版本可覆盖。
- [ ] SEM-012 symbol 名称重命名策略：用户代码可改，内建和生成代码不可直接改；冲突预检查。
- [x] SEM-013 类型解析错误使用 Unknown/Error 并保留理由，不借用任意类型掩盖缺失。(PR-008:TypeClass::Unknown + ChainStatus::Unknown/Missing 均以终端名/该级名为理由,不冒充内建)
- [ ] SEM-014 建立语义 fixture 金标数据，跨 Rust/TS 老逻辑差异必须人工分类审查。
- [ ] SEM-015 引擎版本差异经 capability profile 决定，不用 `if version` 散落调用方。

## 7. 增量索引、依赖图和缓存

- [x] IDX-001 明确四层：文件目录索引、语法索引、符号/类型索引、跨文件关系图。(基础版:PR-007 crates/kode-index 符号/类型层+跨文件反向依赖;文件目录层=kode-vfs walk/store,语法层=kode-parser;证据 docs/kode2/pr-007.md)
- [x] IDX-002 DAG 边类型：declaration/import/entity registration/type alias/component/inheritance/method binding/generation dependency。(基础版:PR-007 类型引用/Parent/组件/接口/entities 注册边(parser RefSet)+实体继承边;import/generation 边随 PR-008/009)
- [x] IDX-003 区分文本改动、signature 改动、body-only 改动、声明删除；相应差异化失效。(基础版:PR-005 dep.rs+PR-007 指纹级零重建;文本/签名/正文细分随 CST 增量,PR-009 面)
- [x] IDX-004 AST 和语义 query 采用 memoization + fingerprint + revision；测量是否选 Salsa。(基础版:PR-007 复用 VFS-011 ParseCache+FNV-1a 指纹+generation;ADR-101 Salsa 选型仍未裁决,不预设)
- [x] IDX-005 对循环依赖与 SCC 计算提供终止保障和精确诊断。(基础版:PR-005 resolve_parent_chain 环截断诊断+PR-007 索引侧 entity_chain 互为 Parent 有限步终止)
- [x] IDX-006 永久索引结构支持定向 symbol lookup 与 reverse reference lookup；杜绝每次 O(workspace files) 查询。(基础版:PR-007 名称倒排 BTreeMap+dependents_of 反向依赖+前缀 workspace_symbols 有序范围扫描)
- [x] IDX-007 索引更新批量提交/原子 generation，读取并发不读到一半的关联。(基础版:PR-007 update_batch 全批应用后一次 bump,零改动空批不 bump)
- [ ] IDX-008 非活跃文件懒加载；当前打开文件优先 warm；初扫扫描优先级按资源根/最近文件调整。
- [ ] IDX-009 磁盘缓存 key 包含 Core schema、engine profile、root identity、workspace config、解析器版本。
- [ ] IDX-010 缓存崩溃写入用临时文件+原子 rename/WAL 等，损坏可清理重建。
- [ ] IDX-011 持久化格式候选 SQLite/redb/自定义二进制；先做 cold start、读写放大、文件数基准。
- [ ] IDX-012 内存索引结构评测紧凑字符串 interning / arenas / small vectors，防止 50k 文件内存爆炸。
- [x] IDX-013 热更新回归须断言“仅影响相关节点”和“文件读取/解析次数”，而非只看结果正确。(基础版:PR-007 rebuild 计数断言:6 文件首扫6/二扫0/单改1;200 文件 bench 同构,证据 docs/kode2/pr-007.md)
- [x] IDX-014 文件 rename/delete 后引用、diagnostics、缓存和生成源映射自动清理。(基础版:PR-007 remove/rename 连带清符号/倒排/反向依赖/继承边/解析缓存;diagnostics 与生成源映射随对应模块接线)
- [x] IDX-015 对 root 增删及 engine profile 切换使用 scoped invalidation，不总是全仓重算。(基础版:PR-007 invalidate_root 只触该根文件;profile 切换入口随 PR-006 root 模型接线)
- [ ] IDX-016 记录索引缺口（unindexed / partial / stale），按需补齐，避免误报无法找到定义。

## 8. LSP 与 IDE 编辑体验

- [ ] LSP-001 Completion（声明、类型、实体属性/方法、RPC 参数、组件、内建 API）共享语义查询。
- [ ] LSP-002 Completion 支持 resolve 延迟补详情，snippet、sortText、filterText、文档与来源。
- [ ] LSP-003 Hover 展示完整类型、来源、可用分面、版本与注释，严禁阻塞等待全局索引。(基础版:PR-010 kode-server hover 响应链(定位/签名/继承链+成员展开,def 视图零 IO 应答;分面可见性/版本/注释随语义面扩展;证据 docs/kode2/pr-010.md)
- [ ] LSP-004 Definition / Declaration / TypeDefinition：`.def` ↔ `types.xml` ↔ `.py` ↔ 引擎源码。
- [ ] LSP-005 References：跨 root 实体/方法/组件/类型，区分语法同名和真实语义引用。
- [ ] LSP-006 DocumentSymbol / WorkspaceSymbol 提供快速搜索与稳定排序。
- [ ] LSP-007 SignatureHelp / parameter hints 使用类型 IR，不单独实现一套解析。
- [ ] LSP-008 Rename 全工作区可编辑范围分析；合成 preview，避免重命名错误同名符号。
- [ ] LSP-009 Diagnostics 分 local syntax / semantic / engine compatibility / runtime config，独立节流。
- [ ] LSP-010 CodeAction 包含创建缺失定义、修复参数类型、定位冲突、调整 include/registry。
- [ ] LSP-011 InlayHints (RPC 参数名/类型) 与 SemanticTokens；评测增量 token 更新成本。
- [ ] LSP-012 CallHierarchy、TypeHierarchy、Entity dependency navigation 可借 LSP 标准能力。
- [ ] LSP-013 Outline / breadcrumbs / folding / linked editing 不触发另一次完整 parse。
- [ ] LSP-014 无 KBEngine 工作区的普通 Python 文件不得受到 Kode 语义劣化影响。
- [ ] LSP-015 Pylance/Pyright 等 Python 语言服务间职责与冲突矩阵；禁止重复 diagnostics、重复 completion 轰炸。
- [ ] LSP-016 所有 LSP 功能测 stale response、cancel、cold workspace、workspace root 变化和 Core 重启。
- [ ] LSP-017 UI 大结果 views 采用虚拟列表和延迟节点加载，避免 Webview 一次渲染万级节点。

## 9. Python 分析与 typings（关键产品能力）

- [ ] PY-001 明确 Python version、语法方言与 KBEngine 引擎支持版本；以 workspace profile 区分。
- [ ] PY-002 对接可复用的 Python AST/语言服务分析能力；如需 Rust parser，先验证覆盖率与来源定位。
- [ ] PY-003 Python class / method / function / variable 分层 symbol 索引与 importer map。
- [ ] PY-004 `entities.xml + *.def + types.xml + *.py` 映射在同一语义图中保留 sources。
- [ ] PY-005 自定义 type（包括被 `types.xml` 引用的用户定义）生成有效 `.pyi`。
- [ ] PY-006 所有 `.def` entity、组件及 Cell/Base/Client API 生成相应 `.pyi`，保留精确参数与容器类型。
- [ ] PY-007 所有项目 Python 文件的 typings 策略：需要澄清是解析输出镜像、类型增强或导出 .pyi；先写产品 spec，禁止以空壳 `Any` 作为完整实现。
- [ ] PY-008 为未注解 Python 签名按可置信信息推断；未知保留 `Any`/`Unknown` 并输出覆盖率与原因。
- [ ] PY-009 KBEngine 引擎 builtin API `.pyi` 按版本/commit 生成，支持用户引擎分支覆盖。
- [ ] PY-010 生成 `.pyi` 源映射记录生成符号→原文件 URI/span/root，含多源汇聚优先级。
- [ ] PY-011 `.pyi` 跳转用户定义时配置拦截策略：从 stub 逆向跳源；适配 Python LS 的定义规则。
- [ ] PY-012 `.pyi` 输出目录隔离、`pyrightconfig` / analysis.extraPaths 集成，禁止不经确认覆盖现有配置。
- [ ] PY-013 增量生成仅刷新受影响 stubs；输出原子写入、不改未受影响文件 mtime。
- [ ] PY-014 生成稳定排序/格式，避免无意义 diff；输出 manifest/hash/源映射/schema 版本。
- [ ] PY-015 import 循环、自定义 alias、容器递归、同名类、重名实体和重复 root 测试。
- [ ] PY-016 生成输出目录默认 `.gitignore` 建议而非擅自编辑；manifest 标注 Generated，不允许重命名覆盖用户自写 stubs。
- [ ] PY-017 快速预览 API 类型树、typing coverage、缺失映射和来源跳转。
- [ ] PY-018 开启/关闭 typings 时测试语言服务器行为、索引失效与诊断收敛。
- [ ] PY-019 类型生成器作为 API provider 可扩展，但官方核心类型 IR 是唯一数据源。
- [ ] PY-020 对 Pylance/Pyright 分别用真实环境验证导航和 stub 优先级，不凭猜测宣称跳源成功。

## 10. KBEngine 工程、引擎版本与专业工具链

- [ ] KBE-001 workspace discovery：从资源目录、环境变量、配置、源码结构识别 KBEngine 工程，明确优先级。
- [ ] KBE-002 项目向导含引擎版本、资源 roots、脚本环境、component paths、server startup config。
- [ ] KBE-003 Engine profile：官方版本、fork、commit、特性探测能力；unknown 时不伪造版本。
- [ ] KBE-004 API metadata 与真实 engine source 绑定，支持导航到 engine C++/Python 定义和 version constraints。
- [ ] KBE-005 校验 entities.xml 注册完整性，`.def`/Python 配对、组件缺失、属性与方法一致性。
- [ ] KBE-006 KBEngine RPC 方法参数与序列化类型兼容性检查，指出 client/base/cell 分面。
- [ ] KBE-007 检查别名循环、类型重定义、不可序列化字段、未知类型和覆盖规则。
- [ ] KBE-008 实体关系浏览器：实体—组件—继承—引用双向探索和懒加载图谱。
- [ ] KBE-009 创建实体/组件/RPC/数据类型的向导，预览实际受改文件并允许撤销。
- [ ] KBE-010 配置合并视图（来源、优先级、冲突、最终值）不阻塞语言请求。
- [ ] KBE-011 数据库 schema 视图和 drift 检查与语义 Core 相连，但 DB driver/SQL 操作走独立隔离服务。
- [ ] KBE-012 Debug Adapter 边界：Python debug、远端 attach、engine session 生命周期，不让 Core 兼任 debugger。
- [ ] KBE-013 运行时 Process/Telnet/Watcher/Log 的 service adapter 分离、权限校验、断线重连、资源清理。
- [ ] KBE-014 Space/Watcher 按真实引擎协议实现：协议未验证前不得宣称支持 mutation/subscription。
- [ ] KBE-015 集成示例项目和真实 engine fixture；与 KBEngine forks 差异测试。
- [ ] KBE-016 Multi-workspace 子项目和多资源 root 的工程模型；显式配置文件示例。
- [ ] KBE-017 Project Doctor：缺少引擎路径、Python 环境、错误 root 顺序、重复实体、索引状态。
- [ ] KBE-018 保留现有 dashboard/monitor/log viewer 能力，迁移前后做功能 parity 表。

## 11. 后台执行器、命令与日志（独立于 LSP）

- [ ] EXEC-001 抽象 CommandDefinition / RunSession / ProcessHandle / TerminalHandle，不同执行语义各有适配器。
- [ ] EXEC-002 提供“复用运行会话”与“每次隔离进程”两种模式，按任务性质选择。
- [ ] EXEC-003 Python REPL 常驻 worker 用 JSON-RPC/有界消息、心跳、取消和异常恢复，绝不默认跨任务污染解释器状态。
- [ ] EXEC-004 交互式程序使用 VS Code terminal/Pseudoterminal，后台批处理使用可见输出面板和 session 管理。
- [ ] EXEC-005 后台执行时不弹出终端（如用户选择），但要清楚显示进程状态、退出码、可取消/可查看日志。
- [ ] EXEC-006 日志统一事件模型：time、source、level、session、correlation_id、structured fields、line text。
- [ ] EXEC-007 stdout/stderr/file/telnet/remote log 统一入口，保留流来源；去重仅在明确规则下执行。
- [ ] EXEC-008 日志聚合 ring buffer、流式过滤、磁盘轮转、文件 tail；避免把全部日志导入 Webview。
- [ ] EXEC-009 大日志 viewer 分页/virtualization/backpressure；搜索和导出可取消。
- [ ] EXEC-010 执行命令必须遵守 workspace trust、用户确认、机密遮蔽；默认不自动运行项目脚本。
- [ ] EXEC-011 Windows/Linux/macOS 环境变量、shell 引号、编码和终止进程树的测试。
- [ ] EXEC-012 Session 重用与纯进程启动建立基准，准确分辨“terminal 窗口”与“Python 冷启动”耗时。
- [ ] EXEC-013 诊断命令 hangs、空闲 session、进程退出、pipe 阻塞和输出丢失。

## 12. 插件系统（先扩展点，后生态）

### 12.1 扩展层级
1. Workspace declarative pack：schema/API metadata、模板、诊断规则描述符（无代码执行）。
2. TypeScript VS Code-side extension：UI、命令、导航面板，通过 VS Code extension API 及 Kode public API 协作。
3. Out-of-process plugin host：需要运行代码的分析器、生成器、工具提供者，以受限 RPC/能力模型运行。
4. WASM runtime（可选、实验性）：确定性纯计算变换；经基准证实后才引入。

- [ ] PLUG-001 定义 `kode-plugin.json` schema：id/version/apiVersion/entrypoint/capabilities/contributions/permissions。
- [ ] PLUG-002 扩展点：type provider、engine-version provider、diagnostic rule、code action、generator、project detector、template、runtime adapter、view contribution。
- [ ] PLUG-003 插件只能请求 QueryService / TypeService / ProjectService / ArtifactService 的稳定 DTO，不暴露 mutable Rust graph。
- [ ] PLUG-004 为 CPU、超时、内存、RPC 输出大小、并发配额制定 policy，阻止慢插件拖垮语言请求。
- [ ] PLUG-005 安全隔离：默认 trusted built-in；第三方需要显式安装/授权，声明文件/网络/执行能力。
- [ ] PLUG-006 Plugin host 崩溃、挂起、协议不兼容时自动停用插件并保留核心功能。
- [ ] PLUG-007 插件贡献顺序显式：builtin < engine profile < workspace override（示例，最终按 ADR 审核）；冲突显示来源。
- [ ] PLUG-008 插件 API SemVer、版本协商、弃用窗口、兼容性检查。
- [ ] PLUG-009 配置隔离及密钥在 SecretStorage，禁止写插件 metadata 或 trace。
- [ ] PLUG-010 诊断规则执行结果以 file version/generation 固定，废弃过期插件结果。
- [ ] PLUG-011 generator 支持 dry-run/preview、权限列表、atomic write 和冲突合并。
- [ ] PLUG-012 测试最小 sample 插件：新增自定义类型、诊断、生成器、version profile 四项。
- [ ] PLUG-013 独立插件测试工具与 manifest validator，例子/文档/教程。
- [ ] PLUG-014 插件市场属于远期选项，第一版优先稳定 SDK 与本地安装能力。
- [ ] PLUG-015 对“Python 插件”采用独立 Python worker RPC，不把 CPython 嵌入语言 Core；验证启动/内存成本。
- [ ] PLUG-016 插件基准：安装 0/5/20 插件下 hover/definition 尾延迟不超配额，恶意死循环隔离测试。

## 13. UI / UX / 可观测与故障恢复

- [ ] UI-001 Project Explorer lazy-load；实体、组件、类型、脚本视图共享 Core 索引。
- [ ] UI-002 状态栏：Core ready/indexing/partial/error、engine profile、resource root、索引进度。
- [ ] UI-003 专业性能面板：队列、缓存、索引生成、P95/P99、主要慢请求及处理建议。
- [ ] UI-004 Core 重启功能、清缓存功能（展示范围/影响）、export diagnostics；勿要求用户清空 workspace 才能修。
- [ ] UI-005 所有非即时能力使用 progress + cancel，避免「一直转圈」。
- [ ] UI-006 生成 typings 的预览/路径/来源图/覆盖率与冲突说明。
- [ ] UI-007 类型信息 UI 显示 Cell/Base/Client 上下文与版本差异，明确 unknown。
- [ ] UI-008 Graph view 小图即时渲染，大图按需加载；Webview CSP 禁用远程 CDN。
- [ ] UI-009 远端不可用、未安装 Core、协议不匹配、索引异常的可理解错误与修复操作。
- [ ] UI-010 多根工作区用户可选择 active project/root，并在跨根跳转时展示完整归属。
- [ ] UI-011 设置分组 performance/semantic/python/typings/engine/runtime/plugins，兼顾默认简洁和高级选项。
- [ ] UI-012 记录用户可禁用重扫描的配置，但禁用后必须标明结果可能部分不可用。

## 14. 测试、正确性、安全与发布门禁

- [ ] QA-001 Unit: parser errors, byte spans, UTF-16 position, alias cycles, entity facets, source map。
- [ ] QA-002 Property-based/fuzz: XML/DEF invalid input never panic/hang；path canonicalization 无碰撞。
- [ ] QA-003 Golden: 基于真实引擎 fixtures 的 hover/definition/diagnostics/typings snapshot。
- [ ] QA-004 Differential: 对旧 TS 输出与新 Rust 输出逐项差异审查，已知旧 bug 单独定标。
- [ ] QA-005 Integration: VS Code Extension Host + native server e2e，对比用户可见结果。
- [ ] QA-006 Python LS interoperability：Pylance / Pyright、不同 Python 环境和 .pyi 优先级。
- [ ] QA-007 Workspace 兼容：Windows path、Linux case、macOS case-insensitive、WSL、SSH、containers。
- [ ] QA-008 Engine 兼容：官方支持版本 + 用户 fork，profile 未知降级。
- [ ] QA-009 Security：workspace trust、命令注入、路径穿越、生成文件覆盖、恶意插件、高频日志敏感数据。
- [ ] QA-010 Resilience：Core kill、client disconnect、损坏缓存、文件 watcher flood、磁盘满、权限拒绝。
- [ ] QA-011 Memory & race：1h 编辑负载、循环增删根、索引与 diagnostics 并发、高频 restart。
- [ ] QA-012 Protocol compatibility：旧客户端/新 Core、新客户端/旧 Core 均有正确握手/错误。
- [ ] QA-013 性能发布门槛同时检测 P95、P99、max、CPU、RAM、index correctness。
- [ ] QA-014 生成覆盖率达到门槛前不得标“所有 Python 文件类型完整生成”。
- [ ] QA-015 每个修复 PR 附复现脚本、测试证据、profile/perf delta、回退计划。
- [ ] QA-016 大型功能启用 feature flag，只有 parity/perf 完成后再移除旧实现。
- [ ] QA-017 自动发布必须遵循现有仓库的手动发布规则，避免重构顺手改变 release governance。

## 15. 分阶段 PR / 依赖、验收与里程碑

### Phase 0 — 基线与冻结（先于任何重写）
- [ ] PH0-01 完成 AUDIT-001..015 与 PERF-001..016；生成现状架构图、基准报告、迁移表。
- [ ] PH0-02 锁定旧功能 parity fixture 和旧 TODO 完成状态；输出 release gate。
- [ ] PH0-GATE 无完整基准和正确性 fixture **禁止进入 Rust 替换阶段**。

### Phase 1 — Core 骨架（最小垂直切片）
- [ ] PH1-01 实现 BUILD-001..016、CORE-001..004、CORE-015..016。(进行中:PR-003 已落 BUILD-001/002/003、CORE-001/002/003、CORE-015/016 最小版,证据见 docs/kode2/pr-003.md;余项随 PR-004..007)
- [x] PH1-02 Rust 服务与 TS client 握手、打开/编辑/关闭文件、cancel、健康状态 e2e。(PR-003:tests/kodeCoreE2E.test.ts 真实 kode-server 二进制,4 用例)
- [ ] PH1-03 实现 VFS 基础；以单文件 `.def` Hover 或 Definition 做真实垂直切片。(进行中:PR-004 已落 VFS-001..013 基础版+kode-server 文档同步对接,证据 docs/kode2/pr-004.md;PR-010 已落 Hover 垂直切片(响应链+TS 面对拍 100%),Definition 随后续单)
- [ ] PH1-GATE Rust 与旧实现同场景一致；无长任务阻塞 VS Code；跨平台可启动。

### Phase 2 — 解析与索引（最大性能收益路径）
- [ ] PH2-01 完成 VFS、SYNTAX 与 IDX 的基础版本，先 `.def`/types.xml/entities.xml/alias.xml。
- [ ] PH2-02 文件监听与增量失效；运行 10k fixture，不出现全仓 rebuild 风暴。
- [ ] PH2-03 迁移 hover/definition/diagnostics 到 Rust 双轨模式；记录 latency correctness 差异。
- [ ] PH2-GATE 同输入与旧行为比对完成，增量命中率与尾延迟过关，无严重语义回归。

### Phase 3 — 专业 KBEngine 语义和完整 LSP
- [ ] PH3-01 完成 SEM、LSP；实体/组件/继承/Cell/Base/Client 信息统一。
- [ ] PH3-02 支持多 root 同名，引用、rename、代码操作与 CallHierarchy。
- [ ] PH3-GATE 冷启动/热缓存/并发编辑/跨 root 场景全部性能和正确性过关。

### Phase 4 — Python 与 typings
- [ ] PH4-01 完成 PY-001..020；与现有 Python LS 共同工作。
- [ ] PH4-02 types.xml 自定义类型、用户 Python 文件、引擎 API stubs、生成→源导航全流程。
- [ ] PH4-GATE 在实际 Pylance/Pyright 环境验证类型提示与源跳转，不只测输出文本。

### Phase 5 — KBEngine 专业 IDE
- [ ] PH5-01 实现 KBE-001..018、UI-001..012，保持已有工具能力。
- [ ] PH5-02 将运行时协议/DB/debug/log 控制拆成独立服务，避免影响 LSP latency。
- [ ] PH5-02A 将 HR-PR-02..07 纳入专业 IDE 验收，先行交付的 TS 功能保持兼容。
- [ ] PH5-GATE 界面功能 parity 与多个真实引擎工程测试通过。

### Phase 6 — 插件与执行管理
- [ ] PH6-01 实现 PLUG-001..016、EXEC-001..013，提供 sample 插件和 SDK。
- [ ] PH6-02 Python plugin 作为隔离进程 PoC，通过延迟与安全测试再正式发布。
- [ ] PH6-GATE 三方插件负载不会导致核心 language latency 显著劣化；权限隔离有效。

### Phase 7 — 稳定发布与去旧
- [ ] PH7-01 运行 QA-001..017 全套、48h 真实项目试用、跨平台打包与文档。
- [ ] PH7-02 仅在双轨功能 parity 和回退措施成熟后删除旧 TS 全仓解析逻辑。
- [ ] PH7-03 文档整理、版本说明、迁移配置、已知限制与性能对照报告。
- [ ] PH7-04 完成 HR-DOD-001..010 与 HR-PR-09 的安全、性能和状态正确性门禁。
- [ ] PH7-GATE 真实大型项目性能达标、无未解决阻塞缺陷，才发布稳定 2.0。

## 16. Code Agent 工作执行协议

每个 Agent/PR 必须遵守：
1. 先阅读本 TODO、docs/perf baseline、ADR、当前源代码和相关测试；核实任务前置依赖。
2. 任务只改一个边界或一组紧耦合文件；不得在一个 PR 中重写所有 Provider。
3. 在 PR 描述列明：问题证据、修改范围、行为差异、性能预算、测试、新增风险、回退方法。
4. 新索引功能必须测失效范围；新 API 必须有协议与兼容测试；新生成器必须有来源映射与覆盖保护。
5. 不凭主观感觉说“快”；记录同机器同 fixture 的重复测量和 profile。
6. 如果实现与旧 TODO/其他 Agent 冲突，先标记冲突，禁止覆盖另一 Agent 的工作。
7. 每完成一项修改 `[ ]`→`[x]` 时记录对应 commit、测试命令、报告路径，不允许无证据勾选。
8. 性能达标但 correctness regress、插件安全隔离失败、Core 崩溃无法恢复的 PR 不能合并。
9. README / features / docs / changelog 与代码一致；未实现项目不得写成现有功能。
10. 涉及用户文件写入、自动运行、网络连接、插件权限变化的行为必须单独审核。

## 17. 建议的首批 12 个 PR（严格顺序，避免大爆炸重构）

- [ ] PR-001 `audit/perf-baseline`：现有入口/四主请求调用链、profile、fixtures、基线报告；不改行为。
- [ ] PR-002 `fix/ts-hotpath`：将旧 TODO A2/A3 已识别的明显阻塞路径止血并提供测量证据。
- [x] PR-003 `infra/rust-workspace`：Cargo workspace + binary packaging + protocol handshake + e2e。(落地:crates/kode-{protocol,server}+rust-toolchain pin+ADR-001/002+src/kodeCoreClient.ts;证据 docs/kode2/pr-003.md)
- [x] PR-004 `core/vfs-snapshot`：overlay + incremental edit + canonical paths + version tests。(落地:crates/kode-vfs+kode-server 文档同步对接+协议 Position/Range DTO;证据 docs/kode2/pr-004.md)
- [x] PR-005 `core/def-xml-parser`：精确源位置与错误恢复 + fuzz + parser benchmarks。(落地:crates/kode-parser(自研零依赖字节级 XML 状态机,ADR-102)+ 对拍 golden 双向门禁(TS 28/28=100%)+ 增量零重建注册表 + release bench(P50 6µs/大样本 19.9MB/s)+ 盲样 1149 例 0 panic;fuzz 纲要随 fuzz 单;证据 docs/kode2/pr-005.md)
- [x] PR-006 `core/root-discovery`：多 resource root / engine profile / URI scopes。(落地:crates/kode-root(ROOT-001..015 基础版:优先级链显式配置>记忆>约定>有界深扫描+宁缺勿猜;平台路径规则 Win 折叠/mac 折叠声明/Linux 敏感/WSL UNC 拆段;submodule/vendored 边界+mount/symlink 环护栏+别名身份+敏感目录台账;引擎配置规则自 TS workspaceDiscovery 移植并逐条 file:line 证据化;UR+Path 双支持;诊断仅新启;TS 对拍 golden 双向门禁 6 树 48/48 字段=100%,tests/kodeRootParity.test.ts;证据 docs/kode2/pr-006.md)
- [x] PR-007 `core/symbol-index`：文件/符号索引、定向查找、generation 与删除清理。(落地:crates/kode-index(IDX-001..007+013/014/015 基础版,六类符号实体/属性/方法/类型/别名/组件,名称倒排+文件级增量复用 ParseCache 指纹零重建+原子 generation)+ 符号对拍 golden 双向门禁(TS 90/90=100%)+ 增量 rebuild 实测(200 文件首扫200/二扫0/单改1);证据 docs/kode2/pr-007.md)
- [x] PR-008 `core/type-graph`：types.xml、alias、entity facets、component、inheritance。(落地:crates/kode-types(书命名 kode-semantic;SEM-002/004/005/007/013 基础版:类型图 IR+六种边+别名链/继承链/全图三色 DFS 环检测,有限步显式诊断)+ 类型面对拍 golden 双向门禁(文件面 28/28+图级 37/37=100%,TS 用现有 defParser/compositionRoots 复算;按 ARCH-012 不做性能对比);证据 docs/kode2/pr-008.md)
- [x] PR-009 `core/invalidation-scheduler`：reverse DAG、任务优先级与 cancel。(落地:crates/kode-scheduler(SCHED-001..021 内部清单=§4 CORE-005..008/017+§7 IDX-003/013/015 调度面基础版,书无 SCHED 编号已如实映射;失效图文件→声明名→反向受影响集+分批重建+风暴合并+五级优先级+取消+有界队列+暂停恢复+崩溃恢复台账+指标)+ 调度面对拍 golden 双向门禁(10 场景,TS 真实 IndexScheduler 复算 148 字段=100%,tests/kodeSchedulerParity.test.ts);证据 docs/kode2/pr-009.md)
- [ ] PR-010 `lsp/definition-hover`：首批 TS→Rust provider 双轨对比，逐步切流。(基础版落地:kode-server hover 响应链(定位→文档→签名→继承成员,textDocument/hover+hoverProvider capability+didOpen/Change/Close 语料视图联动)+对拍 golden 双向门禁(TS defParser/compositionRoots/defChain 复算:文件面 28/28+悬停面 90/90=100%)+环截断/缺父/UTF-16 词提取单测;Provider 切流随后续单;证据 docs/kode2/pr-010.md)
- [x] PR-011 `lsp/completion-diagnostics`：版本化发布与可取消查询。(基础版落地:kode-server textDocument/completion 请求链(URI→position→上下文→条目集:实体/属性/方法分面/类型/别名/继承成员)+completionProvider capability+可取消(-32800)+版本化应答(overlay 严格 version 转移)+对拍 golden 双向门禁(TS defParser/defChain 复算:文件面 28/28+场景面 205/205=100%,671 条目/继承 13)+环截断/UTF-16/遮蔽单测;TS provider 零改动不切流,切流属 PR-012;证据 docs/kode2/pr-011.md)
- [x] PR-012 `perf/gate-phase2`：真实大型数据压力测试和性能/正确性验收，不通过禁止继续扩大迁移。(gate2 61fe132 总判定 FAIL（G-C 201×1 别名面差）→ 修复 5db0a33 → gate3 复判 PASS 五门全绿: compDiverge 201→0、悬停双轮 404/404、双轨 P95<1ms、burst 0 错/RSS 4.97MB; 正本 pr-012-gate2-run.txt + pr-012-gate3-run.txt + pr-012-perf-gate.md 复判节; 剩余差异 §8 设计边界（.py 面归 PH1）; 扩大迁移禁止解除, 切流仍受 pr-012 §4 前置清单约束, serveFromRust 恒 false 不变)

## 18. 关键架构决策待验证清单（不提前拍脑袋）

- [ ] ADR-101 Salsa 与自研 revision query engine：根据 query DAG 大小、内存、工程维护成本决定。
- [ ] ADR-102 quick-xml + spans / rowan / tree-sitter：根据错误恢复、源映射、增量表现决定。
- [ ] ADR-103 SQLite vs redb vs mmap cache：用 2k/10k/50k 数据集比较 cold startup/写放大。
- [ ] ADR-104 标准 LSP vs custom RPC：标准编辑器功能优先 LSP，专用交互使用命名空间协议。
- [ ] ADR-105 Python engine AST/LS 方案：优先复用成熟 Python 工具的行为，避免维护第二套完整 Python LS。
- [ ] ADR-106 Rust plugin runtime：进程隔离先于 WASM 嵌入；Python provider out-of-process PoC。
- [ ] ADR-107 用户工作区引擎源码 metadata：自动索引范围与成本预算，允许仅需的 symbols。
- [ ] ADR-108 插件规则优先级与文件写权限；明确可解释来源和冲突机制。
- [ ] ADR-109 同名多根实体的判定/排序/冲突语义，由 fixture 和实际引擎加载行为确定。
- [ ] ADR-110 `.pyi` navigation source mapping 接入方式：Pylance/Pyright 限制需要实测。

## 19. HR — 热更新 / 文件监听 / 模块名 / Hash 专项（新增、必须实施）

> 本节覆盖手动热更新与自动 Watch，不能做第二套彼此分离的 HTTP 功能。用户已确认：**HTTP 热更新的模块名只需文件名（去掉 .py）和直接父目录名；界面完整展示模块路径**。
> 已知 Kode 文档存在可配置 HTTP Quick Requests、模块变量、手动调用与结果输出；Watch、Hash、成功确认的**代码实现程度未证实**，下面均为审计/开发任务，禁止标成已完成。
> HTTP 示例中若出现 `relaod`，视为兼容性输入：不得不核查服务器实现就自行更正请求字段。

### 19.1 不可变的功能规范和示例

```text
已识别的脚本资源根: scripts/
相对文件路径: entities/fight/FightAI.py
实际 HTTP 请求模块名: fight.FightAI
UI 完整模块名: entities.fight.FightAI
文件短名: FightAI
文件绝对 URI: file:///.../scripts/entities/fight/FightAI.py
```

```text
scripts/base/Avatar.py             -> requestModule=base.Avatar,     fullModule=base.Avatar
scripts/entities/fight/FightAI.py -> requestModule=fight.FightAI,   fullModule=entities.fight.FightAI
scripts/entities/npc/NpcAI.py     -> requestModule=npc.NpcAI,     fullModule=entities.npc.NpcAI
scripts/common/utils/math.py      -> requestModule=utils.math,    fullModule=common.utils.math
```

**规则**：以明确配置的脚本资源根为起点解析 fullModule，`requestModule = basename(parentDirectory) + '.' + basenameWithoutPy`，不允许从 OS 绝对路径盲目截取；即使 requestModule 相同，记录也必须由 targetId + rootId + canonical URI 唯一化。UI 名称永远是 fullModule，并在详情展示请求字段，不能反过来只显示缩写。异常路径如 `__init__.py`、根下单层脚本、namespace package、重复路径、非 `.py` 和多根冲突必须判定为 explicit unsupported / require mapping，不擅自提交 HTTP 请求。

**HTTP 成功分类**：`transport_success`（请求/2xx）≠ `accepted`（服务接受）≠ `applied`（运行中目标明确确认应用），没有可信的业务确认只能显示“请求已发送/待确认”，不得绿色显示“已热更新”。无服务器回执时手动与自动的语义相同。

**安全约束**：默认自动热更新关闭；必须显式开启某个可信 workspace 的特定 target；只允许经过批准的 endpoint、脚本根与可热更文件类型；`.def`、`types.xml`、`entities.xml` 不得默认自动应用，原则上显示变化、风险和“可能需重启”。

### 19.2 现状审计及兼容迁移（HR-AUDIT）
- [ ] HR-AUDIT-001 固定当前 commit SHA；核对 `package.json` commands/config/views/keybindings、README 和旧 todo 的 HTTP 热更新说明，建立逐项事实表。
- [ ] HR-AUDIT-002 使用 `rg 'httpRequests|reload|hotfix|hotReload|watch|\.def|digest|md5|sha256|hash'` 以及 import graph 找出全部相关实现和注册入口。
- [ ] HR-AUDIT-003 追踪现有 Quick Request：用户操作→变量展开→URI/Body 组装→HTTP transport→错误处理→输出面板。
- [ ] HR-AUDIT-004 提取现有 `${module}` 的确切逻辑、资源根识别、大小写处理、特殊 `.py` 文件处理，记录所有现有模板变量。
- [ ] HR-AUDIT-005 搜索现有 VS Code `FileSystemWatcher` / `onDidSaveTextDocument` / 低层 fs watcher / config watcher 的创建、dispose、生命周期与功能归属。
- [ ] HR-AUDIT-006 确认 HTTP 快捷请求中支持的方法、header、URL、body、超时、重试、输出与 SecretStorage 等已有实现，避免重造。
- [ ] HR-AUDIT-007 检查是否已存在热更新历史、状态栏、TreeView 装饰、通知、实时请求时序、失败重试。
- [ ] HR-AUDIT-008 搜索 `.def` Hash/Digest/协议签名与 KBEngine 引擎实际算法实现，区分文件哈希、语义指纹及引擎 Digest。
- [ ] HR-AUDIT-009 找到引擎/HTTP 服务端实现或协议说明，确认请求参数拼写、响应 JSON 字段、目标进程、是否可查询 applied revision。
- [ ] HR-AUDIT-010 在真实项目测试手动更新成功、HTTP 200 但应用失败、服务器未响应、模块名冲突，记录原始响应供 fixture。
- [ ] HR-AUDIT-011 建立保留/封装/替换矩阵；现有通用 Quick Requests 保留通用用途，Hot Reload 用 adapter 复用。
- [ ] HR-AUDIT-012 记录复用模块确切路径与 owner 到 `docs/hotreload/current-implementation.md`；没有源码证据的项目标 `unknown`。

### 19.3 模块识别、双名称模型与兼容配置（HR-MOD）
- [ ] HR-MOD-001 定义 `HotReloadModuleIdentity{workspaceId,rootId,fileUri,fullModule,requestModule,fileStem,parentName,language,sourceVersion}` DTO。
- [ ] HR-MOD-002 定义 `ModuleResolver` 纯函数；输入 URI、明确资源根、profile、user override；输出 Result/diagnostics，无隐式 IO。
- [ ] HR-MOD-003 Python 模块拆分保留大小写，`.py` 仅移除结尾后缀，不因 `.pyi`、`.pyc` 假匹配。
- [ ] HR-MOD-004 生成完整模块名使用脚本根相对路径全部目录段；请求名只使用直接父目录+file stem。
- [ ] HR-MOD-005 手动命令与 Watch 使用同一个 ModuleResolver，禁止复制两套字符串处理。
- [ ] HR-MOD-006 多 script roots 使用 engine profile 明确优先级；未唯一确定根则要求选择/配置，不猜测。
- [ ] HR-MOD-007 `__init__.py` 专门规则经真实 HTTP 服务验证后实现；验证前跳过并给出诊断。
- [ ] HR-MOD-008 脚本资源根直接包含 `Foo.py` 时，必须有显式 single-level fallback 配置；默认标 unresolved。
- [ ] HR-MOD-009 URI canonicalization 兼容 Windows、Linux、macOS、WSL、Remote SSH、symlink、大小写敏感差异。
- [ ] HR-MOD-010 避免不同 root 的 `fight.FightAI` 请求映射错误；请求目标须包含 target 与 root/context（如服务端不支持则拒绝歧义自动更新）。
- [ ] HR-MOD-011 UI 默认显示 `fullModule`，辅以工作区/目标环境；请求详情显示 `requestModule`，不因列宽缩短实体身份。
- [ ] HR-MOD-012 设计 `${reloadModule}`、`${fullModule}`、`${fileName}`、`${relativePath}`、`${workspaceRoot}`、`${targetId}` 模板变量；现有 `${module}` 先审计再决定兼容映射。
- [ ] HR-MOD-013 对旧配置提供兼容迁移和预览请求的功能；不静默篡改已保存 URL 模板。
- [ ] HR-MOD-014 所有日志/历史同时存 fullModule/requestModule/fileUri/targetId，便于排查用户看到的名称与请求名称不同。
- [ ] HR-MOD-015 纯函数单测覆盖上述四个示例及特殊文件、路径穿越、URL encoding、Unicode、同名根/文件。

### 19.4 Watch / Save 事件流水线（HR-WATCH）
- [ ] HR-WATCH-001 默认 `off`，用户按 workspace/target 显式启用 `onSave`（默认推荐）或 `onDiskChange`。
- [ ] HR-WATCH-002 `onSave` 仅选择属于配置 script roots 且规则准许的 `.py` 文件；未保存的编辑不触发 HTTP。
- [ ] HR-WATCH-003 `onDiskChange` 使用原生 VS Code FileSystemWatcher，外部改动/生成/Git checkout 与 save 重叠需去重。
- [ ] HR-WATCH-004 只监听已声明的脚本根；排除 `.git`, `.venv`, `node_modules`, generated stubs, caches, 临时文件、swp、备份文件。
- [ ] HR-WATCH-005 监听生命周期绑定到 workspace/target/config，deactivate、root 移除、模式切换及时 dispose。
- [ ] HR-WATCH-006 实现 per-file debounce 与全局 max-delay 上限：防 save storm 也不无限推迟。
- [ ] HR-WATCH-007 等待写入稳定（短时间连续 stat/hash 一致）后再发送；尊重磁盘原子替换、rename 顺序。
- [ ] HR-WATCH-008 文件 hash 与最近已提交/已成功应用的版本指纹区分，不因一次失败永久跳过。
- [ ] HR-WATCH-009 原始事件归并为 `FileChanged{uri,revision,diskHash,source,time}`，记录合并原因供诊断。
- [ ] HR-WATCH-010 使用 canonical URI + targetId 合并待执行同文件更新；同内容同目标不重复发送。
- [ ] HR-WATCH-011 当文件 A 更新请求执行时又保存 B 版本，保证最终版本被请求，不把旧响应写成新版本成功。
- [ ] HR-WATCH-012 先做轻量 Python 语法检查/配置检查；有错误时标 `blocked`，不默认发送半成品代码。
- [ ] HR-WATCH-013 引擎脚本可热更规则支持 profile capabilities、路径 allowlist/denylist、自定义过滤器。
- [ ] HR-WATCH-014 停用时清理待提交队列；处理中请求依据策略取消/自然完成并更新 UI，不再重新入队。
- [ ] HR-WATCH-015 初次启动、切换分支、恢复窗口不默认对全仓历史文件触发更新；基线扫描不等于变更事件。
- [ ] HR-WATCH-016 大批量文件变化进入安全批次预览模式（可配置数量阈值），防无意向服务器发数百请求。
- [ ] HR-WATCH-017 写入用户可审查的诊断事件：trigger、filtered、debounced、deduped、blocked、scheduled。
- [ ] HR-WATCH-018 单测模拟 onSave、外部改动、原子覆盖、批量 rename、删除后重建、忽略目录、配置变更、远程 URI。

### 19.5 HTTP 适配、调度、幂等与成功确认（HR-HTTP）
- [ ] HR-HTTP-001 从现有 Quick Requests 抽取可复用 RequestExecutor；不可破坏普通通用 HTTP 功能。
- [ ] HR-HTTP-002 `HotReloadProvider` 接受 module identity、target、revision、request correlation id，产生结构化 outcome。
- [ ] HR-HTTP-003 保持自定义 URL/method/headers/body/变量模板，处理 URL query encoding、JSON escaping 与 HTTP method semantics。
- [ ] HR-HTTP-004 保留已有不规范 HTTP 字段拼写作为用户兼容输入，不未经核验自动更正 `relaod`。
- [ ] HR-HTTP-005 所有自动 HTTP 请求仅能发送到用户明确批准的 target endpoint；Workspaces 未信任时禁止发送。
- [ ] HR-HTTP-006 配置网络超时（连接/请求）、最大响应体、header/body redaction；HTTP client 连接池复用。
- [ ] HR-HTTP-007 按目标维护有界并发队列，默认同目标串行；其他目标允许独立并发且全局上限。
- [ ] HR-HTTP-008 支持请求取消和超时，明确取消不等于远端撤销；发送后未知状态必须显示 uncertain。
- [ ] HR-HTTP-009 重试策略：默认不自动重试状态未知的非幂等更新；仅服务端提供 idempotency key 后开启有限退避重试。
- [ ] HR-HTTP-010 解析网络失败、DNS/connect、非 2xx、2xx 无回执、显式 `accepted`、显式 `applied`、应用失败。
- [ ] HR-HTTP-011 引擎端如能返回 appliedRevision/appliedHash/targetProcess，则验证与当前请求 fingerprint 匹配才显示已应用。
- [ ] HR-HTTP-012 兼容老 HTTP 服务端纯文本/JSON 格式，通过 ResponseInterpreter 版本化策略解析，无法确证显示 `sent_unverified`。
- [ ] HR-HTTP-013 防旧响应覆盖新任务：结果 CAS 对比 targetId + canonical URI + requestedVersion；按时间戳不能代替版本校验。
- [ ] HR-HTTP-014 每次执行都生成 correlation_id，在日志、详情、服务端支持时贯穿；避免记录完整 token/header 凭证。
- [ ] HR-HTTP-015 断连/重连更新 endpoint health；health success 不等于任何模块已更新成功。
- [ ] HR-HTTP-016 在 HTTP 层额外提供 `Preview request`，用户确认精确 URL/method/参数后启用自动模式。
- [ ] HR-HTTP-017 Mock server e2e：慢响应、chunked、malformed JSON、状态码、断网、重复请求、服务端成功但本地超时。
- [ ] HR-HTTP-018 使用真实引擎侧服务联调，文档化实际回执字段；无法改服务端时 UI 明确显示未验证。

### 19.6 热更新生命周期状态与历史（HR-STATE）
- [ ] HR-STATE-001 定义 `disabled/idle/dirty/queued/checking/sending/accepted/applied/sent_unverified/failed/blocked/restart_required/unknown` 状态和迁移表。
- [ ] HR-STATE-002 区分 `lastRequestedHash`、`lastAcceptedHash`、`lastVerifiedAppliedHash`、`currentDiskHash`，不混用。
- [ ] HR-STATE-003 `applied` 仅在可信回执或引擎状态查询一致时赋值；旧版本已应用且磁盘又修改时显示 `dirty`。
- [ ] HR-STATE-004 状态按 `(workspaceId, rootId, targetId, uri)` 分区，不允许切换目标后复用旧绿色状态。
- [ ] HR-STATE-005 文件改名/移走/删除及时 tombstone 清理；旧 UI 不继续假显示成功。
- [ ] HR-STATE-006 多服务器多进程返回部分成功时显示 partial，并详细列出失败目标；不要合并成绿色。
- [ ] HR-STATE-007 保存可检索操作历史：time、trigger、fullModule、requestModule、target、duration、result、errorCategory、hash。
- [ ] HR-STATE-008 历史存储大小与保留时间限额，支持导出脱敏 JSON；无需持久化所有 HTTP body。
- [ ] HR-STATE-009 历史快照与当前文件状态分离；重启后不自动相信上一会话的 applied 状态，除非可复核运行时 revision。
- [ ] HR-STATE-010 错误原因可操作：配置错误、模块冲突、语法错误、目标不可达、应用失败、回执不可信、需重启。
- [ ] HR-STATE-011 接口支持 cancel、retry、retry-all-failed、pause、resume、clear-history；重试需要遵守幂等确认。
- [ ] HR-STATE-012 event store/UI 更新批处理并限制频率；1000 事件/秒不得产生 1000 次完整 UI 渲染。
- [ ] HR-STATE-013 reducer/property tests 覆盖乱序返回、重复回执、失败后文件再编辑、目标切换、Core 重启。

### 19.7 热更新 UI / 可视反馈（HR-UI）
- [ ] HR-UI-001 状态栏区分 `Watch Off`、`Ready`、`Sending`、`Sent (unverified)`、`Applied`、`Failed`、`Restart Required`。
- [ ] HR-UI-002 TreeView 提供最近更新/文件/目标分组，节点标题显示 **fullModule**，tooltip 显示 requestModule、URI、target、时间、请求 id。
- [ ] HR-UI-003 编辑器使用文件装饰或 CodeLens/overview 合理呈现最近热更状态，避免长期污染每一行代码。
- [ ] HR-UI-004 独立 Hot Reload 面板展示实时队列、历史、失败、当前目标、监听模式、请求详情和错误诊断。
- [ ] HR-UI-005 配置界面支持启用自动更新、监听模式、root、target、网络超时、语法检查、去抖参数、敏感操作警告。
- [ ] HR-UI-006 UI 明确完整名称与发送名称：`entities.fight.FightAI`；详情 `发送模块 fight.FightAI`。
- [ ] HR-UI-007 事件变化时高频 UI 更新合并节流；列表上千记录采用虚拟滚动与增量加载。
- [ ] HR-UI-008 失败点击定位文件、打开输出日志、查看 HTTP 概要（密钥遮蔽）、可选择重试。
- [ ] HR-UI-009 成功状态只用在确认 `applied` 的情境；`2xx` 没有业务回执用“已发送，未确认”。
- [ ] HR-UI-010 支持按 fullModule/target/status/时间范围过滤与搜索；路径相同但 target 不同分别显示。
- [ ] HR-UI-011 全面支持主题、国际化中文/英文、无障碍快捷键与 screen reader 状态文本。
- [ ] HR-UI-012 UI 关闭、隐藏、切换工作区不停止热更新服务，且不丢状态；deactivate 时可靠释放。
- [ ] HR-UI-013 热更新通知可配置：成功静默、失败提示、批量结果摘要；禁止每次保存弹通知风暴。
- [ ] HR-UI-014 同一完整模块名归属多个 workspace 时显示 root/target，防用户误认更新哪个服务。

### 19.8 `.def` / types.xml / entities.xml Hash 与运行时一致性（HR-HASH）
- [ ] HR-HASH-001 明确三层：`fileHash`（例如 SHA-256 原始字节）、`semanticHash`（稳定规范化语义结构）、`engineDigest`（实际引擎协议报告/确认的指纹）。
- [ ] HR-HASH-002 fileHash 在变更时流式增量/批量读取，复用 VFS 已有字节；避免 UI 每次显示都重新读文件。
- [ ] HR-HASH-003 semanticHash 输入为解析后的规范化 AST/IR，规范版本、字段顺序、空白/注释处理规则文档化。
- [ ] HR-HASH-004 语义 Hash 必须计入所依赖类型/引用定义的版本或在详情标明“仅本文件语义”，防误报完全一致。
- [ ] HR-HASH-005 引擎 Digest 仅来自已验证引擎算法或服务端回执；不能把本地 SHA-256 错标为运行时协议 Hash。
- [ ] HR-HASH-006 若项目 fork/引擎版本不同则交由 FingerprintProvider(profile) 解析；未知标 `not available`。
- [ ] HR-HASH-007 为 `.def` 增加 Hash Inspector：完整路径、三类值、算法/版本、计算时间、来源、复制按钮。
- [ ] HR-HASH-008 文件发生修改时比较上次本地指纹、当前语义指纹、服务端已应用 Digest（若可得），给出一致/不同/未知。
- [ ] HR-HASH-009 `.def` 差异分类：字段新增/删除/重排、类型更改、方法参数/分面变化、继承/组件变化、纯空白/注释。
- [ ] HR-HASH-010 对可能影响协议、序列化、Cell/Base/Client 兼容的更改默认标记 `restart_required`/`needs_review`，不自动热更。
- [ ] HR-HASH-011 对 `types.xml` 自定义类型变化分析 reverse dependency 受影响的全部 `.def`；生成影响报告。
- [ ] HR-HASH-012 `entities.xml` 注册项变化标注影响实体与版本状态；默认不发 Python 热更请求替代结构变更。
- [ ] HR-HASH-013 显示信息入口：`.def` 编辑器 CodeLens、状态条 tooltip、Definition Explorer 面板；巨大工程懒加载。
- [ ] HR-HASH-014 持久化仅必要 metadata 指纹，版本升级后需重新计算；不缓存敏感源码副本。
- [ ] HR-HASH-015 单测：同内容路径不同、换行变化、注释变化、语义改变、依赖变更、编译器/引擎 Profile 不同。
- [ ] HR-HASH-016 性能：单文件修改不触发全项目 Hash 重算；统计 bytes read、rehashed files、affected dependency nodes。
- [ ] HR-HASH-017 Engine Digest 兼容性测试必须对真实引擎实现验证，缺乏证据时明示不可用，不允许宣称引擎已经同步。

### 19.9 扩展 API 与引擎适配器（HR-EXT）
- [ ] HR-EXT-001 定义版本化 `HotReloadProvider`：canReload、resolveModule、prepareRequest、execute、interpretResponse、queryAppliedRevision。
- [ ] HR-EXT-002 定义 `FingerprintProvider`：computeLocalFile、computeSemantic、fetchEngineDigest、compare；声明算法版本与可信度。
- [ ] HR-EXT-003 定义 `HotReloadEligibilityRule`：按 engine profile、root、文件类型、上下文判定 auto/manual/restart。
- [ ] HR-EXT-004 第三方扩展无权限直接截获所有保存事件并随意联网；声明 workspace/network/exec 权限。
- [ ] HR-EXT-005 Python 插件通过隔离 Worker 可贡献 eligibility/response adapter，不允许在热路径无界阻塞。
- [ ] HR-EXT-006 自定义 HTTP 模板也视为 runtime adapter 的一个实现，用户可替换，不把 `reload` URL 写死在 Rust Core。
- [ ] HR-EXT-007 提供一个 stub provider 和 mock HTTP provider 的 SDK 示例、集成测试与权限用例。
- [ ] HR-EXT-008 新增 Provider 不应影响已有语言服务 hover/definition 尾延迟；经调度隔离与基准验证。

### 19.10 性能、可靠性、安全专项门禁（HR-QA）

> 以下为**候选目标**，须用当前仓库真实基线和固定机器明确最终阈值：单文件 Save→队列（不含配置 debounce）P95≤30ms；热更新本地 pipeline CPU 时间 P95≤15ms；UI 单次状态更新节流后≤100ms；高频保存不导致 extension host 事件循环长阻塞；网络耗时单独统计，不混为本地性能。

- [ ] HR-QA-001 基准定义：文件数 200/2k/10k/50k；单文件持续保存、Git checkout 500 文件、写入风暴、远端 SSH/workspace。
- [ ] HR-QA-002 统计 Watch→过滤→哈希→语法检查→队列→HTTP→回执→UI 各段耗时、P95/P99/max、排队与丢弃原因。
- [ ] HR-QA-003 连续保存 100 次同一文件验证 debouncing、最终版本提交、不会无限请求或错误绿色状态。
- [ ] HR-QA-004 500 文件同时变动触发批次确认/限流机制，无全仓热更风暴；UI 不冻结。
- [ ] HR-QA-005 模拟 10 秒 HTTP 超时+用户继续编辑；请求返回后不得把过期版本标成当前成功。
- [ ] HR-QA-006 模拟 HTTP 200 body `error`：状态必须失败；HTTP 200 无规范回执为未确认。
- [ ] HR-QA-007 endpoint 不可达、证书错误、代理错误、target 重启、部分节点成功各自输出可用错误。
- [ ] HR-QA-008 默认只允许经确认的 loopback/trusted endpoint；若允许非 loopback，要有明确授权与安全警告。
- [ ] HR-QA-009 确保 HTTP header/token 不出现在 output、trace、history、UI tooltip、导出数据中。
- [ ] HR-QA-010 阻止配置模板造成 SSRF/任意 file URI 泄露、路径穿越、恶意脚本执行；workspace trust 强制生效。
- [ ] HR-QA-011 Windows/macOS/Linux/WSL/SSH/DevContainer 路径与 localhost 指向测试，明确 HTTP 请求运行在本地还是远端。
- [ ] HR-QA-012 模块名矩阵测试（根、两级、三级、`__init__`、Unicode、重复根），HTTP 正确传短名且 UI 永远完整名。
- [ ] HR-QA-013 Rust Core 正在重建索引时热更新可继续工作，CPU/线程池/锁不可导致语言服务 tail latency 大幅恶化。
- [ ] HR-QA-014 存在热更新插件 0/5/20 个分别做 load test，插件崩溃不影响核心与主线程。
- [ ] HR-QA-015 用受控真实测试服务验证“accepted”与“applied”语义并固化协议 fixture。
- [ ] HR-QA-016 24h Watch/HTTP soak：无 watcher 泄漏、状态增长无界、连接泄漏、错误重试风暴。
- [ ] HR-QA-017 性能不达标时允许关 Watch 和回退至手动 Quick Requests；设置可恢复且无状态数据破坏。
- [ ] HR-QA-018 安全与功能完成矩阵按 target、engine profile、文件类型、触发方式逐项签收。

### 19.11 建议的 Hot Reload PR 顺序及依赖（先复用现有功能）
- [ ] HR-PR-01 `audit/hotreload-current`：HR-AUDIT 全部；输出调用链和已实现/缺失矩阵，不改功能。
- [ ] HR-PR-02 `hotreload/module-identity`：HR-MOD 全部 + pure resolver tests；手动热更先使用双名称模型；兼容原 `${module}`。
- [ ] HR-PR-03 `hotreload/request-adapter`：抽取通用 RequestExecutor + 状态机 + mock server；保证旧 Quick Requests 不回归。
- [ ] HR-PR-04 `hotreload/save-watch`：onSave 默认关闭，可开关、去抖、稳定性/幂等队列、基本语法检查。
- [ ] HR-PR-05 `hotreload/disk-watch`：外部变更、Git 批量变更、目录过滤、target 合并、远端环境。
- [ ] HR-PR-06 `hotreload/ui-status`：状态栏、资源树、历史面板、完整模块名、失败重试与可信回执。
- [ ] HR-PR-07 `hotreload/def-fingerprint`：file/semantic/engine 三种 Hash、影响分析、重启提示。
- [ ] HR-PR-08 `hotreload/plugin-api`：HotReloadProvider/FingerprintProvider/Engine Profile 版本化扩展。
- [ ] HR-PR-09 `hotreload/reliability-gate`：风暴/过期/断网/安全/24h soak 与跨平台性能报告。

**与总阶段关系**：`HR-PR-01` 可在 Phase 0 并行；`HR-PR-02..06` 可在 Phase 1～3 借现有 TS 代码先交付，待 Rust VFS/Index 成熟后只替换解析与指纹底座；`HR-PR-07` 依赖 SYNTAX/SEM/IDX 对稳定语义 Hash 的支持；`HR-PR-08` 依赖 PLUG 公共 API；`HR-PR-09` 为 2.0 发布门禁。**不要为了热更新功能等待整个 Rust 大重构结束**。

### 19.12 专项 Definition of Done（逐条不可跳过）
- [ ] HR-DOD-001 更改 `scripts/entities/fight/FightAI.py`：自动模式启用后只送 `fight.FightAI`；UI 展示 `entities.fight.FightAI`。
- [ ] HR-DOD-002 手动命令、onSave 和 onDiskChange 对同一模块生成完全一致的短名/全名。
- [ ] HR-DOD-003 在 HTTP 返回 200 但未提供可验证应用回执时 UI **不显示已热更新成功**。
- [ ] HR-DOD-004 连续保存 100 次不会导致同一旧版本无限请求或把旧回执当作当前结果。
- [ ] HR-DOD-005 关闭自动更新、未知根/特殊脚本、未知协议或不可信 workspace 均不产生自动 HTTP。
- [ ] HR-DOD-006 `.def` 编辑器能查看 File Hash / Semantic Hash / Engine Digest（不可得时明确标识），结构变化默认不自动应用。
- [ ] HR-DOD-007 跨目标、多 root、远端 SSH 不串数据、不串状态、不误发 HTTP。
- [ ] HR-DOD-008 热更新功能不拉高语言服务 P95/P99、无主线程同步文件风暴、内存/连接/watchers 不泄漏。
- [ ] HR-DOD-009 保留现有手动通用 HTTP 请求功能，文档明确旧 `${module}` 迁移与模板预览。
- [ ] HR-DOD-010 每一个任务附源码路径、commit、测试命令、结果截图或报告，未经验证不得打勾。

---

## 20. 交付定义（Definition of Done）

**代码完成不等于任务完成。** 每个阶段至少须具备：完整测试；前后性能对照；错误与恢复表现；平台兼容；文档；可回退；用户能力未丢失；可追溯的 benchmark 和 commit。所有既有 TODO 严格保留，直到完成逐项映射和状态核实。
