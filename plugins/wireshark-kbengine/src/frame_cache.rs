//! Per-stream frame cache (todo 2026-11-25 audit HIGH: per-frame
//! summaries/trees grew without bound — long captures climbed memory):
//! a ring window evicts the oldest frames once the cap is hit. Frames still
//! inside the window replay as usual; a replay pass over an evicted frame
//! takes the existing neutral `replay (no first-pass summary)` arm on the
//! dissect side — never fabricated, never a crash. `cap == 0` means an
//! explicit unbounded opt-out (memory at the user's own risk).

use std::collections::{BTreeMap, VecDeque};

/// Default per-stream window (frames): roughly 8k summaries + field trees,
/// covering a normal rewind window at a small fraction of what the old
/// unbounded implementation accumulated over hours-long captures.
pub(crate) const DEFAULT_FRAME_CACHE_CAP: usize = 8192;

/// Per-stream first-pass cache (summaries + field trees) with a ring
/// eviction window. `V` is the tree-entry type (production face
/// `MsgTreeEntry`; tests use a dummy type, zero protocol coupling).
pub(crate) struct FrameCache<V: Clone + Default> {
    summaries: BTreeMap<u32, String>,
    trees: BTreeMap<u32, V>,
    /// Insertion order (= first-pass frame order, monotonically increasing
    /// but not strictly); front of the queue is the oldest.
    ring: VecDeque<u32>,
    /// Cache cap (frames); 0 = unbounded.
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

    /// Replay-pass lookup: summary + tree entries (missing tree = `Default`
    /// empty, same semantics as the old
    /// `trees.get(&frame).cloned().unwrap_or_default()`).
    pub(crate) fn get(&self, frame: u32) -> Option<(String, V)> {
        let summary = self.summaries.get(&frame)?.clone();
        let tree = self.trees.get(&frame).cloned().unwrap_or_default();
        Some((summary, tree))
    }

    /// First-pass insert: `entries = None` is the error-reset face (summary
    /// is kept, tree removed — same semantics as the existing Err arm).
    /// Re-inserting the same frame never occupies a second ring slot.
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
        c.insert(1, "s1b".into(), None); // Err-arm re-entry of the same frame
        c.insert(2, "s2".into(), Some(22));
        c.insert(3, "s3".into(), Some(33));
        // Ring still holds 1,2,3 once each → with cap 2 frame 1 is evicted,
        // 2/3 survive.
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
