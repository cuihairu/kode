//! Message/traffic statistics + report assembly (the PA-005 acceptance item
//! "message/traffic statistics" + the analyze entry point).

use std::collections::BTreeMap;

use serde::Serialize;

use crate::connections::{self, ConnectionReport};
use crate::correlate;
use crate::latency;
use crate::record::{Direction, Record};
use crate::report::{AnalysisOptions, Report};
use crate::CONFIRMED_PAIRS;

/// Protocol-confirmed pair specification (request name -> accepted response name set).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PairSpec {
    pub request: &'static str,
    pub responses: &'static [&'static str],
}

/// Counting face keyed by message name.
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

/// Message/traffic statistics (the acceptance item "message/traffic statistics"; unknown
/// messages are not counted into message_stats but presented as meta.unknown_messages, never
/// silently dropped).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StatsReport {
    /// Message name -> count/bytes/direction (BTreeMap = deterministic order).
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

/// A single statistics pass (a pure function; does not change the record order).
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

/// Analysis entry point: a set of decoded records -> a JSON-serializable report (the
/// acceptance wording).
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
