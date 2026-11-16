//! definition 响应链(Phase2 首片,书 §17 PR-010 定义面 / LSP 系列)。
//!
//! 面 = **语料声明落点**:UTF-16 position → 词 → 声明处的 LSP Location。
//! 复用 hover 的定位基建(word_at)与 HoverEngine 语料视图(纯内存、零 IO,
//! ARCH-012 红线同 hover)。四类文档的落点口径:
//! - `.def`:按 TS F12 provider 链的**落点语义**逐层同构 —
//!   ①`<DetailLevel>` 取值词 → 本文件 `<DetailLevels>` 档位声明行;
//!   ②`Properties` 段声明词 → 注册回落(entities.xml 声明行,缺则本文件首行);
//!   ③三方法段声明词 → null(2026-11-08 demo 验收面:TS 下一层 = py 实现/
//!   def 调用链,Rust 不虚构落点,服务轨道回落 TS);④`<Parent>` 取值词 →
//!   语料内父/接口/组件 def 文件首行(缺失即 null,绝不虚构);⑤`<Type>`/
//!   `<of>` 取值词 → 语料内 types.xml 声明行(内建类型无定义文件,null);
//!   ⑥`Components` 段声明词 → null(TS provider 链末尾同 null,不做单侧增强)。
//!   ② 的 Python 脚本层与数据库 schema 层是 Rust 无此能力的面(.py 面 /
//!   DB 快照),按能力边界跳过并直接落 TS 的下一层,不虚构落点。
//! - `entities.xml`:注册项词 → 语料内同名 def 文件首行(TS
//!   findEntityDefinitionFile 同口径);
//! - `types.xml`/`alias.xml`:声明词 → 本文件声明行(TS
//!   findCustomTypeDefinition 同口径,落点=行首)。
//!
//! 剩余差异如实划归(Phase2 首片边界,docs/kode2/phase2-slice-a.md §面定义):
//! TS F12 全脸中的 Python 脚本落点(402 声明词探针实测 401 命中 / 1 条分歧 =
//! 属性链真实存在的 `scripts/base/Avatar.py` 脚本层,见 §1 表)、
//! 数据库 schema 虚拟文档、kbe 桩;Rust 语料面一律 null/直接落下一层。
//!
//! RUST-137 批 1(2026-11-16)语料面补全(TS findDefinitionReferenceInDef
//! 的纯语料半边全下沉,零 IO 红线保持):
//! - `<Arg>` 取值词 → 语料内同名实体 def 首行(TS isPositionInsideTagValue
//!   'Arg' + findEntityDefinitionFile 同构;root 定域唯一候选才落,歧义 null);
//! - `<Interfaces>` 段内任一元素跨度上的词 → `<defs_root>/interfaces/<word>.def`
//!   首行(TS isPositionInsideChildTag + findDefinitionFileByCategory('interface')
//!   同构;TS interfacesRoot = entityDefsRoot/interfaces 单规则);
//! - `<Type>`/`<of>` 取值词的 types.xml 未命中回落:component def → 实体 def
//!   (TS findTypeValueDefinitionReference 顺序 type 条目 → component → entity
//!   的语料化;components = defs_root/components 目录存在性);
//! - `types.xml` 的 `<Type>` 取值词面(TS findTypeValueDefinitionInTypesXml
//!   同构,无 gate):本文件顶层声明行 → component/entity 回落;implementedBy
//!   值词面(py 符号行)仍属能力边界,null 回落 TS;
//! - gate 对齐:TS findDefinitionReferenceInDef 顶部 looksLikeEntityName
//!   (非内建 && 首字母大写)统一拒 Parent/Type/Arg/Interfaces 四臂——
//!   既有 Parent/Type 臂补挂同 gate(小写词 TS 生产 null,曾单侧落点=增强,
//!   本批收回对齐;golden 重生成审计无意外 diff)。
//!
//! 产品面事实:TS 只注册 DefinitionProvider(config/def/def+语料/python 四路,
//! activate/languageServices.ts),无独立 Declaration/TypeDefinition provider;
//! 账本 LSP-004 三方法名按产品现实收敛为 definition 单方法全链。
//! 方法段/属性声明词的 py 落点仍 null(TS 先试 py 实现,注册回落见既有臂),
//! golden 探针带列(Type/of、Arg 取值词词首列;Interfaces 标签 `<` 列),
//! 位置判定型臂在 golden 语境真正触发。

