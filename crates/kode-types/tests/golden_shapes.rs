//! golden 输出形状边缘(合成语料):继承链 missing、多接口/多组件的逗号面、
//! 无根元素 .def 的空 composition、以及合成语料与真实语料互不影响。
//!
//! 真实语料对拍(type_golden.rs)已覆盖主路径;这里用临时 mini 语料驱动
//! dump_type_golden 里真实语料不存在的分支(status missing、第二个接口/组件、
//! 根元素缺失的 .def)。

use kode_types::golden::dump_type_golden;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

fn shape_root() -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "kode-types-golden-shape-{}-{seq}",
        std::process::id()
    ));
    let defs = root.join("tests/fixtures/kbengine-demo-assets/scripts/entity_defs");
    std::fs::create_dir_all(&defs).unwrap();

    // Parent 指向未注册实体 → 继承链 missing(status_str 的 missing 分支);
    // Interfaces 两个合法标签条目(第二个条目产逗号);Components 两个带 Type
    // 的组件槽(第二个条目产逗号)。
    std::fs::write(
        defs.join("Rich.def"),
        "<root>\n\t<Parent> GhostParent </Parent>\n\t<Interfaces>\n\t\t<interface> ROLE </interface>\n\t\t<Interface> MIRROR </Interface>\n\t</Interfaces>\n\t<Components>\n\t\t<bag>\n\t\t\t<Type> BAG </Type>\n\t\t</bag>\n\t\t<mail>\n\t\t\t<Type> MAIL </Type>\n\t\t</mail>\n\t</Components>\n</root>\n",
    )
    .unwrap();

    // 空内容 .def:文档无根元素 → composition 逐字段为空(父级 null、空数组)。
    std::fs::write(defs.join("Bare.def"), "   \n").unwrap();

    // types.xml 一条重定向别名(链到内建,保持分类面非空)。
    std::fs::write(
        defs.join("types.xml"),
        "<root>\n\t<ITEM_ID> UINT16 </ITEM_ID>\n</root>\n",
    )
    .unwrap();
    root
}

#[test]
fn golden_reports_missing_inheritance_and_multi_entry_lists() {
    let root = shape_root();
    let golden = dump_type_golden(&root);

    // 继承链缺级:GhostParent 未在任何注册表 → missing(理由 = 该级名)。
    assert!(
        golden.contains(
            "{\"entity\":\"Rich\",\"status\":\"missing\",\"chain\":[\"Rich\",\"GhostParent\"]}"
        ),
        "missing 继承链如实报告: {golden}"
    );

    // 两个合法接口标签条目都进 composition.interfaces(逗号分隔)。
    assert!(
        golden.contains("\"interfaces\":[\"ROLE\",\"MIRROR\"]"),
        "多接口逐条进数组: {golden}"
    );

    // 两个带 Type 的组件槽都进 components(逗号分隔)。
    assert!(
        golden.contains("\"components\":[\"BAG\",\"MAIL\"]"),
        "多组件逐条进数组: {golden}"
    );

    // 无根元素 .def:composition 逐字段为空,不虚构父级。
    assert!(
        golden.contains("\"composition\":{\"parent\":null,\"interfaces\":[],\"components\":[],\"fieldTypes\":[]}"),
        "空 .def 输出空 composition: {golden}"
    );

    // 别名链面仍在(合成语料的重定向别名)。
    assert!(
        golden.contains(
            "\"name\":\"ITEM_ID\",\"status\":\"resolved\",\"chain\":[\"ITEM_ID\",\"UINT16\"]"
        ),
        "{golden}"
    );

    std::fs::remove_dir_all(&root).unwrap();
}
