# Proxy 会话语义:客户端通道的所有权与仲裁

依据:fork KBEngine(HEAD 55a66552)`kbe/src/server/baseapp/proxy.cpp` + `baseapp.cpp` 及 fork 源码分析档 docs/zh/architecture/source-analysis/proxy-client-session-api.md。本档钉 **Proxy 专属会话 API 的引擎真值**(disconnect/onClientDeath/onLogOnAttempt/onClientGetCell/giveClientTo/stream*);方法名册与只读属性面见 api-baseapp-entity.md,两档互补不重叠。

## 1. Proxy 专属会话 API 名册

| API | 性质 | 一句话语义 |
|---|---|---|
| `disconnect()` | 主动调用 | 只断客户端通道 |
| `onClientDeath()` | 回调 | 会话解绑通知 |
| `onLogOnAttempt(ip, port, password)` | 回调+返回值裁决 | 在线账号接纳新登录的仲裁器 |
| `onClientGetCell()` | 回调 | 客户端进入可访问 Cell 阶段 |
| `giveClientTo(other)` | 主动调用 | 整条客户端所有权链迁移 |
| `onGiveClientToFailure()` | 回调 | 迁移前置校验失败通知 |
| `streamStringToClient()` / `streamFileToClient()` | 主动调用 | 后台任务+主线程分片发送 |

## 2. disconnect():只断通道,不断实体生命周期(proxy.cpp pyDisconnect)

```cpp
Network::Channel* pChannel = Baseapp::getSingleton().networkInterface().findChannel(addr_);
if (pChannel && !pChannel->isDestroyed())
{
    pChannel->condemn("");
}
```

做的事只有一件:让当前客户端通道进入关闭流程。它**没有**:销毁 Proxy、删除数据库记录、主动销毁 Cell。准确理解=**只断会话,不断实体生命周期**(适用:强制踢客户端下线但保留账号实体在线态、让客户端重连)。

## 3. onClientDeath():会话解绑,不是实体销毁(baseapp.cpp onChannelDeregister)

客户端断线的入口是 `Baseapp::onChannelDeregister(...)`→`proxy->onClientDeath()`,其体:

```cpp
Py_DECREF(clientEntityCall());
clientEntityCall(NULL);
addr(Network::Address::NONE);
clientEnabled_ = false;
CALL_ENTITY_AND_COMPONENTS_METHOD(this, ..., "onClientDeath", ...);
```

不是在销毁 Proxy,而是做一轮会话解绑:释放 clientEntityCall/清空客户端地址/clientEnabled_ 置 false,**再经 CALL_ENTITY_AND_COMPONENTS_METHOD 通知实体与全部组件**。准确语义=**这个 Proxy 失去了当前绑定的客户端通道**(常见:记录掉线时间/清理在线态临时状态/标记等重连)。

## 4. onLogOnAttempt():在线账号接纳新登录的脚本裁决

Baseapp::loginBaseapp 对已在内存的账号实体不直接替换连接,而是先问脚本(实体脚本先行,再 CALL_ENTITY_COMPONENTS_METHOD 问组件)。**三返回值在当前源码的实际效果**:

```cpp
switch(ret)
{
case LOG_ON_ACCEPT:
    ...
    break;
case LOG_ON_WAIT_FOR_DESTROY:
default:
    loginBaseappFailed(..., SERVER_ERR_ACCOUNT_IS_ONLINE);
    return;
}
```

- `LOG_ON_ACCEPT`:允许新连接接管(真实语义=**新通道接管当前在线账号并立即重建客户端代理链**:旧通道踢出/addr 改新通道/更新 clientType 与 loginDatas/createClientProxies(true)/再调 onGetWitness)。
- `LOG_ON_REJECT`:拒绝。
- `LOG_ON_WAIT_FOR_DESTROY`:**当前源码未落地为独立流程**——switch 里与 default 同支,实际效果同拒绝;API 文档保留的是理想语义,脚本真正能稳定依赖的只有 accept/reject。

## 5. onClientGetCell():客户端可访问 Cell 的阶段(baseapp.cpp onEntityGetCell)

链路=onEntityGetCell→clientEntityCall 非空时 onClientEntityEnterWorld→initClientCellPropertys→onClientGetCell;Proxy 侧确保 cellEntityCall_ 可用后回调。准确语义不是「Cell 创建成功」而是**带客户端的实体进入客户端可访问 Cell 的阶段**(常见:客户端上线后首次可访问 self.cell)。

## 6. giveClientTo():整条客户端所有权链迁移

做的事:校验源/目标 Proxy→源有 Cell 先通知丢 Witness→通知客户端销毁旧代理实体→清空源 clientEntityCall/clientEnabled/addr/clientType/loginDatas→clientType/loginDatas 交目标→目标在同一条通道上 onGiveClientTo(新建 clientEntityCall/接管 addr/createClientProxies/onGetWitness)。**onGiveClientToFailure 只在迁移启动前的前置校验失败时触发**(源已销毁/源无客户端/目标已销毁/目标是自己/目标已有客户端),不对应迁移中途的网络失败。

## 7. streamStringToClient()/streamFileToClient():后台任务+主线程分片

不是「一次把整块数据发给客户端」:入口只创建下载任务入队,streamFile 真正读文件在后台任务里,发送在主线程按分片推进。脚本侧调用返回任务 id,不阻塞实体逻辑。

## 8. kode 面现状

kode 对 Proxy 专属会话 API 的四个面:

- **悬停文档表:名册全覆盖**。generated/apiDocs.ts(API_DOC_ENTRIES,base 域 lookupApiDoc 消费)对 §1 名册七 API + getClientType/getClientDatas 等十成员全 hit。文案对账:disconnect(「condemns the client channel」)与 §2 对齐;onClientGetCell(「gains access to the entity's cell attribute」)与 §5 对齐。
- **文案分歧(登记)**:onLogOnAttempt 条目声称 `LOG_ON_WAIT_FOR_DESTROY (queue the new login until this entity is destroyed …)` =独立排队流程,引用 wait-for-destroy :3960;而本档 §4 源码铁证=该 case 与 default 同支(:4020-4021)实际同拒绝,行号亦漂移。文案随引擎真值再生归独立批。
- **文案稀薄(登记)**:onGiveClientToFailure 条目 summary 仅 `proxy.cpp:304-307.` 行号零语义,§6 前置校验边界(五种触发条件/不对应网络失败)未入文案。
- **诊断面**:receiverNoneDiagnostics 消息引用 onClientDeath 语义一处——其表述「onClientDeath/onLoseCell → S_RELEASE 后 receiver 为 None」与本档 §3「会话解绑后 clientEntityCall 置空」**同义对齐**(S_RELEASE 即解绑态),并附引擎源码引用(server/baseapp/entity.cpp:800 pyGetClientEntityCall)。

onLogOnAttempt 返回值矩阵(WAIT_FOR_DESTROY 未落地)与 giveClientTo 前置校验边界是脚本高频误用面,静态检查面收编归独立批。
