//! 配置派生单元测试(KODE-CFG-004):`derive_capabilities` 四类能力语义。
//!
//! 覆盖验收两向:
//! - **改配置→派生变**:def 扫描根随定位路径变、telnet 端口随元件段变、
//!   telnet 开关随段有无变、entryScripts 透传 facts;
//! - **配置缺段→回默认派生**:无 telnet 段→关、有段无端口→写死表/defaults
//!   补值、无 res 锚点→工作区根兜底(degraded)、无根无工作区→debug 不 ready。
//!
//! 另覆盖不 panic(路径边界/unicode 防御)。TS 无参考派生实现,本域无 TS 对拍。

use kode_parser::config::parse_config;
use kode_parser::config_derive::{
    derive_capabilities, DeriveFacts, EntryScriptFact, ENGINE_DEFAULT_TELNET_PORTS,
};

/// 解析 XML 为树(测试语料均合法)。
fn parse(xml: &str) -> kode_parser::config::ConfigNode {
    parse_config(xml).expect("应解析出树")
}

/// 便捷:空 facts(workspace/custom 路径均无)。
fn facts<'a>() -> DeriveFacts<'a> {
    DeriveFacts::default()
}

// --- def 扫描根(改配置→派生变) ---

#[test]
fn def_scan_root_derives_from_custom_path() {
    let facts = DeriveFacts {
        custom_config_path: Some("/proj/assets/res/server/kbengine.xml"),
        ..Default::default()
    };
    let cap = derive_capabilities(None, None, &facts);
    assert_eq!(cap.def_scan_roots.roots, vec!["/proj/assets/scripts"]);
    assert!(!cap.def_scan_roots.degraded);
    assert_eq!(cap.def_scan_roots.fallback, None);
}

#[test]
fn def_scan_root_changes_with_path() {
    // 改配置(定位路径)→ 派生变:不同资产根 → 不同扫描根
    let a = derive_capabilities(
        None,
        None,
        &DeriveFacts {
            custom_config_path: Some("/a/res/server/kbengine.xml"),
            ..Default::default()
        },
    );
    let b = derive_capabilities(
        None,
        None,
        &DeriveFacts {
            custom_config_path: Some("/b/deep/res/server/kbengine.xml"),
            ..Default::default()
        },
    );
    assert_eq!(a.def_scan_roots.roots, vec!["/a/scripts"]);
    assert_eq!(b.def_scan_roots.roots, vec!["/b/deep/scripts"]);
    assert_ne!(a.def_scan_roots.roots, b.def_scan_roots.roots);
}

#[test]
fn def_scan_root_res_anchor_is_deepest_segment() {
    // 资产根自身名字含 "res"(reserved) 时,rfind 取最深 res 路径段
    let facts = DeriveFacts {
        custom_config_path: Some("/proj/reserved/res/server/kbengine.xml"),
        ..Default::default()
    };
    let cap = derive_capabilities(None, None, &facts);
    assert_eq!(cap.def_scan_roots.roots, vec!["/proj/reserved/scripts"]);
}

// --- def 扫描根(缺段→回默认派生) ---

#[test]
fn def_scan_root_missing_anchor_falls_back_to_workspace() {
    let facts = DeriveFacts {
        custom_config_path: Some("/flat/kbengine.xml"), // 无 res 段
        workspace_root: Some("/ws"),
        ..Default::default()
    };
    let cap = derive_capabilities(None, None, &facts);
    assert_eq!(cap.def_scan_roots.roots, vec!["/ws"]);
    assert!(cap.def_scan_roots.degraded);
    assert_eq!(
        cap.def_scan_roots.fallback,
        Some("workspaceRoot".to_string())
    );
}

#[test]
fn def_scan_root_no_custom_falls_back_to_workspace() {
    let facts = DeriveFacts {
        custom_config_path: None,
        workspace_root: Some("/ws"),
        ..Default::default()
    };
    let cap = derive_capabilities(None, None, &facts);
    assert_eq!(cap.def_scan_roots.roots, vec!["/ws"]);
    assert!(cap.def_scan_roots.degraded);
    assert_eq!(
        cap.def_scan_roots.fallback,
        Some("workspaceRoot".to_string())
    );
}

