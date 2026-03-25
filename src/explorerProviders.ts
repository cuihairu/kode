import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { KBEngineServerManager, SERVER_COMPONENTS, ServerStatus } from './serverManager';

export class EntityExplorerProvider implements vscode.TreeDataProvider<EntityTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<EntityTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: EntityTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: EntityTreeItem): Promise<EntityTreeItem[]> {
    if (!vscode.workspace.workspaceFolders) {
      return [];
    }

    if (!element) {
      return this.getEntityList();
    }

    return [];
  }

  private async getEntityList(): Promise<EntityTreeItem[]> {
    const entities: EntityTreeItem[] = [];

    if (!vscode.workspace.workspaceFolders) {
      return entities;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const entitiesXmlPath = path.join(workspaceRoot, 'scripts/entities.xml');

    if (!fs.existsSync(entitiesXmlPath)) {
      return entities;
    }

    const content = fs.readFileSync(entitiesXmlPath, 'utf-8');
    const entityMatches = content.matchAll(/<(\w+)\s+([^>]+)>/g);

    for (const match of entityMatches) {
      const entityName = match[1];
      const attributes = match[2];

      const hasCell = /\bhasCell\s*=\s*"true"/i.test(attributes);
      const hasBase = /\bhasBase\s*=\s*"true"/i.test(attributes);
      const hasClient = /\bhasClient\s*=\s*"true"/i.test(attributes);

      const description = [];
      if (hasCell) description.push('Cell');
      if (hasBase) description.push('Base');
      if (hasClient) description.push('Client');

      entities.push(new EntityTreeItem(
        entityName,
        description.join(', '),
        vscode.TreeItemCollapsibleState.Collapsed
      ));
    }

    return entities;
  }
}

class EntityTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
    this.command = {
      command: 'kbengine.entity.open',
      title: '打开实体定义',
      arguments: [label]
    };
  }
}

class ServerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly component: any,
    public readonly status: ServerStatus,
    public readonly pid?: number
  ) {
    super(component.displayName, vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon(getStatusIcon(status));
    this.contextValue = `server_${component.name}`;

    if (status === ServerStatus.Running) {
      this.description = `PID: ${pid}`;
    } else if (status === ServerStatus.Starting) {
      this.description = '启动中...';
    } else if (status === ServerStatus.Stopping) {
      this.description = '停止中...';
    } else if (status === ServerStatus.Error) {
      this.description = '错误';
    }

    this.tooltip = `${component.displayName}\n${component.description}\n状态: ${status}`;
  }
}

export class ServerControlProvider implements vscode.TreeDataProvider<ServerTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ServerTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private serverManager: KBEngineServerManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ServerTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ServerTreeItem): Promise<ServerTreeItem[]> {
    if (element) {
      return [];
    }

    const components = this.serverManager.getAllServers();
    const runningServers = this.serverManager.getRunningServers();

    return components.map(component => {
      const runningServer = runningServers.get(component.name);
      const status = runningServer?.status || ServerStatus.Stopped;
      const pid = runningServer?.pid;

      return new ServerTreeItem(component, status, pid);
    });
  }
}

function getStatusIcon(status: ServerStatus): string {
  switch (status) {
    case ServerStatus.Running:
      return 'circle-filled';
    case ServerStatus.Starting:
      return 'clock';
    case ServerStatus.Stopping:
      return 'loading';
    case ServerStatus.Error:
      return 'error';
    case ServerStatus.Stopped:
    default:
      return 'circle-large-outline';
  }
}

export function pickServerComponent(placeHolder: string) {
  return vscode.window.showQuickPick(
    SERVER_COMPONENTS.map(component => ({
      label: component.displayName,
      description: component.description,
      name: component.name
    })),
    { placeHolder }
  );
}
