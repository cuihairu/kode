import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  DefElementNode,
  getDirectChildElement,
  getDirectChildElements,
  getLineNumberAt,
  getScalarChildValue,
  hasTruthyChildTag,
  parseDefDocument
} from './defParser';
import {
  DefinitionCategory,
  findDefinitionFileByCategory,
  findEntityDefinitionFile,
  getDefinitionWorkspaceLayout,
  getRegisteredEntities,
  getWorkspaceRootForDocument
} from './definitionWorkspace';

export const KBENGINE_DATABASE_SCHEMA_SCHEME = 'kbengine-db-schema';
const DB_TABLE_PREFIX = 'tbl_';
const DB_COLUMN_PREFIX = 'sm_';

type RuntimeScope = 'base' | 'cell' | 'client';
type DatabaseBackend = 'mysql' | 'redis';

interface RuntimeAvailability {
  hasBase: boolean;
  hasCell: boolean;
  hasClient: boolean;
}

interface DefSourceRef {
  filePath: string;
  line: number;
  path: string;
  category: DefinitionCategory;
}

interface PersistentPropertyDescriptor {
  name: string;
  typeName: string;
  persistent: boolean;
  databaseLength?: number;
  identifier: boolean;
  indexType?: string;
  flags?: string;
  scopes: RuntimeScope[];
  source: DefSourceRef;
  children?: PersistentPropertyDescriptor[];
  arrayElement?: PersistentPropertyDescriptor;
  componentTypeName?: string;
}

interface TableFieldDescriptor {
  name: string;
  typeLabel: string;
  sourcePath: string;
  source: DefSourceRef;
  databaseLength?: number;
  indexType?: string;
  identifier: boolean;
  flags?: string;
}

interface TableSchemaDescriptor {
  name: string;
  kind: 'entity' | 'array' | 'component';
  title: string;
  source: DefSourceRef;
  parentTableName?: string;
  propertyPath?: string;
  fields: TableFieldDescriptor[];
}

export interface DatabaseSchemaSnapshot {
  backend: DatabaseBackend;
  entityName: string;
  entitySource?: DefSourceRef;
  defFilePath?: string;
  tables: TableSchemaDescriptor[];
  tableIndex: Map<string, TableSchemaDescriptor>;
}

interface BuildContext {
  workspaceRoot: string;
  entityDefsRoot: string;
  visitedDefinitions: Set<string>;
  componentCache: Map<string, PersistentPropertyDescriptor[]>;
}

const FLAG_SCOPE_MAP: Record<string, RuntimeScope[]> = {
  BASE: ['base'],
  BASE_AND_CLIENT: ['base', 'client'],
  CELL_PUBLIC: ['cell'],
  CELL_PRIVATE: ['cell'],
  ALL_CLIENTS: ['cell', 'client'],
  CELL_PUBLIC_AND_OWN: ['cell', 'client'],
  OWN_CLIENT: ['cell', 'client'],
  OTHER_CLIENTS: ['cell', 'client'],
  CELL_AND_CLIENT: ['cell', 'client'],
  CELL_AND_CLIENTS: ['cell', 'client'],
  CELL_AND_OTHER_CLIENTS: ['cell', 'client']
};

const SIMPLE_DB_TYPE_LABELS: Record<string, string> = {
  INT8: 'tinyint',
  INT16: 'smallint',
  INT32: 'int',
  INT64: 'bigint',
  UINT8: 'tinyint unsigned',
  UINT16: 'smallint unsigned',
  UINT32: 'int unsigned',
  UINT64: 'bigint unsigned',
  FLOAT: 'float',
  DOUBLE: 'double',
  STRING: 'varchar',
  UNICODE: 'varchar',
  PYTHON: 'blob',
  PY_DICT: 'blob',
  PY_TUPLE: 'blob',
  PY_LIST: 'blob',
  BLOB: 'blob',
  ENTITYCALL: 'blob'
};

export class KBEngineDatabaseSchemaProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const entityName = decodeURIComponent(uri.path.replace(/^\/+/, '').replace(/\.schema$/, ''));
    const snapshot = getDatabaseSchemaSnapshot(entityName);
    return renderDatabaseSchema(snapshot);
  }

  refresh(entityName?: string): void {
    if (!entityName) {
      return;
    }

    this.onDidChangeEmitter.fire(createDatabaseSchemaUri(entityName));
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

export function createDatabaseSchemaUri(entityName: string): vscode.Uri {
  return vscode.Uri.parse(`${KBENGINE_DATABASE_SCHEMA_SCHEME}:/${encodeURIComponent(entityName)}.schema`);
}

export function isDatabaseSchemaDocument(document: Pick<vscode.TextDocument, 'uri'>): boolean {
  return document.uri.scheme === KBENGINE_DATABASE_SCHEMA_SCHEME;
}

export function getDatabaseSchemaSnapshot(
  entityName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): DatabaseSchemaSnapshot | null {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);

  if (!workspaceRoot) {
    return null;
  }

  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  if (!layout.entityDefsRoot) {
    return null;
  }

  const defFilePath = findEntityDefinitionFile(entityName, target);
  if (!defFilePath) {
    return null;
  }

  const entityContent = readTextDocument(defFilePath);
  if (!entityContent) {
    return null;
  }

  const entityDocument = parseDefDocument(entityContent);
  if (!entityDocument.root) {
    return null;
  }

  const buildContext: BuildContext = {
    workspaceRoot,
    entityDefsRoot: layout.entityDefsRoot,
    visitedDefinitions: new Set<string>(),
    componentCache: new Map<string, PersistentPropertyDescriptor[]>()
  };
  const availability = getEntityRuntimeAvailability(entityName, workspaceRoot);
  const entitySource: DefSourceRef = {
    filePath: defFilePath,
    line: 1,
    path: entityName,
    category: 'entity'
  };
  const properties = collectPersistentPropertiesForDefinition(
    entityName,
    defFilePath,
    'entity',
    buildContext,
    availability
  );
  const tables = buildMysqlTableSchemas(entityName, entitySource, properties, availability);
  const tableIndex = new Map<string, TableSchemaDescriptor>(tables.map(table => [table.name, table]));

  return {
    backend: 'mysql',
    entityName,
    entitySource,
    defFilePath,
    tables,
    tableIndex
  };
}

export function findDatabaseSchemaFieldAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): { table: string; field?: string } | null {
  const lineText = document.lineAt(position.line).text.trim();
  const tableMatch = /^TABLE\s+([A-Za-z0-9_]+)/.exec(lineText);
  if (tableMatch) {
    return { table: tableMatch[1] };
  }

  const fieldMatch = /^([A-Za-z0-9_]+)\s+/.exec(lineText);
  if (!fieldMatch) {
    return null;
  }

  for (let currentLine = position.line - 1; currentLine >= 0; currentLine -= 1) {
    const currentText = document.lineAt(currentLine).text.trim();
    const currentTableMatch = /^TABLE\s+([A-Za-z0-9_]+)/.exec(currentText);
    if (currentTableMatch) {
      return {
        table: currentTableMatch[1],
        field: fieldMatch[1]
      };
    }
  }

  return null;
}

export function findDatabaseSchemaSourceLocation(
  snapshot: DatabaseSchemaSnapshot,
  tableName: string,
  fieldName?: string
): DefSourceRef | null {
  const table = snapshot.tableIndex.get(tableName);
  if (!table) {
    return null;
  }

  if (!fieldName) {
    return table.source;
  }

  return table.fields.find(field => field.name === fieldName)?.source || null;
}

export function findDatabaseSchemaTargetsForSource(
  snapshot: DatabaseSchemaSnapshot,
  filePath: string,
  sourcePath: string
): Array<{ tableName: string; fieldName?: string }> {
  const targets: Array<{ tableName: string; fieldName?: string }> = [];
  const normalizedFilePath = normalizePath(filePath);

  for (const table of snapshot.tables) {
    if (
      normalizePath(table.source.filePath) === normalizedFilePath
      && (
        table.source.path === sourcePath
        || table.source.path.startsWith(`${sourcePath}.`)
      )
    ) {
      targets.push({ tableName: table.name });
    }

    for (const field of table.fields) {
      if (
        normalizePath(field.source.filePath) === normalizedFilePath
        && (
          field.sourcePath === sourcePath
          || field.sourcePath.startsWith(`${sourcePath}.`)
        )
      ) {
        targets.push({ tableName: table.name, fieldName: field.name });
      }
    }
  }

  return dedupeSchemaTargets(targets);
}

