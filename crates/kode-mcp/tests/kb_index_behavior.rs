//! kb_index 行为补测(2026-11-11 覆盖率批次:基线 llvm-cov 最低两模块
//! fts.rs 84.4% / kb_index.rs 88.0% 之一):向量 P3 seam 诚实面与融合、
//! watcher 注册幂等、kind 过滤轴。每条断言锁定真实行为——无 mock 索引、
//! 无凑数用例(与 kb_p2/kb_p4/kb_assets 同一口径)。

use std::path::PathBuf;
use std::sync::Arc;

use kode_mcp::kb_index::{KnowledgeIndex, SearchOptions, SemanticRetriever};

/// A throwaway assets root + index dir, unique per test (tag + pid), removed
/// on drop so parallel tests never collide or leak state. Same pattern as
/// kb_p2/kb_p4/kb_assets.
struct Fixture {
    root: PathBuf,
    index_dir: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Fixture {
        let root =
            std::env::temp_dir().join(format!("kode-mcp-kbb-{tag}-{}", std::process::id()));
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
    assert!(out["vector"]["deferred"]
        .as_str()
        .unwrap()
        .contains("P3"));
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
    assert_eq!(index.watcher_active(), false);
    assert_eq!(index.dirty_pending(), 0);

    index.start_watch().expect("first watch registration");
    assert_eq!(index.watcher_active(), true);
    assert_eq!(index.dirty_pending(), 0);

    // 第二次注册是幂等 no-op Ok(不重复挂 watcher、不报错)。
    index.start_watch().expect("second watch registration");
    assert_eq!(index.watcher_active(), true);
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
