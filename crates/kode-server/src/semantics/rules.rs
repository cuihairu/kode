//! RPC-05 角色与暴露规则(纯库面,无 RPC/无 TS 消费)。
//!
//! 三类诊断分开出(逐行核过 `../kbengine`):
//! - **客户端 Exposed**:调用方进程是 client/bots 且引用形态为远程句柄时,
//!   def 表命中但候选全部未 Exposed → 回落普通属性臂(entity_call.cpp:117-121;
//!   组件同闸 entity_component_call.cpp:99-103)→ 属性错误,调用不可达;
//!   本地实体/本地组件为 plain Python 派发,无此闸;
//! - **服务端调用方向**:引用形态在当前脚本面不可获取——self 角色属性
//!   该面没有(RPC-02 三面表)+ 面跳闭包推不到的调用类型(RPC-01 矩阵)
//!   + None 引用 + 组件槽结构缺失(槽未声明/未指定类型);
//! - **缺方法**:声明就绪(类已知、快照在手、槽链齐)、对应面 Methods 段
//!   确认无此名 → 远程句柄路径 entity_call.cpp:126-177 属性错误尾;
//! - **声明尚未就绪**(类未知/快照缺/组件类缺/基类链未展开)一律
//!   [`RpcCheck::NotReady`],绝不判确定缺失(验收红线)。

use super::dispatch::{resolve_dispatch, DispatchTarget, MethodCandidate, PyClassResolver, Receiver};
use super::refs::{bind_self_role, CallType, EntityRef, ScriptFace};
use super::snapshot::EntitySnapshot;
use super::Facet;

/// 角色/暴露规则检查结果(六态互斥;三类诊断分开,不合并)。
#[derive(Debug, Clone, PartialEq)]
pub enum RpcCheck {
    /// 调用可达:候选(含 def+Python 双跳转;多候选 = 歧义全列)。
    Reachable {
        candidates: Vec<MethodCandidate>,
    },
    /// 客户端进服调用未 Exposed(仅远程引用路径;client/bots 进程非
    /// Exposed 回落普通属性臂 → 属性错误)。
    ClientNotExposed { method: String, facet: Facet },
    /// 调用方向/结构不可达:引用形态该面不可获取、None 引用、组件槽
    /// 未声明/未指定类型(引擎无此路径)。
    DirectionUnreachable { reason: String },
    /// 缺方法:声明就绪、对应面 Methods 段确认无此名。
    MethodMissing {
        method: String,
        facet: Facet,
        class: String,
    },
    /// 声明尚未就绪(类未知/快照缺/组件脚本类缺/基类链未展开)——不判缺失。
    NotReady { reason: String },
    /// 规则不适用:本地实体引用方法调用为 plain Python 派发,def 段
    /// 未声明不构成确定缺失(引擎 ScriptObject 直落)。
    NotApplicable { reason: String },
}

