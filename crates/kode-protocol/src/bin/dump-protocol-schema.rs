//! RUST-055: single-source-of-truth exporter for the protocol schema.
//!
//! Aggregates every kode-protocol wire DTO into one JSON Schema (the root object's fields are the
//! type inventory, `$defs` collects all sub-types), printed to stdout; checked in as
//! `crates/kode-protocol/protocol.schema.json`, from which the TS types are generated
//! (`pnpm gen:protocol`). Three-lock chain:
//! Rust types -> (this bin) -> schema file -> (json-schema-to-typescript) -> TS types,
//! with tests/protocolSchema.test.ts doing byte-level parity at each hop; any drift on either side
//! goes red.
//!
//! Faces deliberately kept out of the schema: the `Content-Length` frame codec (delegated to the
//! `lsp-server` crate, held by kode-server, so there is no in-repo codec type to describe here); the
//! `$/kode/*` 32-method handler types (inside the .kode-server module; the behavioural face is
//! pinned by protocolContract.test.ts SURFACE_PINS against real binary observation).

use kode_protocol::*;
use schemars::JsonSchema;

// Aggregation root: lets schema_for! collect every wire DTO into the `definitions` of one schema.
// The field names are the type inventory (lower_snake_case, becoming the generated TS root
// interface's property names); consumed only by the derive, never read at runtime, so dead_code is
// this bin's shape rather than an omission.
// (// instead of ///: mechanism notes that must not end up in the schema description.)
#[allow(dead_code)]
/// The full set of kode2 protocol wire DTOs (RUST-055 single source of truth).
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
    signature_help_params: SignatureHelpParams,
    workspace_symbol_params: WorkspaceSymbolParams,
    health_report: HealthReport,
    core_resources: CoreResources,
    document_summary: DocumentSummary,
    file_changed_params: FileChangedParams,
}

fn main() {
    let mut schema =
        serde_json::to_value(schemars::schema_for!(ProtocolSchemaRoot)).expect("schema 可导出");
    // Version metadata: written from the same source as the PROTOCOL_VERSION constant; the TS gate
    // checks all three agree (Rust constant / TS KODE_PROTOCOL_VERSION / schema header).
    schema["title"] = "KodeProtocol".into();
    schema["x-kode-protocol-version"] = PROTOCOL_VERSION.into();
    println!(
        "{}",
        serde_json::to_string_pretty(&schema).expect("pretty print")
    );
}
