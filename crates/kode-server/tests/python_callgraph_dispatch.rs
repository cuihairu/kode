//! `$/kode/python/callgraph` + `$/kode/python/symbols` 全链派发测(C-20 交付②)。
//!
//! 走完整 `$/kode/rpc` → 两条 RPC 链路,验证注册成功、输入契约与输出形状:
//! - callgraph:8 类边全形状、跨文件反索引、语法容错、空文件契约、进程角色;
//! - symbols:每文件符号表形状 + 每方法自身调用(含调用点列)。

use serde_json::{json, Value};

use kode_protocol::{IncomingMessage, Request, RequestId};
use kode_server::{handle_message, Outgoing, ServerState};

fn request(id: i64, method: &str, params: Value) -> IncomingMessage {
    IncomingMessage::Request(Request {
        jsonrpc: "2.0".into(),
        id: RequestId::Number(id),
        method: method.into(),
        params: Some(params),
    })
}

fn response_of(out: &[Outgoing]) -> &Value {
    match &out[0] {
        Outgoing::Response(response) => response.result.as_ref().unwrap(),
        Outgoing::Notification(_) => panic!("expected response"),
    }
}

fn rpc(method: &str, params: Value) -> Value {
    let mut state = ServerState::new();
    handle_message(
        &mut state,
        request(0, "initialize", json!({"capabilities": {}})),
    );
    let out = handle_message(
        &mut state,
        request(1, "$/kode/rpc", json!({"method": method, "params": params})),
    );
    response_of(&out).clone()
}

/// 覆盖全部 8 类边(kbe-* 特化 / local / method / self-method / unknown)。
const KB_ENTITY: &str = r#"import KBEngine
import math

def helper(x):
    return x

def standalone():
    pass

class Avatar(KBEngine.Entity):
    def act(self):
        self.notify()                 # self-method
        self.allClients.onDamage(1)   # kbe-broadcast
        self.baseClients.onSyncHp(2)  # kbe-base-clients
        self.cell.recalc()            # kbe-cross-process (base→cell)
        self.base.reportHp(3)         # kbe-cross-process (cell→base)
        self.tool.use()               # method (self.tool.x → Method)
        KBEngine.log("x")             # kbe-api
        helper(4)                     # local (module-level function)
        other_obj.run()               # method (obj.run → Method)
        undefined_func()              # unknown (bare, not module fn/import)
        math.sqrt(16)                 # method (mod.func → Method)

    def notify(self):
        pass

top_level_call()                      # module top-level → module node
"#;

const MANIFEST: &str = r#"<processTopology>
  <process name="cell_1" role="cellapp"><port>20015</port></process>
  <process name="base_1" role="baseapp"><port>20005</port></process>
  <process name="db_1" role="dbmgr"><port>20000</port></process>
</processTopology>"#;

fn callgraph(params: Value) -> Value {
    rpc("$/kode/python/callgraph", params)
}

fn symbols(params: Value) -> Value {
    rpc("$/kode/python/symbols", params)
}

