# RUST-006 审计:优先局部解析与受影响依赖更新,禁止无理由「任意改动→全仓重建」

日期:2026-11-15。审计对象:todo.md RUST-006。方法:枚举全部事件驱动重建面(实体映射索引/数据字典索引/工作区事件索引/空间数据索引/Rust 语义层/诊断调度/FLOW 图/命令时批分析),逐面核失效粒度。**结论:仓库架构系统性地是增量失效,判据按面谱成立,无生产码缺口,审计收口**;仅有的两处全量作废均有登记理由。

## 1. 各面失效粒度

| 面 | 事件→动作 | 粒度 | 出处 |
|---|---|---|---|
| 实体映射(.def 变更) | 依赖图出计划 → 仅 `plan.invalidateFiles` 摘除索引切片+schema 缓存按清单摘+变更文件自身定向重解析;无关实体条目继续命中 | 依赖闭包(受影响集) | `entityMapping.ts:1086-1101`(IDE-SCH-003/IDE-IDX-008) |
| 实体映射(.py 变更) | 单文件 reconcile(`refreshPythonDefFile`)+归属实体定向 force 重解析(共享脚本逐 owner,只刷依赖实体) | 单文件+归属实体 | `entityMapping.ts:1145-1166`(IDE-IDX-005) |
| 实体映射(types/alias.xml) | **按消费别名**摘 schema 缓存——没消费被改别名的实体继续命中;注册表快照作废 | 消费别名集 | `entityMapping.ts:1011-1018`(IDE-SCH-004) |
| 数据字典索引 | 逐文件 `indexFile`+per-path revision(变更升版本使在飞旧读作废,AUD-070 追读);callKeyDependents 精确依赖边;根移除 `removeRoot` 定向撤贡献 | 单文件+依赖键族 | `globalDataIndex.ts:230-322`(AUD-070/074/KODE-AUD-005) |
| 工作区事件索引 | 逐文件 `indexFile`+revisions;初扫跳过在飞升版文件(监听先挂,最新者胜) | 单文件 | `workspaceIndex.ts:89-139`(AUD-033/KR-AUD-27) |
| 空间数据索引 | 逐文件 `updateFile`;关文档回读盘覆盖 | 单文件 | `spaceDataIndex.ts:117-145` |
| Rust 语义层 | 流敏感解析按文档实例身份+版本成键 LRU(flowVersionKey,KODE-PERF-001)——同版本共享解析、版本前进即新解析,无跨文件重算 | 单文档单版本 | `backend/flowVersionKey.ts` |
| 诊断调度 | per-URI 键控:无关文件变更不产生任何打开文档的诊断任务;连续编辑合并(coalescedStale)+执行后过期丢弃 | 触发文档 | `backend/diagnosticScheduler.ts` 头注②+25 例测试 |
| FLOW 调用图 | 增量失效=快照对比(非调用方现声明键才重算) | 声明键差异集 | FLOW-013(922182dd) |
| 命令时批分析 | `kbengine.def.analyze`/`ruffLint`/defReferenceGraph/projectDoctor | 全量——但无事件驱动重建,用户显式触发即命令语义本身,不在「任意改动→重建」判据域内 | `defAnalysisWiring.ts`/`backend/ruffLint.ts`/`backend/defReferenceGraph.ts` |

## 2. 全量作废的两处登记(均有理由)

| 触发 | 动作 | 理由 |
|---|---|---|
| 工作区根**新增** | `globalDataIndex.invalidate()` 整库重建(`globalDataIndex.ts:254-264`,AUD-071) | 新根贡献未知新写点/读点集,无法定向——根集变化本身是全局输入;根**移除**仍是定向 `removeRoot` |
| 外部资产根(assetsRoot)配置切换 | 实体映射 watcher 三件套整组重挂(`entityMapping.ts:1066-1084`,IDE-IDX-014) | 扫描根集整体更换,等价新根语义 |

## 3. 一次性冷启动与判据的边界

workspaceIndex/globalDataIndex/spaceDataIndex 的初扫(懒触发+可取消等待,AUD-072/CR-AUD 系列)是冷启动设计而非「任意改动→全仓重建」:一次性、懒触发(首个读访问点)、此后全程增量。判据约束的是**变更响应路径**,初扫不在其域。

## 4. 结论

判据指向的反模式(文件变更→无差别全仓重建)在仓库中不存在;变更响应在全部索引面上是「单文件 reconcile + 依赖闭包定向失效 + 无关缓存继续命中」三层结构,且每层有 IDE-IDX/IDE-SCH/AUD 系列测试与真机事故回归钉(IDE-ACC-011 等)。
