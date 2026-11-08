import * as vscode from 'vscode';

import {
  DefinitionMethod,
  DefinitionProperty,
  parseLocalDefinition
} from './definitionSemantics';
import { DefinitionCategory, DefinitionEntry } from './definitionWorkspace';
import { DefinitionSymbolIdentity } from './entityMapping';

export type EntityTreeNode =
  | ExplorerGroupItem
  | DefinitionTreeItem
  | DefinitionSectionItem
  | DefinitionGroupItem
  | DefinitionLeafItem;

export interface DefinitionStats {
  properties: string[];
  baseMethods: DefinitionMethodStats[];
  cellMethods: DefinitionMethodStats[];
  clientMethods: DefinitionMethodStats[];
  parent?: string;
  interfaces: string[];
  components: Array<{ propertyName: string; typeName: string }>;
}

export interface DefinitionMethodStats {
  name: string;
  exposed: boolean;
  identity?: DefinitionSymbolIdentity;
}

export interface DefinitionLeafDescriptor {
  label: string;
  description: string;
  icon: string;
  command?: vscode.Command;
}

export interface DefinitionGroupDescriptor {
  label: string;
  description?: string;
  icon: string;
  items: DefinitionLeafDescriptor[];
}

export interface DefinitionSectionDescriptor {
  key: string;
  label: string;
  icon: string;
  items?: DefinitionLeafDescriptor[];
  groups?: DefinitionGroupDescriptor[];
}

export interface DefinitionSummaryDescriptor {
  label: string;
  value: string;
  icon: string;
  command?: vscode.Command;
}

export interface DefinitionViewModel {
  summary: DefinitionSummaryDescriptor[];
  sections: DefinitionSectionDescriptor[];
}

export interface DatabaseSectionModel {
  tableCount: number;
  fieldCount: number;
  section?: DefinitionSectionDescriptor;
}

export interface InheritedDefinitionGroup {
  label: string;
  properties: string[];
  baseMethods: DefinitionMethodStats[];
  cellMethods: DefinitionMethodStats[];
  clientMethods: DefinitionMethodStats[];
}

export interface DefinitionHierarchyStats {
  local: DefinitionStats;
  inherited: InheritedDefinitionGroup[];
}

export function toMethodStats(method: DefinitionMethod): DefinitionMethodStats {
  return {
    name: method.name,
    exposed: method.exposed,
    identity: {
      ownerKind: method.owner.kind,
      ownerName: method.owner.name,
      sourceKind: method.source.kind,
      sourceChain: [...method.source.chain],
      section: method.section,
      symbolName: method.name
    }
  };
}

function flattenProperties(properties: DefinitionProperty[]): DefinitionProperty[] {
  const flattened: DefinitionProperty[] = [];
  const visit = (property: DefinitionProperty) => {
    flattened.push(property);
    for (const child of property.children) {
      visit(child);
    }
    if (property.arrayElement) {
      visit(property.arrayElement);
    }
  };

  for (const property of properties) {
    visit(property);
  }

  return flattened;
}

export function toStatsFromProperties(properties: DefinitionProperty[]): string[] {
  return flattenProperties(properties)
    .filter(property => !property.fullPath.includes('.') && !property.fullPath.includes('[]'))
    .map(property => property.name);
}

export function parseDefinitionStructure(content: string): DefinitionStats {
  const local = parseLocalDefinition(content, 'entity', 'Anonymous', '/tmp/Anonymous.def');

  return {
    properties: local.properties
      .filter(property => !property.fullPath.includes('.'))
      .map(property => property.name),
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
}

export class ExplorerGroupItem extends vscode.TreeItem {
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

export class DefinitionTreeItem extends vscode.TreeItem {
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

export class DefinitionSectionItem extends vscode.TreeItem {
  constructor(
    public readonly definition: DefinitionEntry,
    public readonly section: DefinitionSectionDescriptor
  ) {
    super(section.label, vscode.TreeItemCollapsibleState.Collapsed);
    // 不可达(批72 定性):所有 DefinitionSectionDescriptor 构造点均显式提供
// items 数组(或 groups),从不两者皆空。故 section.items?.length 恒为数字,
// 末级 `?? 0` 兜底右臂无触发路径。真臂行为由既有
// explorerProvidersBranches.test.ts 描述行渲染用例锁定。
/* istanbul ignore start */
    this.description = String(section.groups?.length ?? section.items?.length ?? 0);
/* istanbul ignore stop */
    this.iconPath = new vscode.ThemeIcon(section.icon);
    this.contextValue = `definition_section_${definition.category}_${section.key}`;
  }
}

export class DefinitionGroupItem extends vscode.TreeItem {
  constructor(public readonly group: DefinitionGroupDescriptor) {
    super(group.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = group.description;
    this.iconPath = new vscode.ThemeIcon(group.icon);
    this.contextValue = 'definition_group_item';
  }
}

export class DefinitionLeafItem extends vscode.TreeItem {
  constructor(public readonly item: DefinitionLeafDescriptor) {
    super(item.label, vscode.TreeItemCollapsibleState.None);
    this.description = item.description;
    this.iconPath = new vscode.ThemeIcon(item.icon);
    this.contextValue = 'definition_leaf';
    this.command = item.command;
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

export function createOpenDefinitionCommand(filePath: string, line?: number): vscode.Command {
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

