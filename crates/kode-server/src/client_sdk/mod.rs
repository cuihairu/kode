//! 客户端实体 SDK 生成核心(`$/kode/sdk/generate`,Rust 单一生产者)。
//!
//! 与 TS `src/clientSdkGenerator.ts` 旧纯生产器**逐字节对拍**:同一份 .def/
//! types.xml 输入产出相同文件内容。TS 侧只留读盘(UI 壳/写盘)与 Rust 不可用
//! 时的回落分支,生成逻辑收敛到这里(单一来源 = Rust)。
//!
//! 入参 = `{ language, entities: [{name, defText}], typesXml, generatedAt,
//! engineTrace?, namespace? }`,返回 = `[{ fileName, content }]`。handler 是
//! 纯函数(params 由 TS 直传,不依赖 mirror 语料、不读盘);畸形 def(结构
//! 错误)按 TS parseClientSdkEntity→null 同口径跳过,单份坏 def 不打断整批。

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use kode_parser::diag::{DiagCode, LineMap};
use kode_parser::model::{flag_domains, normalize_flag_tokens};
use kode_parser::xml::{self, Document, NodeData};

use crate::rpc::RpcRegistry;

/// FIXED_DICT 伴随文件基名(无扩展名;与 TS 同源常量)。
pub const FIXED_DICTS_BASENAME: &str = "ClientSdkFixedDicts";
/// 组件类型类伴随文件基名(无扩展名;与 TS 同源常量)。
pub const COMPONENTS_BASENAME: &str = "ClientSdkComponents";
/// C# 输出命名空间缺省值(Unity 客户端工程可自行改)。
pub const DEFAULT_CSHARP_NAMESPACE: &str = "KbEngineClient";
/// 生成文件头部固定第一行(手写会在下次生成被覆盖)。
const GENERATED_HEADER_LINE: &str =
    "// 由 kode 客户端实体 SDK 生成器生成，手动修改会在下次生成时被覆盖";
/// 引擎溯源探测不到时的字面量(不猜不空缺)。
const TRACE_UNKNOWN: &str = "unknown";

/// 注册 `$/kode/sdk/generate` handler。
pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/sdk/generate", generate_handler);
}

// ---------------------------------------------------------------------------
// 内建类型映射(语言中立 → 目标语言;与 TS TS_BUILTIN_TYPES/CS_BUILTIN_TYPES 同表)
// ---------------------------------------------------------------------------

/// 引擎内置类型 → TypeScript。
const TS_BUILTIN_TYPES: &[(&str, &str)] = &[
    ("UINT8", "number"),
    ("UINT16", "number"),
    ("UINT32", "number"),
    // IDE-AUD-063:64 位整数用 bigint 保全域精确(number 为 float64,2^53+1 起静默丢精度)。
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

/// 引擎内置类型 → C#(向量默认 Vector2/3/4,Unity 自带)。
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

/// 内建类型名缺失时的兜底(TS=unknown,C#=object)。
fn builtin_table(language: &str) -> &'static [(&'static str, &'static str)] {
    if language == "csharp" {
        CS_BUILTIN_TYPES
    } else {
        TS_BUILTIN_TYPES
    }
}

fn fallback_for(language: &str) -> &'static str {
    if language == "csharp" {
        "object"
    } else {
        "unknown"
    }
}

// ---------------------------------------------------------------------------
// 语义模型(.def → 实体;types.xml → 类型表)
// ---------------------------------------------------------------------------

