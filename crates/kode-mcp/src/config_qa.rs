//! KODE-CFG-008 config Q&A face: pure-logic implementations of the three MCP
//! tools `get_final_config` / `get_entry_scripts` / `get_database_schema`
//! (asset-root disk reads + JSON shape).
//!
//! Same source as existing faces, no copying:
//! - Parse/merge/telnet/dbInterface semantics all live in kode-parser
//!   `resolve_config` (the same single source of truth as the TS
//!   `$/kode/config/resolve` consumer channel and `derive_capabilities`); the
//!   engine's hardcoded telnet port number table reuses kode-server
//!   `config_rpc`'s `ENGINE_TELNET_PORT_NUMBERS` (the core's only source of
//!   truth; no separate constant here).
//! - Database schema derivation reuses `AssetKnowledge::db_schema_preview`
//!   (same source as kode-server `$/kode/databaseSchema/build`, C-16).
//!
//! Boundary: passwords never echo values back — MCP clients are external
//! agents, honoring the CLONE-P5 stance (same as the derive face):
//! `dbInterface` only gives connection elements + a `passwordAvailable` flag,
//! with the plaintext password left empty. Disk-read tolerance: a missing
//! single file is honestly recorded as `missing`, no panic.

use std::path::{Path, PathBuf};

use kode_parser::config::{resolve_config, ConfigNode, ENGINE_DEFAULT_TELNET_PORTS};
use kode_server::config_rpc::ENGINE_TELNET_PORT_NUMBERS;
use serde_json::{json, Map, Value};

use crate::kb::AssetKnowledge;

/// Engine-root ancestor-lookup depth cap (walking up from the asset root to find a `<tier>/kbe/res/server/` fallback).
const ENGINE_ROOT_LOOKUP_DEPTH: usize = 4;

/// Engine `KBE_RES_PATH` env var name (same reading as resmgr.cpp `Resmgr::initialize`).
const KBE_RES_PATH_ENV: &str = "KBE_RES_PATH";

/// Splits `KBE_RES_PATH` into search segments per the engine's load semantics
/// (resmgr.cpp `updatePaths`: initially split on `;`; on non-Windows with fewer
/// than 2 segments switch to `:`, Windows keeps `;` so drive letters are not
/// cut apart). Empty segments dropped, trailing `/` appended (matching the
/// engine's `respaths_`).
fn split_res_path(raw: &str) -> Vec<String> {
    let mut segments: Vec<String> = if raw.contains(';') {
        raw.split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    } else if raw.contains(':') {
        raw.split(':')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    } else if !raw.trim().is_empty() {
        vec![raw.trim().to_string()]
    } else {
        Vec::new()
    };
    for seg in segments.iter_mut() {
        if !seg.ends_with('/') {
            seg.push('/');
        }
    }
    segments
}

/// Same reading as the engine's `matchRes` (resmgr.cpp:194-212): joins the `res`
/// relative path against the `KBE_RES_PATH` segment order, a hit on `is_file`
/// wins, returns the **first hit**. Env var unset / no hit → None (the caller
/// falls back to the asset root / ancestor lookup; nothing is fabricated).
fn match_res_path(relative: &str) -> Option<PathBuf> {
    let raw = std::env::var(KBE_RES_PATH_ENV).ok()?;
    let segments = split_res_path(&raw);
    for seg in &segments {
        let fpath = PathBuf::from(format!("{seg}{relative}"));
        if fpath.is_file() {
            return Some(fpath);
        }
    }
    None
}

/// Component config location: an engine `KBE_RES_PATH` hit wins (same reading as
/// `matchRes("server/kbengine.xml")`); env unset / no hit → asset root
/// `{root}/res/server/kbengine.xml` (matching the extension side's
/// `resolveCustomConfigXmlPath` asset-root semantics).
fn custom_config_path(root: &Path) -> PathBuf {
    match_res_path("server/kbengine.xml")
        .unwrap_or_else(|| root.join("res").join("server").join("kbengine.xml"))
}

/// Engine defaults location: an engine `KBE_RES_PATH` hit wins (same reading as
/// `matchRes("server/kbengine_defaults.xml")`, the engine `kbe/res/server/`
/// segment comes first); env unset / no hit → fallbacks: 1. the asset root's own
/// `{root}/res/server/` copy; 2. walking up from the asset root ≤4 tiers to a
/// `<tier>/kbe/res/server/kbengine_defaults.xml` (typical layout: `<ws>/assets`
/// and `<ws>/kbe` as siblings).
/// Not found → None (honest `null`; never assumes defaults exist).
fn defaults_config_path(root: &Path) -> Option<PathBuf> {
    if let Some(found) = match_res_path("server/kbengine_defaults.xml") {
        return Some(found);
    }
    let local = root
        .join("res")
        .join("server")
        .join("kbengine_defaults.xml");
    if local.is_file() {
        return Some(local);
    }
    let mut ancestor = Some(root);
    for _ in 0..ENGINE_ROOT_LOOKUP_DEPTH {
        let Some(dir) = ancestor else { break };
        let candidate = dir
            .join("kbe")
            .join("res")
            .join("server")
            .join("kbengine_defaults.xml");
        if candidate.is_file() {
            return Some(candidate);
        }
        ancestor = dir.parent();
    }
    None
}

