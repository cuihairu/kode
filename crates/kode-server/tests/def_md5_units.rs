//! C-18 def MD5 重放器核心单测。
//!
//! 覆盖:
//! - RFC 1321 MD5 公开向量(手写实现正确性,无新依赖红线);
//! - Phase1 内建类型 uid 序列(21 项,1..21);
//! - 逐字段字节布局(属性 ctor utype/flags/persistent、方法 utype 恒 0、
//!   嵌套 ARRAY 先入流、方法实参 exposed 文档序);
//! - autoMatchCompOwn 3×int32(entities.xml 属性缺省 -1、有值 1/0);
//! - 双夹具(demo-assets/parity-project)md5 确定性双跑一致 + 大写 32hex;
//! - 畸形输入(缺 def/缺 Type)返回 Err 不 panic。
//!
//! golden 再生成:仅样本表变更时 `cargo run -p kode-server --bin dump-def-md5-golden`
//! (见 tests/def_md5_golden.rs 重生成比对)。

use std::collections::HashSet;
use std::path::Path;

use kode_server::def_md5::{
    compute_def_md5, golden_samples, DefMd5Params, Md5, BUILTIN_TYPE_ORDER,
};

fn repo_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or_else(|| Path::new("."))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn rfc1321_vectors() {
    let mut m = Md5::new();
    m.update(b"");
    assert_eq!(hex(&m.clone().finalize()), "d41d8cd98f00b204e9800998ecf8427e");

    let mut m = Md5::new();
    m.update(b"abc");
    assert_eq!(hex(&m.clone().finalize()), "900150983cd24fb0d6963f7d28e17f72");

    let mut m = Md5::new();
    m.update(b"message digest");
    assert_eq!(hex(&m.clone().finalize()), "f96b697d7cb7938d525a2f31aaf161d0");

    // 跨块长串(RFC 标准 "a"×1e6)。
    let mut m = Md5::new();
    for _ in 0..1_000_000 {
        m.update(b"a");
    }
    assert_eq!(hex(&m.clone().finalize()), "7707d6ae4e027c70eea2a935c2296f21");

    // 分块边界(56/64/65 字节)。
    for len in [55usize, 56, 57, 63, 64, 65, 128] {
        let mut m = Md5::new();
        m.update(&vec![0xAB; len]);
        let mut m2 = Md5::new();
        for chunk in vec![0xAB; len].chunks(7) {
            m2.update(chunk);
        }
        assert_eq!(hex(&m.finalize()), hex(&m2.finalize()), "len={len}");
    }
}

#[test]
fn builtin_uid_sequence_1_to_21() {
    // Phase1 内建类型构造序:uid 1..21(datatype.cpp:24 计数器 1 起)。
    assert_eq!(BUILTIN_TYPE_ORDER.len(), 21);
    let sample = golden_samples(repo_root())
        .into_iter()
        .find(|s| s.name == "minimal-single-entity")
        .expect("minimal sample present");
    let result = compute_def_md5(sample.params).expect("compute");
    // 21×2 字节 LE = 42 字节 = 84 hex 字符;"01000200...1500"。
    let phase1 = &result.stream_hex[..84];
    let mut expect = String::new();
    for i in 1..=21u16 {
        expect.push_str(&format!("{:02x}{:02x}", i & 0xff, i >> 8));
    }
    assert_eq!(phase1, expect);
    // UINT32 是第 4 个构造(uid=4,字节 6..8→hex 12..16),ENTITYCALL 第 17 个。
    assert_eq!(&result.stream_hex[12..16], "0400"); // UINT32 = 4
}

