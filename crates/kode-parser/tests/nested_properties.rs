//! RUST-139 嵌套属性模型钉:model.rs 的 `children`/`array_element` 扩展。
//! 独立于 def-parity golden(json.rs 只序列化 7 字段,嵌套面不进 golden)。

use kode_parser::model::parse_def;

#[test]
fn multi_properties_sections_append_not_replace() {
    // 每属性一段的合成形态(depGraph parity 真实抓到的回归面:整段覆盖会
    // 只留最后一段)。
    let def = parse_def(
        "<root>\n\
         \x20 <Properties>\n    <pets>\n      <Type>ARRAY <of> Mob </of></Type>\n    </pets>\n  </Properties>\n\
         \x20 <Properties>\n    <rival>\n      <Type> Mob </Type>\n    </rival>\n  </Properties>\n\
         </root>\n",
    );
    let names: Vec<&str> = def.properties.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["pets", "rival"], "多 Properties 段逐段追加");
    assert_eq!(def.properties[0].type_refs, vec!["Mob"]);
    assert_eq!(def.properties[1].type_refs, vec!["Mob"]);
}

#[test]
fn nested_properties_children_parse_in_declaration_order() {
    let def = parse_def(
        "<root>\n  <Properties>\n    <cfg>\n      <Type> FIXED_DICT </Type>\n      <Properties>\n        <width>\n          <Type> UINT32 </Type>\n        </width>\n        <height>\n          <Type> UINT32 </Type>\n        </height>\n      </Properties>\n    </cfg>\n  </Properties>\n</root>\n",
    );
    let cfg = &def.properties[0];
    assert_eq!(cfg.name, "cfg");
    let child_names: Vec<&str> = cfg.children.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(child_names, vec!["width", "height"]);
    assert_eq!(cfg.children[0].type_refs, vec!["UINT32"]);
}

#[test]
fn array_of_synthesizes_value_element_inheriting_parent() {
    // `<of>` 非空 → 合成 value:name 恒 value,typeName=of 文本,line=父行,
    // 旗标/detailLevel/databaseLength/persistent 继承父,default/identifier/
    // sensitive 清空,arrayElement 不下钻。
    let def = parse_def(
        "<root>\n  <Properties>\n    <slots>\n      <Type>\n        ARRAY\n        <of> SLOT </of>\n      </Type>\n      <Flags> BASE </Flags>\n      <Persistent> true </Persistent>\n    </slots>\n  </Properties>\n</root>\n",
    );
    let slots = &def.properties[0];
    let element = slots.array_element.as_ref().expect("ARRAY 合成 value");
    assert_eq!(element.name, "value");
    assert_eq!(element.type_name.as_deref(), Some("SLOT"));
    assert_eq!(element.line, slots.line, "value 行 = 父属性行");
    assert_eq!(element.flags, slots.flags);
    assert_eq!(element.persistent, slots.persistent);
    assert_eq!(element.detail_level, slots.detail_level);
    assert_eq!(element.database_length, slots.database_length);
    assert_eq!(element.default_value, None);
    assert_eq!(element.identifier, None);
    assert!(!element.sensitive);
    assert!(
        element.array_element.is_none(),
        "TS arrayElement: undefined 不再下钻"
    );
}

#[test]
fn empty_of_text_produces_no_array_element() {
    // 空 `<of>` 文本 = 引擎非法形态,不合成(与 of_ref 同口径)。
    let def = parse_def(
        "<root>\n  <Properties>\n    <x>\n      <Type>\n        ARRAY\n        <of>   </of>\n      </Type>\n    </x>\n  </Properties>\n</root>\n",
    );
    assert!(def.properties[0].array_element.is_none());
    assert_eq!(def.properties[0].of_ref, None);
}

#[test]
fn array_element_children_come_from_type_nested_properties() {
    // `<Type>/<Properties>` 内嵌子属性 → value.children(TS parseProperties 同构)。
    let def = parse_def(
        "<root>\n  <Properties>\n    <slots>\n      <Type>\n        ARRAY\n        <of> SLOT </of>\n        <Properties>\n          <pos>\n            <Type> INT32 </Type>\n          </pos>\n        </Properties>\n      </Type>\n    </slots>\n  </Properties>\n</root>\n",
    );
    let element = def.properties[0]
        .array_element
        .as_ref()
        .expect("arrayElement");
    let child_names: Vec<&str> = element.children.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(child_names, vec!["pos"]);
}

#[test]
fn scalar_property_has_no_children_or_array_element() {
    let def = parse_def(
        "<root>\n  <Properties>\n    <hp>\n      <Type> UINT32 </Type>\n    </hp>\n  </Properties>\n</root>\n",
    );
    assert!(def.properties[0].children.is_empty());
    assert!(def.properties[0].array_element.is_none());
}
