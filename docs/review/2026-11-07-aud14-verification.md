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
| AUD-008 callgraph/symbols/graph 遗漏 | 已修已勾（含 2026-11-07 八轮复审返工，见 §返工） | dd869b5 + 8c2b7411 + bc8a06cf + 086f13c1 + 96a30607 + 3dcecb48 + e61c7c2c + b9edefd1 + f3276040 | 嵌套 def/class、Match guard、Match 属性写、本地裸名不产跨文件伪边均在码；模块接收者补调用点作用域 import 绑定核验（保守歧义契约：ScopeKind 分层+行区间+歧义即放弃+模块回退最外层） | callgraph 12 + graph 20（含返工新 14 例）+ symbols 7 过 |

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

## 返工（codex luna 第二轮 FAIL 项）

- **P2 · 函数内导入被漏判**：第二轮修复的绑定核验只看顶层 `imports` 表，`def battle(): import avatar; avatar.heal()` 这类函数内真绑定被漏判、断边。修（bc8a06cf）：symbols.rs 增 `ImportBindingCollector`（ruff visitor 递归函数/类/分支体）采全作用域 import 绑定，`AstSymbols` 增 `import_bindings` 字段（顶层 `imports` 语义面口径不动，既有消费面零影响），graph.rs 核验改用全作用域。红证=graph_test.rs `function_scoped_import_receiver_resolves_cross_file`（修前红）；门禁=graph_test 9/9、kode-python 全绿（48）、workspace(excl scheduler) 103 个 test-target 全 0 failed、kode-scheduler 绿、clippy kode-python 0 告警。todo AUD-008 勾账行已补注。

## 返工（codex luna 第三轮 FAIL 项）

- **P1 · 文件级合并重开伪边**：第二轮的 `import_bindings` 文件级合并使无关函数的函数内 import 为实例接收者作保（`def setup(): import avatar` + `def battle(): avatar.heal()`）。修（086f13c1）：`AstSymbols.function_import_bindings: BTreeMap<函数名, BTreeSet<绑定>>`（visitor 带函数栈，闭包可见语义记到栈上每层，键与 `CallEdge.caller` 同口径），graph.rs 核验 = 模块顶层 `imports`（全文件可见）∪ 调用方函数子树绑定。红证=graph_test.rs `cross_function_import_no_pseudo_edge`（修前红）；门禁=graph_test 10/10、kode-python 全绿（49）、workspace(excl scheduler) 103 target 0 failed、kode-scheduler 绿、clippy kode-python 0。todo AUD-008 勾账行已补注。

## 返工（codex luna 第四轮 FAIL 项）

- **P1 ×2 · 裸函数名键两缺陷**：①同名方法串保（A.run 的函数内 import 为 B.run 的实例接收者作保）；②嵌套传播方向错（内层 import 误记外层键产伪边，外层 import 反而漏内层调用）。修（96a30607）：改按**行区间作用域**——`AstSymbols.function_import_bindings: Vec<ScopeImportBindings{start_line,end_line,bindings}>`（visitor 带区间栈，绑定记最内层函数区间；区间天然嵌套=外层区间覆盖嵌套体→闭包可见，兄弟/同名区间不相交→互不作保），graph.rs 用调用点行号落区间判可见，彻底去函数名键。红证=graph_test.rs `same_name_method_import_no_pseudo_edge`（修前红：伪边在产）+`outer_import_visible_to_nested_call`（修前红：漏边）；门禁=graph_test 12/12、kode-python 全绿（51）、workspace(excl scheduler) 103 target 0 failed、kode-scheduler 绿、clippy kode-python 0。todo AUD-008 勾账行已补注。

## 返工（codex luna 第五轮 FAIL 项）

- **P1 · 外层 import 被内层遮蔽仍误保放**：行区间 any-包含语义下，`def outer(): import avatar` + `def inner(avatar): avatar.heal()` 仍产伪边（inner 无 import 记录，outer 区间保放）；同理局部赋值遮蔽。修（3dcecb48）：`ScopeImportBindings` 增 `shadows` 集（函数参数全型 + visit_expr 收 Store 上下文 Name = 赋值/walrus/for/with/推导式目标），每函数作用域都保留；graph.rs 改**最近作用域优先**——含调用行的区间按起始行降序（内层先）走查，先遇遮蔽即止不产边，先遇 import 绑定即放行。红证=graph_test.rs `param_shadow_blocks_outer_import_vouch` + `local_assign_shadow_blocks_outer_import_vouch`（修前双红）；门禁=graph_test 14/14、kode-python 全绿（53）、workspace(excl scheduler) 103 target 0 failed、kode-scheduler 绿、clippy kode-python 0。todo AUD-008 勾账行已补注。

## 返工（codex luna 第六轮 FAIL 项）

