//! references 响应链(RUST-138 批 1,IDE-NAV-017/018 语料半边下沉)。
//!
//! 面 = **语料引用位**:UTF-16 position → 符号目标(kind+名)→ LSP Location
//! 列表。与 definition.rs 同饮 HoverEngine 语料视图;TS 生产面
//! (src/defSymbolReferences.ts + src/typesXmlReferences.ts)分两类:
//! - **纯语料半边**(本批):def 内类型名(`<Type>/<Arg>/<of>` 值)、实体名
//!   (`<Parent>` 值)、接口名(`<Interfaces>` 直挂 wrapper 值)与 types.xml
//!   符号(顶层声明名/值引用)的引用位扫描 + 语料声明落点;
//! - **entityMapping 运行时半边**(批 2+,不在本批):Properties 属性
//!   self 访问、三方法段实现/receiver 调用、python 数据字典/cellData 键族
//!   ——TS 经 EntityMappingManager 查 py 实现,Rust 无此能力,保持 null。
//!
//! 逐点同构(TS → Rust):
//! - `wordAt(offset)` ASCII `\w` 扩词(JS `/\w/` 严格 ASCII,非 hover 的
//!   Unicode is_alphanumeric);位置单参入口,词在解析器内部自算;
//! - `resolveDefSymbolReferenceTarget`:链 walk 四臂(KR-AUD-77:直挂
//!   `<Interfaces>` 的四种 wrapper 拼写 interface/Interface/type/Type 优先
//!   判接口;`Type/Arg/of` 值 → type;`Parent` 值 → parent;`Interfaces`
//!   跨度 → interface),容器字面 ARRAY/FIXED_DICT 与空词拒;
//! - `resolveTypesXmlSymbolName`:顶层声明名(父为 `<root>` 字面 && 词 ==
//!   元素名 && offset 在开标签段)+ `Type/Arg/of` 值内引用;
//! - `scanTypeReferencesInXml`:`<Type>` 直挂文本(剔容器字面)+ Type 直挂
//!   `<of>` 子元素值 + `<Arg>` 直挂文本 + 游离 `<of>`(父非 Type)值;
//! - `collectTokenSites`:值区间按空白切 token,`indexOf` 前进逐个定位
//!   (重复 token 各记一位);
//! - 内建类型(KBENGINE_TYPES 同表)无引用面 → None;
//! - 声明落点语料化:custom type = 同根 types_files 声明行(TS
//!   findCustomTypeInfo/findCustomTypeDeclarationInfo 的 workspaceRoot 定域);
//!   entity = `{entity_defs_root}/{name}.def` 首行(findEntityDefinitionFile
//!   单规则);interface = `{entity_defs_root}/interfaces/{name}.def` 首行
//!   (findDefinitionFileByCategory('interface'));types.xml 臂无声明位
//!   (TS provideTypesXmlReferences 忽略 includeDeclaration 且不产声明);
//! - dedup 键:decl = `file:line`(无列,TS 同)、site = `file:line:start`;
//!   includeDeclaration=true 时声明先行。
//!
//! 新增引擎驻留:def/types 语料**原文**(`texts`,引用扫描要逐文件全文
//! 重扫,definition/hover 只消费解析模型不需要原文)。内存代价 = def/xml
//! 资产字节(结构化资产,量级小);BodyOnly(模型同文本异,如注释增删)
//! 也刷新原文——引用位坐标直接依赖原文行位,不能用旧文本。
//!
//! 产品面事实(诚实边界):TS 侧引用走 ReferenceProvider(languageProviders/
//! references.ts);Rust 侧本批只落纯库 + 对拍 golden,`textDocument/
//! references` 的 server.rs LSP 接线属批 2+(server.rs 现有并发在途改动,
//! 本批不碰),期间生产服务面仍是 TS。

use kode_parser::dep::{file_kind_of_uri, FileKind};
use kode_parser::model::TypeDecl;
use kode_parser::xml;
use kode_vfs::store::DocumentKey;

use crate::definition::{
    byte_offset_to_position, deepest_element_with_chain, file_head_location, is_builtin_type,
    line_start_location, position_to_byte_offset, DefinitionLocation, LspPosition, LspRange,
};
use crate::hover::HoverEngine;

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

/// def 光标处符号的引用类(TS DefSymbolReferenceKind 同形)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RefKind {
    Type,
    Parent,
    Interface,
}

/// 光标处解析出的引用目标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RefTarget {
    pub kind: RefKind,
    pub name: String,
}

/// 一条引用位(TS TypesXmlRefSite 同形:文件 + 0 基行 + 行内 UTF-16 起止列)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefSite {
    pub uri: String,
    pub line: u32,
    pub start: u32,
    pub end: u32,
}

/// 容器字面不是类型符号(TS CONTAINER_LITERALS 同表)。
const CONTAINER_LITERALS: &[&str] = &["ARRAY", "FIXED_DICT"];

/// 引擎在 `<Interfaces>` 下认的四种 wrapper 拼写(TS
/// defRenamer.INTERFACE_WRAPPER_NAMES 同表同序——Set 插入序即扫描序,
/// entitydef.cpp:563-566,大小写敏感)。
const INTERFACE_WRAPPER_NAMES: &[&str] = &["interface", "Interface", "type", "Type"];

fn is_container_literal(word: &str) -> bool {
    CONTAINER_LITERALS.contains(&word)
}

// ---------------------------------------------------------------------------
// 词与 token 定位(collectTokenSites 镜像)
// ---------------------------------------------------------------------------

/// TS wordAt 同构:offset 处 ASCII `\w` 扩词(JS `/\w/` = [A-Za-z0-9_];
/// 非 hover::word_at 的 Unicode 语义——TS 两处 wordAt 都是 ASCII)。
fn word_at_offset(text: &str, offset: usize) -> String {
    let offset = offset.min(text.len());
    let mut start = offset;
    while start > 0 {
        let mut prev = start - 1;
        while !text.is_char_boundary(prev) {
            prev -= 1;
        }
        let Some(c) = text[prev..].chars().next() else {
            break;
        };
        if !(c.is_ascii_alphanumeric() || c == '_') {
            break;
        }
        start = prev;
    }
    let mut end = offset;
    while end < text.len() {
        let Some(c) = text[end..].chars().next() else {
            break;
        };
        if !(c.is_ascii_alphanumeric() || c == '_') {
            break;
        }
        end += c.len_utf8();
    }
    text[start..end].to_string()
}

/// 按空白切 token(JS `split(/\s+/)` 等价:空段不产 token;语料 ASCII,
/// Unicode 空白差异不影响)。
fn for_each_token(raw: &str, mut visit: impl FnMut(&str)) {
    let mut token_start: Option<usize> = None;
    for (idx, ch) in raw.char_indices() {
        if ch.is_whitespace() {
            if let Some(start) = token_start.take() {
                visit(&raw[start..idx]);
            }
        } else if token_start.is_none() {
            token_start = Some(idx);
        }
    }
    if let Some(start) = token_start {
        visit(&raw[start..]);
    }
}

