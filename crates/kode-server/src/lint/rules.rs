//! def 分析规则实现(每规则一结构体)。
//!
//! 前 9 条镜像 TS analyzeDefDocument(分析建议面);后 5 条镜像
//! diagnostics.rs 的 validateDocument 语料子集(结构校验面)。消息文案逐字节
//! 同源,区间(节点 span / 取值子区间)与 TS 同口径。规则顺序即注册顺序,
//! 决定聚合输出序。

use std::collections::{BTreeMap, BTreeSet};

use kode_parser::xml::{self, Document, NodeData};

use super::{make_finding, Finding, Rule, RuleRegistry};

// ---------------------------------------------------------------------------
// 词表(与 TS defAnalyzer / kbengineMetadata 同表)
// ---------------------------------------------------------------------------

/// 引擎未注册的幻影类型名(datatypes.cpp addDataType 真值的补集)。
const PHANTOM_TYPE_NAMES: &[&str] = &["BOOL", "BOOLEAN", "TUPLE", "MAP", "FIXED_ARRAY"];

/// 大负载类型(对全体客户端广播时同步开销显著)。
const HEAVY_SYNC_TYPE_NAMES: &[&str] = &[
    "STRING", "UNICODE", "BLOB", "ARRAY", "FIXED_DICT", "PY_DICT", "PY_LIST", "PY_TUPLE", "VECTOR2",
    "VECTOR3", "VECTOR4",
];

/// 客户端可见旗标(common.h ENTITY_CLIENT_DATA_FLAGS 位集展开,8 个无 ANY_CLIENT)。
const CLIENT_SYNC_FLAGS: &[&str] = &[
    "ALL_CLIENTS",
    "CELL_PUBLIC_AND_OWN",
    "OWN_CLIENT",
    "BASE_AND_CLIENT",
    "OTHER_CLIENTS",
];

/// Python 关键字(引擎 setattr 挂关键字名不报错,但脚本语法上不可访问)。
const PYTHON_KEYWORDS: &[&str] = &[
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
    "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
    "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with",
    "yield",
];

