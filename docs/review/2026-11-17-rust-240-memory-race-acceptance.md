# RUST-240 验收纪要:Memory & race(长会话负载/循环增删根/索引与 diagnostics 并发/高频 restart)(纯对账审计)

日期:2026-11-17。本纪要对账 RUST-240(旧 QA-011,主 todo 排队项)的验收口径与交付证据。**结论:四维全有既有面,零代码缺口,纯对账收口;1h 负载以 180s 趋势+稳态判据承载(诚实条款)。**

## 验收维度 → 交付证据映射

| 维度 | 既有面 | 证据 |
| --- | --- | --- |
| 长会话编辑负载 | IDE-AUD-017 三族:longSessionTrend(预设 180s 自然编辑长会话,逐周期 RSS/worker/缓存趋势,预算与稳态判据先落证据)/longSessionNatural(自然编辑序列)/longSessionResources(资源面)+fieldBaseline(demo 资产+5000 文件外部根装配基线)+16s 短压力(REV-034,与长会话分离) | `src/test/electron/suite/longSession{Trend,Natural,Resources}.test.ts`+`fieldBaseline.test.ts`;nightly 链覆盖 |
| 循环增删根 | Rust 层 root 生命周期=root_lifecycle.rs(invalidate_root 语义)+kode-index invalidate_root 单元钉;TS 层 kodeCoreRootLifecycle(根增删→Core 同步→失效)+scanRoots(扫描根变化) | `crates/kode-server/tests/root_lifecycle.rs`+`crates/kode-index/tests/index_units.rs`+`tests/kodeCoreRootLifecycle.test.ts`+`tests/scanRoots.test.ts`(当日 36 例绿) |
| 索引与 diagnostics 并发 | mapWithConcurrency 有界并发(KR-AUD-35:上限不被越过/结果保序/worker 抛错整批拒绝+槽正确释放);并发在途记账(annotationInflightGauge:多文件并发按文件计数,各文件结束总账归零);后台预热二次/并发 start 复用同一轮不重扫;诊断调度器版本闸(最新版本才发布,stormRecovery 咬合) | `tests/backgroundWarmup.test.ts:50,331-347`+`tests/annotationInflightGauge.test.ts:117`+DiagnosticScheduler 家族 |
| 高频 restart | kodeCoreClient 有界重启(10s 窗 3 次+RESTART_GAVE_UP)+spawn 冷却 30s 防高频查询刷重启风暴+版本门杀进程可再 spawn;index 层 InvalidateRoot 幂等 | `src/backend/kodeCoreClient.ts`;RUST-009 轴2(RUST-239 纪要同源) |

## 自我验收证据

- `npx vitest run kodeCoreRootLifecycle/scanRoots/backgroundWarmup/annotationInflightGauge` RC=0(36 例,2026-11-17)。
- xvfb demo 25 RC=0(995e2929 批实测);longSession 族在 CI nightly 全链覆盖。

## 诚实条款

- **1h 编辑负载不整测**:实测口径=180s 趋势周期(RSS/worker/缓存三轴趋势+稳态判据)+field 5000 文件基线;1h 连续负载属 nightly 长跑形态,当前 CI 未跑 1h 时长,如实记账。
- 「循环增删根」的实测=生命周期语义钉(失效/同步幂等),非无限次循环的泄漏专测;RSS 趋势族(longSessionTrend)承载内存回归,如实划界。
- 「高频 restart」以冷却+有界重启策略钉承载;无「100 次连续 kill」压力专测(策略面有界即终止,如实)。
