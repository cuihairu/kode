// IDE-MET-001:活动扩展身份报告。验收口径:报告区分「安装目录存在」与
// 「当前窗口已激活」两个正交事实(装了未激活、激活中目录已消失都要如实
// 分列),并列出远程/本地宿主位置与扩展宿主侧(workspace/ui)。本模块是
// 纯函数渲染面;采集(vscode.extensions.all、fs.existsSync)在
// extension.ts 接线,测试零桩锁定契约。

export interface ExtensionIdentityEntry {
  /** 扩展完整 ID(publisher.name) */
  id: string;
  version: string;
  /** 安装目录(呈现用;存在性由 installExists 单独表达) */
  extensionPath: string;
  /** 安装目录当前是否存在于文件系统 */
  installExists: boolean;
  /** 当前扩展宿主窗口中是否已激活 */
  isActive: boolean;
  /** 宿主侧:ui=本地渲染端,workspace=远程工作区端 */
  extensionKind: string;
}

export interface ExtensionHostContext {
  /** vscode.env.remoteName(undefined=本地窗口) */
  remoteName: string | undefined;
  appName: string;
}

/** 宿主位置:远程窗口 remote(名),本地窗口 local */
export function hostLabel(host: ExtensionHostContext): string {
  return host.remoteName ? `remote(${host.remoteName})` : 'local';
}

export function sideLabel(extensionKind: string): string {
  if (extensionKind === 'workspace') { return 'workspace host'; }
  if (extensionKind === 'ui') { return 'ui host'; }
  return extensionKind;
}

/** 渲染身份报告:每个匹配安装四行(ID/installed/active/side);报告头列
 *  构建提交(IDE-MET-002,读不到=unknown 也如实呈现),读者能把源码 SHA
 *  与 package version 分开对账。 */
export function renderExtensionIdentityReport(
  entries: ExtensionIdentityEntry[],
  host: ExtensionHostContext,
  buildCommit: string
): string {
  const lines: string[] = [
    'Kode extension identity report',
    `host: ${hostLabel(host)} in ${host.appName}`,
    `build commit: ${buildCommit}`
  ];
  if (entries.length === 0) {
    lines.push('no matching extension installs found');
    return `${lines.join('\n')}\n`;
  }
  for (const entry of entries) {
    lines.push(
      `${entry.id} v${entry.version}`,
      `  installed=${entry.installExists ? 'yes' : 'no'} (${entry.extensionPath})`,
      `  active=${entry.isActive ? 'yes' : 'no'}`,
      `  side=${sideLabel(entry.extensionKind)}`
    );
  }
  return `${lines.join('\n')}\n`;
}
