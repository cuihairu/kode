//! BAS-10 共享查询契约。
//!
//! 边界:Rust 事实查询与 TS/LSP 消费。`$/kode/rpc` 单臂 dispatch 已在
//! [`crate::rpc`](crate::rpc)(Value 进出);本模块定义**语义查询的请求/响应
//! 契约**(serde JSON,kind-tagged),同一结构供 hover/completion/definition/
//! diagnostics 消费。缺服务可降级:[`QueryResponse::Unavailable`] 是**定义好
//! 的降级值,不是错误**——服务不在/查询未接线时消费方按该响应回退,
//! 不抛、不空转。
//!
//! 契约协议(TS 消费面):
//! - 请求 `{"kind":"exprKind","params":{"uri","line","col"}}` → 响应
//!   `{"kind":"exprKind","data":{...}|null}`;
//! - `bindingAt` → `bindingAt`(局部绑定视图);
//! - `entitySnapshot` → `entitySnapshot`(快照视图,关键面);
//! - `invalidate` → `invalidate`(失效文档 uri 列表);
//! - `typeAt` → `unavailable`(类型解析未接线,诚实降级,不猜);
//! - `ping` → `ping{available}`(服务健康面)。
//!
//! 位置查询(exprKind/bindingAt)由调用方供 `source`(文档全文,TS 已读盘);
//! 引擎不重读盘。文档身份:uri 为契约键,root 映射由引擎构造时给定
//! ([`ContractEngine::new`] 的 root 上下文)——多根同 uri 的歧义由 root
//! 分配语义承载,契约本身不带 root(与 VFS 键分工,不重造)。

use serde::{Deserialize, Serialize};

use kode_python::ParsedAst;
use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::uri::CanonicalUri;

use super::deps::DependencyGraph;
use super::expr::{collect_assign_events, expr_kind_at, local_binding_at, ExprKind};
use super::snapshot::EntitySnapshot;
use super::store::{def_name_from_key, ProjectDefResolver, SnapshotStore};
use kode_parser::model::DefFile;
use kode_types::TypeGraph;

/// 查询请求(kind-tagged JSON;TS 消费面)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "params", rename_all = "camelCase")]
pub enum QueryRequest {
    /// 位置表达式来源(BAS-07;`source` = 文档全文)。
    ExprKind { uri: String, line: usize, col: usize },
    /// 位置类型显示(BAS-04;当前未接线 → Unavailable 诚实降级)。
    TypeAt { uri: String, line: usize, col: usize },
    /// 名称局部绑定(BAS-07;`source` = 文档全文)。
    BindingAt { uri: String, line: usize, col: usize, name: String },
    /// 实体声明快照(BAS-05;按文档键)。
    EntitySnapshot { uri: String },
    /// 依赖失效集(BAS-09;单文件变更相关项)。
    Invalidate { uri: String },
    /// 服务健康(降级面探针)。
    Ping,
}

/// 表达式来源视图(serde;镜像 [`ExprKind`] 核心型)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "camelCase")]
pub enum ExprKindView {
    Attribute { base: String, attr: String },
    Subscript { base: String, key: Option<String> },
    Call { callee: String },
    LocalAssign { target: String },
    Unknown { reason: String },
}

impl From<&ExprKind> for ExprKindView {
    fn from(k: &ExprKind) -> Self {
        match k {
            ExprKind::Attribute { base, attr } => ExprKindView::Attribute { base: base.clone(), attr: attr.clone() },
            ExprKind::Subscript { base, key } => ExprKindView::Subscript { base: base.clone(), key: key.clone() },
            ExprKind::Call { callee } => ExprKindView::Call { callee: callee.clone() },
            ExprKind::LocalAssign { target } => ExprKindView::LocalAssign { target: target.clone() },
            ExprKind::Unknown(r) => ExprKindView::Unknown { reason: r.clone() },
        }
    }
}

/// 局部绑定视图(BAS-07)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingView {
    pub line: usize,
    pub col: usize,
    pub target: String,
    pub value: ExprKindView,
}

/// 实体快照视图(BAS-05 关键面:身份/继承/接口/属性/冲突/诊断)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotView {
    pub name: String,
    pub parent_chain: Vec<String>,
    pub interfaces: Vec<String>,
    pub property_names: Vec<String>,
    pub conflict_names: Vec<String>,
    pub issue_severities: Vec<String>,
}

impl From<&EntitySnapshot> for SnapshotView {
    fn from(s: &EntitySnapshot) -> Self {
        SnapshotView {
            name: s.parent_chain.first().cloned().unwrap_or_default(),
            parent_chain: s.parent_chain.clone(),
            interfaces: s.interfaces.clone(),
            property_names: s.properties.iter().map(|p| p.name.clone()).collect(),
            conflict_names: s.conflicts.iter().map(|c| c.name.clone()).collect(),
            issue_severities: s.issues.iter().map(|i| i.severity().as_str().to_string()).collect(),
        }
    }
}

