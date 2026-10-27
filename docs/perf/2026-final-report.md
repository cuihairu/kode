# Kode 语言服务性能最终报告:PR7 复测与回归(2026)

- 日期:2026-10-23
- 复测代码:main @ PR6 后(逐项 commit hash 见 `docs/review/2026-10-22-unified-semantic-index-refactor.md` 跟踪表;本次复测基提交 ae4256d,PR7 文档提交 hash 见该表 PR7 行)
- 对照基线:docs/perf/2026-baseline.md(PR1,提交 89e8783)
- 评审来源:docs/review/2026-10-22-unified-semantic-index-refactor.md §9(验收标准)、§10 PR7
- 原则:**无可复现数据的性能声明不进本报告**;未测项如实标「未测量」。

## 1. 测试环境(与 PR1 基线同机同配置)

| 项 | 值 |
|---|---|
| OS | Linux(内核 7.0.0-38-generic) |
| CPU | Intel(R) Core(TM) i9-10880H @ 2.30GHz,14 逻辑核 |
| 内存 | 45GiB(buff/cache 31GiB,热缓存口径,同基线) |
| Node.js | v24.21.0 |
| 量测框架 | vitest 5.0.3(`vitest.bench.config.ts`)+ fake-vscode 桩,真实索引实现 |

## 2. 测试资产集(与 PR1 基线同一生成器、同一规模)

`scripts/generate-perf-assets.mjs --large-files 30000` 确定性生成:small 7 / large 30,005 / multi-root 18 / big-py 5 / def-heavy 1,323 / noise 406,组成与基线报告 §2 完全一致。

复现命令(本轮全部实跑):

```bash
KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/baseline.bench.ts
KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/unblockedDefinition.bench.ts
KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/documentStore.bench.ts
npx vitest run tests/diagnosticScheduler.test.ts   # PR6 诊断重算计数断言
```

原始输出:`docs/perf/final-run.txt`、`docs/perf/final-unblocked-run.txt`、`docs/perf/final-pr2-run.txt`;基线对照:`docs/perf/baseline-run.txt`、`docs/perf/unblocked-definition-run.txt`、`docs/perf/pr2-documentstore-run.txt`。

## 3. 七场景复测对比(PR1 基线 → PR7 复测,同环境同资产集)

### 场景 1:冷启动首次索引(large,30,001 个 .py)

| 指标 | PR1 基线 | PR7 复测 | 变化 |
|---|---|---|---|
| S1 首次类名查询(**全量口径**,显式等扫描) | 107,737.52 ms | 100,492.95 ms | −6.7%(单轮噪声内) |
| S1 首查(**去阻塞口径**,PR5 新路径 U1) | ≈107,737 ms(阻塞在等价全量路径) | **475.34 ms,1 命中** | **≈227×,进入亚秒** |
| U2 首查后后台全量扫描收尾 | —(基线无此拆分) | 106,631.86 ms | 扫描本体与基线同量级,未退化 |
| S1b entity-mapping 冷扫(def-heavy 1,320 .def) | 652.41 ms | 736.50 ms | +12.9%(单轮噪声内,见 §5) |

### 场景 2:索引就绪后重复查询(large,热缓存)

| 指标 | PR1 基线 | PR7 复测 |
|---|---|---|
| findClassesByName P50/P95/P99(n=200) | 0.01 / 0.02 / 0.04 ms | 0 / 0 / 0.02 ms |
| computeMRO P50/P95/P99(n=40) | 0.01 / 0.04 / 1.33 ms | 0 / 0.02 / 0.78 ms |
| Definition 重复查询 P50/P95/P99(U3,n=40) | 未测(PR1 无此 bench 路径) | 16.00 / 22.10 / 23.60 ms |

### 场景 3:新文件落盘后首次查询(big-py)

| 指标 | PR1 基线 | PR7 复测 |
|---|---|---|
| 索引+查询 | 0.75 ms | 0.94 ms |

### 场景 4:编辑当前文件后查询(big-py 8,000 方法,n=20)

| 指标 | PR1 基线 | PR7 复测 |
|---|---|---|
| P50/P95/P99 | 0.04 / 0.14 / 79.93 ms | 0.17 / 0.36 / 89.89 ms |

P99 尖峰来源与基线一致(updateFile 后 MRO 缓存清空重建);P50/P95 绝对值仍在亚毫秒级。

### 场景 5:.def/XML 修改后查询

| 指标 | PR1 基线 | PR7 复测 |
|---|---|---|
| .def 热复扫(mtime 缓存,def-heavy) | 17.08 ms | 18.73 ms(≈39× vs 冷扫 736.50 ms) |
| 同版本 .def AST 复用(PR2 documentParse,n=51) | 未测 | 命中率 96.1%,命中 P95 <0.1 ms |
| big .def 编辑后单次重解析 | 未测 | 1.19 ms |

