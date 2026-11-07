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

/// 沿点分路径走到目标节点(跳过 `<root>`/`<defaults>` 文档元素包裹段,
/// 目录键都是去掉包裹段后的相对路径)。段未命中 → None。
fn node_at<'a>(tree: Option<&'a ConfigNode>, key: &str) -> Option<&'a ConfigNode> {
    let mut current = tree?;
    if current.name.is_empty() && current.children.len() == 1 {
        current = &current.children[0];
    }
    for segment in key.split('.') {
        if segment.is_empty() {
            continue;
        }
        current = current.children.iter().find(|c| c.name == segment)?;
    }
    Some(current)
}

/// 节点 → 值形:叶子取 trim 后文本;容器如实列子键名;空节点 → null。
fn node_value(node: &ConfigNode) -> Value {
    let text = node.text.trim();
    if !text.is_empty() {
        return Value::String(text.to_string());
    }
    if node.children.is_empty() {
        return Value::Null;
    }
    let names: Vec<&str> = node.children.iter().map(|c| c.name.as_str()).collect();
    Value::String(format!(
        "section with {} child key(s): {}",
        node.children.len(),
        names.join(", ")
    ))
}

/// `why_setting`:对给定配置键答「值 + 中英含义 + file:line 出处」。
///
/// 值 = resolve_config 生效树(合并缺省则元件侧)沿点分路径的叶子值;
/// 中英含义 + 出处 = 引擎 defaults 文案库(serverConfigCatalog,经
/// config_catalog 快照)curated 条目;出处是权威 file:line(如
/// `kbe/res/server/kbengine_defaults.xml:618`),另附解析树该节点的
/// sourceComments(原始双语注释)作交叉佐证。键不在文案库 → found:false
/// 如实(值仍解析,含义/出处留空,不虚构)。键在树但非叶子 → 值列子键名。
pub fn why_setting(root: &Path, key: &str) -> Result<Value, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("empty config key".to_string());
    }
    let custom_path = custom_config_path(root);
    let defaults_path = defaults_config_path(root);
    let custom_text = read_opt(&custom_path);
    let defaults_text = read_opt(&defaults_path);
    let resolved = resolve_config(defaults_text.as_deref(), custom_text.as_deref());
    let tree = resolved.merged.as_ref().or(resolved.custom_tree.as_ref());
    let node = node_at(tree, key);

    let doc = crate::config_catalog::find_doc(key);
    let mut out = Map::new();
    out.insert("key".into(), Value::String(key.to_string()));
    out.insert("value".into(), node.map(node_value).unwrap_or(Value::Null));
    out.insert(
        "sourceComments".into(),
        Value::Array(
            node.map(|n| n.source_comments.iter().map(|c| Value::String(c.clone())).collect())
                .unwrap_or_default(),
        ),
    );
    match doc {
        Some(d) => {
            out.insert("found".into(), json!(true));
            out.insert("meaningZh".into(), Value::String(d.zh.to_string()));
            out.insert("meaningEn".into(), Value::String(d.en.to_string()));
            out.insert("origin".into(), Value::String(d.source.to_string()));
            out.insert("group".into(), Value::String(d.group.to_string()));
        }
        None => {
            out.insert("found".into(), json!(false));
            out.insert("meaningZh".into(), Value::Null);
            out.insert("meaningEn".into(), Value::Null);
            out.insert("origin".into(), Value::Null);
            out.insert("group".into(), Value::Null);
        }
    }
    out.insert(
        "configPath".into(),
        Value::String(custom_path.to_string_lossy().into_owned()),
    );
    out.insert(
        "defaultsPath".into(),
        if defaults_text.is_some() {
            Value::String(defaults_path.to_string_lossy().into_owned())
        } else {
            Value::Null
        },
    );
    Ok(Value::Object(out))
}

