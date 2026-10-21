import * as vscode from 'vscode';
import {
  resolveEntityTypeStubSource,
  resolvePythonTypeStubSource
} from './generatedSourceMap';
import { getCustomTypeInfos } from './definitionWorkspace';
import type { EntityTypeStubEntry } from './entityTypeStubs';
import type { PythonTypeStubEntry } from './pythonTypeStubs';

export class GeneratedSourceCodeLensProvider implements vscode.CodeLensProvider {
  constructor(
    private readonly fileName: string,
    private readonly pythonEntries: readonly PythonTypeStubEntry[],
    private readonly entityEntries: readonly EntityTypeStubEntry[]
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
      const source = resolvePythonTypeStubSource(this.pythonEntries, line)
        ?? resolveEntityTypeStubSource(this.entityEntries, line);
      if (!source) {
        continue;
      }
      const label = `原始定义: ${source.origin} types.xml:${source.line}`;
      lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: label,
        command: 'vscode.open',
        arguments: [
          vscode.Uri.file(typesXmlPath),
          { selection: new vscode.Range(source.line - 1, 0, source.line - 1, 0) }
        ]
      }));
    }
    return lenses;
  }
}
