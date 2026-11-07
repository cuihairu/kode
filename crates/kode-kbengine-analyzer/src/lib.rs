//! kode2 KBEngine 分析引擎(todo PA-005 Phase 3)。
//!
//! 验收原文:「独立分析一组解码消息出 JSON 报告」。输入 = 解码记录集
//! (PA-004 `capture analyze --records` 的 JSON 形状;字段子集,serde 容忍
//! 多余字段),输出 = [`report::Report`] JSON。能力面:
//!
//! - `stats`:消息/流量统计(按名/按方向,未知消息计数不丢弃);
//! - `correlate`:请求响应关联 —— **仅协议确证标识**:只按取证文档
//!   (docs/kbengine-wire-protocol.md §6)确证的请求→响应对、同 Flow 内
//!   同类型 FIFO 配对;相邻消息绝不猜配;
//! - `latency`:配对双方时间戳齐备时的 P50/P95/P99(nearest-rank);
//! - `anomalies`:未知消息 / 非法长度(取证最小长度表)/ 解码期异常透传
//!   (Schema 不匹配);
//! - `timeline`:Entity 事件与 RPC 时间线(实体为键);
//! - `connections`:登录 / 切 Baseapp / 重连事件面。
//!
//! 零第三方依赖(serde/serde_json 仅报告序列化,PA-002 先例)。

pub mod connections;
pub mod correlate;
pub mod latency;
pub mod record;
pub mod report;
pub mod stats;

pub use record::{Direction, Record, RecordAnomaly};
pub use report::{AnalysisOptions, Report};
pub use stats::{analyze, PairSpec};

/// 协议确证的请求→响应对(docs/kbengine-wire-protocol.md §6;只认这份
/// 取证表,响应名不在表内的 downlink 不配对)。
pub const CONFIRMED_PAIRS: &[PairSpec] = &[
    PairSpec {
        request: "Loginapp::hello",
        responses: &["Client::onHelloCB"],
    },
    PairSpec {
        request: "Baseapp::hello",
        responses: &["Client::onHelloCB"],
    },
    PairSpec {
        request: "Loginapp::login",
        responses: &["Client::onLoginSuccessfully", "Client::onLoginFailed"],
    },
    PairSpec {
        request: "Baseapp::loginBaseapp",
        responses: &["Client::onCreatedProxies", "Client::onLoginBaseappFailed"],
    },
    PairSpec {
        request: "Baseapp::reloginBaseapp",
        responses: &[
            "Client::onReloginBaseappSuccessfully",
            "Client::onReloginBaseappFailed",
        ],
    },
];
