# KFLOW 三图产品契约(进程流转 / 静态调用路径 / 运行时调用栈)

日期:2026-11-14。todo.md FLOW-002(旧 KFLOW-CORE-02)交付。上位计划:docs/design/kbengine-semantic-precision-and-process-flow.md §5(形态级描述);本文档把它落成可检查的产品契约,FLOW-003 的节点/边协议以本契约为输入实施。

输入:FLOW-001 失败样本账本(docs/review/2026-11-14-kflow-001-graph-failure-samples.md:现任调用树只能展开链根实体本地方法、非法九面组合画边、合成 client 入边、未解析归属错误)+ 用户反馈「现有版本不可用」。

## 1. 三图定义

### G1 进程流转图(架构契约面)

- **回答的问题**:「在这个工程里,客户端与各服务端进程之间,引擎契约允许哪些调用与数据流动?」——架构关系,不是某次请求的执行过程。
- **数据模型(独立)**:参与方 = 进程角色(client/base/cell/db/aoi/其他已核实桥接进程);边 = 契约边(方法 Exposed 方向 / 属性旗标同步方向 / 持久化落点 / 已核实的引擎消息桥),每边带引擎出处(file:line);节点成员 = def 声明的方法/属性。
- **入口(独立)**:实体 def 文件 / 实体架构视图命令。数据源 = def/types 语义(BAS/RPC 提供),不依赖 Python 调用分析。
- **证据规则**:每条边必须有引擎契约出处;没有核实契约的进程(如 loginapp/dbmgr/interfaces 桥)不出现——禁止拓扑全连接(FLOW-009 验收同源)。
- **现状与处置**:entityFlowGraph(批124)的旗标语义面构造性正确(FLOW-001 审计结论),作为 G1 数据种子保留为**独立视图**;不得再作为执行图呈现。

### G2 静态调用路径(本地调用树)

- **回答的问题**:「从这个入口出发,静态分析能证明哪些调用**可能**发生?」——可能路径全集,不是执行记录。
- **数据模型(独立)**:节点 = 工程/资源根/角色/实体候选/函数(含源码位置);边 = 调用点(syntax anchor 必填)+ 方向 + 同步/异步 + 分支条件(候选标记)+ 消息/RPC 形态 + 证据 + 未解析原因(动态 getattr、未知 receiver、第三方/native 各有原因码)。同一函数被多次调用保留**多个调用点**,不压成一个帧(FLOW-005 验收同源)。递归环与深度截断显式标记。
- **入口(独立)**:编辑器函数/调用点上下文「打开调用图」命令;入口向下、调用者向上两种查询方向。
- **证据规则**:每条边携带调用点锚(文件/行/列);解析不了的边标未解析原因,**不静默消失、不猜唯一落点**(FLOW-011 验收同源)。跨进程边是**消息边**(发送→远端执行两段,独立边,不画成同步 Python 子栈,FLOW-007 验收同源)。
- **诚实边界**:分支是候选不是执行顺序;只声明 Exposed 而无客户端源码时最多证明「可调用入口」,不得生成客户端真实帧(FLOW-006 验收同源);静态分析不给出发生次数与全序。

### G3 运行时调用栈(执行事实面)

- **回答的问题**:「某次实际执行中,**真实**发生了什么?」——观察记录,不是推导。
- **数据模型(独立)**:trace 事件 = 会话/进程/线程/实体/时间/帧序(真实帧顺序)/消息关联 ID/来源(采集器标识)/丢失标记。单进程栈是栈;跨进程拼接是**因果链**,二者分别展示(FLOW-023 验收同源);无可靠关联 ID 时不声称确定因果,只展示候选并解释(FLOW-027 验收同源);串联消费面已交付:`src/backend/traceCorrelation.ts`(causal 只认 ID 相等/候选带解释/回调段=派发帧全等落地+parentSeq 子树;令牌适配发射面按 FLOW-026 设计待真实引擎联验另立项);采样栈不冒充完整请求轨迹(FLOW-022 验收同源)。协议面已交付:`src/backend/traceEventModel.ts`(FLOW-023)——来源/采样面配对表(setprofile/settrace/sys-monitoring→complete-within-window、py-spy-record→sampled、py-spy-dump/debugpy-stop→stop-only、log-evidence→sparse-points)、同步栈边(parentSeq/return 链)构造期限同进程同线程、跨进程因果唯一载体 correlationId(缺侧/不一致只给候选)、丢失标记计数入账;渠道能力边界以 [FLOW-022 核实报告](../review/2026-11-14-kflow-trace-01-feasibility.md)为准。
- **入口(独立)**:TRACE 采集/导入命令(FLOW-TRACE 泳道);采集为独立增量,默认不开启高开销全量 trace(FLOW-025 验收同源),不以静态图替代。受控采集入口已交付纯核心:`src/backend/traceCaptureController.ts`(默认关闭/显式启停/有界缓冲/开始结束异常丢弃记账)+ `src/backend/traceCaptureRun.ts`(子进程运行面,超时可关闭);UI 接线在 FLOW-028。
- **前置**:FLOW-022 先核实 debugpy/profile/引擎钩子/py-spy 各自能获取的数据与代价,再定采集面。

## 2. 防混淆红线(验收原文:「禁止将静态可能路径称为实际堆栈」的落地规则)

