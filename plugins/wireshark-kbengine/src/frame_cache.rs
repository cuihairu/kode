//! 每流帧缓存(todo 2026-11-25 审计 HIGH:per-frame summaries/trees 无界增长,
//! 长抓包内存爬升):环形窗口上限,窗口满时按首遍到达序淘汰最旧帧。
//! 窗口内帧的重放遍照常复述;被淘汰帧的重放遍走 dissect 侧既有
//! 「replay (no first-pass summary)」中性降级臂,不编造、不崩。
//! `cap == 0` 表示显式不设限(用户自担内存)。

use std::collections::{BTreeMap, VecDeque};

/// 首选项缺省窗口(帧数/流):约 8k 条摘要 + 字段树,覆盖常态回看窗口,
/// 上界约为旧无界实现长抓包数小时后的一个零头。
pub(crate) const DEFAULT_FRAME_CACHE_CAP: usize = 8192;

/// 每 TCP 流的首遍缓存(摘要 + 字段树),带环形淘汰窗口。
/// `V` 为树条目类型(生产面 `MsgTreeEntry`;测试面用哑型,零协议耦合)。
pub(crate) struct FrameCache<V: Clone> {
    summaries: BTreeMap<u32, String>,
    trees: BTreeMap<u32, V>,
    /// 插入序(= 首遍帧序,单调不严格增);队首即最旧。
    ring: VecDeque<u32>,
    /// 缓存上限(帧数);0 = 不设限。
    cap: usize,
}

impl<V: Clone + Default> FrameCache<V> {
    pub(crate) fn new(cap: usize) -> Self {
        FrameCache {
            summaries: BTreeMap::new(),
            trees: BTreeMap::new(),
            ring: VecDeque::new(),
            cap,
        }
    }

    /// 重放遍取回:摘要 + 树条目(树缺省 = Default 空表,与旧实现
    /// `trees.get(&frame).cloned().unwrap_or_default()` 同语义)。
    pub(crate) fn get(&self, frame: u32) -> Option<(String, V)> {
        let summary = self.summaries.get(&frame)?.clone();
        let tree = self.trees.get(&frame).cloned().unwrap_or_default();
        Some((summary, tree))
    }

    /// 首遍入库:`entries = None` 为错误复位面(摘要照存,树移除,与既有
    /// Err 臂语义一致)。同帧重入不重复占环形槽位。
    pub(crate) fn insert(&mut self, frame: u32, summary: String, entries: Option<V>) {
        let fresh = !self.summaries.contains_key(&frame);
        match entries {
            Some(tree) => {
                self.trees.insert(frame, tree);
            }
            None => {
                self.trees.remove(&frame);
            }
        }
        self.summaries.insert(frame, summary);
        if fresh {
            self.ring.push_back(frame);
        }
        while self.cap != 0 && self.ring.len() > self.cap {
            let Some(oldest) = self.ring.pop_front() else {
                break;
            };
            self.summaries.remove(&oldest);
            self.trees.remove(&oldest);
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.summaries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache(cap: usize) -> FrameCache<u32> {
        FrameCache::new(cap)
    }

    #[test]
    fn evicts_oldest_beyond_cap() {
        let mut c = cache(2);
        c.insert(1, "s1".into(), Some(11));
        c.insert(2, "s2".into(), Some(22));
        c.insert(3, "s3".into(), Some(33));
        assert_eq!(c.len(), 2);
        assert!(c.get(1).is_none(), "oldest frame evicted");
        assert!(c.get(2).is_some());
        assert_eq!(c.get(3), Some(("s3".into(), 33)));
    }

    #[test]
    fn err_shaped_insert_keeps_summary_drops_tree() {
        let mut c = cache(0);
        c.insert(7, "reset".into(), None);
        let got = c.get(7).expect("summary kept");
        assert_eq!(got.0, "reset");
    }

    #[test]
    fn cap_zero_is_unbounded() {
        let mut c = cache(0);
        for frame in 0..200u32 {
            c.insert(frame, format!("s{frame}"), Some(frame));
        }
        assert_eq!(c.len(), 200);
        assert!(c.get(0).is_some());
        assert!(c.get(199).is_some());
    }

    #[test]
    fn reinsert_does_not_duplicate_ring_slot() {
        let mut c = cache(2);
        c.insert(1, "s1".into(), Some(11));
        c.insert(1, "s1b".into(), None); // Err 臂重入同帧
        c.insert(2, "s2".into(), Some(22));
        c.insert(3, "s3".into(), Some(33));
        // 环内仍是 1,2,3 各一次 → 容量 2 时淘汰 1,保留 2/3。
        assert_eq!(c.len(), 2);
        assert!(c.get(1).is_none());
        assert!(c.get(2).is_some() && c.get(3).is_some());
    }

    #[test]
    fn eviction_removes_tree_and_summary_together() {
        let mut c = cache(1);
        c.insert(1, "s1".into(), Some(11));
        c.insert(2, "s2".into(), None);
        assert!(c.get(1).is_none());
        assert!(c.get(2).is_some());
    }
}
