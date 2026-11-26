//! Decoded records + anomaly records: the decode face's (PA-003 session) single data shape for the
//! report face.
//!
//! The records JSON are also the input shape for the PA-005 analysis engine
//! (`kode-kbengine-analyzer`): `capture analyze --records <file>` writes them out and
//! `analyze --records <file>` reads them back. The anomaly semantics align with the engine's red
//! lines: no panic on failure, keep going with each anomaly persisted with its offset.

use kode_kbengine_protocol as kbp;
use kode_kbengine_schema::messages::MessageTable;
use serde::Serialize;

/// One fully decoded message record.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Record {
    /// Flow: `loginapp` / `baseapp` (PA-001 §6: the two processes' tables are independent).
    pub flow: String,
    /// `c2s` / `s2c`.
    pub direction: String,
    pub id: u16,
    /// An id not in the table -> None (the anomaly face; the analysis side counts it as unknown).
    pub name: Option<String>,
    pub payload_len: usize,
    /// Offset of the frame start within this direction's stream.
    pub stream_offset: usize,
    /// Second-granularity Unix timestamp (carried by the pcap input layer; null for raw flows).
    pub timestamp: Option<f64>,
    /// First parameter of an entity event / remote call (INT32 entityID).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<i32>,
    /// Method id of the remote call (a UINT16 on the wire; extracted when the static-table shape
    /// hits).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method_id: Option<u16>,
    /// Argument values decoded per the message signature (JSON shape; see [`value_to_json`]).
    pub args: serde_json::Value,
}

/// One anomaly (decode failure / input-face problem; processing continues without aborting).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Anomaly {
    /// snake_case category (unknown_message_id / memory_limit / ... / unmapped_stream).
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

/// Protocol value -> JSON (Bytes/Raw carry a hex preservation body, so no byte is lost).
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

/// Hex text -> bytes (tolerates `:` separators and whitespace; serves both tshark output and
/// hand-pasted text).
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

/// Remote-call message face (PA-001 §7: base -> `Baseapp::onRemoteMethodCall`, cell ->
/// `Baseapp::onRemoteCallCellMethodFromClient`; downlink is `Client::onRemoteMethodCall` /
/// `Base::onRemoteMethodCall` / `Entity::onRemoteMethodCall`).
fn is_remote_call(name: &str) -> bool {
    name.ends_with("onRemoteMethodCall") || name.ends_with("onRemoteCallCellMethodFromClient")
}

/// Record enrichment: the first parameter of an entity event / remote call (INT32 entityID; in
/// onCreatedProxies the UINT64 guid comes first, so take "the first Int" rather than relying on
/// argument order).
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
                    // A second Int after the INT32 entityID is rare; do not guess, skip it.
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

/// Decode driver: session (PA-003) plus record/anomaly collection; on failure the Flow is reset and
/// decoding continues (engine semantics: the erroring channel is condemned, no overruns, no panic).
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

    /// Feed a stretch of TCP flow bytes for one direction; emits/accumulates records.
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
                // Engine semantics: after the error the channel is condemned -> the whole Flow is
                // reset (both directions' frame builders); later bytes are parsed as a fresh stream.
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

