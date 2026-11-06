//! `$/kode/processTopology/validate` —— 进程拓扑定义期错配预警(C-17)。
//!
//! 交付①进程拓扑清单(部署清单文件 `process_topology.xml`,workspace 根,可选):
//! 声明部署内进程与职能——每进程 name/role(参照 KBEngine COMPONENT_TYPE:
//! dbmgr/loginapp/baseappmgr/cellappmgr/cellapp/baseapp/machine/logger/interfaces
//! /bots 并可自定义)+ 入口命令行 entry + 监听 port + 依赖启动序 dependsOn +
//! 承载实体 hosts(可选窄化)。
//! 交付②定义期错配预警(接入 kode lint/diagnostics 体系):全部 warning 且
//! 文件+行定位,可 CI 拦截。
//!
//! 引擎地面真相(/home/cui/workspaces/kbengine,全部溯源):
//! - COMPONENT_TYPE/COMPONENT_NAME(common.h:75-115);
//! - 方法节→组件:CellMethods→CELLAPP_TYPE(entitydef.cpp:1324)、
//!   BaseMethods→BASEAPP_TYPE(:1467)、ClientMethods→CLIENT_TYPE(:1610);
//! - 属性旗标→域:ENTITY_BASE/CELL/CLIENT_DATA_FLAGS(entitydef/common.h:41-45);
//! - 归属:cellapp 承载 hasCell() 实体、baseapp 承载 hasBase() 实体
//!   (entity_app.h:573-578);dbmgr 按 uid 单实例查找(components.cpp:933)。
//!
//! 边界:清单缺省=零发现(功能未启用,零误报);ClientMethods 不校验(客户端
//! 游戏侧非服务端拓扑,如实记录);闭包(own→interfaces→components→parent)
//! 镜像 message_table load_def_into_module 序,只累积内容不编号。

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use kode_parser::diag::LineMap;
use kode_parser::model::{parse_def, ComponentDef, DefFile, MethodDef, PropertyDef};
use kode_parser::xml::{self, Document};

use crate::rpc::RpcRegistry;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/processTopology/validate", build_handler);
}

/// 已知引擎组件角色名(common.h:99-115 COMPONENT_NAME 的服务端子集)。
const KNOWN_ROLES: &[&str] = &[
    "machine",
    "logger",
    "interfaces",
    "dbmgr",
    "baseappmgr",
    "cellappmgr",
    "baseapp",
    "cellapp",
    "loginapp",
    "bots",
    "console",
    "watcher",
    "tool",
];

/// 单例角色(每部署一个;SERVER_COMPONENTS 的 required 非可扩展项)。
const SINGLETON_ROLES: &[&str] = &[
    "machine",
    "logger",
    "interfaces",
    "dbmgr",
    "baseappmgr",
    "cellappmgr",
];

const SEVERITY_WARNING: u32 = 2;

// 属性旗标 → 域(引擎 entitydef/common.h:41-45)。
const BASE_FLAGS: &[&str] = &["BASE", "BASE_AND_CLIENT"];
const CELL_FLAGS: &[&str] = &[
    "CELL_PUBLIC",
    "CELL_PRIVATE",
    "ALL_CLIENTS",
    "CELL_PUBLIC_AND_OWN",
    "OTHER_CLIENTS",
    "OWN_CLIENT",
];
const CLIENT_FLAGS: &[&str] = &[
    "BASE_AND_CLIENT",
    "ALL_CLIENTS",
    "CELL_PUBLIC_AND_OWN",
    "OTHER_CLIENTS",
    "OWN_CLIENT",
];

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildParams {
    manifest_text: String,
    #[serde(default)]
    entities_xml_text: Option<String>,
    #[serde(default)]
    defs: Vec<DefInput>,
}

/// 单个 def 原文入参(原文直传 def_md5 风格;类别取 category==entity 优先)。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefInput {
    pub name: String,
    #[serde(default)]
    pub category: String,
    pub file_path: String,
    pub text: String,
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// "manifest" | "def"
    pub target: String,
    pub file_path: String,
    pub line: usize,
    pub severity: u32,
    pub message: String,
    pub code: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<Related>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Related {
    pub file_path: String,
    pub line: usize,
    pub message: String,
}

