//! RUST-180 验收钉:配置合并视图取数面的执行归属——`$/kode/config/resolve`
//! 与 `$/kode/config/derive` 命名断言归池交互泳道 + 纯 CPU 类别,语言
//! serving 面(hover/completion/definition)恒内联。「配置合并视图
//! (来源/优先级/冲突/最终值)不阻塞语言请求」的架构属性在此命名钉死:
//! 视图取数走 worker 池交互泳道(交互预留位恒准入,后台硬顶拦不住),
//! serving 面在主线程内联执行,两轨零共享;视图面误入 IO 表或后台泳道
//! 即红(慢解析占后台位无谓、被 IO 硬顶挡住则是真回归)。

use kode_server::executor::{
    execution_lane, rpc_job_kind, rpc_lane_class, ExecutionLane, PoolLane,
};
use kode_server::ServerState;

/// 配置合并视图的两个取数面(视图命令 kbengine.config.visualize 与
/// 最终配置虚拟文档 showFinal 的共同数据源,TS 侧经
/// ensureConfigResolved 单槽缓存消费)。
const CONFIG_VIEW_DATA_METHODS: &[&str] = &["$/kode/config/resolve", "$/kode/config/derive"];

/// 语言 serving 面样本(与视图取数并行不相阻的另一方)。
const SERVING_METHODS: &[&str] = &[
    "textDocument/hover",
    "textDocument/completion",
    "textDocument/definition",
];

#[test]
fn config_view_data_faces_are_registered_pool_interactive_cpu() {
    let state = ServerState::new();
    let snapshot = state.rpc.snapshot();
    let registered: std::collections::HashSet<&str> = snapshot.methods().collect();
    for method in CONFIG_VIEW_DATA_METHODS {
        assert!(
            registered.contains(method),
            "配置取数面 {method} 未在生产注册表(数据源断了,视图将整体退回 TS 回落核)"
        );
        let lane = execution_lane("$/kode/rpc", Some(&serde_json::json!({ "method": method })));
        assert!(
            matches!(lane, ExecutionLane::Pool(PoolLane::Interactive)),
            "{method} 须归池交互泳道(用户主动刷新的视图取数,不该被后台调度语义处置)"
        );
        let (pool_lane, kind) = rpc_lane_class(method);
        assert_eq!(
            pool_lane,
            PoolLane::Interactive,
            "{method} 泳道须交互位(交互预留位恒准入,后台两类硬顶都拦不住它)"
        );
        assert!(
            matches!(kind, kode_scheduler::lane::TaskLane::Cpu),
            "{method} 须纯 CPU 类别:TS 已读盘传文本、handler 是纯解析;入 IO 表会占后台硬顶且语义失真"
        );
        assert_eq!(rpc_job_kind(method), kind, "{method} 双投影须一致");
    }
}

#[test]
fn language_serving_faces_stay_inline_beside_config_view() {
    for method in SERVING_METHODS {
        assert_eq!(
            execution_lane(method, None),
            ExecutionLane::Inline,
            "{method} 必须内联:配置取数在池里排队再久,主线程 serving 面也不经过池"
        );
    }
}
