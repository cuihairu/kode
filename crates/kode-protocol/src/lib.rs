//! kode-protocol — kode2 LSP protocol layer (book §3, crates/kode-protocol).
//!
//! Scope (PR-003 minimal set, book §4):
//! - CORE-001 stdio LSP framed JSON-RPC DTOs (the message shapes). Frame encoding/decoding is
//!   delegated to the `lsp-server` crate (held by kode-server): this crate carries only the
//!   JSON-RPC data shapes, never hand-rolled byte framing.
//! - CORE-002 `initialize` negotiation DTO: capabilities / serverInfo.
//! - CORE-003 request_id threading: `RequestId` threads through request/response/cancel/health
//!   report.
//!
//! Deliberately out of scope: async IO and the server state machine (live in kode-server). This
//! crate stays pure data + pure codec, unit-testable without IO.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Protocol/server version; exchanged by both sides at handshake per ADR-001, mismatch surfaced by the TS side (BUILD-015 follow-up PR).
pub const PROTOCOL_VERSION: &str = "0.2.0";

/// JSON-RPC 2.0 / LSP standard error codes (the subset used by book CORE-001/002).
pub mod error_codes {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    /// Request other than initialize received before the server finished initializing (LSP spec).
    pub const SERVER_NOT_INITIALIZED: i64 = -32002;
    /// Request cancelled by $/cancelRequest (LSP spec).
    pub const REQUEST_CANCELLED: i64 = -32800;
}

/// JSON-RPC request/response id. CORE-003: request_id threads through extension<->Core<->background
/// tasks; both number and string forms must be preserved faithfully (normalizing to one form is
/// forbidden).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
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

/// Inbound message: request (with id) or notification (no id). Untagged, distinguished by fields.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum IncomingMessage {
    Request(Request),
    Notification(Notification),
}

/// JSON-RPC request.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Request {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

/// JSON-RPC notification.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Notification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

/// JSON-RPC response. `id: None` is only for parse errors where the id is unknowable (the spec allows null).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
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

/// JSON-RPC error object.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ResponseError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// Outbound notification (server -> client).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
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
// CORE-002 initialize negotiation DTO (minimal set; capabilities grow item by item in follow-up PRs)
// ---------------------------------------------------------------------------

/// `initialize` request params (only the fields this slice cares about; the rest pass through and are dropped).
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    #[serde(default)]
    pub process_id: Option<u64>,
    #[serde(default)]
    pub root_uri: Option<String>,
    /// LSP multi-workspace folders (VFS-009/KBUG-ROOT): registered one by one as resource roots,
    /// the basis for attributing same-named entities across roots; defaults to only rootUri.
    #[serde(default)]
    pub workspace_folders: Option<Vec<WorkspaceFolder>>,
    #[serde(default)]
    pub capabilities: Option<serde_json::Value>,
    /// kode2 extension slot: client state such as restartGeneration is passed in here (CORE-015 parity comparison).
    #[serde(default)]
    pub initialization_options: Option<serde_json::Value>,
}

/// LSP workspace folder (an initialize.workspaceFolders entry; uri is required).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFolder {
    pub uri: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// `initialize` response.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub capabilities: ServerCapabilities,
    pub server_info: ServerInfo,
}

/// Server capabilities (minimal set: full text sync + hover + completion).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    pub text_document_sync: TextDocumentSyncOptions,
    /// LSP-003 / PH1-03 (PR-010): hover provider capability declaration.
    #[serde(default)]
    pub hover_provider: bool,
    /// Phase2 first slice: textDocument/definition capability declaration (declaration landing site).
    #[serde(default)]
    pub definition_provider: bool,
    /// RUST-139 batch 3: textDocument/documentSymbol capability declaration (def segment-symbol face).
    #[serde(default)]
    pub document_symbol_provider: bool,
    /// RUST-138 batch 3: textDocument/references capability declaration (declaration + reference-site face).
    #[serde(default)]
    pub references_provider: bool,
    /// RUST-141 batch 2: textDocument/rename+prepareRename capability declaration (def rename face).
    #[serde(default)]
    pub rename_provider: bool,
    /// RUST-143 batch 3: textDocument/codeAction capability declaration (four-family assembly face).
    #[serde(default)]
    pub code_action_provider: bool,
    /// RUST-140 batch 3: textDocument/signatureHelp capability declaration (def method signature face).
    #[serde(default)]
    pub signature_help_provider: bool,
    /// RUST-139 batch 4: workspace/symbol capability declaration (def symbol prefix-search face).
    #[serde(default)]
    pub workspace_symbol_provider: bool,
    /// LSP-005 / PR-011: completion provider capability declaration (trigger character `<`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_provider: Option<CompletionOptions>,
}

