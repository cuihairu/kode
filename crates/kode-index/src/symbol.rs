//! 符号模型:六类声明符号 + 位置 + 抽取记录(书 §7 IDX-001 第 3 层「符号/类型
//! 索引」,PR-007 能力面 = 实体/属性/方法/类型/别名/组件)。
//!
//! - [`SymbolKind`]:六类符号;`as_str` 为对拍 golden 与查询出口的稳定字面量;
//! - [`MethodFacet`]:Cell/Base/Client 方法分面(SEM-006/007 基础);
//! - [`SymbolRecord`]:单条抽取记录(索引入库与 golden 序列化共用同一形状,
//!   保证「对拍面 = 索引面」,不允许两套提取逻辑);
//! - [`extract_records`]:ParsedUnit → 符号记录(纯函数,无 IO);
//! - [`SymbolId`]:arena 槽位号,仅在索引持有一致 generation 快照期间有意义,
//!   查询出口返回 owned [`Symbol`](SEM-001 稳定 id 的跨进程语义随 PR-008)。

use kode_parser::dep::{file_kind_of_uri, FileKind, ParsedUnit};
use kode_vfs::store::DocumentKey;

/// 符号种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SymbolKind {
    /// 实体(entities.xml 注册项与 .def 实体本体)。
    Entity,
    /// .def 属性。
    Property,
    /// .def 方法(Base/Cell/Client 分面由 [`MethodFacet`] 区分)。
    Method,
    /// types.xml 自定义类型。
    Type,
    /// alias.xml 别名。
    Alias,
    /// .def 组件槽。
    Component,
}

impl SymbolKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SymbolKind::Entity => "entity",
            SymbolKind::Property => "property",
            SymbolKind::Method => "method",
            SymbolKind::Type => "type",
            SymbolKind::Alias => "alias",
            SymbolKind::Component => "component",
        }
    }
}

/// 方法分面。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MethodFacet {
    Base,
    Cell,
    Client,
}

impl MethodFacet {
    pub fn as_str(self) -> &'static str {
        match self {
            MethodFacet::Base => "base",
            MethodFacet::Cell => "cell",
            MethodFacet::Client => "client",
        }
    }
}

/// arena 槽位号(删除后槽位复用;外部不得跨 generation 缓存)。
pub type SymbolId = usize;

/// 入库符号(查询出口返回 owned 拷贝,不暴露内部 arena/倒排结构)。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Symbol {
    pub id: SymbolId,
    pub name: String,
    pub kind: SymbolKind,
    pub file: DocumentKey,
    /// 1 起行号;.def 实体本体(无行位置的文件级符号)约定为 1。
    pub line: usize,
    pub facet: Option<MethodFacet>,
    pub detail: Option<String>,
}

/// 抽取记录(与 golden 序列化逐字段一致:name/kind/line/facet/detail)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolRecord {
    pub name: String,
    pub kind: SymbolKind,
    pub line: usize,
    pub facet: Option<MethodFacet>,
    pub detail: Option<String>,
}

impl SymbolRecord {
    fn new(name: String, kind: SymbolKind, line: usize, detail: Option<String>) -> SymbolRecord {
        SymbolRecord {
            name,
            kind,
            line,
            facet: None,
            detail,
        }
    }
}

/// 从 `.def` 文件路径/URI 取实体名(file stem;与 TS basename 去 .def 同口径)。
pub fn def_entity_name(uri_path: &str) -> Option<String> {
    std::path::Path::new(uri_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// ParsedUnit → (符号记录序列, .def 实体声明)。
///
/// 返回的记录顺序 = 文档顺序(def:实体本体 → Properties → Components →
/// Base/Cell/Client 方法段,与 DefFile 字段序一致),golden 与索引共用。
/// 第二个返回值仅 .def 有:`(实体名, Parent)`(继承边,IDX-002)。
pub fn extract_records(
    key: &DocumentKey,
    unit: &ParsedUnit,
) -> (Vec<SymbolRecord>, Option<(String, Option<String>)>) {
    match unit {
        ParsedUnit::Def(def) => {
            let path = key.uri.as_path();
            let mut out = Vec::new();
            if let Some(entity) = def_entity_name(path) {
                out.push(SymbolRecord::new(entity, SymbolKind::Entity, 1, None));
            }
            for p in &def.properties {
                out.push(SymbolRecord::new(
                    p.name.clone(),
                    SymbolKind::Property,
                    p.line,
                    p.type_name.clone(),
                ));
            }
            for c in &def.components {
                out.push(SymbolRecord::new(
                    c.name.clone(),
                    SymbolKind::Component,
                    c.line,
                    c.component_type.clone(),
                ));
            }
            let sections = [
                (MethodFacet::Base, &def.base_methods),
                (MethodFacet::Cell, &def.cell_methods),
                (MethodFacet::Client, &def.client_methods),
            ];
            for (facet, methods) in sections {
                for m in methods {
                    let mut record = SymbolRecord::new(
                        m.name.clone(),
                        SymbolKind::Method,
                        m.line,
                        if m.args.is_empty() {
                            None
                        } else {
                            Some(m.args.join(","))
                        },
                    );
                    record.facet = Some(facet);
                    out.push(record);
                }
            }
            let declaration = def_entity_name(path).map(|name| (name, def.parent.clone()));
            (out, declaration)
        }
        ParsedUnit::Entities(entities) => {
            let out = entities
                .entities
                .iter()
                .map(|e| SymbolRecord::new(e.name.clone(), SymbolKind::Entity, e.line, None))
                .collect();
            (out, None)
        }
        ParsedUnit::Types(types) => {
            let out = types
                .types
                .iter()
                .map(|t| {
                    let detail = match t.kind {
                        kode_parser::model::TypeKind::FixedDict => "fixed_dict",
                        kode_parser::model::TypeKind::Array => "array",
                        kode_parser::model::TypeKind::Builtin => "builtin",
                    };
                    SymbolRecord::new(
                        t.name.clone(),
                        SymbolKind::Type,
                        t.line,
                        Some(detail.to_string()),
                    )
                })
                .collect();
            (out, None)
        }
        ParsedUnit::Alias(alias) => {
            let out = alias
                .aliases
                .iter()
                .map(|a| {
                    SymbolRecord::new(
                        a.name.clone(),
                        SymbolKind::Alias,
                        a.line,
                        Some(a.alias_type.clone()),
                    )
                })
                .collect();
            (out, None)
        }
    }
}

/// 声明文件种类判别(非声明文件不产符号;与 dep.rs 同一判定)。
pub fn is_indexable(key: &DocumentKey) -> bool {
    !matches!(file_kind_of_uri(&key.uri), FileKind::Other)
}
