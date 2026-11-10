//! Format adapters: file bytes → [`IndexNode`] set (KODE-MCP-KB-002 P2,
//! design doc §3). Each format is extracted by the repo's existing parser
//! where one exists — never a second heuristic:
//! - Markdown → pulldown-cmark heading walk (document + section spans).
//! - Python → kode-python AST symbols (same extraction as the IDE face).
//! - def/types.xml/alias → the already-parsed [`AssetKnowledge`] in-memory
//!   model, indexed as-is (not re-derived from disk; design doc §3).
//! - config keys → the curated config catalog (same source as why_setting).
//! - Excel → calamine (workbook/sheet/column/row, bounded).
//!
//! Excel parsing was scheduled for P4 by the design doc §12 but was pulled
//! forward by the P2 directive's four-format mapping; the extraction is
//! read-only and resource-bounded (design doc §9).

use std::path::Path;

use calamine::Reader;

use crate::code_index::PySymbol;
use crate::kb::AssetKnowledge;
use crate::nodes::{content_hash, node_id, IndexNode, NodeKind, SourceLocation};
use crate::semantic_model::Confidence;

/// Node content is bounded for BM25; full content is read on demand.
const MAX_NODE_CONTENT: usize = 2000;
/// Excel rows indexed per sheet (rows beyond the cap are reported in the
/// sheet node's content, never silently dropped).
const MAX_EXCEL_ROWS: usize = 200;
/// Excel cells indexed per row.
const MAX_EXCEL_CELLS: usize = 64;

fn bound(s: &str) -> String {
    s.chars().take(MAX_NODE_CONTENT).collect()
}

fn node(
    project: &str,
    rel_path: &str,
    kind: NodeKind,
    name: &str,
    content: &str,
    location: SourceLocation,
    used: &mut std::collections::HashMap<String, usize>,
) -> IndexNode {
    // Disambiguate repeated names within one file deterministically (#2, #3…).
    let count = used.entry(name.to_string()).or_insert(0);
    *count += 1;
    let unique = if *count == 1 {
        name.to_string()
    } else {
        format!("{name}#{}", count)
    };
    let content = bound(content);
    IndexNode {
        id: node_id(&kind, rel_path, &unique),
        project: project.to_string(),
        file_path: rel_path.to_string(),
        kind,
        name: unique,
        content_hash: content_hash(content.as_bytes()),
        content,
        location,
        confidence: Confidence::Determined,
    }
}

fn offset_to_line(line_starts: &[usize], offset: usize) -> usize {
    match line_starts.binary_search(&offset) {
        Ok(i) => i + 1,
        Err(i) => i,
    }
}

fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            starts.push(i + 1);
        }
    }
    starts
}

// ---------------------------------------------------------------- Markdown

