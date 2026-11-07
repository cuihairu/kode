//! 协议帧结构描绘(KODE-MCP-KB-001 ③):`protocol_frame` 工具。
//!
//! 经 kode-server wire_codec(C-15 同源)把 def 方法参数 / types.xml 类型解析
//! 成 [`WireLayout`],渲染成逐字段线布局树(类型/字节宽/偏移/嵌套),答「协议
//! 帧的结构长什么样」。这是请求 ③「协议解析后数据帧」的帧结构面;字节样本
//! 由既有 `encode_decode_sample` 承担(本面只画结构,不编值)。
//!
//! 偏移语义(诚实):`offset` 是相对**直接父容器起点**的字节偏移,仅当路径上
//! 全部前驱字段为定长时可得(动态类型 → null)。容器自身无固定尺寸时其下
//! 字段偏移相对该容器起点,不再折算成帧绝对偏移(避免伪精确)。

use kode_server::wire_codec::{WireLayout, WireSchema};
use serde_json::{json, Value};

use crate::kb::AssetKnowledge;

/// 标量定长线宽(字节);动态类型(None)。
/// FIXED_DICT 全字段定长才定长(递归),否则动态——嵌套全定长字典不再被
/// 误判为动态而虚增未知偏移。
fn fixed_size(layout: &WireLayout) -> Option<usize> {
    Some(match layout {
        WireLayout::U8 | WireLayout::I8 | WireLayout::Bool => 1,
        WireLayout::U16 | WireLayout::I16 => 2,
        WireLayout::U32 | WireLayout::I32 | WireLayout::F32 => 4,
        WireLayout::U64 | WireLayout::I64 | WireLayout::F64 => 8,
        WireLayout::Vec2 => 8,
        WireLayout::Vec3 => 12,
        WireLayout::Vec4 => 16,
        WireLayout::EntityCall => 16,
        WireLayout::FixedDict(fields) => {
            let mut total = 0usize;
            for f in fields {
                total += fixed_size(&f.layout)?;
            }
            return Some(total);
        }
        _ => return None, // Str/Unicode/Blob/Py*/Array:动态
    })
}

fn kind_of(layout: &WireLayout) -> &'static str {
    match layout {
        WireLayout::U8 => "UINT8",
        WireLayout::U16 => "UINT16",
        WireLayout::U32 => "UINT32",
        WireLayout::U64 => "UINT64",
        WireLayout::I8 => "INT8",
        WireLayout::I16 => "INT16",
        WireLayout::I32 => "INT32",
        WireLayout::I64 => "INT64",
        WireLayout::F32 => "FLOAT",
        WireLayout::F64 => "DOUBLE",
        WireLayout::Bool => "BOOL",
        WireLayout::Str => "STRING",
        WireLayout::Unicode => "UNICODE",
        WireLayout::Blob => "BLOB",
        WireLayout::Py => "PYTHON",
        WireLayout::PyDict => "PY_DICT",
        WireLayout::PyTuple => "PY_TUPLE",
        WireLayout::PyList => "PY_LIST",
        WireLayout::EntityCall => "ENTITYCALL",
        WireLayout::Vec2 => "VECTOR2",
        WireLayout::Vec3 => "VECTOR3",
        WireLayout::Vec4 => "VECTOR4",
        WireLayout::Array(_) => "ARRAY",
        WireLayout::FixedDict(_) => "FIXED_DICT",
    }
}

/// 渲染布局树:`name` 字段名;`offset` = 相对父容器起点偏移(前驱全定长
/// 才可得,否则 None)。返回 (节点, 本容器结束偏移)。
fn render_layout(layout: &WireLayout, name: &str, offset: Option<usize>) -> (Value, Option<usize>) {
    let size = fixed_size(layout);
    let mut node = json!({
        "name": name,
        "kind": kind_of(layout),
        "size": size,          // null = 动态(长度前缀/变长)
        "offset": offset,      // null = 偏移不可精确计算
    });
    match layout {
        WireLayout::Array(elem) => {
            node["lengthPrefix"] = json!(true);
            let (el, _) = render_layout(elem, "[element]", None);
            node["element"] = el;
            // 动态容器:结束偏移不可知。
            (node, None)
        }
        WireLayout::FixedDict(fields) => {
            // 子字段偏移相对本容器起点(0 基),与本容器自身位置无关;前驱
            // 字段变长后,后续偏移不可算(不伪精确)。
            let mut off = Some(0usize);
            let mut children = Vec::new();
            for field in fields {
                let (child, end) = render_layout(&field.layout, &field.name, off);
                children.push(child);
                off = end; // None 传播:后续字段偏移不可算
            }
            node["fields"] = Value::Array(children);
            // 容器结束(相对父容器) = 自身偏移 + 内部总长;仅当全部字段定长
            // 且自身位置已知才可得。
            let end = if fields.iter().all(|f| fixed_size(&f.layout).is_some()) {
                let total: usize = fields.iter().filter_map(|f| fixed_size(&f.layout)).sum();
                offset.map(|o| o + total)
            } else {
                None
            };
            (node, end)
        }
        _ => {
            // 定长字段:结束 = 起点 + 尺寸;起点未知(前驱变长)→ 结束也不可知
            // (绝不 `offset.unwrap_or(0)` 造伪精确绝对偏移)。
            let end = match (size, offset) {
                (Some(s), Some(o)) => Some(o + s),
                _ => None,
            };
            (node, end)
        }
    }
}

