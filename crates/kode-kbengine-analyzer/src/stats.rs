//! 消息/流量统计 + 报告装配(PA-005 验收「消息/流量统计」+ analyze 入口)。

use std::collections::BTreeMap;

use serde::Serialize;

use crate::connections::{self, ConnectionReport};
use crate::correlate;
use crate::latency;
use crate::record::{Direction, Record};
use crate::report::{AnalysisOptions, Report};
use crate::CONFIRMED_PAIRS;

/// 协议确证对规格(请求名 → 可接受响应名集)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PairSpec {
    pub request: &'static str,
    pub responses: &'static [&'static str],
}

/// 按消息名的计数面。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct MessageStat {
    pub count: usize,
    pub bytes: usize,
    pub c2s: usize,
    pub s2c: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct TrafficStat {
    pub records: usize,
    pub payload_bytes: usize,
}

/// 消息/流量统计(验收「消息/流量统计」;未知消息不计入 message_stats,
/// 以 meta.unknown_messages 呈现,不静默丢弃)。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StatsReport {
    /// 消息名 → 计数/字节/方向(BTreeMap = 确定序)。
    pub message_stats: BTreeMap<String, MessageStat>,
    pub traffic: TrafficTotal,
    pub unknown_messages: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct TrafficTotal {
    pub records: usize,
    pub c2s: TrafficStat,
    pub s2c: TrafficStat,
}

/// 统计一遍(纯函数;不改记录序)。
pub fn compute_stats(records: &[Record]) -> StatsReport {
    let mut out = StatsReport::default();
    for r in records {
        out.traffic.records += 1;
        match r.direction_or_derived() {
            Some(Direction::ClientToServer) => {
                out.traffic.c2s.records += 1;
                out.traffic.c2s.payload_bytes += r.payload_len;
            }
            Some(Direction::ServerToClient) => {
                out.traffic.s2c.records += 1;
                out.traffic.s2c.payload_bytes += r.payload_len;
            }
            None => {}
        }
        match &r.name {
            Some(name) => {
                let s = out.message_stats.entry(name.clone()).or_default();
                s.count += 1;
                s.bytes += r.payload_len;
                match r.direction_or_derived() {
                    Some(Direction::ClientToServer) => s.c2s += 1,
                    Some(Direction::ServerToClient) => s.s2c += 1,
                    None => {}
                }
            }
            None => out.unknown_messages += 1,
        }
    }
    out
}

/// 分析入口:一组解码记录 → JSON 可序列化报告(验收原文)。
pub fn analyze(records: &[Record], _opts: &AnalysisOptions) -> Report {
    let stats = compute_stats(records);
    let correlations = correlate::correlate(records, CONFIRMED_PAIRS);
    let latency = latency::measure(&correlations);
    let anomalies = crate::report::detect_anomalies(records);
    let entity_timeline = crate::report::build_entity_timeline(records);
    let connections: ConnectionReport = connections::analyze(records);
    Report {
        meta: crate::report::ReportMeta {
            record_count: records.len(),
            unknown_messages: stats.unknown_messages,
        },
        message_stats: stats.message_stats,
        traffic: stats.traffic,
        correlations,
        latency,
        anomalies,
        entity_timeline,
        connections,
    }
}
