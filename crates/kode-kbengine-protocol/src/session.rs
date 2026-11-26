//! Per-Flow independent sessions (PA-003 "session independent per Flow", "handshake negotiation").
//!
//! Key facts about real KBEngine connections (PA-001 §5.2/§6): loginapp and baseapp each
//! maintain **independent message tables** (each does its own hello + its own
//! importClientMessages), so parse state is isolated per Flow (loginapp / baseapp); this
//! module observes the handshake message sequence on the stream and, on receiving
//! onImportClientMessages, automatically merges the payload into that Flow's message table.

use kode_kbengine_schema::messages::MessageTable;

use crate::codec::{decode_value, DecodeLimits, Value};
use crate::cursor::Cursor;
use crate::error::{DecodeError, DecodeErrorKind};
use crate::framing::{Frame, FrameParser, FramingConfig, UnknownIdPolicy};
use crate::messages::MessageMap;

/// Flow ownership (MVP = Client↔Server two-process face; PA-001 §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ComponentRole {
    Loginapp,
    Baseapp,
}

/// Handshake phase (§6 flow observation; advanced by message names, tolerant of out-of-order).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Phase {
    /// Connection established; hello not yet observed.
    #[default]
    Connected,
    /// Outbound hello seen, waiting for onHelloCB.
    HelloAckPending,
    /// onHelloCB seen.
    HelloAcked,
    /// onImportClientMessages seen and applied (dynamic table ready).
    ProtocolImported,
    /// onImportClientEntityDef seen (EntityDef alias segment merged in).
    EntityDefImported,
}

/// Single Flow: independent message table + independent frame state machine + phase.
#[derive(Debug)]
pub struct Flow {
    pub role: ComponentRole,
    pub map: MessageMap,
    parser: FrameParser,
    /// Downlink (s2c) independent framer: TCP frames each direction separately; PA-004
    /// capture feeds by direction (additive API; PA-003 single-stream `feed()` semantics unchanged).
    parser_down: FrameParser,
    pub phase: Phase,
    /// Whether onImportClientMessages has been seen (diagnostics).
    pub protocol_imported: bool,
}

/// TCP stream direction (each direction is an independent byte stream, framed independently).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    ClientToServer,
    ServerToClient,
}

impl Direction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Direction::ClientToServer => "c2s",
            Direction::ServerToClient => "s2c",
        }
    }
}

impl Flow {
    pub fn new(role: ComponentRole, statics: &MessageTable) -> Self {
        let map = MessageMap::from_static(statics);
        let cfg = FramingConfig {
            specs: map.clone_specs(),
            unknown_id_policy: UnknownIdPolicy::Fail,
            max_message_len: 1 << 20,
            packet_always_contain_length: false,
        };
        Flow {
            role,
            map,
            parser: FrameParser::new(cfg.clone()),
            parser_down: FrameParser::new(cfg),
            phase: Phase::Connected,
            protocol_imported: false,
        }
    }

    /// Refresh framing specs after a dynamic import (new ids frameable immediately; both directions).
    fn refresh_specs(&mut self) {
        let specs = self.map.clone_specs();
        self.parser.config_mut().specs = specs.clone();
        self.parser_down.config_mut().specs = specs;
    }

    /// Feed by direction (PA-004 capture/decode face): each direction has its own byte
    /// stream/framer, sharing one message table (dynamic import side effects take effect
    /// for both directions at once).
    pub fn feed_direction(
        &mut self,
        dir: Direction,
        chunk: &[u8],
        limits: &DecodeLimits,
    ) -> Result<Vec<DecodedMessage>, DecodeError> {
        let frames = match dir {
            Direction::ClientToServer => self.parser.feed(chunk)?,
            Direction::ServerToClient => self.parser_down.feed(chunk)?,
        };
        let mut out = Vec::with_capacity(frames.len());
        for frame in frames {
            out.push(self.decode_frame(frame, limits)?);
        }
        Ok(out)
    }

    fn feed(
        &mut self,
        chunk: &[u8],
        limits: &DecodeLimits,
    ) -> Result<Vec<DecodedMessage>, DecodeError> {
        let frames = self.parser.feed(chunk)?;
        let mut out = Vec::with_capacity(frames.len());
        for frame in frames {
            out.push(self.decode_frame(frame, limits)?);
        }
        Ok(out)
    }

