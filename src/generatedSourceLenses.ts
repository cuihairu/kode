import * as vscode from 'vscode';
import { KBENGINE_SOURCE_REVEAL_COMMAND } from './sourceRevealCommand';
import {
  resolveEntityTypeStubSource,
  resolvePythonTypeStubSource
} from './backend/generatedSourceMap';
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
    private entityLines: EntityTypeStubLineMap | null = null,
    // RUST-160:实体名 → .def 文件路径;def 来源镜按它解析跳转目标,
    // 缺映射不出镜(绝不把 .def 行号跳到 types.xml——旧行为的真缺陷)。
    private readonly entityDefFiles: ReadonlyMap<string, string> = new Map()
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

  provideCodeLenses(document: vscode.TextDocument, token?: vscode.CancellationToken): vscode.CodeLens[] {
    // RUST-149 批 3:同步 provider 同样吃取消令牌(入口即停)
    if (!!token?.isCancellationRequested || document.isClosed) {
      return [];
    }
    if (!document.fileName.endsWith(this.fileName)) {
      return [];
    }
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    if (!workspaceRoot) {
      return [];
    }
    // RUST-160:types.xml 注册表不再是总闸——纯 def 来源工作区(无自定义
    // 类型)的实体镜照样出;types.xml 目标逐镜时解析,缺注册表不出该镜。
    const typesXmlPath = getCustomTypeInfos(workspaceRoot)[0]?.filePath;
    const lenses: vscode.CodeLens[] = [];
    for (let line = 0; line < document.lineCount; line += 1) {
      const source = resolvePythonTypeStubSource(this.pythonEntries, this.pythonLines, line)
        ?? resolveEntityTypeStubSource(this.entityEntries, this.entityLines, line);
      if (!source) {
        continue;
      }
      // RUST-160:按来源族分目标——types.xml 镜走注册表文件;def 镜走实体
      // 注册表 defFile(逐实体解析,缺映射不出镜不造错误跳转)。
      let targetUri: vscode.Uri;
      let label: string;
      if (source.sourceKind === 'def') {
        const defFile = this.entityDefFiles.get(source.origin);
        if (!defFile) {
          continue;
        }
        targetUri = vscode.Uri.file(defFile);
        label = `原始定义: ${source.origin} .def:${source.line}`;
      } else {
        if (!typesXmlPath) {
          continue;
        }
        targetUri = vscode.Uri.file(typesXmlPath);
        label = `原始定义: ${source.origin} types.xml:${source.line}`;
      }
      lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: label,
        command: KBENGINE_SOURCE_REVEAL_COMMAND,
        arguments: [
          targetUri,
          { selection: new vscode.Range(source.line - 1, 0, source.line - 1, 0) }
        ]
      }));
    }
    return lenses;
  }
}
