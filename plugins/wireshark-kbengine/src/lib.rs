//! PA-006:KBEngine 线协议 Wireshark dissector 插件(todo PA-006 Phase 4)。
//!
//! 架构边界:本 crate 只是 Wireshark 宿主适配层——字节进/摘要出 + 字段树
//! 渲染,零解析逻辑;三种长度形态组帧、TCP 粘包/拆包、静态+动态消息表、
//! 每 Flow 独立状态机、内存上限与错误复位语义,全部在仓库
//! `kode-kbengine-protocol`(PA-003 验收面,失败不 panic/不越界红线)。
//! unknown id 不编造:无静态表时走 unknown-id 异常面如实展示。
//!
//! 首遍语义:会话状态只在 Wireshark 首遍推进([`PacketView::is_first_pass`]),
//! 重放遍(选中/过滤触发的重解剖)只复述首遍摘要与字段树(树条目纯渲染,
//! 无会话副作用,重放安全)。
//!
//! 字段树(本增量):协议 crate [`decode_spans`] 数据面(与值解码同读序/同
//! 错误语义/同限额),插件按固定注册字段表逐字节区间渲染;标量走整数/
//! bool/字符串/字节,浮点以原始字节面展示(libwireshark alpha 未暴露
//! FT_FLOAT/FT_DOUBLE,不解值不编造);容器(FIXED_DICT/ARRAY/带前缀块/
//! Vector)为 Group 条目 + 子项。
//!
//! 偏移真校验:协议 crate 错误复位(缓冲清空)后其流内偏移与喂入字节数
//! 脱节;插件渲染前校验 tvb 帧头 2 字节 == 消息 id 小端,失真帧如实
//! 不出树(摘要照旧),不猜偏移。

use std::collections::BTreeMap;

use kode_kbengine_protocol::codec::DecodeLimits;
use kode_kbengine_protocol::{
    decode_spans, ComponentRole, DecodedMessage, Direction as WireDirection, Flow, LengthSpec,
    SpanKind, ValueSpan,
};
use kode_kbengine_schema::messages::{build_message_table, MessageTable};
use libwireshark::prefs::{Declaration, PreferenceError, PreferenceMap, PreferenceValue};
use libwireshark::prefs::Value as PrefValue;
use libwireshark::{
    plugin, Base, Binding, DissectResult, Dissector, Encoding, Expert, ExpertGroup, FieldInfo,
    FieldType, Header, PacketFieldError, PacketView, Preferences, Severity,
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

/// 字段注册表(手工 Header impl;渲染按注册名查表,未注册名 → 静默跳过)。
/// abbrev 不带 `kbengine.` 前缀(框架按 FILTER_NAME 自动加)。
struct KbFields;

const FIELDS: &[FieldInfo] = &[
    FieldInfo::new("msg_id", "msg_id", FieldType::U16)
        .with_base(Base::Hex)
        .with_blurb("消息 id(u16 小端,帧头)"),
    FieldInfo::new("msg_len", "msg_len", FieldType::U16)
        .with_blurb("变长形态载荷长(u16,不含 id+长度头)"),
    FieldInfo::new("msg_len_ext", "msg_len_ext", FieldType::U32)
        .with_blurb("扩展形态实长(65535 哨兵后的 u32)"),
    FieldInfo::new("arg_bool", "arg_bool", FieldType::Bool)
        .with_blurb("BOOL 参数(bool 按 int8 存取)"),
    FieldInfo::new("arg_u8", "arg_u8", FieldType::U8).with_base(Base::Hex),
    FieldInfo::new("arg_u16", "arg_u16", FieldType::U16).with_base(Base::Hex),
    FieldInfo::new("arg_u32", "arg_u32", FieldType::U32).with_base(Base::Hex),
    FieldInfo::new("arg_u64", "arg_u64", FieldType::U64).with_base(Base::Hex),
    FieldInfo::new("arg_i8", "arg_i8", FieldType::I8),
    FieldInfo::new("arg_i16", "arg_i16", FieldType::I16),
    FieldInfo::new("arg_i32", "arg_i32", FieldType::I32),
    FieldInfo::new("arg_i64", "arg_i64", FieldType::I64),
    FieldInfo::new("arg_f32b", "arg_f32b", FieldType::Bytes)
        .with_blurb("FLOAT 参数原始 4 字节(libwireshark alpha 未暴露浮点字段类型,不解值)"),
    FieldInfo::new("arg_f64b", "arg_f64b", FieldType::Bytes)
        .with_blurb("DOUBLE 参数原始 8 字节(同上,不解值)"),
    FieldInfo::new("arg_str", "arg_str", FieldType::String)
        .with_blurb("STRING/UNICODE 文本体"),
    FieldInfo::new("arg_bytes", "arg_bytes", FieldType::Bytes).with_blurb("BLOB 体"),
    FieldInfo::new("arg_raw", "arg_raw", FieldType::Bytes)
        .with_blurb("未取证/未知类型原始保留(ENTITYCALL/PYTHON/Unresolved)"),
    FieldInfo::new("arg_group", "arg_group", FieldType::None)
        .with_blurb("容器(数组/FIXED_DICT/带前缀块/定长 Vector)"),
];

impl Header for KbFields {
    fn fields() -> &'static [FieldInfo] {
        FIELDS
    }

    fn add_to(&self, _packet: &mut PacketView<'_>) -> Result<(), PacketFieldError> {
        Ok(())
    }
}

