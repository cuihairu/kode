//! user_type 三契约探测/收集 RPC 面(RUST-MIGRATION-AUDIT-006 B1 车道批 4):
//! `$/kode/python/userTypeContract`。注册表半(types.xml/alias.xml 解析、
//! impl 行定位、文件读取=definitionWorkspace 宿主绑定)留 TS;本面接收
//! TS 组装好的 {file, sources, statuses} 快照,探测核
//! kode_python::user_type_contract::impl_file_has_contract_method 从原文
//! 逐字探测(原始行正则,无词法掩码,与 TS 同判),收集核
//! collect_user_type_contract_missing 出缺方法记录;by_impl_file 聚合
//! (恒等路径比较 + `implLine ?? 1` 贴行)=TS collectUserTypeContractMissingByImplFile
//! 默认 pathResolve 口径逐字对齐。出参 {items, probes}:items=诊断项同构
//! (camelCase);probes=逐源探测面(probes 直验批 4 移植保真,生产不消费)。
//! 消息/工作区机械不出 Rust。

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{json, Map, Value};

use kode_python::user_type_contract::{
    collect_user_type_contract_missing, impl_file_has_contract_method,
    USER_TYPE_CONTRACT_METHODS,
};

use crate::rpc::RpcRegistry;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/python/userTypeContract", user_type_contract);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserTypeContractParams {
    /// 目标 impl 文件(TS 传入 document.uri.fsPath;恒等比较)
    file: String,
    /// impl 文件原文快照(键=implFile 路径;TS 读文件后下发)
    #[serde(default)]
    sources: HashMap<String, String>,
    /// 注册表快照(methods 不下发——探测在 Rust 从 sources 原文重做)
    #[serde(default)]
    statuses: Vec<ContractStatusIn>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContractStatusIn {
    name: String,
    #[serde(default)]
    implemented_by: Option<String>,
    #[serde(default)]
    impl_file: Option<String>,
    #[serde(default)]
    impl_line: Option<usize>,
}

fn user_type_contract(params: Value) -> Result<Value, String> {
    let params: UserTypeContractParams =
        serde_json::from_value(params).map_err(|err| err.to_string())?;
    let sources: HashMap<String, Vec<u16>> = params
        .sources
        .iter()
        .map(|(file, text)| (file.clone(), text.encode_utf16().collect()))
        .collect();
    // 探测面:逐源三方法(probes 对拍直验;生产 TS 不消费)
    let mut probes = Map::new();
    for (file, units) in &sources {
        let mut methods = Map::new();
        for method in USER_TYPE_CONTRACT_METHODS {
            methods.insert(
                method.to_string(),
                Value::Bool(impl_file_has_contract_method(units, method)),
            );
        }
        probes.insert(file.clone(), Value::Object(methods));
    }
    // 收集面:by_impl_file 聚合(恒等比较 + implLine ?? 1 贴行)
    let mut items = Vec::new();
    for status in &params.statuses {
        let Some(impl_file) = status.impl_file.as_deref().filter(|f| !f.is_empty()) else {
            continue;
        };
        if impl_file != params.file {
            continue;
        }
        let source = sources
            .get(impl_file)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let mut methods = [false; 3];
        for (idx, method) in USER_TYPE_CONTRACT_METHODS.iter().enumerate() {
            methods[idx] = impl_file_has_contract_method(source, method);
        }
        let line = status.impl_line.unwrap_or(1);
        for item in collect_user_type_contract_missing(
            &status.name,
            status.implemented_by.as_deref(),
            Some(impl_file),
            &methods,
        ) {
            items.push(json!({
                "message": item.message,
                "method": item.method,
                "typeName": item.type_name,
                "symbolName": item.symbol_name,
                "symbolLength": item.symbol_length,
                "line": line,
                "related": {
                    "targetFile": item.related_target_file,
                    "label": item.related_label,
                },
            }));
        }
    }
    Ok(json!({ "items": items, "probes": Value::Object(probes) }))
}

