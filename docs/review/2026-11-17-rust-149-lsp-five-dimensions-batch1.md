# RUST-149 批 1:LSP 功能五维测试(stale/cancel/cold/root/重启)覆盖盘点与首批缺口填补

日期:2026-11-17

## 批 1 交付

1. **五维覆盖盘点矩阵**(全 provider 面 × 5 维,52 次检索实证):强面=definition/hover/completion(五维近乎全覆盖,含 Rust serving 门/请求失败兜底/冷首扫可取消);诊断调度器 stale 面最强(diagnosticScheduler.test.ts 十项+kodeSchedulerParity TS↔Rust 对拍);重启面跨 face 最强(kodeCoreGate 重启冷却/版本账重置/快照重放/kill-switch+kodeCoreGateRoots 换根重放)。
2. **首批缺口填补(接线级两钉,tests/covExtensionCommands.test.ts)**:
   - `onDidChangeWorkspaceFolders` smoke 升级为真实断言:移除根→documentStore 快照随根释放(cacheHit false→true→释放后 false 三拍)+rootConfigGeneration 推进(reason=workspace-folders)+新增根推进+空事件不推进;
   - `onDidCloseTextDocument` 诊断整族摘除钉:close 面全 13 族 collection 种子→fire close→逐族断言清空(root 移除→VSCode 关文档→清除链的钉)。
3. **顺修生产缺陷**:close 摘除面缺 KSEM-STRUCT-04/05 两族(fixedDictConstructDiagnostics/scalarAssignDiagnostics 的 collection.delete 与 scheduler.releaseDocument 双缺,extension.ts closeWatcher)——同面 11 族全摘,唯此两族关闭后 Problems 面遗留过期诊断;补齐与兄弟族对齐(解构 +2+closeWatcher +7,净 +9)。prove-red:移除修复→钉红(种子残留 got 1),cp+cmp 字节还原→绿(81 passed)。

## 覆盖矩阵要点(节选;完整矩阵见本文件 §盘点)

| 面 | stale | cancel | cold | root | Rust 重启/兜底 |
|---|---|---|---|---|---|
| definition | ✓ kodeDefinitionServing:46 | ✓ 三处 | ✓ 冷首查不阻塞 | 部分(根摘除链钉) | ✓ serving 门+失败回 TS+重启重放 |
| hover | ✓ 版本键控重扫 | ✓ 最全(7 文件) | ✓ | GAP(批2) | ✓ 畸形应答整面作废回 TS |
| completion | GAP(见下裁定) | ✓ 含 Rust-first await-cancel | ✓ isIncomplete 冷契约 | GAP(批2) | ✓ 全臂(空集/null/失败→TS) |
| diagnostics 族 | ✓ 最强(十项+双端 parity) | GAP(代际/version 守卫替代) | GAP(零启动臂) | GAP(见 §发现) | ✓ 12 counters+版本前进不发布 |
| inlay 7 族 | GAP(全族) | 仅 typeData/dataDict | 仅 typeData | GAP | defParam parity 仅对拍 |
| callHierarchy | GAP | ✓ 双向+负缓存 | ✓ | GAP | N-A(RUST-145 批 1 决策核 parity) |
| semanticTokens | ✓ 版本缓存 | N-A(签名无 token,同步算) | N-A | N-A | parity 仅对拍 |
| codeLens | GAP | 仅 property/rpc 两族 | 仅 typesXml | GAP | N-A |

## completion stale 维度裁定(不补版本守卫钉的理由)

补全的保鲜由两层既有机制承担:①VSCode 对每次击键取消前请求(token 面,completionGapArms 已钉 Rust-first await-cancel→[]);②冷首扫 isIncomplete=true 契约(pythonCompletionColdRefresh 已钉,VSCode 拿到 isIncomplete 会重询)。补全结果是瞬态 UI(不被持久化、逐击键重算),版本守卫钉对用户不可见行为无增益——如实登记为「由 cancel+isIncomplete 承担,不加版本闸」,后续若引入异步重活再补。

## 发现(登记,按影响排序,后续批次)

1. **diagnostics.ts 无 onDidChangeWorkspaceFolders 处理器**:根移除不 invalidate 代际也不清已发布诊断——缓解链=根移除→VSCode 关文档→close 摘除(本批已钉);若文档在根移除后仍开着(VSCode 允许),遗留面存在。裁定待批 2(补处理器或留决策记录)。
2. **kodeCoreGateWiring.ts diffScanRoots/syncRootsToRust/foldersWatcher 零测试**(workspace-folder 事件→根 diff→Rust register/remove+重镜像):gate 级 registerRoot/removeRoot/重启重放已测(kodeCoreGateRoots/kodeCoreRootLifecycle),生产粘合层未钉——批 2 候选。
3. **covExtensionCommands.foldersChanged 原为纯 smoke**:本批已升级(见交付 2)。
4. **inlay 7 族 stale/cancel/cold 大面积 GAP、codeLens 7 族 cancel GAP、references/workspaceSymbol/implementation stale GAP**:批 3+ 候选,按用户影响排序。
5. **semanticTokensProvider 签名不带 token**(RUST-144 批 4 如实边界):同步零 await 计算,cancel 维度结构性 N-A;若批 2 引入 Rust 异步取数须同步补 token 面。

## 门禁

eslint 0 / tsc 0 / vitest 全量 860 文件 EXIT=0(首轮唯一红=AUD-076 墙钟 330ms>200ms,在案负载抖动族,solo 61 绿+全量复跑 EXIT=0,与本批触碰面无关)/ xvfb demo 25 RC=0;ANCHORS 锁步=extension.ts 440/539→449/548+perfCallChainDoc 历史注+2026-baseline.md §7 两出处同步;todo.md 批注带 d124e7a4;prove-red 一靶(cp+cmp 还原)。