/// 单帧字段树缓存条目(首遍算,重放遍重放;树条目纯渲染无副作用)。
#[derive(Clone)]
struct MsgTreeEntry {
    /// 帧头在 tvb(本段 TCP 载荷)内的偏移。
    base: usize,
    id: u16,
    length_spec: LengthSpec,
    payload_len: usize,
    spans: Vec<ValueSpan>,
}

/// 每 TCP 流(Wireshark conversation)状态:角色 + 组帧/解码机 + 首遍摘要与
/// 字段树缓存(重放遍复述)。静态表只在开流时并入 Flow::map,不留驻。
struct StreamState {
    role: ComponentRole,
    flow: Flow,
    summaries: BTreeMap<u32, String>,
    trees: BTreeMap<u32, Vec<MsgTreeEntry>>,
    /// 已喂入字节计数(按方向):帧 tvb 偏移 = stream_offset - 本段前喂入量。
    /// 错误复位后协议 crate 的流内偏移与计数脱节,由渲染前 tvb 真校验兜住。
    fed: [usize; 2],
}

impl StreamState {
    fn open(prefs: &KbPrefs, role: ComponentRole) -> Self {
        let statics = load_statics(prefs);
        let flow = Flow::new(role, &statics);
        StreamState {
            role,
            flow,
            summaries: BTreeMap::new(),
            trees: BTreeMap::new(),
            fed: [0, 0],
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

/// 方向 → fed 计数下标。
fn dir_index(dir: WireDirection) -> usize {
    match dir {
        WireDirection::ClientToServer => 0,
        WireDirection::ServerToClient => 1,
    }
}

/// 帧头字节长(与 framing.rs 同口径:Fixed 无长度字段)。
fn header_len(spec: LengthSpec) -> usize {
    match spec {
        LengthSpec::Fixed(_) => 2,
        LengthSpec::Variable => 4,
        LengthSpec::Extended(_) => 8,
    }
}

/// 单条解码消息的摘要:已装表名或 unknown-id 如实;参数个数;不展开参数
/// 值(字段树承担)。Flow::map 首建已并入静态表、动态导入后扩充,
/// `msg.name` 为 None 即真未知,无第二查表面。
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
    type Header = KbFields;
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
    ) -> Option<DissectResult<KbFields>> {
        let prefs = preferences.clone();
        let frame = packet.frame_number();
        let first = packet.is_first_pass();
        let (role, dir) = role_of(&prefs, packet.src_port(), packet.dst_port())?;
        let bytes = packet.bytes().to_vec();
        let len = packet.captured_len();

        let (info, entries) =
            packet.with_conversation(|state: &mut Option<StreamState>| {
                let stream = state.get_or_insert_with(|| StreamState::open(&prefs, role));
                if let Some(cached) = stream.summaries.get(&frame) {
                    let trees = stream.trees.get(&frame).cloned().unwrap_or_default();
                    return (cached.clone(), trees);
                }
                if !first {
                    // 重放遍且首遍无摘要:不推进状态,只给中性复述。
                    return (
                        format!("kbengine {}: replay (no first-pass summary)", dir.as_str()),
                        Vec::new(),
                    );
                }
                let fed_before = stream.fed[dir_index(dir)];
                match stream.flow.feed_direction(dir, &bytes, &DecodeLimits::default()) {
                    Ok(msgs) => {
                        let mut entries = Vec::new();
                        for msg in &msgs {
                            // 帧 tvb 偏移 = 流内偏移 - 本段前喂入量;下溢帧
                            // (错误复位后脱节)不出树,由渲染前校验兜住。
                            let Some(base) = msg.frame.stream_offset.checked_sub(fed_before)
                            else {
                                continue;
                            };
                            let Some(spec) = stream.flow.map.by_id(msg.frame.id) else {
                                continue;
                            };
                            let args = spec.args.clone();
                            if let Ok(spans) =
                                decode_spans(&args, &msg.frame.payload, &DecodeLimits::default())
                            {
                                entries.push(MsgTreeEntry {
                                    base,
                                    id: msg.frame.id,
                                    length_spec: msg.frame.length_spec,
                                    payload_len: msg.frame.payload.len(),
                                    spans,
                                });
                            }
                        }
                        stream.fed[dir_index(dir)] = fed_before + bytes.len();
                        let text = decoded_summary(stream.role, dir, &msgs);
                        stream.summaries.insert(frame, text.clone());
                        stream.trees.insert(frame, entries.clone());
                        (text, entries)
                    }
                    Err(error) => {
                        stream.fed[dir_index(dir)] = fed_before + bytes.len();
                        // 红线面:协议 crate 出错即自身复位;此处如实标注。
                        let text = format!(
                            "{} {}: framing reset: {error}",
                            role_label(stream.role),
                            dir.as_str()
                        );
                        stream.summaries.insert(frame, text.clone());
                        stream.trees.remove(&frame);
                        (text, Vec::new())
                    }
                }
            })?;
        if info.contains("framing reset") {
            let _ = packet.add_expert_text("framing_error", &info);
        }
        if info.contains("(unknown)") {
            let _ = packet.add_expert_text("unknown_message", &info);
        }
        // 字段树:渲染前真校验(错误复位后协议 crate 流内偏移与喂入字节数
        // 脱节)——tvb 帧头 2 字节必须等于 id 小端,失真帧如实不出树。
        for entry in &entries {
            let head_ok = {
                let all = packet.bytes();
                let head = [entry.id as u8, (entry.id >> 8) as u8];
                all.get(entry.base..entry.base + 2) == Some(&head[..])
            };
            if head_ok {
                render_frame_tree(packet, entry);
            }
        }
        Some(DissectResult::new(KbFields, len).with_info(info))
    }
}

fn role_label(role: ComponentRole) -> &'static str {
    match role {
        ComponentRole::Loginapp => "loginapp",
        ComponentRole::Baseapp => "baseapp",
    }
}

