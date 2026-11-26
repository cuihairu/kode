//! C-18 KBEngine official def MD5 (`EntityDef::md5()`) replayer.
//!
//! Goal: be **byte-for-byte identical** to the composite md5 the engine
//! computes over the same assets. During the def loading pipeline the engine
//! feeds a structured byte stream into the static `KBE_MD5`
//! (entitydef.cpp:32/243); strings = raw bytes with no delimiter, numbers =
//! native little-endian; this module replays the same byte stream in the
//! engine's execution order.
//!
//! Provenance (local kbengine HEAD 732b389):
//! - Built-in type construction order: datatypes.cpp:53-83 (21 items, uid
//!   counter starting at 1: datatype.cpp:24);
//! - DataType construction = aliasName (always empty at construction, 0 bytes)
//!   + uid u16: datatype.cpp:86-97 — alias registration comes afterwards
//!     (`aliasName(name)` no longer enters the stream), scalar aliases do not
//!     construct a new type;
//! - FixedArrayType::initialize = [element uid u16] + [element strType]:
//!   datatype.cpp:1715-1717;
//! - FixedDictType per key = [uid u16] + [strType] + [key name] +
//!   [persistent 1B] + [databaseLength u32] (an ARRAY key has the same shape,
//!   with the nested construction bytes entering first): datatype.cpp:2096-2149;
//!   implementedBy (only when non-empty): datatype.cpp:2183-2184;
//! - PropertyDescription construction = [name] + [Default] + [Type raw text] +
//!   [utype u16] + [flags u32] + [persistent 1B] + [identifier 1B] +
//!   [databaseLength u32] + [detailLevel i8] + [type uid u16]:
//!   property.cpp:53-64; ENTITYCALL persistent override: property.cpp:48;
//! - MethodDescription construction = [name] + [utype always 0 (setUType no
//!   longer enters the stream: method.inl:16-19)] + [exposedType 4B]:
//!   method.cpp:28-30; per argument = [uid u16] + [exposedType 4B]:
//!   method.cpp:65-67; `<Exposed/>` → [exposedType 4B]: method.cpp:50 (the
//!   document order decides the exposed value an argument carries; ClientMethods
//!   have no Exposed branch: entitydef.cpp:1602-1666);
//! - ScriptDefModule construction = module name: scriptdef_module.cpp:60
//!   (uType does not enter the stream);
//! - Loading order = loadAllDefDescriptions (Properties→Cell→Base→Client:
//!   entitydef.cpp:927-964) → loadInterfaces (recursive, not the message_table
//!   single level: entitydef.cpp:551-639) → loadComponents
//!   (registerNewScriptDefModule only if not already registered:
//!   entitydef.cpp:642-818; the component property bytes = [EntityComponentType
//!   uid] + PropertyDescription("EntityComponent"), flags derived from the
//!   component's hasBase/hasCell/hasClient: entitydef.cpp:793-808/821-843) →
//!   loadParentClass (recursive loadDefInfo: entitydef.cpp:890-924) →
//!   autoMatchCompOwn (only when the entities.xml entry exists, appends 3×int32
//!   hasClient/hasCell/hasBase, default -1, with value 1/0:
//!   scriptdef_module.cpp:341-397; component modules exit early: 304-331);
//! - Property utype auto counter g_propertyUtypeAuto (starts at 1, advances
//!   when taken; an explicit `<Utype>` takes its slot in g_propertyUtypes):
//!   entitydef.cpp:45/1018-1093;
//! - MD5 output is uppercase 32 hex: md5.cpp:65-72 (`"%2.2X"`).
//!
//! The IDE-internal sha256/semanticHash dual track (hotReloadDefHash /
//! hotReloadStructure) is a separate system and untouched by this module; the
//! engine interop has exactly this one implementation (Rust authority, no TS
//! mirror).

use std::collections::{HashMap, HashSet};

use kode_parser::xml::{parse as parse_xml, Document, NodeData};
use serde_json::{json, Value};

use crate::rpc::RpcRegistry;

// ===========================================================================
// Submodules (SRC-008 phase 1): MD5 basics + byte stream, golden sample set.
// ===========================================================================

mod golden;
mod md5;

pub use golden::{dump_def_md5_golden, golden_samples, GoldenSample, GOLDEN_REL_PATH};
pub use md5::{to_hex, DefMd5Stream, Md5, TraceEntry};

// ===========================================================================
// Replayer
// ===========================================================================

/// Built-in type construction order (datatypes.cpp:56-79).
pub const BUILTIN_TYPE_ORDER: [&str; 21] = [
    "UINT8",
    "UINT16",
    "UINT64",
    "UINT32",
    "INT8",
    "INT16",
    "INT32",
    "INT64",
    "STRING",
    "UNICODE",
    "FLOAT",
    "DOUBLE",
    "PYTHON",
    "PY_DICT",
    "PY_TUPLE",
    "PY_LIST",
    "ENTITYCALL",
    "BLOB",
    "VECTOR2",
    "VECTOR3",
    "VECTOR4",
];

/// Flags string → raw bit mask (entitydef.cpp:161-174, the input is uppercased
/// first).
pub fn flags_value(name_upper: &str) -> Option<u32> {
    match name_upper {
        "CELL" => Some(0x0000_0001),
        "CELL_PUBLIC" => Some(0x0000_0001),
        "CELL_PRIVATE" => Some(0x0000_0002),
        "CELL_AND_CLIENT" => Some(0x0000_0008),
        "CELL_AND_CLIENTS" => Some(0x0000_0004),
        "CELL_AND_OTHER_CLIENTS" => Some(0x0000_0080),
        "CELL_PUBLIC_AND_OWN" => Some(0x0000_0008),
        "ALL_CLIENTS" => Some(0x0000_0004),
        "OTHER_CLIENTS" => Some(0x0000_0080),
        "OWN_CLIENT" => Some(0x0000_0010),
        "BASE_AND_CLIENT" => Some(0x0000_0020),
        "BASE" => Some(0x0000_0040),
        _ => None,
    }
}