#[test]
fn def_scan_root_no_root_no_workspace_is_empty_degraded() {
    let cap = derive_capabilities(None, None, &facts());
    assert!(cap.def_scan_roots.roots.is_empty());
    assert!(cap.def_scan_roots.degraded);
    assert_eq!(
        cap.def_scan_roots.fallback,
        Some("workspaceRoot".to_string())
    );
}

// --- telnet(改配置→派生变) ---

#[test]
fn telnet_disabled_without_section() {
    // 元件无 telnet_service 段 → 关(defaults 段不当开关,批111)
    let custom = parse("<root><baseapp>1</baseapp></root>");
    let defaults = parse(
        "<root><baseapp><telnet_service><port>40000</port></telnet_service></baseapp></root>",
    );
    let cap = derive_capabilities(Some(&custom), Some(&defaults), &facts());
    assert!(!cap.telnet.enabled);
    assert!(cap.telnet.endpoints.is_empty());
}

#[test]
fn telnet_enabled_by_section() {
    // 加段 → 开;去掉 → 关(改配置→派生变)
    let custom = parse("<root><telnet_service><port>40000</port></telnet_service></root>");
    let cap = derive_capabilities(Some(&custom), None, &facts());
    assert!(cap.telnet.enabled);
    assert_eq!(cap.telnet.endpoints.len(), 1);
    assert_eq!(cap.telnet.endpoints[0].port, 40000);
    assert_eq!(cap.telnet.endpoints[0].component, "kbengine.xml");
    assert_eq!(cap.telnet.endpoints[0].host, "127.0.0.1");
}

#[test]
fn telnet_port_change_updates_endpoint() {
    // 改配置(端口)→ 派生变
    let c1 = parse("<root><telnet_service><port>40000</port></telnet_service></root>");
    let c2 = parse("<root><telnet_service><port>40001</port></telnet_service></root>");
    let a = derive_capabilities(Some(&c1), None, &facts());
    let b = derive_capabilities(Some(&c2), None, &facts());
    assert_eq!(a.telnet.endpoints[0].port, 40000);
    assert_eq!(b.telnet.endpoints[0].port, 40001);
}

#[test]
fn telnet_password_sets_flag() {
    let with_pwd = parse(
        "<root><telnet_service><port>40000</port><password>pwd</password></telnet_service></root>",
    );
    let no_pwd = parse("<root><telnet_service><port>40000</port></telnet_service></root>");
    let a = derive_capabilities(Some(&with_pwd), None, &facts());
    let b = derive_capabilities(Some(&no_pwd), None, &facts());
    assert!(a.telnet.endpoints[0].password_set);
    assert!(!b.telnet.endpoints[0].password_set);
}

// --- telnet(缺段→回默认派生) ---

#[test]
fn telnet_section_without_port_uses_writein_table() {
    // 有段无端口 → 逐组件写死表(无 defaults)
    let custom = parse("<root><telnet_service></telnet_service></root>");
    let cap = derive_capabilities(Some(&custom), None, &facts());
    assert!(cap.telnet.enabled);
    assert_eq!(
        cap.telnet.endpoints.len(),
        ENGINE_DEFAULT_TELNET_PORTS.len()
    );
    for (i, (component, writein)) in ENGINE_DEFAULT_TELNET_PORTS.iter().enumerate() {
        assert_eq!(cap.telnet.endpoints[i].component, *component);
        assert_eq!(cap.telnet.endpoints[i].port, *writein);
    }
}

#[test]
fn telnet_section_without_port_uses_defaults_ports() {
    // 有段无端口 + defaults 逐组件补值(批112:defaults 优先于写死表)
    let custom = parse("<root><telnet_service></telnet_service></root>");
    let defaults = parse(
        "<root>\
         <baseapp><telnet_service><port>40009</port></telnet_service></baseapp>\
         </root>",
    );
    let cap = derive_capabilities(Some(&custom), Some(&defaults), &facts());
    let baseapp = cap
        .telnet
        .endpoints
        .iter()
        .find(|e| e.component == "baseapp")
        .unwrap();
    assert_eq!(baseapp.port, 40009);
    // 未在 defaults 出现的组件回落写死表
    let cellapp = cap
        .telnet
        .endpoints
        .iter()
        .find(|e| e.component == "cellapp")
        .unwrap();
    let cellapp_writein = ENGINE_DEFAULT_TELNET_PORTS
        .iter()
        .find(|(c, _)| *c == "cellapp")
        .unwrap()
        .1;
    assert_eq!(cellapp.port, cellapp_writein);
}

