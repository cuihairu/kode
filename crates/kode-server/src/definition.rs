//! definition 响应链(Phase2 首片,书 §17 PR-010 定义面 / LSP 系列)。
//!
//! 面 = **语料声明落点**:UTF-16 position → 词 → 声明处的 LSP Location。
//! 复用 hover 的定位基建(word_at)与 HoverEngine 语料视图(纯内存、零 IO,
//! ARCH-012 红线同 hover)。四类文档的落点口径:
//! - `.def`:按 TS F12 provider 链的**落点语义**逐层同构 —
//!   ①`<DetailLevel>` 取值词 → 本文件 `<DetailLevels>` 档位声明行;
//!   ②`Properties` 段声明词 → 注册回落(entities.xml 声明行,缺则本文件首行);
//!   ③三方法段声明词 → 注册回落(同上);④`<Parent>` 取值词 → 语料内父/
//!   接口/组件 def 文件首行(缺失即 null,绝不虚构);⑤`<Type>`/`<of>` 取值词
//!   → 语料内 types.xml 声明行(内建类型无定义文件,null);⑥`Components`
//!   段声明词 → null(TS provider 链末尾同 null,不做单侧增强)。
//!   ②③ 的 Python 脚本层与数据库 schema 层是 Rust 无此能力的面(.py 面 /
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

use kode_index::symbol::{def_entity_name, extract_records, SymbolKind};
use kode_parser::dep::{file_kind_of_uri, FileKind, ParsedUnit};
use kode_parser::diag::LineMap;
use kode_parser::model::{parse_alias, parse_def, parse_entities, parse_types};
use kode_parser::xml;
use kode_vfs::store::{DocumentKey, RootId};

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
fn line_start_location(uri: &str, line1: usize) -> DefinitionLocation {
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
fn file_head_location(uri: &str) -> DefinitionLocation {
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
        if matches!(file_kind_of_uri(&key.uri), FileKind::Other) {
            return None;
        }
        let line0 = line1 as u32 - 1;
        self.definition_word(key, text, word, line1, line0, 0)
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
                // (TS findDetailLevelDefinitionInDef 同口径)。
                if let Some(pos) = self.detail_level_landing(text, path, line0, character) {
                    return Some(pos);
                }
                // ②`<Parent>` 取值词 → 语料内父 def 首行(接口/组件目录规则
                // 与 chain_face 同源;语料缺失即 null)。
                if let Some(parent) = def.parent.as_deref().filter(|p| !p.is_empty()) {
                    if word == parent {
                        return self.parent_landing(path, word);
                    }
                }
                // ③`<Type>`/`<of>` 取值词 → 语料内 types 声明行(内建 null)。
                if let Some(pos) = self.type_value_landing(text, line0, character, word) {
                    return Some(pos);
                }
                // ④段内声明词:Properties/三方法段按 TS F12 落**注册**而非
                // 声明 span(声明 span 见 hover 面);组件段落 TS provider 链
                // 末尾返 null,不产出落点(不单侧增强)。
                let (records, _) = extract_records(key, &ParsedUnit::Def(parse_def(text)));
                let record = records.iter().find(|r| r.name == word && r.line == line1)?;
                match record.kind {
                    SymbolKind::Property | SymbolKind::Method => Some(self.registry_landing(path)),
                    // 实体本体/组件/类型/别名在 .def 无 F12 落点(TS 同)。
                    _ => None,
                }
            }
            FileKind::Entities => {
                let entities = parse_entities(text);
                let _entry = entities
                    .entities
                    .iter()
                    .find(|e| e.name == word && e.line == line1)?;
                let def_path = self.def_by_name.get(word)?;
                Some(file_head_location(def_path))
            }
            FileKind::Types => {
                let types = parse_types(text);
                let decl = types
                    .types
                    .iter()
                    .find(|t| t.name == word && t.line == line1)?;
                Some(line_start_location(path, decl.line))
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
                return Some(line_start_location(
                    path,
                    lines.line_of(el.name_span.start) + 1,
                ));
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
    /// types.xml 声明行首落点。内建类型无定义文件(引擎 C++ 内建)→ None。
    fn type_value_landing(
        &self,
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
        None
    }
}

/// 内建类型表(与 TS kbengineMetadata::KBENGINE_TYPES 同表,ARRAY/FIXED_DICT
/// 容器含)。
pub(crate) fn is_builtin_type(name: &str) -> bool {
    matches!(
        name,
        "UINT8"
            | "UINT16"
            | "UINT32"
            | "UINT64"
            | "INT8"
            | "INT16"
            | "INT32"
            | "INT64"
            | "FLOAT"
            | "DOUBLE"
            | "STRING"
            | "UNICODE"
            | "VECTOR2"
            | "VECTOR3"
            | "VECTOR4"
            | "ENTITYCALL"
            | "PYTHON"
            | "PY_DICT"
            | "PY_TUPLE"
            | "PY_LIST"
            | "BLOB"
            | "ARRAY"
            | "FIXED_DICT"
    )
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
    word: String,
    definition: DefinitionLocation,
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
    let mut engine = HoverEngine::new();
    // 先全量入库(字典序 = TS 语料序,首写优先口径一致)。
    for (path, (_kind, text)) in &files {
        let key = DocumentKey::new(
            RootId::UNROOTED,
            kode_vfs::uri::CanonicalUri::from_path(path),
        );
        engine.update(key, text);
    }
    let mut dump = GoldenDump {
        generator: "kode-server dump-definition-golden",
        file_count: files.len(),
        definition_count: 0,
        files: Vec::new(),
    };
    for (path, (kind, text)) in &files {
        let key = DocumentKey::new(
            RootId::UNROOTED,
            kode_vfs::uri::CanonicalUri::from_path(path),
        );
        let mut probes: Vec<(usize, String)> = Vec::new();
        match *kind {
            "def" => {
                let def = parse_def(text);
                if let Some(parent) = &def.parent {
                    if !parent.is_empty() {
                        // 探针行 = `<Parent>` 出现行(取值词触发面)。
                        if let Some(idx) = text.lines().position(|l| l.contains(parent)) {
                            probes.push((idx + 1, parent.clone()));
                        }
                    }
                }
                for prop in &def.properties {
                    if let Some(t) = &prop.type_name {
                        probes.push((prop.line, t.clone()));
                    }
                }
                let unit = ParsedUnit::Def(parse_def(text));
                let (records, _) = extract_records(&key, &unit);
                for record in &records {
                    probes.push((record.line, record.name.clone()));
                }
            }
            "entities" => {
                for entry in parse_entities(text).entities {
                    probes.push((entry.line, entry.name));
                }
            }
            "types" => {
                for decl in parse_types(text).types {
                    probes.push((decl.line, decl.name));
                }
            }
            "alias" => {
                for alias in parse_alias(text).aliases {
                    probes.push((alias.line, alias.name));
                }
            }
            _ => {}
        }
        probes.sort_by_key(|(line, _)| *line);
        probes.dedup();
        let mut definitions = Vec::new();
        for (line1, word) in probes {
            if let Some(definition) = engine.definition_at_line(&key, text, line1, &word) {
                definitions.push(GoldenDefinition {
                    line: line1,
                    word,
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
