//! hover 响应链(PR-010,书 §8 LSP-003 / §17 PR-010 / PH1-03 垂直切片)。
//!
//! 本单任务分发提到的「HOVER-001..013」在书 KODE_2_COMPLETE_TODO.md 中无该前缀
//! 条目(§8 为 LSP 系列),与 PR-008 的 TYPE 前缀同情况:本模块按 §17 PR-010 原文
//! + LSP-003 落地,链面编号在 docs/kode2/pr-010.md 里定义并逐条映射书条目,不冒领。
//!
//! 响应链(定位 → 文档 → 签名 → 继承成员),全部纯同步、零 IO:
//! - 定位:UTF-16 position → 词 → 本文件声明符号(六类,PR-007 同面);
//!   `.def` 的 `<Parent>` 标签/取值词触发继承链面;
//! - 文档:符号种类 + 所属段(与 TS getSectionLabel 同源的面)+ 来源文件;
//! - 签名:属性(Type/Flags/Default/DetailLevel/DatabaseLength/Identifier/
//!   Persistent)、方法(facet/Arg/Exposed)、
//!   组件(Type/Persistent)、类型声明(kind/重定向目标)、别名(Type 目标)、
//!   实体注册(def 存在性)、def 实体本体(Parent);
//! - 继承成员:def 链(parent 递归 + interfaces 平铺 + components 挂接,与 TS
//!   buildDefChain 同口径,环截断显式标注)+ 链上各祖先的属性/方法成员展开。
//!
//! ARCH-012 红线:不做任何性能宣称;结构保证只有一条(LSP-003 禁阻塞):查询
//! 只碰本文件已持有的文本与已入库语料视图,无磁盘扫描、无全仓遍历。
//!
//! 对拍:TS 侧 `tests/kodeHoverParity.test.ts` 用 defParser/compositionRoots/
//! buildDefChain 复算同一语料的 hover 面,与 [`dump_hover_golden`] 生成的
//! golden 逐字段比对(双向门禁,PR-005/007/008 同构)。

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use kode_index::symbol::{def_entity_name, extract_records, MethodFacet, SymbolKind};
use kode_parser::dep::{file_kind_of_uri, FileKind, ParsedUnit};
use kode_parser::json::{collect_corpus, PARITY_CORPORA};
use kode_parser::model::{parse_alias, parse_def, parse_entities, parse_types, DefFile, TypeKind};
use kode_vfs::store::{DocumentKey, RootId};

// ---------------------------------------------------------------------------
// 响应模型(结构化面;markdown 渲染只为 LSP contents 兼容,不是对拍面)
// ---------------------------------------------------------------------------

/// 一条 hover 响应:符号身份 + 签名面 + 继承面(仅 def 实体)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoverResponse {
    /// 单请求唯一 face。shadow 对拍先比 face,face 不同即 diff,绝不跨 face
    /// 归一化;同 face 才进入正文严格比较。
    pub face: HoverFace,
    pub symbol: HoverSymbol,
    pub signature: HoverSignature,
    /// def 实体悬停与 `<Parent>` 悬停时的继承闭包面;其余为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inherited: Option<InheritedChain>,
}

/// hover provider face(每请求恰一个)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HoverFace {
    DefEntity,
    DefProperty,
    DefMethod,
    DefComponent,
    EntitiesXml,
    TypesXml,
    AliasXml,
}

/// 符号身份(定位结果)。`kind`/`facet` 与 PR-007 符号面同一字面量。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoverSymbol {
    pub name: String,
    pub kind: String,
    pub facet: Option<String>,
    /// 所属段:与 TS getSectionLabel 输入同源(Entity/Properties/Components/
    /// BaseMethods/CellMethods/ClientMethods/Entities/Types/Aliases)。
    pub section: &'static str,
}

