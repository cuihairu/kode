//! completion 请求链路(PR-011,书 §8 LSP-005 / §17 PR-011 基础版)。
//!
//! 任务分发提到的「COMP-001..0xx」在书 KODE_2_COMPLETE_TODO.md 中无该前缀
//! 条目(§8 为 LSP 系列):本模块按 §17 PR-011 原文 + LSP-005 落地,链面编号
//! 在 docs/kode2/pr-011.md 内定义并逐条映射书条目,不冒领。
//!
//! 请求链(URI → position → 上下文 → 条目集),全部纯同步、零 IO(ARCH-012
//! 红线同 hover:只碰本文件已持有文本与已入库语料视图,无磁盘扫描):
//! - 定位:UTF-16 character → 行前缀(与 TS 行前缀判面同口径);
//! - 上下文:行前缀片段(fragment)+ 完整标签栈(光标以上逐行扫描)判面;
//! - 条目集(六面,与 PR-007 符号面/PR-008 类型面同源):
//!   实体(def 语料注册名)、属性(类型灰字)、方法分面(base/cell/client)、
//!   类型(types.xml 声明)、别名(alias.xml 指向)、继承成员(def 链祖先的
//!   属性/方法,inheritedFrom 显式标注;同名被本类/先出项遮蔽,不重复出项)。
//!
//! 判面规则(与 TS 双轨对拍逐条对应,见 tests/kodeCompletionParity.test.ts):
//! - 开标签上下文:行前缀以 `<片段` 结尾,光标以上标签栈顶为
//!   `Properties` → 属性面;`Base/Cell/ClientMethods` → 方法面(仅本分面);
//!   `Components` → 实体面(组件类型即 def 名);entities.xml 的 `root` 顶
//!   → 实体面;其余栈顶(接口段/属性子标签/def 顶层)不接管 → None;
//! - 取值上下文:行前缀为 `<Parent>` 后随空白+片段 → 实体面;
//!   `<Type>`/`<Arg>`/`<of>` 后随空白+片段 → 类型面 + 别名面(TS
//!   `<(Type|Arg|of)>` 触发面同口径);
//! - 过滤:fragment 大小写敏感 startsWith(确定性优先,双轨同规则);
//! - 类型面/别名面去重:同名首见保留(语料路径字典序 = 首写优先)。
//!
//! 对拍:TS 侧 `tests/kodeCompletionParity.test.ts` 用 defParser/defChain 等
//! 现有原语独立复算同一语料的补全面,与 [`dump_completion_golden`] 生成的
//! golden 逐字段比对(双向门禁,PR-005/007/008/010 同构)。
//! 切流:本单不做——TS provider 保持既有链路,无默认开关(PR-012 门禁后)。

use serde::Serialize;
use serde_json::Value;

use kode_index::symbol::def_entity_name;
use kode_parser::dep::{file_kind_of_uri, FileKind};
use kode_parser::model::{parse_def, DefFile, MethodSection, TypeKind};
use kode_vfs::store::DocumentKey;

use crate::hover::HoverEngine;

// ---------------------------------------------------------------------------
// 响应模型(结构化面;LSP items 只投影 label/kind/detail,非对拍面)
// ---------------------------------------------------------------------------

/// 一条补全响应:判定的上下文 + 有序条目集。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResponse {
    pub context: CompletionContextFace,
    pub items: Vec<CompletionItemFace>,
}

/// 上下文面:判定依据全量呈现(对拍两侧同形)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionContextFace {
    /// "openTag"(行前缀 `<片段`)| "value"(`<Tag> 片段`)。
    pub kind: &'static str,
    /// 所属段:Properties/BaseMethods/CellMethods/ClientMethods/Components/
    /// Entity(`<Parent>` 取值)/Types(`<Type>` 等取值)/Entities(entities.xml
    /// root 直下)。
    pub section: &'static str,
    /// 方法分面(base/cell/client);非方法面为 None。
    pub facet: Option<&'static str>,
    /// 当前 def 实体名(def 文件);entities.xml 为 None。
    pub entity: Option<String>,
    /// 光标前已敲的片段(fragment;开标签不含 `<`)。
    pub fragment: String,
}

