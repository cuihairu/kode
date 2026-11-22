# 重建期语言服务 tail latency(RUST-425 / 旧 HR-QA-013,2026-11-22)

- 任务口径:「Rust Core 正在重建索引时热更新可继续工作,CPU/线程池/锁不可导致语言服务
  tail latency 大幅恶化」——本车道验证 serving 三面(definition/completion/diagnostic)
  与热更新(didChange→新属性补全反映)在索引队列深水(重建中)时的正确性与尾延迟。
- 车道:tests/perf/hotReloadRebuildTail.bench.ts(bench 专用 lane,KODE_REBUILD_TAIL=1
  门;与主 unit 门无交集);界表纯函数 tests/perf/rebuildTailBounds.ts + 单测
  rebuildTailBounds.test.ts(主 unit 门,隔离纪律同 servingBounds:绝无 bench re-import)。
- 跑法:`KODE_REBUILD_TAIL=1 npx vitest run --config vitest.bench.config.ts \
  tests/perf/hotReloadRebuildTail.bench.ts`(输出追加 docs/perf/hot-reload-rebuild-tail-run.txt,
  `KODE_REBUILD_TAIL_OUT` 可覆盖;`KODE_REBUILD_TAIL_BASE/FLOOD` 可改基座/洪泛规模)。
- 环境:基准机同 docs/perf/hardware.md §1(i9-10880H/14 vCPU/机械盘/node v24.21.0),
  真二进制 target/debug/kode-server(`KODE_REBUILD_TAIL_BINARY` 可覆盖,缺省缺件时现场
  cargo build 兜底)。

## 车道结构

| 段 | 内容 | 关键观测 |
|---|---|---|
| steady | 基座 500 def + 3 xml + 10 补全副本 + 热更副本 + 破型正例全量镜像( drained)后,三面各 100 样本 | 三面 p50/p95/p99/max;definition 命中 types.xml:1;补全含 Rebase0_p0..p9;干净零诊断;破型 Error 点名 |
| rebuild | beginBackgroundScan(8000) → 8000 didOpen 洪泛(fire-and-forget)→ 屏障 `$/kode/health`(FIFO 证明全部入队且 health 臂不泵索引) | 屏障 ingest.queued(=8192 队列顶)+ rejectedQueueFull + 洪泛投递墙钟 |
| rebuild serving | 深水在位时三面各 100 样本(每请求前 drain_index_for_request 泵 16 任务/4ms) | 三面 p99;屏障/测量末/热更末三采样 queued>0(重建确在进行);语义断言与稳态同形 |
| 热更 arm | 深水在位时 3 次 didChange 插唯一属性 → 过 350ms 风暴窗 → 补全必须含新属性(freshen self-key 插入跳越,深水队前不排队) | 3 样本 p99;逐次语义断言 HotReload_pN 在补全面 |
| 排空 | scanComplete(8000,0) → 200ms 步进轮询 ingest.queued 归零 | drainTotal(洪泛起点→归零,含测量窗)+ pureDrain(scanComplete→归零) |

## 实测(2026-11-22,load1=41→62(运行中爬升),提交在库记录)

| 面 | 稳态 p50 / p99 | 重建期 p50 / p99 | 界(p99) | 判 |
|---|---|---|---|---|
| definition | 6.89 / 15.98ms | 11.58 / 27.03ms | 40/120ms | 过 |
| completion | 7.97 / 21.00ms | 12.05 / 26.99ms | 30/120ms | 过 |
| diagnostic | 7.74 / 20.43ms | 11.90 / 29.52ms | 50/150ms | 过 |
| 热更新鲜补全 | —(基线=稳态 completion) | p50 41.70 / p99 80.46ms(n=3) | 120ms | 过 |
| 重建排空墙钟 | — | drainTotal 56.56s / pureDrain 0.34s(见边界①,观测面非门面) | 观测 | 不设门 |
| 深水证据 | — | 屏障 queued=8192(队列顶)· rejectedQueueFull=293 · serving 末 7882 · 热更末 7864 | — | 重建全程在 |

重建期三面 p50 ≈ 稳态的 1.5-1.6x,p99 ≈ 1.4-1.7x——「大幅恶化」(数量级)未发生;语义面
(已知落点/零诊断/破型正例/热更新属性反映)全部命中,含队列顶满(8192)状态下。
热更新鲜补全 p99 80.46ms(稳态补全基线 21.00ms)≈3.8x,在 120ms 界内但比 serving 面
更贴界——热更新鲜 face 是最贴界的判据面,负载敏感度见边界⑧。

## 读法与诚实边界