#[test]
fn minimal_property_ctor_bytes() {
    let sample = golden_samples(repo_root())
        .into_iter()
        .find(|s| s.name == "minimal-single-entity")
        .unwrap();
    let result = compute_def_md5(sample.params).unwrap();
    // 在 phase1 之后:模块名 "Gate"。
    let s = &result.stream_hex;
    let phase1_len = 42 * 2; // 42 字节 = 84 hex 字符
    let after = &s[phase1_len..];
    assert!(after.starts_with("47617465"), "module name Gate: {after}");
    // 属性 level:name+default+type+utype(1)+flags(0x40)+persistent(1)+...
    let prop = after.find("6c6576656c").expect("property name level");
    // 属性 ctor 全宽 = 5+0+6+2+4+1+1+4+1+2 = 26 字节 = 52 hex 字符。
    let seg = &after[prop..prop + 52];
    // "level" + "" + "UINT32" + utype(0001) + flags(40000000) + persistent(01)
    let expected = "6c6576656c".to_string()
        + "" // default empty
        + "55494e543332" // UINT32
        + "0100" // utype = 1(auto 计数器首值)
        + "40000000" // flags = BASE(0x40)
        + "01"; // persistent true
    assert!(seg.starts_with(&expected), "prop ctor: {seg}");
    // identifier(00) + dbLen(00000000) + detailLevel(02) + typeUid(0400)
    let tail = &seg[expected.len()..];
    assert_eq!(tail, "00".to_owned() + "00000000" + "02" + "0400");
}

#[test]
fn minimal_method_utype_always_zero_and_exposed() {
    let sample = golden_samples(repo_root())
        .into_iter()
        .find(|s| s.name == "minimal-single-entity")
        .unwrap();
    let result = compute_def_md5(sample.params).unwrap();
    let s = &result.stream_hex;
    // reqUpgrade:name + utype(0000) + exposed(00000000) + setExposed(01000000)
    //   + arg uid(0400) + arg exposed(01000000)
    let idx = s.find("72657155706772616465").expect("reqUpgrade");
    let seg = &s[idx..];
    let expected = "72657155706772616465".to_owned() // "reqUpgrade"
        + "0000" // method utype 恒 0(setUType 不再入流)
        + "00000000" // exposedType NO_EXPOSED
        + "01000000" // <Exposed/>→setExposed(EXPOSED=1)
        + "0400" // arg uid UINT32
        + "01000000"; // arg exposed = EXPOSED(文档序:Exposed 在 Arg 前)
    assert!(seg.starts_with(&expected), "reqUpgrade: {seg}");
    // onLevelUp(ClientMethods):无 Exposed 分支,arg exposed 恒 0。
    let idx = s.find("6f6e4c6576656c5570").expect("onLevelUp");
    let seg = &s[idx..];
    let expected = "6f6e4c6576656c5570".to_owned() + "0000" + "00000000" + "0400" + "00000000";
    assert!(seg.starts_with(&expected), "onLevelUp: {seg}");
}

#[test]
fn minimal_auto_match_comp_own_three_int32() {
    let sample = golden_samples(repo_root())
        .into_iter()
        .find(|s| s.name == "minimal-single-entity")
        .unwrap();
    let result = compute_def_md5(sample.params).unwrap();
    let s = &result.stream_hex;
    // Gate 在 entities.xml 声明 hasCell="true" → hasClient=-1 hasCell=1 hasBase=-1。
    let idx = s.find("ffffffff01000000ffffffff").expect("autoMatchCompOwn tail");
    let _ = idx;
    assert!(s.ends_with("ffffffff01000000ffffffff"));
}

#[test]
fn determinism_and_md5_format() {
    for sample in golden_samples(repo_root()) {
        let a = compute_def_md5(sample.params.clone()).expect("compute a");
        let b = compute_def_md5(sample.params.clone()).expect("compute b");
        assert_eq!(a.md5_hex, b.md5_hex, "{}: deterministic", sample.name);
        assert_eq!(a.stream_hex, b.stream_hex, "{}: deterministic", sample.name);
        assert_eq!(a.md5_hex.len(), 32, "{}: 32 hex", sample.name);
        assert!(a.md5_hex.chars().all(|c| c.is_ascii_hexdigit()), "{}", sample.name);
        assert!(a.md5_hex.chars().all(|c| !c.is_ascii_lowercase()), "{}: uppercase", sample.name);
        assert_eq!(
            a.md5_hex.to_lowercase(),
            a.md5_hex.to_lowercase(),
            "{}",
            sample.name
        );
    }
}