/// 方法参数类型 token(`<Arg> UINT32 </Arg>` 首词;空参回落 STRING)。
fn arg_type_token(arg: &str) -> &str {
    arg.split_whitespace().next().unwrap_or("STRING")
}

/// `protocol_frame`:画协议帧结构。三种入口:
/// - `typeName`:直接解析 types.xml/alias.xml 类型的布局。
/// - `entity` + `method`:该实体远程方法(三节任意)各参数的帧结构。
///
/// 无入口 → Err。`typeName` 优先于 entity+method。
pub fn protocol_frame(
    kb: &AssetKnowledge,
    type_name: Option<&str>,
    entity: Option<&str>,
    method: Option<&str>,
    section: Option<&str>,
) -> Result<Value, String> {
    let resolver = WireSchema::from_sources(
        kb.types_text.as_deref().unwrap_or(""),
        kb.alias_text.as_deref().unwrap_or(""),
    );
    if let Some(type_name) = type_name {
        let layout = resolver
            .resolve(type_name)
            .map_err(|e| format!("{type_name}: {e}"))?;
        let (root, _) = render_layout(&layout, type_name, Some(0));
        return Ok(json!({ "type": type_name, "layout": root }));
    }
    let entity = entity.ok_or("missing argument: entity (or typeName)")?;
    let method = method.ok_or("missing argument: method (or typeName)")?;
    let def = kb
        .defs
        .get(entity)
        .ok_or_else(|| format!("entity not found: {entity}"))?;
    let sections: [(&str, &[kode_parser::model::MethodDef]); 3] = [
        ("BaseMethods", &def.model.base_methods),
        ("CellMethods", &def.model.cell_methods),
        ("ClientMethods", &def.model.client_methods),
    ];
    let (section, m) = match section {
        // 显式节过滤:同名方法跨节消歧。
        Some(sec) => {
            let matched = sections
                .iter()
                .find(|(name, _)| *name == sec)
                .ok_or_else(|| {
                    format!("unknown section: {sec} (expected BaseMethods | CellMethods | ClientMethods)")
                })?;
            let m = matched
                .1
                .iter()
                .find(|m| m.name == method)
                .ok_or_else(|| format!("method not found: {entity}.{method} in {sec}"))?;
            (matched.0, m)
        }
        // 未给节:按 Base/Cell/Client 顺序取首个(如实告知)。
        None => {
            let matched = sections
                .iter()
                .find(|(_, list)| list.iter().any(|m| m.name == method))
                .ok_or_else(|| format!("method not found: {entity}.{method}"))?;
            let m = matched
                .1
                .iter()
                .find(|m| m.name == method)
                .expect("method present");
            (matched.0, m)
        }
    };
    let mut fields = Vec::new();
    let mut off = Some(0usize);
    for arg in &m.args {
        let tok = arg_type_token(arg);
        let layout = resolver
            .resolve(tok)
            .map_err(|e| format!("arg {arg:?}: {e}"))?;
        let (field, end) = render_layout(&layout, tok, off);
        fields.push(field);
        off = end; // 累计帧体偏移(全定长才可得)
    }
    Ok(json!({
        "frame": format!("{entity}.{method}"),
        "section": section,
        "argCount": fields.len(),
        "fields": fields,
        "source": { "file": def.rel_path, "line": m.line },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kb() -> AssetKnowledge {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("tests/fixtures/kbengine-demo-assets");
        AssetKnowledge::load(&root)
    }

    #[test]
    fn resolves_type_to_fixed_dict_layout() {
        let k = kb();
        // SKILL_SLOT 是 types.xml 的 FIXED_DICT(注意 SKILL_SLOT_DATA 是
        // implementedBy 的 Python 模块路径,不是类型名)。
        let out = protocol_frame(&k, Some("SKILL_SLOT"), None, None, None).expect("frame");
        assert_eq!(out["type"], "SKILL_SLOT");
        assert_eq!(out["layout"]["kind"], "FIXED_DICT");
        assert!(!out["layout"]["fields"].as_array().unwrap().is_empty());
        // slot_list 是 ARRAY of UINT32(长度前缀动态),count 是 UINT32 定长。
        let fields = out["layout"]["fields"].as_array().unwrap();
        let slot = fields.iter().find(|f| f["name"] == "slot_list").expect("slot_list");
        assert_eq!(slot["kind"], "ARRAY");
        assert_eq!(slot["size"], Value::Null); // 动态
        let count = fields.iter().find(|f| f["name"] == "count").expect("count");
        assert_eq!(count["size"], 4);
    }

    #[test]
    fn method_frame_resolves_args_with_offsets() {
        let k = kb();
        // Account.reqCreateAvatar 单参 STRING(长度前缀动态)。
        let out = protocol_frame(&k, None, Some("Account"), Some("reqCreateAvatar"), None).expect("frame");
        assert_eq!(out["frame"], "Account.reqCreateAvatar");
        assert_eq!(out["argCount"], 1);
        assert_eq!(out["fields"][0]["name"], "STRING");
        assert_eq!(out["fields"][0]["offset"], 0);
        assert_eq!(out["fields"][0]["size"], Value::Null); // STRING 动态
    }

    #[test]
    fn missing_method_is_error() {
        let k = kb();
        assert!(protocol_frame(&k, None, Some("Account"), Some("NoSuch"), None).is_err());
    }

    // ---- 偏移诚实性(prove-red:旧码 `offset.unwrap_or(0)` 在变长字段后造伪精确
    //      绝对偏移;字典子字段被赋予容器自身偏移)。----
    #[test]
    fn offset_after_variable_length_is_not_falsely_precise() {
        use kode_server::wire_codec::{WireField, WireLayout};
        let layout = WireLayout::FixedDict(vec![
            WireField { name: "s".into(), layout: WireLayout::Str },
            WireField { name: "a".into(), layout: WireLayout::U32 },
            WireField { name: "b".into(), layout: WireLayout::U16 },
        ]);
        let (node, end) = render_layout(&layout, "T", Some(0));
        let fields = node["fields"].as_array().unwrap();
        // 首字段定长起点 0;其后 a、b 因前驱变长偏移不可算(绝不伪精确 4/6)。
        assert_eq!(fields[0]["offset"], 0);
        assert_eq!(fields[1]["offset"], Value::Null);
        assert_eq!(fields[2]["offset"], Value::Null);
        // 容器整体动态 → 结束偏移不可知。
        assert_eq!(node["size"], Value::Null);
        assert_eq!(end, None);
    }

    #[test]
    fn nested_dict_children_are_relative_to_own_start() {
        use kode_server::wire_codec::{WireField, WireLayout};
        // 内层全定长字典(3×U32);外层把内层放 offset 4 处。
        let inner = WireLayout::FixedDict(vec![
            WireField { name: "x".into(), layout: WireLayout::U32 },
            WireField { name: "y".into(), layout: WireLayout::U32 },
        ]);
        let outer = WireLayout::FixedDict(vec![
            WireField { name: "pre".into(), layout: WireLayout::U32 },
            WireField { name: "inner".into(), layout: inner },
        ]);
        let (node, _) = render_layout(&outer, "Outer", Some(0));
        let fields = node["fields"].as_array().unwrap();
        // 子字段偏移相对本容器起点(0 基),不携带容器自身偏移。
        assert_eq!(fields[0]["offset"], 0);
        assert_eq!(fields[1]["offset"], 4);
        let inner_node = &fields[1];
        let inner_fields = inner_node["fields"].as_array().unwrap();
        // 内层子字段相对内层起点:0、4,而非继承外层的 4。
        assert_eq!(inner_fields[0]["offset"], 0);
        assert_eq!(inner_fields[1]["offset"], 4);
        // 全定长内层 → 定长尺寸 8。
        assert_eq!(inner_node["size"], 8);
    }

    #[test]
    fn nested_all_fixed_dict_is_fixed_size() {
        use kode_server::wire_codec::{WireField, WireLayout};
        let inner = WireLayout::FixedDict(vec![
            WireField { name: "a".into(), layout: WireLayout::U32 },
            WireField { name: "b".into(), layout: WireLayout::U16 },
        ]);
        // 嵌套全定长字典定长(旧码 shallow fixed_size 对 FixedDict 恒 None)。
        assert_eq!(fixed_size(&WireLayout::FixedDict(vec![
            WireField { name: "i".into(), layout: inner.clone() },
        ])), Some(6));
        // 内层含动态字段 → 整体动态。
        let dyn_inner = WireLayout::FixedDict(vec![
            WireField { name: "s".into(), layout: WireLayout::Str },
        ]);
        assert_eq!(fixed_size(&WireLayout::FixedDict(vec![
            WireField { name: "i".into(), layout: dyn_inner },
        ])), None);
    }

    // ---- 跨节同名方法消歧(prove-red:旧码无 section 参,同名方法首节胜)。----
    #[test]
    fn section_filter_disambiguates_same_named_method() {
        let k = kb();
        // 未给节:Base 首节(或实际命中节)返回并带 section 名。
        let any = protocol_frame(&k, None, Some("Account"), Some("reqCreateAvatar"), None)
            .expect("frame");
        assert!(any["section"].as_str().is_some());
        // 显式节过滤:命中该节。
        let sec = any["section"].as_str().unwrap();
        let filtered = protocol_frame(&k, None, Some("Account"), Some("reqCreateAvatar"), Some(sec))
            .expect("frame");
        assert_eq!(filtered["section"], sec);
        // 未知节 → Err。
        assert!(protocol_frame(&k, None, Some("Account"), Some("reqCreateAvatar"), Some("Nope"))
            .is_err());
    }
}
