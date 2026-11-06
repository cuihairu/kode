# 三批并行合入完成质量审核（2026-11-05）

基点 `5fbbec2`；PR #5 合并 `5a734a5`、#6 `408c327`、#7 `aea7acd`。本次按当前 main 而非各分支隔离快照裁决。用户所列编号实际为 **18 项**，非 19 项；不猜测缺失编号。PASS 表示所列交付经证据核对符合该项验收，不代表全量门禁已通过；FAIL 包含实质缺陷或关闭依据不成立。测试无法运行不单独当作代码 FAIL。原始要求和当前勾选见 `todo.md:485-486,571,621-623,692,703-707,854-860,999-1002,1009-1010`；KODE/MCP 项当前仍未勾，不应描述成已勾。

## 逐条结论

| 条目 | 原要求与实际交付 / 证据 | 结论 |
|---|---|---|
| IDE-HOT-004 | applied 须可信证据、超时未确认；旧动作路径 `src/hotReloadAppliedCheck.ts:37`、新通道 `src/hotReload.ts:428-455` 确实比对冻结 digest，但参考端未实际应用，通道还漏代际保护及目标核验，见 F2–F4。已勾关闭不成立。`32d9efb`、`001f09b` | **FAIL** |
| IDE-HOT-005 | 结构变更不能普通发送；fire/重试确实共用实例 `src/extension.ts:4812-4820,4915`，但拦截后基线滚动可再次放行，见 F1。已勾关闭不成立。`342bcff` | **FAIL** |
| KODE-HOT-001 | HTTP/Telnet 接入、配置、回执及状态闭环：`src/extension.ts:4842-4848`、`src/hotReload.ts:347-473` 已接通，存在 F2/F4，闭环不成立。`32d9efb` | **FAIL** |
| KODE-HOT-002 | 各状态转换带测试：`tests/hotReloadFileStateTransitions.test.ts:20-125` 有各类派生状态及超时测试（`434f589`）；但直接写台账模拟回执，未验真实通道转换与代际，不能证明实际闭环；F2 是反例。 | **FAIL** |
| IDE-REV-022 | 实际响应接 accepted，须有真实协议依据：接线存在，但参考端仅自造协议，且新通道忽略 targetId，见 F3/F4。`c2b517f` | **FAIL** |
| IDE-REV-023 | 实际发送的 applied 双证与真实接收端依据：旧路径测试包括冻结与旧代（`tests/hotReloadAppliedVerifyWiring.test.ts:228,283`），新通道不满足代际与真实应用，见 F2/F3。`001f09b` | **FAIL** |
| IDE-REV-024 | 结构变化实际拦发送，非结构/Python 放行：单次路径有测试（`tests/hotReloadDefGateWiring.test.ts:140,161,176,254`），连续触发反例 F1 未覆盖。`5b33912` | **FAIL** |
| IDE-AUD-007 | 必须登记接收端实现、请求响应及**所应用** revision/digest；参考端仅读取、复制，自称 applied，没有执行 reload，见 F3；已勾不成立。`094f66e` | **FAIL** |
| IDE-AUD-017 | 短压力保留，另预设长会话、自然交互与资源预算：`src/test/electron/suite/longSessionTrend.test.ts:35,76-80,201-254`；实测记录 `docs/perf/2026-11-05-aud017-long-session-run.txt`，提交 `ee0d114`/`b15caaa`。180 秒是该项目所预设的长会话，不能外推更长时间。 | **PASS** |
| IDE-AUD-018 | 对每个原项完整验收且子项完成才能关：对账确有产物 `docs/review/2026-11-05-aud018-reconciliation.md:3-17,84-96`，但其对 HOT-005/REV-024 和回执族的关闭裁决受 F1/F3 反例推翻。`857a44c`/`e1ca226` | **FAIL** |
| IDE-AUD-019 | 按真实量规逐叶排干，不要求缓存归零：`src/pendingWorkDrain.ts:22-45,48-67`；真机调用 `src/test/electron/suite/finalMarks.test.ts:135-143,195-199`。`558094a`；历史真机排干证据见 `docs/perf/2026-11-05-acc010-final-marks-run.txt`。 | **PASS** |
| IDE-AUD-020 | 双指标断言、可控延迟、预设采样与争用处理：`src/finalMarksVerdict.ts:63-110` 池化、保留排除与未测；`tests/finalMarksVerdict.test.ts:25-55,78-102` 双向注入；真机分别断言 `src/test/electron/suite/finalMarks.test.ts:214-220`。全部超载时当前性能未测，非通过（历史记录 `docs/perf/2026-11-05-acc010-final-marks-run.txt:31-39`）。`42bfd04` | **PASS** |
| IDE-ACC-007 | 取消后残留/IO、共享扫描继续：`src/test/electron/suite/hoverCancelConverge.test.ts` 与 `docs/perf/2026-11-05-acc007-cancel-converge-rerun.txt`，派发后取消补证见 `621c285`；本轮未重跑真机，不把预取消样本当作派发中取消。`b61ec9c` | **PASS** |
| KODE-FEAT-001 | 先评估再定实现：`docs/design/def-formatter-evaluation.md:1-6,47-49,64-73` 列方案及不立即实现的结论。`b144067` | **PASS** |
| KODE-FEAT-002 | 运行时指标/py-spy 与未实现能力分界：`docs/design/perf-analysis-boundary.md`（`9496b29`）。 | **PASS** |
| KODE-ARCH-003 | 五索引所有权/失效文档有产物，但声称逐编号对照的 16 测试存在编号错配和空态假绿，见 F5。`6855e04` | **FAIL** |
| KODE-ARCH-004 | 现状文档已增刷新节 `docs/architecture/current-state.md:3-7`，但并行合并后关键事实过时，见 F6。`7819342` | **FAIL** |
| MCP-001 | 七工具非壳：`crates/kode-mcp/src/server.rs:63-107,127-203` 派发；`crates/kode-mcp/src/kb.rs:10-16,49-68,73-411` 读资产/复用 parser、server；stdio 客户端逐一断言真实结果 `crates/kode-mcp/tests/e2e.rs:54-168`，另有同源测试 `crates/kode-mcp/tests/units.rs:137-169`、双语 README `crates/kode-mcp/README.md:4,51`。`7c1a134`。本轮 cargo 门禁通过。 | **PASS** |

## 缺陷清单

### F1 · P1 · 被拦 def 的基线前移，第二次发送绕过需重启

`src/hotReloadDefGate.ts:47-56` 无论无基线还是结构变化被拦均 `baselines.set(file, after)`；`src/hotReloadRetryCommand.ts:90-103` 与 fire 共用同一本册。反例：先建立 A，结构改 B 第一次拦截，未重启再次保存 B 或只改注释，B 与滚动后的 B 指纹相同即放行；首次见 B 第二次同样放行。跨目标共用也会让一个目标的拦截影响另一个目标。该基线反映最近**观察**而非目标当前已加载结构。`tests/hotReloadDefGateWiring.test.ts:272-299` 明确把拦后滚动作为预期，未覆盖 B 再发送；这属于测试基准固化了错误行为。需要以各目标已知加载版本或明确重启确认建立基线，未知时持续保守拦截。相关提交 `342bcff`、`5b33912`。

### F2 · P1 · 新通道绕过发送代际并丢失冻结 digest

`src/hotReload.ts:378-391` 的 `recordOutcome` 不传 `attempt` 或 `sentDigest`，每个异步回执均被 `src/hotReloadTargetState.ts:87-104,134-142` 当成新发送。旧发送的 digest promise 晚于新发送失败完成时，`src/hotReload.ts:428-445` 可把新失败覆盖为旧 applied；台账也没有该次所发 digest，影响状态机基线。旧动作路径有代际回归（`tests/hotReloadAppliedVerifyWiring.test.ts:228`），没有覆盖新 transport。修复须发送时创建代际并让全部回执/结算绑定代际和冻结 digest。`32d9efb`。

### F3 · P1 · 参考接收端伪称 applied，不能作为引擎已应用的协议证据

`scripts/hot-reload-receiver/referenceReceiver.mjs:94-121` 读取本地文件、尝试复制（复制失败亦忽略），`mode=apply` 就返回 applied；没有引擎调用或已应用 revision 的核实。真实 HTTP 回环只能证明自定义协议的传输和解析，不能证明真实服务实际应用了该 digest。`todo.md:692` 明确要求所应用 revision/digest 和缺服务端依据时保持开放。由此 `docs/review/2026-11-05-aud018-reconciliation.md:86-90` 及 `todo.md:485,621-622,692` 的关闭依据不足。需接真实应用实现并记录版本、请求、响应及应用后证据，或保持未确认。`094f66e`、`001f09b`。

### F4 · P1 · HTTP 通道忽略可选 targetId

`src/hotReloadTransport.ts:138-168` 只校验文件和状态，未校验响应中的 targetId；`src/hotReload.ts:399-400,458-459` 直接落入当前目标。回执带错误 targetId 仍可 accepted，带匹配 digest 也可 applied；这违反 `todo.md:485` 所引用的回执契约。需将目标传入解析并拒绝不一致的显式 targetId。旧协议测试不覆盖新通道。相关 `32d9efb`。

### F5 · P2 · 16 条索引测试与文档非一一对应

`tests/indexOwnershipContracts.test.ts:2` 声称逐编号对应，但文档 `docs/architecture/index-ownership.md:44-49` 的 C-E2 是 removeRoot，测试 `tests/indexOwnershipContracts.test.ts:184-191` 的 C-E2 却测私有 SemanticIndex；C-E3、C-G1、C-G3 无对应测试（文档 `:47,86,90`）。C-W1 标题含查询但 `tests/indexOwnershipContracts.test.ts:142-147` 没有查询；C-G2 在空索引上调用 invalidate（`:162-169`），不能证明清空非空数据或按当前根重建。16 是测试数，不能据此声称覆盖文档契约。`6855e04`。

