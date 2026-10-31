/**
 * schema 虚拟文档发布面(IDE-ARC-004 抽离):kbengine-db-schema 虚拟文档
 * provider 与 uri 装配。只做装配展示——快照/渲染/定位全部委托
 * databaseSchema(适配面),本模块不含任何表/列推导。
 */
import * as vscode from 'vscode';
import {
  getDatabaseSchemaSnapshot,
  locateDatabaseSchemaLineInLines,
  renderDatabaseSchema,
  type DatabaseSchemaSnapshot
} from './databaseSchema';

export const KBENGINE_DATABASE_SCHEMA_SCHEME = 'kbengine-db-schema';

export class KBEngineDatabaseSchemaProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  // IDE-SCH-010:每个 uri 记「屏上这一代」渲染(快照+行),反向跳转定位
  // 只对已发布代取行号——展示与跳转同源,中途 def/配置变更不撕裂
  private readonly publishedRenders = new Map<string, { snapshot: DatabaseSchemaSnapshot | null; lines: string[] }>();
  // AUD-056:关闭 schema 文档即释放该 URI 的已发布代(第二层强引用缓存
  // 不再无界持有);仍打开文档不受影响,保持同代定位
  private readonly closeSubscription: { dispose(): void };

  constructor() {
    this.closeSubscription = vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme === KBENGINE_DATABASE_SCHEMA_SCHEME) {
        this.closeDocument(document.uri);
      }
    });
  }

  /** AUD-056:关闭文档即删除该 URI 的已发布渲染(行数组+快照) */
  closeDocument(uri: vscode.Uri): void {
    this.publishedRenders.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const entityName = decodeURIComponent(uri.path.replace(/^\/+/, '').replace(/\.schema$/, ''));
    // AUD-055:根身份从 URI query 取回——A/B 同名实体两份 URI 各带各根,
    // 快照必须按该根解析,不能串根
    const snapshot = getDatabaseSchemaSnapshot(entityName, parseDatabaseSchemaRoot(uri) ?? undefined);
    const lines = renderDatabaseSchema(snapshot).split('\n');
    this.publishedRenders.set(uri.toString(), { snapshot, lines });
    return lines.join('\n');
  }

  /** IDE-SCH-010:对已发布的渲染定位表/字段行;未发布过(尚未展示)返回 null,
   * 调用侧退回独立快照口径(locateDatabaseSchemaLine) */
  locateInPublishedContent(uri: vscode.Uri, tableName: string, fieldName?: string): number | null {
    const published = this.publishedRenders.get(uri.toString());
    if (!published) {
      return null;
    }
    return locateDatabaseSchemaLineInLines(published.lines, tableName, fieldName);
  }

  /** IDE-SCH-010:已发布代的快照(表名缺省解析用),与屏上文本同代 */
  getPublishedSnapshot(uri: vscode.Uri): DatabaseSchemaSnapshot | null | undefined {
    return this.publishedRenders.get(uri.toString())?.snapshot;
  }

  refresh(entityName?: string, workspaceRoot?: string | null): void {
    if (entityName) {
      // AUD-055:带根刷新——只动该根下的同名实体文档,不误刷另一根的同类文档
      this.onDidChangeEmitter.fire(createDatabaseSchemaUri(entityName, workspaceRoot));
      return;
    }
    // IDE-SCH-005:无参 = 全部打开中的 .schema 文档重取(表前缀/连接配置切换
    // 即刻换新表名,不等文件保存;快照面由 tablePrefix/generation 轴判过期)
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === KBENGINE_DATABASE_SCHEMA_SCHEME) {
        this.onDidChangeEmitter.fire(document.uri);
      }
    }
  }

  dispose(): void {
    this.closeSubscription.dispose();
    this.onDidChangeEmitter.dispose();
  }
}

/** AUD-055:从 schema URI 取回根身份(query root 参数);无根返回 null */
export function parseDatabaseSchemaRoot(uri: vscode.Uri): string | null {
  // URLSearchParams.get 已解一次 percent 编码(建 uri 时 encodeURIComponent),
  // 不再二次解码以免含 % 的路径被吃
  return new URLSearchParams(uri.query).get('root');
}

export function createDatabaseSchemaUri(entityName: string, workspaceRoot?: string | null): vscode.Uri {
  const base = `${KBENGINE_DATABASE_SCHEMA_SCHEME}:/${encodeURIComponent(entityName)}.schema`;
  // AUD-055:根身份编进 query——A/B 同名实体两份不同 URI,文档身份按全
  // URI(含 query)区分;无根(旧路径/测试)保持无 query 原形态
  return workspaceRoot ? vscode.Uri.parse(`${base}?root=${encodeURIComponent(workspaceRoot)}`) : vscode.Uri.parse(base);
}

export function isDatabaseSchemaDocument(document: Pick<vscode.TextDocument, 'uri'>): boolean {
  return document.uri.scheme === KBENGINE_DATABASE_SCHEMA_SCHEME;
}
