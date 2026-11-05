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
