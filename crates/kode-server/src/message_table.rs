//! `$/kode/messageTable/build` handler(批123 消息编号表纯逻辑核心)。
//!
//! 从 def 文本(TS 侧已读盘直传)产出一张与 TS `buildMessageTable` 逐字段
//! 一致的 MessageTable JSON:方法/属性 utype 分配、域位冲突、别名 id、
//! 组件槽、types.xml 用户类型。输入 = `{entityName, defText, typesXml,
//! defs: {name: text}, paths: {name: path}, aliasIdEnabled}`;输出 =
//! MessageTable 全形 JSON(clientMethods/clientProperties 为全量条目,与
//! TS buildMessageTable 返回对象一致,渲染器负责缩减序列化)。
//!
//! 引擎语义与 TS 实现逐条对齐(src/messageTable.ts 模块头注),此处不复述;
//! 差异只在**解析基座**:TS 用 fxp + parseLocalDefinition,Rust 用 kode-parser
//! xml 状态机(等价的容错解析),`<Utype>`/ARRAY `<of>` 链/`<Flags>` 原文
//! 在此从 xml Document 提取(PropertyDef/MethodDef 不带这些细粒度)。

use std::collections::{HashMap, HashSet};

use kode_parser::diag::{DiagCode, LineMap};
use kode_parser::xml::{parse as parse_xml, Document};
use serde_json::Value;

use crate::rpc::RpcRegistry;

// ---------------------------------------------------------------------------
// 常量(与 TS messageTable.ts 逐条一致;来源见其模块头注)
// ---------------------------------------------------------------------------

/// g_entityFlagMapping 12 项(entitydef.cpp L161-174),值 = EntityDataFlags 位
/// (common.h L19-30)。查找前 toupper,大小写不敏感。
const PROPERTY_FLAG_BITS: &[(&str, i64)] = &[
    ("CELL", 0x01),
    ("CELL_AND_CLIENT", 0x08),
    ("CELL_AND_CLIENTS", 0x04),
    ("CELL_AND_OTHER_CLIENTS", 0x80),
    ("BASE_AND_CLIENT", 0x20),
    ("BASE", 0x40),
    ("CELL_PUBLIC", 0x01),
    ("CELL_PRIVATE", 0x02),
    ("ALL_CLIENTS", 0x04),
    ("CELL_PUBLIC_AND_OWN", 0x08),
    ("OTHER_CLIENTS", 0x80),
    ("OWN_CLIENT", 0x10),
];

/// common.h L141-147:三域位集。
const ENTITY_BASE_DATA_FLAGS: i64 = 0x40 | 0x20;
const ENTITY_CELL_DATA_FLAGS: i64 = 0x01 | 0x02 | 0x04 | 0x08 | 0x80 | 0x10;
const ENTITY_CLIENT_DATA_FLAGS: i64 = 0x20 | 0x04 | 0x08 | 0x80 | 0x10;

/// 基元类型 utype 表:DataTypes::initialize 顺序(datatypes.cpp L54-79)。
const PRIMITIVE_TYPE_UTYPES: &[(&str, i64)] = &[
    ("UINT8", 1),
    ("UINT16", 2),
    ("UINT64", 3),
    ("UINT32", 4),
    ("INT8", 5),
    ("INT16", 6),
    ("INT32", 7),
    ("INT64", 8),
    ("STRING", 9),
    ("UNICODE", 10),
    ("FLOAT", 11),
    ("DOUBLE", 12),
    ("PYTHON", 13),
    ("PY_DICT", 14),
    ("PY_TUPLE", 15),
    ("PY_LIST", 16),
    ("ENTITYCALL", 17),
    ("BLOB", 18),
    ("VECTOR2", 19),
    ("VECTOR3", 20),
    ("VECTOR4", 21),
];

/// 引擎保留属性名(common.h L125-155 ENTITY_LIMITED_PROPERTYS,静态表部分)。
const LIMITED_PROPERTY_NAMES: &[&str] = &[
    "id",
    "position",
    "direction",
    "spaceID",
    "autoLoad",
    "cell",
    "base",
    "client",
    "cellData",
    "className",
    "componentdatabaseID",
    "isDestroyed",
    "shouldAutoArchive",
    "shouldAutoBackup",
    "__ACCOUNT_NAME__",
    "__ACCOUNT_PASSWORD__",
    "clientAddr",
    "clientEnabled",
    "hasClient",
    "roundTripTime",
    "timeSinceHeardFromClient",
    "allClients",
    "hasWitness",
    "isWitnessed",
    "otherClients",
    "topSpeed",
    "topSpeedY",
    "interface",
];

/// ENTITY_METHOD_UID 上界:uint16,超界报溢出。
const METHOD_UTYPE_MAX: i64 = 65535;
/// aliasID:属性从 4 起(1-3 保留),超 255 回退 -1。
const ALIAS_ID_PROPERTY_BASE: i64 = 4;
const ALIAS_ID_MAX: i64 = 255;

/// 方法段装载序(引擎 loadDefInfo 顺序)。
const METHOD_LOAD_ORDER: &[&str] = &["CellMethods", "BaseMethods", "ClientMethods"];

/// 三域位集:域命中的属性表才会走 addPropertyDescription。
fn domain_bits_of(domain: &str) -> i64 {
    match domain {
        "cell" => ENTITY_CELL_DATA_FLAGS,
        "base" => ENTITY_BASE_DATA_FLAGS,
        _ => ENTITY_CLIENT_DATA_FLAGS,
    }
}

/// 组件类型号(common.h L78-82),addPropertyDescription 冲突报错按域打印。
fn domain_component_type(domain: &str) -> i64 {
    match domain {
        "cell" => 5,
        "base" => 6,
        _ => 7,
    }
}

/// 方法段名 → 引擎段简称(冲突文案用)。
fn section_name(section: &str) -> &'static str {
    match section {
        "CellMethods" => "Cell",
        "BaseMethods" => "Base",
        _ => "Client",
    }
}

/// 来源标签:own 原样;接口/父类带后缀(与 TS originLabel 同)。
fn origin_label(module_name: &str, origin_kind: &str) -> String {
    match origin_kind {
        "interface" => format!("{module_name}(接口)"),
        "parent" => format!("{module_name}(父类)"),
        _ => module_name.to_string(),
    }
}

/// TS normalizeSourceKey:反斜杠归斜杠 + 小写。
fn normalize_source_key(file_path: &str) -> String {
    file_path.replace('\\', "/").to_ascii_lowercase()
}

