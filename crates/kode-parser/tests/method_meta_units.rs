//! kode-parser 方法元数据单元测试(RUST-108):`<ReturnType>` 与逐
//! `<Arg>` 类型引用提取。两字段不进 parser golden(parity 面零扰动,
//! fixtures_golden 全绿即证)。

use kode_parser::model::parse_def;

#[test]
fn return_type_extracted_when_declared() {
    let def = parse_def(
        "<root>\n <BaseMethods>\n  <reqQuest>\n   <Arg> UINT32 </Arg>\n   <ReturnType> BOOL </ReturnType>\n\
         \x20  </reqQuest>\n </BaseMethods>\n</root>",
    );
    let m = &def.base_methods[0];
    assert_eq!(m.name, "reqQuest");
    assert_eq!(m.return_type.as_deref(), Some("BOOL"));
}

#[test]
fn return_type_none_when_absent_or_empty() {
    let def = parse_def(
        "<root>\n <CellMethods>\n  <a><Arg> UINT8 </Arg></a>\n  <b><ReturnType> </ReturnType></b>\n\
         \x20 </CellMethods>\n</root>",
    );
    assert_eq!(def.cell_methods[0].return_type, None, "缺声明 = None");
    assert_eq!(def.cell_methods[1].return_type, None, "空白声明 = None");
}

/// 遗留拼写等同识别(canonical_tag 归一:大小写/下划线剔除)。
#[test]
fn return_type_legacy_spelling_recognized() {
    let def = parse_def(
        "<root>\n <ClientMethods>\n  <show>\n   <Returntype> UINT16 </Returntype>\n  </show>\n\
         \x20 </ClientMethods>\n</root>",
    );
    assert_eq!(def.client_methods[0].return_type.as_deref(), Some("UINT16"));
}

/// 逐 Arg 类型引用:普通标量一 ref;ARRAY `<of>` 剥指令取元素;指令独占
/// Arg 产空 ref(如实,元素类型不在标量文本内)。args 原文口径不变。
#[test]
fn arg_type_refs_follow_property_convention() {
    let def = parse_def(
        "<root>\n <BaseMethods>\n  <hit>\n\
         \x20   <Arg> UINT32 </Arg>\n\
         \x20   <Arg> ARRAY <of> ITEM_ID </of> </Arg>\n\
         \x20   <Arg> ARRAY </Arg>\n\
         \x20 </hit>\n </BaseMethods>\n</root>",
    );
    let m = &def.base_methods[0];
    assert_eq!(m.args, ["UINT32", "ARRAY", "ARRAY"], "args 原文口径不变");
    assert_eq!(m.arg_type_refs.len(), 3, "与非空 args 逐一对齐");
    assert_eq!(m.arg_type_refs[0], ["UINT32"]);
    assert_eq!(m.arg_type_refs[1], ["ITEM_ID"], "ARRAY 剥指令 + <of> 文本");
    assert_eq!(
        m.arg_type_refs[2],
        Vec::<String>::new(),
        "指令独占 = 空 ref"
    );
    assert_eq!(m.return_type, None);
}
