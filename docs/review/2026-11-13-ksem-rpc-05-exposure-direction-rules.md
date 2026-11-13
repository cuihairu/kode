# KSEM-RPC-05 检查角色与暴露规则

**日期**:2026-11-13
**条目**:`todo.md` KSEM-RPC-05 [P1]「检查角色与暴露规则。验收:客户端 Exposed、服务端调用方向及缺方法分开诊断;声明尚未就绪时不报确定缺失。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 客户端 Exposed(分开诊断) | `RpcCheck::ClientNotExposed{method, facet}`:调用方进程为 client 且引用形态为远程句柄时,def 命中但候选全部未 Exposed → 不可达(引擎:client/bots 进程非 Exposed 回落普通属性臂→属性错误,entity_call.cpp:117-121;组件同闸 entity_component_call.cpp:99-103);任一候选 Exposed 即可达;本地实体/本地组件 plain Python 派发无此闸 |
| 服务端调用方向(分开诊断) | `RpcCheck::DirectionUnreachable{reason}`:引用形态在调用方脚本面不可获取——逐面可获取集(`acquirable_calls`)= self 角色属性种子 + 面跳闭包,**逐面口径不同**(见 §2 发现);另有 None 引用、组件槽未声明/未指定类型(结构不可达族) |
| 及缺方法分开 | `RpcCheck::MethodMissing{method, facet, class}`:声明就绪(类已知/快照在手/槽链齐)、对应面 Methods 段确认无此名(远程句柄路径 entity_call.cpp:126-177 属性错误尾);三类互斥分开出,不合并 |
| 声明尚未就绪时不报确定缺失 | `RpcCheck::NotReady{reason}`:实体类未知/接收者快照缺/槽宿主快照缺/组件快照缺/组件类缺/基类链未展开 → 一律 NotReady,绝不判 MethodMissing(prove-red 变异三钉:类未知守卫抹掉即红);本地实体 def 段缺 = `NotApplicable`(plain 派发 def 非闸,不构成确定缺失) |

## 2. 引擎真值与两项发现(逐行核过 ../kbengine)

- **发现一:client/bots 进程面跳原样返回自身句柄**(entity_call.cpp:164-171 `Py_INCREF(this)`)——链式取面在客户端**不产生新调用类型** → client 面可获取集 = 种子集 {BASE, CELL};VIA 变体与 CLIENT 直连型在客户端面**不可构造**(方向诊断真负例);
- **发现二:服务端面去直连链使闭包近乎全连通**(entity_call.cpp:144-150)——base 面可获取**全部七型**(直连 BASE 经 `self.client.cell.base` 去直连链可构造,.client 有 Proxy 系限定另记不裁剪);cell 面除直连 CLIENT 外全部(CLIENT 分支只认 BASE/CELL 直连型 :151-156——cellapp 无直连客户端连接,真负例);
- 故方向诊断真负例全集 = client 面 {CLIENT 直连、五 VIA 型} + cell 面 {CLIENT 直连} + None 引用 + 组件槽结构缺失;base 面调用类型层面无真负例;
- Exposed 闸与组件闸逐行核:entity_call.cpp:117-121(`g_componentType == CLIENT_TYPE || BOTS_TYPE` 且 `!isExposed` → ScriptObject 臂)、entity_component_call.cpp:99-103(同构);
- RPC-01 `hop_attr` 为服务端语义(entity_call.cpp:166 服务端构造新 EntityCall;:171 客户端自返)——本批 acquirable_calls 对 client 面前置分流,不给模型加面参数。

## 3. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/rules.rs` | 新模块:`RpcCheck` 六态(Reachable/ClientNotExposed/DirectionUnreachable/MethodMissing/NotReady/NotApplicable)+ `check_rpc_call`(结构守卫→引用守卫→落点解析→分诊;分类不读 Unknown 文本,靠前置守卫上下文)+ `acquirable_calls`(逐面种子+闭包,client 面前置分流);测试 18 例 |
| `crates/kode-server/src/semantics/mod.rs` | `pub mod rules` 注册 |

## 4. 测试纠偏(实现对、测试期望错,按源码改正)

1. 初版方向测试断言「CELL 句柄在 cell 面不可获取」「BASE 句柄在 base 面不可获取」——**两例前提全错**:去直连链(`self.client.base.cell` / `self.client.cell.base`)在服务端可构造两者(entity_call.cpp:144-150);改为真负例(cell 面 CLIENT 直连 / client 面 VIA 型+CLIENT 直连);
2. `local_paths_have_no_exposed_gate` 测试数据用 base 段声明但 script_face=Client → 查的是 client 段,改测试数据(实现分面正确);
3. 闭包初版未分流 client 面(套用服务端矩阵)→ 抓出发现一,补 `:164-171` 前置分流。

## 5. 诚实边界

- Proxy 限定不裁剪:base 面 CLIENT/CV* 链有「仅 Proxy 系实体有 .client」的类级限定(RPC-02 同口径,note 记录),方向集按结构可能性给,不按类猜是否 Proxy;
- `hop_attr` 保持面盲(RPC-01 形态);face 依赖由本批 `acquirable_calls` 前置分流消化——若未来消费面需要逐跳 client 语义,须给模型加 face 参数,不在本批;
- 本地实体 def 段缺 → NotApplicable 而非缺方法(plain Python 派发真值,RPC-04 同源);Python 类面另查属消费批次;
- 候选混合 Exposed(部分接口来源 Exposed)按「任一 Exposed 即可达」放行——def 表同名一条,引擎按合并结果放行,逐候选来源优先级归 snapshot 合并规则。

## 6. 证据

- `cargo test -p kode-server --lib semantics::rules` 18/18(Exposed 闸四向/client 面 VIA+CLIENT 负例+BASE 正例/cell 面 CLIENT 直连负例/base 面 CELL 正例+闭包 VIA/None 引用/段缺方法/类未知 NotReady 永不判缺/快照缺 NotReady/本地实体 NotApplicable/组件槽 client 闸+服务端放行/结构三缺分诊/组件段缺方法/本地组件基类链未展开 NotReady);
- **prove-red=变异三发全咬合**:(1) 抹 Exposed 闸 → 2 例红;(2) client 面误套服务端闭包 → client 面 VIA 负例红;(3) 抹类未知 NotReady 守卫(误判缺方法)→ 验收红线例红;恢复 18/18;
- 门禁:clippy -p kode-server --all-targets -D warnings 0;cargo test 双 crate 55 套件全绿 0 失败(kode-server lib 287 含新 18);tsc 0;eslint 0;vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0。