/// 检查一次方法调用(调用方脚本面 + 接收者 + 方法名)。
///
/// - `caller_face`:调用方进程面(Base/Cell=服务端,Client=客户端);
/// - `owner_snapshot`:Role=接收者实体快照;ComponentSlot=槽宿主快照;
/// - `component_snapshot`:ComponentSlot=组件类型自身快照(Role 忽略)。
pub fn check_rpc_call(
    caller_face: ScriptFace,
    receiver: &Receiver,
    method: &str,
    owner_snapshot: Option<&EntitySnapshot>,
    component_snapshot: Option<&EntitySnapshot>,
    py: &dyn PyClassResolver,
) -> RpcCheck {
    // 结构守卫:组件槽三重件(宿主快照/槽声明/组件类型)。
    let reference: EntityRef = match receiver {
        Receiver::Role { reference, .. } => reference.clone(),
        Receiver::ComponentSlot { parent, slot, .. } => {
            let owner = match owner_snapshot {
                Some(s) => s,
                None => {
                    return RpcCheck::NotReady {
                        reason: "槽宿主无快照,不判缺失".into(),
                    }
                }
            };
            let comp_view = match owner.components.iter().find(|c| c.name == *slot) {
                Some(c) => c,
                None => {
                    return RpcCheck::DirectionUnreachable {
                        reason: format!("组件槽 {slot} 未声明(槽宿主 def 无此槽)"),
                    }
                }
            };
            if comp_view.component_type.is_none() {
                return RpcCheck::DirectionUnreachable {
                    reason: format!("组件槽 {slot} 未指定组件类型"),
                };
            }
            if component_snapshot.is_none() {
                return RpcCheck::NotReady {
                    reason: "组件无快照,不判缺失".into(),
                };
            }
            (*parent).clone()
        }
    };

    // 引用守卫:类未知 → 未就绪;方向不可获取 → 方向诊断(先于落点)。
    match &reference {
        EntityRef::None => {
            return RpcCheck::DirectionUnreachable {
                reason: "None 引用无方法可调".into(),
            }
        }
        EntityRef::Remote { class, call } => {
            if class.is_none() {
                return RpcCheck::NotReady {
                    reason: "实体类未知,不判缺失".into(),
                };
            }
            if !acquirable_calls(caller_face).contains(call) {
                return RpcCheck::DirectionUnreachable {
                    reason: format!(
                        "{call:?} 句柄在 {caller_face:?} 面不可获取(self 角色属性+面跳闭包推不到)"
                    ),
                };
            }
        }
        EntityRef::Local { class } => {
            if class.is_none() {
                return RpcCheck::NotReady {
                    reason: "本地实体类未知,不判缺失".into(),
                };
            }
        }
    }

    // 快照守卫(Role):声明未就绪,不判缺失。
    if matches!(receiver, Receiver::Role { .. }) && owner_snapshot.is_none() {
        return RpcCheck::NotReady {
            reason: "接收者无实体快照,不判缺失".into(),
        };
    }

    // 落点解析(dispatch RPC-04)。到此守卫已保证:类已知、快照齐、
    // 方向可达 → dispatch 的 Unknown 只能是「段缺方法」(远程路径)或
    // 「组件类缺方法/类缺」(本地组件路径)。
    let target = resolve_dispatch(receiver, method, owner_snapshot, component_snapshot, py);
    match target {
        DispatchTarget::Resolved(candidates) => {
            // Exposed 闸仅远程引用路径(client/bots 进程);本地实体/本地
            // 组件是 plain Python 派发,无闸。任一候选 Exposed 即可达。
            let remote_path = matches!(reference, EntityRef::Remote { .. });
            if caller_face == ScriptFace::Client && remote_path && candidates.iter().all(|c| !c.exposed)
            {
                if let Some(first) = candidates.first() {
                    return RpcCheck::ClientNotExposed {
                        method: method.into(),
                        facet: first.facet,
                    };
                }
            }
            RpcCheck::Reachable { candidates }
        }
        DispatchTarget::Unknown(_) => {
            classify_dispatch_miss(receiver, &reference, method, owner_snapshot)
        }
    }
}

