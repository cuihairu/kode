//! 通用命令 RPC 面(Phase0 接线):`$/kode/rpc` 单臂 dispatch + handler 注册表。
//!
//! 生成/消息表/lint 等用户主动命令在 Rust 侧各加一个 handler 并在此注册,
//! 不再扩 `server.rs` 的顶层 match 臂(那是 hover/completion 等 serving 面)。
//! handler 是纯函数:params 由 TS 侧直传(TS 已读盘,不依赖 mirror 语料),
//! 返回 JSON 结果或 Err(文案回 TS 兜底路径,不视为 Rust 断言失败)。
//!
//! 后续增量(消息表/生成/lint)各自实现 `pub fn register(reg: &mut RpcRegistry)`,
//! 在 `ServerState::new()` 里 `crate::<mod>::register(&mut rpc)` 注册 —— 每个
//! 增量只碰自己模块 + server.rs 一行,互不冲突,可并行。

use std::collections::BTreeMap;

use serde_json::Value;

/// 一个命令 handler:入参 = `$/kode/rpc` 的 params(任意 JSON),出 = 结果 JSON。
/// Err = 输入/内部错误,TS 侧按不可用回退(不 panic,不杀 server)。
pub type RpcHandler = fn(Value) -> Result<Value, String>;

/// 命令注册表:method(如 `$/kode/messageTable/build`)→ handler。
/// 注册顺序稳定(BTreeMap),健康面可列举。
#[derive(Debug, Default)]
pub struct RpcRegistry {
    handlers: BTreeMap<String, RpcHandler>,
}

impl RpcRegistry {
    pub fn new() -> Self {
        let mut reg = RpcRegistry::default();
        register_builtins(&mut reg);
        reg
    }

    /// 注册一个命令 handler;重复注册同一 method 是编程错误,panic 防静默覆盖。
    pub fn register(&mut self, method: &'static str, handler: RpcHandler) {
        let prev = self.handlers.insert(method.to_string(), handler);
        assert!(prev.is_none(), "rpc method {method} registered twice");
    }

    /// 派发一个命令;未注册 method → Err(与顶层未知方法同口径文案)。
    pub fn dispatch(&self, method: &str, params: Value) -> Result<Value, String> {
        match self.handlers.get(method) {
            Some(handler) => handler(params),
            None => Err(format!("method not found: {method}")),
        }
    }

    /// 已注册 method 列表(健康/对账面)。
    pub fn methods(&self) -> impl Iterator<Item = &str> {
        self.handlers.keys().map(|k| k.as_str())
    }

    /// RUST-075-W:可跨线程快照(fn 指针 Send+Sync)——worker 池持有这份
    /// 快照执行纯 handler,与主线程 ServerState 零共享。同一注册源派生,
    /// 一致性由 snapshot_matches_registry 锁定。
    pub fn snapshot(&self) -> RegistrySnapshot {
        RegistrySnapshot {
            handlers: self.handlers.clone(),
        }
    }
}

/// RUST-068-W:信封级 span id(`$/kode/rpc` params 顶层 `spanId` 字符串,
/// TS 请求入口生成)。缺省/非字符串 = None(纯服务端发起调用无 span)。
/// 只回捞不校验语义,日志面只印值不印 params(脱敏)。
pub fn span_id_of(params: Option<&Value>) -> Option<&str> {
    params
        .and_then(|p| p.get("spanId"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
}

/// 注册表快照(worker 池的派发依据):字段与 RpcRegistry 同源同形,
/// 快照后注册表再变化不回流(注册只发生在构造期,无运行期增注册)。
#[derive(Debug, Default, Clone)]
pub struct RegistrySnapshot {
    handlers: BTreeMap<String, RpcHandler>,
}

impl RegistrySnapshot {
    /// 派发一个命令;未注册 method → Err(与 RpcRegistry 同口径文案)。
    pub fn dispatch(&self, method: &str, params: Value) -> Result<Value, String> {
        match self.handlers.get(method) {
            Some(handler) => handler(params),
            None => Err(format!("method not found: {method}")),
        }
    }

    /// 已注册 method 列表(对账面)。
    pub fn methods(&self) -> impl Iterator<Item = &str> {
        self.handlers.keys().map(|k| k.as_str())
    }

    /// 已注册 method 数。
    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }
}

/// 内建 handler(Phase0 自检):echo 原样回显,验 dispatch 链路贯穿。
/// 测试/传输健康探针入口(TS 侧仅测试夹具消费),非用户功能面。
fn echo(params: Value) -> Result<Value, String> {
    Ok(params)
}

/// 注册内建 handler;增量命令(消息表/生成/lint)各自在自身模块提供
/// `register()`,由 `ServerState::new()` 调用,不挤在这一处。
pub fn register_builtins(reg: &mut RpcRegistry) {
    reg.register("$/kode/echo", echo);
}
