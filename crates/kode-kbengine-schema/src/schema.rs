//! Schema IR + canonical JSON + SHA-256 摘要(todo PA-002「JSON+Hash」)。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::messages::MessageTable;
use crate::wire::WireType;

/// 单实体线格式条目(属性 + 三段方法,全部为线类型)。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EntityWireInfo {
    pub name: String,
    pub parent: Option<String>,
    pub interfaces: Vec<String>,
    pub volatile: bool,
    /// 合并序:父 → 接口 → 自身;flags 保留规范化 token。
    pub properties: Vec<EntityPropertyWire>,
    pub base_methods: Vec<EntityMethodWire>,
    pub cell_methods: Vec<EntityMethodWire>,
    pub client_methods: Vec<EntityMethodWire>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntityPropertyWire {
    pub name: String,
    pub ty: WireType,
    /// 规范化旗标(BASE_AND_CLIENT / ALL_CLIENTS / ...;同步面用)。
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntityMethodWire {
    pub name: String,
    pub exposed: bool,
    pub args: Vec<WireType>,
}

/// Schema IR(项目级;canonical 序:BTreeMap + id 升序 Vec)。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Schema {
    /// IR 版本(结构演进时递增)。
    pub schema_version: u32,
    /// 取证的引擎基准(PA-001:bf1a9cd6 / v2.5.10)。
    pub engine_baseline: String,
    /// §4.3 packetAlwaysContainLength(引擎默认 false)。
    pub packet_always_contain_length: bool,
    /// 别名线类型表(types.xml + alias.xml;名字 → 已展开线类型)。
    pub aliases: BTreeMap<String, WireType>,
    /// 实体线格式(entities.xml 注册 ∩ .def 落盘)。
    pub entities: BTreeMap<String, EntityWireInfo>,
    /// entities.xml 注册但 .def 缺失(诊断保留,不编造空条目)。
    pub missing_entities: Vec<String>,
    pub messages: MessageTable,
    /// 构建诊断(SYNTAX-005 同规:坏输入不失败,逐条可定位)。
    pub diagnostics: Vec<String>,
}

impl Schema {
    pub const SCHEMA_VERSION: u32 = 1;
    pub const ENGINE_BASELINE: &str = "kbengine bf1a9cd6f4a82dd715fcf4a69697382ed531b4c0 (v2.5.10)";

    /// 已展开的别名线类型(types.xml/alias.xml;未知名返回 None)。
    pub fn resolve_alias(&self, name: &str) -> Option<&WireType> {
        self.aliases.get(name)
    }

    /// canonical JSON:serde_json 结构序 + BTreeMap 字典序 + Vec id 升序,
    /// 相同输入字节级一致(无时间戳/路径等不稳定字段)。
    pub fn to_canonical_json(&self) -> String {
        // entry 序已在构建时排序;此处再兜底排序一次(防御手工构造)。
        let mut sorted = self.clone();
        sorted
            .messages
            .entries
            .sort_by(|a, b| a.id.cmp(&b.id).then(a.name.cmp(&b.name)));
        serde_json::to_string(&sorted).expect("Schema is JSON-serializable")
    }

    /// SHA-256(canonical JSON UTF-8 字节);hex 小写。
    pub fn hash_hex(&self) -> String {
        let mut h = Sha256::new();
        h.update(self.to_canonical_json().as_bytes());
        let d = h.finalize();
        let mut out = String::with_capacity(64);
        for b in d {
            out.push_str(&format!("{b:02x}"));
        }
        out
    }
}
