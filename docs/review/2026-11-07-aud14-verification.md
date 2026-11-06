# 审核 14 项清零复核（2026-11-07，逐项取证）

范围：「代码审核发现（源 ChatGPT 代码审核 2026-11-03）」KODE-AUD-001..008 共 8 项 +
「审核发现 2026-10-31」整节（原 6 项发现，节内现存 9 行——3 行为后续追加的同批发现，
一并核验）。任务口径的「14 项」= 8 + 原 6。
基准：origin/main e7af5cba 起核；复审返工后 HEAD 8c2b7411。结论：**14 项全部已修复并已勾账**——
每项修复 commit 均在 main 祖先链上，修复机制在当前 HEAD 逐点实证存在，
本日在干净 worktree（/tmp/kode-aud14）复跑引用测试全绿。
复审（codex luna 第一轮）抓出 1 处 AUD-008 残余（实例接收者伪边）已返工修复
（8c2b7411，见 §返工）；其余 PASS 项复核维持。

## 复核方法

1. 每项勾账行的修复 commit 用 `git merge-base --is-ancestor` 核验在 origin/main。
2. 修复机制在当前 HEAD 用 file:line 重探（行号相对勾账时已漂移的，以机制存在为准）。
3. 引用测试在 e7af5cba 干净检出上本日复跑（数字见下），非转抄历史门禁数字。

## 代码审核发现 2026-11-03（KODE-AUD-001..008，8/8 闭环）

| 项 | 结论 | 修复 commit | 当前 HEAD 实证 | 本日复跑 |
|---|---|---|---|---|
| AUD-001 进程拓扑 queued 不冲刷 | 已修已勾 | 07548e1 | extension.ts 编辑冲刷周期含 processTopologyScheduler.flushQueued()；tests/processTopologyFlush.test.ts 在册 | 该文件在 132 过批次内 |
| AUD-002 C-19 诊断 ID 不一致 | 已修已勾 | e57fb26 | defMethodConsistency.ts 常量=def-method-missing-in-python，languageProviders 别名同源；tests/defPythonParity.test.ts 在册 | 同上 |
| AUD-003 热更状态机丢 sentDigest | 已修已勾 | 02dd105 | hotReloadTargetState.ts 回执路径写回 sentDigest；tests/hotReloadTargetState.test.ts 在册 | 同上 |
| AUD-004 流敏感缺 else/except/finally + bytes 误判 | 已修已勾 | 48d62f3 | selfAttributeFlowTypes.ts anyBlockOpen 含 else/except/finally、字面量前缀分型；tests/selfAttributeFlowTypes.test.ts 在册 | 同上 |
| AUD-005 GlobalDataIndex 旧版覆盖 | 已修已勾 | 4d62ade | noteSaved 同步分支清 editBuffers + runEditRecompute 源复核；tests/globalDataIndex.test.ts 在册 | 134 过批次内 |
| AUD-006 Rust def 递归环 | 已修已勾 | 6a2e005 | process_topology.rs visiting 活动栈 + def_md5.rs loading 活动栈三处守卫在码。**口径注明**：环守卫为静默截断（walk_def 再遇即 return、load_* 跳过），不产「环」专项诊断；验收「循环返回诊断不溢出」按「循环返回、不栈溢出」兑现（def_md5 面无诊断输出通道），A→B→A 测试锁不溢出+Ok 返回 | process_topology_units 31 过 + def_md5_units 12 过* |
| AUD-007 dataflow AST 语义 | 已修已勾 | b26396e | AugAssign 读旧值/Delete 终结链/walrus/Comprehension target/Subscript 读容器均在码 | dataflow_test 17 过 |
| AUD-008 callgraph/symbols/graph 遗漏 | 已修已勾（含 2026-11-07 复审残余返工，见 §返工） | dd869b5 + 8c2b7411 | 嵌套 def/class、Match guard、Match 属性写、本地裸名不产跨文件伪边均在码；模块接收者补 import 绑定核验 | callgraph 12 + graph 8（含返工新 2 例）+ symbols 7 过 |

\* 单测文件随后续批次自然增长，数字为当前 HEAD 实跑，非勾账时数字。

## 审核发现 2026-10-31（整节 9 行全闭环，覆盖原 6 项）

