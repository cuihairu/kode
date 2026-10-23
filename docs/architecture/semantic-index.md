# 统一语义索引架构(2026-10 重构后)

- 范围:PR2–PR6 落地后的语言服务数据面与调度面,作为 docs/perf/2026-final-report.md §8 引用的架构交付物(评审 §11 交付物 3/4/5)。
- 性质:描述**当前代码事实**(src/ 下模块与已锁定测试),不是设想稿。
- 源码索引:src/documentStore.ts(342 行)、src/indexScheduler.ts(422)、src/semanticIndex.ts(329)、src/dependencyGraph.ts(164)、src/diagnosticScheduler.ts(322)、src/entityMapping.ts、src/pythonClassIndex.ts、src/scanRoots.ts、src/workspaceIndex.ts、src/languageServiceMetrics.ts。

## 1. 架构图

```text
                       ┌──────────────────────────────────────────────┐
                       │            VS Code Providers(入口)           │
                       │  Hover / Definition / Completion / Diagnostics│
                       └──────┬───────────────┬───────────────┬───────┘
                              │               │               │
                    ┌─────────▼──────┐ ┌──────▼───────┐ ┌─────▼──────────────┐
   打开文档(内存)──▶│ DocumentStore  │ │ SemanticIndex│ │ DiagnosticScheduler │
   磁盘文件─────────▶│ (快照+解析缓存) │ │ (实体/类型/   │ │ (版本令牌+分层记账)  │
                    │ 版本=只解析一次 │ │  符号查询)   │ │ 同URI新版本胜出      │
                    └─────────┬──────┘ └──────┬───────┘ └─────┬──────────────┘
                              │               │               │
                    ┌─────────▼───────────────▼───────────────▼───────┐
                    │       SemanticDependencyGraph(依赖图失效)        │
                    │  文件→符号依赖;变更经依赖裁断,fullRebuild 恒 false │
                    └─────────┬───────────────────────────────────────┘
                              │ 失效通知(notifySemanticFilesChanged)
                    ┌─────────▼───────────────────────────────────────┐
                    │              IndexScheduler(唯一调度入口)         │
                    │ 优先级队列 + 交互冷却 + 任务合并 + 失败恢复          │
                    └──────┬──────────────┬──────────────┬────────────┘
                           │              │              │
                 ┌─────────▼───┐  ┌───────▼──────┐  ┌────▼──────────────┐
                 │EntityMapping │  │PythonClassIndex│  │ WorkspaceIndex    │
                 │Manager(.def) │  │(类/MRO/组合根) │  │(局部符号索引)       │
                 └─────────┬───┘  └───────┬──────┘  └────┬──────────────┘
                           │              │              │
                    ┌──────▼──────────────▼──────────────▼─────┐
                    │  ScanRoots(文件发现,跨根+外部根,结果缓存)  │
                    └──────────────────────────────────────────┘
                              │
              languageServiceMetrics(全部路径埋点,P50/95/99 汇总)
```

要点:Provider 查询**只读快照与索引**,不在请求路径做目录遍历;全量扫描是调度器里的后台任务;一切失效经依赖图裁断。

## 2. 索引数据模型

### 2.1 DocumentStore(src/documentStore.ts)

- 键:规范化文件路径;值:文档快照 { 版本号、文本行索引、轻量解析结构(parse 结果)、解析状态、最近成功解析版本 }。
- 契约:同版本只解析一次(`getOrParseDocumentSync` 版本轴);解析期间新编辑不覆盖新版本;打开文档以 VS Code 内存文本为准。
- 实测口径:同版本 .def 解析命中率 96.1%(n=51,见 docs/perf/final-pr2-run.txt)。

### 2.2 SemanticIndex(src/semanticIndex.ts)

- 数据:`SemanticEntityRegistration`(实体注册)、`SemanticEntityEntry`(实体条目:owner 引用、def、根)、`SemanticTypeRegistrySnapshot<T>`(类型注册表快照)、`EntityRecord`/`TypeRegistryRecord` 内部记录。
- 查询 API:按根解析实体归属、同名冲突清单(`findEntityConflicts`,胜者排首)、类型注册表快照读取、文件变更失效入口 `notifySemanticFilesChanged(changedFiles)`(返回失效条数)。
- EntityMappingManager 的查询经其兼容层走同序(不另建平行索引)。

### 2.3 SemanticDependencyGraph(src/dependencyGraph.ts)

- 记录:文件 ↔ 依赖文件/符号(`DependencyRecord`);失效计划 `InvalidationPlan { invalidateFiles }`。
- 规则:单文件变更 → `invalidate = { 该文件 } ∪ 传递依赖方`,排序输出;**禁止**任何变更都升级为全仓重建(`fullRebuild` 恒 false,PR5 起断言)。

### 2.4 PythonClassIndex 五轴版本(src/pythonClassIndex.ts)

- per-file `revisions` Map(每文件独立递增)+ `fileCache`(version→ParsedPythonFile);组合根派生判稳用「组合根纪元(rootsEpoch)+ 赋值桥指纹」,不用每次递增的 generation。
- 数据轴:classes / bases / methods / mro / compositionRoots 各自独立失效;删除/重命名走 `unindexFile` 精确摘除(场景 6:删除后 0 命中)。
- 组合根缓存:XML/def 内容 mtime+size 指纹,重派生零重读。