#[test]
fn malformed_inputs_error_not_panic() {
    // 缺 def。
    let p = DefMd5Params {
        types_xml: "<root></root>".into(),
        entities_xml: "<root><Ghost hasCell=\"true\"></Ghost></root>".into(),
        defs: Default::default(),
        alias_xml: String::new(),
        component_scripts: HashSet::new(),
    };
    assert!(compute_def_md5(p).is_err());
    // 属性缺 Type。
    let p = DefMd5Params {
        types_xml: "<root></root>".into(),
        entities_xml: "<root><Ghost hasCell=\"true\"></Ghost></root>".into(),
        defs: [(
            "Ghost".to_string(),
            "<root><Properties><x><Flags>BASE</Flags></x></Properties></root>".to_string(),
        )]
        .into_iter()
        .collect(),
        alias_xml: String::new(),
        component_scripts: HashSet::new(),
    };
    assert!(compute_def_md5(p).is_err());
    // 未知类型引用。
    let p = DefMd5Params {
        types_xml: "<root></root>".into(),
        entities_xml: "<root><Ghost hasCell=\"true\"></Ghost></root>".into(),
        defs: [(
            "Ghost".to_string(),
            "<root><Properties><x><Type>NO_SUCH</Type><Flags>BASE</Flags></x></Properties></root>"
                .to_string(),
        )]
        .into_iter()
        .collect(),
        alias_xml: String::new(),
        component_scripts: HashSet::new(),
    };
    assert!(compute_def_md5(p).is_err());
}

#[test]
fn nested_array_before_host_bytes() {
    // 属性类型为内联 ARRAY<of UINT32>:嵌套构造字节先于属性 ctor 字节。
    let p = DefMd5Params {
        types_xml: "<root></root>".into(),
        entities_xml: "<root><Gate hasCell=\"true\"></Gate></root>".into(),
        defs: [(
            "Gate".to_string(),
            "<root><Properties><ids><Type>ARRAY<of>UINT32</of></Type><Flags>BASE</Flags></ids></Properties></root>".to_string(),
        )]
        .into_iter()
        .collect(),
        alias_xml: String::new(),
        component_scripts: HashSet::new(),
    };
    let result = compute_def_md5(p).unwrap();
    let s = &result.stream_hex;
    // Phase1(42B)+"Gate"(4B)=46 字节 = 92 hex 字符;之后 [array uid u16][元素 uid][元素 "UINT32"]
    let after = &s[(42 + 4) * 2..];
    let inline_array = after.find("696473").expect("ids property");
    // ids 属性名之前必须有嵌套数组字节:array uid(23,下一个 uid=22? 21 builtins+0)
    // 元素 uid=4(UINT32),类型 "UINT32"。
    let pre = &after[..inline_array];
    // array 构造 uid 应为 22(21 内建后第一个),元素 UINT32=4。
    let expected_pre = "1600".to_owned() + "0400" + "55494e543332"; // 22=0x16
    assert!(pre.starts_with(&expected_pre), "nested pre: {pre}");
}

#[test]
fn golden_samples_load_fixtures() {
    // demo-assets 与 parity-project 夹具可装载(至少一个样本)。
    let names: Vec<&str> = golden_samples(repo_root())
        .iter()
        .map(|s| s.name)
        .collect();
    assert!(names.contains(&"kbengine-demo-assets"));
    assert!(names.contains(&"parity-project"));
    assert!(names.contains(&"minimal-single-entity"));
}