// ---------------------------------------------------------------------------
// 清单模型
// ---------------------------------------------------------------------------

struct ProcessNode {
    name: String,
    name_line: usize,
    role: String,
    role_line: usize,
    port: Option<u32>,
    port_line: Option<usize>,
    depends_on: Vec<(String, usize)>,
    hosts: Vec<(String, usize)>,
    custom: bool,
    #[allow(dead_code)]
    entry: Option<String>,
}

struct Manifest {
    processes: Vec<ProcessNode>,
}

fn parse_manifest(text: &str) -> Manifest {
    let doc = xml::parse(text, true);
    let lines = LineMap::new(text);
    let mut processes = Vec::new();
    let root = match doc.root() {
        Some(r) => r,
        None => return Manifest { processes },
    };
    for child in doc.child_elements(root) {
        if doc.element(child).name != "process" {
            continue;
        }
        let e = doc.element(child);
        let name = e
            .attribute("name")
            .map(|a| a.value.trim().to_string())
            .unwrap_or_default();
        let name_line = e
            .attribute("name")
            .map(|a| lines.line_of(a.value_span.start))
            .unwrap_or_else(|| lines.line_of(e.name_span.start));
        let (role, role_line) = match e.attribute("role") {
            Some(a) => (
                a.value.trim().to_string(),
                lines.line_of(a.value_span.start),
            ),
            None => (String::new(), lines.line_of(e.name_span.start)),
        };
        let port = scalar_child(&doc, child, "port").and_then(|v| v.trim().parse::<u32>().ok());
        let port_line = doc
            .child_element(child, "port")
            .map(|idx| lines.line_of(doc.element(idx).name_span.start));
        let depends_on = doc
            .child_elements_named(child, "dependsOn")
            .into_iter()
            .map(|idx| {
                (
                    doc.element(idx).text(&doc).trim().to_string(),
                    lines.line_of(doc.element(idx).name_span.start),
                )
            })
            .filter(|(v, _)| !v.is_empty())
            .collect();
        let hosts = doc
            .child_elements_named(child, "hosts")
            .into_iter()
            .map(|idx| {
                (
                    doc.element(idx).text(&doc).trim().to_string(),
                    lines.line_of(doc.element(idx).name_span.start),
                )
            })
            .filter(|(v, _)| !v.is_empty())
            .collect();
        let custom = doc.truthy_child(child, "custom");
        let entry = scalar_child(&doc, child, "entry");
        processes.push(ProcessNode {
            name,
            name_line,
            role,
            role_line,
            port,
            port_line,
            depends_on,
            hosts,
            custom,
            entry,
        });
    }
    Manifest { processes }
}

/// 首个匹配子元素的直接文本 trim(空 → None)。
fn scalar_child(doc: &Document, idx: usize, name: &str) -> Option<String> {
    doc.child_element(idx, name)
        .map(|child| doc.element(child).text(doc).trim().to_string())
}

// ---------------------------------------------------------------------------
// 实体内容(entities.xml 属性 + def 闭包)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct EntityContent {
    name: String,
    file_path: String,
    line: usize,
    has_cell: bool,
    has_base: bool,
    /// 客户端域内容只累积不校验(客户端属游戏侧,非服务端拓扑——如实记录)。
    #[allow(dead_code)]
    has_client: bool,
    persistent: bool,
    /// 首个触发行的优先定位(def 方法段/持久属性行;回退实体行)。
    cell_line: Option<usize>,
    base_line: Option<usize>,
    persistent_line: Option<usize>,
}

#[derive(Debug, Clone)]
struct RegistryEntity {
    name: String,
    line: usize,
    has_base: bool,
    has_cell: bool,
    has_client: bool,
}

