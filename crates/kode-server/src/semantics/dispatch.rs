//! RPC-04 方法与组件槽落点(纯库面,无 RPC/无 TS 消费)。
//!
//! 三条引擎路径的静态解析(逐行核过 `../kbengine`):
//! - **远程实体方法**:`entity_call.cpp:82-123`——句柄按调用类型查
//!   **目标面**方法表(via 只描述传输路径);命中 → RemoteEntityMethod,
//!   未命中落属性错误;
//! - **组件槽远程路径**:`entity_component_call.cpp:64-110`——同一七路
//!   switch,但查**组件自身 def 模块**对应面方法表(无面跳、无自名闸);
//!   未命中落 `ScriptObject::onScriptGetAttribute`(普通属性臂);
//! - **组件槽本地路径**:`cellapp/entity_component.cpp:35-53`——真身臂为空,
//!   直落 `ScriptObject`(plain Python 属性派发,def 分面**不设闸**);
//!   仅 ghost(!isReal)另查组件模块 cell 方法表(RealEntityMethod,
//!   迁移期 RPC 回真身);`baseapp/entity_component.cpp:31-35` 无条件直落。
//!
//! 验收口径(todo.md RPC-04):只在对应 Methods 段及组件槽查找,提供
//! def 和 Python 实现两种跳转;歧义展示多候选。推不出(类未知/面缺声明/
//! 槽缺失/脚本类缺失)一律 [`DispatchTarget::Unknown`] 带因,不硬造落点。

use super::refs::{EntityRef, ScriptFace};
use super::snapshot::{EntitySnapshot, MethodView};
use super::Facet;

/// Python 类方法事实(消费方从 `scripts/<face>/<类名>.py` 解析,kode-python
/// `AstMethod` 直取;行号/参数口径按解析器原样透传,本模块不换算)。
#[derive(Debug, Clone, PartialEq)]
pub struct PyMethodFacts {
    pub name: String,
    pub line: usize,
    pub params: Vec<String>,
}

/// Python 类事实(该面脚本里以 `<类名>` 命名的类;基类链展开归消费方)。
#[derive(Debug, Clone, PartialEq)]
pub struct PyClassFacts {
    pub class_name: String,
    pub methods: Vec<PyMethodFacts>,
}

/// 脚本面 Python 类解析器(对象安全;None = 该面无此脚本/类,不猜行号)。
pub trait PyClassResolver {
    fn resolve(&self, face: ScriptFace, class_name: &str) -> Option<&PyClassFacts>;
}

/// 方法落点候选(def 声明面 + Python 实现面双跳转)。
#[derive(Debug, Clone, PartialEq)]
pub struct MethodCandidate {
    pub name: String,
    pub facet: Facet,
    pub args: Vec<String>,
    /// def 侧 exposed(plain Python 派发的纯本地方法恒 false——exposed 是
    /// def 侧概念)。
    pub exposed: bool,
    /// def 声明跳转(`Avatar.def`;plain Python 派发且 def 未声明 → None)。
    pub def_file: Option<String>,
    pub def_line: Option<usize>,
    /// def 声明来源(实体自身/接口/父;= Python 实现类名)。
    pub from: String,
    /// Python 实现跳转:类解析到才给 `scripts/<面>/<类名>.py`,不造路径。
    pub py_file: Option<String>,
    /// Python def 行(类在而方法缺失 → None,诚实不造行号)。
    pub py_line: Option<usize>,
}

/// 方法落点结果:确定候选(≥2 = 歧义,全列不任取)或诚实未知。
#[derive(Debug, Clone, PartialEq)]
pub enum DispatchTarget {
    Resolved(Vec<MethodCandidate>),
    Unknown(String),
}

