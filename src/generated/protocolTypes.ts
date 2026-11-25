/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 * 源:crates/kode-protocol/protocol.schema.json(kode-protocol wire DTO 单一真源)。
 * 协议版本:0.2.0
 * 再生:pnpm gen:protocol(schema 本身由 cargo run -q -p kode-protocol --bin dump-protocol-schema 再生)。
 * 门禁:tests/protocolSchema.test.ts 三锁对账,漂移即红。
 */

/**
 * Inbound message: request (with id) or notification (no id). Untagged, distinguished by fields.
 */
export type IncomingMessage = Request | Notification;
/**
 * JSON-RPC request/response id. CORE-003: request_id threads through extension<->Core<->background tasks; both number and string forms must be preserved faithfully (normalizing to one form is forbidden).
 */
export type RequestId = number | string;

/**
 * The full set of kode2 protocol wire DTOs (RUST-055 single source of truth).
 */
export interface KodeProtocol {
  code_action_diagnostic: CodeActionDiagnostic;
  code_action_params: CodeActionParams;
  completion_options: CompletionOptions;
  completion_params: CompletionParams;
  content_change_event: ContentChangeEvent;
  core_resources: CoreResources;
  definition_params: DefinitionParams;
  delete_files_params: DeleteFilesParams;
  deleted_file: DeletedFile;
  did_change_params: DidChangeParams;
  did_close_params: DidCloseParams;
  did_close_text_document_identifier: DidCloseTextDocumentIdentifier;
  did_open_params: DidOpenParams;
  document_diagnostic_params: DocumentDiagnosticParams;
  document_summary: DocumentSummary;
  document_symbol_params: DocumentSymbolParams;
  file_changed_params: FileChangedParams;
  health_report: HealthReport;
  hover_params: HoverParams;
  incoming_message: IncomingMessage;
  initialize_params: InitializeParams;
  initialize_result: InitializeResult;
  notification: Notification;
  position: Position;
  prepare_rename_params: PrepareRenameParams;
  range: Range;
  reference_context: ReferenceContext;
  reference_params: ReferenceParams;
  rename_files_params: RenameFilesParams;
  rename_params: RenameParams;
  renamed_file: RenamedFile;
  request: Request;
  request_id: RequestId;
  response: Response;
  response_error: ResponseError;
  server_capabilities: ServerCapabilities;
  server_info: ServerInfo;
  server_notification: ServerNotification;
  signature_help_params: SignatureHelpParams;
  text_document_identifier: TextDocumentIdentifier;
  text_document_item: TextDocumentItem;
  text_document_sync_options: TextDocumentSyncOptions;
  versioned_text_document_identifier: VersionedTextDocumentIdentifier;
  workspace_folder: WorkspaceFolder;
  workspace_symbol_params: WorkspaceSymbolParams;
}
/**
 * codeAction diagnostic input face (RUST-143 batch 3): the TS side collapses vscode.Diagnostic into pure data (code/range/related location face); the assembly decision core filters by the code gate and range intersection.
 */
export interface CodeActionDiagnostic {
  code: string;
  range: Range;
  /**
   * relatedInformation[0].location.uri.fsPath (parity-family location face; omitted when absent).
   */
  relatedFile?: string | null;
  /**
   * relatedInformation[0].message (target class name; the server falls back to the def file name when it is empty).
   */
  relatedMessage?: string | null;
}
/**
 * LSP range.
 */
export interface Range {
  end: Position;
  start: Position;
}
/**
 * LSP position (character counted in UTF-16 code units; semantics per kode-vfs VFS-004).
 */
export interface Position {
  character: number;
  line: number;
}
/**
 * codeAction request params (RUST-143 batch 3): assembly-family dispatch + family inputs (registered = the near-miss universe from TS getKnownTypeContext assembly; snapshotText = the parity-family target python snapshot, TS readSharedFileSnapshot preferring the open buffer) + the diagnostic face array. The four families (typeReplacement/parityMethod/receiverNone/fixedDict) are assembled independently, producing an ActionFace descriptor array (vscode object construction and l10n titles stay with the TS thin shell).
 */
export interface CodeActionParams {
  diagnostics?: CodeActionDiagnostic[];
  family: string;
  range: Range;
  registered?: string[];
  snapshotText?: string | null;
  textDocument: TextDocumentIdentifier;
}
export interface TextDocumentIdentifier {
  uri: string;
}
/**
 * completion capability declaration (triggerCharacters lets the client decide when to request).
 */
export interface CompletionOptions {
  /**
   * RUST-135: completionItem/resolve lazy detail face (docs/source filled in on demand).
   */
  resolveProvider: boolean;
  triggerCharacters: string[];
}
/**
 * completion request params: document identity + UTF-16 position (the trigger context is derived server-side from the text before the cursor, same contract as the TS line-prefix face).
 */
export interface CompletionParams {
  position: Position;
  textDocument: TextDocumentIdentifier;
}
export interface ContentChangeEvent {
  /**
   * Always None under full sync (change=1); incremental sync (change=2) carries a range, with exact coordinate conversion done by kode-vfs (VFS-004).
   */
  range?: Range | null;
  text: string;
}
/**
 * Core process resource snapshot (RUST-026): RSS / thread count / cumulative disk IO.
 */
