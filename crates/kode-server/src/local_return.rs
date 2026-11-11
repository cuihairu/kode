//! 局部变量返回注解接收者定型 RPC 面(精确性主车道批 D):`$/kode/python/localReturnType`
//! 薄注册,引擎本体在 [`kode_python::local_return`](kode_python::local_return)
//! (TS pythonReturnTypeInference.ts 级联兜底删除后的同文件可推导子集)。
//! 本文件只做参数/响应形状。
//!
//! 契约:
//! - 入参 `{lines: string[], hoverLine, hoverColumn?, word, versionKey?}`:
//!   lines = 调用方行数组原样(hover 路传 `getText().split(/\r?\n/)` 产物,
//!   Rust 不二次掩码/不切行);hoverLine 0 基;hoverColumn = 0 基 UTF-16 列
//!   (VSCode Position.character 同口径;缺省 = 保守回退行首非空白列,绝不
//!   伪造整行最后写点);word = hover 词;versionKey = 不透明缓存键(缺省 =
//!   现解析不缓存);
//! - 出参 `{ret: null | {target, annotation, methodName}}`:null = 同文件无可
//!   推导返回注解(诚实空,hover 回落 TS 链);非法入参(word 空/行越界/
//!   hoverLine 负)→ ret:null;
//! - TS 侧 import 绑定路径保留(接收者正确);本面只答同文件可推导子集,
//!   miss/fail/杀开关(kbengine.core.backend=ts)→ TS 链兜底不变。

use serde::Deserialize;
use serde_json::{json, Value};

use kode_python::local_return::{local_return_type, LocalReturnFace};

use crate::rpc::RpcRegistry;

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/python/localReturnType", local_return);
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct LocalReturnParams {
    /// 调用方行数组原样(不掩码/不切行)
    lines: Vec<String>,
    /// 0 基 hover 行(负值非法 → ret null)
    hover_line: i64,
    /// 0 基 UTF-16 hover 列(负值非法 → 缺列保守回退)
    hover_column: Option<i64>,
    /// hover 词(空 → ret null)
    word: String,
    /// LRU 解析缓存键(不透明字符串;缺省不缓存)
    version_key: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalReturnPayload {
    target: String,
    annotation: String,
    method_name: String,
}

fn local_return(params: Value) -> Result<Value, String> {
    let params: LocalReturnParams = serde_json::from_value(params).map_err(|err| err.to_string())?;
    let ret = if params.hover_line < 0 {
        None
    } else {
        let lines: Vec<Vec<u16>> = params
            .lines
            .iter()
            .map(|line| line.encode_utf16().collect())
            .collect();
        local_return_type(
            &lines,
            params.hover_line as usize,
            // 负列 = 缺列口径,保守回退(不伪造同行后写)
            params.hover_column.filter(|c| *c >= 0).map(|c| c as usize),
            &params.word.encode_utf16().collect::<Vec<u16>>(),
            params.version_key.as_deref(),
        )
        .map(
            |LocalReturnFace {
                 target,
                 annotation,
                 method_name,
             }| {
                LocalReturnPayload {
                    target,
                    annotation,
                    method_name,
                }
            },
        )
    };
    Ok(json!({ "ret": ret }))
}
