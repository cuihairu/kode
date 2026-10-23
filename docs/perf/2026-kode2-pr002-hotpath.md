# 书 PR-002(fix/ts-hotpath):工作区门控 + hover 冷启动 + workspaceDiscovery Sync Top3 实测报告

- 日期:2026-10-23 · 分支:v0.2(基点 cd7c49b)
- 对照:docs/architecture/current-state.md(AUDIT-003/006、PERF-005 待测清单)、旧 A2/A3 已由 PR1-7 消化,本单补剩余可测项
- 量测环境:同 docs/perf/hardware.md(i9-10880H 14 逻辑核,Linux,Node v24.21.0,vitest bench + fake-vscode 桩,真实索引实现;服务层口径,不含 UI 序列化)
- 复现:
  - `KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/coldHover.bench.ts`
  - `npx vitest run --config vitest.bench.config.ts tests/perf/discoverySync.bench.ts`
- 原始输出:docs/perf/cold-hover-run.txt、docs/perf/discovery-sync-run.txt

## 1. 改动摘要(铁律:不改行为结果)

1. **工作区门控(AUDIT-003 负案例)**:`src/workspaceGate.ts` 新增有界特征探测(合并 glob 单次 `findFiles`,maxResults=1:`**/*.def / entities.xml / types.xml / alias.xml / kbengine*.xml`)。激活期 `EntityMappingManager` 以 `deferStartup` 构造(零 watcher、零首扫入队),`PythonClassIndex` 不再无条件后台扫描;特征命中 → `ensureStartup()+scheduleBackgroundScan()` 与门控前逐行为一致。fail-open:探测异常按 KBEngine 工作区放行。
   - 行为保证:①`EntityMappingManager.ensureStartup()` 幂等,挂到全部异步查询入口(21 处)——deferred 模式下任何查询自动启动,`await this.initialScan` 等待链不悬死,结果口径不变;②同步状态读取(getMapping/getIndex/getAllMappings 等 5 处)**不**触发启动——激活期 CodeLens 装配读到的本就是「首扫未完成」近空集,门控后读空集同口径;③非 KBEngine 工作区若有查询/命令使用,即按需启动(有使用证据才付后台成本)。
2. **hover 冷启动 bench 补课(PERF-005 待测)**:`tests/perf/coldHover.bench.ts`,PR1 资产集 large(30,005 .py),补基线 §6 缺失的冷悬停数字(H1-H5,见 §2)。
3. **workspaceDiscovery 交互路径 Top3(AUDIT-006 存量 17 处 Sync 中的 3 处)**:
   - 冷 walk(`scanWorkspaceAnchors` 递归 readdirSync):新增 `preheatDiscoveryScan(root)`,门控放行时激活期预热 scanCache——首查交互不再在请求路径付有界 walk;
   - `conventionalConfigRoots` 一级 readdirSync:按根 memo;
   - `hasEngineConfigProbe` existsSync 探针:按目录 memo;
   - 失效口径与 scanCache 同级(`resetDiscoveryState`/新 `resetDiscoveryMemo`,并挂入 `scanRoots.resetScanRootCache`)。**其余 14 处 Sync 实测 ≤0.03ms/次,低于量测噪声,明确留待 Rust 阶段**(见 §3)。

## 2. hover 冷启动实测(large,30,005 .py;docs/perf/cold-hover-run.txt)

| # | 场景 | 实测 |
|---|---|---|
| H1 | **冷悬停·首扫在途**(before:构造即悬停,n=5) | p50 0.16 / **p95 81.47** / max 81.47 ms;首次即命中 def 方法标注(1 hit) |
| H2 | 首扫收尾(构造期入队 → 完成) | 219.13 ms |
| H3 | **冷悬停·首扫完成后**(after:同点悬停) | **0.37 ms**,1 hit |
| H4 | 热悬停分布(n=40) | p50 0.03 / p95 0.17 / p99 0.33 ms |
| H5 | 冷悬停·激活期预热后(PR-002 ③ 组合效果) | **59.74 ms**(对照 H1 max 81.47,交互路径卸掉有界 walk) |

解读:①首扫在途悬停不再永转——首查亚毫秒出定向答案(p50 0.16ms),最坏样本 81.47ms 为首查一次性成本(定向 .def 解析 + 语义注册 + 深扫描冷 walk);②预算兜底(2.5s/5s)未在任何样本触发;③预热后冷悬停 59.74ms,一次性 walk 从交互路径卸到激活期。

## 3. workspaceDiscovery Sync Top3 实测(docs/perf/discovery-sync-run.txt)

| # | 存量(17 处中) | 修复前 | 修复后 |
|---|---|---|---|
| 1 | 深扫描冷 walk(large,20,000 条目触顶) | **39.97 ms/次**(uncachedWalkRepeat 39.82,def-heavy 12.62/4.26) | 交互路径 resolve 三兄弟 **≈0 ms/次**(interactiveResolveAfterPreheat);walk 本体移至激活期一次性 |
| 2 | `conventionalConfigRoots` readdirSync | 0.01 ms/次 | **≈0 ms/次**(按根 memo) |
| 3 | `hasEngineConfigProbe` + 约定链 existsSync 探针 | 0.03 ms/次 | **0.02 ms/次**(按目录 memo) |
| — | 其余 14 处(记忆项 existsSync、报告链等) | D4/D5 实测 ≈0 ms/次 | **不改**,留待 Rust 阶段(实测低于噪声,改动只添风险) |

## 4. 如实记录的边界

1. 所有数字为服务层单轮(硬件.md §2 口径),多轮取中位待建;H1 的 81.47ms 一次性成本中,深扫描 walk ≈40ms(D1 实测),其余为定向解析/注册首威成本,进一步压缩属后续优化空间。
2. 门控的激活面改进(真实 VS Code activation P95 ≤300ms 预算)不在本单量测范围——真实激活端到端口径属基线 §5 待测项(firebench 需 VS Code 宿主,PR-003 前维持待测)。
3. 同步状态读取 5 处不触发启动是有意取舍:与门控前「激活期读近空集」同口径;若未来装配逻辑改为依赖即时全量,需显式 `waitForInitialScan()`。

## 5. 门禁

- `npx vitest run`:**2827 passed / 7 skipped**(2811 存量全绿 + 本单新增 16:门控探测 6、deferStartup 4、激活门控 3、Top3 失效口径 3)
- `npx tsc -p tsconfig.json --noEmit` 零错误
