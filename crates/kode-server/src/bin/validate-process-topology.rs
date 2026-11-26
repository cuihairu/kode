//! Process topology CI interception (C-17): runs the definition-time mismatch
//! pre-warning over a given workspace directory; any finding is printed and
//! exits 1 (CI gate), zero findings / no manifest exits 0.
//!
//! Usage: `validate-process-topology [workspace-dir]` (defaults to the current
//! directory). Inputs: <dir>/process_topology.xml (absent -> silent zero
//! findings), <dir>/scripts/entities.xml (optional), <dir>/scripts/**/*.def
//! (recursive, classified entity/interface/component by directory).

use std::path::{Path, PathBuf};

use kode_server::process_topology::{validate_process_topology, DefInput};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let manifest = dir.join("process_topology.xml");
    if !manifest.is_file() {
        // No manifest = the feature is not enabled: silent zero findings (no false positives).
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

/// Recursively collect every `.def` under `<scripts>`, classified by its directory.
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

/// Classify def by scripts subdirectory (the closure walk uses `category` to decide entity precedence).
fn classify(path: &Path) -> String {
    let parent = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str());
    match parent {
        Some("entity_defs") => "entity".into(),
        Some("interfaces") => "interface".into(),
        Some("components") => "component".into(),
        _ => "other".into(),
    }
}