/// 解析 entities.xml 注册清单(flat `<Avatar hasBase="true"/>` 与分段
/// `<ClientServerEntities>`/`<ServerOnlyEntities>` 两形态,同 TS getRegisteredEntities)。
fn parse_entity_registry(text: &str) -> Vec<RegistryEntity> {
    let doc = xml::parse(text, false);
    let lines = LineMap::new(text);
    let mut out = Vec::new();
    let root = match doc.root() {
        Some(r) => r,
        None => return out,
    };
    let mut visit = |idx: usize, group_client: Option<bool>| {
        let e = doc.element(idx);
        let truthy = |attr: &str| {
            e.attribute(attr)
                .map(|a| {
                    matches!(
                        a.value.trim().to_ascii_lowercase().as_str(),
                        "true" | "1" | "yes"
                    )
                })
                .unwrap_or(false)
        };
        out.push(RegistryEntity {
            name: e.name.clone(),
            line: lines.line_of(e.name_span.start),
            has_base: truthy("hasBase"),
            has_cell: truthy("hasCell"),
            has_client: group_client.unwrap_or_else(|| truthy("hasClient")),
        });
    };
    for child in doc.child_elements(root) {
        let name = doc.element(child).name.clone();
        match name.as_str() {
            "root" => continue,
            "ClientServerEntities" => {
                for inner in doc.child_elements(child) {
                    visit(inner, Some(true));
                }
            }
            "ServerOnlyEntities" => {
                for inner in doc.child_elements(child) {
                    visit(inner, Some(false));
                }
            }
            _ => visit(child, None),
        }
    }
    out
}

/// def 名 → (DefInput 索引);按 category 优先 entity,回退其它类。
struct DefCorpus {
    by_name: HashMap<String, usize>,
    defs: Vec<DefInput>,
}

impl DefCorpus {
    fn new(defs: Vec<DefInput>) -> DefCorpus {
        let mut by_name: HashMap<String, usize> = HashMap::new();
        for (idx, def) in defs.iter().enumerate() {
            // entity 优先登记(实体同名 def 覆盖接口/组件边角)。
            if def.category == "entity" || !by_name.contains_key(&def.name) {
                by_name.insert(def.name.clone(), idx);
            }
        }
        DefCorpus { by_name, defs }
    }

    fn get(&self, name: &str) -> Option<&DefInput> {
        self.by_name.get(name).map(|&idx| &self.defs[idx])
    }
}

/// 闭合内容累积器(own→interfaces→components→parent,含成环守卫)。
#[derive(Default)]
struct ContentAcc {
    visited: HashSet<String>,
    /// KODE-AUD-006:当前展开路径的活动栈(再入即环)。visited 只对
    /// origin != "interface" 生效,interface 链 A→B→A 不入 visited 仍会无限
    /// 递归栈溢出;visiting 标记正在展开的 def 名,再遇即截断(与 message_table
    /// 同路,引擎递归装载无法终止)。非环 DAG 重访不受影响(visited 先行去重)。
    visiting: HashSet<String>,
    has_cell: bool,
    has_base: bool,
    has_client: bool,
    persistent: bool,
    cell_line: Option<usize>,
    base_line: Option<usize>,
    persistent_line: Option<usize>,
}

impl ContentAcc {
    fn note_line(slot: &mut Option<usize>, line: usize) {
        *slot = Some(match *slot {
            Some(existing) => existing.min(line),
            None => line,
        });
    }

    fn absorb_property(&mut self, prop: &PropertyDef) {
        let flags = &prop.flags;
        if flags.iter().any(|f| BASE_FLAGS.contains(&f.as_str())) {
            self.has_base = true;
            Self::note_line(&mut self.base_line, prop.line);
        }
        if flags.iter().any(|f| CELL_FLAGS.contains(&f.as_str())) {
            self.has_cell = true;
            Self::note_line(&mut self.cell_line, prop.line);
        }
        if flags.iter().any(|f| CLIENT_FLAGS.contains(&f.as_str())) {
            self.has_client = true;
        }
        if prop.persistent == Some(true) {
            self.persistent = true;
            Self::note_line(&mut self.persistent_line, prop.line);
        }
    }

    fn absorb_methods(&mut self, methods: &[MethodDef], section: Section) {
        for method in methods {
            match section {
                Section::Cell => {
                    self.has_cell = true;
                    Self::note_line(&mut self.cell_line, method.line);
                }
                Section::Base => {
                    self.has_base = true;
                    Self::note_line(&mut self.base_line, method.line);
                }
                Section::Client => self.has_client = true,
            }
        }
    }

