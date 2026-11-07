// ---------------------------------------------------------------------------
// 消息帧(network/bundle.cpp:273-395;common.h:88-92)
// ---------------------------------------------------------------------------

use super::bytes::{push_le_u16, push_le_u32};
use super::cursor::WireCursor;
use super::errors::WireError;

// ---------------------------------------------------------------------------
// 消息帧(network/bundle.cpp:273-395;common.h:88-92)
// ---------------------------------------------------------------------------

/// 消息帧:msgid + 变长长度(载荷不含 4 头字节;≥65535→长度=65535+u32 扩展)。
pub fn encode_message_frame(
    msg_id: u16,
    body: &[u8],
    variable_length: bool,
    out: &mut Vec<u8>,
) -> Result<(), WireError> {
    push_le_u16(out, msg_id);
    if !variable_length {
        out.extend_from_slice(body);
        return Ok(());
    }
    let payload = body.len();
    if payload > u32::MAX as usize {
        return Err(WireError::MessageTooLarge { size: payload });
    }
    if payload >= 65535 {
        // 长度字段=65535 + 后插 u32 扩展长(bundle.cpp:358-371)。
        push_le_u16(out, 65535);
        push_le_u32(out, payload as u32);
    } else {
        push_le_u16(out, payload as u16);
    }
    out.extend_from_slice(body);
    Ok(())
}

/// 解码消息帧:定长=读固定 body;变长=读 u16 长度(==65535 则再读 u32 扩展)。
pub fn decode_message_frame(
    cur: &mut WireCursor,
    variable_length: bool,
    fixed_len: Option<usize>,
) -> Result<(u16, Vec<u8>), WireError> {
    let msg_id = cur.read_u16()?;
    if !variable_length {
        let len = fixed_len.unwrap_or(0);
        let body = cur.take(len)?.to_vec();
        return Ok((msg_id, body));
    }
    let mut len = cur.read_u16()? as usize;
    if len == 65535 {
        len = cur.read_u32()? as usize;
    }
    let body = cur.take(len)?.to_vec();
    Ok((msg_id, body))
}