- **P1 ×3 · 遮蔽/分层交互缺陷**：①模块顶层 import 短路内层参数遮蔽（module import 先查→伪边）；②推导式目标与函数内类体 Store 名污染外层函数 shadows（断真边）；③同作用域 import 与参数共存时遮蔽优先误判（断真边）。修（e61c7c2c）：①函数作用域链未决才回退模块 imports（最外层）；②`ScopeKind{Function,Class,Comprehension}` 分层——类体/推导式/lambda 各自独立层（推导式 `enter_comp_scope` 配对进出），graph.rs 按 kind 过滤只走 Function 层；③同层 bindings 优先于 shadows（import 显式重绑定语义）。红证=graph_test.rs `module_import_does_not_bypass_param_shadow`/`same_scope_import_overrides_param`/`comprehension_target_does_not_shadow_function_import`（修前三红）；门禁=graph_test 17/17、kode-python 全绿（56）、workspace(excl scheduler) 103 target 0 failed、kode-scheduler 绿、clippy kode-python 0。todo AUD-008 勾账行已补注。

## 返工（codex luna 第七轮 FAIL 项）

- **P1 ×3 · 推导式/重绑定位置语义缺陷**：①推导式节点被外层 walk_expr 二次走查，目标 Store 漏进外层函数 shadows（断真边）；②Comprehension 层被解析链过滤，推导式元素内迭代变量接收者的伪边放行（模块 import 作保）；③同作用域 import 后本地重绑定恒 binding 优先（伪边向）。修（b9edefd1）：①enter_comp_scope 内部走查整棵子树后配对退出，visit_expr 对推导式直接 return（消二次走查）；②解析链含 Comprehension 层（shadow 阻断向）；③bindings/shadows 改 `BTreeMap<name, 最近行>`，层内按行序裁决（call ≥ 最近 import 且晚于最近本地 → 模块绑定；call ≥ 最近本地且晚于最近 import → 本地对象；层内未决继续向外；模块 imports 仍为最外层回退）。已知粒度限制如实记录：同一行内 lambda 参数遮蔽与外层调用行粒度不可分（保守漏边向）。红证=graph_test.rs `comprehension_target_shadow_blocks_module_vouch` + `rebind_after_import_blocks_vouch`（修前双红）；门禁=graph_test 19/19、kode-python 全绿（58）、workspace(excl scheduler) 103 target 0 failed（首轮 ruff_lint_dispatch 一例负载抖动，隔离复跑过+全量复跑全绿）、clippy kode-python 0。todo AUD-008 勾账行已补注。

## 返工（codex luna 第八轮 FAIL 项 → 契约定版）

- **P1 ×2 · 行序裁决不完备**：①调用位于 import 与本地赋值两类绑定之间时裁决忽略已生效绑定；②多行推导式元素调用早于 target 源码行时遮蔽失效。两例共同根因：name→最近行映射无法无数据流地表达完整先后语义。**定版契约（f3276040）：保守歧义即放弃（宁缺毋滥）**——解析链（Function/Comprehension 层，内层向外）：层内仅 import 绑定且 call≥绑定行 → 放行；层内有本地绑定（Python 静态局部性，叠加 import 亦歧义）→ 不产边；层内未提及 → 向外；全链未决 → 模块 imports 最外层回退。原「import 覆盖参数」断言（round-6）改口径为放弃该边（same_scope_conflict_gives_up_edge）。已知粒度限制如实记录（同行 lambda 遮蔽，保守漏边向）。红证=graph_test.rs `multi_line_comprehension_shadow_blocks_vouch`（修前红）+`same_scope_conflict_gives_up_edge`（改口径断言）；门禁=graph_test 20/20、kode-python 全绿（59）、workspace(excl scheduler) 103 target 0 failed、kode-scheduler 绿、clippy kode-python 0。todo AUD-008 勾账行已补注。

## 本日复跑数字（起核 HEAD e7af5cba → 返工后 HEAD 476e9c23，0 failed）

- vitest：9 文件 266 过（e7af5cba）→ 复跑 267 过（8c2b7411 前身，含 KR-AUD-35 新用例）0 败（cov-debug-process/serverManager/processTopologyFlush/defPythonParity/hotReloadTargetState/selfAttributeFlowTypes=132 批次；globalDataIndex/workspaceIndexColdYield/workspaceEventIndex=134 批次）。
- cargo：kode-server（process_topology_units 31 / def_md5_units 12 / dependency_graph_dispatch 2 / lint_rules 19 / flag_domains_golden 5）+ kode-parser parser_units 19 + kode-python（callgraph 12 / dataflow 17 / graph 20 / symbols 7 / lib 3）+ kode-scheduler 14，全 0 failed。

## 记账说明

本批复核：14 项勾账行与代码事实一致；八轮复审残余（AUD-008 接收者伪边 8c2b7411 →
函数内导入漏判 bc8a06cf → 文件级合并重开伪边 086f13c1 → 裸名键两缺陷 96a30607 →
遮蔽保放 3dcecb48 → 遮蔽/分层交互三缺陷 e61c7c2c → 推导式/重绑定位置语义三缺陷
b9edefd1 → 行序裁决不完备定版保守歧义契约 f3276040）已修并在 AUD-008 勾账行补证据，
AUD-006 勾账行补口径注明（静默截断，无环专项诊断）。报告 v1 的三处表述（14 计数
口径、debugpy/py-spy commit 归因、workspaceIndex :304 漂移）已按复审意见改到本版。