/// TS collectTokenSites 同构:[start,end) 值区间空白分隔 token 逐个定位
/// (`indexOf` 自 search_from 前进;找不到或越出值区间即断),token ==
/// target 记引用位;exclude_containers 时 ARRAY/FIXED_DICT 不记(types.xml
/// 扫描面;def 面的收集不带剔除——TS 两处 collectTokenSites 参数面不同)。
fn token_sites(
    text: &str,
    uri: &str,
    start: usize,
    end: usize,
    target: &str,
    exclude_containers: bool,
    sites: &mut Vec<RefSite>,
) {
    let end = end.min(text.len());
    if start >= end {
        return;
    }
    let raw = &text[start..end];
    let mut search_from = start;
    for_each_token(raw, |token| {
        let Some(idx) = text[search_from..].find(token).map(|i| search_from + i) else {
            return;
        };
        if idx >= end {
            return;
        }
        if !(exclude_containers && is_container_literal(token)) && token == target {
            let pos = byte_offset_to_position(text, idx);
            let width: u32 = token.chars().map(|c| c.len_utf16() as u32).sum();
            sites.push(RefSite {
                uri: uri.to_string(),
                line: pos.line,
                start: pos.character,
                end: pos.character + width,
            });
        }
        search_from = idx + token.len();
    });
}

// ---------------------------------------------------------------------------
// 引用位扫描(scanTypeReferencesInXml / scanDefTagValueSites 镜像)
// ---------------------------------------------------------------------------

/// 先序遍历全部元素,携带父元素名(根的直接子元素父名 = 根元素名)。
fn walk_with_parent(
    doc: &xml::Document,
    node: usize,
    parent_name: Option<&str>,
    visit: &mut impl FnMut(usize, Option<&str>),
) {
    visit(node, parent_name);
    let name = doc.element(node).name.clone();
    for &child in &doc.element(node).children {
        if matches!(doc.nodes[child].data, xml::NodeData::Element(_)) {
            walk_with_parent(doc, child, Some(&name), visit);
        }
    }
}

/// TS scanTypeReferencesInXml 同构:单段 .def / types.xml 内容中 target
/// 类型名的全部引用位。
pub fn scan_type_references_in_xml(text: &str, uri: &str, target: &str) -> Vec<RefSite> {
    let doc = xml::parse(text, true);
    let Some(root) = doc.root() else {
        return Vec::new();
    };
    let mut sites = Vec::new();
    walk_with_parent(&doc, root, None, &mut |node, parent_name| {
        let el = doc.element(node);
        match el.name.as_str() {
            "Type" => {
                // 直挂文本(剔容器字面)+ 直挂 `<of>` 子元素值(不剔)。
                for &child in &el.children {
                    if let xml::NodeData::Text { span, .. } = &doc.nodes[child].data {
                        token_sites(text, uri, span.start, span.end, target, true, &mut sites);
                    }
                }
                for &child in &el.children {
                    if matches!(doc.nodes[child].data, xml::NodeData::Element(_))
                        && doc.element(child).name == "of"
                    {
                        let content = doc.element(child).content_span;
                        token_sites(
                            text,
                            uri,
                            content.start,
                            content.end,
                            target,
                            false,
                            &mut sites,
                        );
                    }
                }
            }
            "Arg" => {
                for &child in &el.children {
                    if let xml::NodeData::Text { span, .. } = &doc.nodes[child].data {
                        token_sites(text, uri, span.start, span.end, target, false, &mut sites);
                    }
                }
            }
            "of" if parent_name != Some("Type") => {
                // 游离 `<of>`(Type 分支已收其直挂子)。
                let content = el.content_span;
                token_sites(
                    text,
                    uri,
                    content.start,
                    content.end,
                    target,
                    false,
                    &mut sites,
                );
            }
            _ => {}
        }
    });
    sites
}

/// TS scanDefTagValueSites 同构:单文件内所有 `<tag_name>` 值区间 token ==
/// target 的引用位;only_direct_interfaces_child 时仅 `<Interfaces>` 直挂
/// 元素算(KR-AUD-77:属性 `<Type>` 等同名元素不误计)。
fn scan_def_tag_value_sites(
    text: &str,
    uri: &str,
    tag_name: &str,
    target: &str,
    only_direct_interfaces_child: bool,
) -> Vec<RefSite> {
    let doc = xml::parse(text, true);
    let Some(root) = doc.root() else {
        return Vec::new();
    };
    let mut sites = Vec::new();
    walk_with_parent(&doc, root, None, &mut |node, parent_name| {
        let el = doc.element(node);
        if el.name != tag_name {
            return;
        }
        if only_direct_interfaces_child && parent_name != Some("Interfaces") {
            return;
        }
        let content = el.content_span;
        token_sites(
            text,
            uri,
            content.start,
            content.end,
            target,
            false,
            &mut sites,
        );
    });
    sites
}

// ---------------------------------------------------------------------------
// 光标处目标识别(resolveDefSymbolReferenceTarget /
// resolveTypesXmlSymbolName 镜像)
// ---------------------------------------------------------------------------

/// TS resolveDefSymbolReferenceTarget 同构:def 光标处符号的引用类。
/// offset 落在文本上时同「文本节点.parent」(= 含该偏移的最深元素),标签上
/// 时同 findDeepestElementAtOffset——两 TS 臂在 Rust 链模型下合并为最深
/// 元素链。容器字面与空词拒;wrapper 直挂 `<Interfaces>` 优先于 Type 臂。
pub(crate) fn def_symbol_reference_target_at(text: &str, offset: usize) -> Option<RefTarget> {
    let doc = xml::parse(text, true);
    let root = doc.root()?;
    let (_hit, chain) = deepest_element_with_chain(&doc, root, offset)?;
    let word = word_at_offset(text, offset);
    if word.is_empty() || is_container_literal(&word) {
        return None;
    }
    for idx in (0..chain.len()).rev() {
        let el = doc.element(chain[idx]);
        let parent_name = if idx > 0 {
            Some(doc.element(chain[idx - 1]).name.as_str())
        } else {
            None
        };
        let content = el.content_span;
        let in_value = offset >= content.start && offset <= content.end;
        // KR-AUD-77:直挂 `<Interfaces>` 的 wrapper 优先判接口(`<Interfaces>`
        // 外的同名 `<Type>` 仍是属性类型)。
        if INTERFACE_WRAPPER_NAMES.contains(&el.name.as_str())
            && parent_name == Some("Interfaces")
            && in_value
        {
            return Some(RefTarget {
                kind: RefKind::Interface,
                name: word,
            });
        }
        if (el.name == "Type" || el.name == "Arg" || el.name == "of") && in_value {
            return Some(RefTarget {
                kind: RefKind::Type,
                name: word,
            });
        }
        if el.name == "Parent" && in_value {
            return Some(RefTarget {
                kind: RefKind::Parent,
                name: word,
            });
        }
        if el.name == "Interfaces" && in_value {
            return Some(RefTarget {
                kind: RefKind::Interface,
                name: word,
            });
        }
    }
    None
}