/// 签名面:按符号种类填充,不适用字段为 null(键恒在,对拍两侧同形)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HoverSignature {
    /// 属性:`<Type>` 直接文本首 token。
    pub r#type: Option<String>,
    /// 属性:`<Flags>` 原文(trim)。
    pub flags: Option<String>,
    /// 属性:`<Default>` 原文(trim)。
    pub default_value: Option<String>,
    /// 属性:`<DetailLevel>`(遗留拼写同识别)。
    pub detail_level: Option<String>,
    /// 属性:`<DatabaseLength>` 原文(trim)。
    pub database_length: Option<String>,
    /// 属性:`<Identifier>` 原文(trim)。
    pub identifier: Option<String>,
    /// 属性/组件:`<Persistent>` truthy;无标签为 null。
    pub persistent: Option<bool>,
    /// 方法:Arg 个数。
    pub arg_count: Option<usize>,
    /// 方法:`<Arg>` 文本(按出现顺序)。
    pub args: Option<Vec<String>>,
    /// 方法:`<Exposed>` truthy。
    pub exposed: Option<bool>,
    /// 组件:`<Type>` 值(组件 def 名)。
    pub component_type: Option<String>,
    /// types.xml 声明:fixedDict | array | builtin(与 TS parseTypesXml 同字面量)。
    pub type_kind: Option<String>,
    /// types.xml 重定向条目的目标(非 FIXED_DICT/ARRAY 的指引首 token)。
    pub alias_target: Option<String>,
    /// alias.xml:`<Type>` 目标。
    pub alias_type: Option<String>,
    /// entities.xml 注册项:命中的 def 路径(语料内首见);未命中给约定名。
    pub def_file: Option<String>,
    /// entities.xml 注册项:def 是否在已入库语料中。
    pub def_exists: Option<bool>,
    /// def 实体本体:`<Parent>` 名。
    pub parent: Option<String>,
}

/// 继承链节点(def 链三面共用):存在性 = 路径在已入库语料中。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainNodeInfo {
    pub name: String,
    pub exists: bool,
}

/// 链上单个祖先的成员展开(继承成员面)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberSummary {
    pub entity: String,
    pub exists: bool,
    pub properties: Vec<MemberProperty>,
    pub methods: Vec<MemberMethod>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberProperty {
    pub name: String,
    pub r#type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberMethod {
    pub name: String,
    pub facet: &'static str,
}

/// def 链面(与 TS buildDefChain 输出同构 + 成员展开):
/// parent 链从紧邻父起;interfaces/components 为闭包内平铺(同名去重首见保序);
/// 接口 def 不跟随 Parent;环截断显式标注,绝不死循环。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InheritedChain {
    pub parent_chain: Vec<ChainNodeInfo>,
    pub interfaces: Vec<ChainNodeInfo>,
    pub components: Vec<ChainNodeInfo>,
    pub cycle_truncated: bool,
    pub members: Vec<MemberSummary>,
}

/// 段名 → TS getSectionLabel 同款中文区块措辞(PR-012 门 §1.3-③ 渲染面对齐;
/// 未映射段保留原文,TS 侧该段走另一悬停面,不在此对齐范围)。
fn section_label(section: &str) -> &str {
    match section {
        "Properties" => "属性区块",
        "BaseMethods" | "CellMethods" | "ClientMethods" => "方法区块",
        "Components" => "组件区块",
        "Parent" => "父类区块",
        "Interfaces" => "接口区块",
        "Volatile" => "易变同步区块",
        other => other,
    }
}

