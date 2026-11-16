# RUST-247..249 ph0-gate 对账修正纪要(2026-11-17)

## 背景

RUST-247(旧 PH0-01)/248(旧 PH0-02)/249(旧 PH0-GATE)以纯对账方式收口:PERF-001..016=RUST-018..033 已全部勾,缺口清单刷新至现状(docs/kode2/ph0-gate.md 2026-11-17 刷新稿)。本纪要记录对账稿的**一处事实修正**与**一处顺笔过期宣称清理**。

## 修正一:A1-7「仍缺」判错承载件(已修正)

对账稿初判 A1-7 Mermaid 调用链图「仍为真缺口」,依据是「current-state.md grep 无 mermaid」。**承载件找错了**:A1-7 的载体是 docs/perf/2026-baseline.md 非 current-state.md。

证据链(全部可机械复核):

1. `docs/perf/2026-baseline.md` §7「主要调用链图(真实路径取证,Mermaid)」含 **4 个 mermaid 块**(hover/definition/completion/diagnostics 四条链);
2. `tests/perfCallChainDoc.test.ts:566` 硬断言 `expect(mermaidBlocks.length).toBe(4)`,且带结构面(flowchart TD/节点引号配平/边算子/classDef waitPoint)与取证面(`file:line` 出处逐锚核对真实文件、锚点行首仍是所引符号,代码迁移即红)双锁——该测试在 unit 门禁常绿;
3. `docs/kode2/legacy-todo-audit.md:32/:135` 记 ❌ 系 **2026-10-30 时点的旧审计**,§7 落地(2026-11-03 前后)之前所写,已过时——本笔在该两行追加了时点对账注,不改正文历史记录。

修正落点:ph0-gate.md 门 1 总判定行(余项去掉 A1-7)、门 1 缺口区 A1-7 行翻 `[x]` 带证据链、todo.md RUST-247/248 两勾行内文修正。修正后门 1 余项仅剩「VS Code UI 层脚本口径」一条,维持 🟡 不变(不因 A1-7 修正虚改总判定)。

## 修正二:顺笔过期宣称清理(本笔提交件)

- `docs/architecture/current-state.md`(en/zh 双语同步)PERF-015 节:原「多轮取中位/置信区间待建」→ 已建(`KODE_PERF_REPEAT` RUST-032 + gate-baseline 5 轮×20 分位聚合与 3 轮轮中位实践;CI M 档与本机 L 档分轨互不换算 RUST-028)。
- 同文件 PERF-016 节:原「decisions.md 尚不存在/待建」→ 已建(RUST-033 账本,12 条带证据锚/取舍/回退+维护规则)。
- `docs/perf/hardware.md` §5:原「decisions.md 待建(本 PR 文件范围受限)」→ 指向已建立的账本正本。

## 对账稿其余断言的核验记录

- 「PERF-006..016 量测面已全收口(RUST-023..033)」:核 todo.md:255-265 十一行勾俱在,证据面含 docs/review/2026-11-15-rust-024(request-metrics)/rust-025(counter-inventory)/rust-026(resource) 三份审计与 2026-11-15 实测族(latency-grouping/request-storm/soak-1h/index-memory-eval/index-increment-bench)——**成立**。
- 「AUDIT-001..015=RUST-034..048 已全部勾」:todo.md 对应行俱在勾态——成立。
- 门 2「Rust 对拍执行器实质在库(18 golden)」:与 crates/kode-server/tests/golden/ 现状一致——成立。

## 诚实条款

- 门 1 维持 🟡:余「VS Code UI 层脚本口径」一条如实留白(真机走查腿 009b/009c 已覆盖人工验收,脚本化 electron 端到端未立项)。
- 门 3 维持 🟡:首次实战回退演练未执行,不虚构全绿。
- 本笔与对账稿主提交(ph0-gate.md/todo.md,含 247/248/249 三勾)分属两个提交件,各自走全门禁;本纪要所属提交不含 todo.md/ph0-gate.md。