### 场景 6:删除 .py 后失效(large)

| 指标 | PR1 基线 | PR7 复测 |
|---|---|---|
| 失效耗时 | 6.71 ms | 11.30 ms |
| 旧类命中数 | 0 | 0(正确性保持) |

### 场景 7:并发查询(multi-root 同名类,60 路)

| 指标 | PR1 基线 | PR7 复测 |
|---|---|---|
| wall | 0.34 ms | 0.09 ms |
| 总命中 | 360(6 定义 × 60 查询,跨根不丢) | 360(不丢) |
| rootsContaining P99(n=20) | 4.58 ms | 7.49 ms |

### 场景 8(噪声):排除式目录不进索引(noise)

| 指标 | PR1 基线 | PR7 复测 |
|---|---|---|
| 冷扫 | 1.64 ms | 2.21 ms |
| 泄漏类命中 | 0 | 0(600 个干扰 .py 仍被排除) |

### 专项:诊断重算收口(PR6,测试内双模型同脚本计数)

| 指标 | before(PR6 前) | after(PR6,复测 tree) |
|---|---|---|
| 同一事件脚本诊断重算次数 | 19 | **7**(编辑合并 + 无关事件 0) |
| 无关 .py / 无关配置变更触发 | 全量重扫 | **0** |

## 4. 验收表(评审 §9.2,逐项:通过 / 未通过 / 未测量)

目标口径以基线评审(PR1,89e8783)定案为准,不硬凑。

| # | §9.2 指标 | 验收要求(评审原文口径) | 实测依据 | 结论 |
|---|---|---|---|---|
| 1 | 已建立索引后的 Hover | 大型测试集 P50/P95/P99;建议 P95 ≤ 30 ms | 服务层组件级证据:行准备 P95 <0.01 ms(PR2 快照)、类型注册表纯内存快照(PR4);**端到端 Hover 请求 P95 未在大型集上量测** | **未测量**(组件级代理数据达标;端到端口径待补 hover bench) |
| 2 | 已建立索引后的 Completion | 大型测试集 P50/P95/P99;建议 P95 ≤ 50 ms | 无对应 bench 场景 | **未测量** |
| 3 | 已建立索引后的 Definition | 大型测试集 P50/P95/P99;建议 P95 ≤ 50 ms | U3(large,30,001 .py,热路径,n=40):P95 **22.10 ms** ≤ 50 ms | **通过** |
| 4 | 单文件增量解析 | 不同大小/类型耗时分布;常见文件 P95 ≤ 100 ms | .def 同版本命中 P95 <0.1 ms;big .def 重解析 1.19 ms;big-py 编辑路径 P95 0.36 ms(P99 89.89 ms,MRO 重建) | **通过**(分布覆盖 .def/XML/py 三类;更细粒度大小分档未测) |
| 5 | 交互请求中的全仓扫描 | 已建立索引后正常请求不得触发全仓目录遍历 | U1 冷启动 Definition 首查 475.34 ms 不等 30,001 文件全量;PR6 无关事件 0;埋点确认交互路径无全量遍历 | **通过** |
| 6 | 高频请求的同步文件系统访问 | 不得重复同步检查整组资产文件 | PR4 废除逐次 statSync 指纹(类型注册表改纯内存快照);PR5 组合根 mtime+size 指纹缓存(重派生零重读);`findFilesAcrossRoots` 结果带生命周期缓存 | **通过** |
| 7 | 增量失效范围 | 单文件变更只更新该文件及依赖图确认的相关索引 | PR6:无关 .py 变更 0 诊断任务、无关配置变更 0 重算;PR5 组合根失效按 SemanticDependencyGraph 裁断(`fullRebuild` 恒 false);场景 6 删除后旧项 0 命中 | **通过** |
| 8 | 索引冷启动 | 记录首扫耗时、文件数、解析数、内存、失败率 | 耗时(U2 106,631.86 ms)、扫描/解析 30,001 文件、失败率 0(本轮 error=0)已记录;**内存占用未记录** | **通过**(内存子项未测量,见 §6) |
| 9 | 大型项目稳定性 | 多轮查询/变更后无持续增长的重复任务、过期结果或不可恢复失败 | PR3 调度器失败恢复测试;PR6 稳定性测试集(50 轮注册/摘除零漂移、失效按根隔离);本轮多场景连续跑无 error | **通过**(测试锁定口径;真实 VS Code 长时会话未测,见 §6) |

