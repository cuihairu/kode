# KBEngine 写法陷阱与 lint 规则

本页集中记录 KBEngine 特有的代码约束、引擎依据和 Kode 的检查边界。**源码里有这个约束、编辑器能提示这个类型、已经有 lint 诊断，是三件不同的事。** 表中的“待实现”不能作为已经交付的功能。

本轮引擎依据：本机 `kbengine` 仓库提交 `f85ad81`；Kode 审核基线 `bf26cbf`，其中 `hasattr` 漏报已在 `c351606` 修复。其他引擎分支应按源码符号重新核验，不能只信可能漂移的行号。

## 规则总表

文档编号用于追踪规范；“诊断 code”只填写实际已发布的代码。建议规则尚未注册为新的诊断 code，也没有自动加入检查。

本表在源码中的单一事实源是 `src/lintRuleRegistry.ts`（IDE-LINT-011）：每条规则登记 code/严重度/角色/开关/触发入口/修复支持/实现状态/源码模块，一致性测试（`tests/lintRuleRegistry.test.ts`）钉住「已注册 = 真的发出诊断」（code 必须出现在真实 src 模块）与「无孤儿开关」（package.json 每个诊断类配置键都被至少一条规则引用）。命令面板 **Show Lint Rules Capability Report**（`kbengine.lintRules.showReport`）随时输出按当前配置渲染的规则清单（输出通道 `Kode Lint Rules`），已启用集合与 Problems 面板一致。

