//! VFS-011 解析缓存:每文档仅保留最新有效快照 + 负缓存。
//!
//! - `valid`:`DocumentKey → (输入指纹, 解析产物 Arc<V>)`。**同一文档只留
//!   最新一份**(新产物覆盖旧产物——最近成功 AST 语义);输入指纹不符即视为
//!   未命中,绝不过期值冒充新值(ARCH-005)。
//! - `negative`:解析失败的文档记 (输入指纹, 原因),同输入不重复解析;
//!   文档一变指纹就变,负缓存自动失效。
//! - 失效入口与 VFS-012 对齐:`invalidate`(删/改名)、`invalidate_root`
//!   (根切换)、`clear`。
//! - CORE-013 基础版:**驻留预算 + 二次机会近似 LRU**。`with_budget` 给出
//!   权重上限与单条目权重函数(单位由调用方定义;kode-parser 用「驻留内容
//!   自有字符串字节」作下界代理),超预算时按插入序时钟扫描驱逐:命中置
//!   「近期用过」位,扫描先清位缓刑一轮、再遇才驱逐;失效产生的陈旧时钟键
//!   惰性跳过,比例失衡时压缩。缺省无界,既有行为零变化。
//!
//! 输入指纹用 FNV-1a(内容 + 长度):基础版零依赖;语义级指纹(HR-HASH-003)
//! 随后续 PR 替换,本模块接口不变。

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use crate::store::{DocumentKey, RootId};

/// 内容指纹(FNV-1a 64;含长度防尾碰撞)。
pub fn content_fingerprint(text: &str) -> u64 {
    content_fingerprint_bytes(text.as_bytes())
}

/// 字节面内容指纹(与 [`content_fingerprint`] 同算法同长度混合;RUST-127
/// 持久化帧的损坏检测走这里,payload 是任意字节非 UTF-8)。
pub fn content_fingerprint_bytes(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash ^ (bytes.len() as u64).rotate_left(32)
}

struct ValidEntry<V> {
    input: u64,
    value: Arc<V>,
    /// CORE-013:近期用过位(get 命中置位,驱逐扫描先清位缓刑一轮)。
    recent: bool,
}

struct NegativeEntry {
    input: u64,
    reason: String,
}

/// 驻留预算(权重单位由调用方定义;CORE-013 基础版用「驻留内容自有字符串
/// 字节」作下界代理,非 RSS 直测——2026-11-15 RUST-129 实测 def 形态
/// RSS ≈ 字节权重 ×3,换算系数归调用方配置面)。
struct Budget<V> {
    /// 权重上限;单条目超限时该条目插入即被驱逐(预算绝不无限超出)。
    max_weight: u64,
    weight: Arc<dyn Fn(&V) -> u64 + Send + Sync>,
}

/// 解析缓存(V 泛型:AST/符号表/诊断集等)。
pub struct ParseCache<V> {
    valid: HashMap<DocumentKey, ValidEntry<V>>,
    negative: HashMap<DocumentKey, NegativeEntry>,
    /// CORE-013 驻留预算。None = 无界(既有行为,零变化)。
    budget: Option<Budget<V>>,
    /// 二次机会时钟环:插入序;失效产生的陈旧键惰性跳过,比例失衡时压缩。
    clock: VecDeque<DocumentKey>,
    /// 当前有效条目权重合计(仅预算面维护;无界缓存恒 0)。
    weight_total: u64,
    /// 累计驱逐条目数(CORE-013 预算面观测)。
    evictions: u64,
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
            budget: None,
            clock: VecDeque::new(),
            weight_total: 0,
            evictions: 0,
        }
    }
}

impl<V> ParseCache<V> {
    pub fn new() -> ParseCache<V> {
        ParseCache::default()
    }

    /// CORE-013 基础版:带驻留预算的缓存。`weight` 给出单条目驻留权重,
    /// 合计超 `max_weight` 时按二次机会近似 LRU 驱逐。
    pub fn with_budget(
        max_weight: u64,
        weight: impl Fn(&V) -> u64 + Send + Sync + 'static,
    ) -> ParseCache<V> {
        ParseCache {
            budget: Some(Budget {
                max_weight,
                weight: Arc::new(weight),
            }),
            ..ParseCache::default()
        }
    }

