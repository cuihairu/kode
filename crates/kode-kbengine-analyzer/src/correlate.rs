//! 请求响应关联(PA-005「仅协议确证标识,不拿相邻猜对」)。
//!
//! 口径:只认 [`PairSpec`] 取证表内的 请求名→响应名 组合;同 Flow 内同
//! 类型 FIFO 配对(协议状态机每对至多一个在途请求);响应名不在任何在途
//! 请求的可接受集内 → 不配对,计入 unmatched(不猜测)。

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
    /// 响应 - 请求(毫秒;时间戳齐备才有)。
    pub delta_ms: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct CorrelationReport {
    pub pairs: Vec<Pair>,
    /// 发出但未等到协议响应的请求数(不猜测配对)。
    pub unmatched_requests: usize,
}

/// 单遍扫描:FIFO 队列按 (flow, request_name);响应到来时取**最早的**
/// 可接受请求(跨请求类型取最老,避免同 flow 的 hello/login 混淆)。
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
            // 可接受该响应的请求类型里,取全局最老的在途请求。
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
    // 剩余在途 = 未匹配请求。
    out.unmatched_requests = pending.values().map(VecDeque::len).sum();
    out
}
