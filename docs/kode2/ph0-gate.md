# PH0 Release Gate — 进入 Rust 阶段的准入清单(PH0-02)

- 日期:2026-10-23 · 分支 v0.2 · 依据:docs/kode2/KODE_2_COMPLETE_TODO.md §15 Phase 0 · **对账刷新:2026-11-17(RUST-248,缺口清单逐条核现状,原快照多处已实质关闭)**
- 铁律(书 §15):「PH0-GATE 无完整基准和正确性 fixture **禁止进入 Rust 替换阶段**」;本文件是该门禁的执行清单与当前状态正本。
- 状态记号:🟢 就绪 · 🟡 部分就绪(缺口已列) · ⬜ 未开始

## 总判定

| 门 | 状态 | 一句话 |
|---|---|---|
| 门 1 基准(bench) | 🟡 | TS 侧基准正本已立(PR1/PR7);Hover/Completion 端到端、内存、多轮中位已实测关闭(2026-gate-baseline.md);**Rust 双轨对拍基准已实测关闭(servingGate 五面:语义 parity+P99/RSS/CPU 界,nightly perf gate 接线,RUST-242 CPU 门 2026-11-17);A1-7 调用链图已闭(2026-11-17 修正:图在 2026-baseline.md §7 四 mermaid 块,legacy-todo-audit 记 ❌ 系 §7 落地前旧审计);余:VS Code UI 层端口径(真机走查腿已覆盖,脚本口径仍留白)** |
| 门 2 正确性 fixture(parity) | 🟢(最小集+扩面过半) | 四主请求 golden 已锁定(11 请求);**Rust 对拍执行器实质在库(18 golden:crates/kode-server/tests/golden/,hover/completion/definition/diagnostics/document-symbols/references/rename/semantic-tokens/call-at/method-calls/code-action/flag-domains/wire/def-md5/param-hints/props/diagnostic-pipeline/semantics-facts);余:signatureHelp 独立 golden、多根同名顺序 golden、规模轴 parity** |
| 门 3 回退方案(rollback) | 🟡 | kill-switch 三值+shadow 对拍+差异日志+演练判据已落(PR-012);`kbengine.core.backend` 默认已按 2026-11-08 用户令切 rust 服务轨道(TS 冻结为杀开关兜底,docs/kode2/feature-flags.md 台账);**provider 逐面接入 compare 后的首次实战回退演练未执行** |

**当前判定:门 3 未全绿(演练未执行)→ 书面门禁未全绿属实;实际路线已由用户令拍板偏离(2026-11-08 切流,B1 收编战役完成,TSMIG 系列记录),本表如实记账张力:书面门不全绿不虚构,实际切流是用户显式决策而非本门放行。Phase 1 骨架(PR-003..007)不阻塞。**

## 门 1 基准(无基准不得声称 Rust 更快 — 书 ARCH-012/PERF-011/015)

### 已就绪

