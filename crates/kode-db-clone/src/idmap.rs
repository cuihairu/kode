//! 类型化 ID 映射(plan §6.3 / PDC-0304):oldID → newID 的键必须区分
//! 物理表 + 主键列,不同表的编号重复不得串改;新主键在目标插入后由数据库
//! 返回——计划期(Prepare)只分配**占位符**,Apply 期(Phase 4)以真实回填。
//!
//! 值域用 [`TypedValue`] 保精度(bigint unsigned 全域),不做算术偏移
//! (§6.3:所有相关字段使用映射结果而非偏移量)。
//!
//! 业务永久稳定 ID(物品模板/技能配置/地图)不入映射:不入表即保持原值,
//! 「未知引用不默认全局替换」由省略承载,不靠哨兵值。

use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde::{Serialize, Serializer};

use crate::value::TypedValue;

/// 全序投影(TypedValue 含 Float 不能派生 Ord;映射键只要求确定性全序,
/// 等价性语义仍由 TypedValue 的 PartialEq 精确承载)。
pub(crate) fn value_rank(v: &TypedValue) -> (u8, String) {
    match v {
        TypedValue::Null => (0, String::new()),
        TypedValue::Int(x) => (1, x.to_string()),
        TypedValue::UInt(x) => (2, x.to_string()),
        TypedValue::BigUInt(x) => (3, x.to_string()),
        TypedValue::Float(x) => (4, format!("{:016x}", x.to_bits())),
        TypedValue::Double(x) => (5, format!("{:016x}", x.to_bits())),
        TypedValue::Decimal(x) => (6, x.clone()),
        TypedValue::Bytes(x) => (7, x.clone()),
        TypedValue::Text(x) => (8, x.clone()),
        TypedValue::DateTime {
            value,
            offset_minutes,
        } => (9, format!("{value}|{offset_minutes:?}")),
    }
}

/// 集合探测用的规范键(与 value_rank 同一投影的扁平形态)。
pub(crate) fn value_key(v: &TypedValue) -> String {
    let (disc, payload) = value_rank(v);
    format!("{disc}:{payload}")
}

/// 导入 ID 模式(§6.1/PDC-0303):空白目标保留原 DBID / 已有测试库分配新 ID。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportMode {
    /// `preserve-id-if-empty`:保留归档原值(要求目标该 ID 空闲,预演查冲突)。
    PreserveIfEmpty,
    /// `allocate-new-ids`:全部主键/引用重分配(默认建议,降低碰撞风险)。
    AllocateNewIds,
}

/// 映射键(§6.3:数据库接口 + Entity 类型由计划整体限定,此处承载
/// 物理表 + 主键列 + 旧值三元组;serde 平面化为可审计字符串)。
#[derive(Debug, Clone, PartialEq)]
pub struct IdMapKey {
    pub table: String,
    pub column: String,
    pub old: TypedValue,
}

// Eq is std's prerequisite bound for Ord; the marker holds (the keys are dominated by
// integers/text, and lookup is governed by the injective projection of Ord).
impl Eq for IdMapKey {}

impl Ord for IdMapKey {
    fn cmp(&self, other: &Self) -> Ordering {
        (
            self.table.as_str(),
            self.column.as_str(),
            value_rank(&self.old),
        )
            .cmp(&(
                other.table.as_str(),
                other.column.as_str(),
                value_rank(&other.old),
            ))
    }
}

impl PartialOrd for IdMapKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

// 手写序列化(键入审计面:表/列/旧值三段,旧值按 TypedValue 原生形态)。
impl Serialize for IdMapKey {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(3))?;
        map.serialize_entry("table", &self.table)?;
        map.serialize_entry("column", &self.column)?;
        map.serialize_entry("old", &self.old)?;
        map.end()
    }
}

/// 旧值的新去向。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MappedId {
    /// 保留归档原值(preserve 模式主键/结构引用)。
    Preserved,
    /// Apply 期由数据库返回新主键;计划期仅占位(序号在语句内引用)。
    Allocated { placeholder: u64 },
    /// 计划期即确定的重写值(唯一键本地重建,PDC-0305)。
    Rebuilt { value: TypedValue },
}

/// ID 类别(验收门:预演须按类别展示变更面)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IdCategory {
    /// 根表实体主键。
    RootKey,
    /// 子表行主键。
    ChildRowKey,
    /// 子表 parentID(引用同克隆集内父行)。
    ParentReference,
    /// 声明跟随的业务引用列(Follow 规则,重映射)。
    BusinessReference,
    /// 唯一键本地重建(昵称/登录名)。
    RebuiltIdentity,
}