### F6 · P2 · 并行合并后当前架构文档过期

`docs/architecture/current-state.md:17-18` 仍称 10 crate 且未列 kode-mcp，实际 `crates/kode-mcp/Cargo.toml` 已入 workspace；`:34-37` 称 HOT-001/002 未实现，实际 fire 已接通 transport（`src/hotReload.ts:347-399`）且新增转换测试（`434f589`）。应描述已实现部分及本报告的未闭合缺陷，避免把状态写成全无。`7819342` 与 `7c1a134` 并行合入产生漂移。

## 测试数字与质量

- 本机 `cargo test --workspace --exclude kode-scheduler`：退出 0；汇总 87 个 test/doc-test 结果块，**525 passed、0 failed、0 ignored**，包括 MCP stdio 和单测。完整本机输出 `/tmp/kode-review-cargo.log`；不包含被排除的 scheduler。
- 本机 `npm test`：退出 1，Vitest 配置加载即报 `Cannot find module 'vitest/config'`，**0 个测试实际运行**；后续 compile/VS Code 测试未执行。工作区无 node_modules；`pnpm install --offline --frozen-lockfile --ignore-scripts` 因 store 操作锁只读失败，`npm install --offline --ignore-scripts --no-package-lock` 因 `@mermaid-js/tiny` 缓存缺失失败。原始输出分别在 `/tmp/kode-review-npm.log`、`/tmp/kode-review-install.log`、`/tmp/kode-review-npm-install.log`。这是依赖环境阻塞，不是预算型测试失败，故不存在可据此隔离复跑转绿的测试；不能引用历史数字冒充本机结果。
- 新测试有有效覆盖：MCP e2e 实际启动 stdio 客户端并逐工具核实内容；AUD-020 反向注入独立越界、保存争用排除证据。局限：状态机测试直接 `store.record` 构造 applied（`tests/hotReloadFileStateTransitions.test.ts:53-63`），不能验证接收端及新通道；F1 测试显式接受拦截后滚动，F5 的部分断言空态或错号，均不能以数量或绿灯替代验收。
- 历史 AUD-017 在 `todo.md:703` 记录曾因负载导致预算测试失败并隔离复跑；长会话设计从每周期大文件双保存调整为每四周期（`src/test/electron/suite/longSessionTrend.test.ts:58-59`），预算未改。该变化改变工作负载，报告不能将其与初版同负载比较。AUD-020 改用预登记负载闸及池化，不再使用历史三轮最优；现有高负载真机结果明确未测，见上述证据。

缺陷合计 **6 项：P1 4、P2 2**。需要返工；尤其不能据回环样本关闭真实应用证据缺口，也不能以现有单次结构闸与台账直写测试证明端到端安全。

## 修复记录（2026-11-05，分支 `feat/kode-fix-f1f4`）

本节是对上列 F1–F4 四个 P1 的返工记录；F5/F6（P2）本轮未动。每缺陷先写能复现缺陷的失败测试（red 已在本机复现），再修码转绿。`todo.md` 未改。

### F1 修复（commit `579ef92`）

- `src/hotReloadDefGate.ts` 判定面改为纯判定：被拦批次（结构性/无基线/不可读）**绝不改基线册**——上审报告的反例（拦后基线滚动，第二次保存同一内容或其非结构变体即放行）不再成立；跨目标基线牵连随纯判定面一并消除。
- 基线只随两时机建立/前滚：`commit`（批次通过判定且即将真实发送，fire 与重试路径同口径）与 `confirmLoaded`（明确重启确认）。新增命令 `kbengine.hotReload.confirmDefBaseline`（activationEvents/commands/docs/guide/commands.md 已登记）承接重启确认；无基线文件在确认前持续保守拦截。
- 回归：`tests/hotReloadDefGateWiring.test.ts`（被拦批次未重启再次保存持续拦下，含只改注释变体；重启确认后放行）、`tests/hotReloadRetryDefGate.test.ts`（重复重试持续拦下；fire 拦下后重试同被拦）。固化旧滚动行为的两条测试按新语义重写。

### F2 修复（commit `a2dd261`）

- `src/hotReload.ts` `sendViaChannel`：发送代际在 `transport.send` 之前逐 (rootId,targetId,file) 以发送发起记录建立，此后全部回执/整组失败/accepted/applied 核验写回**绑定该代际**（旧实现 `recordOutcome` 裸写，每个异步回执都被台账当成新发送）——上审反例「旧发送晚到的 digest 核验把新发送的失败翻成 applied」被代际守卫拒绝（回归测试 `tests/hotReloadChannelApplied.test.ts` 实测 red→green）。
- 发送时点冻结 digest（sentDigest）经绑定代际写回进台账（applied/accepted 升格前先落），与旧动作路径 `src/hotReloadAppliedCheck.ts` 的冻结 digest 双证口径一致。

### F3 修复（commits `39c3dce`、`dbc9d7b`）

- `scripts/hot-reload-receiver/referenceReceiver.mjs`：apply 模式必须配 `--apply-command`（真实应用实现），逐文件执行、退出 0 才回 applied（带 digest+递增 revision），并把 revision/file/digest/命令/输出逐条落 `applied-revisions.jsonl`（应用后证据）；非 0 如实回 failed；**未配置应用命令时如实回 accepted（仅暂存，未应用）**——读取+复制不再自称 applied。暂存副本失败如实回 failed（旧实现静默忽略）。回执透传请求体 targetId。
- `src/hotReloadTransport.ts` 解析层透传 accepted.note 与 applied.revision，不再静默丢弃。
- 验收面跟进：`tests/hotReloadReceiverRoundtrip.test.ts` 新增无命令不自称 applied/真实命令成功才 applied 且落台账/命令失败如实 failed 三条回归；两条依赖接收端伪证面的真 wire 联调（`tests/hotReloadAppliedVerifyWiring.test.ts`）改为显式配真实应用命令再取证，断言不变。上审所列 `docs/review/2026-11-05-aud018-reconciliation.md:86-90` 与 `todo.md:485,621-622,692` 的关闭依据缺口：接收端侧已补真实应用实现与版本台账，但**真实引擎（KBEngine）侧的 applied 证据仍缺**，相关条目不应据此勾回，需以接真实引擎的联调为准。

### F4 修复（commit `aceee35`）

- `src/hotReloadTransport.ts`：`parseReloadHttpReceipts` 接受预期目标——回执显式 targetId 与目标不一致整条拒绝（该文件如实落 sent 并注解，不 claim applied）；`HttpReloadTransport.send` 把目标传入解析，并新增 `${targetId}` 占位（url/headers/body）透传目标；回执 targetId 回显到台账面。
- `src/hotReload.ts` 装配面二次核验（回执显式 targetId 与通道目标不符绝不升格）+ 通道审计行带 `目标=<id>`。

### 门禁数字（本机，2026-11-05）

- `cargo test --workspace --exclude kode-scheduler`：退出 0；87 个 test/doc-test 结果块，**525 passed、0 failed、0 ignored**（`/tmp/kode-fix-cargo-full.log`）。
- Vitest 全量共两轮（默认隔离，515 文件）：末轮 **6356 测试，6335 passed、1 failed、20 skipped**（85.6s）；唯一失败为 `tests/typeStorageColdBuildPhased.test.ts` 的 F13 切片预算（负载敏感，首轮全量亦曾孤立失败、与热更改动无关），隔离复跑三次取真 **6/6、6/6、6/6 全过**。首轮全量另见 5 个无关文件的高负载预算/时序失败（load avg ≈130–160），同样隔离复跑三次取真全过：`hoverDeadlineContext`(10/10)、`processTopologyPerf`(5/5)、`serverManagerProcesses`(21/21)、`globalDataIndex`(108/108)、`selfAttributeNoneDiagnosticsPerf`(2/2)。触及面文件（hotReload* 全系）全量与隔离均绿。
- compile（tsc -p ./）与 tsconfig.mocha.json 干净；`out/test/runTest.js` 冒烟 **12 passing**；`eslint src --ext ts` 干净。
- 说明：审核时 vitest 全量 0 运行系 node_modules 缺失；本轮 `pnpm install --offline --frozen-lockfile --ignore-scripts` 成功（store 锁已可用），数字为本机实测，非历史数字。

## 第二轮返工记录（2026-11-06，codex 复审残余 F1–F4 + 交叉修复，分支 `feat/kode-fix-f1f4`）

本轮处理 codex 二轮复审指出的残余问题：F1 异步时序绕过、F2 digest 落账不全与结算代际错位、F3 接收端假应用、F4 非字符串 targetId、以及部署通道重试通道错位（交叉修复，记 R1-F5）。每项均先写能复现所指问题的失败测试（red 已在本机逐项实测并留存日志，见下），再修码转绿。`todo.md` 未改。

### R1-F1：def 闸基线前滚绑定判定时内容快照（commit `491c50f`）

- 问题：`check` 读到内容 A 放行后，异步 `commit` **重读文件**——若文件已变为未判定内容 B，B 被写进基线；B 被拦/未被目标应用后再次发送 B 即因指纹相同放行（需重启被绕过）。fire 与重试路径同缺口。
- 修法：`createDefStructuralGate` 的 `check` 判定时逐文件留内容快照，`commit` **只落快照、绝不重读**；无快照（未判定过）不滚。`confirmLoaded`（用户明确重启确认）语义不变。
- 回归（`tests/hotReloadRetryDefGate.test.ts`）：闸级「放行→内容变更→commit」时序断言基线仍是判定过的 A、变更内容再次检查被拦；重试级「放行→内容变更→重试」断言第二次重试持续拦下不发送。**red：2 failed | 5 passed**（日志 `/tmp/r2-f1-red.log`，以修码前 gate 源码 + 修码后测试文件在独立 worktree 复现）→ green 7/7。