/// 查询响应(同一结构供 hover/completion/definition/diagnostics)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum QueryResponse {
    ExprKind(Option<ExprKindView>),
    TypeAt(Option<String>),
    BindingAt(Option<BindingView>),
    EntitySnapshot(Option<SnapshotView>),
    Invalidate(Vec<String>),
    Ping { available: bool },
    /// 缺服务可降级(未接线/服务不在 → 该值,不报错)。
    Unavailable { reason: String },
}

impl QueryResponse {
    /// 降级判定(消费方统一回退入口)。
    pub fn is_unavailable(&self) -> bool {
        matches!(self, QueryResponse::Unavailable { .. })
    }
}

/// 语义查询服务边界(对象安全;缺服务由 [`QueryResponse::Unavailable`] 表达)。
pub trait SemanticQueryService {
    /// 服务可用性(整体面;单查询降级由响应 Unavailable 细粒度表达)。
    fn available(&self) -> bool;

    /// 执行查询。`source` = 位置查询的文档全文(调用方已读盘);
    /// 非位置查询传 None。
    fn query(&self, req: &QueryRequest, source: Option<&str>) -> QueryResponse;
}

/// 最小契约引擎:能答的答,不能答的**诚实降级**(Unavailable,不猜)。
///
/// - ExprKind/BindingAt:解析 `source`(kode-python ParsedAst)走 BAS-07;
/// - EntitySnapshot:从注入的 [`SnapshotStore<DefFile>`] 取文档 def,经
///   [`ProjectDefResolver`] 构建(类型图注入或空图);
/// - Invalidate:注入 [`DependencyGraph`] 直接消费者;
/// - TypeAt:未接线 → Unavailable(类型解析属流面,消费边界待接);
/// - Ping:available()。
#[derive(Debug)]
pub struct ContractEngine {
    root: RootId,
    graph: TypeGraph,
    defs: Option<SnapshotStore<DefFile>>,
    deps: Option<DependencyGraph>,
    available: bool,
}

impl ContractEngine {
    pub fn new(root: RootId) -> Self {
        Self {
            root,
            graph: TypeGraph::new(),
            defs: None,
            deps: None,
            available: false,
        }
    }

    /// 注入 def 快照库(实体快照查询面)。
    pub fn with_defs(mut self, defs: SnapshotStore<DefFile>) -> Self {
        self.defs = Some(defs);
        self.available = true;
        self
    }

    /// 注入依赖图(失效查询面)。
    pub fn with_deps(mut self, deps: DependencyGraph) -> Self {
        self.deps = Some(deps);
        self.available = true;
        self
    }

    fn key(&self, uri: &str) -> DocumentKey {
        DocumentKey::new(self.root, CanonicalUri::from_path(uri))
    }
}

impl SemanticQueryService for ContractEngine {
    fn available(&self) -> bool {
        self.available
    }

