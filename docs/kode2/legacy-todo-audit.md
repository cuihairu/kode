# 旧 todo.md 逐条完成状态对账（PH0-02 / AUDIT-001+AUDIT-014）

- 日期:2026-10-23 · 对账基线:分支 v0.2 @ cd7c49b(工作树仅含本单文件)
- 对象:根目录 `todo.md`(2026-10-22 重拆版)A/B/C/D 全部 60 条
- 方法:逐条与今晚 PR1-7 实际 commit(89e8783→e6e8bc7)、测试文件、性能报告、工作流文件对账;**无证据不打勾**。
- 状态记号:✅ 完成(证据齐) · ◐ 部分完成 · ❌ 未完成 · ⏸ 外部条件未触发
- 本文件只对账,**不改写 todo.md**;末章给出可勾清单,勾账动作由 todo.md 维护方执行。

## 结论速览

| 区 | 条数 | ✅ | ◐ | ❌/⏸ | 与 todo.md 勾账差异 |
|---|---|---|---|---|---|
| A 语言服务性能治理 | 39 | 38 | 0 | 1 | **A1/A2/A3/A5/A7 共 27 条实际已完成但 todo.md 未勾**(A1-7 为真实缺口) |
| B 止血项 | 5 | 5 | 0 | 0 | 一致(均已勾) |
| C 功能项 | 12 | 2 | 3 | 7 | C-8/C-9 实际已完成但未勾;其余一致 |
| D 维护与质量 | 4 | 1 | 2 | 1 | 一致(D-1 复核动作仓内不可证) |

PR1-7 commit 链:PR1 89e8783 → PR2 7d8736b → PR3 2aca694 → PR4 4bfba9b → PR5 d4fd634 → PR6 ae4256d → PR7 e6e8bc7(文档)。门禁口径:PR7 报告 `pnpm test:unit` 2,799 passed / tsc 零错 / eslint 零错(docs/perf/2026-final-report.md §7)。

## A. 语言服务性能治理(39 条)

### A1 PR1 · 性能观测与基线(commit 89e8783)

| 项 | todo | 实际 | 证据 |
|---|---|---|---|
| A1-1 metrics 模块 | [ ] | ✅ | `src/languageServiceMetrics.ts`(347 行,11 类事件,单调时钟/请求ID,详细记录默认关,89e8783);`tests/languageServiceMetrics.test.ts` |
| A1-2 记录字段齐备 | [ ] | ✅ | 子阶段耗时/发现读取解析缓存计数/等待初始化/generation/version/状态字段;docs/perf/2026-baseline.md §6 |
| A1-3 汇总出口 | [ ] | ✅ | 命令 `kbengine.metrics.showSummary`(src/extension.ts:1263-1266;89e8783 package.json+docs/guide/commands.md) |
| A1-4 四请求埋点接线 | [ ] | ✅ | hover/definition/completion/诊断入口(extension.ts:263-271 validateDocumentTimed 打点;provideDefinitionTraced;89e8783) |
| A1-5 资产集生成器 | [ ] | ✅ | `scripts/generate-perf-assets.mjs`(6 场景,确定性,89e8783) |
| A1-6 基线报告 | [ ] | ✅ | docs/perf/2026-baseline.md(七场景实测+待测项如实标注)+ baseline-run.txt |
| A1-7 Mermaid 调用链图落同报告 | [ ] | ❌ | **未完成**:grep docs/perf/ 全目录无 mermaid,baseline.md 无调用链图;与 todo 未勾一致(见 ph0-gate.md 门 1 缺口) |

### A2 PR2 · documentStore(commit 7d8736b)

| 项 | todo | 实际 | 证据 |
|---|---|---|---|
| A2-1 快照模块 | [ ] | ✅ | `src/documentStore.ts`(342 行:URI 规范化+版本+文本+行索引+解析态,7d8736b) |
| A2-2 内存优先 | [ ] | ✅ | tests/documentStore.test.ts(311 行,缓冲区≠磁盘以缓冲区为准);PR2 报告 §3 |
| A2-3 同版本只解析一次 | [ ] | ✅ | 同版本缓存+in-flight 合并+解析中再编辑旧不覆新(tests/documentStore.test.ts;PR2 报告 §3) |
| A2-4 Hover 接入 | [ ] | ✅ | hover 行准备走快照(P50 1.66ms→<0.01ms,PR2 报告 §1);注:RPC CodeLens 形参闸仍有 1 处 `getText().split`(src/languageProviders.ts:4063,非 hover 链,不在本条口径内) |
| A2-5 Diagnostics 接入 | [ ] | ✅ | validateDocument 同版本 parseDefAst 复用(document-parse 命中率 96.1%,PR2 报告 §2) |
| A2-6 LRU/释放 | [ ] | ✅ | 关文档释放计数归零(tests/documentStore.test.ts;PR2 报告 §3) |