/// Full sync (openClose + change=1).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextDocumentSyncOptions {
    pub open_close: bool,
    /// 1 = Full: didChange always carries the full text (enough for the PH1 slice; incremental sync is VFS PR-004).
    pub change: u8,
}

/// serverInfo: the TS side validates name/version at handshake (input for the BUILD-015 version-mismatch notice).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

// ---------------------------------------------------------------------------
// didOpen / didChange / didClose DTO(full sync)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DidOpenParams {
    pub text_document: TextDocumentItem,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextDocumentItem {
    pub uri: String,
    pub language_id: String,
    pub version: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DidChangeParams {
    pub text_document: VersionedTextDocumentIdentifier,
    pub content_changes: Vec<ContentChangeEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VersionedTextDocumentIdentifier {
    pub uri: String,
    pub version: i64,
}

/// LSP position (character counted in UTF-16 code units; semantics per kode-vfs VFS-004).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

/// LSP range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContentChangeEvent {
    /// Always None under full sync (change=1); incremental sync (change=2) carries a range,
    /// with exact coordinate conversion done by kode-vfs (VFS-004).
    #[serde(default)]
    pub range: Option<Range>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DidCloseParams {
    pub text_document: DidCloseTextDocumentIdentifier,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DidCloseTextDocumentIdentifier {
    pub uri: String,
}

// ---------------------------------------------------------------------------
// workspace/didRenameFiles / didDeleteFiles DTO (RUST-131-W production file events)
// ---------------------------------------------------------------------------

/// LSP `WorkspaceFileRename`: one rename event (old -> new).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenamedFile {
    pub old_uri: String,
    pub new_uri: String,
}

/// LSP `RenameFilesParams` (only files[].oldUri/newUri is consumed).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenameFilesParams {
    pub files: Vec<RenamedFile>,
}

/// LSP `DeleteFilesParams` entry (only files[].uri is consumed).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DeletedFile {
    pub uri: String,
}

/// LSP `DeleteFilesParams`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DeleteFilesParams {
    pub files: Vec<DeletedFile>,
}

// ---------------------------------------------------------------------------
// textDocument/hover DTO (PR-010: HOVER-001 request entry)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextDocumentIdentifier {
    pub uri: String,
}

/// hover request params: document identity + UTF-16 position (same semantics as Position).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HoverParams {
    pub text_document: TextDocumentIdentifier,
    pub position: Position,
}

// ---------------------------------------------------------------------------
// textDocument/completion DTO (PR-011: baseline completion request path)
// ---------------------------------------------------------------------------

/// completion request params: document identity + UTF-16 position (the trigger context is derived
/// server-side from the text before the cursor, same contract as the TS line-prefix face).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompletionParams {
    pub text_document: TextDocumentIdentifier,
    pub position: Position,
}

/// completion capability declaration (triggerCharacters lets the client decide when to request).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompletionOptions {
    pub trigger_characters: Vec<String>,
    /// RUST-135: completionItem/resolve lazy detail face (docs/source filled in on demand).
    pub resolve_provider: bool,
}

// ---------------------------------------------------------------------------
// textDocument/definition DTO (Phase2 first slice: declaration landing-site request path)
// ---------------------------------------------------------------------------

/// definition request params: document identity + UTF-16 position (same locating foundation as hover).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionParams {
    pub text_document: TextDocumentIdentifier,
    pub position: Position,
}

/// Document identity for the definition request (same shape as hover; a separate type keeps LSP semantics clear).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDiagnosticParams {
    pub text_document: TextDocumentIdentifier,
}

// ---------------------------------------------------------------------------
// textDocument/documentSymbol DTO (RUST-139 batch 3: Outline segment-symbol face sunk into the wiring)
// ---------------------------------------------------------------------------

