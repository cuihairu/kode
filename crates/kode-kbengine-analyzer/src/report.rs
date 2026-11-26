//! Report shape + anomaly detection + the Entity timeline (PA-005).

use std::collections::BTreeSet;

use serde::Serialize;

use crate::connections::ConnectionReport;
use crate::correlate::CorrelationReport;
use crate::latency::LatencyReport;
use crate::record::Record;
use crate::stats::{MessageStat, TrafficTotal};

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ReportMeta {
    pub record_count: usize,
    pub unknown_messages: usize,
}

/// The JSON report (the acceptance item "independently analyze a set of decoded messages and
/// produce a JSON report"; every section in deterministic order).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Report {
    pub meta: ReportMeta,
    pub message_stats: std::collections::BTreeMap<String, MessageStat>,
    pub traffic: TrafficTotal,
    pub correlations: CorrelationReport,
    pub latency: LatencyReport,
    pub anomalies: AnomalyReport,
    pub entity_timeline: EntityTimeline,
    pub connections: ConnectionReport,
}

#[derive(Debug, Clone, Default)]
pub struct AnalysisOptions {
    /// Reserved: report face switches (the current capability face is fully covered).
    pub _private: (),
}

// ---------------------------------------------------------------------------
// anomalies (the acceptance item "unknown messages / illegal length / Schema mismatch")
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Anomaly {
    pub kind: String,
    pub flow: String,
    pub id: u16,
    pub offset: usize,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct AnomalyReport {
    pub items: Vec<Anomaly>,
    pub total: usize,
}

/// Forensic minimum length table (docs/kbengine-wire-protocol.md §6/§7 fixed-length/
/// fixed-shape messages; only entries **confirmed by both ends' shapes** are included, and
/// a payload below the minimum = illegal length; entries for variable-length messages whose
/// field-level shape forensics are incomplete are not included and never fabricated).
const MIN_PAYLOAD_LEN: &[(&str, usize)] = &[
    ("Client::onLoginSuccessfully", 8), // 1+1(cstring×2)+2(u16)+4(blob u32 len)
    ("Client::onLoginFailed", 6),       // 2(u16)+4(blob len)
    ("Client::onEntityEnterWorld", 8),  // i32 + u32 (fixed 8)
    ("Client::onEntityLeaveWorld", 8),
    ("Client::onEntityEnterSpace", 8),
    ("Client::onEntityLeaveSpace", 8),
    ("Client::onEntityDestroyed", 4),
    ("Client::onControlEntity", 5),
    ("Client::onLoginBaseappFailed", 2),
    ("Client::onStreamDataCompleted", 2),
    ("Baseapp::reloginBaseapp", 12), // u64 + i32 (fixed 12)
    ("Client::onCreatedEntity", 5),  // i32 + ≥1(cstring)
];

/// Schema mismatch class: decode-time anomaly kinds passed through (the PA-004 decode face's
/// invalid_string/memory_limit/depth_limit etc.) are evidence of a Schema breach.
fn passthrough_kind(kind: &str) -> bool {
    !matches!(kind, "unknown_message_id")
}

pub fn detect_anomalies(records: &[Record]) -> AnomalyReport {
    let mut out = AnomalyReport::default();
    for r in records {
        match &r.name {
            None => out.items.push(Anomaly {
                kind: "unknown_message".into(),
                flow: r.flow.clone(),
                id: r.id,
                offset: r.stream_offset,
                message: format!("message id {} not in any loaded table segment", r.id),
            }),
            Some(name) => {
                let min = MIN_PAYLOAD_LEN
                    .iter()
                    .find(|(n, _)| n == name)
                    .map(|(_, m)| *m);
                if let Some(min) = min {
                    if r.payload_len < min {
                        out.items.push(Anomaly {
                            kind: "illegal_length".into(),
                            flow: r.flow.clone(),
                            id: r.id,
                            offset: r.stream_offset,
                            message: format!(
                                "{name}: payload {0} < forensic minimum {min}",
                                r.payload_len
                            ),
                        });
                    }
                }
            }
        }
        // Decode-time anomaly pass-through (evidence of a Schema mismatch; unknown id is not counted twice).
        if let Some(a) = &r.anomaly {
            if passthrough_kind(&a.kind) {
                out.items.push(Anomaly {
                    kind: a.kind.clone(),
                    flow: r.flow.clone(),
                    id: r.id,
                    offset: a.offset,
                    message: a.message.clone(),
                });
            }
        }
    }
    out.total = out.items.len();
    out
}

// ---------------------------------------------------------------------------
// Entity events + RPC timeline (the acceptance item "Entity events and the RPC timeline")
// ---------------------------------------------------------------------------

/// Entity event message face (PA-001 §7; the server->client entity life line + the client forwarding face).
fn is_entity_event(name: &str) -> bool {
    const EVENTS: &[&str] = &[
        "Client::onEntityEnterWorld",
        "Client::onEntityLeaveWorld",
        "Client::onEntityEnterSpace",
        "Client::onEntityLeaveSpace",
        "Client::onEntityDestroyed",
        "Client::onCreatedEntity",
        "Client::onCreatedProxies",
        "Client::onUpdatePropertys",
        "Client::onControlEntity",
    ];
    EVENTS.contains(&name) || is_rpc(name)
}

fn is_rpc(name: &str) -> bool {
    name.ends_with("onRemoteMethodCall") || name.ends_with("onRemoteCallCellMethodFromClient")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EntityEvent {
    pub entity_id: Option<i32>,
    pub event: String,
    pub flow: String,
    pub timestamp: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method_id: Option<u16>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct EntityTimeline {
    /// Event order (input order = wire order; deterministic).
    pub events: Vec<EntityEvent>,
    /// The remote-call subset (the RPC timeline).
    pub rpcs: Vec<EntityEvent>,
    /// Deduplicated entity count.
    pub entities: usize,
}

pub fn build_entity_timeline(records: &[Record]) -> EntityTimeline {
    let mut out = EntityTimeline::default();
    let mut ids = BTreeSet::new();
    for r in records {
        let is_event = match &r.name {
            Some(n) => is_entity_event(n),
            None => false,
        };
        if !is_event && r.entity_id.is_none() {
            continue;
        }
        let ev = EntityEvent {
            entity_id: r.entity_id,
            event: r.name.clone().unwrap_or_else(|| format!("id:{}", r.id)),
            flow: r.flow.clone(),
            timestamp: r.timestamp,
            method_id: r.method_id,
        };
        if let Some(id) = r.entity_id {
            ids.insert(id);
        }
        let rpc = r.name.as_deref().map(is_rpc).unwrap_or(false);
        out.events.push(ev.clone());
        if rpc {
            out.rpcs.push(ev);
        }
    }
    out.entities = ids.len();
    out
}