fn read_opt(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// ConfigNode → JSON (same shape as kode-server config_rpc `config_node_to_json`:
/// sourceComments omitted when empty, same as the TS optional field).
fn config_node_to_json(node: &ConfigNode) -> Value {
    let children: Vec<Value> = node.children.iter().map(config_node_to_json).collect();
    let mut map = Map::new();
    map.insert("name".into(), Value::String(node.name.clone()));
    map.insert("text".into(), Value::String(node.text.clone()));
    map.insert("children".into(), Value::Array(children));
    if !node.source_comments.is_empty() {
        map.insert(
            "sourceComments".into(),
            Value::Array(
                node.source_comments
                    .iter()
                    .map(|c| Value::String(c.clone()))
                    .collect(),
            ),
        );
    }
    Value::Object(map)
}

/// f64 → JSON number (integral values become integers, same reading as config_rpc `json_number`).
fn json_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9e15 {
        Value::Number(serde_json::Number::from(value as i64))
    } else {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// Engine hardcoded telnet port table → `{component: port}` (the number table's source of truth is kode-server).
fn telnet_default_ports_json() -> Value {
    let mut map = Map::new();
    for component in ENGINE_DEFAULT_TELNET_PORTS.iter() {
        let port = ENGINE_TELNET_PORT_NUMBERS
            .iter()
            .find(|(name, _)| name == component)
            .map(|(_, port)| *port)
            .unwrap_or(0);
        map.insert((*component).to_string(), json!(port));
    }
    Value::Object(map)
}

/// dbmgr database interface connection elements → JSON (CLONE-P5 stance: the password value is never echoed back).
fn db_interface_json(db: &kode_parser::config::DatabaseInterfaceConfig) -> Value {
    json!({
        "host": db.host,
        "port": json_number(db.port),
        "username": db.username,
        "databaseName": db.database_name,
        "encrypt": db.encrypt,
        "characterSet": db.character_set,
        // The plaintext password is never handed to MCP clients; when encrypt=false
        // and the config is non-empty a flag stands in for the value.
        "password": Value::Null,
        "passwordAvailable": db.plain_password.is_some(),
    })
}

/// First name-matching subtree in document order (DFS; same semantics as
/// kode-parser first_node; here it only reads the already-parsed tree and does
/// not duplicate parsing semantics).
fn first_node<'a>(node: &'a ConfigNode, name: &str) -> Option<&'a ConfigNode> {
    node.children
        .iter()
        .find(|child| child.name == name)
        .or_else(|| {
            node.children
                .iter()
                .find_map(|child| first_node(child, name))
        })
}