### R1-F2：通道冻结 digest 全分支落账 + 读取 await 到完成 + 结算绑定自身代际（commit `d9de2a4`）

- 问题：digest 只在 accepted/applied 分支落账，`sent`、`failed`、整组异常分支的台账没有该次所发 digest；旧回执排定超时结算取**当前记录**的 attempt（新发送接管后，旧发送的窗口基准被套到新记录上）；冻结基准读取只发起不等待，证明不了读到的是发送时的内容。
- 修法：`sendViaChannel` 冻结基准读取 **await 到完成之后**才发起 `transport.send`（冻结 digest=实际发送内容）；冻结完成即整批落账 sentDigest（绑定代际），回执各分支随后更新 outcome；`scheduleUnconfirmedSettle` 改用该发送自己的 attempt（`attemptFor`），无代际不排结算。原「旧发送晚到核验不翻新发送失败」回归按新发送次序重述（发送现在排在其冻结基准之后），断言语义不变。
- 回归（`tests/hotReloadChannelApplied.test.ts` 新增 5 条）：sent/failed/整组异常三分支 sentDigest 落账；冻结读取 await 时序（事件序 read-done 先于 send）；回执排定结算绑定自身代际（新发送窗口未到点不得被旧窗口注解超时）。**red：5 failed | 10 passed**（日志 `/tmp/r2-f2-red.log`）→ green；`tests/hotReload` 全系 393 passed。

### R1-F3：接收端应用后重算 sha256 才自称 applied + wire 测试真实写文件（commit `3cced86`）

- 问题：接收端仅凭应用命令退出码 0 自称 applied，未核实命令实际应用了发送方 digest 指向的内容；wire 测试应用命令是 `node -e "process.exit(0)"` 空操作假应用。
- 修法：`referenceReceiver.mjs` 在退出 0 之后对所发文件**重算 sha256**，与收到时算的 digest（发送方内容指纹）比对一致才回 applied；漂移或读不回如实回 failed（不落应用台账）。wire/roundtrip 测试的应用命令全部改为真实写文件进「引擎目录」（copy 到 engine dir），断言同步加引擎侧产物与所发内容逐字一致。
- 回归（`tests/hotReloadReceiverRoundtrip.test.ts` 新增）：退出 0 但改动了所发内容的命令 → 如实 failed 不自称 applied、不落版本台账。**red：1 failed | 9 passed**（日志 `/tmp/r2-f3-red.log`）→ green；roundtrip+wiring 两套件 23 passed。真实 KBEngine 侧 applied 证据缺口仍在（同上节说明，不据此勾回 todo 条目）。

### R1-F4：非字符串 targetId 拒绝 + 请求体自动附加 targetId（commit `8ec17f7`）

- 问题：回执显式 `targetId: null`/数字/对象被 `typeof` 归一成 undefined 按「未提供」处理，applied 可被接受；请求侧目标透传依赖模板作者记得写 `${targetId}` 占位符。
- 修法：`parseReloadHttpReceipts` 对「存在但非字符串」的 targetId 字段按畸形回执整条拒绝（字段缺失才是未提供）；`HttpReloadTransport.send` 对 JSON 对象请求体自动附加 `targetId` 字段（已有显式 targetId 不覆盖，非 JSON 对象不动）。
- 回归（`tests/hotReloadTransport.test.ts` 新增 3 条）：null/42/对象三种畸形 targetId 均拒绝；无占位符模板的请求体自动带目标；显式 targetId 不被覆盖。**red：2 failed | 37 passed**（日志 `/tmp/r2-f4-red.log`）→ green；`tests/hotReload` 393 passed。

### R1-F5（交叉修复）：部署通道失败重试接回同一发送通道（commit `3d2c180`）

- 问题：部署通道目标是 profile ID，失败重试只反查 quick action 动作（`resolveActionNameForTarget`）——通道失败后重试找不到动作（重试失效）或走错发送通道。
- 修法：通道发送核心从 `setupHotReload` 抽到 `src/hotReloadChannelSend.ts`（fire 与重试共用同一实现：代际建立/冻结 digest/applied 双证核验/代际绑定结算逐字同语义）；`resendHotReloadTarget` 新增 `resolveChannelTransport` 注入，重试目标=当前通道目标时经该通道重发（source=retry），否则回落动作反查路径行为不变；`extension.ts` 把同一解出口接给重试命令。`HOT_RELOAD_APPLIED_SETTLE_MS` 移至 `hotReloadAppliedCheck.ts`（hotReload.ts 原位 re-export，引用方不变）以避免运行时循环依赖。
- 回归（新增 `tests/hotReloadRetryChannel.test.ts`）：profile ID 目标经原通道重发（不走动作反查、台账 attempt=2/channel=http/source=retry）、目标不符回落动作路径、通道重发失败 ok=false+failed 绑定新代际。**red：2 failed | 1 passed**（日志 `/tmp/r2-f5-red.log`）→ green。

### 第二轮门禁数字（本机，2026-11-06）

- `npm test`（vitest run + clean + compile + tsc -p tsconfig.mocha.json + VS Code 集成 runTest.js）：**退出 0 一次通过**。Vitest 516 文件 **6350 passed、20 skipped、0 failed**（上轮末轮那 1 个负载敏感预算失败本轮未复现）；compile 与 mocha tsc 干净；VS Code 集成测试随链通过。日志 `/tmp/r2-npm-test-full.log`。预算型失败隔离复跑协议（3 次取真）本轮**未被触发**——全量首轮即 0 failed,无可隔离复跑项,如实记录。
- `cargo test --workspace --exclude kode-scheduler`：退出 0；**525 passed、0 failed、0 ignored**。日志 `/tmp/r2-cargo-full.log`。
- `eslint src --ext ts`：退出 0 干净（`/tmp/r2-eslint-full.log`）；`tsc -p tsconfig.json --noEmit` 干净。
- 逐项 red 日志：`/tmp/r2-f1-red.log`、`/tmp/r2-f2-red.log`、`/tmp/r2-f3-red.log`、`/tmp/r2-f4-red.log`、`/tmp/r2-f5-red.log`。

## 第三轮返工记录（2026-11-06，二轮复审残余两项精确缺陷，分支 `feat/kode-fix-f1f4`）

本轮处理二轮复审复核后的两项残余：F1 快照共享槽位（并发闸判定可覆写前一批的快照）与 F3 协议级缺陷（协议未把发送方冻结 digest 传给接收端，空操作命令仍能假 applied）。每项均先在修码前源码上实测失败测试（red 已留存日志，见下），再修码转绿。`todo.md` 未改。

### R2-F1：def 闸判定快照按批次/代际隔离（commit `f504e08`）

- 问题：二轮实现的 `checkedSnapshots` 是「文件 → 内容」共享槽位——两批并发 `check` 共享同一槽位，后判定批覆写先判定批的快照；先批 `commit` 时把**从未通过判定的后批内容**滚进基册（时序绕过：被拦内容借并发批的 commit 入基线，指纹相同即放行）。
- 修法：每次 `check` 各自持有整批快照记录（代际册，按判定顺序入册）；`commit` 按文件集逐字同序匹配**最早未消费**的判定批、只落自己那批的快照并消费之；匹配不到（该文件集从未判定过）不滚。并发判定互不覆写；被拦批（永不 commit）的快照借别批 commit 入册的通路被切断。记录带上限（64）防泄漏（被拦批只进不出，超限丢最老，判定面按旧基线保守重判不丢正确性）。
- 回归（新增 `tests/hotReloadDefGateBatchSnapshot.test.ts` 3 条）：两批并发判定互不覆写（先批 commit 后基册=自己批的快照、被拦内容不入册且持续被拦）；同文件先后两批放行按代际各归各（FIFO 消费）；commit 文件集与任何判定批都不匹配时不滚。**red：2 failed | 1 passed**（修码前 448ee6b 独立 worktree 实测，日志 `/tmp/r3-f1-red.log`）→ green 3/3；闸系三套件 21 passed。

### R2-F3：报文下发 sender_digest + 接收端对应用产物核验（commit `c1c1d76`）

- 问题：二轮接收端比较的是**源文件**执行应用命令前后的两次哈希，而协议未把发送方冻结 digest 传给接收端——空操作命令（不改源文件、退出 0）前后哈希恒等，仍能假 applied（二轮的「退出 0 后重算源文件哈希」比对在空操作面前恒真，是协议级假 applied 通路）。
- 修法：①协议报文增加 `sender_digests` 字段（发送时点冻结的 sha256 随报文下发）：`HttpReloadTransport.send` 对 JSON 对象请求体自动附带（显式已给不覆盖，非 JSON 对象不动），通道发送核心 `sendFilesViaReloadChannel` 把已落台账的冻结 digest 传入；协议定义同步进 `docs/design/hot-reload-design.md`（本仓库无 `docs/BRIDGE_PROTOCOL.md`，设计文档 §4 是协议定义面）与接收端脚本头注释、`roundtripProbe.mjs` wire 样本。②接收端新增 `--artifact-dir`（引擎产物目录，路径以 `KODE_RELOAD_ARTIFACT` 注入应用命令）；应用命令退出 0 后对**应用产物**（引擎目录中的实际文件）重算 sha256，与 `sender_digests[file]` 比对一致才回 applied；缺 `--artifact-dir`/报文缺 `sender_digest`/产物读不到/哈希不一致一律如实 failed（不落应用台账、不自称 applied）；旧「源文件前后哈希」比较废除。
- 回归（`tests/hotReloadReceiverRoundtrip.test.ts` 改造为双向断言 + 新增 4 条）：真实应用且 digest 一致 → applied（引擎产物逐字一致断言）；**空操作命令（退出 0、不写产物）→ failed 不落台账**；产物内容 ≠ sender_digest → failed；报文缺 sender_digest → failed；发送侧自动附带 sender_digests 断言；applied 升格/digest 不符不升格等既有面全部改走 `--artifact-dir` + 冻结 digest 下发的新协议。`tests/hotReloadAppliedVerifyWiring.test.ts` 真实接收端两例与拉起助手同步接新协议。**red：6 failed | 8 passed**（修码前 f504e08 独立 worktree 实测，日志 `/tmp/r3-f3-red.log`；含空操作假 applied、产物内容不符、缺 sender_digest、发送侧无字段、源锁缺口、二轮漂移断言改口径）→ green；roundtrip 14 passed、appliedVerify+responseReceipt 23 passed。

