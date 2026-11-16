# RUST-142 批 1 验收纪实:诊断调度状态机回放核下沉 Rust(diagnostic_pipeline.rs)

日期:2026-11-16。todo 行:RUST-142(诊断调度 DiagnosticScheduler 族下沉;本批=纯库回放核+golden 双向门禁,批 2=LSP/生产接线)。

## 交付面

- `crates/kode-server/src/diagnostic_pipeline.rs`(新建,~1100 行):`src/backend/diagnosticScheduler.ts` 的同构下沉——12 计数器状态机 + 四族分层管线回放核,纯库零 RPC;
- `crates/kode-server/src/bin/dump-diagnostic-pipeline-golden.rs`(新建):golden 生成器;
- `crates/kode-server/tests/golden/diagnostic-pipeline-parity.json`(生成,17 迹):traces(权威事件语料)与 outcomes(Rust 回放产出)同文件;
- `crates/kode-server/tests/diagnostic_pipeline_golden.rs`(新建,2 测试):重生成比对 + 结构完整性(12 计数器全点亮审计);
- `tests/kodeDiagnosticPipelineParity.test.ts`(新建,3 测试):TS 镜像——读 golden traces 驱动**生产** DiagnosticScheduler(4 实例管线)逐迹复算,对拍 outcomes;
- `src/lib.rs`:两处接线(`pub mod diagnostic_pipeline` + `pub use dump_diagnostic_pipeline_golden`)。

## 调度语义面(逐条对 TS 生产源核过)

- 12 计数器:requested/computed/published/coalescedStale/staleDropped/releasedDropped/skippedCurrentVersion/disabledSkipped/disabledAsyncDropped/staleGenerationDropped/errored/cleared;
- request 立即通道:禁用记账(disabledSkipped,不建状态)→ 同版本同代跳过(skippedCurrentVersion)→ 计算发布;requestQueued 排队通道:合并计数(不同版本顶掉=coalescedStale;同版本替换不记);
- flush:collectQueued 插入序(TS Map 序,Rust 用 Vec+索引手滚,非 BTreeMap 字典序)→ 逐条目处理时三守卫(关闭代失配=releasedDropped/任务 doc 改版=staleDropped/同版本同代已发布=skippedCurrentVersion)→ sliceMs=0 域每条目后让出(确定性域;真值 25ms 依赖时钟不进对拍)→ 让出过再收一轮;
- 任务 doc 对象语义:每请求新对象,守卫只读任务自己捕获的对象(新版本=新请求=新对象;晚到异步回包以自己 version 发布;T5 [v2,v1]);
- 异步五守卫序(TS onOk 逐行):computed 先记 → null 中止(staleDropped)→ 版本前进(staleDropped)→ 关闭代失配(releasedDropped)→ 开关关闭(disabledAsyncDropped)→ 代切换(staleGenerationDropped,不标已发布);Error:errored 记账不重抛、computed 不增、体内副作用不执行;
- 同步双守卫:重入改版(staleDropped)/重入关闭(releasedDropped);
- setEnabled:同值早退;关闭=clearAll 记录+cleared+发布标记作废;重开=invalidateAll(generation+1);releaseDocument:queued 残留计 coalescedStale+cleared+epoch 自增;
- **微任务序(本轮关键推导,见坑账 1)**:让出面默认 setImmediate 宏任务边界;让出窗口内脚本事件(外部 worker resolve)是窗口内的宏任务轮,gate 续延链(async fn 体恢复→副作用→onOk 守卫+发布)是微任务,在 flush 恢复的宏任务之前排空——**让出窗口 resolve 的异步先于 flush 恢复发布**(T17 序 [b,a,c]:b 批内同步发布→让出窗口 a 异步发布→flush 恢复→c)。

## 四族分层(目标设计面)

`DiagnosticLayer` 四值(localSyntax/semantic/engineCompat/runtimeConfig,serde camelCase)+ `layer_for_family`:DefLocalValidation→LocalSyntax / SemanticsIndex→Semantic / DefMd5Compat→EngineCompat / ConfigContract→RuntimeConfig。每层独立调度器实例=独立节流(同构 TS 生产 13 实例每族一实例)。层只作路由/记账不改调度语义。诚实边界见下。

## golden 形态与对拍方向

`{generator, traceCount:17, traces, outcomes}`:traces 与 outcomes 都由 Rust 产出;TS 镜像读 traces 驱动生产调度器复算,逐迹 `toEqual` 对拍 outcomes(publishLog 按层名字节序拼接:engineCompat<localSyntax<runtimeConfig<semantic / stats 四层 / workload 四层 queued+inFlight)。**镜像红=移植错,按 src/backend/diagnosticScheduler.ts 源码重推**(语义真值源=生产调度器)。Rust golden 测试对同代码产出属同义反复,防伪靠 10 个独立单元钉直钉核心语义。

## 17 迹语料(权威定义在 corpus())

T0 版本跳过 / T1 开关闸往返 / T2 排队合并 / T3 让出窗口 re-collect+release / T4 晚到异步发布自己版本 / T5 null 中止 / T6 异步在途关闭 / T7 异步在途关开关 / T8 异步在途换代 / T9 异步失败 / T10 FIFO 结算序 / T11 已发布同版本重入队跳过 / T12 同步重入改版 / T13 同步重入关闭 / T14 invalidate 后重算 / T15 四族管线独立节流 / T16 让出窗口 resolve 异步发布落在让出窗口内([b,a,c])。

