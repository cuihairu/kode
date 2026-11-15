# RUST-004 审计与整改(第一批):索引查询无阻塞全量初始化前置

日期:2026-11-15。审计对象:todo.md RUST-004「索引查询无阻塞全量初始化前置;允许明确标注 partial/incomplete,禁止悄悄返回假完整结果」。方法:枚举索引消费面逐处读码核实。

**本批结论:provider 读面(hover / definition / completion / inlay)四家的冷索引等待全部接入取消竞速(AUD-072 口径),判据的「查询不阻塞」在交互 provider 面收官**——AUD-072(R4-F07)当时只改了三家,inlay(`src/typeInlayHints.ts`)是唯一保留 pre-AUD-072 阻塞形的消费面,本批补齐。判据后半「partial/incomplete 标注」未动,登记见 §3,整行保持 `[ ]`。

## 1. 已修:inlay 读点冷索引等待接 token

`src/typeInlayHints.ts` `collectDataDictHints` 读点路径的 `await this.dataDictIndex.ensureStarted()`(不接 token)替换为 `awaitDataDictIndexReady(this.dataDictIndex, token)`(`src/languageProviders/pythonDefinition.ts:71`):入口预检 + 与共享初扫 `Promise.race`,取消先到即返回 false → inlay 调用即返(读点 hint 弃,写点 hint 不需索引、保留);共享初扫原样继续服务其他请求,单次取消不中止不破坏索引。token 经 `provideInlayHints` 一路穿透(CancellationToken 本就是该 API 的第三参)。

**懒触发位保持**:gate 仍在读访问点(循环内、write/delete 早退之后),不提进循环前——write/delete-only 的可视区不触发全量扫描是既有语义(写点 hint 只读本行,零扫描成本),提前 hoist 会改变触发语义(实现时先提后审出,已回退)。

## 2. prove-red 设计(预取消不构成 prove)

预取消 token 新旧实现不可分(两者都在入口早退)。钉法:挂死索引(`ensureStarted` 永不 resolve)+ 竞速订阅落定(让一个宏任务过去,订阅发生在微任务里)后中途取消 → 断言调用返回且 `ensureStartedCalls === 1`(证明抵达过读点门,非别名/开关早退假绿)、读点 hint 弃、写点 hint 保留。回归旧形则调用永挂,测试以 2s 超时红。

实测:变异后红(`inlay 仍挂在 ensureStarted:取消未生效`);`cp` 还原 + `cmp` 字节一致后绿。测试 `tests/typeInlayHintsDataDictCancel.test.ts`。

## 3. 登记未修(判据后半 + 其余阻塞面,整行保持未勾)

| 面 | 位置 | 缺口 | 第二批(§5)处置 |
|---|---|---|---|
| `query()` 无就绪门 | `src/globalDataIndex.ts:686-688` | 索引未建时静默返回 `[]`——判据「禁止悄悄返回假完整结果」的直接靶子。当前生产消费面都先过 `ensureStarted`/`awaitDataDictIndexReady` 门所以不可达,但面本身无门、无 partial 标注,属潜伏假完整 | **重定性+标注面落地**:`query()` 原语义保持(增量事件驱动索引,严格就绪门会误伤 noteSaved 驱动用法,见 §5);标注轴 `queryMarked`/`queryKeyFamiliesMarked`/`isReady` 落地,新消费端走标注面 |
| `allEventCalls` 硬 await | `src/workspaceIndex.ts:342-343` | 全量事件调用索引同步等完整初始化,无取消/无 partial | 维持登记:eventApi 无 token 可传,取消需消费面接线设计,非机械批 |
| `defReferenceGraph` 同步扫 | `src/workspaceIndex.ts:363-371` | 同步全量扫描,无 partial 面 | **审计已陈旧**:RUST-001 批 B(1d9a76c3)已把该扫描异步化(fs.promises+8 路有界并发+逐文件让位),登记行失效 |
| partial/incomplete 标注缺失 | GlobalDataDictIndex / SpaceDataIndex / WorkspaceIndex 各查询返回 | 返回形状无 partial/incomplete 维度,判据「允许明确标注」一侧未落地 | **三侧全落地**:GlobalDataDictIndex(§5 `queryMarked`/`queryKeyFamiliesMarked`)+ SpaceDataIndex(§6 `queryFamiliesForSpaceMarked`/`queryFamilySitesMarked`)+ WorkspaceIndex(§6 `allEventCallsMarked`),均返回 `ready` 布尔 |

