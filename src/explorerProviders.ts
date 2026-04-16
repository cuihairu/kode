import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CustomTypeStructureNode,
  DefinitionCategory,
  DefinitionEntry,
  findDefinitionEntryByCategory,
  findDefinitionFileByCategory,
  getDefinitionEntries,
  getWorkspaceRootForDocument
} from './definitionWorkspace';
import { KBENGINE_TYPES } from './kbengineMetadata';
import { KBEngineServerManager, SERVER_COMPONENTS, ServerStatus } from './serverManager';

type EntityTreeNode =
  | ExplorerGroupItem
  | DefinitionTreeItem
  | DefinitionSectionItem
  | DefinitionLeafItem;

interface DefinitionStats {
  properties: string[];
  baseMethods: string[];
  cellMethods: string[];
  clientMethods: string[];
  parent?: string;
  interfaces: string[];
  components: Array<{ propertyName: string; typeName: string }>;
}

interface DefinitionLeafDescriptor {
  label: string;
  description: string;
  icon: string;
  command?: vscode.Command;
}

interface DefinitionSectionDescriptor {
  key: string;
  label: string;
  icon: string;
  items: DefinitionLeafDescriptor[];
}

interface DefinitionSummaryDescriptor {
  label: string;
  value: string;
  icon: string;
  command?: vscode.Command;
}

interface DefinitionViewModel {
  summary: DefinitionSummaryDescriptor[];
  sections: DefinitionSectionDescriptor[];
}

