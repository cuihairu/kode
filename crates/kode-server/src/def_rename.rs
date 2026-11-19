//! RUST-141 批 1:def 重命名纯核——src/backend/defRenamer.ts 同构下沉。
//!
//! 四个纯面(生产 TS 面逐点同构,零 vscode/EntityMappingManager 依赖):
//! - `resolve_rename_symbol_at_offset`:光标处可重命名符号(顶层 Properties
//!   属性 / 三方法段方法;光标词须落在符号元素开/闭标签名字区间内);
//! - `find_def_rename_conflict`:同文件目标名冲突(NAV-008 窄面:方法只查
//!   本段,属性与组件互斥);
//! - `compute_def_rename_edits`:全工作区可编辑范围分析——目标文件同名符号
//!   与后代 def(含接口混入)的同名复述,传播边对齐引擎装载路径
//!   (entitydef.cpp:Parent/接口 wrapper 首子节点取名,interfaces 不读
//!   Parent,悬空引用不产生边);
//! - `find_def_rename_conflict_in_closure`:祖先/后代闭包同成员命名面占名
//!   预检(AUD-061,判重矩阵对齐 ScriptDefModule:组件槽无条件/方法同段/
//!   属性域位相交)。
//!
//! 坐标系:全部公开偏移 = **UTF-16 单元**(TS 字符串同坐标系)。解析器
//! (kode-parser::xml)span 是字节偏移,经 `Utf16Map` 换算;标识符/标签名
//! 全 ASCII,词匹配无跨系歧义。语料含 CJK 注释时两系偏移不同,故 golden
//! 全量存 UTF-16 偏移,TS 镜像(tests/kodeDefRenameParity.test.ts)直接
//! import 生产 defRenamer 函数复算同一 golden 对拍。
//!
//! 批 1 边界(同 references/document_symbols/python-call-at 口径):
//! server.rs/rpc.rs 并发在途,`textDocument/rename`/`prepareRename` LSP
//! 接线与 python self 访问改写面(EntityMappingManager,NAV-011/012)、
//! 输入版本漂移面(renameInputsDrifted)留批 2,生产服务面仍是 TS。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use kode_parser::diag::Span;
use kode_parser::model::{flag_domains, normalize_flag_tokens};
use kode_parser::xml::{self, Document as XmlDoc, NodeData};

/// def 属性/方法名的合法形态(TS DEF_IDENTIFIER_PATTERN 同构;实体名首字母
/// 大写约束不适用于成员)。
pub fn is_def_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// TS DEF_METHOD_SECTIONS 同构。
pub const DEF_METHOD_SECTIONS: &[&str] = &["BaseMethods", "CellMethods", "ClientMethods"];

/// TS INTERFACE_WRAPPER_NAMES 同构:引擎在 `<Interfaces>` 下只认这四种
/// wrapper 拼写(entitydef.cpp:563-566,大小写敏感);以接口名直接命名的
/// 子元素引擎不装载,这里同样不跟随。
pub const INTERFACE_WRAPPER_NAMES: &[&str] = &["interface", "Interface", "type", "Type"];

// ---------------------------------------------------------------------------
// UTF-16 坐标映射(字节 span → TS 字符串偏移)
// ---------------------------------------------------------------------------

struct Utf16Map {
    starts: Vec<usize>,
    utf16: Vec<usize>,
}

impl Utf16Map {
    fn new(text: &str) -> Self {
        let cap = text.chars().count() + 1;
        let mut starts = Vec::with_capacity(cap);
        let mut utf16 = Vec::with_capacity(cap);
        let mut units = 0usize;
        for (byte, ch) in text.char_indices() {
            starts.push(byte);
            utf16.push(units);
            units += ch.len_utf16();
        }
        starts.push(text.len());
        utf16.push(units);
        Self { starts, utf16 }
    }

    /// 字节偏移 → UTF-16 偏移;落在多字节字符内部时钳到该字符起点
    /// (解析器 span 恒在字符边界,此臂纯防御)。
    fn to_u16(&self, byte: usize) -> usize {
        match self.starts.binary_search(&byte) {
            Ok(i) => self.utf16[i],
            Err(i) => self.utf16[i.saturating_sub(1)],
        }
    }
}

fn utf16_offset_to_line(units: &[u16], offset: usize) -> usize {
    // TS offsetToLine = text.slice(0, offset).split('\n').length(1 基)。
    let clamped = offset.min(units.len());
    units[..clamped].iter().filter(|&&c| c == 0x0A).count() + 1
}

// ---------------------------------------------------------------------------
// 面
// ---------------------------------------------------------------------------

/// 可重命名符号(TS DefRenameSymbol 同形)。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefRenameSymbol {
    /// "property" | "method"
    pub kind: &'static str,
    pub name: String,
    /// 方法所属段;属性为 None。
    pub section: Option<&'static str>,
    /// 光标所在名字区间(UTF-16 偏移,含端不含尾),供 prepareRename。
    pub word_start: usize,
    pub word_end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DefRenameEditRange {
    pub start: usize,
    pub end: usize,
}

/// 重命名目标名冲突(TS DefRenameConflict 同形;file_path 仅闭包冲突携带)。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefRenameConflict {
    /// 冲突面:同段方法(段名)/ Properties / Components。
    pub surface: String,
    pub name: String,
    /// 冲突声明行(1 基)。
    pub line: usize,
    pub file_path: Option<String>,
}

/// 一份文件的编辑计算结果(TS DefRenameFileEdits 同形;edits 升序,区间为
/// UTF-16 偏移,相对该文件自身文本)。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefRenameFileEdits {
    pub file_path: PathBuf,
    pub edits: Vec<DefRenameEditRange>,
    /// edits 的计算基准文本(消费方据此换算行列;golden 不序列化)。
    #[serde(skip_serializing)]
    pub text: String,
}

// ---------------------------------------------------------------------------
// 符号解析(resolveRenameSymbolAtOffset 同构)
// ---------------------------------------------------------------------------

fn is_word_unit(c: u16) -> bool {
    matches!(c, 0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A | 0x5F)
}

fn is_identifier_unit(c: u16) -> bool {
    is_word_unit(c)
}

/// TS \s 的 ASCII 面(语料 ASCII;CJK 注释不进标签文本)。
fn is_ts_space(c: u16) -> bool {
    matches!(c, 0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20)
}

/// TS findIdentifierAtOffset 同构(含「紧贴词尾右侧一格」容差)。
fn find_identifier_at_offset(units: &[u16], offset: usize) -> Option<(usize, usize)> {
    if units.is_empty() {
        return None;
    }
    let mut start = offset;
    if start >= units.len() || !is_identifier_unit(units[start]) {
        if start > 0 && is_identifier_unit(units[start - 1]) {
            start -= 1;
        } else {
            return None;
        }
    }
    while start > 0 && is_identifier_unit(units[start - 1]) {
        start -= 1;
    }
    let mut end = start + 1;
    while end < units.len() && is_identifier_unit(units[end]) {
        end += 1;
    }
    Some((start, end))
}

fn contains_range(outer: (usize, usize), inner: (usize, usize)) -> bool {
    inner.0 >= outer.0 && inner.1 <= outer.1
}

/// 元素标签内名字的精确区间(TS getTagNameRange 同构:tokenizer 允许
/// `< hp>`/`</ hp>` 空白形态,不能盲取名 span,须在标签文本上重匹配;
/// TS 正则 `^<\s*/?\s*name\b` 的手写等价,全在 UTF-16 单元上)。自闭合的
/// close span 为空区间,天然排除。
fn get_tag_name_range(
    doc: &XmlDoc,
    units: &[u16],
    map: &Utf16Map,
    idx: usize,
    part: TagPart,
) -> Option<(usize, usize)> {
    let el = doc.element(idx);
    let span: Span = match part {
        TagPart::Open => el.open_span,
        TagPart::Close => el.close_span,
    };
    if span.end <= span.start {
        return None;
    }
    let tag_start = map.to_u16(span.start);
    let tag_end = map.to_u16(span.end);
    let mut i = tag_start;
    if units.get(i).copied() != Some(u16::from(b'<')) {
        return None;
    }
    i += 1;
    while i < tag_end && is_ts_space(units[i]) {
        i += 1;
    }
    if i < tag_end && units[i] == u16::from(b'/') {
        i += 1;
        while i < tag_end && is_ts_space(units[i]) {
            i += 1;
        }
    }
    let name_units: Vec<u16> = el.name.encode_utf16().collect();
    if i + name_units.len() > tag_end || units[i..i + name_units.len()] != name_units[..] {
        return None;
    }
    let after = i + name_units.len();
    // \b:名字后邻非词字符(或到标签切片尾)。
    if after < tag_end && is_word_unit(units[after]) {
        return None;
    }
    Some((i, after))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TagPart {
    Open,
    Close,
}

fn method_section_of(name: &str) -> Option<&'static str> {
    DEF_METHOD_SECTIONS.iter().copied().find(|s| *s == name)
}

