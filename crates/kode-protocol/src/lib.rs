//! kode-protocol — kode2 LSP 协议层(书 §3 crates/kode-protocol)。
//!
//! 范围(PR-003 最小集,书 §4):
//! - CORE-001 stdio LSP framed JSON-RPC:`Content-Length` 帧编码/增量解码,
//!   正确处理短读、分包、非法帧(报错后重同步,不吞后续帧)。
//! - CORE-002 `initialize` 协商 DTO:capabilities / serverInfo。
//! - CORE-003 request_id 贯穿:`RequestId` 贯穿请求/响应/取消/健康报告。
//!
//! 故意不做的:async IO、服务器状态机(在 kode-server)。本 crate 保持纯数据 +
//! 纯编解码,可无 IO 单测。

use serde::{Deserialize, Serialize};

/// 协议/服务器版本;ADR-001 语义下两侧握手时交换,不匹配由 TS 侧提示(BUILD-015 后续 PR)。
pub const PROTOCOL_VERSION: &str = "0.2.0";

/// LSP 标准帧头结束符。
pub const HEADER_DELIMITER: &[u8] = b"\r\n\r\n";

/// 帧头长度上限:超过仍无分隔符视为非法流,丢弃并重同步(防残留字节撑爆内存)。
pub const MAX_HEADER_BYTES: usize = 64 * 1024;

/// 单帧 body 上限:LSP 消息不该到 64MB;超过视为非法帧丢弃(CORE-012 的第一道闸)。
pub const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// JSON-RPC 2.0 / LSP 标准错误码(书 CORE-001/002 用到子集)。
pub mod error_codes {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    /// 服务器未完成 initialize 时收到其他请求(LSP 规范)。
    pub const SERVER_NOT_INITIALIZED: i64 = -32002;
    /// 请求被 $/cancelRequest 取消(LSP 规范)。
    pub const REQUEST_CANCELLED: i64 = -32800;
}

/// JSON-RPC 请求/响应 id。CORE-003:request_id 贯穿扩展↔Core↔后台任务,
/// 数字与字符串两种形态都要保真(禁止归一化成一种)。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
}

impl std::fmt::Display for RequestId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RequestId::Number(n) => write!(f, "#{n}"),
            RequestId::String(s) => write!(f, "#{s}"),
        }
    }
}

/// 入站消息:请求(带 id)或通知(无 id)。untagged 按字段区分。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum IncomingMessage {
    Request(Request),
    Notification(Notification),
}

/// JSON-RPC 请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

/// JSON-RPC 通知。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

/// JSON-RPC 响应。`id: None` 仅用于 id 不可知的解析错误(规范允许 null)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub jsonrpc: &'static str,
    pub id: Option<RequestId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ResponseError>,
}

impl Response {
    pub fn success(id: RequestId, result: serde_json::Value) -> Self {
        Response {
            jsonrpc: "2.0",
            id: Some(id),
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Option<RequestId>, code: i64, message: impl Into<String>) -> Self {
        Response {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(ResponseError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }
}

/// JSON-RPC 错误对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// 出站通知(服务器 → 客户端)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerNotification {
    pub jsonrpc: &'static str,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl ServerNotification {
    pub fn new(method: impl Into<String>, params: Option<serde_json::Value>) -> Self {
        ServerNotification {
            jsonrpc: "2.0",
            method: method.into(),
            params,
        }
    }
}

// ---------------------------------------------------------------------------
// CORE-002 initialize 协商 DTO(最小集;capabilities 随后续 PR 逐项扩充)
// ---------------------------------------------------------------------------

/// `initialize` 请求参数(只取本切片关心的字段,其余透传丢弃)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    #[serde(default)]
    pub process_id: Option<u64>,
    #[serde(default)]
    pub root_uri: Option<String>,
    #[serde(default)]
    pub capabilities: Option<serde_json::Value>,
    /// kode2 扩展位:restartGeneration 等客户端状态经此传入(CORE-015 对账)。
    #[serde(default)]
    pub initialization_options: Option<serde_json::Value>,
}

/// `initialize` 响应。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub capabilities: ServerCapabilities,
    pub server_info: ServerInfo,
}

/// 服务器 capabilities(最小集:full 文本同步)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    pub text_document_sync: TextDocumentSyncOptions,
}

/// 全量同步(openClose + change=1)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocumentSyncOptions {
    pub open_close: bool,
    /// 1 = Full:didChange 每次带全文(PH1 切片够用,增量同步在 VFS PR-004)。
    pub change: u8,
}

/// serverInfo:TS 侧握手时校验名字/版本(BUILD-015 版本不匹配提示的输入)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

