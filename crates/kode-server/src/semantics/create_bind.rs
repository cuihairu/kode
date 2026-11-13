//! 创建 API 异步回调绑定(KSEM-CREATE-04)。
//!
//! 异步创建 API(CREATE-01 契约)的 callback 实参绑定:把「明确回调」
//! 的形参身份从契约形态传播出去(单参=实体|句柄联合、三参=实体|None+
//! dbid+wasActive),失败值面逐族登记(FromDBID 常规失败=首参 None、
//! AnywhereFromDbid id 分配失败=单参 False、实体化失败=不通知——通知
//! 不闭合三态,CREATE-01 已核)。
//!
//! - **可解析回调**(bound method `self.onCreated` / 模块函数,消费方
//!   解析出目标名+形参表传入):形参数对上契约 → `Bound` 逐形参赋型;
//!   对不上 → `ArityMismatch`(引擎 TypeError/静默按 guards);
//! - **动态回调**(变量/getattr/lambda/任意表达式):`Unresolved`——
//!   **不猜**(验收红线);
//! - **未传**(可选回调缺省):`NotProvided`——合法,结果无通知面;
//! - **契约无回调参位**(本地 createEntity/cell 族传了 callable):
//!   `NoCallbackSlot`——引擎不收这个参,错位归 CREATE-01 位数闸;
//!   cell 族成功浮出走 Base 的 `onGetCell()` 无参回调 →
//!   `DeliveredViaOnGetCell`(无形参身份可传播);
//! - 查无此 API → None——不猜。
//!
//! 引擎出处(承 CREATE-01 逐行核):anywhere 单参两分支 baseapp.cpp:
//! 2798-2859;三参 "OKi" baseapp.cpp:1375;id 分配失败单参 False
//! baseapp.cpp:1678-1690;实体化失败不通知 baseapp.cpp:1428-1436;
//! onGetCell 浮出 baseapp/entity.cpp:1032。

use super::create_api::{ApiSide, CallbackShape, lookup};
use super::types::SemType;

/// callback 实参形态(消费方从调用点 AST 折叠后传入)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallbackArg {
    /// 可解析回调(bound method/模块函数):目标名 + 形参表
    /// (形参表由消费方从目标 def 解析,库面不持 AST)。
    Resolvable { target: String, params: Vec<String> },
    /// 动态形态(变量/getattr/lambda/任意表达式)——不猜。
    Dynamic,
    /// 可选回调参未传。
    Absent,
}

/// 失败通知形态(逐族登记;通知不闭合三态承 CREATE-01)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureNotice {
    /// FromDBID 族常规失败(查库无果):三参回调首参收 None。
    FirstArgNone,
    /// AnywhereFromDbid 的 id 分配失败:回调变**单参 False**
    /// (baseapp.cpp:1678-1690)——形态与常规三参不同,消费面按位分诊。
    SingleArgFalse,
    /// 实体化失败:回调**不触发**(baseapp.cpp:1428-1436)——不闭合。
    NotNotified,
}

/// 回调绑定结论。
#[derive(Debug, Clone, PartialEq)]
pub enum BindCheck {
    /// 绑定成立:目标名 + 逐形参(形参名 → 型)+ 失败通知面。
    /// 单参型 = 实体|ENTITYCALL 联合(本 app=实体、跨 app=句柄,静态
    /// 不定向不任取);三参型 = Nullable(实体)、DBID、UINT8。
    Bound {
        target: String,
        params: Vec<(String, SemType)>,
        failure_notices: Vec<FailureNotice>,
    },
    /// 形参数与契约不符(引擎 TypeError 或静默,归 CREATE-01 guards)。
    ArityMismatch {
        target: String,
        expected: usize,
        actual: usize,
    },
    /// 动态回调——保持未知不猜。
    Unresolved { reason: String },
    /// 可选回调未传——合法缺省,结果无通知面。
    NotProvided,
    /// 该 API 契约无 callback 参位(传了也引擎不收)。
    NoCallbackSlot,
    /// cell 族:传入面无回调参,成功浮出走 Base 的 `onGetCell()` 无参
    /// 回调——无形参身份可传播。
    DeliveredViaOnGetCell,
}

