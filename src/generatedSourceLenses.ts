import * as vscode from 'vscode';
import { KBENGINE_SOURCE_REVEAL_COMMAND } from './sourceRevealCommand';
import {
  resolveEntityTypeStubSource,
  resolvePythonTypeStubSource
} from './generatedSourceMap';
import { getCustomTypeInfos } from './definitionWorkspace';
import type { EntityTypeStubEntry, EntityTypeStubLineMap } from './entityTypeStubs';
import type { PythonTypeStubEntry, PythonTypeStubLineMap } from './pythonTypeStubs';

export class GeneratedSourceCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(
    private readonly fileName: string,
    private readonly pythonEntries: readonly PythonTypeStubEntry[],
    private entityEntries: readonly EntityTypeStubEntry[],
    // KR-AUD-78:渲染期记录的真实行映射;缺映射(未渲染)时不出镜,
    // 禁止硬编码生成行号
    private readonly pythonLines: PythonTypeStubLineMap | null = null,
    private entityLines: EntityTypeStubLineMap | null = null
  ) {}

  /**
   * C-22 交付①补:def 再生后刷新实体面计划。激活期冻结的旧条目/行映射
   * 会指向重写后桩文件的旧行;更新后 fire 让已打开的 entity_types.pyi
   * 立即重询镜。python 面(types.xml 来源)暂无事件源,不动。
   */
  updateEntityPlan(
    entityEntries: readonly EntityTypeStubEntry[],
    entityLines: EntityTypeStubLineMap | null
  ): void {
    this.entityEntries = entityEntries;
    this.entityLines = entityLines;
    this._onDidChangeCodeLenses.fire();
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!document.fileName.endsWith(this.fileName)) {
      return [];
    }
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    if (!workspaceRoot) {
      return [];
    }
    const typesXmlPath = getCustomTypeInfos(workspaceRoot)[0]?.filePath;
    if (!typesXmlPath) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    for (let line = 0; line < document.lineCount; line += 1) {
      const source = resolvePythonTypeStubSource(this.pythonEntries, this.pythonLines, line)
        ?? resolveEntityTypeStubSource(this.entityEntries, this.entityLines, line);
      if (!source) {
        continue;
      }
      const label = `原始定义: ${source.origin} types.xml:${source.line}`;
      lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: label,
        command: KBENGINE_SOURCE_REVEAL_COMMAND,
        arguments: [
          vscode.Uri.file(typesXmlPath),
          { selection: new vscode.Range(source.line - 1, 0, source.line - 1, 0) }
        ]
      }));
    }
    return lenses;
  }
}