export function parseDefinitionStructure(content: string): DefinitionStats {
  const extractParent = (): string | undefined => {
    const match = content.match(/<Parent>\s*<([A-Za-z_][A-Za-z0-9_]*)\s*\/>\s*<\/Parent>/i);
    return match?.[1];
  };

  const extractPropertiesFromBody = (body: string): string[] => {
    if (!body) {
      return [];
    }

    const values: string[] = [];
    const propertyRegex = /<([A-Za-z_][A-Za-z0-9_]*)>\s*([\s\S]*?)\s*<\/\1>/g;
    let match: RegExpExecArray | null;

    while ((match = propertyRegex.exec(body)) !== null) {
      if (/<Type>[\s\S]*?<\/Type>/i.test(match[2])) {
        values.push(match[1]);
      }
    }

    return values;
  };

  const extractMethods = (sectionName: 'BaseMethods' | 'CellMethods' | 'ClientMethods'): string[] => {
    const body = content.match(new RegExp(`<${sectionName}>([\\s\\S]*?)<\\/${sectionName}>`, 'i'))?.[1] || '';
    if (!body) {
      return [];
    }

    const values: string[] = [];
    const methodRegex = /<([A-Za-z_][A-Za-z0-9_]*)>\s*([\s\S]*?)\s*<\/\1>/g;
    let match: RegExpExecArray | null;

    while ((match = methodRegex.exec(body)) !== null) {
      if (/<Arg>[\s\S]*?<\/Arg>/i.test(match[2]) || /<Utype>[\s\S]*?<\/Utype>/i.test(match[2])) {
        values.push(match[1]);
      }
    }

    return values;
  };

  const extractInterfaces = (): string[] => {
    const interfacesBody = content.match(/<Interfaces>([\s\S]*?)<\/Interfaces>/i)?.[1];
    if (!interfacesBody) {
      return [];
    }

    const names: string[] = [];
    const interfaceRegex = /<(?:Interface|interface|Type|type)>\s*<([A-Za-z_][A-Za-z0-9_]*)\s*\/>\s*<\/(?:Interface|interface|Type|type)>/g;
    let match: RegExpExecArray | null;
    while ((match = interfaceRegex.exec(interfacesBody)) !== null) {
      names.push(match[1]);
    }
    return names;
  };

  const extractNamedBlocks = (text: string): Array<{ name: string; body: string }> => {
    const blockRegex = /<([A-Za-z_][A-Za-z0-9_]*)>\s*([\s\S]*?)\s*<\/\1>/g;
    const blocks: Array<{ name: string; body: string }> = [];
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(text)) !== null) {
      blocks.push({
        name: match[1],
        body: match[2]
      });
    }

    return blocks;
  };

  const extractComponents = (): Array<{ propertyName: string; typeName: string }> => {
    const componentsBody = content.match(/<Components>([\s\S]*?)<\/Components>/i)?.[1];
    if (!componentsBody) {
      return [];
    }

    const componentEntries: Array<{ propertyName: string; typeName: string }> = [];
    for (const block of extractNamedBlocks(componentsBody)) {
      const typeName = block.body.match(/<Type>\s*<?([A-Za-z_][A-Za-z0-9_]*)\/?>?\s*<\/Type>/i)?.[1];
      if (typeName) {
        componentEntries.push({ propertyName: block.name, typeName });
      }
    }

    return componentEntries;
  };

  return {
    properties: extractPropertiesFromBody(content.match(/<Properties>([\s\S]*?)<\/Properties>/i)?.[1] || ''),
    baseMethods: extractMethods('BaseMethods'),
    cellMethods: extractMethods('CellMethods'),
    clientMethods: extractMethods('ClientMethods'),
    parent: extractParent(),
    interfaces: extractInterfaces(),
    components: extractComponents()
  };
}

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
    const workspaceRoot = getWorkspaceRootForDocument();
    if (!workspaceRoot) {
      return [];
    }

    if (!element) {
      return this.getRootGroups(workspaceRoot);
    }

    if (element instanceof ExplorerGroupItem) {
      return this.getDefinitionItems(workspaceRoot, element.category);
    }

    if (element instanceof DefinitionTreeItem) {
      return [
        new DefinitionSectionItem(
          element.definition,
          {
            key: 'summary',
            label: 'Summary',
            icon: 'list-selection',
            items: element.viewModel.summary.map(item => ({
              label: item.label,
              description: item.value,
              icon: item.icon,
              command: item.command
            }))
          }
        ),
        ...element.viewModel.sections.map(section => new DefinitionSectionItem(element.definition, section))
      ];
    }

    if (element instanceof DefinitionSectionItem) {
      return element.section.items.map(item => new DefinitionLeafItem(item));
    }

    return [];
  }

  private getRootGroups(workspaceRoot: string): ExplorerGroupItem[] {
    const types = getDefinitionEntries(workspaceRoot, 'type');
    const entities = getDefinitionEntries(workspaceRoot, 'entity');
    const interfaces = getDefinitionEntries(workspaceRoot, 'interface');
    const components = getDefinitionEntries(workspaceRoot, 'component');

    return [
      new ExplorerGroupItem('Types', 'type', types.length),
      new ExplorerGroupItem('Entities', 'entity', entities.length),
      new ExplorerGroupItem('Interfaces', 'interface', interfaces.length),
      new ExplorerGroupItem('Components', 'component', components.length)
    ];
  }

  private getDefinitionItems(
    workspaceRoot: string,
    category: DefinitionCategory
  ): DefinitionTreeItem[] {
    return getDefinitionEntries(workspaceRoot, category).map(entry => {
      const description = this.buildDefinitionDescription(entry);
      const viewModel = this.buildDefinitionViewModel(workspaceRoot, entry);
      return new DefinitionTreeItem(entry, description, viewModel);
    });
  }

  private buildDefinitionDescription(entry: DefinitionEntry): string {
    if (entry.category === 'type') {
      const parts: string[] = [entry.aliasType || 'ALIAS'];
      if (entry.implementedBy) {
        parts.push(`implementedBy: ${entry.implementedBy}`);
      }
      if (!entry.pythonFilePath) {
        parts.push('Python Missing');
      }
      return parts.join(', ');
    }

    if (entry.category === 'entity') {
      const parts: string[] = [];
      if (entry.hasBase) {
        parts.push('Base');
      }
      if (entry.hasCell) {
        parts.push('Cell');
      }
      if (entry.hasClient) {
        parts.push('Client');
      }
      if (!entry.registered) {
        parts.push('Unregistered');
      }
      return parts.join(', ');
    }

    return entry.exists ? path.basename(entry.filePath) : 'Missing';
  }

  private buildDefinitionViewModel(
    workspaceRoot: string,
    entry: DefinitionEntry
  ): DefinitionViewModel {
    const relativePath = path.relative(workspaceRoot, entry.filePath) || entry.filePath;
    const summary: DefinitionSummaryDescriptor[] = [
      {
        label: 'Definition',
        value: relativePath,
        icon: 'go-to-file',
        command: entry.exists ? createOpenDefinitionCommand(entry.filePath, entry.line) : undefined
      },
      {
        label: 'Category',
        value: this.getCategoryLabel(entry.category),
        icon: this.getCategoryIcon(entry.category)
      }
    ];

    if (entry.category === 'entity') {
      summary.push(
        { label: 'Registered', value: entry.registered ? 'Yes' : 'No', icon: entry.registered ? 'check' : 'warning' },
        { label: 'Base', value: entry.hasBase ? 'Yes' : 'No', icon: 'circle-filled' },
        { label: 'Cell', value: entry.hasCell ? 'Yes' : 'No', icon: 'circle-filled' },
        { label: 'Client', value: entry.hasClient ? 'Yes' : 'No', icon: 'circle-filled' }
      );
    }

    if (entry.category === 'type') {
      summary.push(
        { label: 'AliasType', value: entry.aliasType || 'ALIAS', icon: 'symbol-key' },
        { label: 'Python', value: entry.pythonFilePath ? path.relative(workspaceRoot, entry.pythonFilePath) : 'Missing', icon: entry.pythonFilePath ? 'file-code' : 'warning' }
      );

      if (entry.implementedBy) {
        summary.push({ label: 'implementedBy', value: entry.implementedBy, icon: 'symbol-namespace' });
      }
    }

    if (!entry.exists) {
      summary.push({ label: 'Status', value: 'Definition file not found', icon: 'warning' });
      return { summary, sections: [] };
    }

    if (entry.category === 'type') {
      const sections: DefinitionSectionDescriptor[] = [];

      if (entry.rawValue) {
        sections.push({
          key: 'alias',
          label: 'Alias',
          icon: 'symbol-type-parameter',
          items: this.createTypeStructureItems(workspaceRoot, entry.typeStructure).length > 0
            ? this.createTypeStructureItems(workspaceRoot, entry.typeStructure)
            : [{
              label: entry.aliasType || 'ALIAS',
              description: entry.rawValue,
              icon: 'symbol-type-parameter'
            }]
        });
      }

      if (entry.typeProperties?.length) {
        sections.push({
          key: 'properties',
          label: 'Properties',
          icon: 'symbol-property',
          items: entry.typeProperties.map(property => this.createTypePropertyItem(workspaceRoot, property))
        });
      }

      if (entry.pythonFilePath) {
        sections.push({
          key: 'python',
          label: 'Python',
          icon: 'file-code',
          items: [{
            label: path.basename(entry.pythonFilePath),
            description: path.relative(workspaceRoot, entry.pythonFilePath),
            icon: 'file-code',
            command: {
              command: 'vscode.open',
              title: 'Open Python Type',
              arguments: [vscode.Uri.file(entry.pythonFilePath)]
            }
          }]
        });
      }

      return { summary, sections };
    }

    const stats = this.readDefinitionStats(entry.filePath);
    summary.push(
      { label: 'Properties', value: String(stats.properties.length), icon: 'symbol-property' },
      {
        label: 'Methods',
        value: String(stats.baseMethods.length + stats.cellMethods.length + stats.clientMethods.length),
        icon: 'symbol-method'
      }
    );

    const sections: DefinitionSectionDescriptor[] = [];

    if (stats.parent) {
      sections.push({
        key: 'parent',
        label: 'Parent',
        icon: 'type-hierarchy-super',
        items: [this.createDefinitionReferenceItem(workspaceRoot, entry, stats.parent)]
      });
    }

    if (stats.interfaces.length > 0) {
      sections.push({
        key: 'interfaces',
        label: 'Interfaces',
        icon: 'symbol-interface',
        items: stats.interfaces.map(name => this.createDefinitionReferenceItem(
          workspaceRoot,
          entry,
          name,
          'interface'
        ))
      });
    }

    if (stats.components.length > 0) {
      sections.push({
        key: 'components',
        label: 'Components',
        icon: 'extensions',
        items: stats.components.map(component => this.createDefinitionReferenceItem(
          workspaceRoot,
          entry,
          component.typeName,
          'component',
          component.propertyName
        ))
      });
    }

    if (stats.properties.length > 0) {
      sections.push({
        key: 'properties',
        label: 'Properties',
        icon: 'symbol-property',
        items: stats.properties.map(name => ({
          label: name,
          description: entry.category === 'entity' ? 'Property' : this.getCategoryLabel(entry.category),
          icon: 'symbol-property'
        }))
      });
    }

    const methodSections: Array<{ label: string; values: string[]; icon: string }> = [
      { label: 'BaseMethods', values: stats.baseMethods, icon: 'symbol-method' },
      { label: 'CellMethods', values: stats.cellMethods, icon: 'symbol-method' },
      { label: 'ClientMethods', values: stats.clientMethods, icon: 'symbol-method' }
    ];

    for (const section of methodSections) {
      if (section.values.length === 0) {
        continue;
      }

      sections.push({
        key: section.label,
        label: section.label,
        icon: section.icon,
        items: section.values.map(name => ({
          label: name,
          description: section.label,
          icon: section.icon
        }))
      });
    }

    return { summary, sections };
  }

  private createDefinitionReferenceItem(
    workspaceRoot: string,
    entry: DefinitionEntry,
    name: string,
    categoryOverride?: DefinitionCategory,
    descriptionPrefix?: string
  ): DefinitionLeafDescriptor {
    const targetCategory = categoryOverride ?? this.resolveParentCategory(entry);
    const targetPath = findDefinitionFileByCategory(name, targetCategory, workspaceRoot)
      || (targetCategory === 'entity' ? null : findDefinitionFileByCategory(name, 'entity', workspaceRoot));

    const description = descriptionPrefix
      ? `${descriptionPrefix} -> ${name}`
      : (targetPath ? path.relative(workspaceRoot, targetPath) : name);

    return {
      label: name,
      description,
      icon: this.getCategoryIcon(targetCategory),
      command: targetPath
        ? {
          command: 'vscode.open',
          title: 'Open Definition',
          arguments: [vscode.Uri.file(targetPath)]
        }
        : undefined
    };
  }

  private createTypePropertyItem(
    workspaceRoot: string,
    property: NonNullable<DefinitionEntry['typeProperties']>[number]
  ): DefinitionLeafDescriptor {
    const typeName = property.typeName || 'UNKNOWN';
    const resolvedReference = this.resolveTypeReference(workspaceRoot, typeName);

    return {
      label: property.name,
      description: `${typeName} · ${resolvedReference.label}`,
      icon: resolvedReference.icon,
      command: resolvedReference.command
    };
  }

  private createTypeStructureItems(
    workspaceRoot: string,
    structure?: CustomTypeStructureNode
  ): DefinitionLeafDescriptor[] {
    if (!structure) {
      return [];
    }

    if (structure.children.length === 0) {
      const resolvedReference = this.resolveTypeReference(workspaceRoot, structure.name);
      return [{
        label: structure.name,
        description: structure.rawValue === structure.name
          ? resolvedReference.label
          : `${structure.rawValue} · ${resolvedReference.label}`,
        icon: resolvedReference.icon,
        command: resolvedReference.command
      }];
    }

    const resolvedReference = this.resolveTypeReference(workspaceRoot, structure.name);
    const items: DefinitionLeafDescriptor[] = [{
      label: structure.name,
      description: `${structure.rawValue} · ${resolvedReference.label}`,
      icon: resolvedReference.icon,
      command: resolvedReference.command
    }];

    for (const child of structure.children) {
      const resolvedReference = this.resolveTypeReference(workspaceRoot, child.value.name);
      items.push({
        label: `<${child.tag}>`,
        description: `${child.value.rawValue} · ${resolvedReference.label}`,
        icon: resolvedReference.icon,
        command: resolvedReference.command
      });
    }

    return items;
  }

  private resolveTypeReference(
    workspaceRoot: string,
    typeName: string
  ): { label: string; icon: string; command?: vscode.Command } {
    if (KBENGINE_TYPES.some(type => type.name === typeName)) {
      return {
        label: 'Built-in',
        icon: 'symbol-key'
      };
    }

    const customTypeEntry = findDefinitionEntryByCategory(typeName, 'type', workspaceRoot);
    if (customTypeEntry) {
      return {
        label: 'Type',
        icon: this.getCategoryIcon('type'),
        command: createOpenDefinitionCommand(customTypeEntry.filePath, customTypeEntry.line)
      };
    }

    const componentEntry = findDefinitionEntryByCategory(typeName, 'component', workspaceRoot);
    if (componentEntry) {
      return {
        label: 'Component',
        icon: this.getCategoryIcon('component'),
        command: createOpenDefinitionCommand(componentEntry.filePath, componentEntry.line)
      };
    }

    const entityEntry = findDefinitionEntryByCategory(typeName, 'entity', workspaceRoot);
    if (entityEntry) {
      return {
        label: 'Entity',
        icon: this.getCategoryIcon('entity'),
        command: createOpenDefinitionCommand(entityEntry.filePath, entityEntry.line)
      };
    }

    return {
      label: 'Unresolved',
      icon: 'warning'
    };
  }

  private resolveParentCategory(entry: DefinitionEntry): DefinitionCategory {
    return entry.category === 'component' ? 'component' : 'entity';
  }

  private getCategoryLabel(category: DefinitionCategory): string {
    switch (category) {
      case 'type':
        return 'Type';
      case 'entity':
        return 'Entity';
      case 'interface':
        return 'Interface';
      case 'component':
        return 'Component';
    }
  }

  private getCategoryIcon(category: DefinitionCategory): string {
    switch (category) {
      case 'type':
        return 'symbol-type-parameter';
      case 'entity':
        return 'symbol-class';
      case 'interface':
        return 'symbol-interface';
      case 'component':
        return 'extensions';
    }
  }

  private readDefinitionStats(defPath: string): DefinitionStats {
    try {
      return parseDefinitionStructure(fs.readFileSync(defPath, 'utf8'));
    } catch {
      return {
        properties: [],
        baseMethods: [],
        cellMethods: [],
        clientMethods: [],
        interfaces: [],
        components: []
      };
    }
  }
}

class ExplorerGroupItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly category: DefinitionCategory,
    count: number
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon(getGroupIcon(category));
    this.contextValue = `definition_group_${category}`;
  }
}

class DefinitionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly definition: DefinitionEntry,
    public readonly description: string,
    public readonly viewModel: DefinitionViewModel
  ) {
    super(definition.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(getDefinitionIcon(definition));
    this.contextValue = `definition_${definition.category}`;
    this.command = definition.exists ? createOpenDefinitionCommand(definition.filePath, definition.line) : undefined;
    this.tooltip = `${definition.name}\n${definition.filePath}`;
  }
}

class DefinitionSectionItem extends vscode.TreeItem {
  constructor(
    public readonly definition: DefinitionEntry,
    public readonly section: DefinitionSectionDescriptor
  ) {
    super(section.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = String(section.items.length);
    this.iconPath = new vscode.ThemeIcon(section.icon);
    this.contextValue = `definition_section_${definition.category}_${section.key}`;
  }
}

class DefinitionLeafItem extends vscode.TreeItem {
  constructor(public readonly item: DefinitionLeafDescriptor) {
    super(item.label, vscode.TreeItemCollapsibleState.None);
    this.description = item.description;
    this.iconPath = new vscode.ThemeIcon(item.icon);
    this.contextValue = 'definition_leaf';
    this.command = item.command;
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

function getGroupIcon(category: DefinitionCategory): string {
  switch (category) {
    case 'type':
      return 'symbol-type-parameter';
    case 'entity':
      return 'symbol-class';
    case 'interface':
      return 'symbol-interface';
    case 'component':
      return 'extensions';
  }
}

function getDefinitionIcon(entry: DefinitionEntry): string {
  if (!entry.exists) {
    return 'warning';
  }

  if (entry.category === 'entity' && !entry.registered) {
    return 'circle-outline';
  }

  return getGroupIcon(entry.category);
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

function createOpenDefinitionCommand(filePath: string, line?: number): vscode.Command {
  const uri = vscode.Uri.file(filePath);

  if (!line || line <= 0) {
    return {
      command: 'vscode.open',
      title: 'Open Definition',
      arguments: [uri]
    };
  }

  return {
    command: 'vscode.open',
    title: 'Open Definition',
    arguments: [
      uri,
      {
        selection: new vscode.Range(
          new vscode.Position(line - 1, 0),
          new vscode.Position(line - 1, 0)
        )
      }
    ]
  };
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
