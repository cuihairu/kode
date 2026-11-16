//! RUST-126 磁盘缓存 key:解析产物持久化条目的身份契约。
//!
//! 持久化家族的 key 先行(RUST-127 崩溃安全写入 / RUST-128 格式基准消费本
//! 契约):**任何影响解析产物语义的环境因子都必须进 key**——环境变了旧条目
//! 还能命中 = 脏读。五因子(RUST-126 行逐名):
//!
//! 1. `core_schema` — Core schema 身份(如 kode-kbengine-schema
//!    `Schema::SCHEMA_VERSION` 或其内容指纹的字符串形态);
//! 2. `engine_profile` — 引擎 profile 身份(如 EngineMetaLayer seed 集 +
//!    override 的指纹字符串);
//! 3. `root_identity` — 根身份(跨进程持久化不能用进程内 RootId 数值,
//!    用根路径等稳定身份);
//! 4. `workspace_config` — 影响解析的工作区配置(调用方规范化后的串);
//! 5. `parser_version` — 解析器版本(解析规则变化旧缓存必须失效)。
//!
//! 编码 = 定序长度前缀串流 + 双 seed FNV-1a 128bit。**长度前缀防拼接
//! 歧义**:(core="ab", engine="c") 与 (core="a", engine="bc") 无前缀时
//! 拼出同串 → 撞 key;带长度前缀即不可能。因子按固定序进流(值互换即
//! 流不同),key 形态 = 32 hex(高/低各 16)。

use crate::parse_cache::content_fingerprint;

/// 五因子输入(借用形态;调用方负责因子的规范化与来源接线)。
#[derive(Debug, Clone, Copy)]
pub struct PersistKeyFactors<'a> {
    pub core_schema: &'a str,
    pub engine_profile: &'a str,
    pub root_identity: &'a str,
    pub workspace_config: &'a str,
    pub parser_version: &'a str,
}

/// 持久化缓存 key(128bit;hex 形态供文件名/索引列)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PersistCacheKey {
    pub high: u64,
    pub low: u64,
}

impl PersistCacheKey {
    /// 32 hex(高 16 + 低 16,定宽)。
    pub fn hex(&self) -> String {
        format!("{:016x}{:016x}", self.high, self.low)
    }
}

/// 长度前缀串:`len:<bytes>`,len 十进制。定序进流。
fn push_factor(stream: &mut String, value: &str) {
    stream.push_str(&value.len().to_string());
    stream.push(':');
    stream.push_str(value);
    stream.push('|');
}

/// 构造持久化缓存 key:`factors` 五因子 + `doc_path` 文档路径身份。
/// 同因子同路径恒稳定(纯函数,无时钟/随机);任一因子或路径变化即变。
pub fn persist_cache_key(factors: &PersistKeyFactors<'_>, doc_path: &str) -> PersistCacheKey {
    let mut stream = String::new();
    push_factor(&mut stream, factors.core_schema);
    push_factor(&mut stream, factors.engine_profile);
    push_factor(&mut stream, factors.root_identity);
    push_factor(&mut stream, factors.workspace_config);
    push_factor(&mut stream, factors.parser_version);
    push_factor(&mut stream, doc_path);
    PersistCacheKey {
        // 双 seed:单 FNV-1a 64 在工程语料(万级条目)碰撞概率已可忽略,
        // 双 seed 把生日界推到 2^64 量级,持久化跨会话条目按 hex 索引零歧义。
        high: content_fingerprint(&stream),
        low: content_fingerprint(&format!("kode-persist-v1|{stream}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn factors<'a>(
        core: &'a str,
        engine: &'a str,
        root: &'a str,
        config: &'a str,
        parser: &'a str,
    ) -> PersistKeyFactors<'a> {
        PersistKeyFactors {
            core_schema: core,
            engine_profile: engine,
            root_identity: root,
            workspace_config: config,
            parser_version: parser,
        }
    }

    #[test]
    fn same_factors_same_path_is_stable() {
        let a = persist_cache_key(&factors("1", "seed-a", "/ws", "cfg", "0.2.0"), "/ws/A.def");
        let b = persist_cache_key(&factors("1", "seed-a", "/ws", "cfg", "0.2.0"), "/ws/A.def");
        assert_eq!(a, b);
        assert_eq!(a.hex().len(), 32);
        // hex 定宽定字符集。
        assert!(a.hex().chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    #[test]
    fn each_factor_change_changes_key() {
        let path = "/ws/A.def";
        let base = persist_cache_key(&factors("1", "seed-a", "/ws", "cfg", "0.2.0"), path);
        // RUST-126 五因子逐名:任一变化 → key 必变(否则脏读)。
        assert_ne!(base, persist_cache_key(&factors("2", "seed-a", "/ws", "cfg", "0.2.0"), path), "core schema 变必须换 key");
        assert_ne!(base, persist_cache_key(&factors("1", "seed-b", "/ws", "cfg", "0.2.0"), path), "engine profile 变必须换 key");
        assert_ne!(base, persist_cache_key(&factors("1", "seed-a", "/ws2", "cfg", "0.2.0"), path), "root identity 变必须换 key");
        assert_ne!(base, persist_cache_key(&factors("1", "seed-a", "/ws", "cfg2", "0.2.0"), path), "workspace config 变必须换 key");
        assert_ne!(base, persist_cache_key(&factors("1", "seed-a", "/ws", "cfg", "0.3.0"), path), "parser version 变必须换 key");
        // 文档路径变化同样换 key。
        assert_ne!(base, persist_cache_key(&factors("1", "seed-a", "/ws", "cfg", "0.2.0"), "/ws/B.def"));
    }

    #[test]
    fn length_prefix_prevents_concatenation_ambiguity() {
        // ("ab","c") 与 ("a","bc") 无前缀时拼出同串 "abc" → 必须不同 key。
        let a = persist_cache_key(&factors("ab", "c", "/ws", "cfg", "0.2.0"), "/ws/A.def");
        let b = persist_cache_key(&factors("a", "bc", "/ws", "cfg", "0.2.0"), "/ws/A.def");
        assert_ne!(a, b, "长度前缀必须防拼接歧义");
    }

    #[test]
    fn empty_factors_still_distinguish_paths() {
        // 全空因子(不合法但构造器不设防):path 仍唯一决定 key,不 panic。
        let a = persist_cache_key(&factors("", "", "", "", ""), "/ws/A.def");
        let b = persist_cache_key(&factors("", "", "", "", ""), "/ws/B.def");
        assert_ne!(a, b);
    }

    #[test]
    fn factor_boundary_chars_do_not_collide() {
        // 值含分隔符时的真歧义:("a|b","c") 与 ("a","b|c") 无前缀时拼出
        // 同流 "a|b|c|…" → 必须撞出不同 key(长度前缀在场即不可能)。
        let a = persist_cache_key(&factors("a|b", "c", "/ws", "cfg", "0.2.0"), "/ws/A.def");
        let b = persist_cache_key(&factors("a", "b|c", "/ws", "cfg", "0.2.0"), "/ws/A.def");
        assert_ne!(a, b, "分隔符跨界歧义必须被长度前缀防住");
    }
}
