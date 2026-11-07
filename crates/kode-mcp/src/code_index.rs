//! 代码符号索引(KODE-MCP-KB-001 ⑦):`search_symbols` 工具。
//!
//! 复用 kode-python 的 AST 符号抽取(与 kode-server 的 Python 分析面同一
//! 解析器,不另立启发式)在 `{root}/scripts` 下建符号索引:类 / 模块级
//! 函数 / 方法,每条带 file:line。答「代码里某个符号在哪定义」。
//!
//! 边界(诚实):只索引 `scripts/`(KBEngine 脚本域),跳过 def/资源/噪音
//! 目录;文件数封顶、单文件读上限 1MB;名字大小写不敏感子串检索,给
//! file/line/kind/class(方法所属类),不整篇回传。调用图/数据流查询未
//! 纳入本面(kode-python 有 extract_call_graph,另立查询再评估)。
//!
//! 行号约定:kode-python 的 `line_col` 是 0 基;本面在 MCP 边界显式 +1
//! 转 1 基(与 def/XML 目录 file:line 一致,如 kbengine_defaults.xml:618),
//! 让 agent 能直接跳转编辑器行号。

use std::path::{Path, PathBuf};

use kode_python::symbols::parse_ast_symbols;
use serde_json::{json, Value};

const MAX_FILES: usize = 5000;
const MAX_FILE_BYTES: u64 = 1_000_000;
const SKIP_DIRS: &[&str] = &[
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

/// 符号条目(类/函数/方法统一形;MCP 面输出用,语义模型复用)。
#[derive(Debug, Clone)]
pub struct PySymbol {
    pub name: String,
    pub kind: &'static str,
    pub class: Option<String>,
    pub file: PathBuf,
    pub line: usize,
}

/// `{root}/scripts` 下递归收集 `.py`(有界)。
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

/// kode-python 0 基行号 → MCP 1 基行号(与 def/XML file:line 惯例一致)。
fn to_one_based(line: usize) -> usize {
    line + 1
}

/// 收集一个文件的所有符号(类 + 模块级函数 + 方法)。
fn symbols_of(file: &Path, source: &str) -> Vec<PySymbol> {
    let extraction = parse_ast_symbols(source);
    let mut out = Vec::new();
    for class in &extraction.symbols.classes {
        out.push(PySymbol {
            name: class.name.clone(),
            kind: "class",
            class: None,
            file: file.to_path_buf(),
            line: to_one_based(class.start_line),
        });
        for method in &class.methods {
            out.push(PySymbol {
                name: method.name.clone(),
                kind: "method",
                class: Some(class.name.clone()),
                file: file.to_path_buf(),
                line: to_one_based(method.line),
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
        });
    }
    out
}

/// 全量 Python 符号表:`{root}/scripts` 下所有 `.py` 的类/函数/方法
/// (有界:文件数封顶、单文件 1MB)。语义模型(find_symbol/implementedBy)
/// 与 search_symbols 共用同一抽取,保证一致性。
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

/// `{root}/scripts` 下按模块名(文件 stem,大小写敏感)定位 `.py`。
/// implementedBy 的 `MODULE.Class` 形态需要按模块名找实现文件。
pub fn find_module(root: &Path, module: &str) -> Option<PathBuf> {
    collect_py(root)
        .into_iter()
        .find(|f| f.file_stem().and_then(|s| s.to_str()) == Some(module))
}

/// 单个源文件里扫 `inst = Class()` 实例赋值,返回类名。
pub fn instance_class_in_source(source: &str, inst: &str) -> Option<String> {
    for line in source.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix(inst) else {
            continue;
        };
        let rest = rest.trim_start();
        if !rest.starts_with('=') {
            continue;
        }
        let after = rest.trim_start_matches('=').trim_start();
        // `Class(...)` → 取标识符。
        let class = after
            .split('(')
            .next()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_'))?;
        if !class.starts_with(|c: char| c.is_ascii_digit()) {
            return Some(class.to_string());
        }
    }
    None
}

/// 全 `{root}/scripts` 下扫 `inst = Class()` 实例赋值(有界:文件数封顶、
/// 单文件 1MB)。implementedBy 被 parser 归一为对象名(丢模块前缀)时,
/// 只能全量扫对象名;按对象名命中是唯一判据,不歧义地取首个。
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

/// `search_symbols`:在 `{root}/scripts` 的 `.py` 里按名字(大小写不敏感
/// 子串)查符号,返回 {name,kind,class,file,line}。空 query → Err;无命中
/// → 空集如实;limit 缺省 20。
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
        // "account" 命中类名 Account 与方法 login? login 不含 account →
        // 只类命。大小写不敏感子串:Account→account 命中。
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
}
