# KBEngine 语义精度与跨进程流转计划

日期：2026-11-11。Kode 盘点基线：`4421a6c6`；本地引擎依据：`kbengine@3082ab5`。状态：**计划已整理，实施任务未验收**。

## 1. 目标和用户要求

把引擎声明与固定结构变成编辑器可用的确定性语义：cellData 的 key/类型/生命周期，实体与 RPC 角色，嵌套结构，序列化前后的对象与传输结构，配置 key/value 和消费代码。调用链按用户反馈重新立项：展示 Client 与各进程之间的一次业务流转，能展开本地调用帧，支持真实堆栈；不以只有函数节点的连线图交付。

本计划是完整范围记录，不代表现有功能全部缺失，也不代表所有 JSON/pickle 都有固定 schema。权威约束来自引擎源码、def/types、明确配置 schema 或项目契约；代码推导保留条件和未知。

## 2. 引擎依据与不能混淆的边界

源码路径以相邻工作区 `../kbengine` 为基准；行号仅用于本次定位，实施时按符号和提交重新核实。

| 契约 | 引擎证据 | 对实施的约束 |
| --- | --- | --- |
| cellData 初始化 | `kbe/src/server/baseapp/entity.cpp:250`，Entity::createCellData | 有 Cell 部件才创建；字段取 Cell 属性描述；组件另建 Cell 数据；额外加入 position/direction。 |
| Cell 获得后的属性可见性 | 同文件 `:1014`，onGetCell；destroyCellData | 脚本回调前删除 self.cellData；内部备份字典仍保留；创建调用异步，不能立刻视为有 Cell。 |
| 持久化回调参数 | 同文件 `:1397`，onWriteToDB | 参数来自内部 cellDataDict_，可能为 None；不等同脚本 self.cellData 可访问。 |
| 远程方法角色 | `kbe/src/lib/entitydef/entity_call.cpp:83` | 按 CELL/BASE/CLIENT 及转发类型查不同方法表；客户端受 Exposed 限制；组件另走槽解析。 |
| RPC 参数 | `kbe/src/lib/entitydef/method.cpp:72` | 参数数量和类型按 checkArgs，特殊 caller offset 必须区分上下文。 |
| 固定字典对象契约 | `kbe/src/lib/entitydef/datatype.cpp:2408/2435/2500/2596` | implementedBy 对象与字典通过 createObjFromDict/getDictFromObj 转换；普通 FIXED_DICT 检查键集合和字段类型。 |
| ENTITYCALL 类型 | 同文件 `:1484` | 接受 EntityCall、None 或实际 Entity；字段类型本身不指定 Avatar 等具体实体。 |
| 创建 API | `kbe/src/server/baseapp/baseapp.cpp:959` 起 | 各 API 返回与回调不同；params 开放性及字段路径须逐个核实。 |
| spaceData | `kbe/src/server/cellapp/spacememory.cpp:703` 起 | key/value 字符串及受保护 _mapping；空间身份不能丢失。 |

cellData 为普通 Python dict，允许脚本附加键。动态键、动态反射、复杂自定义序列化、不确定接收者均不能以猜测结果生成硬错误。JSON 解码没有普遍固定结构；pickle 恢复对象并不提供可静态枚举的字段契约。

## 3. 现有实现与本次差距

以下是源码盘点，未重新执行整套测试；“存在”不等于已验收完整用户路径。

