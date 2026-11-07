// ---------------------------------------------------------------------------
// 字节辅助(全小端)
// ---------------------------------------------------------------------------

pub(super) fn push_le_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub(super) fn push_le_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub(super) fn push_blob(out: &mut Vec<u8>, bytes: &[u8]) {
    push_le_u32(out, bytes.len() as u32);
    out.extend_from_slice(bytes);
}
