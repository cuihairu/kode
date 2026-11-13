# KSEM-RPC-08 登记广播调用语义

**日期**:2026-11-13
**条目**:`todo.md` KSEM-RPC-08 [P1]「登记广播调用语义。验收:区分 allClients/otherClients 等实际引擎 API 的接收者集合;逐项核实,不把广播画成单客户端。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 区分 allClients/otherClients 等实际引擎 API 的接收者集合 | `BroadcastAttr` 只收两个真实 API 名;`RecipientSet` 逐项登记:allClients → `OwnPlusWitnesses`(自己的客户端若有+全部观察者客户端,clients_remote_entity_method.cpp:101-108 先发自己/:117-138 观察者循环)、otherClients → `WitnessesOnly`(跳过自己,:97-99 零观察者直接返回,可零收);与 `self.client.m()`(`OwnClient` 单收,列出仅作对照)三类互异,`broadcast_is_never_drawn_as_single_client` 钉死「广播≠单客户端」红线 |
| 逐项核实 | 发送面逐行核(见 §2):接收者=观察者(witness)实体的客户端,逐个闸(对方 pWitness/未销毁/有 clientEntityCall/通道/`entityInView`);方法查找只查 client 段(findClientMethodDescription,all_clients.cpp:81/:167);组件广播查组件自身 def 模块并透传 otherClients 标志(all_clients.cpp:60-95) |
| 不把广播画成单客户端 | `BroadcastCheck::Delivered` 携带集合态非单个句柄;两广播态互不相等且都与 OwnClient 不同类(测试三向断言);属性只收 cellapp 进程(caller_face≠Cell → `UnavailableOnProcess`,engine:baseapp/entity.cpp:36-41 无 getter,client_lib 无;组件路径转发宿主同 AttributeError,entity_component.cpp:1664-1670) |

## 2. 引擎真值(逐行核过 ../kbengine)

- **属性存在面**:`allClients`/`otherClients` 是**同一类型 `AllClients` 的两个实例**,只差 `otherClients_` 标志(cellapp/entity.cpp:118-119:allClients=…,false / otherClients=…,true);getter **仅 cellapp 注册**(cellapp/entity.cpp:76-77);**baseapp 实体只有 cell/client/databaseID 等getter**(baseapp/entity.cpp:36-41,无任何 Clients);client_lib 无 → base/client 脚本语境运行时 AttributeError;
- **发送面**(cellapp/clients_remote_entity_method.cpp::callmethod):`allClients` **先发自己**(:101-108,须 `pEntity->pWitness() && clientEntityCall()`)再广播观察者(:117-138);`otherClients` 只广播观察者,`witnessesSize()==0` 提前返回(:97-99);观察者逐个闸:pWitness/未销毁/clientEntityCall/通道/`entityInView(pEntity->id())`;一调用打包一次(mstream)发 N 客户端(onRemoteMethodCall 或别名优化变体);
- **查找面**:两路径都 `findClientMethodDescription`(all_clients.cpp:81 组件/:167 直连)——**只查 client 段**;未命中查组件属性描述(AllClients→AllClientsComponent),再未命中回落 `ScriptObject::onScriptGetAttribute` 普通属性臂(与 RPC-04 同族,取属性时不硬报错);
- **组件广播**:`allClients.<组件>.<方法>` 由 `AllClientsComponent` 在**组件自身 def 模块**查 client 段(:60-95 `pComponentScriptDefModule()`),otherClients 标志透传给 `ClientsRemoteEntityMethod`——宿主 def 同名方法不参与(本批 `component_same_name_owner_hit_is_not_bound` 钉);
- **无 Exposed 闸**:服务端→客户端广播对 client 段方法不查 exposed(exposed 是反向闸,RPC-05 已登记);
- **调用点数量**:client 段方法 `isCell()`=false → checkArgs offset=0(method.cpp:83)→ 广播实参恒按 def 声明位,无 caller 注入(RPC-07 合同在此不触发);
- 实体上两对象在 cellapp 实体构造即分配(:118-119),getter 恒返对象不返 None(:582-600)。

## 3. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/broadcast.rs` | 新模块:`BroadcastAttr` 两态/`RecipientSet` 三态(OwnClient 列出仅对照)/`BroadcastCheck` 四态(Delivered{recipients, component, targets}/NotBroadcastTarget/UnavailableOnProcess/NotReady)+ `check_broadcast`(进程可用性结构先判→声明就绪→client 段查找→分诊;组件广播查组件快照防跨模块同名误绑);测试 12 例 |
| `crates/kode-server/src/semantics/mod.rs` | `pub mod broadcast` 注册 + 模块文档 RPC-08 条目 |

## 4. 诚实边界

- 观察者集合的**运行时规模**(几个客户端在视区)是动态事实,静态模型只登记集合的**类别**(自己+观察者/仅观察者),不预测人数;
- `self.client.m()`(OwnClient 单收)的引用解析归 RPC-01/04/05 已有面,本批不重复;RecipientSet::OwnClient 列出仅为三向对照,`check_broadcast` 不产出此态;
- 属性臂回落的错误化(未命中是否报 AttributeError)归消费面措辞——引擎真值是取属性时回落普通属性臂,非广播调用;
- 客户端进程收到广播后的 `onRemoteMethodCall`/别名优化变体分发属客户端侧契约,本批只登记服务端发送面语义。

## 5. 证据

- `cargo test -p kode-server --lib semantics::broadcast` 12/12(allClients 集合/otherClients 集合/三向接收面互异红线/base·client 进程不可用/组件广播查组件模块/宿主同名不混入/组件快照缺 NotReady/宿主快照缺 NotReady/base·cell 段同名不构成广播目标/client 段未命中/无 Exposed 闸/组件路径 base 面不可用);
- **prove-red = 变异三发全咬合**:(1) 抹接收者集合区分(两属性同集合)→ 3 例红;(2) 抹 cellapp-only 进程闸 → 2 例红;(3) 组件广播回落宿主快照 → 2 例红;恢复 12/12;
- 门禁:clippy -p kode-server -p kode-python --all-targets -D warnings 0;cargo test 双 crate 55 套件全绿 0 失败(kode-server lib 325 含新 12);tsc 0;eslint 0;vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0(load ~11)。
