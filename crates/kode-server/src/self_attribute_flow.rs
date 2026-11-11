//! 流敏感 `self.<attr>` 类型 RPC 面(RUST-MIGRATION-AUDIT-006 B1 车道批 1,
//! LANG-NAR-1):`$/kode/python/selfAttributeFlow` 薄注册,引擎本体在
//! [`kode_python::self_flow`](kode_python::self_flow)(TS
//! selfAttributeFlowTypes.ts 逐字移植)。本文件只做参数/响应形状。
//!
//! 契约(与 TS 纯函数同形):
//! - 入参 `{lines: string[], queryLine, attr, versionKey?}`:lines = 调用方
//!   行数组原样(inlay 路传 `getText().split(/\r?\n/)` 产物,诊断路传掩码行;
//!   Rust 不二次掩码/不切行),queryLine/行号 0 基,attr 为属性名,
//!   versionKey = TS flowVersionKeyForDocument 产物的不透明缓存键(缺省 =
//!   现解析不缓存);
//! - 出参 `{flow: null | {types: string[], annotation: string|null,
//!   hasNone, narrowed}}`:types 升序去重;annotation 为 ` | ` 联接或 null
//!   (types 空);非法入参(attr 空/查询行越界/queryLine 负)→ flow:null,
//!   与 TS inferSelfAttributeFlow 返回 null 逐字对齐;
//! - 本面取代「流证据留 TS 单一来源」旧口径(attribute_none.rs 头注同步),
//!   TS 引擎保留为兜底(kbengine.core.backend=ts 杀开关语义不变)。

use serde::Deserialize;
use serde_json::{json, Value};

use kode_python::self_flow::{infer_self_attribute_flow, SelfAttributeFlow};

use crate::rpc::RpcRegistry;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/python/selfAttributeFlow", self_attribute_flow);
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SelfAttributeFlowParams {
    /// 调用方行数组原样(不掩码/不切行)
    lines: Vec<String>,
    /// 0 基查询行(负值非法 → flow null)
    query_line: i64,
    /// 属性名(空 → flow null)
    attr: String,
    /// LRU 解析缓存键(不透明字符串;缺省不缓存)
    version_key: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SelfAttributeFlowPayload {
    types: Vec<String>,
    annotation: Option<String>,
    has_none: bool,
    narrowed: bool,
}

fn self_attribute_flow(params: Value) -> Result<Value, String> {
    let params: SelfAttributeFlowParams =
        serde_json::from_value(params).map_err(|err| err.to_string())?;
    let flow = if params.query_line < 0 {
        None
    } else {
        let lines: Vec<Vec<u16>> = params
            .lines
            .iter()
            .map(|line| line.encode_utf16().collect())
            .collect();
        infer_self_attribute_flow(
            &lines,
            params.query_line as usize,
            &params.attr.encode_utf16().collect::<Vec<u16>>(),
            params.version_key.as_deref(),
        )
        .map(
            |SelfAttributeFlow {
                 types,
                 annotation,
                 has_none,
                 narrowed,
             }| {
                SelfAttributeFlowPayload {
                    types,
                    annotation,
                    has_none,
                    narrowed,
                }
            },
        )
    };
    Ok(json!({ "flow": flow }))
}