## 4. 门禁

`tsc` RC=0;`npm run lint`(`eslint src --ext ts`)RC=0;`test:unit` 全量 **10186 total / 10178 passed / 0 failed / 8 skipped**(与 RUST-003 当轮 10185 比对:差值恰为本批新增 1 例,零消失);`xvfb-run -a test:demo:editor` **25 passing** RC=0。

锚点:`perfCallChainDoc.test.ts` ANCHORS 表不含 `src/typeInlayHints.ts`(核过),本批行号位移不触发锁步。

## 5. 第二批(2026-11-15 续):GlobalDataDictIndex 标注轴落地

**判定方法论**:第一批的 `query()` 缺口按「build-then-serve 前提缺失」处置——重新读码核实,GlobalDataDictIndex 是**增量事件驱动索引**(`noteSaved` 不经初扫也能蓄内容,`gapArms` 钉死「已销毁查询静默空」为既有语义),不存在「未初扫 = 未建」的严格分界:严格就绪门(未就绪即 throw / 拒答)会误伤事件驱动用法,也破坏钉死语义。判据原文「允许明确标注 partial/incomplete,禁止悄悄返回假完整结果」的正解在**标注轴**:让调用方能区分「未建」与「空结果」,而不是把查询锁在门后。

**落地面**(`src/globalDataIndex.ts`):
- `get isReady(): boolean` —— `started && !disposed`,就绪语义=工作区初扫完成且未弃置;
- `queryMarked(dict, keySignature, root?)` —— 返回 `{sites, ready}`,未就绪 `{sites: [], ready: false}`,就绪时与 `query()` 同源;
- `queryKeyFamiliesMarked(dict, root?)` —— 同口径的键族标注变体;
- `query()` / `queryKeyFamilies()` **原语义一行不动**(既有消费面与钉死测试全保)——生产消费面现状都先过 `ensureStarted`/`awaitDataDictIndexReady` 门,标注面供后续消费端迁移时用,门仍在上游纪律。

**prove-red**:变异 `queryMarked`/`queryKeyFamiliesMarked` 恒返 `ready: true`(摘标注=退回「未建装成空结果」)→ 未就绪两例红(`Failed Tests 2`);`cp` 还原 + `cmp` 字节一致 → 4 例复绿。测试 `tests/globalDataIndexMarkedQuery.test.ts` 4 例(isReady 三态 / 未就绪标注 / 就绪同源 / 键族标注)。

**剩余登记**(整行保持未勾的原因):SpaceDataIndex / WorkspaceIndex 标注轴未落(→ §6 已落)+ `allEventCalls` 硬 await(eventApi 无 token 可传,取消需消费面接线设计,非机械批)。

## 6. 第三批(2026-11-15 续):SpaceDataIndex / WorkspaceIndex 标注轴落地

同款模式机械复制(判定方法论见 §5,增量事件驱动语义不变,查询原语义一行不动):

**落地面**:
- `src/spaceDataIndex.ts` —— `get isReady()`(`started && !disposed`)+ `queryFamiliesForSpaceMarked(sid)` → `{families, ready}` + `queryFamilySitesMarked(sid, key)` → `{sites, ready}`;未就绪 `{…: [], ready: false}`,就绪与 plain 查询同源;`awaitReady`(取消闸)上游纪律不变;
- `src/workspaceIndex.ts` —— `get isReady()` + `allEventCallsMarked()` → `Promise<{calls, ready}>`:未就绪**零阻塞零副作用**返回(不触发 `ensureStarted`,findFiles 零次),就绪走 `allEventCalls()` 原语义;`methodsOf` 是文档文本直取面,不依赖索引状态,无标注轴需求。

**prove-red**:变异 SpaceDataIndex 两标注面恒 `ready: true` + 摘 WorkspaceIndex 未就绪早退分支 → 未就绪三例红(3 failed);`cp` 还原 + `cmp` 字节一致 → 7 例复绿。测试 `tests/indexMarkedAxisRound2.test.ts` 7 例(SpaceDataIndex isReady 三态/未就绪标注×2/就绪同源×2;WorkspaceIndex isReady 三态/未就绪零阻塞不触发初扫/就绪同源)。

**剩余登记**(整行保持未勾的唯一原因):`allEventCalls` 硬 await——eventApi 无 token 可传,取消需消费面接线设计,非机械批;标注面已给后续消费端「免阻塞区分未建/空」的迁移面。
