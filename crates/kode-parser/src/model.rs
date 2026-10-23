//! KBEngine 语义模型:.def / entities.xml / types.xml / alias.xml(书 §6.2 基础版)。
//!
//! 提取规则与 TS 现有实现对齐(defParser/defAnalyzer/compositionRoots/
//! definitionWorkspace 的同口径函数),差异逐条记录在 docs/kode2/pr-005.md:
//! - 已知标签用**规范化名**(小写、去空格/下划线/连字符)匹配,以容忍引擎
//!   历史拼写变体(`DetailLevel`/`Detaillevel`、`All Clients`/`ALL_CLIENTS`、
//!   `ClientFlags`/`Client Flags`);fixture 语料全用规范拼写,故与 TS 的
//!   精确名匹配结果一致(对拍覆盖)。
//! - 未知子标签/未知段落**保留**在 `extra_*`,不因未知标签失败(SYNTAX-005)。

use crate::diag::{Diagnostic, LineMap, Span};
use crate::xml::Document;

// ---------------------------------------------------------------------------
// .def
// ---------------------------------------------------------------------------

/// 方法段(引擎 entitydef 三段;顺序稳定供序列化)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MethodSection {
    Base,
    Cell,
    Client,
}

impl MethodSection {
    pub fn as_str(&self) -> &'static str {
        match self {
            MethodSection::Base => "base",
            MethodSection::Cell => "cell",
            MethodSection::Client => "client",
        }
    }

    fn section_tag(&self) -> &'static str {
        match self {
            MethodSection::Base => "BaseMethods",
            MethodSection::Cell => "CellMethods",
            MethodSection::Client => "ClientMethods",
        }
    }

    /// 解析 .def 中的对应方法段名 → 段内方法列表。
    pub fn extract_methods_of(self, doc: &Document, root: usize) -> Vec<usize> {
        doc.child_element(root, self.section_tag())
            .map(|s| doc.child_elements(s))
            .unwrap_or_default()
    }
}

/// 属性旗标(规范化后;未知旗标原样保留大写)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyDef {
    pub name: String,
    pub name_span: Span,
    pub line: usize,
    /// `<Type>` 直接文本首 token(ARRAY/FIXED_DICT/内建名/自定义名)。
    pub type_name: Option<String>,
    /// `<Type>` 上的全部类型引用(文本 token 去掉 ARRAY/FIXED_DICT + `<of>` 文本;
    /// 与 TS collectTypeReferences 同口径)。
    pub type_refs: Vec<String>,
    /// `<Flags>` 原文(trim)。
    pub flags_raw: Option<String>,
    /// 旗标 token 规范化结果(顺序保留)。
    pub flags: Vec<String>,
    /// `<DetailLevel>`(遗留拼写 `Detaillevel` 等同识别)。
    pub detail_level: Option<String>,
    /// `<Persistent>`(truthy 语义同 TS hasTruthyChildTag)。
    pub persistent: Option<bool>,
    /// `<Sensitive>` / `<ClientFlags>` 遗留标签存在且 truthy。
    pub sensitive: bool,
    /// 未知子标签(保留名 + span;SYNTAX-005)。
    pub extra_tags: Vec<(String, Span)>,
}

/// 方法声明(Base/Cell/Client 段内)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodDef {
    pub name: String,
    pub name_span: Span,
    pub line: usize,
    /// `<Arg>` 文本(按出现顺序)。
    pub args: Vec<String>,
    /// `<Exposed>` truthy。
    pub exposed: bool,
}

/// 组件槽(`<Components>` 条目)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentDef {
    pub name: String,
    pub name_span: Span,
    pub line: usize,
    pub component_type: Option<String>,
    pub persistent: Option<bool>,
}

