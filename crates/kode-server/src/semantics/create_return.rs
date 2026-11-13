//! 创建 API 返回值推导(KSEM-CREATE-03)。
//!
//! 创建 API 的返回值按具体 API 赋型(CREATE-01 契约表驱动,两面不漂移):
//!
//! - **同步返实体**仅两个本地 API(baseapp/cellapp 的 `createEntity`):
//!   调用表达式求值为本地实体对象,类名按 entityType 字面量实参
//!   (`SemType::Entity(类名)`);实体名动态 → `Unknown`(实体引用成立、
//!   类未知,不硬造类名);
//! - **异步 API**(anywhere/remotely/FromDBID 族/createCellEntity 族):
//!   调用表达式求值为 None——**绝不视作返回本地对象**(验收红线);实体
//!   价值走回调交付面(`delivery_type_of`):anywhere/remotely 单参 =
//!   实体对象或 BASE EntityCall 句柄(静态不定向 → 联合,不任取);
//!   FromDBID 族三参 = 实体|None + dbid + wasActive;createCellEntity 族
//!   无回调参,经 `onGetCell` 浮出;
//! - 查无此 API(side+name 不在契约表)→ None——不猜。
//!
//! 引擎出处:同步面 baseapp.cpp:977-980 / cellapp.cpp:517-530 直接返回
//! 实体对象(失败走异常非 None);异步面 S_Return 返回 None
//! (baseapp.cpp:1024/:1084/:1206 等);anywhere 回调两分支实体/句柄
//! (baseapp.cpp:2798-2859);FromDBID 三参 "OKi"(baseapp.cpp:1375)。

use super::create_api::{ApiSide, CallbackShape, SyncReturn, contracts, lookup};
use super::types::SemType;

/// 创建 API 调用表达式的求值形态。
#[derive(Debug, Clone, PartialEq)]
pub enum CallValue {
    /// 同步返回本地实体;内含实体类类型(字面量名 → Entity(类名),
    /// 动态名 → Unknown 带因)。
    LocalEntity(SemType),
    /// 异步 API:调用表达式求值为 None——消费面不应在其上做实体操作。
    AsyncNone,
}

/// 回调交付面形态(异步 API 的实体价值入口)。
#[derive(Debug, Clone, PartialEq)]
pub enum Delivery {
    /// 契约无回调参。
    NoCallback,
    /// 经 Base 的 `onGetCell()` 无参回调浮出。
    OnGetCell,
    /// 单参:本 app 创建 = 实体对象;跨 app = BASE EntityCall 句柄
    /// (静态不定向 → 联合两态,消费面不任取)。
    EntityOrMailbox { entity: SemType, mailbox: SemType },
    /// 三参:实体引用|None, dbid(整型), wasActive(0/1 整型)。
    RefDbidWasActive {
        /// 查库失败为 None → Nullable(Entity);实体化失败无通知(不在此型)。
        entity: SemType,
        dbid: SemType,
        was_active: SemType,
    },
}

/// 创建 API 调用表达式的返回值形态;查无此 API(side+name 不在表)→ None。
pub fn call_value_of(side: ApiSide, api: &str, entity_type_literal: Option<&str>) -> Option<CallValue> {
    let contract = lookup(side, api)?;
    match contract.sync_return {
        SyncReturn::EntityDirect => {
            let ty = match entity_type_literal {
                Some(name) => SemType::Entity(name.to_string()),
                None => SemType::Unknown(
                    "本地实体引用成立,但实体名为动态形态,类未知".to_string(),
                ),
            };
            Some(CallValue::LocalEntity(ty))
        }
        SyncReturn::NoneAsync => Some(CallValue::AsyncNone),
    }
}

/// 异步 API 的回调交付面;查无此 API → None。
pub fn delivery_type_of(side: ApiSide, api: &str, entity_type_literal: Option<&str>) -> Option<Delivery> {
    let contract = lookup(side, api)?;
    let entity_ty = || match entity_type_literal {
        Some(name) => SemType::Entity(name.to_string()),
        None => SemType::Unknown("实体名动态,交付实体类未知".to_string()),
    };
    Some(match contract.callback {
        CallbackShape::None => Delivery::NoCallback,
        CallbackShape::OnGetCellNoArgs => Delivery::OnGetCell,
        CallbackShape::OneArgEntityOrMailbox => Delivery::EntityOrMailbox {
            entity: entity_ty(),
            mailbox: SemType::Builtin("ENTITYCALL".to_string()),
        },
        CallbackShape::ThreeArgRefDbidWasActive => Delivery::RefDbidWasActive {
            entity: SemType::Nullable(Box::new(entity_ty())),
            dbid: SemType::Builtin("DBID".to_string()),
            was_active: SemType::Builtin("UINT8".to_string()),
        },
    })
}