/// 绑定 callback 实参到契约;查无此 API(side+name 不在表)→ None。
pub fn bind_callback(
    side: ApiSide,
    api: &str,
    entity_type_literal: Option<&str>,
    arg: &CallbackArg,
) -> Option<BindCheck> {
    let contract = lookup(side, api)?;
    let entity_ty = || match entity_type_literal {
        Some(name) => SemType::Entity(name.to_string()),
        None => SemType::Unknown("实体名动态,交付实体类未知".to_string()),
    };
    Some(match contract.callback {
        // 契约无回调参位:本地 createEntity(同步返回)与 cell 族。
        CallbackShape::None => BindCheck::NoCallbackSlot,
        CallbackShape::OnGetCellNoArgs => match arg {
            // 未传 callable = 正常态(cell 族本无回调参位,浮出走 onGetCell)。
            CallbackArg::Absent => BindCheck::DeliveredViaOnGetCell,
            _ => BindCheck::NoCallbackSlot,
        },
        CallbackShape::OneArgEntityOrMailbox => match arg {
            CallbackArg::Absent => BindCheck::NotProvided,
            CallbackArg::Dynamic => BindCheck::Unresolved {
                reason: "回调实参为动态形态(变量/getattr/lambda),目标不可解析".to_string(),
            },
            CallbackArg::Resolvable { target, params } => {
                if params.len() != 1 {
                    return Some(BindCheck::ArityMismatch {
                        target: target.clone(),
                        expected: 1,
                        actual: params.len(),
                    });
                }
                BindCheck::Bound {
                    target: target.clone(),
                    params: vec![(
                        params[0].clone(),
                        SemType::Union(vec![entity_ty(), SemType::Builtin("ENTITYCALL".to_string())]),
                    )],
                    failure_notices: vec![],
                }
            }
        },
        CallbackShape::ThreeArgRefDbidWasActive => match arg {
            CallbackArg::Absent => BindCheck::NotProvided,
            CallbackArg::Dynamic => BindCheck::Unresolved {
                reason: "回调实参为动态形态(变量/getattr/lambda),目标不可解析".to_string(),
            },
            CallbackArg::Resolvable { target, params } => {
                if params.len() != 3 {
                    return Some(BindCheck::ArityMismatch {
                        target: target.clone(),
                        expected: 3,
                        actual: params.len(),
                    });
                }
                // 失败面:查库失败首参 None;实体化失败不触发;
                // AnywhereFromDbid 的 id 分配失败额外变单参 False。
                let mut notices = vec![FailureNotice::FirstArgNone, FailureNotice::NotNotified];
                if contract.name == "createEntityAnywhereFromDBID" {
                    notices.push(FailureNotice::SingleArgFalse);
                }
                BindCheck::Bound {
                    target: target.clone(),
                    params: vec![
                        (params[0].clone(), SemType::Nullable(Box::new(entity_ty()))),
                        (params[1].clone(), SemType::Builtin("DBID".to_string())),
                        (params[2].clone(), SemType::Builtin("UINT8".to_string())),
                    ],
                    failure_notices: notices,
                }
            }
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolvable(name: &str, n: usize) -> CallbackArg {
        CallbackArg::Resolvable {
            target: name.to_string(),
            params: (0..n).map(|i| format!("p{i}")).collect(),
        }
    }

    #[test]
    fn anywhere_bound_method_single_param_gets_union() {
        let b = bind_callback(
            ApiSide::KBEngineBaseapp,
            "createEntityAnywhere",
            Some("Avatar"),
            &resolvable("self.onCreated", 1),
        )
        .unwrap();
        match b {
            BindCheck::Bound { target, params, failure_notices } => {
                assert_eq!(target, "self.onCreated");
                assert_eq!(failure_notices, vec![]);
                assert_eq!(
                    params[0].1,
                    SemType::Union(vec![
                        SemType::Entity("Avatar".to_string()),
                        SemType::Builtin("ENTITYCALL".to_string()),
                    ])
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn dynamic_entity_name_propagates_unknown_in_union() {
        let b = bind_callback(
            ApiSide::KBEngineBaseapp,
            "createEntityAnywhere",
            None,
            &resolvable("on_created", 1),
        )
        .unwrap();
        match b {
            BindCheck::Bound { params, .. } => assert!(matches!(
                &params[0].1,
                SemType::Union(items)
                    if matches!(&items[0], SemType::Unknown(_))
            )),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn dynamic_callback_never_binds() {
        // 验收红线:动态回调不猜,绝不产 Bound。
        for api in ["createEntityAnywhere", "createEntityRemotely", "createEntityFromDBID"] {
            let b = bind_callback(
                ApiSide::KBEngineBaseapp,
                api,
                Some("Avatar"),
                &CallbackArg::Dynamic,
            )
            .unwrap();
            assert!(matches!(b, BindCheck::Unresolved { .. }), "{api}");
        }
    }

    #[test]
    fn absent_callback_is_legal_default() {
        let b = bind_callback(
            ApiSide::KBEngineBaseapp,
            "createEntityAnywhere",
            None,
            &CallbackArg::Absent,
        )
        .unwrap();
        assert_eq!(b, BindCheck::NotProvided);
    }

    #[test]
    fn from_dbid_triple_binds_nullable_dbid_uint8_with_failure_notices() {
        let b = bind_callback(
            ApiSide::KBEngineBaseapp,
            "createEntityFromDBID",
            Some("Avatar"),
            &resolvable("self.onLoaded", 3),
        )
        .unwrap();
        match b {
            BindCheck::Bound { params, failure_notices, .. } => {
                assert!(matches!(&params[0].1, SemType::Nullable(_)));
                assert_eq!(params[1].1, SemType::Builtin("DBID".to_string()));
                assert_eq!(params[2].1, SemType::Builtin("UINT8".to_string()));
                assert_eq!(
                    failure_notices,
                    vec![FailureNotice::FirstArgNone, FailureNotice::NotNotified]
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn anywhere_from_dbid_adds_single_arg_false_notice() {
        let b = bind_callback(
            ApiSide::KBEngineBaseapp,
            "createEntityAnywhereFromDBID",
            None,
            &resolvable("onLoaded", 3),
        )
        .unwrap();
        match b {
            BindCheck::Bound { failure_notices, .. } => assert_eq!(
                failure_notices,
                vec![
                    FailureNotice::FirstArgNone,
                    FailureNotice::NotNotified,
                    FailureNotice::SingleArgFalse,
                ]
            ),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn arity_mismatch_on_wrong_param_counts() {
        // 三参契约收单参回调。
        let b = bind_callback(
            ApiSide::KBEngineBaseapp,
            "createEntityFromDBID",
            None,
            &resolvable("cb", 1),
        )
        .unwrap();
        assert_eq!(
            b,
            BindCheck::ArityMismatch { target: "cb".to_string(), expected: 3, actual: 1 }
        );
        // 单参契约收三参回调。
        let b = bind_callback(
            ApiSide::KBEngineBaseapp,
            "createEntityRemotely",
            None,
            &resolvable("cb", 3),
        )
        .unwrap();
        assert_eq!(
            b,
            BindCheck::ArityMismatch { target: "cb".to_string(), expected: 1, actual: 3 }
        );
    }

    #[test]
    fn local_creates_have_no_callback_slot() {
        // 本地 createEntity 同步返回,契约无回调参位;传了引擎不收。
        for (side, api) in [
            (ApiSide::KBEngineBaseapp, "createEntity"),
            (ApiSide::KBEngineCellapp, "createEntity"),
        ] {
            let b = bind_callback(side, api, Some("Avatar"), &resolvable("cb", 1)).unwrap();
            assert_eq!(b, BindCheck::NoCallbackSlot, "{api}");
        }
    }

    #[test]
    fn cell_family_absent_delivers_via_on_get_cell() {
        for api in ["createCellEntity", "createCellEntityInNewSpace"] {
            let b = bind_callback(ApiSide::Base, api, None, &CallbackArg::Absent).unwrap();
            assert_eq!(b, BindCheck::DeliveredViaOnGetCell, "{api}");
            // 传了 callable 仍是 NoCallbackSlot(引擎不收)。
            let b = bind_callback(ApiSide::Base, api, None, &resolvable("cb", 0)).unwrap();
            assert_eq!(b, BindCheck::NoCallbackSlot, "{api}");
        }
    }

    #[test]
    fn unknown_api_is_none_not_guessed() {
        assert!(bind_callback(
            ApiSide::KBEngineBaseapp,
            "createEntityMagically",
            None,
            &resolvable("cb", 1)
        )
        .is_none());
        assert!(bind_callback(ApiSide::Base, "createEntityAnywhere", None, &CallbackArg::Absent).is_none());
    }

    #[test]
    fn bound_only_from_resolvable() {
        // 结构性核对:Dynamic/Absent 两形态在任何 API 上都产不出 Bound。
        for c in super::super::create_api::contracts() {
            for arg in [CallbackArg::Dynamic, CallbackArg::Absent] {
                if let Some(BindCheck::Bound { .. }) =
                    bind_callback(c.side, c.name, Some("Avatar"), &arg)
                {
                    panic!("{} 上 {arg:?} 产出了 Bound", c.name);
                }
            }
        }
    }
}