### 第三轮门禁数字（本机，2026-11-06）

- `npm test`（vitest run + clean + compile + tsc -p tsconfig.mocha.json + VS Code 集成 runTest.js）：**退出 0 一次通过**。Vitest 517 文件 **6357 passed、20 skipped、0 failed**；compile 与 mocha tsc 干净；VS Code 集成冒烟 **12 passing**。日志 `/tmp/r3-npm-test-full.log`。预算型失败隔离复跑协议（3 次取真）本轮**未被触发**——全量首轮即 0 failed，无可隔离复跑项，如实记录。
- `cargo test --workspace --exclude kode-scheduler`：退出 0；**525 passed、0 failed、0 ignored**。日志 `/tmp/r3-cargo-full.log`。
- `eslint src --ext ts`：退出 0 干净（`/tmp/r3-eslint-src.log`）；`tsc -p tsconfig.json --noEmit` 干净（`/tmp/r3-tsc.log`）。
- 逐项 red 日志：`/tmp/r3-f1-red.log`（2 failed | 1 passed）、`/tmp/r3-f3-red.log`（6 failed | 8 passed）。

## 第四轮返工记录（2026-11-06，三轮复审残余两项设计级根因，分支 `feat/kode-fix-f1f4`）

本轮处理三轮复审复核后的两项残余，均已收窄到设计根因：F1 的「按文件集匹配最早批」在**被拦批也入队**面前仍是错拿通路；F3 的「应用委托给外部命令」让接收端**无法证明产物是本次命令写的**。每项均先在修码前源码（52429b0）上实测失败测试（red 已留存日志，见下），再修码转绿、独立 commit。`todo.md` 未改。

### R2-F1：def 闸快照按批次令牌认领（commit `7b03306`）

- 问题：三轮实现按「文件集逐字同序匹配**最早未消费**批」消费快照，且**被拦批次也进快照队列**——批 A 被拦、同文件集批 B 放行时，B 的 commit 按文件集匹配到最早的 A 批，把从未通过判定的被拦内容滚进基册（指纹相同即放行，绕过需重启）。
- 设计变更：①被拦批次**不入快照认领队列**（只入被拦记录册：令牌+文件+理由，快照即弃）；②`check` 返回判定结果 `{reasons, token}`——每次判定签发批次令牌；③`commit(token)` **只按令牌认领自己那批**（同文件集的并发/先后批次各归各，被拦/未知/过期令牌一律不滚）；fire 路径（hotReload.ts gateDefChanges）与重试路径（hotReloadRetryCommand.ts resendHotReloadTarget）各自传自己 check 的令牌。
- 回归（重写 `tests/hotReloadDefGateBatchSnapshot.test.ts` 4 条 + 同步 `hotReloadRetryDefGate.test.ts` 令牌口径）：**A 被拦+B 放行（同文件集）→ B commit 后基线不含 A 的被拦内容且后续同结构变更仍被拦**；被拦批令牌 commit 不滚；未知/过期令牌不滚；同文件两批放行乱序按令牌各归各。**red：4 failed | 0 passed**（修码前 52429b0 实测，日志 `/tmp/r4-f1-red.log`）→ green；闸系三套件 22 passed、重试系 26 passed。

### R2-F3：applied 路径改接收端自写产物 + 外部命令降级 accepted（commit `c23dd01`）

- 问题：三轮后应用仍委托给外部命令（`--apply-command`），接收端无法证明引擎目录里的产物是**本次命令**写的——产物哈希核验只能证明「目录里有份内容一致的东西」，证明不了应用通路。
- 设计变更（参考接收端 `referenceReceiver.mjs`）：①applied 路径改为**接收端自己写产物**——按报文 files 读到内容后由接收端自身代码 `writeFileSync` 直接落盘引擎目录（`--artifact-dir`），写后对产物重算 sha256 与报文 `sender_digests[file]` 比对**一致才回 applied**；②落盘失败/哈希不符→**failed 且回滚已写产物**（unlink，引擎目录无残留；多文件批逐文件回滚，坏文件回滚不影响好文件 applied）；③**外部命令模式降级**：命令仍执行（真实副作用）但退出 0 也最多 accepted（带「副作用不可证实」注解），绝不自称 applied、不落应用台账；命令失败仍如实 failed。空操作场景从设计上不存在假 applied：接收端没写产物就没有产物哈希可核验。协议定义同步 `docs/design/hot-reload-design.md` §4 与 `roundtripProbe.mjs` 契约行。
- 回归（重写 `tests/hotReloadReceiverRoundtrip.test.ts` apply 面为双向断言 + 新增 5 条；`hotReloadAppliedVerifyWiring.test.ts` 真实接收端两例同步接自写产物模式）：接收端自己写的产物哈希=sender_digest→applied（引擎产物逐字一致+台账证据）；sender_digest 与产物不符→failed 且产物回滚；报文缺 sender_digest→failed 不写盘；产物路径被占（EISDIR）→failed；多文件批坏文件 failed+回滚、好文件照常 applied；外部命令真实写产物/空操作退出 0→均降级 accepted 绝不 applied 不落台账；外部命令失败→failed。**red：12 failed | 16 passed**（修码前 52429b0 实测，日志 `/tmp/r4-f3-red.log`）→ green；roundtrip 15 passed、appliedVerify+responseReceipt 23 passed。

### 第四轮门禁数字（本机，2026-11-06）

- `npm test`（vitest run + clean + compile + tsc -p tsconfig.mocha.json + VS Code 集成 runTest.js）：首轮 **1 failed**（`typeStorageColdBuildPhased` F13 预算型：maxSliceMs 213>150，全量负载下超时）——按预算型失败隔离复跑协议隔离复跑 **3 次：3/3 passed**（负载型抖动取真为通过）；全量复跑 **退出 0**：Vitest 517 文件 **6359 passed、20 skipped、0 failed**；compile 与 mocha tsc 干净；VS Code 集成冒烟 **12 passing**。日志 `/tmp/r4-npm-test-full.log`（首轮）、`/tmp/r4-npm-test-full2.log`（复跑）。
- `cargo test --workspace --exclude kode-scheduler`：退出 0；**525 passed、0 failed、0 ignored**。日志 `/tmp/r4-cargo-full.log`。
- `eslint src --ext ts`：退出 0 干净（`/tmp/r4-eslint-src.log`）；`tsc -p tsconfig.json --noEmit` 干净（`/tmp/r4-tsc.log`）。
- 逐项 red 日志：`/tmp/r4-f1-red.log`（4 failed | 0 passed）、`/tmp/r4-f3-red.log`（12 failed | 16 passed）。

## 第五轮返工记录（2026-11-06，R2-F3 四项硬化残余 + 文档对齐，分支 `feat/kode-fix-f1f4`）

本轮处理四轮复审对 R2-F3 的五项残余：写失败残留、谎报回滚、同名碰撞、误删已 applied 产物/旧内容丢失、文档对齐。均在修码前源码（e04d497）或上一 commit 上实测失败测试（red 日志见下），再修码转绿、逐项独立 commit。`todo.md` 未改。

说明：硬化项 1（写失败清理）与项 2（回滚如实）共享同一根因与同一条可构造 red 路径（EISDIR 残留 unlink 必失败是唯一可在测试内构造的「清理失败」场景），合并为一个 commit `0228be9`（R4-F3-1），其余逐项独立 commit。

### R4-F3-1：写失败残留 best-effort 清理 + 回执如实 rollback_failed（commit `0228be9`，硬化项 1+2）

- 问题：①`writeFileSync` 抛错直接回 failed，不清理已创建/截断的残留；②unlink 删除失败被吞、回执仍宣称「已回滚(引擎目录无残留)」。
- 修法（`referenceReceiver.mjs`）：`rollbackArtifact` 改为 best-effort 且返回残留路径（ENOENT 视为已清干净）；新增 `failedWithRollback` 统一构造 failed 回执——清理失败时 reason 按事实注明 `残留:<路径>` 并新增 **`rollback_failed` 字段=残留路径**，绝不谎称无残留；写失败分支（含部分写入/截断）也走同一 best-effort 清理，读回失败/哈希不符两分支同步接入。
- 回归（`tests/hotReloadReceiverRoundtrip.test.ts` 新增 1 条）：落盘失败（EISDIR）残留清不掉 → failed 回执含 `rollback_failed`=残留路径、reason 不含「无残留」、无 applied 台账。**red：1 failed | 15 passed**（修码前 e04d497 实测，日志 `/tmp/r5-f1-red.log`）→ green 16 passed。

### R4-F3-2：产物按报文相对路径映射子结构 + 批内碰撞拒绝整批（commit `aa61e05`，硬化项 3）

- 问题：产物路径只用 `basename`，不同目录同名文件写同一引擎目录位置相互踩踏（也是硬化项 4「误删已 applied 产物」的通路之一）。
- 修法：产物路径改为按报文内相对路径映射到 `--artifact-dir` 子结构（批内共同祖先为基准）；路径安全清洗（任何 `..`/`.`/空段=逃逸→拒绝整批不写盘）；清洗后仍映射同址（如同一路径在批内重复）→**同名碰撞拒绝整批**：全批 failed、不写任何产物、不落台账。
- 回归（新增 2 条）：不同目录同名文件（subA/subB 的 Monster.py）→ 各归各子路径、双双 applied、内容逐字一致；批内同址 → 全批 failed 含「拒绝整批」、引擎目录无产物无台账。**red：2 failed | 16 passed**（修码前 0228be9 实测，日志 `/tmp/r5-f3-red.log`）→ green（roundtrip+appliedVerify 31 passed）。

