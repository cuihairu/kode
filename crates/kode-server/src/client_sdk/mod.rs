//! Client entity SDK generation core (`$/kode/sdk/generate`, Rust is the single
//! producer).
//!
//! Byte-for-byte parity with the old TS `src/clientSdkGenerator.ts` pure
//! producer: the same .def / types.xml input yields the same file contents. The
//! TS side keeps only disk reads (UI shell / writing) and the fallback branch
//! for when Rust is unavailable; the generation logic converges here (single
//! source = Rust).
//!
//! Input = `{ language, entities: [{name, defText}], typesXml, generatedAt,
//! engineTrace?, namespace? }`, output = `[{ fileName, content }]`. The handler
//! is a pure function (params come straight from TS, with no dependence on the
//! mirror corpus and no disk reads); a malformed def (structural error) is
//! skipped under the same criteria as TS parseClientSdkEntity -> null, and one
//! bad def does not abort the whole batch.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use kode_parser::diag::{DiagCode, LineMap};
use kode_parser::model::{flag_domains, normalize_flag_tokens};
use kode_parser::xml::{self, Document, NodeData};

use crate::rpc::RpcRegistry;

/// FIXED_DICT companion file basename (no extension; a constant shared with TS).
pub const FIXED_DICTS_BASENAME: &str = "ClientSdkFixedDicts";
/// Component type class companion file basename (no extension; a constant shared with TS).
pub const COMPONENTS_BASENAME: &str = "ClientSdkComponents";
/// Default namespace for C# output (a Unity client project can change it itself).
pub const DEFAULT_CSHARP_NAMESPACE: &str = "KbEngineClient";
/// Fixed first line of a generated file header (hand edits are overwritten on the next generation).
const GENERATED_HEADER_LINE: &str =
    "// 由 kode 客户端实体 SDK 生成器生成，手动修改会在下次生成时被覆盖";
/// Literal used when engine provenance cannot be detected (no guessing, no gap).
const TRACE_UNKNOWN: &str = "unknown";

/// Register the `$/kode/sdk/generate` handler.
pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/sdk/generate", generate_handler);
}

// ---------------------------------------------------------------------------
// Builtin type mapping (language-neutral -> target language; same table as TS TS_BUILTIN_TYPES/CS_BUILTIN_TYPES)
// ---------------------------------------------------------------------------

/// Engine builtin types -> TypeScript.
const TS_BUILTIN_TYPES: &[(&str, &str)] = &[
    ("UINT8", "number"),
    ("UINT16", "number"),
    ("UINT32", "number"),
    // IDE-AUD-063: 64-bit integers use bigint to keep the whole domain exact (number is float64 and silently loses precision from 2^53+1 on).
    ("UINT64", "bigint"),
    ("INT8", "number"),
    ("INT16", "number"),
    ("INT32", "number"),
    ("INT64", "bigint"),
    ("FLOAT", "number"),
    ("DOUBLE", "number"),
    ("STRING", "string"),
    ("UNICODE", "string"),
    ("VECTOR2", "[number, number]"),
    ("VECTOR3", "[number, number, number]"),
    ("VECTOR4", "[number, number, number, number]"),
    ("ENTITYCALL", "unknown"),
    ("PYTHON", "unknown"),
    ("PY_DICT", "unknown"),
    ("PY_TUPLE", "unknown"),
    ("PY_LIST", "unknown"),
    ("BLOB", "unknown"),
];

/// Engine builtin types -> C# (vectors default to Vector2/3/4, which Unity ships with).
const CS_BUILTIN_TYPES: &[(&str, &str)] = &[
    ("UINT8", "byte"),
    ("UINT16", "ushort"),
    ("UINT32", "uint"),
    ("UINT64", "ulong"),
    ("INT8", "sbyte"),
    ("INT16", "short"),
    ("INT32", "int"),
    ("INT64", "long"),
    ("FLOAT", "float"),
    ("DOUBLE", "double"),
    ("STRING", "string"),
    ("UNICODE", "string"),
    ("VECTOR2", "Vector2"),
    ("VECTOR3", "Vector3"),
    ("VECTOR4", "Vector4"),
    ("ENTITYCALL", "object"),
    ("PYTHON", "object"),
    ("PY_DICT", "object"),
    ("PY_TUPLE", "object"),
    ("PY_LIST", "object"),
    ("BLOB", "object"),
];

