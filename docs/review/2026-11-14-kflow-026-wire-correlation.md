# KFLOW-026(FLOW-026)跨进程关联方案核实

日期:2026-11-14。任务:todo.md FLOW-026「验证跨进程关联方案。验收:核实消息是否已有可用关联 ID;没有则设计显式可选引擎/脚本适配,未经协议核实不得擅改 wire 消息。」

红线:本文只核实与设计,**不改 wire**。结论基于本机引擎源码实读(BigWorld-Engine fork,`~/workspaces/kbengine` @ 55a6655,kbe/src 全树),所有断言带 file:line 出处可回查;FLOW-022 报告 §C 的待核实项(「消息是否已有可用关联 ID 归 FLOW-026 核实,本文不预判」)在此收口。

## 1. wire 逐消息帧核实(发送→转发→接收全链实读)

### 1.1 发送帧(实体远程方法调用)

`RemoteEntityMethod::tp_call`(kbe/src/lib/entitydef/remote_entity_method.cpp:44-89)的出包序列:

1. `methodDescription->checkArgs(args)`(:55)——按 def 声明的参数表核对,**多传/少传直接拒**(`checkArgs error` ERROR_MSG 后丢弃调用,:81-87);这就是「偷渡关联令牌参数」不可行的构造性证据;
2. `methodDescription->addToStream(mstream, args)`(:62)→ `MethodDescription::addToStream`(kbe/src/lib/entitydef/method.cpp:146-171)写入:**utype_(uint32 方法 UID)或 aliasID_(uint8 别名)** + 逐参数(`argTypes_[i]->addToStream`,:174)——参数就是脚本层参数原样序列化;
3. `entityCall->newCall(bundle)`(:78)→ `EntityCallAbstract::newCall_`(kbe/src/lib/entitydef/entitycallabstract.cpp:65-113)写入:**消息头(onRemoteMethodCall / onEntityCall / onRemoteCallCellMethodFromClient,按 componentID 路由)+ entityID(`bundle << id_`,:101/:109)+ 服务端间加 mailbox type_(:104)**。

**发送帧全部字段 = {msgID, entityID, [mailboxType], [componentPropertyUID], utype/aliasID, 脚本参数}。没有请求序号、没有关联 ID、没有时间戳。**

### 1.2 转发帧

`kbe/src/lib/server/common.h:15-48` 转发宏族:`NETWORK_ENTITY_MESSAGE_FORWARD_CLIENT/CELLAPP` 只附 `<< ENTITYID`(:23/:32);通用转发附 `<< MYCOMPONENT_ID << FORWARD_COMPONENT_ID`(:16)。转发不注入任何逐请求标识。

### 1.3 接收帧

`Entity::onRemoteMethodCall`(kbe/src/server/baseapp/entity.cpp:888-)读序:`componentPropertyUID`(:902)→ `utype`(:907)→ `findBaseMethodDescription(utype)`(:930)→ 外部通道校验 srcEntityID(:943-953)→ 按方法名取 pyFunc,以**流里原样参数**调脚本。引擎侧分发上下文 `EntityDef::context()` 只有 `currEntityID`(kbe/src/lib/entitydef/entitydef.h:218-223,接收方自己的实体 id)——**没有 callerID、没有关联 ID 传给脚本**。

### 1.4 协议头与数据包头

`MessageHandler` 字段 = name/msgID/pArgs/msgLen/exposed(kbe/src/lib/network/message_handler.h:45-53);`Packet` = msgID + MemoryStream 语义(packet.h:28-35)。全树 grep `correlation|requestID|reqID` 零命中(2026-11-14 实测)。

### 1.5 广播面

`allClients/otherClients` 属性广播走 ED_FLAG_ALL_CLIENTS/ED_FLAG_OTHER_CLIENTS 标志族(kbe/src/lib/entitydef/common.h:22-47);一次发送、cellapp 扇出,**没有逐接收者身份**——广播连「谁收到了」都不在 wire 上。

### 1.6 脚本 API 面

