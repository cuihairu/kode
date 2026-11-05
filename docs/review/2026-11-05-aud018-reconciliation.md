# IDE-AUD-018:深审后原组与修复细项状态对账

- 任务:todo.md IDE-AUD-018「对账深审后原组与修复细项状态」
- 验收原文:「每个原项重新核对自己的完整验收,修复子项全完成才允许关闭,已有失败反例不因单测通过自动消失;关联:IDE-ACC-010。」
- 深审依据:`docs/review/2026-10-30-completion-and-lint-audit.md`(第一轮深审,F01-F18)
  与第二轮(R2-F01..F27)/第三轮(R3-F01..F08)/第四轮(R4-F01..F12)。
- 本批对账范围:第一轮深审重开的原组(热更新 HOT 簇 / 取消收敛 ACC-007 / 最终标记
  ACC-010 / 数据库 REV 簇 / 调试 PDBG 簇)及其修复子项(IDE-REV / IDE-AUD)。第二轮起
  的 33+13+13 个原子任务已逐项单独验收(各带 hash),不在本批重复核验,只登记其状态。

## 1. 对账方法

逐原组:①重开条件(审计 F 编号/反例)→ ②修复子项(IDE-REV/IDE-AUD 及其完成态)→
③按「修复子项全完成才允许关闭」规则给裁决 → ④对可关闭项做「重新核对完整验收」
(读当前码 + 跑该子项测试,不凭旧单测通过代替)。

## 2. 原组对账表(第一轮深审)

| 原组 | 重开条件(审计) | 修复子项 | 子项态 | 完整验收重新核对 | 裁决 |
|---|---|---|---|---|---|
| IDE-HOT-001 | 复审重开:待 REV-021 | REV-021(db90893) | ✅ 已勾 | 已复核关闭 2026-10-31 | 保持关闭 |
| IDE-HOT-003 | 复审重开:待 REV-022 | REV-022(7ce5b27) | ☐ **开放**(深审再重开:回执真实协议证据缺口/AUD-007) | — | **保持开放** |
| IDE-HOT-004 | 复审重开:待 REV-023 | REV-023(029a434) | ☐ **开放**(F08/AUD-005/006/007) | — | **保持开放** |
| IDE-HOT-005 | 复审重开:待 REV-024 | REV-024(4c0aaa8) | ☐ 原开放(F09/AUD-014) | AUD-014(d08e315)已勾:装载面扩到 Parent/Interfaces/Components/Persistent/Utype,反例断言在 tests/hotReloadDefStructure.test.ts:127;本批重跑 28/28 绿 | **本次关闭**(见 §3) |
| IDE-ACC-007 | 复审重开:待 REV-032/033 | REV-032(50e1002)、REV-033(97c00c1)、F14→AUD-015/016(621c285) | ✅ 全部已勾 | 四面(取消不回内容/落潮窗 0 读盘/请求侧量规归零/共享扫描继续)各由已关闭子项真机证据覆盖 | **本次关闭**(见 §3) |
| IDE-ACC-009 | 复审重开:待 REV-030/031/034 | REV-030/031/034(7e25c3e)、F15→AUD-017(41ee80e) | ✅ 全部已勾 | 已复核关闭 2026-10-30;F15「短压力与长会话分开」已由 AUD-017(180s 自然序列)补齐 | 保持关闭 |
| IDE-ACC-010 | F17(确认验收缺陷) | AUD-019、AUD-020 | ☐ **开放**(P1) | — | **保持开放**(AUD-019/020 未完成) |
| IDE-REV-022 | 回执真实协议证据缺口 | AUD-007 | ☐ 开放(用户级阻塞) | — | **保持开放** |
| IDE-REV-023 | F08/AUD-005/006/007 | AUD-005(cd7b47c)、AUD-006(c82f540)、AUD-007 | ✅✅/☐ | F08 两子缺陷(代际写回+sentDigest 冻结)已修复;AUD-007 缺真实协议证据(需会说自定契约的 HTTP 服务)阻塞 | **保持开放**(AUD-007 阻塞) |
| IDE-REV-024 | F09(确认缺陷) | AUD-014(d08e315) | ✅ 已勾 | F09 反例已修:装载面指纹含 `parent`/`interface.*`/`component.*` 槽形状(src/hotReloadDefStructure.ts:33-34),Parent 改/组件槽 Type/Persistent 改均判结构性;本批重跑 28/28 绿 | **本次关闭**(见 §3) |
| IDE-AUD-007 | 保持开放(2026-11-01 实勘) | — | ☐ 阻塞 | 接收端已登记(引擎 master 732b389 的 `KBEngine.reloadScript`,无 HTTP 无回执);请求/响应样本需自定契约 HTTP 服务,属用户级环境决策 | **保持开放**(阻塞条件如实记录) |