/// TS resolveTypesXmlSymbolName 同构:types.xml 光标处符号的类型名
/// (顶层声明名或 `Type/Arg/of` 值内引用;容器字面/implementedBy/其他
/// 标签 None)。
pub(crate) fn types_xml_symbol_name_at(text: &str, offset: usize) -> Option<String> {
    let doc = xml::parse(text, true);
    let root = doc.root()?;
    let (_hit, chain) = deepest_element_with_chain(&doc, root, offset)?;
    let el_idx = *chain.last()?;
    let el = doc.element(el_idx);
    let word = word_at_offset(text, offset);
    if word.is_empty() || is_container_literal(&word) {
        return None;
    }
    // 顶层类型声明名:父为 `<root>`(字面 'root';TS element.parent?.name
    // === 'root'),光标在开标签段(词 == 元素名 && offset < contentStart)。
    if chain.len() >= 2
        && doc.element(chain[chain.len() - 2]).name == "root"
        && el.name == word
        && offset < el.content_span.start
    {
        return Some(word);
    }
    // Type/Arg/of 值内引用。
    if (el.name == "Type" || el.name == "Arg" || el.name == "of")
        && offset >= el.content_span.start
        && offset <= el.content_span.end
    {
        return Some(word);
    }
    None
}

// ---------------------------------------------------------------------------
// 响应链(HoverEngine 语料视图)
// ---------------------------------------------------------------------------

fn site_location(site: &RefSite) -> DefinitionLocation {
    let pos = LspPosition {
        line: site.line,
        character: site.start,
    };
    DefinitionLocation {
        uri: site.uri.clone(),
        range: LspRange {
            start: pos.clone(),
            end: pos,
        },
    }
}

impl HoverEngine {
    /// 交互入口:UTF-16 position → 符号目标 → Location 列表(includeDeclaration
    /// 只对 def 面生效;types.xml 面 TS 忽略该标志)。未知符号/空结果如实
    /// None(LSP 允许),不虚构。
    pub fn references(
        &self,
        key: &DocumentKey,
        text: &str,
        line: u32,
        character: u32,
        include_declaration: bool,
    ) -> Option<Vec<DefinitionLocation>> {
        self.references_at(key, text, line, character, include_declaration)
    }

    /// 位置入口(golden 生成用同款;0 基行)。
    pub fn references_at(
        &self,
        key: &DocumentKey,
        text: &str,
        line0: u32,
        character: u32,
        include_declaration: bool,
    ) -> Option<Vec<DefinitionLocation>> {
        match file_kind_of_uri(&key.uri) {
            FileKind::Def => self.def_references(key, text, line0, character, include_declaration),
            FileKind::Types => self.types_references(key, text, line0, character),
            // python 文档(entityMapping 运行时面)/entities.xml/alias.xml
            // 无 Rust 引用面(TS provider 同 null)。
            _ => None,
        }
    }

    /// def 面(TS provideDefSymbolReferences 语料半边)。
    fn def_references(
        &self,
        key: &DocumentKey,
        text: &str,
        line0: u32,
        character: u32,
        include_declaration: bool,
    ) -> Option<Vec<DefinitionLocation>> {
        let offset = position_to_byte_offset(text, line0, character);
        let target = def_symbol_reference_target_at(text, offset)?;
        // 内建类型无引用面(TS builtIns 同拒;含 ARRAY/FIXED_DICT 容器)。
        if is_builtin_type(&target.name) {
            return None;
        }
        let path = key.uri.as_path();
        let declaration: Option<DefinitionLocation>;
        let sites: Vec<RefSite>;
        match target.kind {
            RefKind::Type => {
                if let Some((types_path, decl)) = self.same_root_type_decl(key.root, &target.name) {
                    sites = self.custom_type_sites(&target.name);
                    declaration = Some(line_start_location(types_path, decl.line));
                } else {
                    let entity_path = self.entity_def_file(path, &target.name)?;
                    sites = self.entity_sites(&target.name);
                    declaration = Some(file_head_location(&entity_path));
                }
            }
            RefKind::Parent => {
                let entity_path = self.entity_def_file(path, &target.name)?;
                sites = self.entity_sites(&target.name);
                declaration = Some(file_head_location(&entity_path));
            }
            RefKind::Interface => {
                sites = self.interface_sites(&target.name);
                declaration = self
                    .interface_def_file(path, &target.name)
                    .map(|ref path| file_head_location(path));
            }
        }
        // 声明先行 + 站点序;dedup 键:decl = file:line(无列)、
        // site = file:line:start(TS 同)。
        let mut locations = Vec::new();
        let mut seen = std::collections::HashSet::new();
        if include_declaration {
            if let Some(decl) = &declaration {
                seen.insert(format!("{}:{}", decl.uri, decl.range.start.line));
                locations.push(decl.clone());
            }
        }
        for site in &sites {
            let dedup_key = format!("{}:{}:{}", site.uri, site.line, site.start);
            if seen.insert(dedup_key) {
                locations.push(site_location(site));
            }
        }
        if locations.is_empty() {
            None
        } else {
            Some(locations)
        }
    }

    /// types.xml 面(TS provideTypesXmlReferences):符号名 → 同根 types
    /// 声明存在性闸 → 全语料 .def + types.xml 引用位(无声明位,不 dedup
    /// ——TS 同;空结果 None)。
    fn types_references(
        &self,
        key: &DocumentKey,
        text: &str,
        line0: u32,
        character: u32,
    ) -> Option<Vec<DefinitionLocation>> {
        let offset = position_to_byte_offset(text, line0, character);
        let name = types_xml_symbol_name_at(text, offset)?;
        // 只对同根 types.xml 已声明的自定义类型出引用(内建类型不是
        // types.xml 符号,免全仓同名内建使用处噪声)。
        self.same_root_type_decl(key.root, &name)?;
        let mut locations = Vec::new();
        for uri in self.scan_corpus_uris() {
            let Some(content) = self.corpus_text(&uri) else {
                continue;
            };
            for site in scan_type_references_in_xml(content, &uri, &name) {
                locations.push(site_location(&site));
            }
        }
        if locations.is_empty() {
            None
        } else {
            Some(locations)
        }
    }

