//! Deterministic pseudo-vector semantic retrieval (P3 seam fill,
//! design doc §12 `P3: pluggable vector module (on-demand), hybrid fusion`).
//!
//! **Honest boundary — must stay in the tool description and payloads:** this
//! is **feature hashing over the AST-derived nodes**, not a learned embedding
//! model. It delivers a real vector slot + hybrid fusion and removes the
//! `vector-deferred` honesty marker, but it does **not** bridge near-synonyms
//! or paraphrase — that remains the learned-model upgrade. Chosen by the
//! project's determinism/red-line decisions: no network, no model weight, and
//! **user source never leaves the machine** (cloud embeddings are the same
//! exfiltration class the project forbids), fully reproducible across runs.
//!
//! Design: 256 dims, feature hashing (`h mod dims`, sign from the top bit —
//! signed reduces collision bias), L2-normalized, brute-force cosine over the
//! bounded node set (design doc §8: local exact queries are the bulk; a vector
//! DB is not warranted). Ties break by node id, matching the BM25 convention.
//!
//! Feature extraction mirrors the Tantivy `cjk` tokenizer so the two faces
//! agree: Latin/identifier unigrams (lowercased, `_` kept) plus CJK unigram and
//! bigram, so Chinese phrases get overlapping features. `name` features are
//! weighted 3× — it is the strongest single signal of an AST node.

use std::fmt;
use std::sync::{Arc, Mutex};

use crate::kb_index::SemanticRetriever;
use crate::nodes::IndexNode;
use crate::store::KbStore;

/// Vector dimensionality. Small on purpose: features are sparse and few; a
/// wider space only dilutes the collision-limited signal.
pub const VECTOR_DIMS: usize = 256;

/// Per-node feature cap (bounded work; content is already bounded at
/// extraction, the cap is the second guarantee).
pub const MAX_FEATURES_PER_NODE: usize = 512;

/// Name features count three times: strongest single AST signal.
pub const NAME_WEIGHT: f32 = 3.0;

/// Keep rows scoring at least this fraction of the top score (see `rank`).
const NOISE_FLOOR_RATIO: f32 = 0.25;

/// Engine name reported in the search payload (`vector.engine`).
pub const VECTOR_ENGINE_NAME: &str = "deterministic-feature-hashing";

/// One table row: node id → L2-normalized embedding.
type EmbeddedNode = (String, Vec<f32>);

/// (node count the table was built for, id → embedding).
type VectorTable = (usize, Vec<EmbeddedNode>);

pub struct DeterministicVectorRetriever {
    store: Arc<KbStore>,
    /// Rebuilt when the node count changes; a same-count content edit
    /// refreshes on the next count change or process restart (documented
    /// residual).
    table: Mutex<Option<VectorTable>>,
}

impl fmt::Debug for DeterministicVectorRetriever {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeterministicVectorRetriever")
            .field("dims", &VECTOR_DIMS)
            .field("engine", &VECTOR_ENGINE_NAME)
            .finish_non_exhaustive()
    }
}

impl DeterministicVectorRetriever {
    pub fn new(store: Arc<KbStore>) -> Self {
        Self {
            store,
            table: Mutex::new(None),
        }
    }

