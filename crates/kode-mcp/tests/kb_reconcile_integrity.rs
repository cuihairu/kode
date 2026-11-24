//! KODE-FULL-005..008:对账完整性回归(同文件四缺陷的收口验收)。
//!
//! - 007:提取/发布失败不提交内容哈希——下一轮按 changed 重试,旧代保留;
//! - 006:扫描截断/读失败是覆盖缺口,不是删除——已收录节点按路径确认后才逐出;
//! - 008:git 忽略资格集合同源(新文件跳过/变忽略显式逐出/模型重建同集合);
//! - 005:watcher 的 dirty 由后台 worker 消费,模型与结构/全文索引同代发布。
//!
//! 全部走真实文件系统与真实索引(无 mock 存储;与 kb_p2/kb_p4 同口径)。

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, RwLock};

use kode_mcp::kb::AssetKnowledge;
use kode_mcp::kb_index::{KnowledgeIndex, Route, SearchOptions};

/// A throwaway assets root + index dir, unique per test (tag + pid), removed
/// on drop (same pattern as kb_p2/kb_index_behavior).
struct Fixture {
    root: PathBuf,
    index_dir: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Fixture {
        let root = std::env::temp_dir().join(format!("kode-mcp-kbri-{tag}-{}", std::process::id()));
        let index_dir =
            std::env::temp_dir().join(format!("kode-mcp-kbri-idx-{tag}-{}", std::process::id()));
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

    /// `git init` + identity, so check-ignore answers inside the fixture.
    fn git_init(&self) {
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "t"],
        ] {
            let ok = Command::new("git")
                .arg("-C")
                .arg(&self.root)
                .args(&args)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            assert!(ok, "git {args:?} failed in fixture repo");
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
        let _ = std::fs::remove_dir_all(&self.index_dir);
    }
}

fn bm25_opts() -> SearchOptions {
    SearchOptions {
        limit: 10,
        route: Route::Bm25,
        ..Default::default()
    }
}

const NORMAL_DEF: &str = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
const SECRET_DEF: &str = "<root>\n\t<Properties>\n\t\t<gold>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</gold>\n\t</Properties>\n</root>\n";

/// KODE-FULL-007:已收录文件的新内容提取失败 → 哈希留在旧代(不得提交
/// 新哈希);修复后下一轮按 changed 重试并发布。旧口径下失败轮 set_file
/// (新哈希)会让第二轮 unchanged 跳过——错误永久遗留。
#[test]
fn failed_extraction_keeps_last_generation_for_retry() {
    let fx = Fixture::new("full007");
    fx.write("res/data.json", "{\"alpha\": 1}");
    let index = fx.index();
    index.reconcile();
    let old_hash = index.store().file_hashes()["res/data.json"].clone();

    // 已收录文件的新内容损坏:提取失败,哈希必须留在旧代。
    fx.write("res/data.json", "{ not json");
    let stats = index.reconcile();
    assert!(stats.extract_errors >= 1, "坏 JSON 必须如实报提取错");
    assert_eq!(
        index.store().file_hashes().get("res/data.json"),
        Some(&old_hash),
        "提取失败不得提交新哈希(否则下一轮误判 unchanged)"
    );

    // 修复为又一版合法内容:必须按 changed 重试并发布新代。
    fx.write("res/data.json", "{\"beta\": 2}");
    let stats = index.reconcile();
    assert_eq!(stats.extract_errors, 0, "{:?}", stats.errors);
    assert_eq!(stats.changed, 1, "修复后必须按 changed 重试(非 unchanged)");
    let new_hash = index.store().file_hashes()["res/data.json"].clone();
    assert_ne!(old_hash, new_hash, "发布成功后哈希推进到新代");
}