    /// 命中最新的有效快照:仅在输入指纹一致时返回;命中置「近期用过」位
    /// (CORE-013:驱逐扫描先清位给一次缓刑)。
    pub fn get(&mut self, key: &DocumentKey, input_fingerprint: u64) -> Option<Arc<V>> {
        let entry = self.valid.get_mut(key)?;
        if entry.input == input_fingerprint {
            entry.recent = true;
            Some(Arc::clone(&entry.value))
        } else {
            None
        }
    }

    /// RUST-125:缓冲活跃通知(打开/编辑触达面)——置「近期用过」位给一次
    /// 驱逐缓刑。条目无效(未驻留/已驱逐)时零操作。缓刑而非硬 pin:硬 pin
    /// 会在超预算时形成无界驻留(违背冷热分层初衷);有效键恒在时钟环
    /// (insert/enforce 清位均回环),置位即可被下一轮扫描保护。
    pub fn mark_recent(&mut self, key: &DocumentKey) {
        if let Some(entry) = self.valid.get_mut(key) {
            entry.recent = true;
        }
    }

    /// 记录一次成功解析:覆盖同文档旧值(仅保留最新有效快照);预算面下
    /// 超限即按近似 LRU 驱逐。
    pub fn insert(&mut self, key: DocumentKey, input_fingerprint: u64, value: V) {
        self.negative.remove(&key);
        let (max, weight) = match self.budget.as_ref() {
            Some(budget) => (budget.max_weight, budget.weight.clone()),
            None => (
                u64::MAX,
                Arc::new(|_: &V| 0u64) as Arc<dyn Fn(&V) -> u64 + Send + Sync>,
            ),
        };
        // 替换同键:先扣旧值权重再计新值。
        if let Some(old) = self.valid.remove(&key) {
            self.weight_total -= weight(&old.value);
        }
        self.weight_total += weight(&value);
        self.valid.insert(
            key.clone(),
            ValidEntry {
                input: input_fingerprint,
                value: Arc::new(value),
                recent: false,
            },
        );
        self.clock.push_back(key);
        self.enforce(max, &*weight);
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
        if let Some(old) = self.valid.remove(key) {
            self.subtract_weight(&old.value);
        }
        self.negative.remove(key);
    }

    /// 根切换失效(VFS-013)。
    pub fn invalidate_root(&mut self, root: RootId) {
        self.valid.retain(|key, _| key.root != root);
        self.negative.retain(|key, _| key.root != root);
        self.reset_weight_total();
    }

    pub fn clear(&mut self) {
        self.valid.clear();
        self.negative.clear();
        self.clock.clear();
        self.weight_total = 0;
    }

    /// 当前有效条目权重合计(仅预算面有意义;无界缓存恒 0)。
    pub fn resident_weight(&self) -> u64 {
        self.weight_total
    }

    /// 累计驱逐条目数(CORE-013 预算面观测)。
    pub fn evictions(&self) -> u64 {
        self.evictions
    }

    /// 驻留预算上限(无界缓存 = None;装配观测面用,不改行为)。
    pub fn budget_bytes(&self) -> Option<u64> {
        self.budget.as_ref().map(|b| b.max_weight)
    }

    pub fn valid_len(&self) -> usize {
        self.valid.len()
    }

    /// 条目是否有效驻留(纯观测,**不置近期位**——get 的命中置位会续缓刑,
    /// 断言驱逐行为必须走这里)。
    pub fn contains(&self, key: &DocumentKey) -> bool {
        self.valid.contains_key(key)
    }

    pub fn negative_len(&self) -> usize {
        self.negative.len()
    }

