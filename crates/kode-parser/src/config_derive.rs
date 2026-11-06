//! 配置派生(KODE-CFG-004):解析后的配置树 → `DeriveCapabilities`。
//!
//! 纯函数、零第三方依赖、不 panic(沿用本 crate 铁律)。逐语义对齐设计文档
//! `docs/design/config-first.md` §2.2/§2.5 与 §5.2 的 `DeriveCapabilities` 形状,
//! 并镜像 TS 侧既有实现:
//!
//! - **def 扫描根**:`server/kbengine.xml` 命中段 → `rfind("res")` 截断(锚点 =
//!   `res` 路径段)后拼 `scripts/`(resmgr.cpp:489-499);命中失败 → degraded +
//!   工作区根兜底。`assets/res` 与 `assets/scripts` 为兄弟目录,故截断在
//!   `res` 段**起点**(保留父目录),而非段后——否则 scripts 会落进 res 内,
//!   与「去掉 /scripts 即 assets 根」矛盾。
//! - **telnet**:开关 = 元件 `kbengine.xml` 有顶层 `<telnet_service>` 段
//!   (批111 口径:defaults 段只补值,不当开关);端口 = 元件段显式端口 >
//!   defaults 逐组件端口 > 写死引擎默认端口表(镜像 `ENGINE_DEFAULT_TELNET_PORTS`)。
//! - **entryScripts**:透传 TS 探测的 facts(路径存在性/入口定位,core 不查询)。
//! - **debug 就绪**:派生无致命缺失 → ready;致命 = 无任何可扫描根(无 res 锚点
//!   且无工作区根)。降级(扫描根回退/入口缺失)记 reasons,不阻塞。
//!
//! TS 侧 settings 半(host 覆盖/显式 port/命令白名单)与存在性校验留 TS(设计
//! §4 #24/#28);本模块只做派生半。TS 无参考派生实现,故本域无 TS 对拍,验收为
//! 单测覆盖「改配置→派生变」与「配置缺段→回默认派生」两向。

use crate::config::ConfigNode;

/// 引擎语义常量:组件 telnet 默认端口表(镜像 TS `ENGINE_DEFAULT_TELNET_PORTS`,
/// `src/telnetService.ts:37`;设计 §4 #26 归 Rust core)。
pub const ENGINE_DEFAULT_TELNET_PORTS: &[(&str, u16)] = &[
    ("loginapp", 31000),
    ("dbmgr", 32000),
    ("interfaces", 33000),
    ("logger", 34000),
    ("baseapp", 40000),
    ("cellapp", 50000),
    ("bots", 51000),
];

/// 逐进程入口模块探测结果(TS 已按约定/索引定位,core 不查询)。
#[derive(Debug, Clone, PartialEq)]
pub struct EntryScriptFact {
    pub process: String,
    pub module: String,
    /// 定位到的路径;null = 未定位到
    pub path: Option<String>,
    pub exists: bool,
}

/// 派生静态输入(TS 探测;core 不发起任何查询,设计 §3.3-4)。
#[derive(Debug, Default)]
pub struct DeriveFacts<'a> {
    /// 工作区根(扫描根兜底)
    pub workspace_root: Option<&'a str>,
    /// 元件 `kbengine.xml` 定位路径(`{assets}/res/server/kbengine.xml`);
    /// None = 无自定义配置(defaults-only)
    pub custom_config_path: Option<&'a str>,
    /// 逐进程入口定位
    pub entry_scripts: Vec<EntryScriptFact>,
}

/// def 扫描根(设计 §5.2 `defScanRoots` 形状)。
#[derive(Debug, Clone, PartialEq)]
pub struct DefScanRoots {
    pub roots: Vec<String>,
    /// 兜底策略名;degraded 时为 `Some("workspaceRoot")`,否则 None
    pub fallback: Option<String>,
    pub degraded: bool,
}

/// telnet 端点(派生半;host 为引擎默认,settings 覆盖留 TS)。
#[derive(Debug, Clone, PartialEq)]
pub struct TelnetEndpoint {
    pub component: String,
    pub host: String,
    pub port: u16,
    pub password_set: bool,
}

