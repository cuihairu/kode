//! Cell 创建目标检查(KSEM-CREATE-06)。
//!
//! 创建 API 的 space/目标 EntityCall 前置条件核实,**仅报告静态可证明的
//! 角色和类型错误**(验收红线——动态目标不猜):
//!
//! - **目标 EntityCall 角色闸(静态可证)**:`createCellEntity` 的参必须
//!   直连 CELL 型 EntityCall(baseapp/entity.cpp:1452-1461 TypeError
//!   「not is a direct cellEntityCall!」);`createEntityRemotely`/
//!   `createEntityRemotelyFromDBID` 的参必须直连 BASE 型(baseapp.cpp
//!   :1073-1080/:2129-2138 TypeError)。消费方折叠出角色 → 与要求不符即
//!   `RoleMismatch` 确定错误;折叠不出(角色未知)→ `Unknown` 不报;
//!   非 EntityCall 形态 → `NotEntityCall`(:1443-1451/:2119-2127);
//!   参缺失 → `MissingArg`(三 API 参均必传);
//! - **space 面(静态不可证,登记不判)**:cellapp `createEntity` 的
//!   spaceID 存在性是运行时状态(`findSpace(spaceID)==NULL || !isGood()`
//!   → TypeError,cellapp.cpp:492-499)——任何字面量都证不了存在性,
//!   `RuntimeGate` 登记;`createCellEntityInNewSpace(cellappIndex)`:
//!   0=不强制指定、非 0 取模回绕(:2531-2545),**非 int 静默兜底 0**
//!   (PyLong_Check 不过保持 0,不是错误)、负数经 AsUnsignedLong 回绕
//!   ——两者提示级,不产 TypeError;
//! - 查无此 API → None——不猜。
//!
//! 全部引擎出处承 CREATE-01 逐行核,本批复核角色闸与 inNewSpace 兜底语义。

use super::create_api::{ApiSide, lookup};

/// EntityCall 目标角色(消费方从源码折叠:属性名/构造形态)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallRole {
    Base,
    Cell,
    Client,
}

/// 目标 EntityCall 实参形态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntityCallArg {
    /// EntityCall 引用;角色已折叠(Some)或未知(None)。
    EntityCall { role: Option<CallRole> },
    /// 折叠结果不是 EntityCall(Entity 引用/标量等)。
    NotEntityCall,
    /// 必传参未传。
    Absent,
    /// 动态表达式。
    Dynamic,
}

/// 目标 EntityCall 检查结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetCheck {
    Ok,
    /// 角色与 API 要求不符 → 引擎 TypeError(静态可证)。
    RoleMismatch { expected: CallRole, actual: CallRole },
    /// 实参不是 EntityCall → 引擎 TypeError「argN is not xxxEntityCall!」。
    NotEntityCall,
    /// 必传参缺失 → 引擎 TypeError(args error)。
    MissingArg,
    /// 动态目标——不猜(红线:仅报告静态可证明的错误)。
    Unknown,
}

/// space 系实参形态(spaceID / cellappIndex)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpaceArg {
    /// 字面量整数。
    Literal(i64),
    /// 字面量非整数(inNewSpace 静默兜底 0;cellapp spaceID 走 args 解析
    /// 位数闸,不在此判)。
    NonIntegerLiteral,
    /// 动态表达式。
    Dynamic,
}

/// space 系检查结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpaceCheck {
    /// 合法(含 0=不强制指定;正数=选第 N 个,不够取模回绕)。
    Ok,
    /// 负数字面量:PyLong_AsUnsignedLong 回绕成超大 uint32,行为未定义
    /// 面——提示级,不产 TypeError。
    NegativeWraps { value: i64 },
    /// 非 int 字面量:PyLong_Check 不过 → 保持 0(不强制指定),静默兜底
    /// ——提示级,不是错误(baseapp.cpp:2539-2542)。
    NonIntegerFallsBackToZero,
    /// spaceID 存在性是运行时状态,静态不可证——登记引擎闸不判
    /// (cellapp.cpp:492-499)。
    RuntimeGate { gate: &'static str },
    /// 动态——不判。
    Unknown,
}

/// 三条目标 EntityCall API 的要求角色;查无此 API 或非目标族 → None。
fn expected_role(side: ApiSide, api: &str) -> Option<CallRole> {
    lookup(side, api)?;
    match (side, api) {
        (ApiSide::Base, "createCellEntity") => Some(CallRole::Cell),
        (ApiSide::KBEngineBaseapp, "createEntityRemotely") => Some(CallRole::Base),
        (ApiSide::KBEngineBaseapp, "createEntityRemotelyFromDBID") => Some(CallRole::Base),
        _ => None,
    }
}

