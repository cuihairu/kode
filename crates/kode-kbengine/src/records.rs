//! 解码记录 + 异常记录:解局面(PA-003 session)→ 报告面的唯一数据形状。
//!
//! 记录 JSON 同时是 PA-005 分析引擎(`kode-kbengine-analyzer`)的输入形状:
//! `capture analyze --records <file>` 落盘、`analyze --records <file>` 回读。
//! 异常语义对齐引擎红线:失败不 panic,逐条带偏移落盘继续。

use kode_kbengine_protocol as kbp;
use kode_kbengine_schema::messages::MessageTable;
use serde::Serialize;

/// 一条解码完成的消息记录。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Record {
    /// Flow:`loginapp` / `baseapp`(PA-001 §6:两进程表独立)。
    pub flow: String,
    /// `c2s` / `s2c`。
    pub direction: String,
    pub id: u16,
    /// 未装表 id → None(异常面,分析端按 unknown 计)。
    pub name: Option<String>,
    pub payload_len: usize,
    /// 该方向流内的帧起点偏移。
    pub stream_offset: usize,
    /// 秒级 Unix 时间戳(pcap 输入层带;raw 流为 null)。
    pub timestamp: Option<f64>,
    /// 实体事件/远程调用首参(INT32 entityID)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<i32>,
    /// 远程调用的方法 id(线上 UINT16;静态表形状命中时提取)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method_id: Option<u16>,
    /// 按消息签名解码的参数值(JSON 形状;见 [`value_to_json`])。
    pub args: serde_json::Value,
}

/// 一条异常(解码失败/输入面问题;不中断继续)。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Anomaly {
    /// snake_case 类别(unknown_message_id / memory_limit / ... / unmapped_stream)。
    pub kind: String,
    pub flow: String,
    pub offset: usize,
    pub message: String,
}

fn kind_name(kind: kbp::DecodeErrorKind) -> &'static str {
    match kind {
        kbp::DecodeErrorKind::UnexpectedEof => "unexpected_eof",
        kbp::DecodeErrorKind::MemoryLimit => "memory_limit",
        kbp::DecodeErrorKind::UnknownMessageId => "unknown_message_id",
        kbp::DecodeErrorKind::DepthLimit => "depth_limit",
        kbp::DecodeErrorKind::InvalidString => "invalid_string",
    }
}

