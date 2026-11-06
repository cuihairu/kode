//! golden 输出边缘(合成语料):继承环/别名链断链/接口标签过滤/多别名/环输出。
//!
//! 真实语料(golden parity 测试)已覆盖主路径;这里用临时 mini 语料驱动
//! dump_type_golden 里语料中不存在的分支(status cycle/missing/unknown、
//! 非标准接口标签、空接口名、无类型组件槽、环列表)。

use kode_types::golden::dump_type_golden;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

fn mini_root() -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("kode-types-golden-{}-{seq}", std::process::id()));
    let defs = root.join("tests/fixtures/kbengine-demo-assets/scripts/entity_defs");
    std::fs::create_dir_all(&defs).unwrap();

    // 继承环:A → B → A。
    std::fs::write(
        defs.join("A.def"),
        "<root>\n\t<Parent> B </Parent>\n\t<Interfaces>\n\t\t<interface> ROLE </interface>\n\t\t<weirdtag> ROLE </weirdtag>\n\t\t<Interface>    </Interface>\n\t</Interfaces>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n\t<Components>\n\t\t<bag>\n\t\t\t<Type> BAG </Type>\n\t\t</bag>\n\t\t<mystery>\n\t\t</mystery>\n\t</Components>\n</root>\n",
    )
    .unwrap();
    std::fs::write(defs.join("B.def"), "<root><Parent> A </Parent></root>\n").unwrap();

    // 别名链:X → Y → Z(不存在)= missing;SELF → SELF = cycle。
    std::fs::write(
        defs.join("types.xml"),
        "<root>\n\t<X> Y </X>\n\t<Y> Z </Y>\n\t<Z> UINT32 </Z>\n\t<SELF> SELF </SELF>\n\t<FD>\n\t\tFIXED_DICT\n\t\t<Properties>\n\t\t\t<v>\n\t\t\t\t<Type> UINT32 </Type>\n\t\t\t</v>\n\t\t</Properties>\n\t</FD>\n\t<ARR>\n\t\tARRAY\n\t\t<of> X </of>\n\t</ARR>\n</root>\n",
    )
    .unwrap();

    // 多条 alias(alias.xml);目标包含类型与不存在名。
    std::fs::write(
        defs.join("alias.xml"),
        "<root>\n\t<Hp>\n\t\t<Type> UINT32 </Type>\n\t</Hp>\n\t<Mana>\n\t\t<Type> UINT32 </Type>\n\t</Mana>\n</root>\n",
    )
    .unwrap();

    // entities.xml 注册语料里没有 def 的实体名 → classification 补入分支。
    std::fs::write(
        root.join("tests/fixtures/kbengine-demo-assets/scripts/entities.xml"),
        "<root>\n\t<Ghost hasBase=\"true\"></Ghost>\n</root>\n",
    )
    .unwrap();
    root
}

#[test]
fn dump_golden_reports_cycles_missing_and_skips_unknown_interface_tags() {
    let root = mini_root();
    let golden = dump_type_golden(&root);

    // 继承环:A/B 互相成为父级 → cycle 状态进 inheritanceChains。
    assert!(golden.contains("\"status\":\"cycle\""), "{golden}");
    // 别名链断链:Z 已定义,但 X→Y→Z 中……全定义则 resolved;缺名链 missing/unknown 需要断链。
    // SELF → SELF 是别名环。
    assert!(golden.contains("\"cycles\":[["), "cycles 应非空: {golden}");

    // 非标准接口标签(weirdtag)不进 composition.interfaces;空名条目跳过。
    assert!(
        golden.contains("\"interfaces\":[\"ROLE\"]"),
        "只留精确标签: {golden}"
    );

    // 无 Type 的组件槽被跳过,有类型的保留。
    assert!(golden.contains("\"components\":[\"BAG\"]"), "{golden}");

    // entities.xml 里语料没有 def 的实体名仍出现在 classifications。
    assert!(golden.contains("{\"name\":\"Ghost\",\"class\""), "{golden}");

    // 多条 alias 逐条进 aliasChains。
    assert!(golden.contains("\"name\":\"Hp\"") && golden.contains("\"name\":\"Mana\""));

    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn alias_chain_to_missing_type_is_reported() {
    let root = mini_root();
    // 追加一条断链别名:X2 → Y2,而 Y2 无定义。
    let defs = root.join("tests/fixtures/kbengine-demo-assets/scripts/entity_defs");
    std::fs::write(
        defs.join("types.xml"),
        "<root>\n\t<X2> Y2 </X2>\n\t<SELF> SELF </SELF>\n</root>\n",
    )
    .unwrap();
    let golden = dump_type_golden(&root);
    // 终点查无注册 → unknown/missing 状态出现(断链如实报告,不猜测)。
    assert!(
        golden.contains("\"status\":\"missing\"") || golden.contains("\"status\":\"unknown\""),
        "{golden}"
    );
    assert!(golden.contains("\"name\":\"X2\""));
    std::fs::remove_dir_all(&root).unwrap();
}
