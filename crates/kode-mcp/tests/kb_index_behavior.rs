//! kb_index 行为补测(2026-11-11 覆盖率批次:基线 llvm-cov 最低两模块
//! fts.rs 84.4% / kb_index.rs 88.0% 之一):向量 P3 seam 诚实面与融合、
//! watcher 注册幂等、kind 过滤轴。每条断言锁定真实行为——无 mock 索引、
//! 无凑数用例(与 kb_p2/kb_p4/kb_assets 同一口径)。

use std::path::PathBuf;
use std::sync::Arc;

use kode_mcp::kb_index::{KnowledgeIndex, Route, SearchOptions, SemanticRetriever};

/// A throwaway assets root + index dir, unique per test (tag + pid), removed
/// on drop so parallel tests never collide or leak state. Same pattern as
/// kb_p2/kb_p4/kb_assets.
struct Fixture {
    root: PathBuf,
    index_dir: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Fixture {
        let root = std::env::temp_dir().join(format!("kode-mcp-kbb-{tag}-{}", std::process::id()));
        let index_dir =
            std::env::temp_dir().join(format!("kode-mcp-kbb-idx-{tag}-{}", std::process::id()));
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

/// P3 seam stub: returns fixed hits regardless of query. Only used to prove
/// the fusion contract, never to fake index content — the returned ids are
/// real node ids discovered from the built index.
#[derive(Debug)]
struct StubRetriever {
    hits: Vec<(String, f32)>,
}

impl SemanticRetriever for StubRetriever {
    fn name(&self) -> &'static str {
        "stub-vector"
    }

    fn retrieve(&self, _query: &str, _limit: usize) -> Result<Vec<(String, f32)>, String> {
        Ok(self.hits.clone())
    }
}

#[test]
fn natural_language_query_reports_vector_seam_honestly() {
    let fx = Fixture::new("vec-none");
    fx.write("docs/net.md", "# Demo\n\n## Gateway\n\n网关转发流程说明\n");
    let index = fx.index();
    index.build();

    // 多词 CJK 短语 → NL 形态 → 走 P3 seam;未配置时如实回报 configured=false,
    // 绝不伪装成 BM25 结果或静默丢字段。
    let out = index
        .search("网关 转发 流程", &opts(10))
        .expect("nl search");
    assert_eq!(out["route"], "bm25");
    assert_eq!(out["vector"]["configured"], false);
    assert!(out["vector"]["deferred"].as_str().unwrap().contains("P3"));
    assert_eq!(out["deterministic"], true);
}

#[test]
fn configured_vector_retriever_fuses_missed_docs_into_nl_results() {
    let fx = Fixture::new("vec-stub");
    fx.write("docs/net.md", "# Demo\n\n## Gateway\n\n网关转发流程说明\n");
    fx.write("docs/db.md", "# Demo\n\n## Archive\n\n存档周期与备份策略\n");
    let index = fx.index();
    index.build();

    // NL 短语的 BM25 词面(与)只命中 net 节点;另取一个 BM25 够不到的
    // 真实节点 id,交给 stub。
    let bm25 = index
        .search("网关 转发 流程", &opts(10))
        .expect("bm25 nl search");
    assert!(bm25["matches"]
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["file"] == "docs/net.md"));
    let archived = index.search("存档", &opts(10)).expect("find archive node");
    let fused_id = archived["matches"][0]["id"].as_str().unwrap().to_string();

    index.set_vector_retriever(Arc::new(StubRetriever {
        hits: vec![(fused_id.clone(), 3.5)],
    }));

    let out = index
        .search("网关 转发 流程", &opts(10))
        .expect("fused nl search");
    assert_eq!(out["vector"]["configured"], true);
    assert_eq!(out["vector"]["engine"], "stub-vector");
    let matches = out["matches"].as_array().unwrap();
    let fused = matches
        .iter()
        .find(|m| m["id"] == serde_json::json!(fused_id))
        .expect("vector-fused row must appear");
    assert_eq!(fused["file"], "docs/db.md");
    // 3.5 在 f32/f64 双侧精确可表示,跨 JSON 序列化无表示差。
    assert_eq!(fused["score"], serde_json::json!(3.5));
    // BM25 hits stay in the same answer (fusion, not replacement).
    assert!(matches.iter().any(|m| m["file"] == "docs/net.md"));
}