// ---------------------------------------------------------------------------
// 输出 JSON 结构(与 TS renderMessageTableJson 同形;全量条目)
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArgJson {
    name: String,
    of_type: Option<Box<ArgJson>>,
    utype: Option<i64>,
    line: usize,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MethodJson {
    name: String,
    section: String,
    direction: String,
    visible_to_client: bool,
    exposed: bool,
    args: Vec<ArgJson>,
    declared_utype: Option<i64>,
    utype: Option<i64>,
    #[serde(rename = "aliasID")]
    alias_id: Option<i64>,
    status: String,
    origin: String,
    origin_kind: String,
    line: usize,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PropertyJson {
    name: String,
    type_name: Option<String>,
    flags: String,
    has_client: bool,
    utype: Option<i64>,
    declared_utype: Option<i64>,
    #[serde(rename = "aliasID")]
    alias_id: Option<i64>,
    origin: String,
    origin_kind: String,
    line: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TypeJson {
    name: String,
    utype: i64,
    kind: String,
    aliased_to: Option<String>,
    line: Option<usize>,
    origin: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct IssueJson {
    kind: String,
    message: String,
    fatal: bool,
    line: Option<usize>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceJson {
    name: String,
    kind: String,
    file_path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TableJson {
    module: String,
    generated_at: String,
    alias_id_enabled: bool,
    load_failed: bool,
    fatal_count: usize,
    sources: Vec<SourceJson>,
    methods: Vec<MethodJson>,
    client_methods: Vec<MethodJson>,
    properties: Vec<PropertyJson>,
    client_properties: Vec<PropertyJson>,
    types: Vec<TypeJson>,
    issues: Vec<IssueJson>,
}

// ---------------------------------------------------------------------------
// 中间装配态(TS ModuleAssembly 对应物)
// ---------------------------------------------------------------------------

struct AsmType {
    name: String,
    utype: i64,
    kind: &'static str,
    aliased_to: Option<String>,
    line: Option<usize>,
    origin: String,
}

struct AsmIssue {
    kind: &'static str,
    message: String,
    fatal: bool,
    line: Option<usize>,
}

struct AsmArg {
    name: String,
    of_type: Option<Box<AsmArg>>,
    utype: Option<i64>,
    line: usize,
}

struct AsmMethod {
    name: String,
    section: &'static str,
    direction: &'static str,
    visible_to_client: bool,
    exposed: bool,
    args: Vec<AsmArg>,
    declared_utype: Option<i64>,
    utype: Option<i64>,
    alias_id: Option<i64>,
    status: &'static str,
    origin: String,
    origin_kind: &'static str,
    line: usize,
}

struct AsmProperty {
    name: String,
    type_name: Option<String>,
    flags: String,
    has_client: bool,
    utype: Option<i64>,
    declared_utype: Option<i64>,
    alias_id: Option<i64>,
    origin: String,
    origin_kind: &'static str,
    line: usize,
}

struct AsmSource {
    name: String,
    kind: &'static str,
    file_path: String,
}

/// 装配态:引擎全局计数器与模块内已注册名的模拟(TS ModuleAssembly)。
struct Assembly {
    entity_name: String,
    used_utypes: HashSet<i64>,
    auto_counter: i64,
    holders: HashMap<i64, String>,
    property_used_utypes: HashSet<i64>,
    property_auto_counter: i64,
    property_holders: HashMap<i64, (String, HashSet<&'static str>)>,
    method_names_by_section: HashMap<&'static str, HashSet<String>>,
    all_method_names: HashSet<String>,
    property_domains: HashMap<&'static str, HashSet<String>>,
    all_property_names: HashSet<String>,
    component_names: HashSet<String>,
    registry: HashMap<String, i64>,
    seen_component_types: HashSet<String>,
    types: Vec<AsmType>,
    issues: Vec<AsmIssue>,
    next_type_utype: i64,
    methods: Vec<AsmMethod>,
    properties: Vec<AsmProperty>,
    sources: Vec<AsmSource>,
    visited: HashSet<String>,
}

impl Assembly {
    fn new(entity_name: &str) -> Assembly {
        let mut method_names_by_section = HashMap::new();
        method_names_by_section.insert("CellMethods", HashSet::new());
        method_names_by_section.insert("BaseMethods", HashSet::new());
        method_names_by_section.insert("ClientMethods", HashSet::new());
        let mut property_domains = HashMap::new();
        property_domains.insert("cell", HashSet::new());
        property_domains.insert("base", HashSet::new());
        property_domains.insert("client", HashSet::new());
        Assembly {
            entity_name: entity_name.to_string(),
            used_utypes: HashSet::new(),
            auto_counter: 1,
            holders: HashMap::new(),
            property_used_utypes: HashSet::new(),
            property_auto_counter: 1,
            property_holders: HashMap::new(),
            method_names_by_section,
            all_method_names: HashSet::new(),
            property_domains,
            all_property_names: HashSet::new(),
            component_names: HashSet::new(),
            registry: HashMap::new(),
            seen_component_types: HashSet::new(),
            types: Vec::new(),
            issues: Vec::new(),
            next_type_utype: 1,
            methods: Vec::new(),
            properties: Vec::new(),
            sources: Vec::new(),
            visited: HashSet::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// def 视图(xml Document 提取;TS parseLocalDefinition 相关字段)
// ---------------------------------------------------------------------------

struct DefView {
    parent: Option<String>,
    parent_line: Option<usize>,
    interfaces: Vec<String>,
    root_name: String,
    properties: Vec<PropView>,
    methods: Vec<MethodView>,
    components: Vec<CompView>,
}

struct PropView {
    name: String,
    line: usize,
    type_name: Option<String>,
    flags: Option<String>,
    utype: i64,
}

struct MethodView {
    name: String,
    line: usize,
    section: &'static str,
    args: Vec<ArgView>,
    exposed: bool,
    utype: i64,
}

struct ArgView {
    name: String,
    of_type: Option<Box<ArgView>>,
}

struct CompView {
    slot_name: String,
    type_name: String,
    line: usize,
    utype: i64,
}

/// TS getScalarChildValue:首个匹配子元素直接文本 trim;空 → None。
fn scalar_child(doc: &Document, idx: usize, name: &str) -> Option<String> {
    let child = doc.child_element(idx, name)?;
    let value = doc.element(child).text(doc).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// TS getNodeValue:子元素文本 trim;空回落首个子元素名;仍空 → None。
fn node_value(doc: &Document, idx: usize, name: &str) -> Option<String> {
    let child = doc.child_element(idx, name)?;
    let text = doc.element(child).text(doc).trim().to_string();
    if !text.is_empty() {
        return Some(text);
    }
    doc.child_elements(child)
        .first()
        .map(|&c| doc.element(c).name.clone())
}

/// TS parseUtypeValue:非数字文本得 0(视同未设置,自动分配)。
fn parse_utype(text: Option<&str>) -> i64 {
    text.and_then(|t| t.trim().parse::<i64>().ok()).unwrap_or(0)
}


/// 已解析 doc 上构造视图(Source::load 复用同一 doc,免二次解析)。
fn parse_def_view_with(doc: &Document, text: &str) -> DefView {
    let lines = LineMap::new(text);

    let root = doc.root();
    let parent = root.and_then(|r| node_value(doc, r, "Parent"));
    let parent_line = root
        .and_then(|r| doc.child_element(r, "Parent"))
        .map(|p| lines.line_of(doc.element(p).name_span.start));
    // 引擎 loadInterfaces(entitydef.cpp L559-561)只装载 wrapper 标签为
    // interface/Interface/type/Type 四拼写的子元素(大小写敏感精确比对),
    // 其余 continue;取名与 <Parent> 同:文本取文本、元素取标签名。
    let interfaces = root
        .and_then(|r| doc.child_element(r, "Interfaces"))
        .map(|ifaces| {
            doc.child_elements(ifaces)
                .iter()
                .filter(|&&child| {
                    matches!(
                        doc.element(child).name.as_str(),
                        "interface" | "Interface" | "type" | "Type"
                    )
                })
                .filter_map(|&child| {
                    let text = doc.element(child).text(doc).trim().to_string();
                    if !text.is_empty() {
                        return Some(text);
                    }
                    doc.child_elements(child)
                        .first()
                        .map(|&grandchild| doc.element(grandchild).name.clone())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut properties = Vec::new();
    let mut methods = Vec::new();
    let mut components = Vec::new();
    if let Some(root) = root {
        if let Some(props) = doc.child_element(root, "Properties") {
            for child in doc.child_elements(props) {
                properties.push(parse_prop(&doc, &lines, child));
            }
        }
        for section in METHOD_LOAD_ORDER {
            if let Some(sec) = doc.child_element(root, section) {
                for child in doc.child_elements(sec) {
                    methods.push(parse_method(&doc, &lines, child, section));
                }
            }
        }
        if let Some(comps) = doc.child_element(root, "Components") {
            for child in doc.child_elements(comps) {
                if let Some(cv) = parse_comp(&doc, &lines, child) {
                    components.push(cv);
                }
            }
        }
    }

    DefView {
        parent,
        parent_line,
        interfaces,
        root_name: root
            .map(|r| doc.element(r).name.clone())
            .unwrap_or_default(),
        properties,
        methods,
        components,
    }
}

fn parse_prop(doc: &Document, lines: &LineMap, child: usize) -> PropView {
    let e = doc.element(child);
    PropView {
        name: e.name.clone(),
        line: lines.line_of(e.name_span.start),
        type_name: scalar_child(doc, child, "Type"),
        flags: scalar_child(doc, child, "Flags"),
        utype: parse_utype(scalar_child(doc, child, "Utype").as_deref()),
    }
}

fn parse_method(doc: &Document, lines: &LineMap, child: usize, section: &'static str) -> MethodView {
    let e = doc.element(child);
    let mut args = Vec::new();
    for arg_node in doc.child_elements_named(child, "Arg") {
        let arg_name = doc.element(arg_node).text(doc).trim().to_string();
        if arg_name.is_empty() {
            continue;
        }
        args.push(parse_arg(doc, arg_node, &arg_name));
    }
    MethodView {
        name: e.name.clone(),
        line: lines.line_of(e.name_span.start),
        section,
        args,
        exposed: doc.truthy_child(child, "Exposed"),
        utype: parse_utype(scalar_child(doc, child, "Utype").as_deref()),
    }
}

/// TS parseArgType:ARRAY 走 `<of>` 递归;缺 of / 空 of 按 TS 语义保留。
fn parse_arg(doc: &Document, arg_node: usize, name: &str) -> ArgView {
    if name != "ARRAY" {
        return ArgView {
            name: name.to_string(),
            of_type: None,
        };
    }
    match doc.child_element(arg_node, "of") {
        None => ArgView {
            name: name.to_string(),
            of_type: None,
        },
        Some(of_idx) => {
            let of_name = doc.element(of_idx).text(doc).trim().to_string();
            let of_type = if of_name.is_empty() {
                Some(Box::new(ArgView {
                    name: String::new(),
                    of_type: None,
                }))
            } else {
                Some(Box::new(parse_arg(doc, of_idx, &of_name)))
            };
            ArgView {
                name: name.to_string(),
                of_type,
            }
        }
    }
}

fn parse_comp(doc: &Document, lines: &LineMap, child: usize) -> Option<CompView> {
    let e = doc.element(child);
    let type_name = node_value(doc, child, "Type")?;
    Some(CompView {
        slot_name: e.name.clone(),
        line: lines.line_of(e.name_span.start),
        type_name,
        utype: parse_utype(scalar_child(doc, child, "Utype").as_deref()),
    })
}

// ---------------------------------------------------------------------------
// 注册面
// ---------------------------------------------------------------------------

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/messageTable/build", build_handler);
}

fn build_handler(params: Value) -> Result<Value, String> {
    build_table(&params)
}

// ---------------------------------------------------------------------------
// def 树取源(TS DefTreeSource 对应物)
// ---------------------------------------------------------------------------

/// 取源:实体自身 defText + 其余 def 按名;路径按名(装配序 sources 用)。
struct Source<'a> {
    entity_name: &'a str,
    def_text: &'a str,
    defs: &'a HashMap<String, String>,
    paths: &'a HashMap<String, String>,
}

impl Source<'_> {
    /// TS loadDef:按名取文本解析;结构错误(未闭合/闭合不匹配/游离闭合/非法
    /// 标签)按 TS parseLocalDefinition 抛错 → null 处理。其余容错解析继续。
    fn load(&self, name: &str) -> Option<DefView> {
        let text = if name == self.entity_name {
            self.def_text
        } else {
            self.defs.get(name)?
        };
        let doc = parse_xml(text, true);
        if is_structural_error(&doc) {
            return None;
        }
        Some(parse_def_view_with(&doc, text))
    }

    fn path_of(&self, name: &str) -> &str {
        self.paths.get(name).map(String::as_str).unwrap_or("")
    }
}

/// 结构错误判定(与 client_sdk::is_structural_error 同口径):TS fxp 对
/// 未闭合/闭合不匹配/游离闭合/非法标签抛错 → loadDef 返回 null。
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

// ---------------------------------------------------------------------------
// 主构建
// ---------------------------------------------------------------------------

/// TS buildMessageTable:基元表注册 → types.xml 用户类型 → 自身 def 递归并入
/// → aliasID 分配 → 汇总 JSON。自身 def 结构错误 → null(与 TS loadDef 抛错
/// 同路,不产表)。
fn build_table(params: &Value) -> Result<Value, String> {
    let entity_name = params
        .get("entityName")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "messageTable/build: missing entityName".to_string())?;
    let def_text = params
        .get("defText")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "messageTable/build: missing defText".to_string())?;
    let types_xml = params.get("typesXml").and_then(|v| v.as_str());
    let defs = params
        .get("defs")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let paths = params
        .get("paths")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let alias_id_enabled = params
        .get("aliasIdEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let source = Source {
        entity_name,
        def_text,
        defs: &defs,
        paths: &paths,
    };

    // 自身 def 结构错误:TS source.loadDef(entityName,'entity') 抛错 → null(不产表)
    let Some(own) = source.load(entity_name) else {
        return Ok(Value::Null);
    };

    let mut asm = Assembly::new(entity_name);
    for (name, utype) in PRIMITIVE_TYPE_UTYPES {
        asm.registry.insert(name.to_string(), *utype);
        asm.types.push(AsmType {
            name: (*name).to_string(),
            utype: *utype,
            kind: "primitive",
            aliased_to: None,
            line: None,
            origin: String::new(),
        });
    }
    asm.next_type_utype = PRIMITIVE_TYPE_UTYPES.len() as i64 + 1;
    if let Some(xml) = types_xml {
        load_types_xml(entity_name, xml, &mut asm);
    }

    load_def_into_module(entity_name, own, "own", &source, &mut asm);
    assign_alias_ids(&mut asm, alias_id_enabled);

    let fatal_count = asm.issues.iter().filter(|i| i.fatal).count();
    let methods: Vec<MethodJson> = asm.methods.iter().map(method_to_json).collect();
    let properties: Vec<PropertyJson> = asm.properties.iter().map(property_to_json).collect();
    let types: Vec<TypeJson> = asm
        .types
        .iter()
        .map(|t| TypeJson {
            name: t.name.clone(),
            utype: t.utype,
            kind: t.kind.to_string(),
            aliased_to: t.aliased_to.clone(),
            line: t.line,
            origin: t.origin.clone(),
        })
        .collect();
    let table = TableJson {
        module: entity_name.to_string(),
        generated_at: iso_now(),
        alias_id_enabled,
        load_failed: fatal_count > 0,
        fatal_count,
        sources: asm
            .sources
            .iter()
            .map(|s| SourceJson {
                name: s.name.clone(),
                kind: s.kind.to_string(),
                file_path: s.file_path.clone(),
            })
            .collect(),
        client_methods: methods.iter().filter(|m| m.visible_to_client).cloned().collect(),
        methods,
        client_properties: properties
            .iter()
            .filter(|p| p.has_client)
            .cloned()
            .collect(),
        properties,
        types,
        issues: asm
            .issues
            .iter()
            .map(|i| IssueJson {
                kind: i.kind.to_string(),
                message: i.message.clone(),
                fatal: i.fatal,
                line: i.line,
            })
            .collect(),
    };
    Ok(serde_json::to_value(&table).map_err(|e| e.to_string())?)
}

/// 单份 def 并入模块(TS loadDefIntoModule):属性 → Cell → Base → Client 方法
/// →(非接口)接口声明序递归 → 组件槽 → 父类递归。
fn load_def_into_module(
    module_name: &str,
    local: DefView,
    origin_kind: &'static str,
    source: &Source,
    asm: &mut Assembly,
) {
    let visit_key = normalize_source_key(source.path_of(module_name));
    // 成环守卫只罩实体(own+父链);接口不罩(引擎 loadInterfaces 重复声明
    // 每次完整装载,撞名报 [X] is exist!;接口尾部提前 return 无环风险)。
    if origin_kind != "interface" && asm.visited.contains(&visit_key) {
        asm.issues.push(AsmIssue {
            kind: "parent-cycle",
            fatal: true,
            line: local.parent_line,
            message: format!(
                "父类链成环:{} 装载中重入 {}(引擎递归装载无法终止,kode 截断该分支)",
                asm.entity_name, module_name
            ),
        });
        return;
    }
    asm.sources.push(AsmSource {
        name: module_name.to_string(),
        kind: origin_kind,
        file_path: source.path_of(module_name).to_string(),
    });
    if origin_kind != "interface" {
        asm.visited.insert(visit_key);
    }

    let root_name = local.root_name.clone();
    for property in &local.properties {
        simulate_property(module_name, property, origin_kind, &root_name, asm);
    }
    for section in METHOD_LOAD_ORDER {
        for method in local.methods.iter().filter(|m| m.section == *section) {
            simulate_method(module_name, method, origin_kind, asm);
        }
    }

    // 接口 def 只并入属性+方法(引擎 loadInterfaces 不递归接口自身)
    if origin_kind == "interface" {
        return;
    }

    for interface_ref in &local.interfaces {
        if let Some(interface_local) = source.load(interface_ref) {
            load_def_into_module(interface_ref, interface_local, "interface", source, asm);
        } else {
            asm.issues.push(AsmIssue {
                kind: "interface-file-missing",
                fatal: true,
                line: None,
                message: format!(
                    "EntityDef::loadDefInfo: failed to load entity:{interface_ref} interface."
                ),
            });
        }
    }

    // 组件槽注册(loadComponents 在接口后父类前)
    for component in &local.components {
        register_component_slot(module_name, component, asm);
    }

    if let Some(parent_name) = &local.parent {
        if let Some(parent_local) = source.load(parent_name) {
            load_def_into_module(parent_name, parent_local, "parent", source, asm);
        } else {
            asm.issues.push(AsmIssue {
                kind: "parent-file-missing",
                fatal: true,
                line: None,
                message: format!(
                    "EntityDef::loadDefInfo: failed to load entity:{parent_name} parentClass."
                ),
            });
        }
    }
}

// ---------------------------------------------------------------------------
// types.xml 装载(TS loadTypesXml)
// ---------------------------------------------------------------------------

fn load_types_xml(origin: &str, types_xml: &str, asm: &mut Assembly) {
    let doc = parse_xml(types_xml, false);
    if is_structural_error(&doc) {
        asm.issues.push(AsmIssue {
            kind: "types-parse-error",
            fatal: true,
            line: None,
            message: "DataTypes::loadTypes: types.xml 解析失败(非法 XML)".to_string(),
        });
        return;
    }
    let lines = LineMap::new(types_xml);
    let Some(root) = doc.root() else {
        return;
    };

    for alias_node in doc.child_elements(root) {
        let alias_name = doc.element(alias_node).name.clone();
        let line = lines.line_of(doc.element(alias_node).name_span.start);
        if alias_name.starts_with('_') {
            asm.issues.push(AsmIssue {
                kind: "invalid-type-alias-name",
                fatal: true,
                line: Some(line),
                message: format!(
                    "DataTypes::loadTypes: Not allowed to use the prefix \"_\"! aliasName={alias_name}"
                ),
            });
            continue;
        }

        let fixed_dict_node = doc.child_element(alias_node, "FIXED_DICT");
        let array_node = doc.child_element(alias_node, "ARRAY");
        let child_text = doc.element(alias_node).text(&doc).trim().to_string();
        if has_alias_name(asm, &alias_name) {
            asm.issues.push(AsmIssue {
                kind: "duplicate-type-alias",
                fatal: false,
                line: Some(line),
                message: format!("DataTypes::addDataType(name): name {alias_name} exist."),
            });
            if fixed_dict_node.is_some() {
                consume_user_type(asm, &alias_name, Some(line), "fixed-dict", origin);
            } else if array_node.is_some() {
                consume_user_type(asm, &alias_name, Some(line), "array", origin);
            }
            continue;
        }

        if let Some(fd) = fixed_dict_node {
            if doc.child_element(fd, "Properties").is_none() {
                asm.issues.push(AsmIssue {
                    kind: "types-parse-error",
                    fatal: true,
                    line: Some(line),
                    message: "FixedDictType::initialize: not found \"Properties\".".to_string(),
                });
                asm.issues.push(AsmIssue {
                    kind: "types-parse-error",
                    fatal: true,
                    line: Some(line),
                    message: format!("DataTypes::loadTypes: parse FIXED_DICT [{alias_name}] error!"),
                });
                consume_user_type(asm, &alias_name, Some(line), "fixed-dict", origin);
                continue;
            }
            register_user_type(asm, &alias_name, Some(line), "fixed-dict", None, origin);
            continue;
        }
        if let Some(arr) = array_node {
            let Some(of_node) = doc.child_element(arr, "of") else {
                asm.issues.push(AsmIssue {
                    kind: "array-of-missing",
                    fatal: true,
                    line: Some(line),
                    message: "FixedArrayType::initialize: not found \"of\".".to_string(),
                });
                asm.issues.push(AsmIssue {
                    kind: "types-parse-error",
                    fatal: true,
                    line: Some(line),
                    message: format!("DataTypes::loadTypes: parse ARRAY [{alias_name}] error!"),
                });
                consume_user_type(asm, &alias_name, Some(line), "array", origin);
                continue;
            };
            let of_name = doc.element(of_node).text(&doc).trim().to_string();
            if lookup_type(&of_name, asm).is_none() {
                asm.issues.push(AsmIssue {
                    kind: "array-of-unknown-type",
                    fatal: true,
                    line: Some(line),
                    message: format!(
                        "FixedArrayType::initialize: key[ARRAY] did not find type[{of_name}]!"
                    ),
                });
                asm.issues.push(AsmIssue {
                    kind: "types-parse-error",
                    fatal: true,
                    line: Some(line),
                    message: format!("DataTypes::loadTypes: parse ARRAY [{alias_name}] error!"),
                });
                consume_user_type(asm, &alias_name, Some(line), "array", origin);
                continue;
            }
            register_user_type(asm, &alias_name, Some(line), "array", None, origin);
            continue;
        }

        if lookup_type(&child_text, asm).is_none() {
            asm.issues.push(AsmIssue {
                kind: "unknown-aliased-type",
                fatal: true,
                line: Some(line),
                message: format!(
                    "DataTypes::loadTypes: can't fount type {child_text} by alias[{alias_name}]."
                ),
            });
            continue;
        }
        register_user_type(asm, &alias_name, Some(line), "alias", Some(&child_text), origin);
    }
}

fn has_alias_name(asm: &Assembly, name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    asm.registry
        .keys()
        .any(|known| known.to_ascii_lowercase() == lower)
}

fn register_user_type(
    asm: &mut Assembly,
    name: &str,
    line: Option<usize>,
    kind: &'static str,
    aliased_to: Option<&str>,
    origin: &str,
) {
    let utype = match aliased_to {
        None => {
            let u = asm.next_type_utype;
            asm.next_type_utype += 1;
            u
        }
        Some(target) => lookup_type(target, asm).expect("aliased type must exist"),
    };
    asm.registry.insert(name.to_string(), utype);
    asm.types.push(AsmType {
        name: name.to_string(),
        utype,
        kind,
        aliased_to: aliased_to.map(str::to_string),
        line,
        origin: origin.to_string(),
    });
}

fn consume_user_type(
    asm: &mut Assembly,
    name: &str,
    line: Option<usize>,
    kind: &'static str,
    origin: &str,
) {
    let utype = asm.next_type_utype;
    asm.next_type_utype += 1;
    asm.types.push(AsmType {
        name: name.to_string(),
        utype,
        kind,
        aliased_to: None,
        line,
        origin: origin.to_string(),
    });
}

fn lookup_type(name: &str, asm: &Assembly) -> Option<i64> {
    asm.registry.get(name).copied()
}

// ---------------------------------------------------------------------------
// 属性装载模拟(TS simulateProperty + allocatePropertyUtype)
// ---------------------------------------------------------------------------

fn simulate_property(
    module_name: &str,
    property: &PropView,
    origin_kind: &'static str,
    root_name: &str,
    asm: &mut Assembly,
) {
    let origin = origin_label(module_name, origin_kind);
    let entry = AsmProperty {
        name: property.name.clone(),
        type_name: property.type_name.clone(),
        flags: String::new(),
        has_client: false,
        utype: None,
        declared_utype: None,
        alias_id: None,
        origin: origin.clone(),
        origin_kind,
        line: property.line,
    };
    asm.properties.push(entry);

    if LIMITED_PROPERTY_NAMES.contains(&property.name.as_str()) {
        asm.issues.push(AsmIssue {
            kind: "property-name-limited",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "EntityDef::loadDefPropertys: '{}' is limited, in module({})!",
                property.name, asm.entity_name
            ),
        });
        return;
    }

    let Some(flags_text) = property.flags.as_deref() else {
        asm.issues.push(AsmIssue {
            kind: "property-flags-missing",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "EntityDef::loadDefPropertys: not fount flagsNode, is {}.{}!",
                asm.entity_name, property.name
            ),
        });
        return;
    };
    let flags_upper = flags_text.trim().to_ascii_uppercase();
    asm.properties.last_mut().unwrap().flags = flags_upper.clone();
    let Some(flag_bits) = flag_bits_of(&flags_upper) else {
        asm.issues.push(AsmIssue {
            kind: "property-flags-unknown",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "EntityDef::loadDefPropertys: not fount flags[{flags_upper}], is {}.{}!",
                asm.entity_name, property.name
            ),
        });
        return;
    };
    // 引擎保留此臂(hasBaseFlags<=0 && hasCellFlags<=0 报错),但 g_entityFlagMapping
    // 全部 12 表项均落在 base∪cell 位集内,查表成功者恒过此关;照形状保留。
    if flag_bits & ENTITY_BASE_DATA_FLAGS <= 0 && flag_bits & ENTITY_CELL_DATA_FLAGS <= 0 {
        asm.issues.push(AsmIssue {
            kind: "property-flags-no-base-cell",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "EntityDef::loadDefPropertys: not fount flags[{flags_upper}], is {}.{}!",
                asm.entity_name, property.name
            ),
        });
        return;
    }
    let has_client = flag_bits & ENTITY_CLIENT_DATA_FLAGS > 0;
    let registered_domains: Vec<&'static str> = ["cell", "base", "client"]
        .into_iter()
        .filter(|domain| flag_bits & domain_bits_of(domain) > 0)
        .collect();
    asm.properties.last_mut().unwrap().has_client = has_client;

    let Some(type_name) = property.type_name.as_deref() else {
        asm.issues.push(AsmIssue {
            kind: "property-type-missing",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "EntityDef::loadDefPropertys: not fount TypeNode, is {}.{}!",
                asm.entity_name, property.name
            ),
        });
        return;
    };
    if type_name == "ARRAY" {
        let utype = asm.next_type_utype;
        asm.next_type_utype += 1;
        asm.types.push(AsmType {
            name: format!("{}_{}", asm.entity_name, property.name),
            utype,
            kind: "inline-array",
            aliased_to: None,
            line: Some(property.line),
            origin,
        });
    } else if lookup_type(type_name, asm).is_none() {
        asm.issues.push(AsmIssue {
            kind: "property-type-unknown",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "属性 {} 的类型 {} 未注册(types.xml 与基元表均无),引擎静默 return false(无 ERROR_MSG)",
                property.name, type_name
            ),
        });
        return;
    }

    let declared = if property.utype > 0 { Some(property.utype) } else { None };
    asm.properties.last_mut().unwrap().declared_utype = declared;
    let utype = allocate_property_utype(
        declared,
        &property.name,
        &registered_domains,
        property.line,
        asm,
    );
    let Some(utype) = utype else {
        return;
    };
    asm.properties.last_mut().unwrap().utype = Some(utype);

    // addPropertyDescription 名字三查,逐域添加时触发
    let first_domain = registered_domains[0];
    let report_add_failure = |asm: &mut Assembly, kind: &'static str, message: String| {
        asm.issues.push(AsmIssue {
            kind,
            fatal: true,
            line: Some(property.line),
            message,
        });
        asm.issues.push(AsmIssue {
            kind,
            fatal: true,
            line: Some(property.line),
            message: format!("EntityDef::addPropertyDescription({}): {root_name}.", asm.entity_name),
        });
    };

    if asm.all_method_names.contains(&property.name) {
        report_add_failure(
            asm,
            "property-method-name-conflict",
            format!(
                "ScriptDefModule::addPropertyDescription: There is a method[{}] name conflict! componentType={}.",
                property.name,
                domain_component_type(first_domain)
            ),
        );
        return;
    }
    if asm.component_names.contains(&property.name) {
        report_add_failure(
            asm,
            "property-component-name-conflict",
            format!(
                "ScriptDefModule::addPropertyDescription: There is a component[{}] name conflict!",
                property.name
            ),
        );
        return;
    }

    let mut name_rejected = false;
    for domain in &registered_domains {
        if asm.property_domains.get_mut(domain).unwrap().contains(&property.name) {
            asm.issues.push(AsmIssue {
                kind: "property-name-conflict",
                fatal: true,
                line: Some(property.line),
                message: format!(
                    "ScriptDefModule::addPropertyDescription: [{}] is exist! componentType={}.",
                    property.name,
                    domain_component_type(domain)
                ),
            });
            name_rejected = true;
            continue;
        }
        asm.property_domains.get_mut(domain).unwrap().insert(property.name.clone());
    }
    if name_rejected {
        asm.issues.push(AsmIssue {
            kind: "property-name-conflict",
            fatal: true,
            line: Some(property.line),
            message: format!(
                "EntityDef::addPropertyDescription({}): {root_name}.",
                asm.entity_name
            ),
        });
        return;
    }
    asm.all_property_names.insert(property.name.clone());
}

fn flag_bits_of(text: &str) -> Option<i64> {
    PROPERTY_FLAG_BITS
        .iter()
        .find(|(key, _)| *key == text)
        .map(|(_, bits)| *bits)
}

fn allocate_property_utype(
    declared: Option<i64>,
    name: &str,
    domains: &[&'static str],
    line: usize,
    asm: &mut Assembly,
) -> Option<i64> {
    if let Some(declared) = declared {
        if declared > METHOD_UTYPE_MAX {
            asm.issues.push(AsmIssue {
                kind: "utype-overflow",
                fatal: true,
                line: Some(line),
                message: format!(
                    "EntityDef::calcDefPropertyUType: 'Utype' has overflowed({declared} > {METHOD_UTYPE_MAX}), is {}.{name}!",
                    asm.entity_name
                ),
            });
            return None;
        }
        if let Some((holder_name, holder_domains)) = asm.property_holders.get(&declared) {
            for domain in domains {
                if holder_domains.contains(domain) {
                    asm.issues.push(AsmIssue {
                        kind: "utype-conflict",
                        fatal: true,
                        line: Some(line),
                        message: format!(
                            "EntityDef::calcDefPropertyUType: {}.{name}, 'Utype' {declared} Conflict({}.{} 'Utype' {declared})!",
                            asm.entity_name, asm.entity_name, holder_name
                        ),
                    });
                }
            }
            return None;
        }
        asm.property_used_utypes.insert(declared);
        asm.property_holders
            .insert(declared, (name.to_string(), domains.iter().copied().collect()));
        return Some(declared);
    }
    while asm.property_used_utypes.contains(&asm.property_auto_counter) {
        asm.property_auto_counter += 1;
    }
    let utype = asm.property_auto_counter;
    asm.property_auto_counter += 1;
    asm.property_used_utypes.insert(utype);
    asm.property_holders
        .insert(utype, (name.to_string(), domains.iter().copied().collect()));
    Some(utype)
}

// ---------------------------------------------------------------------------
// 组件槽注册(TS registerComponentSlot)
// ---------------------------------------------------------------------------

fn register_component_slot(module_name: &str, component: &CompView, asm: &mut Assembly) {
    if LIMITED_PROPERTY_NAMES.contains(&component.slot_name.as_str()) {
        asm.issues.push(AsmIssue {
            kind: "property-name-limited",
            fatal: true,
            line: Some(component.line),
            message: format!(
                "EntityDef::loadComponents: '{}' is limited, in module({})!",
                component.slot_name, asm.entity_name
            ),
        });
        return;
    }

    let origin = origin_label(module_name, "own");
    let entry = AsmProperty {
        name: component.slot_name.clone(),
        type_name: Some(component.type_name.clone()),
        flags: "BASE|CELL_PUBLIC|ENTITY_CLIENT_DATA_FLAGS".to_string(),
        has_client: true,
        utype: None,
        declared_utype: None,
        alias_id: None,
        origin: origin.clone(),
        origin_kind: "own",
        line: component.line,
    };
    asm.properties.push(entry);

    if !asm.seen_component_types.contains(&component.type_name) {
        asm.seen_component_types.insert(component.type_name.clone());
        let utype = asm.next_type_utype;
        asm.next_type_utype += 1;
        asm.types.push(AsmType {
            name: component.type_name.clone(),
            utype,
            kind: "entity-component",
            aliased_to: None,
            line: Some(component.line),
            origin: module_name.to_string(),
        });
    }

    let declared = if component.utype > 0 { Some(component.utype) } else { None };
    asm.properties.last_mut().unwrap().declared_utype = declared;
    let Some(utype) = allocate_property_utype(
        declared,
        &component.slot_name,
        &["cell", "base", "client"],
        component.line,
        asm,
    ) else {
        return;
    };
    asm.properties.last_mut().unwrap().utype = Some(utype);

    if asm.all_method_names.contains(&component.slot_name) {
        asm.issues.push(AsmIssue {
            kind: "property-method-name-conflict",
            fatal: true,
            line: Some(component.line),
            message: format!(
                "ScriptDefModule::addPropertyDescription: There is a method[{}] name conflict! componentType={}.",
                component.slot_name,
                domain_component_type("cell")
            ),
        });
    } else if asm.component_names.contains(&component.slot_name) {
        asm.issues.push(AsmIssue {
            kind: "property-component-name-conflict",
            fatal: true,
            line: Some(component.line),
            message: format!(
                "ScriptDefModule::addPropertyDescription: There is a component[{}] name conflict!",
                component.slot_name
            ),
        });
    } else {
        let mut registered = false;
        for domain in ["cell", "base", "client"] {
            if asm.property_domains.get_mut(domain).unwrap().contains(&component.slot_name) {
                asm.issues.push(AsmIssue {
                    kind: "property-name-conflict",
                    fatal: true,
                    line: Some(component.line),
                    message: format!(
                        "ScriptDefModule::addPropertyDescription: [{}] is exist! componentType={}.",
                        component.slot_name,
                        domain_component_type(domain)
                    ),
                });
                continue;
            }
            asm.property_domains
                .get_mut(domain)
                .unwrap()
                .insert(component.slot_name.clone());
            registered = true;
        }
        if registered {
            asm.all_property_names.insert(component.slot_name.clone());
        }
    }
    asm.component_names.insert(component.slot_name.clone());
}

// ---------------------------------------------------------------------------
// 方法装载模拟(TS simulateMethod + parseMethodArg + parseArrayOfType)
// ---------------------------------------------------------------------------

fn simulate_method(
    module_name: &str,
    method: &MethodView,
    origin_kind: &'static str,
    asm: &mut Assembly,
) {
    let section_label = section_name(method.section);
    let origin = origin_label(module_name, origin_kind);
    let direction = if method.section == "ClientMethods" {
        "server-to-client"
    } else if method.exposed {
        "client-to-server"
    } else {
        "server-internal"
    };
    let visible_to_client = method.section == "ClientMethods" || method.exposed;
    let entry = AsmMethod {
        name: method.name.clone(),
        section: method.section,
        direction,
        visible_to_client,
        exposed: method.exposed,
        args: Vec::new(),
        declared_utype: None,
        utype: None,
        alias_id: None,
        status: "ok",
        origin: origin.clone(),
        origin_kind,
        line: method.line,
    };
    asm.methods.push(entry);

    let mut args_ok = true;
    for arg in &method.args {
        let arg_entry = parse_method_arg(method, arg, &origin, asm);
        asm.methods.last_mut().unwrap().args.push(arg_entry);
        if asm.methods.last().unwrap().args.last().unwrap().utype.is_none() {
            args_ok = false;
        }
    }
    if !args_ok {
        asm.methods.last_mut().unwrap().status = "arg-load-failed";
        return;
    }

    if asm.all_property_names.contains(&method.name) {
        asm.issues.push(AsmIssue {
            kind: "method-property-name-conflict",
            fatal: true,
            line: Some(method.line),
            message: format!(
                "ScriptDefModule::add{section_label}MethodDescription: There is a property[{}] name conflict!",
                method.name
            ),
        });
        asm.methods.last_mut().unwrap().status = "name-conflict";
        return;
    }
    if asm.component_names.contains(&method.name) {
        asm.issues.push(AsmIssue {
            kind: "method-component-name-conflict",
            fatal: true,
            line: Some(method.line),
            message: format!(
                "ScriptDefModule::add{section_label}MethodDescription: There is a component[{}] name conflict!",
                method.name
            ),
        });
        asm.methods.last_mut().unwrap().status = "name-conflict";
        return;
    }
    if asm
        .method_names_by_section
        .get(method.section)
        .unwrap()
        .contains(&method.name)
    {
        asm.issues.push(AsmIssue {
            kind: "method-name-conflict",
            fatal: true,
            line: Some(method.line),
            message: format!(
                "ScriptDefModule::add{section_label}MethodDescription: [{}] is exist!",
                method.name
            ),
        });
        asm.methods.last_mut().unwrap().status = "name-conflict";
        return;
    }

    let declared = if method.utype > 0 { Some(method.utype) } else { None };
    asm.methods.last_mut().unwrap().declared_utype = declared;
    let resolved_utype = match declared {
        Some(declared) => {
            if declared > METHOD_UTYPE_MAX {
                asm.issues.push(AsmIssue {
                    kind: "utype-overflow",
                    fatal: true,
                    line: Some(method.line),
                    message: format!(
                        "EntityDef::loadDef{section_label}Methods: 'Utype' has overflowed({declared} > {METHOD_UTYPE_MAX}), is {}.{}!",
                        asm.entity_name, method.name
                    ),
                });
                asm.methods.last_mut().unwrap().status = "utype-overflow";
                return;
            }
            asm.used_utypes.insert(declared);
            if let Some(holder_name) = asm.holders.get(&declared) {
                asm.issues.push(AsmIssue {
                    kind: "utype-conflict",
                    fatal: true,
                    line: Some(method.line),
                    message: format!(
                        "EntityDef::loadDef{section_label}Methods: {}.{}, 'Utype' {declared} Conflict({}.{} 'Utype' {declared})!",
                        asm.entity_name, method.name, asm.entity_name, holder_name
                    ),
                });
                asm.methods.last_mut().unwrap().status = "utype-conflict";
                return;
            }
            declared
        }
        None => {
            while asm.used_utypes.contains(&asm.auto_counter) {
                asm.auto_counter += 1;
            }
            let utype = asm.auto_counter;
            asm.auto_counter += 1;
            asm.used_utypes.insert(utype);
            utype
        }
    };
    asm.methods.last_mut().unwrap().utype = Some(resolved_utype);
    asm.holders.insert(resolved_utype, method.name.clone());
    asm.method_names_by_section
        .get_mut(method.section)
        .unwrap()
        .insert(method.name.clone());
    asm.all_method_names.insert(method.name.clone());
}

fn parse_method_arg(method: &MethodView, arg: &ArgView, origin: &str, asm: &mut Assembly) -> AsmArg {
    let line = method.line;
    let section_label = section_name(method.section);
    if arg.name != "ARRAY" {
        let utype = lookup_type(&arg.name, asm);
        if utype.is_none() {
            asm.issues.push(AsmIssue {
                kind: "unknown-arg-type",
                fatal: true,
                line: Some(line),
                message: format!(
                    "EntityDef::loadDef{section_label}Methods: dataType[{}] not found, in {}!",
                    arg.name, method.name
                ),
            });
        }
        return AsmArg {
            name: arg.name.clone(),
            of_type: None,
            utype,
            line,
        };
    }

    let inline_name = format!("{}_{}", asm.entity_name, method.name);
    let array_utype = asm.next_type_utype;
    asm.next_type_utype += 1;
    asm.types.push(AsmType {
        name: inline_name.clone(),
        utype: array_utype,
        kind: "inline-array",
        aliased_to: None,
        line: Some(line),
        origin: origin.to_string(),
    });

    let Some(of_type) = arg.of_type.as_deref() else {
        asm.issues.push(AsmIssue {
            kind: "array-of-missing",
            fatal: true,
            line: Some(line),
            message: "FixedArrayType::initialize: not found \"of\".".to_string(),
        });
        asm.issues.push(AsmIssue {
            kind: "unknown-arg-type",
            fatal: true,
            line: Some(line),
            message: format!(
                "EntityDef::loadDef{section_label}Methods: dataType[ARRAY] not found, in {}!",
                method.name
            ),
        });
        return AsmArg {
            name: "ARRAY".to_string(),
            of_type: None,
            utype: None,
            line,
        };
    };

    let element_entry = parse_array_of_type(method, of_type, &inline_name, origin, asm);
    let Some(element_entry) = element_entry else {
        asm.issues.push(AsmIssue {
            kind: "unknown-arg-type",
            fatal: true,
            line: Some(line),
            message: format!(
                "EntityDef::loadDef{section_label}Methods: dataType[ARRAY] not found, in {}!",
                method.name
            ),
        });
        return AsmArg {
            name: "ARRAY".to_string(),
            of_type: None,
            utype: None,
            line,
        };
    };
    AsmArg {
        name: "ARRAY".to_string(),
        of_type: Some(Box::new(element_entry)),
        utype: Some(array_utype),
        line,
    }
}

fn parse_array_of_type(
    method: &MethodView,
    of_type: &ArgView,
    parent_name: &str,
    origin: &str,
    asm: &mut Assembly,
) -> Option<AsmArg> {
    let line = method.line;
    if of_type.name == "ARRAY" {
        let child_name = format!("_{parent_name}_ArrayType");
        let child_utype = asm.next_type_utype;
        asm.next_type_utype += 1;
        asm.types.push(AsmType {
            name: child_name.clone(),
            utype: child_utype,
            kind: "inline-array",
            aliased_to: None,
            line: Some(line),
            origin: origin.to_string(),
        });
        if of_type.of_type.is_none() {
            asm.issues.push(AsmIssue {
                kind: "array-of-missing",
                fatal: true,
                line: Some(line),
                message: "FixedArrayType::initialize: not found \"of\".".to_string(),
            });
        }
        let nested = match of_type.of_type.as_deref() {
            Some(inner) => parse_array_of_type(method, inner, &child_name, origin, asm),
            None => None,
        };
        let Some(nested) = nested else {
            asm.issues.push(AsmIssue {
                kind: "array-init-failed",
                fatal: true,
                line: Some(line),
                message: "FixedArrayType::initialize: Array is wrong.".to_string(),
            });
            return None;
        };
        return Some(AsmArg {
            name: "ARRAY".to_string(),
            of_type: Some(Box::new(nested)),
            utype: Some(child_utype),
            line,
        });
    }

    let element_utype = lookup_type(&of_type.name, asm);
    if element_utype.is_none() {
        asm.issues.push(AsmIssue {
            kind: "array-of-unknown-type",
            fatal: true,
            line: Some(line),
            message: format!(
                "FixedArrayType::initialize: key[ARRAY] did not find type[{}]!",
                of_type.name
            ),
        });
        return None;
    }
    Some(AsmArg {
        name: of_type.name.clone(),
        of_type: None,
        utype: element_utype,
        line,
    })
}

// ---------------------------------------------------------------------------
// aliasID 分配(TS assignAliasIds + assignAliasRange)
// ---------------------------------------------------------------------------

fn assign_alias_ids(asm: &mut Assembly, alias_id_enabled: bool) {
    if !alias_id_enabled {
        return;
    }
    let mut client_properties: Vec<usize> = asm
        .properties
        .iter()
        .enumerate()
        .filter(|(_, p)| p.has_client)
        .map(|(i, _)| i)
        .collect();
    client_properties.sort_by(|&a, &b| asm.properties[a].name.cmp(&asm.properties[b].name));
    let mut next = ALIAS_ID_PROPERTY_BASE;
    for &i in &client_properties {
        asm.properties[i].alias_id = Some(next);
        next += 1;
    }
    if !client_properties.is_empty() && next - 1 > ALIAS_ID_MAX {
        for &i in &client_properties {
            asm.properties[i].alias_id = Some(-1);
        }
    }

    let mut client_methods: Vec<usize> = asm
        .methods
        .iter()
        .enumerate()
        .filter(|(_, m)| m.section == "ClientMethods")
        .map(|(i, _)| i)
        .collect();
    client_methods.sort_by(|&a, &b| asm.methods[a].name.cmp(&asm.methods[b].name));
    let mut next = 1;
    for &i in &client_methods {
        asm.methods[i].alias_id = Some(next);
        next += 1;
    }
    if !client_methods.is_empty() && next - 1 > ALIAS_ID_MAX {
        for &i in &client_methods {
            asm.methods[i].alias_id = Some(-1);
        }
    }
}

// ---------------------------------------------------------------------------
// JSON 映射 + 时间戳
// ---------------------------------------------------------------------------

fn method_to_json(m: &AsmMethod) -> MethodJson {
    MethodJson {
        name: m.name.clone(),
        section: m.section.to_string(),
        direction: m.direction.to_string(),
        visible_to_client: m.visible_to_client,
        exposed: m.exposed,
        args: m.args.iter().map(arg_to_json).collect(),
        declared_utype: m.declared_utype,
        utype: m.utype,
        alias_id: m.alias_id,
        status: m.status.to_string(),
        origin: m.origin.clone(),
        origin_kind: m.origin_kind.to_string(),
        line: m.line,
    }
}

fn arg_to_json(a: &AsmArg) -> ArgJson {
    ArgJson {
        name: a.name.clone(),
        of_type: a.of_type.as_deref().map(|a| Box::new(arg_to_json(a))),
        utype: a.utype,
        line: a.line,
    }
}

fn property_to_json(p: &AsmProperty) -> PropertyJson {
    PropertyJson {
        name: p.name.clone(),
        type_name: p.type_name.clone(),
        flags: p.flags.clone(),
        has_client: p.has_client,
        utype: p.utype,
        declared_utype: p.declared_utype,
        alias_id: p.alias_id,
        origin: p.origin.clone(),
        origin_kind: p.origin_kind.to_string(),
        line: p.line,
    }
}

/// 当前 UTC 时间 ISO-8601(TS new Date().toISOString() 等价,毫秒截 0)。
fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.000Z")
}

/// 1970-01-01 起天数 → 公历(y,m,d)(Howard Hinnant civil_from_days)。
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
