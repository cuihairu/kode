//! KSEM-SEM-GOLDEN(RUST-116,旧 SEM-014)语义 fixture 金标数据。
//!
//! 以真实资产夹具 tests/fixtures/kbengine-demo-assets 为语料,把语义纯库
//! 面的确定性产出整体快照成 frozen golden
//! (crates/kode-server/tests/golden/semantics-facts.json):doclass 语料
//! 分类 / nav 三腿导航链(含忽略事实)/ 跨文件重复三面 / rename 归属三分
//! 语料探针。全数组显式排序,字节级可重放。
//!
//! golden 再生成(仅语料夹具或面语义变更时):
//!   cargo run -p kode-server --bin dump-semantics-golden \
//!     > crates/kode-server/tests/golden/semantics-facts.json
//!
//! 差异分类纪律(RUST-116 后半句「跨 Rust/TS 老逻辑差异必须人工分类
//! 审查」):重放与 TS 侧老逻辑对拍发现的任何差异,**必须先入差异分类账**
//! (docs/review/2026-11-16-rust-116-semantic-golden.md §分类账,裁决=
//! 精确升级/同语义双实现/TS 独有消费面/真分歧待修四档)才可合并;账内
//! 未登记的新差异不得静默吞掉。

use std::path::{Path, PathBuf};

use kode_parser::model::parse_entities;
use kode_vfs::DocumentKey;

use crate::semantics::doclass::{classify_document, duplicate_defs, DocClass};
use crate::semantics::doclass::{duplicate_py_classes, duplicate_registrations};
use crate::semantics::engine_meta::EngineMetaLayer;
use crate::semantics::id::Facet;
use crate::semantics::nav::{EntityNavIndex, FeedIgnoreReason, FeedOutcome, PyFacet};
use crate::semantics::rename_policy::{classify_symbol_owner, SymbolOwner};
use crate::semantics::snapshot::ReferenceKind;

pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/semantics-facts.json";
pub const FIXTURE_REL_PATH: &str = "tests/fixtures/kbengine-demo-assets";

/// 递归收集语料(相对 fixture 根的路径,升序确定):`*.def` / `*.py` /
/// `entities.xml`。
fn collect_corpus(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let mut entries: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(it) => it.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
        Err(_) => return,
    };
    entries.sort();
    for p in entries {
        if p.is_dir() {
            collect_corpus(root, &p, out);
        } else if let Ok(rel) = p.strip_prefix(root) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            if rel.ends_with(".def") || rel.ends_with(".py") || rel.ends_with("entities.xml") {
                out.push(rel);
            }
        }
    }
}

fn doclass_tag(class: &DocClass) -> String {
    match class {
        DocClass::PythonEntity(f) => format!("python-entity/{}", pyfacet_tag(f)),
        DocClass::PythonComponent(f) => format!("python-component/{}", f.as_str()),
        DocClass::Def(kind) => format!("def/{}", kind_tag(*kind)),
        DocClass::EntitiesXml => "entities-xml".into(),
        DocClass::TypesXml => "types-xml".into(),
        DocClass::AliasXml => "alias-xml".into(),
        DocClass::Other => "other".into(),
    }
}

fn facet_tag(f: Facet) -> &'static str {
    match f {
        Facet::Base => "base",
        Facet::Cell => "cell",
        Facet::Client => "client",
    }
}

fn kind_tag(kind: ReferenceKind) -> &'static str {
    match kind {
        ReferenceKind::Entity => "entity",
        ReferenceKind::Interface => "interface",
        ReferenceKind::Component => "component",
    }
}

fn pyfacet_tag(f: &PyFacet) -> &'static str {
    match f {
        PyFacet::Root => "root",
        PyFacet::Base => "base",
        PyFacet::Cell => "cell",
        PyFacet::Client => "client",
    }
}