/// Engine builtin types -> Python (the skeleton stays dependency-free: vectors
/// use tuple generics and do not depend on the Vector class from the KBEngine
/// stubs; UINT64/INT64 -> int, and Python 3 int is unbounded and naturally
/// exact over the whole domain).
const PY_BUILTIN_TYPES: &[(&str, &str)] = &[
    ("UINT8", "int"),
    ("UINT16", "int"),
    ("UINT32", "int"),
    ("UINT64", "int"),
    ("INT8", "int"),
    ("INT16", "int"),
    ("INT32", "int"),
    ("INT64", "int"),
    ("FLOAT", "float"),
    ("DOUBLE", "float"),
    ("STRING", "str"),
    ("UNICODE", "str"),
    ("VECTOR2", "tuple[float, float]"),
    ("VECTOR3", "tuple[float, float, float]"),
    ("VECTOR4", "tuple[float, float, float, float]"),
    ("ENTITYCALL", "Any"),
    ("PYTHON", "Any"),
    ("PY_DICT", "dict"),
    ("PY_TUPLE", "tuple"),
    ("PY_LIST", "list"),
    ("BLOB", "bytes"),
];

/// Fallback when a builtin type name is missing (TS=unknown, C#=object, Python=Any).
fn builtin_table(language: &str) -> &'static [(&'static str, &'static str)] {
    if language == "csharp" {
        CS_BUILTIN_TYPES
    } else if language == "python" {
        PY_BUILTIN_TYPES
    } else {
        TS_BUILTIN_TYPES
    }
}

fn fallback_for(language: &str) -> &'static str {
    if language == "csharp" {
        "object"
    } else if language == "python" {
        "Any"
    } else {
        "unknown"
    }
}

// ---------------------------------------------------------------------------
// Semantic model (.def -> entity; types.xml -> type table)
// ---------------------------------------------------------------------------

struct SdkProperty {
    name: String,
    /// The `<Type>` direct text; `ARRAY` for ARRAY.
    type_name: String,
    /// The `<of>` text of ARRAY; None for non-containers.
    element_type: Option<String>,
    /// The `<Flags>` text as-is (trimmed).
    flags: String,
    /// The three domain bits (base/cell/client).
    domains: Vec<&'static str>,
}

impl SdkProperty {
    fn client_visible(&self) -> bool {
        self.domains.contains(&"client")
    }
}

struct SdkMethod {
    name: String,
    arg_types: Vec<String>,
}

/// Component slot SDK face: the slot member + the component type class (client-visible properties).
struct SdkComponent {
    slot: String,
    type_name: String,
    /// Client-visible properties (the component module itself + interfaces + parents, recursed, deduped by name keeping the first).
    properties: Vec<SdkProperty>,
}

struct SdkEntity {
    name: String,
    parent: Option<String>,
    properties: Vec<SdkProperty>,
    components: Vec<SdkComponent>,
    client_methods: Vec<SdkMethod>,
    exposed_base_methods: Vec<SdkMethod>,
    exposed_cell_methods: Vec<SdkMethod>,
}

struct FixedDictProperty {
    name: String,
    type_name: Option<String>,
    source_line: Option<usize>,
}

struct FixedDictType {
    name: String,
    source_line: Option<usize>,
    properties: Vec<FixedDictProperty>,
}

struct TypeMap {
    builtin: &'static [(&'static str, &'static str)],
    aliases: HashMap<String, String>,
    fixed_dicts: HashMap<String, FixedDictType>,
    fallback: &'static str,
    /// Target language (container/array emission shape branches by language: TS/CS `T[]`, Python `list[T]`).
    language: String,
}

struct SdkEntityInput {
    name: String,
    def_text: String,
}

/// Component def raw text table (keyed by name; the TS closure walks category 'component' and collects recursively).
type ComponentDefs = HashMap<String, String>;

struct EngineTrace {
    engine_version: String,
    engine_commit: String,
}

/// Handler input (a one-to-one match with the TS RPC contract).
struct SdkGenerateParams {
    language: String,
    entities: Vec<SdkEntityInput>,
    component_defs: ComponentDefs,
    types_xml: Option<String>,
    generated_at: String,
    engine_trace: Option<EngineTrace>,
    namespace: Option<String>,
}

// ---------------------------------------------------------------------------
// .def parsing (same criteria as TS parseClientSdkEntity / parseDefFileSemantics)
// ---------------------------------------------------------------------------

/// Structural error test: TS fxp throws on unclosed / mismatched close / stray
/// close tags -> parseClientSdkEntity returns null (skipping that def). Rust's
/// tolerant recovery does not panic, so the same class of structural error is
/// folded into "skip" here, keeping both sides' behaviour consistent.
fn is_structural_error(doc: &Document) -> bool {
    doc.diagnostics.iter().any(|diag| {
        matches!(
            diag.code,
            DiagCode::UnclosedElement
                | DiagCode::MismatchedCloseTag
                | DiagCode::StrayCloseTag
                | DiagCode::InvalidTagName
        )
    })
}