use kode_index::symbol::{def_entity_name, extract_records, SymbolKind};
use kode_parser::dep::{file_kind_of_uri, FileKind, ParsedUnit};
use kode_parser::diag::LineMap;
use kode_parser::model::{parse_alias, parse_def, parse_entities, parse_types};
use kode_parser::xml;
use kode_vfs::store::DocumentKey;

use crate::hover::{category_of, parent_dir, word_at, Category, HoverEngine};

// ---------------------------------------------------------------------------
// 响应模型(LSP Location 同形;serde camelCase 与 TS 对拍面同键)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LspPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

/// 一条定义落点:目标文件 + 区间(声明名 span 或文件首行)。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DefinitionLocation {
    pub uri: String,
    pub range: LspRange,
}

/// 字节偏移 → LSP 0 基 (line, UTF-16 character)(与 VS Code positionAt 同语义:
/// 行按 `\n` 切,`\r` 计入行内字符)。
pub(crate) fn byte_offset_to_position(text: &str, offset: usize) -> LspPosition {
    let offset = offset.min(text.len());
    let mut line = 0u32;
    let mut line_start = 0usize;
    for (idx, ch) in text.char_indices() {
        if idx >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            line_start = idx + 1;
        }
    }
    let character: u32 = text[line_start..offset]
        .chars()
        .map(|c| c.len_utf16() as u32)
        .sum();
    LspPosition { line, character }
}

/// 1 基行号(声明处)→ 行首落点(TS `new Position(line - 1, 0)` 同形)。
pub(crate) fn line_start_location(uri: &str, line1: usize) -> DefinitionLocation {
    let pos = LspPosition {
        line: line1 as u32 - 1,
        character: 0,
    };
    DefinitionLocation {
        uri: uri.to_string(),
        range: LspRange {
            start: pos.clone(),
            end: pos,
        },
    }
}

/// 文件首行落点(TS `Location(uri, Position(0, 0))` 同形)。
pub(crate) fn file_head_location(uri: &str) -> DefinitionLocation {
    line_start_location(uri, 1)
}

// ---------------------------------------------------------------------------
// 响应链(复用 HoverEngine 语料视图)
// ---------------------------------------------------------------------------

impl HoverEngine {
    /// 交互入口:UTF-16 position → 词 → 声明落点。未打开/未知词一律 None
    /// (LSP 允许),不报错不阻塞。
    pub fn definition(
        &self,
        key: &DocumentKey,
        text: &str,
        line: u32,
        character: u32,
    ) -> Option<DefinitionLocation> {
        if matches!(file_kind_of_uri(&key.uri), FileKind::Other) {
            return None;
        }
        let word = word_at(text, line, character)?;
        self.definition_word(key, text, &word, line as usize + 1, line, character)
    }

    /// 声明行入口(golden 生成用):声明行号(1 起)+ 词 → 落点。
    pub fn definition_at_line(
        &self,
        key: &DocumentKey,
        text: &str,
        line1: usize,
        word: &str,
    ) -> Option<DefinitionLocation> {
        self.definition_at_position(key, text, line1, 0, word)
    }

    /// 声明行+列入口(golden 生成用;RUST-137 批 1 起位置判定型探针带词首列,
    /// `<Type>`/`<of>`/`<Arg>`/`<Interfaces>` 臂在 golden 语境真正触发)。
    pub fn definition_at_position(
        &self,
        key: &DocumentKey,
        text: &str,
        line1: usize,
        character: u32,
        word: &str,
    ) -> Option<DefinitionLocation> {
        if matches!(file_kind_of_uri(&key.uri), FileKind::Other) {
            return None;
        }
        let line0 = line1 as u32 - 1;
        self.definition_word(key, text, word, line1, line0, character)
    }