    /// 超预算驱逐:二次机会时钟扫描,recent 条目清位缓刑一轮,再遇才驱逐;
    /// 时钟环里的陈旧键(条目已失效)惰性跳过,比例失衡时压缩。
    ///
    /// 终止性:每轮要么驱逐(recent 清位后必然再遇即驱逐),要么弹出陈旧键;
    /// 单条目自身超限时最终被驱逐(预算绝不无限超出)。极端退化(时钟耗尽
    /// 仍无牺牲者=实现不变量被破坏)按保守策略清空驻留,绝不卡死。
    fn enforce(&mut self, max: u64, weight: &(dyn Fn(&V) -> u64 + Send + Sync)) {
        while self.weight_total > max {
            let mut victim = None;
            while let Some(key) = self.clock.pop_front() {
                match self.valid.get_mut(&key) {
                    // 条目已被失效删除 → 陈旧键,继续扫。
                    None => continue,
                    Some(entry) => {
                        if entry.recent {
                            entry.recent = false;
                            self.clock.push_back(key);
                        } else {
                            victim = Some(key);
                            break;
                        }
                    }
                }
            }
            let Some(key) = victim else {
                let drained = self.valid.len();
                self.valid.clear();
                self.clock.clear();
                self.weight_total = 0;
                self.evictions += drained as u64;
                return;
            };
            if let Some(entry) = self.valid.remove(&key) {
                self.weight_total -= weight(&entry.value);
                self.evictions += 1;
            }
        }
        if self.clock.len() > self.valid.len() * 2 + 64 {
            self.clock.retain(|key| self.valid.contains_key(key));
        }
    }

    /// 扣除单条目权重(仅预算面)。
    fn subtract_weight(&mut self, value: &Arc<V>) {
        if let Some(budget) = self.budget.as_ref() {
            let weight = budget.weight.clone();
            self.weight_total -= weight(value);
        }
    }