## Rust 单元钉(10,全绿)

coalesce_and_latest_version_wins / same_version_replacement_is_not_coalesced / release_drops_queued_task_and_late_async_result / generation_switch_drops_and_does_not_mark_published / disable_drops_inflight_and_reopen_forces_recompute / settle_order_is_resolution_fifo / flush_batch_follows_insertion_order_and_recollects_after_yield / sync_reentrant_mutate_version_drops_publish / layer_pipeline_routes_independently / yield_window_async_publishes_before_flush_resume。

## 镜像解释器要点(TS 侧)

- computeAsync 用 async fn + await gate 形态(gate 于事件时刻预建,async_id 分配序与 Rust make_task 同刻同序);gate 拒绝→体内副作用不执行,正常落定→副作用→返回值;
- yieldToHost hook=先 `await new Promise(setImmediate)`(宏任务边界)再同步跑一条脚本事件——生产让出面形状;
- 每事件后 `await setImmediate` 排空微任务;publish 按事件 trace layer 记录(TS DiagnosticLayer 类型只有 local|semantic,只影响 metrics fileKind,镜像把四层按 tsLayer 路由);
- sliceMs 构造器级:迹内所有 flush 共用同一域(0=每条目必让出/巨值=零让出),镜像有非一致即红的护栏;
- 发布记录/clearAll 记录与 getStats/pendingWorkload 全部走生产面。

## prove-red(双端四靶,全闭环;cp 备份+变异+跑测+cp 还原+cmp 字节校验)

- TS 镜像:golden T16 发布序交换(b/a→a/b)→ 镜像 1 红(发布序深等抓住)→ 字节还原 → 3/3 绿;
- Rust 靶 1:settle FIFO→LIFO(pop_front→pop_back)→ settle_order_is_resolution_fifo 红(RC=101)→ 字节还原 → 10/10 绿;
- Rust 靶 2:删 OkItems epoch 守卫 → release_drops_queued_task_and_late_async_result 红(RC=101)→ 字节还原 → 10/10+golden 2/2 绿。

## 坑账

1. **微任务序两轮翻案**:初版 Rust 回放按"让出边界内联结算"([b,a,c]);写镜像时重推成"两相 FlushResume 模型"([b,c,a],依据"async fn 体恢复先于 flush-resume 排队、onOk 尾随")并重写了 Rust 侧——镜像一跑反而产出 [b,a,c],暴露重推错误:flush 恢复走的是 yieldFn 的**宏任务**边界(setImmediate resolve),而让出窗口内的脚本事件(resolve)在更早的宏任务轮,其微任务续延链先排空。终案=回到让出边界内联结算,镜像 yieldFn 用"先 await 宏任务再跑脚本事件"的生产形状。教训:TS 时序推导必须锚定 await 的**具体 promise 落定机制**(微任务 vs 宏任务),不能只数排队位置;
2. **镜像抓到 Rust 真移植缺陷**:OkItems 段漏计 computed(TS onOk 首行即 `computed+=1`,先于 null 检查与全部守卫)——golden 是带 bug 生成的,生产调度器复算红,按源码修 Rust 后重生成。镜像的"方向 of truth"设计首轮即兑现价值;同期钉 `yield_window_async_publishes_*` 曾"假绿"(旧码 async 不计 computed、sync 计 1 恰好凑对断言值),修后该钉显式断言 computed=2;
3. Error outcome 的体内副作用执行性:TS async fn `await gate` 拒绝→体内后续不执行,Rust Body 段初版先跑副作用再分派 outcome,已改为 Error 跳过(语料 T9 无副作用故 golden 不变,语义钉正);
4. async_id 分配时机:Rust 在事件时刻(make_task)分配,镜像若在 computeAsync 调用时(=flush 处理时)懒分配会因 flush 守卫跳过条目而错位——镜像改为事件时刻预建 gate;
5. TS Map 插入序≠BTreeMap 字典序:states 用 Vec<(String,UriState)>+索引 map 手滚,flush 批序可对拍(zz,aa,mm,bb 钉);release_document 后全量重建索引。

## 诚实边界

- TS 生产层枚举仍是 `local|semantic` 两值,17 诊断家族全按 local 调度;四族(localSyntax/semantic/engineCompat/runtimeConfig)是**目标设计面**,Rust 回放核已按四族建模,批 2(生产接线)才落到 TS 装配;
- 对拍只走两确定性域:sliceMs=0(每条目必让出)与巨值(零让出);真值 25ms 域依赖 performance.now 不进对拍;
- 语料不含:queued 同步 compute 抛错(TS flushQueued catch 记 errored 面,Rust 无 throw 概念)、并发 flush 交叠、真实时钟节流——批 2 接线面处理;
- Rust 回放核不含 metrics 打点(AUD-052 计时面属 TS 装配层)。

## 门禁(2026-11-16 全绿)

- eslint 0;tsc 0;vitest unit 852 文件(851 过+1 skip)10372+8skip RC=0;xvfb demo 25 RC=0;
- cargo test -p kode-server:71 套件全绿(含新 lib 10 钉+golden 2);clippy -D warnings 0;
- 双端 prove-red 四靶闭环后复跑绿。
