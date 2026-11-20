/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 * 源:crates/kode-protocol/protocol.schema.json(kode-protocol wire DTO 单一真源)。
 * 协议版本:0.2.0
 * 再生:pnpm gen:protocol(schema 本身由 cargo run -q -p kode-protocol --bin dump-protocol-schema 再生)。
 * 门禁:tests/protocolSchema.test.ts 三锁对账,漂移即红。
 */

/**
 * 入站消息:请求(带 id)或通知(无 id)。untagged 按字段区分。
 */
export type IncomingMessage = Request | Notification;
/**
 * JSON-RPC 请求/响应 id。CORE-003:request_id 贯穿扩展↔Core↔后台任务, 数字与字符串两种形态都要保真(禁止归一化成一种)。
 */
export type RequestId = number | string;

/**
 * kode2 协议 wire DTO 全集(RUST-055 单一真源)。
 */
export interface KodeProtocol {
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
  file_changed_params: FileChangedParams;
  health_report: HealthReport;
  hover_params: HoverParams;
  incoming_message: IncomingMessage;
  initialize_params: InitializeParams;
  initialize_result: InitializeResult;
  notification: Notification;
  position: Position;
  range: Range;
  reference_context: ReferenceContext;
  references_params: ReferencesParams;
  rename_files_params: RenameFilesParams;
  renamed_file: RenamedFile;
  request: Request;
  request_id: RequestId;
  response: Response;
  response_error: ResponseError;
  server_capabilities: ServerCapabilities;
  server_info: ServerInfo;
  server_notification: ServerNotification;
  text_document_identifier: TextDocumentIdentifier;
  text_document_item: TextDocumentItem;
  text_document_sync_options: TextDocumentSyncOptions;
  versioned_text_document_identifier: VersionedTextDocumentIdentifier;
  workspace_folder: WorkspaceFolder;
}
/**
 * completion 能力声明(triggerCharacters 供客户端决定何时发请求)。
 */
export interface CompletionOptions {
  /**
   * RUST-135:completionItem/resolve 延迟补详情面(文档/来源按需补)。
   */
  resolveProvider: boolean;
  triggerCharacters: string[];
}
/**
 * completion 请求参数:文档身份 + UTF-16 位置(触发上下文由服务端从 光标前文本推导,与 TS 行前缀判面同口径)。
 */
export interface CompletionParams {
  position: Position;
  textDocument: TextDocumentIdentifier;
}
/**
 * LSP 位置(character 按 UTF-16 code unit 计数;语义见 kode-vfs VFS-004)。
 */
export interface Position {
  character: number;
  line: number;
}
export interface TextDocumentIdentifier {
  uri: string;
}
export interface ContentChangeEvent {
  /**
   * Full sync(change=1)下恒为 None;增量同步(change=2)带 range, 由 kode-vfs 做精确坐标转换(VFS-004)。
   */
  range?: Range | null;
  text: string;
}
/**
 * LSP 区间。
 */
export interface Range {
  end: Position;
  start: Position;
}
/**
 * Core 进程资源快照(RUST-026):RSS/线程数/磁盘 IO 累计量。
 */
export interface CoreResources {
  /**
   * 进程累计 CPU 时间 ms(utime+stime,CLK_TCK=100 Linux 标准假设); 调用方两次采样差分得速率
   */
  cpuTimeMs: number;
  diskReadBytes: number;
  diskWriteBytes: number;
  rssBytes: number;
  threads: number;
}
/**
 * definition 请求参数:文档身份 + UTF-16 位置(与 hover 同一定位基建)。
 */
export interface DefinitionParams {
  position: Position;
  textDocument: TextDocumentIdentifier;
}
/**
 * LSP `DeleteFilesParams`。
 */
export interface DeleteFilesParams {
  files: DeletedFile[];
}
/**
 * LSP `DeleteFilesParams` 条目(仅消费 files[].uri)。
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
 * definition 请求的文档身份(与 hover 同形,单独类型保 LSP 语义清晰)。
 */
export interface DocumentDiagnosticParams {
  textDocument: TextDocumentIdentifier;
}
/**
 * 打开文档摘要(只含 uri+version,不带正文)。
 */
export interface DocumentSummary {
  uri: string;
  version: number;
}
/**
 * `$/kode/fileChanged` 通知参数:纯数据、不绑 vscode——将来 watch 下沉 rust 时 TS 只是消费者,协议逐字不变。字段与 TS `NonPythonChangeEvent` 同构 (fsPath/identity/kind/version/fileName/ext/sha256/handledBy)。
 */
