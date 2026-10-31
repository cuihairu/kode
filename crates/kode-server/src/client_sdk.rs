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
    ("UINT64", "number"),
    ("INT8", "number"),
    ("INT16", "number"),
    ("INT32", "number"),
    ("INT64", "number"),
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

struct SdkEntity {
    name: String,
    parent: Option<String>,
    properties: Vec<SdkProperty>,
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

struct EngineTrace {
    engine_version: String,
    engine_commit: String,
}

/// handler 入参(与 TS RPC 契约一一对应)。
struct SdkGenerateParams {
    language: String,
    entities: Vec<SdkEntityInput>,
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

/// TS parseClientSdkEntity:def 内容 → 实体模型;结构错误返回 None(跳过)。
fn parse_entity(def_text: &str, name: &str) -> Option<SdkEntity> {
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
            let (type_name, element_type) = read_def_type_node(&doc, doc.child_element(property, "Type"));
            let flags = doc.scalar_child_value(property, "Flags").unwrap_or_default();
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

    Some(SdkEntity {
        name: name.to_string(),
        parent,
        properties,
        client_methods: read_def_methods(&doc, root, "ClientMethods", false),
        exposed_base_methods: read_def_methods(&doc, root, "BaseMethods", true),
        exposed_cell_methods: read_def_methods(&doc, root, "CellMethods", true),
    })
}

fn client_visible_properties(entity: &SdkEntity) -> Vec<&SdkProperty> {
    entity.properties.iter().filter(|p| p.client_visible()).collect()
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
    while end < bytes.len()
        && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_')
    {
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

/// types.xml → 类型表(内建表 + 别名 + FIXED_DICT;与 TS 同口径)。
fn build_client_sdk_type_map(types_xml: Option<&str>, language: &str) -> TypeMap {
    let mut aliases: HashMap<String, String> = HashMap::new();
    let mut fixed_dicts: HashMap<String, FixedDictType> = HashMap::new();

    if let Some(text) = types_xml {
        let doc = xml::parse(text, false);
        if let Some(root) = doc.root() {
            let lines = LineMap::new(text);
            for type_node in doc.child_elements(root) {
                let element = doc.element(type_node);
                let raw_value = extract_custom_type_raw_value(&doc, type_node);
                aliases.insert(element.name.clone(), extract_custom_type_alias_type(&raw_value));
                let properties = parse_custom_type_properties(&doc, type_node, &lines);
                if !properties.is_empty() {
                    fixed_dicts.insert(
                        element.name.clone(),
                        FixedDictType {
                            name: element.name.clone(),
                            source_line: Some(lines.line_of(element.name_span.start)),
                            properties,
                        },
                    );
                }
            }
        }
    }

    TypeMap {
        builtin: builtin_table(language),
        aliases,
        fixed_dicts,
        fallback: fallback_for(language),
    }
}

// ---------------------------------------------------------------------------
// 类型名解析与发射(与 TS resolveClientSdkTypeName / generate* 同口径)
// ---------------------------------------------------------------------------

fn resolve_type_name(
    type_map: &TypeMap,
    type_name: &str,
    element_type: Option<&str>,
) -> String {
    if let Some(element) = element_type {
        return format!("{}[]", resolve_type_name(type_map, element, None));
    }
    if let Some(builtin) = type_map
        .builtin
        .iter()
        .find(|(name, _)| *name == type_name)
        .map(|(_, value)| *value)
    {
        return builtin.to_string();
    }
    if type_map.fixed_dicts.contains_key(type_name) {
        return type_name.to_string();
    }
    if let Some(alias) = type_map.aliases.get(type_name) {
        if alias != type_name && !type_map.aliases.contains_key(alias) {
            return resolve_type_name(type_map, alias, None);
        }
    }
    type_map.fallback.to_string()
}

fn resolve_property_type(type_map: &TypeMap, property: &SdkProperty) -> String {
    resolve_type_name(type_map, &property.type_name, property.element_type.as_deref())
}

fn resolve_arg_type(type_map: &TypeMap, type_name: &str) -> String {
    resolve_type_name(type_map, type_name, None)
}

/// def 的 `<Arg>` 只有类型没有名字,统一给 `arg0/arg1…` 编号。
fn format_arg_types(type_map: &TypeMap, arg_types: &[String], language: &str) -> String {
    arg_types
        .iter()
        .enumerate()
        .map(|(index, arg)| {
            let resolved = resolve_arg_type(type_map, arg);
            if language == "typescript" {
                format!("_arg{index}: {resolved}")
            } else {
                format!("{resolved} arg{index}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn format_arg_ids(arg_types: &[String], underscored: bool) -> String {
    arg_types
        .iter()
        .enumerate()
        .map(|(index, _)| format!("{}arg{index}", if underscored { "_" } else { "" }))
        .collect::<Vec<_>>()
        .join(", ")
}

fn to_pascal_case(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn used_fixed_dict_types<'a>(entity: &SdkEntity, type_map: &'a TypeMap) -> Vec<&'a FixedDictType> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut used: Vec<&FixedDictType> = Vec::new();
    for property in client_visible_properties(entity) {
        if let Some(dict) = type_map.fixed_dicts.get(&property.type_name) {
            if seen.insert(dict.name.as_str()) {
                used.push(dict);
            }
        }
    }
    used
}

fn engine_trace_lines(engine_trace: Option<&EngineTrace>) -> Vec<String> {
    let (version, commit) = match engine_trace {
        Some(trace) => {
            let value = |field: &str| {
                if field.is_empty() {
                    TRACE_UNKNOWN.to_string()
                } else {
                    field.to_string()
                }
            };
            (
                value(&trace.engine_version),
                value(&trace.engine_commit),
            )
        }
        None => (TRACE_UNKNOWN.to_string(), TRACE_UNKNOWN.to_string()),
    };
    vec![
        format!("// 引擎版本: {version}"),
        format!("// 引擎提交: {commit}"),
    ]
}

fn def_header(language: &str, generated_at: &str, trace_lines: &[String]) -> Vec<String> {
    let mut lines = vec![
        GENERATED_HEADER_LINE.to_string(),
        format!(
            "// 目标语言: {}",
            if language == "typescript" { "TypeScript" } else { "C#" }
        ),
        format!("// 生成时间: {generated_at}"),
    ];
    lines.extend(trace_lines.iter().cloned());
    lines.push(String::new());
    lines
}

fn generate_ts_entity(
    entity: &SdkEntity,
    type_map: &TypeMap,
    generated_at: &str,
    trace_lines: &[String],
) -> String {
    let mut lines = def_header("typescript", generated_at, trace_lines);
    let parent_note = match &entity.parent {
        Some(parent) => format!(" 父类: {parent}"),
        None => String::new(),
    };
    lines.push(format!("// 实体: {}{}", entity.name, parent_note));
    lines.push(String::new());

    let used = used_fixed_dict_types(entity, type_map);
    if !used.is_empty() {
        let names = used.iter().map(|dict| dict.name.clone()).collect::<Vec<_>>().join(", ");
        lines.push(format!(
            "import {{ {names} }} from './{FIXED_DICTS_BASENAME}';"
        ));
        lines.push(String::new());
    }

    lines.push(format!("export class {} {{", entity.name));
    lines.push("  /** 实体 id（由 baseapp 分配） */".to_string());
    lines.push("  public readonly entityId: number;".to_string());

    for property in client_visible_properties(entity) {
        lines.push(String::new());
        lines.push(format!("  /** Flags: {} */", property.flags));
        lines.push(format!(
            "  public {}: {};",
            property.name,
            resolve_property_type(type_map, property)
        ));
    }

    lines.push(String::new());
    lines.push("  public constructor(entityId: number) {".to_string());
    lines.push("    this.entityId = entityId;".to_string());
    lines.push("  }".to_string());

    for method in &entity.client_methods {
        lines.push(String::new());
        let arg_comment = method
            .arg_types
            .iter()
            .map(|arg| resolve_arg_type(type_map, arg))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!(
            "  /** ClientMethods 回调: {}({arg_comment}) */",
            method.name
        ));
        let args = format_arg_types(type_map, &method.arg_types, "typescript");
        lines.push(format!("  public {}({args}): void {{", method.name));
        lines.push("    // TODO: 实现客户端回调".to_string());
        lines.push("  }".to_string());
    }

    for section in [
        (
            &entity.exposed_base_methods,
            "Exposed BaseMethods（客户端可请求）",
            "onBaseOutgoing",
            "baseCall",
        ),
        (
            &entity.exposed_cell_methods,
            "Exposed CellMethods（客户端可请求）",
            "onCellOutgoing",
            "cellCall",
        ),
    ] {
        let (methods, label, seam, call_prefix) = section;
        for method in methods {
            lines.push(String::new());
            lines.push(format!("  /** {label}: {} */", method.name));
            let args = format_arg_types(type_map, &method.arg_types, "typescript");
            let call_args = format_arg_ids(&method.arg_types, true);
            lines.push(format!(
                "  public {}{}({args}): void {{",
                call_prefix,
                to_pascal_case(&method.name)
            ));
            lines.push(format!(
                "    this.{seam}('{}', [{call_args}]);",
                method.name
            ));
            lines.push("  }".to_string());
        }
    }

    lines.push(String::new());
    lines.push("  /** 发送接缝: 按客户端插件的 base 调用通道实现 */".to_string());
    lines.push("  protected onBaseOutgoing(_method: string, _args: unknown[]): void {".to_string());
    lines.push("  }".to_string());
    lines.push("  /** 发送接缝: 按客户端插件的 cell 调用通道实现 */".to_string());
    lines.push("  protected onCellOutgoing(_method: string, _args: unknown[]): void {".to_string());
    lines.push("  }".to_string());
    lines.push("}".to_string());
    lines.push(String::new());
    lines.join("\n")
}

fn generate_cs_entity(
    entity: &SdkEntity,
    type_map: &TypeMap,
    generated_at: &str,
    trace_lines: &[String],
    namespace: &str,
) -> String {
    let mut lines = def_header("csharp", generated_at, trace_lines);
    lines.push(format!("namespace {namespace}"));
    lines.push("{".to_string());

    let used = used_fixed_dict_types(entity, type_map);
    let parent_note = match &entity.parent {
        Some(parent) => format!("（父类 {parent}）"),
        None => String::new(),
    };
    let fixed_note = if used.is_empty() {
        String::new()
    } else {
        format!(
            "（固定字典: {}）",
            used.iter().map(|dict| dict.name.clone()).collect::<Vec<_>>().join(", ")
        )
    };
    lines.push(format!(
        "  /// <summary>{} 客户端实体 SDK 骨架{parent_note}{fixed_note}</summary>",
        entity.name
    ));
    lines.push(format!("  public class {}", entity.name));
    lines.push("  {".to_string());
    lines.push("    /// <summary>实体 id（由 baseapp 分配）</summary>".to_string());
    lines.push("    public long EntityId { get; }".to_string());

    for property in client_visible_properties(entity) {
        lines.push(format!("    /// <summary>Flags: {}</summary>", property.flags));
        lines.push(format!(
            "    public {} {} {{ get; set; }}",
            resolve_property_type(type_map, property),
            to_pascal_case(&property.name)
        ));
    }

    lines.push(format!("    public {}(long entityId)", entity.name));
    lines.push("    {".to_string());
    lines.push("      EntityId = entityId;".to_string());
    lines.push("    }".to_string());

    for method in &entity.client_methods {
        let args = format_arg_types(type_map, &method.arg_types, "csharp");
        lines.push(format!(
            "    /// <summary>ClientMethods 回调: {}</summary>",
            method.name
        ));
        lines.push(format!(
            "    public virtual void {}({args})",
            to_pascal_case(&method.name)
        ));
        lines.push("    {".to_string());
        lines.push("      // TODO: 实现客户端回调".to_string());
        lines.push("    }".to_string());
    }

    for section in [
        (
            &entity.exposed_base_methods,
            "BaseCall",
            "OnBaseOutgoing",
            "Exposed BaseMethods",
        ),
        (
            &entity.exposed_cell_methods,
            "CellCall",
            "OnCellOutgoing",
            "Exposed CellMethods",
        ),
    ] {
        let (methods, prefix, seam, label) = section;
        for method in methods {
            let args = format_arg_types(type_map, &method.arg_types, "csharp");
            let call_args = format_arg_ids(&method.arg_types, false);
            lines.push(format!("    /// <summary>{label}: {}</summary>", method.name));
            lines.push(format!(
                "    public void {}{}({args})",
                prefix,
                to_pascal_case(&method.name)
            ));
            lines.push("    {".to_string());
            lines.push(format!(
                "      {seam}(\"{}\", new object[] {{ {call_args} }});",
                method.name
            ));
            lines.push("    }".to_string());
        }
    }

    lines.push("    /// <summary>发送接缝: 按客户端插件的 base 调用通道实现</summary>".to_string());
    lines.push("    protected virtual void OnBaseOutgoing(string method, object[] args)".to_string());
    lines.push("    {".to_string());
    lines.push("    }".to_string());
    lines.push("    /// <summary>发送接缝: 按客户端插件的 cell 调用通道实现</summary>".to_string());
    lines.push("    protected virtual void OnCellOutgoing(string method, object[] args)".to_string());
    lines.push("    {".to_string());
    lines.push("    }".to_string());
    lines.push("  }".to_string());
    lines.push("}".to_string());
    lines.push(String::new());
    lines.join("\n")
}

fn format_source_line(line: Option<usize>) -> String {
    match line {
        Some(line) => line.to_string(),
        None => "unknown".to_string(),
    }
}

/// FIXED_DICT 伴随文件(逐语言;引用为空 → None 不产文件)。
fn generate_fixed_dicts_file(
    entities: &[&SdkEntity],
    type_map: &TypeMap,
    language: &str,
    generated_at: &str,
    trace_lines: &[String],
    namespace: &str,
) -> Option<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut used: Vec<&FixedDictType> = Vec::new();
    for entity in entities {
        for property in client_visible_properties(entity) {
            if let Some(dict) = type_map.fixed_dicts.get(&property.type_name) {
                if seen.insert(dict.name.clone()) {
                    used.push(dict);
                }
            }
        }
    }
    if used.is_empty() {
        return None;
    }

    let mut lines = def_header(language, generated_at, trace_lines);
    if language == "typescript" {
        for dict in &used {
            lines.push(format!(
                "/** source: types.xml:{} */",
                format_source_line(dict.source_line)
            ));
            lines.push(format!("/** {} FIXED_DICT 别名 */", dict.name));
            lines.push(format!("export interface {} {{", dict.name));
            for property in &dict.properties {
                lines.push(format!(
                    "  /** source: types.xml:{} */",
                    format_source_line(property.source_line)
                ));
                let resolved = match &property.type_name {
                    Some(type_name) => resolve_arg_type(type_map, type_name),
                    None => "unknown".to_string(),
                };
                lines.push(format!("  {}: {resolved};", property.name));
            }
            lines.push("}".to_string());
            lines.push(String::new());
        }
    } else {
        lines.push(format!("namespace {namespace}"));
        lines.push("{".to_string());
        for dict in &used {
            lines.push(format!(
                "  // source: types.xml:{}",
                format_source_line(dict.source_line)
            ));
            lines.push(format!("  /// <summary>{} FIXED_DICT 别名</summary>", dict.name));
            lines.push(format!("  public class {}", dict.name));
            lines.push("  {".to_string());
            for property in &dict.properties {
                lines.push(format!(
                    "    // source: types.xml:{}",
                    format_source_line(property.source_line)
                ));
                let resolved = match &property.type_name {
                    Some(type_name) => resolve_arg_type(type_map, type_name),
                    None => "object".to_string(),
                };
                lines.push(format!(
                    "    public {resolved} {} {{ get; set; }}",
                    to_pascal_case(&property.name)
                ));
            }
            lines.push("  }".to_string());
        }
        lines.push("}".to_string());
        lines.push(String::new());
    }
    Some(lines.join("\n"))
}

struct GeneratedFile {
    file_name: String,
    content: String,
}

fn extension_for(language: &str) -> &'static str {
    if language == "csharp" {
        "cs"
    } else {
        "ts"
    }
}

fn generate(params: &SdkGenerateParams) -> Result<Vec<GeneratedFile>, String> {
    let language = params.language.as_str();
    if language != "typescript" && language != "csharp" {
        return Err(format!("unsupported language: {language}"));
    }
    let type_map = build_client_sdk_type_map(params.types_xml.as_deref(), language);
    let trace_lines = engine_trace_lines(params.engine_trace.as_ref());
    let namespace = params
        .namespace
        .clone()
        .unwrap_or_else(|| DEFAULT_CSHARP_NAMESPACE.to_string());

    let entities: Vec<SdkEntity> = params
        .entities
        .iter()
        .filter_map(|input| parse_entity(&input.def_text, &input.name))
        .collect();
    let entity_refs: Vec<&SdkEntity> = entities.iter().collect();

    let extension = extension_for(language);
    let mut files = Vec::new();
    for entity in &entities {
        let content = if language == "typescript" {
            generate_ts_entity(entity, &type_map, &params.generated_at, &trace_lines)
        } else {
            generate_cs_entity(
                entity,
                &type_map,
                &params.generated_at,
                &trace_lines,
                &namespace,
            )
        };
        files.push(GeneratedFile {
            file_name: format!("{}.{}", entity.name, extension),
            content,
        });
    }
    if let Some(fixed) = generate_fixed_dicts_file(
        &entity_refs,
        &type_map,
        language,
        &params.generated_at,
        &trace_lines,
        &namespace,
    ) {
        files.push(GeneratedFile {
            file_name: format!("{FIXED_DICTS_BASENAME}.{extension}"),
            content: fixed,
        });
    }
    Ok(files)
}

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
    let types_xml = params.get("typesXml").and_then(|v| v.as_str()).map(|s| s.to_string());
    let generated_at = params
        .get("generatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let engine_trace = params.get("engineTrace").and_then(|v| {
        let engine_version = v.get("engineVersion").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let engine_commit = v.get("engineCommit").and_then(|x| x.as_str()).unwrap_or("").to_string();
        Some(EngineTrace { engine_version, engine_commit })
    });
    let namespace = params.get("namespace").and_then(|v| v.as_str()).map(|s| s.to_string());
    Ok(SdkGenerateParams {
        language,
        entities,
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
}