/// telnet 能力(设计 §5.2 `telnet` 形状)。
#[derive(Debug, Clone, PartialEq)]
pub struct TelnetCapabilities {
    pub enabled: bool,
    pub endpoints: Vec<TelnetEndpoint>,
}

/// debug 就绪(设计 §5.2 `debug` 形状;计算归 Rust core,展示留 TS)。
#[derive(Debug, Clone, PartialEq)]
pub struct DebugReady {
    pub ready: bool,
    pub reasons: Vec<String>,
}

/// 数据库连接档案(CLONE-P5 骨架,用户令 2026-11-06:Rust 读引擎配置派生
/// MySQL 连接;镜像 TS `extractDatabaseInterfaceConfig`,`serverConfigMerge.ts:538`)。
///
/// 只取 `<dbmgr><databaseInterfaces><default>`(与 TS 同口径;多接口后续按需)。
/// 密码**不回传明文**(镜像 telnet `passwordSet` 口径):`password_available`
/// 仅表示「encrypt=false 且配置有非空明文可连」;明文由 TS 连接面就地读同
/// 一份引擎配置(RSA 密文两侧都不解读)。
#[derive(Debug, Clone, PartialEq)]
pub struct DatabaseProfile {
    /// `dbmgr/databaseInterfaces/default` 段是否可得(不可得=引擎配置未找到,
    /// 其余字段回落引擎叶子缺省,如实展示「未找到配置段」)。
    pub available: bool,
    /// `<type>`(mysql/redis);redis 只展示不建连(连接面仅 mysql)。
    pub db_type: String,
    pub host: String,
    /// 已按引擎语义落定:0/非法/缺省 → 3306(db_interface_mysql.cpp:166-167)。
    pub port: u16,
    pub username: String,
    pub database_name: String,
    pub character_set: String,
    /// `<auth><encrypt>` 非 `false` 即 true(引擎默认 RSA 密文)。
    pub encrypt: bool,
    /// encrypt=false 且 `<auth><password>` 非空 → true(明文可连,不回传值)。
    pub password_available: bool,
}

/// 派生能力集合(设计 §5.2 `derive` 形状)。
#[derive(Debug, Clone, PartialEq)]
pub struct DeriveCapabilities {
    pub def_scan_roots: DefScanRoots,
    pub telnet: TelnetCapabilities,
    pub database: DatabaseProfile,
    pub entry_scripts: Vec<EntryScriptFact>,
    pub debug: DebugReady,
}

/// 派生入口:由元件树 + 引擎 defaults 树 + TS 探测 facts 计算四类能力。
///
/// `custom_tree` = 元件 `kbengine.xml` 解析树(None = 无自定义配置);
/// `defaults_tree` = 引擎 `kbengine_defaults.xml` 解析树(None = 引擎不可知,
/// 仅用于 telnet 端口补值)。纯函数,无 fs 回调、无 vscode、无跨请求状态。
pub fn derive_capabilities(
    custom_tree: Option<&ConfigNode>,
    defaults_tree: Option<&ConfigNode>,
    facts: &DeriveFacts,
) -> DeriveCapabilities {
    let def_scan_roots = derive_def_scan_roots(facts);
    let telnet = derive_telnet(custom_tree, defaults_tree);
    let database = derive_database(custom_tree, defaults_tree);
    let entry_scripts = facts.entry_scripts.clone();
    let debug = derive_debug(&def_scan_roots, &entry_scripts);
    DeriveCapabilities {
        def_scan_roots,
        telnet,
        database,
        entry_scripts,
        debug,
    }
}

/// 找路径中最后一个「res」路径段起点(前为起/路径界、后为路径界/止)。
/// 返回该段 `r` 的字节下标。空路径/无段 → None。不 panic(逐字节扫 ASCII,
/// 只在字符界切串)。
fn find_res_segment_start(path: &str) -> Option<usize> {
    let bytes = path.as_bytes();
    let mut found = None;
    let mut i = 0;
    while i + 3 <= bytes.len() {
        if bytes[i] == b'r' && bytes[i + 1] == b'e' && bytes[i + 2] == b's' {
            let prev_ok = i == 0 || bytes[i - 1] == b'/';
            let after = i + 3;
            let next_ok = after == bytes.len() || bytes[after] == b'/';
            if prev_ok && next_ok {
                found = Some(i);
            }
        }
        i += 1;
    }
    // 只可能落在字符界(前为起或 '/'),仍防御校验
    found.filter(|&i| path.is_char_boundary(i))
}