以下每条都是可检查规则,FLOW-003 协议与 FLOW-014+ UI 验收逐条对照:

| # | 红线 | 检查面 |
|---|---|---|
| R1 词汇 | G2 禁用「堆栈/栈帧/调用栈」词汇;G2 的帧称「候选帧/调用帧」,「栈帧(stack frame)」仅属 G3 | 数据模型字段名、UI 文案、命令名、文档 |
| R2 数据 | 证据字段分型:`evidence: syntax-anchor`(静态:调用点位置)vs `runtime-source`(运行时:采集器+时间);G2 模型无 runtime 证据位,G3 事件无候选语义位——两模型不共享基类不互相断言 | 协议 schema(FLOW-003)|
| R3 展示 | G2 不使用时序/顺序箭头语义(无执行顺序);G3 时间轴缺失**不得由 G2 推导补齐**;两图同屏时必须带各自来源标签 | FLOW-014+ 样图与面板验收 |
| R4 衔接 | G2 可作为 G3 回放(FLOW-028)的查询骨架,但对齐只走**因果关联边**(消息关联 ID,flow-023/027),禁止按「帧名相同/时间邻近」宣称因果 | TRACE 协议与回放验收 |
| R5 退役 | 旧 defCallChain 面在 FLOW-004/005 替换前如仍可达,UI 必须标「静态可能路径(旧)」;其 resolved=true 但实现体截断的呈现(FLOW-001 S5)视为误导形态,不再复用其渲染语义 | 过渡期 UI |

## 3. 入口登记表(三图独立,互不借用)

| 图 | 命令/入口 | 数据源 | 面板 |
|---|---|---|---|
| G1 | 实体架构视图(现有入口保留) | def/types 旗标语义 + 已核实引擎桥 | entityFlowWebView(改造为纯 G1 语义,移除执行暗示) |
| G2 | 编辑器函数/调用点「打开调用图」(FLOW-005 起新命令;旧 defCallChainProvider 命令过渡期保留带 R5 标签) | KFLOW-CORE 本地解析(FLOW-004)+ 角色化 RPC(FLOW-007/008/009)+ 引擎回调契约(FLOW-010) | 新泳道视图(FLOW-014+) |
| G3 | trace 导入/采集命令(FLOW-TRACE,单独立项) | debugpy/profile/引擎钩子/py-spy(以 FLOW-022 核实结论为准) | TRACE 视图(FLOW-028) |

三个入口共享的只有身份事实(KSEM-BAS:工程/资源根/实体/角色/组件/声明)与类型事实;**不共享图数据模型**——G1/G2/G3 之间无继承关系,渲染层可以同屏,数据层各自独立。

## 4. 与现有资产的关系

| 资产 | 处置 |
|---|---|
| `backend/entityFlowGraph.ts`(批124) | G1 数据种子,旗标/位值/引擎出处全保留;「是架构关系不是执行过程」的定位写进其文档头(现状已有) |
| `kode-python/callgraph.rs`(`$/kode/python/callgraph`) | G2 的候选边源之一;同名 callee 消歧在消费点(FLOW-001 盘点),FLOW-004 重做时以接收者可证明为唯一收边口径,不以方法名全局匹配 |
| `backend/defCallChain.ts` + `defCallChainProvider` + webview | 标记退役,FLOW-004/005 交付后由新解析替换;过渡期按 R5 标注;FLOW-001 失败样本(S1-S6)作为回归依据不得回退 |
| `entityCallGraphView` / `pythonCallGraphRust` | 函数级调用图,不是业务流转;归入 G2 的候选边源,不得独立冒充 G2 产品 |
| `entityFlowWebView` 现有泳道视觉 | 供 FLOW-014 样图参考;其「所有边一个箭头」形态违反 R3/FLOW-017,重做 |

## 6. 协议落地(FLOW-003)

G2 节点/边协议已落为纯协议模块 `src/backend/flowGraphModel.ts`(零 vscode 依赖):节点六面 = rootKey/role/instanceCandidates/entity/fn/declaration;边七面 = callSite/direction/syncAsync/condition/messageKind/evidence/unresolvedReason;§2-R2 证据分型以判别联合锁定(syntax-anchor/declaration-contract/external-source,无 runtime 型);§2-R1 以 external-entry 拒绝 fn 构造与「候选帧」词汇落地;边身份含调用点(同节点对多次调用=多条边);未解析节点/边构造器强制带原因码(九面非法 face-invalid-receiver、无客户端源 no-client-source 等十个码,含 FLOW-001 S1-S6 全谱)。协议钉:tests/flowGraphModel.test.ts。消费面在 FLOW-004(解析)/FLOW-005(展开)/FLOW-014+(呈现)接线。

## 7. 验收映射

验收原文「明确进程流转图、本地调用树/静态调用路径、运行时调用栈的独立数据与入口」→ §1 每图的数据模型/入口小节 + §3 登记表;「禁止将静态可能路径称为实际堆栈」→ §2 R1-R5。FLOW-003 节点/边协议(节点含工程/角色/实例候选/实体/函数/源码;边含调用点/方向/同步异步/条件/消息RPC/证据及未解析原因)以 §1-G2 与 §2-R2 为输入。