/// 引擎受限属性名(validDefPropertyName 按名拒绝;FIXED_DICT 键不受此限)。
const ENTITY_LIMITED_PROPERTYS: &[&str] = &[
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

/// KBENGINE_FLAGS 12 词(含 CELL* 别名拼写;未知 Flags 值判定用)。
const KNOWN_FLAGS: &[&str] = &[
    "CELL_PUBLIC",
    "CELL_PRIVATE",
    "ALL_CLIENTS",
    "CELL_PUBLIC_AND_OWN",
    "OWN_CLIENT",
    "BASE_AND_CLIENT",
    "BASE",
    "OTHER_CLIENTS",
    "CELL",
    "CELL_AND_CLIENT",
    "CELL_AND_CLIENTS",
    "CELL_AND_OTHER_CLIENTS",
];

/// loadDetailLevelInfo 三档。
const DETAIL_LEVELS: &[&str] = &["NEAR", "MEDIUM", "FAR"];

// ---------------------------------------------------------------------------
// 结构助手
// ---------------------------------------------------------------------------

fn is_python_keyword(name: &str) -> bool {
    PYTHON_KEYWORDS.contains(&name)
}

fn describe_keyword_problem(name: &str) -> String {
    format!(
        "名字 {name} 是 Python 关键字:引擎装载不失败,但脚本无法用 self.{name} 访问该成员,建议改名"
    )
}

fn describe_limited_name(kind: &str, name: &str) -> String {
    format!(
        "{kind} {name} 是引擎受限名(ENTITY_LIMITED_PROPERTYS):引擎按名拒绝,实体加载会失败;请改名"
    )
}

/// 节点整体区间(tagStart..closeTagEnd;自闭合 closeTagEnd=开标签终点)。
fn node_span(data: &xml::ElementData) -> kode_parser::diag::Span {
    kode_parser::diag::Span::new(data.open_span.start, data.close_span.end)
}

/// 标签名子区间(`<name ...>` 内的名字)。
fn name_span(data: &xml::ElementData) -> kode_parser::diag::Span {
    data.name_span
}

/// 直接文本子节点的首个 Text span(取值定位用;无文本 → None)。
fn text_child_span(doc: &Document, idx: usize) -> Option<kode_parser::diag::Span> {
    doc.element(idx)
        .children
        .iter()
        .find_map(|&c| match &doc.nodes[c].data {
            NodeData::Text { span, .. } => Some(*span),
            _ => None,
        })
}

/// 取值子区间:值在 content 内的首次出现;越界/缺失回落 content 区间。
fn value_span(text: &str, data: &xml::ElementData, value: &str) -> kode_parser::diag::Span {
    let content_start = data.content_span.start.min(text.len());
    let content_end = data.content_span.end.min(text.len());
    let found = text[content_start..content_end]
        .find(value)
        .map(|rel| content_start + rel)
        .filter(|&offset| offset <= content_end);
    match found {
        Some(offset) => kode_parser::diag::Span::new(offset, offset + value.len()),
        None => kode_parser::diag::Span::new(content_start, content_end),
    }
}

/// 取值子区间(按元素名取其文本值定位)。
fn value_span_of(doc: &Document, text: &str, idx: usize, value: &str) -> kode_parser::diag::Span {
    value_span(text, doc.element(idx), value)
}

/// 直接文本拼接 trim(TS getNodeValue 同语义)。
fn node_value(doc: &Document, idx: usize) -> String {
    doc.element(idx).text(doc).trim().to_string()
}

/// `|` 拆分 Flags 文本 → token 列表(trim + 去空)。
fn split_flags(raw: &str) -> Vec<String> {
    raw.split('|')
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

/// Flags 归一化大写(未知 Flags 值判定用;与 diagnostics.rs scalar_pass 同口径)。
fn normalize_flag_upper(raw: &str) -> String {
    raw.trim().to_uppercase()
}

/// Flags → 三域位(base/cell/client;common.h ENTITY_*_DATA_FLAGS 真值)。
fn flag_scopes(flags: &[String]) -> Vec<String> {
    let has = |names: &[&str]| flags.iter().any(|f| names.contains(&f.as_str()));
    let mut out = Vec::new();
    if has(&["BASE", "BASE_AND_CLIENT"]) {
        out.push("base".to_string());
    }
    if has(&[
        "CELL_PUBLIC",
        "CELL_PRIVATE",
        "ALL_CLIENTS",
        "CELL_PUBLIC_AND_OWN",
        "OWN_CLIENT",
        "OTHER_CLIENTS",
    ]) {
        out.push("cell".to_string());
    }
    if has(&[
        "BASE_AND_CLIENT",
        "ALL_CLIENTS",
        "CELL_PUBLIC_AND_OWN",
        "OWN_CLIENT",
        "OTHER_CLIENTS",
    ]) {
        out.push("client".to_string());
    }
    out
}

fn scope_label(scope: &str) -> &str {
    match scope {
        "base" => "Base",
        "cell" => "Cell",
        "client" => "Client",
        other => other,
    }
}

/// 顶层段白名单(TS toSectionName ∩ ALLOWED_TOP_LEVEL_SECTIONS,精确大小写)。
fn section_label_of(name: &str) -> Option<&'static str> {
    match name {
        "Parent" => Some("父类区块"),
        "Interfaces" => Some("接口区块"),
        "Components" => Some("组件区块"),
        "Properties" => Some("属性区块"),
        "BaseMethods" | "CellMethods" | "ClientMethods" => Some("方法区块"),
        "Volatile" => Some("易变同步区块"),
        _ => None,
    }
}

/// 属性 Flags token(直接 <Flags> 子元素文本拆分)。
fn property_flags(doc: &Document, prop: usize) -> Vec<String> {
    doc.child_element(prop, "Flags")
        .map(|f| split_flags(&node_value(doc, f)))
        .unwrap_or_default()
}

/// 属性 <Type> 取值(直接 <Type> 子元素文本 trim)。
fn property_type_value(doc: &Document, prop: usize) -> Option<String> {
    let type_node = doc.child_element(prop, "Type")?;
    let value = node_value(doc, type_node);
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

// ---------------------------------------------------------------------------
// 规则 1..9:分析建议面(analyzeDefDocument)
// ---------------------------------------------------------------------------

/// 未知 Type 引用(幻影类型)。
#[derive(Debug)]
pub struct PhantomTypeRule;
impl Rule for PhantomTypeRule {
    fn id(&self) -> &'static str {
        "phantom-type"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let doc = ctx.doc;
        let mut out = Vec::new();
        for prop in properties_section(doc) {
            let data = doc.element(prop);
            let Some(type_node) = doc.child_element(prop, "Type") else {
                continue;
            };
            let Some(type_span) = text_child_span(doc, type_node) else {
                continue;
            };
            let value = node_value(doc, type_node);
            if PHANTOM_TYPE_NAMES.contains(&value.as_str()) {
                out.push(make_finding(
                    "phantom-type",
                    "error",
                    type_span,
                    Some(data.name.clone()),
                    format!(
                        "属性 {} 的类型 {} 引擎未注册,实体加载会失败;请改用注册表中的类型",
                        data.name, value
                    ),
                    ctx,
                ));
            }
        }
        out
    }
}

/// 缺 <Type>(属性 Type 缺失或空)。
#[derive(Debug)]
pub struct MissingTypeRule;
impl Rule for MissingTypeRule {
    fn id(&self) -> &'static str {
        "missing-type"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let doc = ctx.doc;
        let mut out = Vec::new();
        for prop in properties_section(doc) {
            let data = doc.element(prop);
            if property_type_value(doc, prop).is_none() {
                out.push(make_finding(
                    "missing-type",
                    "error",
                    name_span(data),
                    Some(data.name.clone()),
                    format!("属性 {} 缺少有效的 <Type>,实体加载会失败", data.name),
                    ctx,
                ));
            }
        }
        out
    }
}

