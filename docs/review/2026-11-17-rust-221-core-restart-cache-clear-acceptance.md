# RUST-221 验收纪要:Core 重启、清缓存(展示范围/影响)、export diagnostics——勿要求清空 workspace 才能修

日期:2026-11-17。本纪要对账 RUST-221(旧 UI-004,主 todo 排队项)的验收口径与交付证据。结论:**export diagnostics 既有(IDE-REL-007 复现摘要);Core 重启与清缓存数据面齐而用户命令面缺失,本批补两命令(真增量),并以诚实文案正面回答「勿要求用户清空 workspace 才能修」。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| Core 重启 | 新命令 `kbengine.core.restart`:gate.restartCore() 公开面(停 Rust 进程+清冷却/镜像账/快照,与换 serverPath 自动重启同一路径),重启后补镜像语料(新进程空库,快照按 didOpen 重放);backend=ts 如实说明无进程可重启不装动作 | `src/backend/kodeCoreGate.ts`(restartCore);`src/kodeCoreGateWiring.ts`(命令);gate 测试 2 例(显式重启同效 kill-switch 往返/ts 幂等) |
| 清缓存(展示范围) | 新命令 `kbengine.diagnostics.clearCaches`:modal 确认先列三缓存(解析文档/数据库 schema/返回注解索引)与实时在册条数,确认后才清 | `src/backend/cacheMaintenance.ts`(renderCacheClearConfirmation);`src/activate/utilityCommands.ts`(接线) |
| 清缓存(展示影响) | 确认文案如实:缓存只是加速层,下次查询自动重建(短暂变慢),不动磁盘与工作区文件,无数据丢失;清后摘要逐条报前后差值,缓存本已空时如实说明「本次没有清掉任何条目」 | `renderCacheClearedReport`;测试 4 例 |
| 勿要求清空 workspace 才能修 | 文案明示「重启窗口不是第一步」;修复梯度=清缓存(轻)→ 重启 Core(中)→ 重启窗口(重,profileHealth 索引停滞入口保留为最后手段);Core 侧另有 kill-switch 杀开关(`kbengine.core.backend=ts`)为即时止血面 | cacheMaintenance 文案;既有 profileHealth/kodeCoreGate 面 |
| export diagnostics | 既有完整面:`kbengine.diagnostics.exportReproSummary`(IDE-REL-007:版本/根/宿主/开关/队列数据+连接掩码)、CPU profile 落盘(.cpuprofile+.window.txt 关联窗口)、发现报告/Project Doctor 通道 | `src/activate/utilityCommands.ts`(reproSummaryCommand);`tests/reproductionSummary*.test.ts` |

## 本批增量(feat c281555d)

- `src/backend/kodeCoreGate.ts`:restartCore() 公开方法(stopClient 语义复用:清冷却/镜像账/快照,差异日志保留与 dispose 同口径)。
- `src/backend/cacheMaintenance.ts`(新):确认文案+清后摘要纯核(渲染层零判定,动作组合在接线)。
- `src/backend/defParser.ts` / `src/databaseSchema.ts`:生产维护面正式导出 clearParsedDocumentCache / clearDatabaseSchemaCache(与 ForTests 同体别名——ForTests 名字不进生产调用点,10+ 处既有测试引用零牵连)。
- 接线:`kodeCoreGateWiring.ts`(kbengine.core.restart)+`utilityCommands.ts`(kbengine.diagnostics.clearCaches);manifest 双命令+双 nls+bundle.l10n 双包('Clear caches' 按钮);commands.md 两小节(docsCommands 门)。
- 测试:cacheMaintenance 4 例+kodeCoreGate restartCore 2 例;prove-red 变异 restartCore 空转→1 红→cmp 字节还原→复绿。
- 门禁:lint 0 / compile 0 / unit 10649 全绿。

## 诚实条款

- 「Core 重启」的形态是**停进程+清账+下次请求重建**(与配置驱动自动重启同一路径),不是原地热重启——Rust 进程无 reload 协议,如实按冷启动交付。
- 清缓存范围是**扩展侧三条内存缓存**,不含 Rust Core 进程内缓存(重启 Core 才触及其侧);不含 versionKey LRU(键控失效自洽,无陈旧窗口暴露面)。两者边界在确认文案与本文档如实分工。
- 缓存条数读数是命令执行瞬间的 gauge 快照;并发写入下的「清掉 N 条」差值按前后读数差计,不承诺精确逐条台账(计数差语义,如实)。