/// LSP contents 用 markdown 渲染(属性/方法面与 TS getSymbolHover 逐字节同
/// 文案同尾随空白,PR-012 门 §1.3-③;其余面为 Rust 侧措辞,非对拍面)。
pub fn render_markdown(response: &HoverResponse) -> String {
    let mut md = String::new();
    md.push_str(&format!("**{}**\n\n", response.symbol.name));
    md.push_str(&format!(
        "{}中的自定义定义。\n\n",
        section_label(response.symbol.section)
    ));
    let s = &response.signature;
    let kind = response.symbol.kind.as_str();
    if kind == "property" {
        // 属性面:字段序/措辞/尾随空白与 TS getSymbolHover 属性区块逐字节同
        // (languageProviders.ts:1623-1649:Type→Flags→Default→DetailLevel→
        // DatabaseLength→Identifier)。TS 属性面不渲染 **Persistent**,Rust 同脸
        // 不再单侧输出;数据库存储段需 DB 快照(FS/DB 面),划归边界。
        if let Some(t) = &s.r#type {
            md.push_str(&format!("**Type**: `{t}`\n\n"));
        }
        if let Some(f) = &s.flags {
            md.push_str(&format!("**Flags**: `{f}`\n\n"));
        }
        if let Some(d) = &s.default_value {
            md.push_str(&format!("**Default**: `{d}`\n\n"));
        }
        if let Some(d) = &s.detail_level {
            md.push_str(&format!("**DetailLevel**: `{d}`\n\n"));
        }
        if let Some(l) = &s.database_length {
            md.push_str(&format!("**DatabaseLength**: `{l}`\n\n"));
        }
        if let Some(i) = &s.identifier {
            md.push_str(&format!("**Identifier**: `{i}`\n\n"));
        }
        return md;
    }
    if kind == "method" {
        // 方法面:与 TS 同构 —— **Args** 行不带尾随空行(由 Exposed 段的
        // 前导空行衔接);无 Args 时以 **参数个数** 行的尾随空行收尾。
        md.push_str(&format!("**参数个数**: {}\n\n", s.arg_count.unwrap_or(0)));
        if let Some(args) = &s.args {
            if !args.is_empty() {
                md.push_str(&format!("**Args**: `{}`", args.join(", ")));
            }
        }
        if let Some(true) = s.exposed {
            md.push_str("\n\n**Exposed**: `true`\n\n该方法可被客户端远程调用。");
        }
        return md;
    }
    if let Some(t) = &s.r#type {
        md.push_str(&format!("**Type**: `{t}`\n\n"));
    }
    if let Some(f) = &s.flags {
        md.push_str(&format!("**Flags**: `{f}`\n\n"));
    }
    if let Some(d) = &s.detail_level {
        md.push_str(&format!("**DetailLevel**: `{d}`\n\n"));
    }
    if let Some(p) = s.persistent {
        if p {
            md.push_str("**Persistent**: `true`\n\n");
        }
    }
    if let Some(n) = s.arg_count {
        md.push_str(&format!("**参数个数**: {n}\n\n"));
    }
    if let Some(args) = &s.args {
        if !args.is_empty() {
            md.push_str(&format!("**Args**: `{}`\n\n", args.join(", ")));
        }
    }
    if let Some(true) = s.exposed {
        md.push_str("**Exposed**: `true`\n\n该方法可被客户端远程调用。\n\n");
    }
    if let Some(ctype) = &s.component_type {
        md.push_str(&format!("**Component Type**: `{ctype}`\n\n"));
    }
    if let Some(kind) = &s.type_kind {
        md.push_str(&format!("**TypeKind**: `{kind}`\n\n"));
    }
    if let Some(target) = &s.alias_target {
        md.push_str(&format!("**AliasType**: `{target}`\n\n"));
    }
    if let Some(target) = &s.alias_type {
        md.push_str(&format!("**AliasType**: `{target}`\n\n"));
    }
    if let Some(parent) = &s.parent {
        md.push_str(&format!("**Parent**: `{parent}`\n\n"));
    }
    if let Some(def_file) = &s.def_file {
        md.push_str(&format!("**Definition**: `{def_file}`\n\n"));
    }
    if let Some(chain) = &response.inherited {
        md.push_str("**def 链**(引擎归并口径)\n\n");
        if !chain.parent_chain.is_empty() {
            let names: Vec<String> = chain.parent_chain.iter().map(chain_node_label).collect();
            let note = if chain.cycle_truncated {
                ";检测到环,已截断"
            } else {
                ""
            };
            md.push_str(&format!(
                "- **Parent 链**: {}(共 {} 层{note})\n\n",
                names.join(" → "),
                chain.parent_chain.len()
            ));
        }
        if !chain.interfaces.is_empty() {
            let names: Vec<String> = chain.interfaces.iter().map(chain_node_label).collect();
            md.push_str(&format!(
                "- **Interfaces 平铺**: {}(接口 def 不跟随 Parent)\n\n",
                names.join("、")
            ));
        }
        if !chain.components.is_empty() {
            let names: Vec<String> = chain.components.iter().map(chain_node_label).collect();
            md.push_str(&format!("- **Components 挂接**: {}\n\n", names.join("、")));
        }
        for member in &chain.members {
            if !member.exists {
                continue;
            }
            let props: Vec<String> = member
                .properties
                .iter()
                .map(|p| match &p.r#type {
                    Some(t) => format!("{}:`{t}`", p.name),
                    None => p.name.clone(),
                })
                .collect();
            let methods: Vec<String> = member
                .methods
                .iter()
                .map(|m| format!("{}({})", m.name, m.facet))
                .collect();
            md.push_str(&format!(
                "- **{} 成员**: 属性 [{}];方法 [{}]\n\n",
                member.entity,
                props.join(", "),
                methods.join(", ")
            ));
        }
    }
    md.trim_end().to_string()
}