/// Leaf value read (non-empty after trim).
fn leaf_text(node: &ConfigNode, name: &str) -> Option<String> {
    first_node(node, name)
        .map(|child| child.text.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Password redaction: any node named `password` in the tree gets its value
/// replaced by a placeholder (MCP clients are external agents; the CLONE-P5
/// stance closes this fully — not just the dbInterface field, the `<password>`
/// leaves in the synthesized tree likewise never leak; structure/source
/// comments are kept so consumers can still see "a password is configured
/// here").
fn redact_node(node: &ConfigNode) -> ConfigNode {
    let mut out = node.clone();
    if out.name == "password" && !out.text.trim().is_empty() {
        out.text = "[redacted]".to_string();
    }
    out.children = out.children.iter().map(redact_node).collect();
    out
}

/// `get_final_config`: parses the component config (+ optional same-tree
/// defaults) and answers in one shot with the synthesized trees / telnet summary
/// / engine hardcoded port table / database connection elements. Password values
/// are redacted across the whole tree (both `<password>` leaves in the tree and
/// the telnet side surface a placeholder / boolean flag).
pub fn final_config(root: &Path) -> Value {
    let custom_path = custom_config_path(root);
    let defaults_path = defaults_config_path(root);
    let custom_text = read_opt(&custom_path);
    let defaults_text = defaults_path.as_deref().and_then(read_opt);
    let resolved = resolve_config(defaults_text.as_deref(), custom_text.as_deref());
    let mut notes: Vec<String> = Vec::new();
    if custom_text.is_none() {
        notes.push(format!(
            "component config not found: {}",
            custom_path.display()
        ));
    }
    if defaults_text.is_none() {
        notes.push(
            "engine defaults xml not present (asset root res/server/ nor any ".to_string()
                + "ancestor kbe/res/server/); values below are the component "
                + "side only; engine default telnet ports come from the "
                + "built-in table",
        );
    }
    json!({
        "configPath": custom_path.to_string_lossy(),
        "defaultsPath": defaults_path.as_ref().map(|p| Value::String(p.to_string_lossy().into_owned())).unwrap_or(Value::Null),
        "customTree": resolved.custom_tree.as_ref().map(|t| config_node_to_json(&redact_node(t))),
        "merged": resolved.merged.as_ref().map(|t| config_node_to_json(&redact_node(t))),
        "telnetSummary": resolved.telnet_summary.iter().map(|e| json!({
            "component": e.component,
            "port": e.port.map(json_number),
            "passwordSet": e.password.is_some(),
        })).collect::<Vec<_>>(),
        "telnetDefaultPorts": telnet_default_ports_json(),
        "customTelnet": resolved.custom_telnet.as_ref().map(|t| json!({
            "port": t.port.map(json_number),
            "passwordSet": t.password.is_some(),
        })),
        "dbInterface": resolved.db_interface.as_ref().map(db_interface_json),
        "notes": notes,
    })
}

/// Component → `scripts/` role directory sequence (official python_assets template
/// reading; both singular/plural `interface` spellings are accepted, plural first
/// matching the TS `INTERFACE_SCRIPT_FOLDERS` order).
const COMPONENT_SCRIPT_DIRS: &[(&str, &[&str])] = &[
    ("baseapp", &["base"]),
    ("cellapp", &["cell"]),
    ("loginapp", &["login"]),
    ("dbmgr", &["db"]),
    ("interfaces", &["interfaces", "interface"]),
    ("logger", &["logger"]),
    ("bots", &["bots"]),
];

/// Engine default for the entry script module name (entryScriptFile defaults to kbemain).
const DEFAULT_ENTRY_MODULE: &str = "kbemain";

/// Reads the `<{component}><entryScriptFile>` override from the config tree
/// (merged, or the component side when defaults are absent).
fn entry_module_override(tree: Option<&ConfigNode>, component: &str) -> Option<String> {
    let section = first_node(tree?, component)?;
    leaf_text(section, "entryScriptFile")
}

/// `get_entry_scripts`: one entry-script fact (module / path / exists) per
/// server component + one for the shared engine wrapper script (same convention
/// as CFG-006's TS `findEngineEntryScript`: `scripts/kbengine.py`). Path/existence
/// read honestly from disk; nothing prefilled or guessed.
pub fn entry_scripts(root: &Path) -> Value {
    let custom_text = read_opt(&custom_config_path(root));
    let defaults_text = defaults_config_path(root).as_deref().and_then(read_opt);
    let resolved = resolve_config(defaults_text.as_deref(), custom_text.as_deref());
    // entryScriptFile is an engine defaults key: query the merged tree when
    // present, else the component side.
    let tree = resolved.merged.as_ref().or(resolved.custom_tree.as_ref());

    let scripts_dir = root.join("scripts");
    let mut facts: Vec<Value> = COMPONENT_SCRIPT_DIRS
        .iter()
        .map(|(component, dirs)| {
            let module = entry_module_override(tree, component)
                .unwrap_or_else(|| DEFAULT_ENTRY_MODULE.to_string());
            // Directory sequence: prefer the directory that actually holds
            // `{module}.py` (when both singular/plural interface directories exist,
            // the file decides); if neither has it, fall back to the first existing
            // directory, then to the first directory with an honest exists:false
            // (consumers get a "missing" diagnosis, same as the TS derived stance).
            let dir = dirs
                .iter()
                .find(|d| scripts_dir.join(d).join(format!("{module}.py")).is_file())
                .or_else(|| dirs.iter().find(|d| scripts_dir.join(d).is_dir()))
                .unwrap_or(&dirs[0]);
            let path = scripts_dir.join(dir).join(format!("{module}.py"));
            let exists = path.is_file();
            json!({
                "process": component,
                "module": module,
                "path": path.to_string_lossy(),
                "exists": exists,
            })
        })
        .collect();

    // Shared engine entry wrapper script (the debugpy injection point; same single fact as TS CFG-006).
    let wrapper = scripts_dir.join("kbengine.py");
    facts.push(json!({
        "process": "baseapp",
        "module": "kbengine",
        "path": wrapper.to_string_lossy(),
        "exists": wrapper.is_file(),
    }));

    json!({ "scriptsRoot": scripts_dir.to_string_lossy(), "entryScripts": facts })
}

/// `get_database_schema`: the schema Q&A face over the C-16 same-source derivation
/// (kode-server databaseSchema/build). Returns each entity's table set + a
/// table-name index + def source references; entity defaults to all entities.
/// Unknown entity name → Err (same error face as db_schema_preview).
pub fn database_schema(knowledge: &AssetKnowledge, entity: Option<&str>) -> Result<Value, String> {
    let preview = knowledge.db_schema_preview(entity)?;
    let mut table_index = Map::new();
    if let Some(tables) = preview.get("tables").and_then(Value::as_array) {
        for table in tables {
            if let Some(name) = table.get("name").and_then(Value::as_str) {
                table_index.insert(name.to_string(), table.clone());
            }
        }
    }
    let entities: Vec<String> = {
        let mut names: Vec<String> = knowledge
            .defs
            .iter()
            .filter(|(_, def)| def.category == "entity")
            .map(|(name, _)| name.clone())
            .collect();
        names.sort();
        names
    };
    Ok(json!({
        "entity": entity,
        "entities": entities,
        "tables": preview.get("tables").cloned().unwrap_or(Value::Array(vec![])),
        "tableIndex": Value::Object(table_index),
        "errors": preview.get("errors").cloned().unwrap_or(Value::Array(vec![])),
        "source": "defs via kode-server $/kode/databaseSchema/build (C-16 same source)",
    }))
}

/// Walks a dotted path to the target node (skipping the `<root>`/`<defaults>`
/// document-element wrapper; directory keys are all relative paths without the
/// wrapper). A segment miss → None.
fn node_at<'a>(tree: Option<&'a ConfigNode>, key: &str) -> Option<&'a ConfigNode> {
    let mut current = tree?;
    if current.name.is_empty() && current.children.len() == 1 {
        current = &current.children[0];
    }
    for segment in key.split('.') {
        if segment.is_empty() {
            continue;
        }
        current = current.children.iter().find(|c| c.name == segment)?;
    }
    Some(current)
}

