//! `process_topology` 核心单测(C-17 定义期错配预警)。
//!
//! 覆盖:清单解析(span 行)、旗标→域映射、实体闭包内容推导(接口/父链/
//! 组件并入)、校验规则 M1-M6/D1-D3/O1-O2 逐条(码+文件+精确行)、正确拓扑
//! 零发现、无清单零发现、畸形清单不 panic、依赖成环 M6。

use std::path::PathBuf;

use kode_server::process_topology::{validate_process_topology, DefInput};

fn fixture(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // crates/kode-server → crates
    p.pop(); // crates → workspace 根
    p.push("tests/fixtures/process-topology");
    p.push(name);
    p
}

fn def_path(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.pop();
    p.push("tests/fixtures/kbengine-demo-assets/scripts/entity_defs");
    p.push(format!("{name}.def"));
    p
}

fn read(name: &str) -> String {
    std::fs::read_to_string(def_path(name)).unwrap_or_else(|_| panic!("missing def {name}"))
}

/// demo-assets 实体 def 集(Avatar/Monster/Account 为演示主体)。
fn demo_defs() -> Vec<DefInput> {
    [
        ("Avatar", "entity"),
        ("Monster", "entity"),
        ("Account", "entity"),
        ("TrainingAvatar", "entity"),
        ("TrainingMonster", "entity"),
        ("EliteMonster", "entity"),
    ]
    .iter()
    .map(|(name, category)| DefInput {
        name: (*name).to_string(),
        category: (*category).to_string(),
        file_path: format!("/defs/entity_defs/{name}.def"),
        text: read(name),
    })
    .collect()
}

const DEMO_ENTITIES_XML: &str = r#"<root>
  <Account hasClient="true"></Account>
  <Avatar hasBase="true" hasCell="true" hasClient="true"></Avatar>
  <Monster hasCell="true"></Monster>
  <TrainingAvatar hasBase="true" hasCell="true" hasClient="true"></TrainingAvatar>
  <TrainingMonster hasCell="true"></TrainingMonster>
  <EliteMonster hasCell="true"></EliteMonster>
</root>"#;

fn validate_manifest(xml: &str) -> Vec<kode_server::process_topology::Finding> {
    validate_process_topology(xml, Some(DEMO_ENTITIES_XML), demo_defs())
}

fn codes(findings: &[kode_server::process_topology::Finding]) -> Vec<&str> {
    findings.iter().map(|f| f.code.as_str()).collect()
}

// ---------------------------------------------------------------------------
// 正确拓扑:五进程零发现
// ---------------------------------------------------------------------------

#[test]
fn five_process_topology_zero_findings() {
    let xml = std::fs::read_to_string(fixture("five-process.xml")).unwrap();
    let findings = validate_manifest(&xml);
    assert!(findings.is_empty(), "expected zero findings, got {findings:#?}");
}

// ---------------------------------------------------------------------------
// M 类:清单形态
// ---------------------------------------------------------------------------

#[test]
fn duplicate_port_reports_m2() {
    let xml = std::fs::read_to_string(fixture("dup-port.xml")).unwrap();
    let findings = validate_manifest(&xml);
    assert!(
        codes(&findings).contains(&"kbengine.processTopologyDuplicatePort"),
        "expected M2, got {:?}",
        codes(&findings)
    );
    let f = findings
        .iter()
        .find(|f| f.code == "kbengine.processTopologyDuplicatePort")
        .unwrap();
    assert_eq!(f.target, "manifest");
    assert_eq!(f.severity, 2);
    // 定位在冲突的 port 行(baseapp_2 的 <port>20005</port>,dup-port.xml 第 19 行)。
    assert_eq!(f.line, 19, "M2 应定位到重复 port 行");
    assert!(f.message.contains("20005"), "message: {}", f.message);
}

#[test]
fn duplicate_singleton_role_reports_m3() {
    let xml = std::fs::read_to_string(fixture("dup-role.xml")).unwrap();
    let findings = validate_manifest(&xml);
    assert!(
        codes(&findings).contains(&"kbengine.processTopologyDuplicateSingletonRole"),
        "expected M3, got {:?}",
        codes(&findings)
    );
}

#[test]
fn unknown_dependency_reports_m5() {
    let xml = std::fs::read_to_string(fixture("unknown-dep.xml")).unwrap();
    let findings = validate_manifest(&xml);
    assert!(
        codes(&findings).contains(&"kbengine.processTopologyUnknownDependency"),
        "expected M5, got {:?}",
        codes(&findings)
    );
    let f = findings
        .iter()
        .find(|f| f.code == "kbengine.processTopologyUnknownDependency")
        .unwrap();
    assert!(f.message.contains("ghost_1"), "message: {}", f.message);
    // 定位到 <dependsOn>ghost_1</dependsOn> 行(unknown-dep.xml 第 15 行)。
    assert_eq!(f.line, 15);
}