/// 单个 .def 文件的语义视图。
#[derive(Debug, Clone)]
pub struct DefFile {
    pub root_tag: Option<String>,
    pub parent: Option<String>,
    pub interfaces: Vec<String>,
    pub volatile: bool,
    pub properties: Vec<PropertyDef>,
    pub components: Vec<ComponentDef>,
    pub base_methods: Vec<MethodDef>,
    pub cell_methods: Vec<MethodDef>,
    pub client_methods: Vec<MethodDef>,
    /// 未识别的顶层段落(名 + span;SYNTAX-005)。
    pub extra_sections: Vec<(String, Span)>,
    pub diagnostics: Vec<Diagnostic>,
}

/// 解析 .def(含伪注释掩码)。
pub fn parse_def(text: &str) -> DefFile {
    let doc = crate::xml::parse(text, true);
    extract_def(&doc, text)
}

/// 从已解析文档提取 .def 语义(line 计算用原始文本;掩码不改长度)。
pub fn extract_def(doc: &Document, raw_text: &str) -> DefFile {
    let lines = LineMap::new(raw_text);
    let mut out = DefFile {
        root_tag: None,
        parent: None,
        interfaces: Vec::new(),
        volatile: false,
        properties: Vec::new(),
        components: Vec::new(),
        base_methods: Vec::new(),
        cell_methods: Vec::new(),
        client_methods: Vec::new(),
        extra_sections: Vec::new(),
        diagnostics: doc.diagnostics.clone(),
    };
    let root = match doc.root() {
        Some(r) => r,
        None => return out,
    };
    out.root_tag = Some(doc.element(root).name.clone());
    for child in doc.child_elements(root) {
        let e = doc.element(child);
        match canonical_tag(&e.name).as_str() {
            "parent" => {
                let t = e.text(doc).trim().to_string();
                if !t.is_empty() {
                    out.parent = Some(t);
                }
            }
            "interfaces" => {
                for iface in doc.child_elements(child) {
                    let name = doc.element(iface).text(doc).trim().to_string();
                    if !name.is_empty() {
                        out.interfaces.push(name);
                    }
                }
            }
            "volatile" => out.volatile = doc.truthy_child(root, &e.name),
            "properties" => {
                for prop in doc.child_elements(child) {
                    out.properties.push(extract_property(doc, prop, &lines));
                }
            }
            "components" => {
                for comp in doc.child_elements(child) {
                    let ce = doc.element(comp);
                    out.components.push(ComponentDef {
                        name: ce.name.clone(),
                        name_span: ce.name_span,
                        line: lines.line_of(ce.name_span.start),
                        component_type: doc.scalar_child_value(comp, "Type"),
                        persistent: doc
                            .child_element(comp, "Persistent")
                            .map(|_| doc.truthy_child(comp, "Persistent")),
                    });
                }
            }
            "basemethods" => {
                out.base_methods = extract_methods(doc, child, &lines);
            }
            "cellmethods" => {
                out.cell_methods = extract_methods(doc, child, &lines);
            }
            "clientmethods" => {
                out.client_methods = extract_methods(doc, child, &lines);
            }
            _ => out.extra_sections.push((e.name.clone(), e.name_span)),
        }
    }
    out
}

