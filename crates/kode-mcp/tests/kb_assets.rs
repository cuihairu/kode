//! KODE-MCP-KB-003 integration: the JSON path-key adapter and the TMX map
//! adapter end-to-end over the built index — scan-root expansion (res/ etc.),
//! `query_assets` filters, honest caps and parse failures, and the guarantee
//! that asset formats never enter the def/xml model parse. Every assertion
//! targets real behavior of the built index — no mocks, no coverage filler.

use kode_mcp::kb_index::KnowledgeIndex;

/// A throwaway assets root + index dir, unique per test (tag + pid), removed
/// on drop so parallel tests never collide or leak state.
struct Fixture {
    root: std::path::PathBuf,
    index_dir: std::path::PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Fixture {
        let root =
            std::env::temp_dir().join(format!("kode-mcp-kbass-{tag}-{}", std::process::id()));
        let index_dir =
            std::env::temp_dir().join(format!("kode-mcp-kbass-idx-{tag}-{}", std::process::id()));
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

/// Behavior-tree JSON in an asset dir (outside scripts/, the new scan face).
const BEHAVIOR_JSON: &str = r#"{"tree":{"type":"behavior","nodes":[{"id":1,"name":"patrol"},{"id":2,"name":"pursue"}],"speed":3.5}}"#;

/// Tiled map with an external tileset, a tile layer and an objectgroup.
const MAP_TMX: &str = "<map version=\"1.10\" orientation=\"orthogonal\" width=\"32\" height=\"24\" tilewidth=\"32\" tileheight=\"32\">\n\
\t<tileset firstgid=\"1\" name=\"terrain\" source=\"../tiles/terrain.tsx\"/>\n\
\t<layer id=\"1\" name=\"ground\" width=\"32\" height=\"24\">\n\
\t\t<data encoding=\"csv\">\n1,2,3\n</data>\n\t</layer>\n\
\t<objectgroup id=\"2\" name=\"spawns\">\n\
\t\t<object id=\"7\" name=\"player_start\" x=\"64\" y=\"32\"/>\n\
\t</objectgroup>\n\
</map>\n";

/// def + python chain so coexistence with the entity model is exercised.
fn write_def_side(fx: &Fixture) {
    fx.write(
        "scripts/entity_defs/Avatar.def",
        "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n",
    );
    fx.write("scripts/avatar.py", "class Avatar:\n    pass\n");
}

// ------------------------------------------------------------ query_assets

#[test]
fn json_configs_are_path_addressable_and_bm25_searchable() {
    let fx = Fixture::new("json");
    fx.write("res/ai/patrol.json", BEHAVIOR_JSON);
    write_def_side(&fx);
    let index = fx.index();
    index.reconcile();

    // The dot path is the address: exact-name lookup routes to the structure
    // index and the leaf value is the node content.
    let exact = index
        .search(
            "tree.nodes.0.name",
            &kode_mcp::kb_index::SearchOptions {
                limit: 10,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(exact["route"], "exact");
    assert_eq!(exact["count"], 1);
    assert_eq!(exact["matches"][0]["kind"], "json-key");
    assert_eq!(exact["matches"][0]["snippet"], "patrol");
    assert_eq!(exact["matches"][0]["file"], "res/ai/patrol.json");

    // A leaf value that is no node name goes through BM25 and still finds
    // the config (this is the "which AI config mentions pursue" question).
    let bm25 = index
        .search(
            "pursue",
            &kode_mcp::kb_index::SearchOptions {
                limit: 10,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(bm25["route"], "bm25");
    let hits = bm25["matches"].as_array().unwrap();
    assert!(
        hits.iter()
            .any(|m| m["kind"] == "json-key" && m["file"] == "res/ai/patrol.json"),
        "bm25 should surface the json leaf: {hits:?}"
    );

    // The def side is untouched by the asset formats (coexistence).
    let entity = index.store().exact_lookup("Avatar");
    assert!(entity.iter().any(|n| n.kind.as_str() == "entity"));
}

#[test]
fn tmx_maps_surface_map_layer_objectgroup_faces_with_lines() {
    let fx = Fixture::new("tmx");
    fx.write("res/maps/level01.tmx", MAP_TMX);
    let index = fx.index();
    index.reconcile();

    // Text filter finds the objectgroup carrying the named object.
    let by_text = index
        .query_assets(Some("tmx"), None, None, Some("player_start"), 50)
        .unwrap();
    assert_eq!(by_text["count"], 1);
    assert_eq!(by_text["matches"][0]["kind"], "tmx-objectgroup");
    assert_eq!(by_text["matches"][0]["name"], "spawns");
    assert!(by_text["matches"][0]["snippet"]
        .as_str()
        .unwrap()
        .contains("player_start(7)"));

    // Name filter reaches a tile layer; its location is the real 1-based
    // line of `<layer>` (map 1 / tileset 2 / layer 3).
    let by_name = index
        .query_assets(Some("tmx"), None, Some("ground"), None, 50)
        .unwrap();
    assert_eq!(by_name["count"], 1);
    assert_eq!(by_name["matches"][0]["kind"], "tmx-layer");
    assert!(
        by_name["matches"][0]["location"]
            .as_str()
            .unwrap()
            .starts_with("lines 3-"),
        "layer carries the real line: {:?}",
        by_name["matches"][0]["location"]
    );

    // Tile data blobs stay out of the index (bounded honesty, no noise).
    let all = index
        .query_assets(Some("tmx"), None, None, Some("1,2,3"), 50)
        .unwrap();
    assert_eq!(all["count"], 0, "tile data must not be indexed");
}

#[test]
fn query_assets_filters_by_format_file_and_prefix() {
    let fx = Fixture::new("filter");
    fx.write("res/ai/patrol.json", BEHAVIOR_JSON);
    fx.write("res/maps/level01.tmx", MAP_TMX);
    let index = fx.index();
    index.reconcile();

    // Without a format both asset formats answer.
    let both = index.query_assets(None, None, None, None, 500).unwrap();
    let count_all = both["count"].as_u64().unwrap();
    assert!(count_all >= 10, "both formats indexed: {count_all}");

    // File filter isolates one asset.
    let by_file = index
        .query_assets(None, Some("res/ai/patrol.json"), None, None, 500)
        .unwrap();
    assert_eq!(
        by_file["count"],
        both["matches"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["file"] == "res/ai/patrol.json")
            .count()
    );
    assert!(by_file["matches"]
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["file"] == "res/ai/patrol.json"));

    // Name-prefix covers `{name}.` children (the excel sheet convention).
    let prefixed = index
        .query_assets(Some("json"), None, Some("tree.nodes"), None, 500)
        .unwrap();
    let names: Vec<&str> = prefixed["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap())
        .collect();
    assert!(
        names.iter().all(|n| n.starts_with("tree.nodes")),
        "prefix must cover children only: {names:?}"
    );
    assert!(names.contains(&"tree.nodes.0.name"));
}

#[test]
fn unknown_asset_format_errors_not_empty_results() {
    let fx = Fixture::new("badfmt");
    fx.write("res/ai/patrol.json", BEHAVIOR_JSON);
    let index = fx.index();
    index.reconcile();
    let err = index
        .query_assets(Some("yaml"), None, None, None, 50)
        .unwrap_err();
    assert!(err.contains("unknown asset format: yaml"), "{err}");
}

// --------------------------------------------------------- honesty + delta

#[test]
fn json_parse_failure_is_visible_in_reconcile_stats() {
    let fx = Fixture::new("badjson");
    fx.write("res/ai/broken.json", "{not json");
    let index = fx.index();
    let stats = index.reconcile();
    assert!(
        stats.extract_errors >= 1,
        "a parse failure must surface, not vanish"
    );
    assert!(
        stats
            .errors
            .iter()
            .any(|e| e.contains("res/ai/broken.json")),
        "the error names the file: {:?}",
        stats.errors
    );
}

#[test]
fn json_truncation_cap_is_reported_in_the_root_node() {
    let fx = Fixture::new("cap");
    let mut text = String::from("{");
    for i in 0..300 {
        if i > 0 {
            text.push(',');
        }
        text.push_str(&format!("\"k{i}\":{i}"));
    }
    text.push('}');
    fx.write("res/big.json", &text);
    let index = fx.index();
    index.reconcile();

    let root = index
        .query_assets(Some("json"), Some("res/big.json"), Some("big"), None, 10)
        .unwrap();
    assert_eq!(root["count"], 1);
    let snippet = root["matches"][0]["snippet"].as_str().unwrap();
    // The snippet is the bounded content head; the note sits at the tail of
    // the stored content, so assert via the store face (full content).
    let stored = index
        .store()
        .exact_lookup("big")
        .into_iter()
        .find(|n| n.kind.as_str() == "json-key")
        .expect("root json node");
    assert!(
        stored.content.contains("paths indexed 256/301"),
        "root reports the exact cap: {}",
        stored.content
    );
    // Non-UTF8-safe: snippet never claims the full document.
    assert!(snippet.len() <= 200);
}

#[test]
fn incremental_json_change_reindexes_without_touching_the_model() {
    let fx = Fixture::new("delta");
    fx.write("res/ai/patrol.json", BEHAVIOR_JSON);
    fx.write("res/maps/level01.tmx", MAP_TMX);
    let index = fx.index();
    index.reconcile();

    // A json-only edit: BLAKE3 re-extract of that file; the def/xml model
    // is not dirtied and asset formats produce no edges, so the edge table
    // is not rebuilt either.
    let before = index.status()["edges"].as_u64().unwrap();
    let mut edited = BEHAVIOR_JSON.strip_suffix('}').unwrap().to_string();
    edited.push_str(",\"extra\":7}");
    fx.write("res/ai/patrol.json", &edited);

    let stats = index.reconcile();
    assert_eq!(stats.changed, 1, "only the edited json file: {stats:?}");
    assert_eq!(stats.extract_errors, 0);
    let after = index.status()["edges"].as_u64().unwrap();
    assert_eq!(
        before, after,
        "asset-only edits do not add or drop edges (before {before}, after {after})"
    );

    let fresh = index
        .query_assets(Some("json"), None, Some("extra"), None, 10)
        .unwrap();
    assert_eq!(fresh["count"], 1, "new key is indexed after the delta");
    assert_eq!(fresh["matches"][0]["snippet"], "7");
}

#[test]
fn non_map_tmx_root_is_rejected_not_force_fitted() {
    let fx = Fixture::new("notmap");
    fx.write("res/misc/random.tmx", "<root><Properties /></root>");
    let index = fx.index();
    let stats = index.reconcile();
    assert!(
        stats
            .errors
            .iter()
            .any(|e| e.contains("root element is <root>")),
        "non-map .tmx states why it was skipped: {:?}",
        stats.errors
    );
}
