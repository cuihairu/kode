//! KODE-CFG-005: config-derived RPC face (`$/kode/config/derive`).
//!
//! The consumer side (TS `src/configDerive.ts` → `src/scanRoots.ts`) goes
//! through the **command-level** `gate.runInRust('$/kode/config/derive')` to
//! get the derived capabilities produced by CFG-004 (def scan roots / entry
//! scripts / telnet / debug readiness). This is **orthogonal** to the serving
//! face switches: it never touches `serveFromRust` (always false), never
//! touches `kbengine.core.backend`, and does not depend on shadow mode —
//! params are passed in directly by TS (already resolved from disk: config
//! path / workspace root / entry script existence; the trees are optional —
//! the def scan root only needs path facts, only the telnet/debug faces need
//! a synthesized tree).
//!
//! The single source of truth lives in the Rust core (TS does not duplicate
//! the derivation logic); Err = malformed input shape, and TS falls back to
//! the old workspace∪assetsRoot chain as unavailable (no server kill, not
//! treated as an assertion failure).

use serde_json::{json, Map, Value};

use kode_parser::config::ConfigNode;
use kode_parser::config_derive::{
    derive_capabilities, DeriveCapabilities, DeriveFacts, EntryScriptFact,
};

use crate::rpc::RpcRegistry;

/// Registers `$/kode/config/derive`; called with one line from `ServerState::new()`.
pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/config/derive", derive_handler);
}

/// handler:params = `{ tree?, defaultsTree?, facts }` → `{ derive, diagnostics }`。
fn derive_handler(params: Value) -> Result<Value, String> {
    let custom_tree = config_node_from_json(params.get("tree"))?;
    let defaults_tree = config_node_from_json(params.get("defaultsTree"))?;
    let owned = facts_from_json(params.get("facts"))?;
    let facts = DeriveFacts {
        workspace_root: owned.workspace_root.as_deref(),
        custom_config_path: owned.custom_config_path.as_deref(),
        entry_scripts: owned.entry_scripts,
    };
    let caps = derive_capabilities(custom_tree.as_ref(), defaults_tree.as_ref(), &facts);
    let diagnostics = diagnostics_to_json(&caps);
    Ok(json!({ "derive": derive_to_json(&caps), "diagnostics": diagnostics }))
}

/// Deserializes one config tree node (mirrors TS `ConfigXmlNode`: `name/text/
/// children/sourceComments`). `null`/absent → `None` (this face has no tree,
/// e.g. a def scan root that only relies on path facts); a non-object → Err
/// (malformed shape, TS falls back). kode-parser is a zero-third-party crate
/// and cannot derive serde, so fields are converted by hand here.
fn config_node_from_json(v: Option<&Value>) -> Result<Option<ConfigNode>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(map)) => Ok(Some(node_from_map(map)?)),
        Some(other) => Err(format!(
            "tree/defaultsTree 应为对象,得到 {}",
            kind_of(other)
        )),
    }
}

fn node_from_map(map: &Map<String, Value>) -> Result<ConfigNode, String> {
    let name = map
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let text = map
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let children = match map.get("children") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Object(child) => node_from_map(child),
                other => Err(format!("children 项应为对象,得到 {}", kind_of(other))),
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(other) => return Err(format!("children 应为数组,得到 {}", kind_of(other))),
    };
    let source_comments = match map.get("sourceComments") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "sourceComments 项应为字符串".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(other) => return Err(format!("sourceComments 应为数组,得到 {}", kind_of(other))),
    };
    Ok(ConfigNode {
        name,
        text,
        children,
        source_comments,
    })
}

/// Derived facts (owns them; borrowed when constructing `DeriveFacts`).
struct OwnedFacts {
    workspace_root: Option<String>,
    custom_config_path: Option<String>,
    entry_scripts: Vec<EntryScriptFact>,
}

