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
| S7 500 burst 同步段(RUST-416 面) | 500 文件 watcher 一窗,filter+offer 纯同步段(零 IO 读盘在异步面) | filterWall 17.7ms / perEvent 0.04ms;offerWall 12.57ms / perEvent 0.03ms;filter p50 0.02ms(load 58.75) | 500 全入队零丢失;同步段零发出 |
| **S8 回执→UI 显示段(2026-11-23)** | 500 回执逐笔 translateDeliveryRecord+core.record(缺省容量 200 环形淘汰,500→200 行);面板渲染 50 行页 + 500 行虚拟滚动路径 | **ledger perRecord p50 0.02ms / p99 0.11ms(max 1.15ms 含 O(200) 淘汰索引重建)**;render 50 行页 p99 3.81ms;render 虚拟 500 行 p99 1.87ms(load1=4.12) | 台账键替换非事件追加;500 回执→200 行;虚拟路径 capacity 调高才激活 |

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
4. **HTTP→回执段非本界表钉域(诚实边界)**:网络往返耗时由 HR-STATE-007 的
   durationMs 逐发送记录于台账(hotReloadChannelSend.ts:146-148),不在本界表;
   网络耗时须单独统计不混为本地性能(§19.10 纪律),本车道测不到。UI 显示段
   (S8)已于 2026-11-23 落车道(见上表行);真 UI 线程墙钟(webview 实渲染)
   属装配面,纯核面不冒充。
5. **阈值化已落(2026-11-23 增:本条曾写「待建」,现已建)**:各段界表在
   tests/perf/hotReloadSegmentBounds.ts(缺省宽松上界,只捕数量级回退,界值取
   两轮更差者再留 ~10x 余量吸收共享 runner 抖动;env 覆盖 KODE_SEG_BOUND_*,
   非法值诚实回退缺省),纯 resolver 钉在主 unit 门;bench 侧逐面比对,违规即
   红(合并阻塞面)。S8 两面(s8LedgerP99Ms 缺省 100ms / s8RenderP99Ms 缺省
   1000ms)按同纪律入表。
6. **S7 同步段有界非秒级(RUST-416 面)**:500 事件 watcher burst 的纯同步段
   (filter+offer)墙钟 ~30ms(load 58;空载 ~10-20ms),读盘/哈希在 libuv 线程池
   异步不占主线程——「UI 不冻结」的纯核面成立(4.3s@50k 是异步读盘排队非同步
   阻塞);S7 的语义断言=500 全入队零丢失+同步段零发出,墙钟只观测。UI 线程面
   (装配)属接线批。
7. **S8 显示段含设计节流窗(诚实边界)**:S8 测的是逐回执翻译+入账与逐页面板
   HTML 生成;回执→面板的 wall 另含 refreshWindowMs(缺省 500ms)设计节流窗,
   窗内合并即防抖(HR-UI-007 已钉),非性能回归面,故 S8 不含该窗。缺省容量 200
   环形淘汰下全量 ≤200 行走既有分页路径,虚拟滚动只在 capacity 调高(千级记录)
   时激活——S8 两径并测,报告值取较重者。
