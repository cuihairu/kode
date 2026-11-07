//! 实体消息解码(PA-003「entity 属性方法」)。
//!
//! 取证口径:
//! - 远程方法调用(§7):`i32 entityID + 逐参数`(entitycallabstract.cpp:104-121
//!   选消息,remote_entity_method.cpp:62-88 逐参写)——两端形状一致,解码。
//! - 服务端 → 客户端属性同步流的字段级格式(别名 ID vs utype 双模、
//!   volatile 位打包)**PA-001 TODO-3 未逐字节取证**——本模块不实现、不编造;
//!   该类消息按 Raw 保留,待取证后补。
use kode_kbengine_schema::wire::WireType;

use crate::codec::{decode_value, DecodeLimits, Value};
use crate::cursor::Cursor;
use crate::error::{DecodeError, DecodeErrorKind};

/// 一条远程方法调用的解码结果。
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteMethodCall {
    pub entity_id: i32,
    pub args: Vec<Value>,
}

/// 解码 `onRemoteMethodCall` / `onRemoteCallCellMethodFromClient` 载荷:
/// `i32 entityID + 按方法签名逐参数`。
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

/// 属性同步流的占位诊断(PA-001 TODO-3):不猜格式,原始字节保留。
pub fn property_sync_unsupported(offset: usize) -> DecodeError {
    DecodeError::new(
        DecodeErrorKind::InvalidString,
        offset,
        "property_sync",
        "server->client property sync field format not forensically pinned (PA-001 TODO-3); keep raw at message layer",
    )
}
