//! Bounded workspace anchor scan for the extension's discovery workflow.
use std::path::Path;

use serde_json::{json, Value};

use crate::rpc::RpcRegistry;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/workspace/scanAnchors", scan_anchors);
}

fn scan_anchors(params: Value) -> Result<Value, String> {
    let root = params
        .get("root")
        .and_then(Value::as_str)
        .ok_or("missing root")?;
    let root = Path::new(root);
    if !root.is_absolute() || !root.is_dir() {
        return Err("workspace root must be an existing absolute directory".into());
    }
    let scan = kode_root::scan_workspace_anchors(root, &kode_root::ScanOptions::default());
    let paths = |values: &[std::path::PathBuf]| -> Vec<String> {
        values
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    };
    Ok(json!({
        "entityDefs": paths(&scan.entity_defs),
        "entitiesXml": paths(&scan.entities_xml),
        "typesXml": paths(&scan.types_xml),
        "kbeSourceRoots": paths(&scan.kbe_source_roots),
        "messagesXml": paths(&scan.messages_xml),
        "configRoots": paths(&scan.config_roots),
        "scanVisited": scan.scan_visited,
        "scanTruncated": scan.scan_truncated,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_real_fixture_and_rejects_bad_root() {
        let root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../kode-root/tests/fixtures/linux_assets");
        let result = scan_anchors(json!({ "root": root.to_string_lossy() })).unwrap();
        assert!(!result["entityDefs"].as_array().unwrap().is_empty());
        assert!(result["scanVisited"].as_u64().unwrap() > 0);
        assert!(scan_anchors(json!({ "root": "relative" })).is_err());
    }
}
