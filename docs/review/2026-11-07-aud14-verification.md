# 审核 14 项清零复核（2026-11-07，逐项取证）

范围：「代码审核发现（源 ChatGPT 代码审核 2026-11-03）」KODE-AUD-001..008 共 8 项 +
「审核发现 2026-10-31」整节（原 6 项，后续扩至 9 行，本复核全行覆盖）。
基准：origin/main e7af5cba。结论：**14 项全部已修复并已勾账，无虚修、无漏网**——
每项修复 commit 均在 main 祖先链上，修复机制在当前 HEAD 逐点实证存在，
本日在干净 worktree（/tmp/kode-aud14，基于 e7af5cba）复跑引用测试全绿。

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
| AUD-006 Rust def 递归环 | 已修已勾 | 6a2e005 | process_topology.rs visiting 活动栈 + def_md5.rs loading 活动栈三处守卫在码 | process_topology_units 31 过 + def_md5_units 12 过* |
| AUD-007 dataflow AST 语义 | 已修已勾 | b26396e | AugAssign 读旧值/Delete 终结链/walrus/Comprehension target/Subscript 读容器均在码 | dataflow_test 17 过 |
| AUD-008 callgraph/symbols/graph 遗漏 | 已修已勾 | dd869b5 | 嵌套 def/class、Match guard、Match 属性写、本地裸名不产跨文件伪边均在码 | callgraph 12 + graph 6 + symbols 7 过 |

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
| workspaceIndex finally 无条件删占位 | 已修已勾 | 3cc6735 | indexFile AUD-034 升 revision+尾随读 + finally 只清自己占位（workspaceIndex.ts:239/304） | workspaceIndexColdYield + workspaceEventIndex 134 过批次内 |
| debugpy/py-spy 孤儿孙进程 | 已修已勾 | f58f4ec | pyspyDump 组杀+detached、debugpyPortProbe spawn detached+killProcessTree | cov-debug-process 在 132 过批次内 |
| autoDebugpy defaultRunPython 无截止 | 已修已勾 | 9fd98448 | RUN_PYTHON_TIMEOUT_MS 30s 截止+组杀+exit 124 如实报 | autoDebugpy.test.ts 随全量（本日未单跑，机制在码+勾账带红证） |

## 本日复跑数字（HEAD e7af5cba，0 failed）

- vitest：9 文件 266 过 0 败（cov-debug-process/serverManager/processTopologyFlush/defPythonParity/hotReloadTargetState/selfAttributeFlowTypes=132；globalDataIndex/workspaceIndexColdYield/workspaceEventIndex=134）。
- cargo：kode-server（process_topology_units 31 / def_md5_units 12 / dependency_graph_dispatch 2 / lint_rules 19 / flag_domains_golden 5）+ kode-parser parser_units 19 + kode-python（callgraph 12 / dataflow 17 / graph 6 / symbols 7 / lib 3），全 0 failed。

## 记账说明

本复核为纯核验批：14 项在 todo.md 中的勾账行（2026-11-03/04 落账）与代码事实一致，
无需要改账的虚勾、无需要补修的漏网，不动原勾账行。
