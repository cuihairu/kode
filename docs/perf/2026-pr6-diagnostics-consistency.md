# PR6 诊断一致性收口:版本化诊断任务与重算收口报告

- 日期:2026-10-23
- 前序:PR5(d4fd634,冷启动 Definition 首查 107,737ms→468.69ms)
- 复现:`npx vitest run tests/diagnosticScheduler.test.ts`(before/after 同一事件脚本指标断言)

## 1. 改动摘要

1. **A6-1 诊断任务版本化**(src/diagnosticScheduler.ts 新模块):每个诊断任务携带文档版本令牌;连续编辑经 `requestQueued` 排队通道同 URI「最新版本胜出」,被顶掉的过期任务记 `coalescedStale` 永不执行;冲刷(`flushQueued`)发布前复核版本令牌,过期结果丢弃(`staleDropped`)。任何路径都不发布与当前版本不匹配的诊断。(IDE-DIA-006 追注 2026-10-28:`flushQueued` 已时间片化——单轮连续同步处理超 25ms 且还有条目时让出宿主续批,让出窗口内的新任务由后续轮次收编;小批量零让出与本文同步口径逐拍等价。IDE-DIA-008 同日追注:每 URI 关闭代守卫——`releaseDocument` 与重开新建状态各自增代,上一代出队条目零计算丢弃、在途 worker 回包发布前丢弃(`releasedDropped`),文档关闭后晚到结果不可能写入 collection。)
2. **A6-2 分层与重算收口**:`DiagnosticLayer`('local' 纯文本/AST | 'semantic' 索引依赖)分层记账;per-URI 键控使无关文件变更零诊断任务;同版本+同诊断输入代(generation)已发布的重复请求零重算(`skippedCurrentVersion`)。指标断言见 §3。
3. **A6-3 entities.xml 同版本失效约束**(src/languageProviders.ts:1090):`validateEntitiesXmlDocument` 分析面经 documentStore `getOrParseDocumentSync('entities-analysis')` 版本化——同版本零重分析(缓存命中),版本前进旧槽整体作废;无版本替身每次现算(与旧行为同价)。
4. **A6-4 配置切换正确清理/重算**(src/extension.ts:1231-1248):`kbengine.enableDiagnostics` 关闭→`diagnostics.clear()` + 停算,重开→invalidateAll 迫使重算;`enableStructureDiagnostics`/`kbengine.diagnostics.*` 变更→invalidateAll + 重算;**其余任意 kbengine.\* 变更(hover/jumpLog/codeLens…,旧行为一律全量重扫)不再触发任何文档重算**。批131 的 `resetDatabaseInterfaceConfigCache()` 保留但不再连带全文档重扫。
5. **A6-5 同名符号跨根稳定性测试集**(tests/semanticIndex.test.ts 末组):注册→摘除→重注册 50 轮胜者/冲突清单零漂移、注册节奏(先A后B/先B后A)确定性、失效按根隔离(rootB types.xml 变更不作废 rootA 快照)、同名 def 跨根 documentStore 版本轴互不串位(接 PR5 版本轴)。

## 2. 诊断重算次数 before/after(同一事件脚本,测试内双模型执行)

事件脚本:开档 A/B/C(.def) → A 连续 10 次编辑 → 无关 .py 文件变更 ×1 → 无关 kbengine 配置变更 ×2 → 诊断配置变更 ×1。

| 模型 | 重算次数 | 构成 |
|---|---|---|
| before(PR6 前接线) | **19** | 开档 3 + 逐键 10(其中 9 次发布即过期)+ 配置变更 3 次 × 全量重扫 3 文档 = 6 |
| after(PR6 调度器) | **7** | 开档 3 + 编辑合并后 1(coalescedStale=9)+ 诊断配置重算 3;无关文件/配置变更 **0** |

两组数字均由 `tests/diagnosticScheduler.test.ts`(A6-2 describe)对同一脚本实际执行计数断言,非推算。before 模型是 PR6 前 extension.ts 事件面的字面等价(每次 kbengine 配置变更 forEach 全部打开文档 validateDocumentTimed)。

## 3. 门禁

- `pnpm test:unit`:**2799 passed / 7 skipped**(门禁 ≥2784;净增 15:diagnosticScheduler.test.ts 11 例 + semanticIndex A6-5 4 例)
- `pnpm compile`(tsc)零错误;`pnpm lint`(eslint)零错误

## 4. 行为变化(如实记录)

1. 文档变更路径的诊断发布从同步推迟到宏任务边界(setTimeout 0 冲刷)——连续编辑的中间版本诊断不再可见,只有合并后的当前版本结果;开档/激活路径保持同步发布。extension.test.ts 相应两处断言改为等一拍冲刷。
2. 任意 kbengine.* 配置变更不再全量重扫打开文档;只有诊断相关配置节(enableDiagnostics/enableStructureDiagnostics/diagnostics.*)触发清理或重算。