/// 协议值 → JSON(Bytes/Raw 走 hex 保留体,不丢字节)。
pub fn value_to_json(v: &kbp::codec::Value) -> serde_json::Value {
    use kbp::codec::Value;
    match v {
        Value::Bool(b) => serde_json::Value::Bool(*b),
        Value::Int(i) => serde_json::json!(i),
        Value::UInt(u) => serde_json::json!(u),
        Value::Float(f) => serde_json::json!(f),
        Value::Str(s) => serde_json::json!(s),
        Value::Bytes(b) => serde_json::json!({ "$hex": hex_encode(b) }),
        Value::Array(items) => serde_json::Value::Array(items.iter().map(value_to_json).collect()),
        Value::Dict(pairs) => {
            let mut m = serde_json::Map::new();
            for (k, val) in pairs {
                m.insert(k.clone(), value_to_json(val));
            }
            serde_json::Value::Object(m)
        }
        Value::Raw(raw) => {
            serde_json::json!({ "$raw_hex": hex_encode(&raw.bytes), "$reason": raw.reason })
        }
    }
}

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// hex 文本 → 字节(容忍 `:` 分隔与空白;tshark/人工粘贴两用)。
pub fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ':')
        .collect();
    let cleaned = cleaned.strip_prefix("0x").unwrap_or(&cleaned);
    if !cleaned.len().is_multiple_of(2) {
        return Err(format!("odd hex length ({})", cleaned.len()));
    }
    let mut out = Vec::with_capacity(cleaned.len() / 2);
    let bytes = cleaned.as_bytes();
    for i in (0..bytes.len()).step_by(2) {
        let hi = (bytes[i] as char)
            .to_digit(16)
            .ok_or_else(|| format!("bad hex at {i}"))?;
        let lo = (bytes[i + 1] as char)
            .to_digit(16)
            .ok_or_else(|| format!("bad hex at {}", i + 1))?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

/// 远程调用消息面(PA-001 §7:base → `Baseapp::onRemoteMethodCall`,cell →
/// `Baseapp::onRemoteCallCellMethodFromClient`,下行为 `Client::onRemoteMethodCall` /
/// `Base::onRemoteMethodCall` / `Entity::onRemoteMethodCall`)。
fn is_remote_call(name: &str) -> bool {
    name.ends_with("onRemoteMethodCall") || name.ends_with("onRemoteCallCellMethodFromClient")
}

/// 记录增强:实体事件/远程调用首参(INT32 entityID;onCreatedProxies 的
/// UINT64 guid 在前,按「首个 Int」取,不依赖参数序)。
fn extract_entity_fields(values: &[kbp::codec::Value], name: &str) -> (Option<i32>, Option<u16>) {
    let mut entity_id = None;
    let mut method_id = None;
    let rpc = is_remote_call(name);
    for v in values {
        match v {
            kbp::codec::Value::Int(i) => {
                if entity_id.is_none() {
                    entity_id = Some(*i as i32);
                } else if rpc && method_id.is_none() {
                    // INT32 entityID 之后罕见第二个 Int;不猜,跳过。
                }
            }
            kbp::codec::Value::UInt(u) if rpc && method_id.is_none() && *u <= u16::MAX as u64 => {
                method_id = Some(*u as u16);
            }
            _ => {}
        }
    }
    (entity_id, method_id)
}

/// 解码驱动:session(PA-003)+ 记录/异常落袋;失败复位该 Flow 后继续
/// (引擎语义:错误通道 condemn,不越界不 panic)。
#[derive(Debug)]
pub struct DecodeDriver {
    session: kbp::Session,
    statics: MessageTable,
    pub records: Vec<Record>,
    pub anomalies: Vec<Anomaly>,
}

impl DecodeDriver {
    pub fn new(statics: MessageTable) -> Self {
        DecodeDriver {
            session: kbp::Session::new(&statics),
            statics,
            records: Vec::new(),
            anomalies: Vec::new(),
        }
    }

    /// 喂入一个方向的一段 TCP 流字节,吐出/累积记录。
    pub fn feed(
        &mut self,
        role: kbp::ComponentRole,
        dir: kbp::Direction,
        chunk: &[u8],
        timestamp: Option<f64>,
    ) {
        let flow = flow_name(role).to_string();
        let dir_s = dir.as_str().to_string();
        match self.session.feed_direction(role, dir, chunk) {
            Ok(msgs) => {
                for m in msgs {
                    let name = m.name.clone();
                    let (entity_id, method_id) = match &name {
                        Some(n) => extract_entity_fields(&m.values, n),
                        None => (None, None),
                    };
                    let args: Vec<serde_json::Value> = m.values.iter().map(value_to_json).collect();
                    self.records.push(Record {
                        flow: flow.clone(),
                        direction: dir_s.clone(),
                        id: m.frame.id,
                        name,
                        payload_len: m.frame.payload.len(),
                        stream_offset: m.frame.stream_offset,
                        timestamp,
                        entity_id,
                        method_id,
                        args: serde_json::Value::Array(args),
                    });
                }
            }
            Err(e) => {
                self.anomalies.push(Anomaly {
                    kind: kind_name(e.kind).to_string(),
                    flow: flow.clone(),
                    offset: e.offset,
                    message: e.message,
                });
                // 引擎语义:错误后通道 condemned → 该 Flow 整体重置(两个
                // 方向的组帧器),后续字节按新流解析。
                self.session.reset_flow(role, &self.statics);
            }
        }
    }
}

pub fn flow_name(role: kbp::ComponentRole) -> &'static str {
    match role {
        kbp::ComponentRole::Loginapp => "loginapp",
        kbp::ComponentRole::Baseapp => "baseapp",
    }
}

pub fn role_of(flow: &str) -> Option<kbp::ComponentRole> {
    match flow {
        "loginapp" => Some(kbp::ComponentRole::Loginapp),
        "baseapp" => Some(kbp::ComponentRole::Baseapp),
        _ => None,
    }
}

/// 静态消息表来源:`--defaults <xml>`;缺省 = 空表(全部 id 走未知异常面,
/// 不编造默认表)。
pub fn message_table(defaults: Option<&str>) -> Result<MessageTable, String> {
    match defaults {
        Some(path) => {
            let xml = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
            Ok(kode_kbengine_schema::messages::build_message_table(
                &xml, None,
            ))
        }
        None => Ok(MessageTable::default()),
    }
}