### R4-F3-3：失败回滚还原原内容而非删除、只及本次失败文件（commit `2d26fc8`，硬化项 4）

- 问题：回滚一律 unlink——预存在的旧产物（上一批已 applied 的版本）被本次失败连带删掉，旧内容丢失。
- 修法：写前读原产物内容（per-file 状态）；任何失败路径回滚**优先还原原内容**（`writeFileSync` 恢复），本次新建（原本不存在）的才删除；回滚只处理本次失败那一个文件，不影响批内已 applied 的兄弟文件。
- 回归（新增 2 条）：预存在产物+哈希不符 → 回执 failed 且产物**还原为原内容**（非删除）；多文件批坏文件失败 → 坏文件产物还原其原内容、好文件照常 applied 且台账只记好文件。**red：2 failed | 18 passed**（修码前 aa61e05 实测，日志 `/tmp/r5-f4-red.log`）→ green 33 passed。

### R4-F3-4：文档对齐（commit `4ff0bfd`，硬化项 5）

- `docs/design/hot-reload-design.md` §4.3：四轮的「回滚已写产物（引擎目录无残留）」无条件承诺改为与实现一致的五轮契约——回滚 best-effort、还原原内容优先、只及本次失败文件、产物相对路径子结构映射（清洗防逃逸、同址拒绝整批）、清理失败如实 `rollback_failed` **不承诺无残留**；接收端脚本头部契约注记同步。

### 第五轮门禁数字（本机，2026-11-06）

- `npm test`：**退出 0 一次通过**：Vitest 517 文件 **6364 passed、20 skipped、0 failed**；compile 与 mocha tsc 干净；VS Code 集成冒烟 **12 passing**。日志 `/tmp/r5-npm-test-full.log`。
- `cargo test --workspace --exclude kode-scheduler`：退出 0；**525 passed、0 failed、0 ignored**。日志 `/tmp/r5-cargo-full.log`。
- `eslint src --ext ts`：退出 0 干净（`/tmp/r5-eslint-src.log`）；`tsc -p tsconfig.json --noEmit` 干净（`/tmp/r5-tsc.log`）。
- 逐项 red 日志：`/tmp/r5-f1-red.log`（1 failed | 15 passed）、`/tmp/r5-f3-red.log`（2 failed | 16 passed）、`/tmp/r5-f4-red.log`（2 failed | 18 passed）。

## 第六轮返工记录（2026-11-06，R2-F3 六轮复审四 FAIL：确定性映射/逃逸防护/读语义/文档测试闭合，分支 `feat/kode-fix-f1f4`）

本轮处理五轮复审对 R2-F3 的四项 FAIL：跨批路径不稳定、符号链接逃逸、读失败误判为不存在（含 UTF-8 转码丢字节）、文档+测试闭合。均在上一 commit 实测失败测试（red 日志见下）后修码转绿、逐项独立 commit。`todo.md` 未改。

### R5-F1：产物路径确定性映射，跨批稳定（commit `c5ff743`）

- 问题：产物映射以「当前批次共同祖先」为基准——共同祖先随批次组成漂移：`subA/X.py`+`subB/X.py` 同批→各归子目录；分两次单文件发送→都映射到引擎目录根 `X.py`，后者覆盖前者，同一文件落位随批次组成变化。
- 修法（`referenceReceiver.mjs`）：**永远按报文内完整相对路径展开**，基准只随接收端暂存根（`--root`）定，与批次组成无关；暂存根之外的文件回落按绝对路径全结构展开（同样确定性）。安全清洗与批内同址拒绝整批保持不变。
- 回归（新增 1 条）：跨批两次单文件发送 subA/X.py、subB/X.py → 各落 `subA/X.py`、`subB/X.py` 不覆盖、不裸落根。**red：1 failed | 20 passed**（日志 `/tmp/r6-f1-red.log`）→ green 21 passed。
- 连带（commit `511d63f`，R5-F1a）：`hotReloadAppliedVerifyWiring` 所发真实文件在暂存根之外，产物落位随映射变为绝对路径全结构，断言同步改 mapped path（首轮全量 npm test 抓到，其余 11 个失败为满载抖动）。

### R5-F2：符号链接逃逸防护（commit `14b73be`）

- 问题：字符串清洗防不住产物目录内的 symlink 指向目录外——沿它写入/unlink 都作用在引擎目录外的真实目标上。
- 修法：写/unlink 前对目标 realpath 解析（目标不存在时逐级取最深已存在祖先），验证仍在 `--artifact-dir`（realpath）内，否则拒绝（failed 回执，不写不删）；回滚路径同过此检查，过不了按 `rollback_failed` 如实上报残留。
- 回归（新增 1 条）：引擎目录内 `subLink→目录外` → failed 含「逃逸」、目录外无产物、无台账。**red：1 failed**（修码前 R5-F1 之后实测，日志 `/tmp/r6-f2-red.log`）→ green 22 passed。

### R5-F3：写前读旧产物 ENOENT-only + Buffer 逐字节还原（commit `351f845`）

- 问题：①写前读旧产物把一切异常当 ENOENT→EACCES/EIO 时误判「不存在」，失败回滚 unlink **误删预存在产物**；②旧内容以 UTF-8 字符串保存，非 UTF-8 文件回滚后被转码破坏。
- 修法：仅 ENOENT 视为不存在，其他读异常如实 failed（`读旧产物失败(<code>)`）拒绝写入且不删除；旧内容以 **Buffer** 保存恢复（逐字节还原），写后核验哈希按原始字节算。
- 回归（新增 2 条 + 改造 2 条）：读旧产物 EACCES→拒绝且产物仍在（red：旧实现误删）；非 UTF-8 旧产物回滚逐字节一致（red：旧实现转码变字节）；目录占位路径改判「读旧产物失败(EISDIR)」拒绝写入不动产物；五轮 rollback_failed 回归由 EISDIR 残留改为只读旧产物（0444：写入 EACCES、回滚还原也 EACCES）构造，语义不变。**red：3 failed | 1 passed**（日志 `/tmp/r6-f3-red.log`）→ green 24 passed。

### R5-F4：文档 §4.3 + 测试闭合（commit `01202b1`）

- `docs/design/hot-reload-design.md` §4.3 按新实现改写：确定性映射（跨批稳定）、符号链接逃逸防护、ENOENT-only 读语义 + Buffer 还原、部分写入残留 best-effort 清理；接收端脚本头部契约注记同步。
- 测试闭合（复审 FAIL-4 四类真实用例全落地）：①部分写入后抛错→残留被清理（RLIMIT_FSIZE 构造真实「写一半再抛错」：接收端 `ulimit -f 2` 下运行，900B 源文件可暂存、其 1100B 转码产物中途 EFBIG 留 1024B 残留，回滚清干净且如实「无残留」）；②跨批映射不覆盖（R5-F1）；③读旧产物 EACCES→拒绝不删（R5-F3）；④产物目录内 symlink 指向外部→拒绝写入（R5-F2）。

### 第六轮门禁数字（本机，2026-11-06）

- `npm test`：首轮 **12 failed**（`hotReloadAppliedVerifyWiring` 1 个为 R5-F1 映射变更的真实断言偏移，R5-F1a 修正；其余 11 个为满载时序/预算抖动）——全量复跑**退出 0 一次通过**：Vitest 517 文件 **6369 passed、20 skipped、0 failed**；compile 与 mocha tsc 干净；VS Code 集成冒烟 **12 passing**。日志 `/tmp/r6-npm-test-full.log`（首轮）、`/tmp/r6-npm-test-full2.log`（复跑）。
- `cargo test --workspace --exclude kode-scheduler`：退出 0；**525 passed、0 failed**。日志 `/tmp/r6-cargo-full.log`。
- `eslint src --ext ts`：退出 0 干净（`/tmp/r6-eslint-src.log`）；`tsc -p tsconfig.json --noEmit` 干净（`/tmp/r6-tsc.log`）。
- 逐项 red 日志：`/tmp/r6-f1-red.log`（1 failed | 20 passed）、`/tmp/r6-f2-red.log`（1 failed）、`/tmp/r6-f3-red.log`（3 failed | 1 passed）。

## 第七轮返工记录（2026-11-07，七轮复审两项精确漏洞 + 文档测试闭合，分支 `feat/kode-fix-f1f4`）

本轮处理七轮复审对 R2-F3 的两项精确漏洞（根内外命名空间碰撞、悬空 symlink 穿透+检查-写入竞态）与文档/测试闭合。均先在修码前源码实测失败测试（red 日志见下），再修码转绿、逐项独立 commit。`todo.md` 未改。

### R6-F1：根内外命名空间碰撞消除——根外路径拒绝整批（commit `3ed1cf3`）

- 问题：六轮产物映射对暂存根之外的文件回落「绝对路径全结构展开」，该回落与根内相对路径共享同一命名空间——`--root=/stage` 时 `/stage/tmp/X.py`（根内）映射 `tmp/X.py`，`/tmp/X.py`（根外）回落也展开成 `tmp/X.py`，分批发送互覆盖。
- 修法（`referenceReceiver.mjs`）：**根外路径直接拒绝整批**（failed 回执 `产物路径在暂存根之外(--root)…拒绝整批,不写盘`，不写盘不落台账）——不允许暂存根之外的绝对路径作为产物目标，产物命名空间只剩根内相对路径一种归属，碰撞从映射规则上不存在。发送侧同步收紧：`roundtripProbe.mjs` 把所发文件写进接收端暂存根内并发送前校验（越界抛错拒绝发送）；`tests/helpers/referenceReceiver.ts` 暴露 `root`，两个 wiring 测试的真实文件移入暂存根（原在根外、依赖已废除的绝对路径回落落位）。
- 回归（`tests/hotReloadReceiverRoundtrip.test.ts` 新增 1 条）：根内 `tmp/X.py` 与根外 `/tmp/X.py` 分两批发送 → 第一批 applied，第二批 failed 含「暂存根之外」、第一批产物不被覆盖、台账只有根内记录。**red：3 failed | 25 passed**（修码前 c8fea6f 实测，含同批加入的七轮 symlink 两条，日志 `/tmp/r7-red-both.log`）→ green。