### A3 PR3 · indexScheduler(commit 2aca694)

| 项 | todo | 实际 | 证据 |
|---|---|---|---|
| A3-1 调度器模块 | [ ] | ✅ | `src/indexScheduler.ts`(422 行,生命周期+状态查询);tests/indexScheduler.test.ts:20-85 |
| A3-2 任务合并/过期取消 | [ ] | ✅ | 同文件同版本合并、高优先级保留、旧版取消/丢弃(tests/indexScheduler.test.ts:87-193) |
| A3-3 优先级队列 | [ ] | ✅ | 五级优先级顺序断言(tests/indexScheduler.test.ts:194-251) |
| A3-4 失败恢复 | [ ] | ✅ | 首扫被杀后重入队可完成,不永久 pending(tests/indexScheduler.test.ts:252-320) |
| A3-5 EntityMappingManager 首扫迁入 | [ ] | ✅ | src/entityMapping.ts:178-196(initial-scan 任务经调度器;PR3 报告) |
| A3-6 后台限流与取消 | [ ] | ✅ | 编辑高峰让路+50ms 冷却窗(tests/indexScheduler.test.ts:321-369);index-scheduler 打点进 metrics(:370) |

### A4 PR4 · semanticIndex + dependencyGraph(commit 4bfba9b;todo 已勾,复核一致)

| 项 | todo | 实际 | 证据 |
|---|---|---|---|
| A4-1 semanticIndex | [x] | ✅ | `src/semanticIndex.ts`(329 行);tests/semanticIndex.test.ts(402 行) |
| A4-2 dependencyGraph | [x] | ✅ | `src/dependencyGraph.ts`(164 行);单文件变更失效范围测试;fullRebuild 恒 false |
| A4-3 类型注册表迁移 | [x] | ✅ | resolveEntityAnnotationType 改查快照(definitionWorkspace.ts;4bfba9b) |
| A4-4 实体映射查询迁移 | [x] | ✅ | getMappingForPythonFile 走 semanticIndex 兼容层(4bfba9b entityMapping.ts) |
| A4-5 多资产根模型 | [x] | ✅ | rootID+显式查找顺序;同名冲突测试(tests/semanticIndex.test.ts) |
| A4-6 查找顺序取证 | [x] | ✅ | docs/review/2026-10-23-pr4-lookup-order-forensics.md(42 行,随 4bfba9b) |

### A5 PR5 · Python Definition 去全仓阻塞(commit d4fd634)

| 项 | todo | 实际 | 证据 |
|---|---|---|---|
| A5-1 去阻塞重构 | [ ] | ✅ | 静态 MRO/组合根命中即答,按需单文件解析+后台补全;U1 冷启动首查 468.69ms(PR5 报告 §2) |
| A5-2 组合根构建缓存 | [ ] | ✅ | mtime+size 指纹缓存,重派生零重读(PR5 报告 §1.3) |
| A5-3 版本与失效 | [ ] | ✅ | classes/bases/methods/mro/compositionRoots 五轴版本+SemanticDependencyGraph 裁断(PR5 报告 §1.4) |
| A5-4 删除/重命名/基类变更摘除 | [ ] | ✅ | unindexFile 精确摘除;删除后旧类 0 命中(PR5 报告 §1.5;final 报告场景 6) |
| A5-5 冷启动首查入报告 | [ ] | ✅ | U1 468.69ms(PR5 报告)/475.34ms(PR7 复测)入 docs/perf |

### A6 PR6 · 诊断一致性收口(commit ae4256d;todo 已勾,复核一致)

| 项 | todo | 实际 | 证据 |
|---|---|---|---|
| A6-1 诊断任务版本化 | [x] | ✅ | src/diagnosticScheduler.ts(322 行);tests/diagnosticScheduler.test.ts(414 行) |
| A6-2 分层诊断 | [x] | ✅ | 重算 19→7、无关事件 0(final 报告专项表) |
| A6-3 entities.xml 版本失效 | [x] | ✅ | documentStore 命名空间化版本缓存(languageProviders.ts validateEntitiesXmlDocument;ae4256d) |
| A6-4 配置切换清理/重算 | [x] | ✅ | tests/diagnosticScheduler.test.ts + tests/extension.test.ts(ae4256d) |
| A6-5 同名符号跨根稳定性 | [x] | ✅ | tests/semanticIndex.test.ts 增 122 行(ae4256d) |