/// KODE-FULL-006:py 收集上限(5000/扩展)被打穿时,本轮扫描不是全集——
/// 已收录节点不得因「没扫到」被逐出;状态面如实报 coverageIncomplete。
/// 确认删除仍工作:路径真正消失(NotFound)后节点移除。
#[test]
fn scan_truncation_keeps_stored_nodes_and_reports_incomplete() {
    let fx = Fixture::new("full006");
    fx.write("scripts/zz_marker.py", "class Marker:\n    pass\n");
    let index = fx.index();
    index.build();
    assert!(
        !index.store().exact_lookup("Marker").is_empty(),
        "基线:marker 已收录"
    );

    // 5001 个洪水文件(a* 排序在 zz 前):py 收集必被 5000 上限截断。
    let scripts = fx.root.join("scripts");
    for i in 0..5001 {
        std::fs::write(scripts.join(format!("a{i:05}.py")), "x = 1\n").unwrap();
    }
    let stats = index.reconcile();
    assert!(stats.scan_truncated, "5002 个 py 候选必触发截断");
    assert_eq!(stats.removed, 0, "覆盖缺口轮不得逐出已收录节点");
    assert!(
        !index.store().exact_lookup("Marker").is_empty(),
        "旧节点在扫描缺口下保留"
    );
    let status = index.status();
    assert_eq!(
        status["lastReconcile"]["coverageIncomplete"],
        serde_json::json!(true),
        "状态面如实报覆盖不完整"
    );

    // 清场后确认删除路径:文件真消失(NotFound)→ 节点移除。
    std::fs::remove_dir_all(&scripts).unwrap();
    std::fs::create_dir_all(&scripts).unwrap();
    let stats = index.reconcile();
    assert!(stats.removed >= 1, "真实消失的文件必须逐出");
    assert!(
        index.store().exact_lookup("Marker").is_empty(),
        "确认删除后节点移除"
    );
}

/// KODE-FULL-008 场景 A:首轮就带 .gitignore——被忽略 def 不进索引、不进
/// 模型(exact/BM25/依赖面零泄漏),正常 def 完整收录。
#[test]
fn git_ignored_def_is_excluded_from_index_and_model_from_start() {
    let fx = Fixture::new("full008a");
    fx.git_init();
    fx.write(".gitignore", "scripts/entity_defs/Secret.def\n");
    fx.write("scripts/entity_defs/Normal.def", NORMAL_DEF);
    fx.write("scripts/entity_defs/Secret.def", SECRET_DEF);
    let index = fx.index();
    let stats = index.build();
    assert!(stats.git_available, "fixture 是 git 仓库");
    assert!(stats.ignored_by_git >= 1);
    assert!(
        !index.store().exact_lookup("Normal").is_empty(),
        "正常 def 收录"
    );
    assert!(
        index.store().exact_lookup("Secret").is_empty(),
        "被忽略 def 不得入结构索引"
    );
    assert!(
        !index
            .store()
            .file_hashes()
            .contains_key("scripts/entity_defs/Secret.def"),
        "被忽略 def 不得登记哈希"
    );
    let hit = index.search("Secret", &bm25_opts()).unwrap();
    let leaked: Vec<_> = hit["matches"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["file"] == serde_json::json!("scripts/entity_defs/Secret.def"))
        .collect();
    assert!(leaked.is_empty(), "BM25 不得回吐被忽略 def 的节点: {hit}");
    assert!(
        index.get_dependencies("Secret", 3, 32).is_err(),
        "依赖面对被忽略实体必须如实 not found"
    );
    // 模型面:load_filtered 与索引同源排除。
    let mut skip = std::collections::HashSet::new();
    skip.insert("scripts/entity_defs/Secret.def".to_string());
    let kb = AssetKnowledge::load_filtered(&fx.root, &skip);
    assert!(kb.defs.contains_key("Normal"));
    assert!(!kb.defs.contains_key("Secret"));
}

