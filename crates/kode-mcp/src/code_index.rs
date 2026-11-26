//! Code symbol index (KODE-MCP-KB-001 ⑦): the `search_symbols` tool.
//!
//! Reuses kode-python's AST symbol extraction (the same parser as
//! kode-server's Python analysis face, no separate heuristics) to build a
//! symbol index under `{root}/scripts`: classes / module-level functions /
//! methods, each carrying file:line. Answers "where is some symbol in the
//! code defined".
//!
//! Boundaries (honest): indexes only `scripts/` (the KBEngine script
//! domain), skipping def/resource/noise directories; file count capped and
//! single-file read capped at 1MB; case-insensitive substring lookup by
//! name, returning file/line/kind/class (the class a method belongs to),
//! without returning whole articles. Call-graph / data-flow queries are not
//! in this face (kode-python has extract_call_graph; re-evaluate if a
//! separate query is added).
//!
//! Line-number convention: kode-python's `line_col` is 0-based; this face
//! explicitly adds +1 at the MCP boundary to go 1-based (consistent with
//! def/XML catalog file:line, e.g. kbengine_defaults.xml:618), so an agent
//! can jump straight to the editor line number.

use std::path::{Path, PathBuf};

use kode_python::symbols::parse_ast_symbols;
use serde_json::{json, Value};

pub(crate) const MAX_FILES: usize = 5000;
const MAX_FILE_BYTES: u64 = 1_000_000;
pub(crate) const SKIP_DIRS: &[&str] = &[
    "target",
    "node_modules",
    ".git",
    ".kbengine",
    ".vscode-test",
    "dist",
    "out",
    "build",
    "entity_defs",
    "res",
];

/// Symbol entry (classes/functions/methods share one shape; used for MCP
/// face output, reused by the semantic model).
#[derive(Debug, Clone)]
pub struct PySymbol {
    pub name: String,
    pub kind: &'static str,
    pub class: Option<String>,
    pub file: PathBuf,
    pub line: usize,
    /// 1-based block end line (exact start..end block; consumed by the
    /// read_node close-reading face).
    pub end_line: usize,
}

/// Recursively collect `.py` under `{root}/scripts` (bounded).
fn collect_py(root: &Path) -> Vec<PathBuf> {
    crate::bounded_scan::collect(&[root.join("scripts")], "py", SKIP_DIRS, MAX_FILES).files
}

