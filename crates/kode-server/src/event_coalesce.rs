//! INDEX-DISCIPLINE-001 ①:索引重扫事件合并器——纯决策核(Rust 主路径,
//! TS 侧 `src/backend/indexEventCoalescer.ts` 只持状态+定时器薄壳,镜像
//! 回退同构)。
//!
//! 用户令(2026-11-18):「频繁修改的文件要合并队列,最近修改的合并放队尾,
//! 同一文件反复建索引不对」。纪律:
//! - **300ms 时间窗**:窗口内同文件 N 次变更只保留最后一次(最新覆盖)——
//!   调用方(薄壳)以 Map 承载 latest-wins,本核只做窗口到期判定;
//! - **尾随顺延**:窗口到期但文件仍在编辑中(isDirty)→ 顺延到下一窗
//!   (队尾合并语义:顺延件的落队序按最后推送时刻排,最近修改的最后出);
//! - **有界顺延**:dirty 顺延有总上限(max_defer)——外部写盘撞上长编辑
//!   会话时,到上限后按盘真相 flush,绝不无限饿死重扫。
//!
//! 纯函数无状态:pending 清单/时钟全由调用方喂入(时钟单一真相在 TS 事件
//! 层),本核零内部状态——可确定性单测,server 侧无隐藏可变状态。

use crate::rpc::RpcRegistry;
use serde_json::{json, Value};

/// 合并窗口(毫秒)。窗口内同文件多事件并一,窗口到期才进重扫队列。
pub const DEFAULT_COALESCE_WINDOW_MS: u64 = 300;

/// dirty 顺延总上限(毫秒)。窗口可反复顺延,但自首次推送起不得超过此界
/// (外部写盘 + 长编辑会话下,到界按盘真相 flush,不无限饿死)。
pub const DEFAULT_COALESCE_MAX_DEFER_MS: u64 = 5000;

/// pending 条目(调用方喂入;`first/lastPushedAtMs` 为 TS 侧单调时钟)。
#[derive(Debug, Clone)]
pub struct PendingEntry {
    pub file: String,
    pub first_pushed_at_ms: u64,
    pub last_pushed_at_ms: u64,
}

/// 决策结果:`flush` 按最后推送时刻**升序**(最旧先出队,最近修改的落
/// 队尾);`defer` = 窗口已到但 dirty 顺延;`hold` = 窗口未到的条数。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CoalesceDecision {
    pub flush: Vec<String>,
    pub defer: Vec<String>,
    pub hold: usize,
}

/// 纯决策核:给定 pending 清单 + 当前 dirty 集 + 时钟,产出本轮决策。
/// 判定顺序(逐文件):
/// 1. `now - last < window` → hold(窗口内合并中);
/// 2. dirty 且 `now - first < max_defer` → defer(尾随顺延,下窗再看);
/// 3. 其余 → flush(按 last 升序,最近修改的排最后=队尾)。
pub fn decide_coalesce(
    pending: &[PendingEntry],
    dirty: &[String],
    now_ms: u64,
    window_ms: u64,
    max_defer_ms: u64,
) -> CoalesceDecision {
    let mut decision = CoalesceDecision::default();
    let mut flush_with_time: Vec<(u64, String)> = Vec::new();
    for entry in pending {
        let age = now_ms.saturating_sub(entry.last_pushed_at_ms);
        if age < window_ms {
            decision.hold += 1;
        } else if dirty.iter().any(|f| f == &entry.file)
            && now_ms.saturating_sub(entry.first_pushed_at_ms) < max_defer_ms
        {
            decision.defer.push(entry.file.clone());
        } else {
            flush_with_time.push((entry.last_pushed_at_ms, entry.file.clone()));
        }
    }
    // 最近修改的合并放队尾:last 升序 → 薄壳按序入队,最新触碰的落队尾。
    flush_with_time.sort_by_key(|(at, _)| *at);
    decision.flush = flush_with_time.into_iter().map(|(_, file)| file).collect();
    decision
}

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/events/coalesce", coalesce_handler);
}

