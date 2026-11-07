//! KODE-CFG-008 配置问答面:`get_final_config` / `get_entry_scripts` /
//! `get_database_schema` 三个 MCP 工具的纯逻辑实现(资产根读盘 + JSON 形)。
//!
//! 与既有面同源不复制:
//! - 解析/合并/telnet/dbInterface 语义全部在 kode-parser `resolve_config`
//!   (与 TS `$/kode/config/resolve` 消费通道、`derive_capabilities` 同一
//!   真源);引擎写死 telnet 端口数值表复用 kode-server `config_rpc` 的
//!   `ENGINE_TELNET_PORT_NUMBERS`(core 唯一真源,此处不另立常数)。
//! - 数据库 schema 推导复用 `AssetKnowledge::db_schema_preview`
//!   (kode-server `$/kode/databaseSchema/build` C-16 同源)。
//!
//! 边界:密码不回传值——MCP 客户端是外部 agent,遵守 CLONE-P5 立场
//! (derive 面同款):`dbInterface` 只给连接要素 + `passwordAvailable`
//! 标记,明文密码留空。读盘容错:单文件缺失如实记 `missing`,不 panic。

use std::path::Path;

use kode_parser::config::{resolve_config, ConfigNode, ENGINE_DEFAULT_TELNET_PORTS};
use kode_server::config_rpc::ENGINE_TELNET_PORT_NUMBERS;
use serde_json::{json, Map, Value};

use crate::kb::AssetKnowledge;

/// 元件配置定位:`{root}/res/server/kbengine.xml`(config_derive 同路径)。
fn custom_config_path(root: &Path) -> std::path::PathBuf {
    root.join("res").join("server").join("kbengine.xml")
}

/// 引擎 defaults 的一些资产树会把 `kbengine_defaults.xml` 拷进
/// `res/server/`;在则作为 defaults 侧参与合并,不在则如实 `null`
/// (telnet/dbInterface 逐叶回落引擎默认,merged 缺席不猜)。
fn defaults_config_path(root: &Path) -> std::path::PathBuf {
    root.join("res")
        .join("server")
        .join("kbengine_defaults.xml")
}

fn read_opt(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// ConfigNode → JSON(与 kode-server config_rpc `config_node_to_json` 同形:
/// sourceComments 空则省,TS 可选字段同形)。
fn config_node_to_json(node: &ConfigNode) -> Value {
    let children: Vec<Value> = node.children.iter().map(config_node_to_json).collect();
    let mut map = Map::new();
    map.insert("name".into(), Value::String(node.name.clone()));
    map.insert("text".into(), Value::String(node.text.clone()));
    map.insert("children".into(), Value::Array(children));
    if !node.source_comments.is_empty() {
        map.insert(
            "sourceComments".into(),
            Value::Array(
                node.source_comments
                    .iter()
                    .map(|c| Value::String(c.clone()))
                    .collect(),
            ),
        );
    }
    Value::Object(map)
}

/// f64 → JSON 数(整值落整数,与 config_rpc `json_number` 同口径)。
fn json_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9e15 {
        Value::Number(serde_json::Number::from(value as i64))
    } else {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// 引擎写死 telnet 端口表 → `{component: port}`(数值表 kode-server 真源)。
fn telnet_default_ports_json() -> Value {
    let mut map = Map::new();
    for component in ENGINE_DEFAULT_TELNET_PORTS.iter() {
        let port = ENGINE_TELNET_PORT_NUMBERS
            .iter()
            .find(|(name, _)| name == component)
            .map(|(_, port)| *port)
            .unwrap_or(0);
        map.insert((*component).to_string(), json!(port));
    }
    Value::Object(map)
}

/// dbmgr 数据库接口连接要素 → JSON(CLONE-P5 立场:密码不回传值)。
fn db_interface_json(db: &kode_parser::config::DatabaseInterfaceConfig) -> Value {
    json!({
        "host": db.host,
        "port": json_number(db.port),
        "username": db.username,
        "databaseName": db.database_name,
        "encrypt": db.encrypt,
        "characterSet": db.character_set,
        // 明文密码不给 MCP 客户端;encrypt=false 且配置非空时以标记代值。
        "password": Value::Null,
        "passwordAvailable": db.plain_password.is_some(),
    })
}

/// 文档序首个名匹配子树(DFS;与 kode-parser first_node 同语义,此处只读
/// 已解析树,不复制解析语义)。
fn first_node<'a>(node: &'a ConfigNode, name: &str) -> Option<&'a ConfigNode> {
    node.children
        .iter()
        .find(|child| child.name == name)
        .or_else(|| {
            node.children
                .iter()
                .find_map(|child| first_node(child, name))
        })
}