#[test]
fn telnet_section_nested_component_matches_regex_first() {
    // 镜像正则「首个 <telnet_service> 任意处」:嵌套段亦被读到
    let custom = parse(
        "<root><baseapp><telnet_service><port>40001</port></telnet_service></baseapp></root>",
    );
    let cap = derive_capabilities(Some(&custom), None, &facts());
    assert!(cap.telnet.enabled);
    assert_eq!(cap.telnet.endpoints[0].port, 40001);
}

// --- entryScripts(透传 facts) ---

#[test]
fn entry_scripts_passthrough_from_facts() {
    let facts = DeriveFacts {
        entry_scripts: vec![
            EntryScriptFact {
                process: "baseapp".to_string(),
                module: "kbengine".to_string(),
                path: Some("/p/scripts/kbengine.py".to_string()),
                exists: true,
            },
            EntryScriptFact {
                process: "cellapp".to_string(),
                module: "kbemain".to_string(),
                path: None,
                exists: false,
            },
        ],
        ..Default::default()
    };
    let cap = derive_capabilities(None, None, &facts);
    assert_eq!(cap.entry_scripts.len(), 2);
    assert_eq!(cap.entry_scripts[0].process, "baseapp");
    assert_eq!(
        cap.entry_scripts[0].path.as_deref(),
        Some("/p/scripts/kbengine.py")
    );
    assert!(!cap.entry_scripts[1].exists);
}

// --- debug 就绪 ---

#[test]
fn debug_ready_clean_derivation() {
    let facts = DeriveFacts {
        custom_config_path: Some("/p/res/server/kbengine.xml"),
        ..Default::default()
    };
    let cap = derive_capabilities(None, None, &facts);
    assert!(cap.debug.ready);
    assert!(cap.debug.reasons.is_empty());
}

#[test]
fn debug_not_ready_when_no_scan_root() {
    // 无 res 锚点且无工作区根 → 致命缺失 → 不 ready
    let cap = derive_capabilities(None, None, &facts());
    assert!(!cap.debug.ready);
    assert!(cap
        .debug
        .reasons
        .iter()
        .any(|r| r.contains("no def scan root")));
}

#[test]
fn debug_degraded_but_ready_with_reason() {
    // 降级(工作区兜底)不阻塞,ready 仍 true,reasons 给可读原因
    let facts = DeriveFacts {
        custom_config_path: None,
        workspace_root: Some("/ws"),
        ..Default::default()
    };
    let cap = derive_capabilities(None, None, &facts);
    assert!(cap.debug.ready);
    assert!(cap.debug.reasons.iter().any(|r| r.contains("degraded")));
}

#[test]
fn debug_reason_for_missing_entry_script() {
    let facts = DeriveFacts {
        custom_config_path: Some("/p/res/server/kbengine.xml"),
        entry_scripts: vec![EntryScriptFact {
            process: "baseapp".to_string(),
            module: "kbengine".to_string(),
            path: None,
            exists: false,
        }],
        ..Default::default()
    };
    let cap = derive_capabilities(None, None, &facts);
    assert!(cap.debug.ready); // 入口缺失不致命(断点不预填)
    assert!(cap
        .debug
        .reasons
        .iter()
        .any(|r| r.contains("entry script missing")));
}

// --- 不 panic 防御(铁律) ---

#[test]
fn weird_paths_do_not_panic() {
    for path in [
        "",
        "/",
        "res",
        "/res",
        "res/",
        "/res/",
        "/x/res",
        "/x/res/",
        "resources/server/kbengine.xml", // res 非段(resources 中) → 无锚点
        "/res/res/server/kbengine.xml",  // 最深 res 段
        "/空间/资源/server/kbengine.xml", // unicode 路径
        "C:\\res\\server\\kbengine.xml", // 反斜杠分隔(非路径界)
        "a b/res/server/kbengine.xml",
    ] {
        let facts = DeriveFacts {
            custom_config_path: Some(path),
            workspace_root: Some("/ws"),
            ..Default::default()
        };
        let cap = derive_capabilities(None, None, &facts);
        let _ = cap; // 不 panic 即过
    }
}

