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

#[cfg(test)]
mod tests {
    use super::*;
    use kbp::codec::Value;
    use kbp::{ComponentRole, Direction};

    /// 仓库自带的引擎缺省消息表(与 CLI 验收同一份)。
    fn defaults_xml_path() -> String {
        format!(
            "{}/tests/fixtures/messages_fixed_defaults.xml",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    /// 变长帧线上形态:`u16 id (LE) + u16 载荷长 (LE) + 载荷`。
    fn var_frame(id: u16, payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(4 + payload.len());
        v.extend_from_slice(&id.to_le_bytes());
        v.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn value_to_json_preserves_every_value_shape() {
        // Bytes/Raw 走 hex 保留体,不丢字节;其余按 JSON 原生形状。
        assert_eq!(value_to_json(&Value::Bool(true)), serde_json::json!(true));
        assert_eq!(value_to_json(&Value::Int(-5)), serde_json::json!(-5));
        assert_eq!(value_to_json(&Value::UInt(7)), serde_json::json!(7));
        assert_eq!(value_to_json(&Value::Float(1.5)), serde_json::json!(1.5));
        assert_eq!(
            value_to_json(&Value::Str("hi".into())),
            serde_json::json!("hi")
        );
        assert_eq!(
            value_to_json(&Value::Bytes(vec![0x01, 0xab])),
            serde_json::json!({ "$hex": "01ab" })
        );
        assert_eq!(
            value_to_json(&Value::Array(vec![Value::Int(1), Value::Float(2.0)])),
            serde_json::json!([1, 2.0])
        );
        assert_eq!(
            value_to_json(&Value::Dict(vec![
                ("a".into(), Value::UInt(1)),
                ("b".into(), Value::Str("x".into())),
            ])),
            serde_json::json!({"a": 1, "b": "x"})
        );
        let raw = Value::Raw(kbp::codec::RawValue {
            reason: "unresolved type".into(),
            bytes: vec![0xde, 0xad],
        });
        assert_eq!(
            value_to_json(&raw),
            serde_json::json!({ "$raw_hex": "dead", "$reason": "unresolved type" })
        );
        // 嵌套容器同样保持形状。
        assert_eq!(
            value_to_json(&Value::Dict(vec![(
                "pos".into(),
                Value::Array(vec![
                    Value::Float(1.0),
                    Value::Float(2.0),
                    Value::Float(3.0)
                ])
            )])),
            serde_json::json!({"pos": [1.0, 2.0, 3.0]})
        );
    }

    #[test]
    fn hex_codec_round_trips_and_rejects_bad_input() {
        assert_eq!(hex_encode(&[0xde, 0xad]), "dead");
        assert_eq!(hex_encode(&[]), "");
        // 冒号分隔(tshark 形态)/空白/0x 前缀都容忍。
        assert_eq!(hex_decode("de:ad").unwrap(), vec![0xde, 0xad]);
        assert_eq!(hex_decode("de ad\n").unwrap(), vec![0xde, 0xad]);
        assert_eq!(hex_decode("0xdead").unwrap(), vec![0xde, 0xad]);
        assert_eq!(hex_decode("").unwrap(), Vec::<u8>::new());
        // 奇数长度:明确报错,不猜。
        assert!(hex_decode("abc").unwrap_err().contains("odd hex length"));
        // 非 hex 字符:报错并带位置。
        let err = hex_decode("zz").unwrap_err();
        assert!(err.contains("bad hex at"), "{err}");
        let err2 = hex_decode("d0z0").unwrap_err();
        assert!(err2.contains("bad hex at 2"), "{err2}");
    }

    #[test]
    fn kind_name_maps_every_decode_error_kind() {
        use kbp::DecodeErrorKind;
        assert_eq!(kind_name(DecodeErrorKind::UnexpectedEof), "unexpected_eof");
        assert_eq!(kind_name(DecodeErrorKind::MemoryLimit), "memory_limit");
        assert_eq!(
            kind_name(DecodeErrorKind::UnknownMessageId),
            "unknown_message_id"
        );
        assert_eq!(kind_name(DecodeErrorKind::DepthLimit), "depth_limit");
        assert_eq!(kind_name(DecodeErrorKind::InvalidString), "invalid_string");
    }

    #[test]
    fn flow_and_role_names_round_trip() {
        assert_eq!(flow_name(ComponentRole::Loginapp), "loginapp");
        assert_eq!(flow_name(ComponentRole::Baseapp), "baseapp");
        assert_eq!(role_of("loginapp"), Some(ComponentRole::Loginapp));
        assert_eq!(role_of("baseapp"), Some(ComponentRole::Baseapp));
        assert_eq!(role_of("cellapp"), None);
        assert_eq!(role_of(""), None);
    }

    #[test]
    fn message_table_defaults_to_empty_without_xml() {
        let table = message_table(None).unwrap();
        // 缺省 = 空表:不编造默认表,任何 id 都走未知异常面。
        assert!(table.by_id(3).is_none());
        // 真实缺省 XML:装表后 id 3 = Loginapp::login。
        let loaded = message_table(Some(&defaults_xml_path())).unwrap();
        assert!(loaded.by_id(3).is_some());
        // 文件不存在:read 失败如实报错,不 panic。
        let err = message_table(Some("/nonexistent/messages.xml")).unwrap_err();
        assert!(err.contains("read"), "{err}");
    }

    #[test]
    fn extract_entity_fields_takes_first_int_as_entity_id() {
        use Value::{Bytes, Int, Str, UInt};
        // 非 RPC 消息:首个 Int 即 entityID(onCreatedProxies 的 guid 在前,
        // 按「首个 Int」取,不依赖参数序)。
        let (e, m) = extract_entity_fields(
            &[UInt(12345), Int(99), Str("Avatar".into())],
            "Client::onCreatedProxies",
        );
        assert_eq!((e, m), (Some(99), None));
        // RPC(下行 Client::onRemoteMethodCall):entityID 之后首个 UInt(≤65535)
        // 是方法 id。
        let (e, m) = extract_entity_fields(
            &[Int(7), UInt(3), Bytes(vec![1])],
            "Client::onRemoteMethodCall",
        );
        assert_eq!((e, m), (Some(7), Some(3)));
        // 上行 cell 远程调用:INT32 entityID + 载荷,无方法 id。
        let (e, m) = extract_entity_fields(
            &[Int(42), Bytes(vec![9])],
            "Baseapp::onRemoteCallCellMethodFromClient",
        );
        assert_eq!((e, m), (Some(42), None));
        // RPC 内 entityID 之后罕见第二个 Int:不猜,跳过(方法 id 仍取 UInt)。
        let (e, m) = extract_entity_fields(&[Int(7), Int(8), UInt(3)], "Base::onRemoteMethodCall");
        assert_eq!((e, m), (Some(7), Some(3)));
        // 无 Int/UInt 的消息:两字段都空。
        let (e, m) = extract_entity_fields(&[Str("x".into())], "Client::onLoginFailed");
        assert_eq!((e, m), (None, None));
        // 非 RPC 的 UInt 不冒充方法 id。
        let (e, m) = extract_entity_fields(&[UInt(16)], "Client::onKicked");
        assert_eq!((e, m), (None, None));
    }

    #[test]
    fn driver_decodes_baseapp_remote_call_with_entity_and_method() {
        let table = message_table(Some(&defaults_xml_path())).unwrap();
        let mut driver = DecodeDriver::new(table);
        // Base::onRemoteMethodCall(id 301,baseapp 流 s2c):INT32 entityID +
        // UINT16 方法 id + UINT8_ARRAY 载荷。
        let mut payload = Vec::new();
        payload.extend_from_slice(&1024i32.to_le_bytes());
        payload.extend_from_slice(&77u16.to_le_bytes());
        payload.extend_from_slice(&3u32.to_le_bytes());
        payload.extend_from_slice(b"abc");
        driver.feed(
            ComponentRole::Baseapp,
            Direction::ServerToClient,
            &var_frame(301, &payload),
            Some(1759000000.5),
        );
        assert!(driver.anomalies.is_empty(), "{:?}", driver.anomalies);
        assert_eq!(driver.records.len(), 1);
        let rec = &driver.records[0];
        assert_eq!(rec.flow, "baseapp");
        assert_eq!(rec.direction, "s2c");
        assert_eq!(rec.name.as_deref(), Some("Base::onRemoteMethodCall"));
        assert_eq!(rec.entity_id, Some(1024));
        assert_eq!(rec.method_id, Some(77));
        assert_eq!(rec.timestamp, Some(1759000000.5));
        // 首参(INT32 entityID)保留在 args JSON 里。
        assert_eq!(rec.args[0], serde_json::json!(1024));
        // UINT8_ARRAY 以 $hex 保留体出参,不丢字节。
        assert_eq!(rec.args[2]["$hex"], serde_json::json!("616263"));
    }

    #[test]
    fn driver_reports_anomaly_kinds_without_panicking() {
        let table = message_table(Some(&defaults_xml_path())).unwrap();
        // 截断帧(声明载荷长 > 实际):unexpected_eof 后通道复位,继续可用。
        let mut driver = DecodeDriver::new(table.clone());
        // Base::onRemoteMethodCall 载荷只有 1 字节(INT32 读不满)。
        driver.feed(
            ComponentRole::Baseapp,
            Direction::ServerToClient,
            &var_frame(301, &[0x01]),
            None,
        );
        assert_eq!(driver.anomalies.len(), 1);
        assert_eq!(driver.anomalies[0].kind, "unexpected_eof");
        assert_eq!(driver.anomalies[0].flow, "baseapp");

        // 未知 id:unknown_message_id(loginapp 流)。
        let mut driver = DecodeDriver::new(table.clone());
        driver.feed(
            ComponentRole::Loginapp,
            Direction::ClientToServer,
            &var_frame(7777, b"x"),
            None,
        );
        assert_eq!(driver.anomalies[0].kind, "unknown_message_id");
        assert_eq!(driver.anomalies[0].flow, "loginapp");

        // 字符串按有损语义读(0xff 高位字节截断,不报错),后续参数继续;
        // 这里喂满 4 参合法载荷确保 login 正常解码,作为异常面的对照。
        let mut driver = DecodeDriver::new(table.clone());
        let mut ok_payload = Vec::new();
        ok_payload.extend_from_slice(b"1\0");
        ok_payload.extend_from_slice(&1u32.to_le_bytes());
        ok_payload.extend_from_slice(b"\0");
        ok_payload.extend_from_slice(b"a\0");
        ok_payload.extend_from_slice(b"b\0");
        driver.feed(
            ComponentRole::Loginapp,
            Direction::ClientToServer,
            &var_frame(3, &ok_payload),
            None,
        );
        assert!(driver.anomalies.is_empty(), "{:?}", driver.anomalies);
        assert_eq!(driver.records.len(), 1);
        assert_eq!(driver.records[0].name.as_deref(), Some("Loginapp::login"));

        // 内存上限:变长帧 65535 哨兵 + u32 实长超限 → memory_limit。
        let mut driver = DecodeDriver::new(table.clone());
        let mut stream = Vec::new();
        stream.extend_from_slice(&301u16.to_le_bytes());
        stream.extend_from_slice(&65535u16.to_le_bytes());
        stream.extend_from_slice(&u32::MAX.to_le_bytes());
        driver.feed(
            ComponentRole::Baseapp,
            Direction::ServerToClient,
            &stream,
            None,
        );
        assert_eq!(driver.anomalies[0].kind, "memory_limit");

        // 空表(无 --defaults):任何 id 都未知,复位后继续可用。
        let mut driver = DecodeDriver::new(message_table(None).unwrap());
        driver.feed(
            ComponentRole::Loginapp,
            Direction::ClientToServer,
            &var_frame(3, b""),
            None,
        );
        assert_eq!(driver.anomalies[0].kind, "unknown_message_id");
        assert!(driver.records.is_empty());
    }
}
