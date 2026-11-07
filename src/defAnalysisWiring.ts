// KODE-ARCH-002:extension.ts 装配模块——.def 静态分析(性能分析建议)。
// 纯移动:命令体/输出通道/诊断集合逐行迁出 activate,装配顺序由调用方保持。
import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeDefDocumentWithRust, collectInheritedNames, formatDefAnalysisReport } from './defAnalyzer';
import { findFilesAcrossRoots } from './scanRoots';
import { getCustomTypeInfos, getRegisteredEntities } from './definitionWorkspace';

export interface DefAnalysisWiring {
  command: vscode.Disposable;
  outputChannel: vscode.OutputChannel;
  diagnostics: vscode.DiagnosticCollection;
}

export function wireDefAnalysis(): DefAnalysisWiring {
  // .def 静态分析建议(性能分析):扫描工作区全部 .def,报告写入输出面板
  // 并以诊断形式落到问题列表
  const defAnalysisOutputChannel = vscode.window.createOutputChannel('KBEngine Def 分析');
  const defAnalysisDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-def-analysis'
  );
  const analyzeDefCommand = vscode.commands.registerCommand(
    'kbengine.def.analyze',
    async () => {
      const defUris = await findFilesAcrossRoots('**/*.def');
      if (defUris.length === 0) {
        vscode.window.showInformationMessage('未找到 .def 文件,无法分析');
        return;
      }

      defAnalysisOutputChannel.clear();
      defAnalysisDiagnostics.clear();
      // 每个 .def 只打开一次:文本缓存供单文件检查与继承链闭包(collectInheritedNames)共用
      const sortedUris = defUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
      const openedDocuments = new Map<string, vscode.TextDocument>();
      const defTexts = new Map<string, string>();
      for (const uri of sortedUris) {
        const document = await vscode.workspace.openTextDocument(uri);
        openedDocuments.set(uri.fsPath, document);
        defTexts.set(path.resolve(uri.fsPath), document.getText());
      }
      const readDefText = (filePath: string): string | null =>
        defTexts.get(path.resolve(filePath)) ?? null;

      // Rust lint 注册表 unknown-type-reference 的类型语料:跨工作区根并集
      // (types.xml 自定义类型 + 已注册实体名;内建类型由 Rust 侧自带)。
      // 计算失败退化为空语料(只查内建),不阻塞分析命令。
      const knownTypes = collectKnownTypesForAnalysis();
      let totalFindings = 0;
      for (const uri of sortedUris) {
        const document = openedDocuments.get(uri.fsPath) as vscode.TextDocument;
        const findings = await analyzeDefDocumentWithRust(
          document.getText(),
          collectInheritedNames(uri.fsPath, readDefText),
          { knownTypes }
        );
        totalFindings += findings.length;
        defAnalysisOutputChannel.appendLine(
          formatDefAnalysisReport(uri.fsPath, findings)
        );
        defAnalysisDiagnostics.set(
          uri,
          findings.map(item => {
            const start = document.positionAt(item.offset);
            const end = document.positionAt(item.offset + item.length);
            return new vscode.Diagnostic(
              new vscode.Range(start, end),
              item.message,
              item.severity === 'error'
                ? vscode.DiagnosticSeverity.Error
                : item.severity === 'warning'
                  ? vscode.DiagnosticSeverity.Warning
                  : vscode.DiagnosticSeverity.Information
            );
          })
        );
      }

      defAnalysisOutputChannel.show();
      vscode.window.showInformationMessage(
        `Def 分析完成: ${defUris.length} 个文件, ${totalFindings} 条建议`
      );
    }
  );
  // 分析命令的类型语料:types.xml 自定义类型 + 已注册实体名(unknown-type-
  // reference 规则用;Rust 侧以 builtin ∪ 语料判已知)。空根/读取失败退化为
  // 空集(只查内建),不虚构语料也不抛错。
  function collectKnownTypesForAnalysis(): string[] {
    try {
      const names = new Set<string>();
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        for (const info of getCustomTypeInfos(folder.uri.fsPath)) {
          names.add(info.name);
        }
        for (const entry of getRegisteredEntities(folder.uri.fsPath)) {
          names.add(entry.name);
        }
      }
      return [...names];
    } catch {
      return [];
    }
  }
  return { command: analyzeDefCommand, outputChannel: defAnalysisOutputChannel, diagnostics: defAnalysisDiagnostics };
}
