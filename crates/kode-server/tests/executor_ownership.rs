//! RUST-075-W 执行归属登记完整性:生产注册表(与 `ServerState::new()` 同源)
//! 全量断言——每个 `$/kode/rpc` 内层 method 归池(交互泳道),顶层 serving/
//! 顺序面一律内联。新增 handler 注册即自动进断言面,漏登记/误登记直接红。

use kode_server::executor::{execution_lane, ExecutionLane, PoolLane};
use kode_server::ServerState;

/// 顶层 method 面(非池):serving(hover/completion/definition/diagnostic/
/// health/workspace)与顺序语义(initialize/shutdown/exit/wait/cancel)。
const INLINE_METHODS: &[&str] = &[
    "initialize",
    "initialized",
    "shutdown",
    "exit",
    "$/cancelRequest",
    "$/kode/health",
    "$/kode/wait",
    "$/kode/workspace/didChangeConfiguration",
    "textDocument/hover",
    "textDocument/completion",
    "textDocument/definition",
    "textDocument/documentSymbol",
];

#[test]
fn every_registered_rpc_handler_is_routed_to_pool_interactive() {
    let state = ServerState::new();
    let snapshot = state.rpc.snapshot();
    assert!(
        snapshot.len() > 10,
        "生产注册表应有真实命令面(实测 {}),快照源断了就全归内联了",
        snapshot.len()
    );
    let mut count = 0;
    for method in snapshot.methods() {
        let lane = execution_lane(
            "$/kode/rpc",
            Some(&serde_json::json!({ "method": method })),
        );
        assert_eq!(
            lane,
            ExecutionLane::Pool(PoolLane::Interactive),
            "注册 handler {method} 未归池(登记漏项)"
        );
        count += 1;
    }
    assert!(count > 10, "断言面非空: {count} 个 handler 全数核过");
}

#[test]
fn serving_and_sequencing_faces_stay_inline() {
    for method in INLINE_METHODS {
        assert_eq!(
            execution_lane(method, None),
            ExecutionLane::Inline,
            "{method} 必须内联(泵交互预留/顺序语义面)"
        );
    }
}

#[test]
fn malformed_rpc_params_fall_back_inline_for_server_error_path() {
    // 形状非法:无内层 method → Inline,由 server 原样回 INVALID_PARAMS。
    assert_eq!(
        execution_lane("$/kode/rpc", Some(&serde_json::json!({}))),
        ExecutionLane::Inline
    );
    assert_eq!(
        execution_lane("$/kode/rpc", Some(&serde_json::json!({ "method": 42 }))),
        ExecutionLane::Inline
    );
    assert_eq!(execution_lane("$/kode/rpc", None), ExecutionLane::Inline);
}
