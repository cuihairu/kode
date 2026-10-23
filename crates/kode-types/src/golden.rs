//! 对拍 golden 序列化(只写不读;TS 侧 `tests/kodeTypesParity.test.ts` 用现有
//! defParser/compositionRoots 原语复算,双向门禁与 PR-005/007 同构)。
//!
//! golden 形状(与 dump 逐字段一致):
//! `{"generator","fileCount","typeNodeCount","files":[{"file","kind",
//!   "decls"|"aliases"|"composition"|"entities"}],
//!  "graph":{"classifications":[{"name","class"}],
//!   "aliasChains":[{"name","status","chain"}],
//!   "inheritanceChains":[{"entity","status","chain"}],
//!   "cycles":[[...]]}}`。
//! 任何一侧抽取/求值语义变化都要重生成 golden 并让两侧门禁同时过。

use std::path::Path;

use kode_parser::json::{collect_corpus, JsonWriter, PARITY_CORPORA};
use kode_parser::model::{parse_alias, parse_def, parse_entities, parse_types};

use crate::graph::{ChainStatus, TypeGraph};

/// golden 文件名(仓库相对)。
pub const GOLDEN_REL_PATH: &str = "crates/kode-types/tests/golden/type-parity.json";

/// compositionRoots 的接口标签四种拼写(引擎 EntityDef::loadInterfaces 口径;
/// 精确匹配,不做规范化)。
const INTERFACE_TAGS: &[&str] = &["interface", "Interface", "type", "Type"];

/// .def 路径 → 实体名(文件名去 .def;与 kode-index::def_entity_name 同口径)。
fn def_entity_name(path: &str) -> Option<String> {
    path.rsplit('/')
        .next()
        .map(|base| base.strip_suffix(".def").unwrap_or(base).to_string())
}

fn status_str(status: ChainStatus) -> &'static str {
    match status {
        ChainStatus::Resolved => "resolved",
        ChainStatus::Cycle => "cycle",
        ChainStatus::Unknown => "unknown",
        ChainStatus::Missing => "missing",
    }
}

/// 语料 → 全量类型图(按排序文件序灌入,节点/边序确定)。
pub fn build_corpus_graph(repo_root: &Path) -> (TypeGraph, usize) {
    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let mut graph = TypeGraph::new();
    for (path, (kind, text)) in &files {
        match *kind {
            "def" => {
                let def = parse_def(text);
                if let Some(name) = def_entity_name(path) {
                    graph.add_def(&name, &def);
                }
            }
            "entities" => {
                let e = parse_entities(text);
                graph.register_entities(&e.entities);
            }
            "types" => {
                let t = parse_types(text);
                graph.add_types(&t);
            }
            "alias" => {
                let a = parse_alias(text);
                graph.add_alias(&a);
            }
            _ => {}
        }
    }
    (graph, files.len())
}

