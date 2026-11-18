// 进程归属 vscode 面(PROC-TAG-001 立项 2026-11-13;PROC-BREADCRUMB-001
// 改面 2026-11-18):判定链与互链推导在纯核 src/backend/processOwnershipLens,
// 本文件保留 openCell/openBase 切换命令(面包屑子节点 detail 的切换后端)
// 并承载 python 面包屑合成根 provider。文件顶部进程 CodeLens 渲染面已按
// 用户令移除(面包屑常驻可见,头部镜属重复展示;kbengine.codeLens.
// processOwnership 设置项连同声明一并删除,不留死开关)。
import * as vscode from 'vscode';
import * as fs from 'fs';
import { buildPythonProcessBreadcrumb } from '../backend/processOwnershipLens';

/**
 * python 面包屑合成根(第二刀):scripts/<role>/ 目录布局命中才返回节点
 * (判不出=null 零干扰 Pylance);节点 range=全文档,Outline 合并多
 * provider 结果时按 range 排序自然置首。与 Pylance 符号共存(VS Code 合并
 * 所有 DocumentSymbolProvider 输出)。当前进程(目录判定)带▸排首位,
 * children=互链对端段(Event,detail=对端路径+快捷键提示;无本文件锚点,
 * selectionRange 落文件头)。
 */
export class ProcessBreadcrumbPythonSymbolProvider implements vscode.DocumentSymbolProvider {
  private readonly fileExists: (path: string) => boolean;

  constructor(deps: { fileExists?: (path: string) => boolean } = {}) {
    this.fileExists = deps.fileExists ?? ((path: string) => fs.existsSync(path));
  }

  provideDocumentSymbols(
    document: vscode.TextDocument,
    _token?: vscode.CancellationToken
  ): vscode.DocumentSymbol[] | null {
    const spec = buildPythonProcessBreadcrumb(document.fileName, this.fileExists);
    if (!spec) {
      return null;
    }
    const fileHead = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    // 全文档 range 经 positionAt 换算(真 API 与测试替身同面;lineCount 替身缺)
    const fullDocument = new vscode.Range(
      new vscode.Position(0, 0),
      document.positionAt(document.getText().length)
    );
    const root = new vscode.DocumentSymbol(
      spec.name,
      `当前进程:${spec.processes[0]}(scripts/<role> 目录判定);其余=同名对端文件。
base↔cell 快捷键切换 ctrl+alt+shift+b/c(kbengine.processOwnership.openCell/openBase)。`,
      vscode.SymbolKind.Namespace,
      fullDocument,
      fileHead
    );
    root.children = spec.children.map(child => new vscode.DocumentSymbol(
      child.process,
      `对端同名文件:${child.siblingPath ?? ''};base↔cell 可用快捷键 ctrl+alt+shift+b/c 切换`,
      vscode.SymbolKind.Event,
      fullDocument,
      fileHead
    ));
    return [root];
  }
}

/** 快捷键切换命令(FILE-TIME-001 批,用户令 2026-11-17「最好能绑定快捷键,
 * 如果在 cell 可以可以快速切换到 base」):base↔cell 同名文件双向跳;
 * client/bots 无键,面包屑子节点 detail 携对端路径。目录判定与互链复用
 * 纯核 buildProcessOwnershipSpec(与判定链同一条,不造第二套);
 * 目标缺位如实提示不静默。 */
export const KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND = 'kbengine.processOwnership.openCell';
export const KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND = 'kbengine.processOwnership.openBase';

export function registerProcessOwnershipSwitchCommands(context: vscode.ExtensionContext): void {
  const openSibling =
    (process: 'cellapp' | 'baseapp') =>
    async (): Promise<void> => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const spec = buildPythonProcessBreadcrumb(editor.document.fileName, (candidate) =>
        fs.existsSync(candidate)
      );
      if (!spec) {
        void vscode.window.showInformationMessage(
          '当前文件判不出进程归属(需 scripts/<role> 目录),无法切换'
        );
        return;
      }
      const target = spec.children.find(child => child.process === process);
      if (!target || !target.siblingPath) {
        void vscode.window.showInformationMessage(`未找到同名 ${process} 对应文件`);
        return;
      }
      await vscode.window.showTextDocument(vscode.Uri.file(target.siblingPath), { preview: false });
    };
  context.subscriptions.push(
    vscode.commands.registerCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND, openSibling('cellapp')),
    vscode.commands.registerCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND, openSibling('baseapp'))
  );
}