/// Source of the static message table: `--defaults <xml>`; default = empty table (every id then goes
/// to the unknown anomaly face; no default table is fabricated).
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

    /// The engine's default message table shipped in the repository (the same copy the CLI
    /// acceptance uses).
    fn defaults_xml_path() -> String {
        format!(
            "{}/tests/fixtures/messages_fixed_defaults.xml",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    /// Variable-length frame wire form: `u16 id (LE) + u16 payload length (LE) + payload`.
    fn var_frame(id: u16, payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(4 + payload.len());
        v.extend_from_slice(&id.to_le_bytes());
        v.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn value_to_json_preserves_every_value_shape() {
        // Bytes/Raw carry a hex preservation body so no byte is lost; everything else keeps its
        // native JSON shape.
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
        // Nested containers keep their shape the same way.
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
        // Colon-separated (the tshark form), whitespace, and a 0x prefix are all tolerated.
        assert_eq!(hex_decode("de:ad").unwrap(), vec![0xde, 0xad]);
        assert_eq!(hex_decode("de ad\n").unwrap(), vec![0xde, 0xad]);
        assert_eq!(hex_decode("0xdead").unwrap(), vec![0xde, 0xad]);
        assert_eq!(hex_decode("").unwrap(), Vec::<u8>::new());
        // Odd length: report clearly, no guessing.
        assert!(hex_decode("abc").unwrap_err().contains("odd hex length"));
        // Non-hex character: report with the position.
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
        // Default = empty table: no fabricated default table, every id goes to the unknown anomaly
        // face.
        assert!(table.by_id(3).is_none());
        // Real default XML: with the table loaded, id 3 = Loginapp::login.
        let loaded = message_table(Some(&defaults_xml_path())).unwrap();
        assert!(loaded.by_id(3).is_some());
        // File does not exist: the read failure is reported faithfully, no panic.
        let err = message_table(Some("/nonexistent/messages.xml")).unwrap_err();
        assert!(err.contains("read"), "{err}");
    }

    #[test]
    fn extract_entity_fields_takes_first_int_as_entity_id() {
        use Value::{Bytes, Int, Str, UInt};
        // Non-RPC message: the first Int is the entityID (in onCreatedProxies the guid comes
        // first, so take "the first Int" rather than relying on argument order).
        let (e, m) = extract_entity_fields(
            &[UInt(12345), Int(99), Str("Avatar".into())],
            "Client::onCreatedProxies",
        );
        assert_eq!((e, m), (Some(99), None));
        // RPC (downlink Client::onRemoteMethodCall): the first UInt (<= 65535) after
        // the entityID is the method id.
        let (e, m) = extract_entity_fields(
            &[Int(7), UInt(3), Bytes(vec![1])],
            "Client::onRemoteMethodCall",
        );
        assert_eq!((e, m), (Some(7), Some(3)));
        // Uplink cell remote call: INT32 entityID + payload, no method id.
        let (e, m) = extract_entity_fields(
            &[Int(42), Bytes(vec![9])],
            "Baseapp::onRemoteCallCellMethodFromClient",
        );
        assert_eq!((e, m), (Some(42), None));
        // A second Int after the entityID inside an RPC is rare: do not guess, skip it
        // (the method id still comes from the UInt).
        let (e, m) = extract_entity_fields(&[Int(7), Int(8), UInt(3)], "Base::onRemoteMethodCall");
        assert_eq!((e, m), (Some(7), Some(3)));
        // A message with no Int/UInt: both fields stay empty.
        let (e, m) = extract_entity_fields(&[Str("x".into())], "Client::onLoginFailed");
        assert_eq!((e, m), (None, None));
        // A non-RPC UInt does not masquerade as the method id.
        let (e, m) = extract_entity_fields(&[UInt(16)], "Client::onKicked");
        assert_eq!((e, m), (None, None));
        // A second Int in a non-RPC message: the else-if condition is false, the rpc arm
        // does not participate (still only the first Int is taken).
        let (e, m) = extract_entity_fields(&[Int(1), Int(2)], "Client::onCreatedProxies");
        assert_eq!((e, m), (Some(1), None));
    }

    #[test]
    fn driver_decodes_baseapp_remote_call_with_entity_and_method() {
        let table = message_table(Some(&defaults_xml_path())).unwrap();
        let mut driver = DecodeDriver::new(table);
        // Base::onRemoteMethodCall (id 301, baseapp flow s2c): INT32 entityID +
        // UINT16 method id + UINT8_ARRAY payload.
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
        // The first parameter (INT32 entityID) is preserved in the args JSON.
        assert_eq!(rec.args[0], serde_json::json!(1024));
        // The UINT8_ARRAY leaves via the $hex preservation body, no byte lost.
        assert_eq!(rec.args[2]["$hex"], serde_json::json!("616263"));
    }

    #[test]
    fn driver_reports_anomaly_kinds_without_panicking() {
        let table = message_table(Some(&defaults_xml_path())).unwrap();
        // Truncated frame (declared payload length > actual): after unexpected_eof the channel is
        // reset and stays usable.
        let mut driver = DecodeDriver::new(table.clone());
        // The Base::onRemoteMethodCall payload is only 1 byte (not enough for a full INT32).
        driver.feed(
            ComponentRole::Baseapp,
            Direction::ServerToClient,
            &var_frame(301, &[0x01]),
            None,
        );
        assert_eq!(driver.anomalies.len(), 1);
        assert_eq!(driver.anomalies[0].kind, "unexpected_eof");
        assert_eq!(driver.anomalies[0].flow, "baseapp");

        // Unknown id: unknown_message_id (loginapp flow).
        let mut driver = DecodeDriver::new(table.clone());
        driver.feed(
            ComponentRole::Loginapp,
            Direction::ClientToServer,
            &var_frame(7777, b"x"),
            None,
        );
        assert_eq!(driver.anomalies[0].kind, "unknown_message_id");
        assert_eq!(driver.anomalies[0].flow, "loginapp");

        // Strings are read with lossy semantics (0xff high bytes truncated, no error) and later
        // parameters keep going; here we feed a full legal 4-argument payload so login decodes
        // normally, as the control case against the anomaly faces.
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

        // Memory limit: variable-length frame with the 65535 sentinel + a u32 real length over the
        // limit -> memory_limit.
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

        // Empty table (no --defaults): every id is unknown; after reset it stays usable.
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
