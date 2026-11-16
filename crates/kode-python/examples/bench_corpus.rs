//! 引擎源码全量自动索引成本基准(RUST-294 / ADR-107 反事实臂)。
//!
//! 走给定根下全部 `.py`(确定性排序),逐文件 ruff 容错解析
//! ([`kode_python::ParsedAst::new`],与生产同入口),报:
//! 文件数 / 字节 / 墙钟 / 含语法错误文件数 / 吞吐。
//! 另报排除 `node_modules`/`.git`/`target`/`vcpkg*` 后的源码口径(两口径
//! 分列,预算论证用),不做任何索引范围假设——「全量」与「源码口径」都是
//! 实测,不是推断。
//!
//! 用法:`cargo run -p kode-python --release --example bench_corpus -- <root>`
//! 决策档:`docs/kode2/adr/ADR-107-engine-source-index-scope.md`。

use std::path::{Path, PathBuf};
use std::time::Instant;

fn collect_py_roots(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut children: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        children.sort();
        for p in children {
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().map(|e| e == "py").unwrap_or(false) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

fn is_build_artifact(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        matches!(
            s.as_ref(),
            "node_modules" | ".git" | "target" | ".venv" | "venv"
        ) || s.starts_with("vcpkg")
    })
}

fn main() {
    let root = std::env::args()
        .nth(1)
        .expect("usage: bench_corpus <engine-root>");
    let root = PathBuf::from(root);
    let all = collect_py_roots(&root);
    let scoped: Vec<_> = all
        .iter()
        .filter(|p| !is_build_artifact(p))
        .cloned()
        .collect();

    for (label, files) in [("全树口径", &all), ("源码口径(排除构建产物)", &scoped)] {
        let t0 = Instant::now();
        let mut bytes = 0u64;
        let mut err_files = 0usize;
        let mut err_count = 0usize;
        for f in files.iter() {
            let Ok(text) = std::fs::read_to_string(f) else {
                continue;
            };
            bytes += text.len() as u64;
            let ast = kode_python::ParsedAst::new(text);
            let n = ast.errors().len();
            if ast.has_syntax_errors() {
                err_files += 1;
                err_count += n;
            }
        }
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let mb = bytes as f64 / (1024.0 * 1024.0);
        let throughput = if ms > 0.0 { mb / (ms / 1000.0) } else { 0.0 };
        println!(
            "{label}: files={} bytes={bytes}({mb:.1}MiB) wall={ms:.1}ms \
             syntax_err_files={err_files} syntax_errs={err_count} \
             throughput={throughput:.1}MiB/s",
            files.len(),
        );
    }
}