#[test]
fn empty_custom_section_does_not_panic() {
    // 空 <telnet_service/> 自闭合、无 port/password
    let custom = parse("<root><telnet_service/></root>");
    let cap = derive_capabilities(Some(&custom), None, &facts());
    assert!(cap.telnet.enabled);
    assert_eq!(
        cap.telnet.endpoints.len(),
        ENGINE_DEFAULT_TELNET_PORTS.len()
    );
    assert!(!cap.telnet.endpoints[0].password_set);
}

#[test]
fn non_numeric_port_treated_as_absent() {
    // "abc" 端口 → 非数 → 视为未指定(硬化;TS 的 NaN 是退化态)
    let custom = parse("<root><telnet_service><port>abc</port></telnet_service></root>");
    let cap = derive_capabilities(Some(&custom), None, &facts());
    assert_eq!(
        cap.telnet.endpoints.len(),
        ENGINE_DEFAULT_TELNET_PORTS.len()
    );
    // 回落写死表首个组件端口
    assert_eq!(
        cap.telnet.endpoints[0].port,
        ENGINE_DEFAULT_TELNET_PORTS[0].1
    );
}

// --- 真实 fixture 集成(树遍历在真实数据上,注释/<root> 包裹/空白) ---

#[test]
fn real_defaults_per_component_telnet_ports() {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root");
    let defaults_xml =
        std::fs::read_to_string(repo_root.join("tests/fixtures/config/kbengine_defaults.xml"))
            .expect("真实 defaults 缺失");
    let defaults = parse_config(&defaults_xml).expect("真实 defaults 应可解析");

    // 真实 defaults 无顶层 <telnet_service>(只有逐组件),不当开关
    let no_custom = derive_capabilities(None, Some(&defaults), &facts());
    assert!(!no_custom.telnet.enabled);
    assert!(no_custom.telnet.endpoints.is_empty());

    // 自定义开 telnet 无端口 → 逐组件取真实 defaults 端口(全 7 组件)
    let custom = parse("<root><telnet_service/></root>");
    let cap = derive_capabilities(Some(&custom), Some(&defaults), &facts());
    assert!(cap.telnet.enabled);
    assert_eq!(
        cap.telnet.endpoints.len(),
        ENGINE_DEFAULT_TELNET_PORTS.len()
    );
    for (component, _) in ENGINE_DEFAULT_TELNET_PORTS {
        let endpoint = cap
            .telnet
            .endpoints
            .iter()
            .find(|e| e.component == *component)
            .unwrap();
        assert!(endpoint.port > 0, "组件 {component} 应有正端口");
        assert_eq!(endpoint.host, "127.0.0.1");
    }
}

// --- database(CLONE-P5 骨架:Rust 读引擎配置派生连接,镜像 extractDatabaseInterfaceConfig) ---

#[test]
fn database_defaults_only_derives_engine_interface() {
    // 引擎 defaults 完整段 → 全要素可得;encrypt=true(默认)→ 密文明文不可读。
    let defaults = parse(
        "<root><dbmgr><databaseInterfaces><default>\
         <pure>false</pure><type>mysql</type><host>localhost</host><port>0</port>\
         <auth><username>kbe</username><password>pwd123456</password><encrypt>true</encrypt></auth>\
         <databaseName>kbe</databaseName><numConnections>5</numConnections>\
         <unicodeString><characterSet>utf8mb4</characterSet><collation>utf8mb4_bin</collation></unicodeString>\
         </default></databaseInterfaces></dbmgr></root>",
    );
    let cap = derive_capabilities(None, Some(&defaults), &facts());
    assert!(cap.database.available);
    assert_eq!(cap.database.db_type, "mysql");
    assert_eq!(cap.database.host, "localhost");
    // 引擎语义:端口 0 → mysql 默认 3306
    assert_eq!(cap.database.port, 3306);
    assert_eq!(cap.database.username, "kbe");
    assert_eq!(cap.database.database_name, "kbe");
    assert_eq!(cap.database.character_set, "utf8mb4");
    assert!(cap.database.encrypt);
    assert!(!cap.database.password_available);
}

