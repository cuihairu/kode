# TS 后端独立目录抽取 · 批次 16(scheduling 族)2026-11-09

续批次 1-15,同式推进。**本批与批次 15 合并提交**(见下)。

## 范围(7 件,`git mv` 至 src/backend/)

diagnosticScheduler / documentStore / pendingWorkDrain / indexScheduler /
backgroundWarmup / warmupStages / entryHooks

选族依据:零 `from 'vscode'` 的调度/文档快照/后台预热面(共 ~2.1k 行)。
**留 src/**:languageServiceMetrics(度量注册表,跨面共享)。

## 改动面

- import 重基 90 处,UNRESOLVED 恰为既有 13 假阳性零新增;族内
  warmupStages→backgroundWarmup 兄弟解析,出向留守件(languageServiceMetrics)
  改 `../`。
- **perfCallChainDoc §7 ANCHORS 锁步 3 处**(本批首次触该面):
  diagnosticScheduler 228/258、documentStore 155 → `src/backend/` 段,
  行号不变(import 指示符仅行内文本变);docs/perf/2026-baseline.md 引用锚
  4 处(diagnosticScheduler :228/:258/:176/:195 面 + documentStore :154)
  改 `backend/` 前缀——校验逻辑 `src/${file}` 与前缀天然兼容,
  perfCallChainDoc 隔离 4/4 绿。
- 活文档路径对账 4 处:features.md en+zh 各 2。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量门禁见提交前记录。

## 为何与批次 15 合并提交

批次 16 的 `git mv`+重基发生在批次 15 全量套件运行中(工作树交叠:
extension.ts 等共享 importer 同时含两批重基改动)。若拆两笔提交,先提的
一笔在 HEAD 态引用尚未搬移的模块必然 tsc 红(ANXOR-RELOCK 教训:工作树绿
≠HEAD 绿)。故两批一次提交,门禁跑在合并后树上。