fn read_capped(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// kode-python 0-based line number → MCP 1-based line number (consistent with
/// the def/XML file:line convention).
fn to_one_based(line: usize) -> usize {
    line + 1
}

/// Collect all symbols of a file (classes + module-level functions + methods).
pub(crate) fn symbols_of(file: &Path, source: &str) -> Vec<PySymbol> {
    let extraction = parse_ast_symbols(source);
    let mut out = Vec::new();
    for class in &extraction.symbols.classes {
        out.push(PySymbol {
            name: class.name.clone(),
            kind: "class",
            class: None,
            file: file.to_path_buf(),
            line: to_one_based(class.start_line),
            end_line: to_one_based(class.end_line),
        });
        for method in &class.methods {
            out.push(PySymbol {
                name: method.name.clone(),
                kind: "method",
                class: Some(class.name.clone()),
                file: file.to_path_buf(),
                line: to_one_based(method.line),
                end_line: to_one_based(method.end_line),
            });
        }
    }
    for function in &extraction.symbols.functions {
        out.push(PySymbol {
            name: function.name.clone(),
            kind: "function",
            class: None,
            file: file.to_path_buf(),
            line: to_one_based(function.line),
            end_line: to_one_based(function.end_line),
        });
    }
    out
}

/// Full Python symbol table: classes/functions/methods of all `.py` files
/// under `{root}/scripts` (bounded: file count capped, 1MB per file). The
/// semantic model (find_symbol/implementedBy) and search_symbols share the
/// same extraction to guarantee consistency.
pub fn collect_symbols(root: &Path) -> Vec<PySymbol> {
    let mut out = Vec::new();
    for file in collect_py(root) {
        let Some(source) = read_capped(&file) else {
            continue;
        };
        out.extend(symbols_of(&file, &source));
    }
    out
}

/// Locate a `.py` under `{root}/scripts` by module name (file stem, case
/// sensitive). implementedBy's `MODULE.Class` shape needs the implementation
/// file found by module name.
pub fn find_module(root: &Path, module: &str) -> Option<PathBuf> {
    collect_py(root)
        .into_iter()
        .find(|f| f.file_stem().and_then(|s| s.to_str()) == Some(module))
}

/// Class path validity: an identifier or dotted identifier
/// (`Class` / `module.Class`), non-empty, no leading/trailing or consecutive
/// dots, no segment starting with a digit.
fn is_class_path(s: &str) -> bool {
    if s.is_empty() || s.starts_with('.') || s.ends_with('.') || s.contains("..") {
        return false;
    }
    s.split('.').all(|p| {
        !p.is_empty()
            && p.chars().all(|c| c.is_alphanumeric() || c == '_')
            && !p.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(true)
    })
}

/// Scan a single source file for **module-level** `inst = Class(...)`
/// instance assignments, returning the class name.
///
/// Criteria (strict, to prevent misidentification of unrelated lines as
/// instance assignments):
/// - **Module level**: the assignment must start at column 0; indented
///   assignments inside a function/class body are not module-level instances.
/// - **Assignment, not comparison/compound**: the right side begins with a
///   single `=` (not `==`/`>=`/`+=` etc.).
/// - **Constructor call**: the right side must be `Class(...)` or
///   `module.Class(...)` (containing `(`); bare names / attribute reads /
///   dict literals do not count.
/// - **Identifier boundary**: `inst` must be followed by whitespace or `=`
///   (`instance` does not match the `inst` prefix).
///
/// A single bad line is skipped rather than aborting the whole file scan;
/// returns the first valid assignment.
pub fn instance_class_in_source(source: &str, inst: &str) -> Option<String> {
    for line in source.lines() {
        // Module level: column 0, no leading whitespace.
        if line.starts_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let t = line.trim_end();
        let Some(rest) = t.strip_prefix(inst) else {
            continue;
        };
        // `inst` must be a complete identifier (followed by whitespace / `=` /
        // end of line).
        if let Some(next) = rest.chars().next() {
            if next.is_alphanumeric() || next == '_' {
                continue;
            }
        }
        let rest = rest.trim_start();
        // Assignment `=` (not comparison / compound assignment).
        if !rest.starts_with('=') || rest.starts_with("==") {
            continue;
        }
        let after = rest['='.len_utf8()..].trim_start();
        // Constructor call: `Class(...)` or `module.Class(...)`.
        let Some(open) = after.find('(') else {
            continue;
        };
        let class = after[..open].trim();
        if !is_class_path(class) {
            continue;
        }
        return Some(class.rsplit('.').next().unwrap_or(class).to_string());
    }
    None
}

/// Look up class `class` in a single `.py` file (bounded read); returns the
/// class name. implementedBy's `MODULE.Class` shape: the class must be inside
/// the corresponding module file, not found globally just by matching a name.
pub fn class_in_file(file: &Path, class: &str) -> Option<String> {
    let source = read_capped(file)?;
    let extraction = parse_ast_symbols(&source);
    extraction
        .symbols
        .classes
        .iter()
        .find(|c| c.name == class)
        .map(|c| c.name.clone())
}

/// Scan all of `{root}/scripts` for `inst = Class()` instance assignments
/// (bounded: file count capped, 1MB per file). When implementedBy has been
/// normalized by the parser into an object name (module prefix dropped), only
/// a full scan by object name is possible; matching by object name is the
/// sole criterion, and the first hit is taken without ambiguity.
pub fn find_instance_class(root: &Path, inst: &str) -> Option<String> {
    for file in collect_py(root) {
        let Some(source) = read_capped(&file) else {
            continue;
        };
        if let Some(class) = instance_class_in_source(&source, inst) {
            return Some(class);
        }
    }
    None
}

/// `search_symbols`: look up symbols by name (case-insensitive substring) in
/// the `.py` files under `{root}/scripts`, returning {name,kind,class,file,
/// line}. Empty query → Err; no hits → an honestly empty set; limit defaults
/// to 20.
pub fn search_symbols(root: &Path, query: &str, limit: usize) -> Result<Value, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("empty symbol query".to_string());
    }
    let q = query.to_lowercase();
    let scan = crate::bounded_scan::collect(&[root.join("scripts")], "py", SKIP_DIRS, MAX_FILES);
    let mut errors = scan.errors;
    let mut found: Vec<Value> = Vec::new();
    for file in scan.files {
        let Some(source) = read_capped(&file) else {
            errors += 1;
            continue;
        };
        for sym in symbols_of(&file, &source) {
            if !sym.name.to_lowercase().contains(&q) {
                continue;
            }
            let mut entry = json!({
                "name": sym.name,
                "kind": sym.kind,
                "file": sym.file.to_string_lossy(),
                "line": sym.line,
            });
            if let Some(class) = sym.class {
                entry["class"] = Value::String(class);
            }
            found.push(entry);
            if found.len() >= limit {
                return Ok(json!({
                    "query": query,
                    "count": found.len(),
                    "truncated": scan.truncated,
                    "results_limited": true,
                    "scan_errors": errors,
                    "matches": found,
                }));
            }
        }
    }
    Ok(json!({
        "query": query,
        "count": found.len(),
        "truncated": scan.truncated,
        "results_limited": false,
        "scan_errors": errors,
        "matches": found,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_query_is_error() {
        assert!(search_symbols(Path::new("."), " ", 20).is_err());
    }

    #[test]
    fn missing_scripts_directory_is_reported() {
        let root = std::env::temp_dir().join(format!("kode-mcp-missing-py-{}", std::process::id()));
        let result = search_symbols(&root, "anything", 20).unwrap();
        assert_eq!(result["count"], 0);
        assert_eq!(result["scan_errors"], 1);
        assert_eq!(result["truncated"], false);
    }

    #[test]
    fn indexes_classes_functions_and_methods_with_lines() {
        let root = std::env::temp_dir().join(format!("kode-mcp-symbols-{}", std::process::id()));
        let scripts = root.join("scripts").join("base");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(
            scripts.join("account.py"),
            "class Account:\n    def login(self):\n        pass\n\ndef helper():\n    pass\n",
        )
        .unwrap();
        let out = search_symbols(&root, "account", 20).expect("answer");
        // "account" hits class name Account and method login? login does not
        // contain account → only the class hits. Case-insensitive substring:
        // Account→account matches.
        let matches = out["matches"].as_array().unwrap();
        let class = matches
            .iter()
            .find(|m| m["kind"] == "class")
            .expect("class");
        assert_eq!(class["name"], "Account");
        assert_eq!(class["line"], 1);

        let login = search_symbols(&root, "login", 20).expect("answer");
        let m = login["matches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["kind"] == "method")
            .expect("method");
        assert_eq!(m["name"], "login");
        assert_eq!(m["class"], "Account");
        assert_eq!(m["line"], 2);

        let helper = search_symbols(&root, "helper", 20).expect("answer");
        let m = helper["matches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["kind"] == "function")
            .expect("function");
        assert_eq!(m["line"], 5);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn no_match_is_honest_empty() {
        let root =
            std::env::temp_dir().join(format!("kode-mcp-symbols-none-{}", std::process::id()));
        let scripts = root.join("scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(scripts.join("a.py"), "x = 1\n").unwrap();
        let out = search_symbols(&root, "zzz", 20).expect("answer");
        assert_eq!(out["count"], 0);
        std::fs::remove_dir_all(&root).ok();
    }

    // ---- instance_class_in_source strict criteria (prove-red: the old code
    // accepted bare names / indented lines / comparisons). ----

    #[test]
    fn instance_assignment_requires_constructor_call() {
        // A bare-name assignment without `(` is not instance construction.
        assert_eq!(instance_class_in_source("inst = Other\n", "inst"), None);
        // Comparison `==` is not assignment.
        assert_eq!(instance_class_in_source("inst == Other()\n", "inst"), None);
        // An attribute read on the right side is not construction.
        assert_eq!(instance_class_in_source("inst = some.attr\n", "inst"), None);
        // A valid constructor call → class name.
        assert_eq!(
            instance_class_in_source("inst = Weapon()\n", "inst"),
            Some("Weapon".into())
        );
    }

    #[test]
    fn instance_assignment_requires_module_level() {
        // An indented assignment inside a function/class body is not a
        // module-level instance.
        let src = "def build():\n    inst = Weapon()\n";
        assert_eq!(instance_class_in_source(src, "inst"), None);
    }

    #[test]
    fn instance_assignment_requires_identifier_boundary() {
        // `instance` should not match the `inst` prefix.
        assert_eq!(
            instance_class_in_source("instance = Weapon()\n", "inst"),
            None
        );
    }

    #[test]
    fn instance_assignment_accepts_dotted_class_path() {
        // The `module.Class()` dotted path → class name (the old code rejected
        // it because `.` failed the identifier filter).
        assert_eq!(
            instance_class_in_source("inst = package.Weapon()\n", "inst"),
            Some("Weapon".into())
        );
        // Leading/trailing dots or consecutive dots are invalid.
        assert_eq!(instance_class_in_source("inst = .Weapon()\n", "inst"), None);
        assert_eq!(
            instance_class_in_source("inst = package..Weapon()\n", "inst"),
            None
        );
    }

    #[test]
    fn instance_assignment_skips_bad_line_and_finds_later_good_line() {
        // One bad line does not abort the whole file scan (the old code's `?`
        // early-returned, dropping later valid lines).
        let src = "inst = Other\ninst = Real()\n";
        assert_eq!(instance_class_in_source(src, "inst"), Some("Real".into()));
    }

    #[test]
    fn class_in_file_locates_only_that_module() {
        let root =
            std::env::temp_dir().join(format!("kode-mcp-class-in-file-{}", std::process::id()));
        let scripts = root.join("scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        let f = scripts.join("mod_a.py");
        std::fs::write(&f, "class factory:\n    pass\n").unwrap();
        assert_eq!(class_in_file(&f, "factory"), Some("factory".into()));
        assert_eq!(class_in_file(&f, "missing"), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn oversized_files_are_skipped_and_counted() {
        // A file >1MB → skipped and counted into scan_errors (a big file is
        // not silently treated as having no symbols).
        let root = std::env::temp_dir().join(format!("kode-mcp-bigpy-{}", std::process::id()));
        let scripts = root.join("scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        let mut big = String::from("class Big:\n    pass\n# ");
        big.push_str(&"x".repeat(1_000_000));
        std::fs::write(scripts.join("big.py"), &big).unwrap();
        let out = search_symbols(&root, "big", 20).expect("answer");
        assert_eq!(out["count"], 0);
        assert_eq!(out["scan_errors"], 1);
        // collect_symbols skips with the same policy.
        assert!(collect_symbols(&root).is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn limit_reached_returns_results_limited() {
        let root = std::env::temp_dir().join(format!("kode-mcp-lim-{}", std::process::id()));
        let scripts = root.join("scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(
            scripts.join("a.py"),
            "class Alpha:\n    pass\nclass Beta:\n    pass\n",
        )
        .unwrap();
        let out = search_symbols(&root, "a", 1).expect("answer");
        assert_eq!(out["count"], 1);
        assert_eq!(out["results_limited"], true);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn instance_class_in_source_skips_bare_inst_and_matches_real_assignment() {
        // A bare `inst` line (identifier to end of line) is not
        // misidentified; a later real assignment in the same source still
        // matches.
        assert_eq!(
            instance_class_in_source("inst\ninst = Weapon()\n", "inst"),
            Some("Weapon".to_string())
        );
        // A source with no assignment shape at all → None.
        assert_eq!(instance_class_in_source("x = 1\n", "inst"), None);
    }

    #[test]
    fn find_instance_class_skips_oversized_files() {
        // Files over 1MB are skipped by the read cap; assignments inside them
        // are not reported as hits (no false positives).
        let root = std::env::temp_dir().join(format!("kode-mcp-inst-over-{}", std::process::id()));
        let scripts = root.join("scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        let mut big = String::from("inst = Weapon()\n");
        big.push_str(&"x".repeat(1_000_001));
        std::fs::write(scripts.join("big.py"), &big).unwrap();
        assert_eq!(find_instance_class(&root, "inst"), None);
        std::fs::remove_dir_all(&root).ok();
    }
}
