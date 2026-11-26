//! RUST-181 验收钉:数据库面与语义 Core 的连接 + DB driver 隔离。
//!
//! 两层命名固化:
//! ① 依赖图隔离——kode-server 与 kode-db-clone 的生产依赖里没有任何数据库
//!    驱动(mysql/sqlx/postgres/sqlite/redis/mongodb 全族);kode-db-clone 的
//!    mysql 驱动只许住在 [dev-dependencies](PDC-0601 testcontainers 门控,
//!    #[ignore] 默认不跑)。语言服务器二进制链接不到任何驱动,SQL 执行面
//!    整个留在 TS 扩展宿主(mysql2 动态装载 + 只读会话 + 语句白名单 +
//!    在途强杀守卫);Rust 侧只产计划(ExportPlanner 只读 SELECT 计划),
//!    不握任何 socket。kode-db-clone 生产依赖白名单同时钉死「未来任何人往
//!    该 crate 加网络客户端即红」。
//! ② 取数面归属——`$/kode/databaseSchema/build`(IDE-RUST-008,schema 视图
//!    与 drift 检查共同的表/列推导核)注册在生产注册表,且归池交互泳道 +
//!    纯 CPU 类别(与 RUST-180 配置取数同规则:用户主动刷新的视图取数
//!    不被后台硬顶拦截,也不许被误归 IO 表)。

use kode_server::executor::{
    execution_lane, rpc_job_kind, rpc_lane_class, ExecutionLane, PoolLane,
};
use kode_server::ServerState;

/// 生产依赖禁入的数据库驱动/网络客户端键(全族,防换皮)。
const FORBIDDEN_DRIVER_KEYS: &[&str] = &[
    "mysql",
    "mysql2",
    "sqlx",
    "postgres",
    "tokio-postgres",
    "rusqlite",
    "sqlite",
    "redis",
    "mongodb",
    "tiberius",
    "diesel",
    "sea-orm",
    "clickhouse",
];

/// kode-db-clone 生产依赖白名单(纯数据处理:序列化/哈希/加密/熵)。
/// 任何人往该 crate 加新生产依赖(哪怕看起来无害)都会红——隔离属性按
/// 清单钉死,不靠口头约定。
const DB_CLONE_ALLOWED_KEYS: &[&str] = &[
    "serde",
    "serde_json",
    "sha2",
    "chacha20poly1305",
    "getrandom",
];

/// 读 Cargo.toml,剥注释后按节归类,返回生产依赖节([dependencies] 与
/// [target.*.dependencies] 这类生产目标节)的依赖键集合。
/// [dev-dependencies]/[build-dependencies] 不算生产面。
fn production_dependency_keys(path: &std::path::Path) -> Vec<String> {
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("读 {} 失败: {e}", path.display()));
    let mut keys = Vec::new();
    let mut section = String::new();
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            section = line
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_string();
            continue;
        }
        let is_production = section == "dependencies"
            || (section.starts_with("target")
                && section.contains("dependencies")
                && !section.contains("dev-dependencies")
                && !section.contains("build-dependencies"));
        if !is_production {
            continue;
        }
        if let Some(key) = line.split('=').next() {
            keys.push(key.trim().to_string());
        }
    }
    keys
}

/// 读指定节([dev-dependencies] 等)的依赖键集合。
fn section_dependency_keys(path: &std::path::Path, want: &str) -> Vec<String> {
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("读 {} 失败: {e}", path.display()));
    let mut keys = Vec::new();
    let mut section = String::new();
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            section = line
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_string();
            continue;
        }
        if section != want {
            continue;
        }
        if let Some(key) = line.split('=').next() {
            keys.push(key.trim().to_string());
        }
    }
    keys
}

fn manifest(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(name)
}

#[test]
fn db_drivers_stay_out_of_production_dependency_graph() {
    // kode-server 主二进制:生产依赖零驱动(黑名单)
    let server_keys = production_dependency_keys(&manifest("Cargo.toml"));
    for key in &server_keys {
        assert!(
            !FORBIDDEN_DRIVER_KEYS.contains(&key.as_str()),
            "kode-server 生产依赖出现数据库驱动 `{key}`:语言服务器二进制不得链接任何 DB 客户端(SQL 执行面归 TS 扩展宿主)"
        );
    }

    // kode-db-clone:生产依赖白名单钉死(多一个键即红)
    let clone_path = manifest("../kode-db-clone/Cargo.toml");
    let clone_keys = production_dependency_keys(&clone_path);
    for key in &clone_keys {
        assert!(
            DB_CLONE_ALLOWED_KEYS.contains(&key.as_str()),
            "kode-db-clone 生产依赖出现白名单外键 `{key}`:该 crate 只许纯数据处理(计划/归档/脱敏),网络与 DB 客户端禁止进入"
        );
    }

    // 非空守卫:解析器真读到了内容(防静默解析失败造假绿)
    assert!(
        server_keys.len() >= 10 && clone_keys.len() == DB_CLONE_ALLOWED_KEYS.len(),
        "依赖清单解析异常(server={} keys, clone={} keys),隔离断言失去意义",
        server_keys.len(),
        clone_keys.len()
    );

    // mysql 驱动确实存在但只在 dev-dependencies(PDC-0601 门控集成测试)
    let dev_keys = section_dependency_keys(&clone_path, "dev-dependencies");
    assert!(
        dev_keys.iter().any(|k| k == "mysql"),
        "kode-db-clone 的 mysql 驱动应住在 [dev-dependencies](testcontainers 门控);整条消失说明测试面被拆,白名单契约失效"
    );
}

#[test]
fn schema_view_data_face_is_registered_pool_interactive_cpu() {
    let state = ServerState::new();
    let snapshot = state.rpc.snapshot();
    let registered: std::collections::HashSet<&str> = snapshot.methods().collect();
    let method = "$/kode/databaseSchema/build";
    assert!(
        registered.contains(method),
        "schema 推导核未在生产注册表:schema 视图与 drift 检查将整体退回 TS 回落核(语义 Core 连接断了)"
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
        "{method} 须纯 CPU 类别:入参是 TS 已收集的属性描述符树,handler 是纯推导;误入 IO 表会占后台硬顶且语义失真"
    );
    assert_eq!(rpc_job_kind(method), kind, "{method} 双投影须一致");
}
