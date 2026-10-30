# KBEngine 写法陷阱与 lint 规则

本页集中记录 KBEngine 特有的代码约束、引擎依据和 Kode 的检查边界。**源码里有这个约束、编辑器能提示这个类型、已经有 lint 诊断，是三件不同的事。** 表中的“待实现”不能作为已经交付的功能。

本轮引擎依据：本机 `kbengine` 仓库提交 `f85ad81`；Kode 审核基线 `bf26cbf`，其中 `hasattr` 漏报已在 `c351606` 修复。其他引擎分支应按源码符号重新核验，不能只信可能漂移的行号。

## 规则总表

文档编号用于追踪规范；“诊断 code”只填写实际已发布的代码。建议规则尚未注册为新的诊断 code，也没有自动加入检查。

| 规范编号 | 写法陷阱或约束 | 当前检查状态 | 诊断 / 实现依据 |
| --- | --- | --- | --- |
| KBE-PY-001 | 直接引用可能为 None 的 `self.cell/base/client` 成员 | 已有实时 Warning，复杂控制流仍有限制 | `kbengine.receiverNone`；`receiverNoneDiagnostics.ts` |
| KBE-PY-002 | 用 `hasattr(self, "cell")` 代替非空检查 | 已修复：继续报 None Warning | 同上；不能证明 EntityCall getter 的结果非 None |
| KBE-PY-003 | receiver 与 `.def` 方法声明段不匹配 | 已有实时 Warning，仅已知声明可判定 | `kbengine.sectionMismatch`；未知方法目前不因此报错 |
| KBE-PY-004 | `or`、条件早退、别名重赋值被误当作非空证明 | 部分实现，本轮复现漏报，待修 | guard 不是完整 Python 控制流分析 |
| KBE-PY-005 | 将注释/字符串里的 `self.cell.foo` 当作代码 | 目前有误报，待修词法过滤 | `pythonLanguageUtils.ts:findPythonReceiverCalls` |
| KBE-PY-006 | 接收者别名的实际使用，如 `peer = self.cell; peer.foo()` | 别名 guard 有局部支持；别名使用点诊断未完成 | 目前调用发现只认 `self.<role>.<name>` |
| KBE-PY-007 | 写入引擎只读属性，如 `self.id = 1` | 有 readonly 元数据/提示，专门赋值 lint 待实现 | `entityBuiltinProperties.ts`；`entity_macro.h` 和 Entity 属性注册宏 |
| KBE-PY-008 | 在错误角色访问引擎属性/API | 有角色属性/补全面，完整误用 lint 待实现 | baseapp/cellapp/client 分面；角色不明时不能猜 |
| KBE-PY-009 | RPC 参数数量/类型与 `.def` 不一致 | 有参数提示、签名与跳转；完整 lint 待实现 | `.def` 的 Arg 与 EntityCall 调用绑定后才能判断 |
| KBE-PY-010 | 销毁后或跨异步回调继续访问 Entity | 生命周期 lint 待设计 | `Entity::pyGetCellEntityCall` 等检查 destroyed；需控制流和生命周期证据，不能见到 destroy 就全文件报错 |
| KBE-DEF-001 | 未知 Type、Flags、DetailLevel | 已有实时校验；未知 Type 有稳定 code | `kbengine.unknownType`；`languageProviders.ts` |
| KBE-DEF-002 | 将多个 Flags 用 `\|` 拼接成组合值 | 已有未知 Flags 校验 | 引擎按单个映射值解析；分析器的容错拆分不代表引擎接受 |
| KBE-DEF-003 | 同域重复定义、缺少/重复必需字段 | 已有结构诊断 | `validateSectionStructure`、`validatePropertyStructure` |
| KBE-DEF-004 | `BOOL/BOOLEAN/TUPLE/MAP/FIXED_ARRAY` 等未注册类型 | 已有 `.def` 分析检查 | `defAnalyzer.ts:phantom-type`；类型是否存在以引擎注册表为准 |
| KBE-DEF-005 | 方法/属性/继承声明名称冲突、非法名称 | 已有按需分析检查 | `method-property-collision`、`inherited-name-collision`、`invalid-identifier`、`engine-limited-name` |
| KBE-DEF-006 | 重负载属性广播、无效 DetailLevel 配置 | 已有按需建议，非所有情况都是错误 | `heavy-sync-broadcast`、`redundant-detail-level` |
| KBE-DEF-007 | 类型别名、ARRAY、FIXED_DICT 的错误使用 | 有类型解析/提示；不能宣称所有形态有 lint | 对齐 `types.xml` 及实际引擎注册类型，未知来源保持未知 |
| KBE-DEF-008 | 更改 Parent/Interfaces/Components、持久化或 RPC 结构后当普通脚本 reload | 热更新已有闸门，但结构指纹不完整，待修 | `hotReloadDefStructure.ts` 当前主要覆盖 Properties 的 Type/Flags 与方法 Arg |
| KBE-DEF-009 | entities.xml 重复实体注册 | 已有实时 Warning | `entitiesXmlAnalysis.ts:duplicate-entity-name` |

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

后续赋值 lint 的最低验收：明确 Entity 身份与角色才检查 `self.id = ...`、增强赋值及 `del self.id`；普通 Python 类恰好有同名字段时不报；注释/字符串不报；继承自项目封装的 Entity 要按真实类型来源判断。**当前没有实现该赋值 lint，不应在功能清单打勾。**

## .def 检查的触发方式

- 实时结构诊断：`kbengine.enableDiagnostics`、`kbengine.enableStructureDiagnostics` 及 `kbengine.diagnostics.check*` 控制，打开/编辑文件时更新 Problems。
- Python receiver 诊断：`kbengine.receiverNoneDiagnostics=true`，默认开启，使用现有诊断调度器；关闭只停止提示，不改变引擎行为。
- `.def` 优化/继承冲突分析：按需运行分析入口，见 `defAnalyzer.ts` 和[语言能力](./language.md)。按需分析有规则不代表每次输入都会自动 lint。
- Hover、签名、inlay、CodeLens 是说明或导航界面；有提示内容不代表相应规则已做诊断。

## 新 lint 的交付条件

每条新规则必须登记：文档编号、实际诊断 code、适用角色、引擎提交与符号、触发器、严重度、开关、正例/反例、定位范围、修复行为及分析边界。规则覆盖表以源码和验收为准，不能只看 TODO 勾选。

实现约束：复用当前文档版本与共享解析；不执行用户 Python；不在 hover/补全中扫描仓库；事件风暴只发布最新版本；大文件检查可让路、可取消；规则查不到类型/声明时保留未知状态。项目级未知声明检查与本地语法检查分开，不用全仓同步解析弥补缺失信息。

快速修复必须能在真实 VS Code 应用且保持 Python 语法合法；处理多行调用、同一行多个 receiver、EOF、缩进和同级后续语句，不为了消除 Warning 擅自包住无关逻辑。自动包裹守卫可能改变流程，不应作为无条件自动保存修复。