// ---- 单测 -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn run(params: Value) -> Value {
        user_type_contract(params).unwrap()
    }

    fn status(name: &str, impl_file: Option<&str>, impl_line: Option<usize>) -> Value {
        let mut base = json!({ "name": name });
        if let Some(file) = impl_file {
            base["implFile"] = json!(file);
        }
        if let Some(line) = impl_line {
            base["implLine"] = json!(line);
        }
        base
    }

    #[test]
    fn missing_one_method_item_shape() {
        let source = "class Impl:\n    def createObjFromDict(self, d):\n        return d\n    def getDictFromObj(self, o):\n        return {}\n";
        let out = run(json!({
            "file": "/w/impl.py",
            "sources": {"/w/impl.py": source},
            "statuses": [{
                "name": "TalentTree",
                "implementedBy": "talent.Impl",
                "implFile": "/w/impl.py",
                "implLine": 4,
            }],
        }));
        let items = out["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["method"], json!("isSameType"));
        assert_eq!(items[0]["typeName"], json!("TalentTree"));
        assert_eq!(items[0]["symbolName"], json!("Impl"));
        assert_eq!(items[0]["symbolLength"], json!(4));
        assert_eq!(items[0]["line"], json!(4));
        assert_eq!(items[0]["related"]["targetFile"], json!("/w/impl.py"));
        assert_eq!(items[0]["related"]["label"], json!("实现文件 impl.py"));
        assert_eq!(
            items[0]["message"],
            json!("user_type TalentTree 的实现 talent.Impl 缺契约方法 isSameType():类型判定失效(createObjFromDict 结果无法通过校验)——引擎 setImplModule 取不到该方法,装载实现模块必失败")
        );
    }

    #[test]
    fn all_present_zero_items_and_probes_face() {
        let source = "def createObjFromDict(self):\n    pass\ndef getDictFromObj(self):\n    pass\ndef isSameType(self):\n    pass\n";
        let out = run(json!({
            "file": "/w/impl.py",
            "sources": {"/w/impl.py": source},
            "statuses": [status("T", Some("/w/impl.py"), Some(1))],
        }));
        assert_eq!(out["items"].as_array().unwrap().len(), 0);
        let probes = out["probes"].as_object().unwrap();
        let methods = probes["/w/impl.py"].as_object().unwrap();
        assert_eq!(methods.len(), 3);
        assert_eq!(methods["createObjFromDict"], json!(true));
        assert_eq!(methods["getDictFromObj"], json!(true));
        assert_eq!(methods["isSameType"], json!(true));
    }

    #[test]
    fn file_filter_and_silent_empty_impl_file() {
        let out = run(json!({
            "file": "/w/impl.py",
            "sources": {"/w/impl.py": "", "/w/other.py": ""},
            "statuses": [
                status("Bound", Some("/w/impl.py"), Some(2)),
                status("Elsewhere", Some("/w/other.py"), Some(1)),
                status("NoFile", None, None),
            ],
        }));
        let items = out["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        for item in items {
            assert_eq!(item["typeName"], json!("Bound"));
        }
    }

    #[test]
    fn impl_line_defaults_to_one() {
        let out = run(json!({
            "file": "/w/impl.py",
            "sources": {"/w/impl.py": ""},
            "statuses": [status("T", Some("/w/impl.py"), None)],
        }));
        assert_eq!(out["items"][0]["line"], json!(1));
    }

    #[test]
    fn source_missing_from_map_probes_all_false() {
        // TS 组装恒下发全量 sources;防御形态=缺失按空源探测(全 false)
        let out = run(json!({
            "file": "/w/impl.py",
            "sources": {},
            "statuses": [status("T", Some("/w/impl.py"), Some(1))],
        }));
        assert_eq!(out["items"].as_array().unwrap().len(), 3);
        assert!(out["probes"].as_object().unwrap().is_empty());
    }

    #[test]
    fn empty_statuses_zero_items() {
        let out = run(json!({ "file": "/w/impl.py", "sources": {}, "statuses": [] }));
        assert_eq!(out["items"].as_array().unwrap().len(), 0);
        assert_eq!(out["probes"].as_object().unwrap().len(), 0);
    }

    #[test]
    fn missing_file_param_is_error() {
        assert!(user_type_contract(json!({ "sources": {} })).is_err());
    }
}
