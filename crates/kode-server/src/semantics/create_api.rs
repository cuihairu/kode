//! 创建 API 契约表(KSEM-CREATE-01)。
//!
//! KBEngine 的实体创建 API 家族在引擎源码里逐个实现,签名/返回值/失败面/
//! 回调形态**逐 API 不同**——本模块把核实过的契约登记成可查表,消费方
//! (补全/跳转/推导/校验)按 API 名取契约,不凭一族经验猜共性:
//!
//! - **同步面**只有两个:KBEngine(baseapp 模块)`createEntity` 与
//!   KBEngine(cellapp 模块)`createEntity`——直接返回本地实体对象;
//!   其余全部异步返回 None,结果走回调;
//! - **回调形态三分**:anywhere/remotely 族单参(本 app=实体对象,跨
//!   app=BASE EntityCall 句柄);FromDBID 族三参(实体引用|None, dbid,
//!   wasActive)("OKi");createCellEntity 族无回调参,成功经 **onGetCell**
//!   无参脚本回调浮出;
//! - **callable 闸两分**:非 DBID 族的 anywhere/remotely 对不可调用
//!   callback **静默忽略置 NULL**;FromDBID 族则 **AssertionError**——
//!   两条路径不同,不能共用「给错回调必报错」或「必静默」的直觉;
//! - **直连闸**:remotely/remotelyFromDBID 的 EntityCall 参必须
//!   ENTITYCALL_TYPE_BASE 直连;createCellEntity 的参必须
//!   ENTITYCALL_TYPE_CELL 直连,类型不合 TypeError;
//! - **FromDBID 失败通知不闭合**:常规失败回调拿 None;anywhere 路径
//!   id 分配失败回调拿 False(单参布尔);实体化失败路径**不通知脚本**。
//!
//! 每条契约带引擎出处(文件:行),全部逐行核过 ../kbengine。

use std::collections::HashMap;

/// API 挂载面。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ApiSide {
    /// `KBEngine` 模块,baseapp 进程。
    KBEngineBaseapp,
    /// `Base` 实体方法,baseapp 进程。
    Base,
    /// `KBEngine` 模块,cellapp 进程。
    KBEngineCellapp,
}

/// 创建族别(与 todo 验收「本地/远端/Anywhere/FromDBID」对齐)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateKind {
    /// 本地同步创建。
    Local,
    /// 远端(指定目标 baseapp)创建。
    Remote,
    /// 任意 baseapp(经 baseappmgr 负载均衡)创建。
    Anywhere,
    /// 从 DBID 恢复创建。
    FromDbid,
    /// 任意 baseapp 从 DBID 恢复创建。
    AnywhereFromDbid,
    /// 远端从 DBID 恢复创建。
    RemotelyFromDbid,
    /// 为本 Base 在既有空间创建 cell 实体。
    CellEntity,
    /// 为本 Base 在新空间创建 cell 实体。
    CellEntityInNewSpace,
}

/// 同步返回值形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncReturn {
    /// 直接返回本地实体对象(仅两个同步 API)。
    EntityDirect,
    /// 异步,返回 None,结果走回调/onGetCell。
    NoneAsync,
}

/// 回调形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallbackShape {
    /// 无回调参(结果不经回调浮出)。
    None,
    /// 单参:本 app 创建 = 实体对象;跨 app = BASE EntityCall 句柄
    /// (baseapp.cpp:2798-2859 两分支)。
    OneArgEntityOrMailbox,
    /// 三参(实体引用|None, dbid, wasActive:int)——"OKi"
    /// (baseapp.cpp:1375-1379/:1787-1793)。
    ThreeArgRefDbidWasActive,
    /// 无回调参,成功由 Base 的 `onGetCell()` 无参回调浮出
    /// (baseapp/entity.cpp:1032)。
    OnGetCellNoArgs,
}

/// callback 参不可调用时的处理。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallableGate {
    /// 静默忽略置 NULL(baseapp.cpp:1020-1022/:1061-1063)。
    SilentIgnore,
    /// AssertionError 拒绝(baseapp.cpp:1197-1204 等 DBID 族)。
    AssertionError,
}

