// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as path from 'path';
import * as vscode from 'vscode';
import { getLineNumberAt } from '../defParser';
import { EntityMappingManager, EntityMethodSection } from '../entityMapping';
import { METHOD_DECLARATION_PATTERN } from '../rpcCodeLens';
import { METHOD_SECTIONS, parseDefAst } from './shared';
import { findDefSymbolInfo, resolveDefMethodPythonTarget } from './navigation';
export class KBEngineCallHierarchyProvider implements vscode.CallHierarchyProvider {
  constructor(private entityMappingManager: EntityMappingManager) {}

  async prepareCallHierarchy(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CallHierarchyItem | vscode.CallHierarchyItem[] | null> {
    if (document.languageId === 'python') {
      const pythonMethod = await this.entityMappingManager.resolvePythonMethodAtPosition(
        document.fileName,
        position.line + 1,
        position.character
      );
      return pythonMethod ? createPythonCallHierarchyItem(pythonMethod) : null;
    }

    if (document.languageId === 'kbengine-def' || document.fileName.toLowerCase().endsWith('.def')) {
      const range = document.getWordRangeAtPosition(position, /\w+/);
      if (!range) {
        return null;
      }

      const word = document.getText(range);
      const symbolInfo = findDefSymbolInfo(document, position, word);
      if (!symbolInfo || !METHOD_SECTIONS.has(symbolInfo.section)) {
        return null;
      }

      // 不可达(批62 定性):symbolInfo 非空说明上一次 parseDefAst 已取到 AST
      // (getDefNodeAtWord→getDefNodeAtPosition 在 ast 为空时必然返回 null),
      // 且本分支的 languageId/文件名条件已满足 parseDefAst 的白名单;同一 document
      // 的同步重复解析不可能改判为空。
      const ast = parseDefAst(document);
      /* istanbul ignore start */
      if (!ast) {
        return null;
      }
      /* istanbul ignore stop */

      const identity = await this.entityMappingManager.resolveDefinitionSymbolAtPosition(
        document.fileName,
        getLineNumberAt(ast, symbolInfo.symbolNode.tagStart),
        symbolInfo.symbolNode.name,
        symbolInfo.section as EntityMethodSection
      );

      // IDE-NAV-015:与 F12 同链(resolveDefMethodPythonTarget:identity
      // 绑定/属主+全局唯一 → 约定链),相同 RPC/mixin 方法两入口同目标;
      // 空臂如实 null(F12 的提示+注册回落不是 python 目标,层次不借)。
      const target = await resolveDefMethodPythonTarget(
        document,
        symbolInfo.symbolNode.name,
        symbolInfo.section as EntityMethodSection,
        this.entityMappingManager,
        identity
      );
      if (!target) {
        return null;
      }

      return createPythonCallHierarchyItem({
        filePath: target.filePath,
        methodName: symbolInfo.symbolNode.name,
        line: target.line,
        character: target.character
      });
    }

    return null;
  }

  async provideCallHierarchyIncomingCalls(
    item: vscode.CallHierarchyItem, token?: vscode.CancellationToken
  ): Promise<vscode.CallHierarchyIncomingCall[]> {
    if (token?.isCancellationRequested) return [];
    const calls = await this.entityMappingManager.getIncomingPythonMethodCalls(item.uri.fsPath, item.name, token);
    if (token?.isCancellationRequested) return [];
    return calls.map(call => new vscode.CallHierarchyIncomingCall(
      createPythonCallHierarchyItem(call.caller),
      [createSelectionRange(call.callLine, call.callCharacter, item.name)]
    ));
  }

  async provideCallHierarchyOutgoingCalls(
    item: vscode.CallHierarchyItem, token?: vscode.CancellationToken
  ): Promise<vscode.CallHierarchyOutgoingCall[]> {
    if (token?.isCancellationRequested) return [];
    const calls = await this.entityMappingManager.getOutgoingPythonMethodCalls(item.uri.fsPath, item.name, token);
    if (token?.isCancellationRequested) return [];
    return calls.map(call => new vscode.CallHierarchyOutgoingCall(
      createPythonCallHierarchyItem(call),
      [createSelectionRange(call.line, call.character, call.methodName)]
    ));
  }
}

export function getPythonMethodDeclarationAtPosition(lineText: string, character: number): string | null {
  const match = METHOD_DECLARATION_PATTERN.exec(lineText);
  if (!match) {
    return null;
  }

  const methodName = match[1];
  const nameStart = lineText.indexOf(methodName);
  const nameEnd = nameStart + methodName.length;
  if (character < nameStart || character > nameEnd) {
    return null;
  }

  return methodName;
}

export function createPythonCallHierarchyItem(
  method: { filePath: string; methodName: string; line: number; character: number }
): vscode.CallHierarchyItem {
  const selectionRange = createSelectionRange(method.line, method.character, method.methodName);
  return new vscode.CallHierarchyItem(
    vscode.SymbolKind.Method,
    method.methodName,
    path.basename(method.filePath),
    vscode.Uri.file(method.filePath),
    selectionRange,
    selectionRange
  );
}

export function createSelectionRange(line: number, character: number, text: string): vscode.Range {
  return new vscode.Range(
    new vscode.Position(Math.max(line - 1, 0), Math.max(character, 0)),
    new vscode.Position(Math.max(line - 1, 0), Math.max(character, 0) + text.length)
  );
}
