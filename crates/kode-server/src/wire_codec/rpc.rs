// ---------------------------------------------------------------------------
// RPC 注册
// ---------------------------------------------------------------------------

use crate::rpc::RpcRegistry;

use super::cursor::WireCursor;
use super::hex::{from_hex, to_hex};
use super::types::{WireLayout, WireValue};
use super::values::{decode_value, encode_value};

pub fn register(reg: &mut RpcRegistry) {
    reg.register("$/kode/wire/encode", encode_handler);
    reg.register("$/kode/wire/decode", decode_handler);
}

fn encode_handler(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let layout: WireLayout =
        serde_json::from_value(params.get("layout").cloned().unwrap_or_default())
            .map_err(|e| e.to_string())?;
    let value: WireValue = serde_json::from_value(params.get("value").cloned().unwrap_or_default())
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    encode_value(&layout, &value, &mut out).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "hex": to_hex(&out) }))
}

fn decode_handler(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let layout: WireLayout =
        serde_json::from_value(params.get("layout").cloned().unwrap_or_default())
            .map_err(|e| e.to_string())?;
    let hex = params
        .get("hex")
        .and_then(|v| v.as_str())
        .ok_or("missing hex")?;
    let bytes = from_hex(hex).map_err(|e| e.to_string())?;
    let mut cur = WireCursor::new(&bytes);
    let value = decode_value(&layout, &mut cur).map_err(|e| e.to_string())?;
    serde_json::to_value(&value).map_err(|e| e.to_string())
}