### A7 PR7 · 复测回归与交付(commit e6e8bc7)

| 项 | todo | 实际 | 证据 |
|---|---|---|---|
| A7-1 同环境复测对比 | [ ] | ✅ | docs/perf/2026-final-report.md §3(同机同资产七场景 PR1→PR7 对照)+ final-run.txt 等三轮原始输出 |
| A7-2 验收表逐项标注 | [ ] | ✅ | final 报告 §4:通过 6 / 未通过 0 / 未测量 2(Hover/Completion 端到端),不硬凑 |
| A7-3 新架构文档 | [ ] | ✅ | docs/architecture/semantic-index.md(125 行) |
| A7-4 未解决问题清单 | [ ] | ✅ | final 报告 §6(6 项未解决+5 条下一轮建议) |

## B. 止血项(5 条;todo 已勾,本次逐条复核 commit 在案)

| 项 | todo | 实际 | 证据 |
|---|---|---|---|
| B-1 hover 永转修复 | [x] | ✅ | 9c8daf7(raceWithBudget+定向解析);悬停 8-14ms;真凶 normalizeLookupPath 小写化 |
| B-2 函数着色 | [x] | ✅ | 179a290(variable.function.call.python=#8BD5FF,11 主题) |
| B-3 RPC 形参 inlay | [x] | ✅ | fa13ef9(kbengine.inlayHints.typeData;+6 测试) |
| B-4 调用链双 Tab | [x] | ✅ | d5cff3d(mermaid@12 离线打包;16 例测试) |
| B-5 分支收敛 main | [x] | ✅ | 5071dde 已在 main(本次 `git branch --contains` 实证) |

## C. 功能项(12 条)

| 项 | todo | 实际 | 证据 |
|---|---|---|---|
| C-1 G9 watcher 协议取证 | [ ] | ❌ | docs/design/ 无 watcher 协议取证文档(def-pyi-stubs.md 非本条口径);src 仅 kbeModuleIndex 内建 API 表,无协议面摘录 |
| C-2 G9 最小查询面板 | [ ] | ❌ | src/ 无 watcher 查询面板模块 |
| C-3 G9 面板操作面 | [ ] | ❌ | 同上,且依赖 C-2 |
| C-4 .pyi 抢占「开关建议档」 | [ ] | ◐ | 实验文档在(docs/review/2026-10-22-pyi-shadow-experiment.md,Observed results/Conclusion);**待拍板的开关建议行未产出**(grep 开关建议/拍板 0 命中) |
| C-5 V-06a 引擎版本探测 | [ ] | ◐ | src/engineCompatibility.ts 以 `kbe/src/lib/common/version.h` 探测(2c1a842);非任务书口径的 git describe→unknown 语义,变形落地 |
| C-6 V-06b API 元数据挂接 | [ ] | ◐ | src/engineApiMetadata.ts 引擎感知 API 元数据(2c1a842,tests/engineApiMetadata.test.ts);「版本标识进 API 浏览面」的呈现面证据待补 |
| C-7 V-06c 配置开关+features 行 | [ ] | ❌ | package.json 无对应引擎版本配置键;docs/features.md 无 V-06 行 |
| C-8 V-07a KBENGINE_ROOT skipIf | [ ] | ✅(漏勾) | tests/realEngineIntegration.test.ts:9,15(`describe.skipIf(!canRun)`;675e805/82cf01c,早于 2026-10-22 重拆) |
| C-9 V-07b fantasydemo 真实样例批 | [ ] | ✅(漏勾) | tests/fantasydemoRealExport.test.ts(:30 skipIf 无本地引擎树即跳;675e805/82cf01c) |
| C-10 V-07c CI 接线(有树真跑) | [ ] | ❌ | .github/workflows/ci.yml 无 KBENGINE_ROOT/集成 tag 腿 |
| C-11 V-08 边界注记 | [ ] | ⏸ | 外部条件(管理协议可用性)未触发,与 todo 口径一致 |
| C-12 chatgpt 四份归并核对 | [ ] | ❌ | docs/review/chatgpt-2026-10-20-{roadmap,log-center,background-process,typings}.md 四份原文仍在,核引用余数≠0 |

## D. 维护与质量(4 条)

| 项 | todo | 实际 | 证据 |
|---|---|---|---|
| D-1 CI 日巡首跑复核 | [ ] | ◐ | .github/workflows/nightly.yml(schedule+48h 停滞门)在仓;cron e4bddc0a5a17 属 Hermes 侧,首跑复核动作无仓内证据,本仓不可判 |
| D-2 docsCommands 测试口径随新键补齐 | [ ] | ❌ | tests/docsCommands.test.ts 对 callChainView/typeData/asyncBudget 0 引用(grep 实证);配置文档行本身已备(docs/guide/configuration.md:105/117/128) |
| D-3 publish 仅 workflow_dispatch | [ ] | ✅(漏勾) | 185f027;.github/workflows/publish.yml:「手动发版专用:仅 workflow_dispatch 触发」(本次复核原文在案) |
| D-4 features.md 随 B/C 同步 | [ ] | ◐ | typeData 行已同步(docs/features.md:27,110);B-1 hover 预算/B-2 函数着色/B-4 callChainView 无对应行(grep 0 命中) |

## 可勾清单(建议 todo.md 维护方按此勾,证据即上表)

1. A1-1..A1-6、A2-1..A2-6、A3-1..A3-6、A5-1..A5-5、A7-1..A7-4(共 27 条)→ 勾,证据列照抄。
2. A1-7 保持未勾(未完成;唯一 PR1 缺口,已入 ph0-gate.md 门 1 缺口清单)。
3. C-8、C-9、D-3 → 勾(完成早于重拆,漏勾)。
4. C-4/C-5/C-6/D-1/D-4 保持未勾但可加「◐ 部分」注记指向本表行。

## AUDIT-014 正式映射:旧 A1-A7 → PR1-7 → Kode 2.0 Phase

书(docs/kode2/KODE_2_COMPLETE_TODO.md)AUDIT-014 条目「明确旧 A1-A7 对新 Phase 的映射;保留所有当前已修复的永转/超时问题回归测试」由本节正式勾账。书文件按其页眉协议(原文逐字保留,不自动覆盖)不改,本节即映射正本。

| 旧账 | 落地 commit | Kode 2.0 对应 Phase/条目 | 迁移口径 |
|---|---|---|---|
| A1 PR1 观测与基线 | 89e8783 | Phase 0(PERF-005/007/010/011 前置)→ Phase 2 Rust bench 对拍口径 | metrics 埋点面为 Rust Core 双轨对齐的**同口径基准**;`tests/perf/*.bench.ts` 为 Phase 2 PR-012 验收的 TS 侧参照 |
| A2 PR2 documentStore | 7d8736b | Phase 1 VFS(CORE/VFS 快照、version 唯一标识)≈ ARCH-003 | 快照/版本/行索引语义整体迁移 kode-vfs;TS documentStore 在双轨期保留为回退提供者 |
| A3 PR3 indexScheduler | 2aca694 | Phase 2 IDX(任务优先级/取消/失败恢复)≈ ARCH-006 | 调度语义(五级优先、keyed 合并、失败重入队)迁 kode-index;行为测试为迁移等价性验收基准 |
| A4 PR4 semanticIndex+dependencyGraph | 4bfba9b | Phase 2 SYNTAX/SEM/IDX(依赖 DAG 失效)≈ ARCH-004/006 | 依赖失效与多根 rootID 模型迁 kode-semantic/kode-index;`fullRebuild` 恒 false 为不变式 |
| A5 PR5 Definition 去阻塞 | d4fd634 | Phase 2/3(IDX 局部查询、冷启动不阻塞)≈ ARCH-004 | U1/U3 口径(冷启动首查、热路径 P95)为 Rust 对拍必测场景;PR5 报告 §4 的 U4 成本为 Rust 侧改进标的 |
| A6 PR6 诊断一致性 | ae4256d | Phase 2 LSP diagnostics(版本化发布)≈ ARCH-005 | 诊断重算计数(19→7)与无关事件 0 为迁移回归阈值 |
| A7 PR7 复测交付 | e6e8bc7 | Phase 0 基准正本(PERF-011/015)→ Phase 2 PR-012 gate 输入 | final 报告「未测量 2 项」即 ph0-gate.md 门 1 缺口 |

**永转/超时问题回归测试保留清单**(AUDIT-014 后半句):hover 预算闸 `tests/hoverBudget.test.ts`(B-1,9c8daf7:raceWithBudget/withInitialScanTimeout/LogHub 超时层名)、`tests/hoverBudget.test.ts` + `tests/indexScheduler.test.ts:253`(扫描失败不永久 pending,A3-4)、`tests/documentStore.test.ts`(解析中再编辑旧不覆新,A2-3)。三类测试在 Rust 迁移期间**禁止删除**,并须在双轨期对 Rust 路径等价复刻(见 ph0-gate.md 门 2)。