#[test]
fn watcher_registration_is_idempotent_and_state_honest() {
    let fx = Fixture::new("watch");
    fx.write("docs/a.md", "hello\n");
    let index = fx.index();
    assert!(!index.watcher_active());
    assert_eq!(index.dirty_pending(), 0);

    index.start_watch().expect("first watch registration");
    assert!(index.watcher_active());
    assert_eq!(index.dirty_pending(), 0);

    // 第二次注册是幂等 no-op Ok(不重复挂 watcher、不报错)。
    index.start_watch().expect("second watch registration");
    assert!(index.watcher_active());
    assert_eq!(index.dirty_pending(), 0);
}

#[test]
fn kind_filter_narrows_the_exact_route() {
    let fx = Fixture::new("kind");
    fx.write("docs/net.md", "# Demo\n\n## Gateway\n\n网关转发流程说明\n");
    let index = fx.index();
    index.build();

    // kind=section:精确路由命中的 section 节点全数保留。
    let mut section_only = opts(10);
    section_only.kind = Some("section".into());
    let out = index.search("Gateway", &section_only).expect("kind search");
    assert_eq!(out["route"], "exact");
    assert!(out["count"].as_u64().unwrap() >= 1);
    assert!(out["matches"]
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["kind"] == "section"));

    // kind=xml-type:同查询被过滤成诚实空集(节点存在,只是类别不符)。
    let mut wrong_kind = opts(10);
    wrong_kind.kind = Some("xml-type".into());
    let out = index.search("Gateway", &wrong_kind).expect("kind search");
    assert_eq!(out["route"], "exact");
    assert_eq!(out["count"], 0);
}

/// Debug/句柄面:Debug 只报字段摘要(finish_non_exhaustive)、root()/fts()
/// 句柄直读、无 watcher 时状态诚实。
#[test]
fn debug_root_and_fts_getters_expose_honest_state() {
    let fx = Fixture::new("getters");
    fx.write("docs/a.md", "# Demo\n\n## Gateway\n\ntext\n");
    let index = fx.index();
    index.build();
    let dbg = format!("{index:?}");
    assert!(dbg.contains("KnowledgeIndex"), "{dbg}");
    assert!(dbg.contains("root:"), "{dbg}");
    assert!(
        dbg.contains(".."),
        "finish_non_exhaustive keeps internals private: {dbg}"
    );
    assert_eq!(index.root(), fx.root.as_path());
    assert!(index.fts().doc_count() >= 1, "build indexes fts docs");
    assert!(!index.watcher_active());
}

