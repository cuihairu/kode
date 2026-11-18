/**
 * 工作区目录着色·文件树角标呈现(FOLDER-COLOR-001):把纯核解析出的路径
 * 语义面孔映射成 FileDecoration(badge 单字母 + ThemeColor + tooltip)。
 * 能力边界如实:VS Code 无原生 Explorer 文件夹底色 API,本面只装饰
 * 「文件」——目录本身零输出(钉子:目录不误报);双条件门(开关+Kode
 * 主题族)关=零装饰输出。读取/判定经注入面,测试用假体同形
 * (对齐 hotReloadFileDecorations 先例)。
 */

import * as vscode from 'vscode';

import type { FolderColorFace, FolderColorSemantic } from './backend/folderColorRules';
import { l10nText } from './nlsRuntime';

export interface FolderColorDecorationDeps {
  /** 双条件门(开关开启+Kode 主题族,用户令终版口径);每次呈现时求值 */
  isActive(): boolean;
  /** 路径语义解析(纯核注入;null=无规则命中,不装饰) */
  resolveFace(fsPath: string): FolderColorFace | null;
  /** 目录判定(只装饰文件,目录本身零输出——无文件夹底色 API,如实不装) */
  isDirectory(fsPath: string): boolean | Promise<boolean>;
}

/** 语义→展示名(tooltip 用;走 l10n 调用期求值,语言切换即时生效) */
function semanticLabelOf(semantic: FolderColorSemantic): string {
  switch (semantic) {
    case 'assets':
      return l10nText('Assets');
    case 'venv':
      return l10nText('Virtual environment');
    case 'docs':
      return l10nText('Docs');
    case 'configs':
      return l10nText('Configs');
    case 'logs':
      return l10nText('Logs');
    case 'process':
      return l10nText('Process scripts');
  }
}

/** tooltip:语义名(+process 面孔附进程名) */
export function folderColorTooltipOf(face: FolderColorFace): string {
  const label = semanticLabelOf(face.semantic);
  return face.process ? `${label} · ${face.process}` : label;
}

/** 文件树角标 provider:门关/目录/无命中=undefined;命中=badge+色+tooltip */
export class FolderColorDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(private readonly deps: FolderColorDecorationDeps) {}

  async provideFileDecoration(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): Promise<vscode.FileDecoration | undefined> {
    if (!this.deps.isActive()) {
      return undefined;
    }
    if (await this.deps.isDirectory(uri.fsPath)) {
      return undefined;
    }
    const face = this.deps.resolveFace(uri.fsPath);
    if (face === null) {
      return undefined;
    }
    return new vscode.FileDecoration(face.badge, folderColorTooltipOf(face), new vscode.ThemeColor(face.colorId));
  }

  /** 门/规则/主题变更通知(VS Code 重渲染角标) */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
