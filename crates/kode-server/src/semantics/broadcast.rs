//! 广播调用语义登记(KSEM-RPC-08)。
//!
//! 引擎的广播接收面是 `allClients` / `otherClients` 两个属性对象
//! (cellapp/entity.cpp:76-77 SCRIPT_GET_DECLARE,**仅 cellapp 进程**;
//! baseapp/entity.cpp:36-41 无此 getter,client_lib 亦无)——由
//! `AllClients` 同一类型携带 `otherClients_` 标志实现两态
//! (cellapp/entity.cpp:118-119:allClients=…,false / otherClients=…,true)。
//!
//! 接收者集合(clients_remote_entity_method.cpp::callmethod 逐行核):
//! - `allClients.m()`:**先发自己的客户端**(:101-108,须 pWitness &&
//!   clientEntityCall),再广播给每个观察者实体的客户端(:117-138 循环,
//!   须对方 pWitness/未销毁/有 clientEntityCall/通道/`entityInView`);
//! - `otherClients.m()`:跳过自己,**仅观察者们的客户端**(:97-99 零观察者
//!   直接返回)——可为零收;
//! - 两者都是**一调用达 N 客户端**(onRemoteMethodCall / 别名优化变体),
//!   与 `self.client.m()`(单收,仅自己的客户端)是三类不同接收面,
//!   绝不把广播画成单客户端。
//!
//! 方法查找只查 **client 段**(`findClientMethodDescription`,
//! all_clients.cpp:81/:167);组件广播 `allClients.<组件>.m()` 由
//! `AllClientsComponent` 查**组件自身 def 模块**的 client 段并透传
//! otherClients 标志(all_clients.cpp:60-95)。属性名未命中 client 段
//! → 回落普通属性臂(与 RPC-04 同族,不在取属性时硬报错)。
//! 非 cellapp 进程语境:实体无此属性 → AttributeError;组件路径转发到
//! 宿主实体 `allClients` 同样 AttributeError(entity_component.cpp:1664-1670)。
//!
//! 调用点数量:client 段方法 `isCell()`=false,checkArgs offset=0
//! (method.cpp:83)→ 广播调用实参恒按 def 声明位,无 caller 注入。

use super::refs::ScriptFace;
use super::snapshot::{EntitySnapshot, MethodView};

/// 广播属性名(实际引擎 API,不接受其它名字)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BroadcastAttr {
    /// `allClients`:自己的客户端 + 全部观察者客户端。
    AllClients,
    /// `otherClients`:仅观察者客户端,不含自己,可零收。
    OtherClients,
}

/// 接收者集合(逐项核实引擎发送面后登记,不合并成「某客户端」)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecipientSet {
    /// 单收:`self.client.m()` 族——仅实体自己的客户端
    /// (本模块不产出此态,列出以对照;单收面归 RPC-04/RPC-05 引用解析)。
    OwnClient,
    /// 多收:自己的客户端(若有)+ 每个观察者的客户端(allClients)。
    OwnPlusWitnesses,
    /// 多收:仅观察者们的客户端,不含自己,可零收(otherClients)。
    WitnessesOnly,
}

/// 广播核查结论。
#[derive(Debug, Clone, PartialEq)]
pub enum BroadcastCheck {
    /// 广播成立:方法在对应 def 模块的 client 段命中;接收者按属性名分集合。
    Delivered {
        /// allClients → OwnPlusWitnesses;otherClients → WitnessesOnly。
        recipients: RecipientSet,
        /// 组件广播时为 Some(组件名)——查找面是组件自身 def 模块。
        component: Option<String>,
        /// client 段命中的声明(通常一条;接口合并多候选全列不任取)。
        targets: Vec<MethodView>,
    },
    /// 名字不在 client 段:引擎取属性时回落普通属性臂
    /// (all_clients.cpp onScriptGetAttribute 尾),不构成广播调用;
    /// 是否报错归消费面(与 RPC-04 本地派发同纪律)。
    NotBroadcastTarget {
        component: Option<String>,
    },
    /// 非 cellapp 进程语境:baseapp/client 进程实体无 allClients/otherClients
    /// 属性(运行时 AttributeError;组件路径转发宿主同错)。
    UnavailableOnProcess {
        caller_face: ScriptFace,
    },
    /// 声明尚未就绪(实体快照缺/组件快照缺)——不判确定性缺失。
    NotReady {
        reason: String,
    },
}