    /// FNV-1a: stable, dependency-free, deterministic across runs.
    fn hash_feature(feature: &str) -> (usize, f32) {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in feature.as_bytes() {
            h ^= u64::from(*byte);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        (
            h as usize % VECTOR_DIMS,
            if (h >> 63) & 1 == 0 { 1.0 } else { -1.0 },
        )
    }

    fn accumulate(vec: &mut [f32], features: Vec<String>, weight: f32) {
        for (i, feature) in features.into_iter().enumerate() {
            if i >= MAX_FEATURES_PER_NODE {
                break;
            }
            let (bucket, sign) = Self::hash_feature(&feature);
            vec[bucket] += sign * weight;
        }
    }

    /// L2 normalize in place; a zero vector stays zero (never a NaN cosine).
    fn normalize(vec: &mut [f32]) {
        let norm: f32 = vec.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 0.0 {
            for v in vec.iter_mut() {
                *v /= norm;
            }
        }
    }

    /// Feature extraction: the same unigram/bigram shape as the Tantivy `cjk`
    /// tokenizer, so the deterministic face and the BM25 face agree on what
    /// counts as a term.
    fn features(text: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut run = String::new();
        let mut prev_cjk: Option<char> = None;
        for ch in text.chars() {
            if ch.is_ascii_alphanumeric() || ch == '_' {
                run.push(ch.to_ascii_lowercase());
                prev_cjk = None;
            } else {
                if !run.is_empty() {
                    out.push(std::mem::take(&mut run));
                }
                if (0x4E00..=0x9FFF).contains(&(ch as u32)) {
                    out.push(ch.to_string());
                    if let Some(prev) = prev_cjk {
                        out.push(format!("{prev}{ch}"));
                    }
                    prev_cjk = Some(ch);
                } else {
                    prev_cjk = None;
                }
            }
        }
        if !run.is_empty() {
            out.push(run);
        }
        out
    }

    pub fn embed_node(node: &IndexNode) -> Vec<f32> {
        let mut vec = vec![0.0f32; VECTOR_DIMS];
        Self::accumulate(&mut vec, Self::features(&node.name), NAME_WEIGHT);
        Self::accumulate(&mut vec, Self::features(&node.content), 1.0);
        Self::normalize(&mut vec);
        vec
    }

    pub fn embed_query(query: &str) -> Vec<f32> {
        let mut vec = vec![0.0f32; VECTOR_DIMS];
        Self::accumulate(&mut vec, Self::features(query), NAME_WEIGHT);
        Self::normalize(&mut vec);
        vec
    }

    /// Build (or reuse) the node→embedding table, then rank the query.
    fn rank(query: &[f32], rows: &[(String, Vec<f32>)], limit: usize) -> Vec<(String, f32)> {
        let mut scored: Vec<(String, f32)> = rows
            .iter()
            .filter_map(|(id, vec)| {
                let dot: f32 = query.iter().zip(vec.iter()).map(|(a, b)| a * b).sum();
                if dot > 0.0 {
                    Some((id.clone(), dot))
                } else {
                    None
                }
            })
            .collect();
        // Deterministic: score desc, ties by node id — same convention as the
        // BM25 face (doc id), so fusion order is reproducible.
        scored.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        // Noise floor: signed feature hashing gives long unrelated docs a
        // small positive cosine roughly half the time (random-projection
        // behavior), and `dot > 0` alone lets that noise fill the fused rows.
        // Keep only rows scoring a real fraction of the top score — true
        // overlaps score high, noise scores near zero.
        if let Some((_, top)) = scored.first() {
            let floor = top * NOISE_FLOOR_RATIO;
            scored.retain(|(_, score)| *score >= floor);
        }
        scored.truncate(limit);
        scored
    }
}

impl SemanticRetriever for DeterministicVectorRetriever {
    fn name(&self) -> &'static str {
        VECTOR_ENGINE_NAME
    }

    fn retrieve(&self, query: &str, limit: usize) -> Result<Vec<(String, f32)>, String> {
        let query_vec = Self::embed_query(query);
        if query_vec.iter().all(|v| *v == 0.0) {
            // Nothing extractable: answer nothing rather than answer wrongly.
            return Ok(Vec::new());
        }
        let count = self.store.stats().0;
        {
            let table = self.table.lock().expect("vector table lock");
            if let Some((cached_count, rows)) = table.as_ref() {
                if *cached_count == count {
                    return Ok(Self::rank(&query_vec, rows, limit));
                }
            }
        }
        // Node count moved → rebuild. Residual: a same-count content edit is
        // picked up on the next count change or process restart (the count is
        // the cheap staleness signal; a content-hash sweep per query would
        // defeat the on-demand purpose).
        let rows: Vec<(String, Vec<f32>)> = self
            .store
            .nodes_all()
            .iter()
            .map(|node| (node.id.clone(), Self::embed_node(node)))
            .collect();
        let ranked = Self::rank(&query_vec, &rows, limit);
        *self.table.lock().expect("vector table lock") = Some((count, rows));
        Ok(ranked)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, name: &str, content: &str) -> IndexNode {
        IndexNode {
            id: id.to_string(),
            project: "t".to_string(),
            file_path: format!("scripts/{id}.def"),
            kind: crate::nodes::NodeKind::Entity,
            name: name.to_string(),
            content: content.to_string(),
            location: crate::nodes::SourceLocation::Lines { start: 1, end: 1 },
            content_hash: String::new(),
            confidence: crate::semantic_model::Confidence::Determined,
        }
    }