/// 重复 <Type>(引擎只取首个,其余忽略)。
#[derive(Debug)]
pub struct DuplicateTypeTagRule;
impl Rule for DuplicateTypeTagRule {
    fn id(&self) -> &'static str {
        "duplicate-type-tag"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let doc = ctx.doc;
        let mut out = Vec::new();
        for prop in properties_section(doc) {
            let data = doc.element(prop);
            let type_nodes = doc.child_elements_named(prop, "Type");
            if type_nodes.len() > 1 {
                out.push(make_finding(
                    "duplicate-type-tag",
                    "warning",
                    name_span(data),
                    Some(data.name.clone()),
                    format!(
                        "属性 {} 定义了 {} 个 <Type>,引擎只装载首个、其余被忽略,请仅保留一个",
                        data.name,
                        type_nodes.len()
                    ),
                    ctx,
                ));
            }
        }
        out
    }
}

/// 大字段对全体客户端广播(ALL_CLIENTS + 大负载类型)。
#[derive(Debug)]
pub struct HeavySyncBroadcastRule;
impl Rule for HeavySyncBroadcastRule {
    fn id(&self) -> &'static str {
        "heavy-sync-broadcast"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let doc = ctx.doc;
        let mut out = Vec::new();
        for prop in properties_section(doc) {
            let data = doc.element(prop);
            let Some(flags_node) = doc.child_element(prop, "Flags") else {
                continue;
            };
            let flags = split_flags(&node_value(doc, flags_node));
            let Some(type_value) = property_type_value(doc, prop) else {
                continue;
            };
            if flags.contains(&"ALL_CLIENTS".to_string())
                && HEAVY_SYNC_TYPE_NAMES.contains(&type_value.as_str())
            {
                out.push(make_finding(
                    "heavy-sync-broadcast",
                    "warning",
                    text_child_span(doc, flags_node)
                        .unwrap_or_else(|| node_span(doc.element(flags_node))),
                    Some(data.name.clone()),
                    format!(
                        "属性 {}({})以 ALL_CLIENTS 对全体客户端同步,大字段建议收窄旗标或改用 tag/DetailLevel 降低同步粒度",
                        data.name, type_value
                    ),
                    ctx,
                ));
            }
        }
        out
    }
}