/// TS getReferenceTargetName: walk the child nodes and take the value of the
/// first non-empty trimmed text; otherwise take the name of the first element
/// child (engine criteria: `<Parent><Entity/></Parent>` -> Entity).
fn reference_target_name(doc: &Document, idx: usize) -> String {
    for &child in &doc.element(idx).children {
        match &doc.nodes[child].data {
            NodeData::Text { decoded, .. } => {
                let trimmed = decoded.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
            NodeData::Element(element) => {
                let name = element.name.trim();
                if !name.is_empty() {
                    return name.to_string();
                }
            }
            _ => {}
        }
    }
    String::new()
}

/// TS readDefTypeNode: the `<Type>` direct text plus the `<of>` text, in two columns.
fn read_def_type_node(doc: &Document, type_idx: Option<usize>) -> (String, Option<String>) {
    let Some(idx) = type_idx else {
        return (String::new(), None);
    };
    let element = doc.element(idx);
    let type_name = element.text(doc).trim().to_string();
    let element_type = doc
        .child_element(idx, "of")
        .map(|of| doc.element(of).text(doc).trim().to_string())
        .filter(|value| !value.is_empty());
    (type_name, element_type)
}

/// TS readDefMethods: one method section (optionally Exposed only); Arg carries a type and no name.
fn read_def_methods(
    doc: &Document,
    root: usize,
    section: &str,
    only_exposed: bool,
) -> Vec<SdkMethod> {
    let mut methods = Vec::new();
    let Some(section_idx) = doc.child_element(root, section) else {
        return methods;
    };
    for method in doc.child_elements(section_idx) {
        if only_exposed && !doc.truthy_child(method, "Exposed") {
            continue;
        }
        let name = doc.element(method).name.clone();
        let arg_types = doc
            .child_elements_named(method, "Arg")
            .into_iter()
            .map(|arg| doc.element(arg).text(doc).trim().to_string())
            .filter(|arg| !arg.is_empty())
            .collect();
        methods.push(SdkMethod { name, arg_types });
    }
    methods
}

/// Component slot `<Type>` name: take the text directly, falling back to the first element child's name when empty (same criteria as message_table node_value).
fn slot_type_name(doc: &Document, slot: usize) -> String {
    let Some(type_idx) = doc.child_element(slot, "Type") else {
        return String::new();
    };
    let text = doc.element(type_idx).text(doc).trim().to_string();
    if !text.is_empty() {
        return text;
    }
    doc.child_elements(type_idx)
        .first()
        .map(|&child| doc.element(child).name.clone())
        .unwrap_or_default()
}

/// Client-visible properties of a component module: itself + interfaces +
/// parents (under components/), recursed and deduped by name (the first, i.e.
/// itself, wins); a missing def returns None (the caller skips that slot /
/// reference).
fn parse_component_properties(
    type_name: &str,
    component_defs: &ComponentDefs,
    visited: &mut HashSet<String>,
) -> Option<Vec<SdkProperty>> {
    let def_text = component_defs.get(type_name)?;
    let doc = xml::parse(def_text, false);
    if is_structural_error(&doc) {
        return None;
    }
    let root = doc.root()?;
    visited.insert(type_name.to_string());
    let mut out: Vec<SdkProperty> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut collect = |doc: &Document, root: usize, out: &mut Vec<SdkProperty>| {
        let Some(properties_node) = doc.child_element(root, "Properties") else {
            return;
        };
        for property in doc.child_elements(properties_node) {
            let element = doc.element(property);
            let (type_name, element_type) =
                read_def_type_node(doc, doc.child_element(property, "Type"));
            let flags = doc
                .scalar_child_value(property, "Flags")
                .unwrap_or_default();
            let domains = flag_domains(&normalize_flag_tokens(&flags));
            if domains.contains(&"client") && seen.insert(element.name.clone()) {
                out.push(SdkProperty {
                    name: element.name.clone(),
                    type_name,
                    element_type,
                    flags,
                    domains,
                });
            }
        }
    };
    collect(&doc, root, &mut out);

    if let Some(ifaces) = doc.child_element(root, "Interfaces") {
        for iface in doc.child_elements(ifaces) {
            let name = reference_target_name(&doc, iface);
            if !name.is_empty() && !visited.contains(&name) {
                if let Some(iprops) = parse_component_properties(&name, component_defs, visited) {
                    for p in iprops {
                        if seen.insert(p.name.clone()) {
                            out.push(p);
                        }
                    }
                }
            }
        }
    }
    if let Some(parent) = doc.child_element(root, "Parent") {
        let name = reference_target_name(&doc, parent);
        if !name.is_empty() && !visited.contains(&name) {
            if let Some(pprops) = parse_component_properties(&name, component_defs, visited) {
                for p in pprops {
                    if seen.insert(p.name.clone()) {
                        out.push(p);
                    }
                }
            }
        }
    }
    Some(out)
}

/// TS parseClientSdkEntity: def content -> entity model; a structural error returns None (skip).
fn parse_entity(def_text: &str, name: &str, component_defs: &ComponentDefs) -> Option<SdkEntity> {
    let doc = xml::parse(def_text, false);
    if is_structural_error(&doc) {
        return None;
    }
    let root = doc.root()?;
    let parent = doc
        .child_element(root, "Parent")
        .map(|parent| reference_target_name(&doc, parent))
        .filter(|value| !value.is_empty());

    let mut properties = Vec::new();
    if let Some(properties_node) = doc.child_element(root, "Properties") {
        for property in doc.child_elements(properties_node) {
            let element = doc.element(property);
            let (type_name, element_type) =
                read_def_type_node(&doc, doc.child_element(property, "Type"));
            let flags = doc
                .scalar_child_value(property, "Flags")
                .unwrap_or_default();
            let domains = flag_domains(&normalize_flag_tokens(&flags));
            properties.push(SdkProperty {
                name: element.name.clone(),
                type_name,
                element_type,
                flags,
                domains,
            });
        }
    }

    let mut components = Vec::new();
    if let Some(components_node) = doc.child_element(root, "Components") {
        for slot in doc.child_elements(components_node) {
            let element = doc.element(slot);
            let slot_name = element.name.clone();
            let type_name = slot_type_name(&doc, slot);
            if type_name.is_empty() {
                continue;
            }
            // A missing component def -> skip that slot (tolerant; the engine fails the
            // whole table, and the SDK face reports the issue under the same
            // criteria as message_table, handled by the TS-side closure face, so
            // skip silently here).
            if let Some(properties) =
                parse_component_properties(&type_name, component_defs, &mut HashSet::new())
            {
                components.push(SdkComponent {
                    slot: slot_name,
                    type_name,
                    properties,
                });
            }
        }
    }

    Some(SdkEntity {
        name: name.to_string(),
        parent,
        properties,
        components,
        client_methods: read_def_methods(&doc, root, "ClientMethods", false),
        exposed_base_methods: read_def_methods(&doc, root, "BaseMethods", true),
        exposed_cell_methods: read_def_methods(&doc, root, "CellMethods", true),
    })
}

fn client_visible_properties(entity: &SdkEntity) -> Vec<&SdkProperty> {
    entity
        .properties
        .iter()
        .filter(|p| p.client_visible())
        .collect()
}

// ---------------------------------------------------------------------------
// types.xml -> type table (same criteria as TS getCustomTypeInfos + buildClientSdkTypeMap)
// ---------------------------------------------------------------------------

/// TS normalizeXmlText: collapse runs of whitespace to a single space and trim; empty -> None.
fn normalize_xml_text(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// TS renderStructureNode: element -> `<name>…</name>` XML string (self-closing short form).
fn render_structure_node(doc: &Document, idx: usize) -> String {
    let element = doc.element(idx);
    if element.self_closing {
        return format!("<{}/>", element.name);
    }
    format!(
        "<{}>{}</{}>",
        element.name,
        inner_xml(doc, idx),
        element.name
    )
}

fn inner_xml(doc: &Document, idx: usize) -> String {
    let mut out = String::new();
    for &child in &doc.element(idx).children {
        match &doc.nodes[child].data {
            NodeData::Text { decoded, .. } => out.push_str(decoded),
            NodeData::Element(_) => out.push_str(&render_structure_node(doc, child)),
            _ => {}
        }
    }
    out
}

/// TS extractCustomTypeRawValue: normalized text chunks + element structure
/// strings (skipping implementedBy/Properties), joined; all empty -> `ALIAS`.
fn extract_custom_type_raw_value(doc: &Document, idx: usize) -> String {
    let mut chunks: Vec<String> = Vec::new();
    for &child in &doc.element(idx).children {
        match &doc.nodes[child].data {
            NodeData::Text { decoded, .. } => {
                if let Some(normalized) = normalize_xml_text(decoded) {
                    chunks.push(normalized);
                }
            }
            NodeData::Element(element) => {
                if element.name == "implementedBy" || element.name == "Properties" {
                    continue;
                }
                chunks.push(render_structure_node(doc, child));
            }
            _ => {}
        }
    }
    let joined = chunks.join(" ").trim().to_string();
    if joined.is_empty() {
        "ALIAS".to_string()
    } else {
        joined
    }
}

/// TS extractCustomTypeAliasType: the first identifier token of rawValue; none -> `ALIAS`.
fn extract_custom_type_alias_type(raw_value: &str) -> String {
    let bytes = raw_value.as_bytes();
    let Some(&first) = bytes.first() else {
        return "ALIAS".to_string();
    };
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return "ALIAS".to_string();
    }
    let mut end = 1;
    while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
        end += 1;
    }
    raw_value[..end].to_string()
}