fn chain_node_label(node: &ChainNodeInfo) -> String {
    if node.exists {
        format!("`{}`", node.name)
    } else {
        format!("`{}`(def 缺失)", node.name)
    }
}

// ---------------------------------------------------------------------------
// HoverEngine:语料视图 + 定位 + 响应链
// ---------------------------------------------------------------------------

/// hover 引擎:持有符号索引与已入库 def 语料视图,纯内存应答。
#[derive(Debug)]
pub struct HoverEngine {
    pub index: kode_index::SymbolIndex,
    /// def 语义视图:**按路径**键(与 TS 逐路径读文件同语义,跨语料同名
    /// 实体互不串扰)。
    def_files: BTreeMap<String, DefFile>,
    /// 实体名(file stem)→ 首见路径(entities.xml 注册项的 defFile 面;
    /// 与 TS 语料序首见一致)。
    pub(crate) def_by_name: BTreeMap<String, String>,
    /// 已入库 def 文件路径(存在性判定,对应 TS 的 fs.existsSync 面)。
    pub(crate) corpus_defs: BTreeSet<String>,
    /// entities.xml 所在目录(defsRoot 向上探测用)。
    entities_dirs: BTreeSet<String>,
    /// entities.xml 语料视图(Phase2 诊断/定义面:按路径键)。
    pub(crate) entities_files: BTreeMap<String, kode_parser::model::EntitiesFile>,
    /// types.xml 语料视图(PR-011 补全类型面:按路径键,跨语料同名不串扰)。
    pub(crate) types_files: BTreeMap<String, kode_parser::model::TypesFile>,
    /// alias.xml 语料视图(PR-011 补全别名面)。
    pub(crate) alias_files: BTreeMap<String, kode_parser::model::AliasFile>,
}

impl Default for HoverEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl HoverEngine {
    pub fn new() -> HoverEngine {
        HoverEngine {
            index: kode_index::SymbolIndex::new(),
            def_files: BTreeMap::new(),
            def_by_name: BTreeMap::new(),
            corpus_defs: BTreeSet::new(),
            entities_dirs: BTreeSet::new(),
            entities_files: BTreeMap::new(),
            types_files: BTreeMap::new(),
            alias_files: BTreeMap::new(),
        }
    }

    /// 单文件入库:符号索引 + 语料视图同步维护。
    pub fn update(&mut self, key: DocumentKey, text: &str) {
        self.index.update(key.clone(), text);
        let path = key.uri.as_path().to_string();
        match file_kind_of_uri(&key.uri) {
            FileKind::Def => {
                self.corpus_defs.insert(path.clone());
                self.def_files.insert(path.clone(), parse_def(text));
                if let Some(name) = def_entity_name(&path) {
                    self.def_by_name.entry(name).or_insert(path);
                }
            }
            FileKind::Entities => {
                if let Some(dir) = parent_dir(&path) {
                    self.entities_dirs.insert(dir.to_string());
                }
                self.entities_files.insert(path, parse_entities(text));
            }
            FileKind::Types => {
                self.types_files.insert(path, parse_types(text));
            }
            FileKind::Alias => {
                self.alias_files.insert(path, parse_alias(text));
            }
            _ => {}
        }
    }

    /// 文件移除(VFS-012 下游清理:符号 + 语料视图连带)。
    pub fn remove(&mut self, key: &DocumentKey) -> usize {
        let removed = self.index.remove(key);
        let path = key.uri.as_path().to_string();
        self.corpus_defs.remove(&path);
        self.def_files.remove(&path);
        self.entities_files.remove(&path);
        self.types_files.remove(&path);
        self.alias_files.remove(&path);
        self.def_by_name.retain(|_, p| p != &path);
        removed
    }

    /// 交互入口:UTF-16 position → 词 → 响应链。
    pub fn hover(
        &self,
        key: &DocumentKey,
        text: &str,
        line: u32,
        character: u32,
    ) -> Option<HoverResponse> {
        if matches!(file_kind_of_uri(&key.uri), FileKind::Other) {
            return None;
        }
        let word = word_at(text, line, character)?;
        self.hover_word(key, text, &word, line as usize + 1)
    }

    /// 声明行入口(golden 生成用):声明行号(1 起)+ 符号名 → 响应链。
    pub fn hover_at_line(
        &self,
        key: &DocumentKey,
        text: &str,
        line1: usize,
        word: &str,
    ) -> Option<HoverResponse> {
        if matches!(file_kind_of_uri(&key.uri), FileKind::Other) {
            return None;
        }
        self.hover_word(key, text, word, line1)
    }