/// 一条补全条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionItemFace {
    pub label: String,
    /// entity | property | method | type | alias(与 PR-007 符号种类同字面量)。
    pub kind: &'static str,
    /// 方法分面。
    pub facet: Option<&'static str>,
    /// 属性:类型;类型:kind(fixedDict/array/builtin);别名:指向;
    /// 实体:def 语料路径。
    pub detail: Option<String>,
    /// 继承成员:来源祖先实体名;本类声明为 None。
    pub inherited_from: Option<String>,
}

/// LSP items 投影(label/kind/detail;CompletionItemKind 数值):
/// method=2,type/entity/alias=7(Class),property=10(Property)。
pub fn to_lsp_items(response: &CompletionResponse) -> Value {
    let items: Vec<Value> = response
        .items
        .iter()
        .map(|item| {
            let kind = match item.kind {
                "method" => 2,
                "property" => 10,
                _ => 7,
            };
            let mut obj = serde_json::json!({ "label": item.label, "kind": kind });
            if let Some(detail) = &item.detail {
                obj["detail"] = Value::String(detail.clone());
            }
            obj
        })
        .collect();
    serde_json::json!({ "isIncomplete": false, "items": items })
}

// ---------------------------------------------------------------------------
// 引擎入口(挂在 HoverEngine 的语料视图上,零额外状态)
// ---------------------------------------------------------------------------

impl HoverEngine {
    /// LSP 入口:UTF-16 position → 判面 → 条目集。未判定上下文返回 None
    /// (server 回 null 结果,不报错不阻塞)。
    pub fn completion(
        &self,
        key: &DocumentKey,
        text: &str,
        line0: u32,
        character: u32,
    ) -> Option<CompletionResponse> {
        if matches!(file_kind_of_uri(&key.uri), FileKind::Other) {
            return None;
        }
        let col = char_col_of(text, line0, character)?;
        self.complete_at(key, text, line0, col)
    }

    /// 判面 + 条目集主体(col = 行内 char 列,0 起)。
    fn complete_at(
        &self,
        key: &DocumentKey,
        text: &str,
        line0: u32,
        col: usize,
    ) -> Option<CompletionResponse> {
        let path = key.uri.as_path();
        let prefix = line_prefix(text, line0, col)?;
        let (head, fragment, open_tag) = split_fragment(&prefix);
        if open_tag {
            // 开标签上下文:光标以上标签栈顶决定条目集。
            let stack = tag_stack(&lines_above(text, line0));
            let top = stack.last()?;
            match file_kind_of_uri(&key.uri) {
                FileKind::Def => match top.as_str() {
                    "Properties" => {
                        let entity = def_entity_name(path)?;
                        let def = parse_def(text);
                        Some(self.members_response(
                            "openTag",
                            "Properties",
                            None,
                            path,
                            &entity,
                            &fragment,
                            &def,
                        ))
                    }
                    "BaseMethods" | "CellMethods" | "ClientMethods" => {
                        let entity = def_entity_name(path)?;
                        let facet = facet_of_section(top);
                        let def = parse_def(text);
                        Some(self.members_response(
                            "openTag",
                            facet_section_of(facet),
                            Some(facet),
                            path,
                            &entity,
                            &fragment,
                            &def,
                        ))
                    }
                    "Components" => {
                        Some(self.entities_response("openTag", "Components", &fragment))
                    }
                    _ => None,
                },
                FileKind::Entities if top == "root" => {
                    Some(self.entities_response("openTag", "Entities", &fragment))
                }
                _ => None,
            }
        } else {
            // 取值上下文:行前缀 `<Tag>` 后随(空白)+片段;片段已剥离,
            // 标签后余文必须是纯空白,否则不是取值位。
            let trimmed = head.trim_start();
            let (section, kind_ctx) = if let Some(rest) = trimmed.strip_prefix("<Parent>") {
                if !rest.chars().all(char::is_whitespace) {
                    return None;
                }
                ("Entity", "entity")
            } else if let Some((tag, rest)) = ["<Type>", "<Arg>", "<of>"]
                .iter()
                .find_map(|tag| trimmed.strip_prefix(tag).map(|rest| (*tag, rest)))
            {
                if !rest.chars().all(char::is_whitespace) {
                    return None;
                }
                let _ = tag;
                ("Types", "type")
            } else {
                return None;
            };
            let entity = if matches!(file_kind_of_uri(&key.uri), FileKind::Def) {
                def_entity_name(path)
            } else {
                None
            };
            let mut items = Vec::new();
            if kind_ctx == "entity" {
                self.push_entity_items(&mut items, &fragment);
            } else {
                self.push_type_items(&mut items, &fragment);
                self.push_alias_items(&mut items, &fragment);
            }
            Some(CompletionResponse {
                context: CompletionContextFace {
                    kind: "value",
                    section,
                    facet: None,
                    entity,
                    fragment,
                },
                items,
            })
        }
    }

