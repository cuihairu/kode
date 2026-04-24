import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getDirectChildElement,
  getDirectChildElements,
  getElementText,
  hasTruthyChildTag,
  parseDefDocument
} from './defParser';
import {
  createDatabaseSchemaUri,
  getDatabaseSchemaSnapshot
} from './databaseSchema';
import {
  CustomTypeStructureNode,
  DefinitionCategory,
  DefinitionEntry,
  getEntityRuntimeProfile,
  findDefinitionEntryByCategory,
  findDefinitionFileByCategory,
  getDefinitionEntries,
  getWorkspaceRootForDocument
} from './definitionWorkspace';
import { EntityMethodSection } from './entityMapping';
import { KBENGINE_TYPES } from './kbengineMetadata';
import { KBEngineServerManager, SERVER_COMPONENTS, ServerStatus } from './serverManager';

type EntityTreeNode =
  | ExplorerGroupItem
  | DefinitionTreeItem
  | DefinitionSectionItem
  | DefinitionGroupItem
  | DefinitionLeafItem;

interface DefinitionStats {
  properties: string[];
  baseMethods: DefinitionMethodStats[];
  cellMethods: DefinitionMethodStats[];
  clientMethods: DefinitionMethodStats[];
  parent?: string;
  interfaces: string[];
  components: Array<{ propertyName: string; typeName: string }>;
}

interface DefinitionMethodStats {
  name: string;
  exposed: boolean;
}

interface DefinitionLeafDescriptor {
  label: string;
  description: string;
  icon: string;
  command?: vscode.Command;
}

interface DefinitionGroupDescriptor {
  label: string;
  description?: string;
  icon: string;
  items: DefinitionLeafDescriptor[];
}

