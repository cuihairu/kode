//! Request/response correlation (PA-005 "protocol-confirmed identifiers only, never
//! guessing from neighbouring messages").
//!
//! Contract: only the request-name -> response-name combinations in the [`PairSpec`]
//! forensic table are trusted; FIFO pairing of the same type within one Flow (the protocol
//! state machine has at most one in-flight request per pair); a response name not in any
//! in-flight request's accepted set -> no pairing, counted as unmatched (no guessing).

use std::collections::VecDeque;

use serde::Serialize;

use crate::record::Record;
use crate::stats::PairSpec;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pair {
    pub flow: String,
    pub request: String,
    pub response: String,
    pub request_ts: Option<f64>,
    pub response_ts: Option<f64>,
    /// Response - request (milliseconds; present only when both timestamps exist).
    pub delta_ms: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct CorrelationReport {
    pub pairs: Vec<Pair>,
    /// Number of requests issued but never answered by a protocol response (no guess-matching).
    pub unmatched_requests: usize,
}

/// Single-pass scan: FIFO queues keyed by (flow, request_name); when a response arrives take the
/// **earliest** acceptable request (the oldest across request types, to avoid confusing hello/login within the same flow).
pub fn correlate(records: &[Record], pairs: &[PairSpec]) -> CorrelationReport {
    let mut out = CorrelationReport::default();
    // flow → request_name → FIFO of (ts, order)
    type PendingQueue = VecDeque<(Option<f64>, usize)>;
    let mut pending: std::collections::BTreeMap<(String, String), PendingQueue> =
        std::collections::BTreeMap::new();
    let mut order = 0usize;

    for r in records {
        let Some(name) = &r.name else { continue };
        let is_request = pairs.iter().any(|p| p.request == name);
        let is_response = pairs.iter().any(|p| p.responses.contains(&name.as_str()));
        if is_request {
            pending
                .entry((r.flow.clone(), name.clone()))
                .or_default()
                .push_back((r.timestamp, order));
            order += 1;
            continue;
        }
        if is_response {
            // Among the request types that accept this response, take the globally oldest in-flight request.
            let mut best: Option<(String, usize, Option<f64>)> = None;
            for p in pairs {
                if !p.responses.contains(&name.as_str()) {
                    continue;
                }
                if let Some(q) = pending.get(&(r.flow.clone(), p.request.to_string())) {
                    if let Some(&(ts, ord)) = q.front() {
                        if best
                            .as_ref()
                            .map(|(_, b_ord, _)| ord < *b_ord)
                            .unwrap_or(true)
                        {
                            best = Some((p.request.to_string(), ord, ts));
                        }
                    }
                }
            }
            if let Some((req_name, _, req_ts)) = best {
                let key = (r.flow.clone(), req_name.clone());
                let q = pending.get_mut(&key).expect("front was just read");
                q.pop_front();
                if q.is_empty() {
                    pending.remove(&key);
                }
                let delta_ms = match (req_ts, r.timestamp) {
                    (Some(a), Some(b)) => Some((b - a) * 1000.0),
                    _ => None,
                };
                out.pairs.push(Pair {
                    flow: r.flow.clone(),
                    request: req_name,
                    response: name.clone(),
                    request_ts: req_ts,
                    response_ts: r.timestamp,
                    delta_ms,
                });
            }
        }
    }
    // Remaining in-flight requests = unmatched requests.
    out.unmatched_requests = pending.values().map(VecDeque::len).sum();
    out
}
