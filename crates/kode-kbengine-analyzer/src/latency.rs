//! 延迟 P50/P95/P99(PA-005;只对时间戳齐备的协议确证配对计算;
//! nearest-rank 百分位,确定性不插值)。

use serde::Serialize;

use crate::correlate::CorrelationReport;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct LatencyReport {
    /// 时间戳齐备的配对数(未齐备的配对不进入延迟统计)。
    pub pair_count: usize,
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub p99_ms: Option<f64>,
    pub max_ms: Option<f64>,
}

/// nearest-rank:ceil(p*n)-1 下标;空集返回 None。
fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let n = sorted.len();
    let rank = ((p * n as f64).ceil() as usize).clamp(1, n);
    Some(sorted[rank - 1])
}

pub fn measure(correlations: &CorrelationReport) -> LatencyReport {
    let mut deltas: Vec<f64> = correlations
        .pairs
        .iter()
        .filter_map(|p| p.delta_ms)
        .collect();
    deltas.sort_by(|a, b| {
        a.partial_cmp(b)
            .expect("no NaN deltas (timestamps are finite)")
    });
    LatencyReport {
        pair_count: deltas.len(),
        p50_ms: percentile(&deltas, 0.50),
        p95_ms: percentile(&deltas, 0.95),
        p99_ms: percentile(&deltas, 0.99),
        max_ms: deltas.last().copied(),
    }
}
