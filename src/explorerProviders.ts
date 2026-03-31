import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { KBEngineServerManager, SERVER_COMPONENTS, ServerStatus } from './serverManager';

type EntityDetail =
  | { label: string; value: string; icon: string }
  | { label: string; value: string; icon: string; command: vscode.Command };

interface ParsedEntityInfo {
  name: string;
  description: string;
  defPath: string;
  details: EntityDetail[];
}

type EntityTreeNode = EntityTreeItem | EntityDetailItem;

export class EntityExplorerProvider implements vscode.TreeDataProvider<EntityTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<EntityTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: EntityTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: EntityTreeNode): Promise<EntityTreeNode[]> {
    if (!vscode.workspace.workspaceFolders) {
      return [];
    }

    if (!element) {
      return this.getEntityList();
    }

    if (element instanceof EntityTreeItem) {
      return element.details.map(detail => new EntityDetailItem(detail));
    }

    return [];
  }

  private async getEntityList(): Promise<EntityTreeItem[]> {
    const entities: EntityTreeItem[] = [];

    if (!vscode.workspace.workspaceFolders) {
      return entities;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const kbengineConfig = vscode.workspace.getConfiguration('kbengine');
    const entitiesXmlPath = path.join(
      workspaceRoot,
      kbengineConfig.get<string>('entitiesXmlPath', 'scripts/entities.xml')
    );
    const entityDefsPath = path.join(
      workspaceRoot,
      kbengineConfig.get<string>('entityDefsPath', 'scripts/entity_defs')
    );

    if (!fs.existsSync(entitiesXmlPath)) {
      return entities;
    }

    const content = fs.readFileSync(entitiesXmlPath, 'utf-8');
    const entityMatches = /<(\w+)\s+([^>]+)>/g;
    let match: RegExpExecArray | null;

    while ((match = entityMatches.exec(content)) !== null) {
      const entityName = match[1];
      const attributes = match[2];

      const hasCell = /\bhasCell\s*=\s*"true"/i.test(attributes);
      const hasBase = /\bhasBase\s*=\s*"true"/i.test(attributes);
      const hasClient = /\bhasClient\s*=\s*"true"/i.test(attributes);

      const description = [];
      if (hasCell) description.push('Cell');
      if (hasBase) description.push('Base');
      if (hasClient) description.push('Client');

      const defPath = path.join(entityDefsPath, `${entityName}.def`);
      const parsedEntity = this.buildEntityInfo(
        entityName,
        description.join(', '),
        defPath,
        { hasCell, hasBase, hasClient }
      );

      entities.push(
        new EntityTreeItem(
          parsedEntity.name,
          parsedEntity.description,
          parsedEntity.defPath,
          parsedEntity.details
        )
      );
    }

    return entities;
  }

  private buildEntityInfo(
    name: string,
    description: string,
    defPath: string,
    flags: { hasCell: boolean; hasBase: boolean; hasClient: boolean }
  ): ParsedEntityInfo {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const relativeDefPath = workspaceRoot ? path.relative(workspaceRoot, defPath) : defPath;
    const details: EntityDetail[] = [
      {
        label: 'Definition',
        value: relativeDefPath || defPath,
        icon: 'go-to-file',
        command: {
          command: 'kbengine.entity.open',
          title: '打开实体定义',
          arguments: [name]
        }
      },
      {
        label: 'Components',
        value: description || 'None',
        icon: 'symbol-class'
      }
    ];

    if (fs.existsSync(defPath)) {
      const content = fs.readFileSync(defPath, 'utf8');
      const propertyCount = this.countMatches(
        content,
        /<(Properties|CellProperties|ClientProperties)>[\s\S]*?<\/\1>/g,
        /<([A-Za-z_][A-Za-z0-9_]*)>\s*<Type>/g
      );
      const methodCount = this.countMatches(
        content,
        /<(BaseMethods|CellMethods|ClientMethods)>[\s\S]*?<\/\1>/g,
        /<([A-Za-z_][A-Za-z0-9_]*)>\s*(?:<Arg>|<\/[A-Za-z_][A-Za-z0-9_]*>)/g
      );

      details.push(
        { label: 'Properties', value: String(propertyCount), icon: 'symbol-property' },
        { label: 'Methods', value: String(methodCount), icon: 'symbol-method' }
      );
    } else {
      details.push({
        label: 'Status',
        value: 'Definition file not found',
        icon: 'warning'
      });
    }

    details.push(
      { label: 'Base', value: flags.hasBase ? 'Yes' : 'No', icon: 'circle-filled' },
      { label: 'Cell', value: flags.hasCell ? 'Yes' : 'No', icon: 'circle-filled' },
      { label: 'Client', value: flags.hasClient ? 'Yes' : 'No', icon: 'circle-filled' }
    );

    return { name, description, defPath, details };
  }

  private countMatches(text: string, sectionRegex: RegExp, itemRegex: RegExp): number {
    let count = 0;
    let sectionMatch: RegExpExecArray | null;

    while ((sectionMatch = sectionRegex.exec(text)) !== null) {
      const sectionBody = sectionMatch[0];
      const scopedRegex = new RegExp(itemRegex.source, itemRegex.flags);
      while (scopedRegex.exec(sectionBody) !== null) {
        count += 1;
      }
    }

    return count;
  }
}

class EntityTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly defPath: string,
    public readonly details: EntityDetail[]
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
    this.command = {
      command: 'kbengine.entity.open',
      title: '打开实体定义',
      arguments: [label]
    };
    this.tooltip = `${label}\n${description}\n${defPath}`;
  }
}

class EntityDetailItem extends vscode.TreeItem {
  constructor(detail: EntityDetail) {
    super(detail.label, vscode.TreeItemCollapsibleState.None);
    this.description = detail.value;
    this.iconPath = new vscode.ThemeIcon(detail.icon);
    this.contextValue = 'entity_detail';
    if ('command' in detail) {
      this.command = detail.command;
    }
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
