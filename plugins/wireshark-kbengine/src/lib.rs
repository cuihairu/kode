//! PA-006:KBEngine 线协议 Wireshark dissector 插件(todo PA-006 Phase 4)。
//!
//! 架构边界:本 crate 只是 Wireshark 宿主适配层——字节进/摘要出,零解析逻辑;
//! 三种长度形态组帧、TCP 粘包/拆包、静态+动态消息表、每 Flow 独立状态机、
//! 内存上限与错误复位语义,全部在仓库 `kode-kbengine-protocol`(PA-003
//! 验收面,失败不 panic/不越界红线)。unknown id 不编造:无静态表时走
//! unknown-id 异常面如实展示。
//!
//! 首遍语义:会话状态只在 Wireshark 首遍推进([`PacketView::is_first_pass`]),
//! 重放遍(选中/过滤触发的重解剖)只复述首遍摘要,不重复喂流。
//!
//! 有类型字段树(Header derive)是下一增量;本增量 Info 列摘要 + Expert 面。

use std::collections::BTreeMap;

use kode_kbengine_protocol::codec::DecodeLimits;
use kode_kbengine_protocol::{
    ComponentRole, DecodedMessage, Direction as WireDirection, Flow,
};
use kode_kbengine_schema::messages::{build_message_table, MessageTable};
use libwireshark::prefs::{Declaration, PreferenceError, PreferenceMap, PreferenceValue};
use libwireshark::prefs::Value as PrefValue;
use libwireshark::{
    plugin, Binding, DissectResult, Dissector, Expert, ExpertGroup, NoHeader, PacketView,
    Preferences, Severity,
};

/// KBEngine 引擎默认组件端口(kbengine_defaults.xml externalPorts 上游默认;
/// 用户可在 Wireshark 首选项覆盖)。
const DEFAULT_LOGINAPP_PORT: u16 = 20013;
const DEFAULT_BASEAPP_PORT: u16 = 20015;

/// 首选项:端口对 + 静态消息表来源。
#[derive(Clone, Debug)]
struct KbPrefs {
    loginapp_port: u16,
    baseapp_port: u16,
    /// `messages_fixed_defaults.xml` 路径;空 = 空表(全部 id 走 unknown 面,
    /// 与 CLI `--defaults` 缺省同口径,不编造默认表)。
    defaults_xml: Option<String>,
}

impl Default for KbPrefs {
    fn default() -> Self {
        KbPrefs {
            loginapp_port: DEFAULT_LOGINAPP_PORT,
            baseapp_port: DEFAULT_BASEAPP_PORT,
            defaults_xml: None,
        }
    }
}

impl Preferences for KbPrefs {
    fn declarations() -> Vec<Declaration> {
        vec![
            Declaration::new(
                "loginapp_port",
                "Loginapp TCP port",
                "Client↔loginapp 流的端口(engine kbengine_defaults.xml 默认 20013)",
                PrefValue::Uint(u32::from(DEFAULT_LOGINAPP_PORT)),
            ),
            Declaration::new(
                "baseapp_port",
                "Baseapp TCP port",
                "Client↔baseapp 流的端口(engine 默认 20015;0 = 不绑)",
                PrefValue::Uint(u32::from(DEFAULT_BASEAPP_PORT)),
            ),
            Declaration::new(
                "defaults_xml",
                "messages_fixed_defaults.xml path",
                "静态消息表来源(空 = 只认动态导入,未知 id 如实标记)",
                PrefValue::String(String::new()),
            ),
        ]
    }

    fn from_values(values: &PreferenceMap) -> Result<Self, PreferenceError> {
        let port = |name: &'static str, fallback: u16| -> Result<u16, PreferenceError> {
            match values.get(name) {
                Some(v) => u16::from_value(v),
                None => Ok(fallback),
            }
        };
        let defaults_xml = match values.get("defaults_xml") {
            Some(v) => String::from_value(v)?,
            None => String::new(),
        };
        Ok(KbPrefs {
            loginapp_port: port("loginapp_port", DEFAULT_LOGINAPP_PORT)?,
            baseapp_port: port("baseapp_port", DEFAULT_BASEAPP_PORT)?,
            defaults_xml: (!defaults_xml.is_empty()).then_some(defaults_xml),
        })
    }
}

/// 每 TCP 流(Wireshark conversation)状态:角色 + 组帧/解码机 + 首遍摘要
/// 缓存(重放遍复述)。静态表只在开流时并入 Flow::map,不留驻。
struct StreamState {
    role: ComponentRole,
    flow: Flow,
    summaries: BTreeMap<u32, String>,
}

impl StreamState {
    fn open(prefs: &KbPrefs, role: ComponentRole) -> Self {
        let statics = load_statics(prefs);
        let flow = Flow::new(role, &statics);
        StreamState {
            role,
            flow,
            summaries: BTreeMap::new(),
        }
    }
}

/// 静态表装载:读失败回落空表(unknown-id 面,不崩、不编造)。
fn load_statics(prefs: &KbPrefs) -> MessageTable {
    let Some(path) = prefs.defaults_xml.as_deref() else {
        return MessageTable::default();
    };
    match std::fs::read_to_string(path) {
        Ok(xml) => build_message_table(&xml, None),
        Err(_) => MessageTable::default(),
    }
}

