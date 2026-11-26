//! Local-variable return-annotation receiver typing RPC face (precision main-lane batch D): `$/kode/python/localReturnType`
//! thin registration; the engine itself lives in [`kode_python::local_return`](kode_python::local_return)
//! (the same-file inferable subset after the TS pythonReturnTypeInference.ts cascade fallback was removed).
//! This file only defines the parameter/response shapes.
//!
//! Contract:
//! - Input `{lines: string[], hoverLine, hoverColumn?, word, versionKey?}`:
//!   lines = the caller's line array as-is (the hover path passes the product of `getText().split(/\r?\n/)`,
//!   Rust does not re-mask or re-split lines); hoverLine is 0-based; hoverColumn = 0-based UTF-16 column
//!   (same stance as VSCode Position.character; defaults to a conservative fallback of the first non-whitespace column, never
//!   fabricating a whole-line last-write point); word = the hover word; versionKey = opaque cache key (defaults to
//!   no caching of the current parse);
//! - Output `{ret: null | {target, annotation, methodName}}`: null = no inferable return annotation in the same file
//!   (honest empty; hover falls back to the TS chain); illegal input (empty word / out-of-range line /
//!   negative hoverLine) -> ret:null;
//! - The TS-side import-binding path is preserved (receiver correctness); this face only answers the same-file inferable subset,
//!   miss/fail/kill switch (kbengine.core.backend=ts) -> the TS chain fallback is unchanged.

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
    /// The caller's line array as-is (no masking / no line splitting)
    lines: Vec<String>,
    /// 0-based hover line (negative is illegal -> ret null)
    hover_line: i64,
    /// 0-based UTF-16 hover column (negative is illegal -> conservative fallback for a missing column)
    hover_column: Option<i64>,
    /// The hover word (empty -> ret null)
    word: String,
    /// LRU parse cache key (opaque string; defaults to no caching)
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
    let params: LocalReturnParams =
        serde_json::from_value(params).map_err(|err| err.to_string())?;
    let ret = if params.hover_line < 0 {
        None
    } else {
        let lines: Vec<Vec<u16>> = params
            .lines
            .iter()
            .map(|line| line.encode_utf16().collect())
            .collect();
        // RUST-072: cancellation (Err) settles through the worker per the cancellation table as -32800; passed through here.
        local_return_type(
            &lines,
            params.hover_line as usize,
            // Negative column = the missing-column stance, conservative fallback (does not fabricate a later write on the same line)
            params.hover_column.filter(|c| *c >= 0).map(|c| c as usize),
            &params.word.encode_utf16().collect::<Vec<u16>>(),
            params.version_key.as_deref(),
        )?
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