| 规范编号 | 写法陷阱或约束 | 当前检查状态 | 诊断 / 实现依据 |
| --- | --- | --- | --- |
| KBE-PY-001 | 直接引用可能为 None 的 `self.cell/base/client` 成员 | 已有实时 Warning，复杂控制流仍有限制 | `kbengine.receiverNone`；`receiverNoneDiagnostics.ts` |
| KBE-PY-002 | 用 `hasattr(self, "cell")` 代替非空检查 | 已修复：继续报 None Warning | 同上；不能证明 EntityCall getter 的结果非 None |
| KBE-PY-003 | receiver 与 `.def` 方法声明段不匹配 | 已有实时 Warning，仅已知声明可判定 | `kbengine.sectionMismatch`；未知方法目前不因此报错 |
| KBE-PY-004 | `or`、条件早退、别名重赋值被误当作非空证明 | 部分实现，本轮复现漏报，待修 | guard 不是完整 Python 控制流分析 |
| KBE-PY-005 | 将注释/字符串里的 `self.cell.foo` 当作代码 | 目前有误报，待修词法过滤 | `pythonLanguageUtils.ts:findPythonReceiverCalls` |
| KBE-PY-006 | 接收者别名的实际使用，如 `peer = self.cell; peer.foo()` | 别名 guard 有局部支持；别名使用点诊断未完成 | 目前调用发现只认 `self.<role>.<name>` |
| KBE-PY-007 | 写入引擎只读属性，如 `self.id = 1` | 已实现（IDE-LINT-007）：普通/增强/注解赋值与 `del` 报 Warning，可写属性与非实体同名字段不报 | `kbengine.readOnlyWrite`；`readOnlyWriteDiagnostics.ts`（表 `entityBuiltinProperties.ts`，注册面 `entity_macro.h` 等） |
| KBE-PY-008 | 在错误角色访问引擎 API（方法） | 仅 hover/补全元数据（角色面表未建立）；属性错用已由 KBE-PY-008b 实现 | `kbengine.entity.builtinProperties`；API 保持仅提示 |
| KBE-PY-008b | 在错误角色访问引擎属性 | 已实现（IDE-LINT-009）：`self.<内建属性>` 注册于其他角色面而当前面没有时报 Warning，引注册面引擎源码取证；角色不明/非实体脚本/非内建属性不报 | `kbengine.roleMisuse`；`roleMisuseDiagnostics.ts`（属性面表取 `entityBuiltinProperties.ts`，与 hover 元数据同源） |
| KBE-PY-009 | RPC 参数数量/类型与 `.def` 不一致 | 已有实时 Warning（参数数量）；类型不符仍只有签名/提示面 | `kbengine.rpcArgCount`；`rpcArgCountDiagnostics.ts` |
| KBE-PY-010 | 销毁后或跨异步回调继续访问 Entity | 已实现（IDE-LINT-010）：同函数同块内确定的 `self.destroy()` 之后直接访问 `self.<成员>` 报 Warning；条件销毁/跨块/跨回调/异常/def 声明 destroy（动态分派）不猜 | `kbengine.postDestroy`；`postDestroyDiagnostics.ts`（引擎 `entity_macro.h:20` destroy 宏公共） |
| KBE-PY-011 | 用户自管 `self.<attr>` 含 None 且未窄化（如构造期赋值被早退绕过） | 已有实时 Warning | `kbengine.attributeNone`；`selfAttributeNoneDiagnostics.ts` |
| KBE-PY-012 | def 属性访问方向违规（访问位置不在 Flags 域位内） | 已有实时 Warning | `kbengine.propertyDirectionViolation`；`propertyDirectionDiagnostics.ts` |
| KBE-PY-012b | 属性方向判定文件作用域不足（降级参考信息） | 已有实时 Information | `kbengine.propertyDirectionScopeUnknown`；同上 |
| KBE-PY-013 | 空间/导航语义（保留键 `_mapping`、无 `canNavigate` 的 `navigate`、键类型） | 已有实时 Warning | `kbengine.spaceNav`；`spaceNavDiagnostics.ts` |
| KBE-PY-014 | 启动脚本启动行未知 `--` 参数、非数字 `--cid/--gus`、未赋值引用 | 已有实时 Warning | `kbengine.startupScript`；`kbengineStartupScript.ts` |
| KBE-DEF-001 | 未知 Type、Flags、DetailLevel | 已有实时校验；未知 Type 有稳定 code | `kbengine.unknownType`；`languageProviders.ts` |
| KBE-DEF-002 | 将多个 Flags 用 `\|` 拼接成组合值 | 已有未知 Flags 校验 | 引擎按单个映射值解析；分析器的容错拆分不代表引擎接受 |
| KBE-DEF-003 | 同域重复定义、缺少/重复必需字段 | 已有结构诊断（发布时**不带诊断 code**，与其余规则不同；受结构开关与重复/必需字段子开关共同控制） | `validateSectionStructure`、`validatePropertyStructure`；`kbengine.enableStructureDiagnostics`/`checkDuplicateDefinitions`/`checkMissingPropertyFields` |
| KBE-DEF-004 | `BOOL/BOOLEAN/TUPLE/MAP/FIXED_ARRAY` 等未注册类型 | 已有 `.def` 分析检查 | `defAnalyzer.ts:phantom-type`；类型是否存在以引擎注册表为准 |
| KBE-DEF-005 | 方法/属性/继承声明名称冲突、非法名称 | 已有按需分析检查 | `method-property-collision`、`inherited-name-collision`、`invalid-identifier`、`engine-limited-name` |
| KBE-DEF-006 | 重负载属性广播、无效 DetailLevel 配置 | 已有按需建议，非所有情况都是错误 | `heavy-sync-broadcast`、`redundant-detail-level` |
| KBE-DEF-007 | 类型别名、ARRAY、FIXED_DICT 的错误使用 | 有类型解析/提示；不能宣称所有形态有 lint | 对齐 `types.xml` 及实际引擎注册类型，未知来源保持未知 |
| KBE-DEF-008 | 更改 Parent/Interfaces/Components、持久化或 RPC 结构后当普通脚本 reload | 热更新已有闸门，但结构指纹不完整，待修 | `hotReloadDefStructure.ts` 当前主要覆盖 Properties 的 Type/Flags 与方法 Arg |
| KBE-DEF-009 | entities.xml 重复实体注册 | 已有实时 Warning | `entitiesXmlAnalysis.ts:duplicate-entity-name` |
| KBE-DEF-010 | `user_type` 三契约方法缺失（createObjFromDict/getDictFromObj/isSameType） | 已有实时 Error | `kbengine.userTypeContractMethodMissing`；`userTypeContract.ts`；随主诊断开关 |
| KBE-DEF-011 | def 声明方法在 Python 缺实现 | 已有实时 Warning | `def-method-missing-in-python`；`defMethodConsistency.ts` |
| KBE-DEF-012 | Python 方法在 def 无声明 | 已有实时 Warning | `kbengine.pythonMethodNotInDef`；`defMethodConsistency.ts` |
| KBE-DEF-013 | 进程拓扑定义与定义期错配预警 | 已有实时 Warning | `kbengine.processTopology`；`processTopologyDiagnostics.ts` |
| KBE-CFG-001 | 工作区配置层:debug.json components 空/缺(unparsable/telnet 段整段被注释同族) | 已有实时 Warning | `kbengine.configContract.debugComponentsEmpty`；`configContractDiagnostics.ts` |
| KBE-CFG-002 | 工作区配置层:已知组件 telnet 端口缺失或偏离引擎默认(31000/32000/40000/50000 等) | 已有实时 Warning | `kbengine.configContract.debugTelnetPortMismatch`；`configContractDiagnostics.ts` |
| KBE-CFG-003 | 工作区配置层:extraPaths 双层上跳(`../..`)或指向不存在目录 | 已有实时 Warning | `kbengine.configContract.extraPathsDoubleUp`；`configContractDiagnostics.ts` |
| KBE-CFG-004 | 工作区配置层:.gitignore 缺 `.kbengine/` 托管目录条目 | 已有实时 Warning | `kbengine.configContract.gitignoreMissingKbengine`；`configContractDiagnostics.ts` |
| KBE-CFG-005 | 工作区配置层:CLAUDE.md/README 声明的 telnet 密码/端口与 debug.json 实值冲突 | 已有实时 Warning | `kbengine.configContract.telnetPasswordDocConflict`；`configContractDiagnostics.ts` |