/// Node → value shape: leaves take the trimmed text; containers honestly list
/// child key names; empty nodes → null.
fn node_value(node: &ConfigNode) -> Value {
    let text = node.text.trim();
    if !text.is_empty() {
        return Value::String(text.to_string());
    }
    if node.children.is_empty() {
        return Value::Null;
    }
    let names: Vec<&str> = node.children.iter().map(|c| c.name.as_str()).collect();
    Value::String(format!(
        "section with {} child key(s): {}",
        node.children.len(),
        names.join(", ")
    ))
}

/// `why_setting`: answers a given config key with "value + meaning in Chinese and
/// English + file:line origin".
///
/// Value = the leaf value along the dotted path in the resolve_config effective
/// tree (merged, or the component side when defaults are absent); meaning in
/// Chinese and English + origin = curated entries from the engine defaults
/// catalog (serverConfigCatalog, via the config_catalog snapshot); the origin is
/// the authoritative file:line (e.g. `kbe/res/server/kbengine_defaults.xml:618`),
/// plus the parsed tree node's sourceComments (original bilingual comments) as
/// cross-corroboration. Key not in the catalog → found:false honestly (the value
/// is still parsed; meaning/origin left empty, nothing fabricated). Key in the
/// tree but not a leaf → the value lists child key names.
pub fn why_setting(root: &Path, key: &str) -> Result<Value, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("empty config key".to_string());
    }
    let custom_path = custom_config_path(root);
    let defaults_path = defaults_config_path(root);
    let custom_text = read_opt(&custom_path);
    let defaults_text = defaults_path.as_deref().and_then(read_opt);
    let resolved = resolve_config(defaults_text.as_deref(), custom_text.as_deref());
    let tree = resolved.merged.as_ref().or(resolved.custom_tree.as_ref());
    let node = node_at(tree, key);

    let doc = crate::config_catalog::find_doc(key);
    let mut out = Map::new();
    out.insert("key".into(), Value::String(key.to_string()));
    out.insert("value".into(), node.map(node_value).unwrap_or(Value::Null));
    out.insert(
        "sourceComments".into(),
        Value::Array(
            node.map(|n| {
                n.source_comments
                    .iter()
                    .map(|c| Value::String(c.clone()))
                    .collect()
            })
            .unwrap_or_default(),
        ),
    );
    match doc {
        Some(d) => {
            out.insert("found".into(), json!(true));
            out.insert("meaningZh".into(), Value::String(d.zh.to_string()));
            out.insert("meaningEn".into(), Value::String(d.en.to_string()));
            out.insert("origin".into(), Value::String(d.source.to_string()));
            out.insert("group".into(), Value::String(d.group.to_string()));
        }
        None => {
            out.insert("found".into(), json!(false));
            out.insert("meaningZh".into(), Value::Null);
            out.insert("meaningEn".into(), Value::Null);
            out.insert("origin".into(), Value::Null);
            out.insert("group".into(), Value::Null);
        }
    }
    out.insert(
        "configPath".into(),
        Value::String(custom_path.to_string_lossy().into_owned()),
    );
    out.insert(
        "defaultsPath".into(),
        defaults_path
            .as_ref()
            .map(|p| Value::String(p.to_string_lossy().into_owned()))
            .unwrap_or(Value::Null),
    );
    Ok(Value::Object(out))
}

