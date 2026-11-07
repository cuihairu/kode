import * as vscode from 'vscode';

// KODE-PERF 视图先行(KBEngine Explorer「There is no data provider registered
// that can provide view data」排查):activate 是同步函数,十个侧栏视图的
// registerTreeDataProvider/createTreeView 分散在数千行装配体的尾段——任何一段
// 同步装配抛错或被拖死,视图就停在「已声明、无提供者」状态,宿主报上述错误且
// 视图全空。修复口径:activate 最前(任何重活之前)先为全部侧栏视图 id 注册
// 一个空占位 provider(getChildren 恒 []),宿主立即完成视图装配;真 provider
// 在既有装配位随后注册,宿主侧同 id 重复注册是「后到者接管」语义
// (extHostTreeViews._treeViews.set / mainThreadTreeViews._dataProviders.set
// 均为覆写),视图随之切换到真数据源。占位到接管之间视图显示为空列表而非
// 错误面板——以空视图换错误视图,装配完成即自动恢复。

/** package.json contributes.views(kbengine-explorer 容器)声明的全部视图 id */
export const KBENGINE_SIDEBAR_VIEW_IDS: readonly string[] = [
  'kbengine.quickActions',
  'kbengine.serverControl',
  // KB-GC-001 guiconsole 期一:组件状态面板(与 tail 共用 ConsoleHub 发现链;
  // 置于服务控制之后,实时负载/存活在侧栏首屏可见)
  'kbengine.componentStatus',
  'kbengine.telnetStatus',
  'kbengine.playerData',
  'kbengine.remoteServers',
  'kbengine.entityExplorer',
  'kbengine.debugTargets',
  'kbengine.config',
  'kbengine.gitHistory',
  'kbengine.gitRangeHistory'
];

export interface StartupViewPlaceholderDeps {
  /** 生产传 vscode.window.registerTreeDataProvider;测试注入记录替身 */
  registerTreeDataProvider: (
    viewId: string,
    provider: vscode.TreeDataProvider<unknown>
  ) => vscode.Disposable;
}

/** 空占位 provider:接管前 getChildren 恒空,无状态、无事件、零副作用 */
export function createEmptyViewPlaceholderProvider(): vscode.TreeDataProvider<unknown> {
  return {
    getChildren: () => [],
    getTreeItem: () => ({ label: '' } as vscode.TreeItem)
  };
}

/**
 * 为全部侧栏视图 id 注册空占位 provider(activate 最前调用)。
 * 返回合并 disposable:随 context.subscriptions 拆除全部占位注册。
 */
export function registerStartupViewPlaceholders(
  deps: StartupViewPlaceholderDeps
): vscode.Disposable {
  const registrations = KBENGINE_SIDEBAR_VIEW_IDS.map(viewId =>
    deps.registerTreeDataProvider(viewId, createEmptyViewPlaceholderProvider())
  );
  return {
    dispose: () => {
      for (const registration of registrations) {
        registration.dispose();
      }
    }
  };
}