struct SdkProperty {
    name: String,
    /// `<Type>` 直文本;ARRAY 为 `ARRAY`。
    type_name: String,
    /// ARRAY 的 `<of>` 文本;非容器为 None。
    element_type: Option<String>,
    /// `<Flags>` 原文(trim)。
    flags: String,
    /// 三域位(base/cell/client)。
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

/// 组件槽 SDK 面:slot 成员 + 组件类型类(客户端可见属性)。
struct SdkComponent {
    slot: String,
    type_name: String,
    /// 客户端可见属性(组件模块自身 + 接口 + 父类递归,按名去重首个)。
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
}

struct SdkEntityInput {
    name: String,
    def_text: String,
}

/// 组件 def 原文表(按名;TS 闭包发现 category 'component' 递归收集)。
type ComponentDefs = HashMap<String, String>;

struct EngineTrace {
    engine_version: String,
    engine_commit: String,
}

/// handler 入参(与 TS RPC 契约一一对应)。
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
// .def 解析(与 TS parseClientSdkEntity / parseDefFileSemantics 同口径)
// ---------------------------------------------------------------------------

/// 结构错误判定:TS fxp 对未闭合/闭合不匹配/游离闭合会抛错 →
/// parseClientSdkEntity 返回 null(跳过该 def)。Rust 容错恢复不出 panic,
/// 在此把同类结构性错误收束成「跳过」,保持两侧行为一致。
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

/// TS getReferenceTargetName:遍历子节点,首个非空 trim 文本取其值,
/// 否则首个元素子节点取其名(引擎口径:`<Parent><Entity/></Parent>` → Entity)。
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

/// TS readDefTypeNode:`<Type>` 直文本 + `<of>` 文本分两栏。
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

/// TS readDefMethods:一段方法(可只收 Exposed),Arg 只有类型没有名字。
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

/// 组件槽 `<Type>` 名:文本直取,空回落首个元素子名(与 message_table node_value 同口径)。
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

/// 组件模块客户端可见属性:自身 + 接口 + 父类(components/ 下)递归按名去重
/// (首个即自身优先);缺失 def 返回 None(调用方跳过该槽/该引用)。
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

/// TS parseClientSdkEntity:def 内容 → 实体模型;结构错误返回 None(跳过)。
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
            // 缺失组件 def → 跳过该槽(宽容;引擎整表失败,SDK 面按 message_table
            // 同口径报 issue 由 TS 侧闭包面处理,此处静默跳过)。
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
// types.xml → 类型表(与 TS getCustomTypeInfos + buildClientSdkTypeMap 同口径)
// ---------------------------------------------------------------------------

/// TS normalizeXmlText:连续空白折叠成单空格后 trim;空 → None。
fn normalize_xml_text(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// TS renderStructureNode:元素 → `<name>…</name>` XML 串(自闭合短形)。
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

/// TS extractCustomTypeRawValue:文本 chunk 规范化 + 元素结构串(跳过
/// implementedBy/Properties)拼接;全空 → `ALIAS`。
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

/// TS extractCustomTypeAliasType:rawValue 首个标识符 token;无 → `ALIAS`。
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

/// TS parseCustomTypeProperties:FIXED_DICT 字段清单(name + Type + 行号)。
/// TS 侧按 name 排序;字段缺 `<Type>` → typeName=None(生成时按语言兜底)。
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 内建表覆盖引擎注册全集(与 kode-types 同口径):内建类型清单漂移时
    /// 生成面不得静默缺失映射。
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
        }
    }

    /// 结构错误判定只收束 fxp 抛错同类(未闭合/错配/游离闭合/非法标签名);
    /// 良构文档不得误判(误判会整份 def 被跳过)。
    #[test]
    fn is_structural_error_matches_wire_skip_class() {
        assert!(!is_structural_error(&xml::parse(
            "<root><A/></root>",
            false
        )));
        // 闭合标签缺名(`</>`)→ InvalidTagName,与 fxp 抛错同类。
        assert!(is_structural_error(&xml::parse("<root></></root>", false)));
    }

    /// 引用目标名:文本形态(trim 后非空)优先,元素形态取首个元素子名,
    /// 纯注释子节点 → 空串。
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

    /// 缺 `<Type>` 子元素 → (空, None);不动 Flags 等兄弟节点。
    #[test]
    fn read_def_type_node_without_type_is_empty() {
        let doc = xml::parse("<root><hp><Flags>ALL_CLIENTS</Flags></hp></root>", false);
        let root = doc.root().unwrap();
        let hp = doc.child_element(root, "hp").unwrap();
        let (type_name, element_type) = read_def_type_node(&doc, doc.child_element(hp, "Type"));
        assert_eq!(type_name, "");
        assert_eq!(element_type, None);
    }

    /// 组件槽类型名:无 `<Type>` → 空;直文本空时回落首个元素子名;全空 → 空。
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

    /// 组件 def 结构错误 → None(调用方跳过该槽),不 panic。
    #[test]
    fn parse_component_properties_structural_error_is_none() {
        let mut defs = ComponentDefs::new();
        defs.insert("Bad".into(), "<root></></root>".into());
        assert!(parse_component_properties("Bad", &defs, &mut HashSet::new()).is_none());
    }

    /// 无 `Properties` 段的组件 → 空清单(仍是 Some,槽不丢)。
    #[test]
    fn parse_component_properties_without_properties_is_empty() {
        let mut defs = ComponentDefs::new();
        defs.insert("NP".into(), "<root><Parent>Ghost</Parent></root>".into());
        let out = parse_component_properties("NP", &defs, &mut HashSet::new()).unwrap();
        assert!(out.is_empty());
    }

    /// 接口与父类递归并入客户端可见属性,同名去重(自身优先)。
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

    /// 无 `Properties` 段的实体照常成模;组件空槽(缺 `<Type>`)跳过不炸。
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

    /// 槽 `<Type>` 直文本空但含元素子 → 元素名即组件类型;组件客户端属性入槽。
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

    /// 连续空白折叠成单空格;纯空白 → None。
    #[test]
    fn normalize_xml_text_collapses_whitespace() {
        assert_eq!(normalize_xml_text("  a \n b\tc  "), Some("a b c".into()));
        assert_eq!(normalize_xml_text("   \n  "), None);
    }

    /// 结构串渲染:自闭合短形;嵌套元素递归,文本原样保留。
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

    /// 自定义类型 rawValue:文本 chunk 规范化 + 元素结构串,跳过
    /// implementedBy/Properties 与注释;全空 → ALIAS。
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
