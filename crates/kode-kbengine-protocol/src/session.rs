//! 每 Flow 独立会话(PA-003「session 每 Flow 独立」「handshake 协商」)。
//!
//! KBEngine 真实连接的关键事实(PA-001 §5.2/§6):loginapp 与 baseapp 各自
//! 维护**独立的消息表**(各自 hello + 各自 importClientMessages),所以解析
//! 状态按 Flow(loginapp / baseapp)隔离;本模块在流上观察握手消息序列,
//! 并在收到 onImportClientMessages 时自动把载荷并入所在 Flow 的消息表。

use kode_kbengine_schema::messages::MessageTable;

use crate::codec::{decode_value, DecodeLimits, Value};
use crate::cursor::Cursor;
use crate::error::{DecodeError, DecodeErrorKind};
use crate::framing::{Frame, FrameParser, FramingConfig, UnknownIdPolicy};
use crate::messages::MessageMap;

/// Flow 归属(MVP = Client↔Server 两进程面;PA-001 §6)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ComponentRole {
    Loginapp,
    Baseapp,
}

/// 握手阶段(§6 流程观察;由消息名驱动推进,可乱序容忍)。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Phase {
    /// 连接建立,尚未观察到 hello。
    #[default]
    Connected,
    /// 已见上行 hello,等待 onHelloCB。
    HelloAckPending,
    /// onHelloCB 已见。
    HelloAcked,
    /// onImportClientMessages 已见并应用(动态表就绪)。
    ProtocolImported,
    /// onImportClientEntityDef 已见(EntityDef 别名段已并入)。
    EntityDefImported,
}

/// 单 Flow:独立消息表 + 独立帧状态机 + 阶段。
#[derive(Debug)]
pub struct Flow {
    pub role: ComponentRole,
    pub map: MessageMap,
    parser: FrameParser,
    pub phase: Phase,
    /// 是否已见 onImportClientMessages(诊断)。
    pub protocol_imported: bool,
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
            parser: FrameParser::new(cfg),
            phase: Phase::Connected,
            protocol_imported: false,
        }
    }

    /// 动态导入后刷新 framing 规格(新增 id 立即可组帧)。
    fn refresh_specs(&mut self) {
        let specs = self.map.clone_specs();
        self.parser.config_mut().specs = specs;
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

        // 握手阶段推进 + 内建副作用(动态导入/EntityDef 别名并入)。
        match name.as_deref() {
            Some("Loginapp::hello") | Some("Baseapp::hello") => {
                self.phase = Phase::HelloAckPending;
            }
            Some("Client::onHelloCB") => {
                self.phase = Phase::HelloAcked;
            }
            Some("Loginapp::importClientMessages") | Some("Baseapp::importClientMessages") => {}
            Some("Client::onImportClientMessages") => {
                // 载荷 = UINT8_ARRAY(blob) → §5.2 记录流。
                if let Some(Value::Bytes(blob)) = values.first() {
                    self.map.apply_import(blob, limits)?;
                    self.refresh_specs();
                    self.protocol_imported = true;
                    self.phase = Phase::ProtocolImported;
                }
            }
            Some("Client::onImportClientEntityDef") => {
                // §6 步骤 10:载荷 = UINT8_ARRAY(blob);别名段 u16 aliassize +
                // 条目(uid, str name, str aliasName)。仅消费别名段(模块段的
                // 属性/方法描述依赖 TODO-3 取证,Raw 保留不编造)。
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

/// 会话:双 Flow 独立(MVP = Client↔Server)。
#[derive(Debug)]
pub struct Session {
    loginapp: Flow,
    baseapp: Flow,
    limits: DecodeLimits,
}

/// 一条解码完成的消息(frame + 名字 + 参数值)。
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedMessage {
    pub role: ComponentRole,
    pub frame: Frame,
    /// 未知 id(None)时 framing 层已按策略处理;此字段为已装表消息名。
    pub name: Option<String>,
    /// 按消息签名解码的参数值。
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

    /// 喂入指定 Flow 方向的 TCP 流字节。
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

    /// 切换连接(loginapp → baseapp):表独立、hello 必须重走(PA-001 §10.3)。
    /// baseapp Flow 建会话时即按独立表初始化,这里只是阶段复位语义说明。
    pub fn reset_flow(&mut self, role: ComponentRole, statics: &MessageTable) {
        match role {
            ComponentRole::Loginapp => self.loginapp = Flow::new(role, statics),
            ComponentRole::Baseapp => self.baseapp = Flow::new(role, statics),
        }
    }
}

/// 保留未用导入(InvalidString 由 entity 模块使用;此处防悬空 import)。
#[allow(unused)]
fn _kind_witness(k: DecodeErrorKind) -> DecodeErrorKind {
    k
}