/// 单条创建 API 契约。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateApiContract {
    /// 脚本可见 API 名。
    pub name: &'static str,
    pub side: ApiSide,
    pub kind: CreateKind,
    /// 同步返回形态。
    pub sync_return: SyncReturn,
    pub callback: CallbackShape,
    pub callable_gate: CallableGate,
    /// 结构前置与失败面(直连闸/存在性/幂等 guard/特殊失败通知形态),
    /// 逐条带引擎行号;消费方措辞自持。
    pub guards: &'static [&'static str],
    /// 引擎出处(文件:行区间)。
    pub source: &'static str,
}

/// 契约表(登记序;逐行核过 ../kbengine 2026-11-13)。
pub fn contracts() -> &'static [CreateApiContract] {
    &[
        // ---- KBEngine 模块 · baseapp 进程 ----
        CreateApiContract {
            name: "createEntity",
            side: ApiSide::KBEngineBaseapp,
            kind: CreateKind::Local,
            sync_return: SyncReturn::EntityDirect,
            callback: CallbackShape::None,
            callable_gate: CallableGate::SilentIgnore, // 无回调参,闸无意义,统一占位
            guards: &[
                "(entityType, params=None) 两参形态;params 可为 None",
                "实参解析失败 → AssertionError「args error」(baseapp.cpp:971-977)",
                "entityType 未校验注册(与本族其它 API 不同,本 app 本地建,查不到走建失败路径)",
            ],
            source: "baseapp.cpp:959-984",
        },
        CreateApiContract {
            name: "createEntityAnywhere",
            side: ApiSide::KBEngineBaseapp,
            kind: CreateKind::Anywhere,
            sync_return: SyncReturn::NoneAsync,
            callback: CallbackShape::OneArgEntityOrMailbox,
            callable_gate: CallableGate::SilentIgnore,
            guards: &[
                "(entityType, params=None, callback=None) 三参形态",
                "entityType 必须已注册 script module → AssertionError「entityType error」(baseapp.cpp:1009-1017)",
                "回调单参:建在本 app=实体对象;建在别的 baseapp=BASE EntityCall 句柄(baseapp.cpp:2830-2859)",
            ],
            source: "baseapp.cpp:986-1026, 2704-2882",
        },
        CreateApiContract {
            name: "createEntityRemotely",
            side: ApiSide::KBEngineBaseapp,
            kind: CreateKind::Remote,
            sync_return: SyncReturn::NoneAsync,
            callback: CallbackShape::OneArgEntityOrMailbox,
            callable_gate: CallableGate::SilentIgnore,
            guards: &[
                "(entityType, baseEntityCall, params=None, callback=None) 四参形态",
                "arg2 必须 EntityCall 类型 → TypeError「arg2 is not baseEntityCall」(baseapp.cpp:1066-1072)",
                "arg2 必须 ENTITYCALL_TYPE_BASE 直连 → TypeError「not is a direct baseEntityCall」(baseapp.cpp:1073-1080)",
                "entityType 必须已注册 → AssertionError(baseapp.cpp:1051-1057)",
            ],
            source: "baseapp.cpp:1028-1086, 2885-3007",
        },
        CreateApiContract {
            name: "createEntityFromDBID",
            side: ApiSide::KBEngineBaseapp,
            kind: CreateKind::FromDbid,
            sync_return: SyncReturn::NoneAsync,
            callback: CallbackShape::ThreeArgRefDbidWasActive,
            callable_gate: CallableGate::AssertionError,
            guards: &[
                "(entityType, dbid, callback=None, dbInterfaceName=\"default\") 2~4 参,其它位数 AssertionError「args require 2 or 3 args」(baseapp.cpp:1117-1122)",
                "dbid <= 0 → AssertionError「dbid error」(baseapp.cpp:1192-1198)",
                "callback 不可调用 → AssertionError「callback error」(**非静默**,baseapp.cpp:1199-1206)",
                "dbInterface 必须存在且非 pure → TypeError/ERROR(baseapp.cpp:1133-1160)",
                "dbmgr 不可达 → AssertionError「not found dbmgr」(baseapp.cpp:1214-1219)",
                "回调三参(实体|None, dbid, wasActive):查库失败 baseEntityRef=None(baseapp.cpp:1366-1371);实体化失败 e==NULL **不通知脚本**(baseapp.cpp:1428-1436);wasActive=已活跃实体直接回引用",
            ],
            source: "baseapp.cpp:1088-1450",
        },
        CreateApiContract {
            name: "createEntityAnywhereFromDBID",
            side: ApiSide::KBEngineBaseapp,
            kind: CreateKind::AnywhereFromDbid,
            sync_return: SyncReturn::NoneAsync,
            callback: CallbackShape::ThreeArgRefDbidWasActive,
            callable_gate: CallableGate::AssertionError,
            guards: &[
                "(entityType, dbid, callback=None, dbInterfaceName=\"default\") 2~4 参",
                "dbid <= 0 → AssertionError;callback 不可调用 → AssertionError(baseapp.cpp:1560-1570)",
                "**id 分配失败路径回调单参 False**(Py_False,非 None/非三参,baseapp.cpp:1678-1690)——失败通知形态不闭合",
                "dbmgr 不可达路径回调**静默丢弃**(take 后空分支,baseapp.cpp:1660-1666)",
                "常规结果三参 \"OKi\":实体|None, dbid, wasActive(baseapp.cpp:1783-1793)",
            ],
            source: "baseapp.cpp:1460-1800",
        },
        CreateApiContract {
            name: "createEntityRemotelyFromDBID",
            side: ApiSide::KBEngineBaseapp,
            kind: CreateKind::RemotelyFromDbid,
            sync_return: SyncReturn::NoneAsync,
            callback: CallbackShape::ThreeArgRefDbidWasActive,
            callable_gate: CallableGate::AssertionError,
            guards: &[
                "(entityType, dbid, baseEntityCall, callback=None, dbInterfaceName=\"default\") 3~5 参,其它位数 AssertionError「args require 3 ~ 5 args」(baseapp.cpp:2035-2040)",
                "arg3 必须 EntityCall 且 ENTITYCALL_TYPE_BASE 直连 → TypeError(baseapp.cpp:2121-2138)",
                "dbid <= 0 → AssertionError;callback 不可调用 → AssertionError(baseapp.cpp:2123-2141)",
                "常规结果三参 \"OKi\":实体|None, dbid, wasActive(失败 baseEntityRef=Py_None,baseapp.cpp:2290-2330)",
                "部分失败路径回调静默丢弃(take 后空分支,baseapp.cpp:2330-2336)",
            ],
            source: "baseapp.cpp:2006-2456",
        },
        // ---- Base 实体 · baseapp 进程 ----
        CreateApiContract {
            name: "createCellEntity",
            side: ApiSide::Base,
            kind: CreateKind::CellEntity,
            sync_return: SyncReturn::NoneAsync,
            callback: CallbackShape::OnGetCellNoArgs,
            callable_gate: CallableGate::SilentIgnore, // 无回调参,占位
            guards: &[
                "(cellEntityCall) 单参:目标 cellapp 上已有 Base 实体的 CELL EntityCall",
                "本实体已销毁/未找到/已有 cell(creatingCell_ || cellEntityCall())→ AssertionError「has a cell」(baseapp/entity.cpp:1420-1443)",
                "arg1 必须 EntityCall 类型 → TypeError「arg1 is not cellEntityCall」(baseapp/entity.cpp:1444-1451)",
                "arg1 必须 ENTITYCALL_TYPE_CELL 直连 → TypeError「not is a direct cellEntityCall」(baseapp/entity.cpp:1452-1461)",
                "无回调参;成功经 onGetCell() 无参回调浮出(baseapp/entity.cpp:1032);cell 建立异常引擎自动 destroy(WARNING,baseapp/entity.cpp:1037)",
            ],
            source: "baseapp/entity.cpp:1416-1473, baseapp.cpp:3119-3228",
        },
        CreateApiContract {
            name: "createCellEntityInNewSpace",
            side: ApiSide::Base,
            kind: CreateKind::CellEntityInNewSpace,
            sync_return: SyncReturn::NoneAsync,
            callback: CallbackShape::OnGetCellNoArgs,
            callable_gate: CallableGate::SilentIgnore, // 无回调参,占位
            guards: &[
                "(cellappIndex=0):0=不强制指定 cellapp;1..N=选第 N 个 cellapp,不够 N 则取模回绕(baseapp.cpp:2531-2538 注释)",
                "本实体已销毁 → AssertionError;createdSpace_ 或已有 cell → AssertionError「in space」(幂等,baseapp/entity.cpp:1490-1506)",
                "**def 必须 hasCell**:无 cell 段 → ERROR 日志 + 静默返回 None(baseapp.cpp:2523-2529)",
                "成功经 onGetCell() 无参回调浮出",
            ],
            source: "baseapp/entity.cpp:1487-1508, baseapp.cpp:2522-2600",
        },
        // ---- KBEngine 模块 · cellapp 进程 ----
        CreateApiContract {
            name: "createEntity",
            side: ApiSide::KBEngineCellapp,
            kind: CreateKind::Local,
            sync_return: SyncReturn::EntityDirect,
            callback: CallbackShape::None,
            callable_gate: CallableGate::SilentIgnore, // 无回调参,占位
            guards: &[
                "(entityType, spaceID, position, direction, params=None) 五参形态",
                "spaceID 不存在/不健康 → TypeError「spaceID %ld not found」(cellapp.cpp:488-493)",
                "关机中 → TypeError(cellapp.cpp:494-499)",
                "entityType 空串 → TypeError(cellapp.cpp:480-485)",
                "同步返回本地 Cell 实体;可能返回 isDestroyed=true 状态实体(进世界时被销毁,cellapp.cpp:521-529 注释)",
            ],
            source: "cellapp.cpp:174, 472-530",
        },
    ]
}