demo 资产 pyi 全库无关联参数(tests/fixtures/kbengine-demo-assets/scripts/base/Account.pyi:19-33:引擎回调 `onClientEnabled()` 无参、`onTimer(timerHandle, userData)` 定签名);timerHandle 是本地定时器句柄,不跨进程。

## 2. 现有 ID 盘点与裁定

| wire 上的标识 | 语义 | 可否作跨进程请求关联 |
|---|---|---|
| entityID | 参与者(实体)身份 | 否——同一对实体间连续 N 次调用不可区分 |
| componentID | 进程身份 | 否——进程级,非请求级 |
| utype/aliasID | 方法身份 | 否——同名方法重复调用不可区分 |
| mailbox type | 落点类型(base/cell/client) | 否——只有类型 |
| timerHandle | 本地定时器 | 否——不跨进程 |

**判定:KBEngine wire 协议没有现成的跨进程请求关联 ID。** 多次相同 RPC、乱序到达、广播的逐请求区分,G3 只能靠显式适配引入令牌(§3),不能靠既有字段拼凑。

## 3. 设计:显式可选脚本侧适配(零 wire 改动)

两形状,**都是显式 opt-in**——不装适配=现状零侵入;装了也只影响装了的方法。既有序列化面就是脚本参数面(method.cpp:174 `argTypes_[i]->addToStream`),令牌作为**脚本参数**传输不触碰 wire 格式;日志面走既有 evidenceLog 通道(tests/fixtures/kbengine-demo-assets/scripts/common/KBEDebug.py:30)。**未核实不改 wire 的红线全程遵守:本设计不新增任何 wire 字段、不改任何引擎源文件。**

### 形状一:载荷适配(payload opt-in)——唯一 causal 面

- 两侧 def 的方法签名**显式**声明尾参 `corrId: str`(或 uint64);发送侧生成令牌(建议 `uuid4` 或 `f"{entityID}:{单调计数}"`),接收侧读参数后经 trace 适配记 message-receive(correlationId=令牌);
- 两侧 correlationId 非空且相等 → `relateMessages`(src/backend/traceEventModel.ts)判 **causal**——协议层已支持,无需新面;
- 约束(构造性,来自 §1.1):①def/签名双侧变更,不改签名的方法不可参与;②引擎自身回调(onClientEnabled/onTimer/onEnterSpace/onLoseCell 等)签名引擎定死,**不可参与**;③checkArgs 拒超参,不能不声明偷渡。

### 形状二:日志适配(log opt-in)——候选关联面

- 发送侧 `evidenceLog(f"call {method} corr={token}")`;接收侧在方法体记 `enter {method}`(形状一方法可带上令牌,其余记不到令牌);
- 记不到令牌的配对只允许**候选关联**——协议已强制(correlationId=null → relateMessages candidate,禁止按方法名/邻近时间宣称因果);本形状的价值=给人工排查提供时间线证据点,不产生 causal 边。

### 装配归属

- 适配模块本体与 TRACE 事件发射(把上述令牌面变成 message-send/receive 事件)属 FLOW-027 实施;本文只定形状与红线;
- G3 呈现(FLOW-028):引擎回调链与形状二配对=候选+解释(reason 带本报告出处);广播面逐接收者区分只能靠形状一令牌(每个接收者在参数里回执不可行——广播参数对所有接收者相同,**广播在形状一下也只有发送侧单令牌**,逐接收者不可区分,如实按候选呈现)。

## 4. 验收映射

| 验收原文 | 落点 |
|---|---|
| 核实消息是否已有可用关联 ID | §1 全链实读(发送/转发/接收/协议头/广播/脚本 API)+ §2 盘点裁定=**没有** |
| 没有则设计显式可选引擎/脚本适配 | §3 两形状(载荷 opt-in=causal 唯一面;日志 opt-in=候选面),均零 wire 改动 |
| 未经协议核实不得擅改 wire 消息 | 红线重申:本设计不新增 wire 字段、不改引擎源;既有参数序列化面与日志通道是全部落点 |