/// dispatch 未命中分类(前提:结构/类/方向守卫已过,不读 Unknown 文本)。
fn classify_dispatch_miss(
    receiver: &Receiver,
    reference: &EntityRef,
    method: &str,
    owner_snapshot: Option<&EntitySnapshot>,
) -> RpcCheck {
    match receiver {
        Receiver::Role { .. } => match reference {
            // 本地实体:plain Python 派发,def 段非闸 → 不判缺。
            EntityRef::Local { .. } => RpcCheck::NotApplicable {
                reason: format!(
                    "本地实体方法调用为 plain Python 派发,{method} 未入该面 def 段不构成确定缺失"
                ),
            },
            // 远程句柄:只可能是目标面段缺方法(守卫已排除类未知/快照缺)。
            EntityRef::Remote { class, call } => RpcCheck::MethodMissing {
                method: method.into(),
                facet: call.target_facet(),
                class: class.clone().unwrap_or_default(),
            },
            EntityRef::None => RpcCheck::DirectionUnreachable {
                reason: "None 引用无方法可调".into(),
            },
        },
        Receiver::ComponentSlot { parent, slot, .. } => match parent {
            // 远程宿主组件槽:组件 def 模块对应面段缺方法(entity_component_call.cpp)。
            EntityRef::Remote { call, .. } => RpcCheck::MethodMissing {
                method: method.into(),
                facet: call.target_facet(),
                class: component_type_of(owner_snapshot, slot).unwrap_or_default(),
            },
            // 本地宿主组件槽:plain Python 派发;类内未声明且基类链未展开
            // (PyClassFacts 平面事实)→ 不判确定缺失。
            EntityRef::Local { .. } => RpcCheck::NotReady {
                reason: format!("组件类内未声明 {method} 且基类链未展开,不判确定缺失"),
            },
            EntityRef::None => RpcCheck::DirectionUnreachable {
                reason: "None 引用无组件槽".into(),
            },
        },
    }
}

/// 组件类型名(槽宿主快照里找;守卫已保证槽声明存在)。
fn component_type_of(owner: Option<&EntitySnapshot>, slot: &str) -> Option<String> {
    owner.and_then(|s| {
        s.components
            .iter()
            .find(|c| c.name == slot)
            .and_then(|c| c.component_type.clone())
    })
}

/// 该脚本面可获取的调用类型集合(self 角色属性种子 + 面跳,逐面口径不同)。
///
/// - **client 面**:面跳原样返回自身句柄(entity_call.cpp:164-171,
///   client/bots 进程不构造新 EntityCall)→ 可获取集 = 种子集
///   {BASE, CELL};VIA 变体与 CLIENT 直连型都不可构造;
/// - **服务端面**:面跳按 RPC-01 矩阵构造新句柄 → 闭包:
///   base 面 = 全部七型(直连 BASE 经 self.client.cell.base 去直连链
///   可构造,Proxy 限定另记);cell 面 = 除直连 CLIENT 外全部
///   (CLIENT 只认 BASE/CELL 直连型,:151-156,cellapp 无直连客户端连接);
///   (RPC-01 矩阵面跳 `hop_attr` 为服务端语义,client 面由此前置分流。)
fn acquirable_calls(face: ScriptFace) -> Vec<CallType> {
    let mut set: Vec<CallType> = Vec::new();
    let mut frontier: Vec<CallType> = Vec::new();
    for attr in ["base", "cell", "client"] {
        if let Some(binding) = bind_self_role(face, attr, None) {
            if let EntityRef::Remote { call, .. } = binding.reference {
                if !set.contains(&call) {
                    set.push(call);
                    frontier.push(call);
                }
            }
        }
    }
    if face == ScriptFace::Client {
        return set;
    }
    while let Some(call) = frontier.pop() {
        for attr in ["base", "cell", "client"] {
            if let Some(next) = call.hop(attr) {
                if !set.contains(&next) {
                    set.push(next);
                    frontier.push(next);
                }
            }
        }
    }
    set
}

#[cfg(test)]
mod tests {
    use super::super::dispatch::{PyClassFacts, PyMethodFacts};
    use super::super::snapshot::{ComponentView, MethodView};
    use super::*;
    use std::collections::HashMap;

    fn view(name: &str, facet: Facet, from: &str, line: usize, exposed: bool) -> MethodView {
        MethodView {
            name: name.into(),
            facet,
            args: vec!["self".into()],
            exposed,
            file: format!("{from}.def"),
            line: Some(line),
            from: from.into(),
        }
    }

    fn py_method(name: &str, line: usize) -> PyMethodFacts {
        PyMethodFacts {
            name: name.into(),
            line,
            params: vec!["self".into()],
        }
    }