#[test]
fn callgraph_full_shape_and_all_kinds() {
    let result = callgraph(json!({
        "files": [{"path": "/scripts/cell/Avatar.py", "text": KB_ENTITY}],
        "manifestXmlText": MANIFEST,
    }));

    let nodes = result.get("nodes").unwrap().as_array().unwrap();
    // 方法节点 Avatar.act / Avatar.notify,模块级函数 helper / standalone,
    // 模块伪节点(有顶层调用边)。
    for name in ["act", "notify", "helper", "standalone"] {
        assert!(nodes
            .iter()
            .any(|n| n["name"] == name && n["id"].as_str().unwrap().starts_with("sym_")));
    }
    assert!(nodes
        .iter()
        .any(|n| n["kind"] == "module" && n["name"] == "Avatar"));

    // 8 类边全部出现(去重统计)。
    let edges = result.get("edges").unwrap().as_array().unwrap();
    assert!(edges.len() >= 11, "edges={edges:?}");
    let mut kinds: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for e in edges {
        kinds.insert(e["kind"].as_str().unwrap());
        assert_eq!(e["filePath"].as_str().unwrap(), "/scripts/cell/Avatar.py");
        assert!(e["callerLine"].is_number());
    }
    for expected in [
        "local",
        "method",
        "self-method",
        "kbe-broadcast",
        "kbe-base-clients",
        "kbe-cross-process",
        "kbe-api",
        "unknown",
    ] {
        assert!(
            kinds.contains(expected),
            "missing kind {expected}, got {kinds:?}"
        );
    }

    // stats.byKind 固定 8 键(0 计数也保留)。
    let by_kind = result["stats"]["byKind"].as_object().unwrap();
    assert_eq!(by_kind.len(), 8);
    assert_eq!(
        result["stats"]["nodeCount"].as_u64().unwrap(),
        nodes.len() as u64
    );
    assert_eq!(
        result["stats"]["edgeCount"].as_u64().unwrap(),
        edges.len() as u64
    );
    assert_eq!(result["stats"]["errorCount"].as_u64().unwrap(), 0);
    assert_eq!(result["stats"]["fileCount"].as_u64().unwrap(), 1);

    // 数据流:Avatar.act 有 def-use 链(至少 1 条)。
    let dataflow = result.get("dataflow").unwrap().as_array().unwrap();
    assert!(
        dataflow.iter().any(|d| d["method"] == "act"),
        "dataflow missing act, got {dataflow:?}"
    );

    // 进程角色:清单 3 进程 → 3 角色(去重升序)。
    let roles = result.get("processRoles").unwrap().as_array().unwrap();
    let role_names: Vec<&str> = roles.iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(role_names, vec!["baseapp", "cellapp", "dbmgr"]);

    // 反索引:至少结构存在(单文件无跨文件,可空或自身折叠后为空)。
    assert!(result.get("reverseIndex").unwrap().is_object());
}

#[test]
fn callgraph_cross_file_reverse_index() {
    // game.py 调用 avatar.py 的 Avatar.act → reverseIndex[avatar.py] 含 game.py。
    let avatar = r#"class Avatar:
    def act(self):
        pass
"#;
    let game = r#"import avatar

def run():
    a = avatar.Avatar()
    a.act()
"#;
    let result = callgraph(json!({
        "files": [
            {"path": "/scripts/cell/avatar.py", "text": avatar},
            {"path": "/scripts/game.py", "text": game},
        ],
    }));
    let reverse = result.get("reverseIndex").unwrap().as_object().unwrap();
    let callers = reverse
        .get("/scripts/cell/avatar.py")
        .unwrap()
        .as_array()
        .unwrap();
    let caller_paths: Vec<&str> = callers.iter().map(|v| v.as_str().unwrap()).collect();
    assert!(
        caller_paths.contains(&"/scripts/game.py"),
        "expected game.py in reverseIndex[avatar.py], got {caller_paths:?}"
    );
}

#[test]
fn callgraph_tolerates_syntax_error() {
    let broken = r#"def broken(:
    pass
"#;
    let result = callgraph(json!({
        "files": [{"path": "/scripts/broken.py", "text": broken}],
    }));
    assert!(result["stats"]["errorCount"].as_u64().unwrap() >= 1);
    // 不 panic,形状完整。
    assert!(result.get("nodes").is_some());
    assert!(result.get("edges").is_some());
}