    #[test]
    fn embedding_is_deterministic_and_normalized() {
        let node = node("Avatar", "Avatar", "cell methods base");
        let a = DeterministicVectorRetriever::embed_node(&node);
        let b = DeterministicVectorRetriever::embed_node(&node);
        assert_eq!(a, b, "same input → same vector");
        assert_eq!(a.len(), VECTOR_DIMS);
        let norm: f32 = a.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4, "L2 normalized, got {norm}");
    }

    #[test]
    fn distinct_names_get_distinct_vectors() {
        let avatar = DeterministicVectorRetriever::embed_node(&node("a", "Avatar", ""));
        let monster = DeterministicVectorRetriever::embed_node(&node("b", "Monster", ""));
        assert_ne!(avatar, monster);
        // Cosine of two unrelated nodes must be below 1, not NaN.
        let dot: f32 = avatar.iter().zip(monster.iter()).map(|(x, y)| x * y).sum();
        assert!(dot.is_finite() && dot < 1.0);
    }

    #[test]
    fn name_weight_dominates_the_signal() {
        // "MoveToPoint" name beats a content coincidence.
        let by_name = DeterministicVectorRetriever::embed_node(&node(
            "a",
            "MoveToPoint",
            "unrelated body text about monsters",
        ));
        let by_content = DeterministicVectorRetriever::embed_node(&node(
            "b",
            "Monster",
            "unrelated body text mentioning move to point",
        ));
        let dot_name: f32 = DeterministicVectorRetriever::embed_query("MoveToPoint")
            .iter()
            .zip(by_name.iter())
            .map(|(x, y)| x * y)
            .sum();
        let dot_content: f32 = DeterministicVectorRetriever::embed_query("MoveToPoint")
            .iter()
            .zip(by_content.iter())
            .map(|(x, y)| x * y)
            .sum();
        assert!(
            dot_name > dot_content,
            "name-weighted match must outrank content coincidence ({dot_name} vs {dot_content})"
        );
    }

    #[test]
    fn cjk_features_cover_phrases() {
        // Unigram + bigram so a two-character phrase is reachable.
        let zh = DeterministicVectorRetriever::embed_query("传送");
        let en = DeterministicVectorRetriever::embed_query("teleport");
        let dot_zh: f32 = DeterministicVectorRetriever::embed_query("传送")
            .iter()
            .zip(zh.iter())
            .map(|(a, b)| a * b)
            .sum();
        assert!(dot_zh > 0.0, "CJK self-match must be positive");
        // The two share no features, so cross-lingual cosine is ~0 (honest:
        // this face does not bridge languages).
        let dot_cross: f32 = DeterministicVectorRetriever::embed_query("传送")
            .iter()
            .zip(en.iter())
            .map(|(a, b)| a * b)
            .sum();
        assert!(
            dot_cross.abs() < 1e-6,
            "no cross-lingual bridge: {dot_cross}"
        );
    }

    #[test]
    fn unextractable_query_answers_nothing() {
        assert!(DeterministicVectorRetriever::embed_query("   ")
            .iter()
            .all(|v| *v == 0.0));
    }

    #[test]
    fn ranking_is_deterministic_ties_break_by_id() {
        let rows: Vec<(String, Vec<f32>)> =
            vec![("b".to_string(), vec![1.0]), ("a".to_string(), vec![1.0])];
        let query = vec![1.0];
        let ranked = DeterministicVectorRetriever::rank(&query, &rows, 10);
        assert_eq!(
            ranked.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"],
            "ties break by node id asc"
        );
    }

    #[test]
    fn retrieve_reads_the_store_and_returns_scored_rows() {
        let tmp = std::env::temp_dir().join(format!("kode-mcp-vec-unit-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("tmp dir");
        let store = Arc::new(KbStore::open(&tmp.join("kb.sqlite")).expect("store open"));
        store
            .replace_file_nodes(
                "scripts/Avatar.def",
                &[
                    node("n1", "Avatar", "cell methods"),
                    node("n2", "Monster", "client methods"),
                ],
            )
            .expect("replace nodes");
        let retriever = DeterministicVectorRetriever::new(store.clone());
        let hits = retriever.retrieve("Avatar", 5).expect("retrieve");
        assert_eq!(hits.first().map(|(id, _)| id.as_str()), Some("n1"));
        assert!(hits.iter().all(|(_, s)| s.is_finite()), "scores finite");
        std::fs::remove_dir_all(&tmp).ok();
    }
}