/// 方法调用接收者(`ref.method(...)` / `self.<槽>.method(...)`;引用形态
/// 由 RPC-01..03 归约,本模块只按引用形态查落点)。
#[derive(Debug, Clone, PartialEq)]
pub enum Receiver {
    /// 实体引用接收者。`script_face` 仅本地引用需要(定分面);远程引用的
    /// 分面由调用类型的目标面决定。
    Role {
        reference: EntityRef,
        script_face: Option<ScriptFace>,
    },
    /// 组件槽接收者。`script_face` 仅本地宿主需要(定 plain 派发的脚本面);
    /// 远程宿主的分面同样由调用类型目标面决定。
    ComponentSlot {
        parent: EntityRef,
        slot: String,
        script_face: Option<ScriptFace>,
    },
}

/// 解析方法落点。
///
/// - `owner_snapshot`:Role = 接收者实体快照;ComponentSlot = 槽宿主实体
///   快照(只读组件槽声明);
/// - `component_snapshot`:ComponentSlot = 组件类型自身快照(Role 忽略)。
pub fn resolve_dispatch(
    receiver: &Receiver,
    method: &str,
    owner_snapshot: Option<&EntitySnapshot>,
    component_snapshot: Option<&EntitySnapshot>,
    py: &dyn PyClassResolver,
) -> DispatchTarget {
    match receiver {
        Receiver::Role {
            reference,
            script_face,
        } => resolve_role(reference, *script_face, method, owner_snapshot, py),
        Receiver::ComponentSlot {
            parent,
            slot,
            script_face,
        } => resolve_component_slot(
            parent,
            slot,
            *script_face,
            method,
            owner_snapshot,
            component_snapshot,
            py,
        ),
    }
}

/// 实体引用落点(entity_call.cpp:82-123:分面由调用类型目标面定;
/// 本地引用按脚本面分面)。
fn resolve_role(
    reference: &EntityRef,
    script_face: Option<ScriptFace>,
    method: &str,
    snap: Option<&EntitySnapshot>,
    py: &dyn PyClassResolver,
) -> DispatchTarget {
    // (分面, 类名):远程句柄分面 = 目标面;本地引用分面 = 脚本面。
    let (facet, class) = match reference {
        EntityRef::None => return DispatchTarget::Unknown("None 引用无可调方法".into()),
        EntityRef::Local { class } => match script_face {
            Some(face) => (facet_of_face(face), class),
            None => return DispatchTarget::Unknown("本地实体缺脚本面,不猜分面".into()),
        },
        EntityRef::Remote { class, call } => (call.target_facet(), class),
    };
    let class_name = match class {
        Some(c) => c,
        None => return DispatchTarget::Unknown("实体类未知,不猜落点".into()),
    };
    let snap = match snap {
        Some(s) => s,
        None => return DispatchTarget::Unknown(format!("{class_name}:无实体快照,不猜落点")),
    };
    def_facet_candidates(snap, facet, method, py)
}

/// 组件槽落点(entity_component_call.cpp:64-110 远程路径 /
/// cellapp entity_component.cpp:35-53 + baseapp :31-35 本地路径)。
fn resolve_component_slot(
    parent: &EntityRef,
    slot: &str,
    script_face: Option<ScriptFace>,
    method: &str,
    owner_snapshot: Option<&EntitySnapshot>,
    component_snapshot: Option<&EntitySnapshot>,
    py: &dyn PyClassResolver,
) -> DispatchTarget {
    let owner = match owner_snapshot {
        Some(s) => s,
        None => return DispatchTarget::Unknown("槽宿主无快照,不猜组件槽".into()),
    };
    let comp_view = match owner.components.iter().find(|c| c.name == slot) {
        Some(c) => c,
        None => {
            return DispatchTarget::Unknown(format!("组件槽 {slot} 未声明(槽宿主 def 无此槽)"))
        }
    };
    let comp_type = match &comp_view.component_type {
        Some(t) => t,
        None => return DispatchTarget::Unknown(format!("组件槽 {slot} 未指定组件类型,不猜落点")),
    };
    match parent {
        EntityRef::None => DispatchTarget::Unknown("None 引用无组件槽".into()),
        EntityRef::Remote { call, .. } => {
            // 远程句柄上的槽:EntityComponentCall 按句柄调用类型查**组件自身
            // def 模块**对应面方法表(entity_component_call.cpp:64-110 同七路
            // switch,无面跳;类未知不阻断——组件类型自槽声明取)。
            let comp = match component_snapshot {
                Some(c) => c,
                None => {
                    return DispatchTarget::Unknown(format!("组件 {comp_type} 无快照,不猜落点"))
                }
            };
            def_facet_candidates(comp, call.target_facet(), method, py)
        }
        EntityRef::Local { .. } => {
            // 本地真实组件:plain Python 属性派发(cellapp 真身臂为空 else
            // 直落 ScriptObject;baseapp 无条件直落)——def 分面不设闸,
            // 候选 = 组件 Python 类方法,def 声明同面缀附。
            let face = match script_face {
                Some(f) => f,
                None => return DispatchTarget::Unknown("本地组件缺脚本面,不猜分面".into()),
            };
            local_component_candidates(comp_type, face, method, component_snapshot, py)
        }
    }
}