    /// 响应链主体:先试 `<Parent>` 继承面,再按声明符号出签名面。
    fn hover_word(
        &self,
        key: &DocumentKey,
        text: &str,
        word: &str,
        line1: usize,
    ) -> Option<HoverResponse> {
        let path = key.uri.as_path();
        match file_kind_of_uri(&key.uri) {
            FileKind::Def => {
                let def = parse_def(text);
                let entity = def_entity_name(path)?;
                // `<Parent>` 标签/取值词 → 继承链面(TS getDefChainHover 同触发面:
                // 无 Parent 也给链面,如实呈现"无声明")。
                if word == "Parent" || Some(word) == def.parent.as_deref() {
                    return Some(HoverResponse {
                        face: HoverFace::DefEntity,
                        symbol: HoverSymbol {
                            name: entity.clone(),
                            kind: "entity".into(),
                            facet: None,
                            section: "Entity",
                        },
                        signature: HoverSignature {
                            parent: def.parent.clone(),
                            ..HoverSignature::default()
                        },
                        inherited: Some(self.chain_face(path, &def)),
                    });
                }
                let (records, _) = extract_records(key, &ParsedUnit::Def(parse_def(text)));
                let record = records.iter().find(|r| r.name == word && r.line == line1)?;
                match record.kind {
                    SymbolKind::Property => {
                        let prop = def
                            .properties
                            .iter()
                            .find(|p| p.name == word && p.line == line1)?;
                        Some(HoverResponse {
                            face: HoverFace::DefProperty,
                            symbol: hover_symbol(record, "Properties"),
                            signature: HoverSignature {
                                r#type: prop.type_name.clone(),
                                flags: prop.flags_raw.clone(),
                                default_value: prop.default_value.clone(),
                                detail_level: prop.detail_level.clone(),
                                database_length: prop.database_length.clone(),
                                identifier: prop.identifier.clone(),
                                persistent: prop.persistent,
                                ..HoverSignature::default()
                            },
                            inherited: None,
                        })
                    }
                    SymbolKind::Method => {
                        let (methods, facet_str) = match record.facet {
                            Some(MethodFacet::Base) => (&def.base_methods, "base"),
                            Some(MethodFacet::Cell) => (&def.cell_methods, "cell"),
                            Some(MethodFacet::Client) | None => (&def.client_methods, "client"),
                        };
                        let method = methods.iter().find(|m| m.name == word && m.line == line1)?;
                        Some(HoverResponse {
                            face: HoverFace::DefMethod,
                            symbol: hover_symbol(record, facet_section(facet_str)),
                            signature: HoverSignature {
                                arg_count: Some(method.args.len()),
                                args: Some(method.args.clone()),
                                exposed: Some(method.exposed),
                                ..HoverSignature::default()
                            },
                            inherited: None,
                        })
                    }
                    SymbolKind::Component => {
                        let comp = def
                            .components
                            .iter()
                            .find(|c| c.name == word && c.line == line1)?;
                        Some(HoverResponse {
                            face: HoverFace::DefComponent,
                            symbol: hover_symbol(record, "Components"),
                            signature: HoverSignature {
                                component_type: comp.component_type.clone(),
                                persistent: comp.persistent,
                                ..HoverSignature::default()
                            },
                            inherited: None,
                        })
                    }
                    SymbolKind::Entity => Some(HoverResponse {
                        face: HoverFace::DefEntity,
                        symbol: HoverSymbol {
                            name: entity.clone(),
                            kind: "entity".into(),
                            facet: None,
                            section: "Entity",
                        },
                        signature: HoverSignature {
                            parent: def.parent.clone(),
                            ..HoverSignature::default()
                        },
                        inherited: Some(self.chain_face(path, &def)),
                    }),
                    // def 文件不出类型/别名符号。
                    SymbolKind::Type | SymbolKind::Alias => None,
                }
            }
            FileKind::Entities => {
                let entities = parse_entities(text);
                let _entry = entities
                    .entities
                    .iter()
                    .find(|e| e.name == word && e.line == line1)?;
                let def_path = self.def_by_name.get(word);
                Some(HoverResponse {
                    face: HoverFace::EntitiesXml,
                    symbol: HoverSymbol {
                        name: word.to_string(),
                        kind: "entity".into(),
                        facet: None,
                        section: "Entities",
                    },
                    signature: HoverSignature {
                        def_file: Some(def_path.cloned().unwrap_or_else(|| format!("{word}.def"))),
                        def_exists: Some(def_path.is_some()),
                        ..HoverSignature::default()
                    },
                    inherited: None,
                })
            }
            FileKind::Types => {
                let types = parse_types(text);
                let decl = types
                    .types
                    .iter()
                    .find(|t| t.name == word && t.line == line1)?;
                let type_kind = match decl.kind {
                    TypeKind::FixedDict => "fixedDict",
                    TypeKind::Array => "array",
                    TypeKind::Builtin => "builtin",
                };
                let directive = decl.directive.as_deref();
                let alias_target = match directive {
                    Some(d) if d != "ARRAY" && d != "FIXED_DICT" => Some(d.to_string()),
                    _ => None,
                };
                Some(HoverResponse {
                    face: HoverFace::TypesXml,
                    symbol: HoverSymbol {
                        name: word.to_string(),
                        kind: "type".into(),
                        facet: None,
                        section: "Types",
                    },
                    signature: HoverSignature {
                        type_kind: Some(type_kind.to_string()),
                        alias_target,
                        ..HoverSignature::default()
                    },
                    inherited: None,
                })
            }
            FileKind::Alias => {
                let aliases = parse_alias(text);
                let alias = aliases
                    .aliases
                    .iter()
                    .find(|a| a.name == word && a.line == line1)?;
                Some(HoverResponse {
                    face: HoverFace::AliasXml,
                    symbol: HoverSymbol {
                        name: word.to_string(),
                        kind: "alias".into(),
                        facet: None,
                        section: "Aliases",
                    },
                    signature: HoverSignature {
                        alias_type: Some(alias.alias_type.clone()),
                        ..HoverSignature::default()
                    },
                    inherited: None,
                })
            }
            FileKind::Other => None,
        }
    }