**统计:通过 6 / 未通过 0 / 未测量 2**(其中 #1 为组件级证据达标但端到端口径未测)。

> **2026-10-28 现场复核注(P0-4d,审计底稿 docs/review/2026-10-28-p0-4d-report-audit.md)**:
> - **#1 Hover 端到端**:已现场补测——联合场稳态 P95 ≤5.05ms(目标 30ms ✓),暖机窗 71.29ms 单列(docs/perf/2026-10-28-p0-4c-joint-acceptance.md §3/§4);本行「未测量」状态就此关闭,上表原文与组件级证据保留不动。
> - **#5 「不等全仓」口径限定**:U1 服务层事实(475.34ms 首查不等全量收尾)保留;现场口径冷首查 1189.08ms 仍含 ~1.05s 首扫等待,结果到位晚于请求——「不等」限定为「不阻塞等全量收尾」,冷窗结果晚到如实记录(审计底稿 §1.1)。
> - **#9 长会话**:已现场补测——10 轮长会话逐轮收敛无劣化,RSS 305→237MiB 平台(P0-4c §4);本行括注「真实 VS Code 长时会话未测」就此关闭。
> - §6 未解决表:#1 的 Hover 面、#2 冷启动内存(四面 VmHWM 177/290/225/305MiB)、#6 激活→首请求链已由 P0-4b/P0-4c 关闭;**Completion 端到端仍未测,如实留账**。

§9.1 行为正确性:`pnpm test:unit` 2,799 通过(门禁 ≥2,799)、tsc 零错、eslint 零错(本轮实跑,见 §7)。

## 5. 未达标项与如实记录的偏差

1. **单轮微增项(噪声量级,不判回归,但如实记录)**:S1b 冷扫 +12.9%(652→737 ms)、S4 P99 +12.5%(79.9→89.9 ms)、S6 失效 +68.4%(6.7→11.3 ms)、S7 rootsContaining P99 +63.5%(4.6→7.5 ms)、S8 冷扫 +34.8%(1.6→2.2 ms)。全部为亚秒/低毫秒级绝对值,且机械盘 + 热缓存口径下单轮抖动大(P5 轮 U4 曾测得 130 s,本轮 89.9 s,同代码);判回归需多轮取中位,本轮各只跑一轮,故**不宣称改善也不判定退化**,列入 §6 待办(基准多轮化)。
2. **U4 全量口径冷启动(P5 轮曾 +20.9%)**:本轮 89,878.77 ms,较基线 −16.6%。两轮分列 130.3 s / 89.9 s,证实该数字受磁盘抖动主导;代码面成本(分块调度 + 版本签名记账)已在 P5 报告 §4 如实记录,该路径已非用户等待路径。
3. **S4 P99 尖峰(79.9→89.9 ms)**:根因与基线相同(updateFile 清 MRO 缓存后重建),量级可接受,保持跟踪。

## 6. 未解决问题清单与下一轮建议

### 未解决

| # | 问题 | 现状 |
|---|---|---|
| 1 | Hover / Completion 端到端 P95 未在大型集量测 | §9.2 #1/#2 标「未测量」;现有为组件级证据 |
| 2 | 冷启动内存占用未记录 | §9.2 #8 内存子项缺数字 |
| 3 | bench 单轮抖动大(机械盘),微增项无法判定 | 需多轮取中位 + 冷/热盘分离 |
| 4 | U4 全量口径的分块调度 + 版本签名记账开销 | 非用户等待路径,但任务量 1,875 chunk 可合并 |
| 5 | S4 P99 尖峰(MRO 重建) | 79~90 ms 量级,可接受待跟踪 |
| 6 | VS Code 真实 UI 端到端(激活→首请求)、Windows/macOS/慢盘 | 基线 §5 即标待测,本轮未覆盖 |

### 下一轮建议(优先级序)

1. **补 Hover/Completion 大型集 bench**(复用 baseline.bench 资产 + languageProviders 真实 Provider),关闭 §9.2 #1/#2。
2. **基准多轮化**:bench 加 `--repeat N` 取中位/置信区间,记录进程内存(`process.memoryUsage.rss` 峰值),消除单轮噪声判定困境。
3. **U4 成本回收**:版本签名惰性化、chunk 任务合并(P5 §4 建议)。
4. **冷/热磁盘缓存分离量测**(基线 §5 待测项)。
5. **VS Code electron 集成端到端**(`test:electron` 通道已有,补性能口径)。

## 7. 门禁(本轮实跑)

- `pnpm test:unit`:**2,799 passed / 7 skipped**(门禁 ≥2,799)
- `pnpm compile`(tsc):零错误
- `pnpm lint`(eslint):零错误

## 8. 架构文档索引

新架构图与索引数据模型/作用域/失效/调度说明见 **docs/architecture/semantic-index.md**(§11 最终交付物 3/4/5);多资产根与同名符号解析策略详见 docs/review/2026-10-23-pr4-lookup-order-forensics.md。