/// 按挂载面 + API 名查契约。
pub fn lookup(side: ApiSide, name: &str) -> Option<&'static CreateApiContract> {
    contracts()
        .iter()
        .find(|c| c.side == side && c.name == name)
}

/// 按挂载面列契约(登记序)。
pub fn apis_for(side: ApiSide) -> Vec<&'static CreateApiContract> {
    contracts().iter().filter(|c| c.side == side).collect()
}

/// 全表索引(side+name → 契约)。
pub fn index() -> HashMap<(ApiSide, &'static str), &'static CreateApiContract> {
    contracts()
        .iter()
        .map(|c| ((c.side, c.name), c))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_all_three_sides_and_names_unique() {
        let all = contracts();
        assert!(all.len() >= 9);
        for side in [ApiSide::KBEngineBaseapp, ApiSide::Base, ApiSide::KBEngineCellapp] {
            assert!(!apis_for(side).is_empty(), "{side:?} 无登记");
        }
        let mut names: Vec<_> = all.iter().map(|c| (c.side, c.name)).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), all.len(), "side+name 有重复");
    }

    #[test]
    fn local_creations_are_synchronous_entity_returns() {
        // 两个「本地」API 是全表仅有的同步返实体形态。
        let base_local = lookup(ApiSide::KBEngineBaseapp, "createEntity").unwrap();
        let cell_local = lookup(ApiSide::KBEngineCellapp, "createEntity").unwrap();
        assert_eq!(base_local.sync_return, SyncReturn::EntityDirect);
        assert_eq!(cell_local.sync_return, SyncReturn::EntityDirect);
        assert_eq!(base_local.callback, CallbackShape::None);
        for c in contracts() {
            if c.sync_return == SyncReturn::EntityDirect {
                let name = c.name;
                assert_eq!(c.kind, CreateKind::Local, "{name} 同步返实体但非本地创建");
            }
        }
    }

    #[test]
    fn anywhere_and_remotely_are_single_arg_async() {
        for name in ["createEntityAnywhere", "createEntityRemotely"] {
            let c = lookup(ApiSide::KBEngineBaseapp, name).unwrap();
            assert_eq!(c.sync_return, SyncReturn::NoneAsync, "{name}");
            assert_eq!(c.callback, CallbackShape::OneArgEntityOrMailbox, "{name}");
            assert_eq!(c.callable_gate, CallableGate::SilentIgnore, "{name}");
        }
    }

    #[test]
    fn from_dbid_family_is_three_arg_with_strict_callable_gate() {
        // DBID 族:三参 "OKi";callback 错给**必报错**——与非 DBID 族静默忽略两分。
        for name in [
            "createEntityFromDBID",
            "createEntityAnywhereFromDBID",
            "createEntityRemotelyFromDBID",
        ] {
            let c = lookup(ApiSide::KBEngineBaseapp, name).unwrap();
            assert_eq!(c.callback, CallbackShape::ThreeArgRefDbidWasActive, "{name}");
            assert_eq!(c.callable_gate, CallableGate::AssertionError, "{name}");
            assert!(c.kind != CreateKind::Local);
        }
    }

    #[test]
    fn anywhere_from_dbid_records_false_failure_shape() {
        // 失败通知不闭合:id 分配失败回调单参 False,必须显式登记。
        let c = lookup(ApiSide::KBEngineBaseapp, "createEntityAnywhereFromDBID").unwrap();
        let joined = c.guards.join(";");
        assert!(joined.contains("False"), "缺 id 分配失败 False 形态");
        assert!(joined.contains("静默丢弃"), "缺 dbmgr 不可达静默丢弃形态");
    }

    #[test]
    fn remote_gates_require_direct_entity_call_type() {
        // 远端族直连闸逐条在案且注明 TypeError。
        let remotely = lookup(ApiSide::KBEngineBaseapp, "createEntityRemotely").unwrap();
        let joined = remotely.guards.join(";");
        assert!(joined.contains("ENTITYCALL_TYPE_BASE") && joined.contains("TypeError"));

        let cell = lookup(ApiSide::Base, "createCellEntity").unwrap();
        let joined = cell.guards.join(";");
        assert!(joined.contains("ENTITYCALL_TYPE_CELL") && joined.contains("TypeError"));
    }

    #[test]
    fn cell_entity_apis_surface_via_on_get_cell() {
        // createCellEntity 族无回调参,成功经 onGetCell 浮出。
        for name in ["createCellEntity", "createCellEntityInNewSpace"] {
            let c = lookup(ApiSide::Base, name).unwrap();
            assert_eq!(c.side, ApiSide::Base);
            assert_eq!(c.callback, CallbackShape::OnGetCellNoArgs, "{name}");
            assert_eq!(c.sync_return, SyncReturn::NoneAsync, "{name}");
        }
        let new_space = lookup(ApiSide::Base, "createCellEntityInNewSpace").unwrap();
        let joined = new_space.guards.join(";");
        assert!(joined.contains("hasCell"), "缺 hasCell 前置");
        assert!(joined.contains("取模回绕"), "缺 cellappIndex 回绕语义");
    }

    #[test]
    fn cellapp_local_records_space_guard_and_destroyed_note() {
        let c = lookup(ApiSide::KBEngineCellapp, "createEntity").unwrap();
        let joined = c.guards.join(";");
        assert!(joined.contains("spaceID"), "缺空间存在性前置");
        assert!(joined.contains("isDestroyed"), "缺返回销毁态实体注记");
    }

    #[test]
    fn every_contract_records_engine_source_with_lines() {
        // 验收「记录引擎出处」:出处必带文件名与行号。
        for c in contracts() {
            assert!(c.source.contains(".cpp:"), "{} 出处缺行号: {}", c.name, c.source);
            assert!(!c.guards.is_empty(), "{} 缺失败/前置面", c.name);
            let joined = c.guards.join(";");
            assert!(
                joined.contains("AssertionError") || joined.contains("TypeError") || joined.contains("ERROR"),
                "{} 缺失败面登记",
                c.name
            );
        }
    }

    #[test]
    fn lookup_unknown_name_is_none() {
        assert!(lookup(ApiSide::KBEngineBaseapp, "createEntityMagically").is_none());
        assert!(lookup(ApiSide::Base, "createEntity").is_none()); // Base 面无此名
        assert!(lookup(ApiSide::KBEngineCellapp, "createEntityAnywhere").is_none());
    }

    #[test]
    fn index_roundtrip() {
        let idx = index();
        assert_eq!(idx.len(), contracts().len());
        let c = idx.get(&(ApiSide::KBEngineBaseapp, "createEntityFromDBID")).unwrap();
        assert_eq!(c.kind, CreateKind::FromDbid);
    }
}
