# 热更各段耗时统计(RUST-414 / 旧 HR-QA-002,2026-11-22)

- 车道:tests/perf/hotReloadSegment.bench.ts(bench 专用 lane,与主 unit 门无交集)
- 跑法:`npx vitest run --config vitest.bench.config.ts tests/perf/hotReloadSegment.bench.ts`
  (输出追加 docs/perf/hot-reload-segment-run.txt,`KODE_SEG_OUT` 可覆盖;ENV 行带 load1)
- 环境:node v24.21.0 / linux / 14 cpus / 200 文件 + 50 次顺序保存(基准机同
  docs/perf/hardware.md §1)
- 口径:热更保存流水线纯核(HotReloadSavePipeline)+ 真实盘上脚本 + 真实
  readSnapshot(读盘+sha256)+ 真实定时器;只观测不改行为;断言只有确定性语义
  命中面(段诊断三连计数/四主因计数),墙钟一律不进断言——阈值化归后续批次。

## 段矩阵实测(2026-11-22,load1=16.06,提交在库记录)

| 段 | 场景 | 关键值 | 语义闸 |
|---|---|---|---|
| S1 过滤 | 200 文件逐事件 isWatchableScriptFile(纯词法) | p50 0.02ms / p95 0.05ms / p99 0.12ms | 全收 200/200 |
| S2 哈希(并发) | 200 文件同窗 readSnapshot(读盘+sha256) | p50 28.23ms / p95 28.86ms(含 libuv 排队) | 200 trigger / 200 flushed |
| S3 语法 | checkSyntax 判定(透传闸) | p50 0ms / p95 0ms | — |
| S4 队列(并发) | 定稿→波次→发出,派生=(flushed-scheduled)-hash-syntax | p50 4.85ms / p95 5.56ms / p99 5.98ms | 200 样本 |
| S5 丢弃原因 | 归并/去重/语法拦/批量滞留 | debounced 1 / deduped 1 / blocked 1 / preview 1 | 四主因计数逐一相等 |
| **S6 无竞争段(顺序)** | 单文件 50 次顺序保存,逐保存 await 上一笔发出 | **hash p50 0.45ms / p95 3.4ms**;syntax 0ms;**queue p50 1.48ms / p95 1.67ms**;**totalCpu(Save→队列)p50 2ms / p95 5ms / p99 7ms / max 7ms** | 逐保存诊断三连 trigger/scheduled/flushed;hash+syntax 各 50 |

## 读法与诚实边界

1. **候选线对拍(§19.10)**:单文件 Save→队列(不含配置 debounce)**P95 5ms**,
   候选线 30ms 之下六个量级;本地 pipeline CPU 时间(队列段=定稿+波次+去重+
   版本号逻辑)**P95 1.67ms**,候选线 15ms 之下一个量级。两者都由 S6 无竞争段
   口径给(逐保存 await,无 libuv 读盘排队)。
2. **无竞争 vs 并发必须分列**:S2/S4 是 200 文件同窗爆发的**含排队**值
   (200 个 readFile 挤 libuv 4 线程池,28.23ms 是排队时延非单读成本);S6 顺序段
   才是单文件固有成本(0.45ms)。读报告时若只看 S2 会高估六个量级——两列并存,
   S2 答「500 文件爆发时中位文件等多久才哈希上」,S6 答「单笔保存的净成本」。
3. **丢弃/排队原因计数=四主因**:debounced(归并)/deduped(去重)/blocked(语法拦)/
   preview(批量滞留)。filtered(空路径/读不到)属异常路径非稳态,不在本面;全量
   八型出口=RUST-341 诊断面板(逐事件一行落通道,用户按时间线复查)。
4. **HTTP→回执→UI 三段未覆盖(诚实边界)**:队列→HTTP→回执→UI 属装配面
   (httpRequestService/发送与回执消费),随接线批与 kode5 分项(HTTP 区+UI 区);
   网络耗时须单独统计不混为本地性能(§19.10 纪律),本车道测不到。
5. **阈值化待建**:本批只记录 P95/P99/max 不钉阈值;若后续纳入夜间门,应走
   KODE_PERF_BOUND_* 同款宽松上界纪律(RUST-027),不直接钉绝对值。