/// DetailLevel 冗余(无客户端可见性时配 DetailLevel 无效果)。
#[derive(Debug)]
pub struct RedundantDetailLevelRule;
impl Rule for RedundantDetailLevelRule {
    fn id(&self) -> &'static str {
        "redundant-detail-level"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let doc = ctx.doc;
        let mut out = Vec::new();
        for prop in properties_section(doc) {
            let data = doc.element(prop);
            let Some(_) = doc.child_element(prop, "DetailLevel") else {
                continue;
            };
            let flags = property_flags(doc, prop);
            if !flags.iter().any(|f| CLIENT_SYNC_FLAGS.contains(&f.as_str())) {
                out.push(make_finding(
                    "redundant-detail-level",
                    "info",
                    name_span(data),
                    Some(data.name.clone()),
                    format!(
                        "属性 {} 的 Flags 无客户端可见性,配置 <DetailLevel> 不产生任何效果(冗余字段)",
                        data.name
                    ),
                    ctx,
                ));
            }
        }
        out
    }
}

/// Python 关键字命名(属性/方法)。
#[derive(Debug)]
pub struct InvalidIdentifierRule;
impl Rule for InvalidIdentifierRule {
    fn id(&self) -> &'static str {
        "invalid-identifier"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let doc = ctx.doc;
        let mut out = Vec::new();
        for prop in properties_section(doc) {
            let data = doc.element(prop);
            if is_python_keyword(&data.name) {
                out.push(make_finding(
                    "invalid-identifier",
                    "error",
                    name_span(data),
                    Some(data.name.clone()),
                    describe_keyword_problem(&data.name),
                    ctx,
                ));
            }
        }
        for method in all_methods_section(doc) {
            let data = doc.element(method);
            if is_python_keyword(&data.name) {
                out.push(make_finding(
                    "invalid-identifier",
                    "error",
                    name_span(data),
                    Some(data.name.clone()),
                    describe_keyword_problem(&data.name),
                    ctx,
                ));
            }
        }
        out
    }
}

/// 方法与属性同名。
#[derive(Debug)]
pub struct MethodPropertyCollisionRule;
impl Rule for MethodPropertyCollisionRule {
    fn id(&self) -> &'static str {
        "method-property-collision"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let doc = ctx.doc;
        let prop_names: BTreeSet<String> = properties_section(doc)
            .into_iter()
            .map(|p| doc.element(p).name.clone())
            .collect();
        let mut out = Vec::new();
        for method in all_methods_section(doc) {
            let data = doc.element(method);
            if prop_names.contains(&data.name) {
                out.push(make_finding(
                    "method-property-collision",
                    "error",
                    name_span(data),
                    Some(data.name.clone()),
                    format!(
                        "方法 {} 与属性同名:引擎装载时按名冲突直接拒绝(scriptdef_module),实体加载会失败",
                        data.name
                    ),
                    ctx,
                ));
            }
        }
        out
    }
}

/// 引擎受限名(属性/方法/组件槽)。
#[derive(Debug)]
pub struct EngineLimitedNameRule;
impl Rule for EngineLimitedNameRule {
    fn id(&self) -> &'static str {
        "engine-limited-name"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let doc = ctx.doc;
        let mut out = Vec::new();
        for (nodes, kind) in [
            (properties_section(doc), "属性"),
            (all_methods_section(doc), "方法"),
            (components_section(doc), "组件"),
        ] {
            for node in nodes {
                let data = doc.element(node);
                if ENTITY_LIMITED_PROPERTYS.contains(&data.name.as_str()) {
                    out.push(make_finding(
                        "engine-limited-name",
                        "error",
                        name_span(data),
                        Some(data.name.clone()),
                        describe_limited_name(kind, &data.name),
                        ctx,
                    ));
                }
            }
        }
        out
    }
}