    /// 属性/方法成员面:本类声明在前(声明序),继承成员随后(祖先链近者优先,
    /// 与 hover 继承成员展开同链),同名被本类/先出项遮蔽。
    #[allow(clippy::too_many_arguments)]
    fn members_response(
        &self,
        kind: &'static str,
        section: &'static str,
        facet: Option<&'static str>,
        path: &str,
        entity: &str,
        fragment: &str,
        def: &DefFile,
    ) -> CompletionResponse {
        let mut items: Vec<CompletionItemFace> = Vec::new();
        let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut push = |item: CompletionItemFace, items: &mut Vec<CompletionItemFace>| {
            if item.label.starts_with(fragment) && seen.insert(item.label.clone()) {
                items.push(item);
            }
        };
        if section == "Properties" {
            for prop in &def.properties {
                push(
                    CompletionItemFace {
                        label: prop.name.clone(),
                        kind: "property",
                        facet: None,
                        detail: prop.type_name.clone(),
                        inherited_from: None,
                    },
                    &mut items,
                );
            }
        } else if let Some(facet) = facet {
            for method in def.methods(facet_section(facet)) {
                push(
                    CompletionItemFace {
                        label: method.name.clone(),
                        kind: "method",
                        facet: Some(facet),
                        detail: None,
                        inherited_from: None,
                    },
                    &mut items,
                );
            }
        }
        // 继承成员:链面展开(近祖先优先;缺父如实空,绝不虚构)。
        let chain = self.chain_face(path, def);
        for member in &chain.members {
            if !member.exists {
                continue;
            }
            if section == "Properties" {
                for prop in &member.properties {
                    push(
                        CompletionItemFace {
                            label: prop.name.clone(),
                            kind: "property",
                            facet: None,
                            detail: prop.r#type.clone(),
                            inherited_from: Some(member.entity.clone()),
                        },
                        &mut items,
                    );
                }
            } else if let Some(facet) = facet {
                for method in &member.methods {
                    if method.facet == facet {
                        push(
                            CompletionItemFace {
                                label: method.name.clone(),
                                kind: "method",
                                facet: Some(facet),
                                detail: None,
                                inherited_from: Some(member.entity.clone()),
                            },
                            &mut items,
                        );
                    }
                }
            }
        }
        CompletionResponse {
            context: CompletionContextFace {
                kind,
                section,
                facet,
                entity: Some(entity.to_string()),
                fragment: fragment.to_string(),
            },
            items,
        }
    }

    /// 实体面条目:def 语料注册名(路径字典序 = 首写优先;detail = 语料路径)。
    fn entities_response(
        &self,
        kind: &'static str,
        section: &'static str,
        fragment: &str,
    ) -> CompletionResponse {
        let mut items = Vec::new();
        self.push_entity_items(&mut items, fragment);
        CompletionResponse {
            context: CompletionContextFace {
                kind,
                section,
                facet: None,
                entity: None,
                fragment: fragment.to_string(),
            },
            items,
        }
    }

