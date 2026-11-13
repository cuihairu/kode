# KSEM-CREATE-06 检查 Cell 创建目标

**日期**:2026-11-13
**条目**:`todo.md` KSEM-CREATE-06 [P2]「检查 Cell 创建目标。验收:核实 space/目标 EntityCall 的 API 前置条件;仅报告静态可证明的角色和类型错误。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 核实目标 EntityCall 的 API 前置条件 | `check_call_target`:三 API 角色闸=createCellEntity 要直连 **CELL** 型(baseapp/entity.cpp:1452-1461)、createEntityRemotely/RemotelyFromDBID 要直连 **BASE** 型(baseapp.cpp:1073-1080/:2129-2138);角色已折叠且不符 → `RoleMismatch` **确定错误**(引擎 TypeError);非 EntityCall 形态 → `NotEntityCall`(:1443-1451/:2119-2127);必传参缺失 → `MissingArg`(三 API 参均必传) |
| 核实 space 的 API 前置条件 | `check_space_target`:cellapp `createEntity(spaceID)` 存在性=**运行时状态**(findSpace+isGood,cellapp.cpp:492-499)——任何字面量都证不了存在性 → `RuntimeGate` 登记不判;`createCellEntityInNewSpace(cellappIndex)`:0=不强制指定、正数=选第 N 个不够取模回绕(:2531-2545)→ Ok |
| 仅报告静态可证明的角色错误(红线) | 角色未折叠出(`role: None`)→ `Unknown` **不报**;动态目标 → `Unknown`;结构防线 `unknown_role_never_mismatches_across_apis` 全 API 循环断言 role=None 产不出 RoleMismatch |
| 仅报告静态可证明的类型错误(红线) | inNewSpace **非 int 静默兜底 0**(PyLong_Check 不过保持 0,baseapp.cpp:2539-2542)→ `NonIntegerFallsBackToZero` **提示级不是错误**;负数经 PyLong_AsUnsignedLong 回绕 → `NegativeWraps` 提示级——两者都不产 TypeError(引擎就不产) |
| (纪律)查无此 API 不猜 | 非 EntityCall 族/非 space 族/查无名 → None |
| 动态形态 | 动态 EntityCall/动态 spaceID/动态 cellappIndex → Unknown 不判 |

## 2. 引擎真值(逐行核过 ../kbengine,本批复核)

- createCellEntity(cellEntityCall)(baseapp/entity.cpp:1425-1464):运行时状态闸(findEntity 不存在/creatingCell_/已有 cell → AssertionError :1425-1441,**静态不可证不判**);类型闸两步——非 EntityCall 类型 TypeError(:1443-1451)、type≠ENTITYCALL_TYPE_CELL TypeError「not is a direct cellEntityCall!」(:1452-1461);
- createEntityRemotelyFromDBID(baseapp.cpp:2119-2138):同构,type≠ENTITYCALL_TYPE_BASE → TypeError;createEntityRemotely(:1073-1080)同;
- cellapp createEntity(spaceID)(cellapp.cpp:492-499):`findSpace(spaceID)==NULL || !space->isGood()` → TypeError「spaceID not found」——space 是进程内运行时状态,静态证不了;
- createCellEntityInNewSpace(cellappIndex)(baseapp.cpp:2523-2545):hasCell 硬闸(ERROR 静默 None,CREATE-02 已钉);`uint32 cellappIndex = 0` 后仅 `PyLong_Check` 通过才赋值——**非 int 静默保持 0**(=不强制指定);注释原文「假如不够4个只有3个那么4代表1」(取模回绕);PyLong_AsUnsignedLong 对负数回绕(行为未定义面,提示级)。

## 3. 改动面(纯库面,无 RPC/无 TS 消费)

| 文件 | 改动 |
|---|---|
| `crates/kode-server/src/semantics/create_target.rs` | 新模块:`CallRole` 三角色 + `EntityCallArg` 四形态 + `TargetCheck` 五态(Ok/RoleMismatch/NotEntityCall/MissingArg/Unknown)+ `SpaceArg` 三形态 + `SpaceCheck` 五态(Ok/NegativeWraps/NonIntegerFallsBackToZero/RuntimeGate/Unknown)+ `expected_role`/`check_call_target`/`check_space_target`;测试 14 例 |
| `crates/kode-server/src/semantics/mod.rs` | `pub mod create_target` 注册 + 模块文档 CREATE-06 条目 |

## 4. 诚实边界

- `role` 由消费方从源码折叠(属性名 `cellEntityCall`/`baseEntityCall` 形态、构造调用);折叠器质量决定 RoleMismatch 触发面——库面契约:没把握就传 None(Unknown 不报);
- 角色闸只认三 API(createCellEntity/createEntityRemotely/RemotelyFromDBID);其余创建 API 无 EntityCall 目标参,不在本批;
- cellapp createEntity 的 entityType/space/pos/dir 五参形态闸(位数/类型)归 CREATE-01 guards;本批只管 spaceID 前置;
- NotEntityCall 判定依赖消费方折叠「该表达式求值为 EntityCall 以外形态」的能力——保守折叠(拿不准)应传 Dynamic 而非 NotEntityCall,库面不替消费方猜;
- 运行时状态闸(findEntity/creatingCell_/hasCell/space 存在)全部登记为引擎出处,不做静态臆断。

## 5. 证据

- `cargo test -p kode-server --lib semantics::create_target` 14/14(cell 角色命中/Base 角色不符/remotely 两 API 角色闸/角色未折叠不报/非 EntityCall 确定/缺参确定/动态不判/查无 API 三面/spaceID 运行时闸三值/索引 0 与正数/负数回绕提示/非 int 兜底提示/查无/结构防线循环);
- **prove-red = 变异三发全咬合**:(1) 角色未知硬判 mismatch → 2 例红(红线双测试);(2) spaceID 字面量硬判 Ok 抹 RuntimeGate → 1 例红;(3) 非 int 索引改负数回绕(静默兜底真值丢失)→ 1 例红;恢复 14/14 且 diff 字节一致;
- 门禁:clippy -p kode-server -p kode-python --all-targets -D warnings 0;cargo test 双 crate 55 套件全绿 0 失败(kode-server lib 410 含新 14);tsc 0;eslint 0;vitest 747 文件 9163+8skip 全绿;xvfb demo 25 RC=0。