    /// TS findCustomTypeInfo/findCustomTypeDeclarationInfo 语料化:查询方
    /// 同根(path_roots 归属)types.xml 声明;types_files 路径字典序首见。
    fn same_root_type_decl(
        &self,
        root: kode_vfs::store::RootId,
        name: &str,
    ) -> Option<(&String, &TypeDecl)> {
        for (types_path, types) in &self.types_files {
            if self.path_root_of(types_path) != Some(root) {
                continue;
            }
            if let Some(decl) = types.types.iter().find(|t| t.name == name) {
                return Some((types_path, decl));
            }
        }
        None
    }

    /// TS findEntityDefinitionFile 语料化:{entity_defs_root}/{name}.def
    /// 在语料中(存在性判定;单规则,无候选歧义面)。
    fn entity_def_file(&self, path: &str, name: &str) -> Option<String> {
        let defs_root = self.entity_defs_root(path)?;
        let candidate = format!("{defs_root}/{name}.def");
        self.corpus_defs.contains(&candidate).then_some(candidate)
    }

    /// TS findDefinitionFileByCategory('interface') 语料化:
    /// `{entity_defs_root}/interfaces/{name}.def`(TS interfacesRoot 单规则)。
    fn interface_def_file(&self, path: &str, name: &str) -> Option<String> {
        let defs_root = self.entity_defs_root(path)?;
        let candidate = format!("{defs_root}/interfaces/{name}.def");
        self.corpus_defs.contains(&candidate).then_some(candidate)
    }

    /// TS collectCustomTypeSites 语料镜像:全语料 .def + types.xml(先 def
    /// 后 types,各按语料字典序 = TS findFilesAcrossRoots 双 glob 拼接序)。
    fn custom_type_sites(&self, name: &str) -> Vec<RefSite> {
        let mut sites = Vec::new();
        for uri in self.scan_corpus_uris() {
            let Some(content) = self.corpus_text(&uri) else {
                continue;
            };
            sites.extend(scan_type_references_in_xml(content, &uri, name));
        }
        sites
    }

    /// TS collectEntitySites 语料镜像:全语料 .def,每文件 `<Parent>` 值
    /// 先、类型引用(`scanTypeReferencesInXml` 的 Type/Arg/of 面)后。
    fn entity_sites(&self, name: &str) -> Vec<RefSite> {
        let mut sites = Vec::new();
        for uri in &self.corpus_defs {
            let Some(content) = self.corpus_text(uri) else {
                continue;
            };
            sites.extend(scan_def_tag_value_sites(
                content, uri, "Parent", name, false,
            ));
            sites.extend(scan_type_references_in_xml(content, uri, name));
        }
        sites
    }

    /// TS collectInterfaceSites 语料镜像:全语料 .def,每文件按 wrapper
    /// 拼写序(interface/Interface/type/Type)各扫一遍,仅 `<Interfaces>`
    /// 直挂算。
    fn interface_sites(&self, name: &str) -> Vec<RefSite> {
        let mut sites = Vec::new();
        for uri in &self.corpus_defs {
            let Some(content) = self.corpus_text(uri) else {
                continue;
            };
            for tag in INTERFACE_WRAPPER_NAMES {
                sites.extend(scan_def_tag_value_sites(content, uri, tag, name, true));
            }
        }
        sites
    }

    /// 引用扫描语料序(TS `[...defFiles, ...typesXmlFiles]` 镜像):corpus
    /// def(字典序)+ types(字典序)。
    fn scan_corpus_uris(&self) -> Vec<String> {
        let mut uris: Vec<String> = self.corpus_defs.iter().cloned().collect();
        uris.extend(self.types_files.keys().cloned());
        uris
    }
}

// ---------------------------------------------------------------------------
// 对拍 golden(只写不读;TS 侧 tests/kodeReferencesParity.test.ts 复算)
// ---------------------------------------------------------------------------

/// golden 文件名(仓库相对)。
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/references-parity.json";

/// golden 探针(1 基行 + UTF-16 列;词不进探针——引用解析器内部自算词,
/// TS 镜像同)。位置判定型面(Parent/Type/Arg/of 值、顶层声明名)。
#[derive(Debug, Clone, PartialEq, Eq)]
struct GoldenProbe {
    line: usize,
    character: u32,
}

/// 探针定序(行,列全序)+ 去重相邻全等项。
fn order_probes(mut probes: Vec<GoldenProbe>) -> Vec<GoldenProbe> {
    probes.sort_by(|a, b| (&a.line, &a.character).cmp(&(&b.line, &b.character)));
    probes.dedup();
    probes
}

#[derive(Debug, serde::Serialize)]
struct GoldenReference {
    line: usize,
    character: u32,
    locations: Vec<DefinitionLocation>,
}

#[derive(Debug, serde::Serialize)]
struct GoldenFile {
    file: String,
    kind: String,
    references: Vec<GoldenReference>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    file_count: usize,
    reference_count: usize,
    files: Vec<GoldenFile>,
}

/// 元素文本内容首 token 探针(词首行列;值判定面的生产触发位)。
fn value_token_probe(doc: &xml::Document, node: usize, text: &str) -> Option<GoldenProbe> {
    let el = doc.element(node);
    let content = text.get(el.content_span.start..el.content_span.end)?;
    let trimmed = content.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    let lead = content.len() - trimmed.len();
    let pos = byte_offset_to_position(text, el.content_span.start + lead);
    Some(GoldenProbe {
        line: pos.line as usize + 1,
        character: pos.character,
    })
}

/// 顶层元素名声明探针(开标签名首;TS 顶层声明名臂的生产触发位:
/// offset 在开标签段 && 词 == 元素名)。
fn declaration_name_probe(doc: &xml::Document, node: usize, text: &str) -> Option<GoldenProbe> {
    let name_start = doc.element(node).name_span.start;
    let pos = byte_offset_to_position(text, name_start);
    Some(GoldenProbe {
        line: pos.line as usize + 1,
        character: pos.character,
    })
}

/// def 文件探针集:`<Parent>` 取值词(值判定,非 definition 的词比对列 0)
/// + 全树 `Type/of/Arg` 取值词 + `<Interfaces>` 段内元素内容首词。
fn def_probes(doc: &xml::Document, root: usize, text: &str) -> Vec<GoldenProbe> {
    let mut probes = Vec::new();
    let mut parent_tags: Vec<usize> = Vec::new();
    let mut value_tags: Vec<usize> = Vec::new();
    let mut interface_segments: Vec<usize> = Vec::new();
    walk_with_parent(
        doc,
        root,
        None,
        &mut |node, _| match doc.element(node).name.as_str() {
            "Parent" => parent_tags.push(node),
            "Type" | "of" | "Arg" => value_tags.push(node),
            "Interfaces" => interface_segments.push(node),
            _ => {}
        },
    );
    for node in parent_tags {
        if let Some(probe) = value_token_probe(doc, node, text) {
            probes.push(probe);
        }
    }
    for node in value_tags {
        if let Some(probe) = value_token_probe(doc, node, text) {
            probes.push(probe);
        }
    }
    for segment in interface_segments {
        walk_with_parent(doc, segment, None, &mut |inner, _| {
            if inner != segment {
                if let Some(probe) = value_token_probe(doc, inner, text) {
                    probes.push(probe);
                }
            }
        });
    }
    probes
}

