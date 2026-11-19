//! WorkspaceSymbol 快速搜索 golden 重生成比对(RUST-139 批 2;Rust 侧真值;
//! TS 侧 tests/kodeWorkspaceSymbolsParity.test.ts 用 defParser 原语独立复算
//! 同一 golden,形成双向对拍,signature-help/references 同构)。

use kode_server::dump_workspace_symbols_golden;
use kode_server::workspace_symbols::WORKSPACE_SYMBOLS_GOLDEN_REL_PATH;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn workspace_symbols_golden_matches_regenerated_dump() {
    let regenerated = dump_workspace_symbols_golden(&repo_root());
    let golden_path = repo_root().join(WORKSPACE_SYMBOLS_GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/workspace-symbols-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "workspace symbols golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-workspace-symbols-golden -- . > crates/kode-server/tests/golden/workspace-symbols-parity.json"
        );
    }
    assert!(committed.contains("\"hitCount\":"));
    assert!(committed.contains("dump-workspace-symbols-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    #[allow(dead_code)]
    generator: String,
    root_count: usize,
    symbol_count: usize,
    probe_count: usize,
    hit_count: usize,
    universe_count: usize,
    probes: Vec<GoldenProbe>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenProbe {
    prefix: String,
    hits: Vec<GoldenHit>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenHit {
    symbol_name: String,
    kind: String,
    section: Option<String>,
    root_name: String,
    root_def_file: String,
    def_file: String,
    line: u32,
}

const SECTIONS: &[&str] = &["BaseMethods", "CellMethods", "ClientMethods"];

#[test]
fn workspace_symbols_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(repo_root().join(WORKSPACE_SYMBOLS_GOLDEN_REL_PATH))
        .expect("golden");
    let value: Dump = serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON");

    // 计数守恒:hitCount = 逐探针命中和;universeCount = 空前缀命中数;
    // symbolCount = 全集去重符号名数;root/probe 规模真分布。
    assert_eq!(
        value.hit_count,
        value.probes.iter().map(|p| p.hits.len()).sum::<usize>(),
        "hitCount 与逐探针和对账"
    );
    let universe_hits = &value
        .probes
        .iter()
        .find(|p| p.prefix.is_empty())
        .expect("空前缀探针在场")
        .hits;
    assert_eq!(
        universe_hits.len(),
        value.universe_count,
        "universeCount 与空前缀命中一致"
    );
    assert_eq!(
        universe_hits
            .iter()
            .map(|h| h.symbol_name.as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        value.symbol_count,
        "symbolCount 与全集去重符号名一致"
    );
    assert!(value.root_count > 1, "语料跨资产树多 root");
    assert!(value.symbol_count > 0 && value.universe_count > 0);

    // 探针序:前缀字节序(BTreeSet 派生);负例恒空(防全绿退化)。
    let mut sorted_prefixes = value
        .probes
        .iter()
        .map(|p| p.prefix.as_str())
        .collect::<Vec<_>>();
    sorted_prefixes.sort();
    let raw_prefixes = value
        .probes
        .iter()
        .map(|p| p.prefix.as_str())
        .collect::<Vec<_>>();
    assert_eq!(raw_prefixes.len(), value.probe_count);
    assert_eq!(sorted_prefixes, raw_prefixes, "探针按前缀字节序");
    for probe in &value.probes {
        let needle = probe.prefix.trim().to_lowercase();
        // 命中序:rootName → symbolName → line。
        for pair in probe.hits.windows(2) {
            let key_a = (
                pair[0].root_name.as_str(),
                pair[0].symbol_name.as_str(),
                pair[0].line,
            );
            let key_b = (
                pair[1].root_name.as_str(),
                pair[1].symbol_name.as_str(),
                pair[1].line,
            );
            assert!(key_a <= key_b, "命中序 violated: {key_a:?} !<= {key_b:?}");
        }
        for hit in &probe.hits {
            // 前缀过滤口径:符号名小写 startsWith(needle)。
            assert!(
                needle.is_empty() || hit.symbol_name.to_lowercase().starts_with(&needle),
                "前缀过滤 violated: prefix={} symbol={}",
                probe.prefix,
                hit.symbol_name
            );
            // 形面:kind 值域/段口径/声明落点与 root 都在语料 fixtures 内。
            match hit.kind.as_str() {
                "property" => assert!(hit.section.is_none(), "property 无段"),
                "method" => {
                    let section = hit.section.as_deref().expect("method 必带段");
                    assert!(SECTIONS.contains(&section), "段越界: {section}");
                }
                other => panic!("kind 越界: {other}"),
            }
            assert!(
                hit.root_def_file.ends_with(".def")
                    && hit.root_def_file.starts_with("tests/fixtures/"),
                "root 落点出语料: {}",
                hit.root_def_file
            );
            assert!(
                hit.def_file.ends_with(".def") && hit.def_file.starts_with("tests/fixtures/"),
                "声明落点出语料: {}",
                hit.def_file
            );
            assert!(hit.line >= 1, "行号 1-based");
            // root 恒实体 def:不落 interfaces/components 段。
            assert!(
                !hit.root_def_file.contains("/interfaces/")
                    && !hit.root_def_file.contains("/components/"),
                "root 恒实体 def: {}",
                hit.root_def_file
            );
        }
    }

    // 区分度真分布钉:接口折入命中、组件槽命中、父链折叠命中(声明落点
    // ≠ root 且非接口/组件段)必须在语料上真实在场——折叠面退化(恒只看
    // 本文件)会在此红。
    let any_interface = value
        .probes
        .iter()
        .any(|p| p.hits.iter().any(|h| h.def_file.contains("/interfaces/")));
    let any_component = value
        .probes
        .iter()
        .any(|p| p.hits.iter().any(|h| h.def_file.contains("/components/")));
    let any_parent_fold = value.probes.iter().any(|p| {
        p.hits.iter().any(|h| {
            h.def_file != h.root_def_file
                && !h.def_file.contains("/interfaces/")
                && !h.def_file.contains("/components/")
        })
    });
    assert!(any_interface, "语料上应有接口折入命中(真实继承面)");
    assert!(any_component, "语料上应有组件槽命中");
    assert!(any_parent_fold, "语料上应有父链折叠命中");
    // 负例真空:至少一个零命中探针在场。
    assert!(
        value.probes.iter().any(|p| p.hits.is_empty()),
        "负例探针应恒空"
    );
}
