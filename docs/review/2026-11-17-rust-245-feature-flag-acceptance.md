# RUST-245 验收纪要:大型功能启用 feature flag,parity/perf 完成后再移除旧实现(真增量:flag 台账+守卫测试锁)

日期:2026-11-17。本纪要对账 RUST-245(旧 QA-016)的验收口径与交付证据。**结论:QA-016 原侦察「部分(大功能开关已有,移除旧实现的闸只有文档);无 flag 台账」仍成立——本批交付任务书验收口径两件:`docs/kode2/feature-flags.md` 台账+测试锁(台账↔package.json 配置面一致+每 flag 在 tests/ 有开关测试),真增量收口。**

## 验收口径 → 交付证据映射

| 任务书要求 | 交付 | 证据 |
| --- | --- | --- |
| `docs/kode2/feature-flags.md` 台账(flag/保护的旧实现/移除条件/当前状态) | 本批新建 | 主档=`kbengine.core.backend`(ts\|rust\|shadow,默认 rust;非法值一律回落 ts);保护的旧实现=TS 语义引擎全族(kodeCoreGate 失败/缺二进制兜底+TS 推导引擎冻结面,RUST-PRECISION 定案);移除条件=parity 持续绿(servingGate 语义五面+P99/RSS/CPU 界)+ph0-gate 门 3 回退演练成熟+用户拍板;当前状态=rust 服务轨道(2026-11-08 用户令切流)/ts kill-switch 在役/shadow 对拍观测 |
| 测试锁:非法 backend 回落 ts 已有,扩到「台账里每个大功能 flag 都有开关测试」 | 本批新建+既有面 | `tests/featureFlagLedger.test.ts` 三例:①台账四要素结构锁②台账每 flag 在 package.json 配置面真实存在(幻影开关红)+tests/ 有文件提及(排除守卫自身,防自指假绿)③kill-switch 三值+默认 rust+非法回落 ts 账面语义锁。既有开关测试面:tests/kodeCoreGate.test.ts(默认/undefined/空串/拼错一律回落 ts :192、rust 未配 serverPath 回落 :241/:258、shadow 四 verdict 面) |
| 「移除旧实现」闸 | 既有文档闸+机械面如实记账 | 机械面=kill-switch 永远收得回来(resolveBackendMode 字面量白名单)+rust 轨道失败回落 TS 不误伤+shadow 只记差异日志;流程闸=ph0-gate 门 3 🟡(首次实战回退演练未执行)+版本红线(版本号/移除属破坏性变更须用户拍板) |

## QA-016 侦察后的演进(对账)

原侦察「`serveFromRust()` 恒 false(默认 ts 不切流)」已演进:2026-11-08 用户令「直接切到 rust」,默认 `rust` 生效服务轨道,TS 保留为失败/缺二进制兜底(kodeCoreGate.ts 头注记账)。台账按演进后状态写,不按侦察时快照。

## prove-red 闭环

台账 flag 名变异为幻影名(`kbengine.core.backendX`)→ 测试红(`台账必须登记核心双轨开关 kbengine.core.backend: expected [ 'kbengine.core.backendX' ] to include 'kbengine.core.backend'`)→ cp 备份还原+cmp 字节校验 → 复绿 3/3。

## 门禁

lint 0 / compile 0 / unit 10665 passed(+3 新例)/885 文件。

## 诚实条款

- **自动闸=守卫锁而非移除执行器**:测试锁的是「台账↔配置面↔开关测试一致」,不是「移除 TS 兜底时自动验证 parity/perf」——后者是流程闸(ph0-gate 门 3 演练+用户拍板+版本红线),不虚构自动化。
- **44 个其余 kbengine.* 开关未逐条建台账条目**:它们是单实现功能开关,无「旧实现待移除」性质(QA-016 原文亦只将 core.backend 列为大功能开关判例);复现摘要导出(IDE-REL-007)自动枚举其现值,台账说明段记账,不逐条重复。
- **首次实战回退演练未执行**(ph0-gate 门 3 🟡 既有状态):台账如实转记,本批不冒充已演练。