    fn definition_word(
        &self,
        key: &DocumentKey,
        text: &str,
        word: &str,
        line1: usize,
        line0: u32,
        character: u32,
    ) -> Option<DefinitionLocation> {
        let path = key.uri.as_path();
        match file_kind_of_uri(&key.uri) {
            FileKind::Def => {
                let def = parse_def(text);
                // ①`<DetailLevel>` 取值词 → 本文件 `<DetailLevels>` 档位声明行
                // (TS findDetailLevelDefinitionInDef 同口径;gate 外,TS 生产
                // 链首臂同位)。
                if let Some(pos) = self.detail_level_landing(text, path, line0, character) {
                    return Some(pos);
                }
                // gate 域(TS findDefinitionReferenceInDef 顶部 looksLikeEntityName
                // 同拒:Parent/Type/Arg/Interfaces 四臂;内建类型与小写词 null)。
                let gate = looks_like_entity_name(word);
                // ②`<Parent>` 取值词 → 语料内父 def 首行(接口/组件目录规则
                // 与 chain_face 同源;语料缺失即 null)。
                if gate {
                    if let Some(parent) = def.parent.as_deref().filter(|p| !p.is_empty()) {
                        if word == parent {
                            if let Some(pos) = self.parent_landing(path, word) {
                                return Some(pos);
                            }
                        }
                    }
                    // ③`<Type>`/`<of>` 取值词 → 语料内 types 声明行(内建 null),
                    // 未命中回落 component/实体 def(RUST-137 批 1)。
                    if let Some(pos) = self.type_value_landing(key, text, line0, character, word) {
                        return Some(pos);
                    }
                }
                // ④段内声明词:Properties 声明词按 TS F12 落**注册**而非声明
                // span(声明 span 见 hover 面);三方法段声明词 → null(能力
                // 边界:py 脚本层/def 调用链是 TS 面,Rust 不虚构落点,服务
                // 轨道回落 TS 取 py 实现落点——demo def-to-cell/base/client
                // 验收面);组件段落 TS provider 链末尾返 null,不产出落点
                // (不单侧增强)。
                let (records, _) = extract_records(key, &ParsedUnit::Def(parse_def(text)));
                if let Some(record) = records.iter().find(|r| r.name == word && r.line == line1) {
                    return match record.kind {
                        SymbolKind::Property => Some(self.registry_landing(path)),
                        // 实体本体/组件/类型/别名在 .def 无 F12 落点(TS 同)。
                        _ => None,
                    };
                }
                // ⑤`<Arg>` 取值词 → 语料内实体 def 首行(RUST-137 批 1;gate 域)。
                if gate {
                    if let Some(pos) = self.arg_value_landing(key, text, line0, character, word) {
                        return Some(pos);
                    }
                    // ⑥`<Interfaces>` 段内词 → interfaces 目录 def 首行
                    // (RUST-137 批 1;gate 域)。
                    if let Some(pos) = self.interfaces_segment_landing(text, path, line0, character, word) {
                        return Some(pos);
                    }
                }
                None
            }
            FileKind::Entities => {
                let entities = parse_entities(text);
                let _entry = entities
                    .entities
                    .iter()
                    .find(|e| e.name == word && e.line == line1)?;
                // KBUG-ROOT:候选按查询方根定域;唯一候选才落点,同根同名
                // 多候选歧义不硬猜首见 → null(TS 面兜底)。
                let candidates = self.def_candidates(key.root, word);
                let def_path = if candidates.len() == 1 {
                    Some(&candidates[0])
                } else {
                    None
                }?;
                Some(file_head_location(def_path))
            }
            FileKind::Types => {
                let types = parse_types(text);
                if let Some(decl) = types
                    .types
                    .iter()
                    .find(|t| t.name == word && t.line == line1)
                {
                    return Some(line_start_location(path, decl.line));
                }
                // RUST-137 批 1:`<Type>` 取值词面(TS findTypeValueDefinitionInTypesXml
                // 同构,无 gate——TS types.xml 分支不经 findDefinitionReferenceInDef):
                // 本文件顶层声明行(findCurrentDocumentCustomTypeReference 同口径;
                // 同 root types 条目链与其同效,合并)→ component/entity 回落;
                // 无落点 null。implementedBy 值词(py 符号行)属能力边界,不触发
                // 本臂(位置判定只认 `<Type>` 元素),null 回落 TS。
                if types_type_value_at(text, line0, character) {
                    if let Some(decl) = types.types.iter().find(|t| t.name == word) {
                        return Some(line_start_location(path, decl.line));
                    }
                    return self.category_def_landing(key, word);
                }
                None
            }
            FileKind::Alias => {
                let aliases = parse_alias(text);
                let alias = aliases
                    .aliases
                    .iter()
                    .find(|a| a.name == word && a.line == line1)?;
                Some(line_start_location(path, alias.line))
            }
            FileKind::Other => None,
        }
    }

