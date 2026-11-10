//! KODE-MCP-KB-002 P2 integration: BLAKE3 content addressing, incremental
//! reconcile (BLAKE3 diff + notify watcher), BM25 search, exact/BM25 routing,
//! SQLite persistence across reopen, index_status state, git-state awareness,
//! and the Excel adapter end-to-end. Every assertion targets real behavior of
//! the built index — no mocks, no coverage filler.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use kode_mcp::kb_index::{KnowledgeIndex, Route, SearchOptions};
use kode_mcp::nodes::content_hash;

/// A throwaway assets root + index dir, unique per test (tag + pid), removed
/// on drop so parallel tests never collide or leak state.
struct Fixture {
    root: PathBuf,
    index_dir: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Fixture {
        let root = std::env::temp_dir().join(format!("kode-mcp-kbp2-{tag}-{}", std::process::id()));
        let index_dir =
            std::env::temp_dir().join(format!("kode-mcp-kbp2-idx-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&index_dir);
        std::fs::create_dir_all(root.join("docs")).unwrap();
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

    fn remove(&self, rel: &str) {
        std::fs::remove_file(self.root.join(rel)).unwrap();
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

fn opts(limit: usize) -> SearchOptions {
    SearchOptions {
        limit,
        ..Default::default()
    }
}

fn count_of(v: &serde_json::Value, key: &str) -> u64 {
    v[key]
        .as_u64()
        .unwrap_or_else(|| panic!("{key} missing: {v}"))
}

// ------------------------------------------------------- BLAKE3 addressing

#[test]
fn blake3_content_addressing_is_stable_and_change_sensitive() {
    // Same bytes → same 64-hex digest; one byte → a different digest.
    let h1 = content_hash(b"alchemy notes");
    let h2 = content_hash(b"alchemy notes");
    assert_eq!(h1, h2);
    assert_eq!(h1.len(), 64);
    assert!(h1.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(h1, content_hash(b"alchemy note2"));

    // Re-extracting identical content yields identical ids and hashes.
    let a = kode_mcp::extract::markdown_nodes("proj", "docs/a.md", "# Potion\n\nbrewing notes\n");
    let b = kode_mcp::extract::markdown_nodes("proj", "docs/a.md", "# Potion\n\nbrewing notes\n");
    assert_eq!(a.len(), b.len());
    for (na, nb) in a.iter().zip(b.iter()) {
        assert_eq!(na.id, nb.id);
        assert_eq!(na.content_hash, nb.content_hash);
    }
    // Changing the content keeps the identity id but moves the content hash.
    let c = kode_mcp::extract::markdown_nodes("proj", "docs/a.md", "# Potion\n\ndifferent notes\n");
    for (na, nc) in a.iter().zip(c.iter()) {
        assert_eq!(na.id, nc.id, "identity id is content-independent");
        if na.content != nc.content {
            assert_ne!(na.content_hash, nc.content_hash);
        }
    }
}

// ------------------------------------------------- incremental reconcile

#[test]
fn reconcile_rebuilds_only_changed_and_removed_files() {
    let fx = Fixture::new("incr");
    fx.write("docs/guide.md", "# Guide\n\nthe oldterm flows here\n");
    fx.write("docs/other.md", "# Other\n\nstable content uniquealpha\n");
    fx.write(
        "scripts/hero.py",
        "class Hero:\n    def roar(self):\n        return 1\n",
    );
    let index = fx.index();
    let s1 = index.build();
    assert_eq!(s1.added, 3, "first sweep adds every file: {s1:?}");
    assert_eq!(s1.unchanged, 0);
    assert!(
        index.search("oldterm", &opts(10)).unwrap()["count"]
            .as_u64()
            .unwrap()
            >= 1,
        "initial content searchable"
    );

    // Rewrite one file: exactly that file is re-extracted.
    fx.write("docs/guide.md", "# Guide\n\nthe newterm flows here\n");
    let s2 = index.reconcile();
    assert_eq!(s2.changed, 1, "only the rewritten file: {s2:?}");
    assert_eq!(s2.unchanged, 2, "BLAKE3 dedup skips untouched files");
    assert_eq!(s2.added, 0);
    assert_eq!(
        count_of(&index.search("oldterm", &opts(10)).unwrap(), "count"),
        0
    );
    assert!(count_of(&index.search("newterm", &opts(10)).unwrap(), "count") >= 1);

    // Deleting a file drops its nodes (never a zombie index entry).
    fx.remove("docs/other.md");
    let s3 = index.reconcile();
    assert_eq!(s3.removed, 1, "{s3:?}");
    assert_eq!(
        count_of(&index.search("uniquealpha", &opts(10)).unwrap(), "count"),
        0
    );
    // The untouched python file survives every sweep.
    assert!(count_of(&index.search("roar", &opts(10)).unwrap(), "count") >= 1);
}

#[test]
fn watcher_marks_dirty_and_reconcile_folds_the_change() {
    let fx = Fixture::new("watch");
    fx.write("docs/watched.md", "# Watched\n\nbefore-watch-token\n");
    let index = fx.index();
    index.build();
    index
        .start_watch()
        .expect("recursive watch over the fixture");
    assert!(index.watcher_active());
    assert_eq!(index.dirty_pending(), 0);

    fx.write("docs/watched.md", "# Watched\n\nafter-watch-token\n");
    // Poll with a generous deadline instead of a flaky fixed sleep.
    let deadline = Instant::now() + Duration::from_secs(30);
    while index.dirty_pending() == 0 {
        assert!(
            Instant::now() < deadline,
            "watcher did not mark the edit dirty within 30s"
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    let stats = index.reconcile();
    assert_eq!(stats.changed, 1, "{stats:?}");
    assert_eq!(index.dirty_pending(), 0, "reconcile folds the dirty set");
    assert_eq!(
        count_of(
            &index.search("before-watch-token", &opts(10)).unwrap(),
            "count"
        ),
        0
    );
    assert!(
        count_of(
            &index.search("after-watch-token", &opts(10)).unwrap(),
            "count"
        ) >= 1
    );
}

// ------------------------------------------------------------- BM25 search

#[test]
fn bm25_finds_known_terms_and_respects_format_filter() {
    let fx = Fixture::new("bm25");
    fx.write(
        "docs/grimoire.md",
        "# Grimoire\n\nthe grimoire lists forbidden alchemy steps\n",
    );
    fx.write(
        "scripts/spellbook.py",
        "class Spellbook:\n    def cast(self):\n        return \"incantation released\"\n",
    );
    let index = fx.index();
    index.build();

    let hit = index.search("alchemy", &opts(10)).unwrap();
    assert_eq!(hit["route"], "bm25");
    assert!(count_of(&hit, "count") >= 1);
    let m = &hit["matches"][0];
    assert_eq!(m["file"], "docs/grimoire.md");
    assert!(m["snippet"].as_str().unwrap().contains("alchemy"));

    // Format filter narrows to python only — the markdown hit is excluded.
    let py_only = SearchOptions {
        format: Some("python".into()),
        ..opts(10)
    };
    let hit = index.search("incantation", &py_only).unwrap();
    assert!(count_of(&hit, "count") >= 1);
    let kinds: Vec<&str> = hit["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["kind"].as_str().unwrap())
        .collect();
    assert!(
        kinds.contains(&"python-class"),
        "class node present in python-only results: {kinds:?}"
    );
    assert_eq!(
        count_of(&index.search("alchemy", &py_only).unwrap(), "count"),
        0
    );
}

// ------------------------------------------------------- exact vs BM25 route

#[test]
fn exact_identifier_route_wins_over_bm25() {
    let fx = Fixture::new("route");
    fx.write(
        "docs/potions.md",
        "# Potion\n\nbrewing potions and elixirs\n",
    );
    let index = fx.index();
    index.build();

    // "Potion" is an existing node name → the structure index answers, and
    // the row carries no BM25 score at all.
    let hit = index.search("Potion", &opts(10)).unwrap();
    assert_eq!(hit["route"], "exact");
    assert!(count_of(&hit, "count") >= 1);
    assert_eq!(hit["matches"][0]["name"], "Potion");
    assert!(hit["matches"][0].get("score").is_none());

    // Forcing the BM25 route for the same word still searches full text.
    let forced = SearchOptions {
        route: Route::Bm25,
        ..opts(10)
    };
    let hit = index.search("Potion", &forced).unwrap();
    assert_eq!(hit["route"], "bm25");
    assert!(count_of(&hit, "count") >= 1);

    // A term that is not any node's name routes to BM25.
    let hit = index.search("brewing", &opts(10)).unwrap();
    assert_eq!(hit["route"], "bm25");
    assert!(count_of(&hit, "count") >= 1);
}

// ------------------------------------------------------------- persistence

#[test]
fn sqlite_and_bm25_index_survive_reopen() {
    let fx = Fixture::new("reopen");
    fx.write("docs/lair.md", "# Lair\n\nthe guardian sleeps beneath\n");
    fx.write(
        "scripts/gate.py",
        "class Gate:\n    def seal(self):\n        return 1\n",
    );
    let index = fx.index();
    index.build();
    let before = index.search("guardian", &opts(10)).unwrap();
    assert!(count_of(&before, "count") >= 1);
    let first_id = before["matches"][0]["id"].clone();
    drop(index);

    // Reopen the same storage dir: persisted state answers without a rebuild.
    let reopened = fx.index();
    let after = reopened.search("guardian", &opts(10)).unwrap();
    assert!(count_of(&after, "count") >= 1, "nodes survive the reopen");
    assert_eq!(after["matches"][0]["id"], first_id);
    let (nodes, edges, _) = reopened.store().stats();
    assert!(nodes > 0);
    let _ = edges;

    // A reconcile after restart must dedup everything via stored BLAKE3.
    let stats = reopened.reconcile();
    assert_eq!(stats.added, 0, "{stats:?}");
    assert_eq!(stats.changed, 0);
    assert_eq!(stats.unchanged, 2);
}

// ------------------------------------------------------------ index_status

#[test]
fn index_status_reflects_index_state() {
    let fx = Fixture::new("status");
    fx.write("docs/guide.md", "# Guide\n\nstatus probe content\n");
    fx.write(
        "scripts/hero.py",
        "class Hero:\n    def roar(self):\n        return 1\n",
    );
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kb/items.xlsx"),
        fx.root.join("items.xlsx"),
    )
    .unwrap();
    let index = fx.index();
    index.build();

    let st = index.status();
    assert!(count_of(&st, "nodes") >= 6, "md + py + excel nodes: {st}");
    assert!(count_of(&st, "ftsDocs") >= 6, "BM25 docs mirror the store");
    assert!(st["byFormat"]["markdown"].as_u64().unwrap() >= 1);
    assert!(st["byFormat"]["python"].as_u64().unwrap() >= 1);
    assert!(st["byFormat"]["excel"].as_u64().unwrap() >= 1);
    assert_eq!(st["storageMode"], "file");
    assert_eq!(st["contentAddressingIntact"], true);
    assert_eq!(count_of(&st["lastReconcile"], "filesScanned"), 3);
    assert_eq!(st["watcherActive"], false);
    assert_eq!(
        st["gitAvailable"], false,
        "plain temp fixture is not a repo"
    );

    index.start_watch().unwrap();
    assert_eq!(index.status()["watcherActive"], true);
}

// ---------------------------------------------------------- git awareness

#[test]
fn gitignored_files_are_never_indexed() {
    let fx = Fixture::new("git");
    // A real temp git repo with ignore rules.
    for cmd in [
        vec!["init", "-q"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "t"],
    ] {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&fx.root)
            .args(&cmd)
            .output()
            .expect("git binary");
        assert!(out.status.success(), "git {cmd:?} failed");
    }
    fx.write(".gitignore", "secret.md\nignored/\n");
    fx.write("docs/visible.md", "visibleterm sits in the open\n");
    fx.write("docs/secret.md", "classifiedterm stays hidden\n");
    fx.write("scripts/ignored/hidden.py", "class Hidden:\n    pass\n");
    let index = fx.index();
    let stats = index.build();

    assert!(stats.git_available, "probe must see the temp repo");
    assert_eq!(
        stats.ignored_by_git, 2,
        "secret.md + scripts/ignored/hidden.py: {stats:?}"
    );
    let st = index.status();
    assert_eq!(st["gitAvailable"], true);
    assert_eq!(count_of(&st, "gitIgnoredLast"), 2);

    // Ignored content is absent from both stores; visible content is present.
    assert_eq!(
        count_of(&index.search("classifiedterm", &opts(10)).unwrap(), "count"),
        0
    );
    assert_eq!(
        count_of(&index.search("hiddenterm", &opts(10)).unwrap(), "count"),
        0
    );
    assert!(count_of(&index.search("visibleterm", &opts(10)).unwrap(), "count") >= 1);
    let (nodes, _, _) = index.store().stats();
    assert!(
        index.store().exact_lookup("Hidden").is_empty(),
        "gitignored python class never reaches the structure index"
    );
    let _ = nodes;
}

// ---------------------------------------------------------------- Excel e2e

#[test]
fn excel_workbook_is_indexed_and_searchable() {
    let fx = Fixture::new("excel");
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kb/items.xlsx"),
        fx.root.join("items.xlsx"),
    )
    .unwrap();
    let index = fx.index();
    index.build();

    let hit = index.search("RedPotion", &opts(10)).unwrap();
    assert!(count_of(&hit, "count") >= 1, "{hit}");
    assert!(hit["matches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["kind"] == "excel-row"));
    // Column nodes carry the header names for exact lookup.
    assert!(!index.store().exact_lookup("Items.name").is_empty());
    let st = index.status();
    assert!(st["byFormat"]["excel"].as_u64().unwrap() >= 1);
}

// ------------------------------------------------------ def/xml model + edges

#[test]
fn def_xml_model_nodes_and_edges_are_persisted() {
    let fx = Fixture::new("defxml");
    fx.write(
        "scripts/entity_defs/Avatar.def",
        "<root>\n\t<Properties>\n\t\t<slot>\n\t\t\t<Type> SKILL_SLOT </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</slot>\n\t</Properties>\n</root>\n",
    );
    fx.write(
        "scripts/entity_defs/types.xml",
        "<root>\n\t<SKILL_SLOT>\n\t\tFIXED_DICT\n\t\t<Properties>\n\t\t\t<a><Type> UINT32 </Type></a>\n\t\t</Properties>\n\t\t<implementedBy> skills.Impl </implementedBy>\n\t</SKILL_SLOT>\n</root>\n",
    );
    fx.write("scripts/avatar.py", "class Avatar:\n    pass\n");
    let index = fx.index();
    let stats = index.build();

    // Model-backed nodes land in the structure index… ("Avatar" matches both
    // the entity node and the same-named python class; find the entity one.)
    let entity = index
        .store()
        .exact_lookup("Avatar")
        .into_iter()
        .find(|n| n.kind.as_str() == "entity")
        .expect("Avatar entity node indexed");
    assert_eq!(entity.file_path, "scripts/entity_defs/Avatar.def");
    let hit = index.search("SKILL_SLOT", &opts(10)).unwrap();
    assert!(hit["matches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["kind"] == "xml-type"));

    // …and the P1 edge rules are persisted (type-reference + implementedBy).
    assert!(count_of(&index.status(), "edges") >= 2, "{stats:?}");
}