interface DefinitionSectionDescriptor {
  key: string;
  label: string;
  icon: string;
  items?: DefinitionLeafDescriptor[];
  groups?: DefinitionGroupDescriptor[];
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

interface DatabaseSectionModel {
  tableCount: number;
  fieldCount: number;
  section?: DefinitionSectionDescriptor;
}

interface InheritedDefinitionGroup {
  label: string;
  properties: string[];
  baseMethods: DefinitionMethodStats[];
  cellMethods: DefinitionMethodStats[];
  clientMethods: DefinitionMethodStats[];
}

interface DefinitionHierarchyStats {
  local: DefinitionStats;
  inherited: InheritedDefinitionGroup[];
}

export function parseDefinitionStructure(content: string): DefinitionStats {
  const document = parseDefDocument(content);
  const root = document.root;

  if (!root) {
    return {
      properties: [],
      baseMethods: [],
      cellMethods: [],
      clientMethods: [],
      interfaces: [],
      components: []
    };
  }

  const extractMethods = (sectionName: EntityMethodSection): DefinitionMethodStats[] => {
    const sectionNode = getDirectChildElement(root, sectionName);
    if (!sectionNode) {
      return [];
    }

    return getDirectChildElements(sectionNode).map(methodNode => ({
      name: methodNode.name,
      exposed: hasTruthyChildTag(methodNode, 'Exposed')
    }));
  };

  const parentName = getDirectChildElements(getDirectChildElement(root, 'Parent'))[0]?.name;
  const interfacesNode = getDirectChildElement(root, 'Interfaces');
  const interfaceNames = getDirectChildElements(interfacesNode)
    .flatMap(interfaceWrapper => getDirectChildElements(interfaceWrapper).map(item => item.name));

  const componentsNode = getDirectChildElement(root, 'Components');
  const components = getDirectChildElements(componentsNode)
    .map(componentNode => ({
      propertyName: componentNode.name,
      typeName: getElementText(getDirectChildElement(componentNode, 'Type')).trim()
    }))
    .filter(component => component.typeName);

  const propertiesNode = getDirectChildElement(root, 'Properties');
  const properties = getDirectChildElements(propertiesNode)
    .filter(propertyNode => !!getDirectChildElement(propertyNode, 'Type'))
    .map(propertyNode => propertyNode.name);

  return {
    properties,
    baseMethods: extractMethods('BaseMethods'),
    cellMethods: extractMethods('CellMethods'),
    clientMethods: extractMethods('ClientMethods'),
    parent: parentName,
    interfaces: interfaceNames,
    components
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
      if (element.section.groups?.length) {
        return element.section.groups.map(group => new DefinitionGroupItem(group));
      }

      return (element.section.items || []).map(item => new DefinitionLeafItem(item));
    }

    if (element instanceof DefinitionGroupItem) {
      return element.group.items.map(item => new DefinitionLeafItem(item));
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
      const description = this.buildDefinitionDescription(workspaceRoot, entry);
      const viewModel = this.buildDefinitionViewModel(workspaceRoot, entry);
      return new DefinitionTreeItem(entry, description, viewModel);
    });
  }

  private buildDefinitionDescription(workspaceRoot: string, entry: DefinitionEntry): string {
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
      const runtimeProfile = getEntityRuntimeProfile(entry.name, workspaceRoot);
      const parts: string[] = [];
      if (runtimeProfile?.runtimeLabel) {
        parts.push(runtimeProfile.runtimeLabel);
      } else {
        if (entry.hasBase) {
          parts.push('Base');
        }
        if (entry.hasCell) {
          parts.push('Cell');
        }
        if (entry.hasClient) {
          parts.push('Client');
        }
      }
      if (runtimeProfile) {
        parts.push(runtimeProfile.visibilityLabel);
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
      const runtimeProfile = getEntityRuntimeProfile(entry.name, workspaceRoot);
      summary.push(
        { label: 'Registered', value: entry.registered ? 'Yes' : 'No', icon: entry.registered ? 'check' : 'warning' },
        { label: 'Base', value: entry.hasBase ? 'Yes' : 'No', icon: 'circle-filled' },
        { label: 'Cell', value: entry.hasCell ? 'Yes' : 'No', icon: 'circle-filled' },
        { label: 'Client', value: entry.hasClient ? 'Yes' : 'No', icon: 'circle-filled' }
      );

      if (runtimeProfile) {
        summary.push(
          { label: 'Runtime', value: runtimeProfile.runtimeLabel, icon: 'server-process' },
          { label: 'Visibility', value: runtimeProfile.visibilitySummary, icon: 'eye' },
          { label: 'Registration', value: runtimeProfile.registrationSummary, icon: 'symbol-event' }
        );
      }
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

    const hierarchyStats = this.readDefinitionHierarchyStats(workspaceRoot, entry);
    const databaseModel = entry.category === 'entity'
      ? this.createDatabaseSectionModel(workspaceRoot, entry)
      : { tableCount: 0, fieldCount: 0 } as DatabaseSectionModel;
    const stats = hierarchyStats.local;
    const inherited = hierarchyStats.inherited;
    const inheritedPropertyCount = inherited.reduce((sum, group) => sum + group.properties.length, 0);
    const inheritedMethodCount = inherited.reduce(
      (sum, group) => sum + group.baseMethods.length + group.cellMethods.length + group.clientMethods.length,
      0
    );
    const exposedGroups = this.createExposedSectionGroups(entry, inherited, stats);
    const exposedCount = exposedGroups.reduce((sum, group) => sum + group.items.length, 0);
    summary.push(
      { label: 'Properties', value: String(stats.properties.length + inheritedPropertyCount), icon: 'symbol-property' },
      {
        label: 'Methods',
        value: String(
          stats.baseMethods.length + stats.cellMethods.length + stats.clientMethods.length + inheritedMethodCount
        ),
        icon: 'symbol-method'
      }
    );

    if (inherited.length > 0) {
      summary.push({ label: 'Mixed In', value: String(inherited.length), icon: 'symbol-interface' });
    }

    if (exposedCount > 0) {
      summary.push({ label: 'Exposed', value: String(exposedCount), icon: 'radio-tower' });
    }

    if (databaseModel.section) {
      summary.push(
        { label: 'DB Tables', value: String(databaseModel.tableCount), icon: 'database' },
        { label: 'DB Fields', value: String(databaseModel.fieldCount), icon: 'symbol-field' }
      );
    }

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

    if (entry.category === 'entity') {
      const runtimeProfile = getEntityRuntimeProfile(entry.name, workspaceRoot);
      if (runtimeProfile) {
        sections.push({
          key: 'runtime',
          label: 'Runtime',
          icon: 'server-process',
          items: [
            {
              label: 'Roles',
              description: runtimeProfile.runtimeLabel,
              icon: 'server-process'
            },
            {
              label: 'Visibility',
              description: runtimeProfile.visibilityLabel,
              icon: runtimeProfile.client.enabled ? 'device-desktop' : 'vm'
            },
            {
              label: 'BaseApp',
              description: this.describeRuntimeFacet(runtimeProfile.base),
              icon: 'symbol-class'
            },
            {
              label: 'CellApp',
              description: this.describeRuntimeFacet(runtimeProfile.cell),
              icon: 'symbol-class'
            },
            {
              label: 'Client',
              description: this.describeRuntimeFacet(runtimeProfile.client),
              icon: 'device-desktop'
            }
          ]
        });
      }
    }

    if (exposedGroups.length > 0) {
      sections.push({
        key: 'exposed',
        label: 'Exposed',
        icon: 'radio-tower',
        groups: exposedGroups
      });
    }

    if (databaseModel.section) {
      sections.push(databaseModel.section);
    }

    const propertySection = this.createPropertySectionDescriptor(entry, inherited, stats);
    if (propertySection) {
      sections.push(propertySection);
    }

    const methodSections: Array<{ label: EntityMethodSection; values: DefinitionMethodStats[]; icon: string }> = [
      { label: 'BaseMethods', values: stats.baseMethods, icon: 'symbol-method' },
      { label: 'CellMethods', values: stats.cellMethods, icon: 'symbol-method' },
      { label: 'ClientMethods', values: stats.clientMethods, icon: 'symbol-method' }
    ];

    for (const section of methodSections) {
      const methodSection = this.createMethodSectionDescriptor(entry, section.label, section.icon, inherited, stats);
      if (methodSection) {
        sections.push(methodSection);
      }
    }

    return { summary, sections };
  }

  private createPropertySectionDescriptor(
    entry: DefinitionEntry,
    inherited: InheritedDefinitionGroup[],
    stats: DefinitionStats
  ): DefinitionSectionDescriptor | null {
    const ownItems = stats.properties.map(name => ({
      label: name,
      description: entry.category === 'entity' ? 'Property' : `${this.getCategoryLabel(entry.category)} Property`,
      icon: 'symbol-property'
    }));
    const inheritedGroups = inherited
      .filter(group => group.properties.length > 0)
      .map(group => ({
        label: group.label,
        description: 'Mixed In',
        icon: 'symbol-interface',
        items: group.properties.map(name => ({
          label: name,
          description: 'Mixed Property',
          icon: 'symbol-property'
        }))
      }));

    if (inheritedGroups.length === 0) {
      if (ownItems.length === 0) {
        return null;
      }

      return {
        key: 'properties',
        label: 'Properties',
        icon: 'symbol-property',
        items: ownItems
      };
    }

    const groups: DefinitionGroupDescriptor[] = [];
    if (ownItems.length > 0) {
      groups.push({
        label: 'Own',
        description: 'Declared Here',
        icon: 'symbol-class',
        items: ownItems
      });
    }
    groups.push(...inheritedGroups);

    return {
      key: 'properties',
      label: 'Properties',
      icon: 'symbol-property',
      groups
    };
  }

  private createExposedSectionGroups(
    entry: DefinitionEntry,
    inherited: InheritedDefinitionGroup[],
    stats: DefinitionStats
  ): DefinitionGroupDescriptor[] {
    const groups: DefinitionGroupDescriptor[] = [];
    const ownItems = this.createExposedItems(entry, 'Own', stats.baseMethods, 'BaseMethods')
      .concat(this.createExposedItems(entry, 'Own', stats.cellMethods, 'CellMethods'));

    if (ownItems.length > 0) {
      groups.push({
        label: 'Own',
        description: 'Declared Here',
        icon: 'symbol-class',
        items: ownItems
      });
    }

    for (const group of inherited) {
      const items = this.createExposedItems(entry, group.label, group.baseMethods, 'BaseMethods')
        .concat(this.createExposedItems(entry, group.label, group.cellMethods, 'CellMethods'));
      if (items.length === 0) {
        continue;
      }

      groups.push({
        label: group.label,
        description: 'Mixed In',
        icon: 'symbol-interface',
        items
      });
    }

    return groups;
  }

  private createDatabaseSectionModel(
    workspaceRoot: string,
    entry: DefinitionEntry
  ): DatabaseSectionModel {
    const snapshot = getDatabaseSchemaSnapshot(entry.name, workspaceRoot);
    if (!snapshot || snapshot.tables.length === 0) {
      return {
        tableCount: 0,
        fieldCount: 0
      };
    }

    const groups: DefinitionGroupDescriptor[] = snapshot.tables.map(table => ({
      label: table.name,
      description: table.parentTableName ? `${table.kind} -> ${table.parentTableName}` : table.kind,
      icon: table.kind === 'entity' ? 'database' : 'table',
      items: table.fields.map(field => ({
        label: field.name,
        description: `${field.typeLabel} -> ${field.sourcePath}`,
        icon: 'symbol-field',
        command: {
          command: 'kbengine.database.open',
          title: 'Open Database Schema',
          arguments: [entry.name, table.name, field.name]
        }
      }))
    }));

    return {
      tableCount: snapshot.tables.length,
      fieldCount: snapshot.tables.reduce((sum, table) => sum + table.fields.length, 0),
      section: {
        key: 'database',
        label: 'Database',
        icon: 'database',
        groups
      }
    };
  }

  private createExposedItems(
    entry: DefinitionEntry,
    sourceLabel: string,
    methods: DefinitionMethodStats[],
    section: EntityMethodSection
  ): DefinitionLeafDescriptor[] {
    return methods
      .filter(method => method.exposed)
      .map(method => ({
        label: method.name,
        description: section,
        icon: 'radio-tower',
        command: this.createMethodCommand(entry, method, section)
      }));
  }

  private createMethodSectionDescriptor(
    entry: DefinitionEntry,
    section: EntityMethodSection,
    icon: string,
    inherited: InheritedDefinitionGroup[],
    stats: DefinitionStats
  ): DefinitionSectionDescriptor | null {
    const localMethods = this.filterSectionMethods(stats, section).filter(method => !method.exposed);
    const inheritedGroups = inherited
      .map(group => ({
        label: group.label,
        description: 'Mixed In',
        icon: 'symbol-interface',
        items: this.filterSectionMethods(group, section)
          .filter(method => !method.exposed)
          .map(method => this.createMethodItem(entry, method, section))
      }))
      .filter(group => group.items.length > 0);

    if (inheritedGroups.length === 0) {
      if (localMethods.length === 0) {
        return null;
      }

      return {
        key: section,
        label: section,
        icon,
        items: localMethods.map(method => this.createMethodItem(entry, method, section))
      };
    }

    const groups: DefinitionGroupDescriptor[] = [];
    if (localMethods.length > 0) {
      groups.push({
        label: 'Own',
        description: 'Declared Here',
        icon: 'symbol-class',
        items: localMethods.map(method => this.createMethodItem(entry, method, section))
      });
    }
    groups.push(...inheritedGroups);

    if (groups.length === 0) {
      return null;
    }

    return {
      key: section,
      label: section,
      icon,
      groups
    };
  }

  private filterSectionMethods(
    stats: Pick<DefinitionStats, 'baseMethods' | 'cellMethods' | 'clientMethods'>
      | Pick<InheritedDefinitionGroup, 'baseMethods' | 'cellMethods' | 'clientMethods'>,
    section: EntityMethodSection
  ): DefinitionMethodStats[] {
    switch (section) {
      case 'BaseMethods':
        return stats.baseMethods;
      case 'CellMethods':
        return stats.cellMethods;
      case 'ClientMethods':
        return stats.clientMethods;
    }
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

  private createMethodItem(
    entry: DefinitionEntry,
    method: DefinitionMethodStats,
    section: EntityMethodSection
  ): DefinitionLeafDescriptor {
    return {
      label: method.name,
      description: method.exposed ? `${section} · Exposed` : section,
      icon: method.exposed ? 'radio-tower' : 'symbol-method',
      command: this.createMethodCommand(entry, method, section)
    };
  }

  private createMethodCommand(
    entry: DefinitionEntry,
    method: DefinitionMethodStats,
    section: EntityMethodSection
  ): vscode.Command | undefined {
    return entry.category === 'entity' || entry.category === 'interface'
      ? {
        command: 'kbengine.entity.method.open',
        title: 'Open Entity Method',
        arguments: [entry.name, method.name, section]
      }
      : createOpenDefinitionCommand(entry.filePath, entry.line);
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

  private describeRuntimeFacet(
    facet: {
      enabled: boolean;
      declared: boolean;
      scriptExists: boolean;
    }
  ): string {
    if (facet.declared) {
      return facet.enabled ? 'Declared On' : 'Declared Off';
    }

    if (facet.scriptExists) {
      return facet.enabled ? 'Inferred From Script' : 'Script Present';
    }

    return 'Not Declared';
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

  private readDefinitionHierarchyStats(
    workspaceRoot: string,
    entry: DefinitionEntry
  ): DefinitionHierarchyStats {
    const local = this.readDefinitionStats(entry.filePath);
    if (entry.category !== 'entity' && entry.category !== 'interface') {
      return { local, inherited: [] };
    }

    return {
      local,
      inherited: this.collectInheritedDefinitionGroups(workspaceRoot, local.interfaces, [])
    };
  }

  private collectInheritedDefinitionGroups(
    workspaceRoot: string,
    interfaceNames: string[],
    chain: string[],
    visited = new Set<string>()
  ): InheritedDefinitionGroup[] {
    const groups: InheritedDefinitionGroup[] = [];

    for (const interfaceName of interfaceNames) {
      const interfacePath = findDefinitionFileByCategory(interfaceName, 'interface', workspaceRoot);
      if (!interfacePath) {
        continue;
      }

      const normalizedPath = interfacePath.replace(/\\/g, '/').toLowerCase();
      if (visited.has(normalizedPath)) {
        continue;
      }
      visited.add(normalizedPath);

      const stats = this.readDefinitionStats(interfacePath);
      const nextChain = [...chain, interfaceName];
      groups.push({
        label: `Mixin · ${nextChain.join(' / ')}`,
        properties: stats.properties,
        baseMethods: stats.baseMethods,
        cellMethods: stats.cellMethods,
        clientMethods: stats.clientMethods
      });

      groups.push(...this.collectInheritedDefinitionGroups(
        workspaceRoot,
        stats.interfaces,
        nextChain,
        visited
      ));
    }

    return groups;
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
    this.description = String(section.groups?.length ?? section.items?.length ?? 0);
    this.iconPath = new vscode.ThemeIcon(section.icon);
    this.contextValue = `definition_section_${definition.category}_${section.key}`;
  }
}

class DefinitionGroupItem extends vscode.TreeItem {
  constructor(public readonly group: DefinitionGroupDescriptor) {
    super(group.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = group.description;
    this.iconPath = new vscode.ThemeIcon(group.icon);
    this.contextValue = 'definition_group_item';
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