/// 核查一次广播调用(`self.allClients[.<组件>].<方法>(...)` 形态)。
///
/// 判定次序:进程可用性(结构,先判)→ 声明就绪 → client 段查找 → 分诊。
/// 查找面:无组件 = 宿主实体快照 client 段;有组件 = **组件自身快照**
/// client 段(宿主快照同面命中不参与,防跨模块同名误绑)。
pub fn check_broadcast(
    caller_face: ScriptFace,
    receiver: BroadcastAttr,
    component: Option<&str>,
    method: &str,
    owner_snapshot: Option<&EntitySnapshot>,
    component_snapshot: Option<&EntitySnapshot>,
) -> BroadcastCheck {
    // 广播属性仅 cellapp 进程存在(cellapp/entity.cpp:76-77;
    // baseapp/client 侧无 getter → AttributeError)。
    if caller_face != ScriptFace::Cell {
        return BroadcastCheck::UnavailableOnProcess { caller_face };
    }

    // 接收者集合按属性名逐项登记,两态不同,绝不合并。
    let recipients = match receiver {
        BroadcastAttr::AllClients => RecipientSet::OwnPlusWitnesses,
        BroadcastAttr::OtherClients => RecipientSet::WitnessesOnly,
    };

    // 组件广播查组件自身 def 模块(all_clients.cpp:60-95);无组件查宿主。
    let (snapshot, is_component) = match component {
        Some(name) => match component_snapshot {
            Some(snap) => (Some(snap), Some(name.to_string())),
            None => (
                None,
                Some(name.to_string()),
            ),
        },
        None => (owner_snapshot, None),
    };

    let Some(snapshot) = snapshot else {
        return BroadcastCheck::NotReady {
            reason: match is_component {
                Some(name) => format!("组件 {name} 的 def 快照缺失"),
                None => "实体 def 快照缺失".to_string(),
            },
        };
    };

    // 只查 client 段(findClientMethodDescription,all_clients.cpp:81/:167);
    // base/cell 段同名不参与。
    let targets: Vec<MethodView> = snapshot
        .client_methods
        .iter()
        .filter(|m| m.name == method)
        .cloned()
        .collect();

    if targets.is_empty() {
        return BroadcastCheck::NotBroadcastTarget {
            component: is_component,
        };
    }

    BroadcastCheck::Delivered {
        recipients,
        component: is_component,
        targets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantics::id::Facet;

    fn view(name: &str, facet: Facet) -> MethodView {
        MethodView {
            name: name.to_string(),
            facet,
            args: vec![],
            exposed: false,
            file: "test.entities".to_string(),
            line: Some(1),
            from: "Avatar".to_string(),
        }
    }

    fn snapshot_with_client(methods: &[&str]) -> EntitySnapshot {
        let mut snap = EntitySnapshot::default();
        for m in methods {
            snap.client_methods.push(view(m, Facet::Client));
        }
        // 干扰项:同名落在 base/cell 段,client 段查找必须无视之。
        snap.base_methods.push(view("hit", Facet::Base));
        snap.cell_methods.push(view("hit", Facet::Cell));
        snap
    }

    #[test]
    fn all_clients_on_cell_reaches_own_plus_witnesses() {
        let snap = snapshot_with_client(&["hit"]);
        let check = check_broadcast(
            ScriptFace::Cell,
            BroadcastAttr::AllClients,
            None,
            "hit",
            Some(&snap),
            None,
        );
        assert_eq!(
            check,
            BroadcastCheck::Delivered {
                recipients: RecipientSet::OwnPlusWitnesses,
                component: None,
                targets: vec![view("hit", Facet::Client)],
            }
        );
    }

    #[test]
    fn other_clients_excludes_own_client() {
        // otherClients 只达观察者客户端,不含自己;可零收。
        let snap = snapshot_with_client(&["hit"]);
        let check = check_broadcast(
            ScriptFace::Cell,
            BroadcastAttr::OtherClients,
            None,
            "hit",
            Some(&snap),
            None,
        );
        assert!(matches!(check,
            BroadcastCheck::Delivered { recipients: RecipientSet::WitnessesOnly, .. }));
    }

    #[test]
    fn broadcast_is_never_drawn_as_single_client() {
        // 验收红线:两广播接收面都与「单客户端」不同类。
        let snap = snapshot_with_client(&["hit"]);
        for attr in [BroadcastAttr::AllClients, BroadcastAttr::OtherClients] {
            let check = check_broadcast(ScriptFace::Cell, attr, None, "hit", Some(&snap), None);
            match check {
                BroadcastCheck::Delivered { recipients, .. } => {
                    assert_ne!(recipients, RecipientSet::OwnClient, "{attr:?}");
                }
                other => panic!("{attr:?} → {other:?}"),
            }
        }
        // 且 allClients 与 otherClients 互不相同。
        let a = check_broadcast(ScriptFace::Cell, BroadcastAttr::AllClients, None, "hit", Some(&snap), None);
        let b = check_broadcast(ScriptFace::Cell, BroadcastAttr::OtherClients, None, "hit", Some(&snap), None);
        assert_ne!(a, b);
    }

    #[test]
    fn baseapp_and_client_faces_have_no_broadcast_attrs() {
        // 非 cellapp 进程无此属性(运行时 AttributeError)——结构先判,
        // 快照缺失也不掩盖此结论。
        let check = check_broadcast(
            ScriptFace::Base,
            BroadcastAttr::AllClients,
            None,
            "hit",
            None,
            None,
        );
        assert_eq!(
            check,
            BroadcastCheck::UnavailableOnProcess {
                caller_face: ScriptFace::Base,
            }
        );
        let check = check_broadcast(
            ScriptFace::Client,
            BroadcastAttr::OtherClients,
            None,
            "hit",
            None,
            None,
        );
        assert!(matches!(check,
            BroadcastCheck::UnavailableOnProcess { caller_face: ScriptFace::Client }));
    }

    #[test]
    fn component_broadcast_resolves_in_component_module() {
        // 组件广播查组件自身 def 模块 client 段,otherClients 标志透传。
        let owner = snapshot_with_client(&["hit"]); // 宿主有同名,不参与组件查找
        let mut comp = EntitySnapshot::default();
        comp.client_methods.push(view("compHit", Facet::Client));
        let check = check_broadcast(
            ScriptFace::Cell,
            BroadcastAttr::AllClients,
            Some("Bag"),
            "compHit",
            Some(&owner),
            Some(&comp),
        );
        assert!(matches!(check,
            BroadcastCheck::Delivered { recipients: RecipientSet::OwnPlusWitnesses, component: Some(ref c), .. }
            if c == "Bag"));
        if let BroadcastCheck::Delivered { targets, .. } = check {
            assert_eq!(targets.len(), 1);
            assert_eq!(targets[0].name, "compHit");
        }
    }

    #[test]
    fn component_same_name_owner_hit_is_not_bound() {
        // 组件广播时宿主 client 段同名方法不参与(防跨模块同名误绑)。
        let owner = snapshot_with_client(&["hit"]);
        let mut comp = EntitySnapshot::default();
        comp.client_methods.push(view("hit", Facet::Client));
        let check = check_broadcast(
            ScriptFace::Cell,
            BroadcastAttr::AllClients,
            Some("Bag"),
            "hit",
            Some(&owner),
            Some(&comp),
        );
        if let BroadcastCheck::Delivered { targets, .. } = check {
            // 只取组件模块一份,宿主同名未混入。
            assert_eq!(targets.len(), 1);
        } else {
            panic!("expected Delivered, got {check:?}");
        }
    }

    #[test]
    fn component_snapshot_missing_is_not_ready() {
        let owner = snapshot_with_client(&["hit"]);
        let check = check_broadcast(
            ScriptFace::Cell,
            BroadcastAttr::OtherClients,
            Some("Bag"),
            "hit",
            Some(&owner),
            None,
        );
        assert!(matches!(check, BroadcastCheck::NotReady { .. }));
    }

    #[test]
    fn owner_snapshot_missing_is_not_ready() {
        let check = check_broadcast(
            ScriptFace::Cell,
            BroadcastAttr::AllClients,
            None,
            "hit",
            None,
            None,
        );
        assert!(matches!(check, BroadcastCheck::NotReady { .. }));
    }

    #[test]
    fn method_only_in_base_or_cell_section_is_not_broadcast_target() {
        // 广播只查 client 段;同名只在 base/cell 段 → 不构成广播目标。
        let mut snap = EntitySnapshot::default();
        snap.base_methods.push(view("hit", Facet::Base));
        snap.cell_methods.push(view("hit", Facet::Cell));
        let check = check_broadcast(
            ScriptFace::Cell,
            BroadcastAttr::AllClients,
            None,
            "hit",
            Some(&snap),
            None,
        );
        assert_eq!(
            check,
            BroadcastCheck::NotBroadcastTarget { component: None }
        );
    }

    #[test]
    fn client_section_miss_is_not_broadcast_target() {
        let snap = snapshot_with_client(&["other"]);
        let check = check_broadcast(
            ScriptFace::Cell,
            BroadcastAttr::AllClients,
            None,
            "hit",
            Some(&snap),
            None,
        );
        assert_eq!(
            check,
            BroadcastCheck::NotBroadcastTarget { component: None }
        );
    }

    #[test]
    fn client_method_need_not_be_exposed_for_broadcast() {
        // 服务端 → 客户端方向的广播无 Exposed 闸(RPC-05 的闸是 client
        // 进程调服务端的反向面);非 exposed client 段方法照常广播。
        let mut snap = EntitySnapshot::default();
        let mut m = view("hit", Facet::Client);
        m.exposed = false;
        snap.client_methods.push(m);
        let check = check_broadcast(
            ScriptFace::Cell,
            BroadcastAttr::AllClients,
            None,
            "hit",
            Some(&snap),
            None,
        );
        assert!(matches!(check, BroadcastCheck::Delivered { .. }));
    }

    #[test]
    fn component_broadcast_on_base_face_is_unavailable() {
        // 组件路径转发宿主 allClients(entity_component.cpp:1664-1670),
        // baseapp 宿主无此属性 → AttributeError,与直连路径同因。
        let mut comp = EntitySnapshot::default();
        comp.client_methods.push(view("hit", Facet::Client));
        let check = check_broadcast(
            ScriptFace::Base,
            BroadcastAttr::AllClients,
            Some("Bag"),
            "hit",
            None,
            Some(&comp),
        );
        assert!(matches!(check,
            BroadcastCheck::UnavailableOnProcess { caller_face: ScriptFace::Base }));
    }
}