    fn push_entity_items(&self, items: &mut Vec<CompletionItemFace>, fragment: &str) {
        for (name, path) in &self.def_by_name {
            if name.starts_with(fragment) {
                items.push(CompletionItemFace {
                    label: name.clone(),
                    kind: "entity",
                    facet: None,
                    detail: Some(path.clone()),
                    inherited_from: None,
                });
            }
        }
    }

    /// 类型面条目:全部语料 types.xml 声明(路径序,同名首见)。
    fn push_type_items(&self, items: &mut Vec<CompletionItemFace>, fragment: &str) {
        let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for file in self.types_files.values() {
            for decl in &file.types {
                if seen.insert(decl.name.clone()) && decl.name.starts_with(fragment) {
                    items.push(CompletionItemFace {
                        label: decl.name.clone(),
                        kind: "type",
                        facet: None,
                        detail: Some(type_kind_str(decl.kind.clone()).to_string()),
                        inherited_from: None,
                    });
                }
            }
        }
    }

    /// 别名面条目:全部语料 alias.xml 条目(路径序,同名首见)。
    fn push_alias_items(&self, items: &mut Vec<CompletionItemFace>, fragment: &str) {
        let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for file in self.alias_files.values() {
            for alias in &file.aliases {
                if seen.insert(alias.name.clone()) && alias.name.starts_with(fragment) {
                    items.push(CompletionItemFace {
                        label: alias.name.clone(),
                        kind: "alias",
                        facet: None,
                        detail: Some(alias.alias_type.clone()),
                        inherited_from: None,
                    });
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 判面原语(行前缀 / 标签栈;与 TS 复算同规则)
// ---------------------------------------------------------------------------

fn type_kind_str(kind: TypeKind) -> &'static str {
    match kind {
        TypeKind::FixedDict => "fixedDict",
        TypeKind::Array => "array",
        TypeKind::Builtin => "builtin",
    }
}

fn facet_of_section(section: &str) -> &'static str {
    match section {
        "BaseMethods" => "base",
        "CellMethods" => "cell",
        _ => "client",
    }
}

fn facet_section_of(facet: &str) -> &'static str {
    match facet {
        "base" => "BaseMethods",
        "cell" => "CellMethods",
        _ => "ClientMethods",
    }
}

fn facet_section(facet: &str) -> MethodSection {
    match facet {
        "base" => MethodSection::Base,
        "cell" => MethodSection::Cell,
        _ => MethodSection::Client,
    }
}

/// 该行(0 起)光标前的行前缀(character 按 UTF-16 计,超行尾截到行尾)。
fn line_prefix(text: &str, line0: u32, col: usize) -> Option<String> {
    let line = line_text(text, line0)?;
    let mut utf16 = 0usize;
    let mut end = line.len();
    for (idx, ch) in line.char_indices() {
        if utf16 >= col {
            end = idx;
            break;
        }
        utf16 += ch.len_utf16();
    }
    Some(line[..end].to_string())
}

/// 该行(0 起)全文(不含行终止符;缺行 None)。
fn line_text(text: &str, line0: u32) -> Option<&str> {
    if line0 == 0 {
        return text.split('\n').next();
    }
    let mut line = 0u32;
    for (idx, ch) in text.char_indices() {
        if ch == '\n' {
            line += 1;
            if line == line0 {
                let rest = &text[idx + 1..];
                return Some(rest.split('\n').next().unwrap_or(""));
            }
        }
    }
    None
}

/// UTF-16 character → 行内 char 列(0 起;行不存在返回 None)。
fn char_col_of(text: &str, line0: u32, character: u32) -> Option<usize> {
    let line = line_text(text, line0)?;
    let mut utf16 = 0u32;
    let mut col = 0usize;
    for ch in line.chars() {
        if utf16 >= character {
            break;
        }
        utf16 += ch.len_utf16() as u32;
        col += 1;
    }
    Some(col)
}

/// 行前缀 →(去片段头部, 片段, 是否开标签):尾部词为片段;其前紧邻 `<`
/// 即开标签上下文(片段为空时前缀以 `<` 结尾)。
fn split_fragment(prefix: &str) -> (String, String, bool) {
    let head_end = prefix
        .char_indices()
        .rev()
        .find(|(_, ch)| !(ch.is_ascii_alphanumeric() || *ch == '_'))
        .map(|(idx, _)| idx + prefix[idx..].chars().next().map_or(1, |c| c.len_utf8()))
        .unwrap_or(0);
    let fragment = prefix[head_end..].to_string();
    let head = prefix[..head_end].to_string();
    let open_tag = head.ends_with('<');
    (head, fragment, open_tag)
}

/// 光标所在行以上的全部行(不含当前行;栈扫描用——条目声明行自身不会
/// 嵌套影响栈,与 TS 复算同规则)。
fn lines_above(text: &str, line0: u32) -> String {
    let mut line = 0u32;
    for (idx, ch) in text.char_indices() {
        if line == line0 {
            return text[..idx].to_string();
        }
        if ch == '\n' {
            line += 1;
        }
    }
    text.to_string()
}

/// 行级标签栈:逐行累计完整标签(`<X>` 进栈,`</X>` 出栈,`<X/>`/`<!--`
/// 注释与未闭合尾标忽略)。返回栈(底→顶)。
fn tag_stack(above: &str) -> Vec<String> {
    let mut stack: Vec<String> = Vec::new();
    for line in above.split('\n') {
        scan_line_tags(line, &mut stack);
    }
    stack
}

/// 单行标签扫描(栈推进;`tag_stack` 与场景枚举共用同一规则)。
fn scan_line_tags(line: &str, stack: &mut Vec<String>) {
    let trimmed = line.trim_start();
    if trimmed.starts_with("<!--") && !trimmed[4..].contains("-->") {
        return;
    }
    let mut i = 0usize;
    while i < line.len() {
        if !line.is_char_boundary(i) {
            i += 1;
            continue;
        }
        if !line[i..].starts_with('<') {
            i += 1;
            continue;
        }
        let Some(rel) = line[i + 1..].find('>') else {
            break; // 未闭合尾标(含跨行标签):忽略
        };
        let inner = &line[i + 1..i + 1 + rel];
        if let Some(name) = inner.strip_prefix('/') {
            if stack.last().map(|t| t == name.trim()).unwrap_or(false) {
                stack.pop();
            }
        } else if !inner.starts_with("!--") && !inner.ends_with('/') {
            let name: String = inner
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if !name.is_empty() {
                stack.push(name);
            }
        }
        i += rel + 2;
    }
}

// ---------------------------------------------------------------------------
// 对拍 golden(只写不读;TS 侧 tests/kodeCompletionParity.test.ts 复算)
// ---------------------------------------------------------------------------

/// golden 文件名(仓库相对)。
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/completion-parity.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenScenario {
    line: usize,
    character: u32,
    response: CompletionResponse,
}

#[derive(Debug, Serialize)]
struct GoldenFile {
    file: String,
    kind: String,
    scenarios: Vec<GoldenScenario>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    file_count: usize,
    scenario_count: usize,
    files: Vec<GoldenFile>,
}

/// 场景点:1 起行号 + UTF-16 列。
type ScenarioPos = (usize, u32);

fn utf16_len(s: &str) -> u32 {
    s.chars().map(char::len_utf16).sum::<usize>() as u32
}

/// 场景枚举(确定性;TS 侧按同规则复算场景并逐点比对响应):
/// - def:Properties/方法段/Components 段内的条目行 → 开标签点两点
///   (`<` 后全量点 + 名前 2 字符过滤点);`<Parent>` 行与 `<Type>`/`<Arg>`/
///   `<of>` 带值行 → 取值点两点(标签后全量点 + 值首 token 末过滤点);
/// - entities:root 直下条目行 → 开标签点两点(同上)。
fn enumerate_scenarios(kind: &str, text: &str) -> Vec<ScenarioPos> {
    let mut out = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    for (idx, line) in text.split('\n').enumerate() {
        let line1 = idx + 1;
        let ws_len = line.len() - line.trim_start().len();
        let ws16 = utf16_len(&line[..ws_len]);
        let trimmed = line.trim_start();
        let top = stack.last().cloned();
        if kind == "def" {
            match top.as_deref() {
                Some("Properties")
                | Some("BaseMethods")
                | Some("CellMethods")
                | Some("ClientMethods")
                | Some("Components") => {
                    if let Some(name) = open_tag_name(trimmed) {
                        // 全量点(``+`<`)与过滤点(名前 2 字符)。
                        out.push((line1, ws16 + 1));
                        out.push((line1, ws16 + 1 + fragment16(&name)));
                    }
                }
                _ => {}
            }
            let mut value_point = |tag: &str, rest: &str| {
                out.push((line1, ws16 + utf16_len(tag)));
                let value = rest.trim_start();
                if value.is_empty() {
                    return;
                }
                let pad = utf16_len(rest) - utf16_len(value);
                let token = leading_word(value);
                out.push((line1, ws16 + utf16_len(tag) + pad + utf16_len(token)));
            };
            if let Some(rest) = trimmed.strip_prefix("<Parent>") {
                value_point("<Parent>", rest);
            } else if let Some((tag, rest)) = ["<Type>", "<Arg>", "<of>"]
                .iter()
                .find_map(|t| trimmed.strip_prefix(t).map(|rest| (*t, rest)))
            {
                value_point(tag, rest);
            }
        } else if kind == "entities" && top.as_deref() == Some("root") {
            if let Some(name) = open_tag_name(trimmed) {
                out.push((line1, ws16 + 1));
                out.push((line1, ws16 + 1 + fragment16(&name)));
            }
        }
        scan_line_tags(line, &mut stack);
    }
    out
}

/// 值首 token(前导词字符)。
fn leading_word(value: &str) -> &str {
    value
        .char_indices()
        .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '_'))
        .map(|(i, _)| &value[..i])
        .unwrap_or(value)
}