    fn absorb_component(&mut self, comp: &ComponentDef) {
        if comp.persistent == Some(true) {
            self.persistent = true;
            Self::note_line(&mut self.persistent_line, comp.line);
        }
    }
}

#[derive(Clone, Copy)]
enum Section {
    Base,
    Cell,
    Client,
}

/// 走查一个 def(含闭包),累积内容。`origin` 区分实体/接口(接口不成环守卫,
/// 与 message_table 一致)。
fn walk_def(name: &str, corpus: &DefCorpus, origin: &str, acc: &mut ContentAcc) {
    if origin != "interface" && !acc.visited.insert(name.to_string()) {
        // 父类链成环:引擎递归装载无法终止,kode 截断(与 message_table 同路)。
        return;
    }
    // KODE-AUD-006:活动栈保护——component/interface/parent 三向关系成环
    // (A→B→A)时,visited 只挡非 interface 链;interface 链 A→B→A 不入 visited
    // 仍会无限递归栈溢出。visiting 标记当前展开路径,再入即环,截断返回。
    if !acc.visiting.insert(name.to_string()) {
        return;
    }
    let def = match corpus.get(name) {
        Some(def) => def,
        None => {
            acc.visiting.remove(name);
            return;
        }
    };
    let file: DefFile = parse_def(&def.text);
    for prop in &file.properties {
        acc.absorb_property(prop);
    }
    acc.absorb_methods(&file.base_methods, Section::Base);
    acc.absorb_methods(&file.cell_methods, Section::Cell);
    acc.absorb_methods(&file.client_methods, Section::Client);
    for comp in &file.components {
        acc.absorb_component(comp);
        if let Some(type_name) = &comp.component_type {
            walk_def(type_name, corpus, "component", acc);
        }
    }
    for iface in &file.interfaces {
        walk_def(iface, corpus, "interface", acc);
    }
    if let Some(parent) = &file.parent {
        walk_def(parent, corpus, origin, acc);
    }
    acc.visiting.remove(name);
}

// ---------------------------------------------------------------------------
// 主校验
// ---------------------------------------------------------------------------

fn build_handler(params: Value) -> Result<Value, String> {
    let input: BuildParams = serde_json::from_value(params)
        .map_err(|e| format!("processTopology/validate params: {e}"))?;
    let findings = validate(input);
    serde_json::to_value(BTreeMap::from([("findings", findings)])).map_err(|e| e.to_string())
}

/// 公共入口(CI bin 用):给定清单原文 + entities.xml 原文 + defs 集合,返回全部发现。
pub fn validate_process_topology(
    manifest_text: &str,
    entities_xml_text: Option<&str>,
    defs: Vec<DefInput>,
) -> Vec<Finding> {
    validate(BuildParams {
        manifest_text: manifest_text.to_string(),
        entities_xml_text: entities_xml_text.map(str::to_string),
        defs,
    })
}

