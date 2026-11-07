//! Schema 编译缓存(PA-003「schema 编译缓存」):同一 Hash 的 Schema 只
//! 编译一次,得到各 Flow 的快速查表结构。

use std::collections::HashMap;
use std::sync::Arc;

use kode_kbengine_schema::Schema;

use crate::messages::MessageMap;

/// 编译产物:静态段消息表(含参数线类型)+ 全局解码上限。
#[derive(Debug)]
pub struct CompiledSchema {
    pub hash_hex: String,
    pub statics: MessageMap,
    pub packet_always_contain_length: bool,
}

/// 进程级缓存(hash → 编译产物)。
#[derive(Debug, Default)]
pub struct SchemaCache {
    entries: HashMap<String, Arc<CompiledSchema>>,
}

impl SchemaCache {
    pub fn new() -> Self {
        SchemaCache::default()
    }

    /// 命中则复用;未命中则编译(schema hash 做键)。
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