/// TS parseCustomTypeProperties: the FIXED_DICT field list (name + Type + line number).
/// The TS side sorts by name; a field missing `<Type>` -> typeName=None (generation falls back per language).
fn parse_custom_type_properties(
    doc: &Document,
    type_idx: usize,
    lines: &LineMap,
) -> Vec<FixedDictProperty> {
    let Some(properties_node) = doc.child_element(type_idx, "Properties") else {
        return Vec::new();
    };
    let mut properties: Vec<FixedDictProperty> = doc
        .child_elements(properties_node)
        .into_iter()
        .map(|property| {
            let element = doc.element(property);
            let type_line = doc
                .child_element(property, "Type")
                .map(|t| lines.line_of(doc.element(t).name_span.start));
            let line = lines.line_of(element.name_span.start);
            FixedDictProperty {
                name: element.name.clone(),
                type_name: doc.scalar_child_value(property, "Type"),
                source_line: type_line.or(Some(line)),
            }
        })
        .collect();
    properties.sort_by(|left, right| left.name.cmp(&right.name));
    properties
}

mod gen;

use gen::generate;

fn parse_params(params: Value) -> Result<SdkGenerateParams, String> {
    let language = params
        .get("language")
        .and_then(|v| v.as_str())
        .ok_or("missing 'language'")?
        .to_string();
    let entities = params
        .get("entities")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let name = item.get("name")?.as_str()?.to_string();
                    let def_text = item.get("defText")?.as_str()?.to_string();
                    Some(SdkEntityInput { name, def_text })
                })
                .collect()
        })
        .unwrap_or_default();
    let types_xml = params
        .get("typesXml")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let component_defs = params
        .get("defs")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<ComponentDefs>()
        })
        .unwrap_or_default();
    let generated_at = params
        .get("generatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let engine_trace = params.get("engineTrace").map(|v| {
        let engine_version = v
            .get("engineVersion")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let engine_commit = v
            .get("engineCommit")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        EngineTrace {
            engine_version,
            engine_commit,
        }
    });
    let namespace = params
        .get("namespace")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(SdkGenerateParams {
        language,
        entities,
        component_defs,
        types_xml,
        generated_at,
        engine_trace,
        namespace,
    })
}

