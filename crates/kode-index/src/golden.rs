//! Parity golden serialization (write-only; the TS side `tests/kodeIndexParity.test.ts`
//! recomputes with the existing defParser primitives, and the bidirectional gate is
//! isomorphic to PR-005).
//!
//! The golden shape matches [`kode_index::symbol::extract_records`] field by field:
//! `{"generator","fileCount","symbolCount","files":[{"file","kind",
//!   "symbols":[{"name","kind","line","facet","detail"}]}]}`.
//! Any change to the extraction semantics on either side must regenerate the golden
//! and make both sides' gates pass.

use std::path::Path;

use kode_parser::dep::ParsedUnit;
use kode_parser::json::{collect_corpus, JsonWriter, PARITY_CORPORA};
use kode_parser::model::{parse_alias, parse_def, parse_entities, parse_types};
use kode_vfs::store::{DocumentKey, RootId};

use crate::symbol::{def_entity_name, extract_records};

/// Corpus file -> ParsedUnit (kind strings come from collect_corpus, which only
/// produces def/entities/types/alias). An unknown kind is not a data shape but a
/// corpus-discovery surface contract breach -> fail-fast assertion surface; we never
/// silently drop files inside the production path.
fn parse_by_kind(kind: &str, text: &str) -> ParsedUnit {
    match kind {
        "def" => ParsedUnit::Def(parse_def(text)),
        "entities" => ParsedUnit::Entities(parse_entities(text)),
        "types" => ParsedUnit::Types(parse_types(text)),
        "alias" => ParsedUnit::Alias(parse_alias(text)),
        other => unreachable!("collect_corpus 只产四种 kind,遇到 {other:?} 即语料发现面契约失守"),
    }
}

/// golden file name (repo-relative).
pub const GOLDEN_REL_PATH: &str = "crates/kode-index/tests/golden/symbol-parity.json";

/// Symbol golden JSON for the entire corpus (field-for-field identical to the TS recomputer).
pub fn dump_symbols(repo_root: &Path) -> String {
    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let mut w = JsonWriter::new();
    w.raw("{\"generator\":\"kode-index dump-symbol-golden\",\"fileCount\":");
    w.num(files.len());
    let mut symbol_total = 0usize;
    // Count the total first (two passes trade for a simpler output shape: the total comes first).
    for (path, (kind, text)) in &files {
        let unit = parse_by_kind(kind, text);
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
        let unit = parse_by_kind(kind, text);
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

/// Re-export of the entity-name helper (for tests).
pub fn entity_of_file(path: &str) -> Option<String> {
    def_entity_name(path)
}

#[cfg(test)]
mod tests {
    use kode_parser::dep::ParsedUnit;

    use super::{entity_of_file, parse_by_kind};

    /// ParsedUnit -> stable tag (for test assertions; variant membership at a glance).
    fn unit_tag(unit: ParsedUnit) -> &'static str {
        match unit {
            ParsedUnit::Def(_) => "def",
            ParsedUnit::Entities(_) => "entities",
            ParsedUnit::Types(_) => "types",
            ParsedUnit::Alias(_) => "alias",
        }
    }

    /// kind dispatch surface: each of the four corpus kinds lands on its matching ParsedUnit.
    #[test]
    fn parse_by_kind_dispatches_all_corpus_kinds() {
        assert_eq!(unit_tag(parse_by_kind("def", "<root/>")), "def");
        assert_eq!(unit_tag(parse_by_kind("entities", "<root/>")), "entities");
        assert_eq!(unit_tag(parse_by_kind("types", "<root/>")), "types");
        assert_eq!(
            unit_tag(parse_by_kind("alias", "<root/>")),
            "alias",
            "alias kind 必须落 Alias 解析(语料含属性式 alias.xml)"
        );
    }

    /// An unknown kind is a corpus-discovery surface contract breach: fail fast, never
    /// silently drop the file.
    #[test]
    #[should_panic(expected = "语料发现面契约失守")]
    fn parse_by_kind_rejects_unknown_kind() {
        let _ = parse_by_kind("unknown-kind", "<root/>");
    }

    /// entity_of_file forwards to def_entity_name: takes the file stem; stem-less
    /// paths return None.
    #[test]
    fn entity_of_file_delegates_to_def_entity_name() {
        assert_eq!(
            entity_of_file("/x/entities/Avatar.def"),
            Some("Avatar".into())
        );
        assert_eq!(entity_of_file("Car.def"), Some("Car".into()));
        assert_eq!(entity_of_file(".."), None, "父目录引用无文件茎");
        assert_eq!(entity_of_file(""), None, "空路径无文件茎");
    }
}