#[test]
fn custom_role_bypassed_m4() {
    let xml = std::fs::read_to_string(fixture("custom-role.xml")).unwrap();
    let findings = validate_manifest(&xml);
    assert!(
        !codes(&findings).contains(&"kbengine.processTopologyUnknownRole"),
        "custom role 不应触发 M4, got {:?}",
        codes(&findings)
    );
}

#[test]
fn unknown_role_reports_m4_without_custom() {
    let xml = r#"<processTopology>
      <process name="machine_1" role="machine"><port>20099</port></process>
      <process name="x_1" role="xenon"><port>20100</port></process>
    </processTopology>"#;
    let findings = validate_manifest(xml);
    assert!(
        codes(&findings).contains(&"kbengine.processTopologyUnknownRole"),
        "expected M4, got {:?}",
        codes(&findings)
    );
    let f = findings
        .iter()
        .find(|f| f.code == "kbengine.processTopologyUnknownRole")
        .unwrap();
    assert_eq!(f.line, 3);
}

#[test]
fn dependency_cycle_reports_m6() {
    let xml = r#"<processTopology>
      <process name="a" role="baseapp"><dependsOn>b</dependsOn><port>1</port></process>
      <process name="b" role="cellapp"><dependsOn>c</dependsOn><port>2</port></process>
      <process name="c" role="loginapp"><dependsOn>a</dependsOn><port>3</port></process>
    </processTopology>"#;
    let findings = validate_manifest(xml);
    assert!(
        codes(&findings).contains(&"kbengine.processTopologyDependencyCycle"),
        "expected M6, got {:?}",
        codes(&findings)
    );
    let f = findings
        .iter()
        .find(|f| f.code == "kbengine.processTopologyDependencyCycle")
        .unwrap();
    assert!(f.message.contains("→"), "message: {}", f.message);
}

// ---------------------------------------------------------------------------
// D 类:def 内容 vs 拓扑角色
// ---------------------------------------------------------------------------

#[test]
fn missing_dbmgr_reports_d3_on_persistent_property_line() {
    let xml = std::fs::read_to_string(fixture("no-dbmgr.xml")).unwrap();
    let findings = validate_manifest(&xml);
    assert!(
        codes(&findings).contains(&"kbengine.processTopologyMissingDbmgr"),
        "expected D3, got {:?}",
        codes(&findings)
    );
    let f = findings
        .iter()
        .find(|f| {
            f.code == "kbengine.processTopologyMissingDbmgr" && f.message.contains("Avatar")
        })
        .expect("Avatar D3 finding");
    assert_eq!(f.target, "def");
    assert_eq!(f.file_path, "/defs/entity_defs/Avatar.def");
    // Avatar.def 首个持久属性 <name> 元素行定位(Avatar.def 第 8 行)。
    assert_eq!(f.line, 8, "D3 应定位到首个持久属性行");
    assert!(f.message.contains("Avatar"), "message: {}", f.message);
    // related 指向清单。
    assert_eq!(f.related.len(), 1);
    assert_eq!(f.related[0].file_path, "<manifest>");
}

#[test]
fn missing_cellapp_reports_d1_on_cell_line() {
    let xml = std::fs::read_to_string(fixture("no-cellapp.xml")).unwrap();
    let findings = validate_manifest(&xml);
    assert!(
        codes(&findings).contains(&"kbengine.processTopologyMissingCellapp"),
        "expected D1, got {:?}",
        codes(&findings)
    );
    let f = findings
        .iter()
        .find(|f| {
            f.code == "kbengine.processTopologyMissingCellapp"
                && f.file_path == "/defs/entity_defs/Monster.def"
        })
        .expect("Monster D1 finding");
    assert_eq!(f.target, "def");
    assert_eq!(f.file_path, "/defs/entity_defs/Monster.def");
    // Monster.def 最早 cell 内容 = 首个 cell 域属性 <aiState>(CELL_PUBLIC,第 8 行;
    // CellMethods <onAggro> 在 15 行,note_line 取最小行)。
    assert_eq!(f.line, 8, "D1 应定位到最早 cell 内容行");
}

#[test]
fn missing_baseapp_reports_d2() {
    let xml = r#"<processTopology>
      <process name="machine_1" role="machine"><port>20099</port></process>
      <process name="cellapp_1" role="cellapp"><port>20015</port></process>
    </processTopology>"#;
    let findings = validate_manifest(xml);
    assert!(
        codes(&findings).contains(&"kbengine.processTopologyMissingBaseapp"),
        "expected D2, got {:?}",
        codes(&findings)
    );
    let f = findings
        .iter()
        .find(|f| f.code == "kbengine.processTopologyMissingBaseapp")
        .unwrap();
    assert_eq!(f.file_path, "/defs/entity_defs/Account.def");
}