## EntityCall 判空：属性存在不代表另一端存在

引擎 `server/baseapp/entity.cpp` 注册 `cell/client` getter；`Entity::pyGetCellEntityCall`、`Entity::pyGetClientEntityCall` 在对应 EntityCall 指针为空时走 `S_Return`。`lib/pyscript/scriptobject.h` 定义 `S_Return` 返回 Python `None`。因此这既可能发生在失去对端之后，也可能发生在对端尚未创建时，不能只理解为玩家离线。

下面的写法仍应有 Warning：

```python
if hasattr(self, "cell"):
    self.cell.send()  # getter 存在，但结果仍可能为 None
```

最小改法：

```python
if self.cell is not None:
    self.cell.send()
```

如果后续代码只依赖保存下来的接收者，更清晰的写法是先取值再检查：

```python
peer = self.cell
if peer is not None:
    peer.send()
```

最后一例是推荐的代码形态，但当前别名使用点追踪还不完整。不能因为编辑器没有警告，就推断它已经做了完整数据流验证。取得非空引用也不保证远端进程始终存活或 RPC 一定执行成功；lint 这里只检查本地引用 None 风险。

## 哪些条件可以证明安全

| 代码形态 | 应有结论 | 当前限制 |
| --- | --- | --- |
| `if self.cell: self.cell.send()` | 分支内已判空 | 简单形态已有支持 |
| `if ok and self.cell:` 的分支体 | 已判空 | 简单同一行条件已有支持 |
| `if ok or self.cell:` 的分支体 | 仍可能为 None | 多行简单形态会报，同行形态本轮发现漏报 |
| `if self.cell is None: return` 后继续 | 可证明早退时已判空 | 当前只做形态分析，不能正确处理所有嵌套路径 |
| None 分支内仅某个子分支 return | 不能证明安全 | 本轮复现漏报，待修 |
| None 分支里 `print("return")` | 不能证明早退 | 本轮复现关键字文本误判，待修 |
| `peer = self.cell` 后将 `peer` 改成其他对象再 `if peer:` | 不能证明 self.cell 非空 | 别名失效追踪待修 |
| 检查后经过 `await/yield`、回调或可能改变生命周期的操作 | 需要重新分析 | 不能无限沿用旧 guard；完整检查尚未交付 |

复杂表达式、嵌套函数、异常路径和多行条件需要词法/语法及控制流支持。后续 lint 必须偏向保留警告，而不是把不确定条件认成安全；同时提供明确的局限说明，避免将启发式 Warning 包装成类型证明。

## RPC 路由与 None 是独立检查

在 Kode 的接收者映射中，`self.base`、`self.cell`、`self.client` 分别对应 `BaseMethods`、`CellMethods`、`ClientMethods`。只有已解析且归属于当前实体的声明，才能用来判断段错配。

```python
if self.cell is not None:
    self.cell.login()  # 若 login 只在 BaseMethods 声明，仍有段错配
```

补判空不能修复路由错误，所以段错配诊断不能提供“插入 None 守卫”作为修复。方法声明缺失、继承/组件未解析、外部根未就绪时，应先报告信息不足或走回退，不能随意判定接口不存在。

## 只读属性与角色

`entityBuiltinProperties.ts` 已按 baseapp/cellapp/client 收集属性与 readonly 标记；例如 `id`、`isDestroyed`、`className` 和部分 EntityCall 属性是只读面。`position`、`direction` 等可写性要按角色看，不能把一个角色的规则复制给全部脚本。