fn extract_property(doc: &Document, idx: usize, lines: &LineMap) -> PropertyDef {
    let e = doc.element(idx);
    let mut prop = PropertyDef {
        name: e.name.clone(),
        name_span: e.name_span,
        line: lines.line_of(e.name_span.start),
        type_name: None,
        type_refs: Vec::new(),
        flags_raw: None,
        flags: Vec::new(),
        detail_level: None,
        persistent: None,
        sensitive: false,
        extra_tags: Vec::new(),
    };
    for child in doc.child_elements(idx) {
        let ce = doc.element(child);
        match canonical_tag(&ce.name).as_str() {
            "type" => {
                let refs = collect_type_refs(doc, child);
                prop.type_name = ce.first_text_token(doc);
                prop.type_refs = refs;
            }
            "flags" | "clientflags" => {
                let raw = ce.text(doc).trim().to_string();
                if !raw.is_empty() {
                    let tokens = normalize_flag_tokens(&raw);
                    // 遗留双标签(Client Flags + Flags)合并,去重保序。
                    for t in tokens {
                        if !prop.flags.contains(&t) {
                            prop.flags.push(t);
                        }
                    }
                    let raw_full = match &prop.flags_raw {
                        Some(prev) => format!("{prev}|{raw}"),
                        None => raw,
                    };
                    prop.flags_raw = Some(raw_full);
                }
            }
            "detaillevel" => {
                let t = ce.text(doc).trim().to_string();
                if !t.is_empty() {
                    prop.detail_level = Some(t);
                }
            }
            "persistent" => prop.persistent = Some(doc.truthy_child(idx, &ce.name)),
            "sensitive" => prop.sensitive = doc.truthy_child(idx, &ce.name) || prop.sensitive,
            _ => prop.extra_tags.push((ce.name.clone(), ce.name_span)),
        }
    }
    prop
}

fn extract_methods(doc: &Document, section: usize, lines: &LineMap) -> Vec<MethodDef> {
    let mut out = Vec::new();
    for m in doc.child_elements(section) {
        let me = doc.element(m);
        let mut args = Vec::new();
        let mut exposed = false;
        for child in doc.child_elements(m) {
            let ce = doc.element(child);
            match canonical_tag(&ce.name).as_str() {
                "arg" => {
                    let t = ce.text(doc).trim().to_string();
                    if !t.is_empty() {
                        args.push(t);
                    }
                }
                "exposed" => exposed = doc.truthy_child(m, &ce.name),
                _ => {}
            }
        }
        out.push(MethodDef {
            name: me.name.clone(),
            name_span: me.name_span,
            line: lines.line_of(me.name_span.start),
            args,
            exposed,
        });
    }
    out
}

/// TS collectTypeReferences 同口径:Type 直接文本 token(去掉 ARRAY/FIXED_DICT)
/// + `<of>` 文本,按出现顺序。
pub fn collect_type_refs(doc: &Document, type_idx: usize) -> Vec<String> {
    let mut names = Vec::new();
    let e = doc.element(type_idx);
    for token in e.text(doc).split_whitespace() {
        if token != "ARRAY" && token != "FIXED_DICT" {
            names.push(token.to_string());
        }
    }
    for child in doc.child_elements(type_idx) {
        let ce = doc.element(child);
        if ce.name == "of" {
            let of = ce.text(doc).trim().to_string();
            if !of.is_empty() {
                names.push(of);
            }
        }
    }
    names
}