/// 继承链同名判重(批116;引擎 scriptdef_module 判重语义)。
#[derive(Debug)]
pub struct InheritedNameCollisionRule;
impl Rule for InheritedNameCollisionRule {
    fn id(&self) -> &'static str {
        "inherited-name-collision"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let doc = ctx.doc;
        let mut out = Vec::new();
        for prop in properties_section(doc) {
            let data = doc.element(prop);
            let Some(info) = ctx.inherited.get(&data.name) else {
                continue;
            };
            let own_domains = flag_scopes(&property_flags(doc, prop));
            if !info.method_sources.is_empty() {
                out.push(make_finding(
                    "inherited-name-collision",
                    "error",
                    name_span(data),
                    Some(data.name.clone()),
                    format!(
                        "属性 {} 与继承链上的方法同名:父子/接口描述装入同一 ScriptDefModule,hasMethodName 全局拒绝,实体加载会失败{}",
                        data.name,
                        cite(&info.method_sources)
                    ),
                    ctx,
                ));
                continue;
            }
            let overlaps = info
                .property_domains
                .iter()
                .chain(info.component_domains.iter())
                .any(|d| own_domains.contains(d));
            if overlaps {
                let mut sources: Vec<String> = info.property_sources.clone();
                sources.extend(info.component_sources.clone());
                out.push(make_finding(
                    "inherited-name-collision",
                    "error",
                    name_span(data),
                    Some(data.name.clone()),
                    format!(
                        "属性 {} 与继承链上的属性/组件槽同域位同名:同一模块 addPropertyDescription 判重拒绝,实体加载会失败{}",
                        data.name,
                        cite(&sources)
                    ),
                    ctx,
                ));
            }
        }
        for (method, section) in all_methods_with_section(doc) {
            let data = doc.element(method);
            let Some(info) = ctx.inherited.get(&data.name) else {
                continue;
            };
            if info.method_sections.iter().any(|s| s == section) {
                out.push(make_finding(
                    "inherited-name-collision",
                    "error",
                    name_span(data),
                    Some(data.name.clone()),
                    format!(
                        "方法 {} 与继承链上的方法同段同名:同一模块同段判重拒绝,实体加载会失败{}",
                        data.name,
                        cite(&info.method_sources)
                    ),
                    ctx,
                ));
                continue;
            }
            if !info.property_sources.is_empty() || !info.component_sources.is_empty() {
                let mut sources: Vec<String> = info.property_sources.clone();
                sources.extend(info.component_sources.clone());
                out.push(make_finding(
                    "inherited-name-collision",
                    "error",
                    name_span(data),
                    Some(data.name.clone()),
                    format!(
                        "方法 {} 与继承链上的属性/组件同名:addXxxMethodDescription 的 hasPropertyName/hasComponentName 全局拒绝,实体加载会失败{}",
                        data.name,
                        cite(&sources)
                    ),
                    ctx,
                ));
            }
        }
        for comp in components_section(doc) {
            let data = doc.element(comp);
            let Some(info) = ctx.inherited.get(&data.name) else {
                continue;
            };
            let mut sources: Vec<String> = info.property_sources.clone();
            sources.extend(info.component_sources.clone());
            sources.extend(info.method_sources.clone());
            out.push(make_finding(
                "inherited-name-collision",
                "error",
                name_span(data),
                Some(data.name.clone()),
                format!(
                    "组件槽 {} 与继承链上的声明同名:组件槽经 addComponentProperty 走 addPropertyDescription,同名判重拒绝,实体加载会失败{}",
                    data.name,
                    cite(&sources)
                ),
                ctx,
            ));
        }
        out
    }
}

fn cite(sources: &[String]) -> String {
    format!("(继承自 {})", sources.join("、"))
}

// ---------------------------------------------------------------------------
// 规则 10..14:结构校验面(diagnostics.rs 语料子集)
// ---------------------------------------------------------------------------

/// 未知 Type 引用(builtin ∪ 已知类型之外 → Error;候选词子区间)。
#[derive(Debug)]
pub struct UnknownTypeReferenceRule;
impl Rule for UnknownTypeReferenceRule {
    fn id(&self) -> &'static str {
        "unknown-type-reference"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let mut out = Vec::new();
        walk_all(ctx.doc, &mut |doc, node| {
            if doc.element(node).name != "Type" {
                return;
            }
            let value = node_value(doc, node);
            if value.is_empty() || !doc.child_elements(node).is_empty() {
                return;
            }
            for candidate in word_tokens(&value) {
                if ctx.known_types.contains(&candidate) {
                    continue;
                }
                out.push(make_finding(
                    "unknown-type-reference",
                    "error",
                    value_span_of(doc, ctx.text, node, &candidate),
                    None,
                    format!(
                        "自定义类型 {candidate} 未在 types.xml 中注册，请先在 types.xml 注册后再引用"
                    ),
                    ctx,
                ));
            }
        });
        out
    }
}