    fn decode_frame(
        &mut self,
        frame: Frame,
        limits: &DecodeLimits,
    ) -> Result<DecodedMessage, DecodeError> {
        let spec = self.map.by_id(frame.id).cloned();
        let (name, values) = match &spec {
            Some(spec) => {
                let mut cur = Cursor::new(&frame.payload);
                let mut values = Vec::with_capacity(spec.args.len());
                for (i, arg_ty) in spec.args.iter().enumerate() {
                    let v = decode_value(arg_ty, &mut cur, limits, 0)?;
                    values.push(v);
                    let _ = i;
                }
                (Some(spec.name.clone()), values)
            }
            None => (None, Vec::new()),
        };

        // Handshake phase advancement + builtin side effects (dynamic import / EntityDef alias merge).
        match name.as_deref() {
            Some("Loginapp::hello") | Some("Baseapp::hello") => {
                self.phase = Phase::HelloAckPending;
            }
            Some("Client::onHelloCB") => {
                self.phase = Phase::HelloAcked;
            }
            Some("Loginapp::importClientMessages") | Some("Baseapp::importClientMessages") => {}
            Some("Client::onImportClientMessages") => {
                // Payload = UINT8_ARRAY(blob) → §5.2 record stream.
                if let Some(Value::Bytes(blob)) = values.first() {
                    self.map.apply_import(blob, limits)?;
                    self.refresh_specs();
                    self.protocol_imported = true;
                    self.phase = Phase::ProtocolImported;
                }
            }
            Some("Client::onImportClientEntityDef") => {
                // §6 step 10: payload = UINT8_ARRAY(blob); alias segment u16 aliassize +
                // entries (uid, str name, str aliasName). Only the alias segment is consumed
                // (attribute/method descriptions of the module segment depend on TODO-3
                // evidence; kept as Raw, not fabricated).
                if let Some(Value::Bytes(body)) = values.first().cloned() {
                    let mut cur = Cursor::new(&body);
                    let alias_size = cur.read_u16()?;
                    for _ in 0..alias_size {
                        let uid = cur.read_u16()?;
                        let _name = cur.read_cstring()?;
                        let alias_name = cur.read_cstring()?;
                        self.map.insert_alias(uid, alias_name);
                    }
                    if alias_size > 0 {
                        self.phase = Phase::EntityDefImported;
                    }
                }
            }
            _ => {}
        }

        Ok(DecodedMessage {
            role: self.role,
            frame,
            name,
            values,
        })
    }
}

/// Session: two independent Flows (MVP = Client↔Server).
#[derive(Debug)]
pub struct Session {
    loginapp: Flow,
    baseapp: Flow,
    limits: DecodeLimits,
}

/// One fully decoded message (frame + name + argument values).
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedMessage {
    pub role: ComponentRole,
    pub frame: Frame,
    /// Unknown ids (None) were already handled at the framing layer per policy; this field
    /// holds the name of an installed message.
    pub name: Option<String>,
    /// Argument values decoded per the message signature.
    pub values: Vec<Value>,
}

impl Session {
    pub fn new(statics: &MessageTable) -> Self {
        Session {
            loginapp: Flow::new(ComponentRole::Loginapp, statics),
            baseapp: Flow::new(ComponentRole::Baseapp, statics),
            limits: DecodeLimits::default(),
        }
    }

    pub fn with_limits(statics: &MessageTable, limits: DecodeLimits) -> Self {
        let mut s = Session::new(statics);
        s.limits = limits;
        s
    }

    /// Feed TCP stream bytes for the given Flow.
    pub fn feed(
        &mut self,
        role: ComponentRole,
        chunk: &[u8],
    ) -> Result<Vec<DecodedMessage>, DecodeError> {
        match role {
            ComponentRole::Loginapp => self.loginapp.feed(chunk, &self.limits),
            ComponentRole::Baseapp => self.baseapp.feed(chunk, &self.limits),
        }
    }

    /// Feed TCP stream bytes for the given Flow + direction (PA-004 capture/decode face;
    /// the two directions frame independently, sharing this Flow's message table).
    pub fn feed_direction(
        &mut self,
        role: ComponentRole,
        dir: Direction,
        chunk: &[u8],
    ) -> Result<Vec<DecodedMessage>, DecodeError> {
        let flow = match role {
            ComponentRole::Loginapp => &mut self.loginapp,
            ComponentRole::Baseapp => &mut self.baseapp,
        };
        flow.feed_direction(dir, chunk, &self.limits)
    }

    pub fn flow(&self, role: ComponentRole) -> Option<&MessageMap> {
        match role {
            ComponentRole::Loginapp => Some(&self.loginapp.map),
            ComponentRole::Baseapp => Some(&self.baseapp.map),
        }
    }

    pub fn flow_mut(&mut self, role: ComponentRole) -> Option<&mut Flow> {
        match role {
            ComponentRole::Loginapp => Some(&mut self.loginapp),
            ComponentRole::Baseapp => Some(&mut self.baseapp),
        }
    }

    pub fn phase_of(&self, role: ComponentRole) -> Phase {
        match role {
            ComponentRole::Loginapp => self.loginapp.phase,
            ComponentRole::Baseapp => self.baseapp.phase,
        }
    }

    /// Switch connection (loginapp → baseapp): tables are independent and hello must be
    /// redone (PA-001 §10.3). The baseapp Flow is initialized with its own table at session
    /// construction; this is only a phase-reset semantics note.
    pub fn reset_flow(&mut self, role: ComponentRole, statics: &MessageTable) {
        match role {
            ComponentRole::Loginapp => self.loginapp = Flow::new(role, statics),
            ComponentRole::Baseapp => self.baseapp = Flow::new(role, statics),
        }
    }
}

/// Keep unused imports alive (InvalidString is used by the entity module; guards against a dangling import here).
#[allow(unused)]
fn _kind_witness(k: DecodeErrorKind) -> DecodeErrorKind {
    k
}
