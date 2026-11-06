//! KODE-CFG-005:配置派生 RPC 面(`$/kode/config/derive`)。
//!
//! 消费端(TS `src/configDerive.ts` → `src/scanRoots.ts`)经**命令级**
//! `gate.runInRust('$/kode/config/derive')` 取 CFG-004 推导出的派生能力
//! (def 扫描根/入口脚本/telnet/调试就绪)。与 serving 面开关**正交**:
//! 不动 `serveFromRust`(恒 false)、不动 `kbengine.core.backend`,不依赖
//! shadow 模式——params 由 TS 直传(已从盘上解析:配置路径/工作区根/入口
//! 脚本存在性;树可选:def 扫描根只需路径事实,telnet/debug 面才需合成树)。
//!
//! 单一真源在 Rust core(TS 不复制推导逻辑);Err = 输入形态非法,TS 按
//! 不可用回退旧 workspace∪assetsRoot 链(不杀 server,不视为断言失败)。

use serde_json::{json, Map, Value};

use kode_parser::config::ConfigNode;
use kode_parser::config_derive::{
    derive_capabilities, DeriveCapabilities, DeriveFacts, EntryScriptFact,
};

use crate::rpc::RpcRegistry;

/// 注册 `$/kode/config/derive`;由 `ServerState::new()` 加一行调用。
pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/config/derive", derive_handler);
}

/// handler:params = `{ tree?, defaultsTree?, facts }` → `{ derive, diagnostics }`。
fn derive_handler(params: Value) -> Result<Value, String> {
    let custom_tree = config_node_from_json(params.get("tree"))?;
    let defaults_tree = config_node_from_json(params.get("defaultsTree"))?;
    let owned = facts_from_json(params.get("facts"))?;
    let facts = DeriveFacts {
        workspace_root: owned.workspace_root.as_deref(),
        custom_config_path: owned.custom_config_path.as_deref(),
        entry_scripts: owned.entry_scripts,
    };
    let caps = derive_capabilities(custom_tree.as_ref(), defaults_tree.as_ref(), &facts);
    let diagnostics = diagnostics_to_json(&caps);
    Ok(json!({ "derive": derive_to_json(&caps), "diagnostics": diagnostics }))
}

/// 反序列化一个配置树节点(镜像 TS `ConfigXmlNode`:`name/text/children/
/// sourceComments`)。`null`/缺省 → `None`(该面无树,如 def 扫描根只依赖
/// 路径事实);非对象 → Err(形态非法,TS 回退)。kode-parser 是零第三方
/// crate,不能 serde 派生,故在此手工逐字段转。
fn config_node_from_json(v: Option<&Value>) -> Result<Option<ConfigNode>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(map)) => Ok(Some(node_from_map(map)?)),
        Some(other) => Err(format!(
            "tree/defaultsTree 应为对象,得到 {}",
            kind_of(other)
        )),
    }
}

fn node_from_map(map: &Map<String, Value>) -> Result<ConfigNode, String> {
    let name = map
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let text = map
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let children = match map.get("children") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Object(child) => node_from_map(child),
                other => Err(format!("children 项应为对象,得到 {}", kind_of(other))),
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(other) => return Err(format!("children 应为数组,得到 {}", kind_of(other))),
    };
    let source_comments = match map.get("sourceComments") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "sourceComments 项应为字符串".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(other) => return Err(format!("sourceComments 应为数组,得到 {}", kind_of(other))),
    };
    Ok(ConfigNode {
        name,
        text,
        children,
        source_comments,
    })
}

/// 派生事实(拥有所有格;构造 `DeriveFacts` 时借用)。
struct OwnedFacts {
    workspace_root: Option<String>,
    custom_config_path: Option<String>,
    entry_scripts: Vec<EntryScriptFact>,
}

fn facts_from_json(v: Option<&Value>) -> Result<OwnedFacts, String> {
    let map = match v {
        None | Some(Value::Null) => return Ok(OwnedFacts::empty()),
        Some(Value::Object(map)) => map,
        Some(other) => return Err(format!("facts 应为对象,得到 {}", kind_of(other))),
    };
    let workspace_root = map
        .get("workspaceRoot")
        .and_then(Value::as_str)
        .map(str::to_string);
    let custom_config_path = map
        .get("customConfigPath")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut entry_scripts = Vec::new();
    if let Some(Value::Array(items)) = map.get("entryScripts") {
        for item in items {
            let obj = item
                .as_object()
                .ok_or_else(|| "entryScripts 项应为对象".to_string())?;
            let process = obj
                .get("process")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let module = obj
                .get("module")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let path = obj.get("path").and_then(Value::as_str).map(str::to_string);
            let exists = obj.get("exists").and_then(Value::as_bool).unwrap_or(false);
            entry_scripts.push(EntryScriptFact {
                process,
                module,
                path,
                exists,
            });
        }
    }
    Ok(OwnedFacts {
        workspace_root,
        custom_config_path,
        entry_scripts,
    })
}

impl OwnedFacts {
    fn empty() -> Self {
        OwnedFacts {
            workspace_root: None,
            custom_config_path: None,
            entry_scripts: Vec::new(),
        }
    }
}

/// 派生能力 → JSON(camelCase,消费端 TS 直读)。
fn derive_to_json(caps: &DeriveCapabilities) -> Value {
    json!({
        "defScanRoots": {
            "roots": caps.def_scan_roots.roots,
            "fallback": caps.def_scan_roots.fallback,
            "degraded": caps.def_scan_roots.degraded,
        },
        "telnet": {
            "enabled": caps.telnet.enabled,
            "endpoints": caps.telnet.endpoints.iter().map(|e| json!({
                "component": e.component,
                "host": e.host,
                "port": e.port,
                "passwordSet": e.password_set,
            })).collect::<Vec<_>>(),
        },
        "entryScripts": caps.entry_scripts.iter().map(|s| json!({
            "process": s.process,
            "module": s.module,
            "path": s.path,
            "exists": s.exists,
        })).collect::<Vec<_>>(),
        "debug": {
            "ready": caps.debug.ready,
            "reasons": caps.debug.reasons,
        },
    })
}

/// 派生诊断(reasons 由 CFG-004 产出,英文机器面文案;此处补 scope 与 severity)。
fn diagnostics_to_json(caps: &DeriveCapabilities) -> Vec<Value> {
    let mut out = Vec::new();
    if caps.def_scan_roots.degraded {
        out.push(json!({
            "scope": "defScanRoots",
            "severity": "warning",
            "message": "def scan root degraded: workspace root fallback",
        }));
    }
    if !caps.debug.ready {
        out.push(json!({
            "scope": "debug",
            "severity": "warning",
            "message": format!("debug not ready: {}", caps.debug.reasons.join("; ")),
        }));
    }
    out
}

/// JSON 值种类名(诊断/错误文案用)。
fn kind_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
