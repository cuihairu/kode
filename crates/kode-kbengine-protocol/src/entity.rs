//! Entity message decoding (PA-003 "entity properties and methods").
//!
//! Forensic scope:
//! - Remote method calls (§7): `i32 entityID + one value per argument`
//!   (entitycallabstract.cpp:104-121 selects the message,
//!   remote_entity_method.cpp:62-88 writes the arguments one by one) — both ends share the
//!   shape, so this is decoded.
//! - The field-level format of the server → client property sync stream (alias ID vs utype
//!   dual mode, volatile bit packing) is **not byte-for-byte forensically pinned in PA-001
//!   TODO-3** — this module neither implements nor fabricates it; such messages are kept as
//!   Raw until the evidence lands.
use kode_kbengine_schema::wire::WireType;

use crate::codec::{decode_value, DecodeLimits, Value};
use crate::cursor::Cursor;
use crate::error::{DecodeError, DecodeErrorKind};

/// Decoded result of one remote method call.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteMethodCall {
    pub entity_id: i32,
    pub args: Vec<Value>,
}

/// Decode the `onRemoteMethodCall` / `onRemoteCallCellMethodFromClient` payload:
/// `i32 entityID + one value per argument of the method signature`.
pub fn decode_remote_method_call(
    payload: &[u8],
    method_args: &[WireType],
    limits: &DecodeLimits,
) -> Result<RemoteMethodCall, DecodeError> {
    let mut cur = Cursor::new(payload);
    let entity_id = cur.read_i32()?;
    let mut args = Vec::with_capacity(method_args.len());
    for (i, arg_ty) in method_args.iter().enumerate() {
        let v = decode_value(arg_ty, &mut cur, limits, 0).map_err(|mut e| {
            e.path = format!(
                "method.arg[{i}]{}",
                if e.path.is_empty() {
                    String::new()
                } else {
                    format!(".{ }, ", e.path)
                }
            );
            e
        })?;
        args.push(v);
    }
    Ok(RemoteMethodCall { entity_id, args })
}

/// Placeholder diagnostics for the property sync stream (PA-001 TODO-3): no format guessing, raw bytes retained.
pub fn property_sync_unsupported(offset: usize) -> DecodeError {
    DecodeError::new(
        DecodeErrorKind::InvalidString,
        offset,
        "property_sync",
        "server->client property sync field format not forensically pinned (PA-001 TODO-3); keep raw at message layer",
    )
}