第二轮/第三轮/第四轮(IDE-AUD-022..077、IDE-RUST-001..004):均逐项带 hash 勾齐,状态
与深审结论一致,无遗留重开项,本批不重复核验(仅 F06/F07 例外,见 §4)。

## 3. 本次关闭项(修复子项全完成 + 完整验收重新核对通过)

### IDE-REV-024(及原组 IDE-HOT-005)

- 重开条件:F09「def 指纹遗漏 Parent/Interfaces/Components/Persistent 等结构,改变仍
  structural=false,可进入普通 reload」。
- 修复:AUD-014(d08e315)`buildStructuralFingerprint` 增装载面 `loading: Map<string,string>`
  (`parent`/`interface.<名>`/`component.<槽>`→形状,src/hotReloadDefStructure.ts:33-34/132/139/147);
  逐项入指纹序列化(:179),差异比较(:223-232)。
- 重新核对:读当前码确认装载面在指纹中;tests/hotReloadDefStructure.test.ts:127 起
  「IDE-AUD-014 装载面」describe 含 Parent 改→结构性(:162-166)、接口增减→结构性、组件槽
  Type/Persistent 改→结构性(:189-194)反例;本批 `vitest run hotReloadDefStructure
  +hotReloadDefGateWiring` **28/28 绿**。
- 验收口径(REV-024):序列化/RPC 参数结构变化提示需重启、发送器不收到普通 reload,
  非结构 Python 仍可发送——由 4c0aaa8 闸 + d08e315 装载面闭合。
- **关闭 REV-024;原组 HOT-005 同步关闭**(其重开条件仅「待 REV-024」)。

### IDE-ACC-007(取消后收敛)

- 重开条件:待 REV-032/033;F14 追加「真实 IO/计算已启动后的中止」证据缺口。
- 修复子项全部完成:REV-032(50e1002,2026-11-04 复核关闭)、REV-033(97c00c1,2026-11-05
  复核关闭)、F14 派发后取消面(AUD-016 621c285 + hover 侧 AUD-015)。
- 完整验收重新核对(四面,各由已关闭子项真机证据覆盖):
  ①实际取消后记录残留任务数与新增 IO——AUD-016 派发后闸 `gateReached=true/requestWindow=1/
  postCancelWindow=0`(请求归属 IO 差),取消落潮窗 0 读盘(REV-032/033);
  ②共享扫描继续——取消后现场 appendFile,parse 计数前进(3073→3075 等);
  ③请求独占任务停止——请求侧量规(diagnostics/annotation/schema)归零;
  ④请求不得回内容——取消样本 returnedDefinition/returnedContent 为 false。
- **关闭 ACC-007。**

## 4. 仍可见的失败反例(不因单测通过自动消失)

- **F06**「同行条件/None 分支嵌套 return/已失效别名可能消掉 receiver 警告」——确认缺陷,
  `src/receiverNoneGuard.ts` 自 2026-10-30 审计后 **零提交**(git log 空),反例仍在;
  未在 IDE-AUD/IDE-LINT 登记修复任务。
- **F07**「注释/普通字符串的 receiver 文本会报 Warning;`peer=self.cell; peer.send()` 零诊断」
  ——确认缺陷,同源零提交,反例仍在;未登记。
- 上述两项**保持可见、保持开放**;建议后续以 IDE-LINT 族(或新 AUD)登记修复任务
  (本批仅对账,不新造任务,避免混入清账范围)。

## 5. 保持开放项汇总(原因)

| 项 | 原因 |
|---|---|
| IDE-HOT-003 / IDE-REV-022 | 回执真实协议证据缺口(AUD-007 阻塞) |
| IDE-HOT-004 / IDE-REV-023 | AUD-007 缺真实 applied 协议证据(需自定契约 HTTP 服务) |
| IDE-AUD-007 | 用户级环境决策(无会说该契约的服务端,引擎原生重载无回执) |
| IDE-ACC-010 | AUD-019/AUD-020(P1)未完成:量规对齐 + 延迟越界真正判失败 |
| IDE-AUD-019/020 | 未开始(下一批) |
| F06/F07 | 未修复未登记(§4) |

## 6. 运行与门禁

- 本批仅对账 + 关闭可关闭项,无源码改动(只读核对 + 重跑既有测试):
  `vitest run tests/hotReloadDefStructure.test.ts tests/hotReloadDefGateWiring.test.ts` 28/28 绿。
- 无新门禁需全量跑(零源码变更);关闭项均引用已验收证据(hash 见 §2)。
