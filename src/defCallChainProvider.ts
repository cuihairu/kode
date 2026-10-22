import * as path from 'path';
import * as vscode from 'vscode';
import type { EntityMappingManager } from './entityMapping';
import {
  buildDefCallChain,
  findDefMethodByStart,
  renderDefCallChainMermaid
} from './defCallChain';
import type { DefCallChain } from './defCallChain';
import { findPythonMethodDeclarations } from './rpcCodeLens';

export interface CallChainPickItem extends vscode.QuickPickItem {
  line: number;
  methodName: string;
}

export class CallChainController {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  constructor(private readonly entityMappingManager: EntityMappingManager) {}

  fireConfigurationChanged(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('kbengine.python')
      .get<boolean>('callChainHints', true);
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!this.enabled() || document.languageId !== 'python') {
      return [];
    }

    const declarations = findPythonMethodDeclarations(document.getText());
    const lenses: vscode.CodeLens[] = [];
    for (const declaration of declarations) {
      const definition = await this.entityMappingManager.resolveMethodDefinition(
        document.fileName,
        declaration.methodName
      );
      if (!definition) {
        continue;
      }
      lenses.push(new vscode.CodeLens(
        new vscode.Range(declaration.line, declaration.character, declaration.line, declaration.character),
        {
          title: 'Call Chain',
          command: 'kbengine.python.showCallChain',
          arguments: [document.uri, declaration.line + 1, declaration.methodName]
        }
      ));
    }
    return lenses;
  }

  async showForActiveEditor(
    uri?: vscode.Uri,
    line?: number,
    methodName?: string
  ): Promise<void> {
    if (!this.enabled()) {
      vscode.window.showInformationMessage('Def call chain hints are disabled');
      return;
    }

    let selected: CallChainPickItem | undefined;
    const editor = vscode.window.activeTextEditor;
    if ((!uri || !methodName || !line) && editor?.document.languageId === 'python') {
      selected = await this.pickMethod(editor.document);
      uri = editor.document.uri;
      line = selected?.line;
      methodName = selected?.methodName;
    }
    if (!uri || !methodName || !line) {
      vscode.window.showInformationMessage('Open a Python entity script to show a call chain');
      return;
    }

    let index = this.entityMappingManager.getIndexForPythonFile(uri!.fsPath);
    if (!index) {
      await this.entityMappingManager.waitForInitialScan();
      index = this.entityMappingManager.getIndexForPythonFile(uri!.fsPath);
    }
    if (!index) {
      vscode.window.showInformationMessage(`No entity mapping found for ${path.basename(uri.fsPath)}`);
      return;
    }

    const startDefinition = findDefMethodByStart(index, { filePath: uri.fsPath, line, methodName });
    if (!startDefinition) {
      vscode.window.showInformationMessage(`${methodName} is not an indexed entity def method`);
      return;
    }

    const chain = buildDefCallChain(index, { filePath: uri.fsPath, line, methodName });
    if (!chain) {
      vscode.window.showInformationMessage(`${methodName} is not an indexed entity def method`);
      return;
    }
    this.showPreview(chain);
  }

  private async pickMethod(
    document: vscode.TextDocument
  ): Promise<CallChainPickItem | undefined> {
    const declarations = findPythonMethodDeclarations(document.getText());
    if (declarations.length === 0) {
      return undefined;
    }
    const checked = await Promise.all(declarations.map(async declaration => ({
      declaration,
      definition: await this.entityMappingManager.resolveMethodDefinition(
        document.fileName,
        declaration.methodName
      )
    })));
    const items = checked
      .filter(item => item.definition)
      .map(item => ({
        label: item.declaration.methodName,
        description: item.definition?.section,
        line: item.declaration.line + 1,
        methodName: item.declaration.methodName
      }));
    if (items.length === 0) {
      return undefined;
    }
    if (items.length === 1) {
      return items[0];
    }
    return await vscode.window.showQuickPick(items, {
      placeHolder: 'Select an entity method'
    }) as CallChainPickItem | undefined;
  }

  private showPreview(chain: DefCallChain): void {
    const panel = vscode.window.createWebviewPanel(
      'kbengine.defCallChain',
      'KBEngine Def Call Chain',
      vscode.ViewColumn.Beside,
      { enableScripts: false }
    );
    const mermaid = renderDefCallChainMermaid(chain);
    panel.webview.html = this.html(chain, mermaid);
  }

  private html(chain: DefCallChain, mermaid: string): string {
    const fallback = [
      chain.root.signature,
      ...chain.edges.map(edge => {
        const target = chain.nodes.find(node => node.id === edge.to);
        return `${edge.from} --${edge.receiver}--> ${target?.signature ?? edge.to}`;
      })
    ].join('\n');
    return `<!DOCTYPE html><html><body><pre data-mermaid="${encodeURIComponent(mermaid)}">${fallback
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></body></html>`;
  }
}