fn facts_from_json(v: Option<&Value>) -> Result<OwnedFacts, String> {
    let map = match v {
        None | Some(Value::Null) => return Ok(OwnedFacts::empty()),
        Some(Value::Object(map)) => map,
        Some(other) => return Err(format!("facts 应为对象,得到 {}", kind_of(other))),
    };
    let workspace_root = map
        .get("workspaceRoot")
        .and_then(Value::as_str)
        .map(str::to_string);
    let custom_config_path = map
        .get("customConfigPath")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut entry_scripts = Vec::new();
    if let Some(Value::Array(items)) = map.get("entryScripts") {
        for item in items {
            let obj = item
                .as_object()
                .ok_or_else(|| "entryScripts 项应为对象".to_string())?;
            let process = obj
                .get("process")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let module = obj
                .get("module")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let path = obj.get("path").and_then(Value::as_str).map(str::to_string);
            let exists = obj.get("exists").and_then(Value::as_bool).unwrap_or(false);
            entry_scripts.push(EntryScriptFact {
                process,
                module,
                path,
                exists,
            });
        }
    }
    Ok(OwnedFacts {
        workspace_root,
        custom_config_path,
        entry_scripts,
    })
}

impl OwnedFacts {
    fn empty() -> Self {
        OwnedFacts {
            workspace_root: None,
            custom_config_path: None,
            entry_scripts: Vec::new(),
        }
    }
}

/// Derived capabilities → JSON (camelCase, read directly by the TS consumer).
fn derive_to_json(caps: &DeriveCapabilities) -> Value {
    json!({
        "defScanRoots": {
            "roots": caps.def_scan_roots.roots,
            "fallback": caps.def_scan_roots.fallback,
            "degraded": caps.def_scan_roots.degraded,
        },
        "telnet": {
            "enabled": caps.telnet.enabled,
            "endpoints": caps.telnet.endpoints.iter().map(|e| json!({
                "component": e.component,
                "host": e.host,
                "port": e.port,
                "passwordSet": e.password_set,
            })).collect::<Vec<_>>(),
        },
        // CLONE-P5 skeleton: Rust-derived database connection profile
        // (plaintext passwords are never sent back; passwordAvailable only
        // marks encrypt=false with a non-empty config).
        "database": {
            "available": caps.database.available,
            "dbType": caps.database.db_type,
            "host": caps.database.host,
            "port": caps.database.port,
            "username": caps.database.username,
            "databaseName": caps.database.database_name,
            "characterSet": caps.database.character_set,
            "encrypt": caps.database.encrypt,
            "passwordAvailable": caps.database.password_available,
        },
        "entryScripts": caps.entry_scripts.iter().map(|s| json!({
            "process": s.process,
            "module": s.module,
            "path": s.path,
            "exists": s.exists,
        })).collect::<Vec<_>>(),
        "debug": {
            "ready": caps.debug.ready,
            "reasons": caps.debug.reasons,
        },
    })
}

/// Derived diagnostics (reasons are produced by CFG-004 as English machine
/// face copy; scope and severity are added here).
fn diagnostics_to_json(caps: &DeriveCapabilities) -> Vec<Value> {
    let mut out = Vec::new();
    if caps.def_scan_roots.degraded {
        out.push(json!({
            "scope": "defScanRoots",
            "severity": "warning",
            "message": "def scan root degraded: workspace root fallback",
        }));
    }
    if !caps.debug.ready {
        out.push(json!({
            "scope": "debug",
            "severity": "warning",
            "message": format!("debug not ready: {}", caps.debug.reasons.join("; ")),
        }));
    }
    out
}

/// JSON value kind name (used for diagnostic/error copy).
fn kind_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

// ============ KODE-CFG-009: `$/kode/config/resolve` (consumer-channel fetch port) ============
//
// params = `{ defaultsXml: string|null, customXml: string|null }` (TS only
// reads the raw text from disk, no parsing) → `{ defaultsTree, customTree,
// merged, telnetSummary, dbInterface }`. The single implementation of
// parse/merge/value-reading is kode-parser resolve_config (the TS
// parseConfigXml/mergeConfigXml/summarizeFinalTelnet/
// extractDatabaseInterfaceConfig have been retired, design §6.2 step 3).

use kode_parser::config::{
    resolve_config, DatabaseInterfaceConfig, TelnetSummaryEntry, ENGINE_DEFAULT_TELNET_PORTS,
};