/// 由元件 `kbengine.xml` 定位路径派生 def 扫描根:
/// `rfind("res")` 截断(锚点 = res 路径段起点)后拼 `scripts/`。
fn scripts_root_from_config_path(path: &str) -> Option<String> {
    let start = find_res_segment_start(path)?;
    let parent = path[..start].trim_end_matches('/');
    Some(format!("{parent}/scripts"))
}

fn derive_def_scan_roots(facts: &DeriveFacts) -> DefScanRoots {
    match facts
        .custom_config_path
        .and_then(scripts_root_from_config_path)
    {
        Some(root) => DefScanRoots {
            roots: vec![root],
            fallback: None,
            degraded: false,
        },
        None => {
            let roots: Vec<String> = facts
                .workspace_root
                .map(str::to_string)
                .into_iter()
                .collect();
            DefScanRoots {
                roots,
                fallback: Some("workspaceRoot".to_string()),
                degraded: true,
            }
        }
    }
}

/// 元件 `kbengine.xml` 顶层 `<telnet_service>` 段读值(镜像
/// `parseKbengineXmlTelnet`,`telnetService.ts:70`;树内按文档序找首段,
/// 与正则「首个 `<telnet_service>`」一致)。端口只收正有限整数(0/负/非数
/// 视为未指定——TS 的 NaN 端口是退化态,Rust 以 `Option<u16>` 无法表示,
/// 此处硬化处理,文档化差异)。
struct CustomTelnet {
    port: Option<u16>,
    password: Option<String>,
}

/// 文档序首个名匹配的节点(深度优先;镜像正则首个 `<name>` 出现)。
fn first_node<'a>(node: &'a ConfigNode, name: &str) -> Option<&'a ConfigNode> {
    for child in &node.children {
        if child.name == name {
            return Some(child);
        }
    }
    for child in &node.children {
        if let Some(found) = first_node(child, name) {
            return Some(found);
        }
    }
    None
}

fn read_custom_telnet(tree: &ConfigNode) -> Option<CustomTelnet> {
    let section = first_node(tree, "telnet_service")?;
    let pick = |name: &str| {
        section
            .children
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.text.trim().to_string())
            .filter(|t| !t.is_empty())
    };
    let port = pick("port")
        .as_deref()
        .and_then(|t| t.parse::<u16>().ok())
        .filter(|p| *p > 0);
    Some(CustomTelnet {
        port,
        password: pick("password"),
    })
}

/// 引擎 defaults 逐组件 telnet 读值(镜像 `parseKbengineDefaultsTelnet`,
/// `telnetService.ts:104`;端口 = Number(text) 且 >0,密码取首非空)。
struct DefaultsTelnet {
    ports: std::collections::HashMap<String, u16>,
    password: Option<String>,
}

fn read_defaults_telnet(tree: &ConfigNode) -> Option<DefaultsTelnet> {
    let mut ports = std::collections::HashMap::new();
    let mut password = None;
    for (component, _) in ENGINE_DEFAULT_TELNET_PORTS {
        // 镜像正则 `<component>…</component>`:文档序首个(任意深度,含
        // `<root>` 包裹层下)——与 parseKbengineDefaultsTelnet 的首个出现一致。
        let Some(comp) = first_node(tree, component) else {
            continue;
        };
        let Some(telnet) = comp.children.iter().find(|c| c.name == "telnet_service") else {
            continue;
        };
        let port_text = telnet
            .children
            .iter()
            .find(|c| c.name == "port")
            .map(|c| c.text.trim().to_string());
        if let Some(t) = &port_text {
            if let Ok(port) = t.parse::<u16>() {
                if port > 0 {
                    ports.insert((*component).to_string(), port);
                }
            }
        }
        if password.is_none() {
            let pwd = telnet
                .children
                .iter()
                .find(|c| c.name == "password")
                .map(|c| c.text.trim().to_string())
                .unwrap_or_default();
            if !pwd.is_empty() {
                password = Some(pwd);
            }
        }
    }
    if ports.is_empty() && password.is_none() {
        None
    } else {
        Some(DefaultsTelnet { ports, password })
    }
}