    fn query(&self, req: &QueryRequest, source: Option<&str>) -> QueryResponse {
        match req {
            QueryRequest::ExprKind { uri: _, line, col } => {
                let Some(src) = source else {
                    return QueryResponse::Unavailable { reason: "source-missing".into() };
                };
                let ast = ParsedAst::new(src);
                match expr_kind_at(&ast, *line, *col) {
                    Some(k) => QueryResponse::ExprKind(Some(ExprKindView::from(&k))),
                    None => QueryResponse::ExprKind(None),
                }
            }
            QueryRequest::BindingAt { uri: _, line, col, name } => {
                let Some(src) = source else {
                    return QueryResponse::Unavailable { reason: "source-missing".into() };
                };
                let ast = ParsedAst::new(src);
                let events = collect_assign_events(&ast);
                match local_binding_at(&events, *line, *col, name) {
                    Some(b) => QueryResponse::BindingAt(Some(BindingView {
                        line: b.line,
                        col: b.col,
                        target: b.target.clone(),
                        value: ExprKindView::from(&b.value),
                    })),
                    None => QueryResponse::BindingAt(None),
                }
            }
            QueryRequest::TypeAt { .. } => {
                QueryResponse::Unavailable { reason: "type-resolution-not-wired".into() }
            }
            QueryRequest::EntitySnapshot { uri } => {
                let Some(defs) = &self.defs else {
                    return QueryResponse::Unavailable { reason: "def-store-absent".into() };
                };
                let key = self.key(uri);
                let Some(own) = defs.get(&key) else {
                    return QueryResponse::EntitySnapshot(None);
                };
                let resolver = ProjectDefResolver::new(defs);
                let snap = EntitySnapshot::build(own, &resolver, &self.graph, self.root, &def_name_from_key(&key));
                QueryResponse::EntitySnapshot(Some(SnapshotView::from(&snap)))
            }
            QueryRequest::Invalidate { uri } => {
                let Some(deps) = &self.deps else {
                    return QueryResponse::Unavailable { reason: "deps-absent".into() };
                };
                let key = self.key(uri);
                QueryResponse::Invalidate(deps.consumers_of(&key).iter().map(|k| k.uri.to_uri_string()).collect())
            }
            QueryRequest::Ping => QueryResponse::Ping { available: self.available() },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expr_kind_contract_round_trip() {
        let e = QueryResponse::ExprKind(Some(ExprKindView::Call { callee: "self.load()".into() }));
        let v = serde_json::to_value(&e).unwrap();
        // 契约面:kind-tagged,TS 可判型。
        assert_eq!(v["kind"], "exprKind");
        assert_eq!(v["data"]["shape"], "call");
        assert_eq!(v["data"]["callee"], "self.load()");
        // 反序列化回原值。
        let back: QueryResponse = serde_json::from_value(v).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn request_round_trip_shape() {
        let r = QueryRequest::ExprKind { uri: "file:///a.py".into(), line: 1, col: 2 };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["kind"], "exprKind");
        assert_eq!(v["params"]["line"], 1);
        let back: QueryRequest = serde_json::from_value(v).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn unavailable_is_defined_degradation() {
        let e = ContractEngine::new(RootId(1));
        let r = e.query(&QueryRequest::TypeAt { uri: "x".into(), line: 0, col: 0 }, None);
        assert!(r.is_unavailable(), "未接线查询 = 定义好降级,不报错");
        assert_eq!(e.query(&QueryRequest::Ping, None), QueryResponse::Ping { available: false });
    }

    #[test]
    fn ping_reflects_wired_state() {
        let e = ContractEngine::new(RootId(1)).with_deps(DependencyGraph::new());
        assert_eq!(e.query(&QueryRequest::Ping, None), QueryResponse::Ping { available: true });
    }

    #[test]
    fn source_query_served_via_contract() {
        let e = ContractEngine::new(RootId(1)).with_defs(SnapshotStore::new());
        let src = "v = self.mgr.fetch()\n";
        match e.query(&QueryRequest::ExprKind { uri: "u".into(), line: 0, col: 4 }, Some(src)) {
            QueryResponse::ExprKind(Some(ExprKindView::Call { callee })) => {
                assert!(callee.contains("self.mgr.fetch"), "callee 全形态: {callee}");
            }
            other => panic!("expected Call view, got {other:?}"),
        }
        match e.query(&QueryRequest::BindingAt { uri: "u".into(), line: 0, col: 5, name: "v".into() }, Some(src)) {
            QueryResponse::BindingAt(Some(b)) => {
                assert_eq!(b.target, "v");
                assert!(matches!(b.value, ExprKindView::Call { .. }));
            }
            other => panic!("expected BindingAt, got {other:?}"),
        }
    }

    #[test]
    fn source_missing_is_degraded() {
        let e = ContractEngine::new(RootId(1));
        assert!(e.query(&QueryRequest::ExprKind { uri: "u".into(), line: 0, col: 0 }, None).is_unavailable());
        assert!(e.query(&QueryRequest::BindingAt { uri: "u".into(), line: 0, col: 0, name: "x".into() }, None).is_unavailable());
    }

    #[test]
    fn entity_snapshot_served_from_store() {
        let mut defs = SnapshotStore::new();
        let k = DocumentKey::new(RootId(1), CanonicalUri::from_path("/defs/Avatar.def"));
        defs.commit(super::super::store::Build::new(k, 1, kode_parser::model::parse_def(
            "<root><Properties><hp>INT32</hp></Properties></root>",
        )));
        let e = ContractEngine::new(RootId(1)).with_defs(defs);
        match e.query(&QueryRequest::EntitySnapshot { uri: "/defs/Avatar.def".into() }, None) {
            QueryResponse::EntitySnapshot(Some(s)) => {
                assert_eq!(s.name, "Avatar");
                assert!(s.property_names.iter().any(|p| p == "hp"));
            }
            other => panic!("expected snapshot view, got {other:?}"),
        }
    }

    #[test]
    fn invalidate_served_from_graph() {
        let mut deps = DependencyGraph::new();
        let p = DocumentKey::new(RootId(1), CanonicalUri::from_path("/defs/Monster.def"));
        let c = DocumentKey::new(RootId(1), CanonicalUri::from_path("/scripts/avatar.py"));
        deps.add_edge(&p, &c);
        let e = ContractEngine::new(RootId(1)).with_deps(deps);
        match e.query(&QueryRequest::Invalidate { uri: "/defs/Monster.def".into() }, None) {
            QueryResponse::Invalidate(v) => assert_eq!(v.len(), 1),
            other => panic!("expected invalidate list, got {other:?}"),
        }
    }

    #[test]
    fn defs_absent_snapshot_degrades() {
        let e = ContractEngine::new(RootId(1));
        assert!(e.query(&QueryRequest::EntitySnapshot { uri: "/defs/A.def".into() }, None).is_unavailable());
    }
}
