# KSEM-CREATE-04 绑定异步创建回调

**日期**:2026-11-13
**条目**:`todo.md` KSEM-CREATE-04 [P2]「绑定异步创建回调。验收:传播明确回调实参的实体身份及失败值;支持可解析 bound method/函数,动态回调不猜。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 传播明确回调实参的实体身份 | `CallbackArg::Resolvable{target, params}`(消费方解析出 bound method/函数目标名+形参表)→ `BindCheck::Bound` 逐形参赋型:单参契约 = `Union[Entity(类名), ENTITYCALL]`(本 app=实体、跨 app=句柄,静态不定向不任取;实体名动态 → Unknown 进联合);三参契约 = `Nullable(实体)`+`DBID`+`UINT8` |
| 及失败值 | `FailureNotice` 逐族登记:FromDBID/AnywhereFromDbid/RemotelyFromDbid 常规失败=首参 None(`FirstArgNone`)、实体化失败=回调不触发(`NotNotified`,通知不闭合)、AnywhereFromDbid 的 id 分配失败=**变单参 False**(`SingleArgFalse`,baseapp.cpp:1678-1690,形态与常规三参不同);anywhere/remotely 非 DBID 族=空表(无登记失败通知形态,不保证触发) |
| 支持可解析 bound method/函数 | `Resolvable` 形态:形参数对上契约 → `Bound`(形参表由消费方从目标 def 解析传入,库面不持 AST);对不上 → `ArityMismatch{expected, actual}`(引擎 TypeError/静默归 CREATE-01 guards) |
| 动态回调不猜(红线) | `CallbackArg::Dynamic` → `Unresolved` 带因——单参/三参两臂同口径;结构防线测试 `bound_only_from_resolvable` 全契约×Dynamic/Absent 循环断言产不出 Bound |
| (纪律)查无此 API 不猜 | side+name 不在 CREATE-01 表 → None |
| 边界形态 | `Absent`(可选回调缺省)= `NotProvided` 合法无通知面;契约无 callback 参位(本地 createEntity/cell 族传了 callable)= `NoCallbackSlot`(引擎不收,错位归 CREATE-01 位数闸);cell 族未传 = `DeliveredViaOnGetCell`(成功浮出走 Base 的 `onGetCell()` 无参回调,无形参身份可传播) |

## 2. 引擎真值(承 CREATE-01 逐行核,本批引用)

- anywhere 单参回调两分支:本 app=实体对象、跨 app=BASE EntityCall 句柄(baseapp.cpp:2798-2859)——绑定面给联合,不替运行时定向;
- 三参 "OKi"(baseapp.cpp:1375);id 分配失败单参 False(baseapp.cpp:1678-1690);实体化失败不触发(baseapp.cpp:1428-1436);onGetCell 浮出(baseapp/entity.cpp:1032);
- callable 闸两分(非 DBID 静默忽略/DBID AssertionError)是「传了不可调用对象」的面,与「传了契约没有的参位」(NoCallbackSlot)分层,不混。

## 3. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/create_bind.rs` | 新模块:`CallbackArg` 三形态(Resolvable/Dynamic/Absent)+ `FailureNotice` 三态 + `BindCheck` 六态(Bound/ArityMismatch/Unresolved/NotProvided/NoCallbackSlot/DeliveredViaOnGetCell)+ `bind_callback`(契约 callback 四臂分流,AnywhereFromDbid 额外 SingleArgFalse);测试 11 例 |
| `crates/kode-server/src/semantics/mod.rs` | `pub mod create_bind` 注册 + 模块文档 CREATE-04 条目 |

## 4. 测试纠偏(prove-red 基建)

1. 变异 1 首发锚点(Dynamic 臂文本)在单参/三参两臂同构重复(count=2)assert 拒动——改首次出现替换(`replace(.., 1)`),红线测试 `dynamic_callback_never_binds` 三 API 循环保证任一臂被换都咬合(实际咬出 2 红:含结构防线 bound_only_from_resolvable);

## 5. 诚实边界

- `Resolvable` 的形参表由消费方解析传入(库面契约:传错形参表=错位绑定;消费方应从目标 def/函数 AST 直取);
- 同名 bound method 多候选(重载/遮蔽)归消费方解析时的歧义裁决(CREATE-02 目录纪律同族),本模块按消费方给定的唯一目标赋型;
- `failure_notices` 是「引擎登记在案的失败形态」不是「全部失败可能」——anywhere/remotely 非 DBID 族空表=无登记形态,不等于「失败必通知」;
- lambda 实参按 Dynamic 分型(闭包体推导归 expr/facts 既有面,本批不展开);
- 回调目标**内部**的形参使用流分析(形参在函数体内怎么用)不在本批——本批只绑定调用点身份。

## 6. 证据

- `cargo test -p kode-server --lib semantics::create_bind` 11/11(单参联合+字面量传播/动态实体名 Unknown 进联合/动态回调三 API 不猜/缺省合法/三参 Nullable+DBID+UINT8+失败两态/AnywhereFromDbid 额外 False/位数不符双向/本地无参位/cell 族 OnGetCell+传参拒/查无此 API/结构防线全契约循环);
- **prove-red = 变异三发全咬合**:(1) 动态回调硬绑 → 2 例红(dynamic_callback_never_binds + bound_only_from_resolvable);(2) 抹 SingleArgFalse → 1 例红;(3) 联合句柄态硬换实体型 → 1 例红;恢复 11/11 且 diff 断言与清洁快照字节一致;
- 门禁:clippy -p kode-server -p kode-python --all-targets -D warnings 0;cargo test 双 crate 55 套件全绿 0 失败(kode-server lib 383 含新 11);tsc 0;eslint 0;vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0。
