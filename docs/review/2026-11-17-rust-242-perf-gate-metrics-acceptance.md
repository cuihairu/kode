# RUST-242 验收纪要:性能发布门槛同时检测 P95/P99/max/CPU/RAM/index correctness(真增量:CPU 门级断言补齐)

日期:2026-11-17。本纪要对账 RUST-242(旧 QA-013,QA 家族主 todo 排队项)的验收口径与交付证据。**结论:六指标中五指标既有门/观测面齐备(P99/RSS 有界断言,P95/max 已算已记入 run 工件,index correctness=语义五面钉),唯一真缺口=CPU 无门级断言——本批补齐(servingGate 稳态窗进程 CPU 占比断言),真增量收口。**

## 验收维度 → 交付证据映射

| 指标 | 门级形态 | 证据 |
| --- | --- | --- |
| P99 | **有界断言**(spawn.start/mirror.total/steady 三面/editRoundTrip 全在界) | `tests/perf/servingGate.bench.ts`+`servingBounds.ts`(env 可覆盖);TS 侧 `gate.bench.ts` warmP99Ms 界 |
| P95 | 已计算已记录(metric 行 p50/p95/p99/max 全落 `docs/perf/serving-gate-run.txt` 工件,可跨跑对账) | servingGate `metric()` 输出;宽松上界纪律=界取 P99(数量级捕抓),P95 记录形态 |
| max | 已计算已记录(同上);TS 门另有 warmMaxMs 界 | 同上+gateBounds |
| **CPU** | **本批新补:稳态窗进程 CPU 占比有界断言**(`/proc/<pid>/stat` utime+stime 增量/墙钟×100,首版界 200%=两核全忙只捕跑飞自旋;`/proc` 不可得如实跳过不冒充) | 本批 `servingGate.bench.ts`(serverCpuSeconds+steady 基线/收尾)+`servingBounds.ts`(+steadyCpuPercentMax,env `KODE_SERVING_BOUND_STEADY_CPU_PERCENT_MAX`);解析对活体 /proc 实证(state@0/utime@11/stime@12) |
| RAM | **有界断言**(mirrorRssDeltaMb/steadyRssMb/servingSoak RSS_GROWTH_CEILING_MB 捕数量级泄漏) | servingGate/servingSoak+`docs/perf/soak-1h.md`/`index-memory-eval.md` |
| index correctness | **语义五面钉**(已知声明落点/必有补全项/诊断反例干净零/正例未注册类型 Error 点名/编辑后结果变化——「全 null 替身在此红」,2026-11-15 审计 P1-2) | servingGate.bench.ts:340-368 断言面 |

## 本批增量(feat)

- `tests/perf/servingBounds.ts`:+`steadyCpuPercentMax`(缺省 200,env 覆盖,非法回退缺省);头注记账 CPU 观测语义与非 Linux 缺失口径。
- `tests/perf/servingGate.bench.ts`:+`serverCpuSeconds`(/proc stat comm 安全解析)+steady 测量循环前基线(墙钟+CPU 累计)+收尾占比计算入 `cpu.steadyPercent` 工件+超界入 violations 收口 it。
- `tests/perf/servingBounds.test.ts`:四例随动(缺省表/env 覆盖独立/非法回退/超界报告含新键+等值不过界)。
- prove-red:变异界比对(false &&)→ violation 钉红(expected [] to deeply equal [3 项])→ cp+cmp 字节还原 → 绿。
- 门禁:lint 0 / compile 0 / unit 10659 全绿;CPU 解析对活体 /proc 实证。

## 诚实条款

- **CPU 首版界 200% 是宽松上界**(只捕跑飞自旋,不捕慢 10%);首跑落账 `serving-gate-run.txt` 后可按基线收紧(与墙钟界同演进纪律),如实记账。
- CPU 采样是 Linux `/proc` 面——CI runner Linux ✓;非 Linux(本地 macOS)=观测缺失如实跳过,门不因平台缺观测而红(与 RSS 同口径)。
- bench 文件按隔离纪律不进主 unit 门(防 spawn+3000 文件镜像进单测);新采样/断言的运行时路径由 CI perf-gate job(KODE_SERVING_GATE=1,nightly)执行,本地实证=解析函数对活体 /proc+纯函数钉。
- P95/max 是「记录+跨跑对账」形态非独立界——宽松上界纪律的既定设计(界取 P99/max 关键位),非缺口,如实划界。