/// types.xml 探针集:顶层声明名(开标签名首)+ 全树 `Type/Arg/of` 取值词。
fn types_probes(doc: &xml::Document, root: usize, text: &str) -> Vec<GoldenProbe> {
    let mut probes = Vec::new();
    for &child in &doc.element(root).children {
        if matches!(doc.nodes[child].data, xml::NodeData::Element(_)) {
            if let Some(probe) = declaration_name_probe(doc, child, text) {
                probes.push(probe);
            }
        }
    }
    walk_with_parent(doc, root, None, &mut |node, _| {
        if matches!(doc.element(node).name.as_str(), "Type" | "of" | "Arg") {
            if let Some(probe) = value_token_probe(doc, node, text) {
                probes.push(probe);
            }
        }
    });
    probes
}

/// 整个语料的 references golden JSON(def/types 文件逐探针引用位;
/// entities/alias 无 TS 引用面,空数组占位)。
pub fn dump_references_golden(repo_root: &std::path::Path) -> String {
    use kode_parser::json::{collect_corpus, PARITY_CORPORA};

    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let registry = crate::golden_corpus::corpus_registry();
    let mut engine = HoverEngine::new();
    // 先全量入库(字典序 = TS 语料序;键 = 各语料工程根,KBUG-ROOT 隔离)。
    for (path, (_kind, text)) in &files {
        engine.update(crate::golden_corpus::corpus_key(&registry, path), text);
    }
    let mut dump = GoldenDump {
        generator: "kode-server dump-references-golden",
        file_count: files.len(),
        reference_count: 0,
        files: Vec::new(),
    };
    for (path, (kind, text)) in &files {
        let key = crate::golden_corpus::corpus_key(&registry, path);
        let mut probes: Vec<GoldenProbe> = Vec::new();
        match *kind {
            "def" => {
                let doc = xml::parse(text, true);
                if let Some(root) = doc.root() {
                    probes.extend(def_probes(&doc, root, text));
                }
            }
            "types" => {
                let doc = xml::parse(text, true);
                if let Some(root) = doc.root() {
                    probes.extend(types_probes(&doc, root, text));
                }
            }
            // entities/alias:TS provider 对非 .def/types.xml 文件如实 null。
            _ => {}
        }
        let probes = order_probes(probes);
        let mut references = Vec::new();
        for probe in probes {
            if let Some(locations) =
                engine.references_at(&key, text, probe.line as u32 - 1, probe.character, true)
            {
                references.push(GoldenReference {
                    line: probe.line,
                    character: probe.character,
                    locations,
                });
            }
        }
        dump.reference_count += references.len();
        dump.files.push(GoldenFile {
            file: path.clone(),
            kind: kind.to_string(),
            references,
        });
    }
    serde_json::to_string(&dump).expect("serialize references golden")
}