/// Extract a Markdown file into a Document node + one Section node per
/// heading span (pulldown-cmark byte offsets → 1-based line spans).
pub fn markdown_nodes(project: &str, rel_path: &str, text: &str) -> Vec<IndexNode> {
    let parser = pulldown_cmark::Parser::new_ext(text, pulldown_cmark::Options::empty());
    let events: Vec<_> = parser.into_offset_iter().collect();
    let starts = line_starts(text);
    let mut used = std::collections::HashMap::new();
    let mut out = Vec::new();

    // Heading starts: (byte offset, level, heading text).
    let mut headings: Vec<(usize, u32, String)> = Vec::new();
    let mut current: Option<(u32, String)> = None;
    for (event, range) in &events {
        match event {
            pulldown_cmark::Event::Start(pulldown_cmark::Tag::Heading { level, .. }) => {
                current = Some((*level as u32, String::new()));
                let _ = range;
            }
            pulldown_cmark::Event::End(pulldown_cmark::TagEnd::Heading(_)) => {
                if let Some((level, text_buf)) = current.take() {
                    headings.push((range.start, level, text_buf.trim().to_string()));
                }
            }
            pulldown_cmark::Event::Text(t) | pulldown_cmark::Event::Code(t) => {
                if let Some((_, buf)) = current.as_mut() {
                    buf.push_str(t);
                }
            }
            _ => {}
        }
    }
    // First H1 is the document title (title_of convention from docs_index);
    // its heading does not produce a duplicate Section node.
    let title_idx = headings.iter().position(|(_, level, _)| *level == 1);
    let title = title_idx.map(|i| headings[i].2.clone()).unwrap_or_default();

    out.push(node(
        project,
        rel_path,
        NodeKind::Document,
        &if title.is_empty() {
            std::path::Path::new(rel_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(rel_path)
                .to_string()
        } else {
            title
        },
        text,
        SourceLocation::Lines {
            start: 1,
            end: text.lines().count().max(1),
        },
        &mut used,
    ));
    // Section spans: heading start → next heading start (any level) or EOF.
    // The title H1 is not a section (its content is the document itself).
    for (i, (start, _level, heading)) in headings.iter().enumerate() {
        if Some(i) == title_idx {
            continue;
        }
        let end = headings
            .get(i + 1)
            .map(|(next, _, _)| *next)
            .unwrap_or(text.len());
        let start_line = offset_to_line(&starts, *start);
        let end_line = offset_to_line(&starts, end.saturating_sub(1).max(*start));
        let slice = &text[*start..end.min(text.len())];
        let name = if heading.is_empty() {
            format!("section {}", i + 1)
        } else {
            heading.clone()
        };
        out.push(node(
            project,
            rel_path,
            NodeKind::Section,
            &name,
            slice,
            SourceLocation::Lines {
                start: start_line,
                end: end_line,
            },
            &mut used,
        ));
    }
    out
}

// ----------------------------------------------------------------- Python

/// Python symbols of one file → class/function/method nodes with the exact
/// source block as content (kode-python AST, same as the IDE face).
pub fn python_nodes(project: &str, rel_path: &str, file: &Path, source: &str) -> Vec<IndexNode> {
    let symbols = crate::code_index::symbols_of(file, source);
    python_nodes_from_symbols(project, rel_path, source, &symbols)
}

/// Node construction from an already-extracted symbol table (reconcile
/// reuses one parse per file).
pub fn python_nodes_from_symbols(
    project: &str,
    rel_path: &str,
    source: &str,
    symbols: &[PySymbol],
) -> Vec<IndexNode> {
    let lines: Vec<&str> = source.lines().collect();
    let mut used = std::collections::HashMap::new();
    let mut out = Vec::new();
    for sym in symbols {
        let kind = match sym.kind {
            "class" => NodeKind::PythonClass,
            "function" => NodeKind::PythonFunction,
            _ => NodeKind::PythonMethod,
        };
        // Exact source block start..end (1-based, inclusive), bounded.
        let start = sym.line.saturating_sub(1);
        let end = sym.end_line.min(lines.len());
        let block = if start < end {
            lines[start..end].join("\n")
        } else {
            String::new()
        };
        let name = match &sym.class {
            Some(class) => format!("{class}.{}", sym.name),
            None => sym.name.clone(),
        };
        out.push(node(
            project,
            rel_path,
            kind,
            &name,
            &block,
            SourceLocation::Lines {
                start: sym.line,
                end: sym.end_line,
            },
            &mut used,
        ));
    }
    out
}

// ------------------------------------------------------------- def / XML

/// def/types.xml/alias nodes from the **already-parsed** in-memory model
/// (design doc §3: parsed data is a first-class index source, not re-parsed
/// from disk). Grouped by file for per-file incremental replacement.
pub fn def_xml_nodes(kb: &AssetKnowledge, project: &str) -> Vec<IndexNode> {
    let mut used_by_file: std::collections::HashMap<
        String,
        std::collections::HashMap<String, usize>,
    > = std::collections::HashMap::new();
    let mut out = Vec::new();
    let mut push = |rel_path: &str,
                    kind: NodeKind,
                    name: String,
                    content: String,
                    location: SourceLocation| {
        let used = used_by_file.entry(rel_path.to_string()).or_default();
        out.push(node(
            project, rel_path, kind, &name, &content, location, used,
        ));
    };
    for def in kb.defs.values() {
        let text_lines = def.text.lines().count();
        push(
            &def.rel_path,
            NodeKind::Entity,
            def.name.clone(),
            def.text.clone(),
            SourceLocation::Lines {
                start: 1,
                end: text_lines.max(1),
            },
        );
        for prop in &def.model.properties {
            let mut content = String::new();
            if let Some(t) = &prop.type_name {
                content.push_str("type ");
                content.push_str(t);
            }
            for r in &prop.type_refs {
                content.push(' ');
                content.push_str(r);
            }
            if !prop.flags.is_empty() {
                content.push_str(" flags ");
                content.push_str(&prop.flags.join(" "));
            }
            if let Some(default) = &prop.default_value {
                content.push_str(" default ");
                content.push_str(default);
            }
            push(
                &def.rel_path,
                NodeKind::EntityProperty,
                format!("{}.{}", def.name, prop.name),
                content,
                SourceLocation::Lines {
                    start: prop.line,
                    end: prop.line,
                },
            );
        }
        for (section, methods) in [
            ("BaseMethods", &def.model.base_methods),
            ("CellMethods", &def.model.cell_methods),
            ("ClientMethods", &def.model.client_methods),
        ] {
            for m in methods {
                let mut content = format!("{section} remote method {0}", m.name);
                for arg in &m.args {
                    content.push(' ');
                    content.push_str(arg);
                }
                push(
                    &def.rel_path,
                    NodeKind::EntityMethod,
                    format!("{}.{}", def.name, m.name),
                    content,
                    SourceLocation::Lines {
                        start: m.line,
                        end: m.line,
                    },
                );
            }
        }
    }
    for decl in &kb.types.types {
        let mut content = format!("{:?} type", decl.kind);
        if let Some(directive) = &decl.directive {
            content.push_str(" alias-of ");
            content.push_str(directive);
        }
        if let Some(impl_symbol) = &decl.implemented_by_symbol {
            content.push_str(" implementedBy ");
            content.push_str(impl_symbol);
        }
        for field in &decl.field_refs {
            content.push_str(" field ");
            content.push_str(field);
        }
        if let Some(element) = &decl.element_ref {
            content.push_str(" of ");
            content.push_str(element);
        }
        push(
            "scripts/entity_defs/types.xml",
            NodeKind::XmlType,
            decl.name.clone(),
            content,
            SourceLocation::Xml {
                path: format!("types/{}", decl.name),
                line: decl.line,
            },
        );
        for field in &decl.field_refs {
            push(
                "scripts/entity_defs/types.xml",
                NodeKind::XmlElement,
                format!("{}.{}", decl.name, field),
                format!("field of {:?} type {}", decl.kind, decl.name),
                SourceLocation::Xml {
                    path: format!("types/{}/{}", decl.name, field),
                    line: decl.line,
                },
            );
        }
    }
    for alias in &kb.alias.aliases {
        push(
            "scripts/entity_defs/alias.xml",
            NodeKind::XmlAttribute,
            alias.name.clone(),
            format!("alias of {}", alias.alias_type),
            SourceLocation::Xml {
                path: format!("alias/{}", alias.name),
                line: alias.line,
            },
        );
    }
    out
}

/// Config catalog nodes (compile-time curated knowledge, same source as
/// why_setting/list_config_settings): dotted key + zh/en meaning + file:line
/// provenance. Indexed once; content never changes at runtime.
pub fn config_catalog_nodes() -> Vec<IndexNode> {
    let rel = "catalog/server-config";
    let mut used = std::collections::HashMap::new();
    crate::config_catalog::SERVER_CONFIG_ITEM_DOCS
        .iter()
        .map(|(key, doc)| {
            node(
                "catalog",
                rel,
                NodeKind::XmlAttribute,
                key,
                &format!("{key} {0} {1} source {2}", doc.en, doc.zh, doc.source),
                SourceLocation::Xml {
                    path: doc.source.to_string(),
                    line: 0,
                },
                &mut used,
            )
        })
        .collect()
}

// ----------------------------------------------------------------- Excel

/// Spreadsheet cells → plain text (bounded); empty cells skipped.
fn cell_text(cell: &calamine::Data) -> String {
    match cell {
        calamine::Data::Empty => String::new(),
        calamine::Data::String(s) => s.clone(),
        calamine::Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                format!("{f}")
            }
        }
        calamine::Data::Int(i) => format!("{i}"),
        calamine::Data::Bool(b) => format!("{b}"),
        calamine::Data::DateTime(dt) => format!("{}", dt.as_f64()),
        calamine::Data::DateTimeIso(s) => s.clone(),
        calamine::Data::DurationIso(s) => s.clone(),
        calamine::Data::Error(e) => format!("error {e}"),
    }
}

