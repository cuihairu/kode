//! The assembler from a project directory → [`Schema`] (the disk surface; the kode-vfs read cache).

use std::path::Path;

use kode_vfs::disk::DiskCache;

use crate::layout::{self, AliasMap};
use crate::messages::{build_message_table, MessageTable};
use crate::schema::{EntityWireInfo, Schema};

/// Build options.
#[derive(Debug, Clone, Default)]
pub struct BuildOptions {
    /// §4.3 packetAlwaysContainLength (engine default false; when true, every message is modeled as
    /// variable on the wire, message_handler.cpp:173-175).
    pub packet_always_contain_length: bool,
}

/// A build failure (the project structure does not meet the minimum requirement; bad files go to
/// diagnostics rather than failing).
#[derive(Debug)]
pub struct BuildError(pub String);

impl std::fmt::Display for BuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "kbengine schema build error: {}", self.0)
    }
}
impl std::error::Error for BuildError {}

/// Builds the complete Schema from the project asset root (`kbengine_<...>_assets/`, containing
/// `scripts/entities.xml` and the like).
///
/// `engine_fixed_defaults_xml` = the verbatim engine `kbe/res/server/messages_fixed_defaults.xml`
/// (the fixed-table baseline; supplied by the caller, the crate does not bind an engine repository path).
/// When the project `res/server/messages_fixed.xml` exists it is merged in as the override segment;
/// when `kbengine.xml` / `kbengine_defaults.xml` exists, `<packetAlwaysContainLength>` is read.
pub fn build_schema_from_project(
    project_root: &Path,
    engine_fixed_defaults_xml: Option<&str>,
    opts: &BuildOptions,
) -> Result<Schema, BuildError> {
    let scripts = project_root.join("scripts");
    if !scripts.is_dir() {
        return Err(BuildError(format!(
            "not a KBEngine asset root (no scripts/ dir): {}",
            project_root.display()
        )));
    }

    let mut diagnostics: Vec<String> = Vec::new();
    let mut cache = DiskCache::new();
    let mut read = |path: &Path, acc: &mut Vec<String>| -> Option<String> {
        match cache.load(path) {
            Ok(buf) => Some(buf.text().to_string()),
            Err(e) => {
                // Diagnostics use paths relative to the project root (snapshots/logs can be compared
                // across machines).
                let shown = path.strip_prefix(project_root).unwrap_or(path);
                acc.push(format!("{}: unreadable ({e})", shown.display()));
                None
            }
        }
    };

    // ---- types.xml / alias.xml → the alias wire-type table ----
    let defs_dir = scripts.join("entity_defs");
    let types_xml = read(&defs_dir.join("types.xml"), &mut diagnostics);
    let alias_xml = read(&defs_dir.join("alias.xml"), &mut diagnostics);
    let raw = layout::collect_raw_types(
        types_xml.as_deref().unwrap_or("<root></root>"),
        alias_xml.as_deref(),
    );
    let aliases: AliasMap = layout::resolve_alias_map(&raw);

    // ---- entities.xml + *.def → the entity wire formats ----
    let entities_xml = read(&scripts.join("entities.xml"), &mut diagnostics)
        .ok_or_else(|| BuildError("scripts/entities.xml missing".into()))?;
    let registered = layout::entity_registered(&entities_xml);

    let mut load_def = |name: &str| -> Option<kode_parser::model::DefFile> {
        let path = defs_dir.join(format!("{name}.def"));
        let text = read(&path, &mut diagnostics)?;
        Some(kode_parser::model::parse_def(&text))
    };

    let mut entities = std::collections::BTreeMap::new();
    let mut missing_entities: Vec<String> = Vec::new();
    for (name, _attrs) in &registered {
        match layout::entity_wire_info(name, &mut load_def, &raw) {
            Some(info) => {
                entities.insert(name.clone(), info);
            }
            None => missing_entities.push(name.clone()),
        }
    }

    // ---- The fixed message table: engine defaults + project overrides ----
    let mut defaults_xml_text: Option<String> = engine_fixed_defaults_xml.map(str::to_string);
    if defaults_xml_text.is_none() {
        // The project res/server/messages_fixed_defaults.xml is allowed as a fallback (the engine also
        // resolves this file under res/server; when absent the table is an empty segment).
        defaults_xml_text = read(
            &project_root.join("res/server/messages_fixed_defaults.xml"),
            &mut diagnostics,
        );
    }
    let project_fixed = read(
        &project_root.join("res/server/messages_fixed.xml"),
        &mut diagnostics,
    );
    let mut messages: MessageTable = build_message_table(
        defaults_xml_text.as_deref().unwrap_or("<root></root>"),
        project_fixed.as_deref(),
    );
    if defaults_xml_text.is_none() {
        diagnostics.push(
            "engine messages_fixed_defaults.xml not provided: fixed table = project segment only"
                .into(),
        );
    }

    // ---- packetAlwaysContainLength (project configuration overrides the engine default) ----
    let mut always_len = opts.packet_always_contain_length;
    for cfg in [
        "res/server/kbengine.xml",
        "res/server/kbengine_defaults.xml",
    ] {
        if let Some(text) = read(&project_root.join(cfg), &mut diagnostics) {
            if let Some(v) = parse_truthy_tag(&text, "packetAlwaysContainLength") {
                always_len = v;
            }
        }
    }
    if always_len {
        // §4.3: every message is modeled as variable (including originally fixed ones).
        for e in &mut messages.entries {
            e.length = crate::messages::MessageLength::Variable;
        }
    }

    let schema = Schema {
        schema_version: Schema::SCHEMA_VERSION,
        engine_baseline: Schema::ENGINE_BASELINE.to_string(),
        packet_always_contain_length: always_len,
        aliases,
        entities,
        missing_entities,
        messages,
        diagnostics,
    };
    Ok(schema)
}

/// `<tag> 1|true|True </tag>` semantics (an approximation of the engine serverconfig boolean read:
/// numeric 0 = false / non-zero = true, boolean literals case-insensitive; a missing tag = None).
fn parse_truthy_tag(xml_text: &str, tag: &str) -> Option<bool> {
    let doc = kode_parser::xml::parse(xml_text, false);
    let root = doc.root()?;
    let el = doc.child_element(root, tag)?;
    let raw = doc.element(el).text(&doc).trim().to_ascii_lowercase();
    if raw.is_empty() {
        return None;
    }
    Some(raw != "0" && raw != "false" && raw != "no")
}

// Keeps the EntityWireInfo import name when unused in this file (suppresses the warning at build time).
#[allow(unused)]
fn _type_witness(_: &EntityWireInfo) {}
