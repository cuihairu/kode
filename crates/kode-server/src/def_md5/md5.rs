//! def MD5 基础:RFC 1321 手写 MD5(SRC-008 阶段 1 自 def_md5 迁出,纯移动)
//! 与带溯源踪迹的字节流构建器(DefMd5Stream/TraceEntry/to_hex)。区域原文
//! 零改动;finish 需要 DefMd5Result,自父模块导入(类型,无运行时环)。
use super::DefMd5Result;
// ===========================================================================
// MD5(RFC 1321,手写:无新依赖红线)
// ===========================================================================

const MD5_S: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

/// RFC 1321 MD5(镜像引擎 OpenSSL MD5;输出小端 digest)。
#[derive(Clone, Debug)]
pub struct Md5 {
    state: [u32; 4],
    buffer: [u8; 64],
    buffered: usize,
    total: u64,
}

impl Md5 {
    pub fn new() -> Self {
        Md5 {
            state: [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476],
            buffer: [0u8; 64],
            buffered: 0,
            total: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.total = self.total.wrapping_add(data.len() as u64);
        if self.buffered > 0 {
            let need = 64 - self.buffered;
            let take = need.min(data.len());
            self.buffer[self.buffered..self.buffered + take].copy_from_slice(&data[..take]);
            self.buffered += take;
            data = &data[take..];
            if self.buffered == 64 {
                let block = self.buffer;
                self.process_block(&block);
                self.buffered = 0;
            }
        }
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            self.process_block(&block);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buffer[self.buffered..self.buffered + data.len()].copy_from_slice(data);
            self.buffered += data.len();
        }
    }

    pub fn finalize(mut self) -> [u8; 16] {
        let bit_len = self.total.wrapping_mul(8);
        self.update(&[0x80]);
        while self.buffered != 56 {
            self.update(&[0x00]);
        }
        self.update(&bit_len.to_le_bytes());
        let mut out = [0u8; 16];
        for (i, word) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_le_bytes());
        }
        out
    }

    fn process_block(&mut self, block: &[u8; 64]) {
        let mut m = [0u32; 16];
        for i in 0..16 {
            m[i] = u32::from_le_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        let (mut a, mut b, mut c, mut d) =
            (self.state[0], self.state[1], self.state[2], self.state[3]);
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let tmp = d;
            d = c;
            c = b;
            let sum = a.wrapping_add(f).wrapping_add(MD5_K[i]).wrapping_add(m[g]);
            b = b.wrapping_add(sum.rotate_left(MD5_S[i]));
            a = tmp;
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
    }
}

impl Default for Md5 {
    fn default() -> Self {
        Self::new()
    }
}

// ===========================================================================
// 字节流构建器(带溯源踪迹,golden 可审计)
// ===========================================================================

/// 单段 append 的溯源记录(字段名+引擎 file:line+字节 hex)。
#[derive(Clone, Debug)]
pub struct TraceEntry {
    pub field: String,
    pub source: String,
    pub bytes_hex: String,
}

/// def MD5 字节流:喂 MD5 的同时镜像留痕。
#[derive(Clone, Debug)]
pub struct DefMd5Stream {
    md5: Md5,
    bytes: Vec<u8>,
    trace: Vec<TraceEntry>,
}

impl DefMd5Stream {
    pub fn new() -> Self {
        DefMd5Stream {
            md5: Md5::new(),
            bytes: Vec::new(),
            trace: Vec::new(),
        }
    }

    pub(super) fn append(&mut self, field: &str, source: &str, data: &[u8]) {
        self.md5.update(data);
        self.bytes.extend_from_slice(data);
        self.trace.push(TraceEntry {
            field: field.to_string(),
            source: source.to_string(),
            bytes_hex: to_hex(data),
        });
    }

    /// 引擎裸字符串(无长度前缀无 NUL)。
    pub fn append_str(&mut self, field: &str, source: &str, s: &str) {
        self.append(field, source, s.as_bytes());
    }

    pub fn append_u16(&mut self, field: &str, source: &str, v: u16) {
        self.append(field, source, &v.to_le_bytes());
    }

    pub fn append_u32(&mut self, field: &str, source: &str, v: u32) {
        self.append(field, source, &v.to_le_bytes());
    }

    pub fn append_i32(&mut self, field: &str, source: &str, v: i32) {
        self.append(field, source, &v.to_le_bytes());
    }

    pub fn append_bool(&mut self, field: &str, source: &str, v: bool) {
        // C++ sizeof(bool)=1。
        self.append(field, source, &[v as u8]);
    }

    pub fn stream_hex(&self) -> String {
        to_hex(&self.bytes)
    }

    pub fn finish(self) -> DefMd5Result {
        let digest = self.md5.clone().finalize();
        DefMd5Result {
            md5_hex: to_hex(&digest).to_uppercase(),
            stream_hex: to_hex(&self.bytes),
            trace: self.trace,
        }
    }
}

impl Default for DefMd5Stream {
    fn default() -> Self {
        Self::new()
    }
}

pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}