export function locateDatabaseSchemaLine(
  snapshot: DatabaseSchemaSnapshot,
  tableName: string,
  fieldName?: string
): number {
  let line = 1;
  line += 4;
  line += 1;

  for (const table of snapshot.tables) {
    if (table.name === tableName && !fieldName) {
      return line;
    }

    line += 4;

    for (const field of table.fields) {
      if (table.name === tableName && field.name === fieldName) {
        return line;
      }

      line += 2;
    }

    line += 1;
  }

  return 1;
}

export function renderDatabaseSchema(snapshot: DatabaseSchemaSnapshot | null): string {
  if (!snapshot) {
    return '# KBEngine Database Schema\n\nNo schema available.\n';
  }

  const lines: string[] = [];
  lines.push(`# KBEngine Database Schema: ${snapshot.entityName}`);
  lines.push('');
  lines.push(`Backend: ${snapshot.backend.toUpperCase()}`);
  lines.push(`Source: ${snapshot.defFilePath || `${snapshot.entityName}.def`}`);
  lines.push('');

  for (const table of snapshot.tables) {
    lines.push(`TABLE ${table.name}`);
    lines.push(`kind: ${table.kind}`);
    if (table.parentTableName) {
      lines.push(`parent: ${table.parentTableName}`);
    }
    lines.push(`source: ${path.basename(table.source.filePath)}:${table.source.line} (${table.source.path})`);
    lines.push('');

    for (const field of table.fields) {
      const annotations: string[] = [field.typeLabel];
      if (field.databaseLength !== undefined) {
        annotations.push(`len=${field.databaseLength}`);
      }
      if (field.indexType) {
        annotations.push(`index=${field.indexType}`);
      }
      if (field.identifier) {
        annotations.push('identifier=true');
      }
      if (field.flags) {
        annotations.push(`flags=${field.flags}`);
      }

      lines.push(`${field.name}  ${annotations.join('  ')}`);
      lines.push(`  source: ${path.basename(field.source.filePath)}:${field.source.line} (${field.sourcePath})`);
    }

    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function collectPersistentPropertiesForDefinition(
  definitionName: string,
  filePath: string,
  category: DefinitionCategory,
  context: BuildContext,
  availability: RuntimeAvailability
): PersistentPropertyDescriptor[] {
  const normalizedPath = normalizePath(filePath);
  if (context.visitedDefinitions.has(normalizedPath)) {
    return [];
  }
  context.visitedDefinitions.add(normalizedPath);

  const content = readTextDocument(filePath);
  if (!content) {
    return [];
  }

  const document = parseDefDocument(content);
  const root = document.root;
  if (!root) {
    return [];
  }

  const properties = new Map<string, PersistentPropertyDescriptor>();

  mergeProperties(properties, parsePropertySection(
    getDirectChildElement(root, 'Properties'),
    document,
    filePath,
    category,
    definitionName,
    availability
  ));

  const interfacesNode = getDirectChildElement(root, 'Interfaces');
  if (interfacesNode) {
    for (const interfaceWrapper of getDirectChildElements(interfacesNode)) {
      for (const interfaceNode of getDirectChildElements(interfaceWrapper)) {
        const interfacePath = findDefinitionFileByCategory(interfaceNode.name, 'interface', context.workspaceRoot);
        if (!interfacePath) {
          continue;
        }

        mergeProperties(
          properties,
          collectPersistentPropertiesForDefinition(
            interfaceNode.name,
            interfacePath,
            'interface',
            context,
            availability
          )
        );
      }
    }
  }

  const componentsNode = getDirectChildElement(root, 'Components');
  if (componentsNode) {
    for (const componentNode of getDirectChildElements(componentsNode)) {
      const componentTypeName = getScalarChildValue(componentNode, 'Type');
      if (!componentTypeName) {
        continue;
      }

      const scopes = getDefinitionScopesFromComponent(componentTypeName, context, availability);
      const isPersistent = !hasFalsePersistent(componentNode);
      const componentSource: DefSourceRef = {
        filePath,
        line: getLineNumberAt(document, componentNode.tagStart),
        path: componentNode.name,
        category
      };
      const descriptor: PersistentPropertyDescriptor = {
        name: componentNode.name,
        typeName: 'ENTITY_COMPONENT',
        persistent: isPersistent,
        identifier: false,
        indexType: undefined,
        databaseLength: undefined,
        flags: undefined,
        scopes,
        source: componentSource,
        componentTypeName,
        children: isPersistent
          ? getPersistentComponentProperties(componentTypeName, context, availability)
          : []
      };

      if (descriptor.persistent) {
        mergeProperties(properties, [descriptor]);
      }
    }
  }

  const parentNode = getDirectChildElement(root, 'Parent');
  const parentName = getDirectChildElements(parentNode)[0]?.name;
  if (parentName) {
    const parentCategory = category === 'component' ? 'component' : 'entity';
    const parentPath = findDefinitionFileByCategory(parentName, parentCategory, context.workspaceRoot)
      || (parentCategory === 'entity' ? findEntityDefinitionFile(parentName, context.workspaceRoot) : null);

    if (parentPath) {
      mergeProperties(
        properties,
        collectPersistentPropertiesForDefinition(parentName, parentPath, parentCategory, context, availability)
      );
    }
  }

  return [...properties.values()];
}

function parsePropertySection(
  sectionNode: DefElementNode | undefined,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  definitionName: string,
  availability: RuntimeAvailability,
  parentPath = ''
): PersistentPropertyDescriptor[] {
  if (!sectionNode) {
    return [];
  }

  const properties: PersistentPropertyDescriptor[] = [];
  for (const propertyNode of getDirectChildElements(sectionNode)) {
    const descriptor = parsePropertyNode(
      propertyNode,
      document,
      filePath,
      category,
      definitionName,
      availability,
      parentPath
    );
    if (descriptor?.persistent) {
      properties.push(descriptor);
    }
  }
  return properties;
}

function parsePropertyNode(
  propertyNode: DefElementNode,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  definitionName: string,
  availability: RuntimeAvailability,
  parentPath = ''
): PersistentPropertyDescriptor | null {
  const typeName = getScalarChildValue(propertyNode, 'Type');
  if (!typeName) {
    return null;
  }

  const flags = getScalarChildValue(propertyNode, 'Flags');
  const scopes = getPropertyScopes(flags, availability);
  if (scopes.length === 0) {
    return null;
  }

  const propertyPath = parentPath ? `${parentPath}.${propertyNode.name}` : propertyNode.name;
  const descriptor: PersistentPropertyDescriptor = {
    name: propertyNode.name,
    typeName,
    persistent: !hasFalsePersistent(propertyNode),
    databaseLength: parseOptionalNumber(getScalarChildValue(propertyNode, 'DatabaseLength')),
    identifier: hasTruthyChildTag(propertyNode, 'Identifier'),
    indexType: normalizeOptionalString(getScalarChildValue(propertyNode, 'Index')),
    flags,
    scopes,
    source: {
      filePath,
      line: getLineNumberAt(document, propertyNode.tagStart),
      path: propertyPath,
      category
    }
  };

  if (!descriptor.persistent) {
    return descriptor;
  }

  if (typeName === 'ARRAY') {
    descriptor.arrayElement = parseArrayElementDescriptor(
      propertyNode,
      document,
      filePath,
      category,
      definitionName,
      availability,
      propertyPath,
      descriptor
    );
  } else if (typeName === 'FIXED_DICT') {
    descriptor.children = parseFixedDictChildren(
      propertyNode,
      document,
      filePath,
      category,
      definitionName,
      availability,
      propertyPath,
      descriptor
    );
  }

  return descriptor;
}

function parseArrayElementDescriptor(
  propertyNode: DefElementNode,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  definitionName: string,
  availability: RuntimeAvailability,
  propertyPath: string,
  parentDescriptor: PersistentPropertyDescriptor
): PersistentPropertyDescriptor | undefined {
  const typeNode = getDirectChildElement(propertyNode, 'Type');
  const elementTypeName = getScalarChildValue(typeNode, 'of');
  if (!typeNode || !elementTypeName) {
    return undefined;
  }

  const elementDescriptor: PersistentPropertyDescriptor = {
    name: 'value',
    typeName: elementTypeName,
    persistent: true,
    databaseLength: parentDescriptor.databaseLength,
    identifier: false,
    indexType: undefined,
    flags: parentDescriptor.flags,
    scopes: [...parentDescriptor.scopes],
    source: {
      filePath,
      line: getLineNumberAt(document, propertyNode.tagStart),
      path: `${propertyPath}[]`,
      category
    }
  };

  if (elementTypeName === 'FIXED_DICT') {
    elementDescriptor.children = parseFixedDictChildren(
      typeNode,
      document,
      filePath,
      category,
      definitionName,
      availability,
      `${propertyPath}[]`,
      elementDescriptor
    );
  }

  return elementDescriptor;
}

function parseFixedDictChildren(
  containerNode: DefElementNode,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  definitionName: string,
  availability: RuntimeAvailability,
  propertyPath: string,
  parentDescriptor: PersistentPropertyDescriptor
): PersistentPropertyDescriptor[] {
  const propertiesNode = getDirectChildElement(containerNode, 'Properties');
  if (!propertiesNode) {
    return [];
  }

  const children: PersistentPropertyDescriptor[] = [];
  for (const childNode of getDirectChildElements(propertiesNode)) {
    const typeName = getScalarChildValue(childNode, 'Type');
    if (!typeName) {
      continue;
    }

    const childPath = `${propertyPath}.${childNode.name}`;
    const childDescriptor: PersistentPropertyDescriptor = {
      name: childNode.name,
      typeName,
      persistent: !hasFalsePersistent(childNode),
      databaseLength: parseOptionalNumber(getScalarChildValue(childNode, 'DatabaseLength')),
      identifier: false,
      indexType: undefined,
      flags: parentDescriptor.flags,
      scopes: [...parentDescriptor.scopes],
      source: {
        filePath,
        line: getLineNumberAt(document, childNode.tagStart),
        path: childPath,
        category
      }
    };

    if (!childDescriptor.persistent) {
      continue;
    }

    if (typeName === 'FIXED_DICT') {
      childDescriptor.children = parseFixedDictChildren(
        childNode,
        document,
        filePath,
        category,
        definitionName,
        availability,
        childPath,
        childDescriptor
      );
    } else if (typeName === 'ARRAY') {
      childDescriptor.arrayElement = parseArrayElementDescriptor(
        childNode,
        document,
        filePath,
        category,
        definitionName,
        availability,
        childPath,
        childDescriptor
      );
    }

    children.push(childDescriptor);
  }

  return children;
}

function getPersistentComponentProperties(
  componentTypeName: string,
  context: BuildContext,
  availability: RuntimeAvailability
): PersistentPropertyDescriptor[] {
  const cached = context.componentCache.get(componentTypeName);
  if (cached) {
    return clonePersistentProperties(cached);
  }

  const componentPath = findDefinitionFileByCategory(componentTypeName, 'component', context.workspaceRoot);
  if (!componentPath) {
    return [];
  }

  const properties = collectPersistentPropertiesForDefinition(
    componentTypeName,
    componentPath,
    'component',
    context,
    availability
  );
  context.componentCache.set(componentTypeName, clonePersistentProperties(properties));
  return clonePersistentProperties(properties);
}

function buildMysqlTableSchemas(
  entityName: string,
  entitySource: DefSourceRef,
  properties: PersistentPropertyDescriptor[],
  availability: RuntimeAvailability
): TableSchemaDescriptor[] {
  const tables: TableSchemaDescriptor[] = [];
  const rootTableName = `${DB_TABLE_PREFIX}${entityName}`;
  const rootTable: TableSchemaDescriptor = {
    name: rootTableName,
    kind: 'entity',
    title: entityName,
    source: entitySource,
    propertyPath: entityName,
    fields: []
  };
  tables.push(rootTable);

  const hasCellPersistentData = properties.some(property => property.scopes.includes('cell'));
  if (hasCellPersistentData || availability.hasCell) {
    rootTable.fields.push(
      createSyntheticField('sm_position_0', 'float', 'position.x', entitySource),
      createSyntheticField('sm_position_1', 'float', 'position.y', entitySource),
      createSyntheticField('sm_position_2', 'float', 'position.z', entitySource),
      createSyntheticField('sm_direction_0', 'float', 'direction.roll', entitySource),
      createSyntheticField('sm_direction_1', 'float', 'direction.pitch', entitySource),
      createSyntheticField('sm_direction_2', 'float', 'direction.yaw', entitySource)
    );
  }

  for (const property of properties) {
    appendPropertyToTable(rootTable, tables, property, rootTableName);
  }

  return tables;
}

function appendPropertyToTable(
  table: TableSchemaDescriptor,
  tables: TableSchemaDescriptor[],
  property: PersistentPropertyDescriptor,
  currentTableName: string,
  fixedDictPrefix = ''
): void {
  if (!property.persistent) {
    return;
  }

  if (property.typeName === 'ARRAY') {
    const childTable = createArrayTable(currentTableName, property);
    tables.push(childTable);

    if (property.arrayElement) {
      appendPropertyToTable(childTable, tables, property.arrayElement, childTable.name);
    }
    return;
  }

  if (property.typeName === 'ENTITY_COMPONENT') {
    const childTable = createComponentTable(currentTableName, property);
    tables.push(childTable);

    for (const childProperty of property.children || []) {
      appendPropertyToTable(childTable, tables, childProperty, childTable.name);
    }
    return;
  }

  if (property.typeName === 'FIXED_DICT') {
    const nextPrefix = `${fixedDictPrefix}${property.name}_`;
    for (const childProperty of property.children || []) {
      appendPropertyToTable(table, tables, childProperty, currentTableName, nextPrefix);
    }
    return;
  }

  for (const fieldName of expandColumnNames(property, fixedDictPrefix)) {
    if (table.fields.some(field => field.name === fieldName)) {
      continue;
    }

    table.fields.push({
      name: fieldName,
      typeLabel: resolveDbTypeLabel(property.typeName),
      sourcePath: property.source.path,
      source: property.source,
      databaseLength: property.databaseLength,
      indexType: property.indexType,
      identifier: property.identifier,
      flags: property.flags
    });
  }
}

function createArrayTable(parentTableName: string, property: PersistentPropertyDescriptor): TableSchemaDescriptor {
  const tableName = `${parentTableName}_${property.name || 'values'}`;
  return {
    name: tableName,
    kind: 'array',
    title: property.source.path,
    source: property.source,
    parentTableName,
    propertyPath: property.source.path,
    fields: []
  };
}

function createComponentTable(parentTableName: string, property: PersistentPropertyDescriptor): TableSchemaDescriptor {
  return {
    name: `${parentTableName}_${property.name}`,
    kind: 'component',
    title: property.source.path,
    source: property.source,
    parentTableName,
    propertyPath: property.source.path,
    fields: []
  };
}

function expandColumnNames(property: PersistentPropertyDescriptor, fixedDictPrefix = ''): string[] {
  const baseName = `${DB_COLUMN_PREFIX}${fixedDictPrefix}${property.name}`;
  switch (property.typeName) {
    case 'VECTOR2':
      return [`${baseName}_0`, `${baseName}_1`];
    case 'VECTOR3':
      return [`${baseName}_0`, `${baseName}_1`, `${baseName}_2`];
    case 'VECTOR4':
      return [`${baseName}_0`, `${baseName}_1`, `${baseName}_2`, `${baseName}_3`];
    default:
      return [baseName];
  }
}

function createSyntheticField(
  name: string,
  typeLabel: string,
  sourcePath: string,
  source: DefSourceRef
): TableFieldDescriptor {
  return {
    name,
    typeLabel,
    sourcePath,
    source,
    identifier: false
  };
}

function resolveDbTypeLabel(typeName: string): string {
  return SIMPLE_DB_TYPE_LABELS[typeName] || typeName.toLowerCase();
}

function getPropertyScopes(flags: string | undefined, availability: RuntimeAvailability): RuntimeScope[] {
  const normalizedFlag = normalizeFlag(flags);
  if (!normalizedFlag) {
    return [];
  }

  const scopes = FLAG_SCOPE_MAP[normalizedFlag] || [];
  return scopes.filter(scope => {
    switch (scope) {
      case 'base':
        return availability.hasBase;
      case 'cell':
        return availability.hasCell;
      case 'client':
        return availability.hasClient;
      default:
        return false;
    }
  });
}

function getDefinitionScopesFromComponent(
  componentTypeName: string,
  context: BuildContext,
  availability: RuntimeAvailability
): RuntimeScope[] {
  const componentPath = findDefinitionFileByCategory(componentTypeName, 'component', context.workspaceRoot);
  if (!componentPath) {
    return [];
  }

  const content = readTextDocument(componentPath);
  if (!content) {
    return [];
  }

  const document = parseDefDocument(content);
  if (!document.root) {
    return [];
  }

  const scopes = new Set<RuntimeScope>();
  const registerScope = (scope: RuntimeScope, enabled: boolean) => {
    if (enabled) {
      scopes.add(scope);
    }
  };

  for (const propertyNode of getDirectChildElements(getDirectChildElement(document.root, 'Properties'))) {
    for (const scope of getPropertyScopes(getScalarChildValue(propertyNode, 'Flags'), availability)) {
      scopes.add(scope);
    }
  }

  for (const methodSection of ['BaseMethods', 'CellMethods', 'ClientMethods'] as const) {
    const sectionNode = getDirectChildElement(document.root, methodSection);
    if (!sectionNode) {
      continue;
    }

    if (getDirectChildElements(sectionNode).length === 0) {
      continue;
    }

    if (methodSection === 'BaseMethods') {
      registerScope('base', availability.hasBase);
    } else if (methodSection === 'CellMethods') {
      registerScope('cell', availability.hasCell);
    } else {
      registerScope('client', availability.hasClient);
    }
  }

  return [...scopes];
}

function mergeProperties(
  target: Map<string, PersistentPropertyDescriptor>,
  properties: PersistentPropertyDescriptor[]
): void {
  for (const property of properties) {
    const existing = target.get(property.name);
    if (!existing) {
      target.set(property.name, clonePersistentProperty(property));
      continue;
    }

    if (property.identifier && !existing.identifier) {
      existing.identifier = true;
    }
    if (!existing.indexType && property.indexType) {
      existing.indexType = property.indexType;
    }
    if (existing.databaseLength === undefined && property.databaseLength !== undefined) {
      existing.databaseLength = property.databaseLength;
    }
  }
}

function clonePersistentProperties(properties: PersistentPropertyDescriptor[]): PersistentPropertyDescriptor[] {
  return properties.map(property => clonePersistentProperty(property));
}

function clonePersistentProperty(property: PersistentPropertyDescriptor): PersistentPropertyDescriptor {
  return {
    ...property,
    scopes: [...property.scopes],
    children: property.children ? clonePersistentProperties(property.children) : undefined,
    arrayElement: property.arrayElement ? clonePersistentProperty(property.arrayElement) : undefined
  };
}

function getEntityRuntimeAvailability(entityName: string, workspaceRoot: string): RuntimeAvailability {
  const entityInfo = getRegisteredEntities(workspaceRoot).find(entity => entity.name === entityName);
  if (!entityInfo) {
    return {
      hasBase: true,
      hasCell: true,
      hasClient: false
    };
  }

  return {
    hasBase: entityInfo.hasBase,
    hasCell: entityInfo.hasCell,
    hasClient: entityInfo.hasClient
  };
}

function readTextDocument(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function hasFalsePersistent(node: DefElementNode): boolean {
  const value = getScalarChildValue(node, 'Persistent');
  return value?.trim().toLowerCase() === 'false';
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeFlag(flags: string | undefined): string | undefined {
  const normalizedFlag = flags?.trim().toUpperCase();
  if (!normalizedFlag) {
    return undefined;
  }

  switch (normalizedFlag) {
    case 'CELL_AND_CLIENT':
      return 'CELL_PUBLIC_AND_OWN';
    case 'CELL_AND_CLIENTS':
      return 'ALL_CLIENTS';
    case 'CELL_AND_OTHER_CLIENTS':
      return 'OTHER_CLIENTS';
    default:
      return normalizedFlag;
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

function dedupeSchemaTargets(
  targets: Array<{ tableName: string; fieldName?: string }>
): Array<{ tableName: string; fieldName?: string }> {
  const seen = new Set<string>();
  const deduped: Array<{ tableName: string; fieldName?: string }> = [];

  for (const target of targets) {
    const key = `${target.tableName}::${target.fieldName || ''}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(target);
  }

  return deduped;
}