/// KODE-AUD-006:def 递归循环保护。interface 链成环 Ghost→Type→Type(自环):
/// Replayer 的 load_interfaces 不查 loaded_modules,修前无限递归栈溢出;loading
/// 活动栈截断,compute_def_md5 正常返回(不 panic)。
///
/// 夹具形态:load_interfaces 取 if_entry 子元素(Interface/interface/Type/type)
/// 的**标签名**为接口名(engine entitydef.cpp:551-639 口径),故 interface_name=
/// "Type"(由 `<Type>` 子元素标签名得),再加载同名 def "Type" 又引 `<Type>` →
/// 自环。若用真实 def 的 `<interface>ROLE</interface>`(文本名)形态,接口名提取
/// 不匹配、接口从不被加载、环不可达,测试不判别。判别已验证:无守卫 SIGABRT
/// 栈溢出、有守卫返回 Ok。
#[test]
fn interface_cycle_does_not_overflow() {
    let p = DefMd5Params {
        types_xml: "<root></root>".into(),
        entities_xml: "<root><Ghost hasCell=\"true\"></Ghost></root>".into(),
        defs: [
            (
                "Ghost".to_string(),
                "<root><Interfaces><Iface><Type>Type</Type></Iface></Interfaces></root>"
                    .to_string(),
            ),
            (
                "Type".to_string(),
                "<root><Interfaces><Iface><Type>Type</Type></Iface></Interfaces></root>"
                    .to_string(),
            ),
        ]
        .into_iter()
        .collect(),
        alias_xml: String::new(),
        component_scripts: HashSet::new(),
    };
    // 不 panic 即通过(环被截断);md5 值不校验,关键是返回而非栈溢出。
    assert!(compute_def_md5(p).is_ok());
}

/// KODE-AUD-006:parent 链成环 Ghost→A→B→A(load_parent_class 不查
/// loaded_modules),loading 活动栈截断。
#[test]
fn parent_cycle_does_not_overflow() {
    let p = DefMd5Params {
        types_xml: "<root></root>".into(),
        entities_xml: "<root><Ghost hasCell=\"true\"></Ghost></root>".into(),
        defs: [
            (
                "Ghost".to_string(),
                "<root><Parent> A </Parent></root>".to_string(),
            ),
            (
                "A".to_string(),
                "<root><Parent> B </Parent></root>".to_string(),
            ),
            (
                "B".to_string(),
                "<root><Parent> A </Parent></root>".to_string(),
            ),
        ]
        .into_iter()
        .collect(),
        alias_xml: String::new(),
        component_scripts: HashSet::new(),
    };
    assert!(compute_def_md5(p).is_ok());
}

/// KODE-AUD-006:def 递归循环保护。component 链成环 Ghost→Type→Type(自环):
/// load_components→load_def_info 递归,load_def_info 不查 loaded_modules(环上
/// 无节点已装载),修前无限递归栈溢出;loading 活动栈截断,正常返回不 panic。
///
/// 夹具形态:load_components 的 component_name=comp_entry 标签名,child_el 再找
/// 同名子元素(得 `<C>`),component_type_name=Type 子元素标签名="Type",加载同名
/// def "Type" 又自引 → 环。判别已验证:无守卫 SIGABRT 栈溢出、有守卫返回 Ok。
#[test]
fn component_cycle_does_not_overflow() {
    let cyc = "<root><Components><C><C><Type>Type</Type></C></C></Components></root>";
    let p = DefMd5Params {
        types_xml: "<root></root>".into(),
        entities_xml: "<root><Ghost hasCell=\"true\"></Ghost></root>".into(),
        defs: [
            ("Ghost".to_string(), cyc.to_string()),
            ("Type".to_string(), cyc.to_string()),
        ]
        .into_iter()
        .collect(),
        alias_xml: String::new(),
        component_scripts: HashSet::new(),
    };
    // 不 panic 即通过(环被截断);md5 值不校验,关键是返回而非栈溢出。
    assert!(compute_def_md5(p).is_ok());
}
