//! KODE-CFG-009:core resolve 单元(Rust 侧唯一解析/合并/读值实现)。
//!
//! `resolve_config` = parse + merge + telnet 速览 + 数据库连接要素一次出全;
//! 语义镜像既有 TS 消费面(summarizeFinalTelnet / extractDatabaseInterfaceConfig,
//! 两者在 TS 侧下线后由本模块为唯一真源):
//! - telnet 速览:逐组件(引擎写死表序)读 <telnet_service> 端口/密码,
//!   端口数字非法→null、0 合法保留、密码空→null;组件段在伪根一层或
//!   <root> 包裹二层都找(两候选层,镜像 extractDatabaseInterfaceConfig);
//! - 数据库连接要素:dbmgr>databaseInterfaces>default,encrypt 缺省 true,
//!   明文密码只在 encrypt=false 提取,缺叶回落引擎默认常量。

use kode_parser::config::{db_interface_config, parse_config, resolve_config, telnet_summary};

const DEFAULTS_TELNET: &str = r#"<root>
  <loginapp><telnet_service><port> 31000 </port><password> defpwd </password></telnet_service></loginapp>
  <baseapp><telnet_service><port> 40000 </port><password> pwd1 </password></telnet_service></baseapp>
  <cellapp><telnet_service><port> 0 </port></telnet_service></cellapp>
  <bots><telnet_service><port> abc </port><password>   </password></telnet_service></bots>
  <dbmgr></dbmgr>
</root>"#;

fn entry<'a>(
    summary: &'a [kode_parser::config::TelnetSummaryEntry],
    component: &str,
) -> &'a kode_parser::config::TelnetSummaryEntry {
    summary
        .iter()
        .find(|e| e.component == component)
        .unwrap_or_else(|| panic!("summary missing {component}"))
}

#[test]
fn telnet_summary_reads_ports_and_passwords_with_engine_table_order() {
    let tree = parse_config(DEFAULTS_TELNET).unwrap();
    let summary = telnet_summary(&tree);
    assert_eq!(summary.len(), 7);
    assert_eq!(
        summary
            .iter()
            .map(|e| e.component.as_str())
            .collect::<Vec<_>>(),
        [
            "loginapp",
            "dbmgr",
            "interfaces",
            "logger",
            "baseapp",
            "cellapp",
            "bots"
        ]
    );
    // 端口/密码如实:有则带出
    assert_eq!(entry(&summary, "baseapp").port, Some(40000.0));
    assert_eq!(entry(&summary, "baseapp").password.as_deref(), Some("pwd1"));
    // loginapp 也在(引擎 defaults 全组件段都在)
    assert_eq!(entry(&summary, "loginapp").port, Some(31000.0));
    assert_eq!(
        entry(&summary, "loginapp").password.as_deref(),
        Some("defpwd")
    );
}

#[test]
fn telnet_summary_edge_semantics_mirror_ts() {
    let tree = parse_config(DEFAULTS_TELNET).unwrap();
    let summary = telnet_summary(&tree);
    // 端口 0:数字合法,保留 0(镜像 Number.isFinite 分支)
    assert_eq!(entry(&summary, "cellapp").port, Some(0.0));
    // 非数字端口 → None;空密码 → None
    assert_eq!(entry(&summary, "bots").port, None);
    assert_eq!(entry(&summary, "bots").password, None);
    // 组件段缺 telnet_service → 全 None(不猜)
    assert_eq!(entry(&summary, "dbmgr").port, None);
    assert_eq!(entry(&summary, "dbmgr").password, None);
    // 无 <root> 包裹的合成形态(伪根一层直挂组件段)同样可读
    let flat =
        parse_config("<loginapp><telnet_service><port>31001</port></telnet_service></loginapp>")
            .unwrap();
    let flat_summary = telnet_summary(&flat);
    assert_eq!(entry(&flat_summary, "loginapp").port, Some(31001.0));
}

#[test]
fn telnet_summary_empty_tree_gives_all_nulls() {
    let tree = parse_config("<root><dbmgr><debug>1</debug></dbmgr></root>").unwrap();
    let summary = telnet_summary(&tree);
    assert_eq!(summary.len(), 7);
    assert!(summary
        .iter()
        .all(|e| e.port.is_none() && e.password.is_none()));
}