/// `$/kode/sdk/generate` handler:params → `[{fileName, content}]`。
fn generate_handler(params: Value) -> Result<Value, String> {
    let parsed = parse_params(params)?;
    let files = generate(&parsed)?;
    Ok(Value::Array(
        files
            .into_iter()
            .map(|file| json!({"fileName": file.file_name, "content": file.content}))
            .collect(),
    ))
}

// ---------------------------------------------------------------------------
// headless collection face (client-sdk-gen bin/CI; the extension flow collects
// in TS definitionWorkspace, so this is an equivalent replica: entities.xml
// registration order (flat + sectioned, deduped by first occurrence in document
// order) -> {name}.def; the component closure seeds from the entity def
// `<Components>` slot names, and visit recurses Interfaces/Parent/component
// slots (components/ preferred, interfaces/ as fallback), same direction as TS
// collectClientSdkComponentDefs; a missing types.xml = an empty type table.
// ---------------------------------------------------------------------------

/// Closure leads from the def text (component slot / interface / parent names; a structural error yields all empty, without panicking).
struct DefClosureLeads {
    component_names: Vec<String>,
    interface_names: Vec<String>,
    parent_name: Option<String>,
}

fn parse_def_closure_leads(def_text: &str) -> DefClosureLeads {
    let mut leads = DefClosureLeads {
        component_names: Vec::new(),
        interface_names: Vec::new(),
        parent_name: None,
    };
    let doc = xml::parse(def_text, false);
    if is_structural_error(&doc) {
        return leads;
    }
    let Some(root) = doc.root() else {
        return leads;
    };
    if let Some(components_node) = doc.child_element(root, "Components") {
        for slot in doc.child_elements(components_node) {
            let name = slot_type_name(&doc, slot);
            if !name.is_empty() {
                leads.component_names.push(name);
            }
        }
    }
    if let Some(ifaces) = doc.child_element(root, "Interfaces") {
        for iface in doc.child_elements(ifaces) {
            let name = reference_target_name(&doc, iface);
            if !name.is_empty() {
                leads.interface_names.push(name);
            }
        }
    }
    if let Some(parent) = doc.child_element(root, "Parent") {
        let name = reference_target_name(&doc, parent);
        if !name.is_empty() {
            leads.parent_name = Some(name);
        }
    }
    leads
}

/// Registered names from entities.xml (document order; flat + the
/// ClientServerEntities/ServerOnlyEntities sectioned dual criteria, keeping the
/// first occurrence of a duplicate name, same direction as TS
/// getRegisteredEntities). An unreadable file or a missing root -> Err (the
/// caller decides whether to abort).
pub fn read_registered_entity_names(
    entities_xml_path: &std::path::Path,
) -> Result<Vec<String>, String> {
    let text = std::fs::read_to_string(entities_xml_path).map_err(|e| {
        format!(
            "读取 entities.xml 失败({}): {e}",
            entities_xml_path.display()
        )
    })?;
    let doc = xml::parse(&text, false);
    let root = doc
        .root()
        .ok_or_else(|| format!("entities.xml 无根元素:{}", entities_xml_path.display()))?;
    let mut names: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push_name = |name: &str| {
        if !name.is_empty() && name != "root" && seen.insert(name.to_string()) {
            names.push(name.to_string());
        }
    };
    for child in doc.child_elements(root) {
        let element = doc.element(child);
        // Sectioned container (BigWorld semantics): the child elements are the registration entries; a flat section's own name is the registration name.
        if element.name == "ClientServerEntities" || element.name == "ServerOnlyEntities" {
            for entry in doc.child_elements(child) {
                push_name(doc.element(entry).name.as_str());
            }
        } else {
            push_name(element.name.as_str());
        }
    }
    Ok(names)
}

