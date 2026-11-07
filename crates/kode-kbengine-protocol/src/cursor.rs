//! 零拷贝游标:对 `&[u8]` 的边界检查读取(失败返回 [`DecodeError`],绝不
//! panic、绝不越界)。字符串语义逐条对齐引擎(PA-001 §3.1)。

use kode_kbengine_schema::wire::WireType;

use crate::codec::DecodeLimits;
use crate::error::{DecodeError, DecodeErrorKind};

/// 对一块只读字节的游标(`offset()` 为流内绝对偏移)。
#[derive(Debug)]
pub struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Cursor { data, pos: 0 }
    }

    pub fn offset(&self) -> usize {
        self.pos
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    pub fn at_end(&self) -> bool {
        self.pos >= self.data.len()
    }

    /// 借出剩余全部字节(零拷贝;Raw 保留用)。
    pub fn rest(&self) -> &'a [u8] {
        &self.data[self.pos.min(self.data.len())..]
    }

    fn need(&mut self, n: usize, path: &str) -> Result<(), DecodeError> {
        if self.remaining() < n {
            return Err(DecodeError::new(
                DecodeErrorKind::UnexpectedEof,
                self.pos,
                path,
                format!("need {n} bytes, have {}", self.remaining()),
            ));
        }
        Ok(())
    }

    fn read_slice(&mut self, n: usize, path: &str) -> Result<&'a [u8], DecodeError> {
        self.need(n, path)?;
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub fn read_bytes(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        self.read_slice(n, "bytes")
    }

    pub fn peek_u16(&self, path: &str) -> Result<u16, DecodeError> {
        if self.remaining() < 2 {
            return Err(DecodeError::new(
                DecodeErrorKind::UnexpectedEof,
                self.pos,
                path,
                format!("peek u16: have {}", self.remaining()),
            ));
        }
        Ok(u16::from_le_bytes([
            self.data[self.pos],
            self.data[self.pos + 1],
        ]))
    }

    pub fn read_u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.read_slice(1, "u8")?[0])
    }

    pub fn read_i8(&mut self) -> Result<i8, DecodeError> {
        Ok(self.read_slice(1, "i8")?[0] as i8)
    }

    pub fn read_u16(&mut self) -> Result<u16, DecodeError> {
        let b = self.read_slice(2, "u16")?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn read_i16(&mut self) -> Result<i16, DecodeError> {
        let b = self.read_slice(2, "i16")?;
        Ok(i16::from_le_bytes([b[0], b[1]]))
    }

    pub fn read_u32(&mut self) -> Result<u32, DecodeError> {
        let b = self.read_slice(4, "u32")?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn read_i32(&mut self) -> Result<i32, DecodeError> {
        Ok(self.read_u32()? as i32)
    }

    pub fn read_u64(&mut self) -> Result<u64, DecodeError> {
        let b = self.read_slice(8, "u64")?;
        Ok(u64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    pub fn read_i64(&mut self) -> Result<i64, DecodeError> {
        Ok(self.read_u64()? as i64)
    }

    pub fn read_f32(&mut self) -> Result<f32, DecodeError> {
        Ok(f32::from_le_bytes(
            self.read_slice(4, "f32")?.try_into().unwrap(),
        ))
    }

    pub fn read_f64(&mut self) -> Result<f64, DecodeError> {
        Ok(f64::from_le_bytes(
            self.read_slice(8, "f64")?.try_into().unwrap(),
        ))
    }

    /// 协议参数 STRING(memorystream.h:319-332 口径):逐字节扫描到 `\0`;
    /// **非 ASCII 字节(≥0x80)同样提前终止**(引擎逐字节读 char > 0 时
    /// break 的行为)。无 NUL 时读到流尾(容错,不报错)。
    pub fn read_cstring(&mut self) -> Result<String, DecodeError> {
        let start = self.pos;
        let rest = self.rest();
        let mut len = 0usize;
        for &b in rest {
            if b == 0 || b >= 0x80 {
                break;
            }
            len += 1;
        }
        self.pos += len
            + if len < rest.len() && rest[len] == 0 {
                1
            } else {
                0
            };
        let bytes = &self.data[start..start + len];
        Ok(String::from_utf8_lossy(bytes).into_owned())
    }

    /// u32 长度前缀块(UNICODE/BLOB/PYTHON,datatype.cpp:1129-1143 等)。
    /// 长度上限 [`DecodeLimits::max_blob`](红线:内存有上限)。
    pub fn read_blob(&mut self, limits: &DecodeLimits) -> Result<&'a [u8], DecodeError> {
        let len = self.read_u32()?;
        self.read_sized_body(len as usize, limits, "blob")
    }

    /// 已知声明长度的定体读取(长度/上限/EOF 三重检查)。
    pub fn read_sized_body(
        &mut self,
        len: usize,
        limits: &DecodeLimits,
        path: &str,
    ) -> Result<&'a [u8], DecodeError> {
        if len > limits.max_blob {
            return Err(DecodeError::new(
                DecodeErrorKind::MemoryLimit,
                self.pos,
                path,
                format!("declared {len} > cap {}", limits.max_blob),
            ));
        }
        self.read_slice(len, path)
    }
}

/// UTF-8 体解码(codec 用;偏移诊断在此层落位)。
pub fn read_utf8_body<'a>(
    cur: &mut Cursor<'a>,
    len: usize,
    limits: &DecodeLimits,
) -> Result<String, DecodeError> {
    let bytes = cur.read_sized_body(len, limits, "unicode")?;
    Ok(String::from_utf8_lossy(bytes).into_owned())
}

/// 编译期哨兵:WireType 属于变长前缀族(供 framing/codec 共享的口径)。
pub fn is_length_prefixed(ty: &WireType) -> bool {
    matches!(
        ty,
        WireType::Unicode | WireType::Blob | WireType::Python | WireType::Array { .. }
    )
}