// ---------------------------------------------------------------------------
// O 类:hosts 声明
// ---------------------------------------------------------------------------

#[test]
fn hosts_contradiction_reports_o1() {
    let xml = std::fs::read_to_string(fixture("wrong-hosts.xml")).unwrap();
    let findings = validate_manifest(&xml);
    assert!(
        codes(&findings).contains(&"kbengine.processTopologyHostConflict"),
        "expected O1, got {:?}",
        codes(&findings)
    );
    let f = findings
        .iter()
        .find(|f| f.code == "kbengine.processTopologyHostConflict")
        .unwrap();
    assert_eq!(f.target, "manifest");
    assert!(f.message.contains("Account"), "message: {}", f.message);
    assert!(f.message.contains("cellapp"), "message: {}", f.message);
}

#[test]
fn unknown_hosted_entity_reports_o2() {
    let xml = std::fs::read_to_string(fixture("unknown-entity.xml")).unwrap();
    let findings = validate_manifest(&xml);
    assert!(
        codes(&findings).contains(&"kbengine.processTopologyUnknownHostedEntity"),
        "expected O2, got {:?}",
        codes(&findings)
    );
    let f = findings
        .iter()
        .find(|f| f.code == "kbengine.processTopologyUnknownHostedEntity")
        .unwrap();
    assert!(f.message.contains("Ghost"), "message: {}", f.message);
    // 定位到 <hosts>Ghost</hosts> 行(unknown-entity.xml 第 17 行)。
    assert_eq!(f.line, 17);
}

#[test]
fn hosts_consistent_no_o1() {
    let xml = std::fs::read_to_string(fixture("five-process.xml")).unwrap();
    let findings = validate_manifest(&xml);
    assert!(
        !codes(&findings).contains(&"kbengine.processTopologyHostConflict"),
        "正确 hosts 不应触发 O1, got {:?}",
        codes(&findings)
    );
}

// ---------------------------------------------------------------------------
// 边界:无清单 / 畸形清单
// ---------------------------------------------------------------------------

#[test]
fn no_manifest_zero_findings() {
    let findings = validate_process_topology("", Some(DEMO_ENTITIES_XML), demo_defs());
    assert!(findings.is_empty());
}

#[test]
fn malformed_manifest_no_panic() {
    let findings = validate_manifest("<processTopology><process name=unclosed");
    // 畸形清单不 panic;若可解析出进程仍校验,否则零发现。
    let _ = findings;
}

#[test]
fn manifest_with_no_processes_zero_findings() {
    let findings = validate_manifest("<processTopology></processTopology>");
    assert!(findings.is_empty());
}

// ---------------------------------------------------------------------------
// 内容推导:闭包(父链/接口/组件)并入
// ---------------------------------------------------------------------------

/// Monster 的 def 只声明 <Parent>Avatar</Parent> 与接口 ROLE,cell 内容经闭包
/// 从父类/接口并入;父类 Avatar 有 BaseMethods → Monster 也应有 base 内容。
#[test]
fn closure_merges_parent_and_interface_content() {
    // 只给 Monster.def(父类 Avatar.def + 接口 ROLE 在 defs 集),清单无
    // cellapp 但 Monster 经闭包有 cell 内容 → D1。
    let mut defs = demo_defs();
    defs.retain(|d| d.name == "Monster" || d.name == "Avatar" || d.name == "ROLE");
    // ROLE 接口含 cell 方法。
    let role_interface = r#"<root>
      <CellMethods><onRoleTick></onRoleTick></CellMethods>
    </root>"#;
    defs.push(DefInput {
        name: "ROLE".into(),
        category: "interface".into(),
        file_path: "/defs/interfaces/ROLE.def".into(),
        text: role_interface.into(),
    });
    let xml = r#"<processTopology>
      <process name="machine_1" role="machine"><port>20099</port></process>
      <process name="baseapp_1" role="baseapp"><port>20005</port></process>
    </processTopology>"#;
    let findings = validate_process_topology(xml, None, defs);
    // 缺 cellapp → Monster 闭包含 cell 内容(CellMethods onRoleTick)→ D1。
    assert!(
        codes(&findings).contains(&"kbengine.processTopologyMissingCellapp"),
        "闭包并入 cell 内容应触发 D1, got {:?}",
        codes(&findings)
    );
    let monster = findings.iter().find(|f| {
        f.file_path == "/defs/entity_defs/Monster.def" && f.code == "kbengine.processTopologyMissingCellapp"
    });
    assert!(monster.is_some(), "Monster D1 应存在, got {:?}", codes(&findings));
}

