//! .def 方法元数据面(SEM-006/RUST-108):方法参数、返回类型声明、
//! Cell/Base/Client 分面、Property flags、调用权限元数据。
//!
//! - 分面 = .def 三段(BaseMethods/CellMethods/ClientMethods),逐方法记录
//!   声明 site(name span + 1 基行)+ 出处(root/version 经
//!   [`crate::graph::TypeGraph::set_ingest`] 上下文,provenance 同口径);
//! - 参数 = `<Arg>` 原文 + 类型引用(kode-parser collect_type_refs 同口径,
//!   ARRAY/FIXED_DICT 指令剥离 + `<of>` 文本);**引擎 RPC 参数无具名**,
//!   如实不造参数名;指令独占的 Arg 产出空 ref,如实;
//! - 返回类型 = def `<ReturnType>` 直文本声明(TS definitionSemantics
//!   getScalarChildValue 同口径;def 格式无返回值网络序列化,该声明供
//!   inlay/导航消费——Python 推导居 RUST-PRECISION 面,两者互补不混流);
//! - 调用权限 = `Exposed` truthy + 分面:Base/Cell 分面的 Exposed = 客户端
//!   可调(引擎 exposedMethods);Client 分面 = 服务端→客户端方向,不因
//!   无 Exposed 而不可达——事实记录在此,解释居消费面;
//! - Property flags:`DefFile.properties[].flags`(规范化 token)已由
//!   kode-parser 承载,本模块不重复建模(def 旗标语义居
//!   defAnalyzer/CELL-08 各面)。
//!
//! 注册时机:`add_def` 灌入时逐方法登记;同名实体重复 add_def 整体跳过
//! (节点 first-write-wins 同口径),不产生重复方法条目。

use kode_parser::Span;

use crate::graph::TypeGraph;
use crate::provenance::{TypeOrigin, TypeSourceKind};

/// 方法分面(.def 三段)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MethodFacet {
    Base,
    Cell,
    Client,
}

impl MethodFacet {
    pub fn as_str(&self) -> &'static str {
        match self {
            MethodFacet::Base => "base",
            MethodFacet::Cell => "cell",
            MethodFacet::Client => "client",
        }
    }
}

/// 方法参数:原文 + 类型引用(顺序保留;无具名,引擎 RPC 参数无名字)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodArg {
    pub text: String,
    pub type_refs: Vec<String>,
}

/// 方法元数据(单条 = 一个实体某分面的一个方法声明)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MethodMeta {
    /// 所属实体(add_def 的 name 参数,= 文件名去 .def)。
    pub entity: String,
    pub facet: MethodFacet,
    pub name: String,
    pub args: Vec<MethodArg>,
    /// def `<ReturnType>` 直文本声明;缺/空 = None(如实,不猜)。
    pub return_type: Option<String>,
    /// `<Exposed>` truthy(调用权限事实;语义见模块doc)。
    pub exposed: bool,
    /// 方法声明名 0 基字节区间(parser name_span)。
    pub span: Span,
    /// 方法声明行(parser 1 基)。
    pub line: usize,
    /// 出处(root/version 携带灌入上下文)。
    pub origin: TypeOrigin,
}

impl TypeGraph {
    /// 某实体的全部方法(分面登记序 = def 文件段序,稳定)。
    pub fn entity_methods(&self, entity: &str) -> Vec<&MethodMeta> {
        self.methods.iter().filter(|m| m.entity == entity).collect()
    }

    /// 某实体某分面的方法。
    pub fn methods_by_facet(&self, entity: &str, facet: MethodFacet) -> Vec<&MethodMeta> {
        self.methods
            .iter()
            .filter(|m| m.entity == entity && m.facet == facet)
            .collect()
    }

    /// 调用权限面:某实体 Exposed truthy 的方法(跨分面,登记序)。
    pub fn exposed_methods(&self, entity: &str) -> Vec<&MethodMeta> {
        self.methods
            .iter()
            .filter(|m| m.entity == entity && m.exposed)
            .collect()
    }

    /// 从 .def 灌入方法元数据(add_def 内部调用;公开度 pub(crate) 防绕过
    /// 出处上下文)。重复实体(add_def 节点被 first-write-wins 拒绝)不达
    /// 此处,无重复条目。
    pub(crate) fn record_methods(&mut self, entity: &str, def: &kode_parser::model::DefFile) {
        for (facet, ms) in [
            (MethodFacet::Base, &def.base_methods),
            (MethodFacet::Cell, &def.cell_methods),
            (MethodFacet::Client, &def.client_methods),
        ] {
            for m in ms {
                let origin = self.origin_for(TypeSourceKind::Def, Some(m.name_span), Some(m.line));
                self.methods.push(MethodMeta {
                    entity: entity.to_string(),
                    facet,
                    name: m.name.clone(),
                    args: m
                        .args
                        .iter()
                        .cloned()
                        .zip(&m.arg_type_refs)
                        .map(|(text, refs)| MethodArg {
                            text,
                            type_refs: refs.clone(),
                        })
                        .collect(),
                    return_type: m.return_type.clone(),
                    exposed: m.exposed,
                    span: m.name_span,
                    line: m.line,
                    origin,
                });
            }
        }
    }
}