/// KODE-FULL-008 场景 B:先收录、后加 .gitignore——已收录变忽略必须显式
/// 逐出;同批正常 def 修改触发的模型批量重建不得把被忽略 def 写回。
#[test]
fn newly_ignored_def_is_evicted_and_not_reindexed_by_model_rebuild() {
    let fx = Fixture::new("full008b");
    fx.git_init();
    fx.write("scripts/entity_defs/Normal.def", NORMAL_DEF);
    fx.write("scripts/entity_defs/Secret.def", SECRET_DEF);
    let index = fx.index();
    index.build();
    assert!(
        !index.store().exact_lookup("Secret").is_empty(),
        "基线:Secret 已收录"
    );

    // 加忽略 + 同时改正常 def(触发模型整体重建——旧口径会把 Secret 写回)。
    fx.write(".gitignore", "scripts/entity_defs/Secret.def\n");
    fx.write(
        "scripts/entity_defs/Normal.def",
        &NORMAL_DEF.replace("UINT32", "INT64"),
    );
    let stats = index.reconcile();
    assert!(stats.removed >= 1, "已收录变忽略必须显式逐出");
    assert!(
        index.store().exact_lookup("Secret").is_empty(),
        "逐出后结构面无 Secret"
    );
    assert!(
        !index
            .store()
            .file_hashes()
            .contains_key("scripts/entity_defs/Secret.def"),
        "逐出后哈希面无 Secret"
    );
    assert!(
        !index.store().exact_lookup("Normal").is_empty(),
        "正常 def 修改后仍在索引"
    );
}

/// KODE-FULL-005:watcher 只记 dirty,后台 worker 消费——不重启 MCP,
/// 新 def 落盘后结构索引与挂接的模型缓存同代更新,dirty 归零。
#[test]
fn worker_consumes_dirty_and_publishes_model_same_generation() {
    let fx = Fixture::new("full005");
    fx.write("scripts/entity_defs/Normal.def", NORMAL_DEF);
    let index = Arc::new(fx.index());
    let cache = Arc::new(RwLock::new(AssetKnowledge::load(&fx.root)));
    index.attach_model_cache(Arc::clone(&cache));
    index.build();
    assert!(
        cache.read().unwrap().defs.contains_key("Normal"),
        "成功发布后模型缓存同代刷新"
    );
    index.start_watch().expect("inotify on temp dir");
    index.start_reconcile_worker();

    // 运行期新增 def:无重启、无手动 reconcile。
    fx.write("scripts/entity_defs/Later.def", NORMAL_DEF);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let indexed = !index.store().exact_lookup("Later").is_empty();
        let model_fresh = cache.read().unwrap().defs.contains_key("Later");
        if indexed && model_fresh && index.dirty_pending() == 0 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "worker 必须在有界时间内消费 dirty 并同代发布(30s); state={:?} dirty={} indexed={} model={}",
            index.status(),
            index.dirty_pending(),
            !index.store().exact_lookup("Later").is_empty(),
            cache.read().unwrap().defs.contains_key("Later")
        );
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    let status = index.status();
    assert_eq!(
        status["autoReconcile"]["active"],
        serde_json::json!(true),
        "{status}"
    );
}

#[test]
fn gitignore_change_alone_refreshes_the_index() {
    let fx = Fixture::new("watch-gitignore");
    fx.git_init();
    fx.write("scripts/entity_defs/Secret.def", SECRET_DEF);
    let index = Arc::new(fx.index());
    index.build();
    assert!(!index.store().exact_lookup("Secret").is_empty());
    index.start_watch().expect("watch fixture");
    index.start_reconcile_worker();

    let await_visibility = |expected: bool| {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let visible = !index.store().exact_lookup("Secret").is_empty();
            if visible == expected {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "{}", index.status());
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    };
    fx.write(".gitignore", "scripts/entity_defs/Secret.def\n");
    await_visibility(false);
    std::fs::remove_file(fx.root.join(".gitignore")).unwrap();
    await_visibility(true);
}
