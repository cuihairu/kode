//! completion 对拍 golden 重生成比对(Rust 侧真值;TS 侧
//! tests/kodeCompletionParity.test.ts 用现有 defParser/defChain 等原语复算同一
//! golden,形成双向对拍,PR-005/007/008/010 同构)。

use kode_server::dump_completion_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn completion_golden_matches_regenerated_dump() {
    let regenerated = dump_completion_golden(&repo_root());
    let golden_path = repo_root().join(kode_server::completion::GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/completion-parity.json");
    // 尾部换行由重定向/dump println! 引入,不参与比对
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "completion golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-completion-golden -- . > crates/kode-server/tests/golden/completion-parity.json\nRust 重生成:…{}",
            &regenerated[diff_at.saturating_sub(120)..(diff_at + 160).min(regenerated.len())],
        );
    }
    assert!(committed.contains("\"scenarioCount\":"));
    assert!(committed.contains("dump-completion-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    file_count: usize,
    scenario_count: usize,
    files: Vec<GoldenFile>,
}

#[derive(serde::Deserialize)]
struct GoldenFile {
    #[allow(dead_code)]
    file: String,
    #[allow(dead_code)]
    kind: String,
    scenarios: Vec<serde_json::Value>,
}

#[test]
fn completion_golden_structure_is_complete() {
    let committed =
        std::fs::read_to_string(repo_root().join(kode_server::completion::GOLDEN_REL_PATH))
            .expect("golden");
    let value: Dump =
        serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    assert!(
        value.file_count >= 25,
        "语料文件数异常: {}",
        value.file_count
    );
    assert_eq!(
        value.scenario_count,
        value.files.iter().map(|f| f.scenarios.len()).sum::<usize>(),
        "scenarioCount 与实际不符"
    );
    assert!(
        value.scenario_count >= 100,
        "场景数过少: {}",
        value.scenario_count
    );
    // 六面条目集在语料上至少各出现一次(实体/属性/方法分面/类型/继承成员;
    // 别名条目随语料属性式 alias.xml 恒 0,见 pr-011.md 语料偏差说明)。
    let all_items: Vec<&serde_json::Value> = value
        .files
        .iter()
        .flat_map(|f| f.scenarios.iter())
        .flat_map(|s| s["response"]["items"].as_array().unwrap().iter())
        .collect();
    for kind in ["entity", "property", "method", "type"] {
        let n = all_items.iter().filter(|i| i["kind"] == kind).count();
        assert!(n > 0, "条目面 {kind} 在语料上为空");
    }
    let sections: Vec<&str> = value
        .files
        .iter()
        .flat_map(|f| f.scenarios.iter())
        .map(|s| s["response"]["context"]["section"].as_str().unwrap())
        .collect();
    for section in [
        "Properties",
        "BaseMethods",
        "CellMethods",
        "ClientMethods",
        "Components",
        "Entity",
        "Types",
        "Entities",
    ] {
        assert!(
            sections.contains(&section),
            "上下文面 {section} 在语料上为空"
        );
    }
    // 继承成员面:至少一条带 inheritedFrom 的条目。
    let inherited = all_items
        .iter()
        .filter(|i| i["inheritedFrom"].is_string())
        .count();
    assert!(inherited > 0, "继承成员条目在语料上为空");
}
