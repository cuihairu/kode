//! KODE-MCP-KB-002 P4 integration: `query_excel` filters, the
//! `get_dependencies` cross-format closure (def → types.xml → python, plus
//! excel/csv cell edges), the P1-vocabulary → node-id bridge, and the CSV
//! adapter end-to-end. Every assertion targets real behavior of the built
//! index — no mocks, no coverage filler.

use std::path::{Path, PathBuf};

use kode_mcp::kb_index::KnowledgeIndex;

/// A throwaway assets root + index dir, unique per test (tag + pid), removed
/// on drop so parallel tests never collide or leak state.
struct Fixture {
    root: PathBuf,
    index_dir: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Fixture {
        let root = std::env::temp_dir().join(format!("kode-mcp-kbp4-{tag}-{}", std::process::id()));
        let index_dir =
            std::env::temp_dir().join(format!("kode-mcp-kbp4-idx-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&index_dir);
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        Fixture { root, index_dir }
    }

    fn write(&self, rel: &str, content: &str) {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    fn copy_fixture(&self, name: &str) {
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kb").join(name),
            self.root.join(name),
        )
        .unwrap();
    }

    fn index(&self) -> KnowledgeIndex {
        KnowledgeIndex::open_at(&self.root, &self.index_dir).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
        let _ = std::fs::remove_dir_all(&self.index_dir);
    }
}

/// The def/types.xml/python chain fixture used by the traversal tests:
/// Avatar.slot → SKILL_SLOT → skills.Impl, plus the Avatar entity → class
/// name edge. Shapes mirror the kb_p2 defxml fixture.
fn write_chain(fx: &Fixture) {
    fx.write(
        "scripts/entity_defs/Avatar.def",
        "<root>\n\t<Properties>\n\t\t<slot>\n\t\t\t<Type> SKILL_SLOT </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</slot>\n\t</Properties>\n</root>\n",
    );
    fx.write(
        "scripts/entity_defs/types.xml",
        "<root>\n\t<SKILL_SLOT>\n\t\tFIXED_DICT\n\t\t<Properties>\n\t\t\t<a><Type> UINT32 </Type></a>\n\t\t</Properties>\n\t\t<implementedBy> skills.Impl </implementedBy>\n\t</SKILL_SLOT>\n</root>\n",
    );
    fx.write("scripts/avatar.py", "class Avatar:\n    pass\n");
    fx.write("scripts/skills.py", "class Impl:\n    pass\n");
}

/// A two-hop chain seeded from a csv row: the cell names the xml type
/// (hop 1, `excel-cell-name-match`), whose types-level `implementedBy`
/// reaches the python class (hop 2). No shorter path to `Impl` exists here
/// — no def property references the type — so depth cuts are observable.
fn write_type_chain(fx: &Fixture) {
    fx.write(
        "scripts/entity_defs/types.xml",
        "<root>\n\t<SKILL_SLOT>\n\t\tFIXED_DICT\n\t\t<Properties>\n\t\t\t<a><Type> UINT32 </Type></a>\n\t\t</Properties>\n\t\t<implementedBy> skills.Impl </implementedBy>\n\t</SKILL_SLOT>\n</root>\n",
    );
    fx.write("scripts/skills.py", "class Impl:\n    pass\n");
    fx.write("table.csv", "slot_type\nSKILL_SLOT\n");
}

// ------------------------------------------------------------- query_excel

#[test]
fn query_excel_filters_by_sheet_text_and_file() {
    let fx = Fixture::new("qxl");
    fx.copy_fixture("items.xlsx");
    let index = fx.index();
    index.build();

    // Sheet filter returns the sheet node plus its columns and rows.
    let by_sheet = index.query_excel(None, Some("Items"), None, 200);
    let kinds: Vec<&str> = by_sheet["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"excel-sheet"), "{by_sheet}");
    assert!(kinds.contains(&"excel-column"), "{by_sheet}");
    assert!(kinds.contains(&"excel-row"), "{by_sheet}");

    // Text filter narrows to the rows mentioning the term (A1 locations).
    let by_text = index.query_excel(None, None, Some("RedPotion"), 200);
    assert!(by_text["count"].as_u64().unwrap() >= 1, "{by_text}");
    assert!(by_text["matches"].as_array().unwrap().iter().all(|m| {
        let snippet = m["snippet"].as_str().unwrap_or_default();
        snippet.contains("RedPotion") || m["kind"] == "excel-sheet"
    }));

    // Unknown sheet and unknown file are honestly empty, not errors.
    assert_eq!(index.query_excel(None, Some("NoSuchSheet"), None, 50)["count"], 0);
    assert_eq!(
        index.query_excel(Some("no/such/file.csv"), None, None, 50)["count"],
        0
    );
}

// ------------------------------------------------- excel/csv cell name edges

#[test]
fn excel_and_csv_cells_matching_symbols_yield_unknown_edges() {
    let fx = Fixture::new("celledge");
    fx.copy_fixture("items.xlsx");
    // CSV table with a ';' delimiter and a cell that names the class.
    fx.write("potions.csv", "item;owner\nRedPotion;5\n");
    fx.write("scripts/potion.py", "class RedPotion:\n    pass\n");
    let index = fx.index();
    index.build();

    // The persisted edge set carries the same-name heuristic edge from the
    // csv row node to the python class — always Unknown confidence, never
    // Determined (design doc §10).
    let edges = index.store().edges();
    let cell_edges: Vec<_> = edges
        .iter()
        .filter(|e| e.rule == "excel-cell-name-match")
        .collect();
    assert!(!cell_edges.is_empty(), "{edges:?}");
    assert!(cell_edges
        .iter()
        .all(|e| e.confidence.as_str() == "unknown"));
    let target = cell_edges
        .iter()
        .map(|e| e.target_node.as_str())
        .find(|t| t.contains("potion.py"))
        .expect("csv row → RedPotion class edge");
    let target_node = index.store().node_by_id(target).unwrap();
    assert_eq!(target_node.kind.as_str(), "python-class");

    // Traversing outward from the row node reaches the class.
    let row_hits = index.query_excel(Some("potions.csv"), None, Some("RedPotion"), 50);
    let row_id = row_hits["matches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["kind"] == "excel-row")
        .map(|m| m["id"].as_str().unwrap().to_string())
        .expect("csv row node");
    let deps = index.get_dependencies(&row_id, 6, 256).unwrap();
    assert!(deps["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["rule"] == "excel-cell-name-match"
            && e["to"].as_str().unwrap() == target));
}

// ------------------------------------------------------- get_dependencies

#[test]
fn get_dependencies_traverses_def_types_python_chain() {
    let fx = Fixture::new("depchain");
    write_chain(&fx);
    let index = fx.index();
    index.build();

    let deps = index.get_dependencies("Avatar.slot", 6, 256).unwrap();
    let edges = deps["edges"].as_array().unwrap();
    let rules: Vec<&str> = edges
        .iter()
        .map(|e| e["rule"].as_str().unwrap())
        .collect();
    assert!(rules.contains(&"types.xml type-reference"), "{deps}");
    assert!(rules.contains(&"implementedBy"), "{deps}");
    // Confidence provenance rides every hop (property→type is Inferred,
    // implementedBy is Inferred per the P1 rules).
    assert!(edges
        .iter()
        .all(|e| e["confidence"].as_str().unwrap() != ""));

    // The closure reaches the python class node (cross-format: def → xml → py).
    let nodes = deps["nodes"].as_array().unwrap();
    assert!(nodes.iter().any(|n| n["kind"] == "entity-property"));
    assert!(nodes.iter().any(|n| n["kind"] == "xml-type"));
    assert!(nodes.iter().any(|n| n["kind"] == "python-class"));
    assert_eq!(deps["deterministic"], true);
}

#[test]
fn p1_edges_are_persisted_with_canonical_node_ids() {
    let fx = Fixture::new("bridge");
    write_chain(&fx);
    let index = fx.index();
    index.build();

    // The P1 vocabulary (def:/types:/py:) must have been bridged to node ids
    // for this fixture — every endpoint resolves to a real index node, so
    // get_dependencies can traverse rule edges and excel edges in one space.
    for e in index.store().edges() {
        assert!(
            index.store().node_by_id(&e.source_node).is_some(),
            "unresolved edge source: {} ({})",
            e.source_node,
            e.rule
        );
        assert!(
            index.store().node_by_id(&e.target_node).is_some(),
            "unresolved edge target: {} ({})",
            e.target_node,
            e.rule
        );
    }
}

#[test]
fn get_dependencies_depth_and_node_bounds_report_truncation() {
    let fx = Fixture::new("depbound");
    write_type_chain(&fx);
    let index = fx.index();
    index.build();

    let hits = index.query_excel(Some("table.csv"), None, Some("SKILL_SLOT"), 50);
    let row_id = hits["matches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["kind"] == "excel-row")
        .map(|m| m["id"].as_str().unwrap().to_string())
        .expect("csv row node");

    // Depth 1 stops after the first hop: the cell-name edge reaches the xml
    // type, but the type's own implementedBy edge (hop 2) does not fire.
    let shallow = index.get_dependencies(&row_id, 1, 256).unwrap();
    let shallow_rules: Vec<&str> = shallow["edges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["rule"].as_str().unwrap())
        .collect();
    assert!(shallow_rules.contains(&"excel-cell-name-match"), "{shallow}");
    assert!(!shallow_rules.contains(&"implementedBy"), "{shallow}");
    assert_eq!(shallow["nodeCount"], 2);
    assert_eq!(shallow["truncated"], false);

    // Full depth walks the type → python class hop.
    let deep = index.get_dependencies(&row_id, 6, 256).unwrap();
    assert!(
        deep["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["rule"] == "implementedBy"),
        "{deep}"
    );
    assert!(
        deep["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["kind"] == "python-class"),
        "{deep}"
    );

    // A node cap of 1 leaves only the seed and reports the truncation.
    let capped = index.get_dependencies(&row_id, 6, 1).unwrap();
    assert_eq!(capped["truncated"], true);
    assert_eq!(capped["nodeCount"], 1);
    assert_eq!(capped["edgeCount"], 0);
}

#[test]
fn python_only_change_rebuilds_edges_incrementally() {
    let fx = Fixture::new("pyedge");
    write_chain(&fx);
    // No python class named Avatar yet → no entity-class-name edge.
    fx.write("scripts/avatar.py", "placeholder = True\n");
    let index = fx.index();
    index.build();
    assert!(
        !index
            .store()
            .edges()
            .iter()
            .any(|e| e.rule == "entity-class-name"),
        "sanity: no class, no entity-class-name edge"
    );

    // A python-only edit must rebuild the persisted edges: per-file
    // extracted files stay in the dirty set feeding the edge trigger, even
    // though no def/xml changed. (The trigger used to consult a set that
    // had already had python/excel/csv files removed from it, so a
    // python-only edit left stale edges behind.)
    fx.write("scripts/avatar.py", "class Avatar:\n    pass\n");
    index.reconcile();
    assert!(
        index
            .store()
            .edges()
            .iter()
            .any(|e| e.rule == "entity-class-name"),
        "python-only edit must rebuild persisted edges"
    );
}

#[test]
fn get_dependencies_unknown_symbol_is_honest_error() {
    let fx = Fixture::new("depmiss");
    write_chain(&fx);
    let index = fx.index();
    index.build();

    let err = index.get_dependencies("NoSuchSymbolAnywhere", 6, 256).unwrap_err();
    assert!(err.contains("not found"), "{err}");
}

// -------------------------------------------------------------- CSV adapter

#[test]
fn csv_tables_are_indexed_with_quoting_and_delimiter_detection() {
    let fx = Fixture::new("csv");
    // ';' delimiter, a quoted field containing a comma and an escaped quote.
    fx.write(
        "csvdemo.csv",
        "name;note\n\"Red,Potion\";\"said \"\"hi\"\"\"\n",
    );
    let index = fx.index();
    index.build();

    let hits = index.query_excel(Some("csvdemo.csv"), None, None, 50);
    let matches = hits["matches"].as_array().unwrap();
    assert!(matches.iter().any(|m| m["kind"] == "excel-sheet"), "{hits}");
    assert!(matches
        .iter()
        .any(|m| m["kind"] == "excel-column" && m["name"] == "csvdemo.name"));
    // The quoted field survives parsing intact (the comma is part of the
    // value, not a delimiter artifact).
    let row = matches
        .iter()
        .find(|m| m["kind"] == "excel-row")
        .expect("csv data row indexed");
    assert!(row["snippet"].as_str().unwrap().contains("Red,Potion"), "{row}");
    // A1 location reflects the ';' layout (row 2, first column).
    assert!(row["location"].as_str().unwrap().contains("A2"), "{row}");
}

#[test]
fn csv_non_utf8_is_reported_honestly() {
    let fx = Fixture::new("csvbad");
    // GBK-ish bytes that are not valid UTF-8.
    std::fs::write(fx.root.join("gbk.csv"), b"\xC4\xE3\xBA\xC3\x2C\x31").unwrap();
    let index = fx.index();
    index.build();

    let hits = index.query_excel(Some("gbk.csv"), None, Some("unreadable"), 50);
    assert_eq!(hits["count"], 1, "{hits}");
    let sheet = &hits["matches"].as_array().unwrap()[0];
    assert_eq!(sheet["kind"], "excel-sheet");
    assert!(sheet["snippet"].as_str().unwrap().contains("not valid UTF-8"));
}