/// def 分面候选:只在该面 Methods 段查找(验收口径);同名多来源全列。
fn def_facet_candidates(
    snap: &EntitySnapshot,
    facet: Facet,
    method: &str,
    py: &dyn PyClassResolver,
) -> DispatchTarget {
    let views = facet_views(snap, facet);
    let hits: Vec<&MethodView> = views.iter().filter(|v| v.name == method).collect();
    if hits.is_empty() {
        return DispatchTarget::Unknown(format!(
            "{} Methods 段无 {method}(不可达)",
            facet_dir(facet)
        ));
    }
    DispatchTarget::Resolved(hits.iter().map(|v| enrich_def_candidate(v, py)).collect())
}

/// def 声明候选 → 双跳转候选(def 面 + Python 实现面)。
fn enrich_def_candidate(view: &MethodView, py: &dyn PyClassResolver) -> MethodCandidate {
    let face = facet_face(view.facet);
    let (py_file, py_line) = match py.resolve(face, &view.from) {
        Some(facts) => (
            Some(format!("scripts/{}/{}.py", face_dir(face), view.from)),
            facts.methods.iter().find(|m| m.name == view.name).map(|m| m.line),
        ),
        None => (None, None),
    };
    MethodCandidate {
        name: view.name.clone(),
        facet: view.facet,
        args: view.args.clone(),
        exposed: view.exposed,
        def_file: Some(view.file.clone()),
        def_line: view.line,
        from: view.from.clone(),
        py_file,
        py_line,
    }
}

/// 本地真实组件方法候选(plain Python 派发;def 声明同面缀附)。
fn local_component_candidates(
    comp_type: &str,
    face: ScriptFace,
    method: &str,
    component_snapshot: Option<&EntitySnapshot>,
    py: &dyn PyClassResolver,
) -> DispatchTarget {
    let facts = match py.resolve(face, comp_type) {
        Some(f) => f,
        None => {
            return DispatchTarget::Unknown(format!(
                "组件 {comp_type} 该面脚本/类未解析到,不猜落点"
            ))
        }
    };
    let facet = facet_of_face(face);
    let mut candidates = Vec::new();
    for m in facts.methods.iter().filter(|m| m.name == method) {
        // def 声明面缀附:同面 Methods 段同名声明才给 def 跳转——plain 派发
        // 不查 def 表,声明存在只是文档面,不是运行时闸。
        let def_view = component_snapshot
            .map(|s| facet_views(s, facet).iter().find(|v| v.name == method))
            .unwrap_or(None);
        candidates.push(MethodCandidate {
            name: m.name.clone(),
            facet,
            args: def_view.map(|v| v.args.clone()).unwrap_or_else(|| m.params.clone()),
            exposed: def_view.map(|v| v.exposed).unwrap_or(false),
            def_file: def_view.map(|v| v.file.clone()),
            def_line: def_view.and_then(|v| v.line),
            from: comp_type.to_string(),
            py_file: Some(format!("scripts/{}/{}.py", face_dir(face), comp_type)),
            py_line: Some(m.line),
        });
    }
    if candidates.is_empty() {
        return DispatchTarget::Unknown(format!("组件 {comp_type} 该面类无 {method} 方法"));
    }
    DispatchTarget::Resolved(candidates)
}