| 发现 | 结论 | 修复 commit | 当前 HEAD 实证 | 本日复跑 |
|---|---|---|---|---|
| pid=0 组杀误伤（processManager） | 已修已勾 | 16f0af0d | killProcessTree `!Number.isInteger(pid)\|\|pid<=0` 闸（processManager.ts:124） | cov-debug-process 在 132 过批次内 |
| startTargetGroup `??` 吞显式 null | 已修已勾 | 9fd98448 | resolveDependencyWaitDeadline（serverManager.ts:214）null=无限/undefined=60s 契约在码 | serverManager.test.ts 同上 |
| flag_scopes 域表背离单一来源 | 已修已勾 | 3cc6735 | lint/rules.rs:187 `flag_domains(&normalize_flag_tokens(...))` 单一来源 | kode-server lint_rules 19 过 + flag_domains_golden 过 |
| flag_scopes 未归一化 token | 已修已勾 | 3cc6735 | 同上 normalize_flag_tokens（CELL→CELL_PUBLIC 别名+折叠） | parser_units 19 过 + golden 锁步 |
| implementedBy 悬空 type 节点 | 已修已勾 | 60a6569 | dependency_graph.rs implementedBy 前 `ensure_node(type:{name})` 在码 | dependency_graph_dispatch 2 过 |
| globalDataIndex 在途复用旧 promise | 已修已勾 | e5dd0bf1 | indexFile AUD-070 revision 核对+追赶重读在码（globalDataIndex.ts ~1702） | globalDataIndex.test.ts 134 过批次内 |
| workspaceIndex finally 无条件删占位 | 已修已勾 | 3cc6735 | indexFile AUD-034 升 revision+尾随读 + finally 只清自己占位（workspaceIndex.ts:239；原引 :304 已漂移至 :314） | workspaceIndexColdYield + workspaceEventIndex 134 过批次内 |
| debugpy/py-spy 孤儿孙进程 | 已修已勾 | f58f4ec（debugpy 安装通道）+ 9fd9844（py-spy 组杀+detached） | debugpyPortProbe spawn detached+killProcessTree（debugpyPortProbe.ts:214）、pyspyDump 组杀+detached（pyspyDump.ts:43） | cov-debug-process 在 132 过批次内 |
| autoDebugpy defaultRunPython 无截止 | 已修已勾 | 9fd98448 | RUN_PYTHON_TIMEOUT_MS 30s 截止+组杀+exit 124 如实报 | autoDebugpy.test.ts 随全量（本日未单跑，机制在码+勾账带红证） |

## 返工（codex luna 第一轮 FAIL 项）

- **P1 · AUD-008 残余（实例接收者伪边）**：`resolve_callee_file` 对非 self、非空的接收者一律取首段按 basename 找文件，不经 import 绑定核验——`avatar.heal()`（avatar 为实例变量）会把唯一同名文件 avatar.py 误指为被调方。修（8c2b7411）：模块接收者分支先核调用方 `imports` 绑定（含 `import avatar` / `from pkg import avatar` 的 binding 面），未绑定 → None 宁缺毋滥。红证=graph_test.rs `receiver_without_import_no_cross_file_pseudo_edge`（修前红：伪边在产）+正向 `imported_module_receiver_resolves_cross_file`（真模块调用不切断）；门禁=graph_test 8/8、kode-python 全绿（45）、workspace cargo test --exclude kode-scheduler 0 failed、kode-scheduler 14 过、clippy kode-python 0 告警。todo AUD-008 勾账行已补注。

## 本日复跑数字（起核 HEAD e7af5cba + 返工后 HEAD 8c2b7411，0 failed）

- vitest：9 文件 266 过（e7af5cba）→ 复跑 267 过（8c2b7411 前身，含 KR-AUD-35 新用例）0 败（cov-debug-process/serverManager/processTopologyFlush/defPythonParity/hotReloadTargetState/selfAttributeFlowTypes=132 批次；globalDataIndex/workspaceIndexColdYield/workspaceEventIndex=134 批次）。
- cargo：kode-server（process_topology_units 31 / def_md5_units 12 / dependency_graph_dispatch 2 / lint_rules 19 / flag_domains_golden 5）+ kode-parser parser_units 19 + kode-python（callgraph 12 / dataflow 17 / graph 8 / symbols 7 / lib 3）+ kode-scheduler 14，全 0 failed。

## 记账说明

本批复核：14 项勾账行与代码事实一致；返工残余（AUD-008 接收者伪边）已修并在
AUD-008 勾账行补 8c2b7411 证据，AUD-006 勾账行补口径注明（静默截断，无环专项诊断）。
报告 v1 的三处表述（14 计数口径、debugpy/py-spy commit 归因、workspaceIndex :304 漂移）
已按复审意见改到本版。