    /// `<DetailLevel>` 取值内且词命中本文件 `<DetailLevels>` 档位名 →
    /// 档位声明行行首(TS findDetailLevelDefinitionInDef 同口径)。
    fn detail_level_landing(
        &self,
        text: &str,
        path: &str,
        line0: u32,
        character: u32,
    ) -> Option<DefinitionLocation> {
        let doc = xml::parse(text, false);
        let root = doc.root()?;
        let offset = position_to_byte_offset(text, line0, character);
        let node = deepest_element_at(&doc, root, offset)?;
        if !doc.element(node).name.eq_ignore_ascii_case("DetailLevel") {
            return None;
        }
        let levels = doc
            .child_elements(root)
            .into_iter()
            .find(|&c| doc.element(c).name.eq_ignore_ascii_case("DetailLevels"))?;
        let lines = LineMap::new(text);
        let word = word_at(text, line0, character).unwrap_or_default();
        for child in doc.child_elements(levels) {
            let el = doc.element(child);
            // 档位内文本只在词命中时才落点(与 TS 的 word 相等判定同口径)。
            if el.name == word {
                // line_of 为 1 基行号;line_start_location 已按 0 基 LSP 行折算,
                // 不能再 +1(否则落点偏下一行)。
                return Some(line_start_location(path, lines.line_of(el.name_span.start)));
            }
        }
        None
    }

    /// `Properties`/三方法段的注册落点(TS F12 第一层之后的语料层):
    /// entities.xml 同名实体声明行;缺注册 → 本文件首行。Python 脚本层与
    /// 数据库 schema 层是无此能力的面,跳过(见模块注释)。
    fn registry_landing(&self, path: &str) -> DefinitionLocation {
        if let Some(entity) = def_entity_name(path) {
            if let Some(defs_root) = self.defs_root(path) {
                let mut candidates = Vec::new();
                if let Some(scripts_root) = parent_dir(&defs_root) {
                    candidates.push(format!("{scripts_root}/entities.xml"));
                }
                candidates.push(format!("{defs_root}/entities.xml"));
                for cand in candidates {
                    if let Some(file) = self.entities_files.get(&cand) {
                        if let Some(entry) = file.entities.iter().find(|e| e.name == entity) {
                            return line_start_location(&cand, entry.line);
                        }
                    }
                }
            }
        }
        file_head_location(path)
    }

    /// `<Parent>` 取值 → 语料内父 def 首行。目录规则与 chain_face 同源:
    /// 接口文件父回落 interfaces 目录,组件槽父回落 components 目录。
    fn parent_landing(&self, path: &str, parent: &str) -> Option<DefinitionLocation> {
        let defs_root = self.defs_root(path)?;
        let parent_dir = match category_of(&defs_root, path) {
            Category::Component => format!("{defs_root}/components"),
            _ => defs_root,
        };
        let parent_path = format!("{parent_dir}/{parent}.def");
        if !self.corpus_defs.contains(&parent_path) {
            return None;
        }
        Some(file_head_location(&parent_path))
    }

    /// 位置(UTF-16)落在 `<Type>`/`<of>` 取值内且词命中类型名 → 语料内
    /// types.xml 声明行首落点。内建类型无定义文件(引擎 C++ 内建)→ None;
    /// types 未命中回落 component/实体 def(TS findTypeValueDefinitionReference
    /// 顺序 type 条目 → component → entity 的语料化;RUST-137 批 1,gate 在调用方)。
    fn type_value_landing(
        &self,
        key: &DocumentKey,
        text: &str,
        line0: u32,
        character: u32,
        word: &str,
    ) -> Option<DefinitionLocation> {
        if is_builtin_type(word) {
            return None;
        }
        let byte_offset = position_to_byte_offset(text, line0, character);
        let doc = xml::parse(text, true);
        let root = doc.root()?;
        let node = deepest_element_at(&doc, root, byte_offset)?;
        let name = &doc.element(node).name;
        if name != "Type" && name != "of" {
            return None;
        }
        let content = doc.element(node).content_span;
        if byte_offset < content.start || byte_offset > content.end {
            return None;
        }
        // 语料内 types 声明查找:路径字典序首见(与 TS 语料序首见同口径)。
        for (tpath, types) in &self.types_files {
            if let Some(decl) = types.types.iter().find(|t| t.name == word) {
                return Some(line_start_location(tpath, decl.line));
            }
        }
        self.category_def_landing(key, word)
    }

