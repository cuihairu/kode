//! Framing:消息帧状态机(PA-003「framing 三种长度 + TCP 粘包拆包」)。
//!
//! 引擎口径(PA-001 §4/§11):三端共享 `READ_ID → (READ_LEN → READ_LEN_EX)
//! → READ_BODY` 状态机,支持任意字节边界的分片重组(packet_reader.cpp:31-250)。
//! 红线:未知 id 不猜(默认 Fail)/ 单消息内存上限 / 截断留待下个 feed,不 panic。

use kode_kbengine_schema::messages::MessageLength;

use crate::error::{DecodeError, DecodeErrorKind};

/// 单消息长度规格(framing 视角;§4.2)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LengthSpec {
    /// 定长:线上无长度字段。
    Fixed(u32),
    /// 变长:u16(载荷,不含 id+len 头)。
    Variable,
    /// 扩展:u16=65535 哨兵 + u32 实长(本帧实际读到的实长)。
    Extended(u32),
}

/// 未知 id 策略(引擎:未知 id → ERROR + 通道 condemned;解析器默认对齐)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnknownIdPolicy {
    /// 报错([`DecodeErrorKind::UnknownMessageId`]),与引擎语义一致。
    Fail,
    /// 宽松模式:按变长(u16 长度)试探组帧——仅在明确分析未知工程时启用。
    AssumeVariable,
}

#[derive(Debug, Clone)]
pub struct FramingConfig {
    /// id → 长度规格(来自静态段 + 动态导入段)。
    pub specs: std::collections::BTreeMap<u16, MessageLength>,
    pub unknown_id_policy: UnknownIdPolicy,
    /// 单消息载荷上限(红线:内存有上限;引擎外保守默认 1 MiB,
    /// 扩展长度真实载荷通常远小于此)。
    pub max_message_len: u32,
    /// §4.3 packetAlwaysContainLength=true:所有消息按带 u16 长度建模
    /// (message_handler.cpp:173-175)。
    pub packet_always_contain_length: bool,
}

impl Default for FramingConfig {
    fn default() -> Self {
        FramingConfig {
            specs: std::collections::BTreeMap::new(),
            unknown_id_policy: UnknownIdPolicy::Fail,
            max_message_len: 1 << 20,
            packet_always_contain_length: false,
        }
    }
}

/// 解出的帧。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub id: u16,
    pub payload: Vec<u8>,
    pub length_spec: LengthSpec,
    /// 帧起点在流内的偏移(本 parser 生命周期内累计)。
    pub stream_offset: usize,
}

/// 跨 feed 的帧状态机(TCP 粘包/拆包安全)。
#[derive(Debug)]
pub struct FrameParser {
    cfg: FramingConfig,
    buf: Vec<u8>,
    /// buf[0..consumed] 已消费、待压缩。
    consumed: usize,
    /// buf[0] 的流内绝对偏移(feed 累计;compact 推进)。
    abs_base: usize,
}

impl FrameParser {
    pub fn new(cfg: FramingConfig) -> Self {
        FrameParser {
            cfg,
            buf: Vec::new(),
            consumed: 0,
            abs_base: 0,
        }
    }

    /// 当前缓冲中未成帧的字节数(诊断/测试用)。
    pub fn pending_buffer_len(&self) -> usize {
        self.buf.len() - self.consumed
    }

    pub fn config_mut(&mut self) -> &mut FramingConfig {
        &mut self.cfg
    }

    /// 喂入一段 TCP 流,吐出所有已完整解出的帧。
    ///
    /// 错误策略(红线):任何 Err 时状态机**复位**(缓冲清空)——引擎语义是
    /// 错误后 condemn 通道,调用方应重开解析器或换策略;绝不在坏状态上继续。
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, DecodeError> {
        self.buf.extend_from_slice(chunk);
        // 防失控:待解析缓冲超上限(等价于一条不允许的最大帧也放不下)→ 复位。
        if self.buf.len() - self.consumed > self.cfg.max_message_len as usize + 8 {
            let len = self.buf.len() - self.consumed;
            self.reset();
            return Err(DecodeError::new(
                DecodeErrorKind::MemoryLimit,
                self.abs_base.saturating_sub(len),
                "framing.buffer",
                format!("pending buffer {len} > cap {}", self.cfg.max_message_len),
            ));
        }
        let mut out = Vec::new();
        loop {
            match self.try_one_frame() {
                Ok(Some(frame)) => out.push(frame),
                Ok(None) => break,
                Err(e) => {
                    self.reset();
                    return Err(e);
                }
            }
        }
        self.compact();
        Ok(out)
    }

    fn reset(&mut self) {
        self.buf.clear();
        self.consumed = 0;
    }

    fn compact(&mut self) {
        if self.consumed > 0 {
            self.abs_base += self.consumed;
            self.buf.drain(..self.consumed);
            self.consumed = 0;
        }
    }

