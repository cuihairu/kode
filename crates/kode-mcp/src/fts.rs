//! Tantivy BM25 full-text index over knowledge nodes (KODE-MCP-KB-002 P2,
//! design doc §2/§6): the default main text index for term queries.
//!
//! Tokenizers (design doc §6 "Chinese text is tokenized with a CJK-friendly
//! tokenizer; English/code symbols use a dedicated tokenizer"):
//! - `default` — word tokenizer + lowercaser (English/code identifiers).
//! - `cjk` — 1..2 n-gram (unigram+bigram), the standard CJK-friendly
//!   decomposition without a segmentation dictionary dependency.
//! - `trigram` — 3..3 n-gram over file paths for substring path search.
//!
//! Scoring is Tantivy's BM25; ranking ties fall back to (doc id), and the
//! caller applies a deterministic (score desc, kind rank, path) order.

use std::path::Path;

use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value as DocValue, STRING,
};
use tantivy::{Index, IndexReader, IndexWriter, TantivyDocument, Term};

use crate::nodes::IndexNode;

/// Tokenizer names registered on every open/create (the tokenizer manager is
/// not persisted in the index directory; it must be re-registered per open).
const TOK_DEFAULT: &str = "default";
const TOK_CJK: &str = "cjk";
const TOK_TRIGRAM: &str = "trigram";

/// Fields of the BM25 index.
#[derive(Debug, Clone, Copy)]
pub struct Fields {
    id: Field,
    kind: Field,
    format: Field,
    name: Field,
    file: Field,
    line: Field,
    text: Field,
    text_cjk: Field,
    path_tri: Field,
}

fn text_field_with(tokenizer: &str, stored: bool) -> TextOptions {
    let indexing = TextFieldIndexing::default()
        .set_tokenizer(tokenizer)
        .set_index_option(IndexRecordOption::WithFreqsAndPositions);
    let options = TextOptions::default().set_indexing_options(indexing);
    if stored {
        options.set_stored()
    } else {
        options
    }
}

fn register_tokenizers(index: &mut Index) {
    let manager = tantivy::tokenizer::TokenizerManager::default();
    manager.register(
        TOK_DEFAULT,
        tantivy::tokenizer::TextAnalyzer::builder(tantivy::tokenizer::SimpleTokenizer::default())
            .filter(tantivy::tokenizer::LowerCaser)
            .build(),
    );
    manager.register(
        TOK_CJK,
        tantivy::tokenizer::TextAnalyzer::builder(
            tantivy::tokenizer::NgramTokenizer::new(1, 2, false)
                .expect("cjk ngram 1..2 is a valid range"),
        )
        .filter(tantivy::tokenizer::LowerCaser)
        .build(),
    );
    manager.register(
        TOK_TRIGRAM,
        tantivy::tokenizer::TextAnalyzer::builder(
            tantivy::tokenizer::NgramTokenizer::new(3, 3, false)
                .expect("trigram 3..3 is a valid range"),
        )
        .filter(tantivy::tokenizer::LowerCaser)
        .build(),
    );
    index.set_tokenizers(manager);
}

fn build_schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();
    let id = builder.add_text_field("id", STRING | tantivy::schema::STORED);
    let kind = builder.add_text_field("kind", STRING | tantivy::schema::STORED);
    let format = builder.add_text_field("format", STRING | tantivy::schema::STORED);
    let name = builder.add_text_field("name", text_field_with(TOK_DEFAULT, true));
    let file = builder.add_text_field("file", STRING | tantivy::schema::STORED);
    let line = builder.add_u64_field("line", tantivy::schema::STORED);
    let text = builder.add_text_field("text", text_field_with(TOK_DEFAULT, false));
    let text_cjk = builder.add_text_field("text_cjk", text_field_with(TOK_CJK, false));
    let path_tri = builder.add_text_field("path_tri", text_field_with(TOK_TRIGRAM, false));
    let fields = Fields {
        id,
        kind,
        format,
        name,
        file,
        line,
        text,
        text_cjk,
        path_tri,
    };
    (builder.build(), fields)
}

fn node_document(node: &IndexNode, f: &Fields) -> TantivyDocument {
    let mut d = TantivyDocument::default();
    d.add_text(f.id, &node.id);
    d.add_text(f.kind, node.kind.as_str());
    d.add_text(f.format, node.kind.format());
    d.add_text(f.name, &node.name);
    d.add_text(f.file, &node.file_path);
    d.add_u64(f.line, node.location.start_line().unwrap_or(0) as u64);
    // BM25 body: name (repeated once for weight) + content.
    d.add_text(f.text, format!("{} {}", node.name, node.content));
    d.add_text(f.text_cjk, format!("{} {}", node.name, node.content));
    d.add_text(f.path_tri, &node.file_path);
    d
}