impl IdCategory {
    pub fn label(self) -> &'static str {
        match self {
            IdCategory::RootKey => "root-entity-key",
            IdCategory::ChildRowKey => "child-row-key",
            IdCategory::ParentReference => "parent-reference",
            IdCategory::BusinessReference => "business-reference",
            IdCategory::RebuiltIdentity => "rebuilt-identity",
        }
    }
}

/// 一条登记:键 + 去向 + 类别(审计面)。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IdMapEntry {
    pub key: IdMapKey,
    pub mapped: MappedId,
    pub category: IdCategory,
}

/// 本次导入的 ID 映射账本(BTreeMap 确定性序;JSON 键必须是字符串,
/// 故序列化为按键序的条目数组,同样可审计且免键投影失真)。
#[derive(Debug, Clone, Default)]
pub struct IdMap {
    entries: BTreeMap<IdMapKey, IdMapEntry>,
    next_placeholder: u64,
}

impl Serialize for IdMap {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut seq = serializer.serialize_seq(Some(self.entries.len()))?;
        for entry in self.entries.values() {
            seq.serialize_element(entry)?;
        }
        seq.end()
    }
}

impl IdMap {
    pub fn new() -> Self {
        Self {
            entries: BTreeMap::new(),
            next_placeholder: 1,
        }
    }

    /// 登记一条「保留原值」。
    pub fn preserve(&mut self, key: IdMapKey, category: IdCategory) {
        self.insert(key, MappedId::Preserved, category);
    }

    /// 登记一条占位新键(placeholder 单调递增,计划期不猜真实值)。
    pub fn allocate(&mut self, key: IdMapKey, category: IdCategory) -> MappedId {
        let placeholder = self.next_placeholder;
        self.next_placeholder += 1;
        let mapped = MappedId::Allocated { placeholder };
        self.insert(key, mapped.clone(), category);
        mapped
    }

    /// 登记一条计划期重写值(唯一键重建)。
    pub fn rebuild(&mut self, key: IdMapKey, value: TypedValue, category: IdCategory) {
        self.insert(key, MappedId::Rebuilt { value }, category);
    }

    fn insert(&mut self, key: IdMapKey, mapped: MappedId, category: IdCategory) {
        // 同键重复登记按 BTreeMap 语义后写覆盖;调用方(导入计划器)按行序
        // 恰好一次登记,重复即上游逻辑错,测试锁定。
        self.entries.insert(
            key.clone(),
            IdMapEntry {
                key,
                mapped,
                category,
            },
        );
    }

    /// 查旧值的去向(结构列渲染时引用同一映射,不另算)。
    pub fn get(&self, table: &str, column: &str, old: &TypedValue) -> Option<&MappedId> {
        self.entries
            .get(&IdMapKey {
                table: table.into(),
                column: column.into(),
                old: old.clone(),
            })
            .map(|e| &e.mapped)
    }

    /// 占位符 → 键(语句渲染时把 NewKey 占位与映射账本对上;Apply 期回填用)。
    pub fn key_for_placeholder(&self, placeholder: u64) -> Option<&IdMapKey> {
        self.entries
            .values()
            .find(|e| e.mapped == MappedId::Allocated { placeholder })
            .map(|e| &e.key)
    }

    /// 按类别计数(预演摘要面)。
    pub fn counts_by_category(&self) -> BTreeMap<IdCategory, usize> {
        let mut out = BTreeMap::new();
        for entry in self.entries.values() {
            *out.entry(entry.category).or_insert(0) += 1;
        }
        out
    }