/// Constant port number table (same source as ENGINE_DEFAULT_TELNET_PORTS,
/// for lookups; pub so the kode-mcp config Q&A face can reuse it, while the
/// core remains the single source of truth).
pub const ENGINE_TELNET_PORT_NUMBERS: &[(&str, i64)] = &[
    ("loginapp", 31000),
    ("dbmgr", 32000),
    ("interfaces", 33000),
    ("logger", 34000),
    ("baseapp", 40000),
    ("cellapp", 50000),
    ("bots", 51000),
];

/// Registers `$/kode/config/resolve`.
pub fn register_resolve(reg: &mut RpcRegistry) {
    reg.register("$/kode/config/resolve", resolve_handler);
}

fn resolve_handler(params: Value) -> Result<Value, String> {
    let defaults_xml = opt_xml_text(params.get("defaultsXml"), "defaultsXml")?;
    let custom_xml = opt_xml_text(params.get("customXml"), "customXml")?;
    let resolved = resolve_config(defaults_xml.as_deref(), custom_xml.as_deref());
    Ok(json!({
        "defaultsTree": resolved.defaults_tree.as_ref().map(config_node_to_json),
        "customTree": resolved.custom_tree.as_ref().map(config_node_to_json),
        "merged": resolved.merged.as_ref().map(config_node_to_json),
        "telnetSummary": resolved
            .telnet_summary
            .iter()
            .map(telnet_entry_to_json)
            .collect::<Vec<_>>(),
        // Engine hard-coded port table (single source of truth in the core;
        // the TS-side constant table has been deleted)
        "telnetDefaultPorts": telnet_default_ports_json(),
        // Reads the telnet_service section of the component config (the core
        // form of the old parseKbengineXmlTelnet)
        "customTelnet": resolved.custom_telnet.as_ref().map(|t| {
            json!({
                "port": t.port.map(json_number),
                "password": t.password,
            })
        }),
        "dbInterface": resolved.db_interface.as_ref().map(db_interface_to_json),
    }))
}

fn opt_xml_text(v: Option<&Value>, field: &str) -> Result<Option<String>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(other) => Err(format!("{field} 应为字符串或 null,得到 {}", kind_of(other))),
    }
}

/// ConfigNode → TS `ConfigXmlNode`-shaped JSON (sourceComments omitted when
/// empty, same shape as the TS optional fields).
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

/// f64 → JSON number (whole values become integers, matching the TS Number
/// output shape).
fn json_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9e15 {
        Value::Number(serde_json::Number::from(value as i64))
    } else {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

fn telnet_entry_to_json(entry: &TelnetSummaryEntry) -> Value {
    json!({
        "component": entry.component,
        "port": entry.port.map(json_number),
        "password": entry.password,
    })
}

fn db_interface_to_json(db: &DatabaseInterfaceConfig) -> Value {
    let mut map = Map::new();
    map.insert("host".into(), Value::String(db.host.clone()));
    map.insert("port".into(), json_number(db.port));
    map.insert("username".into(), Value::String(db.username.clone()));
    map.insert(
        "databaseName".into(),
        Value::String(db.database_name.clone()),
    );
    map.insert("encrypt".into(), Value::Bool(db.encrypt));
    map.insert(
        "characterSet".into(),
        Value::String(db.character_set.clone()),
    );
    if let Some(password) = &db.plain_password {
        map.insert("plainPassword".into(), Value::String(password.clone()));
    }
    Value::Object(map)
}

/// Engine hard-coded port table (single source of truth among core
/// constants) → JSON.
fn telnet_default_ports_json() -> Value {
    let mut map = Map::new();
    for component in ENGINE_DEFAULT_TELNET_PORTS.iter() {
        let port = ENGINE_TELNET_PORT_NUMBERS
            .iter()
            .find(|(name, _)| name == component)
            .map(|(_, port)| *port)
            .unwrap_or(0);
        map.insert(
            (*component).to_string(),
            Value::Number(serde_json::Number::from(port)),
        );
    }
    Value::Object(map)
}