export interface CoreResources {
  /**
   * Cumulative process CPU time in ms (utime+stime, assuming the Linux-standard CLK_TCK=100); the caller diffs two samples to get a rate
   */
  cpuTimeMs: number;
  diskReadBytes: number;
  diskWriteBytes: number;
  rssBytes: number;
  threads: number;
}
/**
 * definition request params: document identity + UTF-16 position (same locating foundation as hover).
 */
export interface DefinitionParams {
  position: Position;
  textDocument: TextDocumentIdentifier;
}
/**
 * LSP `DeleteFilesParams`.
 */
export interface DeleteFilesParams {
  files: DeletedFile[];
}
/**
 * LSP `DeleteFilesParams` entry (only files[].uri is consumed).
 */
export interface DeletedFile {
  uri: string;
}
export interface DidChangeParams {
  contentChanges: ContentChangeEvent[];
  textDocument: VersionedTextDocumentIdentifier;
}
export interface VersionedTextDocumentIdentifier {
  uri: string;
  version: number;
}
export interface DidCloseParams {
  textDocument: DidCloseTextDocumentIdentifier;
}
export interface DidCloseTextDocumentIdentifier {
  uri: string;
}
export interface DidOpenParams {
  textDocument: TextDocumentItem;
}
export interface TextDocumentItem {
  languageId: string;
  text: string;
  uri: string;
  version: number;
}
/**
 * Document identity for the definition request (same shape as hover; a separate type keeps LSP semantics clear).
 */
export interface DocumentDiagnosticParams {
  textDocument: TextDocumentIdentifier;
}
/**
 * Open-document summary (uri + version only, no text body).
 */
export interface DocumentSummary {
  uri: string;
  version: number;
}
/**
 * documentSymbol request params: document identity only (the Outline face is recomputed server-side from the synced document text; no position/context input; a separate type keeps LSP semantics clear).
 */
export interface DocumentSymbolParams {
  textDocument: TextDocumentIdentifier;
}
/**
 * `$/kode/fileChanged` notification params: pure data, no vscode binding -- when watch is sunk into rust later, TS is just a consumer and the protocol stays character for character. Fields are isomorphic to TS `NonPythonChangeEvent` (fsPath/identity/kind/version/fileName/ext/sha256/handledBy).
 */
export interface FileChangedParams {
  /**
   * Lowercase extension with the leading dot (`.def`); empty string when there is no extension
   */
  ext: string;
  fileName: string;
  /**
   * Path as-is
   */
  fsPath: string;
  /**
   * "python" | "rust" | "unrouted" (the handler the route resolved to)
   */
  handledBy: string;
  /**
   * Normalized identity key (slash / dot-segment normalization)
   */
  identity: string;
  /**
   * "create" | "change" | "delete"
   */
  kind: string;
  /**
   * Content sha256 hex; None on deletion or when unreadable (never fabricated)
   */
  sha256?: string | null;
  /**
   * On-disk version token `${mtimeMs}:${size}`; None when unavailable (never fabricated)
   */
  version?: string | null;
}
/**
 * `$/kode/health` response: startup probe / health status / observable recovery reason (CORE-016). `restart_generation` grows on the TS side so the client can reconcile after a crash restart.
 */
export interface HealthReport {
  documents: DocumentSummary[];
  initialized: boolean;
  pid: number;
  /**
   * RUST-026 Core process resource observation; non-Linux or /proc parse failure = None (honest degradation)
   */
  resources?: CoreResources | null;
  restartGeneration: number;
  serverVersion: string;
  shutdownRequested: boolean;
  status: string;
  uptimeMs: number;
}
/**
 * hover request params: document identity + UTF-16 position (same semantics as Position).
 */
export interface HoverParams {
  position: Position;
  textDocument: TextDocumentIdentifier;
}
/**
 * JSON-RPC request.
 */
export interface Request {
  id: RequestId;
  jsonrpc: string;
  method: string;
  params?: {
    [k: string]: unknown;
  };
}
/**
 * JSON-RPC notification.
 */
export interface Notification {
  jsonrpc: string;
  method: string;
  params?: {
    [k: string]: unknown;
  };
}
/**
 * `initialize` request params (only the fields this slice cares about; the rest pass through and are dropped).
 */
export interface InitializeParams {
  capabilities?: {
    [k: string]: unknown;
  };
  /**
   * kode2 extension slot: client state such as restartGeneration is passed in here (CORE-015 parity comparison).
   */
  initializationOptions?: {
    [k: string]: unknown;
  };
  processId?: number | null;
  rootUri?: string | null;
  /**
   * LSP multi-workspace folders (VFS-009/KBUG-ROOT): registered one by one as resource roots, the basis for attributing same-named entities across roots; defaults to only rootUri.
   */
  workspaceFolders?: WorkspaceFolder[] | null;
}
/**
 * LSP workspace folder (an initialize.workspaceFolders entry; uri is required).
 */
