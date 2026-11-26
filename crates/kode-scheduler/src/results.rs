//! CORE-012 large-result governance (baseline): capped pagination + byte-size ceiling +
//! cooperative cancellation.
//!
//! Pure pagination core (the real transport wiring of streaming chunks comes with the server
//! assembly); invariants:
//!
//! - **Entry hard cap**: entries per page ≤ `max_items`;
//! - **Size hard cap**: total weight per page ≤ `max_bytes` (weight = per-entry approximate
//!   bytes supplied by the caller; a lower-bound proxy on the same semantics as the VFS-013
//!   resident weight, not a direct measurement of JSON bytes);
//! - **Oversized entries never silently vanish**: when a single entry's own weight exceeds
//!   `max_bytes`, the page cuts off before that entry, `oversized_at` reports it truthfully,
//!   never swallowing the entry and never admitting it over the cap;
//! - **Deterministic pagination**: cursor = input-order offset; the same input plus the same
//!   cursor must yield the same page;
//! - **Cooperative cancellation**: check [`CancelToken`] entry by entry; on cancellation
//!   collection stops and what was already collected is honestly flagged `cancelled`
//!   (a half page stays honest, never pretending to be a full page).

use crate::scheduler::CancelToken;

/// Per-page limits (CORE-012). Both must be ≥ 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageLimits {
    pub max_items: usize,
    pub max_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageLimitsError {
    /// max_items is 0.
    ZeroItems,
    /// max_bytes is 0.
    ZeroBytes,
}

impl PageLimits {
    /// Validate (reject unhealthy limits at construction time).
    pub fn validate(&self) -> Result<(), PageLimitsError> {
        if self.max_items == 0 {
            return Err(PageLimitsError::ZeroItems);
        }
        if self.max_bytes == 0 {
            return Err(PageLimitsError::ZeroBytes);
        }
        Ok(())
    }
}

/// Pagination cursor: input-order offset (deterministic; no cursor field = start from 0).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageCursor {
    pub offset: usize,
}

impl PageCursor {
    pub fn start() -> PageCursor {
        PageCursor { offset: 0 }
    }
}

/// One page of results (ARCH-004: truncation / cancellation / oversized entries are all
/// explicit, never passed off as complete).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page<T> {
    /// Entries of this page (input-order slice).
    pub items: Vec<T>,
    /// Starting offset of this page.
    pub offset: usize,
    /// Starting offset of the next page; None = reached the end (no more entries).
    pub next_offset: Option<usize>,
    /// Position of the entry whose own weight exceeds max_bytes (never silently swallowed;
    /// this is the caller's special-case surface).
    pub oversized_at: Option<usize>,
    /// This page stopped short because of cancellation (collected entries are kept as is).
    pub cancelled: bool,
    /// Total weight of this page (lower-bound proxy, same per-entry weight semantics).
    pub bytes_estimate: usize,
}