### R6-F2：悬空 symlink 拒绝 + temp+rename 原子写消 TOCTOU（commit `ab0bc29`）

- 问题：①最终组件是指向目录外**不存在文件**的悬空 symlink 时，realpath 抛 ENOENT 回落到最深已存在祖先（引擎目录本身）→ 六轮防护误判安全 → `writeFileSync` 沿悬空链接把产物写到引擎目录外；②realpath 检查与写入之间存在检查-写入（TOCTOU）窗口，竞态把产物位换成 symlink 后写入照样沿新链接逃逸。
- 修法（`referenceReceiver.mjs`）组合拳：①写前 **lstat 最终组件**——是 symlink（无论悬空与否）一律拒绝（lstat 不跟随链接，悬空也拿到 symlink 状态，六轮「最深已存在祖先」回落穿不过）；②产物改 **temp+rename 原子写**——先在引擎目录内 `'wx'` 独占创建自建临时文件（进程级唯一名字绝不碰撞，O_EXCL 绝不沿既有任何路径含 symlink 写入），内容与 digest 核验全在临时文件上完成，最后 `fs.rename` 原子替换到产物位（rename 不跟随目标 symlink，TOCTOU 从写入机制上消除；rename 目标目录组件用 realpath 后的真实父目录构建，无 symlink 中间层），临时文件写前同样 lstat/realpath 校验；③失败收尾只清理自建临时文件（best-effort unlink，失败如实 `rollback_failed`=残留临时文件路径）——引擎目录既有产物从头到尾不被触碰，五/六轮「还原原内容」回滚通路退役（原产物天然原样保留）。写前读旧产物的 ENOENT-only 语义保留（非 ENOENT 读异常仍拒绝写入不触碰）。
- 回归（新增 2 条 + 重造 1 条 + 改名 2 条）：悬空 symlink 指向目录外 → failed 含「符号链接」、目录外无落盘、链接原样；产物位 symlink 指向目录内也一律拒绝；落盘失败构造由「0444 只读旧产物」改为「引擎目录只读 0o555」（temp+rename 的原子替换不读目标文件权限，0444 场景如实 applied——改用目录级只读构造真实落盘失败，既有产物原样、无临时残留）；两条「还原原内容」回归改述为「原样保留不删不改写」（同一可观测契约，机制更强）。源锁测试补钉 `renameSync`/`lstatSync`/`'wx'`。**red：2 failed | 26 passed**（R6-F1 之后、R6-F2 修码前实测，日志 `/tmp/r7-f1-after.log`）→ green（roundtrip+两 wiring 51 passed）。

### R6-F3：文档 §4.3 + 测试闭合（commit `b9afab2`）

- `docs/design/hot-reload-design.md` §4.3 按新实现改写：产物命名空间只认暂存根内路径（根外拒绝整批+发送侧校验）、lstat 拒链接的符号链接逃逸防护、temp+rename 原子写消 TOCTOU、失败收尾只清临时文件（原产物不触碰，「还原原内容」退役）；五/六轮被替代的承诺（绝对路径回落命名空间、还原式回滚）从契约中移除。接收端脚本头部契约注记同步（随 R6-F2 落盘）。
- 测试闭合（复审要求两类用例全落地）：①根内外碰撞（R6-F1：分批发送根内 `tmp/X.py` 与根外 `/tmp/X.py` → 后者拒绝整批、前者产物不被覆盖）；②悬空链接（R6-F2：悬空 symlink → 拒绝写入不逃逸；父目录 symlink 指向目录外 → 拒绝，沿用六轮回归）。
- 连带：`roundtripProbe.mjs` 重跑落盘 AUD-007 wire 样本（所发文件现写入接收端暂存根内，发送侧校验在册）。

### 第七轮门禁数字（本机，2026-11-07）

- `cargo test --workspace --exclude kode-scheduler`：**退出 0**；87 个结果块 **525 passed、0 failed**。日志 `/tmp/r7-cargo-full.log`。
- `npm test`：vitest 全量三轮（本机负载均值 177–193，同机另有 apollo C++ 构建/gradle/dotnet/go 测试并行）：**6367 passed、20 skipped**，每轮 5–6 failed 且**每轮失败的用例集互不相同**、全部是预算/截止时间/真实子进程类测试（`typeStorageColdBuildPhased`、`processTopologyPerf`、`hoverDeadlineContext`、`receiverNoneAsyncSharedParse`、`globalDataIndex`、`pythonTestRunner`、`debugConfigAttach`），**零热更换路失败**；失败文件离线单跑**全部通过（113 tests）**，判定为满载抖动（六轮首轮 11 个同类抖动同因）。日志 `/tmp/r7-npm-test-full.log`、`/tmp/r7-npm-test-full2.log`、`/tmp/r7-npm-test-full3.log`。链上其余段直跑验证：compile 退出 0（`/tmp/r7-compile.log`）、`tsc -p tsconfig.mocha.json` 干净、VS Code 集成冒烟 **12 passing**（首轮 1 个激活 hook 2s 超时为同因抖动，复跑干净；`/tmp/r7-electron2.log`）。
- `eslint src --ext ts`：退出 0 干净；`tsc -p tsconfig.json --noEmit` 干净。
- 逐项 red 日志：`/tmp/r7-red-both.log`（3 failed | 25 passed）、`/tmp/r7-f1-after.log`（2 failed | 26 passed）。

## 第八轮返工记录（2026-11-06，八轮复审三项：rename 父目录竞态 / 清理标志位 / 暂存唯一子目录，分支 `feat/kode-fix-f1f4`）

本轮处理八轮复审对参考接收端的三项缺陷：rename 前父目录缺少包含性与组件同一性双重验证（目录换入竞态可逃逸）、失败清理不以确认自建为门（可能删非本进程创建的文件）、暂存按 basename 平铺互相覆盖（同批可污染源文件）。均先在修码前源码实测失败测试（red 日志见下），修码转绿后逐项独立 commit。`todo.md` 未改。

### R7-F1：rename 父目录双重验证 + 清理以确认自建为门（commit `87fcbed`）

- 问题①：rename 直接用产物父目录 realpath 构建目标，未验证包含性与组件同一性——与目录换入竞态时（父目录被换成指向外部的 symlink）realpath 照样通过，产物被 rename 到引擎目录外。
- 修法①（`referenceReceiver.mjs`）：新增 `verifiedRealParentForRename()`——rename 前立即 realpath 父目录，要求**包含性**（解析路径在 `--artifact-dir` realpath 内）与**组件同一性**（解析路径与原路径逐字相同，链上无 symlink 组件）同时成立，rename 目标改用验证后的真实父目录；JS 无 `O_NOFOLLOW`，realpath→rename 的残余竞态窗口在 design §4.3 如实记载而非假装消除。
- 问题②：失败清理无条件 unlink 临时文件——`'wx'` 独占创建本身失败（如 EEXIST）时也会删除**不是本进程创建**的文件。
- 修法②：创建是独立成功点——`openSync 'wx'` 成功才置 created 标志，其后才允许最终 unlink；创建失败不碰任何文件、不报 `rollback_failed`；部分写入（EFBIG）残留照清（fd 创建成功在先）。
- 内部辅助经 ES module 导出供单测钉住（main guard 保持直接执行行为不变）。
- 回归（`tests/hotReloadReceiverHelpers.test.ts` 新增 + `tests/hotReloadReceiverRoundtrip.test.ts` 新增）：rename 父目录 symlink 组件拒绝、创建失败不清理他文件、部分写入残留清理。**red：9 failed | 28 passed**（修码前两文件实测，`/tmp/r8-red.log`；roundtrip 单文件 **2 failed | 28 passed**，`/tmp/r8-red-roundtrip.log`）→ 修后仅剩八轮暂存回归 **1 failed | 36 passed**（`/tmp/r8-f1-green.log`）。

### R7-F2：暂存逐文件唯一子目录（commit `3428c8c`）

- 问题：暂存把每个收到的文件按 `basename` 平铺到暂存根顶层——同批 `<root>/sub/X.py` 与 `<root>/X.py` 时，前者的暂存副本覆盖后者的**源文件**（读回污染、digest 不符、源文件被暂存动作改写）。
- 修法：暂存按报文相对路径展开到 `<root>/.staged/<relative path>`（与产物映射同一套逃逸清洗与批内碰撞规则），同批暂存副本互不碰撞，不碰任何源文件与 applied 台账。
- 回归（roundtrip 新增八轮回归）：同批 sub/X.py + X.py → 双 applied、源文件逐字原样、暂存互不覆盖。**red：R7-F1 提交上 1 failed | 36 passed**（`/tmp/r8-f1-green.log`）→ **green 37 passed**（`/tmp/r8-f2-green.log`、`/tmp/r8-f2-green2.log`）；源锁测试同步钉新创建/清理/暂存机制。

### R7-F3：design §4.3 与接收端头部契约收口（commit `44bbcc3`）

