//! BAS-05 有效实体声明快照。
//!
//! 由实体自身 `.def` + Parent/Interfaces/组件的定义展开成 [`EntitySnapshot`]:
//! - 继承链(环检测,含自环——绝不 hang);
//! - 接口展开(方法/属性贡献);
//! - 组件槽(component_type 解析);
//! - 覆盖与冲突记录(**多候选不任取一个**——同名属性/方法在多个来源出现时
//!   全部保留在 `conflicts`,消费方据此展示候选而非武断取第一个);
//! - 缺失(父/接口未注册)与环 → 诊断事实(诚实,不伪造完成)。

use std::collections::BTreeMap;

use kode_parser::model::DefFile;

use super::facts::{Evidence, Fact, Origin};
use super::id::Facet;
use super::types::SemType;

/// 属性视图(来源保留)。
#[derive(Debug, Clone, PartialEq)]
pub struct PropertyView {
    pub name: String,
    pub ty: SemType,
    /// 声明来源符号路径(`Avatar/Properties/hp` 等;可空)。
    pub symbol: Option<String>,
    pub file: String,
    pub line: Option<usize>,
    /// 是否继承(非自身声明)。
    pub inherited: bool,
    /// 来源名(`Avatar`/`Mixin`/父实体名)。
    pub from: String,
}

/// 方法视图(按角色分面)。
#[derive(Debug, Clone, PartialEq)]
pub struct MethodView {
    pub name: String,
    pub facet: Facet,
    pub args: Vec<String>,
    pub exposed: bool,
    pub file: String,
    pub line: Option<usize>,
    pub from: String,
}

/// 组件槽视图。
#[derive(Debug, Clone, PartialEq)]
pub struct ComponentView {
    pub name: String,
    pub component_type: Option<String>,
    pub persistent: Option<bool>,
}

/// 冲突(多候选;绝不任取一个)。
#[derive(Debug, Clone, PartialEq)]
pub struct Conflict {
    /// 冲突项名(属性/方法名)。
    pub name: String,
    /// 全部候选来源(按展开顺序)。
    pub candidates: Vec<String>,
    pub reason: String,
}

/// 有效实体声明快照。
#[derive(Debug, Clone, Default)]
pub struct EntitySnapshot {
    /// 继承链(自身在前;环/缺失以 status 事实另记)。
    pub parent_chain: Vec<String>,
    /// 展开的接口名(去重,顺序保留)。
    pub interfaces: Vec<String>,
    pub properties: Vec<PropertyView>,
    pub base_methods: Vec<MethodView>,
    pub cell_methods: Vec<MethodView>,
    pub client_methods: Vec<MethodView>,
    pub components: Vec<ComponentView>,
    /// 多候选(同名属性/方法多来源)。
    pub conflicts: Vec<Conflict>,
    /// 诊断事实(缺失父/接口、环、未解析组件类型)。
    pub issues: Vec<Fact>,
}

/// def 名 → def 文件解析器(对象安全;借回调用方的 def,不要求 'static)。
pub trait DefResolver {
    fn resolve(&self, name: &str) -> Option<&DefFile>;
}