/// Cut one page out under the limits. `weight` yields an entry's approximate bytes (the
/// size-ceiling metering surface).
pub fn paginate<T: Clone>(
    items: &[T],
    cursor: PageCursor,
    limits: PageLimits,
    mut weight: impl FnMut(&T) -> usize,
    cancel: &CancelToken,
) -> Page<T> {
    let mut page = Page {
        items: Vec::new(),
        offset: cursor.offset,
        next_offset: None,
        oversized_at: None,
        cancelled: false,
        bytes_estimate: 0,
    };
    let mut taken = 0usize;
    let mut bytes = 0usize;
    let mut idx = cursor.offset;
    while idx < items.len() {
        // Cooperative cancellation: check entry by entry; on cancellation stop collecting
        // (a half page is reported as such).
        if cancel.is_cancelled() {
            page.cancelled = true;
            break;
        }
        let item = &items[idx];
        let w = weight(item);
        // Oversized entry: never swallow it, never admit it over the cap — this page cuts off
        // here and reports it truthfully.
        if w > limits.max_bytes {
            page.oversized_at = Some(idx);
            break;
        }
        if taken == limits.max_items || bytes + w > limits.max_bytes {
            // Limit truncation: there is more; the next page starts at the current entry.
            break;
        }
        bytes += w;
        taken += 1;
        page.items.push(item.clone());
        idx += 1;
    }
    page.bytes_estimate = bytes;
    page.next_offset = if idx < items.len() { Some(idx) } else { None };
    page
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(items: usize, bytes: usize) -> PageLimits {
        PageLimits {
            max_items: items,
            max_bytes: bytes,
        }
    }

    #[test]
    fn validate_rejects_zero_caps() {
        assert_eq!(limits(0, 16).validate(), Err(PageLimitsError::ZeroItems));
        assert_eq!(limits(4, 0).validate(), Err(PageLimitsError::ZeroBytes));
        assert!(limits(4, 16).validate().is_ok());
    }

    #[test]
    fn paginates_deterministically_by_item_cap() {
        let items: Vec<usize> = (0..35).collect();
        let cancel = CancelToken::new();
        let mut cursor = PageCursor::start();
        let mut pages = 0;
        loop {
            let page = paginate(&items, cursor, limits(10, usize::MAX), |_| 1, &cancel);
            assert!(!page.cancelled);
            assert_eq!(page.offset, cursor.offset);
            pages += 1;
            match page.next_offset {
                Some(next) => cursor = PageCursor { offset: next },
                None => break,
            }
        }
        assert_eq!(pages, 4, "35 条按 10/页 = 3 满页 + 1 尾页");
        // The tail page holds 5 entries.
        let last = paginate(
            &items,
            PageCursor { offset: 30 },
            limits(10, usize::MAX),
            |_| 1,
            &cancel,
        );
        assert_eq!(last.items, vec![30, 31, 32, 33, 34]);
        assert_eq!(last.next_offset, None);
    }

    #[test]
    fn byte_cap_cuts_page_before_item_cap() {
        let items = vec![10u32, 10, 10, 1, 1, 1, 1];
        let cancel = CancelToken::new();
        let page = paginate(
            &items,
            PageCursor::start(),
            limits(100, 25),
            |v| *v as usize,
            &cancel,
        );
        // 10+10+10 = 30 > 25 → only two 10s are taken (20); the third 10 is deferred to the
        // next page.
        assert_eq!(page.items, vec![10, 10]);
        assert_eq!(page.bytes_estimate, 20);
        assert_eq!(page.next_offset, Some(2));
        assert_eq!(page.oversized_at, None);
    }

    #[test]
    fn oversized_item_reported_and_never_silently_swallowed() {
        let items = vec![1u32, 1000, 2];
        let cancel = CancelToken::new();
        let page = paginate(
            &items,
            PageCursor::start(),
            limits(10, 8),
            |v| *v as usize,
            &cancel,
        );
        // Entry 1 (weight 1000 > 8): this page cuts off before it, reports it truthfully,
        // and never admits it.
        assert_eq!(page.items, vec![1]);
        assert_eq!(page.oversized_at, Some(1));
        assert_eq!(page.next_offset, Some(1), "调用方可从超大条目处特判续取");
        // Resuming from the oversized entry: it is still over the cap, so the page stays empty
        // but oversized_at keeps pointing at it.
        let again = paginate(
            &items,
            PageCursor { offset: 1 },
            limits(10, 8),
            |v| *v as usize,
            &cancel,
        );
        assert!(again.items.is_empty());
        assert_eq!(again.oversized_at, Some(1));
    }

    #[test]
    fn cancel_stops_collection_and_marks_partial_page() {
        let items: Vec<usize> = (0..50).collect();
        let cancel = CancelToken::new();
        // The weight closure fires the cancellation on the 6th metering (a proving ground for
        // the cooperative-checkpoint semantics).
        let mut seen = 0;
        let trigger = cancel.clone();
        let page = paginate(
            &items,
            PageCursor::start(),
            limits(100, usize::MAX),
            move |v| {
                seen += 1;
                let _ = v;
                if seen == 6 {
                    trigger.cancel();
                }
                1
            },
            &cancel,
        );
        assert!(page.cancelled, "半页必须如实标注");
        // Cooperative semantics (same contract as scheduler run-body cancellation): the
        // triggering entry's own admission iteration has already completed before the
        // cancellation takes effect, so it is kept; collection stops at the next checkpoint
        // (idx=6).
        assert_eq!(page.items.len(), 6, "触发取消的条目保留,下一检查点停");
        assert_eq!(page.next_offset, Some(6), "取消截断也是截断:调用方可续");
    }

    #[test]
    fn pre_cancelled_request_yields_empty_cancelled_page() {
        let items = vec![1usize, 2, 3];
        let cancel = CancelToken::new();
        cancel.cancel();
        let page = paginate(&items, PageCursor::start(), limits(10, 100), |_| 1, &cancel);
        assert!(page.cancelled);
        assert!(page.items.is_empty());
        assert_eq!(page.next_offset, Some(0));
    }

    #[test]
    fn empty_input_is_final_empty_page() {
        let items: Vec<usize> = Vec::new();
        let cancel = CancelToken::new();
        let page = paginate(&items, PageCursor::start(), limits(10, 100), |_| 1, &cancel);
        assert!(page.items.is_empty());
        assert_eq!(page.next_offset, None);
        assert!(!page.cancelled);
        assert_eq!(page.oversized_at, None);
    }

    #[test]
    fn cursor_resume_is_exact_continuation() {
        let items: Vec<usize> = (0..7).collect();
        let cancel = CancelToken::new();
        let first = paginate(
            &items,
            PageCursor::start(),
            limits(3, usize::MAX),
            |_| 1,
            &cancel,
        );
        assert_eq!(first.items, vec![0, 1, 2]);
        let second = paginate(
            &items,
            PageCursor {
                offset: first.next_offset.expect("has next"),
            },
            limits(3, usize::MAX),
            |_| 1,
            &cancel,
        );
        assert_eq!(second.items, vec![3, 4, 5]);
        let third = paginate(
            &items,
            PageCursor {
                offset: second.next_offset.expect("has next"),
            },
            limits(3, usize::MAX),
            |_| 1,
            &cancel,
        );
        assert_eq!(third.items, vec![6]);
        assert_eq!(third.next_offset, None, "到底");
    }
}