/// 存储降级面:SQLite 落盘不可写时诚实降到内存库(tantivy 目录预建,
/// 本身可写,故只有 sqlite 走降级)。
#[test]
#[cfg(unix)]
fn store_degrades_to_memory_when_sqlite_dir_unwritable() {
    let fx = Fixture::new("memfb");
    std::fs::create_dir_all(fx.index_dir.join("tantivy")).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&fx.index_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let index = KnowledgeIndex::open_at(&fx.root, &fx.index_dir)
        .expect("memory fallback keeps the index usable");
    let mode = index.store().mode;
    // 先恢复权限再断言,保证 Drop 清理可用。
    std::fs::set_permissions(&fx.index_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(mode, "memory");
}

/// 扫描跳过面:超 1MB 大文件与不可读(mode 000)文件都不进扫描结果
/// (metadata/read 双拒绝臂)。
#[test]
#[cfg(unix)]
fn reconcile_skips_oversize_and_unreadable_files() {
    let fx = Fixture::new("skipscan");
    fx.write("docs/small.md", "# Small\n\n## Alpha\n\ntiny\n");
    std::fs::write(fx.root.join("docs/big.md"), vec![b'x'; 1_000_001]).unwrap();
    std::fs::write(fx.root.join("docs/locked.md"), "# Locked\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        fx.root.join("docs/locked.md"),
        std::fs::Permissions::from_mode(0o000),
    )
    .unwrap();
    let index = fx.index();
    let stats = index.reconcile();
    std::fs::set_permissions(
        fx.root.join("docs/locked.md"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert_eq!(
        stats.files_scanned, 1,
        "oversize + unreadable must both be skipped"
    );
    assert_eq!(stats.added, 1);
}

/// 查询路由面:空查询拒绝;显式 Exact 路由不走 Auto 判定。
#[test]
fn search_rejects_empty_query_and_honors_explicit_exact_route() {
    let fx = Fixture::new("routes");
    fx.write("docs/gw.md", "# Demo\n\n## Gateway\n\ntext\n");
    let index = fx.index();
    index.build();
    let err = index.search("   ", &opts(5)).unwrap_err();
    assert_eq!(err, "empty search query");
    let mut exact = opts(5);
    exact.route = Route::Exact;
    let out = index.search("Gateway", &exact).unwrap();
    assert_eq!(out["route"], "exact");
    assert_eq!(out["count"].as_u64().unwrap(), 1);
}

/// Exact 路由的 limit 早停:同名节点跨文件存在时按 limit 截断。
#[test]
fn exact_route_breaks_early_at_limit() {
    let fx = Fixture::new("limit");
    fx.write("docs/one.md", "# Demo\n\n## Shared\n\nfirst\n");
    fx.write("docs/two.md", "# Demo\n\n## Shared\n\nsecond\n");
    let index = fx.index();
    index.build();
    let mut wide = opts(10);
    wide.route = Route::Exact;
    let wide_out = index.search("Shared", &wide).unwrap();
    assert!(
        wide_out["count"].as_u64().unwrap() >= 2,
        "two same-name sections exist"
    );
    let mut exact = opts(1);
    exact.route = Route::Exact;
    let out = index.search("Shared", &exact).unwrap();
    assert_eq!(out["route"], "exact");
    assert_eq!(
        out["count"].as_u64().unwrap(),
        1,
        "limit=1 must truncate the exact-route loop early"
    );
}

/// BM25 路由命中面:fts 命中回表并携带 score。
#[test]
fn bm25_route_returns_scored_rows_from_fts_hits() {
    let fx = Fixture::new("bm25");
    fx.write(
        "docs/q.md",
        "# Demo\n\n## Notes\n\nquokka sparkle portal beacon\n",
    );
    let index = fx.index();
    index.build();
    let mut bm25 = opts(5);
    bm25.route = Route::Bm25;
    let out = index.search("quokka", &bm25).unwrap();
    assert_eq!(out["route"], "bm25");
    let matches = out["matches"].as_array().unwrap();
    assert!(!matches.is_empty(), "term hits must surface from fts");
    assert!(matches[0].get("score").is_some(), "bm25 rows carry a score");
}

/// 向量融合上限 + 后端离线诚实面:BM25 已占满 limit 时向量命中让位;
/// retrieve Err 不炸查询,configured/engine 仍如实。
#[test]
fn vector_merge_caps_at_limit_and_offline_backend_is_honest() {
    let fx = Fixture::new("vec-cap");
    fx.write("docs/nl.md", "# Demo\n\nquokka sparkle portal beacon\n");
    let index = fx.index();
    index.build();
    index.set_vector_retriever(Arc::new(StubRetriever {
        hits: vec![("never-relevant".to_string(), 9.9)],
    }));
    // NL 形态(≥4 词带空格)→ BM25 行已占满 limit=1,向量命中必须让位。
    let out = index
        .search("quokka sparkle portal beacon", &opts(1))
        .expect("capped vector merge");
    assert_eq!(out["vector"]["configured"], true);
    assert_eq!(out["count"].as_u64().unwrap(), 1);
    assert!(
        out["matches"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["id"] != "never-relevant"),
        "vector hit beyond the limit must not be merged"
    );

    #[derive(Debug)]
    struct OfflineRetriever;
    impl SemanticRetriever for OfflineRetriever {
        fn name(&self) -> &'static str {
            "offline-vector"
        }
        fn retrieve(&self, _q: &str, _l: usize) -> Result<Vec<(String, f32)>, String> {
            Err("backend offline".to_string())
        }
    }
    let fx2 = Fixture::new("vec-off");
    fx2.write("docs/nl.md", "# Demo\n\nquokka sparkle portal beacon\n");
    let index2 = fx2.index();
    index2.build();
    index2.set_vector_retriever(Arc::new(OfflineRetriever));
    let out2 = index2
        .search("quokka sparkle portal beacon", &opts(5))
        .expect("offline backend must not fail the search");
    assert_eq!(out2["vector"]["configured"], true);
    assert_eq!(out2["vector"]["engine"], "offline-vector");
}

/// get_dependencies 面:同名多种子排序路径 + 规则幻影目标如实上报
/// unindexed,绝不静默丢弃。
#[test]
fn get_dependencies_sorts_seeds_and_reports_unindexed_targets() {
    use kode_mcp::nodes::{node_id, IndexNode, NodeKind, Reference, Relation, SourceLocation};
    use kode_mcp::semantic_model::Confidence;

    fn ent(rel: &str, name: &str) -> IndexNode {
        IndexNode {
            id: node_id(&NodeKind::Entity, rel, name),
            project: "proj".to_string(),
            file_path: rel.to_string(),
            kind: NodeKind::Entity,
            name: name.to_string(),
            content: String::new(),
            location: SourceLocation::Lines { start: 1, end: 1 },
            content_hash: kode_mcp::nodes::content_hash(name.as_bytes()),
            confidence: Confidence::Unknown,
        }
    }

    let fx = Fixture::new("deps");
    let a = ent("scripts/entities/a/Dup.def", "Dup");
    let b = ent("scripts/entities/b/Dup.def", "Dup");
    let leaf = ent("scripts/entities/Leaf.def", "Leaf");
    let index = fx.index();
    index
        .store()
        .replace_file_nodes("scripts/entities/a/Dup.def", std::slice::from_ref(&a))
        .unwrap();
    index
        .store()
        .replace_file_nodes("scripts/entities/b/Dup.def", std::slice::from_ref(&b))
        .unwrap();
    index
        .store()
        .replace_file_nodes("scripts/entities/Leaf.def", std::slice::from_ref(&leaf))
        .unwrap();
    index
        .store()
        .replace_edges(&[
            Reference {
                source_node: a.id.clone(),
                target_node: leaf.id.clone(),
                relation: Relation::Calls,
                confidence: Confidence::Inferred,
                rule: "unit-test".to_string(),
            },
            Reference {
                source_node: a.id.clone(),
                target_node: "phantom-target".to_string(),
                relation: Relation::References,
                confidence: Confidence::Unknown,
                rule: "unit-test".to_string(),
            },
        ])
        .unwrap();
    let out = index.get_dependencies("Dup", 3, 50).unwrap();
    assert_eq!(out["seeds"].as_array().unwrap().len(), 2);
    assert_eq!(out["edgeCount"].as_u64().unwrap(), 2);
    let nodes = out["nodes"].as_array().unwrap();
    // 2 种子 + leaf + 幻影 = 4 行;幻影如实标 unindexed。
    assert_eq!(nodes.len(), 4);
    let phantom = nodes
        .iter()
        .find(|n| n.get("indexed") == Some(&serde_json::json!(false)))
        .expect("phantom target reported");
    assert_eq!(phantom["id"], "phantom-target");
    assert_eq!(phantom["note"], "rule target has no indexed node");
}

/// 存储面与 fts 面短暂失同步(store 侧撤档、fts 文档仍在)时,BM25 命中
/// 回表 miss 不炸查询,诚实返回空集。
#[test]
fn bm25_survives_store_fts_desync_with_honest_empty_set() {
    let fx = Fixture::new("desync");
    fx.write(
        "docs/q.md",
        "# Demo\n\n## Notes\n\nquokka sparkle portal beacon\n",
    );
    let index = fx.index();
    index.build();
    index.store().remove_file("docs/q.md").unwrap();
    let mut bm25 = opts(5);
    bm25.route = Route::Bm25;
    let out = index.search("quokka", &bm25).unwrap();
    assert_eq!(out["route"], "bm25");
    assert_eq!(
        out["count"].as_u64().unwrap(),
        0,
        "fts hit whose store node is gone must yield an honest empty set"
    );
}

/// store 落盘面:目标路径的父目录被同名文件占住时,KbStore::open 如实
/// 报错(错误携带目录路径),绝不 panic。
#[test]
fn kb_store_open_reports_blocked_parent_honestly() {
    use kode_mcp::store::KbStore;
    let base = std::env::temp_dir().join(format!("kode-mcp-store-err-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let blocker = base.join("blocker");
    std::fs::write(&blocker, "a file, not a directory").unwrap();
    let err = KbStore::open(&blocker.join("kb.sqlite"))
        .expect_err("parent occupied by a file must fail open");
    assert!(
        err.contains("index dir"),
        "error should name the dir creation failure: {err}"
    );
    std::fs::remove_dir_all(&base).ok();
}

/// sqlite 落盘面:目录只读时 Connection::open 失败必须如实上抛
/// (内存降级是 kb_index 装配面的职责,store 自身不静默换库)。
#[test]
#[cfg(unix)]
fn kb_store_open_reports_readonly_dir_honestly() {
    use kode_mcp::store::KbStore;
    let base = std::env::temp_dir().join(format!("kode-mcp-store-ro-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o500)).unwrap();
    let res = KbStore::open(&base.join("kb.sqlite"));
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
    let err = res.expect_err("sqlite cannot create a db file in a read-only dir");
    assert!(!err.is_empty());
    std::fs::remove_dir_all(&base).ok();
}

/// sqlite 落盘面:kb.sqlite 路径本身被目录占住时,Connection::open 立即
/// 失败(sqlite 首写惰性建库,只读目录推迟到 execute_batch;目录占位才是
/// open 当场报错的构造)。
#[test]
#[cfg(unix)]
fn kb_store_open_reports_dir_occupied_db_path_honestly() {
    use kode_mcp::store::KbStore;
    let base = std::env::temp_dir().join(format!("kode-mcp-store-dir-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("kb.sqlite")).unwrap();
    let err = KbStore::open(&base.join("kb.sqlite"))
        .expect_err("opening a directory as the db file must fail at once");
    assert!(!err.is_empty());
    std::fs::remove_dir_all(&base).ok();
}

/// index_status 存储面:nodes/edges/byFormat 计数、watcher/dirty 状态与
/// 内容寻址完整性(status() 首次驱动 stats+content_addressing_intact)。
#[test]
fn status_reports_storage_faces_and_content_addressing() {
    let fx = Fixture::new("status");
    fx.write("docs/net.md", "# Demo\n\n## Gateway\n\ntext\n");
    let index = fx.index();
    index.build();
    let status = index.status();
    assert!(status["nodes"].as_u64().unwrap() >= 1);
    assert_eq!(status["edges"].as_u64().unwrap(), 0);
    assert_eq!(status["storageMode"], "file");
    assert_eq!(status["watcherActive"], false);
    assert_eq!(status["dirtyPending"].as_u64().unwrap(), 0);
    assert_eq!(status["contentAddressingIntact"], true);
    assert!(status["lastReconcile"]["filesScanned"].as_u64().unwrap() >= 1);
    // build 后内容寻址完整:BLAKE3 全量对账通过。
    assert!(index.store().content_addressing_intact());
}

/// nodes_of_kinds 空清单守卫:空切片诚实返回空,不生成坏 SQL。
#[test]
fn nodes_of_kinds_empty_slice_is_empty() {
    let fx = Fixture::new("emptykinds");
    fx.write("docs/a.md", "# Demo\n");
    let index = fx.index();
    index.build();
    assert!(index.store().nodes_of_kinds(&[]).is_empty());
}