    struct StubPy(HashMap<(&'static str, String), PyClassFacts>);

    impl StubPy {
        fn with(mut self, face: ScriptFace, facts: PyClassFacts) -> Self {
            let dir = match face {
                ScriptFace::Base => "base",
                ScriptFace::Cell => "cell",
                ScriptFace::Client => "client",
            };
            self.0.insert((dir, facts.class_name.clone()), facts);
            self
        }
    }

    impl PyClassResolver for StubPy {
        fn resolve(&self, face: ScriptFace, class_name: &str) -> Option<&PyClassFacts> {
            let dir = match face {
                ScriptFace::Base => "base",
                ScriptFace::Cell => "cell",
                ScriptFace::Client => "client",
            };
            self.0.get(&(dir, class_name.to_string()))
        }
    }

    fn role_remote(class: Option<&str>, call: CallType) -> Receiver {
        Receiver::Role {
            reference: EntityRef::Remote {
                class: class.map(|c| c.into()),
                call,
            },
            script_face: None,
        }
    }

    fn check(
        face: ScriptFace,
        receiver: &Receiver,
        method: &str,
        snap: Option<&EntitySnapshot>,
        py: &StubPy,
    ) -> RpcCheck {
        check_rpc_call(face, receiver, method, snap, None, py)
    }

    // ---- 客户端 Exposed 闸 ----

    #[test]
    fn client_caller_non_exposed_is_client_not_exposed() {
        let snap = EntitySnapshot {
            base_methods: vec![view("recycle", Facet::Base, "Avatar", 30, false)],
            ..Default::default()
        };
        let py = StubPy(HashMap::new());
        let r = check(
            ScriptFace::Client,
            &role_remote(Some("Avatar"), CallType::Base),
            "recycle",
            Some(&snap),
            &py,
        );
        assert_eq!(
            r,
            RpcCheck::ClientNotExposed {
                method: "recycle".into(),
                facet: Facet::Base
            }
        );
    }

    #[test]
    fn client_caller_exposed_is_reachable() {
        let snap = EntitySnapshot {
            base_methods: vec![view("request", Facet::Base, "Avatar", 31, true)],
            ..Default::default()
        };
        let py = StubPy(HashMap::new());
        let r = check(
            ScriptFace::Client,
            &role_remote(Some("Avatar"), CallType::Base),
            "request",
            Some(&snap),
            &py,
        );
        match r {
            RpcCheck::Reachable { candidates } => assert_eq!(candidates.len(), 1),
            other => panic!("期望 Reachable,得 {other:?}"),
        }
    }

    #[test]
    fn server_caller_skips_exposed_gate() {
        // Exposed 闸只在 client/bots 进程(entity_call.cpp:117 判
        // g_componentType):服务端调用未 Exposed 方法照常可达。
        let snap = EntitySnapshot {
            cell_methods: vec![view("fire", Facet::Cell, "Avatar", 88, false)],
            ..Default::default()
        };
        let py = StubPy(HashMap::new());
        let r = check(
            ScriptFace::Cell,
            &role_remote(Some("Avatar"), CallType::Cell),
            "fire",
            Some(&snap),
            &py,
        );
        match r {
            RpcCheck::Reachable { candidates } => assert_eq!(candidates.len(), 1),
            other => panic!("期望 Reachable,得 {other:?}"),
        }
    }

    #[test]
    fn local_paths_have_no_exposed_gate() {
        // 本地实体/本地组件 plain Python 派发:client 调用面也不裁 Exposed。
        let snap = EntitySnapshot {
            client_methods: vec![view("recycle", Facet::Client, "Avatar", 30, false)],
            ..Default::default()
        };
        let py = StubPy(HashMap::new());
        let r = check(
            ScriptFace::Client,
            &Receiver::Role {
                reference: EntityRef::Local {
                    class: Some("Avatar".into()),
                },
                script_face: Some(ScriptFace::Client),
            },
            "recycle",
            Some(&snap),
            &py,
        );
        match r {
            RpcCheck::Reachable { candidates } => assert_eq!(candidates.len(), 1),
            other => panic!("期望 Reachable,得 {other:?}"),
        }
    }

    // ---- 服务端调用方向 ----

    #[test]
    fn direction_client_direct_on_cell_face_unreachable() {
        // cellapp 无直连客户端连接:CLIENT 直连型在 cell 面闭包推不到
        // (client 分支只认 BASE/CELL,entity_call.cpp:151-156;
        // self.client 给的是 CLIENT_VIA_BASE,.client 链推不出直连 CLIENT)。
        let py = StubPy(HashMap::new());
        let r = check(
            ScriptFace::Cell,
            &role_remote(Some("Avatar"), CallType::Client),
            "fire",
            Some(&EntitySnapshot::default()),
            &py,
        );
        match r {
            RpcCheck::DirectionUnreachable { reason } => assert!(reason.contains("不可获取")),
            other => panic!("期望 DirectionUnreachable,得 {other:?}"),
        }
    }

    #[test]
    fn direction_via_types_unconstructible_on_client_face() {
        // client/bots 进程面跳原样返回自身句柄(entity_call.cpp:164-171):
        // VIA 变体与 CLIENT 直连型在 client 面不可构造;BASE 直连可得。
        let py = StubPy(HashMap::new());
        let via = check(
            ScriptFace::Client,
            &role_remote(Some("Avatar"), CallType::CellViaBase),
            "m",
            Some(&EntitySnapshot::default()),
            &py,
        );
        assert!(matches!(via, RpcCheck::DirectionUnreachable { .. }));
        let client_direct = check(
            ScriptFace::Client,
            &role_remote(Some("Avatar"), CallType::Client),
            "m",
            Some(&EntitySnapshot::default()),
            &py,
        );
        assert!(matches!(client_direct, RpcCheck::DirectionUnreachable { .. }));
        // BASE 直连可得(client 面种子)→ 方向通,进落点面。
        let ok = check(
            ScriptFace::Client,
            &role_remote(Some("Avatar"), CallType::Base),
            "m",
            Some(&EntitySnapshot::default()),
            &py,
        );
        assert!(matches!(ok, RpcCheck::MethodMissing { .. }));
    }

    #[test]
    fn direction_cell_handle_on_base_face_acquirable() {
        // baseapp self.cell 种子:CELL 直连可得 → 方向通,进落点面。
        let py = StubPy(HashMap::new());
        let r = check(
            ScriptFace::Base,
            &role_remote(Some("Avatar"), CallType::Cell),
            "m",
            Some(&EntitySnapshot::default()),
            &py,
        );
        assert!(matches!(r, RpcCheck::MethodMissing { .. }));
    }

    #[test]
    fn direction_client_face_has_no_client_handle() {
        // client 面无 .client:CLIENT 句柄不可获取;但 CELL 直连可得。
        let py = StubPy(HashMap::new());
        let bad = check(
            ScriptFace::Client,
            &role_remote(Some("Avatar"), CallType::Client),
            "m",
            Some(&EntitySnapshot::default()),
            &py,
        );
        assert!(matches!(bad, RpcCheck::DirectionUnreachable { .. }));
        let ok = check(
            ScriptFace::Client,
            &role_remote(Some("Avatar"), CallType::Cell),
            "m",
            Some(&EntitySnapshot::default()),
            &py,
        );
        // 方向通 → 进落点面(cell 段空 → 缺方法,不再是方向诊断)。
        assert!(matches!(ok, RpcCheck::MethodMissing { .. }));
    }

    #[test]
    fn direction_via_types_acquirable_through_closure() {
        // 闭包推导:CLIENT_VIA_CELL 在 base 面可获取(self.cell.client 两跳)。
        let py = StubPy(HashMap::new());
        let snap = EntitySnapshot {
            client_methods: vec![view("showTip", Facet::Client, "Avatar", 120, false)],
            ..Default::default()
        };
        let r = check(
            ScriptFace::Base,
            &role_remote(Some("Avatar"), CallType::ClientViaCell),
            "showTip",
            Some(&snap),
            &py,
        );
        match r {
            RpcCheck::Reachable { candidates } => assert_eq!(candidates.len(), 1),
            other => panic!("期望 Reachable,得 {other:?}"),
        }
    }

    #[test]
    fn none_reference_is_direction_unreachable() {
        let py = StubPy(HashMap::new());
        let r = check(
            ScriptFace::Base,
            &Receiver::Role {
                reference: EntityRef::None,
                script_face: Some(ScriptFace::Base),
            },
            "m",
            Some(&EntitySnapshot::default()),
            &py,
        );
        assert!(matches!(r, RpcCheck::DirectionUnreachable { .. }));
    }

    // ---- 缺方法(与未就绪分开) ----

    #[test]
    fn remote_section_empty_is_method_missing() {
        let snap = EntitySnapshot {
            base_methods: vec![view("recycle", Facet::Base, "Avatar", 30, false)],
            ..Default::default()
        };
        let py = StubPy(HashMap::new());
        let r = check(
            ScriptFace::Cell,
            &role_remote(Some("Avatar"), CallType::Cell),
            "recycle",
            Some(&snap),
            &py,
        );
        assert_eq!(
            r,
            RpcCheck::MethodMissing {
                method: "recycle".into(),
                facet: Facet::Cell,
                class: "Avatar".into()
            }
        );
    }

    #[test]
    fn unknown_class_is_not_ready_never_missing() {
        // 验收红线:声明尚未就绪(类未知)绝不判确定缺失。
        let py = StubPy(HashMap::new());
        let r = check(
            ScriptFace::Cell,
            &role_remote(None, CallType::Cell),
            "fire",
            Some(&EntitySnapshot::default()),
            &py,
        );
        assert_eq!(
            r,
            RpcCheck::NotReady {
                reason: "实体类未知,不判缺失".into()
            }
        );
    }

    #[test]
    fn missing_snapshot_is_not_ready_never_missing() {
        let py = StubPy(HashMap::new());
        let r = check(
            ScriptFace::Cell,
            &role_remote(Some("Avatar"), CallType::Cell),
            "fire",
            None,
            &py,
        );
        assert!(matches!(r, RpcCheck::NotReady { .. }));
    }

    #[test]
    fn local_entity_def_miss_is_not_applicable() {
        // 本地实体 plain 派发:def 段缺 ≠ 缺方法(Python 类面另查)。
        let py = StubPy(HashMap::new());
        let r = check(
            ScriptFace::Base,
            &Receiver::Role {
                reference: EntityRef::Local {
                    class: Some("Avatar".into()),
                },
                script_face: Some(ScriptFace::Base),
            },
            "helper",
            Some(&EntitySnapshot::default()),
            &py,
        );
        assert!(matches!(r, RpcCheck::NotApplicable { .. }));
    }

    // ---- 组件槽规则 ----

    fn slot_host(slot: &str, comp_type: Option<&str>) -> EntitySnapshot {
        EntitySnapshot {
            components: vec![ComponentView {
                name: slot.into(),
                component_type: comp_type.map(|t| t.into()),
                persistent: None,
                file: "Avatar.def".into(),
                line: Some(15),
            }],
            ..Default::default()
        }
    }

    #[test]
    fn component_slot_remote_client_exposed_gate() {
        // 组件调用同闸(entity_component_call.cpp:99-103):client 进程
        // 非 Exposed 组件方法不可达;服务端可达。
        let host = slot_host("weapon", Some("Weapon"));
        let comp = EntitySnapshot {
            cell_methods: vec![view("swing", Facet::Cell, "Weapon", 77, false)],
            ..Default::default()
        };
        let py = StubPy(HashMap::new());
        let recv = |call| Receiver::ComponentSlot {
            parent: EntityRef::Remote {
                class: Some("Avatar".into()),
                call,
            },
            slot: "weapon".into(),
            script_face: None,
        };
        let client_hit = check_rpc_call(
            ScriptFace::Client,
            &recv(CallType::Cell),
            "swing",
            Some(&host),
            Some(&comp),
            &py,
        );
        assert_eq!(
            client_hit,
            RpcCheck::ClientNotExposed {
                method: "swing".into(),
                facet: Facet::Cell
            }
        );
        let server_hit = check_rpc_call(
            ScriptFace::Cell,
            &recv(CallType::Cell),
            "swing",
            Some(&host),
            Some(&comp),
            &py,
        );
        assert!(matches!(server_hit, RpcCheck::Reachable { .. }));
    }

    #[test]
    fn component_slot_structural_gaps_split_from_missing() {
        let py = StubPy(HashMap::new());
        let recv = |call| Receiver::ComponentSlot {
            parent: EntityRef::Remote {
                class: Some("Avatar".into()),
                call,
            },
            slot: "weapon".into(),
            script_face: None,
        };
        // 槽未声明 = 结构缺失(方向族),非缺方法。
        let host_other = slot_host("bag", Some("Bag"));
        let no_slot = check(
            ScriptFace::Cell,
            &recv(CallType::Cell),
            "swing",
            Some(&host_other),
            &py,
        );
        match no_slot {
            RpcCheck::DirectionUnreachable { reason } => assert!(reason.contains("未声明")),
            other => panic!("期望 DirectionUnreachable,得 {other:?}"),
        }
        // 槽在但无类型 = 结构缺失。
        let host_no_type = slot_host("weapon", None);
        let no_type = check(
            ScriptFace::Cell,
            &recv(CallType::Cell),
            "swing",
            Some(&host_no_type),
            &py,
        );
        match no_type {
            RpcCheck::DirectionUnreachable { reason } => assert!(reason.contains("未指定组件类型")),
            other => panic!("期望 DirectionUnreachable,得 {other:?}"),
        }
        // 组件快照缺 = 未就绪,不判缺失。
        let host_ok = slot_host("weapon", Some("Weapon"));
        let no_comp = check(
            ScriptFace::Cell,
            &recv(CallType::Cell),
            "swing",
            Some(&host_ok),
            &py,
        );
        assert!(matches!(no_comp, RpcCheck::NotReady { .. }));
    }

    #[test]
    fn component_slot_remote_missing_is_method_missing() {
        let host = slot_host("weapon", Some("Weapon"));
        let comp = EntitySnapshot {
            cell_methods: vec![view("swing", Facet::Cell, "Weapon", 77, false)],
            ..Default::default()
        };
        let py = StubPy(HashMap::new());
        let r = check_rpc_call(
            ScriptFace::Cell,
            &Receiver::ComponentSlot {
                parent: EntityRef::Remote {
                    class: Some("Avatar".into()),
                    call: CallType::Cell,
                },
                slot: "weapon".into(),
                script_face: None,
            },
            "swing_missing",
            Some(&host),
            Some(&comp),
            &py,
        );
        assert_eq!(
            r,
            RpcCheck::MethodMissing {
                method: "swing_missing".into(),
                facet: Facet::Cell,
                class: "Weapon".into()
            }
        );
    }

    #[test]
    fn component_slot_local_missing_method_is_not_ready() {
        // 本地组件 plain 派发 + PyClassFacts 平面事实(基类链未展开):
        // 类内未声明 → 不判确定缺失(验收红线)。
        let host = slot_host("weapon", Some("Weapon"));
        let py = StubPy(HashMap::new()).with(
            ScriptFace::Cell,
            PyClassFacts {
                class_name: "Weapon".into(),
                methods: vec![py_method("other", 1)],
            },
        );
        let r = check_rpc_call(
            ScriptFace::Cell,
            &Receiver::ComponentSlot {
                parent: EntityRef::Local {
                    class: Some("Avatar".into()),
                },
                slot: "weapon".into(),
                script_face: Some(ScriptFace::Cell),
            },
            "swing",
            Some(&host),
            Some(&EntitySnapshot::default()),
            &py,
        );
        match r {
            RpcCheck::NotReady { reason } => assert!(reason.contains("基类链未展开")),
            other => panic!("期望 NotReady,得 {other:?}"),
        }
    }
}