/// 首遍解码摘要:0..N 条消息列表;unknown id 计数如实;缓冲残段如实;
/// Info 列截断到 240 字符(字符边界安全,完整字段树见树渲染)。
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

/// 渲染一帧的字段树:帧头(id/长度形态) + 各参数跨度(载荷偏移 = 帧头 +
/// 头长 + span.start)。单条目失败(截断捕获/越界)静默跳过,不毁整树。
fn render_frame_tree(packet: &mut PacketView<'_>, e: &MsgTreeEntry) {
    let _ = packet.add_uint("msg_id", e.base, u32::from(e.id));
    match e.length_spec {
        LengthSpec::Fixed(_) => {}
        LengthSpec::Variable => {
            let _ = packet.add_uint("msg_len", e.base + 2, e.payload_len as u32);
        }
        LengthSpec::Extended(_) => {
            let _ = packet.add_uint("msg_len", e.base + 2, 65535);
            let _ = packet.add_uint("msg_len_ext", e.base + 4, e.payload_len as u32);
        }
    }
    let payload_off = e.base + header_len(e.length_spec);
    for span in &e.spans {
        render_span(packet, span, payload_off);
    }
}

/// 单个跨度渲染(按种类选注册字段;浮点字节面如实不解值;Group 递归)。
fn render_span(packet: &mut PacketView<'_>, span: &ValueSpan, tvb_off: usize) {
    let off = tvb_off + span.start;
    let res = match span.kind {
        SpanKind::Bool => packet.add_item("arg_bool", off, span.len, Encoding::NA),
        SpanKind::U8 => packet.add_item("arg_u8", off, span.len, Encoding::LITTLE_ENDIAN),
        SpanKind::U16 => packet.add_item("arg_u16", off, span.len, Encoding::LITTLE_ENDIAN),
        SpanKind::U32 => packet.add_item("arg_u32", off, span.len, Encoding::LITTLE_ENDIAN),
        SpanKind::U64 => packet.add_item("arg_u64", off, span.len, Encoding::LITTLE_ENDIAN),
        SpanKind::I8 => packet.add_item("arg_i8", off, span.len, Encoding::LITTLE_ENDIAN),
        SpanKind::I16 => packet.add_item("arg_i16", off, span.len, Encoding::LITTLE_ENDIAN),
        SpanKind::I32 => packet.add_item("arg_i32", off, span.len, Encoding::LITTLE_ENDIAN),
        SpanKind::I64 => packet.add_item("arg_i64", off, span.len, Encoding::LITTLE_ENDIAN),
        SpanKind::F32 => packet.add_item("arg_f32b", off, span.len, Encoding::NA),
        SpanKind::F64 => packet.add_item("arg_f64b", off, span.len, Encoding::NA),
        SpanKind::Str => packet.add_item("arg_str", off, span.len, Encoding::UTF_8),
        SpanKind::Bytes => packet.add_item("arg_bytes", off, span.len, Encoding::NA),
        SpanKind::Raw => packet.add_item("arg_raw", off, span.len, Encoding::NA),
        SpanKind::Group => {
            let top = packet.add_item("arg_group", off, span.len, Encoding::NA);
            for child in &span.children {
                render_span(packet, child, tvb_off);
            }
            top
        }
    };
    let _ = res;
}

plugin!(KbEngine);