/// 规范化标签名:小写 + 去掉空格/下划线/连字符(遗留拼写容忍)。
pub fn canonical_tag(name: &str) -> String {
    name.chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-' | '\t'))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 旗标文本 → 规范化 token(`|` 分隔)。
///
/// 与 TS defAnalyzer 同基座:trim + 大写,`CELL` → `CELL_PUBLIC` 别名;
/// 在此之上的**遗留拼写容忍**:`All Clients`/`ALL CLIENTS`/`ALL_CLIENTS`
/// 等空白/连字符变体折叠到规范形(去分隔符后重试);未知 token 按原文
/// 大写保留,不悄悄丢弃。
pub fn normalize_flag_tokens(raw: &str) -> Vec<String> {
    const KNOWN: &[&str] = &[
        "BASE",
        "BASE_AND_CLIENT",
        "CELL_PUBLIC",
        "CELL_PRIVATE",
        "ALL_CLIENTS",
        "CELL_PUBLIC_AND_OWN",
        "OWN_CLIENT",
        "OTHER_CLIENTS",
    ];
    let mut out = Vec::new();
    for token in raw.split('|') {
        let upper = token.trim().to_uppercase();
        if upper.is_empty() {
            continue;
        }
        let canonical = if upper == "CELL" {
            "CELL_PUBLIC".to_string()
        } else if KNOWN.contains(&upper.as_str()) {
            upper
        } else {
            // 遗留变体:去空白/连字符后与规范形对照(ALL CLIENTS → ALLCLIENTS → ALL_CLIENTS)
            let compact: String = upper
                .chars()
                .filter(|c| !matches!(c, ' ' | '_' | '-' | '\t'))
                .collect();
            match KNOWN
                .iter()
                .find(|k| k.chars().filter(|c| *c != '_').eq(compact.chars()))
            {
                Some(k) => (*k).to_string(),
                None => upper,
            }
        };
        if !out.contains(&canonical) {
            out.push(canonical);
        }
    }
    out
}

/// 三域位(base/cell/client)映射(common.h 真值,与 TS defAnalyzer 同表)。
pub fn flag_domains(flags: &[String]) -> Vec<&'static str> {
    let mut has_base = false;
    let mut has_cell = false;
    let mut has_client = false;
    for f in flags {
        match f.as_str() {
            "BASE" => has_base = true,
            "BASE_AND_CLIENT" => {
                has_base = true;
                has_client = true;
            }
            "CELL_PUBLIC" | "CELL_PRIVATE" => has_cell = true,
            "ALL_CLIENTS" | "CELL_PUBLIC_AND_OWN" => {
                has_cell = true;
                has_client = true;
            }
            "OWN_CLIENT" | "OTHER_CLIENTS" => has_client = true,
            _ => {}
        }
    }
    let mut out = Vec::new();
    if has_base {
        out.push("base");
    }
    if has_cell {
        out.push("cell");
    }
    if has_client {
        out.push("client");
    }
    out
}

impl DefFile {
    pub fn methods(&self, section: MethodSection) -> &[MethodDef] {
        match section {
            MethodSection::Base => &self.base_methods,
            MethodSection::Cell => &self.cell_methods,
            MethodSection::Client => &self.client_methods,
        }
    }
}

// ---------------------------------------------------------------------------
// entities.xml
// ---------------------------------------------------------------------------

/// 实体注册条目。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityEntry {
    pub name: String,
    pub name_span: Span,
    pub line: usize,
    /// 属性(hasBase/hasCell/hasClient 等,文档顺序)。
    pub attributes: Vec<(String, String)>,
}