/// 整个语料的类型面 golden JSON(与 TS 复算器逐字段一致)。
pub fn dump_type_golden(repo_root: &Path) -> String {
    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let (graph, file_count) = build_corpus_graph(repo_root);
    let mut w = JsonWriter::new();
    w.raw("{\"generator\":\"kode-types dump-type-golden\",\"fileCount\":");
    w.num(file_count);
    w.raw(",\"typeNodeCount\":");
    w.num(graph.nodes.len());
    w.raw(",\"files\":[");

    let mut first_file = true;
    for (path, (kind, text)) in &files {
        if !first_file {
            w.raw(",");
        }
        first_file = false;
        w.raw("{\"file\":");
        w.str(path);
        w.raw(",\"kind\":");
        w.str(kind);
        match *kind {
            "def" => {
                let def = parse_def(text);
                w.raw(",\"composition\":{\"parent\":");
                w.opt_str(def.parent.as_deref());
                // compositionRoots:Interfaces 子元素按四种精确**标签名**拼写过滤
                // (parser DefFile.interfaces 存的是文本,这里按文档重取标签名)。
                w.raw(",\"interfaces\":[");
                let mut fi = true;
                let document = kode_parser::xml::parse(text, true);
                if let Some(root) = document.root() {
                    if let Some(section) = document.child_element(root, "Interfaces") {
                        for iface in document.child_elements(section) {
                            let tag = document.element(iface).name.as_str();
                            if !INTERFACE_TAGS.contains(&tag) {
                                continue;
                            }
                            let name = document.element(iface).text(&document).trim().to_string();
                            if name.is_empty() {
                                continue;
                            }
                            if !fi {
                                w.raw(",");
                            }
                            fi = false;
                            w.str(&name);
                        }
                    }
                }
                w.raw("],\"components\":[");
                let mut ci = true;
                for comp in &def.components {
                    let Some(t) = &comp.component_type else {
                        continue;
                    };
                    if !ci {
                        w.raw(",");
                    }
                    ci = false;
                    w.str(t);
                }
                w.raw("],\"fieldTypes\":[");
                let mut ti = true;
                for prop in &def.properties {
                    for r in &prop.type_refs {
                        if !ti {
                            w.raw(",");
                        }
                        ti = false;
                        w.str(r);
                    }
                }
                w.raw("]}");
            }
            "entities" => {
                let e = parse_entities(text);
                w.raw(",\"entities\":[");
                for (i, ent) in e.entities.iter().enumerate() {
                    if i > 0 {
                        w.raw(",");
                    }
                    w.str(&ent.name);
                }
                w.raw("]");
            }
            "types" => {
                let t = parse_types(text);
                w.raw(",\"decls\":[");
                for (i, decl) in t.types.iter().enumerate() {
                    if i > 0 {
                        w.raw(",");
                    }
                    w.raw("{\"name\":");
                    w.str(&decl.name);
                    w.raw(",\"kind\":");
                    w.str(match decl.kind {
                        kode_parser::model::TypeKind::FixedDict => "fixedDict",
                        kode_parser::model::TypeKind::Array => "array",
                        kode_parser::model::TypeKind::Builtin => "builtin",
                    });
                    w.raw(",\"implementedBySymbol\":");
                    w.opt_str(decl.implemented_by_symbol.as_deref());
                    w.raw(",\"fieldRefs\":[");
                    for (j, r) in decl.field_refs.iter().enumerate() {
                        if j > 0 {
                            w.raw(",");
                        }
                        w.str(r);
                    }
                    w.raw("],\"elementRef\":");
                    w.opt_str(decl.element_ref.as_deref());
                    w.raw("}");
                }
                w.raw("]");
            }
            "alias" => {
                let a = parse_alias(text);
                w.raw(",\"aliases\":[");
                for (i, al) in a.aliases.iter().enumerate() {
                    if i > 0 {
                        w.raw(",");
                    }
                    w.raw("{\"name\":");
                    w.str(&al.name);
                    w.raw(",\"aliasType\":");
                    w.str(&al.alias_type);
                    w.raw("}");
                }
                w.raw("]");
            }
            _ => {}
        }
        w.raw("}");
    }

    // 图级:分类 + 别名链 + 继承链 + 全图环(均按名称排序,输出确定)。
    w.raw("],\"graph\":{\"classifications\":[");
    let mut names = graph.by_name.keys().cloned().collect::<Vec<_>>();
    for e in &graph.registered_entities {
        if !graph.by_name.contains_key(e) {
            names.push(e.clone());
        }
    }
    names.sort();
    names.dedup();
    for (i, name) in names.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.raw("{\"name\":");
        w.str(name);
        w.raw(",\"class\":");
        w.str(graph.classify(name).as_str());
        w.raw("}");
    }
    w.raw("],\"aliasChains\":[");
    let mut alias_names: Vec<String> = graph
        .nodes
        .iter()
        .filter(|n| matches!(n, crate::TypeNode::Alias { .. }))
        .map(|n| n.name().to_string())
        .collect();
    alias_names.sort();
    for (i, name) in alias_names.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        let resolved = graph.resolve_alias_chain(name);
        w.raw("{\"name\":");
        w.str(name);
        w.raw(",\"status\":");
        w.str(status_str(resolved.status));
        w.raw(",\"chain\":[");
        for (j, c) in resolved.chain.iter().enumerate() {
            if j > 0 {
                w.raw(",");
            }
            w.str(c);
        }
        w.raw("]}");
    }
    w.raw("],\"inheritanceChains\":[");
    let mut entity_names: Vec<String> = graph
        .nodes
        .iter()
        .filter(|n| matches!(n, crate::TypeNode::UserType { .. }))
        .map(|n| n.name().to_string())
        .collect();
    entity_names.sort();
    for (i, name) in entity_names.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        let chain = graph.resolve_inheritance(name);
        w.raw("{\"entity\":");
        w.str(name);
        w.raw(",\"status\":");
        w.str(status_str(chain.status));
        w.raw(",\"chain\":[");
        for (j, c) in chain.chain.iter().enumerate() {
            if j > 0 {
                w.raw(",");
            }
            w.str(c);
        }
        w.raw("]}");
    }
    w.raw("],\"cycles\":[");
    let mut cycles = graph.find_cycles();
    cycles.sort();
    for (i, cycle) in cycles.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.raw("[");
        for (j, c) in cycle.iter().enumerate() {
            if j > 0 {
                w.raw(",");
            }
            w.str(c);
        }
        w.raw("]");
    }
    w.raw("]}");
    w.raw("}");
    w.buf
}
