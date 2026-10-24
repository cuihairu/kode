//! VFS-011 解析缓存:每文档仅保留最新有效快照 + 负缓存。
//!
//! - `valid`:`DocumentKey → (输入指纹, 解析产物 Arc<V>)`。**同一文档只留
//!   最新一份**(新产物覆盖旧产物——最近成功 AST 语义);输入指纹不符即视为
//!   未命中,绝不过期值冒充新值(ARCH-005)。
//! - `negative`:解析失败的文档记 (输入指纹, 原因),同输入不重复解析;
//!   文档一变指纹就变,负缓存自动失效。
//! - 失效入口与 VFS-012 对齐:`invalidate`(删/改名)、`invalidate_root`
//!   (根切换)、`clear`。
//!
//! 输入指纹用 FNV-1a(内容 + 长度):基础版零依赖;语义级指纹(HR-HASH-003)
//! 随后续 PR 替换,本模块接口不变。

use std::collections::HashMap;
use std::sync::Arc;

use crate::store::{DocumentKey, RootId};

/// 内容指纹(FNV-1a 64;含长度防尾碰撞)。
pub fn content_fingerprint(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash ^ (text.len() as u64).rotate_left(32)
}

struct ValidEntry<V> {
    input: u64,
    value: Arc<V>,
}

struct NegativeEntry {
    input: u64,
    reason: String,
}

/// 解析缓存(V 泛型:AST/符号表/诊断集等)。
pub struct ParseCache<V> {
    valid: HashMap<DocumentKey, ValidEntry<V>>,
    negative: HashMap<DocumentKey, NegativeEntry>,
}

impl<V> std::fmt::Debug for ParseCache<V> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 不打印 V(可能巨大),只打印条目数。
        f.debug_struct("ParseCache")
            .field("valid", &self.valid.len())
            .field("negative", &self.negative.len())
            .finish()
    }
}

impl<V> Default for ParseCache<V> {
    fn default() -> Self {
        ParseCache {
            valid: HashMap::new(),
            negative: HashMap::new(),
        }
    }
}

impl<V> ParseCache<V> {
    pub fn new() -> ParseCache<V> {
        ParseCache::default()
    }

    /// 命中最新有效快照:仅在输入指纹一致时返回。
    pub fn get(&self, key: &DocumentKey, input_fingerprint: u64) -> Option<Arc<V>> {
        let entry = self.valid.get(key)?;
        if entry.input == input_fingerprint {
            Some(Arc::clone(&entry.value))
        } else {
            None
        }
    }

    /// 记录一次成功解析:覆盖同文档旧值(仅保留最新有效快照)。
    pub fn insert(&mut self, key: DocumentKey, input_fingerprint: u64, value: V) {
        self.negative.remove(&key);
        self.valid.insert(
            key,
            ValidEntry {
                input: input_fingerprint,
                value: Arc::new(value),
            },
        );
    }

    /// 负缓存命中:同输入的失败不重复解析。
    pub fn get_negative(&self, key: &DocumentKey, input_fingerprint: u64) -> Option<&str> {
        let entry = self.negative.get(key)?;
        if entry.input == input_fingerprint {
            Some(&entry.reason)
        } else {
            None
        }
    }

    /// 记录一次解析失败(同输入去重;成功写入会清掉负缓存)。
    pub fn insert_negative(
        &mut self,
        key: DocumentKey,
        input_fingerprint: u64,
        reason: impl Into<String>,
    ) {
        self.valid.remove(&key);
        self.negative.insert(
            key,
            NegativeEntry {
                input: input_fingerprint,
                reason: reason.into(),
            },
        );
    }

    /// VFS-012:删除/重命名失效。
    pub fn invalidate(&mut self, key: &DocumentKey) {
        self.valid.remove(key);
        self.negative.remove(key);
    }

    /// 根切换失效(VFS-013)。
    pub fn invalidate_root(&mut self, root: RootId) {
        self.valid.retain(|key, _| key.root != root);
        self.negative.retain(|key, _| key.root != root);
    }

    pub fn clear(&mut self) {
        self.valid.clear();
        self.negative.clear();
    }

    pub fn valid_len(&self) -> usize {
        self.valid.len()
    }

    pub fn negative_len(&self) -> usize {
        self.negative.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::uri::CanonicalUri;

    fn key(root: u32, path: &str) -> DocumentKey {
        DocumentKey::new(RootId(root), CanonicalUri::from_path(path))
    }

    #[test]
    fn keeps_only_latest_valid_snapshot() {
        let mut cache: ParseCache<String> = ParseCache::new();
        let k = key(1, "/w/a.def");
        let fp1 = content_fingerprint("v1");
        cache.insert(k.clone(), fp1, "ast-v1".into());
        assert_eq!(cache.get(&k, fp1).unwrap().as_str(), "ast-v1");
        // 新解析覆盖旧值:旧指纹立刻未命中。
        let fp2 = content_fingerprint("v2");
        cache.insert(k.clone(), fp2, "ast-v2".into());
        assert!(cache.get(&k, fp1).is_none());
        assert_eq!(cache.get(&k, fp2).unwrap().as_str(), "ast-v2");
        assert_eq!(cache.valid_len(), 1);
    }

    #[test]
    fn negative_cache_hits_same_input_only() {
        let mut cache: ParseCache<String> = ParseCache::new();
        let k = key(1, "/w/broken.def");
        let fp = content_fingerprint("<Entity>");
        cache.insert_negative(k.clone(), fp, "unterminated tag");
        assert_eq!(cache.get_negative(&k, fp), Some("unterminated tag"));
        // 内容一变,负缓存自动失效。
        assert!(cache
            .get_negative(&k, content_fingerprint("<Entity/>"))
            .is_none());
        // 成功解析清掉负缓存。
        cache.insert(k.clone(), fp, "ast".into());
        assert_eq!(cache.negative_len(), 0);
    }

    #[test]
    fn invalidate_and_invalidate_root() {
        let mut cache: ParseCache<String> = ParseCache::new();
        let a = key(1, "/w/a.def");
        let b = key(2, "/w/b.def");
        cache.insert(a.clone(), 1, "x".into());
        cache.insert(b.clone(), 1, "y".into());
        cache.invalidate(&a);
        assert!(cache.get(&a, 1).is_none());
        assert!(cache.get(&b, 1).is_some());
        cache.invalidate_root(RootId(2));
        assert!(cache.get(&b, 1).is_none());
    }

    #[test]
    fn fingerprint_is_stable_and_length_sensitive() {
        assert_eq!(content_fingerprint("abc"), content_fingerprint("abc"));
        assert_ne!(content_fingerprint("abc"), content_fingerprint("abd"));
        assert_ne!(content_fingerprint("ab"), content_fingerprint("abc"));
    }
}
