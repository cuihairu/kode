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
  constructor(
    private readonly fileName: string,
    private readonly pythonEntries: readonly PythonTypeStubEntry[],
    private readonly entityEntries: readonly EntityTypeStubEntry[],
    // KR-AUD-78:渲染期记录的真实行映射;缺映射(未渲染)时不出镜,
    // 禁止硬编码生成行号
    private readonly pythonLines: PythonTypeStubLineMap | null = null,
    private readonly entityLines: EntityTypeStubLineMap | null = null
  ) {}

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
