//! RUST-126 disk cache keys: the identity contract of parse artifact persistence entries.
//!
//! The persistence family pins keys first (RUST-127 crash-safe writes / RUST-128 format
//! baseline consume this contract): **any environmental factor that affects the semantics
//! of a parse artifact must go into the key** — a changed environment still hitting the
//! old entry is a dirty read. Five factors (RUST-126, each named in its line):
//!
//! 1. `core_schema` — the Core schema identity (e.g. the kode-kbengine-schema
//!    `Schema::SCHEMA_VERSION` or the string form of its content fingerprint);
//! 2. `engine_profile` — the engine profile identity (e.g. the fingerprint string of
//!    the EngineMetaLayer seed set + overrides);
//! 3. `root_identity` — the root identity (cross-process persistence cannot use the
//!    in-process RootId number; use the root path and other stable identities);
//! 4. `workspace_config` — the workspace configuration that affects parsing (the
//!    caller-normalized string);
//! 5. `parser_version` — the parser version (a parse-rule change must invalidate old caches).
//!
//! Encoding = an ordered length-prefixed stream plus a dual-seed FNV-1a 128bit. **The
//! length prefix prevents concatenation ambiguity**: (core="ab", engine="c") and
//! (core="a", engine="bc") produce the same string without prefixes -> a key collision;
//! with length prefixes it is impossible. Factors enter the stream in a fixed order
//! (swapping values yields a different stream); key form = 32 hex chars (16 high / 16 low).

use crate::parse_cache::content_fingerprint;

/// The five-factor input (borrowed form; the caller owns factor normalization and source wiring).
#[derive(Debug, Clone, Copy)]
pub struct PersistKeyFactors<'a> {
    pub core_schema: &'a str,
    pub engine_profile: &'a str,
    pub root_identity: &'a str,
    pub workspace_config: &'a str,
    pub parser_version: &'a str,
}

/// The persistent cache key (128bit; hex form for file names / index columns).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PersistCacheKey {
    pub high: u64,
    pub low: u64,
}

impl PersistCacheKey {
    /// 32 hex chars (16 high + 16 low, fixed width).
    pub fn hex(&self) -> String {
        format!("{:016x}{:016x}", self.high, self.low)
    }
}

/// A length-prefixed string: `len:<bytes>`, len in decimal. Enters the stream in fixed order.
fn push_factor(stream: &mut String, value: &str) {
    stream.push_str(&value.len().to_string());
    stream.push(':');
    stream.push_str(value);
    stream.push('|');
}

/// Build the persistent cache key: the five `factors` plus the `doc_path` document path identity.
/// Stable for the same factors and path (a pure function, no clock/randomness); changing any
/// factor or the path changes the key.
pub fn persist_cache_key(factors: &PersistKeyFactors<'_>, doc_path: &str) -> PersistCacheKey {
    let mut stream = String::new();
    push_factor(&mut stream, factors.core_schema);
    push_factor(&mut stream, factors.engine_profile);
    push_factor(&mut stream, factors.root_identity);
    push_factor(&mut stream, factors.workspace_config);
    push_factor(&mut stream, factors.parser_version);
    push_factor(&mut stream, doc_path);
    PersistCacheKey {
        // Dual seed: a single FNV-1a 64 collision probability is already negligible
        // for engineering corpora (tens of thousands of entries), and the dual seed pushes
        // the birthday bound to the 2^64 range, so hex-indexed cross-session
        // entries stay unambiguous.
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
        // Fixed-width hex with a fixed character set.
        assert!(a
            .hex()
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    #[test]
    fn each_factor_change_changes_key() {
        let path = "/ws/A.def";
        let base = persist_cache_key(&factors("1", "seed-a", "/ws", "cfg", "0.2.0"), path);
        // The five RUST-126 factors by name: any change -> the key must change (otherwise a dirty read).
        assert_ne!(
            base,
            persist_cache_key(&factors("2", "seed-a", "/ws", "cfg", "0.2.0"), path),
            "core schema 变必须换 key"
        );
        assert_ne!(
            base,
            persist_cache_key(&factors("1", "seed-b", "/ws", "cfg", "0.2.0"), path),
            "engine profile 变必须换 key"
        );
        assert_ne!(
            base,
            persist_cache_key(&factors("1", "seed-a", "/ws2", "cfg", "0.2.0"), path),
            "root identity 变必须换 key"
        );
        assert_ne!(
            base,
            persist_cache_key(&factors("1", "seed-a", "/ws", "cfg2", "0.2.0"), path),
            "workspace config 变必须换 key"
        );
        assert_ne!(
            base,
            persist_cache_key(&factors("1", "seed-a", "/ws", "cfg", "0.3.0"), path),
            "parser version 变必须换 key"
        );
        // A changed document path also changes the key.
        assert_ne!(
            base,
            persist_cache_key(&factors("1", "seed-a", "/ws", "cfg", "0.2.0"), "/ws/B.def")
        );
    }

    #[test]
    fn length_prefix_prevents_concatenation_ambiguity() {
        // ("ab","c") and ("a","bc") concatenate to the same string "abc" without prefixes
        // -> they must yield different keys.
        let a = persist_cache_key(&factors("ab", "c", "/ws", "cfg", "0.2.0"), "/ws/A.def");
        let b = persist_cache_key(&factors("a", "bc", "/ws", "cfg", "0.2.0"), "/ws/A.def");
        assert_ne!(a, b, "长度前缀必须防拼接歧义");
    }

    #[test]
    fn empty_factors_still_distinguish_paths() {
        // All-empty factors (illegal but the constructor sets no defense): the path still
        // uniquely determines the key, no panic.
        let a = persist_cache_key(&factors("", "", "", "", ""), "/ws/A.def");
        let b = persist_cache_key(&factors("", "", "", "", ""), "/ws/B.def");
        assert_ne!(a, b);
    }

    #[test]
    fn factor_boundary_chars_do_not_collide() {
        // True ambiguity when values contain separators: ("a|b","c") and ("a","b|c")
        // produce the same stream "a|b|c|..." without prefixes -> they must collide
        // into different keys (with the length prefix present this is impossible).
        let a = persist_cache_key(&factors("a|b", "c", "/ws", "cfg", "0.2.0"), "/ws/A.def");
        let b = persist_cache_key(&factors("a", "b|c", "/ws", "cfg", "0.2.0"), "/ws/A.def");
        assert_ne!(a, b, "分隔符跨界歧义必须被长度前缀防住");
    }
}