impl EntitySnapshot {
    /// 构建快照。
    ///
    /// - `own` 实体自身 DefFile;
    /// - `resolve` 按名取 def(父/接口/组件类型;缺失返回 None → 诚实缺失);
    /// - `graph` 类型图(属性类型解析);
    /// - `root_id`/`entity_name` 用于身份证据。
    pub fn build(
        own: &DefFile,
        resolve: &dyn DefResolver,
        graph: &kode_types::TypeGraph,
        root_id: kode_vfs::store::RootId,
        entity_name: &str,
    ) -> EntitySnapshot {
        let mut snap = EntitySnapshot::default();
        let mut visited: Vec<String> = Vec::new();

        // 继承链(含自环检测)。
        let mut chain = vec![entity_name.to_string()];
        let mut cur = own.parent.clone();
        let mut cycle = false;
        let mut depth = 0;
        while let Some(p) = cur {
            depth += 1;
            if depth > 64 {
                snap.issues.push(issue_fact(&format!("inheritance-chain-overflow:{entity_name}"), root_id, entity_name));
                break;
            }
            if p == entity_name || chain.contains(&p) {
                cycle = true;
                chain.push(p);
                break;
            }
            chain.push(p.clone());
            cur = resolve.resolve(&p).and_then(|d| d.parent.clone());
        }
        snap.parent_chain = chain;
        if cycle {
            snap.issues.push(issue_fact(&format!("inheritance-cycle:{entity_name}"), root_id, entity_name));
        }
        if let Some(p) = &own.parent {
            if resolve.resolve(p).is_none() {
                snap.issues.push(issue_fact(&format!("missing-parent:{p}"), root_id, entity_name));
            }
        }

        // 收集来源定义(自身 + 父链 + 接口;顺序保留)。
        let mut sources: Vec<(String, &DefFile)> = Vec::new();
        
        visited.push(entity_name.to_string());
        sources.push((entity_name.to_string(), own));
        for name in snap.parent_chain.iter().skip(1) {
            if visited.contains(name) {
                continue;
            }
            if let Some(d) = resolve.resolve(name) {
                visited.push(name.clone());
                sources.push((name.clone(), d));
            }
        }
        for name in &own.interfaces {
            snap.interfaces.push(name.clone());
            if visited.contains(name) {
                snap.issues.push(issue_fact(&format!("interface-cycle-or-duplicate:{name}"), root_id, entity_name));
                continue;
            }
            match resolve.resolve(name) {
                Some(d) => {
                    visited.push(name.clone());
                    sources.push((name.clone(), d));
                }
                None => snap.issues.push(issue_fact(&format!("missing-interface:{name}"), root_id, entity_name)),
            }
        }

        // 属性:来源序展开,同名多来源 → 冲突(不任取)。
        let mut prop_seen: BTreeMap<&str, Vec<String>> = BTreeMap::new();
        for (from, def) in &sources {
            let own_decl = from == entity_name;
            for p in &def.properties {
                let entry = prop_seen.entry(p.name.as_str()).or_default();
                if !entry.contains(from) {
                    entry.push(from.clone());
                }
                let ty = match &p.type_name {
                    Some(tn) => SemType::from_type_graph(graph, tn, 4),
                    None => SemType::Unknown("no-type".into()),
                };
                snap.properties.push(PropertyView {
                    name: p.name.clone(),
                    ty,
                    symbol: Some(format!("{from}/Properties/{}", p.name)),
                    file: format!("{from}.def"),
                    line: Some(p.line),
                    inherited: !own_decl,
                    from: from.clone(),
                });
            }
        }
        for (name, froms) in &prop_seen {
            if froms.len() > 1 {
                snap.conflicts.push(Conflict {
                    name: (*name).to_string(),
                    candidates: froms.clone(),
                    reason: "property-defined-in-multiple-sources".into(),
                });
            }
        }

        // 方法(按面):同名多来源 → 冲突。
        for (facet, _list) in [
            (Facet::Base, &own.base_methods),
            (Facet::Cell, &own.cell_methods),
            (Facet::Client, &own.client_methods),
        ] {
            let mut seen: BTreeMap<&str, Vec<String>> = BTreeMap::new();
            let mut views = Vec::new();
            for (from, def) in &sources {
                let method_list = match facet {
                    Facet::Base => &def.base_methods,
                    Facet::Cell => &def.cell_methods,
                    Facet::Client => &def.client_methods,
                };
                for m in method_list {
                    let entry = seen.entry(m.name.as_str()).or_default();
                    if !entry.contains(from) {
                        entry.push(from.clone());
                    }
                    views.push(MethodView {
                        name: m.name.clone(),
                        facet,
                        args: m.args.clone(),
                        exposed: m.exposed,
                        file: format!("{from}.def"),
                        line: Some(m.line),
                        from: from.clone(),
                    });
                }
            }
            for (name, froms) in &seen {
                if froms.len() > 1 {
                    snap.conflicts.push(Conflict {
                        name: (*name).to_string(),
                        candidates: froms.clone(),
                        reason: "method-defined-in-multiple-sources".into(),
                    });
                }
            }
            match facet {
                Facet::Base => snap.base_methods = views,
                Facet::Cell => snap.cell_methods = views,
                Facet::Client => snap.client_methods = views,
            }
        }

        // 组件槽。
        for c in &own.components {
            if let Some(ct) = &c.component_type {
                if resolve.resolve(ct).is_none() {
                    snap.issues.push(issue_fact(&format!("missing-component-type:{ct}"), root_id, entity_name));
                }
            }
            snap.components.push(ComponentView {
                name: c.name.clone(),
                component_type: c.component_type.clone(),
                persistent: c.persistent,
            });
        }

        snap
    }
}

