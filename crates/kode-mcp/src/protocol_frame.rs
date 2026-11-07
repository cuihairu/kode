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
        _ => return None, // Str/Unicode/Blob/Py*/Array/FixedDict:动态
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
            let mut off = offset;
            let mut children = Vec::new();
            for field in fields {
                let (child, end) = render_layout(&field.layout, &field.name, off);
                children.push(child);
                if let Some(e) = end {
                    off = Some(e);
                } else {
                    off = None; // 后续字段偏移不可算
                }
            }
            node["fields"] = Value::Array(children);
            // FIXED_DICT 定长(所有字段定长)才算结束偏移;否则动态。
            let all_fixed = fields.iter().all(|f| fixed_size(&f.layout).is_some());
            let end = if all_fixed {
                let total: usize = fields.iter().filter_map(|f| fixed_size(&f.layout)).sum();
                Some(offset.unwrap_or(0) + total)
            } else {
                None
            };
            (node, end)
        }
        _ => {
            let end = size.map(|s| offset.unwrap_or(0) + s);
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
    let mut found: Option<(&str, &kode_parser::model::MethodDef)> = None;
    for (section, list) in [
        ("BaseMethods", &def.model.base_methods),
        ("CellMethods", &def.model.cell_methods),
        ("ClientMethods", &def.model.client_methods),
    ] {
        if let Some(m) = list.iter().find(|m| m.name == method) {
            found = Some((section, m));
            break;
        }
    }
    let (section, m) = found.ok_or_else(|| format!("method not found: {entity}.{method}"))?;
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
        let out = protocol_frame(&k, Some("SKILL_SLOT"), None, None).expect("frame");
        assert_eq!(out["type"], "SKILL_SLOT");
        assert_eq!(out["layout"]["kind"], "FIXED_DICT");
        assert!(out["layout"]["fields"].as_array().unwrap().len() >= 1);
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
        let out = protocol_frame(&k, None, Some("Account"), Some("reqCreateAvatar")).expect("frame");
        assert_eq!(out["frame"], "Account.reqCreateAvatar");
        assert_eq!(out["argCount"], 1);
        assert_eq!(out["fields"][0]["name"], "STRING");
        assert_eq!(out["fields"][0]["offset"], 0);
        assert_eq!(out["fields"][0]["size"], Value::Null); // STRING 动态
    }

    #[test]
    fn missing_method_is_error() {
        let k = kb();
        assert!(protocol_frame(&k, None, Some("Account"), Some("NoSuch")).is_err());
    }
}
