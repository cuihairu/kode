// 文件顶部进程归属 CodeLens(PROC-TAG-001,用户令 2026-11-13):Python
// 实体脚本顶部一行镜,标当前文件所属进程(scripts/<role>/ 目录判定),
// 其他进程存在同名对应文件(cell/Hero.py ↔ base/Hero.py ↔ bots/Hero.py)
// 时并列出可点击 tag,点击走既有源码 reveal 命令快速切换。判定链与互链
// 推导在纯核 src/backend/processOwnershipLens.ts,本文件只做 vscode 面
// (配置闸/def 佐证的解析链/命令装配/刷新源)。独立开关
// kbengine.codeLens.processOwnership(批154 惯例:每类 lens 一枚开关)。
import * as vscode from 'vscode';
import * as fs from 'fs';
import { EntityMappingManager } from '../entityMapping';
import { findPythonMethodDeclarations } from '../backend/rpcCodeLens';
import {
  buildProcessOwnershipSpec,
  processFromDefSections,
  type ProcessName
} from '../backend/processOwnershipLens';
import { KBENGINE_SOURCE_REVEAL_COMMAND } from '../sourceRevealCommand';
import { getLanguageFeatureConfig } from './shared';

/** 文件事件载荷:真 API 两事件均带 files;fake 桩 delete 臂历史形状为
 * uris,双形并读保持桩/真机同一条事件链(只关心路径是否 .py) */
const fileEventPaths = (
  event: { files?: ReadonlyArray<{ fsPath: string }>; uris?: ReadonlyArray<{ fsPath: string }> }
): string[] => [...(event.files ?? []), ...(event.uris ?? [])].map(entry => entry.fsPath);

export class ProcessOwnershipCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
  private readonly unsubscribeFileEvents: () => void;
  private readonly fileExists: (path: string) => boolean;

  constructor(
    private entityMappingManager: EntityMappingManager,
    deps: { fileExists?: (path: string) => boolean } = {}
  ) {
    this.fileExists = deps.fileExists ?? ((path: string) => fs.existsSync(path));
    // 同名对应文件的新建/删除改变互链面:.py 文件事件即 fire 重取
    // (文档自身变更 VS Code 自动重取,不需要这里管)
    const onFileEvent = (event: { files?: ReadonlyArray<{ fsPath: string }>; uris?: ReadonlyArray<{ fsPath: string }> }): void => {
      if (fileEventPaths(event).some(fsPath => fsPath.endsWith('.py'))) {
        this.onDidChangeCodeLensesEmitter.fire();
      }
    };
    const created = vscode.workspace.onDidCreateFiles(onFileEvent);
    const deleted = vscode.workspace.onDidDeleteFiles(onFileEvent);
    this.unsubscribeFileEvents = () => {
      created.dispose();
      deleted.dispose();
    };
  }

  // 批154 惯例:独立开关 kbengine.codeLens.processOwnership,关只熄这一类;
  // 开关变更由 extension 配置监听 fire 即时生效
  fireConfigurationChanged(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  dispose(): void {
    this.unsubscribeFileEvents();
    this.onDidChangeCodeLensesEmitter.dispose();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    const cancelled = () => !!token?.isCancellationRequested || document.isClosed;
    if (cancelled() || !getLanguageFeatureConfig().codeLensProcessOwnership) {
      return [];
    }
    // 判定链第一优先级:目录角色 + 同名互链
    const spec = buildProcessOwnershipSpec(document.fileName, this.fileExists);
    // 第二优先级:目录判不出时以 def 方法区块佐证(单族才认,不猜)
    const current = spec?.current ?? (await this.resolveDefEvidenceProcess(document, cancelled));
    if (cancelled() || !current) {
      return [];
    }
    const lineZero = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    const lenses: vscode.CodeLens[] = [
      // 当前进程纯展示:空命令 id=VS Code 渲染 title 文本但不可点击(无动作
      // 可执行),tooltip 补判据说明(任务口径「无命令或仅 hover 提示」)
      new vscode.CodeLens(lineZero, {
        title: `⚙ ${current}（当前）`,
        command: '',
        tooltip: `本文件所属进程:${current}(由 scripts/<role> 目录判定;判不出不出镜)`
      })
    ];
    for (const sibling of spec?.siblings ?? []) {
      lenses.push(
        new vscode.CodeLens(lineZero, {
          title: `⚙ ${sibling.process}`,
          command: KBENGINE_SOURCE_REVEAL_COMMAND,
          arguments: [
            vscode.Uri.file(sibling.path),
            { selection: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)) }
          ]
        })
      );
    }
    return lenses;
  }

  /**
   * 判定链第二优先级(def 区块佐证):本文件声明的 def 方法按既有解析链
   * (resolveMethodDefinition,与 RPC 镜链同源)落段,收齐区块集合后交纯核
   * 裁定——恰好单一进程族才佐证;Base/Cell 双有=双进程实体,目录判不出时
   * 无法归属,如实 null。
   */
  private async resolveDefEvidenceProcess(
    document: vscode.TextDocument,
    cancelled: () => boolean
  ): Promise<ProcessName | null> {
    const declarations = findPythonMethodDeclarations(document.getText());
    const sections = new Set<string>();
    const resolved = new Set<string>();
    for (const declaration of declarations) {
      if (cancelled()) {
        return null;
      }
      if (resolved.has(declaration.methodName)) {
        continue;
      }
      resolved.add(declaration.methodName);
      try {
        const location = await this.entityMappingManager.resolveMethodDefinition(
          document.fileName,
          declaration.methodName
        );
        if (location?.section) {
          sections.add(location.section);
        }
      } catch {
        // 解析失败=该名无证据,继续后续名(整体不因单名失败放弃)
      }
    }
    if (cancelled()) {
      return null;
    }
    return processFromDefSections(sections);
  }
}
