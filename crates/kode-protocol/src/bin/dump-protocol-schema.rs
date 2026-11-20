//! RUST-055:协议 schema 单一真源导出器。
//!
//! 把 kode-protocol 全部 wire DTO 聚合成一份 JSON Schema(根对象字段即
//! 类型清单,`$defs` 收全部子类型),stdout 输出;入库为
//! `crates/kode-protocol/protocol.schema.json`,TS 侧类型由该文件生成
//! (`pnpm gen:protocol`)。三锁链:
//! Rust 类型 →(本 bin)→ schema 文件 →(json-schema-to-typescript)→ TS 类型,
//! tests/protocolSchema.test.ts 逐级字节对账,任一侧漂移即红。
//!
//! 刻意不进 schema 的面:FrameDecoder/FrameOutcome(编解码内部态,非 wire
//! 形状);`$/kode/*` 32 方法 handler 类型(.kode-server 模块内,行为面由
//! protocolContract.test.ts SURFACE_PINS 钉真二进制观测)。

use kode_protocol::*;
use schemars::JsonSchema;

// 聚合根:让 schema_for! 把全部 wire DTO 收进同一份 schema 的 `definitions`。
// 字段名即类型清单(小写蛇形,生成 TS 根接口的属性名);只被 derive 消费
// 不被运行时读取,dead_code 是本 bin 的形态而非遗漏。
// (用 // 而非 ///:机制说明不进 schema description。)
#[allow(dead_code)]
/// kode2 协议 wire DTO 全集(RUST-055 单一真源)。
#[derive(JsonSchema)]
struct ProtocolSchemaRoot {
    request: Request,
    notification: Notification,
    server_notification: ServerNotification,
    response: Response,
    response_error: ResponseError,
    incoming_message: IncomingMessage,
    request_id: RequestId,
    initialize_params: InitializeParams,
    initialize_result: InitializeResult,
    server_capabilities: ServerCapabilities,
    server_info: ServerInfo,
    text_document_sync_options: TextDocumentSyncOptions,
    workspace_folder: WorkspaceFolder,
    did_open_params: DidOpenParams,
    text_document_item: TextDocumentItem,
    did_change_params: DidChangeParams,
    versioned_text_document_identifier: VersionedTextDocumentIdentifier,
    position: Position,
    range: Range,
    content_change_event: ContentChangeEvent,
    did_close_params: DidCloseParams,
    did_close_text_document_identifier: DidCloseTextDocumentIdentifier,
    renamed_file: RenamedFile,
    rename_files_params: RenameFilesParams,
    deleted_file: DeletedFile,
    delete_files_params: DeleteFilesParams,
    text_document_identifier: TextDocumentIdentifier,
    hover_params: HoverParams,
    completion_params: CompletionParams,
    completion_options: CompletionOptions,
    definition_params: DefinitionParams,
    document_diagnostic_params: DocumentDiagnosticParams,
    document_symbol_params: DocumentSymbolParams,
    reference_params: ReferenceParams,
    reference_context: ReferenceContext,
    prepare_rename_params: PrepareRenameParams,
    rename_params: RenameParams,
    code_action_params: CodeActionParams,
    code_action_diagnostic: CodeActionDiagnostic,
    health_report: HealthReport,
    core_resources: CoreResources,
    document_summary: DocumentSummary,
    file_changed_params: FileChangedParams,
}

fn main() {
    let mut schema =
        serde_json::to_value(schemars::schema_for!(ProtocolSchemaRoot)).expect("schema 可导出");
    // 版本元数据:与 PROTOCOL_VERSION 常量同源写入,TS 门对账三方一致
    // (Rust 常量 / TS KODE_PROTOCOL_VERSION / schema 头)。
    schema["title"] = "KodeProtocol".into();
    schema["x-kode-protocol-version"] = PROTOCOL_VERSION.into();
    println!(
        "{}",
        serde_json::to_string_pretty(&schema).expect("pretty print")
    );
}