/// 行首开标签名(`^<Name>` 或带属性的 `<Name …>`;`</X>`/`<X/>` 形态不取)。
fn open_tag_name(trimmed: &str) -> Option<String> {
    let rest = trimmed.strip_prefix('<')?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if name.is_empty() {
        return None;
    }
    let after = &rest[name.len()..];
    if after.starts_with('>') || after.starts_with(char::is_whitespace) {
        Some(name)
    } else {
        None
    }
}

/// 名前片段的 UTF-16 宽(过滤场景:名前 ≤2 字符)。
fn fragment16(name: &str) -> u32 {
    utf16_len(&name.chars().take(2).collect::<String>())
}

/// 整个语料的 completion golden JSON(每文件每场景点一条响应)。
pub fn dump_completion_golden(repo_root: &std::path::Path) -> String {
    let files = kode_parser::json::collect_corpus(repo_root, kode_parser::json::PARITY_CORPORA);
    let mut engine = HoverEngine::new();
    // 先全量入库(字典序 = TS 语料序,首写优先口径一致)。
    for (path, (_kind, text)) in &files {
        let key = DocumentKey::new(
            kode_vfs::store::RootId::UNROOTED,
            kode_vfs::uri::CanonicalUri::from_path(path),
        );
        engine.update(key, text);
    }
    let mut dump = GoldenDump {
        generator: "kode-server dump-completion-golden",
        file_count: files.len(),
        scenario_count: 0,
        files: Vec::new(),
    };
    for (path, (kind, text)) in &files {
        let key = DocumentKey::new(
            kode_vfs::store::RootId::UNROOTED,
            kode_vfs::uri::CanonicalUri::from_path(path),
        );
        let mut scenarios = Vec::new();
        for (line1, character) in enumerate_scenarios(kind, text) {
            if let Some(response) = engine.completion(&key, text, line1 as u32 - 1, character) {
                scenarios.push(GoldenScenario {
                    line: line1,
                    character,
                    response,
                });
            }
        }
        dump.scenario_count += scenarios.len();
        dump.files.push(GoldenFile {
            file: path.clone(),
            kind: kind.to_string(),
            scenarios,
        });
    }
    serde_json::to_string(&dump).expect("serialize completion golden")
}