/// `list_config_settings`:引擎 defaults 文案库全量条目(每配置项的中英
/// 含义 + 权威 file:line 出处 + 分组),可选按 group / 前缀过滤;每项附
/// 生效值(resolve_config 生效树解析,缺省值 null)。答「XML 配置每个选项
/// 的含义」。group 未知名 → 空集如实(附可用分组),不报错。
pub fn list_config_settings(root: &Path, group: Option<&str>, prefix: Option<&str>) -> Value {
    let custom_path = custom_config_path(root);
    let defaults_path = defaults_config_path(root);
    let custom_text = read_opt(&custom_path);
    let defaults_text = read_opt(&defaults_path);
    let resolved = resolve_config(defaults_text.as_deref(), custom_text.as_deref());
    let tree = resolved.merged.as_ref().or(resolved.custom_tree.as_ref());

    let mut group_counts: Map<String, Value> = Map::new();
    let mut settings: Vec<Value> = Vec::new();
    for (key, doc) in crate::config_catalog::SERVER_CONFIG_ITEM_DOCS {
        *group_counts
            .entry(doc.group.to_string())
            .or_insert_with(|| json!(0)) = {
            let n = group_counts.get(doc.group).and_then(Value::as_u64).unwrap_or(0) + 1;
            json!(n)
        };
        if let Some(g) = group {
            if doc.group != g {
                continue;
            }
        }
        if let Some(p) = prefix {
            if !key.starts_with(p) {
                continue;
            }
        }
        settings.push(json!({
            "key": key,
            "value": node_at(tree, key).map(node_value).unwrap_or(Value::Null),
            "meaningZh": doc.zh,
            "meaningEn": doc.en,
            "origin": doc.source,
            "group": doc.group,
        }));
    }
    json!({
        "count": settings.len(),
        "groupCounts": Value::Object(group_counts),
        "filter": json!({
            "group": group,
            "prefix": prefix,
        }),
        "settings": settings,
    })
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

    fn write_config(root: &Path, name: &str, text: &str) {
        let conf = root.join("res").join("server");
        std::fs::create_dir_all(&conf).unwrap();
        std::fs::write(conf.join(name), text).unwrap();
    }

    #[test]
    fn json_number_keeps_fraction_and_rejects_non_finite() {
        // 整值落整数;分数保浮点;NaN/Inf → null(绝不虚构数)。
        assert_eq!(json_number(3306.0), serde_json::json!(3306));
        assert_eq!(json_number(1.5), serde_json::json!(1.5));
        assert_eq!(json_number(f64::NAN), Value::Null);
        assert_eq!(json_number(f64::INFINITY), Value::Null);
    }

    #[test]
    fn final_config_merges_defaults_and_exposes_db_interface() {
        // defaults + 元件合并 → dbInterface 出面(密码不给值,只给可用标记)。
        let root = std::env::temp_dir().join(format!("kode-mcp-dbi-{}", std::process::id()));
        write_config(
            &root,
            "kbengine_defaults.xml",
            "<root>\n<dbmgr>\n<databaseInterfaces>\n<default>\n<host> 10.0.0.5 </host>\n\
             <port> 3307 </port>\n<auth>\n<username> kbe_user </username>\n\
             <encrypt> false </encrypt>\n<password> db-pass </password>\n</auth>\n\
             <unicodeString>\n<characterSet> utf8mb4 </characterSet>\n</unicodeString>\n\
             <databaseName> kbe_db </databaseName>\n</default>\n\
             </databaseInterfaces>\n</dbmgr>\n</root>\n",
        );
        write_config(&root, "kbengine.xml", "<root>\n<baseapp>\n<backupPeriod> 500 </backupPeriod>\n</baseapp>\n</root>\n");
        let payload = final_config(&root);
        // defaultsPath 有 defaults → 字符串(非 null)。
        assert!(payload["defaultsPath"].as_str().unwrap().ends_with("kbengine_defaults.xml"));
        let db = payload["dbInterface"].as_object().expect("dbInterface");
        assert_eq!(db["host"], "10.0.0.5");
        assert_eq!(db["port"], 3307);
        assert_eq!(db["username"], "kbe_user");
        assert_eq!(db["databaseName"], "kbe_db");
        assert_eq!(db["encrypt"], false);
        assert_eq!(db["characterSet"], "utf8mb4");
        // 密码永远不给值:标记可用即可。
        assert_eq!(db["password"], Value::Null);
        assert_eq!(db["passwordAvailable"], true);
        assert!(!payload.to_string().contains("db-pass"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn why_setting_reports_defaults_path_and_skips_empty_segments() {
        // 点分键含空段(baseapp..backupPeriod):空段跳过,值照常解析;
        // defaults 在 → defaultsPath 字符串。
        let root = std::env::temp_dir().join(format!("kode-mcp-why-{}", std::process::id()));
        write_config(&root, "kbengine.xml", "<root>\n<baseapp>\n<backupPeriod> 500 </backupPeriod>\n</baseapp>\n</root>\n");
        write_config(&root, "kbengine_defaults.xml", "<root>\n<cellapp>\n<distanceField> x </distanceField>\n</cellapp>\n</root>\n");
        let out = why_setting(&root, "baseapp..backupPeriod").expect("answer");
        assert_eq!(out["value"], "500");
        assert!(out["defaultsPath"].as_str().unwrap().ends_with("kbengine_defaults.xml"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn database_schema_builds_table_index() {
        let k = crate::kb::AssetKnowledge::load(&fixture_root());
        let out = crate::config_qa::database_schema(&k, Some("Avatar")).expect("schema");
        // 表名索引:Avatar 持久属性 → 至少一张表按名入索引。
        let index = out["tableIndex"].as_object().expect("tableIndex");
        assert!(!index.is_empty(), "expected indexed tables for Avatar");
        let entity = out["entity"].as_str().unwrap();
        assert_eq!(entity, "Avatar");
        // 未知名 → Err(与 db_schema_preview 同错面)。
        assert!(crate::config_qa::database_schema(&k, Some("NoSuch")).is_err());
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

    #[test]
    fn why_setting_answers_value_meaning_and_origin() {
        let payload = why_setting(&fixture_root(), "dbmgr.account_system.account_registration.enable")
            .expect("answer");
        // 值来自元件侧(无 defaults → 合并不猜,取 custom_tree)。
        assert_eq!(payload["value"], "true");
        // 中英含义来自文案库(curated)。
        assert_eq!(payload["found"], true);
        assert!(payload["meaningZh"]
            .as_str()
            .unwrap()
            .contains("开放注册"));
        assert!(payload["meaningEn"].as_str().unwrap().contains("registration"));
        // 出处 = 权威 file:line(文案库 source)。
        assert!(payload["origin"]
            .as_str()
            .unwrap()
            .contains("kbengine_defaults.xml"));
        assert_eq!(payload["group"], "account");
        // 解析树该节点原始双语注释作交叉佐证。
        let comments = payload["sourceComments"].as_array().unwrap();
        assert!(!comments.is_empty(), "fixture node carries its inline comment");
    }

    #[test]
    fn why_setting_unknown_key_is_found_false_not_error() {
        let payload = why_setting(&fixture_root(), "no.such.key").expect("graceful");
        assert_eq!(payload["found"], false);
        assert!(payload["meaningZh"].is_null());
        assert!(payload["origin"].is_null());
        assert!(payload["value"].is_null());
    }

    #[test]
    fn why_setting_empty_key_is_error() {
        assert!(why_setting(&fixture_root(), "  ").is_err());
    }

    #[test]
    fn why_setting_catalog_key_absent_in_tree_is_honest_null_value() {
        // baseapp.archivePeriod 在文案库但元件侧未配置(无 defaults 不猜)。
        let payload = why_setting(&fixture_root(), "baseapp.archivePeriod").expect("answer");
        assert_eq!(payload["found"], true);
        assert!(payload["meaningZh"].as_str().unwrap().contains("存档"));
        assert!(payload["value"].is_null());
    }

    #[test]
    fn why_setting_section_key_lists_children() {
        // dbmgr.account_system 是容器段 → 值如实列子键名。
        let payload = why_setting(&fixture_root(), "dbmgr.account_system").expect("answer");
        assert_eq!(payload["found"], true);
        let value = payload["value"].as_str().unwrap();
        assert!(value.starts_with("section with"));
        assert!(value.contains("account_registration"));
    }

    #[test]
    fn list_config_settings_enumerates_catalog_with_values() {
        let payload = list_config_settings(&fixture_root(), None, None);
        let settings = payload["settings"].as_array().unwrap();
        assert!(settings.len() > 200, "full catalog enumerated");
        // 每项都有中英含义 + 出处 + 分组。
        for s in settings.iter().take(50) {
            assert!(s["meaningZh"].as_str().unwrap().len() > 0);
            assert!(s["meaningEn"].as_str().unwrap().len() > 0);
            assert!(s["origin"].as_str().unwrap().contains("kbe/"));
            assert!(s["group"].as_str().unwrap().len() > 0);
        }
        // 元件侧配置的键附真实生效值(其余为 null,不虚构)。
        let reg = settings
            .iter()
            .find(|s| s["key"] == "dbmgr.account_system.account_registration.enable")
            .expect("registration key present");
        assert_eq!(reg["value"], "true");
        let absent = settings
            .iter()
            .find(|s| s["key"] == "baseapp.archivePeriod")
            .expect("archive key present");
        assert!(absent["value"].is_null());
        // groupCounts 覆盖全部组。
        assert!(payload["groupCounts"]["account"].as_u64().unwrap() > 0);
        assert_eq!(payload["count"].as_u64().unwrap() as usize, settings.len());
    }

    #[test]
    fn list_config_settings_filters_by_group_and_prefix() {
        let group = list_config_settings(&fixture_root(), Some("backup"), None);
        let gs = group["settings"].as_array().unwrap();
        assert!(!gs.is_empty(), "backup group non-empty");
        assert!(gs.iter().all(|s| s["group"] == "backup"));

        let prefix = list_config_settings(&fixture_root(), None, Some("baseapp."));
        let ps = prefix["settings"].as_array().unwrap();
        assert!(!ps.is_empty());
        assert!(ps.iter().all(|s| s["key"].as_str().unwrap().starts_with("baseapp.")));

        // 未知名组 → 空集如实,不报错。
        let none = list_config_settings(&fixture_root(), Some("no-such-group"), None);
        assert_eq!(none["count"], 0);
        assert!(none["settings"].as_array().unwrap().is_empty());
    }
}