#[test]
fn database_custom_overrides_defaults_per_leaf() {
    // 改配置(元件 kbengine.xml 非空叶子)→ 派生变:custom host/port 覆盖,
    // 未覆盖的 username/databaseName 沿 defaults。
    let defaults = parse(
        "<root><dbmgr><databaseInterfaces><default><host>db.internal</host><port>13306</port>\
         <auth><username>kbe</username></auth><databaseName>kbe</databaseName></default>\
         </databaseInterfaces></dbmgr></root>",
    );
    let custom = parse(
        "<root><dbmgr><databaseInterfaces><default><host>127.0.0.1</host><port>3307</port>\
         </default></databaseInterfaces></dbmgr></root>",
    );
    let cap = derive_capabilities(Some(&custom), Some(&defaults), &facts());
    assert_eq!(cap.database.host, "127.0.0.1");
    assert_eq!(cap.database.port, 3307);
    assert_eq!(cap.database.username, "kbe");
    assert_eq!(cap.database.database_name, "kbe");
}

#[test]
fn database_plaintext_password_marks_available() {
    // encrypt=false(明文配置)且有非空密码 → password_available=true;
    // 派生面不回传明文值(结构里没有该字段,由编译器保证)。
    let defaults = parse(
        "<root><dbmgr><databaseInterfaces><default><host>localhost</host>\
         <auth><username>kbe</username><password>plain</password><encrypt>false</encrypt></auth>\
         </default></databaseInterfaces></dbmgr></root>",
    );
    let cap = derive_capabilities(None, Some(&defaults), &facts());
    assert!(!cap.database.encrypt);
    assert!(cap.database.password_available);
    // 改配置:encrypt 回 true → 明文不可读
    let encrypted = parse(
        "<root><dbmgr><databaseInterfaces><default>\
         <auth><password>rsa-cipher</password><encrypt>true</encrypt></auth>\
         </default></databaseInterfaces></dbmgr></root>",
    );
    let cap2 = derive_capabilities(None, Some(&encrypted), &facts());
    assert!(cap2.database.encrypt);
    assert!(!cap2.database.password_available);
}

#[test]
fn database_missing_section_falls_back_to_engine_constants() {
    // 无 dbmgr/databaseInterfaces/default 段 → available=false,叶子回落引擎
    // 常量(与 TS extractDatabaseInterfaceConfig 返回 null 的语义对应:展示面
    // 如实标「未找到配置段」,不虚构连接)。
    let custom = parse("<root><baseapp>1</baseapp></root>");
    let cap = derive_capabilities(Some(&custom), None, &facts());
    assert!(!cap.database.available);
    assert_eq!(cap.database.host, "localhost");
    assert_eq!(cap.database.port, 3306);
    assert_eq!(cap.database.username, "kbe");
    assert_eq!(cap.database.database_name, "kbe");
    assert_eq!(cap.database.character_set, "utf8mb4");
    assert_eq!(cap.database.db_type, "mysql");
}

#[test]
fn database_redis_type_is_reported_but_not_connectable() {
    // type=redis 如实上报(连接面仅 mysql,UI 据此不建连)。
    let defaults = parse(
        "<root><dbmgr><databaseInterfaces><default><type>redis</type><host>r1</host>\
         </default></databaseInterfaces></dbmgr></root>",
    );
    let cap = derive_capabilities(None, Some(&defaults), &facts());
    assert_eq!(cap.database.db_type, "redis");
    assert_eq!(cap.database.host, "r1");
}

#[test]
fn database_invalid_port_falls_back_to_3306() {
    // 端口非法文本(非数字)→ 与 0 同语义:3306(NaN>0 为假,TS 同口径)。
    let defaults = parse(
        "<root><dbmgr><databaseInterfaces><default><port>not-a-number</port>\
         </default></databaseInterfaces></dbmgr></root>",
    );
    let cap = derive_capabilities(None, Some(&defaults), &facts());
    assert_eq!(cap.database.port, 3306);
}
