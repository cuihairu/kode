//! Framing: message frame state machine (PA-003 "framing three length shapes + TCP sticky/split packets").
//!
//! Engine semantics (PA-001 §4/§11): all three ends share the `READ_ID → (READ_LEN → READ_LEN_EX)
//! → READ_BODY` state machine, supporting reassembly of fragments at any byte boundary
//! (packet_reader.cpp:31-250).
//! Red lines: unknown ids are never guessed (default Fail) / per-message memory cap /
//! truncation is deferred to the next feed, no panics.

use kode_kbengine_schema::messages::MessageLength;

use crate::error::{DecodeError, DecodeErrorKind};

/// Per-message length specification (from the framing perspective; §4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LengthSpec {
    /// Fixed length: no length field on the wire.
    Fixed(u32),
    /// Variable: u16 (payload, excluding the id+len header).
    Variable,
    /// Extended: u16=65535 sentinel + u32 actual length (the actual length really read for this frame).
    Extended(u32),
}

/// Unknown id policy (engine: unknown id → ERROR + channel condemned; the parser defaults to matching it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnknownIdPolicy {
    /// Fail with an error ([`DecodeErrorKind::UnknownMessageId`]), matching engine semantics.
    Fail,
    /// Permissive mode: attempt framing as variable length (u16 length) — enable only when deliberately analyzing an unknown project.
    AssumeVariable,
}

#[derive(Debug, Clone)]
pub struct FramingConfig {
    /// id → length spec (from the static segment + the dynamically imported segment).
    pub specs: std::collections::BTreeMap<u16, MessageLength>,
    pub unknown_id_policy: UnknownIdPolicy,
    /// Per-message payload cap (red line: memory bounded; a conservative 1 MiB default
    /// outside the engine, real extended-length payloads are usually far smaller).
    pub max_message_len: u32,
    /// §4.3 packetAlwaysContainLength=true: every message is modeled as carrying a u16 length
    /// (message_handler.cpp:173-175).
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

/// A resolved frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub id: u16,
    pub payload: Vec<u8>,
    pub length_spec: LengthSpec,
    /// Offset of the frame start within the stream (accumulated over this parser's lifetime).
    pub stream_offset: usize,
}

/// Frame state machine carried across feeds (TCP sticky/split-packet safe).
#[derive(Debug)]
pub struct FrameParser {
    cfg: FramingConfig,
    buf: Vec<u8>,
    /// buf[0..consumed] has been consumed and awaits compaction.
    consumed: usize,
    /// Absolute in-stream offset of buf[0] (accumulated by feed; advanced by compact).
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

    /// Bytes in the current buffer that have not yet formed a frame (diagnostics/tests).
    pub fn pending_buffer_len(&self) -> usize {
        self.buf.len() - self.consumed
    }

    pub fn config_mut(&mut self) -> &mut FramingConfig {
        &mut self.cfg
    }

    /// Feed a chunk of a TCP stream and emit every frame fully resolved.
    ///
    /// Error policy (red line): on any Err the state machine **resets** (buffer cleared) — the
    /// engine's semantics condemn the channel after an error; the caller should reopen the parser
    /// or switch policy; decoding never continues on top of a bad state.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, DecodeError> {
        self.buf.extend_from_slice(chunk);
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
        // Runaway guard: the cap constrains only the "still-unresolved remainder" — fully
        // legal frames are resolved first, then the check runs.
        // Checking the total buffer first would invalidate an entire run of legal frames
        // (e.g. the 1.2 MiB loginapp dynamic import stream) just because the total bytes
        // exceed one maximum frame, silently losing legal data.
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
        self.compact();
        Ok(out)
    }

    fn reset(&mut self) {
        // A reset drops the whole buffer (frames already resolved but discarded with the Err,
        // plus unframed residue); the dropped range advances abs_base in lockstep (same
        // ledger as compact): otherwise stream_offset after recovery re-counts from the stale
        // base point and systematically under-reports the in-stream position.
        self.abs_base += self.buf.len();
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

    /// Attempt to resolve one frame from buf[consumed..]; insufficient data → Ok(None) (defer to the next feed).
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
                    // §4.3: the wire carries a length by force (read it and verify it matches the fixed length in the table).
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
                    // Variable: u16 → 65535 sentinel → u32 actual length (packet_reader.cpp:116-167).
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

        // Derive the header size and payload length from the spec.
        let (header, payload_len) = match len_spec {
            LengthSpec::Fixed(n) => (2usize, n as usize),
            LengthSpec::Variable => {
                let declared = u16::from_le_bytes([buf[2], buf[3]]) as usize;
                (4, declared)
            }
            LengthSpec::Extended(n) => (8, n as usize),
        };
        let total = header + payload_len;
        // Aggregate per-frame memory cap check (red line).
        if total as u64 > self.cfg.max_message_len as u64 + 8 {
            return Err(DecodeError::new(
                DecodeErrorKind::MemoryLimit,
                base_offset,
                format!("msg {id}"),
                format!("frame {total} bytes > cap {}", self.cfg.max_message_len),
            ));
        }
        if buf.len() < total {
            return Ok(None); // Fragmented: wait for the next feed
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

/// §8 encrypted envelope location (not decrypted; Blowfish is cryptography, and the
/// protocol engine's red line is zero third-party dependencies):
/// `u16 encLen + u8 padSize + ciphertext`, with encLen = plaintext length + 1
/// (encryption_filter.cpp:56-66).
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
