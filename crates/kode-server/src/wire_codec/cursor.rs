// ---------------------------------------------------------------------------
// 游标(全小端)
// ---------------------------------------------------------------------------

use super::errors::WireError;

// ---------------------------------------------------------------------------
// 游标(全小端)
// ---------------------------------------------------------------------------

/// 只读游标:全小端,截断即 [`WireError::Truncated`]。编码写入裸 `Vec<u8>`。
#[derive(Debug)]
pub struct WireCursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> WireCursor<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        WireCursor { data, pos: 0 }
    }

    /// 剩余字节数。
    pub fn remaining(&self) -> usize {
        self.data.len() - self.pos
    }

    pub(super) fn take(&mut self, n: usize) -> Result<&'a [u8], WireError> {
        if self.remaining() < n {
            return Err(WireError::Truncated {
                need: n,
                have: self.remaining(),
            });
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub fn read_u8(&mut self) -> Result<u8, WireError> {
        Ok(self.take(1)?[0])
    }

    pub fn read_u16(&mut self) -> Result<u16, WireError> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn read_u32(&mut self) -> Result<u32, WireError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn read_u64(&mut self) -> Result<u64, WireError> {
        let b = self.take(8)?;
        Ok(u64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    pub fn read_i8(&mut self) -> Result<i8, WireError> {
        Ok(self.read_u8()? as i8)
    }

    pub fn read_i16(&mut self) -> Result<i16, WireError> {
        Ok(self.read_u16()? as i16)
    }

    pub fn read_i32(&mut self) -> Result<i32, WireError> {
        Ok(self.read_u32()? as i32)
    }

    pub fn read_i64(&mut self) -> Result<i64, WireError> {
        Ok(self.read_u64()? as i64)
    }

    pub fn read_f32(&mut self) -> Result<f32, WireError> {
        Ok(f32::from_le_bytes(
            self.take(4)?.try_into().expect("4 bytes"),
        ))
    }

    pub fn read_f64(&mut self) -> Result<f64, WireError> {
        Ok(f64::from_le_bytes(
            self.take(8)?.try_into().expect("8 bytes"),
        ))
    }

    /// STRING(NUL 结尾无前缀;遇 NUL 或**非 ASCII** 字节即停,终止字节被消费)。
    pub fn read_cstring(&mut self) -> Result<String, WireError> {
        let mut out: Vec<u8> = Vec::new();
        while self.remaining() > 0 {
            let c = self.read_u8()?;
            if c == 0 || !c.is_ascii() {
                break;
            }
            out.push(c);
        }
        String::from_utf8(out).map_err(|_| WireError::NonAsciiString)
    }

    /// uint32 长度前缀 + 字节(readBlob memorystream.h:425-440;长度超剩余→LengthOverflow)。
    pub fn read_len_prefixed(&mut self) -> Result<Vec<u8>, WireError> {
        let len = self.read_u32()? as usize;
        if len > self.remaining() {
            return Err(WireError::LengthOverflow {
                length: len as u32,
                remaining: self.remaining(),
            });
        }
        Ok(self.take(len)?.to_vec())
    }
}