fn col_letter(mut c: usize) -> String {
    let mut s = String::new();
    loop {
        s.insert(0, (b'A' + (c % 26) as u8) as char);
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    s
}

/// A1-style range of sheet `row` (0-based within the used range), spanning
/// `cols` columns from the range's start column.
fn excel_range(sheet_cells: &calamine::Range<calamine::Data>, row: usize, cols: usize) -> String {
    let start = sheet_cells.start().unwrap_or((0, 0));
    let row_1 = start.0 as usize + row + 1;
    let col_a = start.1 as usize;
    format!(
        "{}{}:{}{}",
        col_letter(col_a),
        row_1,
        col_letter(col_a.saturating_add(cols.saturating_sub(1))),
        row_1
    )
}

/// Excel workbook → sheet/column/row nodes (calamine, read-only, bounded:
/// rows per sheet capped at [`MAX_EXCEL_ROWS`], cells per row capped; the
/// cap is recorded in the sheet content, never silently dropped). A sheet
/// whose cells cannot be read still yields a node that says so — the error
/// is visible, never swallowed.
pub fn excel_nodes(project: &str, rel_path: &str, path: &Path) -> Result<Vec<IndexNode>, String> {
    let mut workbook =
        calamine::open_workbook_auto(path).map_err(|e| format!("{rel_path}: {e}"))?;
    let sheet_names = workbook.sheet_names();
    let mut used = std::collections::HashMap::new();
    let mut out = Vec::new();
    for sheet in &sheet_names {
        let Ok(range) = workbook.worksheet_range(sheet) else {
            out.push(node(
                project,
                rel_path,
                NodeKind::ExcelSheet,
                sheet,
                &format!("sheet {sheet} unreadable (cells could not be parsed)"),
                SourceLocation::Excel {
                    sheet: sheet.clone(),
                    range: "unknown".to_string(),
                },
                &mut used,
            ));
            continue;
        };
        let mut rows = range.rows();
        let mut total_rows = 0usize;
        let mut sheet_text = String::new();
        let mut indexed_rows = 0usize;
        // (range row index, joined cells, A1 range) — header excluded later.
        let mut row_nodes: Vec<(usize, String, String)> = Vec::new();
        let headers: Option<Vec<String>> = rows.next().map(|r| {
            r.iter()
                .take(MAX_EXCEL_CELLS)
                .map(cell_text)
                .collect::<Vec<_>>()
        });
        let mut first_data_row = 0usize;
        if let Some(hdrs) = &headers {
            first_data_row = 1;
            sheet_text.push_str(&hdrs.join(" | "));
            sheet_text.push('\n');
        }
        for (i, row) in rows.enumerate() {
            total_rows += 1;
            let cells: Vec<String> = row
                .iter()
                .take(MAX_EXCEL_CELLS)
                .map(cell_text)
                .filter(|c| !c.is_empty())
                .collect();
            if cells.is_empty() {
                continue;
            }
            let joined = cells.join(" | ");
            if indexed_rows < MAX_EXCEL_ROWS {
                sheet_text.push_str(&joined);
                sheet_text.push('\n');
                row_nodes.push((
                    first_data_row + i,
                    joined.clone(),
                    excel_range(&range, first_data_row + i, row.len()),
                ));
                indexed_rows += 1;
            }
        }
        let truncated_note = if total_rows > indexed_rows {
            format!(" (rows indexed {indexed_rows}/{total_rows}, capped at {MAX_EXCEL_ROWS})")
        } else {
            String::new()
        };
        let end = range
            .end()
            .map(|(r, c)| format!("{}{}", col_letter(c as usize), r as usize + 1))
            .unwrap_or_else(|| "A1".to_string());
        out.push(node(
            project,
            rel_path,
            NodeKind::ExcelSheet,
            sheet,
            &format!("sheet {sheet} {0}{truncated_note}", bound(&sheet_text)),
            SourceLocation::Excel {
                sheet: sheet.clone(),
                range: format!("A1:{end}"),
            },
            &mut used,
        ));
        if let Some(headers) = headers {
            for (ci, header) in headers.iter().enumerate() {
                if header.is_empty() {
                    continue;
                }
                out.push(node(
                    project,
                    rel_path,
                    NodeKind::ExcelColumn,
                    &format!("{sheet}.{header}"),
                    &format!("column of sheet {sheet}: {header}"),
                    SourceLocation::Excel {
                        sheet: sheet.clone(),
                        range: excel_range(&range, 0, ci + 1),
                    },
                    &mut used,
                ));
            }
        }
        for (row_idx, joined, range_str) in row_nodes {
            out.push(node(
                project,
                rel_path,
                NodeKind::ExcelRow,
                &format!("{sheet}.row{}", row_idx + 1),
                &joined,
                SourceLocation::Excel {
                    sheet: sheet.clone(),
                    range: range_str,
                },
                &mut used,
            ));
        }
    }
    Ok(out)
}

/// Dispatch a disk file to its adapter by extension. def/xml come from the
/// parsed model (see [`def_xml_nodes`]), not from this disk path.
pub fn extract_file(project: &str, root: &Path, path: &Path) -> Result<Vec<IndexNode>, String> {
    let rel_path = crate::nodes::rel_path(root, path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "md" => {
            let text = std::fs::read_to_string(path).map_err(|e| format!("{rel_path}: {e}"))?;
            Ok(markdown_nodes(project, &rel_path, &text))
        }
        "py" => {
            let source = std::fs::read_to_string(path).map_err(|e| format!("{rel_path}: {e}"))?;
            Ok(python_nodes(project, &rel_path, path, &source))
        }
        "xlsx" | "xlsm" | "xls" | "ods" | "xlsb" => excel_nodes(project, &rel_path, path),
        other => Err(format!("{rel_path}: no extractor for .{other}")),
    }
}

/// Does this extension have a disk extractor? (def/xml are model-backed.)
pub fn is_indexable_ext(ext: &str) -> bool {
    matches!(
        ext,
        "md" | "py" | "xlsx" | "xlsm" | "xls" | "ods" | "xlsb" | "def" | "xml"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> &'static str {
        "testproj"
    }

    // ---- Markdown (pulldown-cmark section spans). ----

    #[test]
    fn markdown_yields_document_and_sections_with_line_spans() {
        let text = "# 设计文档\n\n## 网络\n\n客户端登录流程说明。\n\n## 数据库\n\n存档说明。\n";
        let nodes = markdown_nodes(project(), "docs/design.md", text);
        let doc = nodes.iter().find(|n| n.kind == NodeKind::Document).unwrap();
        assert_eq!(doc.name, "设计文档");
        assert_eq!(doc.location, SourceLocation::Lines { start: 1, end: 9 });
        let net = nodes
            .iter()
            .find(|n| n.kind == NodeKind::Section && n.name == "网络")
            .expect("网络 section");
        // "## 网络" is line 3; section runs to just before "## 数据库" (line 7).
        assert_eq!(net.location, SourceLocation::Lines { start: 3, end: 6 });
        assert!(net.content.contains("客户端登录流程说明"));
        assert!(
            !net.content.contains("存档说明"),
            "section span must not bleed"
        );
        let db = nodes
            .iter()
            .find(|n| n.kind == NodeKind::Section && n.name == "数据库")
            .unwrap();
        assert_eq!(db.location.start_line(), Some(7));
        // ids are stable + unique per file
        let ids: Vec<_> = nodes.iter().map(|n| n.id.clone()).collect();
        assert_eq!(
            ids.len(),
            std::collections::HashSet::<_>::from_iter(ids.iter()).len()
        );
    }

    #[test]
    fn markdown_duplicate_headings_get_ordinal_ids() {
        let text = "# Doc\n\n## Same\n\na\n\n## Same\n\nb\n";
        let nodes = markdown_nodes(project(), "docs/d.md", text);
        let sections: Vec<_> = nodes
            .iter()
            .filter(|n| n.kind == NodeKind::Section)
            .map(|n| n.name.clone())
            .collect();
        assert_eq!(sections, vec!["Same", "Same#2"]);
    }

    #[test]
    fn markdown_without_h1_titles_by_file_stem() {
        let nodes = markdown_nodes(project(), "docs/notes.md", "just text\nmore text\n");
        let doc = nodes.iter().find(|n| n.kind == NodeKind::Document).unwrap();
        assert_eq!(doc.name, "notes");
    }

    // ---- Python (kode-python symbols + exact source blocks). ----

    #[test]
    fn python_nodes_carry_exact_source_blocks_and_qualified_names() {
        let src =
            "class Account:\n    def login(self):\n        pass\n\n\ndef helper():\n    return 1\n";
        let nodes = python_nodes(
            project(),
            "scripts/base/account.py",
            Path::new("/x/account.py"),
            src,
        );
        let class = nodes
            .iter()
            .find(|n| n.kind == NodeKind::PythonClass)
            .unwrap();
        assert_eq!(class.name, "Account");
        assert_eq!(class.location, SourceLocation::Lines { start: 1, end: 3 });
        assert_eq!(
            class.content,
            "class Account:\n    def login(self):\n        pass"
        );
        let method = nodes
            .iter()
            .find(|n| n.kind == NodeKind::PythonMethod)
            .unwrap();
        assert_eq!(method.name, "Account.login");
        assert_eq!(method.location, SourceLocation::Lines { start: 2, end: 3 });
        let func = nodes
            .iter()
            .find(|n| n.kind == NodeKind::PythonFunction)
            .unwrap();
        assert_eq!(func.name, "helper");
        // `def helper` is line 6 in this source (1-based, exact block).
        assert_eq!(func.location.start_line(), Some(6));
        // Content is BM25-searchable (the term only exists in the block).
        assert!(func.content.contains("return 1"));
    }

    // ---- def/types.xml/alias from the parsed model. ----

    #[test]
    fn def_xml_nodes_come_from_the_parsed_model() {
        // Real KBEngine shape: `<Arg>` is a direct child of the method
        // element (no `<Args>` wrapper), matching the demo fixture.
        let text = "<root><Properties><level><Type> UINT32 </Type><Flags> BASE </Flags></level></Properties>\
                    <BaseMethods><reqCreateAvatar><Exposed> true </Exposed><Arg> UINT32 </Arg></reqCreateAvatar></BaseMethods></root>";
        let mut kb = AssetKnowledge::default();
        kb.defs.insert(
            "Avatar".into(),
            crate::kb::ParsedDef {
                name: "Avatar".into(),
                category: "entity".into(),
                rel_path: "scripts/entity_defs/Avatar.def".into(),
                text: text.into(),
                model: kode_parser::model::parse_def(text),
            },
        );
        let nodes = def_xml_nodes(&kb, project());
        let entity = nodes.iter().find(|n| n.kind == NodeKind::Entity).unwrap();
        assert_eq!(entity.name, "Avatar");
        assert_eq!(entity.file_path, "scripts/entity_defs/Avatar.def");
        let prop = nodes
            .iter()
            .find(|n| n.kind == NodeKind::EntityProperty)
            .unwrap();
        assert_eq!(prop.name, "Avatar.level");
        assert!(prop.content.contains("UINT32"));
        assert!(prop.content.contains("BASE"));
        let method = nodes
            .iter()
            .find(|n| n.kind == NodeKind::EntityMethod)
            .unwrap();
        assert_eq!(method.name, "Avatar.reqCreateAvatar");
        assert!(method.content.contains("BaseMethods"));
        assert!(method.content.contains("UINT32"));
    }

    #[test]
    fn types_and_alias_nodes_carry_implemented_by_and_fields() {
        let types = "<root><SKILL_SLOT>\n\tFIXED_DICT\n\t<Properties><a><Type>UINT32</Type></a></Properties>\n\t<implementedBy>mod.Impl</implementedBy>\n</SKILL_SLOT>\
                     <ARR>\n\tARRAY\n\t<of>UINT32</of>\n</ARR></root>";
        let kb = AssetKnowledge {
            types: kode_parser::model::parse_types(types),
            alias: kode_parser::model::parse_alias("<root><ITEM_ID>\n\tUINT16\n</ITEM_ID></root>"),
            ..Default::default()
        };
        let nodes = def_xml_nodes(&kb, project());
        let slot = nodes
            .iter()
            .find(|n| n.kind == NodeKind::XmlType && n.name == "SKILL_SLOT")
            .unwrap();
        // The parser stores the implementedBy symbol without its module
        // prefix (kode-parser model.rs rsplit('.')) and field_refs as the
        // referenced type names — indexed as-is, not re-derived.
        assert!(
            slot.content.contains("implementedBy Impl"),
            "{}",
            slot.content
        );
        assert!(slot.content.contains("field UINT32"));
        let field = nodes
            .iter()
            .find(|n| n.kind == NodeKind::XmlElement && n.name == "SKILL_SLOT.UINT32")
            .expect("field node");
        assert_eq!(field.file_path, "scripts/entity_defs/types.xml");
        let arr = nodes.iter().find(|n| n.name == "ARR").unwrap();
        assert!(arr.content.contains("of UINT32"));
        let alias = nodes
            .iter()
            .find(|n| n.kind == NodeKind::XmlAttribute)
            .unwrap();
        assert_eq!(alias.name, "ITEM_ID");
        assert!(alias.content.contains("UINT16"));
        assert_eq!(alias.file_path, "scripts/entity_defs/alias.xml");
    }

    // ---- config catalog. ----

    #[test]
    fn config_catalog_nodes_cover_the_curated_keys() {
        let nodes = config_catalog_nodes();
        assert!(nodes.len() > 200, "catalog size mirrored");
        let archive = nodes
            .iter()
            .find(|n| n.name == "baseapp.archivePeriod")
            .expect("config key node");
        assert_eq!(archive.project, "catalog");
        assert!(archive.content.contains("archivePeriod"));
        assert!(
            archive.content.contains("存档"),
            "zh meaning indexed for BM25"
        );
        assert!(archive.content.contains("kbengine_defaults.xml"));
    }

    // ---- content addressing bounds. ----

    #[test]
    fn node_content_is_bounded() {
        let big = "x".repeat(5000);
        let mut used = std::collections::HashMap::new();
        let n = node(
            project(),
            "a.md",
            NodeKind::Document,
            "big",
            &big,
            SourceLocation::Lines { start: 1, end: 1 },
            &mut used,
        );
        assert!(n.content.chars().count() <= MAX_NODE_CONTENT);
        assert_eq!(
            n.content_hash,
            content_hash(n.content.as_bytes()),
            "hash covers the bounded stored content"
        );
    }

    // ---- extract_file dispatch. ----

    #[test]
    fn extract_file_dispatches_by_extension_and_errors_honestly() {
        let root = std::env::temp_dir().join(format!("kode-mcp-extract-{}", std::process::id()));
        let docs = root.join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("a.md"), "# T\n\n## S\nteleport notes\n").unwrap();
        let nodes = extract_file(project(), &root, &docs.join("a.md")).unwrap();
        assert!(nodes.iter().any(|n| n.kind == NodeKind::Document));
        assert!(nodes.iter().any(|n| n.kind == NodeKind::Section));
        assert!(extract_file(project(), &root, &docs.join("nope.bin")).is_err());
        assert!(extract_file(project(), &root, &root.join("missing.md")).is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn indexable_extensions_cover_all_four_formats() {
        for ext in [
            "md", "py", "xlsx", "xlsm", "xls", "ods", "xlsb", "def", "xml",
        ] {
            assert!(is_indexable_ext(ext), "{ext}");
        }
        assert!(!is_indexable_ext("bin"));
        assert!(!is_indexable_ext("png"));
    }

    // ---- Excel (calamine over the committed .xlsx fixture). ----

    #[test]
    fn excel_fixture_yields_sheets_columns_and_rows() {
        let xlsx = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kb/items.xlsx");
        let nodes = excel_nodes(project(), "tables/items.xlsx", &xlsx).unwrap();
        let items = nodes
            .iter()
            .find(|n| n.kind == NodeKind::ExcelSheet && n.name == "Items")
            .expect("Items sheet node");
        assert!(items.content.contains("RedPotion"));
        assert!(items.content.contains("ManaCrystal"));
        let boss = nodes
            .iter()
            .find(|n| n.kind == NodeKind::ExcelSheet && n.name == "Boss")
            .expect("Boss sheet node");
        assert!(boss.content.contains("DragonKing"));
        assert!(nodes
            .iter()
            .any(|n| n.kind == NodeKind::ExcelColumn && n.name == "Items.name"));
        let row = nodes
            .iter()
            .find(|n| n.kind == NodeKind::ExcelRow && n.name == "Items.row2")
            .expect("row 2 node");
        assert!(row.content.contains("RedPotion"));
        assert!(matches!(items.location, SourceLocation::Excel { .. }));
    }
}