export interface FileChangedParams {
  /**
   * 小写含点扩展名(`.def`);无扩展名为空串
   */
  ext: string;
  fileName: string;
  /**
   * 原样路径
   */
  fsPath: string;
  /**
   * "python" | "rust" | "unrouted"(路由命中的处理方)
   */
  handledBy: string;
  /**
   * 归一身份键(斜杠/点段归一)
   */
  identity: string;
  /**
   * "create" | "change" | "delete"
   */
  kind: string;
  /**
   * 内容 sha256 hex;删除或读不到为 None(不编造)
   */
  sha256?: string | null;
  /**
   * 盘上版本 token `${mtimeMs}:${size}`;拿不到为 None(不编造)
   */
  version?: string | null;
}
/**
 * `$/kode/health` 响应:启动探针/健康状态/可观察恢复原因(CORE-016)。 `restart_generation` 由 TS 侧传入增长,崩溃重启后客户端可对账。
 */
export interface HealthReport {
  documents: DocumentSummary[];
  initialized: boolean;
  pid: number;
  /**
   * RUST-026 Core 进程资源观测;非 Linux 或 /proc 解析失败 = None 诚实降级
   */
  resources?: CoreResources | null;
  restartGeneration: number;
  serverVersion: string;
  shutdownRequested: boolean;
  status: string;
  uptimeMs: number;
}
/**
 * hover 请求参数:文档身份 + UTF-16 位置(语义同 Position)。
 */
export interface HoverParams {
  position: Position;
  textDocument: TextDocumentIdentifier;
}
/**
 * JSON-RPC 请求。
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
 * JSON-RPC 通知。
 */
export interface Notification {
  jsonrpc: string;
  method: string;
  params?: {
    [k: string]: unknown;
  };
}
/**
 * `initialize` 请求参数(只取本切片关心的字段,其余透传丢弃)。
 */
export interface InitializeParams {
  capabilities?: {
    [k: string]: unknown;
  };
  /**
   * kode2 扩展位:restartGeneration 等客户端状态经此传入(CORE-015 对账)。
   */
  initializationOptions?: {
    [k: string]: unknown;
  };
  processId?: number | null;
  rootUri?: string | null;
  /**
   * LSP 多工作区文件夹(VFS-009/KBUG-ROOT):逐个注册为资源根,跨根同名 实体隔离的归属依据;缺省只落 rootUri。
   */
  workspaceFolders?: WorkspaceFolder[] | null;
}
/**
 * LSP 工作区文件夹(initialize.workspaceFolders 条目;uri 必需)。
 */
export interface WorkspaceFolder {
  name?: string | null;
  uri: string;
}
/**
 * `initialize` 响应。
 */
export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo: ServerInfo;
}
/**
 * 服务器 capabilities(最小集:full 文本同步 + hover + completion)。
 */
export interface ServerCapabilities {
  /**
   * LSP-005 / PR-011:completion provider 能力声明(触发字符 `<`)。
   */
  completionProvider?: CompletionOptions | null;
  /**
   * Phase2 首片:textDocument/definition 能力声明(语料声明落点面)。
   */
  definitionProvider?: boolean;
  /**
   * LSP-003 / PH1-03(PR-010):hover provider 能力声明。
   */
  hoverProvider?: boolean;
  textDocumentSync: TextDocumentSyncOptions;
}
/**
 * 全量同步(openClose + change=1)。
 */
export interface TextDocumentSyncOptions {
  /**
   * 1 = Full:didChange 每次带全文(PH1 切片够用,增量同步在 VFS PR-004)。
   */
  change: number;
  openClose: boolean;
}
/**
 * serverInfo:TS 侧握手时校验名字/版本(BUILD-015 版本不匹配提示的输入)。
 */
export interface ServerInfo {
  name: string;
  version: string;
}
/**
 * references 请求的引用上下文:是否把声明本身计入结果(LSP includeDeclaration; 只对 def 面生效,types.xml 面无声明位)。
 */
export interface ReferenceContext {
  includeDeclaration: boolean;
}
/**
 * references 请求参数:文档身份 + UTF-16 位置 + 引用上下文。服务面 = 语义引用(Semantic;跨 root 同名异声明 Shadow 与不可解析 Dangling 不入列)。
 */
export interface ReferencesParams {
  context: ReferenceContext;
  position: Position;
  textDocument: TextDocumentIdentifier;
}
/**
 * LSP `RenameFilesParams`(仅消费 files[].oldUri/newUri)。
 */
export interface RenameFilesParams {
  files: RenamedFile[];
}
/**
 * LSP `WorkspaceFileRename`:一条重命名事件(old → new)。
 */
export interface RenamedFile {
  newUri: string;
  oldUri: string;
}
/**
 * JSON-RPC 响应。`id: None` 仅用于 id 不可知的解析错误(规范允许 null)。
 */
export interface Response {
  error?: ResponseError | null;
  id?: RequestId | null;
  jsonrpc: string;
  result?: unknown;
}
/**
 * JSON-RPC 错误对象。
 */
export interface ResponseError {
  code: number;
  data?: unknown;
  message: string;
}
/**
 * 出站通知(服务器 → 客户端)。
 */
export interface ServerNotification {
  jsonrpc: string;
  method: string;
  params?: unknown;
}