/// 解析偏移处的可重命名符号(TS resolveRenameSymbolAtOffset 同构)。要求
/// 光标词落在符号元素(顶层 Properties/方法段直接子元素)的开/闭标签名字
/// 区间内;否则 None。
pub fn resolve_rename_symbol_at_offset(text: &str, offset: usize) -> Option<DefRenameSymbol> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let map = Utf16Map::new(text);
    let word = find_identifier_at_offset(&units, offset)?;
    let doc = xml::parse(text, true);
    let root = doc.root()?;
    let word_str = String::from_utf16_lossy(&units[word.0..word.1]);

    for section in doc.child_elements(root) {
        let section_el = doc.element(section);
        let is_property_section = section_el.name == "Properties";
        let is_method_section = method_section_of(&section_el.name).is_some();
        if !is_property_section && !is_method_section {
            continue;
        }
        for child in doc.child_elements(section) {
            if doc.element(child).name != word_str {
                continue;
            }
            for part in [TagPart::Open, TagPart::Close] {
                let Some(name_range) = get_tag_name_range(&doc, &units, &map, child, part) else {
                    continue;
                };
                if contains_range(name_range, word) {
                    return Some(DefRenameSymbol {
                        kind: if is_property_section { "property" } else { "method" },
                        name: word_str.clone(),
                        section: if is_property_section {
                            None
                        } else {
                            method_section_of(&section_el.name)
                        },
                        word_start: name_range.0,
                        word_end: name_range.1,
                    });
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 同文件冲突(NAV-008 窄面)
// ---------------------------------------------------------------------------

/// TS findDefRenameConflict 同构。方法重名只查本段(跨段同名合法);属性
/// 与组件同属实体成员命名面,任一占名即冲突。名字非法/改名即本名 → None。
pub fn find_def_rename_conflict(
    text: &str,
    symbol: &DefRenameSymbol,
    new_name: &str,
) -> Option<DefRenameConflict> {
    if !is_def_identifier(new_name) || new_name == symbol.name {
        return None;
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let map = Utf16Map::new(text);
    let doc = xml::parse(text, true);
    let root = doc.root()?;

    if symbol.kind == "method" {
        for section in doc.child_elements(root) {
            let section_name = doc.element(section).name.clone();
            if Some(section_name.as_str()) != symbol.section {
                continue;
            }
            for child in doc.child_elements(section) {
                let el = doc.element(child);
                if el.name == new_name {
                    return Some(DefRenameConflict {
                        surface: section_name.clone(),
                        name: new_name.to_string(),
                        line: utf16_offset_to_line(&units, map.to_u16(el.open_span.start)),
                        file_path: None,
                    });
                }
            }
        }
        return None;
    }

    for section in doc.child_elements(root) {
        let section_name = doc.element(section).name.clone();
        if section_name != "Properties" && section_name != "Components" {
            continue;
        }
        for child in doc.child_elements(section) {
            let el = doc.element(child);
            if el.name == new_name {
                return Some(DefRenameConflict {
                    surface: section_name.clone(),
                    name: new_name.to_string(),
                    line: utf16_offset_to_line(&units, map.to_u16(el.open_span.start)),
                    file_path: None,
                });
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 成员声明面(闭包判重)
// ---------------------------------------------------------------------------

/// 一份 def 文本里顶层直接子元素的可重命名成员声明(引擎把父类/接口/组件
/// 描述装进同一 ScriptDefModule 判重,这里按同一命名面取成员)。
#[derive(Debug, Clone, PartialEq, Eq)]
struct RenameMemberDecl {
    kind: &'static str,
    name: String,
    section: Option<&'static str>,
    domains: BTreeSet<String>,
    line: usize,
}

/// Flags 文本 → 域位集(TS flagDomainsOfNode 同口径:首文本子节点按 '|'
/// 切分,normalize 后逐 token 取域位并集)。
fn flag_domains_of_element(doc: &XmlDoc, idx: usize) -> BTreeSet<String> {
    let Some(flags_idx) = doc.child_element(idx, "Flags") else {
        return BTreeSet::new();
    };
    let flags_text = doc
        .element(flags_idx)
        .children
        .iter()
        .find_map(|&c| match &doc.nodes[c].data {
            NodeData::Text { decoded, .. } => Some(decoded.clone()),
            _ => None,
        });
    let flags_raw = flags_text.unwrap_or_default();
    let tokens: Vec<&str> = flags_raw
        .split('|')
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect();
    let mut domains = BTreeSet::new();
    for token in normalize_flag_tokens(&tokens.join("|")) {
        for domain in flag_domains(std::slice::from_ref(&token)) {
            domains.insert(domain.to_string());
        }
    }
    domains
}

fn collect_own_member_decls(doc: &XmlDoc, units: &[u16], map: &Utf16Map, root: usize) -> Vec<RenameMemberDecl> {
    let mut decls = Vec::new();
    for section in doc.child_elements(root) {
        let section_name = doc.element(section).name.clone();
        if section_name == "Properties" || section_name == "Components" {
            for child in doc.child_elements(section) {
                let el = doc.element(child);
                decls.push(RenameMemberDecl {
                    kind: if section_name == "Properties" {
                        "property"
                    } else {
                        "component"
                    },
                    name: el.name.clone(),
                    section: None,
                    domains: flag_domains_of_element(doc, child),
                    line: utf16_offset_to_line(units, map.to_u16(el.open_span.start)),
                });
            }
        } else if let Some(section_str) = method_section_of(&section_name) {
            for child in doc.child_elements(section) {
                let el = doc.element(child);
                decls.push(RenameMemberDecl {
                    kind: "method",
                    name: el.name.clone(),
                    section: Some(section_str),
                    domains: BTreeSet::new(),
                    line: utf16_offset_to_line(units, map.to_u16(el.open_span.start)),
                });
            }
        }
    }
    decls
}

/// 引擎判重矩阵(defAnalyzer 同语义,scriptdef_module.cpp):
/// - 组件槽经 addComponentProperty 走 addPropertyDescription,与任何同名
///   声明无条件冲突;
/// - 方法 vs 方法仅同段冲突(段即命名空间);
/// - 方法 vs 属性/组件:全局拒绝,无条件冲突;
/// - 属性 vs 属性/组件:按域查找,域位相交才冲突。
fn member_conflicts(own: &RenameMemberDecl, inherited: &RenameMemberDecl) -> bool {
    if own.kind == "component" || inherited.kind == "component" {
        return true;
    }
    if own.kind == "method" && inherited.kind == "method" {
        return own.section == inherited.section;
    }
    if own.kind != inherited.kind {
        return true;
    }
    own.domains.iter().any(|d| inherited.domains.contains(d))
}

/// 目标符号改名后的新声明面(用于与闭包文件判重)。
fn resolve_target_rename_decl(
    doc: &XmlDoc,
    root: usize,
    symbol: &DefRenameSymbol,
) -> Option<RenameMemberDecl> {
    if symbol.kind == "method" {
        return Some(RenameMemberDecl {
            kind: "method",
            name: symbol.name.clone(),
            section: symbol.section,
            domains: BTreeSet::new(),
            line: 0,
        });
    }
    for section in doc.child_elements(root) {
        if doc.element(section).name != "Properties" {
            continue;
        }
        for child in doc.child_elements(section) {
            let el = doc.element(child);
            if el.name == symbol.name {
                return Some(RenameMemberDecl {
                    kind: "property",
                    name: symbol.name.clone(),
                    section: None,
                    domains: flag_domains_of_element(doc, child),
                    line: 0,
                });
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 引擎取名语义 + def 语义面
// ---------------------------------------------------------------------------

/// 引擎取名语义(entitydef.cpp 对 `<Parent>`/接口 wrapper 取**首个子节点**,
/// tinyxml getKey:文本取文本、元素取标签名;纯空白文本节点按引擎
/// condenseWhiteSpace 口径跳过;混合内容只认首个非空白子节点,文本优先)。
pub fn get_reference_target_name(doc: &XmlDoc, idx: usize) -> String {
    for &child in &doc.element(idx).children {
        match &doc.nodes[child].data {
            NodeData::Text { decoded, .. } => {
                let text = decoded.trim();
                if !text.is_empty() {
                    return text.to_string();
                }
            }
            NodeData::Element(_) => return doc.element(child).name.trim().to_string(),
            _ => {}
        }
    }
    String::new()
}

/// def 文件的直接语义面:Parent 名 + Interfaces 引用名(对齐引擎装载语法;
/// rename 闭包只消费这两面,组件槽 Type 面属方法实现候选链,不在本核)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefFileSemantics {
    pub parent_name: Option<String>,
    pub interface_names: Vec<String>,
}

pub fn parse_def_file_semantics(content: &str) -> Option<DefFileSemantics> {
    let doc = xml::parse(content, true);
    let root = doc.root()?;
    let parent_name = doc
        .child_element(root, "Parent")
        .map(|idx| get_reference_target_name(&doc, idx))
        .filter(|n| !n.is_empty());
    let mut interface_names = Vec::new();
    for section in doc.child_elements(root) {
        if doc.element(section).name != "Interfaces" {
            continue;
        }
        for reference in doc.child_elements(section) {
            if !INTERFACE_WRAPPER_NAMES.contains(&doc.element(reference).name.as_str()) {
                continue;
            }
            // 自闭合/空 wrapper 得空名,等价悬空引用,跳过。
            let name = get_reference_target_name(&doc, reference);
            if !name.is_empty() {
                interface_names.push(name);
            }
        }
    }
    Some(DefFileSemantics {
        parent_name,
        interface_names,
    })
}

// ---------------------------------------------------------------------------
// 工作区走查(定义根定位 / 文件枚举 / owner 闭包)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DefOwnerCategory {
    Entity,
    Interface,
    Component,
}

#[derive(Debug, Clone)]
struct DefFileEntry {
    file_path: PathBuf,
    category: DefOwnerCategory,
    #[allow(dead_code)]
    name: String,
}

fn is_path_inside(base_dir: &Path, target: &Path) -> bool {
    target.strip_prefix(base_dir).is_ok()
}

/// 从目标文件向上推导 entity_defs 定义根(TS findEntityDefsRootFromFile
/// 同构:命中含 entities.xml 的目录后须确认目标文件确实位于其 entity_defs
/// 子树下,否则取该目录本身;找不到 entities.xml 返回 None)。
pub fn find_entity_defs_root_from_file(file_path: &Path) -> Option<PathBuf> {
    let resolved = std::fs::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
    let mut dir = resolved.parent()?.to_path_buf();
    loop {
        if dir.join("entities.xml").exists() {
            let defs_root = dir.join("entity_defs");
            if is_path_inside(&defs_root, &resolved) {
                return Some(defs_root);
            }
            return Some(dir);
        }
        let parent = dir.parent()?;
        if parent == dir {
            return None;
        }
        dir = parent.to_path_buf();
    }
}

/// 调用方约定 file_path 在 defs_root 内(根由目标文件自身向上推导/枚举构造)。
fn classify_def_file(defs_root: &Path, file_path: &Path) -> DefFileEntry {
    let resolved = std::fs::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
    let base = std::fs::canonicalize(defs_root).unwrap_or_else(|_| defs_root.to_path_buf());
    let mut category = DefOwnerCategory::Entity;
    if let Ok(relative) = resolved.strip_prefix(&base) {
        for component in relative.components() {
            let seg = component.as_os_str().to_string_lossy();
            if seg == "interfaces" {
                category = DefOwnerCategory::Interface;
            } else if seg == "components" {
                category = DefOwnerCategory::Component;
            }
        }
    }
    DefFileEntry {
        name: resolved
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        file_path: resolved,
        category,
    }
}

fn list_def_files_recursive(defs_root: &Path) -> Vec<DefFileEntry> {
    let mut entries = Vec::new();
    fn walk(dir: &Path, defs_root: &Path, out: &mut Vec<DefFileEntry>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut paths: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        paths.sort();
        for path in paths {
            if path.is_dir() {
                walk(&path, defs_root, out);
            } else if path.is_file()
                && path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase().ends_with(".def"))
                    .unwrap_or(false)
            {
                out.push(classify_def_file(defs_root, &path));
            }
        }
    }
    walk(defs_root, defs_root, &mut entries);
    entries.sort_by(|a, b| a.file_path.cmp(&b.file_path));
    entries
}

struct DefLinkPaths {
    parent_path: Option<PathBuf>,
    interface_paths: Vec<PathBuf>,
}

/// 引擎的边解析面(entitydef.cpp):实体 Parent 平铺在定义根;接口固定在
/// interfaces/ 子目录;组件 def 的 Parent 在 components/ 内解析。接口文件
/// 装载时不读 Parent(loadInterfaces 不走 loadParentClass)——不产生边。
fn resolve_link_paths(defs_root: &Path, entry: &DefFileEntry, semantics: &DefFileSemantics) -> DefLinkPaths {
    let interface_paths = semantics
        .interface_names
        .iter()
        .map(|name| defs_root.join("interfaces").join(format!("{name}.def")))
        .collect();
    let mut parent_path = None;
    if let Some(parent_name) = &semantics.parent_name {
        if entry.category != DefOwnerCategory::Interface {
            let parent_dir = if entry.category == DefOwnerCategory::Component {
                defs_root.join("components")
            } else {
                defs_root.to_path_buf()
            };
            parent_path = Some(parent_dir.join(format!("{parent_name}.def")));
        }
    }
    DefLinkPaths {
        parent_path,
        interface_paths,
    }
}

/// 文件 owner 的祖先闭包(Parent 链 + Interfaces 混入,传递)——按引擎装载
/// 路径精确解析,悬空引用不产生边。
fn collect_owner_closure(
    entry: &DefFileEntry,
    defs_root: &Path,
    file_index: &BTreeMap<PathBuf, DefFileEntry>,
    read_content: &dyn Fn(&Path) -> Option<String>,
) -> BTreeSet<PathBuf> {
    let mut closure = BTreeSet::new();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    seen.insert(entry.file_path.clone());
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(entry.clone());
    while let Some(current) = queue.pop_front() {
        let Some(content) = read_content(&current.file_path) else {
            continue;
        };
        let Some(semantics) = parse_def_file_semantics(&content) else {
            continue;
        };
        let links = resolve_link_paths(defs_root, &current, &semantics);
        for target_path in links
            .parent_path
            .into_iter()
            .chain(links.interface_paths)
        {
            let Some(target_entry) = file_index.get(&target_path) else {
                continue;
            };
            closure.insert(target_entry.file_path.clone());
            if !seen.contains(&target_entry.file_path) {
                seen.insert(target_entry.file_path.clone());
                queue.push_back(target_entry.clone());
            }
        }
    }
    closure
}

// ---------------------------------------------------------------------------
// 编辑区间收集 + 全工作区编辑计算
// ---------------------------------------------------------------------------

/// 收集一份 def 文本里符号的全部名字区间(开标签 + 非自闭合的闭标签)。
pub fn collect_rename_edits_in_text(text: &str, symbol: &DefRenameSymbol) -> Vec<DefRenameEditRange> {
    let doc = xml::parse(text, true);
    let Some(root) = doc.root() else {
        return Vec::new();
    };
    let units: Vec<u16> = text.encode_utf16().collect();
    let map = Utf16Map::new(text);
    let mut ranges = Vec::new();
    for section in doc.child_elements(root) {
        let section_name = doc.element(section).name.as_str();
        let section_matches = if symbol.kind == "method" {
            Some(section_name) == symbol.section
        } else {
            section_name == "Properties"
        };
        if !section_matches {
            continue;
        }
        for child in doc.child_elements(section) {
            if doc.element(child).name != symbol.name {
                continue;
            }
            if let Some(open) = get_tag_name_range(&doc, &units, &map, child, TagPart::Open) {
                ranges.push(DefRenameEditRange {
                    start: open.0,
                    end: open.1,
                });
            }
            if let Some(close) = get_tag_name_range(&doc, &units, &map, child, TagPart::Close) {
                ranges.push(DefRenameEditRange {
                    start: close.0,
                    end: close.1,
                });
            }
        }
    }
    ranges.sort_by_key(|r| r.start);
    ranges
}

type CrossFileReader<'a> = &'a dyn Fn(&Path) -> Option<String>;

/// 计算重命名的全部编辑(TS computeDefRenameEdits 同构):目标文件的同名
/// 符号 + 后代 def(闭包含目标)里的同名复述。新名非法/与原名相同、无法
/// 解析目标文件时返回空数组。
pub fn compute_def_rename_edits(
    target_file_path: &Path,
    target_text: &str,
    symbol: &DefRenameSymbol,
    new_name: &str,
    read_cross_file_content: CrossFileReader,
) -> Vec<DefRenameFileEdits> {
    if !is_def_identifier(new_name) || new_name == symbol.name {
        return Vec::new();
    }
    let resolved_target = std::fs::canonicalize(target_file_path)
        .unwrap_or_else(|_| target_file_path.to_path_buf());
    let target_edits = collect_rename_edits_in_text(target_text, symbol);
    let mut results: Vec<DefRenameFileEdits> = if target_edits.is_empty() {
        return Vec::new();
    } else {
        vec![DefRenameFileEdits {
            file_path: resolved_target.clone(),
            edits: target_edits,
            text: target_text.to_string(),
        }]
    };

    let Some(defs_root) = find_entity_defs_root_from_file(&resolved_target) else {
        return results;
    };

    let files = list_def_files_recursive(&defs_root);
    let mut file_index = BTreeMap::new();
    for entry in files {
        file_index.insert(entry.file_path.clone(), entry);
    }

    for entry in file_index.values() {
        if entry.file_path == resolved_target {
            continue;
        }
        let Some(content) = read_cross_file_content(&entry.file_path) else {
            continue;
        };
        let closure = collect_owner_closure(entry, &defs_root, &file_index, read_cross_file_content);
        if !closure.contains(&resolved_target) {
            continue;
        }
        let edits = collect_rename_edits_in_text(&content, symbol);
        if !edits.is_empty() {
            results.push(DefRenameFileEdits {
                file_path: entry.file_path.clone(),
                edits,
                text: content,
            });
        }
    }

    results.sort_by(|a, b| a.file_path.cmp(&b.file_path));
    results
}

// ---------------------------------------------------------------------------
// 闭包冲突预检(AUD-061)
// ---------------------------------------------------------------------------

/// TS findDefRenameConflictInClosure 同构。在 NAV-008 的声明文件检查之外,
/// 同时检查目标 owner 的祖先闭包(Parent 链 + Interfaces 混入)与全部后代
/// (其祖先闭包含目标)是否已按引擎全局判重占用 newName;占用即返回冲突位
/// (面 + 1 基行号 + 文件路径)。找不到定义根、目标无法解析、名字非法/
/// 改名即本名 → None。
pub fn find_def_rename_conflict_in_closure(
    target_file_path: &Path,
    target_text: &str,
    symbol: &DefRenameSymbol,
    new_name: &str,
    read_cross_file_content: CrossFileReader,
) -> Option<DefRenameConflict> {
    if !is_def_identifier(new_name) || new_name == symbol.name {
        return None;
    }
    let resolved_target = std::fs::canonicalize(target_file_path)
        .unwrap_or_else(|_| target_file_path.to_path_buf());
    let defs_root = find_entity_defs_root_from_file(&resolved_target)?;
    let target_doc = xml::parse(target_text, true);
    let target_root = target_doc.root()?;
    let target_decl = resolve_target_rename_decl(&target_doc, target_root, symbol)?;

    let files = list_def_files_recursive(&defs_root);
    let mut file_index = BTreeMap::new();
    for entry in files {
        file_index.insert(entry.file_path.clone(), entry);
    }

    let target_entry = classify_def_file(&defs_root, &resolved_target);
    let ancestor_closure =
        collect_owner_closure(&target_entry, &defs_root, &file_index, read_cross_file_content);

    for entry in file_index.values() {
        if entry.file_path == resolved_target {
            continue;
        }
        let Some(content) = read_cross_file_content(&entry.file_path) else {
            continue;
        };
        let is_ancestor = ancestor_closure.contains(&entry.file_path);
        let is_descendant = collect_owner_closure(entry, &defs_root, &file_index, read_cross_file_content)
            .contains(&resolved_target);
        if !is_ancestor && !is_descendant {
            continue;
        }
        let doc = xml::parse(&content, true);
        let Some(root) = doc.root() else {
            continue;
        };
        let units: Vec<u16> = content.encode_utf16().collect();
        let map = Utf16Map::new(&content);
        for decl in collect_own_member_decls(&doc, &units, &map, root) {
            if decl.name != new_name {
                continue;
            }
            if member_conflicts(&decl, &target_decl) {
                return Some(DefRenameConflict {
                    surface: decl.section
                        .map(str::to_string)
                        .unwrap_or_else(|| {
                            if decl.kind == "property" {
                                "Properties".to_string()
                            } else {
                                "Components".to_string()
                            }
                        }),
                    name: new_name.to_string(),
                    line: decl.line,
                    file_path: Some(entry.file_path.to_string_lossy().into_owned()),
                });
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// golden(vitest 直接 import 生产 defRenamer 函数复算对拍)
// ---------------------------------------------------------------------------

pub const DEF_RENAME_GOLDEN_REL_PATH: &str =
    "crates/kode-server/tests/golden/def-rename-parity.json";

/// 闭包冲突探测名:合法标识符且不出现在任何语料文件中——走完整工作区走查
/// 而恒 null,钉「无冲突路径」;冲突路径由既有成员名候选驱动。
const PROBE_NEW_NAME: &str = "zzRenameProbeNew";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenHit {
    offset: usize,
    kind: &'static str,
    section: Option<&'static str>,
    name: String,
    word_start: usize,
    word_end: usize,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenCheck {
    new_name: String,
    conflict: Option<GoldenConflict>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenConflict {
    surface: String,
    name: String,
    line: usize,
    file_path: Option<String>,
}

#[derive(Debug, serde::Serialize)]
struct GoldenEditFile {
    file: String,
    ranges: Vec<(usize, usize)>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenAnalysis {
    kind: &'static str,
    section: Option<&'static str>,
    name: String,
    conflict_checks: Vec<GoldenCheck>,
    edits: Vec<GoldenEditFile>,
    closure_checks: Vec<GoldenCheck>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFileEntry {
    file: String,
    probe_count: usize,
    symbol_hits: Vec<GoldenHit>,
    analyses: Vec<GoldenAnalysis>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenWorkspace {
    root: Option<String>,
    files: Vec<GoldenFileEntry>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    workspace_count: usize,
    def_file_count: usize,
    symbol_hit_count: usize,
    analysis_count: usize,
    closure_check_count: usize,
    workspaces: Vec<GoldenWorkspace>,
}

fn to_repo_rel(repo_root: &Path, path: &Path) -> String {
    path.strip_prefix(repo_root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// .def 语料收集(PARITY_CORPORA 同根,只收 .def,BTreeMap 字典序确定性)。
fn collect_def_corpus(repo_root: &Path) -> BTreeMap<String, String> {
    fn walk(dir: &Path, rel_prefix: &str, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        entries.sort();
        for path in entries {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let rel = format!("{rel_prefix}/{name}");
            if path.is_dir() {
                walk(&path, &rel, out);
                continue;
            }
            if name.to_lowercase().ends_with(".def") {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    out.insert(rel, text);
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    for corpus in kode_parser::json::PARITY_CORPORA {
        walk(&repo_root.join(corpus), corpus, &mut out);
    }
    out
}

/// 一份 def 文本的顶层成员名(Properties/Components/三方法段直接子元素)。
fn member_names_of(text: &str) -> BTreeSet<String> {
    let doc = xml::parse(text, true);
    let Some(root) = doc.root() else {
        return BTreeSet::new();
    };
    let mut names = BTreeSet::new();
    for section in doc.child_elements(root) {
        let section_name = doc.element(section).name.clone();
        let is_member_section = section_name == "Properties"
            || section_name == "Components"
            || method_section_of(&section_name).is_some();
        if !is_member_section {
            continue;
        }
        for child in doc.child_elements(section) {
            names.insert(doc.element(child).name.clone());
        }
    }
    names
}

/// 遍历 .def 语料:逐文件逐偏移探测符号解析(非空命中入 golden),对每个
/// 可解析符号跑同文件冲突 × 同文件成员名候选、全工作区编辑计算、闭包冲突
/// ×「在他文件声明过的成员名」候选(只在他目标文件声明的名字对闭包检查
/// 恒 null——生产只查非目标文件,不出现即恒 null,故候选宇宙取「在他文件
/// 声明过的名字 ∪ 探测名」,both 侧同规则;纯走查 null 路径由探测名钉)。
pub fn dump_def_rename_golden(repo_root: &Path) -> String {
    // to_repo_rel 以 canonical 根剥前缀;相对路径输入(如 ".")先归一。
    let repo_root = &repo_root.canonicalize().unwrap_or_else(|_| repo_root.to_path_buf());
    let corpus = collect_def_corpus(repo_root);
    let reader = |p: &Path| std::fs::read_to_string(p).ok();

    // 按定义根分组(Option<String>:None < Some,Rust 序)。
    let mut groups: BTreeMap<Option<String>, Vec<String>> = BTreeMap::new();
    for rel in corpus.keys() {
        let abs = repo_root.join(rel);
        let root = find_entity_defs_root_from_file(&abs);
        let key = root.map(|r| to_repo_rel(repo_root, &r));
        groups.entry(key).or_default().push(rel.clone());
    }

    let mut dump = GoldenDump {
        generator: "kode-server dump-def-rename-golden",
        workspace_count: groups.len(),
        def_file_count: corpus.len(),
        symbol_hit_count: 0,
        analysis_count: 0,
        closure_check_count: 0,
        workspaces: Vec::new(),
    };

    for (root_key, files) in &groups {
        // 每文件的成员名集(供候选宇宙计算)。
        let member_names: BTreeMap<&str, BTreeSet<String>> = files
            .iter()
            .map(|rel| (rel.as_str(), member_names_of(&corpus[rel])))
            .collect();

        let mut golden_files = Vec::new();
        for rel in files {
            let text = &corpus[rel];
            let units: Vec<u16> = text.encode_utf16().collect();
            let abs = repo_root.join(rel);

            // 逐偏移探测符号解析。
            let mut hits = Vec::new();
            let mut analysis_keys: Vec<(&'static str, Option<&'static str>, String)> = Vec::new();
            for offset in 0..=units.len() {
                if let Some(symbol) = resolve_rename_symbol_at_offset(text, offset) {
                    let key = (symbol.kind, symbol.section, symbol.name.clone());
                    if !analysis_keys.contains(&key) {
                        analysis_keys.push(key.clone());
                    }
                    hits.push(GoldenHit {
                        offset,
                        kind: symbol.kind,
                        section: symbol.section,
                        name: symbol.name.clone(),
                        word_start: symbol.word_start,
                        word_end: symbol.word_end,
                    });
                }
            }

            let same_file_names = member_names.get(rel.as_str()).cloned().unwrap_or_default();
            let other_names: BTreeSet<String> = member_names
                .iter()
                .filter(|(f, _)| **f != rel.as_str())
                .flat_map(|(_, names)| names.iter().cloned())
                .collect();

            let mut analyses = Vec::new();
            for (kind, section, name) in &analysis_keys {
                let symbol = DefRenameSymbol {
                    kind,
                    name: name.clone(),
                    section: *section,
                    word_start: 0,
                    word_end: 0,
                };

                // 同文件冲突 × 本文件成员名 ∪ 探测名。
                let mut conflict_candidates = same_file_names.clone();
                conflict_candidates.insert(PROBE_NEW_NAME.to_string());
                let conflict_checks: Vec<GoldenCheck> = conflict_candidates
                    .into_iter()
                    .map(|candidate| GoldenCheck {
                        new_name: candidate.clone(),
                        conflict: find_def_rename_conflict(text, &symbol, &candidate).map(
                            |c| GoldenConflict {
                                surface: c.surface,
                                name: c.name,
                                line: c.line,
                                file_path: None,
                            },
                        ),
                    })
                    .collect();

                // 全工作区编辑计算。
                let edits = compute_def_rename_edits(&abs, text, &symbol, PROBE_NEW_NAME, &reader)
                    .into_iter()
                    .map(|fe| GoldenEditFile {
                        file: to_repo_rel(repo_root, &fe.file_path),
                        ranges: fe
                            .edits
                            .into_iter()
                            .map(|e| (e.start, e.end))
                            .collect(),
                    })
                    .collect();

                // 闭包冲突 × 他文件声明过的成员名 ∪ 探测名。
                let mut closure_candidates = other_names.clone();
                closure_candidates.insert(PROBE_NEW_NAME.to_string());
                let closure_checks: Vec<GoldenCheck> = closure_candidates
                    .into_iter()
                    .map(|candidate| {
                        let conflict =
                            find_def_rename_conflict_in_closure(&abs, text, &symbol, &candidate, &reader);
                        dump.closure_check_count += 1;
                        GoldenCheck {
                            new_name: candidate.clone(),
                            conflict: conflict.map(|c| GoldenConflict {
                                surface: c.surface,
                                name: c.name,
                                line: c.line,
                                file_path: c.file_path.map(|p| to_repo_rel(repo_root, Path::new(&p))),
                            }),
                        }
                    })
                    .collect();

                analyses.push(GoldenAnalysis {
                    kind,
                    section: *section,
                    name: name.clone(),
                    conflict_checks,
                    edits,
                    closure_checks,
                });
            }
            dump.analysis_count += analyses.len();
            golden_files.push(GoldenFileEntry {
                file: rel.clone(),
                probe_count: units.len() + 1,
                symbol_hits: hits,
                analyses,
            });
        }
        dump.workspaces.push(GoldenWorkspace {
            root: root_key.clone(),
            files: golden_files,
        });
    }
    dump.symbol_hit_count = dump
        .workspaces
        .iter()
        .map(|w| w.files.iter().map(|f| f.symbol_hits.len()).sum::<usize>())
        .sum();
    serde_json::to_string_pretty(&dump).expect("serialize")
}

// ---------------------------------------------------------------------------
// 单元钉
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const HERO_DEF: &str = "<root>\n  <Properties>\n    <hp>\n      <Type> UINT32 </Type>\n      <Flags> BASE_AND_CLIENT </Flags>\n    </hp>\n  </Properties>\n  <CellMethods>\n    <reqAttack>\n      <Exposed> true </Exposed>\n    </reqAttack>\n  </CellMethods>\n</root>\n";

    /// 临时工作区构造:files = (相对路径, 内容);返回根目录。
    fn tmp_workspace(tag: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "kode-def-rename-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for (rel, content) in files {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
            std::fs::write(&path, content).expect("write");
        }
        root
    }

    #[test]
    fn resolve_symbol_open_close_and_tolerance_faces() {
        let open = HERO_DEF.find("<hp>").unwrap();
        // 开标签词中。
        let hit = resolve_rename_symbol_at_offset(HERO_DEF, open + 2).expect("开标签词中解析");
        assert_eq!(hit.kind, "property");
        assert_eq!(hit.name, "hp");
        assert_eq!(hit.section, None);
        assert_eq!(&HERO_DEF[hit.word_start..hit.word_end], "hp");
        // 闭标签上:词区间指向闭标签名字。
        let close = HERO_DEF.find("</hp>").unwrap();
        let hit2 = resolve_rename_symbol_at_offset(HERO_DEF, close + 3).expect("闭标签解析");
        assert_eq!(hit2.word_start, close + 2);
        // 词尾右侧一格容差('>' 处回退一步命中 hp)。
        assert!(resolve_rename_symbol_at_offset(HERO_DEF, open + 3).is_some());
        // 方法符号携带段。
        let method = HERO_DEF.find("reqAttack").unwrap();
        let hit3 = resolve_rename_symbol_at_offset(HERO_DEF, method).expect("方法解析");
        assert_eq!(hit3.kind, "method");
        assert_eq!(hit3.section, Some("CellMethods"));
        // Flags 值、嵌套子元素名、空白处都不是可重命名符号。
        assert!(resolve_rename_symbol_at_offset(HERO_DEF, HERO_DEF.find("UINT32").unwrap()).is_none());
        assert!(resolve_rename_symbol_at_offset(HERO_DEF, HERO_DEF.find("Exposed").unwrap()).is_none());
        assert!(resolve_rename_symbol_at_offset(HERO_DEF, 0).is_none());
        // 坏文本:无根。
        assert!(resolve_rename_symbol_at_offset("plain text", 2).is_none());
    }

    #[test]
    fn conflict_method_same_section_and_property_component_faces() {
        let method_pos = HERO_DEF.find("reqAttack").unwrap();
        let symbol = resolve_rename_symbol_at_offset(HERO_DEF, method_pos).unwrap();
        // 无同名即无冲突(方法面:同段无 reqAttack2)。
        assert!(find_def_rename_conflict(HERO_DEF, &symbol, "reqAttack2").is_none());
        // 同段重名:CellMethods 里再声明 cellSkill,方法改名撞同段已有成员。
        let with_dup = HERO_DEF.replace(
            "  </CellMethods>",
            "    <cellSkill>\n    </cellSkill>\n  </CellMethods>",
        );
        let dup_symbol = with_dup
            .find("cellSkill")
            .and_then(|p| resolve_rename_symbol_at_offset(&with_dup, p));
        assert!(dup_symbol.is_some());
        // 方法改名为同段已有名 → 冲突带 1 基行号。
        let m = resolve_rename_symbol_at_offset(&with_dup, with_dup.find("reqAttack").unwrap()).unwrap();
        let hit = find_def_rename_conflict(&with_dup, &m, "cellSkill").expect("同段冲突");
        assert_eq!(hit.surface, "CellMethods");
        assert_eq!(hit.name, "cellSkill");
        assert!(hit.line >= 1);
        // 跨段同名合法:BaseMethods 里有同名不冲突。
        let cross = HERO_DEF.replace("<root>", "<root>\n  <BaseMethods>\n    <cellSkill>\n    </cellSkill>\n  </BaseMethods>");
        let m2 = resolve_rename_symbol_at_offset(&cross, cross.find("reqAttack").unwrap()).unwrap();
        assert!(find_def_rename_conflict(&cross, &m2, "cellSkill").is_none(), "跨段同名合法");
        // 名字非法/改名即本名 → None。
        assert!(find_def_rename_conflict(&cross, &m2, "1bad").is_none());
        assert!(find_def_rename_conflict(&cross, &m2, "reqAttack").is_none());
        // 属性 vs 组件互斥。
        let with_comp = HERO_DEF.replace(
            "  <CellMethods>",
            "  <Components>\n    <bag>\n      <Type> Inventory </Type>\n    </bag>\n  </Components>\n  <CellMethods>",
        );
        let hp = resolve_rename_symbol_at_offset(&with_comp, with_comp.find("<hp>").unwrap() + 2).unwrap();
        let hit2 = find_def_rename_conflict(&with_comp, &hp, "bag").expect("属性撞组件");
        assert_eq!(hit2.surface, "Components");
    }

    #[test]
    fn identifier_gate_and_reference_target_name_forms() {
        // 非法新名:编辑计算为空。
        let hp_pos = HERO_DEF.find("<hp>").unwrap() + 2;
        let symbol = resolve_rename_symbol_at_offset(HERO_DEF, hp_pos).unwrap();
        assert!(collect_rename_edits_in_text(HERO_DEF, &symbol).len() == 2, "开+闭标签两区间");
        // 引擎取名语义:文本形态与元素形态(首子节点,文本取文本/元素取标签名)。
        let text_doc = "<root><Parent> Hero </Parent><Interfaces><interface> ROLE </interface></Interfaces></root>";
        let doc = xml::parse(text_doc, true);
        let root = doc.root().unwrap();
        let parent = doc.child_element(root, "Parent").unwrap();
        assert_eq!(get_reference_target_name(&doc, parent), "Hero");
        let interfaces = doc.child_element(root, "Interfaces").unwrap();
        let iface = doc.child_elements(interfaces)[0];
        assert_eq!(get_reference_target_name(&doc, iface), "ROLE");
        // 元素形态:<Parent><Hero/></Parent> 取标签名。
        let elem_doc = xml::parse("<root><Parent><Hero/></Parent></root>", true);
        let elem_root = elem_doc.root().unwrap();
        let elem_parent = elem_doc.child_element(elem_root, "Parent").unwrap();
        assert_eq!(get_reference_target_name(&elem_doc, elem_parent), "Hero", "元素形态取标签名");
        // 悬空(空内容)wrapper 得空名。
        let empty_doc = xml::parse("<root><Interfaces><interface>   </interface></Interfaces></root>", true);
        let r2 = empty_doc.root().unwrap();
        let ifaces2 = empty_doc.child_element(r2, "Interfaces").unwrap();
        let w2 = empty_doc.child_elements(ifaces2)[0];
        assert_eq!(get_reference_target_name(&empty_doc, w2), "");
        // 语义面:Parent + Interfaces。
        let sem = parse_def_file_semantics(text_doc).unwrap();
        assert_eq!(sem.parent_name.as_deref(), Some("Hero"));
        assert_eq!(sem.interface_names, vec!["ROLE".to_string()]);
        // 接口文件 Parent 不被跟随(resolve_link_paths 面)。
        let entry = DefFileEntry {
            file_path: PathBuf::from("/x/interfaces/ROLE.def"),
            category: DefOwnerCategory::Interface,
            name: "ROLE".to_string(),
        };
        let sem2 = DefFileSemantics {
            parent_name: Some("Hero".to_string()),
            interface_names: Vec::new(),
        };
        let links = resolve_link_paths(Path::new("/x"), &entry, &sem2);
        assert!(links.parent_path.is_none(), "接口不读 Parent");
    }

    #[test]
    fn workspace_edits_cover_descendant_and_interface_closure() {
        let root = tmp_workspace(
            "edits",
            &[
                ("entities.xml", "<root/>\n"),
                (
                    "entity_defs/Hero.def",
                    "<root>\n  <Interfaces><interface> ROLE </interface></Interfaces>\n  <Properties>\n    <hp>\n      <Flags> BASE </Flags>\n    </hp>\n  </Properties>\n</root>\n",
                ),
                (
                    "entity_defs/Monster.def",
                    "<root>\n  <Parent>Hero</Parent>\n  <Properties>\n    <hp>\n      <Flags> BASE </Flags>\n    </hp>\n  </Properties>\n</root>\n",
                ),
                (
                    "entity_defs/interfaces/ROLE.def",
                    "<root>\n  <Properties>\n    <hp>\n      <Flags> BASE </Flags>\n    </hp>\n  </Properties>\n</root>\n",
                ),
                (
                    "entity_defs/Unrelated.def",
                    "<root>\n  <Properties>\n    <hp>\n      <Flags> BASE </Flags>\n    </hp>\n  </Properties>\n</root>\n",
                ),
            ],
        );
        let target = root.join("entity_defs/Hero.def");
        let text = std::fs::read_to_string(&target).unwrap();
        let symbol = resolve_rename_symbol_at_offset(&text, text.find("<hp>").unwrap() + 2).unwrap();
        let reader = |p: &Path| std::fs::read_to_string(p).ok();
        let edits = compute_def_rename_edits(&target, &text, &symbol, "vigor", &reader);
        let files: Vec<String> = edits
            .iter()
            .map(|e| e.file_path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        // 编辑只向后代传播:Monster(Parent Hero)复述进编辑;接口 ROLE 是
        // 祖先不在此面(它由「从接口文件发起」覆盖);无关实体不动。
        assert_eq!(
            files,
            vec!["Hero.def".to_string(), "Monster.def".to_string()],
            "后代复述进编辑,祖先接口与无关实体不动"
        );
        // 每文件两区间(开+闭标签)。
        for fe in &edits {
            assert_eq!(fe.edits.len(), 2);
            assert!(fe.edits[0].start < fe.edits[1].start);
        }
        // 接口源头发起:混入实体与其实体后代都进编辑(Interfaces 传递闭包)。
        let role = root.join("entity_defs/interfaces/ROLE.def");
        let role_text = std::fs::read_to_string(&role).unwrap();
        let role_symbol =
            resolve_rename_symbol_at_offset(&role_text, role_text.find("<hp>").unwrap() + 2).unwrap();
        let role_edits = compute_def_rename_edits(&role, &role_text, &role_symbol, "vigor", &reader);
        let role_files: Vec<String> = role_edits
            .iter()
            .map(|e| e.file_path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            role_files,
            vec![
                "Hero.def".to_string(),
                "Monster.def".to_string(),
                "ROLE.def".to_string()
            ],
            "从接口发起:混入实体 Hero 与后代 Monster 都进编辑"
        );
        // 新名非法/即本名 → 空。
        assert!(compute_def_rename_edits(&target, &text, &symbol, "1x", &reader).is_empty());
        assert!(compute_def_rename_edits(&target, &text, &symbol, "hp", &reader).is_empty());
        // 组件 Parent 在 components/ 内解析;悬空 Parent 不产生边。
        let dangling = tmp_workspace(
            "dangling",
            &[
                ("entities.xml", "<root/>\n"),
                (
                    "entity_defs/Lone.def",
                    "<root><Parent>Ghost</Parent><Properties><hp><Flags> BASE </Flags></hp></Properties></root>\n",
                ),
            ],
        );
        let lone = dangling.join("entity_defs/Lone.def");
        let lone_text = std::fs::read_to_string(&lone).unwrap();
        let lone_symbol =
            resolve_rename_symbol_at_offset(&lone_text, lone_text.find("<hp>").unwrap() + 2).unwrap();
        let lone_edits = compute_def_rename_edits(&lone, &lone_text, &lone_symbol, "vigor", &reader);
        assert_eq!(lone_edits.len(), 1, "悬空 Parent 只改自己");
    }

    #[test]
    fn closure_conflict_ancestor_and_descendant_directions() {
        let reader = |p: &Path| std::fs::read_to_string(p).ok();
        let root = tmp_workspace(
            "closure",
            &[
                ("entities.xml", "<root/>\n"),
                (
                    "entity_defs/Hero.def",
                    "<root>\n  <Properties>\n    <hp>\n      <Flags> BASE </Flags>\n    </hp>\n    <vigor>\n      <Flags> CELL_PUBLIC </Flags>\n    </vigor>\n  </Properties>\n  <CellMethods>\n    <onMove>\n    </onMove>\n  </CellMethods>\n</root>\n",
                ),
                (
                    "entity_defs/Monster.def",
                    "<root>\n  <Parent>Hero</Parent>\n  <Properties>\n    <ferocity>\n      <Flags> BASE </Flags>\n    </ferocity>\n  </Properties>\n</root>\n",
                ),
            ],
        );
        // 后代方向:改 Hero.hp → vigor 撞后代?Monster 无 vigor → 无冲突;
        // 但 Hero.hp → ferocity 撞后代 Monster.ferocity(BASE 相交)→ 冲突带文件。
        let hero = root.join("entity_defs/Hero.def");
        let hero_text = std::fs::read_to_string(&hero).unwrap();
        let hp = resolve_rename_symbol_at_offset(&hero_text, hero_text.find("<hp>").unwrap() + 2).unwrap();
        let hit = find_def_rename_conflict_in_closure(&hero, &hero_text, &hp, "ferocity", &reader)
            .expect("后代占名冲突");
        assert_eq!(hit.surface, "Properties");
        assert_eq!(hit.name, "ferocity");
        assert!(hit.file_path.as_deref().unwrap().ends_with("Monster.def"));
        // 域位不相交不冲突:Hero.hp(BASE)→ 改 vigor?vigor 是自己文件同名
        // → 即本名闸;改 onMove?kind 不同(方法面)→ 方法 vs 属性无条件冲突。
        let m = resolve_rename_symbol_at_offset(&hero_text, hero_text.find("onMove").unwrap()).unwrap();
        let hit2 = find_def_rename_conflict_in_closure(&hero, &hero_text, &m, "ferocity", &reader)
            .expect("方法 vs 后代属性无条件冲突");
        assert_eq!(hit2.surface, "Properties");
        // 祖先方向:改 Monster.ferocity → hp 撞祖先 Hero.hp → 冲突。
        let monster = root.join("entity_defs/Monster.def");
        let monster_text = std::fs::read_to_string(&monster).unwrap();
        let ferocity =
            resolve_rename_symbol_at_offset(&monster_text, monster_text.find("ferocity").unwrap()).unwrap();
        let hit3 = find_def_rename_conflict_in_closure(&monster, &monster_text, &ferocity, "hp", &reader)
            .expect("祖先占名冲突");
        assert!(hit3.file_path.as_deref().unwrap().ends_with("Hero.def"));
        // 无关名字(仅探测名)→ 完整走查后 null。
        assert!(find_def_rename_conflict_in_closure(&hero, &hero_text, &hp, PROBE_NEW_NAME, &reader).is_none());
        // 无定义根 → None。
        let lone_dir = tmp_workspace("noroot", &[("Lone.def", HERO_DEF)]);
        let lone = lone_dir.join("Lone.def");
        let lone_text = std::fs::read_to_string(&lone).unwrap();
        let lone_symbol =
            resolve_rename_symbol_at_offset(&lone_text, lone_text.find("<hp>").unwrap() + 2).unwrap();
        assert!(
            find_def_rename_conflict_in_closure(&lone, &lone_text, &lone_symbol, "vigor", &reader).is_none()
        );
    }

    #[test]
    fn flag_domain_overlap_gates_property_conflict() {
        // BASE({base}) vs CELL_PUBLIC({cell})域位不相交 → 后代占名不冲突;
        // BASE_AND_CLIENT({base,client}) vs ALL_CLIENTS({cell,client})相交
        // 于 client → 冲突。
        let reader = |p: &Path| std::fs::read_to_string(p).ok();
        let root1 = tmp_workspace(
            "domains",
            &[
                ("entities.xml", "<root/>\n"),
                (
                    "entity_defs/Hero.def",
                    "<root><Properties><hp><Flags> BASE </Flags></hp></Properties></root>\n",
                ),
                (
                    "entity_defs/Monster.def",
                    "<root><Parent>Hero</Parent><Properties><sight><Flags> CELL_PUBLIC </Flags></sight></Properties></root>\n",
                ),
            ],
        );
        // Hero.hp(BASE)→ sight(Monster,CELL_PUBLIC):不相交 → null。
        let hero1 = root1.join("entity_defs/Hero.def");
        let text1 = std::fs::read_to_string(&hero1).unwrap();
        let sym1 = resolve_rename_symbol_at_offset(&text1, text1.find("<hp>").unwrap() + 2).unwrap();
        assert!(
            find_def_rename_conflict_in_closure(&hero1, &text1, &sym1, "sight", &reader).is_none(),
            "域位不相交不冲突"
        );
        let root2 = tmp_workspace(
            "domains2",
            &[
                ("entities.xml", "<root/>\n"),
                (
                    "entity_defs/Hero.def",
                    "<root><Properties><hp><Flags> BASE_AND_CLIENT </Flags></hp></Properties></root>\n",
                ),
                (
                    "entity_defs/Monster.def",
                    "<root><Parent>Hero</Parent><Properties><mp><Flags> ALL_CLIENTS </Flags></mp></Properties></root>\n",
                ),
            ],
        );
        // Hero.hp(BASE_AND_CLIENT)→ mp(Monster,ALL_CLIENTS):相交 → 冲突。
        let hero2 = root2.join("entity_defs/Hero.def");
        let text2 = std::fs::read_to_string(&hero2).unwrap();
        let sym2 = resolve_rename_symbol_at_offset(&text2, text2.find("<hp>").unwrap() + 2).unwrap();
        let hit = find_def_rename_conflict_in_closure(&hero2, &text2, &sym2, "mp", &reader)
            .expect("域位相交冲突");
        assert_eq!(hit.surface, "Properties");
        assert!(hit.file_path.as_deref().unwrap().ends_with("Monster.def"));
    }

    // ---- COV-039:防御臂/边界臂直调与工作区夹具 -----------------------------

    #[test]
    fn cov_utf16_map_interior_and_identifier_empty() {
        // 83:多字节字符内部字节偏移钳到该字符 UTF-16 起点(防御面直调)。
        let map = Utf16Map::new("a中b");
        let mid = "a中b".find('中').unwrap() + 1;
        assert_eq!(map.to_u16(mid), 1);
        assert_eq!(map.to_u16(0), 0);
        // 162:空文本/无词落点 → None。
        assert_eq!(find_identifier_at_offset(&[], 0), None);
        let blanks: Vec<u16> = "  ".encode_utf16().collect();
        assert_eq!(find_identifier_at_offset(&blanks, 0), None);
    }

    #[test]
    fn cov_tag_self_closing_and_miss_faces() {
        // 203:自闭合元素 close span 空 → 闭区间 None,编辑只含开区间。
        // 注:Rust tokenizer recover 模式直接丢弃 `< hp>`/`</ hp>` 空白形态
        // (实测 Properties 子元素只剩内层 Type),get_tag_name_range 的空白
        // 跳过臂(213/214/218/219)在 Rust 输入空间不可达,与 209/223/228
        // 同列结构性余量。
        let self_closing = "<root>\n  <Properties>\n    <mp/>\n  </Properties>\n</root>\n";
        let sym = resolve_rename_symbol_at_offset(self_closing, self_closing.find("mp").unwrap())
            .expect("自闭合属性可解析");
        assert_eq!(sym.kind, "property");
        assert_eq!(sym.name, "mp");
        assert_eq!(collect_rename_edits_in_text(self_closing, &sym).len(), 1);
        // 267:非 Properties/方法段命中 → None;478:全无命中 → None。
        let odd = "<root>\n  <Unknown>\n    <zz/>\n  </Unknown>\n</root>\n";
        assert_eq!(
            resolve_rename_symbol_at_offset(odd, odd.find("zz").unwrap()),
            None
        );
        assert_eq!(
            resolve_rename_symbol_at_offset(HERO_DEF, HERO_DEF.find("</root>").unwrap()),
            None
        );
    }

    #[test]
    fn cov_flags_element_child_and_reference_faces() {
        // 375:Flags 段挂元素子节点(非文本)→ find_map None 走空 flags 面。
        let odd_flags = "<root>\n  <Properties>\n    <hp>\n      <Type>UINT32</Type>\n      <Flags><BASE_AND_CLIENT/></Flags>\n    </hp>\n  </Properties>\n</root>\n";
        let hit = resolve_rename_symbol_at_offset(odd_flags, odd_flags.find("<hp>").unwrap() + 2)
            .expect("元素形态 Flags 仍可解析");
        assert_eq!(hit.name, "hp");
        // 498:Parent 混合内容非文本/非元素节点跳过;526:空 wrapper 跳过。
        let sem_text = "<root>\n  <Parent><!--c--><Base/></Parent>\n  <Interfaces>\n    <Interface/>\n    <Interface>IFoo</Interface>\n  </Interfaces>\n</root>\n";
        let sem = parse_def_file_semantics(sem_text).expect("语义面可解析");
        assert_eq!(sem.parent_name.as_deref(), Some("Base"));
        assert_eq!(sem.interface_names, vec!["IFoo".to_string()]);
    }

    #[test]
    fn cov_root_walk_classify_list_and_component_parent() {
        // 580:向上到文件系统根无 entities.xml → None(tmp 深度 3 跳即可)。
        let lonely = tmp_workspace("lonely", &[("entity_defs/Hero.def", HERO_DEF)]);
        assert_eq!(
            find_entity_defs_root_from_file(&lonely.join("entity_defs/Hero.def")),
            None
        );
        // 600:目标不在 defs_root 子树 → strip_prefix 失败,类目保 Entity。
        let other_root = tmp_workspace("other", &[("elsewhere/Monster.def", HERO_DEF)]);
        let entry = classify_def_file(
            &lonely.join("entity_defs"),
            &other_root.join("elsewhere/Monster.def"),
        );
        assert_eq!(entry.category, DefOwnerCategory::Entity);
        // 615:递归枚举不存在目录 → 空。
        assert!(list_def_files_recursive(&lonely.join("nope")).is_empty());
        // 655:Component 类目 Parent 解析进 components/ 子目录。
        let comp_path = lonely.join("entity_defs/components/Slot.def");
        std::fs::create_dir_all(comp_path.parent().unwrap()).unwrap();
        std::fs::write(&comp_path, "<root>\n  <Parent>Base</Parent>\n</root>\n").unwrap();
        let comp = classify_def_file(&lonely.join("entity_defs"), &comp_path);
        assert_eq!(comp.category, DefOwnerCategory::Component);
        let sem = parse_def_file_semantics("<root>\n  <Parent>Base</Parent>\n</root>\n").unwrap();
        let links = resolve_link_paths(&lonely.join("entity_defs"), &comp, &sem);
        assert_eq!(
            links.parent_path,
            Some(lonely.join("entity_defs/components/Base.def"))
        );
    }

    #[test]
    fn cov_owner_closure_skip_arms() {
        // 683:起始文件读不到;686:内容无根元素;695:悬空 Parent 引用不产边。
        let root = tmp_workspace("closure", &[("entity_defs/Hero.def", HERO_DEF)]);
        let defs = root.join("entity_defs");
        let hero = classify_def_file(&defs, &defs.join("Hero.def"));
        let mut index = std::collections::BTreeMap::new();
        index.insert(hero.file_path.clone(), hero.clone());
        let none_reader: CrossFileReader = &|_: &Path| None;
        assert!(collect_owner_closure(&hero, &defs, &index, none_reader).is_empty());
        let garbage_reader: CrossFileReader = &|_: &Path| Some("garbage".to_string());
        assert!(collect_owner_closure(&hero, &defs, &index, garbage_reader).is_empty());
        let dangling_reader: CrossFileReader = &|p: &Path| {
            if p.ends_with("Hero.def") {
                Some("<root>\n  <Parent>Ghost</Parent>\n</root>\n".to_string())
            } else {
                None
            }
        };
        assert!(collect_owner_closure(&hero, &defs, &index, dangling_reader).is_empty());
    }

    #[test]
    fn cov_collect_compute_and_corpus_edges() {
        // 715/1022:无根文本面 → 空;771:新名非法 → 空编辑。
        let sym =
            resolve_rename_symbol_at_offset(HERO_DEF, HERO_DEF.find("<hp>").unwrap() + 2).unwrap();
        assert!(collect_rename_edits_in_text("", &sym).is_empty());
        assert!(member_names_of("").is_empty());
        let hero_path = tmp_workspace("edges", &[("entity_defs/Hero.def", HERO_DEF)])
            .join("entity_defs/Hero.def");
        let fs_reader: CrossFileReader = &|p: &Path| std::fs::read_to_string(p).ok();
        assert!(compute_def_rename_edits(&hero_path, HERO_DEF, &sym, "1bad", fs_reader).is_empty());
        // 991:语料目录不存在 → 空收;997:非 UTF-8 文件名跳过。
        let corpus_root = tmp_workspace("corpus", &[]);
        assert!(collect_def_corpus(&corpus_root).is_empty());
        let first = kode_parser::json::PARITY_CORPORA[0];
        let dir = corpus_root.join(first);
        std::fs::create_dir_all(&dir).unwrap();
        // 非 UTF-8 文件名臂只在 Linux 可构造:Windows 无 unix 字节名 API,
        // macOS APFS 拒绝非 UTF-8 文件名(write 必败,2026-11-19 nightly
        // darwin 实测 unwrap 炸);corpus.len()==1 断言各侧同真,保持无条件。
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::ffi::OsStrExt;
            let bad = std::ffi::OsStr::from_bytes(b"\xff\xfe.def");
            std::fs::write(dir.join(bad), "<root/>").unwrap();
        }
        std::fs::write(
            dir.join("ok.def"),
            "<root>\n  <Properties>\n    <hp/>\n  </Properties>\n</root>\n",
        )
        .unwrap();
        let corpus = collect_def_corpus(&corpus_root);
        assert_eq!(corpus.len(), 1, "只收合法文件名 def: {corpus:?}");
    }

    #[test]
    fn cov_workspace_loop_skip_arms() {
        // 795:compute 循环跳过目标自身;856:祖先 def 坏 XML 根 None 跳过;
        // 866:conflict 循环中既非祖先也非后代的 def 跳过;descendant 臂走通。
        let hero_text = "<root>\n  <Parent>Base</Parent>\n  <Properties>\n    <hp>\n      <Type>UINT32</Type>\n    </hp>\n  </Properties>\n</root>\n";
        let alien_text = "<root>\n  <Parent>Hero</Parent>\n  <Properties>\n    <zz9>\n      <Type>UINT32</Type>\n      <Flags><BASE_AND_CLIENT/></Flags>\n    </zz9>\n  </Properties>\n</root>\n";
        let root = tmp_workspace(
            "loops",
            &[
                ("entities.xml", "<root/>"),
                ("entity_defs/Hero.def", hero_text),
                ("entity_defs/Base.def", "not xml <<<"),
                (
                    "entity_defs/Ghost2.def",
                    "<root>\n  <Properties>\n    <mana>UINT32</mana>\n  </Properties>\n</root>\n",
                ),
                ("entity_defs/Alien.def", alien_text),
            ],
        );
        let hero = root.join("entity_defs/Hero.def");
        let text = std::fs::read_to_string(&hero).unwrap();
        let sym = resolve_rename_symbol_at_offset(&text, text.find("<hp>").unwrap() + 2).unwrap();
        let fs_reader: CrossFileReader = &|p: &Path| std::fs::read_to_string(p).ok();
        let edits = compute_def_rename_edits(&hero, &text, &sym, "mp2", fs_reader);
        assert!(
            edits.iter().any(|e| e.file_path.ends_with("Hero.def")),
            "目标文件自身编辑在场: {edits:?}"
        );
        // 856:祖先 Base 坏 XML 跳过;Alien(后代)zz9 方法与 hp 属性面不同,
        // member_conflicts 不咬 → 无冲突。
        assert!(
            find_def_rename_conflict_in_closure(&hero, &text, &sym, "zz9", fs_reader).is_none(),
            "无占用冲突"
        );
    }
}