/// documentSymbol request params: document identity only (the Outline face is recomputed server-side
/// from the synced document text; no position/context input; a separate type keeps LSP semantics
/// clear).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSymbolParams {
    pub text_document: TextDocumentIdentifier,
}

/// references request params: document identity + UTF-16 position + reference context (RUST-138 batch 3).
/// `context`/`includeDeclaration` may both be omitted (omitted = no exact declaration, matching LSP
/// ReferenceContext semantics; the client may send just the document and position).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceParams {
    pub text_document: TextDocumentIdentifier,
    pub position: Position,
    #[serde(default)]
    pub context: ReferenceContext,
}

/// Reference context: `includeDeclaration` decides whether the exact declaration (that symbol's name
/// span inside the def) counts toward the result. The types.xml face has no declaration site at all,
/// so this flag has no effect on that face.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceContext {
    #[serde(default)]
    pub include_declaration: bool,
}

/// prepareRename request params (RUST-141 batch 2): document identity + UTF-16 position --
/// renamable-symbol resolution and the candidate-name range are recomputed server-side from the
/// synced document.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRenameParams {
    pub text_document: TextDocumentIdentifier,
    pub position: Position,
}

/// rename request params (RUST-141 batch 2): document identity + UTF-16 position + target name.
/// The def-face edit and closure-conflict pre-check are recomputed server-side (the python self-access
/// rewrite face is not part of this face).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenameParams {
    pub text_document: TextDocumentIdentifier,
    pub position: Position,
    pub new_name: String,
}

/// codeAction diagnostic input face (RUST-143 batch 3): the TS side collapses vscode.Diagnostic into
/// pure data (code/range/related location face); the assembly decision core filters by the code gate
/// and range intersection.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CodeActionDiagnostic {
    pub code: String,
    pub range: Range,
    /// relatedInformation[0].location.uri.fsPath (parity-family location face; omitted when absent).
    #[serde(default)]
    pub related_file: Option<String>,
    /// relatedInformation[0].message (target class name; the server falls back to the def file name
    /// when it is empty).
    #[serde(default)]
    pub related_message: Option<String>,
}

/// codeAction request params (RUST-143 batch 3): assembly-family dispatch + family inputs
/// (registered = the near-miss universe from TS getKnownTypeContext assembly; snapshotText = the
/// parity-family target python snapshot, TS readSharedFileSnapshot preferring the open buffer) + the
/// diagnostic face array. The four families (typeReplacement/parityMethod/receiverNone/fixedDict) are
/// assembled independently, producing an ActionFace descriptor array (vscode object construction and
/// l10n titles stay with the TS thin shell).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CodeActionParams {
    pub text_document: TextDocumentIdentifier,
    pub range: Range,
    pub family: String,
    #[serde(default)]
    pub registered: Vec<String>,
    #[serde(default)]
    pub snapshot_text: Option<String>,
    #[serde(default)]
    pub diagnostics: Vec<CodeActionDiagnostic>,
}

/// signatureHelp request params (RUST-140 batch 3): python document + cursor. Starting from the
/// inline text, the server runs call-site lexing (python_call_at, isomorphic to TS
/// getPythonCallAtPosition) -> the inheritance-chain closure signature decision (signature_help) in
/// this domain, with zero TS decision input throughout; the runtime entity registry chain
/// (EntityMappingManager) does not cross this face -- signatures come from the corpus def view.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignatureHelpParams {
    pub text_document: TextDocumentIdentifier,
    pub position: Position,
}

/// `workspace/symbol` params (RUST-139 batch 4): the prefix query string for Ctrl+T quick search.
/// The LSP optional `limit` param does not enter the Rust face -- the decision core produces the full
/// result set, which the TS thin shell then truncates (that is vscode request-side behaviour; the
/// server does not guess the paging contract).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSymbolParams {
    pub query: String,
}

// ---------------------------------------------------------------------------
// CORE-016 health probe DTO
// ---------------------------------------------------------------------------

/// `$/kode/health` response: startup probe / health status / observable recovery reason (CORE-016).
/// `restart_generation` grows on the TS side so the client can reconcile after a crash restart.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
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
    /// RUST-026 Core process resource observation; non-Linux or /proc parse failure = None (honest
    /// degradation)
    #[serde(default)]
    pub resources: Option<CoreResources>,
}

