/**
 * 远程服务器管理视图(IDE-PDBG-004):列 ~/.ssh/config 主机 + 手动添加项,
 * 「本地」恒为第一项且默认选中——debug 与 py-spy 按所选主机分派(远程 =
 * ssh 前缀跑命令 / 隧道转发)。选择落 workspaceState,视图即时刷新。
 */

import * as vscode from 'vscode';
import type { SshHostEntry } from './sshConfig';
import type { SshHostsSnapshot } from './remoteConnection';

export const REMOTE_SERVERS_MANUAL_KEY = 'kbengine.remoteServers.manual.v1';
export const REMOTE_SERVERS_SELECTED_KEY = 'kbengine.remoteServers.selected.v1';

/** 本地节点 id(= 默认选择) */
export const LOCAL_SERVER_ID = 'local';

export type RemoteServerKind = 'local' | 'ssh-config' | 'manual';

export interface RemoteServerNode {
  id: string;
  kind: RemoteServerKind;
  /** ssh-config 项的完整参数(跳板/端口/用户);手动项只有裸主机 */
  entry?: SshHostEntry;
  selected: boolean;
}

/**
 * 组树:本地恒第一(默认),ssh/config 项按别名序,手动项随后;选中项
 * 标 ✓。手动项与 config 项同名时手动项不重复列(config 里的优先,删手
 * 动项不误删 config 事实)。
 */
export function buildRemoteServerNodes(
  snapshot: Pick<SshHostsSnapshot, 'hosts'>,
  manualHosts: string[],
  selected: string
): RemoteServerNode[] {
  const nodes: RemoteServerNode[] = [
    { id: LOCAL_SERVER_ID, kind: 'local', selected: selected === LOCAL_SERVER_ID || selected.length === 0 }
  ];
  const configIds = new Set<string>([LOCAL_SERVER_ID]);
  for (const entry of [...snapshot.hosts].sort((a, b) => a.host.localeCompare(b.host))) {
    configIds.add(entry.host);
    nodes.push({ id: entry.host, kind: 'ssh-config', entry, selected: selected === entry.host });
  }
  for (const host of manualHosts) {
    if (configIds.has(host)) {
      continue; // config 已列:手动项不重复
    }
    nodes.push({ id: host, kind: 'manual', entry: { host }, selected: selected === host });
  }
  return nodes;
}

export class RemoteServerTreeItem extends vscode.TreeItem {
  constructor(node: RemoteServerNode) {
    const label = node.kind === 'local' ? '本地(直接执行)' : node.id;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = node.id;
    this.iconPath = new vscode.ThemeIcon(
      node.kind === 'local' ? 'home' : node.kind === 'ssh-config' ? 'server' : 'plug'
    );
    this.contextValue = `remote-server-${node.kind}`;
    const detail = node.kind === 'local'
      ? '默认:命令在本机跑'
      : node.entry?.hostname && node.entry.hostname !== node.id
        ? `${node.entry.hostname}${node.entry.port ? `:${node.entry.port}` : ''}`
        : '';
    this.description = [node.selected ? '✓ 已选' : '', detail, node.entry?.proxyJump ? `跳板 ${node.entry.proxyJump}` : '']
      .filter(part => part.length > 0)
      .join(' · ');
    this.tooltip = [
      node.kind === 'local' ? '本地:debug 与 py-spy 在本机直接执行' : `ssh 主机:${node.id}`,
      node.entry?.hostname ? `HostName ${node.entry.hostname}` : '',
      node.entry?.user ? `User ${node.entry.user}` : '',
      node.entry?.port ? `Port ${node.entry.port}` : '',
      node.entry?.proxyJump ? `ProxyJump ${node.entry.proxyJump}` : '',
      node.kind === 'manual' ? '手动添加项(右键可移除)' : '',
      node.selected ? '当前选中:debug/py-spy 分派目标' : '点击切换为分派目标'
    ]
      .filter(line => line.length > 0)
      .join('\n');
    this.command = {
      command: 'kbengine.remoteServers.select',
      title: 'Select Remote Server',
      arguments: [node.id]
    };
  }
}

export interface RemoteServerTreeDeps {
  getSnapshot(): SshHostsSnapshot | null;
  getManualHosts(): string[];
  getSelected(): string;
}

export class RemoteServerTreeProvider implements vscode.TreeDataProvider<RemoteServerTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RemoteServerTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly deps: RemoteServerTreeDeps) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: RemoteServerTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): RemoteServerTreeItem[] {
    const snapshot = this.deps.getSnapshot();
    return buildRemoteServerNodes(
      snapshot ?? { hosts: [] },
      this.deps.getManualHosts(),
      this.deps.getSelected()
    ).map(node => new RemoteServerTreeItem(node));
  }
}