/// 组件 Persistent 并入持久性(组件 def 在 components/ 子目录)。
#[test]
fn component_persistent_counts_toward_dbmgr() {
    let avatar = read("Avatar");
    // Avatar.def 组件 <bag><Type>Inventory</Type><Persistent>true</Persistent></bag>。
    // 仅给 Avatar + Inventory 组件 def;缺 dbmgr → D3。
    let defs = vec![
        DefInput {
            name: "Avatar".into(),
            category: "entity".into(),
            file_path: "/defs/entity_defs/Avatar.def".into(),
            text: avatar.clone(),
        },
        DefInput {
            name: "Inventory".into(),
            category: "component".into(),
            file_path: "/defs/entity_defs/components/Inventory.def".into(),
            text: "<root></root>".into(),
        },
    ];
    let xml = r#"<processTopology>
      <process name="machine_1" role="machine"><port>20099</port></process>
      <process name="cellapp_1" role="cellapp"><port>20015</port></process>
      <process name="baseapp_1" role="baseapp"><port>20005</port></process>
    </processTopology>"#;
    let findings = validate_process_topology(xml, None, defs);
    assert!(
        codes(&findings).contains(&"kbengine.processTopologyMissingDbmgr"),
        "组件 Persistent 应驱动 D3, got {:?}",
        codes(&findings)
    );
}

/// 属性旗标→域映射:纯 cell 旗标驱动 hasCell,base 旗标驱动 hasBase。
#[test]
fn property_flags_map_to_domains() {
    let defs = vec![DefInput {
        name: "E".into(),
        category: "entity".into(),
        file_path: "/defs/entity_defs/E.def".into(),
        text: r#"<root>
          <Properties>
            <hp><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></hp>
            <name><Type>STRING</Type><Flags>BASE</Flags></name>
          </Properties>
        </root>"#
        .into(),
    }];
    // 缺 cellapp → E 有 cell 内容 → D1;缺 baseapp → D2。
    let xml = r#"<processTopology>
      <process name="machine_1" role="machine"><port>20099</port></process>
    </processTopology>"#;
    let findings = validate_process_topology(xml, None, defs);
    let codes = codes(&findings);
    assert!(codes.contains(&"kbengine.processTopologyMissingCellapp"), "got {codes:?}");
    assert!(codes.contains(&"kbengine.processTopologyMissingBaseapp"), "got {codes:?}");
}

// ---------------------------------------------------------------------------
// KODE-AUD-006:def 递归循环保护(interface/parent 成环不栈溢出)
// ---------------------------------------------------------------------------

/// interface 链成环 A→B→A:walk_def 递归装载无法终止,活动栈 visiting 截断,
/// 不 panic 不栈溢出(修前无限递归 stack overflow)。
#[test]
fn interface_cycle_a_to_b_to_a_terminates() {
    let defs = vec![
        DefInput {
            name: "A".into(),
            category: "entity".into(),
            file_path: "/defs/entity_defs/A.def".into(),
            text: r#"<root><Interfaces><interface> B </interface></Interfaces></root>"#.into(),
        },
        DefInput {
            name: "B".into(),
            category: "entity".into(),
            file_path: "/defs/entity_defs/B.def".into(),
            text: r#"<root><Interfaces><interface> A </interface></Interfaces></root>"#.into(),
        },
    ];
    let xml = r#"<processTopology>
      <process name="cellapp_1" role="cellapp"><port>20003</port></process>
    </processTopology>"#;
    // 不 panic 即通过(环被截断);发现集可有可无,关键是返回而非栈溢出。
    let findings = validate_process_topology(xml, None, defs);
    assert!(findings.len() <= 4);
}

/// parent 链成环 A→B→A:同样由活动栈截断。
#[test]
fn parent_cycle_a_to_b_to_a_terminates() {
    let defs = vec![
        DefInput {
            name: "A".into(),
            category: "entity".into(),
            file_path: "/defs/entity_defs/A.def".into(),
            text: r#"<root><Parent> B </Parent></root>"#.into(),
        },
        DefInput {
            name: "B".into(),
            category: "entity".into(),
            file_path: "/defs/entity_defs/B.def".into(),
            text: r#"<root><Parent> A </Parent></root>"#.into(),
        },
    ];
    let xml = r#"<processTopology>
      <process name="cellapp_1" role="cellapp"><port>20003</port></process>
    </processTopology>"#;
    let findings = validate_process_topology(xml, None, defs);
    assert!(findings.len() <= 4);
}