已实现（IDE-LINT-007）：明确 Entity 身份与角色才检查——文件段（`base`/`cell`/`client`）定面，段面判不出经 `.def` 归属面，多面歧义只兜底宏公共三项；`self.id = ...`、增强赋值、注解赋值及 `del self.id` 报 `kbengine.readOnlyWrite`（Warning）；普通 Python 类恰好有同名字段（非实体脚本）不报；注释/字符串经词法掩码不报；比较（`==`/`<=`）、海象（属性目标非法）、属性续写（`self.<prop>.x`，非重绑定）与下标写（`self.<prop>[i]=x`）不报；每处命中引引擎注册面 file:line。已知边界（与同族 self-属性 lint 一致）：嵌套非实体类内的同名 `self.<p>` 不单列（文件级身份判定）；`del (self.<p>)` 与 `del self.<p>, x` 的第二项不报（括号/逗号前缀形态）。

## RPC 参数数量：绑定当前 section 的 Arg 才判

已实现（IDE-LINT-008）：`self.base/cell/client.<method>(...)` 调用点按**顶层实参数**与 `.def` 该方法在**调用所属 section**（`BaseMethods`/`CellMethods`/`ClientMethods`）声明的 `<Arg>` 数对账，明确数量不符报 `kbengine.rpcArgCount`（Warning）；`.def` 里 Arg 的直文本即参数（KBEngine def 方法参数不具名，只列类型），Arg 个数即声明参数个数。

只报**明确不符**，以下保留未知一律不报：

- **声明未就绪**：实体/根映射查不到该方法声明，或该方法声明的 Arg 数各来源不一致（同名跨实体/组件多来源，歧义）；`declaredArgs` 缺失（无 Arg 信息）。
- **段外声明**：方法只在别的 section 声明（经当前接收者侧调用不会路由到），由 `kbengine.sectionMismatch` 单独报，此处不重复。
- **星号参数**：调用点顶层任一实参段首以 `*` 开头（`*args`/`**kw` 解包或收集，数量不可判定），或声明 Arg 直文本以 `*` 开头。顶层 `a * b` 的二元乘法星号不触发（只认实参段首星号）；嵌套括号内的星号不影响外层实参计数。
- **动态接收者**：非 `self.<role>.<name>` 形态（别名 `peer = self.cell; peer.foo()`、局部变量接收者）本就不在发现面，天然未知。
- **括号不闭合**到文件尾、方法名与 `(` 之间有其他 token：形态不明，未知。

实现口径：调用点发现面走词法掩码（去字符串/注释里的伪调用，`findPythonReceiverCalls` 同款）；实参计数面走原文并自带字符串/注释词法态（字符串里的逗号不当分隔，`countCallArguments`）——掩码把字符串整体空白会吞掉字符串实参导致计数偏少，故计数面不复用掩码。跨行调用按括号深度计数到配对 `)`；空括号计 0；尾随逗号不多计。参数数量**类型**不符仍只有签名/提示面（`kbengine.rpcArgCount` 只对数量），inlay 提示不替代诊断。开关 `kbengine.rpcArgCountDiagnostics=true`（默认开启），关闭只停止提示，不改变引擎行为。

## 角色错用：属性面表有据可查才判

已实现（IDE-LINT-009，KBE-PY-008b）：实体脚本里 `self.<内建属性>` 访问当前角色面（baseapp/cellapp/client）**未注册**该属性、但属性注册于**其他面**时报 `kbengine.roleMisuse`（Warning），每条命中引注册面引擎源码 file:line 取证（`position` 注册于 cellapp/client，在 base 脚本访问即错用）。角色判定与内建属性 hover/inlay 同一底座：文件段（`base`/`cell`/`client`）定面，段面判不出经 `.def` 归属面，多面歧义只兜底宏公共三项——那三项各面都注册，不可能错用，故歧义零产出；角色不明（非实体脚本/无 def 归属）与普通 Python 类不猜。属性面表复用 `entityBuiltinProperties.ts`（与 hover 元数据**同源**，同一张表）。

已知边界（与同族 self-属性 lint 一致）：嵌套非实体类内的同名 `self.<p>` 不单列（文件级身份判定）；`self.<prop>` 仅单段——`self.cell.position` 等多段访问是 EntityCall 成员面，不参与（由 receiver/段错配负责）；引擎实体 **API**（方法，如 `teleport`/`addTimer`）的角色面表尚未建立，API 错用保持仅 hover/补全元数据，不冒充已实现。开关 `kbengine.roleMisuseDiagnostics=true`（默认开启），关闭只停止提示，不改变引擎行为。

## 销毁后访问：同函数同块可确定才判

