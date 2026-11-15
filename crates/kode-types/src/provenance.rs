//! 类型出处面(SEM-003/RUST-105):每个类型的 declaration/definition/
//! reference source span、原始 root/version、生成映射。
//!
//! 全部为平行侧表/注册表,**不改节点/边构建语义**(既有 11+7 钉与消费面
//! 零影响):
//! - [`TypeOrigin`] 按节点下标平行,`push_node` 单隘口锁步盖章;绕过
//!   `push_node` 的直接节点表写入不锁步(如 rpcargs 测试助手),读面
//!   [`TypeGraph::origin_of`] 防御性返 `None`;
//! - 引用点锚统一 = **引用方声明的 name span**(解析器对 types.xml 内层
//!   `<of>`/`<Type>` 文本与 alias 指向不暴露独立 span;def 属性/组件锚在其
//!   声明名上)——如实登记,不虚构引用文本自身的 span;
//! - declaration/definition 的分工:types.xml/alias.xml 条目 = 声明出处
//!   (节点 origin);实体 .def = 定义出处(节点 origin);entities.xml 注册
//!   = 注册出处(无节点,既有口径,落
//!   [`TypeGraph::entity_registration_origin`] 侧表);
//! - 生成映射为 opt-in 注册表(生成管线现居 TS 侧 pythonTypeStubs/
//!   entityTypeStubs,Rust 消费待接线),构建器永不自动填充。
//!
//! root/version 经 [`TypeGraph::set_ingest`] 上下文供给(由接线方在灌入前
//! 设置;纯库面无自动来源)。

use kode_parser::Span;

use crate::graph::{EdgeKind, TypeId};

/// 来源种类(与灌入入口一一对应)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeSourceKind {
    /// types.xml 条目(声明出处)。
    TypesXml,
    /// alias.xml 条目(声明出处)。
    AliasXml,
    /// 实体 .def(定义出处;name = 文件名去 .def)。
    Def,
    /// entities.xml 注册(注册出处,无节点)。
    EntitiesXml,
    /// 直接构造(测试/物化/拒收标注,无源文件)。
    Direct,
}

impl TypeSourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TypeSourceKind::TypesXml => "types_xml",
            TypeSourceKind::AliasXml => "alias_xml",
            TypeSourceKind::Def => "def",
            TypeSourceKind::EntitiesXml => "entities_xml",
            TypeSourceKind::Direct => "direct",
        }
    }
}

/// 节点出处:声明/定义 site + 原始 root/version。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeOrigin {
    pub source: TypeSourceKind,
    /// 声明/定义名的 0 基字节区间(parser `name_span`;Direct = None)。
    pub span: Option<Span>,
    /// 声明/定义行(parser 1 基 `line`;Direct = None)。
    pub line: Option<usize>,
    /// 灌入时接线方供给的 root 身份(不透明字符串键;未设置 = None)。
    pub root: Option<String>,
    /// 灌入时接线方供给的文档版本。
    pub version: Option<u64>,
}

impl TypeOrigin {
    /// 直接构造出处(无源文件)。
    pub fn direct() -> TypeOrigin {
        TypeOrigin {
            source: TypeSourceKind::Direct,
            span: None,
            line: None,
            root: None,
            version: None,
        }
    }
}

/// 引用点记录:from 节点经 `kind` 边引用 `name`,锚在引用方声明的 name
/// span(统一口径见模块doc)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeRefSite {
    pub from: TypeId,
    pub kind: EdgeKind,
    pub name: String,
    pub span: Option<Span>,
    pub line: Option<usize>,
}

/// 灌入上下文:接线方在 add_* 之前设置,随后全部出处盖章携带。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IngestContext {
    pub root: Option<String>,
    pub version: Option<u64>,
}

/// 生成产物(SEM-003 生成映射;opt-in 注册,无自动填充)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GenerationKind {
    /// pythonTypeStubs 的 kbe_types 自定义类型 stub。
    PyiStub,
    /// entityTypeStubs 的实体 stub。
    EntityStub,
}

impl GenerationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            GenerationKind::PyiStub => "pyi_stub",
            GenerationKind::EntityStub => "entity_stub",
        }
    }
}

/// 一条生成映射:类型名 → 生成产物(kind + 产物路径)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationTarget {
    pub kind: GenerationKind,
    pub path: String,
}

impl crate::graph::TypeGraph {
    /// 设置灌入上下文(root/version 由接线方供给;纯库面无自动来源)。
    /// 后续 `add_types`/`add_alias`/`add_def`/`register_entities` 的全部
    /// 出处盖章携带;不影响已入图数据。
    pub fn set_ingest(&mut self, root: Option<&str>, version: Option<u64>) {
        self.ingest = IngestContext {
            root: root.map(|r| r.to_string()),
            version,
        };
    }

    /// 清空灌入上下文(之后的灌入出处 root/version = None)。
    pub fn clear_ingest(&mut self) {
        self.ingest = IngestContext::default();
    }

    /// 节点出处(下标平行;绕过 `push_node` 的直接节点表写入不锁步,
    /// 越界/缺位防御性返 `None`)。
    pub fn origin_of(&self, id: TypeId) -> Option<&TypeOrigin> {
        self.origins.get(id.0 as usize)
    }

    /// entities.xml 注册出处(未注册名返 `None`)。
    pub fn entity_registration_origin(&self, name: &str) -> Option<&TypeOrigin> {
        self.entity_registrations.get(name)
    }

    /// 按被引用名过滤引用点(输出按登记序 = 灌入序,稳定)。
    pub fn reference_sites(&self, name: &str) -> Vec<&TypeRefSite> {
        self.ref_sites.iter().filter(|s| s.name == name).collect()
    }

    /// 登记生成映射(opt-in;同类型可多产物,按登记序保留)。
    pub fn link_generation(&mut self, name: &str, target: GenerationTarget) {
        self.generation_links
            .entry(name.to_string())
            .or_default()
            .push(target);
    }

    /// 查询生成映射(未登记 = 空切片)。
    pub fn generation_targets(&self, name: &str) -> &[GenerationTarget] {
        self.generation_links
            .get(name)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }
}