| 方向 | 可复用代码 | 差距/待核实 |
| --- | --- | --- |
| cellData | `src/backend/propertyDirectionDiagnostics.ts`、propertyDirectionRust | 已有 key 类型/域位提示；全链结构传播、别名、生命周期和补全需逐入口核实。 |
| 结构类型 | `src/pythonTypeStubs.ts`、kode-types、wire_codec/schema.rs | TypedDict/别名及 wire 布局存在；wire 结构重解析注释指出类型图字段信息不足，需统一适配。 |
| RPC | rpcArgCountDiagnostics、kode-python/callgraph、entityMapping | 数量/方向及部分调用边已有；具体实体接收者、Arg 类型、跨进程真实落点尚需本计划验收。 |
| 自定义转换 | userTypeContractSource、kode-python/user_type_contract | 已有契约方法存在性；方法体输入/输出结构是否匹配未由存在性证明。 |
| 编解码 | kode-server/wire_codec、kode-kbengine-protocol、schema | 已有 wire 编解码与跨度；编辑器对象来源到编解码结构的语义传播为独立工作。 |
| 配置 | configDerive、serverConfigMerge/Resolve、serverConfigCatalog、configContractDiagnostics、schemas | 已有合并/注释/部分 schema/环境检查；不能称配置零覆盖；代码读取点与 schema 类型联动需盘点后扩展。 |
| 共享数据 | globalDataIndex、globalDataIndexCore | 已有引用/跳转/类型；补全、可用性、常量真实绑定与冲突需核实。 |
| 旧调用链 | defCallChain.ts、defCallChainProvider、webview/defCallChainViewer | 节点以 entity/section/method 为主，边只有 base/cell/client receiver；不足以表达帧、条件、消息因果和运行实例。 |
| Python 调用图 | pythonCallGraphRust、entityCallGraphView、kode-python/callgraph | 函数/调用边可复用；不能视为 Client/多进程业务流转或实际执行栈。 |
| 实体架构图 | backend/entityFlowGraph、entityFlowWebView | 描述 RPC 可达、属性同步和持久化规则；是架构关系，不是某次请求的执行过程。 |

历史 B-4/C-20 等勾项保留其原交付范围；新用户反馈另立 KFLOW 任务，不沿用历史完成状态抵扣。

## 4. 共同语义模型

建议在现有 crate 边界内落实，不预先强制新增 crate。Rust 负责语义事实及查询，TS 负责文档/工作区输入、交互和呈现。复用现有类型、schema、索引和协议；避免又建一套互不联动的解析器。

- 身份：工程/资源根/引擎版本/实体/角色/组件/声明，区分静态角色和运行实例。
- 类型：保留逻辑字段、传输字段序、范围、可空、联合、开放结构与未知。
- 来源：AST 表达式、局部写点、别名、调用点、分支和文档版本；同行语句按完整位置排序。
- 事实：声明确定、代码推导、未知/冲突，并保留证据路径。单个置信数字不能替代来源。
- 图：节点和调用点身份分离；边区分同步调用、异步消息、引擎回调、广播和未解析外部边。
- 增量：语义快照带版本，查询不等全仓重扫；依赖边驱动精确失效。

## 5. 调用链重做的交付形态

默认从编辑器函数/调用点进入一个业务场景，以 Client、Base、Cell 和实际涉及的其他进程为泳道。跨进程边显示 RPC、方向、参数类型和声明来源；点击泳道内节点能展开本地 helper 调用树，并跳到调用点或实现。递归、分支、动态边、截断都可见。

静态模式展示可能路径，不能给出真实发生次数或全序。只声明 Exposed 而没有客户端源码，最多证明可调用入口，不能生成客户端真实帧。dbmgr/interfaces/loginapp 等桥接只有找到实际 API/消息/回调契约才加入。架构图可以作为单独视图保留，但不再冒充执行图。

运行时模式另行采集真实帧和事件；单进程栈是栈，跨进程拼接是因果链，二者分别展示。没有可靠消息关联 ID 时不声称确定因果；跨机器时间戳不能独自决定全序。实现采集需先核实当前引擎/调试协议能力，再选择最小适配方案。

## 6. 固定格式与配置的实施边界

序列化分析分别检查逻辑对象、转换字典、wire 布局、解码对象四层，不能仅凭编解码成功认定对象正确。implementedBy 的三个契约方法存在不代表往返正确。项目 JSON、自定义 pack/unpack 先接显式 schema，再做有界静态构造推导；动态字段形成开放结构。

配置分别处理引擎 defaults/custom、kode 自身配置和项目业务配置。默认 XML 值用于默认说明，类型/范围/枚举应有读取代码或 schema 依据。有效值展示覆盖来源；代码侧 cfg[key] 获取同一 schema 的类型、跳转和引用；环境覆盖和敏感值有单独表示。配置消费者不执行用户脚本来获取结构。

## 7. 实施顺序及验收

第一批：BAS 的最小基础 + CELL + STRUCT 必需子集 + SER 的 implementedBy 双向结构，先解决用户可见的固定 key/type；CFG 权威契约盘点可同步开展。

