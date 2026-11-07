// ---------------------------------------------------------------------------
// hex 辅助(golden/RPC 边界用)
// ---------------------------------------------------------------------------

use super::errors::WireError;

// ---------------------------------------------------------------------------
// hex 辅助(golden/RPC 边界用)
// ---------------------------------------------------------------------------

/// 小写 hex(无分隔)。
pub fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 解析小写/大写 hex。
pub fn from_hex(s: &str) -> Result<Vec<u8>, WireError> {
    if !s.len().is_multiple_of(2) {
        return Err(WireError::InvalidHex(s.to_string()));
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_val(bytes[i]).ok_or_else(|| WireError::InvalidHex(s.to_string()))?;
        let lo = hex_val(bytes[i + 1]).ok_or_else(|| WireError::InvalidHex(s.to_string()))?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