/// 端口 → (角色, 方向):prefs 两端口即绑定面,必须命中其一(dissect 只被
/// 绑定端口的包唤起;0 端口在 dissect_on 已剔)。
fn role_of(prefs: &KbPrefs, src: u32, dst: u32) -> Option<(ComponentRole, WireDirection)> {
    let loginapp = u32::from(prefs.loginapp_port);
    let baseapp = u32::from(prefs.baseapp_port);
    if dst == loginapp {
        Some((ComponentRole::Loginapp, WireDirection::ClientToServer))
    } else if src == loginapp {
        Some((ComponentRole::Loginapp, WireDirection::ServerToClient))
    } else if dst == baseapp {
        Some((ComponentRole::Baseapp, WireDirection::ClientToServer))
    } else if src == baseapp {
        Some((ComponentRole::Baseapp, WireDirection::ServerToClient))
    } else {
        None
    }
}

/// 单条解码消息的摘要:已装表名或 unknown-id 如实;参数个数;
/// 不展开参数值(字段树是下一增量)。Flow::map 首建已并入静态表、动态
/// 导入后扩充,`msg.name` 为 None 即真未知,无第二查表面。
fn message_summary(msg: &DecodedMessage) -> String {
    let name = match &msg.name {
        Some(n) => n.clone(),
        None => format!("id=0x{:04x}(unknown)", msg.frame.id),
    };
    format!("{}({} args)", name, msg.values.len())
}

struct KbEngine;

impl Dissector for KbEngine {
    type Preferences = KbPrefs;
    type Header = NoHeader;
    const NAME: &'static str = "KBEngine Wire Protocol";
    const SHORT_NAME: &'static str = "KBE";
    const FILTER_NAME: &'static str = "kbengine";
    const EXPERTS: &'static [Expert] = &[
        Expert::new(
            "framing_error",
            ExpertGroup::Malformed,
            Severity::Warning,
            "KBEngine framing error",
        ),
        Expert::new(
            "unknown_message",
            ExpertGroup::Undecoded,
            Severity::Note,
            "Unknown KBEngine message id",
        ),
    ];

    /// 绑定面:两端口(prefs 变化即重挂载;0 = 不绑;同口去重)。
    fn dissect_on(preferences: &KbPrefs) -> Vec<Binding> {
        let mut out = vec![Binding::tcp_port(preferences.loginapp_port)];
        if preferences.baseapp_port != 0 && preferences.baseapp_port != preferences.loginapp_port {
            out.push(Binding::tcp_port(preferences.baseapp_port));
        }
        out
    }

    /// 组帧不交给 Wireshark(tcp_dissect_pdus):协议 crate 自带跨 feed
    /// 状态机(三种长度形态 + 65535 扩展 + 内存上限 + 错误复位),解析
    /// 单源不复制。dissect 每次收到一整段 TCP 载荷,成帧可能 0..N 条。
    fn tcp_framing() -> Option<libwireshark::TcpFraming> {
        None
    }

    fn dissect(
        preferences: &KbPrefs,
        packet: &mut PacketView<'_>,
    ) -> Option<DissectResult<NoHeader>> {
        let prefs = preferences.clone();
        let frame = packet.frame_number();
        let first = packet.is_first_pass();
        let (role, dir) = role_of(&prefs, packet.src_port(), packet.dst_port())?;
        let bytes = packet.bytes().to_vec();
        let len = packet.captured_len();

        let info = packet.with_conversation(|state: &mut Option<StreamState>| {
            let stream = state.get_or_insert_with(|| StreamState::open(&prefs, role));
            if let Some(cached) = stream.summaries.get(&frame) {
                return cached.clone();
            }
            if !first {
                // 重放遍且首遍无摘要:不推进状态,只给中性复述。
                return format!("kbengine {}: replay (no first-pass summary)", dir.as_str());
            }
            match stream.flow.feed_direction(dir, &bytes, &DecodeLimits::default()) {
                Ok(msgs) => {
                    let text = decoded_summary(stream.role, dir, &msgs);
                    stream.summaries.insert(frame, text.clone());
                    text
                }
                Err(error) => {
                    // 红线面:协议 crate 出错即自身复位;此处如实标注。
                    let text = format!(
                        "{} {}: framing reset: {error}",
                        role_label(stream.role),
                        dir.as_str()
                    );
                    stream.summaries.insert(frame, text.clone());
                    text
                }
            }
        })?;
        if info.contains("framing reset") {
            let _ = packet.add_expert_text("framing_error", &info);
        }
        if info.contains("(unknown)") {
            let _ = packet.add_expert_text("unknown_message", &info);
        }
        Some(DissectResult::new(NoHeader, len).with_info(info))
    }
}

fn role_label(role: ComponentRole) -> &'static str {
    match role {
        ComponentRole::Loginapp => "loginapp",
        ComponentRole::Baseapp => "baseapp",
    }
}

/// 首遍解码摘要:0..N 条消息列表;unknown id 计数如实;缓冲残段如实;
/// Info 列截断到 240 字符(字符边界安全,完整字段树属下一增量)。
fn decoded_summary(role: ComponentRole, dir: WireDirection, msgs: &[DecodedMessage]) -> String {
    let mut text = format!("{} {}", role_label(role), dir.as_str());
    if msgs.is_empty() {
        text.push_str(": fragment buffered");
    } else {
        let items: Vec<String> = msgs.iter().map(message_summary).collect();
        text.push_str(&format!(": {}", items.join(", ")));
        let unknown = msgs.iter().filter(|m| m.name.is_none()).count();
        if unknown > 0 {
            text.push_str(&format!(" [{unknown} unknown id]"));
        }
    }
    if text.len() > 240 {
        let mut cut = 240;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push('…');
    }
    text
}

plugin!(KbEngine);