    /// def 链面:与 TS buildDefChain 同算法(def 视图替代 fs 读),含成员展开。
    /// 入口语义面取**悬停文件自身**的解析结果(`entry`),不做按名全局查——
    /// 多语料同名实体的视图互不串扰(父/接口/组件按路径在语料内求存在性)。
    /// PR-011 起供 completion 继承成员面复用(crate 内)。
    pub(crate) fn chain_face(&self, path: &str, entry: &DefFile) -> InheritedChain {
        let mut face = InheritedChain {
            parent_chain: Vec::new(),
            interfaces: Vec::new(),
            components: Vec::new(),
            cycle_truncated: false,
            members: Vec::new(),
        };
        let Some(defs_root) = self.defs_root(path) else {
            return face;
        };
        let mut seen_interfaces: BTreeSet<String> = BTreeSet::new();
        let mut seen_components: BTreeSet<String> = BTreeSet::new();
        let mut seen_files: BTreeSet<String> = BTreeSet::from([path.to_string()]);

        // 闭包三面收集:同名去重首见保序(TS collectFlatDecls 同口径)。
        fn collect(
            face: &mut InheritedChain,
            defs_root: &str,
            corpus_defs: &BTreeSet<String>,
            seen_interfaces: &mut BTreeSet<String>,
            seen_components: &mut BTreeSet<String>,
            def: &DefFile,
        ) {
            for name in &def.interfaces {
                if seen_interfaces.insert(name.clone()) {
                    let def_path = format!("{defs_root}/interfaces/{name}.def");
                    face.interfaces.push(ChainNodeInfo {
                        name: name.clone(),
                        exists: corpus_defs.contains(&def_path),
                    });
                }
            }
            for comp in &def.components {
                let Some(name) = &comp.component_type else {
                    continue;
                };
                if seen_components.insert(name.clone()) {
                    let def_path = format!("{defs_root}/components/{name}.def");
                    face.components.push(ChainNodeInfo {
                        name: name.clone(),
                        exists: corpus_defs.contains(&def_path),
                    });
                }
            }
        }

        let mut current: Option<(String, &DefFile)> = Some((path.to_string(), entry));
        while let Some((cpath, cdef)) = current {
            let category = category_of(&defs_root, &cpath);
            collect(
                &mut face,
                &defs_root,
                &self.corpus_defs,
                &mut seen_interfaces,
                &mut seen_components,
                cdef,
            );
            // 接口 def 不跟随 Parent(引擎 loadInterfaces 口径)。
            let parent = match category {
                Category::Interface => None,
                _ => cdef.parent.clone(),
            };
            let Some(parent) = parent.filter(|p| !p.is_empty()) else {
                break;
            };
            let parent_dir = match category {
                Category::Component => format!("{defs_root}/components"),
                _ => defs_root.clone(),
            };
            let parent_path = format!("{parent_dir}/{parent}.def");
            let exists = self.corpus_defs.contains(&parent_path);
            face.parent_chain.push(ChainNodeInfo {
                name: parent.clone(),
                exists,
            });
            if seen_files.contains(&parent_path) {
                face.cycle_truncated = true;
                break;
            }
            seen_files.insert(parent_path.clone());
            // 成员展开 + 前进:按**路径**读该父的 def 视图(与 TS 逐路径
            // 读文件同语义);未入库按缺文件处理,绝不虚构。
            match self.def_files.get(&parent_path) {
                Some(pdef) => {
                    face.members.push(MemberSummary {
                        entity: parent.clone(),
                        exists: true,
                        properties: pdef
                            .properties
                            .iter()
                            .map(|p| MemberProperty {
                                name: p.name.clone(),
                                r#type: p.type_name.clone(),
                            })
                            .collect(),
                        methods: facet_methods(pdef),
                    });
                    current = Some((parent_path.clone(), pdef));
                }
                _ => {
                    face.members.push(MemberSummary {
                        entity: parent.clone(),
                        exists,
                        properties: Vec::new(),
                        methods: Vec::new(),
                    });
                    break;
                }
            }
        }
        face
    }