/// dump 语义金标(确定性;两次调用同字节)。
pub fn dump_semantics_golden(repo_root: &Path) -> String {
    let fixture = repo_root.join(FIXTURE_REL_PATH);
    let mut corpus: Vec<String> = Vec::new();
    collect_corpus(&fixture, &fixture, &mut corpus);
    corpus.sort();

    let key_of = |rel: &str| {
        DocumentKey::new(
            kode_vfs::store::RootId(1),
            kode_vfs::uri::CanonicalUri::from_path(&fixture.join(rel).to_string_lossy()),
        )
    };
    let read =
        |rel: &str| -> String { std::fs::read_to_string(fixture.join(rel)).unwrap_or_default() };

    // ---- entities.xml 注册位 ----
    let ents = parse_entities(&read("scripts/entities.xml")).entities;

    // ---- nav 三腿链 ----
    let mut nav = EntityNavIndex::default();
    let mut nav_ignored: Vec<serde_json::Value> = Vec::new();
    let mut def_stems: Vec<String> = Vec::new();
    for e in &ents {
        nav.register_entity("scripts/entities.xml", e);
    }
    for rel in &corpus {
        if rel.ends_with(".def") {
            let name = rel.rsplit('/').next().unwrap_or(rel);
            let name = name.strip_suffix(".def").unwrap_or(name);
            def_stems.push(name.to_string());
            // def 段事实 = 注册位 hasXxx 旗标(消费方口径;缺旗标不计段)。
            let mut facets: Vec<Facet> = Vec::new();
            if entry_line_flag(&ents, name, "hasBase") {
                facets.push(Facet::Base);
            }
            if entry_line_flag(&ents, name, "hasCell") {
                facets.push(Facet::Cell);
            }
            if entry_line_flag(&ents, name, "hasClient") {
                facets.push(Facet::Client);
            }
            nav.declare_def(name, rel, &facets);
        }
    }
    for rel in &corpus {
        if !rel.ends_with(".py") {
            continue;
        }
        let src = read(rel);
        let symbols = kode_python::symbols::extract(&kode_python::parse::ParsedAst::new(&src));
        match nav.feed_python(rel, &symbols) {
            FeedOutcome::Fed { .. } => {}
            FeedOutcome::Ignored(reason) => {
                let tag = match reason {
                    FeedIgnoreReason::NotScriptLayout => "not-script-layout",
                    FeedIgnoreReason::EntityNotRegistered => "entity-not-registered",
                };
                nav_ignored.push(serde_json::json!({ "path": rel, "reason": tag }));
            }
        }
    }
    nav_ignored.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));

    let mut nav_entries: Vec<serde_json::Value> = Vec::new();
    let mut names: Vec<String> = ents.iter().map(|e| e.name.clone()).collect();
    names.extend(def_stems);
    names.sort();
    names.dedup();
    for name in &names {
        let Some(e) = nav.forward(name) else {
            continue;
        };
        let python: Vec<serde_json::Value> = e
            .python
            .iter()
            .map(|(facet, site)| {
                serde_json::json!({
                    "facet": pyfacet_tag(facet),
                    "file": site.file,
                    "class_line": site.class_line,
                    "class_end_line": site.class_end_line,
                    "bases": site.bases,
                })
            })
            .collect();
        nav_entries.push(serde_json::json!({
            "entity": e.entity,
            "registration": e.registration.as_ref().map(|r| serde_json::json!({
                "file": r.file,
                "line": r.line,
                "attributes": r.attributes,
            })),
            "def_file": e.def_file,
            "def_facets": e.def_facets.iter().map(|f| facet_tag(*f)).collect::<Vec<_>>(),
            "python": python,
        }));
    }

    // ---- doclass 语料分类 ----
    let mut doclass_rows: Vec<serde_json::Value> = corpus
        .iter()
        .map(|rel| {
            serde_json::json!({
                "path": rel,
                "class": doclass_tag(&classify_document(&key_of(rel))),
            })
        })
        .collect();
    doclass_rows.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));

    // ---- 跨文件重复三面 ----
    let keys: Vec<DocumentKey> = corpus.iter().map(|rel| key_of(rel)).collect();
    let dup_defs: Vec<serde_json::Value> = duplicate_defs(&keys)
        .into_iter()
        .map(|f| {
            serde_json::json!({
                "kind": kind_tag(f.kind),
                "name": f.name,
                "files": f.files,
            })
        })
        .collect();
    let dup_regs: Vec<serde_json::Value> = duplicate_registrations(&ents)
        .into_iter()
        .map(|f| serde_json::json!({ "name": f.name, "lines": f.lines }))
        .collect();
    let mut dup_classes: Vec<serde_json::Value> = Vec::new();
    for rel in &corpus {
        if !rel.ends_with(".py") {
            continue;
        }
        let src = read(rel);
        let symbols = kode_python::symbols::extract(&kode_python::parse::ParsedAst::new(&src));
        for f in duplicate_py_classes(&symbols) {
            dup_classes
                .push(serde_json::json!({ "file": rel, "class": f.class, "lines": f.lines }));
        }
    }
    dup_classes.sort_by(|a, b| a["file"].as_str().cmp(&b["file"].as_str()));

    // ---- rename 归属三分(语料探针:每 py 文件按文件干分类 + 两个固定
    // 探针钉内建/生成物面)----
    let meta = EngineMetaLayer::new();
    let mut rename_rows: Vec<serde_json::Value> = Vec::new();
    for rel in &corpus {
        if !rel.ends_with(".py") {
            continue;
        }
        let stem = rel.rsplit('/').next().unwrap_or(rel);
        let stem = stem.strip_suffix(".py").unwrap_or(stem);
        let c = classify_symbol_owner(&meta, rel, stem, None, None, ".kbengine");
        rename_rows.push(serde_json::json!({
            "path": rel,
            "name": stem,
            "owner": owner_tag(c.owner),
        }));
    }
    rename_rows.push(serde_json::json!({
        "path": "scripts/base/Avatar.py",
        "name": "createEntity",
        "owner": "engine-builtin",
        "probe": "builtin-api",
    }));
    rename_rows.push(serde_json::json!({
        "path": ".kbengine/stubs/KBEngine.pyi",
        "name": "createEntity",
        "owner": "generated",
        "probe": "generated-stub",
    }));
    rename_rows.sort_by(|a, b| {
        a["path"]
            .as_str()
            .cmp(&b["path"].as_str())
            .then(a["name"].as_str().cmp(&b["name"].as_str()))
    });

    let doc = serde_json::json!({
        "fixture": FIXTURE_REL_PATH,
        "corpusCount": corpus.len(),
        "doclass": doclass_rows,
        "nav": nav_entries,
        "navIgnored": nav_ignored,
        "duplicateDefs": dup_defs,
        "duplicateRegistrations": dup_regs,
        "duplicatePyClasses": dup_classes,
        "renameOwnership": rename_rows,
    });
    serde_json::to_string_pretty(&doc).expect("golden JSON 序列化") + "\n"
}

