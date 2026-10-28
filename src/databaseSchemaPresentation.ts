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

  provideTextDocumentContent(uri: vscode.Uri): string {
    const entityName = decodeURIComponent(uri.path.replace(/^\/+/, '').replace(/\.schema$/, ''));
    const snapshot = getDatabaseSchemaSnapshot(entityName);
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

  refresh(entityName?: string): void {
    if (entityName) {
      this.onDidChangeEmitter.fire(createDatabaseSchemaUri(entityName));
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
    this.onDidChangeEmitter.dispose();
  }
}

export function createDatabaseSchemaUri(entityName: string): vscode.Uri {
  return vscode.Uri.parse(`${KBENGINE_DATABASE_SCHEMA_SCHEME}:/${encodeURIComponent(entityName)}.schema`);
}

export function isDatabaseSchemaDocument(document: Pick<vscode.TextDocument, 'uri'>): boolean {
  return document.uri.scheme === KBENGINE_DATABASE_SCHEMA_SCHEME;
}
