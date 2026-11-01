//! 进程拓扑 CI 拦截(C-17):对给定 workspace 目录跑定义期错配预警,任一发现
//! 打印并 exit 1(CI 门禁),零发现/无清单 exit 0。
//!
//! 用法:`validate-process-topology [workspace-dir]`(缺省=当前目录)。
//! 输入:<dir>/process_topology.xml(缺省→静默零发现)、<dir>/scripts/entities.xml
//! (可选)、<dir>/scripts/**/*.def(递归,按目录归类 entity/interface/component)。

use std::path::{Path, PathBuf};

use kode_server::process_topology::{validate_process_topology, DefInput};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let manifest = dir.join("process_topology.xml");
    if !manifest.is_file() {
        // 无清单=功能未启用,静默零发现(零误报)。
        return;
    }
    let manifest_text = read(&manifest);
    let entities_path = dir.join("scripts").join("entities.xml");
    let entities_text = entities_path.is_file().then(|| read(&entities_path));
    let defs = collect_defs(&dir.join("scripts"));
    let findings = validate_process_topology(&manifest_text, entities_text.as_deref(), defs);
    if findings.is_empty() {
        println!("process_topology: ok");
        return;
    }
    for f in &findings {
        eprintln!(
            "[{code}] {}:{}: {message}",
            f.file_path,
            f.line,
            message = f.message,
            code = f.code,
        );
    }
    std::process::exit(1);
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        eprintln!("error reading {}: {e}", path.display());
        std::process::exit(2);
    })
}

/// 递归收集 `<scripts>` 下全部 `.def`,按所在目录归类。
fn collect_defs(scripts: &Path) -> Vec<DefInput> {
    let mut out = Vec::new();
    if scripts.is_dir() {
        walk(scripts, &mut out);
    }
    out
}

fn walk(dir: &Path, out: &mut Vec<DefInput>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("def") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let category = classify(&path);
        out.push(DefInput {
            name,
            category,
            file_path: path.to_string_lossy().into_owned(),
            text: std::fs::read_to_string(&path).unwrap_or_default(),
        });
    }
}

/// 按 scripts 子目录归类 def(闭包走查用 category 决定实体优先)。
fn classify(path: &Path) -> String {
    let parent = path.parent().and_then(|p| p.file_name()).and_then(|s| s.to_str());
    match parent {
        Some("entity_defs") => "entity".into(),
        Some("interfaces") => "interface".into(),
        Some("components") => "component".into(),
        _ => "other".into(),
    }
}
