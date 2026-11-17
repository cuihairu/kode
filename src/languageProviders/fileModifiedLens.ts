// 文件顶部修改时间 CodeLens(FILE-TIME-001,用户令 2026-11-17):「在文件
// 顶部显示修改的时间,热更新时间」——热更时间半边由既有 IDE-HOT-100 状态点
// 承担(hotReloadFileStateLens.ts「上次 <时间>」),本面只补修改时间:盘上
// mtime 一次 stat,保存即刷新,编辑未保存显式注记。独立开关
// kbengine.codeLens.fileModifiedTime(批154 惯例:每类 lens 一枚开关)。
import * as vscode from 'vscode';
import { formatModifiedTimeLens, type StatMtimeMs } from '../backend/fileModifiedLens';
import { getLanguageFeatureConfig } from './shared';

const defaultStat: StatMtimeMs = async (file: string) => {
  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(file));
  return { mtimeMs: stat.mtime };
};

export class FileModifiedTimeCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly stat: StatMtimeMs;
  private readonly now: () => number;
  private readonly unsubscribeSave: () => void;

  constructor(deps: { stat?: StatMtimeMs; now?: () => number } = {}) {
    this.stat = deps.stat ?? defaultStat;
    this.now = deps.now ?? Date.now;
    // 盘上 mtime 只在落盘时变:保存即 fire 重询(文档打开的首查由 VS Code
    // 触发;isDirty 注记随重询如实反映,不逐击键刷新)
    const save = vscode.workspace.onDidSaveTextDocument(() => {
      this.emitter.fire();
    });
    this.unsubscribeSave = () => save.dispose();
  }

  fireConfigurationChanged(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.unsubscribeSave();
    this.emitter.dispose();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    if (token?.isCancellationRequested || document.isClosed) {
      return [];
    }
    if (!getLanguageFeatureConfig().codeLensFileModifiedTime) {
      return [];
    }
    let mtimeMs: number | undefined;
    try {
      mtimeMs = (await this.stat(document.uri.fsPath)).mtimeMs;
    } catch {
      return []; // stat 失败(删除/不可及)=不出镜,不编造时间
    }
    const text = formatModifiedTimeLens(mtimeMs, document.isDirty, this.now());
    if (text === null) {
      return [];
    }
    const lineZero = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    return [
      new vscode.CodeLens(lineZero, {
        title: text,
        command: '',
        tooltip: '文件最近一次落盘时间(盘上 mtime);热更状态与投递时间见同文件顶部热更状态点'
      })
    ];
  }
}