    /// 尝试从 buf[consumed..] 解一帧;数据不足 → Ok(None)(留待下个 feed)。
    fn try_one_frame(&mut self) -> Result<Option<Frame>, DecodeError> {
        let start = self.consumed;
        let buf = &self.buf[start..];
        if buf.len() < 2 {
            return Ok(None);
        }
        let id = u16::from_le_bytes([buf[0], buf[1]]);
        let base_offset = self.abs_base + start;
        let len_spec = match self.cfg.specs.get(&id) {
            Some(MessageLength::Fixed(n)) => {
                if self.cfg.packet_always_contain_length {
                    // §4.3:线上强制带长度(读取并校验与表内定长一致)。
                    if buf.len() < 4 {
                        return Ok(None);
                    }
                    let declared = u16::from_le_bytes([buf[2], buf[3]]) as u32;
                    if *n > 0 && declared != *n {
                        return Err(DecodeError::new(
                            DecodeErrorKind::MemoryLimit,
                            base_offset,
                            format!("msg {id}"),
                            format!("declared len {declared} != fixed {n}"),
                        ));
                    }
                    LengthSpec::Variable
                } else {
                    LengthSpec::Fixed(*n)
                }
            }
            Some(MessageLength::Variable) | None => {
                if self.cfg.specs.contains_key(&id)
                    || self.cfg.unknown_id_policy == UnknownIdPolicy::AssumeVariable
                {
                    // 变长:u16 → 65535 哨兵 → u32 实长(packet_reader.cpp:116-167)。
                    if buf.len() < 4 {
                        return Ok(None);
                    }
                    let declared = u16::from_le_bytes([buf[2], buf[3]]);
                    if declared == 65535 {
                        if buf.len() < 8 {
                            return Ok(None);
                        }
                        let ext = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
                        if ext > self.cfg.max_message_len {
                            return Err(DecodeError::new(
                                DecodeErrorKind::MemoryLimit,
                                base_offset,
                                format!("msg {id}"),
                                format!("extended len {ext} > cap {}", self.cfg.max_message_len),
                            ));
                        }
                        LengthSpec::Extended(ext)
                    } else {
                        if declared as u32 > self.cfg.max_message_len {
                            return Err(DecodeError::new(
                                DecodeErrorKind::MemoryLimit,
                                base_offset,
                                format!("msg {id}"),
                                format!(
                                    "declared len {declared} > cap {}",
                                    self.cfg.max_message_len
                                ),
                            ));
                        }
                        LengthSpec::Variable
                    }
                } else {
                    return Err(DecodeError::new(
                        DecodeErrorKind::UnknownMessageId,
                        base_offset,
                        "framing",
                        format!("unknown message id {id}"),
                    ));
                }
            }
        };

        // 由规格算头部大小与载荷长。
        let (header, payload_len) = match len_spec {
            LengthSpec::Fixed(n) => (2usize, n as usize),
            LengthSpec::Variable => {
                let declared = u16::from_le_bytes([buf[2], buf[3]]) as usize;
                (4, declared)
            }
            LengthSpec::Extended(n) => (8, n as usize),
        };
        let total = header + payload_len;
        // 单帧内存上限总检查(红线)。
        if total as u64 > self.cfg.max_message_len as u64 + 8 {
            return Err(DecodeError::new(
                DecodeErrorKind::MemoryLimit,
                base_offset,
                format!("msg {id}"),
                format!("frame {total} bytes > cap {}", self.cfg.max_message_len),
            ));
        }
        if buf.len() < total {
            return Ok(None); // 分片:等下个 feed
        }
        let payload = buf[header..total].to_vec();
        self.consumed += total;
        Ok(Some(Frame {
            id,
            payload,
            length_spec: len_spec,
            stream_offset: base_offset,
        }))
    }
}

/// §8 加密信封定位(不解密;Blowfish 属密码学,协议引擎零第三方依赖红线):
/// `u16 encLen + u8 padSize + 密文`,encLen = 明文长 + 1
/// (encryption_filter.cpp:56-66)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedEnvelope {
    pub declared_plaintext_len: u32,
    pub pad_size: u8,
    pub ciphertext: Vec<u8>,
}

pub fn parse_encrypted_envelope(data: &[u8]) -> Result<EncryptedEnvelope, DecodeError> {
    if data.len() < 3 {
        return Err(DecodeError::new(
            DecodeErrorKind::UnexpectedEof,
            0,
            "envelope",
            format!("need >=3 bytes, have {}", data.len()),
        ));
    }
    let enc_len = u16::from_le_bytes([data[0], data[1]]) as u32;
    let pad = data[2];
    if enc_len > (1 << 20) {
        return Err(DecodeError::new(
            DecodeErrorKind::MemoryLimit,
            0,
            "envelope",
            format!("encLen {enc_len} > cap"),
        ));
    }
    let need = 3 + enc_len as usize;
    if data.len() < need {
        return Err(DecodeError::new(
            DecodeErrorKind::UnexpectedEof,
            data.len(),
            "envelope",
            format!("declared {enc_len}, have {}", data.len() - 3),
        ));
    }
    Ok(EncryptedEnvelope {
        declared_plaintext_len: enc_len.saturating_sub(1),
        pad_size: pad,
        ciphertext: data[3..need].to_vec(),
    })
}
