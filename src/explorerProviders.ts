import * as path from 'path';
import * as vscode from 'vscode';

import { l10nText } from './nlsRuntime';
import { createDefinitionSemanticsLoader } from './backend/definitionSemantics';
import {
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
import { KBENGINE_TYPES } from './backend/kbengineMetadata';
import { KBEngineServerManager, SERVER_COMPONENTS, ServerStatus } from './serverManager';
import {
  ExplorerGroupItem,
  DefinitionTreeItem,
  DefinitionSectionItem,
  DefinitionGroupItem,
  DefinitionLeafItem,
  toMethodStats,
  toStatsFromProperties,
  createOpenDefinitionCommand
} from './explorerProvidersModel';
import type {
  EntityTreeNode,
  DefinitionStats,
  DefinitionMethodStats,
  DefinitionLeafDescriptor,
  DefinitionGroupDescriptor,
  DefinitionSectionDescriptor,
  DefinitionSummaryDescriptor,
  DefinitionViewModel,
  DatabaseSectionModel,
  InheritedDefinitionGroup,
  DefinitionHierarchyStats
} from './explorerProvidersModel';

/** 面板分类/分组标题走 vscode.l10n:调用期求值(语言切换即时生效),默认英文源串 */
// l10nText 自 ./nlsRuntime 共享实现导入(KODE-I18N-002):六面共用公共取词入口

/** 根分组计数快照(UX-REVIEW-011③:视图标题徽章数据源) */
export interface EntityExplorerRootCounts {
  types: number;
  entities: number;
  interfaces: number;
  components: number;
}

/**
 * UX-REVIEW-011③:视图标题徽章(合计>0 才挂——空项目挂 0 是噪音;
 * tooltip=四组明细,侧栏压缩态下仍外露「里面有东西」)。纯函数便于对账,
 * 宿主(views.ts)只做赋值。
 */
export function entityExplorerBadgeOf(
  counts: EntityExplorerRootCounts
): { value: number; tooltip: string } | null {
  const total = counts.types + counts.entities + counts.interfaces + counts.components;
  if (total <= 0) {
    return null;
  }
  return {
    value: total,
    tooltip: l10nText(
      'Entities {entities} · Types {types} · Interfaces {interfaces} · Components {components}',
      counts as unknown as Record<string, string | number>
    )
  };
}

export class EntityExplorerProvider implements vscode.TreeDataProvider<EntityTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<EntityTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /**
   * UX-REVIEW-011③:根分组每次实际渲染时回调计数快照;宿主(views.ts)
   * 据此设 TreeView.badge,侧栏压缩态下标题徽章仍外露「里面有东西」。
   * 计数只在 getRootGroups 真正执行时产生,不做急切扫描,零额外开销。
   */
  constructor(private readonly onRootCounts?: (counts: EntityExplorerRootCounts) => void) {}

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
            label: l10nText('Summary'),
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

      // 不可达(批72 定性):所有 DefinitionSectionDescriptor 构造点(buildDefinitionViewModel
// 与 buildDatabaseViewModel)均显式提供 items 数组(或 groups),从不留空。
// 故 element.section.items 恒为数组,`|| []` 兜底右臂无触发路径。
// 真臂行为由既有 explorerProvidersBranches.test.ts 子项展开用例锁定。
/* istanbul ignore start */
      return (element.section.items || []).map(item => new DefinitionLeafItem(item));
/* istanbul ignore stop */
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

    this.publishRootCounts({
      types: types.length,
      entities: entities.length,
      interfaces: interfaces.length,
      components: components.length
    });
    return [
      new ExplorerGroupItem(l10nText('Types'), 'type', types.length),
      new ExplorerGroupItem(l10nText('Entities'), 'entity', entities.length),
      new ExplorerGroupItem(l10nText('Interfaces'), 'interface', interfaces.length),
      new ExplorerGroupItem(l10nText('Components'), 'component', components.length)
    ];
  }

  /** 计数快照外发(构造期注入的宿主回调;无注入时为空操作) */
  private publishRootCounts(counts: EntityExplorerRootCounts): void {
    this.onRootCounts?.(counts);
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
        parts.push(l10nText('Python Missing'));
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
        parts.push(l10nText('Unregistered'));
      }
      return parts.join(', ');
    }

    return entry.exists ? path.basename(entry.filePath) : l10nText('Missing');
  }

  private buildDefinitionViewModel(
    workspaceRoot: string,
    entry: DefinitionEntry
  ): DefinitionViewModel {
    const relativePath = path.relative(workspaceRoot, entry.filePath) || entry.filePath;
    const summary: DefinitionSummaryDescriptor[] = [
      {
        label: l10nText('Definition'),
        value: relativePath,
        icon: 'go-to-file',
        command: entry.exists ? createOpenDefinitionCommand(entry.filePath, entry.line) : undefined
      },
      {
        label: l10nText('Category'),
        value: this.getCategoryLabel(entry.category),
        icon: this.getCategoryIcon(entry.category)
      }
    ];

    if (entry.category === 'entity') {
      const runtimeProfile = getEntityRuntimeProfile(entry.name, workspaceRoot);
      summary.push(
        { label: l10nText('Registered'), value: entry.registered ? l10nText('Yes') : l10nText('No'), icon: entry.registered ? 'check' : 'warning' },
        { label: 'Base', value: entry.hasBase ? l10nText('Yes') : l10nText('No'), icon: 'circle-filled' },
        { label: 'Cell', value: entry.hasCell ? l10nText('Yes') : l10nText('No'), icon: 'circle-filled' },
        { label: 'Client', value: entry.hasClient ? l10nText('Yes') : l10nText('No'), icon: 'circle-filled' }
      );

      if (runtimeProfile) {
        summary.push(
          { label: l10nText('Runtime'), value: runtimeProfile.runtimeLabel, icon: 'server-process' },
          { label: l10nText('Visibility'), value: runtimeProfile.visibilitySummary, icon: 'eye' },
          { label: l10nText('Registration'), value: runtimeProfile.registrationSummary, icon: 'symbol-event' }
        );
      }
    }

    if (entry.category === 'type') {
      summary.push(
        { label: l10nText('AliasType'), value: entry.aliasType || 'ALIAS', icon: 'symbol-key' },
        { label: 'Python', value: entry.pythonFilePath ? path.relative(workspaceRoot, entry.pythonFilePath) : l10nText('Missing'), icon: entry.pythonFilePath ? 'file-code' : 'warning' }
      );

      if (entry.implementedBy) {
        summary.push({ label: 'implementedBy', value: entry.implementedBy, icon: 'symbol-namespace' });
      }
    }

    if (!entry.exists) {
      summary.push({ label: l10nText('Status'), value: l10nText('Definition file not found'), icon: 'warning' });
      return { summary, sections: [] };
    }

    if (entry.category === 'type') {
      const sections: DefinitionSectionDescriptor[] = [];

      if (entry.rawValue) {
        sections.push({
          key: 'alias',
          label: l10nText('Alias'),
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
          label: l10nText('Properties'),
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
    const interfaceCount = stats.interfaces.length;
    const componentCount = stats.components.length;

    if (interfaceCount > 0) {
      summary.push({ label: l10nText('Interfaces'), value: String(interfaceCount), icon: 'symbol-interface' });
    }

    if (componentCount > 0) {
      summary.push({ label: 'Components', value: String(componentCount), icon: 'extensions' });
    }

    summary.push(
      { label: l10nText('Properties'), value: String(stats.properties.length + inheritedPropertyCount), icon: 'symbol-property' },
      {
        label: l10nText('Methods'),
        value: String(
          stats.baseMethods.length + stats.cellMethods.length + stats.clientMethods.length + inheritedMethodCount
        ),
        icon: 'symbol-method'
      }
    );

    if (inherited.length > 0) {
      summary.push({ label: l10nText('Mixed In'), value: String(inherited.length), icon: 'symbol-interface' });
    }

    if (exposedCount > 0) {
      summary.push({ label: l10nText('Exposed'), value: String(exposedCount), icon: 'radio-tower' });
    }

    if (databaseModel.section) {
      summary.push(
        { label: l10nText('DB Tables'), value: String(databaseModel.tableCount), icon: 'database' },
        { label: l10nText('DB Fields'), value: String(databaseModel.fieldCount), icon: 'symbol-field' }
      );
    }

    const sections: DefinitionSectionDescriptor[] = [];

    if (stats.parent) {
      sections.push({
        key: 'parent',
        label: l10nText('Parent'),
        icon: 'type-hierarchy-super',
        items: [this.createDefinitionReferenceItem(workspaceRoot, entry, stats.parent)]
      });
    }

    if (stats.interfaces.length > 0) {
      sections.push({
        key: 'interfaces',
        label: l10nText('Interfaces'),
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
          label: l10nText('Runtime'),
          icon: 'server-process',
          items: [
            {
              label: l10nText('Roles'),
              description: runtimeProfile.runtimeLabel,
              icon: 'server-process'
            },
            {
              label: l10nText('Visibility'),
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
        label: l10nText('Exposed'),
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
      description: entry.category === 'entity' ? l10nText('Property') : `${this.getCategoryLabel(entry.category)} ${l10nText('Property')}`,
      icon: 'symbol-property'
    }));
    const inheritedGroups = inherited
      .filter(group => group.properties.length > 0)
      .map(group => ({
        label: group.label,
        description: l10nText('Mixed In'),
        icon: 'symbol-interface',
        items: group.properties.map(name => ({
          label: name,
          description: l10nText('Mixed Property'),
          icon: 'symbol-property'
        }))
      }));

    if (inheritedGroups.length === 0) {
      if (ownItems.length === 0) {
        return null;
      }

      return {
        key: 'properties',
        label: l10nText('Properties'),
        icon: 'symbol-property',
        items: ownItems
      };
    }

    const groups: DefinitionGroupDescriptor[] = [];
    if (ownItems.length > 0) {
      groups.push({
        label: l10nText('Own'),
        description: l10nText('Declared Here'),
        icon: 'symbol-class',
        items: ownItems
      });
    }
    groups.push(...inheritedGroups);

    return {
      key: 'properties',
      label: l10nText('Properties'),
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
        label: l10nText('Own'),
        description: l10nText('Declared Here'),
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
        description: l10nText('Mixed In'),
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
          // AUD-055:根身份随命令入参贯穿,A/B 同名实体各开各根
          arguments: [entry.name, table.name, field.name, workspaceRoot]
        }
      }))
    }));

    return {
      tableCount: snapshot.tables.length,
      fieldCount: snapshot.tables.reduce((sum, table) => sum + table.fields.length, 0),
      section: {
        key: 'database',
        label: l10nText('Database'),
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
        description: l10nText(section),
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
        description: l10nText('Mixed In'),
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
        label: l10nText(section),
        icon,
        items: localMethods.map(method => this.createMethodItem(entry, method, section))
      };
    }

    const groups: DefinitionGroupDescriptor[] = [];
    if (localMethods.length > 0) {
      groups.push({
        label: l10nText('Own'),
        description: l10nText('Declared Here'),
        icon: 'symbol-class',
        items: localMethods.map(method => this.createMethodItem(entry, method, section))
      });
    }
    groups.push(...inheritedGroups);

    // 不可达(批62 定性):上方 `inheritedGroups.length === 0` 已早退,走到这里
    // groups 至少含一个继承组,长度不可能为 0。
    /* istanbul ignore start */
    if (groups.length === 0) {
      return null;
    }
    /* istanbul ignore stop */

    return {
      key: section,
      label: l10nText(section),
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
      description: method.exposed ? `${l10nText(section)} · ${l10nText('Exposed')}` : l10nText(section),
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
        arguments: [method.identity || {
          ownerKind: entry.category === 'entity' ? 'entity' : 'interface',
          ownerName: entry.name,
          sourceKind: 'local',
          sourceChain: [],
          section,
          symbolName: method.name
        }]
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
        label: l10nText('Built-in'),
        icon: 'symbol-key'
      };
    }

    const customTypeEntry = findDefinitionEntryByCategory(typeName, 'type', workspaceRoot);
    if (customTypeEntry) {
      return {
        label: l10nText('Type'),
        icon: this.getCategoryIcon('type'),
        command: createOpenDefinitionCommand(customTypeEntry.filePath, customTypeEntry.line)
      };
    }

    const componentEntry = findDefinitionEntryByCategory(typeName, 'component', workspaceRoot);
    if (componentEntry) {
      return {
        label: l10nText('Component'),
        icon: this.getCategoryIcon('component'),
        command: createOpenDefinitionCommand(componentEntry.filePath, componentEntry.line)
      };
    }

    const entityEntry = findDefinitionEntryByCategory(typeName, 'entity', workspaceRoot);
    if (entityEntry) {
      return {
        label: l10nText('Entity'),
        icon: this.getCategoryIcon('entity'),
        command: createOpenDefinitionCommand(entityEntry.filePath, entityEntry.line)
      };
    }

    return {
      label: l10nText('Unresolved'),
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
      return facet.enabled ? l10nText('Declared On') : l10nText('Declared Off');
    }

    if (facet.scriptExists) {
      return facet.enabled ? l10nText('Inferred From Script') : l10nText('Script Present');
    }

    return l10nText('Not Declared');
  }

  private getCategoryLabel(category: DefinitionCategory): string {
    switch (category) {
      case 'type':
        return l10nText('Type');
      case 'entity':
        return l10nText('Entity');
      case 'interface':
        return l10nText('Interface');
      case 'component':
        return l10nText('Component');
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
      const loader = createDefinitionSemanticsLoader(defPath);
      if (!loader) {
        throw new Error('workspace root missing');
      }

      const name = path.basename(defPath, '.def');
      const normalized = defPath.replace(/\\/g, '/').toLowerCase();
      const category: DefinitionCategory = normalized.includes('/interfaces/')
        ? 'interface'
        : normalized.includes('/components/')
          ? 'component'
          : 'entity';
      const local = loader.loadLocal(name, category);
      if (!local) {
        throw new Error('definition semantics missing');
      }

      return {
        properties: toStatsFromProperties(local.properties),
        baseMethods: local.methodsBySection.BaseMethods.map(toMethodStats),
        cellMethods: local.methodsBySection.CellMethods.map(toMethodStats),
        clientMethods: local.methodsBySection.ClientMethods.map(toMethodStats),
        parent: local.parentName,
        interfaces: local.interfaces.map(item => item.name),
        components: local.components.map(component => ({
          propertyName: component.slotName,
          typeName: component.typeName
        }))
      };
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
    const loader = createDefinitionSemanticsLoader(workspaceRoot);
    if (!loader) {
      return {
        local: this.readDefinitionStats(entry.filePath),
        inherited: []
      };
    }

    const category = entry.category === 'component' ? 'component' : entry.category === 'interface' ? 'interface' : 'entity';
    const resolved = loader.loadResolved(entry.name, category, true);
    if (!resolved) {
      return {
        local: this.readDefinitionStats(entry.filePath),
        inherited: []
      };
    }

    return {
      local: {
        properties: toStatsFromProperties(resolved.local.properties),
        baseMethods: resolved.local.methodsBySection.BaseMethods.map(toMethodStats),
        cellMethods: resolved.local.methodsBySection.CellMethods.map(toMethodStats),
        clientMethods: resolved.local.methodsBySection.ClientMethods.map(toMethodStats),
        parent: resolved.local.parentName,
        interfaces: resolved.local.interfaces.map(item => item.name),
        components: resolved.local.components.map(component => ({
          propertyName: component.slotName,
          typeName: component.typeName
        }))
      },
      inherited: resolved.inheritanceGroups.map(group => ({
        label: group.label,
        properties: toStatsFromProperties(group.properties),
        baseMethods: group.methodsBySection.BaseMethods.map(toMethodStats),
        cellMethods: group.methodsBySection.CellMethods.map(toMethodStats),
        clientMethods: group.methodsBySection.ClientMethods.map(toMethodStats)
      }))
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
      this.description = l10nText('Starting...');
    } else if (status === ServerStatus.Stopping) {
      this.description = l10nText('Stopping...');
    } else if (status === ServerStatus.Error) {
      this.description = l10nText('Error');
    }

    this.tooltip = `${component.displayName}\n${component.description}\n${l10nText('Status: {state}', { state: status })}`;
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

    // 批112 用户令:telnet 状态灯移出本树(独立视图 kbengine.telnetStatus,
    // 见 src/telnetTree.ts),本树只列 server 进程
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

export { parseDefinitionStructure } from './explorerProvidersModel';
export type {
  EntityTreeNode,
  DefinitionStats,
  DefinitionMethodStats,
  DefinitionLeafDescriptor,
  DefinitionGroupDescriptor,
  DefinitionSectionDescriptor,
  DefinitionSummaryDescriptor,
  DefinitionViewModel,
  DatabaseSectionModel,
  InheritedDefinitionGroup,
  DefinitionHierarchyStats
} from './explorerProvidersModel';