/// One BM25 hit (deterministic order applied by the caller).
#[derive(Debug, Clone)]
pub struct FtsHit {
    pub node_id: String,
    pub score: f32,
}

/// Tantivy-backed BM25 index. `commit` is behind a mutex because
/// `IndexWriter::commit` takes `&mut self`.
pub struct FtsIndex {
    index: Index,
    reader: IndexReader,
    writer: Mutex<IndexWriter<TantivyDocument>>,
    fields: Fields,
}

use std::sync::Mutex;

impl std::fmt::Debug for FtsIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FtsIndex")
            .field("open", &true)
            .finish_non_exhaustive()
    }
}

impl FtsIndex {
    /// Open (or create) the index directory. The tokenizer set is registered
    /// on every open because it is not persisted.
    pub fn open(dir: &Path) -> Result<FtsIndex, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let (schema, fields) = build_schema();
        let exists = dir.join("meta.json").exists();
        let mut index = if exists {
            Index::open_in_dir(dir).map_err(|e| e.to_string())?
        } else {
            Index::create_in_dir(dir, schema.clone()).map_err(|e| e.to_string())?
        };
        register_tokenizers(&mut index);
        let writer = index
            .writer(15_000_000) // 1 thread minimum arena (MEMORY_BUDGET_NUM_BYTES_MIN)
            .map_err(|e| e.to_string())?;
        let reader = index.reader().map_err(|e| e.to_string())?;
        Ok(FtsIndex {
            index,
            reader,
            writer: Mutex::new(writer),
            fields,
        })
    }

    /// Open in a throwaway temp directory (unit/integration tests; tantivy
    /// has no directory-free RAM mode, so this is a private temp dir).
    pub fn open_in_memory() -> Result<FtsIndex, String> {
        let (schema, fields) = build_schema();
        let dir = std::env::temp_dir().join(format!(
            "kode-mcp-fts-mem-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut index = Index::create_in_dir(&dir, schema).map_err(|e| e_string(&e))?;
        register_tokenizers(&mut index);
        let writer = index.writer(15_000_000).map_err(|e| e_string(&e))?;
        let reader = index.reader().map_err(|e| e_string(&e))?;
        Ok(FtsIndex {
            index,
            reader,
            writer: Mutex::new(writer),
            fields,
        })
    }

    /// Replace the full-text documents of one file's nodes and commit.
    pub fn replace_file(&self, file_path: &str, nodes: &[IndexNode]) -> Result<(), String> {
        let f = &self.fields;
        let mut writer = self.writer.lock().expect("fts writer lock");
        writer.delete_term(Term::from_field_text(f.file, file_path));
        for node in nodes {
            writer
                .add_document(node_document(node, f))
                .map_err(|e| e_string(&e))?;
        }
        writer.commit().map_err(|e| e_string(&e))?;
        self.reader.reload().map_err(|e| e_string(&e))?;
        Ok(())
    }

    /// Drop every document of one file and commit (file deleted on disk).
    pub fn remove_file(&self, file_path: &str) -> Result<(), String> {
        let mut writer = self.writer.lock().expect("fts writer lock");
        writer.delete_term(Term::from_field_text(self.fields.file, file_path));
        writer.commit().map_err(|e| e_string(&e))?;
        self.reader.reload().map_err(|e| e_string(&e))?;
        Ok(())
    }

    /// Number of live documents (index_status face).
    pub fn doc_count(&self) -> usize {
        self.reader.searcher().num_docs() as usize
    }

    /// BM25 search over (name, text, text_cjk, path trigrams). Deterministic:
    /// score desc, then kind rank, then file path, then node id.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<(String, f32)>, String> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let f = self.fields;
        let mut parser =
            QueryParser::for_index(&self.index, vec![f.name, f.text, f.text_cjk, f.path_tri]);
        parser.set_conjunction_by_default();
        parser.set_field_boost(f.name, 3.0);
        parser.set_field_boost(f.path_tri, 0.5);
        let parsed = match parser.parse_query(query.trim()) {
            Ok(q) => q,
            // Odd user syntax (quotes, ranges, field terms) → fall back to a
            // plain conjunction of the analyzed terms, never an error surface.
            Err(_) => self.term_conjunction(query.trim()),
        };
        let searcher = self.reader.searcher();
        let top = searcher
            .search(&parsed, &TopDocs::with_limit(limit.max(1)).order_by_score())
            .map_err(|e| e_string(&e))?;
        let mut out = Vec::new();
        for (score, addr) in top {
            let Ok(found) = searcher.doc::<TantivyDocument>(addr) else {
                continue;
            };
            let Some(id) = found.get_first(f.id).and_then(|v| v.as_str()) else {
                continue;
            };
            out.push((id.to_string(), score));
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    /// Fallback query: conjunction over `default`-tokenized terms.
    fn term_conjunction(&self, query: &str) -> Box<dyn tantivy::query::Query> {
        use tantivy::query::{BooleanQuery, TermQuery};
        use tantivy::schema::IndexRecordOption;
        let mut analyzer = self
            .index
            .tokenizers()
            .get(TOK_DEFAULT)
            .expect("default tokenizer registered");
        let mut stream = analyzer.token_stream(query);
        let mut terms = Vec::new();
        while stream.advance() {
            let token = stream.token().clone();
            terms.push(Term::from_field_text(self.fields.text, &token.text));
        }
        if terms.is_empty() {
            // Unmatchable (e.g. pure punctuation): empty conjunction.
            terms.push(Term::from_field_text(self.fields.text, "\u{0}nope"));
        }
        Box::new(BooleanQuery::new(
            terms
                .into_iter()
                .map(|t| {
                    (
                        tantivy::query::Occur::Must,
                        Box::new(TermQuery::new(t, IndexRecordOption::Basic))
                            as Box<dyn tantivy::query::Query>,
                    )
                })
                .collect(),
        ))
    }
}

fn e_string(e: &dyn std::fmt::Display) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nodes::{content_hash, NodeKind, SourceLocation};
    use crate::semantic_model::Confidence;

    fn node(id: &str, file: &str, name: &str, content: &str) -> IndexNode {
        IndexNode {
            id: id.to_string(),
            project: "proj".to_string(),
            file_path: file.to_string(),
            kind: NodeKind::Section,
            name: name.to_string(),
            content: content.to_string(),
            location: SourceLocation::Lines { start: 1, end: 2 },
            content_hash: content_hash(content.as_bytes()),
            confidence: Confidence::Inferred,
        }
    }

    #[test]
    fn bm25_finds_known_term() {
        let fts = FtsIndex::open_in_memory().unwrap();
        fts.replace_file(
            "docs/net.md",
            &[node(
                "section:docs/net.md:Login",
                "docs/net.md",
                "Login",
                "weapon login flow over UDP gateway",
            )],
        )
        .unwrap();
        fts.replace_file(
            "docs/db.md",
            &[node(
                "section:docs/db.md:Store",
                "docs/db.md",
                "Store",
                "database archival strategy",
            )],
        )
        .unwrap();
        let hits = fts.search("weapon", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "section:docs/net.md:Login");
        assert!(hits[0].1 > 0.0);
    }

    #[test]
    fn bm25_ranks_relevant_doc_first() {
        let fts = FtsIndex::open_in_memory().unwrap();
        fts.replace_file(
            "docs/a.md",
            &[node("s:a", "docs/a.md", "Misc", "teleport handling notes")],
        )
        .unwrap();
        fts.replace_file(
            "docs/b.md",
            &[node(
                "s:b",
                "docs/b.md",
                "Teleport",
                "teleport teleport teleport cooldown rules",
            )],
        )
        .unwrap();
        let hits = fts.search("teleport", 10).unwrap();
        assert!(hits.len() >= 2);
        assert_eq!(hits[0].0, "s:b", "denser term doc should rank first");
        assert!(hits[0].1 > hits[1].1);
    }

    #[test]
    fn cjk_term_finds_chinese_content() {
        let fts = FtsIndex::open_in_memory().unwrap();
        fts.replace_file(
            "docs/net.md",
            &[node(
                "s:net",
                "docs/net.md",
                "网络",
                "客户端登录流程说明与网关转发",
            )],
        )
        .unwrap();
        fts.replace_file(
            "docs/db.md",
            &[node("s:db", "docs/db.md", "数据库", "存档周期与备份策略")],
        )
        .unwrap();
        let hits = fts.search("登录", 10).unwrap();
        assert_eq!(hits.len(), 1, "bigram must not leak into unrelated docs");
        assert_eq!(hits[0].0, "s:net");
        // Single CJK char works through the unigram tier.
        let hits = fts.search("存", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "s:db");
    }

    #[test]
    fn path_trigram_supports_substring_path_search() {
        let fts = FtsIndex::open_in_memory().unwrap();
        fts.replace_file(
            "scripts/base/account.py",
            &[node(
                "s:acc",
                "scripts/base/account.py",
                "Account",
                "account entity logic",
            )],
        )
        .unwrap();
        fts.replace_file(
            "scripts/cell/monster.py",
            &[node(
                "s:mon",
                "scripts/cell/monster.py",
                "Monster",
                "cell logic",
            )],
        )
        .unwrap();
        let hits = fts.search("base/account", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "s:acc");
    }

    #[test]
    fn replace_file_swaps_documents() {
        let fts = FtsIndex::open_in_memory().unwrap();
        fts.replace_file("a.md", &[node("s:a1", "a.md", "Old", "quantum widget")])
            .unwrap();
        assert_eq!(fts.search("quantum", 10).unwrap().len(), 1);
        // Rewrite the file without that term: old doc must be gone.
        fts.replace_file("a.md", &[node("s:a2", "a.md", "New", "chain widget")])
            .unwrap();
        assert!(fts.search("quantum", 10).unwrap().is_empty());
        assert_eq!(fts.search("chain", 10).unwrap().len(), 1);
        assert_eq!(fts.doc_count(), 1);
        // Removing the file clears the index.
        fts.remove_file("a.md").unwrap();
        assert_eq!(fts.doc_count(), 0);
    }

    #[test]
    fn odd_syntax_falls_back_to_term_conjunction() {
        let fts = FtsIndex::open_in_memory().unwrap();
        fts.replace_file("a.md", &[node("s:a", "a.md", "T", "gateway login retries")])
            .unwrap();
        // `field:` syntax + quotes would fail strict parsing → conjunction.
        let hits = fts.search("gateway \"login\"", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "s:a");
        // Pure punctuation → no terms → honest empty.
        assert!(fts.search("!!!", 10).unwrap().is_empty());
        assert!(fts.search("  ", 10).unwrap().is_empty());
    }

    #[test]
    fn persistent_dir_reopens_with_tokenizers() {
        let dir = std::env::temp_dir().join(format!("kode-mcp-fts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        {
            let fts = FtsIndex::open(&dir).unwrap();
            fts.replace_file(
                "d.md",
                &[node("s:d", "d.md", "Battle", "damage formula 防御")],
            )
            .unwrap();
        }
        // Reopen: tokenizers re-registered, stored docs still searchable.
        let fts = FtsIndex::open(&dir).unwrap();
        let en = fts.search("battle", 10).unwrap();
        assert_eq!(en.len(), 1);
        let zh = fts.search("防御", 10).unwrap();
        assert_eq!(zh.len(), 1);
        assert_eq!(fts.doc_count(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn open_on_a_file_path_is_an_honest_error() {
        // open 的首个动作是 create_dir_all:路径被同名文件占住时必须报错
        // (错误携带路径)而不是 panic/静默——MCP 启动面依赖这个诚实错误。
        let base =
            std::env::temp_dir().join(format!("kode-mcp-fts-open-err-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let occupied = base.join("occupied");
        std::fs::write(&occupied, "a file, not a directory").unwrap();
        let err = FtsIndex::open(&occupied).expect_err("opening a file path must fail");
        assert!(
            err.contains(&occupied.to_string_lossy().to_string()),
            "error should carry the offending path: {err}"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn limit_zero_and_oversized_limits_still_answer() {
        let fts = FtsIndex::open_in_memory().unwrap();
        fts.replace_file(
            "a.md",
            &[
                node("s:a", "a.md", "Alpha", "sigma delta sigma"),
                node("s:b", "a.md", "Beta", "sigma gamma"),
            ],
        )
        .unwrap();
        // limit 0 按契约收敛为至少搜 1 条(limit.max(1)):不报错、不挂起。
        let hits = fts.search("sigma", 0).unwrap();
        assert_eq!(hits.len(), 1, "limit 0 answers exactly one hit");
        assert_eq!(fts.search("sigma", 1).unwrap().len(), 1);
        // 超出语料规模的 limit 如实返回全量,不是错误。
        assert_eq!(fts.search("sigma", 100).unwrap().len(), 2);
    }

    #[test]
    fn name_match_outranks_content_only_match() {
        let fts = FtsIndex::open_in_memory().unwrap();
        // 同词频(各 1 次)同语料规模:name 命中(name 字段 3.0 boost)必须排在
        // 仅正文命中的前面——字段加权是搜索排序的设计决策,锁死。
        fts.replace_file(
            "a.md",
            &[node("s:a", "a.md", "Gateway", "other words here")],
        )
        .unwrap();
        fts.replace_file(
            "b.md",
            &[node("s:b", "b.md", "Router", "a gateway appears here")],
        )
        .unwrap();
        let hits = fts.search("gateway", 10).unwrap();
        assert_eq!(hits.len(), 2, "both docs contain the term once");
        assert_eq!(hits[0].0, "s:a", "name-boosted doc must rank first");
        assert!(hits[0].1 > hits[1].1);
    }
}