// ---------------------------------------------------------------------------
// didOpen / didChange / didClose DTO(full sync)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DidOpenParams {
    pub text_document: TextDocumentItem,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocumentItem {
    pub uri: String,
    pub language_id: String,
    pub version: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DidChangeParams {
    pub text_document: VersionedTextDocumentIdentifier,
    pub content_changes: Vec<ContentChangeEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionedTextDocumentIdentifier {
    pub uri: String,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentChangeEvent {
    /// Full sync 下恒为 None;保留字段位便于 PR-004 增量同步扩展。
    #[serde(default)]
    pub range: Option<serde_json::Value>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DidCloseParams {
    pub text_document: DidCloseTextDocumentIdentifier,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DidCloseTextDocumentIdentifier {
    pub uri: String,
}

// ---------------------------------------------------------------------------
// CORE-016 健康探针 DTO
// ---------------------------------------------------------------------------

/// `$/kode/health` 响应:启动探针/健康状态/可观察恢复原因(CORE-016)。
/// `restart_generation` 由 TS 侧传入增长,崩溃重启后客户端可对账。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub status: String,
    pub pid: u32,
    pub server_version: String,
    pub uptime_ms: u64,
    pub initialized: bool,
    pub shutdown_requested: bool,
    pub restart_generation: u64,
    pub documents: Vec<DocumentSummary>,
}

/// 打开文档摘要(只含 uri+version,不带正文)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub uri: String,
    pub version: i64,
}

// ---------------------------------------------------------------------------
// CORE-001 帧编解码
// ---------------------------------------------------------------------------

/// 解码产出的单条结果:要么一条消息,要么一个帧级错误(非法头/非法 body)。
#[derive(Debug, Clone)]
pub enum FrameOutcome {
    Message(serde_json::Value),
    /// 非法帧头(缺 Content-Length/数值非法/超限)。
    InvalidHeader(String),
    /// 帧头合法但 body 不是合法 JSON → 上层回 PARSE_ERROR。
    InvalidBody,
}

/// 增量帧解码器:喂任意大小的字节块,吐出完整帧。
/// 处理:短读(帧未到齐先缓存)、分包(一次 chunk 多帧/一帧跨多 chunk)、
/// 非法帧(报 `InvalidHeader` 后向前重同步到下一帧候选头,不丢合法后续帧)。
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
    /// 重同步模式:帧头非法后为真,跳垃圾字节直到下一个帧候选头。
    resync: bool,
}

impl FrameDecoder {
    pub fn new() -> Self {
        FrameDecoder {
            buf: Vec::new(),
            resync: false,
        }
    }

    /// 当前缓冲内积压字节数(测试/诊断用)。
    pub fn buffered_len(&self) -> usize {
        self.buf.len()
    }

    /// 喂入一个字节块,返回本轮解出的全部帧结果。
    pub fn push(&mut self, chunk: &[u8]) -> Vec<FrameOutcome> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(outcome) = self.try_next_frame() {
            out.push(outcome);
        }
        self.compact();
        out
    }

    /// 尝试解出一个帧;解不出(数据不足)返回 None。
    fn try_next_frame(&mut self) -> Option<FrameOutcome> {
        // 重同步模式:上一次帧头非法,跳过垃圾字节直到下一个 Content-Length: 候选。
        if self.resync {
            match find_subslice(&self.buf, b"Content-Length:") {
                Some(pos) => {
                    self.buf.drain(..pos);
                    self.resync = false;
                }
                None => {
                    // 没找到候选头:保留尾部若干字节(可能是被截断的下一个头)。
                    let keep_from = self.buf.len().saturating_sub(b"Content-Length:".len() - 1);
                    self.buf.drain(..keep_from);
                    return None;
                }
            }
        }

        let header_end = match find_subslice(&self.buf, HEADER_DELIMITER) {
            Some(pos) => pos + HEADER_DELIMITER.len(),
            None => {
                if self.buf.len() > MAX_HEADER_BYTES {
                    self.buf.clear();
                    self.resync = true;
                    return Some(FrameOutcome::InvalidHeader(
                        "header delimiter not found within limit".to_string(),
                    ));
                }
                return None; // 短读:头未到齐
            }
        };

        let content_length = match parse_content_length(&self.buf[..header_end]) {
            Ok(len) => len,
            Err(err) => {
                self.buf.drain(..header_end);
                // 帧头非法:其 body 也是垃圾,进入重同步跳到下一帧候选。
                self.resync = true;
                return Some(FrameOutcome::InvalidHeader(err));
            }
        };
        if content_length > MAX_BODY_BYTES {
            self.buf.drain(..header_end);
            // body 超限且长度不可信,直接进入重同步。
            self.resync = true;
            return Some(FrameOutcome::InvalidHeader(format!(
                "content-length {content_length} exceeds limit {MAX_BODY_BYTES}"
            )));
        }

        if self.buf.len() < header_end + content_length {
            return None; // 短读:body 未到齐
        }
        let body: Vec<u8> = self.buf.drain(..header_end + content_length).collect();
        let body = &body[header_end..];
        match serde_json::from_slice::<serde_json::Value>(body) {
            Ok(value) => Some(FrameOutcome::Message(value)),
            Err(_) => Some(FrameOutcome::InvalidBody),
        }
    }

    /// 丢弃已消费的前缀,防缓冲无限增长。
    fn compact(&mut self) {
        if self.buf.capacity() > 1024 * 1024 && self.buf.len() < 64 * 1024 {
            self.buf.shrink_to_fit();
        }
    }
}

/// 编码一条消息为 LSP stdio 帧(`Content-Length` 头 + body)。
pub fn encode_frame(body: &serde_json::Value) -> std::io::Result<Vec<u8>> {
    let body = serde_json::to_vec(body)?;
    let mut frame = Vec::with_capacity(body.len() + 64);
    frame.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// 从帧头字节里解析 Content-Length(允许其他头字段,大小写不敏感)。
fn parse_content_length(header: &[u8]) -> Result<usize, String> {
    let text = std::str::from_utf8(header).map_err(|_| "header is not valid UTF-8".to_string())?;
    let mut found = None;
    for line in text.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            let value = value.trim();
            found = Some(
                value
                    .parse::<usize>()
                    .map_err(|_| format!("invalid Content-Length value {value:?}"))?,
            );
        }
    }
    found.ok_or_else(|| "missing Content-Length header".to_string())
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