/// 核实目标 EntityCall 实参;查无此 API/非目标族 → None。
pub fn check_call_target(side: ApiSide, api: &str, arg: &EntityCallArg) -> Option<TargetCheck> {
    let expected = expected_role(side, api)?;
    Some(match arg {
        EntityCallArg::EntityCall { role: Some(actual) } => {
            if *actual == expected {
                TargetCheck::Ok
            } else {
                TargetCheck::RoleMismatch {
                    expected,
                    actual: *actual,
                }
            }
        }
        // 角色未折叠出——静态不可证,不报(红线)。
        EntityCallArg::EntityCall { role: None } => TargetCheck::Unknown,
        EntityCallArg::NotEntityCall => TargetCheck::NotEntityCall,
        EntityCallArg::Absent => TargetCheck::MissingArg,
        EntityCallArg::Dynamic => TargetCheck::Unknown,
    })
}

/// 核实 space 系实参;查无此 API/非 space 族 → None。
pub fn check_space_target(side: ApiSide, api: &str, arg: &SpaceArg) -> Option<SpaceCheck> {
    lookup(side, api)?;
    match (side, api) {
        // cellapp 本地 createEntity(spaceID):存在性运行时态,静态不可证。
        (ApiSide::KBEngineCellapp, "createEntity") => Some(match arg {
            SpaceArg::Literal(_) => SpaceCheck::RuntimeGate {
                gate: "spaceID 存在性运行时检查(findSpace+isGood,cellapp.cpp:492-499),静态不可证",
            },
            SpaceArg::NonIntegerLiteral | SpaceArg::Dynamic => SpaceCheck::Unknown,
        }),
        (ApiSide::Base, "createCellEntityInNewSpace") => Some(match arg {
            SpaceArg::Literal(v) if *v < 0 => SpaceCheck::NegativeWraps { value: *v },
            SpaceArg::Literal(_) => SpaceCheck::Ok,
            SpaceArg::NonIntegerLiteral => SpaceCheck::NonIntegerFallsBackToZero,
            SpaceArg::Dynamic => SpaceCheck::Unknown,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_entity_call_with_cell_role_is_ok() {
        let c = check_call_target(
            ApiSide::Base,
            "createCellEntity",
            &EntityCallArg::EntityCall { role: Some(CallRole::Cell) },
        )
        .unwrap();
        assert_eq!(c, TargetCheck::Ok);
    }

    #[test]
    fn cell_entity_call_role_mismatch_is_definite() {
        // 引擎 TypeError「not is a direct cellEntityCall!」(entity.cpp:1452-1461)。
        let c = check_call_target(
            ApiSide::Base,
            "createCellEntity",
            &EntityCallArg::EntityCall { role: Some(CallRole::Base) },
        )
        .unwrap();
        assert_eq!(
            c,
            TargetCheck::RoleMismatch { expected: CallRole::Cell, actual: CallRole::Base }
        );
    }

    #[test]
    fn remotely_apis_require_base_role() {
        let bad = check_call_target(
            ApiSide::KBEngineBaseapp,
            "createEntityRemotely",
            &EntityCallArg::EntityCall { role: Some(CallRole::Cell) },
        )
        .unwrap();
        assert_eq!(
            bad,
            TargetCheck::RoleMismatch { expected: CallRole::Base, actual: CallRole::Cell }
        );
        let ok = check_call_target(
            ApiSide::KBEngineBaseapp,
            "createEntityRemotelyFromDBID",
            &EntityCallArg::EntityCall { role: Some(CallRole::Base) },
        )
        .unwrap();
        assert_eq!(ok, TargetCheck::Ok);
    }

    #[test]
    fn unresolved_role_never_mismatches() {
        // 验收红线:仅报告静态可证明的错误——角色折叠不出不报。
        let c = check_call_target(
            ApiSide::Base,
            "createCellEntity",
            &EntityCallArg::EntityCall { role: None },
        )
        .unwrap();
        assert_eq!(c, TargetCheck::Unknown);
    }

    #[test]
    fn not_entity_call_is_definite_type_error() {
        let c = check_call_target(
            ApiSide::Base,
            "createCellEntity",
            &EntityCallArg::NotEntityCall,
        )
        .unwrap();
        assert_eq!(c, TargetCheck::NotEntityCall);
    }

    #[test]
    fn absent_mandatory_arg_is_definite() {
        let c = check_call_target(ApiSide::Base, "createCellEntity", &EntityCallArg::Absent).unwrap();
        assert_eq!(c, TargetCheck::MissingArg);
        let c = check_call_target(
            ApiSide::KBEngineBaseapp,
            "createEntityRemotely",
            &EntityCallArg::Absent,
        )
        .unwrap();
        assert_eq!(c, TargetCheck::MissingArg);
    }

    #[test]
    fn dynamic_target_not_judged() {
        let c = check_call_target(
            ApiSide::Base,
            "createCellEntity",
            &EntityCallArg::Dynamic,
        )
        .unwrap();
        assert_eq!(c, TargetCheck::Unknown);
    }

    #[test]
    fn call_target_unknown_api_is_none() {
        assert!(check_call_target(ApiSide::Base, "createCellEntity", &EntityCallArg::Dynamic).is_some());
        // 非 EntityCall 族 → None 不猜。
        assert!(check_call_target(
            ApiSide::KBEngineBaseapp,
            "createEntityAnywhere",
            &EntityCallArg::Dynamic,
        )
        .is_none());
        assert!(check_call_target(ApiSide::Base, "createEntityMagically", &EntityCallArg::Dynamic).is_none());
    }

    #[test]
    fn space_id_is_runtime_gate_never_static() {
        // spaceID 存在性是运行时状态,任何字面量都证不了——登记不判。
        for v in [1, -1, 999999] {
            let c = check_space_target(
                ApiSide::KBEngineCellapp,
                "createEntity",
                &SpaceArg::Literal(v),
            )
            .unwrap();
            assert!(matches!(c, SpaceCheck::RuntimeGate { .. }), "{v}");
        }
        let c = check_space_target(
            ApiSide::KBEngineCellapp,
            "createEntity",
            &SpaceArg::Dynamic,
        )
        .unwrap();
        assert_eq!(c, SpaceCheck::Unknown);
    }

    #[test]
    fn cellapp_index_zero_and_positive_are_ok() {
        // 0=不强制指定;正数=选第 N 个,不够取模回绕(baseapp.cpp:2531-2545)。
        for v in [0, 1, 4] {
            let c = check_space_target(
                ApiSide::Base,
                "createCellEntityInNewSpace",
                &SpaceArg::Literal(v),
            )
            .unwrap();
            assert_eq!(c, SpaceCheck::Ok, "{v}");
        }
    }

    #[test]
    fn negative_index_wraps_advisory() {
        let c = check_space_target(
            ApiSide::Base,
            "createCellEntityInNewSpace",
            &SpaceArg::Literal(-1),
        )
        .unwrap();
        assert_eq!(c, SpaceCheck::NegativeWraps { value: -1 });
    }

    #[test]
    fn non_integer_index_silently_falls_back_to_zero() {
        // 非 int 静默兜底 0(baseapp.cpp:2539-2542),提示级不是错误。
        let c = check_space_target(
            ApiSide::Base,
            "createCellEntityInNewSpace",
            &SpaceArg::NonIntegerLiteral,
        )
        .unwrap();
        assert_eq!(c, SpaceCheck::NonIntegerFallsBackToZero);
    }

    #[test]
    fn space_target_unknown_api_is_none() {
        assert!(check_space_target(
            ApiSide::Base,
            "createCellEntity",
            &SpaceArg::Literal(0)
        )
        .is_none());
        assert!(check_space_target(
            ApiSide::KBEngineCellapp,
            "createEntityMagically",
            &SpaceArg::Literal(0)
        )
        .is_none());
    }

    #[test]
    fn unknown_role_never_mismatches_across_apis() {
        // 结构性核对:role=None 在任何目标 API 上都产不出 RoleMismatch。
        for (side, api) in [
            (ApiSide::Base, "createCellEntity"),
            (ApiSide::KBEngineBaseapp, "createEntityRemotely"),
            (ApiSide::KBEngineBaseapp, "createEntityRemotelyFromDBID"),
        ] {
            let c = check_call_target(side, api, &EntityCallArg::EntityCall { role: None }).unwrap();
            assert_ne!(c, TargetCheck::RoleMismatch { expected: CallRole::Base, actual: CallRole::Base });
            assert!(matches!(c, TargetCheck::Unknown), "{api}");
        }
    }
}