/// 未知 Flags 值(12 词表之外 → Error)。
#[derive(Debug)]
pub struct UnknownFlagValueRule;
impl Rule for UnknownFlagValueRule {
    fn id(&self) -> &'static str {
        "unknown-flag-value"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let mut out = Vec::new();
        walk_all(ctx.doc, &mut |doc, node| {
            if doc.element(node).name != "Flags" {
                return;
            }
            let raw = node_value(doc, node);
            let normalized = normalize_flag_upper(&raw);
            if !normalized.is_empty() && !KNOWN_FLAGS.contains(&normalized.as_str()) {
                let data = doc.element(node);
                out.push(make_finding(
                    "unknown-flag-value",
                    "error",
                    value_span(ctx.text, data, &raw),
                    None,
                    format!(
                        "未知的 KBEngine Flags 值: {raw}。KBEngine 源码按单个映射值解析 <Flags>，不支持此写法。"
                    ),
                    ctx,
                ));
            }
        });
        out
    }
}

/// 未知 DetailLevel(三档之外 → Error)。
#[derive(Debug)]
pub struct UnknownDetailLevelRule;
impl Rule for UnknownDetailLevelRule {
    fn id(&self) -> &'static str {
        "unknown-detail-level"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let mut out = Vec::new();
        walk_all(ctx.doc, &mut |doc, node| {
            if doc.element(node).name != "DetailLevel" {
                return;
            }
            let value = node_value(doc, node);
            if !value.is_empty() && !DETAIL_LEVELS.contains(&value.as_str()) {
                let data = doc.element(node);
                out.push(make_finding(
                    "unknown-detail-level",
                    "error",
                    value_span(ctx.text, data, &value),
                    None,
                    format!("未知的 DetailLevel: {value}"),
                    ctx,
                ));
            }
        });
        out
    }
}

/// 重复定义(按段;Properties 按旗标作用域判重,Warning+Info 成对)。
#[derive(Debug)]
pub struct DuplicateDefinitionRule;
impl Rule for DuplicateDefinitionRule {
    fn id(&self) -> &'static str {
        "duplicate-definition"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let doc = ctx.doc;
        let Some(root) = doc.root() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for section in doc.child_elements(root) {
            let section_data = doc.element(section);
            let Some(label) = section_label_of(&section_data.name) else {
                continue;
            };
            let is_properties = section_data.name == "Properties";
            let mut seen_symbols: BTreeMap<String, kode_parser::diag::Span> = BTreeMap::new();
            let mut seen_scopes: BTreeMap<String, BTreeMap<String, kode_parser::diag::Span>> =
                BTreeMap::new();
            for symbol in doc.child_elements(section) {
                let symbol_data = doc.element(symbol);
                let symbol_range = node_span(symbol_data);
                if is_properties {
                    let scopes = flag_scopes(&property_flags(doc, symbol));
                    if !scopes.is_empty() {
                        let empty = BTreeMap::new();
                        let known = seen_scopes.get(&symbol_data.name).unwrap_or(&empty);
                        let hits: Vec<String> = scopes
                            .iter()
                            .filter(|s| known.contains_key(*s))
                            .cloned()
                            .collect();
                        for scope in &hits {
                            out.push(make_finding(
                                "duplicate-definition",
                                "warning",
                                symbol_range,
                                Some(symbol_data.name.clone()),
                                format!(
                                    "{label}中存在重复定义: {} ({})",
                                    symbol_data.name,
                                    scope_label(scope)
                                ),
                                ctx,
                            ));
                            let existing = known.get(scope).expect("scope checked");
                            out.push(make_finding(
                                "duplicate-definition",
                                "info",
                                *existing,
                                Some(symbol_data.name.clone()),
                                format!(
                                    "{} 在 {label} 中已在 {} 作用域定义",
                                    symbol_data.name,
                                    scope_label(scope)
                                ),
                                ctx,
                            ));
                        }
                        let entry = seen_scopes.entry(symbol_data.name.clone()).or_default();
                        for scope in &scopes {
                            entry.entry(scope.clone()).or_insert(symbol_range);
                        }
                    }
                } else if let Some(existing) = seen_symbols.get(&symbol_data.name) {
                    out.push(make_finding(
                        "duplicate-definition",
                        "warning",
                        symbol_range,
                        Some(symbol_data.name.clone()),
                        format!("{label}中存在重复定义: {}", symbol_data.name),
                        ctx,
                    ));
                    out.push(make_finding(
                        "duplicate-definition",
                        "info",
                        *existing,
                        Some(symbol_data.name.clone()),
                        format!("{} 在 {label} 中已定义", symbol_data.name),
                        ctx,
                    ));
                } else {
                    seen_symbols.insert(symbol_data.name.clone(), symbol_range);
                }
            }
        }
        out
    }
}