fn validate(input: BuildParams) -> Vec<Finding> {
    let manifest = parse_manifest(&input.manifest_text);
    if manifest.processes.is_empty() {
        return Vec::new();
    }
    let corpus = DefCorpus::new(input.defs);
    let registry = input
        .entities_xml_text
        .as_deref()
        .map(parse_entity_registry)
        .unwrap_or_default();

    let manifest_path = "<manifest>".to_string();
    let mut findings = Vec::new();

    // 实体内容 = entities.xml 注册项 ∪ category=entity 的 def 名。
    let contents = collect_contents(&registry, &corpus);

    // 校验清单本身(M1-M6)。
    check_manifest(&manifest, &manifest_path, &mut findings);

    // 角色存在性。
    let has_role = |role: &str| manifest.processes.iter().any(|p| p.role == role);
    let has_cellapp = has_role("cellapp");
    let has_baseapp = has_role("baseapp");
    let has_dbmgr = has_role("dbmgr");

    // D1/D2/D3:实体内容 vs 拓扑角色。
    for content in contents.values() {
        let line_at = |slot: Option<usize>| slot.unwrap_or(content.line);
        if content.has_cell && !has_cellapp {
            findings.push(Finding {
                target: "def".into(),
                file_path: content.file_path.clone(),
                line: line_at(content.cell_line),
                severity: SEVERITY_WARNING,
                message: format!(
                    "实体 {} 有 cell 内容(CellMethods 或 cell 域属性),但进程拓扑缺少 cellapp 角色进程",
                    content.name
                ),
                code: "kbengine.processTopologyMissingCellapp".into(),
                related: vec![Related {
                    file_path: manifest_path.clone(),
                    line: 1,
                    message: "进程拓扑清单未声明 role=\"cellapp\" 的进程".into(),
                }],
            });
        }
        if content.has_base && !has_baseapp {
            findings.push(Finding {
                target: "def".into(),
                file_path: content.file_path.clone(),
                line: line_at(content.base_line),
                severity: SEVERITY_WARNING,
                message: format!(
                    "实体 {} 有 base 内容(BaseMethods 或 base 域属性),但进程拓扑缺少 baseapp 角色进程",
                    content.name
                ),
                code: "kbengine.processTopologyMissingBaseapp".into(),
                related: vec![Related {
                    file_path: manifest_path.clone(),
                    line: 1,
                    message: "进程拓扑清单未声明 role=\"baseapp\" 的进程".into(),
                }],
            });
        }
        if content.persistent && !has_dbmgr {
            findings.push(Finding {
                target: "def".into(),
                file_path: content.file_path.clone(),
                line: line_at(content.persistent_line),
                severity: SEVERITY_WARNING,
                message: format!(
                    "实体 {} 有持久化属性,但进程拓扑缺少 dbmgr 角色进程",
                    content.name
                ),
                code: "kbengine.processTopologyMissingDbmgr".into(),
                related: vec![Related {
                    file_path: manifest_path.clone(),
                    line: 1,
                    message: "进程拓扑清单未声明 role=\"dbmgr\" 的进程".into(),
                }],
            });
        }
    }

    // O1/O2:清单 hosts 声明 vs 实体内容/存在性。
    for process in &manifest.processes {
        for (entity_name, line) in &process.hosts {
            match contents.get(entity_name) {
                None => findings.push(Finding {
                    target: "manifest".into(),
                    file_path: manifest_path.clone(),
                    line: *line,
                    severity: SEVERITY_WARNING,
                    message: format!(
                        "进程 {} 承载了未知名实体 {}(不在 entities.xml 也未找到 def)",
                        process.name, entity_name
                    ),
                    code: "kbengine.processTopologyUnknownHostedEntity".into(),
                    related: Vec::new(),
                }),
                Some(content) => {
                    enum HostIssue {
                        ContentMismatch(&'static str),
                        /// 非 cellapp/baseapp 角色承载实体(仅这两类承载实体)。
                        WrongRole,
                    }
                    let issue = match process.role.as_str() {
                        "cellapp" if !content.has_cell => Some(HostIssue::ContentMismatch(
                            "cellapp 承载的实体无 cell 内容(CellMethods/cell 域属性)",
                        )),
                        "baseapp" if !content.has_base => Some(HostIssue::ContentMismatch(
                            "baseapp 承载的实体无 base 内容(BaseMethods/base 域属性)",
                        )),
                        "cellapp" | "baseapp" => None,
                        _ => Some(HostIssue::WrongRole),
                    };
                    if let Some(issue) = issue {
                        let message = match issue {
                            HostIssue::ContentMismatch(detail) => {
                                format!("实体 {} 归属矛盾:{}", entity_name, detail)
                            }
                            HostIssue::WrongRole => format!(
                                "进程 {} 的角色 \"{}\" 不能承载实体(仅 cellapp/baseapp 承载实体)",
                                process.name, process.role
                            ),
                        };
                        findings.push(Finding {
                            target: "manifest".into(),
                            file_path: manifest_path.clone(),
                            line: *line,
                            severity: SEVERITY_WARNING,
                            message,
                            code: "kbengine.processTopologyHostConflict".into(),
                            related: vec![Related {
                                file_path: content.file_path.clone(),
                                line: content.line,
                                message: format!("实体 {} 的 def/注册位置", entity_name),
                            }],
                        });
                    }
                }
            }
        }
    }

    findings.sort_by(|a, b| {
        a.file_path
            .cmp(&b.file_path)
            .then(a.line.cmp(&b.line))
            .then(a.code.cmp(&b.code))
    });
    findings
}

fn collect_contents(
    registry: &[RegistryEntity],
    corpus: &DefCorpus,
) -> BTreeMap<String, EntityContent> {
    let mut contents: BTreeMap<String, EntityContent> = BTreeMap::new();

    // entities.xml 注册项(权威部署集),内容 = 属性 ∪ def 闭包。
    for entry in registry {
        let mut acc = ContentAcc::default();
        walk_def(&entry.name, corpus, "entity", &mut acc);
        let file_path = corpus
            .get(&entry.name)
            .map(|d| d.file_path.clone())
            .unwrap_or_else(|| "<entities.xml>".into());
        let line = corpus
            .get(&entry.name)
            .map(|_| acc_or(acc.cell_line, entry.line))
            .unwrap_or(entry.line);
        contents.insert(
            entry.name.clone(),
            EntityContent {
                name: entry.name.clone(),
                file_path,
                line: entry.line,
                has_cell: acc.has_cell || entry.has_cell,
                has_base: acc.has_base || entry.has_base,
                has_client: acc.has_client || entry.has_client,
                persistent: acc.persistent,
                cell_line: acc.cell_line,
                base_line: acc.base_line,
                persistent_line: acc.persistent_line,
            },
        );
        let _ = line;
    }

    // category=entity 的 def 名(未注册也纳入检测集)。
    for def in &corpus.defs {
        if def.category != "entity" || contents.contains_key(&def.name) {
            continue;
        }
        let mut acc = ContentAcc::default();
        walk_def(&def.name, corpus, "entity", &mut acc);
        contents.insert(
            def.name.clone(),
            EntityContent {
                name: def.name.clone(),
                file_path: def.file_path.clone(),
                line: 1,
                has_cell: acc.has_cell,
                has_base: acc.has_base,
                has_client: acc.has_client,
                persistent: acc.persistent,
                cell_line: acc.cell_line,
                base_line: acc.base_line,
                persistent_line: acc.persistent_line,
            },
        );
    }

    contents
}

fn acc_or(value: Option<usize>, fallback: usize) -> usize {
    value.unwrap_or(fallback)
}

fn check_manifest(manifest: &Manifest, manifest_path: &str, findings: &mut Vec<Finding>) {
    // M1:进程名重复。
    let mut seen_names: HashMap<&str, usize> = HashMap::new();
    for process in &manifest.processes {
        if let Some(_first) = seen_names.get(process.name.as_str()) {
            findings.push(Finding {
                target: "manifest".into(),
                file_path: manifest_path.into(),
                line: process.name_line,
                severity: SEVERITY_WARNING,
                message: format!("进程名重复:{}", process.name),
                code: "kbengine.processTopologyDuplicateName".into(),
                related: Vec::new(),
            });
        } else {
            seen_names.insert(process.name.as_str(), process.name_line);
        }
    }

    // M2:端口冲突。
    let mut seen_ports: HashMap<u32, (&str, usize)> = HashMap::new();
    for process in &manifest.processes {
        let Some(port) = process.port else { continue };
        let line = process.port_line.unwrap_or(process.name_line);
        if let Some((owner, _)) = seen_ports.get(&port) {
            findings.push(Finding {
                target: "manifest".into(),
                file_path: manifest_path.into(),
                line,
                severity: SEVERITY_WARNING,
                message: format!("端口冲突:{} 与 {} 都监听 {}", process.name, owner, port),
                code: "kbengine.processTopologyDuplicatePort".into(),
                related: Vec::new(),
            });
        } else {
            seen_ports.insert(port, (process.name.as_str(), line));
        }
    }

    // M3:单例角色重复。
    let mut role_counts: HashMap<&str, usize> = HashMap::new();
    for process in &manifest.processes {
        *role_counts.entry(process.role.as_str()).or_default() += 1;
    }
    let mut reported_singletons: HashSet<&str> = HashSet::new();
    for process in &manifest.processes {
        if SINGLETON_ROLES.contains(&process.role.as_str())
            && role_counts.get(process.role.as_str()).copied().unwrap_or(0) > 1
            && reported_singletons.insert(process.role.as_str())
        {
            findings.push(Finding {
                target: "manifest".into(),
                file_path: manifest_path.into(),
                line: process.role_line,
                severity: SEVERITY_WARNING,
                message: format!(
                    "单例角色重复:role \"{}\" 每部署只应有一个进程",
                    process.role
                ),
                code: "kbengine.processTopologyDuplicateSingletonRole".into(),
                related: Vec::new(),
            });
        }
    }

    // M4:未知角色(非引擎名且未标 custom)。
    for process in &manifest.processes {
        if !process.custom && !KNOWN_ROLES.contains(&process.role.as_str()) {
            findings.push(Finding {
                target: "manifest".into(),
                file_path: manifest_path.into(),
                line: process.role_line,
                severity: SEVERITY_WARNING,
                message: format!(
                    "未知进程角色 \"{}\"(非 KBEngine 组件名;自定义请加 <custom>true</custom>)",
                    process.role
                ),
                code: "kbengine.processTopologyUnknownRole".into(),
                related: Vec::new(),
            });
        }
    }

    // M5:dependsOn 引用不存在进程。
    let known: HashSet<&str> = manifest.processes.iter().map(|p| p.name.as_str()).collect();
    for process in &manifest.processes {
        for (dep, line) in &process.depends_on {
            if !known.contains(dep.as_str()) {
                findings.push(Finding {
                    target: "manifest".into(),
                    file_path: manifest_path.into(),
                    line: *line,
                    severity: SEVERITY_WARNING,
                    message: format!("进程 {} 依赖了不存在的进程 {}", process.name, dep),
                    code: "kbengine.processTopologyUnknownDependency".into(),
                    related: Vec::new(),
                });
            }
        }
    }

    // M6:依赖成环。
    for cycle in dependency_cycles(manifest) {
        let process = manifest.processes.iter().find(|p| p.name == cycle.0);
        let line = process.map(|p| p.name_line).unwrap_or(1);
        findings.push(Finding {
            target: "manifest".into(),
            file_path: manifest_path.into(),
            line,
            severity: SEVERITY_WARNING,
            message: format!("依赖成环:{}", cycle.1.join(" → ")),
            code: "kbengine.processTopologyDependencyCycle".into(),
            related: Vec::new(),
        });
    }
}

/// 返回每个成环(起点名, 路径),去重(同环只报一次)。
fn dependency_cycles(manifest: &Manifest) -> Vec<(String, Vec<String>)> {
    let index: HashMap<&str, usize> = manifest
        .processes
        .iter()
        .enumerate()
        .map(|(i, p)| (p.name.as_str(), i))
        .collect();
    let mut reported: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for start_idx in 0..manifest.processes.len() {
        let mut path: Vec<String> = Vec::new();
        let mut on_path: HashSet<usize> = HashSet::new();
        let mut current = start_idx;
        loop {
            if !on_path.insert(current) {
                // 回到路径上的节点 → 提取环。
                if let Some(pos) = path.iter().position(|name| {
                    index
                        .get(name.as_str())
                        .map(|&i| i == current)
                        .unwrap_or(false)
                }) {
                    let cycle: Vec<String> = path[pos..].to_vec();
                    let mut key: Vec<String> = cycle.clone();
                    key.sort();
                    let key = key.join("|");
                    if reported.insert(key) {
                        let first = cycle.first().cloned().unwrap_or_default();
                        out.push((first, cycle));
                    }
                }
                break;
            }
            path.push(manifest.processes[current].name.clone());
            // 只走第一个仍在部署内的依赖。
            let next = manifest.processes[current]
                .depends_on
                .iter()
                .find_map(|(dep, _)| index.get(dep.as_str()).copied());
            match next {
                Some(next) => current = next,
                None => break,
            }
        }
    }
    out
}