### 2.5 DiagnosticScheduler(src/diagnosticScheduler.ts)

- 任务携带文档版本令牌;同 URI 队列「最新版本胜出」,被顶掉的过期任务 `coalescedStale` 永不执行;冲刷前复核版本,过期结果 `staleDropped`。
- 分层:'local'(纯文本/AST)与 'semantic'(索引依赖)分开记账;per-URI 键控使无关文件变更零任务;同版本+同诊断代零重算(`skippedCurrentVersion`)。

## 3. 作用域规则(多资产根)

依据:docs/review/2026-10-23-pr4-lookup-order-forensics.md(取证+锁定测试)。

1. **根登记**:`registerRoot(规范化路径)` 幂等;稳定 rootID = 规范化路径;显式 order = 登记序(工作区根在前,外部资产根按 getIndexScanRoots 声明序)——查询结果**不依赖 Map 插入序或 OS 枚举序**。
2. **文件归属根**:最长前缀命中(嵌套资产根优先)。
3. **扫描序 = 注册序**:`findFilesAcrossRoots` 按根序枚举,故「先到先得」类规则可复现。
4. **同名符号策略**(锁定测试见 semanticIndex.test.ts):
   - 实体名映射:后注册者覆盖先者(单一胜者),冲突经 `findEntityConflicts` 全量暴露,不静默;
   - 类名→实体、owner(kind+名)回溯:先到先得(注册序首个);
   - Python 文件→实体:owner 精确匹配(路径大小写不敏感)→ basename 实体名回落 → 上层 PythonClassIndex 兜底;
   - 失效按根隔离:rootB 的 types.xml 变更不作废 rootA 快照;同名 def 跨根走 documentStore 版本轴互不串位。

## 4. 失效规则

| 变更 | 失效范围 | 机制 |
|---|---|---|
| Python 文件编辑 | 该文件 revisions+1 → classes/bases/methods/mro 轴按解析结果重建;MRO 缓存清空 | documentStore 版本检查 + pythonClassIndex 单文件路径 |
| .def / entities.xml / types.xml / alias.xml | 组合根指纹(mtime+size)失配才重派生;受影响符号经 SemanticDependencyGraph 裁断 | notifySemanticFilesChanged → InvalidationPlan |
| 类型注册表文件 | 仅该根的类型注册表快照作废,按 (根, 开关) 键控重建 | PR4:逐次 statSync 指纹已废除,重建只由更新事件驱动 |
| 文件删除/重命名 | unindexFile 精确摘除旧符号项 | 场景 6:11.3ms,0 旧命中 |
| 诊断配置变更 | 仅诊断相关节(enableDiagnostics/enableStructureDiagnostics/diagnostics.*)触发清理(invalidateAll)或重算;其余 kbengine.* 变更 0 重算 | extension.ts 配置面 + diagnosticScheduler |
| VS Code 文件事件不可靠时 | 显式一致性检查入口(有界重扫/手动刷新),不做逐查询全量元数据检查 | scanRoots 结果生命周期缓存 |

## 5. 任务调度(src/indexScheduler.ts)

- 任务种类:`initial-scan` / `single-file-update` / `dependency-update` / `delete-cleanup` / `full-reindex` / `non-interactive`。
- 优先级(数值小者先):CurrentFileLight 0 → RequestLocal 1 → DependencyUpdate 2 → BackgroundFull 3 → NonInteractive 4;`isInteractivePriority` = priority < 3。
- 机制:
  - 同键任务合并(同 URI 最新版本胜出,过期任务取消/丢弃);
  - 交互冷却(interactiveCooldownMs):后台全量任务在交互任务后让路,分块 16 路并发/块,块间可插队;
  - 失败恢复:任务失败可重试,不永久停留 pending(锁定测试);staging 探测失败不永久缓存;
  - 状态查询:`SchedulerStatus` / `SchedulerMetrics`(含 backgroundDelayMs);
  - 激活即排程 initial-scan + full-reindex(extension.ts),Provider 只等 RequestLocal 级任务。

## 6. 数据流示例(冷启动 Definition,对应最终报告 U1=475.34ms)

```text
激活 ─▶ 调度器排程 initial-scan(发现)+ full-reindex(分块后台)
用户首次 Definition ─▶ Provider:①静态 MRO 命中?②组合根命中? ──是──▶ 即答(不等全量)
                                        └──否──▶ RequestLocal 单文件按需解析(查询文件/import 候选/同目录)
                                                 仍落空 ▶ 等后台收敛后重查(③ 反向形态)
后台 30,001 文件扫描继续 ▶ U2=106.6s 收尾,期间交互不被阻塞
```

## 7. 关联文档

- 性能最终报告:docs/perf/2026-final-report.md
- 基线:docs/perf/2026-baseline.md;各 PR 报告:docs/perf/2026-pr2/3/5/6-*.md
- 查找顺序取证:docs/review/2026-10-23-pr4-lookup-order-forensics.md
- 评审总纲:docs/review/2026-10-22-unified-semantic-index-refactor.md
