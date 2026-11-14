# RUST-024 审计:关键请求指标采集面清单(P50/P95/P99/max、队列、排队、取消率、缓存)

日期:2026-11-15。审计对象:todo.md RUST-024(旧 PERF-007)「每个关键请求采集 P50/P95/P99/max、队列耗时、执行耗时、排队长度、取消率、cache hit/miss」。方法:逐维找现役采集面并核实消费点。**结论:六维全部有现役采集面,零生产码改动;唯一口径注意=「取消率」是派生值(公式在案),无单一现成字段。**

## 指标维度 → 现役采集面

| 维度 | 采集面 | 证据/样例 |
|---|---|---|
| P50/P95/P99/max | tests/perf/v02Baseline.bench.ts `metric()`(provider 级 n=100 采样) | V02-METRIC V02.large-30k.warm.hover n=100 p50=0.26ms p95=0.44ms p99=0.64ms max(102 条/跑);冷态 once() 单值 |
| 队列耗时 | diagnosticScheduler 记账 + KODE-PERF-006 场景实测 | 200 次连续编辑合并 1 次重算:computed=1 coalescedStale=199,排队+执行合计 wall=3.3ms(docs/perf/2026-11-04-process-topology-diagnostics.md) |
| 执行耗时 | PERF-005 分段纪律(11 类事件,每请求总耗时+发现/读取/解析/缓存命中计数) | current-state.md §PERF-005【Tested】;冷索引/暖查询/失效/重算分段数字在案 |
| 排队长度 | `DiagnosticScheduler.pendingWorkload(): {queued, inFlight}`(diagnosticScheduler.ts:163) | **已接线生产**:metrics channel 报告 `renderActiveTasksReport({operationCounts, scheduler: pendingWorkload()})`(loggingWiring.ts:124-127);测试消费 diagnosticScheduler.test.ts |
| 取消率(派生) | scheduler stats 六个丢弃/合并计数 ÷ requested | coalescedStale(排队被顶掉)/staleDropped(执行后版本前进)/releasedDropped(文档关闭晚到)/staleGenerationDropped(输入代切换)/disabledAsyncDropped;取消率=Σ(丢弃类)/requested,**派生口径,无单一字段**(诚实声明);KODE-PERF-006 实测取消路径 staleDropped=1 published=1 0.5ms |
| cache hit/miss | v02 bench `*.hits` 面 + 解析 LRU(flowVersionKey) | hoverHits/completionItems 等成对发射(hits/miss 同行可读);流敏感解析缓存 LRU 按文档版本键控(KODE-PERF-001,LRU max 8 + reset hook) |

## 每请求状态面(PERF-005 既有)

每请求记录:总耗时、文件发现/读取/解析/缓存命中计数、是否等待初始化、索引 generation、文档 version、结果状态(**ok/miss/取消/异常**)——取消作为请求终态已在单请求粒度记账(89e8783 埋点),与 scheduler 聚合统计互补。

## 缺口判定

- 六维全有采集面,无生产码缺口;
- 阈值与回归门(RUST-027/028)不在本条范围——本条只管「采集」;
- 「每个关键请求」的关键面=hover/definition/completion/diagnostics 四 provider + diagnosticScheduler 队列,均已覆盖;Rust Core 请求面回环时延已由 RUST-022 批补测(coreSpawn.bench.ts)。