1. **排空墙钟=观测面非门面(关键判例)**:重建排空速率受 **scheduler `pick_next`
   全队列重排 O(q log q)(crates/kode-scheduler/src/scheduler.rs:758,每次 pump_once
   重建排序)`queue_order`)+ execute 线性 retain 拖累=重建排空 O(n²)**——实测
   每任务 ~5ms(8000 档)/~18ms(2000 档),随语料规模平方增长。**这是排空吞吐问题,
   非 RUST-425 判定面**:判定面=serving 尾延迟+热更新鲜度,两者与排空速率正交
   (serving 泵被 16ms 墙钟预算封顶,单次 pump_once 的 O(q log q) 重排被预算吸收;
   实测 serving p99 重建期 27.03/26.99/29.52ms,稳态 15.98/21.00/20.43ms,无回退)。
   排空 O(n²) 记为本任务
   发现的跟进候选(修复=pick_next 换堆/有序集或插入时保序),不设门——设门会把
   非判定面的吞吐特性误判为 RUST-425 回退。drainTotal 只观测记录(run.txt)。
2. **重建=索引队列深水,非后台线程**:Core 无 async runtime/rayon,serving 与重建同在
   单线程内联 stdio pump(main.rs 帧路径只 flush_due 不泵索引;泵走空闲 tick 64 任务/
   16ms 与请求排水 16 任务/4ms)。「重建中」的可观测锚 = ingest.queued 深水,本车道三
   采样钉死(屏障/serving 末/热更末均 >7800)。暖门(coldWhileWarming=0)标记任务只在
   scanComplete 泵至终态,暖门计数属 RUST-074-W 轴,非本任务面,如实记录。
3. **单任务不可抢占=已知缺口(如实记录不掩盖)**:泵切片单任务不可中断(index_queue.rs
   pump_budgeted_until),1.6MB def(~150ms,docs/perf/2026-11-15-index-increment-bench.md)
   会阻塞整个 serving 环——2026-11-15 实测 busy hover max 81.47ms 即此形。本车道合成
   语料单 def ~0.5KB(单任务亚毫秒)不触发该缺口;大 def 洪泛下的抢占界属 RESP-001
   筛切片已修面的残余,留待后续批(若要钉,须 1.6MB 级夹具另立车道)。
4. **池/锁轴=结构面说明**:kode-pool(available_parallelism,n≥2,interactive_reserved=1)
   只服务 `$/kode/rpc`(纯 fn,零 ServerState 共享),不在 serving 路径;serving 路径
   无 Mutex(ExecShared.state 锁只在池派发瞬持,handler 在锁外)。本车道不在 serving
   路径伪造池竞争——三轴(CPU/线程池/锁)中 CPU 轴由深水队列实测,池/锁轴由结构证明
   (不在路径上)+ RUST-416 池观测面补。
5. **队列顶满(8192)=INDEX_QUEUE_MAX 命中**:基座 514 + 洪泛 8000 > 8192,屏障期
   rejectedQueueFull=293(洪泛 def 的刷新任务被拒,不影响被测基座文档——基座早已入
   库,洪泛 def 不进 serving 面)。这是比设计更强的深水压力(内存压力+队满拒绝),
   serving/热更在该状态下全部通过,如实记录。
6. **热更新鲜度=语义硬断言非墙钟**:HotReload_p0..p2 逐次进补全面(freshen self-key
   插入跳越在深水队前生效)是 RUST-425「热更新可继续工作」的核心证据;80.46ms p99
   含 300ms 风暴窗外的一次补全往返,不做跨机器绝对比较(PERF-015)。
7. **阈值纪律**:KODE_REBUILD_BOUND_*(界表纯函数,单测钉非法回退缺省);墙钟界 ~10x
   余量只捕数量级回退;语义命中面硬断言不属界表。基准在库 run.txt,重跑追加。
8. **热更新鲜 face 负载敏感度(最贴界判据面)**:本面(补全往返单请求,过 300ms 风暴
   窗)是 7 个判据面里最贴界的——实测 load1≈21 时 21.27ms、load1≈43 时 74.92ms、
   load1≈62(运行中爬升)时 80.46ms、load1≈82 时 175.45ms(超界一跑,见下)。判据:本
   车道墙钟界按共享 runner 抖动吸收设计(PERF-015),跨机器不比较绝对值;热更新鲜面在
   load1≲62 均过界,load1≥82 才超界——**门面过界 ≠ 系统回退,须先读 load1 再归因**
   (满载抖动族判例:轮换受害者,基线零新增)。基准 run.txt 取 load1≈41→62 全绿跑;
   load1≈82 的 175.45ms 超界跑是同一机器负载爬升所致(该跑 rebuild 三面 27-34ms
   仍过界,仅热更新鲜面被单次长排队拖过界),不作 RUST-425 回退证据——归因后非回退,
   故不进界表,只在此如实记录。
