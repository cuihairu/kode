/**
 * types.xml 落库索引的全仓 watcher 装配线(IDE-ARC-005 自 languageProviders
 * 的 TypesXmlCodeLensProvider 抽出):def/types.xml/entities.xml 任一改动都
 * 会改变引用与落点并触发重取。此前 provider 在构造器里私建这三枚全仓
 * watcher(且其 dispose 从未被装配层调用=泄漏);现在 provider 只做镜渲染,
 * 全仓 watch 归本装配线模块,Disposable 交 extension 的 context.subscriptions
 * 统一释放。def 变更仍走 IDE-SCH-008 按实体增量替换(只重建该实体贡献的
 * usage 记录),types.xml/entities.xml 仍整表置空(别名与实体清单影响全体
 * 消费方)。
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { invalidateTypeStorageUsageIndex, replaceTypeStorageUsageForEntity } from './databaseSchema';

/** 建三枚全仓 watcher 并接失效策略;onUsageIndexChanged 在失效后回调(装配层
 * 用它驱动受影响 provider 的镜刷新)。返回的 Disposable 拆掉全部 watcher。 */
export function registerTypeStorageIndexWatchers(onUsageIndexChanged: () => void): vscode.Disposable {
  const watchers: vscode.FileSystemWatcher[] = [];
  for (const pattern of ['**/*.def', '**/types.xml', '**/entities.xml']) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const invalidate = (): void => {
      invalidateTypeStorageUsageIndex();
      onUsageIndexChanged();
    };
    const replaceEntity = (uri?: vscode.Uri): void => {
      if (!uri) {
        invalidate(); // 无 uri 的事件面兜底:退回整表置空
        return;
      }
      const folder = vscode.workspace.workspaceFolders?.find(item =>
        uri.fsPath === item.uri.fsPath
        || uri.fsPath.startsWith(`${item.uri.fsPath}/`)
        || uri.fsPath.startsWith(`${item.uri.fsPath}${path.sep}`));
      const root = folder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        invalidate();
        return;
      }
      replaceTypeStorageUsageForEntity(root, path.basename(uri.fsPath, path.extname(uri.fsPath)));
      onUsageIndexChanged();
    };
    if (pattern === '**/*.def') {
      watcher.onDidChange(replaceEntity);
      watcher.onDidCreate(replaceEntity);
      watcher.onDidDelete(replaceEntity);
    } else {
      watcher.onDidChange(invalidate);
      watcher.onDidCreate(invalidate);
      watcher.onDidDelete(invalidate);
    }
    watchers.push(watcher);
  }
  return {
    dispose: (): void => {
      for (const watcher of watchers) watcher.dispose();
    }
  };
}