    /// `<Arg>` 取值内词 → 语料内同名实体 def 首行(TS isPositionInsideTagValue
    /// 'Arg' + findEntityDefinitionFile 同构;root 定域唯一候选才落,同根同名
    /// 歧义不硬猜 → null)。gate 在调用方(RUST-137 批 1)。
    fn arg_value_landing(
        &self,
        key: &DocumentKey,
        text: &str,
        line0: u32,
        character: u32,
        word: &str,
    ) -> Option<DefinitionLocation> {
        let byte_offset = position_to_byte_offset(text, line0, character);
        let doc = xml::parse(text, true);
        let root = doc.root()?;
        let node = deepest_element_at(&doc, root, byte_offset)?;
        if doc.element(node).name != "Arg" {
            return None;
        }
        let content = doc.element(node).content_span;
        if byte_offset < content.start || byte_offset > content.end {
            return None;
        }
        let candidates = self.def_candidates(key.root, word);
        let def_path = if candidates.len() == 1 {
            Some(&candidates[0])
        } else {
            None
        }?;
        Some(file_head_location(def_path))
    }

    /// `<Interfaces>` 段内(任一后代元素跨度上,含起止标签)的词 → 语料内
    /// `<defs_root>/interfaces/<word>.def` 首行。TS isPositionInsideChildTag
    /// ('Interfaces') + findDefinitionFileByCategory('interface') 同构
    /// (TS interfacesRoot = entityDefsRoot/interfaces 单规则;fs 存在性检查
    /// 语料化为 corpus_defs 判定)。gate 在调用方(RUST-137 批 1)。
    fn interfaces_segment_landing(
        &self,
        text: &str,
        path: &str,
        line0: u32,
        character: u32,
        word: &str,
    ) -> Option<DefinitionLocation> {
        let byte_offset = position_to_byte_offset(text, line0, character);
        let doc = xml::parse(text, true);
        let root = doc.root()?;
        let (_hit, chain) = deepest_element_with_chain(&doc, root, byte_offset)?;
        if !chain
            .iter()
            .any(|&n| doc.element(n).name == "Interfaces")
        {
            return None;
        }
        let defs_root = self.entity_defs_root(path)?;
        let iface = format!("{defs_root}/interfaces/{word}.def");
        if !self.corpus_defs.contains(&iface) {
            return None;
        }
        Some(file_head_location(&iface))
    }

    /// TS findTypeValueDefinitionReference 的 component/entity 回落(语料化;
    /// RUST-137 批 1):本 root `components/<word>.def` 存在 → 文件首行;
    /// 否则实体 def(root 定域唯一候选,歧义 null——与 entities 面
    /// def_candidates 同口径)。TS findEntityDefinitionFile 已对拍语义
    /// (entities 面在用),components 半边对应 findDefinitionFileByCategory
    /// ('component') 的 layout.componentsRoot/<word>.def 存在性检查。
    fn category_def_landing(&self, key: &DocumentKey, word: &str) -> Option<DefinitionLocation> {
        let path = key.uri.as_path();
        if let Some(defs_root) = self.entity_defs_root(path) {
            let comp = format!("{defs_root}/components/{word}.def");
            if self.corpus_defs.contains(&comp) {
                return Some(file_head_location(&comp));
            }
        }
        let candidates = self.def_candidates(key.root, word);
        if let [only] = candidates {
            return Some(file_head_location(only));
        }
        None
    }

    /// entity_defs 根解析(TS layout.entityDefsRoot 同口径):`entity_defs/`
    /// 内文件经 defs_root 已取该目录;types.xml 等非 def 文件的 defs_root
    /// 返回 entities 目录本身,此处统一折算 `{entities_dir}/entity_defs`
    /// (目录在语料中存在才算——corpus 有其下任一 def)。RUST-137 批 1。
    pub(crate) fn entity_defs_root(&self, path: &str) -> Option<String> {
        let defs_root = self.defs_root(path)?;
        if path.starts_with(&format!("{defs_root}/")) {
            return Some(defs_root.to_string());
        }
        let candidate = format!("{defs_root}/entity_defs");
        if self
            .corpus_defs
            .iter()
            .any(|p| p.starts_with(&format!("{candidate}/")))
        {
            Some(candidate)
        } else {
            None
        }
    }
}

