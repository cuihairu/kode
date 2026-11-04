# KODE-PERF-006 进程拓扑全量诊断成本测量报告(2026-11-04)

> 取证口径:进程拓扑全量诊断(任一 def/清单变更都触发的整拓扑重算,`src/extension.ts`
> `scheduleProcessTopologyDiagnostics`)的成本分解测量——宿主同步阻塞段(input 收集 /
> findings 映射+发布)与 Rust 校验 RPC 段分开计量;`src/diagnosticScheduler.ts` 的
> 连续编辑合并与取消守卫单独观测。采集脚本 `tests/processTopologyPerf.test.ts`
> (`npx vitest run tests/processTopologyPerf.test.ts --reporter=verbose`,打印
> `[KODE-PERF-006 *]` 行);合成 workspace 为 5 进程清单 + entities.xml + N 个真实形态
> 实体 def(各 ~25 行,属性/方法/Arglist)。机器负载抖动下多次采样取代表性读数;
> 数字看数量级与线性形状,不作绝对 SLA。

## 1. 测量对象与分段

一次全量重算的三段(拓扑是全局输入,单文件变更产出全量状态):

| 段 | 内容 | 宿主阻塞? |
|---|---|---|
| input | `collectTopologyDefInputs` 读全部 def(每 def 一次 `readSharedFileSnapshot`) | **是**(同步) |
| rpc | `validateProcessTopologyInRust` 经 Rust 校验(清单/entities/def 原文直传) | 否(await,循环自由) |
| map | `mapFindingsToDiagnostics` + 每条 finding 的 `specToDiagnostic`(每 spec 重算 `computeLineStarts`)+ 按文件分组发布 | **是**(同步) |

宿主**事件循环延迟** = input + map 两个同步阻塞段(循环在此期间无法处理其它任务);
Rust RPC 是异步段,单列 wall-clock 不混入宿主延迟。

## 2. 批量 def 输入:宿主同步阻塞段(input)

| defs | CPU(ms) | 墙钟(ms) | 每 def 墙钟(ms) |
|---|---|---|---|
| 100 | 20.4 | 24.7 | 0.25 |
| 500 | 50.2 | 62.2 | 0.12 |
| 1000 | 110.5 | 126.6 | 0.13 |

线性(0.12-0.13ms/def)。**1000 def 全量读盘阻塞宿主 ~127ms**。
口径注:本测量 `readSharedFileSnapshot` 的 `listOpenDocuments()` 在测试面为空;
真实宿主为 O 个打开文档 × N def 的逐文档身份比较,是未计入的额外 O(N×O) 成本
(另文评估,此处只量磁盘读路径)。

## 3. 批量 def 输入:findings 映射 + 发布(map)

| defs | findings | CPU(ms) | 墙钟(ms) | 每 finding 墙钟(ms) |
|---|---|---|---|---|
| 100 | 200 | 24.6 | 27.9 | 0.14 |
| 500 | 1000 | 82.2 | 94.7 | 0.09 |
| 1000 | 2000 | 115.2 | 132.4 | 0.07 |

线性(0.07-0.14ms/finding)。**2000 findings 映射+行号换算阻塞宿主 ~132ms**;
每 finding 一次目标文件 `computeLineStarts`(行起始偏移表 O(文件长))。同文件多
findings 的重复 lineStarts 重算是既知风险(与 KODE-PERF-002 同族),本次每 def 2
findings 下未见平方爆炸,但 findings 高度集中于同一文件时仍需关注。

## 4. Rust 校验 RPC 段(异步,不阻塞宿主)

`target/debug/kode-server`(**debug 构建**,仅示数量级;release 构建显著更快)。
两次采样(机器负载差异):

| defs | findings | 墙钟 #1(ms) | 墙钟 #2(ms) |
|---|---|---|---|
| 100 | 203 | 132.7 | 87.1 |
| 500 | 1003 | 942.9 | 417.2 |
| 1000 | 2003 | 1119.6 | 775.5 |

Rust 校验产出 ~2 findings/def(与合成 map 场景同量级,映射成本口径一致)。
**1000 def 的 Rust 校验 RPC ~0.8-1.1s(debug)**,宿主在 await 期间自由;
Rust 侧 CPU 与墙钟同量级(子进程独自计算)。首调含 spawn+LSP 握手(百 ms 级),
后续调用复用进程。

## 5. 连续编辑:编辑风暴不放大重算

200 次快速编辑(版本 1..200,同 URI `requestQueued`)→ 一次冲刷:

```
computed=1 published=1 coalescedStale=199  cpu=1.9ms wall=3.3ms
```

**200 次编辑合并为 1 次重算**(199 次过期排队任务永不执行,`coalescedStale`);
编辑风暴不放大全量重算,宿主只付最新版本一次计算。

## 6. 取消:在途版本前进,旧结果廉价弃置

版本 1 异步计算在途(慢 RPC 挂起)→ 文档前进到版本 2 → 版本 1 结果落定:

```
staleDropped=1 published=1  cpu=0.5ms wall=0.5ms
```

**在途旧结果按版本守卫丢弃(不发布),守卫代价 ~0.5ms**;只发布最新版本。

## 7. 结论与读法

1. **宿主事件循环延迟主导项** = input + map 同步段:1000 def/2000 findings 全量重算
   ~**260ms 宿主阻塞**(126.6 input + 132.4 map + 发布小量)。这是「宿主延迟」的真实面
   ——任何在途编辑/输入在约 0.26s 窗口内被阻塞。
2. **Rust 校验是墙钟大头**(~0.8-1.1s @1000 def,debug)但**异步非阻塞**:宿主循环
   自由,代价是整链 wall-clock 拉长(诊断更新延迟),非宿主卡顿。
3. **连续编辑**已被调度器合并(200→1),不放大重算;**取消**守卫廉价(~0.5ms),
   不发布过期结果——两场景无性能风险。
4. 优化候选(供 KODE-PERF-007 基线对照):map 段同文件 findings 的 `computeLineStarts`
   去重(现每 finding 重算整文件行表);input 段打开文档身份比较的 O(N×O) 路径。
