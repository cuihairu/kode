import * as fs from 'fs';
import * as vscode from 'vscode';
import { getWorkspaceRootForDocument } from './definitionWorkspace';
import { readManagedDirSetting, resolveManagedDirName } from './pythonStubExport';
import { generatedInferencesEnabled } from './inferPipeline';
import { generatedStubPath, generatedStubSymbol } from './backend/inferredEnrichment';

/** Read the generated stub for this exact source path and revision on disk. */
export function readGeneratedStub(document: vscode.TextDocument): string | null {
  if (document.isDirty || !generatedInferencesEnabled()) {
    return null;
  }
  const source = document.fileName;
  const root = getWorkspaceRootForDocument(document);
  if (!root) {
    return null;
  }
  const managedDir = resolveManagedDirName(readManagedDirSetting()).name;
  const stub = generatedStubPath(root, managedDir, source);
  if (!stub) {
    return null;
  }
  try {
    if (fs.statSync(stub).mtimeMs < fs.statSync(source).mtimeMs) {
      return null;
    }
    return fs.readFileSync(stub, 'utf8');
  } catch {
    return null;
  }
}

export function createInferredMirrorHover(
  document: vscode.TextDocument,
  word: string,
  line?: number
): vscode.Hover | null {
  if (!/^[A-Za-z_]\w*$/.test(word)) {
    return null;
  }
  const stub = readGeneratedStub(document);
  const symbol = stub && generatedStubSymbol(document.getText(), stub, word, line);
  if (!symbol) {
    return null;
  }
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${word}**\n\n`);
  const inferredType = symbol.returnType ? `-> ${symbol.returnType}` : symbol.variableType;
  if (inferredType) {
    markdown.appendMarkdown(`**推断类型**: \`${inferredType}\`\n\n`);
  }
  if (symbol.params.length) {
    const parameters = symbol.params.map(param => `\`${param.name}: ${param.type}\``).join(', ');
    markdown.appendMarkdown(`**参数**: ${parameters}\n\n`);
  }
  markdown.appendMarkdown('_来自 Pyrefly 生成的类型桩_');
  return new vscode.Hover(markdown);
}