fn facet_views(snap: &EntitySnapshot, facet: Facet) -> &[MethodView] {
    match facet {
        Facet::Base => &snap.base_methods,
        Facet::Cell => &snap.cell_methods,
        Facet::Client => &snap.client_methods,
    }
}

fn facet_of_face(face: ScriptFace) -> Facet {
    match face {
        ScriptFace::Base => Facet::Base,
        ScriptFace::Cell => Facet::Cell,
        ScriptFace::Client => Facet::Client,
    }
}

fn facet_face(facet: Facet) -> ScriptFace {
    match facet {
        Facet::Base => ScriptFace::Base,
        Facet::Cell => ScriptFace::Cell,
        Facet::Client => ScriptFace::Client,
    }
}

fn face_dir(face: ScriptFace) -> &'static str {
    match face {
        ScriptFace::Base => "base",
        ScriptFace::Cell => "cell",
        ScriptFace::Client => "client",
    }
}

fn facet_dir(facet: Facet) -> &'static str {
    match facet {
        Facet::Base => "base",
        Facet::Cell => "cell",
        Facet::Client => "client",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantics::refs::CallType;
    use crate::semantics::snapshot::ComponentView;
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

    fn py_class(name: &str, methods: Vec<PyMethodFacts>) -> PyClassFacts {
        PyClassFacts {
            class_name: name.into(),
            methods,
        }
    }

    /// 测试桩:按(面, 类名)查类事实;None = 该面无此脚本/类。
    struct StubPy(HashMap<(&'static str, String), PyClassFacts>);

    impl StubPy {
        fn with(mut self, face: ScriptFace, facts: PyClassFacts) -> Self {
            self.0.insert((face_dir(face), facts.class_name.clone()), facts);
            self
        }
    }

    impl PyClassResolver for StubPy {
        fn resolve(&self, face: ScriptFace, class_name: &str) -> Option<&PyClassFacts> {
            self.0.get(&(face_dir(face), class_name.to_string()))
        }
    }

    fn resolved(target: DispatchTarget) -> Vec<MethodCandidate> {
        match target {
            DispatchTarget::Resolved(v) => v,
            DispatchTarget::Unknown(r) => panic!("期望 Resolved,得 Unknown({r})"),
        }
    }

    fn unknown_reason(target: DispatchTarget) -> String {
        match target {
            DispatchTarget::Unknown(r) => r,
            DispatchTarget::Resolved(_) => panic!("期望 Unknown,得 Resolved"),
        }
    }

    // ---- 实体引用落点(entity_call.cpp 方法表) ----

    #[test]
    fn role_remote_searches_only_target_facet_section() {
        // 验收「只在对应 Methods 段查找」:cell Methods 段命中的方法,
        // base 段声明不得出现在 cell 句柄的候选里,反之不可达。
        let snap = EntitySnapshot {
            base_methods: vec![view("recycle", Facet::Base, "Avatar", 30, false)],
            cell_methods: vec![view("fire", Facet::Cell, "Avatar", 88, true)],
            ..Default::default()
        };
        let py = StubPy(HashMap::new()).with(
            ScriptFace::Cell,
            py_class("Avatar", vec![py_method("fire", 410)]),
        );
        let r = resolve_dispatch(
            &Receiver::Role {
                reference: EntityRef::Remote {
                    class: Some("Avatar".into()),
                    call: CallType::Cell,
                },
                script_face: None,
            },
            "fire",
            Some(&snap),
            None,
            &py,
        );
        let cands = resolved(r);
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].facet, Facet::Cell);
        assert!(cands[0].exposed);
        // 双跳转:def 声明面 + Python 实现面。
        assert_eq!(cands[0].def_file.as_deref(), Some("Avatar.def"));
        assert_eq!(cands[0].def_line, Some(88));
        assert_eq!(cands[0].py_file.as_deref(), Some("scripts/cell/Avatar.py"));
        assert_eq!(cands[0].py_line, Some(410));
        // base 段方法对 cell 句柄不可达(不跨段搜)。
        let miss = resolve_dispatch(
            &Receiver::Role {
                reference: EntityRef::Remote {
                    class: Some("Avatar".into()),
                    call: CallType::Cell,
                },
                script_face: None,
            },
            "recycle",
            Some(&snap),
            None,
            &py,
        );
        assert!(unknown_reason(miss).contains("cell Methods 段无 recycle"));
    }

    #[test]
    fn role_remote_via_uses_target_facet_not_transport() {
        // via 只描述传输路径:CLIENT_VIA_BASE 句柄查 client 段(非 base)。
        let snap = EntitySnapshot {
            client_methods: vec![view("showTip", Facet::Client, "Avatar", 120, false)],
            base_methods: vec![view("showTip", Facet::Base, "Avatar", 20, false)],
            ..Default::default()
        };
        let py = StubPy(HashMap::new());
        let cands = resolved(resolve_dispatch(
            &Receiver::Role {
                reference: EntityRef::Remote {
                    class: Some("Avatar".into()),
                    call: CallType::ClientViaBase,
                },
                script_face: None,
            },
            "showTip",
            Some(&snap),
            None,
            &py,
        ));
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].facet, Facet::Client);
        assert_eq!(cands[0].def_line, Some(120));
    }

    #[test]
    fn role_local_uses_script_face_facet() {
        let snap = EntitySnapshot {
            base_methods: vec![view("recycle", Facet::Base, "Avatar", 30, false)],
            ..Default::default()
        };
        let py = StubPy(HashMap::new());
        // baseapp 本地实体(self/KBEngine.entities[]):按脚本面(base)分面。
        let cands = resolved(resolve_dispatch(
            &Receiver::Role {
                reference: EntityRef::Local {
                    class: Some("Avatar".into()),
                },
                script_face: Some(ScriptFace::Base),
            },
            "recycle",
            Some(&snap),
            None,
            &py,
        ));
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].facet, Facet::Base);
        // 本地引用缺脚本面 → 不猜分面。
        let no_face = resolve_dispatch(
            &Receiver::Role {
                reference: EntityRef::Local {
                    class: Some("Avatar".into()),
                },
                script_face: None,
            },
            "recycle",
            Some(&snap),
            None,
            &py,
        );
        assert!(unknown_reason(no_face).contains("缺脚本面"));
    }

    #[test]
    fn role_unknown_class_and_none_ref_not_guessed() {
        let snap = EntitySnapshot {
            cell_methods: vec![view("fire", Facet::Cell, "Avatar", 88, false)],
            ..Default::default()
        };
        let py = StubPy(HashMap::new());
        // 类未知:落点不可猜(即使快照在手——引用形态类字段为准,不偷看)。
        let unk = resolve_dispatch(
            &Receiver::Role {
                reference: EntityRef::Remote {
                    class: None,
                    call: CallType::Cell,
                },
                script_face: None,
            },
            "fire",
            Some(&snap),
            None,
            &py,
        );
        assert_eq!(unknown_reason(unk), "实体类未知,不猜落点");
        // None 引用:无方法可调。
        let none = resolve_dispatch(
            &Receiver::Role {
                reference: EntityRef::None,
                script_face: Some(ScriptFace::Cell),
            },
            "fire",
            Some(&snap),
            None,
            &py,
        );
        assert!(unknown_reason(none).contains("None 引用"));
    }

    #[test]
    fn role_py_jump_honest_when_class_or_method_missing() {
        // 类在而方法缺失 → py_file 有、py_line None;类缺失 → 双 None。
        let snap = EntitySnapshot {
            cell_methods: vec![
                view("fire", Facet::Cell, "Avatar", 88, false),
                view("heal", Facet::Cell, "Mixin", 55, false),
            ],
            ..Default::default()
        };
        let py = StubPy(HashMap::new()).with(
            ScriptFace::Cell,
            // Avatar 类在但没有 fire;heal 的来源 Mixin 类不存在。
            py_class("Avatar", vec![py_method("other", 1)]),
        );
        let cands = resolved(resolve_dispatch(
            &Receiver::Role {
                reference: EntityRef::Remote {
                    class: Some("Avatar".into()),
                    call: CallType::Cell,
                },
                script_face: None,
            },
            "fire",
            Some(&snap),
            None,
            &py,
        ));
        assert_eq!(cands[0].py_file.as_deref(), Some("scripts/cell/Avatar.py"));
        assert_eq!(cands[0].py_line, None);
        let heal = resolved(resolve_dispatch(
            &Receiver::Role {
                reference: EntityRef::Remote {
                    class: Some("Avatar".into()),
                    call: CallType::Cell,
                },
                script_face: None,
            },
            "heal",
            Some(&snap),
            None,
            &py,
        ));
        assert_eq!(heal[0].py_file, None);
        assert_eq!(heal[0].py_line, None);
    }

    #[test]
    fn role_multi_source_ambiguity_lists_all_candidates() {
        // 验收「歧义展示多候选」:自身 + 接口同名方法全列,各带各的跳转。
        let snap = EntitySnapshot {
            cell_methods: vec![
                view("onPick", Facet::Cell, "Avatar", 200, false),
                view("onPick", Facet::Cell, "Pickable", 42, true),
            ],
            ..Default::default()
        };
        let py = StubPy(HashMap::new())
            .with(ScriptFace::Cell, py_class("Avatar", vec![py_method("onPick", 210)]))
            .with(ScriptFace::Cell, py_class("Pickable", vec![py_method("onPick", 50)]));
        let cands = resolved(resolve_dispatch(
            &Receiver::Role {
                reference: EntityRef::Remote {
                    class: Some("Avatar".into()),
                    call: CallType::Cell,
                },
                script_face: None,
            },
            "onPick",
            Some(&snap),
            None,
            &py,
        ));
        assert_eq!(cands.len(), 2);
        let froms: Vec<&str> = cands.iter().map(|c| c.from.as_str()).collect();
        assert_eq!(froms, vec!["Avatar", "Pickable"]);
        assert_eq!(cands[0].def_line, Some(200));
        assert_eq!(cands[0].py_line, Some(210));
        assert_eq!(cands[1].def_file.as_deref(), Some("Pickable.def"));
        assert!(cands[1].exposed);
        assert_eq!(cands[1].py_line, Some(50));
    }

    // ---- 组件槽落点(entity_component_call / entity_component) ----

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
    fn component_slot_remote_uses_component_module_target_facet() {
        // 远程句柄上的槽:查组件自身 def 模块对应面表(entity_component_call.cpp:64-110),
        // 不是宿主实体的表——宿主故意同名方法放 base 段作区分。
        let host = EntitySnapshot {
            base_methods: vec![view("swing", Facet::Base, "Avatar", 30, false)],
            ..slot_host("weapon", Some("Weapon"))
        };
        let comp = EntitySnapshot {
            cell_methods: vec![view("swing", Facet::Cell, "Weapon", 77, true)],
            ..Default::default()
        };
        let py = StubPy(HashMap::new());
        let cands = resolved(resolve_dispatch(
            &Receiver::ComponentSlot {
                parent: EntityRef::Remote {
                    class: Some("Avatar".into()),
                    call: CallType::CellViaBase,
                },
                slot: "weapon".into(),
                script_face: None,
            },
            "swing",
            Some(&host),
            Some(&comp),
            &py,
        ));
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].facet, Facet::Cell);
        assert_eq!(cands[0].from, "Weapon");
        assert_eq!(cands[0].def_file.as_deref(), Some("Weapon.def"));
        // CELL_VIA_BASE 与 CELL 同目标面(查 cell 段,非 base)。
        let via = resolved(resolve_dispatch(
            &Receiver::ComponentSlot {
                parent: EntityRef::Remote {
                    class: Some("Avatar".into()),
                    call: CallType::BaseViaCell,
                },
                slot: "weapon".into(),
                script_face: None,
            },
            "swing",
            Some(&host),
            Some(&EntitySnapshot {
                base_methods: vec![view("swing", Facet::Base, "Weapon", 71, false)],
                ..Default::default()
            }),
            &py,
        ));
        assert_eq!(via[0].facet, Facet::Base);
    }

    #[test]
    fn component_slot_missing_pieces_are_unknown() {
        let comp = EntitySnapshot::default();
        let py = StubPy(HashMap::new());
        // 槽宿主无快照。
        let no_host = resolve_dispatch(
            &Receiver::ComponentSlot {
                parent: EntityRef::Remote {
                    class: Some("Avatar".into()),
                    call: CallType::Cell,
                },
                slot: "weapon".into(),
                script_face: None,
            },
            "swing",
            None,
            Some(&comp),
            &py,
        );
        assert!(unknown_reason(no_host).contains("槽宿主无快照"));
        // 槽未声明。
        let host = slot_host("bag", Some("Bag"));
        let no_slot = resolve_dispatch(
            &Receiver::ComponentSlot {
                parent: EntityRef::Remote {
                    class: Some("Avatar".into()),
                    call: CallType::Cell,
                },
                slot: "weapon".into(),
                script_face: None,
            },
            "swing",
            Some(&host),
            Some(&comp),
            &py,
        );
        assert!(unknown_reason(no_slot).contains("组件槽 weapon 未声明"));
        // 槽在但组件类型未指定。
        let host_no_type = slot_host("weapon", None);
        let no_type = resolve_dispatch(
            &Receiver::ComponentSlot {
                parent: EntityRef::Remote {
                    class: Some("Avatar".into()),
                    call: CallType::Cell,
                },
                slot: "weapon".into(),
                script_face: None,
            },
            "swing",
            Some(&host_no_type),
            Some(&comp),
            &py,
        );
        assert!(unknown_reason(no_type).contains("未指定组件类型"));
        // 组件无快照。
        let host_ok = slot_host("weapon", Some("Weapon"));
        let no_comp = resolve_dispatch(
            &Receiver::ComponentSlot {
                parent: EntityRef::Remote {
                    class: Some("Avatar".into()),
                    call: CallType::Cell,
                },
                slot: "weapon".into(),
                script_face: None,
            },
            "swing",
            Some(&host_ok),
            None,
            &py,
        );
        assert!(unknown_reason(no_comp).contains("组件 Weapon 无快照"));
    }

    #[test]
    fn component_slot_local_real_is_plain_python_dispatch() {
        // 本地真身:plain Python 派发(cellapp 真身臂空 else 直落 ScriptObject;
        // baseapp 无条件直落)——def 段不设闸,类里有的方法即可调,
        // def 同面声明缀附作 def 跳转。
        let comp = EntitySnapshot {
            cell_methods: vec![view("swing", Facet::Cell, "Weapon", 77, true)],
            ..Default::default()
        };
        let py = StubPy(HashMap::new()).with(
            ScriptFace::Cell,
            py_class("Weapon", vec![
                py_method("swing", 70),
                // py-only:任何 def 段都未声明,本地照样可调。
                py_method("polish", 90),
            ]),
        );
        let host = slot_host("weapon", Some("Weapon"));
        // def 已声明:双跳转齐。
        let both = resolved(resolve_dispatch(
            &Receiver::ComponentSlot {
                parent: EntityRef::Local {
                    class: Some("Avatar".into()),
                },
                slot: "weapon".into(),
                script_face: Some(ScriptFace::Cell),
            },
            "swing",
            Some(&host),
            Some(&comp),
            &py,
        ));
        assert_eq!(both.len(), 1);
        assert_eq!(both[0].py_file.as_deref(), Some("scripts/cell/Weapon.py"));
        assert_eq!(both[0].py_line, Some(70));
        assert_eq!(both[0].def_file.as_deref(), Some("Weapon.def"));
        assert!(both[0].exposed);
        // py-only:def 字段诚实 None,args 取类事实参数。
        let only = resolved(resolve_dispatch(
            &Receiver::ComponentSlot {
                parent: EntityRef::Local {
                    class: Some("Avatar".into()),
                },
                slot: "weapon".into(),
                script_face: Some(ScriptFace::Cell),
            },
            "polish",
            Some(&host),
            Some(&comp),
            &py,
        ));
        assert_eq!(only[0].def_file, None);
        assert_eq!(only[0].def_line, None);
        assert_eq!(only[0].py_line, Some(90));
        assert_eq!(only[0].args, vec!["self".to_string()]);
    }

    #[test]
    fn component_slot_local_base_face_fallthrough() {
        // baseapp 本地组件:无条件直落 ScriptObject(entity_component.cpp:31-35),
        // 按脚本面(base)的类解析。
        let py = StubPy(HashMap::new()).with(
            ScriptFace::Base,
            py_class("Bag", vec![py_method("open", 12)]),
        );
        let host = slot_host("bag", Some("Bag"));
        let cands = resolved(resolve_dispatch(
            &Receiver::ComponentSlot {
                parent: EntityRef::Local {
                    class: Some("Avatar".into()),
                },
                slot: "bag".into(),
                script_face: Some(ScriptFace::Base),
            },
            "open",
            Some(&host),
            Some(&EntitySnapshot::default()),
            &py,
        ));
        assert_eq!(cands[0].py_file.as_deref(), Some("scripts/base/Bag.py"));
        assert_eq!(cands[0].facet, Facet::Base);
    }

    #[test]
    fn component_slot_local_missing_script_or_method_is_unknown() {
        let host = slot_host("weapon", Some("Weapon"));
        let py = StubPy(HashMap::new());
        // 本地宿主缺脚本面。
        let no_face = resolve_dispatch(
            &Receiver::ComponentSlot {
                parent: EntityRef::Local {
                    class: Some("Avatar".into()),
                },
                slot: "weapon".into(),
                script_face: None,
            },
            "swing",
            Some(&host),
            None,
            &py,
        );
        assert!(unknown_reason(no_face).contains("缺脚本面"));
        // 该面脚本/类缺失。
        let no_class = resolve_dispatch(
            &Receiver::ComponentSlot {
                parent: EntityRef::Local {
                    class: Some("Avatar".into()),
                },
                slot: "weapon".into(),
                script_face: Some(ScriptFace::Cell),
            },
            "swing",
            Some(&host),
            None,
            &py,
        );
        assert!(unknown_reason(no_class).contains("脚本/类未解析到"));
        // 类在而方法不在。
        let py2 = StubPy(HashMap::new())
            .with(ScriptFace::Cell, py_class("Weapon", vec![py_method("other", 1)]));
        let no_method = resolve_dispatch(
            &Receiver::ComponentSlot {
                parent: EntityRef::Local {
                    class: Some("Avatar".into()),
                },
                slot: "weapon".into(),
                script_face: Some(ScriptFace::Cell),
            },
            "swing",
            Some(&host),
            None,
            &py2,
        );
        assert!(unknown_reason(no_method).contains("该面类无 swing"));
    }
}
