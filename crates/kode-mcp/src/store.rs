//! SQLite storage for the knowledge index (KODE-MCP-KB-002 P2, design doc
//! §6): nodes, edges, and per-file BLAKE3 hashes survive process restarts
//! and reopens. rusqlite with the bundled SQLite (no system dependency).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;

use crate::nodes::{content_hash, IndexNode, NodeKind, Reference, Relation, SourceLocation};
use crate::semantic_model::Confidence;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS files (
    path   TEXT PRIMARY KEY,
    blake3 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
    id           TEXT PRIMARY KEY,
    project      TEXT NOT NULL,
    file_path    TEXT NOT NULL,
    kind         TEXT NOT NULL,
    name         TEXT NOT NULL,
    content      TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    confidence   TEXT NOT NULL,
    loc_kind     TEXT NOT NULL,
    loc_start    INTEGER,
    loc_end      INTEGER,
    loc_sheet    TEXT,
    loc_range    TEXT,
    loc_xml_path TEXT,
    loc_line     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS edges (
    source_node TEXT NOT NULL,
    target_node TEXT NOT NULL,
    relation    TEXT NOT NULL,
    confidence  TEXT NOT NULL,
    rule        TEXT NOT NULL,
    PRIMARY KEY (source_node, target_node, relation, rule)
);
";

/// Persistent index storage. The connection is mutex-guarded because the MCP
/// server hands `&self` out to concurrent requests.
#[derive(Debug)]
pub struct KbStore {
    conn: Mutex<Connection>,
    /// Where the database lives (reported by index_status).
    pub path: PathBuf,
    /// "file" (persistent) or "memory" (fallback when the tree is read-only).
    pub mode: &'static str,
}

fn row_to_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexNode> {
    let kind_str: String = row.get(3)?;
    let kind = NodeKind::from_kind_str(&kind_str).unwrap_or(NodeKind::XmlElement);
    let loc_kind: String = row.get(8)?;
    let location = match loc_kind.as_str() {
        "excel" => SourceLocation::Excel {
            sheet: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
            range: row.get::<_, Option<String>>(12)?.unwrap_or_default(),
        },
        "xml" => SourceLocation::Xml {
            path: row.get::<_, Option<String>>(13)?.unwrap_or_default(),
            line: row.get::<_, Option<i64>>(14)?.unwrap_or(0) as usize,
        },
        _ => SourceLocation::Lines {
            start: row.get::<_, Option<i64>>(9)?.unwrap_or(0) as usize,
            end: row.get::<_, Option<i64>>(10)?.unwrap_or(0) as usize,
        },
    };
    let confidence = match row.get::<_, String>(7)?.as_str() {
        "determined" => Confidence::Determined,
        "inferred" => Confidence::Inferred,
        _ => Confidence::Unknown,
    };
    Ok(IndexNode {
        id: row.get(0)?,
        project: row.get(1)?,
        file_path: row.get(2)?,
        kind,
        name: row.get(4)?,
        content: row.get(5)?,
        content_hash: row.get(6)?,
        location,
        confidence,
    })
}

const NODE_COLS: &str = "id, project, file_path, kind, name, content, content_hash, confidence, \
     loc_kind, loc_start, loc_end, loc_sheet, loc_range, loc_xml_path, loc_line";

impl KbStore {
    /// Open (creating if needed) a persistent store at `path`.
    pub fn open(path: &Path) -> Result<KbStore, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("index dir {}: {e}", parent.display()))?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        // WAL + NORMAL: durable enough for an index cache, fast for bulk rewrites.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        Ok(KbStore {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
            mode: "file",
        })
    }

    /// In-memory fallback (read-only trees): same schema, honest `memory` mode.
    pub fn in_memory() -> Result<KbStore, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(KbStore {
            conn: Mutex::new(conn),
            path: PathBuf::from(":memory:"),
            mode: "memory",
        })
    }

    /// All stored file hashes (path → blake3), the diff basis for
    /// incremental updates.
    pub fn file_hashes(&self) -> HashMap<String, String> {
        let conn = self.conn.lock().expect("store lock");
        let mut stmt = match conn.prepare("SELECT path, blake3 FROM files") {
            Ok(s) => s,
            Err(_) => return HashMap::new(),
        };
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>());
        rows.unwrap_or_default().into_iter().collect()
    }

    /// Record one indexed file's content hash.
    pub fn set_file(&self, path: &str, hash: &str) -> Result<(), String> {
        let conn = self.conn.lock().expect("store lock");
        conn.execute(
            "INSERT INTO files(path, blake3) VALUES(?1, ?2)
             ON CONFLICT(path) DO UPDATE SET blake3 = excluded.blake3",
            [path, hash],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Forget a file (deleted from disk): its hash row and all its nodes.
    pub fn remove_file(&self, path: &str) -> Result<(), String> {
        let conn = self.conn.lock().expect("store lock");
        conn.execute("DELETE FROM files WHERE path = ?1", [path])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM nodes WHERE file_path = ?1", [path])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Atomically replace all nodes of one file (re-extraction result).
    pub fn replace_file_nodes(&self, path: &str, nodes: &[IndexNode]) -> Result<(), String> {
        let conn = self.conn.lock().expect("store lock");
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM nodes WHERE file_path = ?1", [path])
            .map_err(|e| e.to_string())?;
        for n in nodes {
            let (loc_kind, start, end, sheet, range, xml_path, line) = match &n.location {
                SourceLocation::Lines { start, end } => (
                    "lines",
                    Some(*start as i64),
                    Some(*end as i64),
                    None,
                    None,
                    None,
                    None,
                ),
                SourceLocation::Excel { sheet, range } => (
                    "excel",
                    None,
                    None,
                    Some(sheet.as_str()),
                    Some(range.as_str()),
                    None,
                    None,
                ),
                SourceLocation::Xml { path: p, line } => (
                    "xml",
                    None,
                    None,
                    None,
                    None,
                    Some(p.as_str()),
                    Some(*line as i64),
                ),
            };
            tx.execute(
                "INSERT OR REPLACE INTO nodes(id, project, file_path, kind, name, content, \
                 content_hash, confidence, loc_kind, loc_start, loc_end, loc_sheet, loc_range, \
                 loc_xml_path, loc_line)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                rusqlite::params![
                    n.id,
                    n.project,
                    n.file_path,
                    n.kind.as_str(),
                    n.name,
                    n.content,
                    n.content_hash,
                    n.confidence.as_str(),
                    loc_kind,
                    start,
                    end,
                    sheet,
                    range,
                    xml_path,
                    line,
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Replace the whole edge set (rebuilt per reconcile from parsed data).
    pub fn replace_edges(&self, edges: &[crate::nodes::Reference]) -> Result<(), String> {
        let conn = self.conn.lock().expect("store lock");
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM edges", [])
            .map_err(|e| e.to_string())?;
        for e in edges {
            tx.execute(
                "INSERT OR IGNORE INTO edges(source_node, target_node, relation, confidence, rule)
                 VALUES(?1,?2,?3,?4,?5)",
                rusqlite::params![
                    e.source_node,
                    e.target_node,
                    e.relation.as_str(),
                    e.confidence.as_str(),
                    e.rule,
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Exact-name lookup (case-insensitive), the structure-index route.
    /// Deterministic order is applied by the caller (kind rank, then path).
    pub fn exact_lookup(&self, name: &str) -> Vec<IndexNode> {
        let conn = self.conn.lock().expect("store lock");
        let mut stmt = match conn.prepare(&format!(
            "SELECT {NODE_COLS} FROM nodes WHERE name = ?1 COLLATE NOCASE"
        )) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([name], row_to_node)
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
            .unwrap_or_default()
    }

    /// Node by exact id (read_node-style precise access over stored nodes).
    pub fn node_by_id(&self, id: &str) -> Option<IndexNode> {
        let conn = self.conn.lock().expect("store lock");
        let mut stmt = conn
            .prepare(&format!("SELECT {NODE_COLS} FROM nodes WHERE id = ?1"))
            .ok()?;
        stmt.query_row([id], row_to_node).ok()
    }

    /// Counts for index_status: nodes per format + totals.
    pub fn stats(&self) -> (usize, usize, HashMap<String, usize>) {
        let conn = self.conn.lock().expect("store lock");
        let nodes = conn
            .query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0) as usize;
        let edges = conn
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0) as usize;
        let mut by_format = HashMap::new();
        if let Ok(mut stmt) = conn.prepare("SELECT kind, COUNT(*) FROM nodes GROUP BY kind") {
            if let Ok(rows) =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            {
                for row in rows.flatten() {
                    if let Some(kind) = NodeKind::from_kind_str(&row.0) {
                        *by_format.entry(kind.format().to_string()).or_insert(0usize) +=
                            row.1 as usize;
                    }
                }
            }
        }
        (nodes, edges, by_format)
    }

    /// Integrity self-check: every node content_hash still matches its
    /// content (content addressing holds after round-trips).
    pub fn content_addressing_intact(&self) -> bool {
        let conn = self.conn.lock().expect("store lock");
        let mut stmt = match conn.prepare("SELECT content, content_hash FROM nodes") {
            Ok(s) => s,
            Err(_) => return false,
        };
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>());
        match rows {
            Ok(rows) => rows
                .iter()
                .all(|(content, hash)| content_hash(content.as_bytes()) == *hash),
            Err(_) => false,
        }
    }
}

/// Convert a [`crate::semantic_model`] edge row into a stored [`Reference`].
/// Kept here so the semantic model's edge vocabulary is the single source.
pub fn semantic_edge(
    from: &str,
    to: &str,
    relation: &str,
    rule: &str,
    confidence: Confidence,
) -> Reference {
    Reference {
        source_node: from.to_string(),
        target_node: to.to_string(),
        relation: match relation {
            "defines" => Relation::Defines,
            "imports" => Relation::Imports,
            "contains" => Relation::Contains,
            "configures" => Relation::Configures,
            "calls" => Relation::Calls,
            _ => Relation::References,
        },
        confidence,
        rule: rule.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, file: &str, name: &str, content: &str) -> IndexNode {
        IndexNode {
            id: id.to_string(),
            project: "proj".to_string(),
            file_path: file.to_string(),
            kind: NodeKind::Section,
            name: name.to_string(),
            content: content.to_string(),
            location: SourceLocation::Lines { start: 1, end: 3 },
            content_hash: content_hash(content.as_bytes()),
            confidence: Confidence::Inferred,
        }
    }

    #[test]
    fn store_survives_reopen() {
        let dir = std::env::temp_dir().join(format!("kode-mcp-store-{}", std::process::id()));
        let db = dir.join("kb.sqlite");
        std::fs::create_dir_all(&dir).unwrap();
        {
            let store = KbStore::open(&db).unwrap();
            store
                .replace_file_nodes(
                    "docs/design.md",
                    &[node(
                        "section:docs/design.md:Net",
                        "docs/design.md",
                        "Net",
                        "network layer",
                    )],
                )
                .unwrap();
            store.set_file("docs/design.md", "abc").unwrap();
        }
        // Reopen from disk: node + file hash survive.
        let reopened = KbStore::open(&db).unwrap();
        let found = reopened.exact_lookup("net");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "section:docs/design.md:Net");
        assert_eq!(found[0].content, "network layer");
        assert_eq!(
            reopened
                .file_hashes()
                .get("docs/design.md")
                .map(|s| s.as_str()),
            Some("abc")
        );
        assert!(reopened.content_addressing_intact());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn replace_file_nodes_swaps_content_atomically() {
        let store = KbStore::in_memory().unwrap();
        let path = "a.md";
        store
            .replace_file_nodes(path, &[node("section:a.md:one", path, "one", "v1")])
            .unwrap();
        // Second version of the same file: old node gone, new node present.
        store
            .replace_file_nodes(path, &[node("section:a.md:two", path, "two", "v2")])
            .unwrap();
        assert!(store.exact_lookup("one").is_empty());
        assert_eq!(store.exact_lookup("two").len(), 1);
        let (nodes, edges, _) = store.stats();
        assert_eq!(nodes, 1);
        assert_eq!(edges, 0);
    }

    #[test]
    fn remove_file_drops_hash_and_nodes() {
        let store = KbStore::in_memory().unwrap();
        store
            .replace_file_nodes("gone.md", &[node("section:gone.md:x", "gone.md", "x", "c")])
            .unwrap();
        store.set_file("gone.md", "h1").unwrap();
        store.remove_file("gone.md").unwrap();
        assert!(store.exact_lookup("x").is_empty());
        assert!(store.file_hashes().is_empty());
    }

    #[test]
    fn edges_replace_and_stats_count() {
        let store = KbStore::in_memory().unwrap();
        let edges = vec![
            semantic_edge(
                "def:A.p",
                "types:T",
                "references",
                "type-ref",
                Confidence::Inferred,
            ),
            semantic_edge(
                "types:T",
                "py:Impl",
                "implements",
                "implementedBy",
                Confidence::Inferred,
            ),
        ];
        store.replace_edges(&edges).unwrap();
        let (nodes, edges_n, _) = store.stats();
        assert_eq!(nodes, 0);
        assert_eq!(edges_n, 2);
        // Replace with fewer: old edges gone, not appended.
        store.replace_edges(&edges[..1]).unwrap();
        let (_, edges_n, _) = store.stats();
        assert_eq!(edges_n, 1);
    }

    #[test]
    fn exact_lookup_is_case_insensitive_by_name_not_substring() {
        let store = KbStore::in_memory().unwrap();
        store
            .replace_file_nodes(
                "scripts/entity_defs/Avatar.def",
                &[
                    node(
                        "entity-property:scripts/entity_defs/Avatar.def:Avatar.level",
                        "scripts/entity_defs/Avatar.def",
                        "Avatar.level",
                        "level UINT32",
                    ),
                    node(
                        "entity:scripts/entity_defs/Avatar.def:Avatar",
                        "scripts/entity_defs/Avatar.def",
                        "Avatar",
                        "avatar entity",
                    ),
                ],
            )
            .unwrap();
        assert_eq!(store.exact_lookup("avatar").len(), 1);
        assert_eq!(store.exact_lookup("AVATAR.LEVEL").len(), 1);
        // Substring is not a hit (that is BM25's job).
        assert!(store.exact_lookup("ava").is_empty());
    }

    #[test]
    fn node_by_id_roundtrips_excel_and_xml_locations() {
        let store = KbStore::in_memory().unwrap();
        let excel = IndexNode {
            id: "excel-sheet:tables/items.xlsx:Items".into(),
            project: "proj".into(),
            file_path: "tables/items.xlsx".into(),
            kind: NodeKind::ExcelSheet,
            name: "Items".into(),
            content: "sheet Items".into(),
            location: SourceLocation::Excel {
                sheet: "Items".into(),
                range: "A1:C3".into(),
            },
            content_hash: content_hash(b"sheet Items"),
            confidence: Confidence::Determined,
        };
        let xml = IndexNode {
            id: "xml-type:scripts/entity_defs/types.xml:ITEM".into(),
            project: "proj".into(),
            file_path: "scripts/entity_defs/types.xml".into(),
            kind: NodeKind::XmlType,
            name: "ITEM".into(),
            content: "FIXED_DICT".into(),
            location: SourceLocation::Xml {
                path: "root/ITEM".into(),
                line: 7,
            },
            content_hash: content_hash(b"FIXED_DICT"),
            confidence: Confidence::Inferred,
        };
        store
            .replace_file_nodes("tables/items.xlsx", std::slice::from_ref(&excel))
            .unwrap();
        store
            .replace_file_nodes("scripts/entity_defs/types.xml", std::slice::from_ref(&xml))
            .unwrap();
        assert_eq!(
            store.node_by_id(&excel.id).unwrap().location,
            excel.location
        );
        assert_eq!(store.node_by_id(&xml.id).unwrap().location, xml.location);
        assert_eq!(
            store.node_by_id(&xml.id).unwrap().confidence,
            Confidence::Inferred
        );
        assert!(store.node_by_id("nope").is_none());
    }
}