const ENTITY_BASE_DATA_FLAGS: u32 = 0x0060; // BASE | BASE_AND_CLIENT
const ENTITY_CELL_DATA_FLAGS: u32 = 0x009f;
const ENTITY_CLIENT_DATA_FLAGS: u32 = 0x00bc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TypeKind {
    Builtin,
    Array,
    Dict,
    EntityComponent,
    /// EntityCallType (datatype.h:633-635) — the getName()/type() class
    /// identity is fixed at construction time;
    /// KR-AUD-82: decoupled from the aliasName registration name (the engine's
    /// addDataType never touches class identity).
    EntityCall,
}

#[derive(Clone, Debug)]
struct TypeInfo {
    kind: TypeKind,
    /// The Array's element type id (FixedArrayType::getDataType).
    element: Option<u16>,
}

#[derive(Default)]
struct DataTypesState {
    /// _g_dataTypeUID (datatype.cpp:24, starts at 1; finalise resets it: 108).
    next_uid: u16,
    by_name: HashMap<String, u16>,
    info: HashMap<u16, TypeInfo>,
}

impl DataTypesState {
    fn new() -> Self {
        DataTypesState {
            next_uid: 1,
            by_name: HashMap::new(),
            info: HashMap::new(),
        }
    }

    /// DataType construction: aliasName always empty at construction (0 bytes)
    /// + uid u16 (datatype.cpp:86-97).
    fn construct(&mut self, stream: &mut DefMd5Stream, kind: TypeKind, field: &str) -> u16 {
        let id = self.next_uid;
        self.next_uid += 1;
        stream.append_u16(field, "datatype.cpp:95-96 (DataType ctor)", id);
        self.info.insert(
            id,
            TypeInfo {
                kind,
                element: None,
            },
        );
        id
    }

    /// addDataType(name, dt): writes only the name→id table (alias registration
    /// comes afterwards, not in the stream; datatypes.cpp:190-218 —
    /// `dataType->aliasName(name)` only changes aliasName_, never the
    /// getName()/type() class identity). KR-AUD-82: register must not overwrite
    /// type metadata.
    fn register(&mut self, name: &str, id: u16) {
        self.by_name.insert(name.to_string(), id);
    }

    fn lookup(&self, name: &str) -> Option<u16> {
        self.by_name.get(name).copied()
    }

    /// Whether this type is ENTITYCALL — the engine's three checks all use the
    /// **class identity** and never recurse into the array chain (KR-AUD-86):
    /// - property.cpp:48-51 `strcmp(dataType_->getName(),"ENTITYCALL")`;
    /// - datatype.cpp:2141 `dataType->type()`;
    /// - datatype.cpp:2104 array key `dataType->getDataType()->type()` — it
    ///   only looks at **one level** of element (a nested FixedArrayType element
    ///   has type()==FIXEDARRAY), so the element id passed by the caller is
    ///   equivalent.
    ///
    /// Alias registration never changes class identity (KR-AUD-82).
    fn is_entitycall(&self, id: u16) -> bool {
        matches!(
            self.info.get(&id).map(|info| info.kind),
            Some(TypeKind::EntityCall)
        )
    }
}

/// The module's domain bits and exposed-method count (for component flags
/// derivation, entitydef.cpp:793-808).
#[derive(Clone, Default)]
struct ModuleState {
    has_base: bool,
    has_cell: bool,
    has_client: bool,
    base_exposed_methods: usize,
    cell_exposed_methods: usize,
    /// isComponentModule (scriptdef_module.cpp:304 early-exit check).
    is_component: bool,
    /// Utypes used by this module, explicit or auto (KR-AUD-85: conflict
    /// detection is limited to the same module — the engine's
    /// findPropertyDescription only looks at this module).
    prop_utypes: Vec<u16>,
}

/// Computation inputs (mirror the message_table input shape; componentScripts
/// is an optional `{"base:Name","cell:Name"}` existence set — the script probe
/// face of the component's autoMatchCompOwn, corresponding to the existence of
/// the engine's scripts/{base,cell}/components/<Name>.py).
#[derive(Clone, Debug, Default)]
pub struct DefMd5Params {
    pub types_xml: String,
    pub entities_xml: String,
    /// Entity/interface/component name → def original text (interfaces and
    /// components are looked up by name; directory structure does not
    /// participate).
    pub defs: HashMap<String, String>,
    pub alias_xml: String,
    pub component_scripts: HashSet<String>,
}

#[derive(Debug)]
pub struct DefMd5Result {
    pub md5_hex: String,
    pub stream_hex: String,
    pub trace: Vec<TraceEntry>,
}

impl DefMd5Result {
    pub fn to_json(&self) -> Value {
        json!({
            "md5": self.md5_hex,
            "algorithm": "md5",
            "streamHex": self.stream_hex,
            "trace": self.trace.iter().map(|t| json!({
                "field": t.field,
                "source": t.source,
                "bytes": t.bytes_hex,
            })).collect::<Vec<_>>(),
        })
    }
}

/// XML helper: the engine's getValStr = first text child node kbe_trim
/// (xml.cpp:121-128).
fn first_text(doc: &Document, el: usize) -> String {
    let element = doc.element(el);
    for &child in &element.children {
        if let NodeData::Text { decoded, .. } = &doc.nodes[child].data {
            return decoded
                .trim_matches(|c: char| c.is_ascii_whitespace())
                .to_string();
        }
    }
    String::new()
}

/// Engine enterNode(node,key) ≈ the parent element's named child element
/// (xml.cpp:60-88).
fn child_el(doc: &Document, parent: usize, key: &str) -> Option<usize> {
    doc.child_elements(parent)
        .into_iter()
        .find(|&c| doc.element(c).name == key)
}

/// Engine xml.cpp:113-119 getKey = trim(Value): an element takes its tag name,
/// text/CDATA take the decoded text trimmed (the source of the text forms of
/// interface/component names).
fn engine_get_key(doc: &Document, node: usize) -> String {
    match &doc.nodes[node].data {
        NodeData::Element(e) => e.name.trim().to_string(),
        NodeData::Text { decoded, .. } | NodeData::Cdata { decoded, .. } => {
            decoded.trim().to_string()
        }
        _ => String::new(),
    }
}

