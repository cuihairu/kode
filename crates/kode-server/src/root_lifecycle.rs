//! RUST-069-W:工作区根生命周期接线——WorkspaceSession 接管服务端唯一根
//! 注册表。新增/移除根经真实 RPC 落到 session:注册表更新(根 id 只经
//! session 发号,化身隔离,id 永不复用)+ 共享缓存按登记序扇出清除
//! (document-store 镜像 overlay / hover-engine 符号+语料+def 候选),回执
//! 带每消费面清除数(ARCH-004)。
//!
//! 走顶层请求臂而非 RpcRegistry:根生命周期要动 `&mut ServerState`
//! (注册表 + 缓存扇出),不是纯函数命令。请求而非通知:回执可供装配
//! 测试断言扇出清理确实发生(未知根诚实回 removed:false,不抛不猜)。

use serde_json::{json, Value};

use kode_protocol::{error_codes, Request, Response};

use crate::server::ServerState;

/// `$/kode/workspace/rootAdded` `{ path }` → `{ root }`(幂等:同路径重复
/// 注册返回既有 id)。
pub fn handle_root_added(state: &mut ServerState, request: Request) -> Response {
    let Some(path) = root_path(&request) else {
        return Response::error(
            Some(request.id),
            error_codes::INVALID_PARAMS,
            "rootAdded requires non-empty string `path`",
        );
    };
    let root = state.session.add_root(&path);
    Response::success(request.id, json!({ "root": root.0 }))
}

/// `$/kode/workspace/rootRemoved` `{ path }` → 已注册根
/// `{ removed: true, root, invalidated: [[sink, cleared]...] }`(按登记序);
/// 未知根 `{ removed: false }`(无扇出)。
pub fn handle_root_removed(state: &mut ServerState, request: Request) -> Response {
    let Some(path) = root_path(&request) else {
        return Response::error(
            Some(request.id),
            error_codes::INVALID_PARAMS,
            "rootRemoved requires non-empty string `path`",
        );
    };
    let Some(removal) = state.session.remove_root(&path) else {
        return Response::success(request.id, json!({ "removed": false }));
    };
    // RUST-069-W 撤根清缓存的队列侧延伸(RUST-070/071/073):该根的待执行
    // 索引刷新全部摘除——撤根后残留刷新会把旧根语料重新灌回(复活缺陷)。
    let purged = state.index.purge_root(removal.root);
    let invalidated: Vec<Value> = removal
        .invalidated
        .iter()
        .map(|(sink, cleared)| json!([sink, cleared]))
        .collect();
    Response::success(
        request.id,
        json!({
            "removed": true,
            "root": removal.root.0,
            "invalidated": invalidated,
            "purgedPendingRefresh": purged,
        }),
    )
}

/// `$/kode/workspace/roots` → `{ roots: [[id, path]...] }`(装配/测试对账面)。
pub fn handle_roots_list(state: &mut ServerState, request: Request) -> Response {
    let roots: Vec<Value> = state
        .session
        .roots()
        .iter()
        .map(|(root, path)| json!([root.0, path]))
        .collect();
    Response::success(request.id, json!({ "roots": roots }))
}

fn root_path(request: &Request) -> Option<String> {
    request
        .params
        .as_ref()
        .and_then(|params| params.get("path"))
        .and_then(Value::as_str)
        .map(|path| path.to_string())
        .filter(|path| !path.is_empty())
}