/// 全表一致性核对(测试/审计用):同步返实体的 API 必是 Local 族,
/// 异步 API 必不产 LocalEntity——「不将所有创建 API 视为返回本地对象」
/// 的结构性防线。
pub fn audit_sync_local_only() -> Result<(), String> {
    for c in contracts() {
        match c.sync_return {
            SyncReturn::EntityDirect if c.kind != super::create_api::CreateKind::Local => {
                return Err(format!("{} 非本地创建却同步返实体", c.name));
            }
            SyncReturn::NoneAsync => {}
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baseapp_local_create_returns_local_entity_with_literal_class() {
        let v = call_value_of(ApiSide::KBEngineBaseapp, "createEntity", Some("Avatar")).unwrap();
        assert_eq!(v, CallValue::LocalEntity(SemType::Entity("Avatar".to_string())));
    }

    #[test]
    fn dynamic_entity_name_keeps_unknown_not_fake_class() {
        let v = call_value_of(ApiSide::KBEngineBaseapp, "createEntity", None).unwrap();
        assert!(matches!(v, CallValue::LocalEntity(SemType::Unknown(_))));
    }

    #[test]
    fn cellapp_local_create_returns_local_entity() {
        let v = call_value_of(ApiSide::KBEngineCellapp, "createEntity", Some("SpawnPoint")).unwrap();
        assert_eq!(v, CallValue::LocalEntity(SemType::Entity("SpawnPoint".to_string())));
    }

    #[test]
    fn async_apis_never_return_local_object() {
        // 验收红线:七条异步 API 全部无返回,不视作本地对象。
        for (side, api) in [
            (ApiSide::KBEngineBaseapp, "createEntityAnywhere"),
            (ApiSide::KBEngineBaseapp, "createEntityRemotely"),
            (ApiSide::KBEngineBaseapp, "createEntityFromDBID"),
            (ApiSide::KBEngineBaseapp, "createEntityAnywhereFromDBID"),
            (ApiSide::KBEngineBaseapp, "createEntityRemotelyFromDBID"),
            (ApiSide::Base, "createCellEntity"),
            (ApiSide::Base, "createCellEntityInNewSpace"),
        ] {
            assert_eq!(
                call_value_of(side, api, Some("Avatar")),
                Some(CallValue::AsyncNone),
                "{api}"
            );
        }
    }

    #[test]
    fn unknown_api_is_none_not_guessed() {
        assert!(call_value_of(ApiSide::KBEngineBaseapp, "createEntityMagically", None).is_none());
        assert!(call_value_of(ApiSide::Base, "createEntity", None).is_none());
        assert!(call_value_of(ApiSide::KBEngineCellapp, "createEntityAnywhere", None).is_none());
    }

    #[test]
    fn anywhere_delivery_is_entity_or_mailbox_union() {
        let d = delivery_type_of(ApiSide::KBEngineBaseapp, "createEntityAnywhere", Some("Avatar")).unwrap();
        assert_eq!(
            d,
            Delivery::EntityOrMailbox {
                entity: SemType::Entity("Avatar".to_string()),
                mailbox: SemType::Builtin("ENTITYCALL".to_string()),
            }
        );
    }

    #[test]
    fn from_dbid_delivery_is_nullable_triple() {
        for api in [
            "createEntityFromDBID",
            "createEntityAnywhereFromDBID",
            "createEntityRemotelyFromDBID",
        ] {
            let d = delivery_type_of(ApiSide::KBEngineBaseapp, api, None).unwrap();
            match d {
                Delivery::RefDbidWasActive { entity, .. } => {
                    // 查库失败为 None → Nullable 包实体型。
                    assert!(matches!(entity, SemType::Nullable(inner)
                        if matches!(&*inner, SemType::Unknown(_))), "{api}");
                }
                other => panic!("{api} 交付面错: {other:?}"),
            }
        }
    }

    #[test]
    fn cell_entity_delivery_is_on_get_cell() {
        for api in ["createCellEntity", "createCellEntityInNewSpace"] {
            assert_eq!(
                delivery_type_of(ApiSide::Base, api, None),
                Some(Delivery::OnGetCell),
                "{api}"
            );
        }
    }

    #[test]
    fn local_creates_have_no_callback_delivery() {
        for (side, api) in [
            (ApiSide::KBEngineBaseapp, "createEntity"),
            (ApiSide::KBEngineCellapp, "createEntity"),
        ] {
            assert_eq!(delivery_type_of(side, api, None), Some(Delivery::NoCallback), "{api}");
        }
    }

    #[test]
    fn delivery_unknown_api_is_none() {
        assert!(delivery_type_of(ApiSide::KBEngineCellapp, "createCellEntity", None).is_none());
    }

    #[test]
    fn audit_holds_on_registry() {
        audit_sync_local_only().expect("契约表自洽");
    }
}