已实现（IDE-LINT-010，KBE-PY-010）：引擎事实——`destroy` 是各面实体宏公共方法（`entity_macro.h:20` `SCRIPT_METHOD_DECLARE("destroy", pyDestroyEntity, ...)`），`self.destroy()` 销毁自身；销毁后各 getter（如 `Entity::pyGetCellEntityCall`）检查 destroyed，访问即异常。判定：同一函数内同一块（同缩进，中间无 dedent）的销毁语句（整句 `self.destroy()` 或 `x = self.destroy()`）先于访问语句，且两者间无同层 `return`/`break`/`continue`/`raise`（无条件早退，访问为死码）→ 报 `kbengine.postDestroy`（Warning）。成员集：排除 `id`/`isDestroyed`/`className`（销毁后仍可读的身份/状态项，读 `isDestroyed` 正是确认销毁）与 `destroy`（重复销毁非本 lint 面向的访问错用），其余任何成员（属性/方法/EntityCall）访问都报。

已知边界（不冒充已实现）：销毁在访问之后、条件销毁（`if`/`while` 内）、销毁在祖先块而访问在嵌套块（或反之）、跨函数/跨回调（回调里销毁，另一回调访问）、异常路径（销毁抛错未完成）、动态分派（def 声明 `destroy` 方法/属性 → `self.destroy()` 可能非引擎销毁，整文件不分析）——均不报，不做全文件误报；`self.<prop>` 仅 `self.` 单段前缀（`other.destroy`/`self.cell.destroy` 非销毁自身，不参与）。开关 `kbengine.postDestroyDiagnostics=true`（默认开启），关闭只停止提示，不改变引擎行为。

## .def 检查的触发方式

- 实时结构诊断：`kbengine.enableDiagnostics`、`kbengine.enableStructureDiagnostics` 及 `kbengine.diagnostics.check*` 控制，打开/编辑文件时更新 Problems。
- Python receiver 诊断：`kbengine.receiverNoneDiagnostics=true`，默认开启，使用现有诊断调度器；关闭只停止提示，不改变引擎行为。
- 只读属性写入诊断：`kbengine.readOnlyWriteDiagnostics=true`，默认开启，走现有诊断调度器（独立集合 `kbengine-readonly-write`）；关闭只停止提示，不改变引擎行为。
- RPC 实参数量诊断：`kbengine.rpcArgCountDiagnostics=true`，默认开启，与 receiver/attr 同通道（集合 `kbengine`）发布；关闭只停止提示，不改变引擎行为。
- 角色错用诊断：`kbengine.roleMisuseDiagnostics=true`，默认开启，走现有诊断调度器（独立集合 `kbengine-role-misuse`）；关闭只停止提示，不改变引擎行为。
- 销毁后访问诊断：`kbengine.postDestroyDiagnostics=true`，默认开启，走现有诊断调度器（独立集合 `kbengine-post-destroy`）；关闭只停止提示，不改变引擎行为。
- `.def` 优化/继承冲突分析：按需运行分析入口，见 `defAnalyzer.ts` 和[语言能力](./language.md)。按需分析有规则不代表每次输入都会自动 lint。
- Hover、签名、inlay、CodeLens 是说明或导航界面；有提示内容不代表相应规则已做诊断。

## 新 lint 的交付条件

每条新规则必须登记：文档编号、实际诊断 code、适用角色、引擎提交与符号、触发器、严重度、开关、正例/反例、定位范围、修复行为及分析边界。规则覆盖表以源码和验收为准，不能只看 TODO 勾选。

实现约束：复用当前文档版本与共享解析；不执行用户 Python；不在 hover/补全中扫描仓库；事件风暴只发布最新版本；大文件检查可让路、可取消；规则查不到类型/声明时保留未知状态。项目级未知声明检查与本地语法检查分开，不用全仓同步解析弥补缺失信息。

快速修复必须能在真实 VS Code 应用且保持 Python 语法合法；处理多行调用、同一行多个 receiver、EOF、缩进和同级后续语句，不为了消除 Warning 擅自包住无关逻辑。自动包裹守卫可能改变流程，不应作为无条件自动保存修复。

receiver-none 守卫修复的边界已按此在真实 VS Code 验收（IDE-LINT-012）：多行调用（括号未闭合续行）整体纳入包裹、续行重缩进连贯；同一行两个不同 receiver 各诊断各得各的守卫——receiver 从诊断自身方法名区间提取（`receiverFromDiagnosticLine`），不取行首个 `self.<receiver>.`，第一个 receiver 的修复不会套到第二个的诊断上；EOF（末行使用、无尾换行）包裹与早退都应用成功、位置不越界；包裹把同级与更深语句整体进一级、在首个不引用本 receiver 的同级语句处截断，无关后续行逐字节不变（证据 `docs/perf/2026-11-06-lint-quickfix-boundaries-run.txt`）。