    /// entities.xml 语料视图(Phase2 诊断/定义面只读)。
    pub(crate) fn entities_files(&self) -> &BTreeMap<String, kode_parser::model::EntitiesFile> {
        &self.entities_files
    }

    /// defsRoot 探测(TS findEntityDefsRootFromFile 同规则):向上找含
    /// entities.xml 的目录;文件在 `entity_defs/` 内时根取该子目录。
    pub(crate) fn defs_root(&self, path: &str) -> Option<String> {
        let mut dir = parent_dir(path)?;
        loop {
            if self.entities_dirs.contains(dir) {
                let defs_root = format!("{dir}/entity_defs");
                if path.starts_with(&format!("{defs_root}/")) {
                    return Some(defs_root);
                }
                return Some(dir.to_string());
            }
            dir = parent_dir(dir)?;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Category {
    Entity,
    Interface,
    Component,
}

/// 文件在 defsRoot 下的类别(TS categoryOf 同规则:相对段含 interfaces/
/// components 判定)。
pub(crate) fn category_of(defs_root: &str, path: &str) -> Category {
    if !path.starts_with(&format!("{defs_root}/")) {
        return Category::Entity;
    }
    let rel = &path[defs_root.len() + 1..];
    if rel.split('/').any(|s| s == "interfaces") {
        Category::Interface
    } else if rel.split('/').any(|s| s == "components") {
        Category::Component
    } else {
        Category::Entity
    }
}

fn facet_methods(def: &DefFile) -> Vec<MemberMethod> {
    let sections = [
        (MethodFacet::Base, &def.base_methods),
        (MethodFacet::Cell, &def.cell_methods),
        (MethodFacet::Client, &def.client_methods),
    ];
    let mut out = Vec::new();
    for (facet, methods) in sections {
        for m in methods {
            out.push(MemberMethod {
                name: m.name.clone(),
                facet: facet.as_str(),
            });
        }
    }
    out
}

fn facet_section(facet: &str) -> &'static str {
    match facet {
        "base" => "BaseMethods",
        "cell" => "CellMethods",
        _ => "ClientMethods",
    }
}

fn hover_symbol(record: &kode_index::symbol::SymbolRecord, section: &'static str) -> HoverSymbol {
    HoverSymbol {
        name: record.name.clone(),
        kind: record.kind.as_str().to_string(),
        facet: record.facet.map(|f| f.as_str().to_string()),
        section,
    }
}

/// 父目录(路径用 `/`;无父返回 None)。
pub(crate) fn parent_dir(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(dir, _)| dir)
}

// ---------------------------------------------------------------------------
// 词提取(HOVER 定位层;UTF-16 character ↔ char 边界)
// ---------------------------------------------------------------------------

/// 该行(0 起)的字节区间(不含行终止符;缺行返回 None)。
fn line_bounds(text: &str, line0: u32) -> Option<(usize, usize)> {
    let mut line: u32 = 0;
    let mut start = 0usize;
    for (idx, ch) in text.char_indices() {
        if line == line0 {
            let end = text[idx..]
                .find('\n')
                .map(|n| idx + n)
                .unwrap_or(text.len());
            return Some((start, end));
        }
        if ch == '\n' {
            line += 1;
            start = idx + 1;
        }
    }
    if line == line0 {
        return Some((start, text.len()));
    }
    None
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

/// LSP 词提取:character 按 UTF-16 计;光标在词内或紧贴词尾均可命中
/// (VS Code 语义的子集:emoji 等 astral 字符按 UTF-16 双单位正确跨界)。
pub fn word_at(text: &str, line0: u32, character: u32) -> Option<String> {
    let (s, e) = line_bounds(text, line0)?;
    let line = text[s..e].trim_end_matches('\r');
    // (utf16 起点, char) 序列。
    let mut chars: Vec<(u32, char)> = Vec::new();
    let mut acc = 0u32;
    for ch in line.chars() {
        chars.push((acc, ch));
        acc += ch.len_utf16() as u32;
    }
    if chars.is_empty() {
        return None;
    }
    // 光标覆盖的 char(character 落在某 char 的 utf16 区间内),行尾取最后一字。
    let idx = chars
        .iter()
        .position(|(start, ch)| character < start + ch.len_utf16() as u32)
        .unwrap_or(chars.len() - 1);
    // 词内命中;否则紧贴词尾(光标在前一 char 结束处)也可命中。
    let mut anchor = idx;
    if !is_word_char(chars[idx].1) {
        if idx > 0 && character == chars[idx].0 && is_word_char(chars[idx - 1].1) {
            anchor = idx - 1;
        } else {
            return None;
        }
    }
    let mut lo = anchor;
    while lo > 0 && is_word_char(chars[lo - 1].1) {
        lo -= 1;
    }
    let mut hi = anchor;
    while hi + 1 < chars.len() && is_word_char(chars[hi + 1].1) {
        hi += 1;
    }
    let word: String = chars[lo..=hi].iter().map(|(_, ch)| ch).collect();
    Some(word)
}

// ---------------------------------------------------------------------------
// 对拍 golden(只写不读;TS 侧 tests/kodeHoverParity.test.ts 复算)
// ---------------------------------------------------------------------------

/// golden 文件名(仓库相对)。
pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/hover-parity.json";

#[derive(Debug, Serialize)]
struct GoldenHover {
    line: usize,
    word: String,
    hover: HoverResponse,
}

#[derive(Debug, Serialize)]
struct GoldenFile {
    file: String,
    kind: String,
    hovers: Vec<GoldenHover>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    file_count: usize,
    hover_count: usize,
    files: Vec<GoldenFile>,
}

/// 语料文件 → ParsedUnit(kind 字符串来自 collect_corpus)。
fn parse_by_kind(kind: &str, text: &str) -> Option<ParsedUnit> {
    match kind {
        "def" => Some(ParsedUnit::Def(parse_def(text))),
        "entities" => Some(ParsedUnit::Entities(parse_entities(text))),
        "types" => Some(ParsedUnit::Types(parse_types(text))),
        "alias" => Some(ParsedUnit::Alias(parse_alias(text))),
        _ => None,
    }
}

/// 整个语料的 hover golden JSON(每文件每声明符号一条响应链)。
pub fn dump_hover_golden(repo_root: &std::path::Path) -> String {
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
        generator: "kode-server dump-hover-golden",
        file_count: files.len(),
        hover_count: 0,
        files: Vec::new(),
    };
    for (path, (kind, text)) in &files {
        let Some(unit) = parse_by_kind(kind, text) else {
            continue;
        };
        let key = DocumentKey::new(
            RootId::UNROOTED,
            kode_vfs::uri::CanonicalUri::from_path(path),
        );
        let (records, _) = extract_records(&key, &unit);
        let mut hovers = Vec::new();
        for record in &records {
            if let Some(hover) = engine.hover_at_line(&key, text, record.line, &record.name) {
                hovers.push(GoldenHover {
                    line: record.line,
                    word: record.name.clone(),
                    hover,
                });
            }
        }
        dump.hover_count += hovers.len();
        dump.files.push(GoldenFile {
            file: path.clone(),
            kind: kind.to_string(),
            hovers,
        });
    }
    serde_json::to_string(&dump).expect("serialize hover golden")
}
