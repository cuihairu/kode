# RUST-005 审计:发布到编辑器的结果带请求/文档/索引版本,拒绝旧结果覆盖新结果

日期:2026-11-15。审计对象:todo.md RUST-005。方法:枚举全部「发布到编辑器」面(诊断集合/装饰/provider-pull/面板/流式/状态条),逐面核版本身份与陈旧拒绝机制。**结论:判据按面型全谱成立,无生产码缺口,审计收口**;两类面型(一次性命令/流式)不适用版本化快照语义,如实登记裁定依据,不凑数不改。

## 1. 事件驱动诊断家族:判据的完整实现(15 调度器)

主共享调度器(`src/backend/diagnosticScheduler.ts`)+ 14 个独立实例(`src/activate/diagnostics.ts:635-1652`:defMethodConsistency/userTypeContract/propertyDirection/readOnlyWrite/roleMisuse/postDestroy/cellDataWrite/spaceDataProtectedKey/fixedDictConstruct/scalarAssign/cellDataWrongKey/cellDataCallback/processTopology 等;独立建制的理由=每 URI 单排队槽,主任务占槽会顶掉同文档其它管线,:627-630 注释)。判据三轴逐一:

| 判据轴 | 机制 | 位置 |
|---|---|---|
| 请求版本 | 任务携带入队版本令牌;同 URI 排队「最新版本胜出」,旧版本出队记 coalescedStale 永不执行 | `requestQueued` :237-251 |
| 文档版本 | 计算后复核 live `document.version`,前进即 staleDropped 不发布(同步+异步双路) | `computeAndPublish` :450/:531 |
| 索引/输入版本 | generation(诊断输入代):配置/结构开关变更 `invalidateAll` 自增;计算在途中切代 → staleGenerationDropped 丢弃,且不把新代标成已发布(防 skippedCurrentVersion 错跳) | :423/:474-483 |
| 关闭身份 | releaseEpoch 每 URI 关闭代:关闭/重开使在途与已出队全部失配 → releasedDropped | :456/:537/:322 |
| 开关身份 | 在途计算遇开关关闭 → disabledAsyncDropped,不写回 collection | :462-471 |
| 同版本免重算 | publishedVersion+publishedGeneration 双轴命中即 skip(反向防抖) | :215-220/:333-339 |

测试钉:`tests/diagnosticScheduler.test.ts` 25 例,五类守卫计数(coalescedStale/staleDropped/releasedDropped/staleGenerationDropped/disabledAsyncDropped)+flush 让出时间片全数断言。

进程拓扑特例核实:publish 跨多目标文件(`diagnostics.ts:1810-1816` 全量 clear+set)而守卫身份是触发文档版本——裁定良性:全局输入(entities.xml/defs)在 computeAsync 内现读(:1784-1786),manifestText 在请求时捕获但 manifest 是开放文档事件触发,VS Code 对开放文档的每次内容变更(含外部改动自动重载)都推进 version,触发文档版本守卫(:1778/:450)即覆盖其输入变化;非开放文件不产生文档事件、不入该管线。两触发档(manifest 档与 def 档)并发在飞时,后完成者的输入与前者差异只可能来自 manifest 变更,而该变更必然推进 manifest 文档 version → 前者被 staleDropped 拦截。登记该结构细节,不构成可复现的旧压新。

## 2. provider-pull 面:请求身份天然成立

hover/definition/completion/inlay/codeLens/codeActions/highlight 均为 VS Code 拉模型:每次 provider 调用即一次请求,宿主重查即弃旧答,不存在「旧结果写回新版本」的通道。调用内陈旧已由两道既有闸收口:KR-AUD-60(逐访问循环 token 截断)、AUD-072(冷索引等待取消竞速,hover/definition/completion/inlay 四家,后者 2026-11-15 RUST-004 批 1 补齐,9ab191c9)。流敏感解析缓存按文档实例身份+版本成键(flowVersionKey.ts,KODE-PERF-001),跨版本不命中旧解析。

## 3. 其余面型裁定

| 面型 | 面 | 裁定 |
|---|---|---|
| 一次性命令快照 | `kbengine.def.analyze`(`defAnalysisWiring.ts:62`)、`kbengine.python.ruffLint`(`backend/ruffLint.ts:104`→clear-then-set)、临时编辑热更(`activate/hotReload.ts:795`) | 用户显式触发、先 clear 后 set、无并发发布者;结果是「执行时刻快照」语义,版本化不适用。双击竞态窗口=用户尺度且输入同源(ruff 各自 spawn 时刻读盘),登记不修 |
| 流式追加 | telnet 控制台(`telnetWebView.ts:214`)、KBE 日志尾(`logWebView.ts:43` 带暂停背压) | 追加式事件流,序即身份,无快照覆盖语义 |
| 面板数据 | callgraph(KODE-PERF-001 刷新代际守卫)、flow 泳道(FLOW-019 阶段间取消+代际)、monitoring(显式暂停键)、其余查询面板 | 用户触发查询-应答对或已有代际守卫 |
| 单写者状态机 | 状态条(telnet 连接态/热更通道态/日志尾连接态)、热更 RESTART_REQUIRED 面(HOT 批已修 never-clear) | 更新即状态迁移,写者唯一,无旧快照通道 |
| 树视图 | TreeDataProvider 拉模型 | 宿主拉取,无命令式覆盖面 |

## 4. 「索引版本」轴的登记

调度器 generation 现由配置/结构开关变更驱动(`extension.ts:856/860/864`、`diagnostics.ts` 组内联动)。`layer:'semantic'` 生产消费面尚不存在(scheduler 类型已备、无 `layer: 'semantic'` 调用点)——语义索引失效→invalidateAll 的接线属该诊断面上线时的装配项,非本判据现存缺口;届时 generation 机制即承载索引版本轴。