export interface WorkspaceFolder {
  name?: string | null;
  uri: string;
}
/**
 * `initialize` response.
 */
export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo: ServerInfo;
}
/**
 * Server capabilities (minimal set: full text sync + hover + completion).
 */
export interface ServerCapabilities {
  /**
   * RUST-143 batch 3: textDocument/codeAction capability declaration (four-family assembly face).
   */
  codeActionProvider?: boolean;
  /**
   * LSP-005 / PR-011: completion provider capability declaration (trigger character `<`).
   */
  completionProvider?: CompletionOptions | null;
  /**
   * Phase2 first slice: textDocument/definition capability declaration (declaration landing site).
   */
  definitionProvider?: boolean;
  /**
   * RUST-139 batch 3: textDocument/documentSymbol capability declaration (def segment-symbol face).
   */
  documentSymbolProvider?: boolean;
  /**
   * LSP-003 / PH1-03 (PR-010): hover provider capability declaration.
   */
  hoverProvider?: boolean;
  /**
   * RUST-138 batch 3: textDocument/references capability declaration (declaration + reference-site face).
   */
  referencesProvider?: boolean;
  /**
   * RUST-141 batch 2: textDocument/rename+prepareRename capability declaration (def rename face).
   */
  renameProvider?: boolean;
  /**
   * RUST-140 batch 3: textDocument/signatureHelp capability declaration (def method signature face).
   */
  signatureHelpProvider?: boolean;
  textDocumentSync: TextDocumentSyncOptions;
  /**
   * RUST-139 batch 4: workspace/symbol capability declaration (def symbol prefix-search face).
   */
  workspaceSymbolProvider?: boolean;
}
/**
 * Full sync (openClose + change=1).
 */
export interface TextDocumentSyncOptions {
  /**
   * 1 = Full: didChange always carries the full text (enough for the PH1 slice; incremental sync is VFS PR-004).
   */
  change: number;
  openClose: boolean;
}
/**
 * serverInfo: the TS side validates name/version at handshake (input for the BUILD-015 version-mismatch notice).
 */
export interface ServerInfo {
  name: string;
  version: string;
}
/**
 * prepareRename request params (RUST-141 batch 2): document identity + UTF-16 position -- renamable-symbol resolution and the candidate-name range are recomputed server-side from the synced document.
 */
export interface PrepareRenameParams {
  position: Position;
  textDocument: TextDocumentIdentifier;
}
/**
 * Reference context: `includeDeclaration` decides whether the exact declaration (that symbol's name span inside the def) counts toward the result. The types.xml face has no declaration site at all, so this flag has no effect on that face.
 */
export interface ReferenceContext {
  includeDeclaration?: boolean;
}
/**
 * references request params: document identity + UTF-16 position + reference context (RUST-138 batch 3). `context`/`includeDeclaration` may both be omitted (omitted = no exact declaration, matching LSP ReferenceContext semantics; the client may send just the document and position).
 */
export interface ReferenceParams {
  context?: ReferenceContext;
  position: Position;
  textDocument: TextDocumentIdentifier;
}
/**
 * LSP `RenameFilesParams` (only files[].oldUri/newUri is consumed).
 */
export interface RenameFilesParams {
  files: RenamedFile[];
}
/**
 * LSP `WorkspaceFileRename`: one rename event (old -> new).
 */
export interface RenamedFile {
  newUri: string;
  oldUri: string;
}
/**
 * rename request params (RUST-141 batch 2): document identity + UTF-16 position + target name. The def-face edit and closure-conflict pre-check are recomputed server-side (the python self-access rewrite face is not part of this face).
 */
export interface RenameParams {
  newName: string;
  position: Position;
  textDocument: TextDocumentIdentifier;
}
/**
 * JSON-RPC response. `id: None` is only for parse errors where the id is unknowable (the spec allows null).
 */
export interface Response {
  error?: ResponseError | null;
  id?: RequestId | null;
  jsonrpc: string;
  result?: unknown;
}
/**
 * JSON-RPC error object.
 */
export interface ResponseError {
  code: number;
  data?: unknown;
  message: string;
}
/**
 * Outbound notification (server -> client).
 */
export interface ServerNotification {
  jsonrpc: string;
  method: string;
  params?: unknown;
}
/**
 * signatureHelp request params (RUST-140 batch 3): python document + cursor. Starting from the inline text, the server runs call-site lexing (python_call_at, isomorphic to TS getPythonCallAtPosition) -> the inheritance-chain closure signature decision (signature_help) in this domain, with zero TS decision input throughout; the runtime entity registry chain (EntityMappingManager) does not cross this face -- signatures come from the corpus def view.
 */
export interface SignatureHelpParams {
  position: Position;
  textDocument: TextDocumentIdentifier;
}
/**
 * `workspace/symbol` params (RUST-139 batch 4): the prefix query string for Ctrl+T quick search. The LSP optional `limit` param does not enter the Rust face -- the decision core produces the full result set, which the TS thin shell then truncates (that is vscode request-side behaviour; the server does not guess the paging contract).
 */
export interface WorkspaceSymbolParams {
  query: string;
}