/// `list_config_settings`: the full set of engine defaults catalog entries (each
/// config item's meaning in Chinese and English + authoritative file:line origin
/// + group), optionally filtered by group / prefix; each item carries its
///
/// Effective value (resolved from the resolve_config effective tree, null when
/// absent). Answers "what each XML config option means". Unknown group name →
/// empty set honestly (with the available groups listed), no error.
pub fn list_config_settings(root: &Path, group: Option<&str>, prefix: Option<&str>) -> Value {
    let custom_path = custom_config_path(root);
    let defaults_path = defaults_config_path(root);
    let custom_text = read_opt(&custom_path);
    let defaults_text = defaults_path.as_deref().and_then(read_opt);
    let resolved = resolve_config(defaults_text.as_deref(), custom_text.as_deref());
    let tree = resolved.merged.as_ref().or(resolved.custom_tree.as_ref());

    let mut group_counts: Map<String, Value> = Map::new();
    let mut settings: Vec<Value> = Vec::new();
    for (key, doc) in crate::config_catalog::SERVER_CONFIG_ITEM_DOCS {
        *group_counts
            .entry(doc.group.to_string())
            .or_insert_with(|| json!(0)) = {
            let n = group_counts
                .get(doc.group)
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + 1;
            json!(n)
        };
        if let Some(g) = group {
            if doc.group != g {
                continue;
            }
        }
        if let Some(p) = prefix {
            if !key.starts_with(p) {
                continue;
            }
        }
        settings.push(json!({
            "key": key,
            "value": node_at(tree, key).map(node_value).unwrap_or(Value::Null),
            "meaningZh": doc.zh,
            "meaningEn": doc.en,
            "origin": doc.source,
            "group": doc.group,
        }));
    }
    json!({
        "count": settings.len(),
        "groupCounts": Value::Object(group_counts),
        "filter": json!({
            "group": group,
            "prefix": prefix,
        }),
        "settings": settings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// `KBE_RES_PATH` is process-global; tests touching it must run serially (to
    /// avoid cross-contamination).
    static RES_PATH_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn fixture_root() -> PathBuf {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop();
        p.pop();
        p.push("tests/fixtures/kbengine-demo-assets");
        p
    }

    fn write_config(root: &Path, name: &str, text: &str) {
        let conf = root.join("res").join("server");
        std::fs::create_dir_all(&conf).unwrap();
        std::fs::write(conf.join(name), text).unwrap();
    }

    /// Temporarily sets KBE_RES_PATH and restores the previous value on scope exit
    /// (test serialization is guaranteed by the caller's lock).
    struct ResPathEnvGuard {
        previous: Option<String>,
    }

    impl ResPathEnvGuard {
        fn set(value: &str) -> Self {
            let previous = std::env::var(KBE_RES_PATH_ENV).ok();
            // Under edition 2021, set_var/remove_var are safe functions; concurrency
            // serialization is guaranteed by the caller-held RES_PATH_ENV_LOCK (no
            // concurrent reads/writes within this process).
            std::env::set_var(KBE_RES_PATH_ENV, value);
            Self { previous }
        }
    }

    impl Drop for ResPathEnvGuard {
        fn drop(&mut self) {
            // Same as above; the lock is held for the guard's whole lifetime.
            match &self.previous {
                Some(value) => std::env::set_var(KBE_RES_PATH_ENV, value),
                None => std::env::remove_var(KBE_RES_PATH_ENV),
            }
        }
    }

    /// Unified isolation for config-parse-face tests: the parse functions
    /// (`custom_config_path` / `defaults_config_path` → `match_res_path`) read the
    /// process-level `KBE_RES_PATH`, so without isolation they cross-contaminate
    /// the two env-priority tests concurrently (cargo runs one test binary
    /// multi-threaded by default). Hold the same lock and set an empty value for
    /// the test duration — empty = no usable segment, parsing falls back to the
    /// asset root, same semantics as "env unset".
    fn config_env_isolation() -> (std::sync::MutexGuard<'static, ()>, ResPathEnvGuard) {
        let lock = RES_PATH_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        (lock, ResPathEnvGuard::set(""))
    }

    /// Same reading as the engine's `matchRes`: the first hit in `KBE_RES_PATH`
    /// segment order is taken, the asset root only serves as a fallback.
    #[test]
    fn res_path_env_takes_priority_over_asset_root() {
        let _lock = RES_PATH_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let base = std::env::temp_dir().join(format!("kode-mcp-respath-{}", std::process::id()));
        let engine_res = base.join("engine").join("kbe").join("res");
        let assets = base.join("assets");
        std::fs::create_dir_all(engine_res.join("server")).unwrap();
        std::fs::create_dir_all(assets.join("res").join("server")).unwrap();
        // Engine-segment defaults (source of truth) + asset-segment custom (overrides)
        std::fs::write(
            engine_res.join("server").join("kbengine_defaults.xml"),
            "<root><dbmgr><databaseInterfaces><default><host>engine-host</host>\
             </default></databaseInterfaces></dbmgr></root>",
        )
        .unwrap();
        std::fs::write(
            assets.join("res").join("server").join("kbengine.xml"),
            "<root><dbmgr><databaseInterfaces><default><host>asset-host</host>\
             </default></databaseInterfaces></dbmgr></root>",
        )
        .unwrap();
        // Also place a "fake" defaults under the asset root, verifying the env var
        // takes precedence over the asset root
        std::fs::write(
            assets
                .join("res")
                .join("server")
                .join("kbengine_defaults.xml"),
            "<root><dbmgr><databaseInterfaces><default><host>asset-defaults-host</host>\
             </default></databaseInterfaces></dbmgr></root>",
        )
        .unwrap();

        let res_path = format!("{}/;{}/", engine_res.display(), assets.display());
        let _env = ResPathEnvGuard::set(&res_path);
        let payload = final_config(&assets);
        // defaults comes from the engine segment (env var first), not the asset-root copy
        assert!(
            payload["defaultsPath"]
                .as_str()
                .unwrap()
                .replace('\\', "/")
                .contains("engine/kbe/res/server/kbengine_defaults.xml"),
            "defaults should hit the engine segment via KBE_RES_PATH: {}",
            payload["defaultsPath"]
        );
        // custom comes from the asset segment (engine segment has no kbengine.xml → hits the asset segment)
        assert!(
            payload["configPath"]
                .as_str()
                .unwrap()
                .replace('\\', "/")
                .contains("assets/res/server/kbengine.xml"),
            "custom should hit the asset segment via KBE_RES_PATH: {}",
            payload["configPath"]
        );
        std::fs::remove_dir_all(&base).ok();
    }

    /// When the env var is unset, fall back to the asset root / walk up to `kbe/`
    /// (the norm for standalone deployments without the env).
    #[test]
    fn without_res_path_env_falls_back_to_asset_root_and_kbe_ancestor() {
        let _lock = RES_PATH_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let base = std::env::temp_dir().join(format!("kode-mcp-fallback-{}", std::process::id()));
        let assets = base.join("assets");
        let engine_res = base.join("kbe").join("res").join("server");
        std::fs::create_dir_all(assets.join("res").join("server")).unwrap();
        std::fs::create_dir_all(&engine_res).unwrap();
        std::fs::write(
            assets.join("res").join("server").join("kbengine.xml"),
            "<root><dbmgr><databaseInterfaces><default><host>fallback-host</host>\
             </default></databaseInterfaces></dbmgr></root>",
        )
        .unwrap();
        std::fs::write(
            engine_res.join("kbengine_defaults.xml"),
            "<root><dbmgr><databaseInterfaces><default><databaseName>from-ancestor-kbe</databaseName>\
             </default></databaseInterfaces></dbmgr></root>",
        )
        .unwrap();

        let _env = ResPathEnvGuard::set(""); // empty value = no usable segment
        let payload = final_config(&assets);
        assert_eq!(payload["dbInterface"]["host"], "fallback-host");
        // Asset root has no defaults → walk up to <base>/kbe/res/server/
        assert!(
            payload["defaultsPath"]
                .as_str()
                .unwrap()
                .replace('\\', "/")
                .contains("kbe/res/server/kbengine_defaults.xml"),
            "should walk up the ancestor kbe/ to locate defaults: {}",
            payload["defaultsPath"]
        );
        std::fs::remove_dir_all(&base).ok();
    }

    /// Engine `KBE_RES_PATH` splitting: semicolon first, trailing `/` appended, empty segments dropped.
    #[test]
    fn split_res_path_matches_engine_semantics() {
        assert_eq!(
            split_res_path("/a/kbe/res/;/b/assets/"),
            vec!["/a/kbe/res/", "/b/assets/"]
        );
        // Split on colon when there is no semicolon (non-Windows engine reading)
        assert_eq!(
            split_res_path("/a/kbe/res:/b/assets"),
            vec!["/a/kbe/res/", "/b/assets/"]
        );
        // Single segment with no separator: one trimmed segment, trailing `/` appended as usual
        assert_eq!(split_res_path("/only"), vec!["/only/"]);
        assert_eq!(split_res_path("  rel "), vec!["rel/"]);
        assert!(split_res_path("   ").is_empty());
    }

    /// ResPathEnvGuard's both-side restore face: when the env var **was already
    /// set**, guard drop restores that value (rather than removing it) — the Some
    /// arm; the isolation lock is held throughout to prevent concurrent writes.
    #[test]
    fn res_path_env_guard_restores_previous_value_on_drop() {
        let _iso = config_env_isolation();
        // Preset a pre-existing value: the inner guard captures Some("/prev/") → drop restores it.
        std::env::set_var(KBE_RES_PATH_ENV, "/prev/");
        {
            let _inner = ResPathEnvGuard::set("/tmp/x/");
            assert_eq!(
                std::env::var(KBE_RES_PATH_ENV).ok().as_deref(),
                Some("/tmp/x/")
            );
        }
        assert_eq!(
            std::env::var(KBE_RES_PATH_ENV).ok().as_deref(),
            Some("/prev/"),
            "drop must restore the pre-existing value, not remove it"
        );
    }

    #[test]
    fn json_number_keeps_fraction_and_rejects_non_finite() {
        // Integral values become integers; fractions stay floats; NaN/Inf → null (never fabricate a number).
        assert_eq!(json_number(3306.0), serde_json::json!(3306));
        assert_eq!(json_number(1.5), serde_json::json!(1.5));
        assert_eq!(json_number(f64::NAN), Value::Null);
        assert_eq!(json_number(f64::INFINITY), Value::Null);
    }

    #[test]
    fn final_config_merges_defaults_and_exposes_db_interface() {
        let _iso = config_env_isolation();
        // defaults + component merged → dbInterface surfaces (the password is not given as a value, only an availability flag).
        let root = std::env::temp_dir().join(format!("kode-mcp-dbi-{}", std::process::id()));
        write_config(
            &root,
            "kbengine_defaults.xml",
            "<root>\n<dbmgr>\n<databaseInterfaces>\n<default>\n<host> 10.0.0.5 </host>\n\
             <port> 3307 </port>\n<auth>\n<username> kbe_user </username>\n\
             <encrypt> false </encrypt>\n<password> db-pass </password>\n</auth>\n\
             <unicodeString>\n<characterSet> utf8mb4 </characterSet>\n</unicodeString>\n\
             <databaseName> kbe_db </databaseName>\n</default>\n\
             </databaseInterfaces>\n</dbmgr>\n</root>\n",
        );
        write_config(
            &root,
            "kbengine.xml",
            "<root>\n<baseapp>\n<backupPeriod> 500 </backupPeriod>\n</baseapp>\n</root>\n",
        );
        let payload = final_config(&root);
        // defaultsPath has defaults → a string (not null).
        assert!(payload["defaultsPath"]
            .as_str()
            .unwrap()
            .ends_with("kbengine_defaults.xml"));
        let db = payload["dbInterface"].as_object().expect("dbInterface");
        assert_eq!(db["host"], "10.0.0.5");
        assert_eq!(db["port"], 3307);
        assert_eq!(db["username"], "kbe_user");
        assert_eq!(db["databaseName"], "kbe_db");
        assert_eq!(db["encrypt"], false);
        assert_eq!(db["characterSet"], "utf8mb4");
        // The password value is never given: an availability flag suffices.
        assert_eq!(db["password"], Value::Null);
        assert_eq!(db["passwordAvailable"], true);
        assert!(!payload.to_string().contains("db-pass"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn why_setting_reports_defaults_path_and_skips_empty_segments() {
        let _iso = config_env_isolation();
        // Dotted key has an empty segment (baseapp..backupPeriod): empty segments
        // are skipped and the value parses as usual; defaults present → defaultsPath
        // is a string.
        let root = std::env::temp_dir().join(format!("kode-mcp-why-{}", std::process::id()));
        write_config(
            &root,
            "kbengine.xml",
            "<root>\n<baseapp>\n<backupPeriod> 500 </backupPeriod>\n</baseapp>\n</root>\n",
        );
        write_config(
            &root,
            "kbengine_defaults.xml",
            "<root>\n<cellapp>\n<distanceField> x </distanceField>\n</cellapp>\n</root>\n",
        );
        let out = why_setting(&root, "baseapp..backupPeriod").expect("answer");
        assert_eq!(out["value"], "500");
        assert!(out["defaultsPath"]
            .as_str()
            .unwrap()
            .ends_with("kbengine_defaults.xml"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn database_schema_builds_table_index() {
        let k = crate::kb::AssetKnowledge::load(&fixture_root());
        let out = crate::config_qa::database_schema(&k, Some("Avatar")).expect("schema");
        // Table-name index: Avatar persistent properties → at least one table indexed by name.
        let index = out["tableIndex"].as_object().expect("tableIndex");
        assert!(!index.is_empty(), "expected indexed tables for Avatar");
        let entity = out["entity"].as_str().unwrap();
        assert_eq!(entity, "Avatar");
        // Unknown name → Err (same error face as db_schema_preview).
        assert!(crate::config_qa::database_schema(&k, Some("NoSuch")).is_err());
    }

    #[test]
    fn final_config_reads_component_xml_and_reports_missing_defaults() {
        let _iso = config_env_isolation();
        let payload = final_config(&fixture_root());
        // Component config present: the dbmgr section + databaseInterfaces are readable.
        assert!(payload["customTree"].is_object(), "custom tree parsed");
        assert!(payload["merged"].is_null(), "no defaults → merged 不猜");
        assert!(payload["defaultsPath"].is_null());
        // Engine hardcoded port table: loginapp=31000 on the Q&A face.
        assert_eq!(payload["telnetDefaultPorts"]["loginapp"], 31000);
        assert_eq!(payload["telnetDefaultPorts"]["cellapp"], 50000);
        // notes honestly records the absence of defaults.
        let notes = payload["notes"].as_array().unwrap();
        assert!(notes
            .iter()
            .any(|n| n.as_str().unwrap().contains("defaults")));
    }

    #[test]
    fn final_config_on_empty_root_is_honest_not_panic() {
        let _iso = config_env_isolation();
        let payload = final_config(Path::new("/definitely/not/a/root"));
        assert!(payload["customTree"].is_null());
        assert!(payload["merged"].is_null());
        assert_eq!(payload["telnetDefaultPorts"]["dbmgr"], 32000);
        let notes = payload["notes"].as_array().unwrap();
        assert!(notes
            .iter()
            .any(|n| n.as_str().unwrap().contains("component config not found")));
    }

    #[test]
    fn final_config_redacts_passwords_everywhere() {
        let _iso = config_env_isolation();
        // A temp asset root carrying `<password>` values: telnet_service section + databaseInterfaces.
        let root = std::env::temp_dir().join(format!("kode-mcp-redact-{}", std::process::id()));
        let conf = root.join("res").join("server");
        std::fs::create_dir_all(&conf).unwrap();
        std::fs::write(
            conf.join("kbengine.xml"),
            "<root>\n<telnet_service>\n<port> 32000 </port>\n<password> s3cret-telnet </password>\n\
             </telnet_service>\n<dbmgr>\n<databaseInterfaces>\n<default>\n<host> localhost </host>\n\
             <encrypt> false </encrypt>\n<password> s3cret-db </password>\n</default>\n\
             </databaseInterfaces>\n</dbmgr>\n</root>\n",
        )
        .unwrap();
        let payload = final_config(&root);
        let text = payload.to_string();
        assert!(
            !text.contains("s3cret-telnet"),
            "telnet password leaked: {text}"
        );
        assert!(!text.contains("s3cret-db"), "db password leaked: {text}");
        // The placeholder / boolean flag surfaces honestly (structure is not lost).
        assert!(text.contains("[redacted]"));
        assert_eq!(payload["customTelnet"]["passwordSet"], true);
        assert_eq!(payload["customTelnet"]["port"], 32000);
        // db side: no defaults → merged is not guessed → dbInterface is absent, but
        // the db password lives in customTree and has been redacted (covered by the
        // !contains assertions above).
        assert!(payload["dbInterface"].is_null());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn entry_scripts_reports_module_path_exists_per_component() {
        let _iso = config_env_isolation();
        let payload = entry_scripts(&fixture_root());
        let facts = payload["entryScripts"].as_array().unwrap();
        let by_process: std::collections::BTreeMap<&str, &Value> = facts
            .iter()
            .map(|f| (f["process"].as_str().unwrap(), f))
            .collect();
        // baseapp → scripts/base/kbemain.py exists (component facts are picked
        // precisely by module; the shared wrapper script also belongs to the baseapp
        // process, so dedupe by the process key is not possible).
        let base = facts
            .iter()
            .find(|f| f["process"] == "baseapp" && f["module"] == "kbemain")
            .expect("baseapp component fact");
        assert_eq!(base["exists"], true);
        assert!(base["path"]
            .as_str()
            .unwrap()
            .replace('\\', "/")
            .ends_with("scripts/base/kbemain.py"));
        // Singular/plural interface fallback: the interfaces directory has no kbemain.py → lands on interface/.
        let interfaces = by_process["interfaces"];
        assert!(interfaces["path"]
            .as_str()
            .unwrap()
            .replace('\\', "/")
            .ends_with("scripts/interface/kbemain.py"));
        assert_eq!(interfaces["exists"], true);
        // Shared engine wrapper script: the fixture has no scripts/kbengine.py → exists:false honestly.
        let wrapper_fact = facts
            .iter()
            .find(|f| f["module"] == "kbengine")
            .expect("wrapper fact present");
        assert_eq!(wrapper_fact["process"], "baseapp");
        assert_eq!(wrapper_fact["exists"], false);
        assert!(wrapper_fact["path"]
            .as_str()
            .unwrap()
            .replace('\\', "/")
            .ends_with("scripts/kbengine.py"));
    }

    #[test]
    fn why_setting_answers_value_meaning_and_origin() {
        let _iso = config_env_isolation();
        let payload = why_setting(
            &fixture_root(),
            "dbmgr.account_system.account_registration.enable",
        )
        .expect("answer");
        // The value comes from the component side (no defaults → merge not guessed, take custom_tree).
        assert_eq!(payload["value"], "true");
        // The meaning in Chinese and English comes from the catalog (curated).
        assert_eq!(payload["found"], true);
        assert!(payload["meaningZh"].as_str().unwrap().contains("开放注册"));
        assert!(payload["meaningEn"]
            .as_str()
            .unwrap()
            .contains("registration"));
        // Origin = the authoritative file:line (the catalog's source).
        assert!(payload["origin"]
            .as_str()
            .unwrap()
            .contains("kbengine_defaults.xml"));
        assert_eq!(payload["group"], "account");
        // The parsed tree node's original bilingual comments serve as cross-corroboration.
        let comments = payload["sourceComments"].as_array().unwrap();
        assert!(
            !comments.is_empty(),
            "fixture node carries its inline comment"
        );
    }

    #[test]
    fn why_setting_unknown_key_is_found_false_not_error() {
        let _iso = config_env_isolation();
        let payload = why_setting(&fixture_root(), "no.such.key").expect("graceful");
        assert_eq!(payload["found"], false);
        assert!(payload["meaningZh"].is_null());
        assert!(payload["origin"].is_null());
        assert!(payload["value"].is_null());
    }

    #[test]
    fn why_setting_empty_key_is_error() {
        let _iso = config_env_isolation();
        assert!(why_setting(&fixture_root(), "  ").is_err());
    }

    #[test]
    fn why_setting_catalog_key_absent_in_tree_is_honest_null_value() {
        let _iso = config_env_isolation();
        // baseapp.archivePeriod is in the catalog but not configured on the component side (no defaults, not guessed).
        let payload = why_setting(&fixture_root(), "baseapp.archivePeriod").expect("answer");
        assert_eq!(payload["found"], true);
        assert!(payload["meaningZh"].as_str().unwrap().contains("存档"));
        assert!(payload["value"].is_null());
    }

    #[test]
    fn why_setting_section_key_lists_children() {
        let _iso = config_env_isolation();
        // dbmgr.account_system is a container section → the value honestly lists child key names.
        let payload = why_setting(&fixture_root(), "dbmgr.account_system").expect("answer");
        assert_eq!(payload["found"], true);
        let value = payload["value"].as_str().unwrap();
        assert!(value.starts_with("section with"));
        assert!(value.contains("account_registration"));
    }

    #[test]
    fn list_config_settings_enumerates_catalog_with_values() {
        let _iso = config_env_isolation();
        let payload = list_config_settings(&fixture_root(), None, None);
        let settings = payload["settings"].as_array().unwrap();
        assert!(settings.len() > 200, "full catalog enumerated");
        // Every item has a meaning in Chinese and English + origin + group.
        for s in settings.iter().take(50) {
            assert!(!s["meaningZh"].as_str().unwrap().is_empty());
            assert!(!s["meaningEn"].as_str().unwrap().is_empty());
            assert!(s["origin"].as_str().unwrap().contains("kbe/"));
            assert!(!s["group"].as_str().unwrap().is_empty());
        }
        // Keys configured on the component side carry their real effective value (others are null, never fabricated).
        let reg = settings
            .iter()
            .find(|s| s["key"] == "dbmgr.account_system.account_registration.enable")
            .expect("registration key present");
        assert_eq!(reg["value"], "true");
        let absent = settings
            .iter()
            .find(|s| s["key"] == "baseapp.archivePeriod")
            .expect("archive key present");
        assert!(absent["value"].is_null());
        // groupCounts covers all groups.
        assert!(payload["groupCounts"]["account"].as_u64().unwrap() > 0);
        assert_eq!(payload["count"].as_u64().unwrap() as usize, settings.len());
    }

    #[test]
    fn list_config_settings_filters_by_group_and_prefix() {
        let _iso = config_env_isolation();
        let group = list_config_settings(&fixture_root(), Some("backup"), None);
        let gs = group["settings"].as_array().unwrap();
        assert!(!gs.is_empty(), "backup group non-empty");
        assert!(gs.iter().all(|s| s["group"] == "backup"));

        let prefix = list_config_settings(&fixture_root(), None, Some("baseapp."));
        let ps = prefix["settings"].as_array().unwrap();
        assert!(!ps.is_empty());
        assert!(ps
            .iter()
            .all(|s| s["key"].as_str().unwrap().starts_with("baseapp.")));

        // Unknown group name → empty set honestly, no error.
        let none = list_config_settings(&fixture_root(), Some("no-such-group"), None);
        assert_eq!(none["count"], 0);
        assert!(none["settings"].as_array().unwrap().is_empty());
    }
}