/// entities.xml 注册清单(root 伪条目排除,与 TS getRegisteredEntities 同口径)。
#[derive(Debug, Clone, Default)]
pub struct EntitiesFile {
    pub entities: Vec<EntityEntry>,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn parse_entities(text: &str) -> EntitiesFile {
    let doc = crate::xml::parse(text, false);
    let lines = LineMap::new(text);
    let mut out = EntitiesFile {
        entities: Vec::new(),
        diagnostics: doc.diagnostics.clone(),
    };
    let root = match doc.root() {
        Some(r) => r,
        None => return out,
    };
    for child in doc.child_elements(root) {
        let e = doc.element(child);
        if e.name == "root" {
            continue;
        }
        out.entities.push(EntityEntry {
            name: e.name.clone(),
            name_span: e.name_span,
            line: lines.line_of(e.name_span.start),
            attributes: e
                .attributes
                .iter()
                .map(|a| (a.name.clone(), a.value.clone()))
                .collect(),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// types.xml
// ---------------------------------------------------------------------------

/// 自定义类型声明(与 TS compositionRoots::parseTypesXml 同口径)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeKind {
    FixedDict,
    Array,
    Builtin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeDecl {
    pub name: String,
    pub name_span: Span,
    pub line: usize,
    pub kind: TypeKind,
    /// 指引文本首 token(FIXED_DICT/ARRAY 或重定向目标;PR-008 类型图
    /// 别名节点消费;不进 parser golden)。
    pub directive: Option<String>,
    /// FIXED_DICT implementedBy 的末段符号(MODULE.Symbol → Symbol)。
    pub implemented_by_symbol: Option<String>,
    /// FIXED_DICT 键字段类型引用(逐属性 Type 收集)。
    pub field_refs: Vec<String>,
    /// ARRAY 的 `<of>` 元素类型。
    pub element_ref: Option<String>,
}

/// types.xml 类型表。
#[derive(Debug, Clone, Default)]
pub struct TypesFile {
    pub types: Vec<TypeDecl>,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn parse_types(text: &str) -> TypesFile {
    let doc = crate::xml::parse(text, false);
    extract_types(&doc, text)
}

pub fn extract_types(doc: &Document, raw_text: &str) -> TypesFile {
    let lines = LineMap::new(raw_text);
    let mut out = TypesFile {
        types: Vec::new(),
        diagnostics: doc.diagnostics.clone(),
    };
    let root = match doc.root() {
        Some(r) => r,
        None => return out,
    };
    for child in doc.child_elements(root) {
        let e = doc.element(child);
        let text_directive = e.first_text_token(doc).unwrap_or_default();
        // 属性式条目(`<JSONDATA type="UINT32"/>`):无文本指引时回落 `type`
        // 属性值(PR-012 门 §1.3-① 口径关闭:此前属性式被跳过,与 TS provider/
        // parseTypesXml 的注册面不一致;属性式 ARRAY 的元素类型回落 `of` 属性)。
        let directive = if text_directive.is_empty() {
            e.attributes
                .iter()
                .find(|a| a.name == "type")
                .map(|a| a.value.trim().to_string())
                .unwrap_or_default()
        } else {
            text_directive
        };
        let kind = match directive.as_str() {
            "FIXED_DICT" => TypeKind::FixedDict,
            "ARRAY" => TypeKind::Array,
            "" => continue, // 空条目(纯注释位)不产出,与 TS 一致
            _ => TypeKind::Builtin,
        };
        let (implemented_by_symbol, field_refs, element_ref) = match kind {
            TypeKind::FixedDict => {
                let symbol = doc
                    .scalar_child_value(child, "implementedBy")
                    .map(|full| {
                        full.trim()
                            .rsplit('.')
                            .next()
                            .unwrap_or("")
                            .trim()
                            .to_string()
                    })
                    .filter(|s| !s.is_empty());
                let mut field_refs = Vec::new();
                if let Some(props) = doc.child_element(child, "Properties") {
                    for prop in doc.child_elements(props) {
                        if let Some(t) = doc.child_element(prop, "Type") {
                            field_refs.extend(collect_type_refs(doc, t));
                        }
                    }
                }
                (symbol, field_refs, None)
            }
            TypeKind::Array => {
                let element_ref = doc
                    .child_element(child, "of")
                    .map(|of| doc.element(of).text(doc).trim().to_string())
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        // 属性式:`<X type="ARRAY" of="UINT32"/>` 的元素类型。
                        e.attributes
                            .iter()
                            .find(|a| a.name == "of")
                            .map(|a| a.value.trim().to_string())
                            .filter(|s| !s.is_empty())
                    });
                (None, Vec::new(), element_ref)
            }
            TypeKind::Builtin => (None, Vec::new(), None),
        };
        out.types.push(TypeDecl {
            name: e.name.clone(),
            name_span: e.name_span,
            line: lines.line_of(e.name_span.start),
            kind,
            directive: if directive.is_empty() {
                None
            } else {
                Some(directive)
            },
            implemented_by_symbol,
            field_refs,
            element_ref,
        });
    }
    out
}

// ---------------------------------------------------------------------------
// alias.xml
// ---------------------------------------------------------------------------

/// 别名关联(与 TS buildAliasXmlCustomTypeInfo 同口径的提取结果)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AliasDecl {
    pub name: String,
    pub name_span: Span,
    pub line: usize,
    /// 别名指向:Type 子元素首个非空文本 / 首个非 Type 子元素标签名 /
    /// 自身首个非空文本;全无则不产出条目。
    pub alias_type: String,
}

/// alias.xml 关联表。
#[derive(Debug, Clone, Default)]
pub struct AliasFile {
    pub aliases: Vec<AliasDecl>,
    /// 属性式别名(`<Foo type="ARRAY" of="UINT32"/>`;TS 现实现会跳过,Rust
    /// 结构化保留,不进对拍 golden)。
    pub attribute_aliases: Vec<(String, Vec<(String, String)>)>,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn parse_alias(text: &str) -> AliasFile {
    let document = crate::xml::parse(text, false);
    let doc = &document;
    let lines = LineMap::new(text);
    let mut out = AliasFile {
        aliases: Vec::new(),
        attribute_aliases: Vec::new(),
        diagnostics: doc.diagnostics.clone(),
    };
    let root = match doc.root() {
        Some(r) => r,
        None => return out,
    };
    for child in doc.child_elements(root) {
        let e = doc.element(child);
        let type_child = doc.child_element(child, "Type");
        let other_child = doc
            .child_elements(child)
            .into_iter()
            .find(|&c| doc.element(c).name != "Type");
        let direct_text_non_empty = direct_text_token(doc, child);
        match (type_child, other_child, direct_text_non_empty) {
            (None, None, None) => {
                // TS 同口径:无子元素且无非空文本 → 跳过;属性式结构化保留。
                if !e.attributes.is_empty() {
                    out.attribute_aliases.push((
                        e.name.clone(),
                        e.attributes
                            .iter()
                            .map(|a| (a.name.clone(), a.value.clone()))
                            .collect(),
                    ));
                }
            }
            (tc, oc, dt) => {
                let alias_type = match (tc, oc, dt) {
                    (Some(t), _, _) => doc
                        .element(t)
                        .text(doc)
                        .split_whitespace()
                        .next()
                        .map(str::to_string)
                        .unwrap_or_else(|| "ALIAS".to_string()),
                    (None, Some(c), _) => doc.element(c).name.clone(),
                    (None, None, Some(text)) => text,
                    (None, None, None) => "ALIAS".to_string(),
                };
                out.aliases.push(AliasDecl {
                    name: e.name.clone(),
                    name_span: e.name_span,
                    line: lines.line_of(e.name_span.start),
                    alias_type,
                });
            }
        }
    }
    out
}

/// 首个非空 trim 文本 token(直接文本子节点)。
fn direct_text_token(doc: &Document, idx: usize) -> Option<String> {
    doc.element(idx)
        .text(doc)
        .split_whitespace()
        .next()
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// 继承/组件树(SEM-007/SEM-008 基础版)
// ---------------------------------------------------------------------------

/// 实体继承链中的一个节点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainNode {
    pub entity: String,
    pub parent: Option<String>,
}

/// 实体继承链解析:`parents` 为实体名 → .def 提取的 Parent 声明。
/// 返回 (从该实体到根的链, 环诊断)。环时截断在重复点并给精确诊断,
/// 绝不死循环(SEM-004/IDX-005 同类保障)。
pub fn resolve_parent_chain(
    entity: &str,
    parents: &std::collections::HashMap<String, String>,
) -> (Vec<ChainNode>, Option<Diagnostic>) {
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut current = Some(entity.to_string());
    let mut cycle = None;
    while let Some(name) = current {
        if !seen.insert(name.clone()) {
            cycle = Some(Diagnostic::new(
                crate::diag::DiagCode::InheritanceCycle,
                crate::diag::Severity::Error,
                Span::new(0, 0),
                format!("实体继承链存在环:{name}"),
            ));
            break;
        }
        let parent = parents.get(&name).cloned();
        chain.push(ChainNode {
            entity: name.clone(),
            parent: parent.clone(),
        });
        current = parent;
    }
    (chain, cycle)
}

/// 组件树:实体 → 组件类型列表(浅层;组件 def 的再嵌套由调用方递归)。
pub fn component_types(def: &DefFile) -> Vec<String> {
    def.components
        .iter()
        .filter_map(|c| c.component_type.clone())
        .collect()
}
