//! Schema compilation cache (PA-003 "schema compile cache"): a Schema with the same Hash is
//! compiled only once, yielding the fast lookup structures used by each Flow.

use std::collections::HashMap;
use std::sync::Arc;

use kode_kbengine_schema::Schema;

use crate::messages::MessageMap;

/// Compilation product: static-segment message table (with argument wire types) + global decode limits.
#[derive(Debug)]
pub struct CompiledSchema {
    pub hash_hex: String,
    pub statics: MessageMap,
    pub packet_always_contain_length: bool,
}

/// Process-level cache (hash → compilation product).
#[derive(Debug, Default)]
pub struct SchemaCache {
    entries: HashMap<String, Arc<CompiledSchema>>,
}

impl SchemaCache {
    pub fn new() -> Self {
        SchemaCache::default()
    }

    /// Reuse on a hit; compile on a miss (keyed by schema hash).
    pub fn get_or_compile(&mut self, schema: &Schema) -> Arc<CompiledSchema> {
        let hash = schema.hash_hex();
        if let Some(hit) = self.entries.get(&hash) {
            return Arc::clone(hit);
        }
        let compiled = Arc::new(CompiledSchema {
            hash_hex: hash.clone(),
            statics: MessageMap::from_static(&schema.messages),
            packet_always_contain_length: schema.packet_always_contain_length,
        });
        self.entries.insert(hash, Arc::clone(&compiled));
        compiled
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}