/// TS looksLikeEntityName 同构:非内建类型 && 首字母 ASCII 大写、其余
/// ASCII 字母/数字/下划线(gate 域 = TS findDefinitionReferenceInDef 顶部
/// 同拒;RUST-137 批 1 起既有 Parent/Type 臂一并挂 gate 对齐)。
pub(crate) fn looks_like_entity_name(word: &str) -> bool {
    if is_builtin_type(word) {
        return false;
    }
    let mut chars = word.chars();
    match chars.next() {
        Some(c) if c.is_ascii_uppercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// types.xml 的 `<Type>` 元素取值内位置判定(TS isPositionInsideTagValue
/// 'Type' 同构;只认 `Type` 精确名——implementedBy 值不触发)。RUST-137 批 1。
fn types_type_value_at(text: &str, line0: u32, character: u32) -> bool {
    let byte_offset = position_to_byte_offset(text, line0, character);
    let doc = xml::parse(text, true);
    let Some(root) = doc.root() else {
        return false;
    };
    let Some(node) = deepest_element_at(&doc, root, byte_offset) else {
        return false;
    };
    if doc.element(node).name != "Type" {
        return false;
    }
    let content = doc.element(node).content_span;
    byte_offset >= content.start && byte_offset <= content.end
}

/// 内建类型表(与 TS kbengineMetadata::KBENGINE_TYPES 同表,ARRAY/FIXED_DICT
/// 容器含)。
pub(crate) const BUILTIN_TYPES: &[&str] = &[
    "UINT8",
    "UINT16",
    "UINT32",
    "UINT64",
    "INT8",
    "INT16",
    "INT32",
    "INT64",
    "FLOAT",
    "DOUBLE",
    "STRING",
    "UNICODE",
    "VECTOR2",
    "VECTOR3",
    "VECTOR4",
    "ENTITYCALL",
    "PYTHON",
    "PY_DICT",
    "PY_TUPLE",
    "PY_LIST",
    "BLOB",
    "ARRAY",
    "FIXED_DICT",
];

pub(crate) fn is_builtin_type(name: &str) -> bool {
    BUILTIN_TYPES.contains(&name)
}

/// UTF-16 (line, character) → 字节偏移(clamp 到行尾/文末,不 panic)。
pub(crate) fn position_to_byte_offset(text: &str, line0: u32, character: u32) -> usize {
    let lines = LineMap::new(text);
    let line_index = (line0 as usize).min(lines.line_count() - 1);
    let line_start = line_start_of(text, line_index);
    let line_end = text[line_start..]
        .find('\n')
        .map(|n| line_start + n)
        .unwrap_or(text.len());
    let mut utf16 = 0u32;
    for (idx, ch) in text[line_start..line_end].char_indices() {
        if utf16 >= character {
            return line_start + idx;
        }
        utf16 += ch.len_utf16() as u32;
    }
    line_end
}

fn line_start_of(text: &str, line_index: usize) -> usize {
    let mut line = 0usize;
    if line == line_index {
        return 0;
    }
    for (idx, ch) in text.char_indices() {
        if ch == '\n' {
            line += 1;
            if line == line_index {
                return idx + 1;
            }
        }
    }
    text.len()
}

/// 深度优先找包含字节偏移的最深元素(偏移落在 [open_span.start, close_span.end])。
fn deepest_element_at(doc: &xml::Document, node: usize, offset: usize) -> Option<usize> {
    let data = doc.element(node);
    if offset < data.open_span.start || offset > data.close_span.end {
        return None;
    }
    for &child in &data.children {
        if let NodeHit::Element(found) = probe_node(doc, child, offset) {
            if let Some(deeper) = deepest_element_at(doc, found, offset) {
                return Some(deeper);
            }
            return Some(found);
        }
    }
    Some(node)
}

/// 同 deepest_element_at,附根→自身的祖先链(元素节点序;TS findAncestorElement
/// 含自身的祖先判定同域)。RUST-137 批 1(`<Interfaces>` 段判定)。
pub(crate) fn deepest_element_with_chain(
    doc: &xml::Document,
    node: usize,
    offset: usize,
) -> Option<(usize, Vec<usize>)> {
    let data = doc.element(node);
    if offset < data.open_span.start || offset > data.close_span.end {
        return None;
    }
    for &child in &data.children {
        if let NodeHit::Element(found) = probe_node(doc, child, offset) {
            let (hit, chain) = deepest_element_with_chain(doc, found, offset)
                .unwrap_or((found, vec![found]));
            let mut full = vec![node];
            full.extend(chain);
            return Some((hit, full));
        }
    }
    Some((node, vec![node]))
}

enum NodeHit {
    Element(usize),
    Miss,
}

fn probe_node(doc: &xml::Document, node: usize, offset: usize) -> NodeHit {
    match &doc.nodes[node].data {
        xml::NodeData::Element(data) => {
            if offset >= data.open_span.start && offset <= data.close_span.end {
                NodeHit::Element(node)
            } else {
                NodeHit::Miss
            }
        }
        _ => NodeHit::Miss,
    }
}

// ---------------------------------------------------------------------------
// 对拍 golden(只写不读;TS 侧 tests/kodeDefinitionParity.test.ts 复算)
// ---------------------------------------------------------------------------

/// golden 文件名(仓库相对)。
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/definition-parity.json";

#[derive(Debug, serde::Serialize)]
struct GoldenDefinition {
    line: usize,
    character: u32,
    word: String,
    definition: DefinitionLocation,
}

/// golden 探针:(1 基行,UTF-16 列,词)。位置判定型臂(Type/of、Arg 取值词、
/// Interfaces 段词)带词首/标签首列,词比对型臂(Parent、声明词)列 = 0。
#[derive(Debug, Clone, PartialEq, Eq)]
struct GoldenProbe {
    line: usize,
    character: u32,
    word: String,
}

/// 元素文本内容首 token 探针(词首行列;TS 镜像
/// `getElementText(node).trim().split(/\s+/)[0]` + contentStart 前导空白同算术)。
fn value_token_probe(doc: &xml::Document, node: usize, text: &str) -> Option<GoldenProbe> {
    let el = doc.element(node);
    let content = text.get(el.content_span.start..el.content_span.end)?;
    let trimmed = content.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    let token_end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let lead = content.len() - trimmed.len();
    let pos = byte_offset_to_position(text, el.content_span.start + lead);
    Some(GoldenProbe {
        line: pos.line as usize + 1,
        character: pos.character,
        word: trimmed[..token_end].to_string(),
    })
}

/// 先序遍历全部元素节点(文本节点不递归)。
fn walk_elements(doc: &xml::Document, node: usize, visit: &mut impl FnMut(usize)) {
    visit(node);
    for &child in &doc.element(node).children {
        if matches!(doc.nodes[child].data, xml::NodeData::Element(_)) {
            walk_elements(doc, child, visit);
        }
    }
}

/// 探针定序(行,列,词 全序;TS 镜像同键)+ 去重相邻全等项。
fn order_probes(mut probes: Vec<GoldenProbe>) -> Vec<GoldenProbe> {
    probes.sort_by(|a, b| {
        (&a.line, &a.character, &a.word).cmp(&(&b.line, &b.character, &b.word))
    });
    probes.dedup();
    probes
}

#[derive(Debug, serde::Serialize)]
struct GoldenFile {
    file: String,
    kind: String,
    definitions: Vec<GoldenDefinition>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    file_count: usize,
    definition_count: usize,
    files: Vec<GoldenFile>,
}

/// 整个语料的 definition golden JSON(每文件:声明符号 + Parent/Type 取值探针)。
pub fn dump_definition_golden(repo_root: &std::path::Path) -> String {
    use kode_parser::json::{collect_corpus, PARITY_CORPORA};

    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let registry = crate::golden_corpus::corpus_registry();
    let mut engine = HoverEngine::new();
    // 先全量入库(字典序 = TS 语料序;键 = 各语料工程根,KBUG-ROOT 隔离)。
    for (path, (_kind, text)) in &files {
        engine.update(crate::golden_corpus::corpus_key(&registry, path), text);
    }
    let mut dump = GoldenDump {
        generator: "kode-server dump-definition-golden",
        file_count: files.len(),
        definition_count: 0,
        files: Vec::new(),
    };
    for (path, (kind, text)) in &files {
        let key = crate::golden_corpus::corpus_key(&registry, path);
        let mut probes: Vec<GoldenProbe> = Vec::new();
        match *kind {
            "def" => {
                let def = parse_def(text);
                if let Some(parent) = &def.parent {
                    if !parent.is_empty() {
                        // 探针行 = `<Parent>` 出现行(取值词触发面;词比对臂,列 0)。
                        if let Some(idx) = text.lines().position(|l| l.contains(parent)) {
                            probes.push(GoldenProbe {
                                line: idx + 1,
                                character: 0,
                                word: parent.clone(),
                            });
                        }
                    }
                }
                let unit = ParsedUnit::Def(parse_def(text));
                let (records, _) = extract_records(&key, &unit);
                for record in &records {
                    probes.push(GoldenProbe {
                        line: record.line,
                        character: 0,
                        word: record.name.clone(),
                    });
                }
                // RUST-137 批 1 位置判定型探针:全树 `<Type>`/`<of>`/`<Arg>` 取值
                // 词 + `<Interfaces>` 段内元素的内容首词(词首行列,生产触发面
                // 是取值词而非元素名)——既有属性 Type 词探针(声明行+列 0)由
                // 本采集取代,类型落点面在 golden 语境真正触发。
                let doc = xml::parse(text, true);
                if let Some(root) = doc.root() {
                    let mut value_tags: Vec<usize> = Vec::new();
                    let mut interface_segments: Vec<usize> = Vec::new();
                    walk_elements(&doc, root, &mut |node| {
                        match doc.element(node).name.as_str() {
                            "Type" | "of" | "Arg" => value_tags.push(node),
                            "Interfaces" => interface_segments.push(node),
                            _ => {}
                        }
                    });
                    for node in value_tags {
                        if let Some(probe) = value_token_probe(&doc, node, text) {
                            probes.push(probe);
                        }
                    }
                    for segment in interface_segments {
                        // 生产臂语义 = 取值词(光标在 `<interface> ROLE </interface>`
                        // 的 ROLE 上,F12 word=ROLE);探针取段内元素的内容首词,
                        // 元素名本身(interface,小写)会被 gate 拒、非生产触发面。
                        walk_elements(&doc, segment, &mut |inner| {
                            if inner != segment {
                                if let Some(probe) = value_token_probe(&doc, inner, text) {
                                    probes.push(probe);
                                }
                            }
                        });
                    }
                }
            }
            "entities" => {
                for entry in parse_entities(text).entities {
                    probes.push(GoldenProbe {
                        line: entry.line,
                        character: 0,
                        word: entry.name,
                    });
                }
            }
            "types" => {
                for decl in parse_types(text).types {
                    probes.push(GoldenProbe {
                        line: decl.line,
                        character: 0,
                        word: decl.name,
                    });
                }
                // RUST-137 批 1:全树 `<Type>` 取值词探针(嵌套 FIXED_DICT 字段;
                // 词首行列,findTypeValueDefinitionInTypesXml 触发面)。
                let doc = xml::parse(text, true);
                if let Some(root) = doc.root() {
                    walk_elements(&doc, root, &mut |node| {
                        if doc.element(node).name == "Type" {
                            if let Some(probe) = value_token_probe(&doc, node, text) {
                                probes.push(probe);
                            }
                        }
                    });
                }
            }
            "alias" => {
                for alias in parse_alias(text).aliases {
                    probes.push(GoldenProbe {
                        line: alias.line,
                        character: 0,
                        word: alias.name,
                    });
                }
            }
            _ => {}
        }
        let probes = order_probes(probes);
        let mut definitions = Vec::new();
        for probe in probes {
            if let Some(definition) =
                engine.definition_at_position(&key, text, probe.line, probe.character, &probe.word)
            {
                definitions.push(GoldenDefinition {
                    line: probe.line,
                    character: probe.character,
                    word: probe.word,
                    definition,
                });
            }
        }
        dump.definition_count += definitions.len();
        dump.files.push(GoldenFile {
            file: path.clone(),
            kind: kind.to_string(),
            definitions,
        });
    }
    serde_json::to_string(&dump).expect("serialize definition golden")
}