/// Engine xml.cpp:72-95 enterNode: walks the sibling chain starting at node
/// looking for an element whose getKey == key, and on a hit returns its **first
/// non-comment child node** — text or element alike (not a named-child lookup).
/// Also: tinyxml2's DOM has no text node that is "purely whitespace in the raw
/// bytes" — Identify (tinyxml2.cpp:715-723) skips whitespace on the **raw
/// bytes** before classifying, and only whitespace followed by real text falls
/// back to p=start to build a text node with a whitespace prefix (:782-786);
/// the default is PRESERVE_WHITESPACE (xml.h:1732, and the engine's
/// `new XMLDocument()` uses the default).
/// Entity decoding happens in GetStr (tinyxml2.cpp:286-360), after
/// classification — for a node like `&#32;` that becomes whitespace only after
/// decoding, the engine **does build it** (getKey = trim → empty name). So this
/// repo classifies and skips on raw bytes: a text span counts as a node the
/// engine would not have only if it is entirely C-locale whitespace; CDATA is
/// an explicit node and is built, not skipped.
fn engine_enter_node(doc: &Document, node: usize, key: &str) -> Option<usize> {
    let mut cur = Some(node);
    while let Some(idx) = cur {
        if matches!(doc.nodes[idx].data, NodeData::Element(_)) && engine_get_key(doc, idx) == key {
            return doc
                .element(idx)
                .children
                .iter()
                .copied()
                .find(|&c| match &doc.nodes[c].data {
                    NodeData::Comment { .. } => false,
                    NodeData::Text { span, .. } => !doc.source[span.start..span.end]
                        .bytes()
                        .all(is_engine_whitespace),
                    _ => true,
                });
        }
        cur = doc.nodes[idx].parent.and_then(|parent| {
            let siblings = &doc.element(parent).children;
            let pos = siblings.iter().position(|&c| c == idx)?;
            siblings.get(pos + 1).copied()
        });
    }
    None
}

