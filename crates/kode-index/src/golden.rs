//! 对拍 golden 序列化(只写不读;TS 侧 `tests/kodeIndexParity.test.ts` 用现有
//! defParser 原语复算,双向门禁与 PR-005 同构)。
//!
//! golden 形状与 [`kode_index::symbol::extract_records`] 逐字段一致:
//! `{"generator","fileCount","symbolCount","files":[{"file","kind",
//!   "symbols":[{"name","kind","line","facet","detail"}]}]}`。
//! 任何一侧抽取语义变化都要重生成 golden 并让两侧门禁同时过。

use std::path::Path;

use kode_parser::dep::ParsedUnit;
use kode_parser::json::{collect_corpus, JsonWriter, PARITY_CORPORA};
use kode_parser::model::{parse_alias, parse_def, parse_entities, parse_types};
use kode_vfs::store::{DocumentKey, RootId};

use crate::symbol::{def_entity_name, extract_records};

/// 语料文件 → ParsedUnit(kind 字符串来自 collect_corpus)。
fn parse_by_kind(kind: &str, text: &str) -> Option<ParsedUnit> {
    match kind {
        "def" => Some(ParsedUnit::Def(parse_def(text))),
        "entities" => Some(ParsedUnit::Entities(parse_entities(text))),
        "types" => Some(ParsedUnit::Types(parse_types(text))),
        "alias" => Some(ParsedUnit::Alias(parse_alias(text))),
        _ => None,
    }
}

/// golden 文件名(仓库相对)。
pub const GOLDEN_REL_PATH: &str = "crates/kode-index/tests/golden/symbol-parity.json";

/// 整个语料的符号 golden JSON(与 TS 复算器逐字段一致)。
pub fn dump_symbols(repo_root: &Path) -> String {
    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let mut w = JsonWriter::new();
    w.raw("{\"generator\":\"kode-index dump-symbol-golden\",\"fileCount\":");
    w.num(files.len());
    let mut symbol_total = 0usize;
    // 先算总数(两遍遍历换取输出结构简单:总数在前)。
    for (path, (kind, text)) in &files {
        let Some(unit) = parse_by_kind(kind, text) else {
            continue;
        };
        let key = DocumentKey::new(
            RootId::UNROOTED,
            kode_vfs::uri::CanonicalUri::from_path(path),
        );
        let (records, _) = extract_records(&key, &unit);
        symbol_total += records.len();
    }
    w.raw(",\"symbolCount\":");
    w.num(symbol_total);
    w.raw(",\"files\":[");
    let mut first_file = true;
    for (path, (kind, text)) in &files {
        let Some(unit) = parse_by_kind(kind, text) else {
            continue;
        };
        let key = DocumentKey::new(
            RootId::UNROOTED,
            kode_vfs::uri::CanonicalUri::from_path(path),
        );
        let (records, _) = extract_records(&key, &unit);
        if !first_file {
            w.raw(",");
        }
        first_file = false;
        w.raw("{\"file\":");
        w.str(path);
        w.raw(",\"kind\":");
        w.str(kind);
        w.raw(",\"symbols\":[");
        for (i, r) in records.iter().enumerate() {
            if i > 0 {
                w.raw(",");
            }
            w.raw("{\"name\":");
            w.str(&r.name);
            w.raw(",\"kind\":");
            w.str(r.kind.as_str());
            w.raw(",\"line\":");
            w.num(r.line);
            w.raw(",\"facet\":");
            match r.facet {
                Some(f) => {
                    w.str(f.as_str());
                }
                None => {
                    w.raw("null");
                }
            }
            w.raw(",\"detail\":");
            match r.detail.as_deref() {
                Some(d) => {
                    w.str(d);
                }
                None => {
                    w.raw("null");
                }
            }
            w.raw("}");
        }
        w.raw("]}");
    }
    w.raw("]}");
    w.buf
}

/// 实体名帮助器的 re-export(测试用)。
pub fn entity_of_file(path: &str) -> Option<String> {
    def_entity_name(path)
}