    /// 全部登记(确定性序,审计/测试断言面)。
    pub fn entries(&self) -> impl Iterator<Item = &IdMapEntry> {
        self.entries.values()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(table: &str, column: &str, old: u64) -> IdMapKey {
        IdMapKey {
            table: table.into(),
            column: column.into(),
            old: TypedValue::BigUInt(old),
        }
    }

    #[test]
    fn keys_are_typed_per_table_and_column() {
        // §6.3:不同表/列的同值旧键互不串改。
        let mut map = IdMap::new();
        map.allocate(key("tbl_Avatar", "id", 7), IdCategory::RootKey);
        map.preserve(key("tbl_Account", "id", 7), IdCategory::RootKey);
        assert_eq!(
            map.get("tbl_Avatar", "id", &TypedValue::BigUInt(7)),
            Some(&MappedId::Allocated { placeholder: 1 })
        );
        assert_eq!(
            map.get("tbl_Account", "id", &TypedValue::BigUInt(7)),
            Some(&MappedId::Preserved)
        );
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn placeholders_are_monotonic_and_resolvable() {
        let mut map = IdMap::new();
        map.allocate(key("tbl_Avatar", "id", 1), IdCategory::RootKey);
        map.allocate(key("tbl_Avatar_items", "id", 2), IdCategory::ChildRowKey);
        map.allocate(key("tbl_Avatar_items", "id", 3), IdCategory::ChildRowKey);
        assert_eq!(
            map.get("tbl_Avatar_items", "id", &TypedValue::BigUInt(3)),
            Some(&MappedId::Allocated { placeholder: 3 })
        );
        assert_eq!(
            map.key_for_placeholder(2).map(|k| k.table.as_str()),
            Some("tbl_Avatar_items")
        );
        assert!(map.key_for_placeholder(9).is_none());
    }

    #[test]
    fn counts_by_category_for_preview() {
        let mut map = IdMap::new();
        map.allocate(key("tbl_Avatar", "id", 1), IdCategory::RootKey);
        map.allocate(key("tbl_Avatar_items", "id", 2), IdCategory::ChildRowKey);
        map.preserve(
            key("tbl_Avatar_items", "parentID", 1),
            IdCategory::ParentReference,
        );
        map.rebuild(
            IdMapKey {
                table: "tbl_Avatar".into(),
                column: "sm_name".into(),
                old: TypedValue::Text("hero".into()),
            },
            TypedValue::Text("hero_imported1".into()),
            IdCategory::RebuiltIdentity,
        );
        let counts = map.counts_by_category();
        assert_eq!(counts.get(&IdCategory::RootKey), Some(&1));
        assert_eq!(counts.get(&IdCategory::ChildRowKey), Some(&1));
        assert_eq!(counts.get(&IdCategory::ParentReference), Some(&1));
        assert_eq!(counts.get(&IdCategory::RebuiltIdentity), Some(&1));
        assert_eq!(counts.get(&IdCategory::BusinessReference), None);
    }

    #[test]
    fn missing_key_is_none_not_default() {
        let map = IdMap::new();
        // 未登记的引用不返回任何映射(调用方须保持原值,而非默认替换)。
        assert!(map
            .get("tbl_Avatar", "sm_templateId", &TypedValue::BigUInt(42))
            .is_none());
    }

    #[test]
    fn value_rank_and_key_cover_all_value_kinds_deterministically() {
        // 序投影:Null < 整型族 < 浮点族 < 十进制 < 字节 < 文本 < 时间,
        // 同族内按载荷序;value_key 是同一投影的扁平形态(可审计字符串)。
        let mut keys: Vec<String> = [
            TypedValue::Null,
            TypedValue::Int(-5),
            TypedValue::UInt(5),
            TypedValue::BigUInt(5),
            TypedValue::Float(1.5),
            TypedValue::Double(2.5),
            TypedValue::Decimal("1.23".into()),
            TypedValue::Bytes("0a".into()),
            TypedValue::Text("abc".into()),
            TypedValue::DateTime {
                value: "2026-01-01".into(),
                offset_minutes: Some(480),
            },
        ]
        .iter()
        .map(value_key)
        .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "rank 序与枚举声明序一致");
        assert_eq!(keys[0], "0:");
        assert!(keys[1].starts_with("1:-5"));
        assert!(keys[2].starts_with("2:5"));
        assert!(keys[3].starts_with("3:5"));
        assert!(keys[4].starts_with("4:"));
        assert!(keys[5].starts_with("5:"));
        assert!(keys[6].starts_with("6:1.23"));
        assert!(keys[7].starts_with("7:0a"));
        assert_eq!(keys[8], "8:abc");
        assert!(keys[9].starts_with("9:2026-01-01|Some(480)"));
        keys.dedup();
        assert_eq!(keys.len(), 10, "十种值形态的键互不相同");
    }

    #[test]
    fn id_map_key_orders_by_table_then_column_then_value() {
        // 全序:表 → 列 → 值秩;partial_cmp 与 cmp 一致(Ord 前置)。
        let a = IdMapKey {
            table: "tbl_A".into(),
            column: "id".into(),
            old: TypedValue::BigUInt(1),
        };
        let b = IdMapKey {
            table: "tbl_A".into(),
            column: "id".into(),
            old: TypedValue::Text("x".into()),
        };
        let c = IdMapKey {
            table: "tbl_B".into(),
            column: "id".into(),
            old: TypedValue::BigUInt(1),
        };
        assert!(a < b, "同表同列:数值秩 < 文本秩");
        assert!(b < c, "表名序决定跨表序");
        assert_eq!(a.cmp(&a), std::cmp::Ordering::Equal);
        assert_eq!(a.partial_cmp(&b), Some(a.cmp(&b)));
        assert!(a == a.clone());
    }

    #[test]
    fn id_map_len_and_is_empty_track_entries() {
        let mut map = IdMap::new();
        assert!(map.is_empty());
        assert_eq!(map.len(), 0);
        map.preserve(key("tbl_Avatar", "id", 7), IdCategory::RootKey);
        assert!(!map.is_empty());
        assert_eq!(map.len(), 1);
        assert_eq!(map.entries().count(), 1);
    }
}