    /// 失效批量发生(根切换)后重算权重合计。
    fn reset_weight_total(&mut self) {
        let Some(budget) = self.budget.as_ref() else {
            self.weight_total = 0;
            return;
        };
        let weight = budget.weight.clone();
        self.weight_total = self.valid.values().map(|entry| weight(&entry.value)).sum();
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

    #[test]
    fn debug_fmt_shows_entry_counts_not_values() {
        // Debug 不打印 V(可能巨大),只打印 valid/negative 条目数。
        let mut cache: ParseCache<String> = ParseCache::new();
        assert_eq!(format!("{cache:?}"), "ParseCache { valid: 0, negative: 0 }");
        let k = key(1, "/w/a.def");
        cache.insert(k.clone(), content_fingerprint("v"), "big-ast".into());
        cache.insert_negative(key(2, "/w/b.def"), content_fingerprint("bad"), "syntax");
        let dbg = format!("{cache:?}");
        assert!(dbg.contains("valid: 1"), "{dbg}");
        assert!(dbg.contains("negative: 1"), "{dbg}");
        assert!(!dbg.contains("big-ast"), "V 不得泄漏进 Debug");
    }

    #[test]
    fn clear_empties_both_valid_and_negative() {
        let mut cache: ParseCache<String> = ParseCache::new();
        let k = key(1, "/w/a.def");
        cache.insert(k.clone(), content_fingerprint("v"), "ast".into());
        cache.insert_negative(key(2, "/w/b.def"), content_fingerprint("bad"), "syntax");
        assert_eq!(cache.valid_len(), 1);
        assert_eq!(cache.negative_len(), 1);
        cache.clear();
        assert_eq!(cache.valid_len(), 0);
        assert_eq!(cache.negative_len(), 0);
        assert!(cache.get(&k, content_fingerprint("v")).is_none());
    }

    // ---- CORE-013 预算面 ----

    // &String 在此是类型所需:ParseCache::with_budget 的权重契约是 Fn(&V),
    // V=String 时签名必须逐字匹配(&str 反而进不了泛型位)。
    #[allow(clippy::ptr_arg)]
    fn len_weight(value: &String) -> u64 {
        value.len() as u64
    }

    #[test]
    fn budget_evicts_least_recently_used() {
        let mut cache: ParseCache<String> = ParseCache::with_budget(20, len_weight);
        let a = key(1, "/w/a.def");
        let b = key(2, "/w/b.def");
        let c = key(3, "/w/c.def");
        cache.insert(a.clone(), 1, "0123456789".into());
        cache.insert(b.clone(), 1, "9876543210".into());
        assert_eq!(cache.resident_weight(), 20);
        // 命中 A:二次机会保护。
        assert_eq!(cache.get(&a, 1).unwrap().as_str(), "0123456789");
        cache.insert(c.clone(), 1, "abcdefghij".into());
        // B(最久未用)被驱逐,A 因近期命中获缓刑。
        assert!(cache.get(&a, 1).is_some(), "近期命中条目必须被保护");
        assert!(cache.get(&b, 1).is_none(), "最久未用条目必须被驱逐");
        assert_eq!(cache.evictions(), 1);
        assert_eq!(cache.resident_weight(), 20);
    }

    #[test]
    fn mark_recent_grants_one_round_reprieve() {
        let mut cache: ParseCache<String> = ParseCache::with_budget(20, len_weight);
        let a = key(1, "/w/a.def");
        let b = key(2, "/w/b.def");
        cache.insert(a.clone(), 1, "0123456789".into());
        cache.insert(b.clone(), 1, "9876543210".into());
        // RUST-125:打开事件触达(无指纹 get,纯 mark_recent)。
        cache.mark_recent(&a);
        cache.insert(key(3, "/w/c.def"), 1, "abcdefghij".into());
        // b(未触达)被逐,a 因 mark_recent 缓刑存活(contains 纯观测,
        // get 的命中置位会污染断言)。
        assert!(cache.contains(&a), "mark_recent 必须缓刑一轮");
        assert!(!cache.contains(&b), "未触达条目先被驱逐");
        // 缓刑窗口有限:清位后 a 移至环尾,后续超限轮次先逐环头(c),
        // 持续超限最终轮到 a——长置未动的打开文件最终让位,不虚构硬 pin
        // (二次机会时钟的近似 LRU 语义,牺牲者序=环序非严格 LRU 序)。
        cache.insert(key(4, "/w/d.def"), 1, "klmnopqrst".into());
        assert!(!cache.contains(&key(3, "/w/c.def")), "环头未触达条目先逐");
        cache.insert(key(5, "/w/e.def"), 1, "uvwxyz0123".into());
        assert!(!cache.contains(&a), "持续超限最终逐出缓刑条目");
    }

    #[test]
    fn mark_recent_unknown_key_is_noop() {
        let mut cache: ParseCache<String> = ParseCache::with_budget(20, len_weight);
        cache.mark_recent(&key(9, "/w/ghost.def"));
        assert_eq!(cache.valid_len(), 0);
        assert_eq!(cache.evictions(), 0);
    }

    #[test]
    fn budget_single_entry_over_limit_is_evicted_immediately() {
        let mut cache: ParseCache<String> = ParseCache::with_budget(5, len_weight);
        let k = key(1, "/w/huge.def");
        cache.insert(k.clone(), 1, "0123456789".into());
        // 单条目即超限:插入即驱逐,预算绝不无限超出(终止性守卫)。
        assert!(cache.get(&k, 1).is_none());
        assert_eq!(cache.valid_len(), 0);
        assert_eq!(cache.resident_weight(), 0);
        assert_eq!(cache.evictions(), 1);
    }

    #[test]
    fn fingerprint_mismatch_does_not_mark_recent() {
        let mut cache: ParseCache<String> = ParseCache::with_budget(20, len_weight);
        let a = key(1, "/w/a.def");
        let b = key(2, "/w/b.def");
        let c = key(3, "/w/c.def");
        cache.insert(a.clone(), 1, "0123456789".into());
        cache.insert(b.clone(), 1, "9876543210".into());
        // 指纹不符的「未命中」不得置近期位:过期条目不享受缓刑。
        assert!(cache.get(&a, 42).is_none());
        cache.insert(c.clone(), 1, "abcdefghij".into());
        assert!(cache.get(&a, 1).is_none(), "过期命中不得保护条目");
        assert!(cache.get(&b, 1).is_some());
    }

    #[test]
    fn replace_same_key_updates_weight() {
        let mut cache: ParseCache<String> = ParseCache::with_budget(15, len_weight);
        let a = key(1, "/w/a.def");
        let b = key(2, "/w/b.def");
        cache.insert(a.clone(), 1, "0123456789".into());
        cache.insert(a.clone(), 2, "01234567".into());
        assert_eq!(cache.resident_weight(), 8, "替换同键必须重算权重");
        assert_eq!(cache.get(&a, 2).unwrap().as_str(), "01234567");
        cache.insert(b.clone(), 1, "9876543210".into());
        // 8+10=18 > 15:驱逐 A(recent 位在 get 时已置位,先清位缓刑,
        // 时钟环扫描 B 后回环再遇 A 驱逐——两轮内必收敛)。
        assert!(cache.get(&b, 1).is_some());
        assert!(cache.get(&a, 2).is_none(), "超限后必须驱逐到预算内");
        assert!(cache.resident_weight() <= 15);
    }

    #[test]
    fn invalidate_adjusts_budget_weight() {
        let mut cache: ParseCache<String> = ParseCache::with_budget(20, len_weight);
        let a = key(1, "/w/a.def");
        let b = key(2, "/w/b.def");
        let c = key(3, "/w/c.def");
        cache.insert(a.clone(), 1, "0123456789".into());
        cache.insert(b.clone(), 1, "9876543210".into());
        cache.invalidate(&a);
        assert_eq!(cache.resident_weight(), 10, "失效必须同步扣权重");
        cache.insert(c.clone(), 1, "abcdefghij".into());
        // 10+10=20 恰好预算内:不得误驱逐。
        assert_eq!(cache.evictions(), 0);
        assert!(cache.get(&b, 1).is_some());
        assert!(cache.get(&c, 1).is_some());
    }

    #[test]
    fn invalidate_root_recomputes_budget_weight() {
        let mut cache: ParseCache<String> = ParseCache::with_budget(20, len_weight);
        let a = key(1, "/w/a.def");
        let b = key(2, "/w/b.def");
        let c = key(3, "/w/c.def");
        cache.insert(a.clone(), 1, "0123456789".into());
        cache.insert(b.clone(), 2, "9876543210".into());
        cache.invalidate_root(RootId(1));
        assert_eq!(cache.resident_weight(), 10, "根切换必须重算权重合计");
        cache.insert(c.clone(), 3, "abcdefghij".into());
        assert_eq!(cache.evictions(), 0);
        assert!(cache.get(&b, 2).is_some());
    }

    #[test]
    fn unbounded_default_never_evicts() {
        let mut cache: ParseCache<String> = ParseCache::new();
        for i in 0..64 {
            cache.insert(key((i % 8) as u32, "/w/x.def"), i as u64, "some-ast".into());
        }
        assert_eq!(cache.evictions(), 0);
        assert_eq!(cache.resident_weight(), 0, "无界缓存不追踪权重");
        assert_eq!(cache.valid_len(), 8);
    }

    #[test]
    fn budget_keeps_lookup_correct_under_pressure() {
        // 驱逐只丢缓存不丢正确性:重插即重建。
        let mut cache: ParseCache<String> = ParseCache::with_budget(12, len_weight);
        let a = key(1, "/w/a.def");
        let b = key(2, "/w/b.def");
        let fp = content_fingerprint("v");
        cache.insert(a.clone(), fp, "0123456789".into());
        cache.insert(b.clone(), fp, "9876543210".into());
        assert!(cache.get(&a, fp).is_none(), "A 被驱逐");
        cache.insert(a.clone(), fp, "0123456789".into());
        assert_eq!(
            cache.get(&a, fp).unwrap().as_str(),
            "0123456789",
            "重插即恢复"
        );
    }
}
