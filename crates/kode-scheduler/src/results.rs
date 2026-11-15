//! CORE-012 大结果治理(基础版):限额分页 + 字节体积上限 + 协作取消。
//!
//! 纯分页核(流式 chunk 的真正传输接线随 server 装配单);不变量:
//!
//! - **条目硬限**:单页条目数 ≤ `max_items`;
//! - **体积硬限**:单页权重合计 ≤ `max_bytes`(权重 = 调用方给的条目近似
//!   字节;与 VFS-013 驻留权重同口径的下界代理,不是 JSON 字节数直测);
//! - **超大条目绝不静默消失**:单条自身权重超 `max_bytes` 时,本页在该条
//!   前截止,`oversized_at` 如实上报,绝不吞条目也绝不超限收录;
//! - **确定性分页**:游标 = 输入序偏移;同输入同游标必得同页;
//! - **协作取消**:逐条检查 [`CancelToken`],取消即停收,已收部分如实标注
//!   `cancelled`(半页诚实,绝不装完整页)。

use crate::scheduler::CancelToken;

/// 单页限额(CORE-012)。两项都必须 ≥ 1。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageLimits {
    pub max_items: usize,
    pub max_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageLimitsError {
    /// max_items 为 0。
    ZeroItems,
    /// max_bytes 为 0。
    ZeroBytes,
}

impl PageLimits {
    /// 校验(构造期拒绝带病限额)。
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

/// 分页游标:输入序偏移(确定性;无游标字段 = 从 0 起)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageCursor {
    pub offset: usize,
}

impl PageCursor {
    pub fn start() -> PageCursor {
        PageCursor { offset: 0 }
    }
}

/// 一页结果(ARCH-004:截断/取消/超大条目全部明示,不装完整)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page<T> {
    /// 本页条目(输入序切片)。
    pub items: Vec<T>,
    /// 本页起始偏移。
    pub offset: usize,
    /// 下一页起始偏移;None = 已到底(无更多条目)。
    pub next_offset: Option<usize>,
    /// 单条自身权重超 max_bytes 的条目位置(绝不静默吞;调用方特判面)。
    pub oversized_at: Option<usize>,
    /// 本页因取消而半途收笔(已收条目如实保留)。
    pub cancelled: bool,
    /// 本页权重合计(下界代理,同条目权重口径)。
    pub bytes_estimate: usize,
}

/// 按限额切一页。`weight` 给出条目近似字节(体积上限计量面)。
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
        // 协作取消:逐条检查,取消即停收(半页如实)。
        if cancel.is_cancelled() {
            page.cancelled = true;
            break;
        }
        let item = &items[idx];
        let w = weight(item);
        // 超大条目:绝不吞、绝不超限收录——本页在此截止并如实上报。
        if w > limits.max_bytes {
            page.oversized_at = Some(idx);
            break;
        }
        if taken == limits.max_items || bytes + w > limits.max_bytes {
            // 限额截断:还有更多,下一页从当前条目起。
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
        // 尾页 5 条。
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
        // 10+10+10 = 30 > 25 → 只收两个 10(20),第三个 10 让下一页。
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
        // 条目 1(权重 1000 > 8):本页在它前截止,如实上报,绝不收录。
        assert_eq!(page.items, vec![1]);
        assert_eq!(page.oversized_at, Some(1));
        assert_eq!(page.next_offset, Some(1), "调用方可从超大条目处特判续取");
        // 从超大条目继续:它自身仍超限,页恒空但 oversized_at 持续指认。
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
        // 权重闭包在第 6 次计量时拉响取消(协作检查点语义的考场)。
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
        // 协作语义(与调度器 run 体取消同口径):触发条目自身的准入迭代
        // 已在取消生效前完成,故其保留;下一个检查点(idx=6)停收。
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