/// `$/kode/events/coalesce` 桥:pending/dirty/时钟全由 TS 薄壳喂入,本面
/// 只回决策。载荷缺字段如实 Err(不静默吞成空决策——空决策会让薄壳以为
/// 全部 flush,把 dirty 顺延纪律打穿)。
fn coalesce_handler(params: Value) -> Result<Value, String> {
    let now_ms = params
        .get("nowMs")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "coalesce: nowMs (u64) required".to_string())?;
    let window_ms = params
        .get("windowMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_COALESCE_WINDOW_MS);
    let max_defer_ms = params
        .get("maxDeferMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_COALESCE_MAX_DEFER_MS);
    let pending_json = params
        .get("pending")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "coalesce: pending array required".to_string())?;
    let mut pending: Vec<PendingEntry> = Vec::with_capacity(pending_json.len());
    for item in pending_json {
        let file = item
            .get("file")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "coalesce: pending[].file required".to_string())?
            .to_string();
        let first_pushed_at_ms = item
            .get("firstPushedAtMs")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "coalesce: pending[].firstPushedAtMs required".to_string())?;
        let last_pushed_at_ms = item
            .get("lastPushedAtMs")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "coalesce: pending[].lastPushedAtMs required".to_string())?;
        pending.push(PendingEntry { file, first_pushed_at_ms, last_pushed_at_ms });
    }
    let dirty: Vec<String> = params
        .get("dirtyFiles")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let decision = decide_coalesce(&pending, &dirty, now_ms, window_ms, max_defer_ms);
    Ok(json!({
        "flush": decision.flush,
        "defer": decision.defer,
        "hold": decision.hold,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: u64 = 300;
    const MAX_DEFER: u64 = 5000;

    fn entry(file: &str, first: u64, last: u64) -> PendingEntry {
        PendingEntry {
            file: file.to_string(),
            first_pushed_at_ms: first,
            last_pushed_at_ms: last,
        }
    }

    #[test]
    fn window_hold_then_flush() {
        // 钉子①:窗口内 hold,窗口外 flush(同文件 N 次推送由薄壳 Map 并一,
        // 本核见到的恒是并一后的单条)。
        let pending = [entry("a.py", 0, 1000)];
        let at_1100 = decide_coalesce(&pending, &[], 1100, WINDOW, MAX_DEFER);
        assert_eq!(at_1100.hold, 1);
        assert!(at_1100.flush.is_empty());
        let at_1301 = decide_coalesce(&pending, &[], 1301, WINDOW, MAX_DEFER);
        assert_eq!(at_1301.flush, vec!["a.py".to_string()]);
        assert_eq!(at_1301.hold, 0);
    }

    #[test]
    fn dirty_defers_within_max() {
        // 钉子②:窗口到期但 dirty → 顺延;max_defer 界外不再顺延。
        let pending = [entry("a.py", 0, 0)];
        let dirty = vec!["a.py".to_string()];
        let at_301 = decide_coalesce(&pending, &dirty, 301, WINDOW, MAX_DEFER);
        assert_eq!(at_301.defer, vec!["a.py".to_string()]);
        assert!(at_301.flush.is_empty());
        // first=0,now=5500 > max_defer=5000:按盘真相 flush。
        let at_5501 = decide_coalesce(&pending, &dirty, 5501, WINDOW, MAX_DEFER);
        assert_eq!(at_5501.flush, vec!["a.py".to_string()]);
        assert!(at_5501.defer.is_empty());
    }

    #[test]
    fn flush_order_most_recent_last() {
        // 「最近修改的合并放队尾」:两文件都到期,后触碰的排 flush 尾。
        let pending = [entry("older.py", 0, 100), entry("newer.py", 0, 900)];
        let decision = decide_coalesce(&pending, &[], 2000, WINDOW, MAX_DEFER);
        assert_eq!(
            decision.flush,
            vec!["older.py".to_string(), "newer.py".to_string()]
        );
    }

    #[test]
    fn clean_file_never_defers() {
        // 非 dirty 文件窗口一到就 flush,零顺延。
        let pending = [entry("a.py", 0, 0)];
        let decision = decide_coalesce(&pending, &[], 301, WINDOW, MAX_DEFER);
        assert_eq!(decision.flush.len(), 1);
        assert!(decision.defer.is_empty());
    }

    #[test]
    fn handler_rejects_missing_now() {
        // 载荷缺 nowMs 如实 Err(不吞成全 flush)。
        let err = coalesce_handler(serde_json::json!({ "pending": [] })).unwrap_err();
        assert!(err.contains("nowMs"));
    }

    #[test]
    fn handler_roundtrip() {
        let params = serde_json::json!({
            "nowMs": 10_000,
            "windowMs": 300,
            "maxDeferMs": 5000,
            "pending": [
                { "file": "a.py", "firstPushedAtMs": 6000, "lastPushedAtMs": 6000 },
                { "file": "b.py", "firstPushedAtMs": 8500, "lastPushedAtMs": 9000 }
            ],
            "dirtyFiles": ["a.py"]
        });
        let out = coalesce_handler(params).unwrap();
        assert_eq!(out["flush"][0], "b.py");
        assert_eq!(out["defer"][0], "a.py");
        assert_eq!(out["hold"], 0);
    }
}
