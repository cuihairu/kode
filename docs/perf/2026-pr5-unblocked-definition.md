# PR5 去全仓阻塞:Python Definition 冷启动首查实测报告

- 日期:2026-10-23
- 对照基线:docs/perf/2026-baseline.md(PR1,场景 1 S1 = **107,737 ms** 冷启动首次类名查询,即「首次 Definition 被全量 .py 索引阻塞」)
- 代码:PR5 提交(消除 PythonClassIndex.ensureScanned/ensureCompositionRoots 的首查阻塞)
- 量测环境:同 PR1 基线(Linux,i9-10880H 14 逻辑核,Node v24.21.0,fake-vscode + 真实索引实现)
- 复现:`KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/unblockedDefinition.bench.ts`
- 原始输出:docs/perf/unblocked-definition-run.txt

## 1. 改动摘要

1. **首扫后台化**:文件发现(keyed `initial-scan` 任务)+ 分块解析(`full-reindex` 后台任务,16 路并发/块,块间可插队交互任务)全部迁入 indexScheduler;激活即排程(extension.ts)。
2. **Definition 去阻塞**:①静态 MRO / ②组合根命中即答,不等全量;请求所需文件(查询文件、import 候选、同目录兄弟)按 RequestLocal 单文件任务按需解析,补载顺序对齐 discovery 序;①② 均落空才等后台扫描收敛后重查(③ 反向形态必须全仓口径)。
3. **组合根构建缓存**:XML/def 内容按 mtime+size 指纹缓存,重派生零重读(`python-composition-roots` 事件 cacheHits 断言);派生并发判稳用「组合根纪元 + 赋值桥指纹」,不再用每次解析都递增的 generation。
4. **显式版本轴 + PR4 依赖图**:classes/bases/methods/mro/compositionRoots 五轴独立递增;组合根派生来源(entities.xml/.def/types.xml + 带实例赋值的 py)记入 SemanticDependencyGraph,失效按图裁断,`fullRebuild` 恒 false。
5. **删除/重命名/基类变更**:旧索引项精确摘除(unindexFile),跳转不再落已删除位置;②比较改用稳定 classKey(staging/后台重解析后对象引用失效)。

## 2. 实测数字(large,30,005 个 .py)

| # | 场景 | PR1 基线 | PR5 实测 | 变化 |
|---|---|---|---|---|
| U1 | **冷启动 Definition 首查**(首扫在途,不等待) | ≈107,737 ms(阻塞在等价的全量路径上) | **468.69 ms,1 命中** | **≈230×,进入亚秒** |
| U2 | 后台全量扫描收尾(首查后) | — | 117,345.74 ms | 扫描本体后台推进 |
| U3 | 索引就绪后 Definition 重复查询 | — | p50 12.60 / p95 27.30 / p99 47.97 ms(n=40) | 热路径可用 |
| U4 | 全量口径 API 冷启动首查(显式等扫描,与 PR1 S1 同口径) | 107,737 ms | 130,267.31 ms | +20.9%(见 §4) |

## 3. 解读

1. **主指标达成**:PR1 的唯一秒级瓶颈(首次 Definition 被全仓扫描阻塞 107.7s)消除——常规 self 方法跳转首查 468.69ms 出答案,期间 30,000 文件全量索引在调度器后台继续。
2. **正确性不降级**:①静态 MRO/②组合根命中即答;①② 落空(如兄弟 mixin 反向形态)自动等全量收敛后重查,结果口径与 PR1 一致(单元测试锁定,含「发现面未收录仍按需命中」「扫描失败不永久缓存」「重命名后旧位置不可达」)。
3. **U3 的 12ms p50** 是 ③ 反向后代全 byName 遍历的既有成本形态(PR1 未单测此路径),非本次引入。

## 4. 如实记录的回归

- U4(显式等待全量的冷启动)130,267ms,较 PR1 的 107,737ms 慢 20.9%。来源:分块任务调度(1,875 个 chunk 任务)+ 每文件版本签名记账 + staging 探测性读。该路径在生产中不再是用户等待路径(仅类名枚举等全量口径 API 使用);若需回收,后续可做签名惰性化与任务合并。

## 5. 门禁

- `pnpm test:unit`:**2784 passed / 7 skipped**(门禁 ≥2777)
- `pnpm compile`(tsc)零错误;`pnpm lint`(eslint)零错误