第二批：RPC 接收者身份 + KFLOW-CORE 本地调用树和跨角色连接 + KFLOW-UI，交付可读的 Client→Base→Cell→Client 场景图。与第一批共享身份和类型结果。

第三批：序列化项目 schema/配置消费联动、CREATE/DATA；TRACE 作为真实栈与因果追踪增量，有独立采集验收，不阻塞静态图首版。

任务以 todo.md 的未勾项为唯一完成账本。每项目标尽量控制在半天内；若源码核实后发现超出，先拆出更小的子项再实现，不能用一条“大功能完成”掩盖未验收部分。任何一项只有生产接线、正反例、未知边界及对应证据通过后才勾；盘点项交付盘点文档即可，不冒充功能落地。每批跑相关 Rust/TS 测试，用户路径在真实 VS Code 验证；文档整理阶段不宣称代码测试通过。

性能阈值在测试前登记：端到端冷/热态、索引忙时、超时降级、连续编辑和大图展开分别计量；P50/P95/P99 与资源上限记录原始证据。现有 hover/definition 目标可作为输入，不能把旧报告当新功能验收。

## 8. 原子任务索引

以下只列分组、依赖和 ID 范围。所有勾选状态仅维护在 [项目 TODO](../../todo.md#kbengine-semantic-plan)，不建立第二套重复勾账。

- **KSEM-BAS**：共同语义基础，10 项（`KSEM-BAS-01` 至 `KSEM-BAS-10`）；依赖：无；先完成本组，再按各组依赖推进。
- **KSEM-CELL**：cellData 结构和生命周期，15 项（`KSEM-CELL-01` 至 `KSEM-CELL-15`）；依赖：BAS-03..08；先结构再推导与诊断。
- **KSEM-STRUCT**：嵌套结构类型传播，8 项（`KSEM-STRUCT-01` 至 `KSEM-STRUCT-08`）；依赖：BAS-04..07；与 CELL 共用类型系统。
- **KSEM-RPC**：实体身份和跨角色 RPC，9 项（`KSEM-RPC-01` 至 `KSEM-RPC-09`）；依赖：BAS 身份/类型/来源；FLOW 复用此结果。
- **KSEM-CREATE**：创建 API 与回调类型，6 项（`KSEM-CREATE-01` 至 `KSEM-CREATE-06`）；依赖：BAS + RPC；逐 API 契约核实后实施。
- **KSEM-SER**：固定格式序列化和反序列化，14 项（`KSEM-SER-01` 至 `KSEM-SER-14`）；依赖：BAS + STRUCT；优先引擎契约，项目格式需显式来源。
- **KSEM-CFG**：固定配置 key/value 与配置消费代码，11 项（`KSEM-CFG-01` 至 `KSEM-CFG-11`）；依赖：BAS + STRUCT；复用 configDerive/merge/catalog/schema。
- **KSEM-DATA**：共享数据与空间数据，6 项（`KSEM-DATA-01` 至 `KSEM-DATA-06`）；依赖：BAS + STRUCT；承接已有 globalDataIndex。
- **KFLOW-CORE**：重做 Client 与进程流转模型及本地调用树，13 项（`KFLOW-CORE-01` 至 `KFLOW-CORE-13`）；依赖：用户反馈现有版本不可用；BAS/RPC 提供身份，不以旧图完成项抵扣。
- **KFLOW-UI**：进程泳道和可展开调用堆栈视图，8 项（`KFLOW-UI-01` 至 `KFLOW-UI-08`）；依赖：KFLOW-CORE 协议稳定；用户要求为实际流程可读。
- **KFLOW-TRACE**：真实调用栈与跨进程运行时追踪，8 项（`KFLOW-TRACE-01` 至 `KFLOW-TRACE-08`）；依赖：静态路径先交付；采集为单独增量，不以静态图替代。
- **KSEM-QA**：分批验收与文档交付，6 项（`KSEM-QA-01` 至 `KSEM-QA-06`）；依赖：每个能力批次单独执行，不等全部实现。

## 9. 未核实事项

运行时跨进程关联字段、不同创建 API 的完整回调签名、所有内建 CellData 键、项目自定义编码/配置函数及客户端语言适配尚未穷尽核实，已分别列任务。未提供用户现场调用栈/示例失败链，KFLOW-CORE-01 需从项目复现获取，不能在本计划中虚构。源代码基线变化后需重新核实来源。