/// Core process resource snapshot (RUST-026): RSS / thread count / cumulative disk IO.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoreResources {
    pub rss_bytes: u64,
    pub threads: u32,
    pub disk_read_bytes: u64,
    pub disk_write_bytes: u64,
    /// Cumulative process CPU time in ms (utime+stime, assuming the Linux-standard CLK_TCK=100);
    /// the caller diffs two samples to get a rate
    pub cpu_time_ms: u64,
}

/// Open-document summary (uri + version only, no text body).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub uri: String,
    pub version: i64,
}

// ---------------------------------------------------------------------------
// `$/kode/fileChanged` notification (hot-reload bypass face §11.3): non-py file changes forwarded to rust on demand
// ---------------------------------------------------------------------------

/// `$/kode/fileChanged` notification method name (client -> server, one-way, no acknowledgment).
///
/// When the TS side watches a non-py file change under assetsRoot and a rust consumer is registered
/// in the consumer registry, it sends this frame over the existing LSP stdio; **no
/// request/response semantics change**. The server silently drops unknown notifications per the LSP
/// spec (the unknown branch of kode-server `handle_notification`), so until the rust side implements
/// this notification there is zero side effect -- a silent degradation.
///
/// Cross-checked character for character with TS `src/fileChangeBypass.ts`
/// `KODE_FILE_CHANGED_METHOD` (each side carries one cross-language parity lock).
pub const FILE_CHANGED_NOTIFICATION: &str = "$/kode/fileChanged";

/// `$/kode/fileChanged` notification params: pure data, no vscode binding -- when watch is sunk
/// into rust later, TS is just a consumer and the protocol stays character for character. Fields are
/// isomorphic to TS `NonPythonChangeEvent` (fsPath/identity/kind/version/fileName/ext/sha256/handledBy).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileChangedParams {
    /// Path as-is
    pub fs_path: String,
    /// Normalized identity key (slash / dot-segment normalization)
    pub identity: String,
    /// "create" | "change" | "delete"
    pub kind: String,
    /// On-disk version token `${mtimeMs}:${size}`; None when unavailable (never fabricated)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub file_name: String,
    /// Lowercase extension with the leading dot (`.def`); empty string when there is no extension
    pub ext: String,
    /// Content sha256 hex; None on deletion or when unreadable (never fabricated)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// "python" | "rust" | "unrouted" (the handler the route resolved to)
    pub handled_by: String,
}

#[cfg(test)]
mod file_changed_notification {
    use super::*;

    #[test]
    fn method_name_matches_ts_constant() {
        // Cross-language parity lock: TS KODE_FILE_CHANGED_METHOD matches this constant verbatim
        let ts = include_str!("../../../src/backend/fileChangeBypass.ts");
        assert_eq!(FILE_CHANGED_NOTIFICATION, "$/kode/fileChanged");
        assert!(
            ts.contains(&format!("'{FILE_CHANGED_NOTIFICATION}'")),
            "TS 侧 KODE_FILE_CHANGED_METHOD 应与 Rust FILE_CHANGED_NOTIFICATION 同值"
        );
    }

    #[test]
    fn params_serialise_to_camel_case_payload() {
        let params = FileChangedParams {
            fs_path: "/ws/assets/res/types.xml".to_string(),
            identity: "/ws/assets/res/types.xml".to_string(),
            kind: "change".to_string(),
            version: Some("1730000000000:9".to_string()),
            file_name: "types.xml".to_string(),
            ext: ".xml".to_string(),
            sha256: Some("a".repeat(64)),
            handled_by: "rust".to_string(),
        };
        let json = serde_json::to_value(&params).expect("serialisable");
        assert_eq!(json["fsPath"], "/ws/assets/res/types.xml");
        assert_eq!(json["fileName"], "types.xml");
        assert_eq!(json["handledBy"], "rust");
        assert_eq!(json["version"], "1730000000000:9");
        // Optional fields (version/digest unavailable) are omitted rather than null, so the
        // front end need not check for null
        let minimal = FileChangedParams {
            version: None,
            sha256: None,
            ..params
        };
        let json = serde_json::to_value(&minimal).expect("serialisable");
        assert!(json.get("version").is_none());
        assert!(json.get("sha256").is_none());
    }
}