/// C-locale isspace (the layer under tinyxml2's XMLUtil::IsWhiteSpace,
/// tinyxml2.h:569-572, via isspace(); UTF-8 continuation bytes are not
/// whitespace).
fn is_engine_whitespace(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\x0b' | b'\x0c' | b'\r')
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MethodDomain {
    Cell,
    Base,
    Client,
}

struct Replayer {
    stream: DefMd5Stream,
    types: DataTypesState,
    types_xml_text: String,
    entities_text: String,
    defs: HashMap<String, String>,
    component_scripts: HashSet<String>,
    /// entities.xml entry name → (hasClient,hasCell,hasBase) attribute values
    /// (defaults to -1).
    entities_attrs: HashMap<String, (i32, i32, i32)>,
    /// Module names whose def loading is complete (the loadComponents
    /// findScriptModule check).
    loaded_modules: HashSet<String>,
    /// KODE-AUD-006: active stack of the current def expansion path (re-entry
    /// means a cycle). load_interfaces / load_parent_class do not check
    /// loaded_modules, so a cyclic interface/parent chain (A→B→A) would recurse
    /// until stack overflow; `loading` marks the def name currently being
    /// expanded, and meeting it again truncates.
    loading: HashSet<String>,
    modules: HashMap<String, ModuleState>,
    /// g_propertyUtypeAuto/g_propertyUtypes(entitydef.cpp:45/1018-1093)。
    prop_utype_auto: u16,
    prop_utypes: Vec<u16>,
}

impl Replayer {
    fn new(params: DefMd5Params) -> Result<Self, String> {
        let mut entities_attrs = HashMap::new();
        if !params.entities_xml.trim().is_empty() {
            let doc = parse_xml(&params.entities_xml, false);
            let root = doc
                .root()
                .ok_or("entities.xml: no root element".to_string())?;
            for el in doc.child_elements(root) {
                let name = doc.element(el).name.clone();
                let attr = |key: &str| -> i32 {
                    match doc.element(el).attribute(key) {
                        Some(a) if a.value.trim().eq_ignore_ascii_case("true") => 1,
                        Some(_) => 0,
                        None => -1,
                    }
                };
                entities_attrs.insert(name, (attr("hasClient"), attr("hasCell"), attr("hasBase")));
            }
        }
        Ok(Replayer {
            stream: DefMd5Stream::new(),
            types: DataTypesState::new(),
            types_xml_text: params.types_xml,
            entities_text: params.entities_xml,
            defs: params.defs,
            component_scripts: params.component_scripts,
            entities_attrs,
            loaded_modules: HashSet::new(),
            loading: HashSet::new(),
            modules: HashMap::new(),
            prop_utype_auto: 1,
            prop_utypes: Vec::new(),
        })
    }

    fn module(&mut self, name: &str) -> &mut ModuleState {
        self.modules.entry(name.to_string()).or_default()
    }

    // ------------------------------------------------------------------
    // Phase1:DataTypes::initialize(datatypes.cpp:53-83 + loadTypes:94-187)
    // ------------------------------------------------------------------

    fn replay_builtin_types(&mut self) {
        for name in BUILTIN_TYPE_ORDER {
            // ENTITYCALL carries its class identity (EntityCallType) from
            // construction time, KR-AUD-82.
            let kind = if name == "ENTITYCALL" {
                TypeKind::EntityCall
            } else {
                TypeKind::Builtin
            };
            let id = self.types.construct(&mut self.stream, kind, "builtin-uid");
            self.types.register(name, id);
        }
    }

    fn replay_types_xml(&mut self) -> Result<(), String> {
        if self.types_xml_text.trim().is_empty() {
            return Ok(());
        }
        let text = self.types_xml_text.clone();
        let doc = parse_xml(&text, false);
        let root = match doc.root() {
            Some(r) => r,
            None => return Ok(()),
        };
        for el in doc.child_elements(root) {
            let alias_name = doc.element(el).name.clone();
            let type_text = first_text(&doc, el);
            if type_text == "FIXED_DICT" {
                let id = self
                    .types
                    .construct(&mut self.stream, TypeKind::Dict, "type-uid");
                self.replay_fixed_dict(&doc, el, &alias_name)?;
                self.types.register(&alias_name, id);
            } else if type_text == "ARRAY" {
                let id = self
                    .types
                    .construct(&mut self.stream, TypeKind::Array, "type-uid");
                let element = self.replay_array(&doc, el)?;
                if let Some(info) = self.types.info.get_mut(&id) {
                    info.element = Some(element);
                }
                self.types.register(&alias_name, id);
            } else if !type_text.is_empty() {
                let target = self.types.lookup(&type_text).ok_or_else(|| {
                    format!("types.xml: alias [{alias_name}] target [{type_text}] not found")
                })?;
                self.types.register(&alias_name, target);
            }
        }
        Ok(())
    }

    /// FixedArrayType::initialize: appends [element uid u16] + [element
    /// strType] (datatype.cpp:1715-1717; a nested ARRAY first enters its inner
    /// construction + initialization bytes). Returns the element type id (for
    /// the caller to fill back into ArrayTypeInfo.element).
    fn replay_array(&mut self, doc: &Document, of_parent_el: usize) -> Result<u16, String> {
        let of_el = child_el(doc, of_parent_el, "of")
            .ok_or_else(|| "FixedArrayType::initialize: not found \"of\"".to_string())?;
        let str_type = first_text(doc, of_el);
        if str_type == "ARRAY" {
            let inner = self
                .types
                .construct(&mut self.stream, TypeKind::Array, "array-uid");
            let inner_element = self.replay_array(doc, of_el)?;
            if let Some(info) = self.types.info.get_mut(&inner) {
                info.element = Some(inner_element);
            }
            self.stream
                .append_u16("array-element-uid", "datatype.cpp:1715-1716", inner);
            self.stream
                .append_str("array-element-type", "datatype.cpp:1717", "ARRAY");
            Ok(inner)
        } else {
            let element = self.types.lookup(&str_type).ok_or_else(|| {
                format!("FixedArrayType::initialize: element type [{str_type}] not found")
            })?;
            self.stream
                .append_u16("array-element-uid", "datatype.cpp:1715-1716", element);
            self.stream
                .append_str("array-element-type", "datatype.cpp:1717", &str_type);
            Ok(element)
        }
    }

    /// FixedDictType::initialize (XML): per key + implementedBy
    /// (datatype.cpp:2050-2196).
    fn replay_fixed_dict(
        &mut self,
        doc: &Document,
        dict_el: usize,
        parent_name: &str,
    ) -> Result<(), String> {
        let props_el = child_el(doc, dict_el, "Properties")
            .ok_or_else(|| "FixedDictType::initialize: not found \"Properties\"".to_string())?;
        let key_els: Vec<usize> = doc.child_elements(props_el);
        for key_el in key_els {
            let type_name = doc.element(key_el).name.clone();
            let type_el = match child_el(doc, key_el, "Type") {
                Some(t) => t,
                None => continue, // 无 Type 键被忽略(datatype.cpp:2161-2165)
            };
            let str_type = first_text(doc, type_el);
            let mut persistent = true;
            if let Some(p) = child_el(doc, key_el, "Persistent") {
                if first_text(doc, p) == "false" {
                    persistent = false;
                }
            }
            let mut database_length: u32 = 0;
            if let Some(d) = child_el(doc, key_el, "DatabaseLength") {
                database_length = first_text(doc, d).trim().parse().unwrap_or(0);
            }

            if str_type == "ARRAY" {
                let array_id =
                    self.types
                        .construct(&mut self.stream, TypeKind::Array, "dict-array-uid");
                let element = self.replay_array(doc, type_el)?;
                if let Some(info) = self.types.info.get_mut(&array_id) {
                    info.element = Some(element);
                }
                // dataType->getDataType()->type()==ENTITYCALL(datatype.cpp:2104)。
                if self.types.is_entitycall(element) {
                    persistent = false;
                }
                let _ = parent_name; // childName 不入流(datatype.cpp:2093)
                self.stream
                    .append_u16("dict-key-uid", "datatype.cpp:2096-2097", array_id);
                self.stream
                    .append_str("dict-key-type", "datatype.cpp:2098", "ARRAY");
                self.stream
                    .append_str("dict-key-name", "datatype.cpp:2099", &type_name);
                self.stream
                    .append_bool("dict-key-persistent", "datatype.cpp:2111", persistent);
                self.stream
                    .append_u32("dict-key-db-length", "datatype.cpp:2112", database_length);
            } else {
                let target = self.types.lookup(&str_type).ok_or_else(|| {
                    format!(
                        "FixedDictType::initialize: key [{type_name}] type [{str_type}] not found"
                    )
                })?;
                // dataType->type()==ENTITYCALL(datatype.cpp:2141)。
                if self.types.is_entitycall(target) {
                    persistent = false;
                }
                self.stream
                    .append_u16("dict-key-uid", "datatype.cpp:2133-2134", target);
                self.stream
                    .append_str("dict-key-type", "datatype.cpp:2135", &str_type);
                self.stream
                    .append_str("dict-key-name", "datatype.cpp:2136", &type_name);
                self.stream
                    .append_bool("dict-key-persistent", "datatype.cpp:2148", persistent);
                self.stream
                    .append_u32("dict-key-db-length", "datatype.cpp:2149", database_length);
            }
        }
        if let Some(impl_el) = child_el(doc, dict_el, "implementedBy") {
            let str_type = first_text(doc, impl_el);
            if !str_type.is_empty() {
                self.stream
                    .append_str("dict-implementedBy", "datatype.cpp:2184", &str_type);
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // Phase2: replay entities.xml entity by entity (entitydef.cpp:199-237)
    // ------------------------------------------------------------------

    fn replay_entities(&mut self) -> Result<(), String> {
        if self.entities_text.trim().is_empty() {
            return Ok(());
        }
        let text = self.entities_text.clone();
        let doc = parse_xml(&text, false);
        let root = match doc.root() {
            Some(r) => r,
            None => return Ok(()),
        };
        // Document-order snapshot (borrow conflict: collect the names first).
        let names: Vec<String> = doc
            .child_elements(root)
            .iter()
            .map(|&el| doc.element(el).name.clone())
            .collect();
        for name in names {
            self.register_new_script_module(&name);
            self.load_def_info(&name, &name, false)?;
        }
        Ok(())
    }

    /// registerNewScriptDefModule: constructs only if not already registered
    /// (the name enters the stream; entitydef.cpp:253-265).
    fn register_new_script_module(&mut self, name: &str) {
        if self.modules.contains_key(name) {
            return;
        }
        self.stream
            .append_str("module-name", "scriptdef_module.cpp:60", name);
        self.modules
            .insert(name.to_string(), ModuleState::default());
    }

    /// loadDefInfo (entitydef.cpp:339-400): the loading-order closure.
    /// `interfaces_ignore_components` is true only in the component branch
    /// (entitydef.cpp:765).
    fn load_def_info(
        &mut self,
        file_name: &str,
        module_name: &str,
        interfaces_ignore_components: bool,
    ) -> Result<(), String> {
        // KODE-AUD-006: active-stack protection — a cyclic component chain
        // (A→B→A) recurses via load_components → load_def_info, and meeting
        // `loading` again truncates (the engine's recursive loading cannot
        // terminate).
        if !self.loading.insert(file_name.to_string()) {
            return Ok(());
        }
        let result = (|| {
            let def_text = self
                .defs
                .get(file_name)
                .cloned()
                .ok_or_else(|| format!("def not found: {file_name}.def"))?;
            let doc = parse_xml(&def_text, false);
            let root = doc
                .root()
                .ok_or_else(|| format!("{file_name}.def: no root element"))?;
            self.load_all_def_descriptions(&doc, root, module_name)?;
            self.load_interfaces(&doc, root, module_name, interfaces_ignore_components)?;
            self.load_components(&doc, root, module_name)?;
            self.load_parent_class(&doc, root, module_name)?;
            // loadDetailLevelInfo/loadVolatileInfo do not enter the stream
            // (verified: no md5 appends).
            self.auto_match_comp_own(module_name);
            self.loaded_modules.insert(file_name.to_string());
            Ok(())
        })();
        self.loading.remove(file_name);
        result
    }

    /// loadAllDefDescriptions(entitydef.cpp:927-964):Properties→Cell→Base→Client。
    fn load_all_def_descriptions(
        &mut self,
        doc: &Document,
        root: usize,
        module_name: &str,
    ) -> Result<(), String> {
        if let Some(props_el) = child_el(doc, root, "Properties") {
            self.load_def_properties(doc, props_el, module_name)?;
        }
        if let Some(el) = child_el(doc, root, "CellMethods") {
            self.load_def_methods(doc, el, module_name, MethodDomain::Cell)?;
        }
        if let Some(el) = child_el(doc, root, "BaseMethods") {
            self.load_def_methods(doc, el, module_name, MethodDomain::Base)?;
        }
        if let Some(el) = child_el(doc, root, "ClientMethods") {
            self.load_def_methods(doc, el, module_name, MethodDomain::Client)?;
        }
        Ok(())
    }

    /// loadDefPropertys(entitydef.cpp:1097-1311)。
    fn load_def_properties(
        &mut self,
        doc: &Document,
        props_el: usize,
        module_name: &str,
    ) -> Result<(), String> {
        for prop_el in doc.child_elements(props_el) {
            let name = doc.element(prop_el).name.clone();
            let flags: u32 = match child_el(doc, prop_el, "Flags") {
                Some(f) => {
                    let str_flags = first_text(doc, f).to_uppercase();
                    let v = flags_value(&str_flags).ok_or_else(|| {
                        format!(
                            "loadDefPropertys: unknown flags [{str_flags}] {module_name}.{name}"
                        )
                    })?;
                    if v & ENTITY_BASE_DATA_FLAGS > 0 {
                        self.module(module_name).has_base = true;
                    }
                    if v & ENTITY_CELL_DATA_FLAGS > 0 {
                        self.module(module_name).has_cell = true;
                    }
                    if v & ENTITY_CLIENT_DATA_FLAGS > 0 {
                        self.module(module_name).has_client = true;
                    }
                    v
                }
                None => {
                    // The engine errors out and stops on a missing Flags
                    // (entitydef.cpp:1162-1176); some kode fixture properties
                    // lack Flags, so these are replayed leniently with flags=0
                    // (recorded in the trace).
                    0
                }
            };

            let mut is_persistent = false;
            if let Some(p) = child_el(doc, prop_el, "Persistent") {
                if first_text(doc, p) == "true" {
                    is_persistent = true;
                }
            }

            let type_el = child_el(doc, prop_el, "Type")
                .ok_or_else(|| format!("loadDefPropertys: no Type {module_name}.{name}"))?;
            let str_type = first_text(doc, type_el);
            let data_type = self.resolve_datatype(doc, type_el, &str_type, module_name, &name)?;

            let is_identifier = match child_el(doc, prop_el, "Identifier") {
                Some(i) => first_text(doc, i) == "true",
                None => false,
            };
            let mut database_length: u32 = 0;
            if let Some(d) = child_el(doc, prop_el, "DatabaseLength") {
                database_length = first_text(doc, d).trim().parse().unwrap_or(0);
            }
            let default_str = match child_el(doc, prop_el, "Default") {
                Some(d) => first_text(doc, d),
                None => String::new(),
            };
            let detail_level: i8 = match child_el(doc, prop_el, "DetailLevel") {
                Some(d) => match first_text(doc, d).as_str() {
                    "NEAR" => 0,
                    "MEDIUM" => 1,
                    _ => 2, // FAR 及未知缺省(entitydef.cpp:1116/1261-1268)
                },
                None => 2,
            };
            let i_utype = match child_el(doc, prop_el, "Utype") {
                Some(u) => first_text(doc, u).trim().parse::<i64>().unwrap_or(-1),
                None => -1,
            };
            let utype = self.calc_property_utype(i_utype, module_name)?;

            // PropertyDescription construction bytes (property.cpp:53-64; the
            // order is strict).
            self.stream
                .append_str("property-name", "property.cpp:53", &name);
            self.stream
                .append_str("property-default", "property.cpp:54", &default_str);
            self.stream
                .append_str("property-type", "property.cpp:55", &str_type);
            self.stream
                .append_u16("property-utype", "property.cpp:56", utype);
            self.stream
                .append_u32("property-flags", "property.cpp:57", flags);
            if is_persistent && self.types.is_entitycall(data_type) {
                is_persistent = false; // property.cpp:48-51 ENTITYCALL 覆盖
            }
            self.stream
                .append_bool("property-persistent", "property.cpp:58", is_persistent);
            self.stream
                .append_bool("property-identifier", "property.cpp:59", is_identifier);
            self.stream
                .append_u32("property-db-length", "property.cpp:60", database_length);
            self.stream.append(
                "property-detail-level",
                "property.cpp:61",
                &[detail_level as u8],
            );
            self.stream
                .append_u16("property-type-uid", "property.cpp:63-64", data_type);
        }
        Ok(())
    }

    /// `<Type>` resolution for properties/arguments: ARRAY is constructed
    /// inline (nested bytes enter the stream first), everything else is a table
    /// lookup (entitydef.cpp:1190-1212 / 1340-1353).
    fn resolve_datatype(
        &mut self,
        doc: &Document,
        type_el: usize,
        str_type: &str,
        module_name: &str,
        member_name: &str,
    ) -> Result<u16, String> {
        if str_type == "ARRAY" {
            let id = self
                .types
                .construct(&mut self.stream, TypeKind::Array, "inline-array-uid");
            let element = self.replay_array(doc, type_el)?;
            if let Some(info) = self.types.info.get_mut(&id) {
                info.element = Some(element);
            }
            let _ = (module_name, member_name); // childName 不入流
            Ok(id)
        } else {
            self.types.lookup(str_type).ok_or_else(|| {
                format!("dataType [{str_type}] not found ({module_name}.{member_name})")
            })
        }
    }

    /// calcDefPropertyUType (entitydef.cpp:1018-1093). The conflict check for
    /// an explicit Utype is **same-module** scoped: after the global
    /// g_propertyUtypes hit, the engine only consults
    /// `pScriptModule->findPropertyDescription(futype, base/cell/client)`, and
    /// if this module lacks the property it push_backs as usual — the engine
    /// tolerates reusing the same Utype across modules (KR-AUD-85; before the
    /// fix the global dedup was stricter and rejected valid defs). The global
    /// table still collects all utypes so the auto counter can skip taken
    /// numbers.
    fn calc_property_utype(&mut self, i_utype: i64, module_name: &str) -> Result<u16, String> {
        let futype: u16;
        if i_utype > 0 {
            futype =
                u16::try_from(i_utype).map_err(|_| format!("'Utype' overflowed: {i_utype}"))?;
            if self.module(module_name).prop_utypes.contains(&futype) {
                return Err(format!("'Utype' conflict: {futype}"));
            }
            self.prop_utypes.push(futype);
            self.module(module_name).prop_utypes.push(futype);
        } else {
            let mut candidate = self.prop_utype_auto;
            self.prop_utype_auto += 1;
            while self.prop_utypes.contains(&candidate) {
                candidate = self.prop_utype_auto;
                self.prop_utype_auto += 1;
            }
            self.prop_utypes.push(candidate);
            self.module(module_name).prop_utypes.push(candidate);
            futype = candidate;
        }
        Ok(futype)
    }

    /// loadDef{Cell,Base,Client}Methods(entitydef.cpp:1314+/1440+/1602+):
    /// Construction = [name] + [utype always 0] + [exposedType 4B]; child nodes
    /// are processed in document order (Exposed → [exposed 4B]; Arg → inline
    /// ARRAY bytes + [uid] + [exposed 4B]; Utype contributes no bytes: setUType
    /// appends nothing). ClientMethods have no Exposed branch.
    fn load_def_methods(
        &mut self,
        doc: &Document,
        methods_el: usize,
        module_name: &str,
        domain: MethodDomain,
    ) -> Result<(), String> {
        for method_el in doc.child_elements(methods_el) {
            let name = doc.element(method_el).name.clone();
            self.stream
                .append_str("method-name", "method.cpp:28", &name);
            self.stream
                .append_u16("method-utype(=0)", "method.cpp:29", 0);
            let mut exposed: i32 = 0; // NO_EXPOSED(method.h:30)
            self.stream
                .append_i32("method-exposed", "method.cpp:30", exposed);
            for child in doc.child_elements(method_el) {
                let key = doc.element(child).name.clone();
                match key.as_str() {
                    "Exposed" if domain != MethodDomain::Client => {
                        exposed = 1; // EXPOSED(method.h:33)
                        self.stream
                            .append_i32("method-set-exposed", "method.cpp:50", exposed);
                    }
                    "Arg" => {
                        // Engine: typeNode = argNode->FirstChild();
                        // getValStr(typeNode) (entitydef.cpp:1486-1488/1620-1622)
                        // = the **Arg element's own text**, not a `<Type>` child
                        // element; an inline ARRAY navigates via `<of>` (a child
                        // of Arg).
                        let str_type = first_text(doc, child);
                        let data_type =
                            self.resolve_datatype(doc, child, &str_type, module_name, &name)?;
                        self.stream
                            .append_u16("method-arg-uid", "method.cpp:66", data_type);
                        // pushArgType carries the exposedType_ at that moment
                        // (method.cpp:67).
                        self.stream
                            .append_i32("method-arg-exposed", "method.cpp:67", exposed);
                    }
                    _ => {} // Utype 等无字节
                }
            }
            // addMethodDescription does not enter the stream; neither does the
            // auto-allocated utype (setUType appends nothing).
            let m = self.module(module_name);
            match domain {
                MethodDomain::Cell => {
                    m.has_cell = true;
                    if exposed == 1 {
                        m.cell_exposed_methods += 1;
                    }
                }
                MethodDomain::Base => {
                    m.has_base = true;
                    if exposed == 1 {
                        m.base_exposed_methods += 1;
                    }
                }
                MethodDomain::Client => {
                    m.has_client = true;
                }
            }
        }
        Ok(())
    }

    /// loadInterfaces (entitydef.cpp:551-639, recursive; contents merge into
    /// the current module, the interface name never enters the stream).
    fn load_interfaces(
        &mut self,
        doc: &Document,
        root: usize,
        module_name: &str,
        ignore_components: bool,
    ) -> Result<(), String> {
        let interfaces_el = match child_el(doc, root, "Interfaces") {
            Some(i) => i,
            None => return Ok(()),
        };
        for if_entry in doc.child_elements(interfaces_el) {
            // Engine entitydef.cpp:562-565: the entry's getKey (= element name)
            // must be one of {interface,Interface,type,Type}, otherwise continue.
            let entry_key = engine_get_key(doc, if_entry);
            if !matches!(
                entry_key.as_str(),
                "interface" | "Interface" | "type" | "Type"
            ) {
                continue;
            }
            // Engine entitydef.cpp:567-584: interfaceNode =
            // enterNode(entry, key), trying the four keys in turn — the first
            // non-comment child node; interface name = getKey(interfaceNode):
            // the text form `<interface> ROLE </interface>` yields "ROLE", the
            // element form `<interface><Tank/></interface>` yields the element
            // name "Tank".
            let interface_node = ["Interface", "interface", "Type", "type"]
                .iter()
                .find_map(|k| engine_enter_node(doc, if_entry, k));
            let interface_node = match interface_node {
                Some(n) => n,
                None => continue,
            };
            let interface_name = engine_get_key(doc, interface_node);
            // KODE-AUD-006: active-stack protection — a cyclic interface chain
            // (A→B→A) does not check loaded_modules and would recurse until
            // stack overflow; meeting `loading` again truncates. Removed when
            // done, and it must be removed before the error propagates (otherwise
            // leftovers in `loading` pollute later expansions).
            if !self.loading.insert(interface_name.clone()) {
                continue;
            }
            let result = (|| {
                let text = self
                    .defs
                    .get(&interface_name)
                    .cloned()
                    .ok_or_else(|| format!("interface def not found: {interface_name}.def"))?;
                let idoc = parse_xml(&text, false);
                let iroot = idoc
                    .root()
                    .ok_or_else(|| format!("{interface_name}.def: no root"))?;
                self.load_all_def_descriptions(&idoc, iroot, module_name)?;
                if !ignore_components {
                    self.load_components(&idoc, iroot, module_name)?;
                }
                self.load_interfaces(&idoc, iroot, module_name, ignore_components)
            })();
            self.loading.remove(&interface_name);
            result?;
        }
        Ok(())
    }

    /// loadComponents(entitydef.cpp:642-818)。
    fn load_components(
        &mut self,
        doc: &Document,
        root: usize,
        module_name: &str,
    ) -> Result<(), String> {
        let components_el = match child_el(doc, root, "Components") {
            Some(c) => c,
            None => return Ok(()),
        };
        for comp_entry in doc.child_elements(components_el) {
            // Engine entitydef.cpp:655: componentName = getKey(entry) =
            // the element name.
            let component_name = engine_get_key(doc, comp_entry);
            // enterNode(entry, componentName) (entitydef.cpp:656) = the entry's
            // first non-comment child node (text or element).
            let comp_node = match engine_enter_node(doc, comp_entry, &component_name) {
                Some(n) => n,
                None => continue,
            };
            // The back half of the engine's three-step navigation at
            // entitydef.cpp:663-671: componentTypeNameNode =
            // enterNode(componentNode,"Type"), componentTypeName = getKey(·) —
            // i.e. the `<Type>` text (trimmed), not the element name literal
            // "Type".
            let component_type_name = match engine_enter_node(doc, comp_node, "Type") {
                Some(n) => engine_get_key(doc, n),
                None => String::new(),
            };
            if component_type_name.is_empty() {
                // Engine entitydef.cpp:668-671: componentTypeName=="" → return
                // false.
                return Err(format!("component name is NULL: {component_name}"));
            }

            let mut is_persistent = true;
            if let Some(p) = child_el(doc, comp_entry, "Persistent") {
                if first_text(doc, p) == "false" {
                    is_persistent = false;
                }
            }
            let i_utype = match child_el(doc, comp_entry, "Utype") {
                Some(u) => first_text(doc, u).trim().parse::<i64>().unwrap_or(-1),
                None => -1,
            };
            let utype = self.calc_property_utype(i_utype, module_name)?;

            if !self.loaded_modules.contains(&component_type_name) {
                // New component: register (the name enters the stream) + load its
                // def (interfaces ignore components: 765) + parent class
                // (components/ directory) + autoMatchCompOwn (791).
                self.register_new_script_module(&component_type_name);
                self.module(&component_type_name).is_component = true;
                // Component script existence → domain bits
                // (scriptdef_module.cpp:306-320).
                if self
                    .component_scripts
                    .contains(&format!("base:{component_type_name}"))
                {
                    self.module(&component_type_name).has_base = true;
                }
                if self
                    .component_scripts
                    .contains(&format!("cell:{component_type_name}"))
                {
                    self.module(&component_type_name).has_cell = true;
                }
                self.load_def_info(&component_type_name, &component_type_name, true)?;
            }

            // flags are derived from the component's hasBase/hasCell/hasClient
            // (entitydef.cpp:793-808).
            let flags = {
                let m = self.module(&component_type_name);
                let mut f = 0u32;
                if m.has_base {
                    f |= 0x0040; // ED_FLAG_BASE
                }
                if m.has_cell {
                    f |= 0x0001; // ED_FLAG_CELL_PUBLIC
                }
                if m.has_client {
                    if m.has_base {
                        f |= 0x0020; // ED_FLAG_BASE_AND_CLIENT
                    } else {
                        f |= 0x009c; // ALL_CLIENTS|CELL_PUBLIC_AND_OWN|OTHER_CLIENTS|OWN_CLIENT
                    }
                }
                f
            };

            // addComponentProperty(entitydef.cpp:821-843):EntityComponentType
            // Construct the uid (creating a new one only for names unknown to
            // types) + PropertyDescription("EntityComponent").
            let ec_id = match self.types.lookup(&component_type_name) {
                Some(id) => id,
                None => {
                    let id = self.types.construct(
                        &mut self.stream,
                        TypeKind::EntityComponent,
                        "entity-component-uid",
                    );
                    self.types.register(&component_type_name, id);
                    id
                }
            };
            self.stream
                .append_str("component-prop-name", "property.cpp:53", &component_name);
            self.stream
                .append_str("component-prop-default", "property.cpp:54", "");
            self.stream
                .append_str("component-prop-type", "property.cpp:55", "EntityComponent");
            self.stream
                .append_u16("component-prop-utype", "property.cpp:56", utype);
            self.stream
                .append_u32("component-prop-flags", "property.cpp:57", flags);
            self.stream.append_bool(
                "component-prop-persistent",
                "property.cpp:58",
                is_persistent,
            );
            self.stream
                .append_bool("component-prop-identifier", "property.cpp:59", false);
            self.stream
                .append_u32("component-prop-db-length", "property.cpp:60", 0);
            self.stream.append(
                "component-prop-detail-level",
                "property.cpp:61",
                &[2u8], // DETAIL_LEVEL_FAR
            );
            self.stream
                .append_u16("component-prop-type-uid", "property.cpp:63-64", ec_id);

            // The component property sets the host's domain bits
            // (entitydef.cpp:851-861).
            if flags & ENTITY_BASE_DATA_FLAGS > 0 {
                self.module(module_name).has_base = true;
            }
            if flags & ENTITY_CELL_DATA_FLAGS > 0 {
                self.module(module_name).has_cell = true;
            }
            if flags & ENTITY_CLIENT_DATA_FLAGS > 0 {
                self.module(module_name).has_client = true;
            }
        }
        Ok(())
    }

    /// loadParentClass (entitydef.cpp:890-924): the parent def merges into the
    /// current module (the parent module name is not registered; the parent's
    /// autoMatchCompOwn appends int32s according to the entities.xml entry).
    fn load_parent_class(
        &mut self,
        doc: &Document,
        root: usize,
        module_name: &str,
    ) -> Result<(), String> {
        let parent_el = match child_el(doc, root, "Parent") {
            Some(p) => p,
            None => return Ok(()),
        };
        // Engine entitydef.cpp:897-899: parentClassName =
        // getKey(enterNode(defNode,"Parent")) — enterNode returns the first
        // non-comment child node of <Parent>, and getKey = trim(Value)
        // (xml.cpp:72-95/113-119): the text form `<Parent> A </Parent>` yields
        // "A", the element form `<Parent><A/></Parent>` yields the element name
        // "A" (KR-AUD-83; before the fix only first_text was taken, so the
        // element form yielded an empty string).
        let parent_name = engine_enter_node(doc, parent_el, "Parent")
            .map(|node| engine_get_key(doc, node))
            .unwrap_or_default();
        // KODE-AUD-006: active-stack protection — a cyclic parent chain
        // (A→B→A) does not check loaded_modules and would recurse until stack
        // overflow; meeting `loading` again truncates. Removed when done (and it
        // must be removed before the error propagates).
        if !self.loading.insert(parent_name.clone()) {
            return Ok(());
        }
        let result = (|| {
            let text = self
                .defs
                .get(&parent_name)
                .cloned()
                .ok_or_else(|| format!("parent def not found: {parent_name}.def"))?;
            let pdoc = parse_xml(&text, false);
            let proot = pdoc
                .root()
                .ok_or_else(|| format!("{parent_name}.def: no root"))?;
            self.load_all_def_descriptions(&pdoc, proot, module_name)?;
            self.load_interfaces(&pdoc, proot, module_name, false)?;
            self.load_components(&pdoc, proot, module_name)?;
            self.load_parent_class(&pdoc, proot, module_name)?;
            // The engine's loadDefInfo calls pScriptModule->autoMatchCompOwn()
            // at the tail of every recursion level (entitydef.cpp:398); inside,
            // it looks up entities.xml using the module's own name_ (the child
            // module) → every parent-chain level appends the child module's
            // 3×int32 again (an engine quirk, mirrored faithfully in the
            // replay).
            self.auto_match_comp_own(module_name);
            Ok(())
        })();
        self.loading.remove(&parent_name);
        result
    }

    /// autoMatchCompOwn(scriptdef_module.cpp:302-530):
    /// - Component modules exit early (304-331); exposed methods can still set
    ///   hasClient (322-328);
    /// - Entity modules append the 3×int32 only when entities.xml has an entry
    ///   of that name (defaults to -1, with value 1/0).
    fn auto_match_comp_own(&mut self, name: &str) {
        let m = self.modules.get(name).cloned().unwrap_or_default();
        if m.is_component {
            if !m.has_client
                && ((m.has_base && m.base_exposed_methods > 0)
                    || (m.has_cell && m.cell_exposed_methods > 0))
            {
                self.module(name).has_client = true;
            }
            return;
        }
        if let Some(&(has_client, has_cell, has_base)) = self.entities_attrs.get(name) {
            self.stream
                .append_i32("assertionHasClient", "scriptdef_module.cpp:375", has_client);
            self.stream
                .append_i32("assertionHasCell", "scriptdef_module.cpp:386", has_cell);
            self.stream
                .append_i32("assertionHasBase", "scriptdef_module.cpp:397", has_base);
        }
    }
}

/// Computes the composite def md5 (Phase1 types.xml + Phase2 entities.xml, in
/// the engine's execution order).
pub fn compute_def_md5(params: DefMd5Params) -> Result<DefMd5Result, String> {
    let mut replayer = Replayer::new(params)?;
    replayer.replay_builtin_types();
    replayer.replay_types_xml()?;
    replayer.replay_entities()?;
    Ok(replayer.stream.finish())
}

// ===========================================================================
// RPC
// ===========================================================================

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/def/md5", md5_handler);
}

fn md5_handler(params: Value) -> Result<Value, String> {
    let types_xml = params
        .get("typesXml")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let entities_xml = params
        .get("entitiesXml")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut defs = HashMap::new();
    if let Some(map) = params.get("defs").and_then(|v| v.as_object()) {
        for (k, v) in map {
            if let Some(text) = v.as_str() {
                defs.insert(k.clone(), text.to_string());
            }
        }
    }
    let alias_xml = params
        .get("aliasXml")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut component_scripts = HashSet::new();
    if let Some(list) = params.get("componentScripts").and_then(|v| v.as_array()) {
        for v in list {
            if let Some(s) = v.as_str() {
                component_scripts.insert(s.to_string());
            }
        }
    }
    let result = compute_def_md5(DefMd5Params {
        types_xml,
        entities_xml,
        defs,
        alias_xml,
        component_scripts,
    })?;
    Ok(result.to_json())
}