/// 叶子读值(trim 后非空)。
fn leaf_text(node: &ConfigNode, name: &str) -> Option<String> {
    first_node(node, name)
        .map(|child| child.text.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// 密码脱敏:树内任何名为 `password` 的节点值替换为占位符(MCP 客户端是
/// 外部 agent,CLONE-P5 立场全面收口——不只 dbInterface 字段,合成树里的
/// `<password>` 叶子同样不外泄;结构/源注释保留,消费端仍能看到「此处有
/// 密码配置」)。
fn redact_node(node: &ConfigNode) -> ConfigNode {
    let mut out = node.clone();
    if out.name == "password" && !out.text.trim().is_empty() {
        out.text = "[redacted]".to_string();
    }
    out.children = out.children.iter().map(redact_node).collect();
    out
}

/// `get_final_config`:解析元件配置(+可选同目录 defaults),一次出全
/// 合成树 / telnet 速览 / 引擎写死端口表 / 数据库连接要素。密码值全树
/// 脱敏(树内 `<password>` 叶子与 telnet 侧都以占位/布尔标记出面)。
pub fn final_config(root: &Path) -> Value {
    let custom_path = custom_config_path(root);
    let defaults_path = defaults_config_path(root);
    let custom_text = read_opt(&custom_path);
    let defaults_text = read_opt(&defaults_path);
    let resolved = resolve_config(defaults_text.as_deref(), custom_text.as_deref());
    let mut notes: Vec<String> = Vec::new();
    if custom_text.is_none() {
        notes.push(format!(
            "component config not found: {}",
            custom_path.display()
        ));
    }
    if defaults_text.is_none() {
        notes.push(
            "engine defaults xml not present under res/server/ (values below are \
             the component side only; engine default telnet ports come from the \
             built-in table)"
                .to_string(),
        );
    }
    json!({
        "configPath": custom_path.to_string_lossy(),
        "defaultsPath": if defaults_text.is_some() {
            Value::String(defaults_path.to_string_lossy().into_owned())
        } else {
            Value::Null
        },
        "customTree": resolved.custom_tree.as_ref().map(|t| config_node_to_json(&redact_node(t))),
        "merged": resolved.merged.as_ref().map(|t| config_node_to_json(&redact_node(t))),
        "telnetSummary": resolved.telnet_summary.iter().map(|e| json!({
            "component": e.component,
            "port": e.port.map(json_number),
            "passwordSet": e.password.is_some(),
        })).collect::<Vec<_>>(),
        "telnetDefaultPorts": telnet_default_ports_json(),
        "customTelnet": resolved.custom_telnet.as_ref().map(|t| json!({
            "port": t.port.map(json_number),
            "passwordSet": t.password.is_some(),
        })),
        "dbInterface": resolved.db_interface.as_ref().map(db_interface_json),
        "notes": notes,
    })
}

/// 组件 → `scripts/` 角色目录序列(官方 python_assets 模板口径;interface
/// 单复数两者都认,复数在前与 TS `INTERFACE_SCRIPT_FOLDERS` 同序)。
const COMPONENT_SCRIPT_DIRS: &[(&str, &[&str])] = &[
    ("baseapp", &["base"]),
    ("cellapp", &["cell"]),
    ("loginapp", &["login"]),
    ("dbmgr", &["db"]),
    ("interfaces", &["interfaces", "interface"]),
    ("logger", &["logger"]),
    ("bots", &["bots"]),
];

/// 入口脚本模块名的引擎默认值(entryScriptFile 缺省 = kbemain)。
const DEFAULT_ENTRY_MODULE: &str = "kbemain";

/// 从(合并缺省则元件侧)配置树读 `<{component}><entryScriptFile>` 覆盖值。
fn entry_module_override(tree: Option<&ConfigNode>, component: &str) -> Option<String> {
    let section = first_node(tree?, component)?;
    leaf_text(section, "entryScriptFile")
}

/// `get_entry_scripts`:每个服务端组件一条入口脚本事实(module / path /
/// exists)+ 共享引擎包装脚本一条(CFG-006 TS `findEngineEntryScript` 同
/// 约定:`scripts/kbengine.py`)。路径/存在性如实读盘,不预填不猜。
pub fn entry_scripts(root: &Path) -> Value {
    let custom_text = read_opt(&custom_config_path(root));
    let defaults_text = read_opt(&defaults_config_path(root));
    let resolved = resolve_config(defaults_text.as_deref(), custom_text.as_deref());
    // entryScriptFile 是引擎 defaults 键:合并树在则查合并,否则查元件侧。
    let tree = resolved.merged.as_ref().or(resolved.custom_tree.as_ref());

    let scripts_dir = root.join("scripts");
    let mut facts: Vec<Value> = COMPONENT_SCRIPT_DIRS
        .iter()
        .map(|(component, dirs)| {
            let module = entry_module_override(tree, component)
                .unwrap_or_else(|| DEFAULT_ENTRY_MODULE.to_string());
            // 目录序列:优先取实际含 `{module}.py` 的目录(interface 单复数
            // 两目录并存时以文件为准);都没有则回落第一个存在的目录,再
            // 回落首目录如实 exists:false(消费端拿「missing」诊断,同 TS
            // 派生立场)。
            let dir = dirs
                .iter()
                .find(|d| scripts_dir.join(d).join(format!("{module}.py")).is_file())
                .or_else(|| dirs.iter().find(|d| scripts_dir.join(d).is_dir()))
                .unwrap_or(&dirs[0]);
            let path = scripts_dir.join(dir).join(format!("{module}.py"));
            let exists = path.is_file();
            json!({
                "process": component,
                "module": module,
                "path": path.to_string_lossy(),
                "exists": exists,
            })
        })
        .collect();

    // 共享引擎入口包装脚本(debugpy 注入点;TS CFG-006 单一事实同款)。
    let wrapper = scripts_dir.join("kbengine.py");
    facts.push(json!({
        "process": "baseapp",
        "module": "kbengine",
        "path": wrapper.to_string_lossy(),
        "exists": wrapper.is_file(),
    }));

    json!({ "scriptsRoot": scripts_dir.to_string_lossy(), "entryScripts": facts })
}

/// `get_database_schema`:C-16 同源推导(kode-server databaseSchema/build)
/// 的 schema 问答面。返回每实体表集 + 表名索引 + def 源引用;entity 缺省 =
/// 全部实体。entity 未知名 → Err(与 db_schema_preview 同错面)。
pub fn database_schema(knowledge: &AssetKnowledge, entity: Option<&str>) -> Result<Value, String> {
    let preview = knowledge.db_schema_preview(entity)?;
    let mut table_index = Map::new();
    if let Some(tables) = preview.get("tables").and_then(Value::as_array) {
        for table in tables {
            if let Some(name) = table.get("name").and_then(Value::as_str) {
                table_index.insert(name.to_string(), table.clone());
            }
        }
    }
    let entities: Vec<String> = {
        let mut names: Vec<String> = knowledge
            .defs
            .iter()
            .filter(|(_, def)| def.category == "entity")
            .map(|(name, _)| name.clone())
            .collect();
        names.sort();
        names
    };
    Ok(json!({
        "entity": entity,
        "entities": entities,
        "tables": preview.get("tables").cloned().unwrap_or(Value::Array(vec![])),
        "tableIndex": Value::Object(table_index),
        "errors": preview.get("errors").cloned().unwrap_or(Value::Array(vec![])),
        "source": "defs via kode-server $/kode/databaseSchema/build (C-16 same source)",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_root() -> PathBuf {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop();
        p.pop();
        p.push("tests/fixtures/kbengine-demo-assets");
        p
    }

    #[test]
    fn final_config_reads_component_xml_and_reports_missing_defaults() {
        let payload = final_config(&fixture_root());
        // 元件配置在:dbmgr 段 + databaseInterfaces 读得到。
        assert!(payload["customTree"].is_object(), "custom tree parsed");
        assert!(payload["merged"].is_null(), "no defaults → merged 不猜");
        assert!(payload["defaultsPath"].is_null());
        // 引擎写死端口表:loginapp=31000 问答面。
        assert_eq!(payload["telnetDefaultPorts"]["loginapp"], 31000);
        assert_eq!(payload["telnetDefaultPorts"]["cellapp"], 50000);
        // notes 如实记录 defaults 缺席。
        let notes = payload["notes"].as_array().unwrap();
        assert!(notes
            .iter()
            .any(|n| n.as_str().unwrap().contains("defaults")));
    }

    #[test]
    fn final_config_on_empty_root_is_honest_not_panic() {
        let payload = final_config(Path::new("/definitely/not/a/root"));
        assert!(payload["customTree"].is_null());
        assert!(payload["merged"].is_null());
        assert_eq!(payload["telnetDefaultPorts"]["dbmgr"], 32000);
        let notes = payload["notes"].as_array().unwrap();
        assert!(notes
            .iter()
            .any(|n| n.as_str().unwrap().contains("component config not found")));
    }

    #[test]
    fn final_config_redacts_passwords_everywhere() {
        // 带 <password> 值的临时资产根:telnet_service 段 + databaseInterfaces。
        let root = std::env::temp_dir().join(format!("kode-mcp-redact-{}", std::process::id()));
        let conf = root.join("res").join("server");
        std::fs::create_dir_all(&conf).unwrap();
        std::fs::write(
            conf.join("kbengine.xml"),
            "<root>\n<telnet_service>\n<port> 32000 </port>\n<password> s3cret-telnet </password>\n\
             </telnet_service>\n<dbmgr>\n<databaseInterfaces>\n<default>\n<host> localhost </host>\n\
             <encrypt> false </encrypt>\n<password> s3cret-db </password>\n</default>\n\
             </databaseInterfaces>\n</dbmgr>\n</root>\n",
        )
        .unwrap();
        let payload = final_config(&root);
        let text = payload.to_string();
        assert!(
            !text.contains("s3cret-telnet"),
            "telnet password leaked: {text}"
        );
        assert!(!text.contains("s3cret-db"), "db password leaked: {text}");
        // 占位/布尔标记如实出面(结构不丢)。
        assert!(text.contains("[redacted]"));
        assert_eq!(payload["customTelnet"]["passwordSet"], true);
        assert_eq!(payload["customTelnet"]["port"], 32000);
        // db 侧:无 defaults → merged 不猜 → dbInterface 缺席,但 db 密码在
        // customTree 内且已被脱敏(上面的 !contains 断言覆盖)。
        assert!(payload["dbInterface"].is_null());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn entry_scripts_reports_module_path_exists_per_component() {
        let payload = entry_scripts(&fixture_root());
        let facts = payload["entryScripts"].as_array().unwrap();
        let by_process: std::collections::BTreeMap<&str, &Value> = facts
            .iter()
            .map(|f| (f["process"].as_str().unwrap(), f))
            .collect();
        // baseapp → scripts/base/kbemain.py 存在(组件事实按 module 精确取,
        // 共享包装脚本同属 baseapp process,不能按 process 键去重)。
        let base = facts
            .iter()
            .find(|f| f["process"] == "baseapp" && f["module"] == "kbemain")
            .expect("baseapp component fact");
        assert_eq!(base["exists"], true);
        assert!(base["path"]
            .as_str()
            .unwrap()
            .ends_with("scripts/base/kbemain.py"));
        // interface 单复数回退:interfaces 目录无 kbemain.py → 落 interface/。
        let interfaces = by_process["interfaces"];
        assert!(interfaces["path"]
            .as_str()
            .unwrap()
            .ends_with("scripts/interface/kbemain.py"));
        assert_eq!(interfaces["exists"], true);
        // 共享引擎包装脚本:夹具无 scripts/kbengine.py → exists:false 如实。
        let wrapper_fact = facts
            .iter()
            .find(|f| f["module"] == "kbengine")
            .expect("wrapper fact present");
        assert_eq!(wrapper_fact["process"], "baseapp");
        assert_eq!(wrapper_fact["exists"], false);
        assert!(wrapper_fact["path"]
            .as_str()
            .unwrap()
            .ends_with("scripts/kbengine.py"));
    }
}
