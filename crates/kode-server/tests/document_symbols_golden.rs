//! document symbols 对拍 golden 重生成比对(Rust 侧真值;TS 侧
//! tests/kodeDocumentSymbolsParity.test.ts 用现有 defParser 原语复算同一
//! golden,形成双向对拍,definition/references golden 同构)。

use kode_server::dump_document_symbols_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn document_symbols_golden_matches_regenerated_dump() {
    let regenerated = dump_document_symbols_golden(&repo_root());
    let golden_path =
        repo_root().join(kode_server::document_symbols::DOCUMENT_SYMBOLS_GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/document-symbols-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "document symbols golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-document-symbols-golden -- . > crates/kode-server/tests/golden/document-symbols-parity.json"
        );
    }
    assert!(committed.contains("\"symbolCount\":"));
    assert!(committed.contains("dump-document-symbols-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    #[allow(dead_code)]
    file_count: usize,
    symbol_count: usize,
    files: Vec<GoldenFile>,
}

#[derive(serde::Deserialize)]
struct GoldenFile {
    #[allow(dead_code)]
    file: String,
    symbols: Vec<serde_json::Value>,
}

#[test]
fn document_symbols_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(
        repo_root().join(kode_server::document_symbols::DOCUMENT_SYMBOLS_GOLDEN_REL_PATH),
    )
    .expect("golden");
    let value: Dump =
        serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    assert!(
        value.symbol_count > 0,
        "document symbols golden 为空:语料上应有符号"
    );
    let total: usize = value.files.iter().map(|f| count(&f.symbols)).sum();
    assert_eq!(total, value.symbol_count, "symbolCount 与逐文件和不一致");
    // 符号键形:name/kind/range/selectionRange/children(全跨度+选择跨度)。
    for file in &value.files {
        for symbol in &file.symbols {
            assert_symbol_shape(symbol);
        }
    }
}

fn count(symbols: &[serde_json::Value]) -> usize {
    symbols
        .iter()
        .map(|s| {
            1 + count(
                s["children"]
                    .as_array()
                    .map(|c| c.as_slice())
                    .unwrap_or(&[]),
            )
        })
        .sum()
}

fn assert_symbol_shape(symbol: &serde_json::Value) {
    assert!(symbol["name"].is_string(), "符号缺 name: {symbol}");
    assert!(symbol["detail"].is_string(), "符号缺 detail: {symbol}");
    assert!(
        symbol["range"]["start"]["line"].is_u64()
            && symbol["range"]["start"]["character"].is_u64()
            && symbol["range"]["end"]["line"].is_u64()
            && symbol["range"]["end"]["character"].is_u64(),
        "符号 range 键形不对: {symbol}"
    );
    assert!(
        symbol["selectionRange"]["start"]["line"].is_u64()
            && symbol["selectionRange"]["start"]["character"].is_u64(),
        "符号 selectionRange 键形不对: {symbol}"
    );
    assert!(
        symbol["children"].is_array(),
        "符号缺 children 数组: {symbol}"
    );
    for child in symbol["children"].as_array().expect("children") {
        assert_symbol_shape(child);
    }
}
