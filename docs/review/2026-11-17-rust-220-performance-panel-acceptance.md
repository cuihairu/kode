# RUST-220 验收纪要:专业性能面板(队列、缓存、索引生成、P95/P99、主要慢请求及处理建议)

日期:2026-11-17。本纪要对账 RUST-220(旧 UI-003,主 todo 排队项)的验收口径与交付证据。结论:**五维数据面全部既有(调度器/gauge/分位数汇总),缺的是聚合消费面——本批补性能面板快照命令(纯核渲染+接线+manifest+测试),属真增量。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| 队列 | 诊断调度 queued/inFlight(与 showActiveTasks 同探针 DIA-006)+ 索引调度 queued/running/failed/completed/cancelled + 按优先级排队分布 | `src/backend/performancePanel.ts`(队列段);RUST-187 探针 |
| 缓存 | 解析文档缓存(条/字节 vs 上限+占比%)+ 数据库 schema 缓存 + 返回注解索引(TTL) | 三 gauge:`getParsedDocumentCacheGauge`/`getDatabaseSchemaCacheGauge`/`getReturnAnnotationCacheGauge`(既有);面板缓存段 |
| 索引生成 | SchedulerMetrics 五项:合并去重/过期丢弃/交互推迟(累计让出 ms)/失败恢复——**本批前无用户可见消费面**(RUST-219 侦察缺口) | `src/backend/indexScheduler.ts:87-98`(数据面既有);面板索引生成段(本批) |
| P95/P99 | 逐操作族 P50/P95/P99/max/命中率(PR1 既有汇总面 showSummary);面板慢请求榜复用同源 getAllOperationSummaries | `src/languageServiceMetrics.ts:64-85,231`(既有);面板慢请求段(本批,聚焦前 5) |
| 主要慢请求及处理建议 | 按 P99 降序前 5(count=0 空窗口行排除不冒充)+ 阈值映射既有取证入口:P99>1s→CPU profile+`[kode-lsm]`/`[kode-hover]` 日志过滤;P99>200ms→观察队列/缓存或开 `kbengine.metrics.detailed`;全低速→「无异常慢请求」零打扰 | `slowRequestSuggestion`(本批);取证入口既有(IDE-MET-007/2026-10-22 接线) |

## 本批增量(feat eeb0d3eb)

- `src/backend/performancePanel.ts`(新):五段固定(队列→索引生成→缓存→主要慢请求→处理建议)快照渲染纯核;建议=阈值映射既有入口,不发明新诊断。
- `src/loggingWiring.ts`(接线):新命令 `kbengine.metrics.showPerformancePanel` 渲染进 Kode Language Service Metrics 通道;wireLogging 增 indexScheduler 注入(extension.ts 调用点同步)。
- manifest:`package.json` contributes.commands+onCommand、双 nls 键;commands.md 契约小节(docsCommands 门要求,单元门内)。
- 测试:`tests/performancePanel.test.ts`(新,6 例:五段齐备/索引五项+三 gauge/降序榜+空窗口排除/无采样如实/建议三档/阈值边界 200/1001);prove-red 变异空窗口过滤→1 红→cmp 字节还原→复绿。
- 门禁:lint 0 / compile 0 / unit 10643 全绿(docsCommands 13 过)。

## 诚实条款

- 面板形态是**命令驱动即时快照文本**(与 showSummary/showActiveTasks 同模式),不是自动刷新的可视化面板;组件级 CPU/内存可视化另有 `kbengine.monitoring.show`(MonitoringWebView,引擎侧指标)。二者分工:性能面板=扩展语言服务自观测,监控面板=引擎组件观测。
- 「主要慢请求」取 P99 前 5,全量分位数表仍由 showSummary 承载(面板注脚指路);进度率/百分比无调度总量数据面,不发明。
- 索引生成段计数是**全程累计值**(调度器生命周期内),非窗口速率;速率面板需时序数据面(无,不冒充)。