#[test]
fn db_interface_reads_full_section() {
    let tree = parse_config(
        r#"<root><dbmgr><databaseInterfaces><default>
  <host> 192.168.1.9 </host>
  <port> 3307 </port>
  <auth><username> kbe2 </username><encrypt> false </encrypt><password> plain1 </password></auth>
  <databaseName> kbe2 </databaseName>
  <unicodeString><characterSet> utf8 </characterSet></unicodeString>
</default></databaseInterfaces></dbmgr></root>"#,
    )
    .unwrap();
    let db = db_interface_config(&tree).expect("dbmgr 段在,应可提取");
    assert_eq!(db.host, "192.168.1.9");
    assert_eq!(db.port, 3307.0);
    assert_eq!(db.username, "kbe2");
    assert_eq!(db.database_name, "kbe2");
    assert!(!db.encrypt);
    assert_eq!(db.character_set, "utf8");
    // encrypt=false 才提明文密码
    assert_eq!(db.plain_password.as_deref(), Some("plain1"));
}

#[test]
fn db_interface_defaults_and_encrypt_true_hides_password() {
    let tree = parse_config(
        r#"<root><dbmgr><databaseInterfaces><default>
  <auth><encrypt> true </encrypt><password> rsa-blob </password></auth>
</default></databaseInterfaces></dbmgr></root>"#,
    )
    .unwrap();
    let db = db_interface_config(&tree).expect("dbmgr 段在,应可提取");
    assert_eq!(db.host, "localhost");
    // 端口缺/非法回落 3306
    assert_eq!(db.port, 3306.0);
    assert_eq!(db.username, "kbe");
    assert_eq!(db.database_name, "kbe");
    assert!(db.encrypt);
    // RSA 密文不读不解读
    assert_eq!(db.plain_password, None);
    assert_eq!(db.character_set, "utf8mb4");
}

#[test]
fn db_interface_none_without_section() {
    let tree = parse_config("<root><baseapp><debug>1</debug></baseapp></root>").unwrap();
    assert_eq!(db_interface_config(&tree), None);
}

#[test]
fn resolve_config_parses_merges_and_summarizes() {
    let custom = r#"<loginapp><telnet_service><port> 31001 </port><password> custompwd </password></telnet_service></loginapp>"#;
    let resolved = resolve_config(Some(DEFAULTS_TELNET), Some(custom));
    // defaults 伪根一层是 <root> 包裹、custom 伪根一层直挂组件段:合并后
    // 两层候选都该命中(loginapp 覆盖值从 custom 侧整名替换带出)
    assert!(resolved.custom_tree.is_some());
    assert!(resolved.defaults_tree.is_some());
    let merged = resolved.merged.as_ref().expect("defaults 在,merged 应在");
    assert_eq!(merged.name, "");
    let loginapp = entry(&resolved.telnet_summary, "loginapp");
    assert_eq!(loginapp.port, Some(31001.0));
    assert_eq!(loginapp.password.as_deref(), Some("custompwd"));
    // defaults 侧未被覆盖的 baseapp 保留
    assert_eq!(
        entry(&resolved.telnet_summary, "baseapp").port,
        Some(40000.0)
    );
}

#[test]
fn resolve_config_defaults_only_and_none() {
    let only = resolve_config(Some(DEFAULTS_TELNET), None);
    assert!(only.custom_tree.is_none());
    assert!(only.merged.is_some());
    assert_eq!(entry(&only.telnet_summary, "loginapp").port, Some(31000.0));

    let none = resolve_config(None, None);
    assert!(none.defaults_tree.is_none());
    assert!(none.custom_tree.is_none());
    assert!(none.merged.is_none());
    assert!(none.telnet_summary.is_empty());
    assert_eq!(none.db_interface, None);
}

#[test]
fn custom_telnet_reads_first_document_order_section() {
    let custom = r#"<root>\n  <telnet_service>\n    <port> 40009 </port>\n    <password> secret </password>\n  </telnet_service>\n</root>"#;
    let resolved = resolve_config(None, Some(custom));
    let telnet = resolved.custom_telnet.expect("段在,应可提取");
    assert_eq!(telnet.port, Some(40009.0));
    assert_eq!(telnet.password.as_deref(), Some("secret"));

    // 无段 → None;密码空 → None;端口非法 → None
    let none = resolve_config(None, Some("<root><baseapp/></root>"));
    assert_eq!(none.custom_telnet, None);
    let empty = resolve_config(
        None,
        Some("<root><telnet_service><port> abc </port><password>  </password></telnet_service></root>"),
    );
    let telnet = empty.custom_telnet.expect("段在");
    assert_eq!(telnet.port, None);
    assert_eq!(telnet.password, None);
}
