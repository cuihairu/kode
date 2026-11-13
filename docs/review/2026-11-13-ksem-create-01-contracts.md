# KSEM-CREATE-01 登记创建 API 契约表

**日期**:2026-11-13
**条目**:`todo.md` KSEM-CREATE-01 [P2]「登记创建 API 契约表。验收:分别核对 Base/Cell 的本地、远端、Anywhere、FromDBID API 签名、返回值、失败和回调参数;记录引擎出处。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 分别核对 Base/Cell 的本地、远端、Anywhere、FromDBID API | `ApiSide` 三面(KBEngineBaseapp/Base/KBEngineCellapp)× `CreateKind` 八族(Local/Remote/Anywhere/FromDbid/AnywhereFromDbid/RemotelyFromDbid/CellEntity/CellEntityInNewSpace),九条契约登记成可查表 `contracts()`/`lookup(side, name)`/`apis_for(side)`/`index()`;**cellapp 面只有本地 `createEntity`**(engine:cellapp.cpp:174 唯一注册),远端/Anywhere/FromDBID 族全在 baseapp 面 |
| 签名、返回值 | 逐条 `guards` 登记参数形态与位数;`SyncReturn` 两态:**同步返实体仅两个本地 API**(baseapp `createEntity` 直接返回实体对象 baseapp.cpp:977-980;cellapp `createEntity` 返回本地 Cell 实体且可能 isDestroyed=true 态 cellapp.cpp:521-529),其余全部 NoneAsync |
| 失败和回调参数 | `CallbackShape` 三分:anywhere/remotely 族单参(本 app=实体对象,跨 app=BASE EntityCall 句柄,baseapp.cpp:2798-2859 两分支);FromDBID 族三参 "OKi"(实体引用\|None, dbid, wasActive:int,baseapp.cpp:1375/:1787/:2290-2330);createCellEntity 族**无回调参**,成功经 Base 的 `onGetCell()` 无参回调浮出(baseapp/entity.cpp:1032);`CallableGate` 两分:非 DBID 族 callback 错给**静默忽略置 NULL**(baseapp.cpp:1020/:1061),FromDBID 族 **AssertionError**(baseapp.cpp:1197)——两路径不同;FromDBID 失败通知不闭合:常规失败=None、anywhere id 分配失败=**单参 False**(baseapp.cpp:1678-1690)、实体化失败=**不通知**、dbmgr 不可达=静默丢弃 |
| 记录引擎出处 | 每条契约 `source` 字段带文件:行区间(测试钉 `.cpp:` 必含);全部逐行核过 ../kbengine |

## 2. 引擎真值(逐行核过 ../kbengine,要点)

- **结构直连闸三分**:createEntityRemotely/RemotelyFromDBID 的 EntityCall 参必须 `ENTITYCALL_TYPE_BASE` 直连(TypeError,baseapp.cpp:1073-1080/:2121-2138);createCellEntity 的参必须 `ENTITYCALL_TYPE_CELL` 直连(TypeError,baseapp/entity.cpp:1452-1461);cellapp 端本地 createEntity 的 spaceID 必须存在且健康(TypeError,cellapp.cpp:488-493);
- **幂等 guard**:createCellEntity 已有 cell(creatingCell_ ‖ cellEntityCall())→ AssertionError「has a cell」;createCellEntityInNewSpace createdSpace_ ‖ 已有 cell → AssertionError「in space」;且 **def 必须 hasCell**——无 cell 段则 ERROR 日志 + 静默返回 None(baseapp.cpp:2523-2529);
- **createCellEntityInNewSpace(cellappIndex)**:0=不强制指定 cellapp,1..N=选第 N 个,不够 N 取模回绕(baseapp.cpp:2531-2538 引擎注释原文);
- **FromDBID 位数闸**:FromDBID 2~4 参(其它 AssertionError)、RemotelyFromDBID 3~5 参;baseapp `createEntity` 的 entityType **不查注册**(与本族其它 API 不同);anywhere/remotely/FromDBID 的 entityType 都查 `findScriptModule`(AssertionError);
- **DBID 族 dbInterface** 必须存在且非 pure(TypeError/ERROR,baseapp.cpp:1133-1160 等)。

## 3. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/create_api.rs` | 新模块:契约表(`CreateApiContract{name, side, kind, sync_return, callback, callable_gate, guards, source}` + 五个形态枚举)+ `contracts()/lookup()/apis_for()/index()`;测试 11 例 |
| `crates/kode-server/src/semantics/mod.rs` | `pub mod create_api` 注册 + 模块文档 CREATE-01 条目 |

## 4. 诚实边界

- `CallableGate::SilentIgnore` 对**无回调参**的 API(Local/CellEntity 族)是无意义的占位值——闸只在有 callback 参的 API 上有语义,消费方按 `CallbackShape::None` 先分流;
- 契约表是**登记面**(签名/失败/回调形态),后续 CREATE-02..06(字面量实体名解析/返回值推导/回调绑定/params 字典校验/Cell 创建目标)按表消费,本批不做推导;
- wasActive 语义(DB 中已活跃实体直接回引用)登记在 guards 文本,其类型面(实体 vs 句柄)归 CREATE-03 推导批;
- 引擎出处行号按 ../kbengine 当前 fork(2026-11-13 HEAD)行位,引擎上游变动需对账(与 hook 锚点同纪律)。

## 5. 证据

- `cargo test -p kode-server --lib semantics::create_api` 11/11(三面覆盖+名唯一/同步返实体仅本地两 API/anywhere·remotely 单参异步静默/DBID 族三参严闸/anywhereFromDBID False 失败形态显式登记/远端族直连闸+TypeError/cell 族 onGetCell+hasCell+回绕/cellapp 本地空间闸+销毁态注记/每条契约出处带行号+失败面在案/查无此名 None/index 回转);
- **prove-red = 变异三发全咬合**:(1) 抹 callable 闸两分(DBID 族改静默)→ 1 例红;(2) Anywhere 改同步返实体 → 2 例红;(3) 抹 id 分配失败 False 形态登记 → 1 例红;恢复 11/11;
- 门禁:clippy -p kode-server -p kode-python --all-targets -D warnings 0;cargo test 双 crate 55 套件全绿 0 失败(kode-server lib 350 含新 11);tsc 0;eslint 0;vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0。