/// 属性缺 <Flags>。
#[derive(Debug)]
pub struct MissingFlagsRule;
impl Rule for MissingFlagsRule {
    fn id(&self) -> &'static str {
        "missing-flags"
    }
    fn check(&self, ctx: &super::RuleContext) -> Vec<Finding> {
        let doc = ctx.doc;
        let mut out = Vec::new();
        for prop in properties_section(doc) {
            let data = doc.element(prop);
            if doc.child_element(prop, "Flags").is_none() {
                out.push(make_finding(
                    "missing-flags",
                    "error",
                    node_span(data),
                    Some(data.name.clone()),
                    format!("属性 {} 缺少 <Flags> 定义", data.name),
                    ctx,
                ));
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// 段/树遍历助手
// ---------------------------------------------------------------------------

/// `<Properties>` 段内属性元素下标列表。
fn properties_section(doc: &Document) -> Vec<usize> {
    doc.root()
        .and_then(|r| doc.child_element(r, "Properties"))
        .map(|s| doc.child_elements(s))
        .unwrap_or_default()
}

/// `<Components>` 段内组件元素下标列表。
fn components_section(doc: &Document) -> Vec<usize> {
    doc.root()
        .and_then(|r| doc.child_element(r, "Components"))
        .map(|s| doc.child_elements(s))
        .unwrap_or_default()
}

/// 三方法段(Base/Cell/Client)内方法元素下标列表(段序稳定)。
fn all_methods_section(doc: &Document) -> Vec<usize> {
    all_methods_with_section(doc)
        .into_iter()
        .map(|(m, _)| m)
        .collect()
}

/// 三方法段内 (方法, 段名) 列表(段序 Base → Cell → Client)。
fn all_methods_with_section(doc: &Document) -> Vec<(usize, &'static str)> {
    const SECTIONS: &[(&str, &str)] = &[
        ("BaseMethods", "base"),
        ("CellMethods", "cell"),
        ("ClientMethods", "client"),
    ];
    let Some(root) = doc.root() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for &(tag, section) in SECTIONS {
        if let Some(sec) = doc.child_element(root, tag) {
            for m in doc.child_elements(sec) {
                out.push((m, section));
            }
        }
    }
    out
}

/// DFS 先序遍历全部元素(标量扫描用;TS visitElementNodes 同序)。
fn dfs_find(doc: &Document, node: usize, f: &mut impl FnMut(&Document, usize)) {
    f(doc, node);
    for child in doc.child_elements(node) {
        dfs_find(doc, child, f);
    }
}

/// 从根元素起 DFS 先序遍历全部元素。
fn walk_all(doc: &Document, f: &mut impl FnMut(&Document, usize)) {
    if let Some(root) = doc.root() {
        dfs_find(doc, root, f);
    }
}

/// 词法扫描 [A-Za-z_][A-Za-z0-9_]*(TS typeCandidateRegex 同序)。
fn word_tokens(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = value.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_alphabetic() || chars[i] == '_' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            out.push(chars[start..i].iter().collect());
        } else {
            i += 1;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

/// 把全量规则按稳定顺序推入注册表。
pub fn register_all(reg: &mut RuleRegistry) {
    reg.push(Box::new(PhantomTypeRule));
    reg.push(Box::new(MissingTypeRule));
    reg.push(Box::new(DuplicateTypeTagRule));
    reg.push(Box::new(HeavySyncBroadcastRule));
    reg.push(Box::new(RedundantDetailLevelRule));
    reg.push(Box::new(InvalidIdentifierRule));
    reg.push(Box::new(MethodPropertyCollisionRule));
    reg.push(Box::new(EngineLimitedNameRule));
    reg.push(Box::new(InheritedNameCollisionRule));
    reg.push(Box::new(UnknownTypeReferenceRule));
    reg.push(Box::new(UnknownFlagValueRule));
    reg.push(Box::new(UnknownDetailLevelRule));
    reg.push(Box::new(DuplicateDefinitionRule));
    reg.push(Box::new(MissingFlagsRule));
}