// ---------------------------------------------------------------------------
// 单元钉(合成语料)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use kode_vfs::store::{DocumentKey, RootRegistry};
    use kode_vfs::uri::CanonicalUri;

    use super::*;

    fn registry() -> RootRegistry {
        let mut registry = RootRegistry::new();
        registry.register("/proj-a");
        registry.register("/proj-b");
        registry
    }

    fn key_for(registry: &RootRegistry, path: &str) -> DocumentKey {
        let uri = CanonicalUri::from_path(path);
        DocumentKey::new(registry.root_for(&uri), uri)
    }

    const A_ENTITIES: &str = "<root>\n  <Avatar> scripts/entity_defs/Avatar.def </Avatar>\n  <Monster> scripts/entity_defs/Monster.def </Monster>\n</root>\n";
    const B_ENTITIES: &str =
        "<root>\n  <Avatar> scripts/entity_defs/Avatar.def </Avatar>\n</root>\n";
    const A_TYPES: &str = "<root>\n  <ITEM_ID> UINT16 </ITEM_ID>\n</root>\n";
    const A_AVATAR: &str = "<root>\n  <Properties>\n    <hp>\n      <Type> ITEM_ID </Type>\n    </hp>\n  </Properties>\n</root>\n";
    const A_MONSTER: &str = "<root>\n  <Parent> Avatar </Parent>\n  <Properties>\n    <ai>\n      <Type> Avatar </Type>\n    </ai>\n  </Properties>\n</root>\n";
    const A_ROLE: &str = "<root>\n  <CellMethods>\n    <onMove>\n      <Arg> UINT32 </Arg>\n    </onMove>\n  </CellMethods>\n</root>\n";
    const A_IFACE_AVATAR: &str = "<root>\n  <Interfaces>\n    <interface> ROLE </interface>\n  </Interfaces>\n  <Properties>\n    <hp>\n      <Type> ROLE </Type>\n    </hp>\n  </Properties>\n</root>\n";
    const B_TYPES: &str = "<root>\n  <ITEM_ID> INT8 </ITEM_ID>\n</root>\n";
    const B_AVATAR: &str = "<root>\n  <Properties>\n    <hp>\n      <Type> ITEM_ID </Type>\n    </hp>\n  </Properties>\n</root>\n";

    fn build() -> (RootRegistry, HoverEngine) {
        let registry = registry();
        let mut engine = HoverEngine::new();
        for (path, text) in [
            ("/proj-a/scripts/entities.xml", A_ENTITIES),
            ("/proj-a/scripts/entity_defs/types.xml", A_TYPES),
            ("/proj-a/scripts/entity_defs/Avatar.def", A_AVATAR),
            ("/proj-a/scripts/entity_defs/Monster.def", A_MONSTER),
            ("/proj-a/scripts/entity_defs/interfaces/ROLE.def", A_ROLE),
            (
                "/proj-a/scripts/entity_defs/AvatarIface.def",
                A_IFACE_AVATAR,
            ),
            ("/proj-b/scripts/entities.xml", B_ENTITIES),
            ("/proj-b/scripts/entity_defs/types.xml", B_TYPES),
            ("/proj-b/scripts/entity_defs/Avatar.def", B_AVATAR),
        ] {
            engine.update(key_for(&registry, path), text);
        }
        (registry, engine)
    }

    /// 元素内容首 token 的 (1 基行, 列) 探针(测试定位用)。
    fn probe_of(text: &str, tag: &str) -> (usize, u32) {
        let doc = xml::parse(text, true);
        let root = doc.root().expect("root");
        let mut hit = None;
        walk_with_parent(&doc, root, None, &mut |node, _| {
            if hit.is_none() && doc.element(node).name == tag {
                let el = doc.element(node);
                let content = &text[el.content_span.start..el.content_span.end];
                let trimmed = content.trim_start();
                if !trimmed.is_empty() {
                    let lead = content.len() - trimmed.len();
                    let pos = byte_offset_to_position(text, el.content_span.start + lead);
                    hit = Some((pos.line as usize + 1, pos.character));
                }
            }
        });
        hit.expect("probe tag")
    }

    fn probe_at_decl(text: &str, tag: &str) -> (usize, u32) {
        let doc = xml::parse(text, true);
        let root = doc.root().expect("root");
        for &child in &doc.element(root).children {
            if matches!(doc.nodes[child].data, xml::NodeData::Element(_))
                && doc.element(child).name == tag
            {
                let pos = byte_offset_to_position(text, doc.element(child).name_span.start);
                return (pos.line as usize + 1, pos.character);
            }
        }
        panic!("decl tag not found: {tag}");
    }

    fn refs_at(
        engine: &HoverEngine,
        registry: &RootRegistry,
        path: &str,
        text: &str,
        line1: usize,
        character: u32,
    ) -> Option<Vec<DefinitionLocation>> {
        engine.references_at(
            &key_for(registry, path),
            text,
            line1 as u32 - 1,
            character,
            true,
        )
    }

    fn uris_of(locations: &[DefinitionLocation]) -> Vec<&str> {
        locations.iter().map(|loc| loc.uri.as_str()).collect()
    }

    #[test]
    fn target_resolution_faces() {
        // Type 值 → type;Parent 值 → parent;wrapper 直挂 Interfaces →
        // interface;属性同名 Type 不误判接口(KR-AUD-77);Flags 词 → None。
        assert_eq!(
            def_symbol_reference_target_at(A_AVATAR, position_of(A_AVATAR, 4, 14)).map(|t| t.kind),
            Some(RefKind::Type)
        );
        assert_eq!(
            def_symbol_reference_target_at(A_MONSTER, position_of(A_MONSTER, 2, 12))
                .map(|t| t.kind),
            Some(RefKind::Parent)
        );
        assert_eq!(
            def_symbol_reference_target_at(A_IFACE_AVATAR, position_of(A_IFACE_AVATAR, 3, 18))
                .map(|t| t.kind),
            Some(RefKind::Interface)
        );
        assert_eq!(
            def_symbol_reference_target_at(A_IFACE_AVATAR, position_of(A_IFACE_AVATAR, 7, 14))
                .map(|t| t.kind),
            Some(RefKind::Type)
        );
        // 非符号元素(段名标签上)→ None(链 walk 无命中臂)。
        assert_eq!(
            def_symbol_reference_target_at(A_ROLE, position_of(A_ROLE, 2, 5)),
            None
        );
    }

    /// (1 基行, UTF-16 列) → 字节偏移。
    fn position_of(text: &str, line1: usize, character: u32) -> usize {
        position_to_byte_offset(text, line1 as u32 - 1, character)
    }

    #[test]
    fn type_face_custom_type_same_root_decl_and_cross_root_sites() {
        let (registry, engine) = build();
        let (line1, character) = probe_of(A_AVATAR, "Type");
        let locations = refs_at(
            &engine,
            &registry,
            "/proj-a/scripts/entity_defs/Avatar.def",
            A_AVATAR,
            line1,
            character,
        )
        .expect("type face");
        // 声明先行 = 同根 types.xml ITEM_ID 声明行首;站点含本 def 使用处
        // (跨 root /proj-b 的 Avatar.def 使用处也入列——TS 扫描全工作区)。
        assert_eq!(locations[0].uri, "/proj-a/scripts/entity_defs/types.xml");
        assert!(locations[0].range.start.character == 0);
        let uris = uris_of(&locations);
        assert!(uris.contains(&"/proj-a/scripts/entity_defs/Avatar.def"));
        assert!(uris.contains(&"/proj-b/scripts/entity_defs/Avatar.def"));
        // 跨根同名词:proj-b 查询落 proj-b 声明。
        let (bline, bchar) = probe_of(B_AVATAR, "Type");
        let b_locations = refs_at(
            &engine,
            &registry,
            "/proj-b/scripts/entity_defs/Avatar.def",
            B_AVATAR,
            bline,
            bchar,
        )
        .expect("type face b");
        assert_eq!(b_locations[0].uri, "/proj-b/scripts/entity_defs/types.xml");
    }

    #[test]
    fn builtin_type_has_no_face() {
        let (registry, mut engine) = registry_holder();
        let text = "<root>\n  <Properties>\n    <hp>\n      <Type> UINT32 </Type>\n    </hp>\n  </Properties>\n</root>\n";
        engine.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/Builtin.def"),
            text,
        );
        let (bl, bc) = probe_of(text, "Type");
        assert_eq!(
            refs_at(
                &engine,
                &registry,
                "/proj-a/scripts/entity_defs/Builtin.def",
                text,
                bl,
                bc
            ),
            None
        );
    }

    #[test]
    fn container_literal_rejected_at_target_resolution() {
        // ARRAY 在 Type 直挂文本上:词=ARRAY 容器字面 → None(引用面同拒)。
        let text = "<root>\n  <Properties>\n    <bag>\n      <Type>\n        ARRAY\n        <of> UINT32 </of>\n      </Type>\n    </bag>\n  </Properties>\n</root>\n";
        let (registry, mut engine) = registry_holder();
        engine.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/Bag.def"),
            text,
        );
        let (line1, character) = probe_of(text, "Type");
        assert_eq!(
            refs_at(
                &engine,
                &registry,
                "/proj-a/scripts/entity_defs/Bag.def",
                text,
                line1,
                character
            ),
            None
        );
    }

    fn registry_holder() -> (RootRegistry, HoverEngine) {
        (registry(), HoverEngine::new())
    }

    #[test]
    fn entity_face_parent_and_type_refs() {
        let (registry, mut engine) = build();
        let (line1, character) = probe_of(A_MONSTER, "Parent");
        let locations = refs_at(
            &engine,
            &registry,
            "/proj-a/scripts/entity_defs/Monster.def",
            A_MONSTER,
            line1,
            character,
        )
        .expect("entity face");
        // 声明先行 = Avatar.def 首行;站点 = Parent 值先、Type 实体引用后
        // (全三元序钉:同文件两站点的先后也是契约,TS 镜像同序)。
        assert_eq!(locations[0].uri, "/proj-a/scripts/entity_defs/Avatar.def");
        assert_eq!(locations[0].range.start.line, 0);
        let (pl, pc) = probe_of(A_MONSTER, "Parent");
        let (tl, tc) = probe_of(A_MONSTER, "Type");
        let faces: Vec<(&str, u32, u32)> = locations
            .iter()
            .map(|loc| {
                (
                    loc.uri.as_str(),
                    loc.range.start.line,
                    loc.range.start.character,
                )
            })
            .collect();
        assert_eq!(
            faces,
            vec![
                ("/proj-a/scripts/entity_defs/Avatar.def", 0, 0),
                ("/proj-a/scripts/entity_defs/Monster.def", pl as u32 - 1, pc),
                ("/proj-a/scripts/entity_defs/Monster.def", tl as u32 - 1, tc),
            ]
        );
        assert_eq!(
            uris_of(&locations),
            vec![
                "/proj-a/scripts/entity_defs/Avatar.def",
                "/proj-a/scripts/entity_defs/Monster.def",
                "/proj-a/scripts/entity_defs/Monster.def",
            ]
        );
        // 未注册实体的 Parent 词:语料缺 def → None。
        let missing = "<root>\n  <Parent> Ghost </Parent>\n</root>\n";
        engine.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/GhostRef.def"),
            missing,
        );
        let (gl, gc) = probe_of(missing, "Parent");
        assert_eq!(
            refs_at(
                &engine,
                &registry,
                "/proj-a/scripts/entity_defs/GhostRef.def",
                missing,
                gl,
                gc
            ),
            None
        );
    }

    #[test]
    fn interface_face_wrapper_direct_child_only() {
        let (registry, mut engine) = build();
        // wrapper 值上的词 → interface 面:站点只含直挂 wrapper 值,
        // 属性 <Type> ROLE 不混入(KR-AUD-77)。
        let (line1, character) = probe_of(A_IFACE_AVATAR, "interface");
        let locations = refs_at(
            &engine,
            &registry,
            "/proj-a/scripts/entity_defs/AvatarIface.def",
            A_IFACE_AVATAR,
            line1,
            character,
        )
        .expect("interface face");
        assert_eq!(
            locations[0].uri,
            "/proj-a/scripts/entity_defs/interfaces/ROLE.def"
        );
        assert_eq!(
            uris_of(&locations),
            vec![
                "/proj-a/scripts/entity_defs/interfaces/ROLE.def",
                "/proj-a/scripts/entity_defs/AvatarIface.def"
            ]
        );
        // 接口 def 语料缺失:站点照列,无声明位。
        let missing = "<root>\n  <Interfaces>\n    <Interface> GHOST_IFACE </Interface>\n  </Interfaces>\n</root>\n";
        engine.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/IfaceMissing.def"),
            missing,
        );
        let (ml, mc) = probe_of(missing, "Interface");
        let locations = refs_at(
            &engine,
            &registry,
            "/proj-a/scripts/entity_defs/IfaceMissing.def",
            missing,
            ml,
            mc,
        )
        .expect("interface sites without decl");
        assert_eq!(
            uris_of(&locations),
            vec!["/proj-a/scripts/entity_defs/IfaceMissing.def"]
        );
    }

    #[test]
    fn include_declaration_false_drops_decl_only() {
        let (registry, engine) = build();
        let (line1, character) = probe_of(A_AVATAR, "Type");
        let key = key_for(&registry, "/proj-a/scripts/entity_defs/Avatar.def");
        let with_decl = engine
            .references_at(&key, A_AVATAR, line1 as u32 - 1, character, true)
            .expect("with decl");
        let without = engine
            .references_at(&key, A_AVATAR, line1 as u32 - 1, character, false)
            .expect("without decl");
        assert_eq!(with_decl.len() - without.len(), 1);
        assert_ne!(with_decl[0].uri, without[0].uri);
    }

    #[test]
    fn types_xml_face_declaration_name_and_value_refs() {
        let (registry, engine) = build();
        // 顶层声明名探针(开标签名首)→ types 面:全语料引用位,无声明位。
        let (line1, character) = probe_at_decl(A_TYPES, "ITEM_ID");
        let locations = refs_at(
            &engine,
            &registry,
            "/proj-a/scripts/entity_defs/types.xml",
            A_TYPES,
            line1,
            character,
        )
        .expect("types face");
        let uris = uris_of(&locations);
        assert!(uris.contains(&"/proj-a/scripts/entity_defs/Avatar.def"));
        // types.xml 内 ITEM_IDS 的 <of> ITEM_ID 也是引用位。
        let types_text = "<root>\n  <ITEM_ID> UINT16 </ITEM_ID>\n  <ITEM_IDS>\n    ARRAY\n    <of> ITEM_ID </of>\n  </ITEM_IDS>\n</root>\n";
        let mut local = HoverEngine::new();
        local.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/types.xml"),
            types_text,
        );
        local.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/Avatar.def"),
            A_AVATAR,
        );
        let (dl, dc) = probe_at_decl(types_text, "ITEM_ID");
        let locations = local
            .references_at(
                &key_for(&registry, "/proj-a/scripts/entity_defs/types.xml"),
                types_text,
                dl as u32 - 1,
                dc,
                true,
            )
            .expect("types face with of");
        assert_eq!(
            uris_of(&locations),
            vec![
                "/proj-a/scripts/entity_defs/Avatar.def",
                "/proj-a/scripts/entity_defs/types.xml",
            ]
        );
    }

    #[test]
    fn alias_xml_has_no_face() {
        let (registry, mut engine) = registry_holder();
        let text = "<root>\n  <GHOST_ALIAS> UINT16 </GHOST_ALIAS>\n</root>\n";
        engine.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/alias.xml"),
            text,
        );
        let (line1, character) = probe_at_decl(text, "GHOST_ALIAS");
        assert_eq!(
            refs_at(
                &engine,
                &registry,
                "/proj-a/scripts/entity_defs/alias.xml",
                text,
                line1,
                character
            ),
            None
        );
    }

    #[test]
    fn token_sites_repeat_tokens_each_located() {
        let text = "<root>\n  <Type> ITEM_ID ITEM_ID </Type>\n</root>\n";
        let sites = scan_type_references_in_xml(text, "/x.def", "ITEM_ID");
        assert_eq!(sites.len(), 2);
        assert_ne!(sites[0].start, sites[1].start);
        assert_eq!(sites[0].end - sites[0].start, sites[1].end - sites[1].start);
    }

    #[test]
    fn bodyonly_text_change_refreshes_scan_text() {
        // 模型同文本异(注释增行):BodyOnly 也刷新原文驻留——引用位行号
        // 必须跟新文本,不得用旧文本坐标。
        let (registry, mut engine) = registry_holder();
        let v1 = "<root>\n  <!-- c -->\n  <Properties>\n    <hp>\n      <Type> ITEM_ID </Type>\n    </hp>\n  </Properties>\n</root>\n";
        let v2 = "<root>\n  <!-- c1 -->\n  <!-- c2 -->\n  <Properties>\n    <hp>\n      <Type> ITEM_ID </Type>\n    </hp>\n  </Properties>\n</root>\n";
        let types = A_TYPES;
        engine.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/types.xml"),
            types,
        );
        engine.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/Avatar.def"),
            v1,
        );
        let (l1, c1) = probe_of(v1, "Type");
        let r1 = refs_at(
            &engine,
            &registry,
            "/proj-a/scripts/entity_defs/Avatar.def",
            v1,
            l1,
            c1,
        )
        .expect("v1");
        let site1 = r1
            .iter()
            .find(|loc| loc.uri.ends_with("Avatar.def"))
            .expect("site");
        assert_eq!(site1.range.start.line, (l1 - 1) as u32);
        engine.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/Avatar.def"),
            v2,
        );
        let (l2, c2) = probe_of(v2, "Type");
        let r2 = refs_at(
            &engine,
            &registry,
            "/proj-a/scripts/entity_defs/Avatar.def",
            v2,
            l2,
            c2,
        )
        .expect("v2");
        let site2 = r2
            .iter()
            .find(|loc| loc.uri.ends_with("Avatar.def"))
            .expect("site");
        assert_eq!(site2.range.start.line, (l2 - 1) as u32);
        assert_ne!(site1.range.start.line, site2.range.start.line);
        let _ = (c1, c2);
    }

    #[test]
    fn remove_clears_corpus_text() {
        let (registry, mut engine) = registry_holder();
        engine.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/Avatar.def"),
            A_AVATAR,
        );
        engine.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/types.xml"),
            A_TYPES,
        );
        engine.remove(&key_for(
            &registry,
            "/proj-a/scripts/entity_defs/Avatar.def",
        ));
        assert_eq!(
            engine.corpus_text("/proj-a/scripts/entity_defs/Avatar.def"),
            None
        );
        assert!(engine
            .types_files
            .contains_key("/proj-a/scripts/entity_defs/types.xml"));
    }

    // ---- 边界面/入口包装/直挂文本臂(COV 批补) --------------------------------

    #[test]
    fn word_at_multibyte_boundary_walks_back_to_ascii() {
        // 回扫跨过多字节字符的非边界字节位,停在 ASCII 词首
        assert_eq!(word_at_offset("a中b", 4), "b");
        assert_eq!(word_at_offset("中word中", 6), "word");
    }

    #[test]
    fn token_sites_empty_range_and_empty_documents_are_noop() {
        let mut sites = Vec::new();
        token_sites("abc", "u", 2, 2, "a", false, &mut sites);
        assert!(sites.is_empty());
        assert!(scan_type_references_in_xml("", "u", "T").is_empty());
        assert!(scan_def_tag_value_sites("", "u", "Parent", "T", false).is_empty());
    }

    #[test]
    fn interfaces_direct_text_resolves_interface_kind() {
        // <Interfaces> 直挂文本(无 wrapper 子元素)也判接口面
        let text = "<root>\n  <Interfaces> WIDGET </Interfaces>\n</root>\n";
        let offset = text.find("WIDGET").unwrap();
        let target = def_symbol_reference_target_at(text, offset).expect("interface target");
        assert_eq!(target.kind, RefKind::Interface);
        assert_eq!(target.name, "WIDGET");
    }

    #[test]
    fn types_xml_value_reference_and_none_faces() {
        let with_arg = "<root>\n  <T1>\n    <Arg> UINT8 </Arg>\n  </T1>\n</root>\n";
        assert_eq!(
            types_xml_symbol_name_at(with_arg, with_arg.find("UINT8").unwrap()).as_deref(),
            Some("UINT8")
        );
        // 顶层声明元素值内的词不是声明名(声明臂要求词==元素名)
        assert_eq!(
            types_xml_symbol_name_at(B_TYPES, B_TYPES.find("INT8").unwrap()),
            None
        );
    }

    #[test]
    fn references_wrapper_entry_delegates() {
        let (registry, engine) = build();
        let (line1, character) = probe_of(A_AVATAR, "Type");
        let key = key_for(&registry, "/proj-a/scripts/entity_defs/Avatar.def");
        let locations = engine
            .references(&key, A_AVATAR, (line1 - 1) as u32, character, true)
            .expect("wrapper delegates to references_at");
        assert!(locations.iter().any(|loc| loc.uri.ends_with("types.xml")));
    }

    #[test]
    fn type_target_without_types_decl_falls_back_to_entity_def() {
        // Avatar 不是 types.xml 声明的自定义类型 → 回退实体 def 文件头
        let (registry, engine) = build();
        let (line1, character) = probe_of(A_MONSTER, "Type");
        let locations = refs_at(
            &engine,
            &registry,
            "/proj-a/scripts/entity_defs/Monster.def",
            A_MONSTER,
            line1,
            character,
        )
        .expect("Avatar 作为实体名有 def 文件");
        assert!(locations.iter().any(|loc| loc.uri.ends_with("Avatar.def")));
    }

    #[test]
    fn interfaces_direct_text_without_sites_is_none_when_declaration_excluded() {
        let (registry, mut engine) = registry_holder();
        let text = "<root>\n  <Interfaces> WIDGET </Interfaces>\n</root>\n";
        engine.update(
            key_for(&registry, "/proj-a/scripts/entity_defs/Direct.def"),
            text,
        );
        let key = key_for(&registry, "/proj-a/scripts/entity_defs/Direct.def");
        let offset = text.find("WIDGET").unwrap();
        let pos = byte_offset_to_position(text, offset);
        // 直挂文本形无 wrapper 子元素 → 零站点;排除声明位 → 空结果如实 None
        assert_eq!(
            engine.references_at(&key, text, pos.line, pos.character, false),
            None
        );
    }

    #[test]
    fn value_token_probe_skips_whitespace_only_content() {
        let text = "<root>\n  <Empty>   </Empty>\n</root>\n";
        let doc = xml::parse(text, true);
        let root = doc.root().expect("root");
        let mut hit = false;
        walk_with_parent(&doc, root, None, &mut |node, _| {
            if doc.element(node).name == "Empty" {
                hit = true;
                assert_eq!(value_token_probe(&doc, node, text), None);
            }
        });
        assert!(hit, "Empty 元素被访问");
    }

    #[test]
    #[should_panic(expected = "decl tag not found")]
    fn probe_at_decl_missing_tag_panics_honestly() {
        probe_at_decl(A_TYPES, "NOPE");
    }
}
