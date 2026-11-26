//! RUST-075-W / RUST-076-W 执行归属登记完整性:生产注册表(与
//! `ServerState::new()` 同源)全量断言——每个 `$/kode/rpc` 内层 method 归池
//! 并按单一分类源(`rpc_lane_class`)拿到 (泳道, LaneGate 类别);顶层
//! serving/顺序面一律内联。新增 handler 注册即自动进断言面,漏登记(缺省
//! Cpu 仍能跑但可审计)/陈旧 IO 登记(表内面已注销)直接红。

use kode_server::executor::{
    execution_lane, rpc_job_kind, rpc_lane_class, ExecutionLane, PoolLane,
};
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
fn every_registered_rpc_handler_is_routed_to_pool_with_lane_class() {
    let state = ServerState::new();
    let snapshot = state.rpc.snapshot();
    assert!(
        snapshot.len() > 10,
        "生产注册表应有真实命令面(实测 {}),快照源断了就全归内联了",
        snapshot.len()
    );
    let mut count = 0;
    let mut io_count = 0;
    for method in snapshot.methods() {
        let lane = execution_lane("$/kode/rpc", Some(&serde_json::json!({ "method": method })));
        assert!(
            matches!(lane, ExecutionLane::Pool(_)),
            "注册 handler {method} 未归池(登记漏项)"
        );
        // 单一分类源:池泳道与 LaneGate 类别同源成对;每面必属三类之一。
        let (pool_lane, kind) = rpc_lane_class(method);
        assert_eq!(
            pool_lane,
            match lane {
                ExecutionLane::Pool(l) => l,
                ExecutionLane::Inline => unreachable!("matched above"),
            },
            "{method} 池泳道与 execution_lane 决策不一致"
        );
        assert!(
            matches!(
                kind,
                kode_scheduler::lane::TaskLane::Io | kode_scheduler::lane::TaskLane::Cpu
            ),
            "{method} 类别须 Io/Cpu(交互面走池交互预留位,不单列)"
        );
        assert_eq!(rpc_job_kind(method), kind, "{method} 双投影须一致");
        if matches!(kind, kode_scheduler::lane::TaskLane::Io) {
            assert_eq!(
                pool_lane,
                PoolLane::Background,
                "{method} IO 面须归后台泳道(不占交互位)"
            );
            io_count += 1;
        }
        count += 1;
    }
    assert!(count > 10, "断言面非空: {count} 个 handler 全数核过");
    assert!(
        io_count >= 5,
        "IO 显式表应有真实登记面(实测 {io_count}),表清空即分类源断了"
    );
}

#[test]
fn io_table_has_no_stale_registrations() {
    // 陈旧登记检查:IO 表里每个面都必须仍存在于生产注册表——方法改名/
    // 注销后忘清表,该面将永远按 IO 装配(静默漂移),此处直接红。
    let state = ServerState::new();
    let snapshot = state.rpc.snapshot();
    let registered: std::collections::HashSet<&str> = snapshot.methods().collect();
    for method in [
        "$/kode/dbClone/export",
        "$/kode/dbClone/inspectArchive",
        "$/kode/dbClone/readArchiveRows",
        "$/kode/ruff/format",
        "$/kode/ruff/lint",
        "$/kode/workspace/scanAnchors",
    ] {
        assert!(
            registered.contains(method),
            "IO 表登记面 {method} 已不在生产注册表(陈旧登记,清表或改名)"
        );
    }
}

#[test]
fn ruff_format_classifies_as_background_io_like_lint() {
    // KODE-FULL-004:format 走 stdin→stdout 管道外部进程,与 lint 同归后台
    // IO 面(漏登记则占交互位,挂起时饿死交互请求)。
    for method in ["$/kode/ruff/format", "$/kode/ruff/lint"] {
        let (pool_lane, kind) = rpc_lane_class(method);
        assert_eq!(pool_lane, PoolLane::Background, "{method} 须归后台泳道");
        assert_eq!(kind, kode_scheduler::lane::TaskLane::Io);
    }
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
