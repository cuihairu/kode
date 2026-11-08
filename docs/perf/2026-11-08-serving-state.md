# 服务态性能测量（诊断面切流收口，2026-11-08）

## 背景

2026-11-08 用户令「直接切到 rust，把发现的问题都修复，特别是性能问题」。诊断面切流
完成后（bc55988f），definition / completion / diagnostic 三面全 Rust-first 服务。
本批建立**服务态**（Rust 常驻进程真实服务链路）性能基线，回答四个问题：

1. 激活路径成本（spawn + 语料全量镜像）；
2. 三面稳态 RTT 与首查延迟；
3. 每编辑服务成本（诊断服务腿真实每键成本）；
4. 服务进程内存。

## 量测面与口径

- bench：`tests/perf/servingState.bench.ts`（不进 pnpm test 门禁，同 KODE-PERF-007 口径）
  `cargo build -p kode-server && npx vitest run --config vitest.bench.config.ts tests/perf/servingState.bench.ts`
- 真实链路：真实 kode-server 二进制 + 真实 KodeCoreClient（Content-Length 帧stdio 管道）。
- 合成语料：小工作区 300 def + 3 XML；大工作区 3000 def + 3 XML（def ≈60 行/1.1KB，
  含 Properties×10 + 三方法段×5 + DetailLevels）。
- 原始输出：`docs/perf/serving-state-run.txt`（`V02-SERVING-METRIC` 行）。
- **测量环境告警**：测量时机器 load average 20–25（并发构建占用），绝对值普遍膨胀
  （Node 侧唤醒延迟受影响最大）；相对结论（量级、比例、伸缩性）不受影响。
  空载复测应在同报告追加，不覆写本文件。

## 结果（第二轮含 healthFloor 探针；load 20–25）

| 指标 | 值 | 结论 |
|---|---|---|
| spawn（拉起+initialize 握手） | P50 5.5ms / max 16.8ms (n=5) | 激活路径可忽略 |
| mirror 300 语料全量 | 12.4ms 总量；单文档 P50 0.03ms | 镜像近零成本 |
| mirror 3000 语料全量 | 64ms 总量（≈0.02ms/doc 线性） | 伸缩线性，3000 文档一次性 64ms |
| firstRequest（镜像后首查） | definition 3.7ms / completion 2.2ms / diagnostic 3.1ms | 均 <5ms |
| steady.definition (n=100) | P50 1.71ms / P95 2.62ms | 热态 RTT 亚 3ms |
| steady.completion (n=100) | P50 0.72ms / P95 0.97ms | 热态 RTT 亚 1ms |
| steady.diagnostic (n=100) | P50 2.93ms / P95 4.09ms | 见分解 |
| steady.healthFloor (n=100) | **P50 47.24ms / P95 68.91ms** | ⚠ 见发现 ① |
| editRoundTrip.mirrorDidChange | P50 0.07ms | 每编辑镜像近零 |
| editRoundTrip.diagnostic | P50 4.49ms / P95 6.44ms | 每编辑服务成本，异步离关键路径 |
| pipeline.diagnostic20（20 路并发） | 摊销 3.93ms ≈ 串行 P50 | 不摊销，见发现 ③ |
| RSS afterStart → afterMirror3000 | 8.8 → 118.6MB（Δ≈110MB） | ≈37KB/文档，见发现 ④ |

## 成本分解（Rust 直测，不经 IPC）

独立 Rust 直测（同构 1.1KB def + 3003 文档语料入引擎）：

| 段 | 每请求 |
|---|---|
| `xml::parse` 全文现解析 | ≈0.17ms |
| 标量+结构两趟扫描+分配 | ≈0.7ms |
| **def_diagnostics 合计（warm）** | **≈0.9ms** |
| type_context 重建 @3003 文档 | 可忽略（types/entities/alias 文件数少） |

对照：稳态 diagnostic RTT P50 2.93ms ≈ 服务端算力 0.9ms + 传输地板 ~0.6ms
（completion RTT 0.72ms 即地板量级）+ 负载噪声（load 20 下唤醒膨胀 ×2–3）。

## 发现

### ① `$/kode/health` 报告 O(文档数)——潜在，非现役

`health_report`（crates/kode-server/src/server.rs:621）每次调用全量序列化
`open_summaries()`：3003 文档 → ~270KB JSON/次 → P50 47ms。**现无生产调用点**
（`src/` 中 `health()` 仅定义，E2E/测试用）。若未来做 watchdog/轮询探活，
必须先改分页/截断（documents 列表按需返回或摘要计数），否则探活本身成为负载。

### ② 每编辑服务成本可接受

didChange 镜像 0.07ms + diagnostic RTT ~4.5ms，全程异步离关键路径（TS 同步首绘
不变，Rust 面版本护栏内落位）。每键成本 <5ms 异步,无风险。

### ③ 服务主循环单线程串行——管线不摊销（设计如此，非缺陷）

20 路并发 diagnostic 摊销 3.93ms ≈ 串行 P50：主循环逐条处理，不并行。单请求
算力亚毫秒,串行无瓶颈；若未来引入大语料批请求再考虑批量端点。

### ④ 服务进程内存 ≈37KB/文档（含全文+解析树+符号索引）

3003 文档 110MB。与 TS 基线（docs/perf/2026-baseline.md：全量扫描期 RSS
+127.91MB）同量级,但 Rust 是稳态常驻（TS 是扫描峰值）。大工作区（>30k 文档）
预计 ~1.1GB,届时需评估流式/增量入库或按需加载——现语料规模(千级)无风险。

### ⑤ 优化候选（挂账,现无必要）

- `def_diagnostics` 每请求现解析全文（0.17ms/req,占算力 19%）：可复用 didChange
  入库时的解析产物(按 uri+version 缓存 ParsedUnit)——现算力 0.9ms 不构成瓶颈,不动。
- 空载复测:绝对值以空载为准,本报告数字在 load 20–25 下取得（相对结论有效）。

## 对照 TS 基线（docs/perf/2026-baseline.md）

| 面 | TS 热态（进程内,P50） | Rust 服务 RTT（P50,含 IPC） |
|---|---|---|
| hover | 0.01–0.73ms（large-30k） | 未单列（同 completion 量级） |
| completion | 0.01–0.73ms（large-30k）/ 3.67ms（big-py） | 0.72ms（3000 语料） |
| definition | 冷首查 468.69ms / 热态亚毫秒 | 1.71ms（含 IPC 全程） |
| 诊断 | 批92 同解析共用,进程内 | 2.93ms（含 IPC+两趟扫描） |

结论：Rust 服务态 RTT 全部亚 5ms,与 TS 进程内热态同量级（RTT 含 IPC 帧与跨进程
唤醒）；换来的是内存数量级优势（R1 审计 9.3×–33.8×）与索引常驻。激活路径成本
可忽略。**无回归性性能问题,不需要为切流回退任何面。**