fn derive_telnet(
    custom_tree: Option<&ConfigNode>,
    defaults_tree: Option<&ConfigNode>,
) -> TelnetCapabilities {
    let xml = custom_tree.and_then(read_custom_telnet);
    let defaults_info = defaults_tree.and_then(read_defaults_telnet);
    let enabled = xml.is_some();
    let mut endpoints = Vec::new();
    if let Some(xml) = &xml {
        let password = xml.password.as_deref().unwrap_or("");
        let defaults_password = defaults_info
            .as_ref()
            .and_then(|d| d.password.as_deref())
            .unwrap_or("");
        let password_set = !password.is_empty() || !defaults_password.is_empty();
        if let Some(port) = xml.port {
            // 显式端口:单目标,component 标为来源(镜像 buildTelnetTargets 的
            // label 口径;settings 半的「自定义目标」留 TS)。
            endpoints.push(TelnetEndpoint {
                component: "kbengine.xml".to_string(),
                host: "127.0.0.1".to_string(),
                port,
                password_set,
            });
        } else {
            // 无显式端口:逐组件端口 = defaults 补值 > 写死表(批112 口径)。
            for (component, writein) in ENGINE_DEFAULT_TELNET_PORTS {
                let port = defaults_info
                    .as_ref()
                    .and_then(|d| d.ports.get(*component).copied())
                    .unwrap_or(*writein);
                endpoints.push(TelnetEndpoint {
                    component: (*component).to_string(),
                    host: "127.0.0.1".to_string(),
                    port,
                    password_set,
                });
            }
        }
    }
    TelnetCapabilities { enabled, endpoints }
}

/// 引擎叶子缺省(镜像 TS `ENGINE_DB_INTERFACE_DEFAULTS`,
/// kbengine_defaults.xml `<dbmgr><databaseInterfaces><default>`)。
const ENGINE_DB_HOST: &str = "localhost";
const ENGINE_DB_PORT: u16 = 3306;
const ENGINE_DB_USERNAME: &str = "kbe";
const ENGINE_DB_NAME: &str = "kbe";
const ENGINE_DB_CHARSET: &str = "utf8mb4";
const ENGINE_DB_TYPE: &str = "mysql";

/// 一份配置树里的 default 接口原始叶子(缺省 None;已 trim,空文本当 None)。
struct RawDbInterface {
    db_type: Option<String>,
    host: Option<String>,
    port_text: Option<String>,
    username: Option<String>,
    password: Option<String>,
    encrypt_text: Option<String>,
    database_name: Option<String>,
    character_set: Option<String>,
}

fn read_default_interface(tree: Option<&ConfigNode>) -> Option<RawDbInterface> {
    let dbmgr = tree.and_then(|t| first_node(t, "dbmgr"))?;
    // 与 TS 同口径:databaseInterfaces 与 default 都是 dbmgr 的**直接**子节点。
    let interfaces = dbmgr
        .children
        .iter()
        .find(|c| c.name == "databaseInterfaces")?;
    let iface = interfaces.children.iter().find(|c| c.name == "default")?;
    let leaf = |name: &str| {
        iface
            .children
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.text.trim().to_string())
            .filter(|t| !t.is_empty())
    };
    let auth = iface.children.iter().find(|c| c.name == "auth");
    let auth_leaf = |name: &str| {
        auth.and_then(|a| {
            a.children
                .iter()
                .find(|c| c.name == name)
                .map(|c| c.text.trim().to_string())
                .filter(|t| !t.is_empty())
        })
    };
    let unicode = iface.children.iter().find(|c| c.name == "unicodeString");
    let charset = unicode.and_then(|u| {
        u.children
            .iter()
            .find(|c| c.name == "characterSet")
            .map(|c| c.text.trim().to_string())
            .filter(|t| !t.is_empty())
    });
    Some(RawDbInterface {
        db_type: leaf("type"),
        host: leaf("host"),
        port_text: leaf("port"),
        username: auth_leaf("username"),
        password: auth_leaf("password"),
        encrypt_text: auth_leaf("encrypt"),
        database_name: leaf("databaseName"),
        character_set: charset,
    })
}