fn issue_fact(reason: &str, _root: kode_vfs::store::RootId, entity: &str) -> Fact {
    Fact::new(reason.to_string(), Origin::unknown(reason)).with_evidence(Evidence::new(
        format!("{entity}.def"),
        None,
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_parser::model::{ComponentDef, PropertyDef, MethodDef};

    fn prop(name: &str, ty: &str) -> PropertyDef {
        PropertyDef {
            name: name.into(),
            name_span: kode_parser::Span::new(0, 0),
            line: 1,
            type_name: Some(ty.into()),
            type_refs: vec![ty.into()],
            flags_raw: None,
            flags: vec![],
            default_value: None,
            detail_level: None,
            database_length: None,
            identifier: None,
            persistent: None,
            sensitive: false,
            extra_tags: vec![],
        }
    }

    fn method(name: &str, exposed: bool) -> MethodDef {
        MethodDef { name: name.into(), name_span: kode_parser::Span::new(0, 0), line: 2, args: vec![], exposed }
    }

    fn def(parent: Option<&str>, interfaces: Vec<&str>, props: Vec<PropertyDef>) -> DefFile {
        DefFile {
            root_tag: Some("root".into()),
            parent: parent.map(|s| s.to_string()),
            interfaces: interfaces.into_iter().map(|s| s.to_string()).collect(),
            volatile: false,
            properties: props,
            components: vec![],
            base_methods: vec![],
            cell_methods: vec![],
            client_methods: vec![],
            extra_sections: vec![],
            diagnostics: vec![],
        }
    }

    struct DefMap(Vec<(&'static str, DefFile)>);

    impl DefMap {
        fn get(&self, name: &str) -> Option<&DefFile> {
            self.0.iter().find(|(n, _)| *n == name).map(|(_, d)| d)
        }
    }

    impl super::DefResolver for DefMap {
        fn resolve(&self, name: &str) -> Option<&DefFile> {
            self.get(name)
        }
    }

    fn map_defs(defs: Vec<(&'static str, DefFile)>) -> DefMap {
        DefMap(defs)
    }

    #[test]
    fn expands_parent_and_interfaces_keeps_order() {
        let own = def(Some("Monster"), vec!["Mixin"], vec![prop("hp", "INT32")]);
        let monster = def(None, vec![], vec![prop("level", "UINT8")]);
        let mixin = def(None, vec![], vec![prop("soul", "INT32")]);
        let resolve = map_defs(vec![("Monster", monster), ("Mixin", mixin)]);
        let g = kode_types::TypeGraph::new();
        let snap = EntitySnapshot::build(&own, &resolve, &g, kode_vfs::store::RootId(1), "Avatar");
        assert_eq!(snap.parent_chain, ["Avatar", "Monster"]);
        assert_eq!(snap.interfaces, ["Mixin"]);
        // 属性序:自身 hp → 父 level → 接口 soul。
        let names: Vec<&str> = snap.properties.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["hp", "level", "soul"]);
        assert!(snap.properties[1].inherited);
    }

    #[test]
    fn cycle_is_diagnosed_not_hang() {
        let a = def(Some("B"), vec![], vec![]);
        let b = def(Some("A"), vec![], vec![]);
        let resolve = map_defs(vec![("A", a), ("B", b)]);
        let g = kode_types::TypeGraph::new();
        let snap = EntitySnapshot::build(resolve.get("A").unwrap(), &resolve, &g, kode_vfs::store::RootId(1), "A");
        assert!(snap.issues.iter().any(|f| f.value.contains("inheritance-cycle")));
    }

    #[test]
    fn conflict_keeps_both_candidates() {
        let own = def(None, vec!["Mixin"], vec![prop("x", "INT32")]);
        let mixin = def(None, vec![], vec![prop("x", "STRING")]);
        let resolve = map_defs(vec![("Mixin", mixin)]);
        let g = kode_types::TypeGraph::new();
        let snap = EntitySnapshot::build(&own, &resolve, &g, kode_vfs::store::RootId(1), "Avatar");
        let conflict = snap.conflicts.iter().find(|c| c.name == "x").expect("同名属性必须冲突");
        assert_eq!(conflict.candidates.len(), 2, "多候选不任取一个");
    }

    #[test]
    fn missing_parent_is_diagnosed_not_fabricated() {
        let own = def(Some("Ghost"), vec![], vec![]);
        let resolve = map_defs(vec![]);
        let g = kode_types::TypeGraph::new();
        let snap = EntitySnapshot::build(&own, &resolve, &g, kode_vfs::store::RootId(1), "Avatar");
        assert!(snap.issues.iter().any(|f| f.value.contains("missing-parent:Ghost")));
    }

    #[test]
    fn methods_split_by_facet() {
        let mut own = def(None, vec![], vec![]);
        own.base_methods = vec![method("tp", false)];
        own.cell_methods = vec![method("tick", false)];
        own.client_methods = vec![method("move", true)];
        let resolve = map_defs(vec![]);
        let g = kode_types::TypeGraph::new();
        let snap = EntitySnapshot::build(&own, &resolve, &g, kode_vfs::store::RootId(1), "Avatar");
        assert_eq!(snap.base_methods.len(), 1);
        assert_eq!(snap.cell_methods[0].name, "tick");
        assert!(snap.client_methods[0].exposed);
    }

    #[test]
    fn components_resolve_type() {
        let mut own = def(None, vec![], vec![]);
        own.components = vec![ComponentDef {
            name: "weapon".into(),
            name_span: kode_parser::Span::new(0, 0),
            line: 3,
            component_type: Some("Weapon".into()),
            persistent: Some(false),
        }];
        let resolve = map_defs(vec![]);
        let g = kode_types::TypeGraph::new();
        let snap = EntitySnapshot::build(&own, &resolve, &g, kode_vfs::store::RootId(1), "Avatar");
        assert_eq!(snap.components.len(), 1);
        assert!(snap.issues.iter().any(|f| f.value.contains("missing-component-type:Weapon")));
    }
}