- `docs/design/hot-reload-design.md` §4.3 落八轮契约：rename 父目录双重验证（包含性+组件同一性）与残余 realpath→rename 窗口如实注记；临时文件验证顺序锚定 `'wx'` 创建成功点、清理以确认自建为门；暂存逐文件唯一 `.staged` 子目录（与产物映射同规则）。同时移除五轮「回滚 best-effort / 还原原内容」与六轮「根外绝对路径回落」两条已废除承诺，七轮清理措辞对齐创建点标志位。
- 接收端脚本头部契约注记同步（五轮回滚通路、六轮根外回落标为 history）；`roundtripProbe` 线样本按新基线重跑（`docs/perf/2026-11-05-aud007-receiver-roundtrip.txt`）。

### Windows 真机 rename 覆盖证据（openclaw，随本轮入库 `docs/perf/2026-11-08-win-rename-overwrite-roundtrip.txt`）

- openclaw（Windows Server 2022，node v24.22.1）参考接收端真实回环：fresh apply → applied revision1；**overwrite apply → applied revision2，产物字节逐字替换（`HP = 100`→`HP = 200`，digest 随内容变化）——rename 覆盖既有目标在 Windows 成立**；幂等重放 revision3 同 digest；暂存独立子目录 `true`；父目录 symlink 组件 → failed 回执（reason 含「rename 目标父目录含符号链接组件…不自称 applied」），泄漏检查 `other/X.py exists = false`、链接原样。
- **VERDICT: PASS (rename replaces existing target on this platform; contract holds)；FINAL_VERDICT=PASS**。

### 第八轮门禁数字（2026-11-06）

- 本机（14C，负载 100–291）：
  - `cargo test --workspace --exclude kode-scheduler`：**退出 0**；87 结果块 **525 passed、0 failed、0 ignored**（`/tmp/r8-cargo-full.log`）。
  - `eslint src --ext ts`：**退出 0** 干净（`/tmp/r8-eslint2.log`）；`tsc -p tsconfig.json --noEmit`：**退出 0** 干净（`/tmp/r8-tsc2.log`）。
  - vitest 全量：第 1 轮 **2 failed | 6379 passed | 20 skipped（6401）**——两失败均为预算/真跑型（`globalDataIndex` 切片扫描预算 2891ms、`pythonTestRunner` 真 pytest 5042ms，满载抖动）；**第 2 轮全绿：退出 0，514 文件 passed | 4 skipped，6381 passed | 20 skipped（6401）**（`/tmp/r8-local-vitest.log`、`/tmp/r8-local-vitest2.log`）。失败文件隔离复跑：`globalDataIndex` **3/3 过**、`serverGroupLaunch` **3/3 过**；`pythonTestRunner` 在本机极端负载（load 291）下 1/3 过、idle 机器 3/3 过（见 imac 行），判定负载依赖。