#[test]
fn callgraph_empty_files_contract() {
    let result = callgraph(json!({"files": []}));
    assert_eq!(result["stats"]["fileCount"].as_u64().unwrap(), 0);
    assert_eq!(result["nodes"].as_array().unwrap().len(), 0);
    assert_eq!(result["edges"].as_array().unwrap().len(), 0);
    assert!(result
        .get("processRoles")
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn symbols_per_file_shape_and_self_calls() {
    let result = symbols(json!({
        "files": [{"path": "/scripts/cell/Avatar.py", "text": KB_ENTITY}],
    }));
    let files = result.as_array().unwrap();
    assert_eq!(files.len(), 1);
    let f = &files[0];
    assert_eq!(f["filePath"], "/scripts/cell/Avatar.py");
    assert!(f["lineCount"].is_number());

    let classes = f["classes"].as_array().unwrap();
    assert_eq!(classes.len(), 1);
    let class = &classes[0];
    assert_eq!(class["name"], "Avatar");
    assert_eq!(class["qualifiedName"], "Avatar");

    let methods = class["methods"].as_array().unwrap();
    let act = methods.iter().find(|m| m["name"] == "act").unwrap();
    assert_eq!(act["isAsync"], false);
    assert!(act["params"].is_array());

    // act 的自身调用:notify(1 处,含 line/character)。
    let calls = act["calls"].as_array().unwrap();
    let notify = calls.iter().find(|c| c["methodName"] == "notify").unwrap();
    assert!(notify["line"].is_number());
    assert!(notify["character"].is_number());

    // 模块级函数表 + 导入表。
    let functions = f["functions"].as_array().unwrap();
    let helper = functions
        .iter()
        .find(|fn_| fn_["name"] == "helper")
        .unwrap();
    assert_eq!(helper["params"].as_array().unwrap().len(), 1);
    let imports = f["imports"].as_array().unwrap();
    let kb = imports.iter().find(|i| i["binding"] == "KBEngine").unwrap();
    assert_eq!(kb["module"], "KBEngine");

    // 无语法错误 → errors 空。
    assert_eq!(f["errors"].as_array().unwrap().len(), 0);
}

#[test]
fn symbols_tolerates_syntax_error_reports_errors() {
    let result = symbols(json!({
        "files": [{"path": "/scripts/broken.py", "text": "def broken(:\n    pass\n"}],
    }));
    let files = result.as_array().unwrap();
    let errors = files[0]["errors"].as_array().unwrap();
    assert!(!errors.is_empty(), "expected at least one syntax error");
}

#[test]
fn symbols_empty_files_contract() {
    let result = symbols(json!({"files": []}));
    assert_eq!(result.as_array().unwrap().len(), 0);
}

#[test]
fn callgraph_keeps_same_named_methods_separate_across_files() {
    let source = "class Avatar:\n def act(self):\n  self.target()\n def target(self):\n  pass\n";
    let result = callgraph(json!({"files": [
        {"path": "/base/Avatar.py", "text": source},
        {"path": "/cell/Avatar.py", "text": source}
    ]}));
    let nodes = result["nodes"].as_array().unwrap();
    let edges = result["edges"].as_array().unwrap();
    let id = |path: &str, name: &str| {
        nodes
            .iter()
            .find(|n| n["filePath"] == path && n["name"] == name)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_ne!(id("/base/Avatar.py", "act"), id("/cell/Avatar.py", "act"));
    for path in ["/base/Avatar.py", "/cell/Avatar.py"] {
        let edge = edges
            .iter()
            .find(|e| e["filePath"] == path && e["callee"] == "target")
            .unwrap();
        assert_eq!(edge["callerId"], id(path, "act"));
        assert_eq!(edge["calleeId"], id(path, "target"));
    }
}

// --- KR-AUD-91 验收:跨文件身份(嵌套作用域/同 stem/多工作区) ---

#[test]
fn kr_aud_91_nested_scope_edges_carry_file_identity() {
    // 嵌套 def 的调用边两端必须是带文件身份的 sym_ ID;
    // 两文件中同名嵌套函数 callerId 不混淆。
    let src = |which: &str| {
        format!(
        "class Foo:\n def run(self):\n  def inner():\n   helper()\n  inner()\n\ndef helper():\n pass\n# {which}\n"
    )
    };
    let result = callgraph(json!({"files": [
        {"path": "/p/one/A.py", "text": src("one")},
        {"path": "/p/two/A.py", "text": src("two")}
    ]}));
    let edges = result["edges"].as_array().unwrap();
    let nested_caller_ids: Vec<&str> = edges
        .iter()
        .filter(|e| e["caller"] == "inner")
        .filter_map(|e| e["callerId"].as_str())
        .collect();
    assert_eq!(nested_caller_ids.len(), 2, "两文件各一条嵌套调用边");
    assert_ne!(
        nested_caller_ids[0], nested_caller_ids[1],
        "同名嵌套函数必须按文件区分"
    );
    for e in edges {
        let caller_id = e["callerId"].as_str().expect("边缺 callerId");
        let callee_id = e["calleeId"].as_str().expect("边缺 calleeId");
        assert!(
            caller_id.starts_with("sym_"),
            "callerId 非文件身份: {caller_id}"
        );
        assert!(
            callee_id.starts_with("sym_"),
            "calleeId 非文件身份: {callee_id}"
        );
        assert!(
            caller_id.contains("2f702f6f6e652f412e7079")
                || caller_id.contains("2f702f74776f2f412e7079"),
            "callerId 不含本文件路径 hex: {caller_id}"
        );
    }
}

#[test]
fn kr_aud_91_same_stem_functions_keep_separate_nodes() {
    // 不同目录同 stem 文件(/base/scripts/util.py vs /cell/scripts/util.py):
    // 同名函数独立节点、边指向本文件端点、源码行正确。
    let util = "def helper():\n pass\n\ndef entry():\n helper()\n";
    let result = callgraph(json!({"files": [
        {"path": "/proj/base/scripts/util.py", "text": util},
        {"path": "/proj/cell/scripts/util.py", "text": util}
    ]}));
    let nodes = result["nodes"].as_array().unwrap();
    let edges = result["edges"].as_array().unwrap();
    let node_id = |path: &str, name: &str| -> String {
        let n = nodes
            .iter()
            .find(|n| n["filePath"] == path && n["name"] == name)
            .unwrap_or_else(|| panic!("缺节点 {path}::{name}"));
        n["id"].as_str().unwrap().to_string()
    };
    let base_helper = node_id("/proj/base/scripts/util.py", "helper");
    let cell_helper = node_id("/proj/cell/scripts/util.py", "helper");
    assert_ne!(base_helper, cell_helper, "同 stem 同名函数必须独立节点");
    // 源码位置:helper 行 0,entry 行 3(0-based)。
    let base_entry_node = nodes
        .iter()
        .find(|n| n["filePath"] == "/proj/base/scripts/util.py" && n["name"] == "entry")
        .unwrap();
    assert_eq!(base_entry_node["line"], 3);
    // 每条边的端点必须是本文件节点。
    for path in ["/proj/base/scripts/util.py", "/proj/cell/scripts/util.py"] {
        let edge = edges
            .iter()
            .find(|e| e["filePath"] == path && e["callee"] == "helper")
            .unwrap_or_else(|| panic!("{path} 缺 entry->helper 边"));
        assert_eq!(
            edge["callerId"],
            node_id(path, "entry"),
            "callerId 未指向本文件节点"
        );
        assert_eq!(
            edge["calleeId"],
            node_id(path, "helper"),
            "calleeId 未指向本文件节点"
        );
    }
}

#[test]
fn kr_aud_91_multi_workspace_same_relative_path_keeps_separate_nodes() {
    // 多工作区:两个根下相同相对路径的同名符号保持独立节点与边。
    let util = "def boot():\n pass\n\ndef start():\n boot()\n";
    let result = callgraph(json!({"files": [
        {"path": "/wsA/scripts/app.py", "text": util},
        {"path": "/wsB/scripts/app.py", "text": util}
    ]}));
    let nodes = result["nodes"].as_array().unwrap();
    let edges = result["edges"].as_array().unwrap();
    let id_of = |path: &str, name: &str| -> String {
        nodes
            .iter()
            .find(|n| n["filePath"] == path && n["name"] == name)
            .unwrap_or_else(|| panic!("缺节点 {path}::{name}"))["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let a_boot = id_of("/wsA/scripts/app.py", "boot");
    let b_boot = id_of("/wsB/scripts/app.py", "boot");
    assert_ne!(a_boot, b_boot, "多工作区同名符号必须独立");
    for path in ["/wsA/scripts/app.py", "/wsB/scripts/app.py"] {
        let edge = edges
            .iter()
            .find(|e| e["filePath"] == path && e["callee"] == "boot")
            .unwrap_or_else(|| panic!("{path} 缺 start->boot 边"));
        assert_eq!(edge["callerId"], id_of(path, "start"));
        assert_eq!(edge["calleeId"], id_of(path, "boot"));
    }
}