/// 数据库连接档案派生(CLONE-P5 骨架):`dbmgr/databaseInterfaces/default`
/// 连接要素,custom(元件 kbengine.xml)非空叶子覆盖 defaults,叶子缺省回落
/// 引擎常量;端口 0/非法/缺省 → 3306;encrypt 非 `false` 即密文(默认)。
/// 密码不回传值——`password_available` 仅标记「明文可读」(encrypt=false 且
/// 非空),明文由 TS 连接面读同一份引擎配置,两侧都不解读 RSA 密文。
fn derive_database(
    custom_tree: Option<&ConfigNode>,
    defaults_tree: Option<&ConfigNode>,
) -> DatabaseProfile {
    let defaults_raw = read_default_interface(defaults_tree);
    let custom_raw = read_default_interface(custom_tree);
    let available = defaults_raw.is_some() || custom_raw.is_some();
    let pick = |custom: Option<String>, defaults: Option<String>| -> Option<String> {
        custom.or(defaults)
    };
    let db_type = pick(
        custom_raw.as_ref().and_then(|r| r.db_type.clone()),
        defaults_raw.as_ref().and_then(|r| r.db_type.clone()),
    )
    .unwrap_or_else(|| ENGINE_DB_TYPE.to_string());
    let host = pick(
        custom_raw.as_ref().and_then(|r| r.host.clone()),
        defaults_raw.as_ref().and_then(|r| r.host.clone()),
    )
    .unwrap_or_else(|| ENGINE_DB_HOST.to_string());
    let port_text = pick(
        custom_raw.as_ref().and_then(|r| r.port_text.clone()),
        defaults_raw.as_ref().and_then(|r| r.port_text.clone()),
    );
    let port = port_text
        .as_deref()
        .and_then(|t| t.parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(ENGINE_DB_PORT);
    let username = pick(
        custom_raw.as_ref().and_then(|r| r.username.clone()),
        defaults_raw.as_ref().and_then(|r| r.username.clone()),
    )
    .unwrap_or_else(|| ENGINE_DB_USERNAME.to_string());
    let database_name = pick(
        custom_raw.as_ref().and_then(|r| r.database_name.clone()),
        defaults_raw.as_ref().and_then(|r| r.database_name.clone()),
    )
    .unwrap_or_else(|| ENGINE_DB_NAME.to_string());
    let character_set = pick(
        custom_raw.as_ref().and_then(|r| r.character_set.clone()),
        defaults_raw.as_ref().and_then(|r| r.character_set.clone()),
    )
    .unwrap_or_else(|| ENGINE_DB_CHARSET.to_string());
    // encrypt:引擎语义「非 false 即密文」(缺省 = true,TS 同口径)。
    let encrypt_text = pick(
        custom_raw.as_ref().and_then(|r| r.encrypt_text.clone()),
        defaults_raw.as_ref().and_then(|r| r.encrypt_text.clone()),
    );
    let encrypt = encrypt_text
        .map(|t| !t.eq_ignore_ascii_case("false"))
        .unwrap_or(true);
    let password = pick(
        custom_raw.as_ref().and_then(|r| r.password.clone()),
        defaults_raw.as_ref().and_then(|r| r.password.clone()),
    );
    let password_available = !encrypt && password.is_some();
    DatabaseProfile {
        available,
        db_type,
        host,
        port,
        username,
        database_name,
        character_set,
        encrypt,
        password_available,
    }
}

fn derive_debug(def: &DefScanRoots, entry_scripts: &[EntryScriptFact]) -> DebugReady {
    let mut reasons = Vec::new();
    if def.degraded {
        reasons.push("def scan root degraded: workspace root fallback".to_string());
    }
    for es in entry_scripts {
        if !es.exists {
            reasons.push(format!(
                "entry script missing: {}/{}",
                es.process, es.module
            ));
        }
    }
    // 致命:无任何可扫描根(无 res 锚点且无工作区根)——派生无法继续。
    let fatal = def.roots.is_empty();
    if fatal {
        reasons.push("no def scan root (no res anchor and no workspace root)".to_string());
    }
    DebugReady {
        ready: !fatal,
        reasons,
    }
}