- imac（192.168.5.117）：
  - 原生 Windows 口径全量：**69 failed | 6291 passed | 34 skipped（6394），38 文件失败**——全部为平台性差异（路径分隔符 `scripts\` vs `scripts/`、Windows 大小写折叠、`getuid` 等），非本仓门禁口径，弃用（`/tmp/r8-imac-vitest.log`）。
  - **WSL2 Ubuntu（20C/62G，Linux 口径=门禁口径）**：node v24.21.0 + pnpm 12.10.1 + pytest 9.2.0，`pnpm install --frozen-lockfile`。全量复跑：pytest 补齐后 8 轮中前 7 轮每轮 **2–5 failed**、失败集逐轮变化且全为时机型——根因是 **WSL2 墙钟跳变**：0.1s 采样实测 `CLOCK_REALTIME` 每 ~5s 跳 ±33s（max_fwd **+33.084s** / max_bwd **−33.084s**；Windows 宿主同期 max_delta 0.48s 稳定），`until()` 的 `Date.now` 截止被假超时（失败用例报出时长远小于自身 5s deadline，如 1170ms/256ms）；root 下 mask `systemd-timesyncd` 后 60s 采样 **0 次跳变**，**mask 前循环第 8 轮 + mask 后连续 4 轮（x1–x4）共 5 轮全绿：退出 0，513 文件 passed | 5 skipped，6373 passed | 28 skipped（6401），0 failed**（`/tmp/r8-wsl-loop.log`、`/tmp/r8-wsl-xrounds.log`）。
  - 失败文件隔离复跑 ×3（取真）：mask 后 `serverGroupLaunch`、`serverReadiness`、`logHub`、`serverManagerRunner`、`pythonTestRunner`、`serverManagerProcesses`、`autoDebugpy` 全部 **3/3 通过**；`covExtensionCommands`（原失败为环境缺 pytest，补装后）**3/3 通过**。与本机全绿轮共同证明残余失败为环境时钟/依赖问题而非代码问题。

## 第九轮返工记录（2026-11-06，九轮复审三项：暂存命名空间隔离 / 暂存路径写前验证 / 收尾清理 dev/ino 比对，分支 `feat/kode-fix-f1f4`）

本轮处理九轮复审对参考接收端的三项缺陷：①源命名空间与暂存命名空间相交——八轮把暂存副本展开到 `<root>/.staged/<相对路径>`，但源路径清洗不排除 `.staged` 第一段，同批含既有 `<root>/.staged/X.py` 源文件时 `<root>/X.py` 的暂存副本 `copyFileSync` 直接覆盖该**源文件**，且词法排除挡不住指向暂存树的 symlink 别名与悬空别名（批内更早文件的暂存动作可把悬空别名目标「补齐」，读取阶段经别名复活）；②暂存路径写入无 symlink 检查——`.staged`（或更深目录）被换成指向暂存根外的 symlink 时 `copyFileSync` 沿链接逃逸；③失败清理只以八轮「确认自建」标志位为门——创建后、收尾前路径被竞态替换成别的文件时，按路径 unlink 仍会删掉**不是本次创建**的文件。修码 `9a5c7ee`（仅动4文件：design §4.3 + 接收端脚本 + 两个测试，逐项核对无夹带）。收尾核对三窄点实现完整、测试与契约齐全，**无需补码**；红先行实测与全量门禁见下。`todo.md` 未改。

### R9-F1：暂存命名空间与源树隔离 + 暂存写前双重验证（commit `9a5c7ee`）

- 修法①（源路径预检）：源路径第一段为 `.staged` → 属接收端暂存命名空间，**拒绝整批**（与路径清洗同一防线，源/暂存命名空间从映射规则上不相交）；**别名补口**：对每个源文件 realpath 解析，解析结果落在暂存树 realpath 内 → 拒绝整批；realpath 失败且（文件自身是悬空 symlink **或**祖先链含 symlink 组件，`hasSymlinkAncestor` 至暂存根为止、基准自身合法 symlink 不算）→ 无法证明不在暂存树内，同样拒绝整批；祖先全为真实目录 = 真缺失，保持逐文件「读不到所发文件」失败语义。
- 修法②（暂存写前 `safeStagingTarget`）：对暂存父目录链取**最深已存在祖先**做双重验证——包含性（realpath 在暂存根 real 内）+ 一致性（**相对比较**：解析路径与原路径相对暂存根的相对路径逐字一致，树内 symlink 组件即不等被拒，暂存根自身合法 symlink 祖先如 macOS `/tmp` 不误判）+ realpath 失败但组件存在（悬空 symlink 链）直接拒绝 + `lstat` 最终组件拒 symlink；任一不过拒绝本文件暂存。检查→mkdir→copy 一瞬残余窗口与 realpath→rename 同级，design §4.3 如实记为已知限制，不自称「已消除」。
- 回归（`tests/hotReloadReceiverRoundtrip.test.ts` 新增 6 条 + 源码锁补钉）：同批含 `.staged` 源文件→拒绝整批源文件逐字原样；`.staged` 为外部 symlink→拒绝暂存副本不逃逸；源路径 symlink 别名指向暂存树→拒绝整批；悬空别名被批内暂存补齐→预检拒绝整批不产生经别名的 applied；源文件自身悬空 symlink→拒绝整批；暂存根经合法 symlink 祖先到达→不误拒且真缺失文件保持逐文件失败语义（FAIL-4 兼容）。**red：5 failed**（roundtrip 侧；`r9-red-first-50aef64.log`）→ green。

### R9-F2：收尾清理 dev/ino 比对（commit `9a5c7ee`）

- 问题：八轮标志位只回答「这个路径上的文件是不是我创建的」，防不住「创建后、收尾前路径被竞态替换」——替换文件与创建判定无关联，按路径 unlink 仍会删掉非本次创建的文件。
- 修法（`referenceReceiver.mjs`）：`openSync 'wx'` 创建成功点 `fstatSync(fd)` 捕获 dev/ino；收尾 `cleanupTempArtifact` unlink 前 `lstat` 比对路径当前 dev/ino，一致才删；不符或捕获缺失（fstatSync 失败，身份无法确认）→ 跳过，回执 `rollback_skipped` 如实上报不触碰；ENOENT（已不存在）= 清理目标已达成；fd 任何路径下都关闭不泄漏。`lstat` 比对→unlink 一瞬残余窗口如实记为已知限制，不自称「绝不删错」。
- 回归（`tests/hotReloadReceiverHelpers.test.ts` 新增 3 条，既有用例同步传 createdStat）：dev/ino 不符（rename 保 inode 的替换文件）→ 跳过报 `rollback_skipped` 且替换文件原样；dev/ino 一致 → 照常清理；捕获缺失 → 跳过不盲删。**red：2 failed**（helpers 侧；`r9-red-first-50aef64.log`）→ green。

### R9-F3：design §4.3 九轮契约 + 证据绑定（commit `9a5c7ee` + 收尾入库）

- `docs/design/hot-reload-design.md` §4.3 落九轮三条契约（源/暂存命名空间不相交、暂存写前双重验证、收尾 dev/ino 比对）与两处残余窗口如实注记；接收端脚本头部契约注记同步（九轮条目①—⑤）。
- **证据绑定（收尾补齐）**：Windows 真机回环证据 `docs/perf/2026-11-06-win-roundtrip-r9.txt` **随录被测 commit `9a5c7ee`**（openclaw，Windows Server 2022，node v24.22.1；八场景：1-5 复现八轮 rename 覆盖 + 6 `.staged` 源拒绝 + 7 悬空别名拒绝 + 8 `.staged` symlink 拒绝；**FINAL_VERDICT=PASS，PROBE_EXIT=0**）。原八轮证据未随录 commit hash 的缺口以补注如实指向九轮记录（`docs/perf/2026-11-08-win-rename-overwrite-roundtrip.txt` 补注）。同探针 Linux 本机对拍八场景同样全 PASS（`r9-winprobe-local-linux.log`）。收尾门禁日志全部带 HEAD hash 入 `docs/review/evidence/`。

### 红先行（收尾补测，修码前源 `50aef64` receiver + 九轮新测试）

- **red：8 failed | 38 passed**（`docs/review/evidence/r9-red-first-50aef64.log`，两测试文件整跑）——8 项=helpers 2（dev/ino 不符跳过、捕获缺失跳过）+ roundtrip 5（`.staged` 命名空间、`.staged` 外部 symlink、symlink 别名、悬空别名批内补齐、文件自身悬空）+ 证据源锁 1（`safeStagingTarget`/`rollback_skipped`/`fstatSync` 未入源）；修后两文件 **46 passed**、全量绿。九轮新测试在旧实现上必红，能区分旧行为。

### 第九轮门禁数字（2026-11-06，HEAD `735aa4a`，本机负载 19–24）

- `cargo test --workspace`：**退出 0**，94 结果块 **558 passed、0 failed、0 ignored**（`r9-full-cargo.log`）。
- `cargo fmt --check`：**退出 0**；`cargo clippy --workspace --all-targets -- -D warnings`：**退出 0**（`r9-full-fmt-clippy.log`）。**红→绿**：初跑 fmt=1 / clippy=101——全为分支落后 main 的既有面（41 文件未格式化 + 20 处 lint，R9 未动 Rust），修复**逐字对齐 main 上已有修法**后独立入库 `735aa4a`（红日志 `r9-full-fmt-clippy-red-at-9a5c7ee.log`）；修复本身亦过全量 cargo 测试（上）。**范围注记（十一轮如实更正）**：十轮复审指出 `735aa4a` **并非纯格式面**——含恒真断言改实断言与 clippy 表达式替换，详见下「第十一轮返工记录」R11-F3，故不声称该提交「仅格式变化」。
- `eslint src --ext ts`：**退出 0** 干净（`r9-full-eslint.log`）；`pnpm clean && pnpm compile && tsc -p tsconfig.mocha.json`：**退出 0** 干净（`r9-full-tsc.log`）。
- vitest 全量第 1 轮：**退出 0，514 文件 passed | 4 skipped，6390 passed | 20 skipped（6410），0 failed**（`r9-full-vitest-1.log`）。**预算型失败隔离复跑协议未被触发**——首轮 0 failed 无可隔离复跑项，如实记录。
- **环境根因处置（上席三轮全量 3–5 failed 的定性）**：`covExtensionCommands` 隔离 3/3 仍挂，根因是本机 PATH 首个 `python3` 为 agent venv（无 pytest 模块），测试 `locateInterpreterOnPath` 取 PATH 首个解释器 → 真跑 pytest 段 0 条目——**环境非回归**（九轮 diff 未触及该面）。处置：门禁 PATH 注入 shim（`python3 → /usr/bin/python3`，pytest 9.1.1），该文件隔离验证 **80/80 过**、随全量绿。上席原始日志（`r9-cargo-full.log`、`r9-vitest-full-1/2/3.log`、`r9-vitest-isolated-x3.log`）一并入库备查。
- VS Code 集成冒烟 `node ./out/test/runTest.js`：**12 passing**，退出 0（`r9-full-electron.log`）。

## 第十一轮返工记录（2026-11-06，十轮复审唯一遗留：证据绑定 FAIL，分支 `feat/kode-fix-f1f4`）

十轮复审（`docs/review/2026-11-06-f1f4-round10-review.md`，提交 `b5f18bf` 入库）三面判定：`.staged` 隔离 **PASS**、inode 比对清理 **PASS**、**证据绑定 FAIL**——六份九轮门禁日志头部 HEAD 均为 `735aa4a` 而非终态 `46e1bb3`；Windows 回环记录只有手写 commit 行，缺运行时 `git rev-parse HEAD`、工作树状态与所执行字节的哈希，无法证明记录随运行采集。本轮按 codex 报告所列最小修法处理三项，**产品代码（接收端/测试）零改动**，只动证据采集面；`todo.md` 未改。

### R11-F1：终态提交门禁日志（被测提交 `8411a72`，干净检出）

- 采集包装器在**同一原始日志**先记录：分支、`git rev-parse HEAD`、采集时点 `git status --porcelain`（工作树状态）、起始时间+负载、命令，结尾记录结束时间与退出码；日志全部写在**仓库之外**（`$TMPDIR/r11-gates/`），因此采集自身不污染所记录的工作树状态，全部六份状态行均为 `clean (empty)`。包装器为一次性本地脚本（`r11-capture.sh`，未入库——evidence 提交因此只含日志与文档，不含任何代码改动；其头部字段形状与下方日志逐行对应，可复算复现）。
- 六份日志入 `docs/review/evidence/`，头部一律 `HEAD: 8411a7279ac6c366ef48a56678e72730cb3c9ede`：
  - `r11-full-cargo.log`：`cargo test --workspace` **退出 0**，94 结果块 **558 passed、0 failed、0 ignored**。
  - `r11-full-fmt-clippy.log`：`cargo fmt --check` **0**、`cargo clippy --workspace --all-targets -- -D warnings` **0**（`--- fmt exit=0 ---` / `--- clippy exit=0 ---`）。
  - `r11-full-eslint.log`：`pnpm lint` **退出 0** 干净。
  - `r11-full-tsc.log`：`pnpm clean && pnpm compile && tsc -p tsconfig.mocha.json` **退出 0**；`out/buildCommit.json` 记 `build commit 8411a72…`（构建身份与被测提交一致）。
  - `r11-full-vitest-1.log`：`npx vitest run` **退出 0**，**514 文件 passed | 4 skipped（518），6390 passed | 20 skipped（6410），0 failed**。
  - `r11-full-electron.log`：`node ./out/test/runTest.js` **12 passing**，退出 0。

### R11-F2：回环记录的运行时采集绑定（探针入库 `scripts/hot-reload-receiver/winRoundtripProbe.mjs`，随 `8411a72` 入库）

- 九轮探针只存在于会话临时目录、不在版本控制内，其 commit 标注是事后手写；本轮把探针**入库**并在头部随运行输出（原始 stdout、不做事后编辑）：`captured-at`、主机/平台/node、`git rev-parse HEAD`、`--abbrev-ref HEAD`、`git status --porcelain`、探针与接收端两个文件的**运行时 sha256**，并各自与 `git show HEAD:<path>` 的 blob sha256 对比给出 `probe bytes == HEAD blob` / `receiver bytes == HEAD blob` 标志——执行字节与记录提交的字节可逐字节互证。
- 本机 Linux 对拍 `docs/review/evidence/r11-winprobe-local-linux.log`：HEAD `8411a72…`、status 空、`probe bytes == HEAD blob: true`、`receiver bytes == HEAD blob: true`，八场景 **FINAL_VERDICT=PASS**、包装器 `exit=0`。
- Windows 真机 `docs/perf/2026-11-06-win-roundtrip-r11.txt`（openclaw，Windows Server 2022，node v24.22.1）：被测工作树由 `git bundle`（tip `8411a72`）在真机 `git clone -c core.autocrlf=false -b feat/kode-fix-f1f4` 检出，clone 后 `git rev-parse HEAD` = `8411a72…` 且 `git status --porcelain` 为空；探针运行时输出同一 HEAD、状态空、探针 sha256 `f3d36748e5f95483a2ea87d4c493ed66ad53f38aca079309a7cf5e80de100d75`、接收端 sha256 `b56b7ecae6e206d13019f97587743bc1e90e17dda206fe7823c3c3fe4fc317cd`，两哈希均与 `git show HEAD:` blob 一致，且与 Linux 本机对拍哈希**逐字节相同**（LF/CRLF 未改字节）；八场景 **FINAL_VERDICT=PASS**、包装器 `exit=0`。
- **被测提交与证据提交的关系（codex 明示「不能要求一个提交内的文件自含该提交自身哈希」）**：被测提交 = `8411a72`（终态代码提交，六份门禁与两端回环全部采于此）；随后的 evidence 提交只新增日志与本文档，**不含代码改动**，故证据所指代码树即 `8411a72` 的代码树，不声称证据提交自身哈希被其自身文件携带。

### R11-F3：`735aa4a` 范围如实注记（十轮复审第 4 项）

- 第九轮曾把 `735aa4a` 记为 fmt/clippy 清理；十轮复审抽查判定**并非纯格式面**，据此如实更正：`crates/kode-mcp/tests/units.rs:60-62` 把恒真断言改为「不包含 `TrainingMonster`」的实断言，**改变了测试行为**；`crates/kode-corpus/src/encoding.rs:239,345-350`（`chunks_exact → as_chunks`、`%2 → is_multiple_of`）、`crates/kode-parser/src/config.rs:199,215,234`（`extend(pending.drain(..)) → append(&mut pending)` 三处）与 `crates/kode-parser/src/config.rs:323`（`seen.iter().any(..) → seen.contains(..)`）为 clippy 驱动的表达式替换。
- 抽查的生产代码替换语义相当，但**未对全部 44 文件作逻辑等价证明**，故本记录不声称该提交「仅格式变化」；上述更正同时写入第九轮门禁数字小节。该提交本体过全量 cargo 测试（上第九轮、本轮 HEAD 均 558 passed / 0 failed）。