/// Headless generation request: `assets_root` points at the asset root (with
/// `scripts/entities.xml` + `scripts/entity_defs/` under it); the language is
/// one of three; provenance / namespace are optional.
#[derive(Debug)]
pub struct ClientSdkCliRequest {
    pub assets_root: std::path::PathBuf,
    pub language: String,
    pub namespace: Option<String>,
    pub engine_version: Option<String>,
    pub engine_commit: Option<String>,
    pub generated_at: Option<String>,
}

/// Headless generation output (file name + content, written to disk by the caller).
#[derive(Debug)]
pub struct ClientSdkCliFile {
    pub file_name: String,
    pub content: String,
}

/// Collect the def/types corpus from the asset root and generate the client SDK
/// files (CI/bin entry point; the generation core is the same function as the
/// `$/kode/sdk/generate` RPC, so the two entry points have zero divergence).
pub fn generate_sdk_headless(req: &ClientSdkCliRequest) -> Result<Vec<ClientSdkCliFile>, String> {
    let scripts_dir = req.assets_root.join("scripts");
    let entity_defs_root = scripts_dir.join("entity_defs");
    if !entity_defs_root.is_dir() {
        return Err(format!(
            "entity_defs 目录不存在:{}",
            entity_defs_root.display()
        ));
    }
    let entities_xml = scripts_dir.join("entities.xml");
    let names = read_registered_entity_names(&entities_xml)?;

    let mut entities: Vec<SdkEntityInput> = Vec::new();
    for name in &names {
        let def_path = entity_defs_root.join(format!("{name}.def"));
        if let Ok(def_text) = std::fs::read_to_string(&def_path) {
            entities.push(SdkEntityInput {
                name: name.clone(),
                def_text,
            });
        }
    }
    if entities.is_empty() {
        return Err(format!(
            "entities.xml 登记的实体在 entity_defs 下均无 def 文件(登记 {} 项):{}",
            names.len(),
            entity_defs_root.display()
        ));
    }

    // Component closure: seeds = each entity def's component slot names; visit recurses Interfaces/Parent/component slots.
    let mut component_defs: ComponentDefs = HashMap::new();
    let mut queue: Vec<String> = Vec::new();
    let mut enqueued = HashSet::new();
    let enqueue = |name: &str, queue: &mut Vec<String>, enqueued: &mut HashSet<String>| {
        if !name.is_empty() && !enqueued.contains(name) {
            enqueued.insert(name.to_string());
            queue.push(name.to_string());
        }
    };
    for entity in &entities {
        let leads = parse_def_closure_leads(&entity.def_text);
        for name in leads.component_names {
            enqueue(&name, &mut queue, &mut enqueued);
        }
    }
    while let Some(name) = queue.pop() {
        if component_defs.contains_key(&name) {
            continue;
        }
        // Prefer components/ for components, fall back to interfaces/ for interfaces (same criteria as TS).
        let component_path = entity_defs_root
            .join("components")
            .join(format!("{name}.def"));
        let interface_path = entity_defs_root
            .join("interfaces")
            .join(format!("{name}.def"));
        let def_path = if component_path.is_file() {
            component_path
        } else if interface_path.is_file() {
            interface_path
        } else {
            continue;
        };
        let Ok(def_text) = std::fs::read_to_string(&def_path) else {
            continue;
        };
        let leads = parse_def_closure_leads(&def_text);
        component_defs.insert(name.clone(), def_text);
        for iface in leads.interface_names {
            enqueue(&iface, &mut queue, &mut enqueued);
        }
        if let Some(parent) = leads.parent_name {
            enqueue(&parent, &mut queue, &mut enqueued);
        }
        for comp in leads.component_names {
            enqueue(&comp, &mut queue, &mut enqueued);
        }
    }

    let types_xml = std::fs::read_to_string(entity_defs_root.join("types.xml")).ok();
    let engine_trace = match (&req.engine_version, &req.engine_commit) {
        (Some(v), Some(c)) => Some(EngineTrace {
            engine_version: v.clone(),
            engine_commit: c.clone(),
        }),
        // Giving only one side does not fabricate the other: when half the provenance
        // is missing, omit the whole block, matching the shape of an absent
        // engineTrace object on the RPC side.
        _ => None,
    };

    let params = SdkGenerateParams {
        language: req.language.clone(),
        entities,
        component_defs,
        types_xml,
        generated_at: req.generated_at.clone().unwrap_or_default(),
        engine_trace,
        namespace: req.namespace.clone(),
    };
    Ok(generate(&params)?
        .into_iter()
        .map(|file| ClientSdkCliFile {
            file_name: file.file_name,
            content: file.content,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The builtin tables cover the engine's whole registry (same criteria as kode-types):
    /// if the builtin type list drifts, the generation face must not silently
    /// lose a mapping.
    #[test]
    fn builtin_tables_cover_engine_registry() {
        for name in kode_types::builtin::BUILTIN_TYPES {
            assert!(
                TS_BUILTIN_TYPES.iter().any(|(key, _)| key == name),
                "TS builtin table missing engine type {name}"
            );
            assert!(
                CS_BUILTIN_TYPES.iter().any(|(key, _)| key == name),
                "CS builtin table missing engine type {name}"
            );
            assert!(
                PY_BUILTIN_TYPES.iter().any(|(key, _)| key == name),
                "PY builtin table missing engine type {name}"
            );
        }
    }

    /// The structural error test only folds in the same class fxp throws on
    /// (unclosed / mismatched / stray close / invalid tag name); a well-formed
    /// document must not be misjudged (a misjudgement would skip the whole def).
    #[test]
    fn is_structural_error_matches_wire_skip_class() {
        assert!(!is_structural_error(&xml::parse(
            "<root><A/></root>",
            false
        )));
        // A close tag without a name (`</>`) -> InvalidTagName, the same class as fxp's thrown errors.
        assert!(is_structural_error(&xml::parse("<root></></root>", false)));
    }

    /// Reference target name: the text form (non-empty after trim) wins; the
    /// element form takes the first element child's name; comment-only child
    /// nodes -> an empty string.
    #[test]
    fn reference_target_name_prefers_text_then_element_name() {
        let doc = xml::parse("<root><Parent> Mob </Parent></root>", false);
        let root = doc.root().unwrap();
        let parent = doc.child_element(root, "Parent").unwrap();
        assert_eq!(reference_target_name(&doc, parent), "Mob");

        let doc = xml::parse("<root><Parent><Entity/></Parent></root>", false);
        let root = doc.root().unwrap();
        let parent = doc.child_element(root, "Parent").unwrap();
        assert_eq!(reference_target_name(&doc, parent), "Entity");

        let doc = xml::parse("<root><Parent><!-- c --></Parent></root>", false);
        let root = doc.root().unwrap();
        let parent = doc.child_element(root, "Parent").unwrap();
        assert_eq!(reference_target_name(&doc, parent), "");
    }

    /// A missing `<Type>` child element -> (empty, None); sibling nodes such as Flags are left untouched.
    #[test]
    fn read_def_type_node_without_type_is_empty() {
        let doc = xml::parse("<root><hp><Flags>ALL_CLIENTS</Flags></hp></root>", false);
        let root = doc.root().unwrap();
        let hp = doc.child_element(root, "hp").unwrap();
        let (type_name, element_type) = read_def_type_node(&doc, doc.child_element(hp, "Type"));
        assert_eq!(type_name, "");
        assert_eq!(element_type, None);
    }

    /// Component slot type name: no `<Type>` -> empty; an empty direct text falls back to the first element child's name; all empty -> empty.
    #[test]
    fn slot_type_name_falls_back_to_first_element_child() {
        let doc = xml::parse("<root><bag></bag></root>", false);
        let root = doc.root().unwrap();
        let bag = doc.child_element(root, "bag").unwrap();
        assert_eq!(slot_type_name(&doc, bag), "");

        let doc = xml::parse("<root><bag><Type><Inventory/></Type></bag></root>", false);
        let root = doc.root().unwrap();
        let bag = doc.child_element(root, "bag").unwrap();
        assert_eq!(slot_type_name(&doc, bag), "Inventory");

        let doc = xml::parse("<root><bag><Type></Type></bag></root>", false);
        let root = doc.root().unwrap();
        let bag = doc.child_element(root, "bag").unwrap();
        assert_eq!(slot_type_name(&doc, bag), "");
    }

    const CLIENT_PROP_DEF: &str = "<root><Properties><vis>\
<Type>UINT32</Type><Flags>ALL_CLIENTS</Flags></vis></Properties></root>";

    #[test]
    fn parse_component_properties_missing_def_is_none() {
        let defs = ComponentDefs::new();
        assert!(parse_component_properties("Ghost", &defs, &mut HashSet::new()).is_none());
    }

    /// A structural error in a component def -> None (the caller skips that slot), without panicking.
    #[test]
    fn parse_component_properties_structural_error_is_none() {
        let mut defs = ComponentDefs::new();
        defs.insert("Bad".into(), "<root></></root>".into());
        assert!(parse_component_properties("Bad", &defs, &mut HashSet::new()).is_none());
    }

    /// A component with no `Properties` section -> an empty list (still Some, so the slot is not lost).
    #[test]
    fn parse_component_properties_without_properties_is_empty() {
        let mut defs = ComponentDefs::new();
        defs.insert("NP".into(), "<root><Parent>Ghost</Parent></root>".into());
        let out = parse_component_properties("NP", &defs, &mut HashSet::new()).unwrap();
        assert!(out.is_empty());
    }

    /// Interfaces and parents are merged recursively into the client-visible properties, deduped by name (itself wins).
    #[test]
    fn parse_component_properties_merges_interface_and_parent_with_dedup() {
        let mut defs = ComponentDefs::new();
        defs.insert(
            "Comp".into(),
            r#"<root>
              <Properties><inv><Type>UINT32</Type><Flags>ALL_CLIENTS</Flags></inv></Properties>
              <Interfaces><iface><Shared/></iface></Interfaces>
              <Parent>Base</Parent>
            </root>"#
                .into(),
        );
        defs.insert(
            "Shared".into(),
            r#"<root>
              <Properties>
                <inv><Type>UINT32</Type><Flags>ALL_CLIENTS</Flags></inv>
                <sharedOnly><Type>STRING</Type><Flags>OTHER_CLIENTS</Flags></sharedOnly>
              </Properties>
            </root>"#
                .into(),
        );
        defs.insert(
            "Base".into(),
            "<root><Properties><mail><Type>STRING</Type>\
<Flags>BASE_AND_CLIENT</Flags></mail></Properties></root>"
                .into(),
        );
        let out = parse_component_properties("Comp", &defs, &mut HashSet::new()).unwrap();
        let names: Vec<&str> = out.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["inv", "sharedOnly", "mail"],
            "接口先于父类,同名去重"
        );
    }

    /// An entity with no `Properties` section still models normally; an empty component slot (missing `<Type>`) is skipped without breaking.
    #[test]
    fn parse_entity_skips_empty_component_slot_and_supports_no_properties() {
        let entity = parse_entity(
            "<root><Components><bag></bag></Components></root>",
            "Empty",
            &ComponentDefs::new(),
        )
        .unwrap();
        assert_eq!(entity.name, "Empty");
        assert!(entity.properties.is_empty());
        assert!(entity.components.is_empty());
    }

    /// A slot whose `<Type>` direct text is empty but has element children -> the element name is the component type; the component's client properties enter the slot.
    #[test]
    fn parse_entity_resolves_slot_type_from_element_child() {
        let mut defs = ComponentDefs::new();
        defs.insert("Inventory".into(), CLIENT_PROP_DEF.into());
        let entity = parse_entity(
            "<root><Components><bag><Type><Inventory/></Type></bag></Components></root>",
            "E",
            &defs,
        )
        .unwrap();
        assert_eq!(entity.components.len(), 1);
        assert_eq!(entity.components[0].slot, "bag");
        assert_eq!(entity.components[0].type_name, "Inventory");
        assert_eq!(entity.components[0].properties[0].name, "vis");
    }

    /// Runs of whitespace collapse to a single space; pure whitespace -> None.
    #[test]
    fn normalize_xml_text_collapses_whitespace() {
        assert_eq!(normalize_xml_text("  a \n b\tc  "), Some("a b c".into()));
        assert_eq!(normalize_xml_text("   \n  "), None);
    }

    /// Structure string rendering: the self-closing short form; nested elements recurse, text is kept as-is.
    #[test]
    fn render_structure_node_renders_self_closing_and_nested() {
        let doc = xml::parse("<root><Props/><FIX><Props/> tail </FIX></root>", false);
        let root = doc.root().unwrap();
        let props = doc.child_element(root, "Props").unwrap();
        assert_eq!(render_structure_node(&doc, props), "<Props/>");
        let fix = doc.child_element(root, "FIX").unwrap();
        assert_eq!(
            render_structure_node(&doc, fix),
            "<FIX><Props/> tail </FIX>"
        );
    }

    /// Custom type rawValue: normalized text chunks + element structure strings,
    /// skipping implementedBy/Properties and comments; all empty -> ALIAS.
    #[test]
    fn extract_custom_type_raw_value_and_alias_type() {
        let doc = xml::parse(
            "<root>\n  <MY_TYPE> UINT32 <implementedBy>sys</implementedBy><!-- n --> \
</MY_TYPE>\n  <ALIAS_TYPE>   </ALIAS_TYPE>\n</root>",
            false,
        );
        let root = doc.root().unwrap();
        let my = doc.child_element(root, "MY_TYPE").unwrap();
        assert_eq!(extract_custom_type_raw_value(&doc, my), "UINT32");
        let alias = doc.child_element(root, "ALIAS_TYPE").unwrap();
        assert_eq!(extract_custom_type_raw_value(&doc, alias), "ALIAS");

        assert_eq!(extract_custom_type_alias_type("UINT32"), "UINT32");
        assert_eq!(extract_custom_type_alias_type("_priv"), "_priv");
        assert_eq!(extract_custom_type_alias_type("9abc"), "ALIAS");
        assert_eq!(extract_custom_type_alias_type(""), "ALIAS");
    }
}