/// 注册位布尔旗标读取(nav RegistrationSite.flag 同判据)。
fn entry_line_flag(ents: &[kode_parser::model::EntityEntry], name: &str, flag: &str) -> bool {
    ents.iter()
        .find(|e| e.name == name)
        .and_then(|e| {
            e.attributes
                .iter()
                .find(|(k, _)| k == flag)
                .map(|(_, v)| v.eq_ignore_ascii_case("true") || v == "1")
        })
        .unwrap_or(false)
}

fn owner_tag(owner: SymbolOwner) -> &'static str {
    match owner {
        SymbolOwner::UserCode => "user-code",
        SymbolOwner::EngineBuiltin => "engine-builtin",
        SymbolOwner::Generated => "generated",
        SymbolOwner::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_root() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .unwrap_or_else(|| Path::new("."))
    }

    #[test]
    fn dump_is_deterministic_across_calls() {
        let a = dump_semantics_golden(repo_root());
        let b = dump_semantics_golden(repo_root());
        assert_eq!(a, b, "两次 dump 同字节");
    }

    #[test]
    fn golden_covers_corpus_and_faces() {
        let doc: serde_json::Value =
            serde_json::from_str(&dump_semantics_golden(repo_root())).expect("JSON 合法");
        assert_eq!(doc["fixture"], FIXTURE_REL_PATH);
        let count = doc["corpusCount"].as_u64().expect("corpusCount");
        assert!(count > 20, "demo 语料规模回归锁,得 {count}");
        let doclass = doc["doclass"].as_array().expect("doclass array");
        assert_eq!(doclass.len() as u64, count, "逐文件分类全量");
        let nav = doc["nav"].as_array().expect("nav array");
        assert!(
            nav.iter().any(|e| e["entity"] == "Avatar"),
            "Avatar 导航链在案"
        );
        let avatar = nav.iter().find(|e| e["entity"] == "Avatar").unwrap();
        let facets: Vec<&str> = avatar["def_facets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(facets, ["base", "cell", "client"], "hasXxx 旗标推导段事实");
        let ignored = doc["navIgnored"].as_array().expect("ignored array");
        assert!(
            ignored
                .iter()
                .any(|r| r["reason"] == "entity-not-registered"),
            "kbemain 等未注册脚本诚实入忽略账"
        );
        let rename = doc["renameOwnership"].as_array().expect("rename array");
        assert!(rename
            .iter()
            .any(|r| r["probe"] == "builtin-api" && r["owner"] == "engine-builtin"));
        assert!(rename
            .iter()
            .any(|r| r["probe"] == "generated-stub" && r["owner"] == "generated"));
    }
}
