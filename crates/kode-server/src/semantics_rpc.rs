//! 语义引擎 RPC 接线(KSEM-CELL-04 键补全面):把 [`crate::semantics`] 的
//! 纯库查询接到 `$/kode/rpc` 注册表(无状态 handler:TS 每请求供 def 宇宙,
//! 与 `$/kode/lint/analyzeDef` 同口径——def 数据流 TS→Rust 按请求供给,
//! 引擎不扫盘不缓存)。消费边界协议见 [`crate::semantics::query`]。
//!
//! `$/kode/semantics/cellDataKeys` {entity, defs:[{name,text}]} →
//! {entity, status, keys:[{key,kind,typeLabel,sourceFile,sourceLine}]}:
//! - entity 不可解析(defs 里没有该实体)→ keys 空,不造;
//! - defs 不含父/接口/组件类型 → 对应贡献缺席(诚实,TS 负责闭包完整性);
//! - 脚本宇宙未供 → status=script-unknown(键集与脚本面无关)。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rpc::RpcRegistry;
use crate::semantics::cell::CellDataShape;
use crate::semantics::store::{Build, ProjectDefResolver, SnapshotStore};
use kode_types::TypeGraph;
use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::uri::CanonicalUri;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/semantics/cellDataKeys", handle_cell_data_keys);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CellDataKeysParams {
    entity: String,
    #[serde(default)]
    defs: Vec<DefSource>,
}

#[derive(Deserialize)]
struct DefSource {
    name: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CellDataKeysResponse {
    entity: String,
    status: &'static str,
    keys: Vec<crate::semantics::cell::CellDataKeyView>,
}

fn handle_cell_data_keys(params: Value) -> Result<Value, String> {
    let p: CellDataKeysParams = serde_json::from_value(params)
        .map_err(|e| format!("bad params: {e}"))?;
    let root = RootId(0);
    let mut defs = SnapshotStore::new();
    for (i, d) in p.defs.iter().enumerate() {
        let key = DocumentKey::new(root, CanonicalUri::from_path(&format!("/defs/{}.def", d.name)));
        defs.commit(Build::new(key, (i + 1) as i64, kode_parser::parse_def(&d.text)));
    }
    let resolver = ProjectDefResolver::new(&defs);
    let Some(own) = crate::semantics::snapshot::DefResolver::resolve(&resolver, &p.entity) else {
        // 实体 def 不在供给宇宙:keys 空,不造(响应级状态,非 CellDataStatus)。
        return serde_json::to_value(CellDataKeysResponse {
            entity: p.entity,
            status: "entity-missing",
            keys: Vec::new(),
        })
        .map_err(|e| format!("encode: {e}"));
    };
    let g = TypeGraph::new();
    let shape = CellDataShape::build(own, &resolver, &g, root, &p.entity, None);
    serde_json::to_value(CellDataKeysResponse {
        entity: p.entity,
        status: shape.status.as_str(),
        keys: shape.key_views(),
    })
    .map_err(|e| format!("encode: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_include_all_three_faces() {
        let params = json!({
            "entity": "Avatar",
            "defs": [
                {"name": "Avatar", "text": "<root><Properties><hp><Type>UINT16</Type><Flags>CELL_PUBLIC</Flags></hp></Properties><Components><weapon><Type>Weapon</Type></weapon></Components></root>"},
                {"name": "Weapon", "text": "<root><Properties><ammo><Type>UINT32</Type><Flags>CELL_PRIVATE</Flags></ammo><skin><Type>STRING</Type><Flags>BASE</Flags></skin></Properties></root>"}
            ]
        });
        let v = handle_cell_data_keys(params).unwrap();
        let keys = v["keys"].as_array().unwrap();
        let kinds: Vec<(&str, &str)> = keys
            .iter()
            .map(|k| (k["key"].as_str().unwrap(), k["kind"]["kind"].as_str().unwrap()))
            .collect();
        assert!(kinds.contains(&("hp", "defField")), "def 字段面: {kinds:?}");
        assert!(kinds.contains(&("position", "builtin")), "内建键面: {kinds:?}");
        assert!(kinds.contains(&("weapon", "componentSlot")), "组件槽面: {kinds:?}");
        // 组件槽类型标签 = 组件类型名。
        let weapon = keys.iter().find(|k| k["key"] == "weapon").unwrap();
        assert_eq!(weapon["typeLabel"], "Weapon");
    }

    #[test]
    fn component_slot_excludes_non_cell_fields() {
        let params = json!({
            "entity": "Avatar",
            "defs": [
                {"name": "Avatar", "text": "<root><Components><weapon><Type>Weapon</Type></weapon></Components></root>"},
                {"name": "Weapon", "text": "<root><Properties><ammo><Type>UINT32</Type><Flags>CELL_PRIVATE</Flags></ammo><skin><Type>STRING</Type><Flags>BASE</Flags></skin></Properties></root>"}
            ]
        });
        // 组件槽下字段不在顶层键宇宙(嵌套面),顶层只有槽名。
        let v = handle_cell_data_keys(params).unwrap();
        let keys: Vec<&str> = v["keys"].as_array().unwrap().iter().map(|k| k["key"].as_str().unwrap()).collect();
        assert_eq!(keys, ["position", "direction", "weapon"], "顶层=内建键+槽;组件字段在嵌套面");
    }

    #[test]
    fn entity_missing_keys_empty_no_fabrication() {
        let params = json!({"entity": "Ghost", "defs": []});
        let v = handle_cell_data_keys(params).unwrap();
        assert_eq!(v["keys"].as_array().unwrap().len(), 0);
        assert_eq!(v["status"], "entity-missing", "实体不在宇宙 → 响应级状态,不冒充无部件");
    }

    #[test]
    fn malformed_params_is_error_not_panic() {
        assert!(handle_cell_data_keys(json!({"defs": "nope"})).is_err());
        assert!(handle_cell_data_keys(json!(null)).is_err());
    }
}