- [x] 基准报告正本:docs/perf/2026-baseline.md(PR1,89e8783)+ docs/perf/2026-final-report.md(PR7 复测,e6e8bc7),同机(i9-10880H/Linux/Node v24.21.0)同资产集(`scripts/generate-perf-assets.mjs`,六场景)。
- [x] 七场景 PR1→PR7 对照数字 + 原始输出落盘(docs/perf/*-run.txt);验收表通过 6/未通过 0/未测量 2,不硬凑。
- [x] 硬件与环境记录:docs/perf/hardware.md(PERF-001,AUDIT 7bd2c4d)。
- [x] bench 可复现命令:`KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/*.bench.ts`。

### 关门缺口(进入 Rust 替换前必须关闭)

- [x] 🟢 Hover 端到端 P95 大型集已测量(2026-10-23,`tests/perf/gate.bench.ts` → docs/perf/2026-gate-baseline.md §2):large 30k,热态 n=100(5 轮×20)P95 **0.09 ms**(轮中位 0.04 ms),远低评审建议 30 ms;激活期冷态(首扫在途)P95 116.01 ms(首样本即 1 hit,未触预算兜底)。原 final 报告 §9.2 #1「未测量」关闭。
- [x] 🟢 Completion 端到端 P95 已测量(同上 §2.2):.py self. 面 P95 **0.08 ms**、.def 类型面 P95 **0.74 ms**(建议 ≤50 ms,通过);冷态 .py 面 P95 1.34 ms。原 §9.2 #2 关闭。
- [x] 🟢 冷启动内存占用已记录(同上 §4,RSS 峰值口径,25ms 采样):激活期峰值 **115.40 MB**(+32.40 MB);全量扫描期(30,001 .py)峰值 **687.19 MB**(+571.64 MB;3 轮峰值 488.63/653.26/661.83 MB,轮间爬升列入待跟踪)。原 §9.2 #8 内存子项关闭。
- [x] 🟢 bench 单轮抖动多轮中位已建立(同上 §2.2/§4):热态每指标 5 轮×20 样本报聚合分位+逐轮中位;全量扫描 3 轮墙钟 126.4/151.5/166.0s(极差 39.6s,机械盘抖动实证)轮中位 **151.5s**。原 §5.1「判回归必须多轮取中位」口径闭环。
- [x] 🟢 附加:失效后首重查已实测(同上 §3):.def 定向失效映射重建 1.85 ms、失效后首次 Hover 0.29 ms(1 hit);删除 .py 失效 28.04 ms、首次重查 0.56 ms(旧项 0 命中,阳性对照 1 hit)。
- [x] 🟢 A1-7 调用链图(Mermaid)已落(2026-11-17 对账修正,原「仍缺」判错文件):docs/perf/2026-baseline.md **§7「主要调用链图(真实路径取证,Mermaid)」**四条链(hover/definition/completion/diagnostics,四个 mermaid 块),tests/perfCallChainDoc.test.ts:566 硬断言 `mermaidBlocks.length === 4`+结构面(flowchart TD/节点引号配平/边算子/classDef waitPoint)+取证面(`file:line` 出处逐锚核对真实文件,代码迁移即红);legacy-todo-audit.md:32/:135 记 ❌ 系 §7 落地(2026-11-03 前后)之前的旧审计(2026-10-30 时点),已过时;此前「current-state.md grep 无 mermaid」系找错承载件——A1-7 的承载件是 2026-baseline.md 非 current-state.md。
- [x] **Rust 双轨对拍基准定义**已实测关闭(2026-11-15..17 演进,原「未立项」过时):servingGate 五面=语义 parity(hover/completion/definition/diagnostics/serving)+P99/RSS 界+CPU 界(steadyCpuPercentMax 200%,RUST-242 2026-11-17)+ nightly perf gate 接线(KODE_PERF_GATE=1);同 fixture 同口径跑 Rust 服务轨道实测,界的纪律=RUST-027 宽松上界;PERF-006..016 量测面已全收口(RUST-023..033,2026-11-15 批)。
- [x] 端到端口径边界大部分已关闭(2026-11-17 对账):soak 1h/OOM/杀进程恢复/损坏回建已实测(RUST-030,SOAK-SUMMARY 722 行全绿);extension activation 九段位+publish 端到端已实测(PERF-005 b3582459+a6cd06b1);Core spawn/handshake 已实测(d6e5be97);扫描期 RSS 轮间爬升列入 soak 长跑观测。**余下留白(如实):VS Code electron UI 序列化层不在脚本口径,以 009b imac/009c Linux 真机走查腿覆盖(2026-11-10 纪要),脚本化 electron 端到端仍未立项。**

## 门 2 正确性 fixture(同输入旧行为比对 — 书 PH1-GATE/PH2-GATE)

### 已就绪(本 commit)

- [x] parity 项目:`tests/fixtures/parity-project/`(实体继承 Monster→Avatar、组件 Inventory、Base/Cell 分面、Exposed、`<Arg>` 形参闸、types.xml/alias.xml 自定义类型),由 `scripts/generate-parity-fixtures.mjs` 确定性生成(`--check` 防漂移)。
- [x] golden 输入输出:`tests/fixtures/parity/golden.json`,11 请求锁 hover(3)/definition(4)/completion(2)/diagnostics(2);对拍测试 `tests/parityGolden.test.ts`(默认对拍,`KODE_PARITY_UPDATE=1` 重录;两次重录 sha256 一致,确定性已验证)。
- [x] 永转/超时回归锁(hoverBudget/documentStore/indexScheduler 三类测试)在 AUDIT-014 映射中列为迁移期禁删项(legacy-todo-audit.md 末节)。

### 关门缺口

- [ ] golden 扩面(2026-11-17 对账:过半已关闭):references ✅(8682caec,kodeReferencesParity.test.ts+references-parity.json)、rename ✅(def-rename-parity.json+kodeDefRenameParity 面)、code-action/document-symbols/semantic-tokens/call-at/method-calls/flag-domains/wire/def-md5/param-hints/props/diagnostic-pipeline/semantics-facts 已入(18 golden 全清单见总判定);**仍缺:signatureHelp 独立 golden、多根同名符号命中顺序 golden(docs/review/2026-10-23-pr4-lookup-order-forensics.md 的显式策略)尚未入 golden。**
- [ ] 规模轴 parity:golden 现为 small 口径;S/M/L 规模下的行为等价抽查(perf 资产复用)未定义。(2026-11-17 对账:仍未定义,语义 golden 语料=tests/fixtures/electron-ws 固定集;规模轴纯由 perf bench 覆盖语义命中面抽查)
- [x] Rust 侧对拍执行器实质在库(2026-11-17 对账关闭,原「未存在」过时):crates/kode-server/tests/golden/ 18 golden(生成器=dump-* 各 bin)+TS 侧对拍测试族(kodePythonCallAtParity/kodeReferencesParity/kodeDefinitionParity 等,同 fixture 喂两侧比对);Rust 测试门禁=CI rust-coverage job(cargo test 唯一执行点)。
- [ ] VS Code 真实 UI 层(electron 端到端)不在 golden 口径,基线 §5 待测项仍开放。(2026-11-17 对账:真机走查腿已覆盖=009b imac 四阶段+009c Linux xvfb 双形态纪要;脚本化 electron 端到端仍未立项,与门 1 UI 层留白同一条)

## 门 3 回退方案(书 §16.3/PH7-02:双轨 parity 与回退措施成熟前不删旧实现)

### 已就绪(PR-012,2026-10-23)

- [x] 回退底线已从「TS 单轨」演进为「TS 冻结兜底」(2026-11-17 对账):Rust 服务轨道已按 2026-11-08 用户令默认生效(kbengine.core.backend 默认 rust);TS 语义引擎冻结为杀开关兜底(kodeCoreGate 失败/缺二进制自动回落 ts,不误伤);shadow 对拍只记差异不发布。
- [x] 迁移铁律已有依据:书 PH7-02(仅双轨 parity 和回退成熟后删旧 TS 全仓解析)、§16.8(correctness regress 的 PR 不能合并);TS 兜底删除条件清单=docs/kode2/feature-flags.md 台账(RUST-245,2026-11-17)。
- [x] 双轨 kill-switch 配置键已设计+实现并已实战切流:`kbengine.core.backend: ts|rust|shadow`(默认值演进:ts→rust,2026-11-08 用户令;非法值一律回落 ts;resolveBackendMode 字面量白名单=kill-switch 永远收得回来)——src/kodeCoreGate.ts `resolveBackendMode`+装配;设计正本 docs/kode2/pr-012.md §1,台账正本 docs/kode2/feature-flags.md(守卫 tests/featureFlagLedger.test.ts)。
- [x] shadow 模式(双跑比对、Rust 结果仅记录不发布)+差异日志已实现:backend=shadow 时 TS 照常服务,同参请求镜像 kode-server,五种 verdict 入有界环形 ShadowDiffLog(500 条)并接输出通道「KBEngine Core Shadow」,命令 `kbengine.core.showShadowDiffLog` 查看;采集器就位,provider 逐面接线属 parity 扩面后续单。
- [x] 回退演练脚本与判据已立(pr-012.md §2.3):四步演练 + 四判据(结果逐字节一致/failure 全归因 rust 侧/kill-switch 后 clientAlive=false/全程用户无感);可执行实战演练待 provider 接线后做首次并记录。

### 关门缺口(收尾)

- [ ] provider 逐面接入 `gate.compare()` 后的首次实战回退演练与记录(pr-012.md §2.3 判据打勾)。
- [x] 旧 TS 实现的退役条件清单已从书条款细化为可执行 checklist(pr-012.md §6);其逐条执行属 PH7 阶段。

## 与书条目的勾稽

- 本文件兑现 §15 PH0-02 后半句「输出 release gate」;PH0-02 前半句(锁定 parity fixture 与旧 TODO 完成状态)分别由 `tests/fixtures/parity/`+`tests/parityGolden.test.ts` 与 `docs/kode2/legacy-todo-audit.md`(60 行对账)兑现。
- AUDIT-014(旧 A1-A7 映射正式勾账)落 legacy-todo-audit.md 末两节;书文件按其页眉协议保持原文逐字,不就地勾选。
- PH0-GATE 判定在书 §15 为复选框;勾选条件=门 1 缺口关闭 + 门 2 扩面与对拍执行器就绪 + 门 3 kill-switch 设计落库。**2026-11-17 对账:后两条件已实质达成(对拍执行器 18 golden+kill-switch 实战在役),门 1 余 A1-7 Mermaid 图与 UI 层脚本口径两条;门 3 实战演练未执行前本表不勾全绿。实际切流(2026-11-08 用户令)是用户显式决策,不以本门放行为前提;任何新增替换面 PR 仍以本表判红纪律自律。**
