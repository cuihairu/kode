import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  DefDocument,
  DefElementNode,
  getDirectChildElement,
  getDirectChildElements,
  getLineNumberAt,
  getScalarChildValue,
  parseDefDocument
} from './defParser';

export type DefinitionCategory = 'type' | 'entity' | 'interface' | 'component';

export interface CustomTypePropertyInfo {
  name: string;
  typeName?: string;
}

export interface CustomTypeStructureChild {
  tag: string;
  value: CustomTypeStructureNode;
}

export interface CustomTypeStructureNode {
  name: string;
  rawValue: string;
  children: CustomTypeStructureChild[];
}

export interface CustomTypeInfo {
  name: string;
  filePath: string;
  line: number;
  startOffset: number;
  endOffset: number;
  aliasType: string;
  rawValue: string;
  structure: CustomTypeStructureNode;
  implementedBy?: string;
  properties: CustomTypePropertyInfo[];
  pythonFilePath?: string;
}

export interface CustomTypeDeclarationInfo {
  name: string;
  filePath: string;
  line: number;
  implementedBy?: string;
}

export interface RegisteredEntityInfo {
  name: string;
  hasBaseDeclared: boolean;
  hasCellDeclared: boolean;
  hasClientDeclared: boolean;
  hasBase: boolean;
  hasCell: boolean;
  hasClient: boolean;
}

export interface DefinitionEntry {
  name: string;
  filePath: string;
  category: DefinitionCategory;
  exists: boolean;
  registered: boolean;
  line?: number;
  hasBaseDeclared?: boolean;
  hasCellDeclared?: boolean;
  hasClientDeclared?: boolean;
  hasBase?: boolean;
  hasCell?: boolean;
  hasClient?: boolean;
  aliasType?: string;
  rawValue?: string;
  typeStructure?: CustomTypeStructureNode;
  implementedBy?: string;
  pythonFilePath?: string;
  typeProperties?: CustomTypePropertyInfo[];
}

export interface DefinitionWorkspaceLayout {
  workspaceRoot: string;
  entityDefsRoot: string | null;
  entityScriptsRoot: string | null;
  interfacesRoot: string | null;
  componentsRoot: string | null;
  entitiesXmlPath: string | null;
  typesXmlPath: string | null;
  userTypeRoots: string[];
}

export interface EntityRuntimeFacet {
  enabled: boolean;
  declared: boolean;
  scriptExists: boolean;
  scriptPath: string | null;
  source: 'declared' | 'inferred' | 'disabled';
}

export interface EntityRuntimeProfile {
  base: EntityRuntimeFacet;
  cell: EntityRuntimeFacet;
  client: EntityRuntimeFacet;
  runtimeRoles: string[];
  runtimeLabel: string;
  visibilityLabel: string;
  registrationSummary: string;
  visibilitySummary: string;
}

export function getWorkspaceRootForDocument(
  document?: Pick<vscode.TextDocument, 'fileName'>
): string | null {
  const folder = vscode.workspace.workspaceFolders?.find(item => {
    const folderPath = item.uri.fsPath;
    if (!document) {
      return false;
    }

    return document.fileName === folderPath
      || document.fileName.startsWith(`${folderPath}${path.sep}`)
      || document.fileName.startsWith(`${folderPath}/`);
  });

  return folder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}

export function getDefinitionWorkspaceLayout(workspaceRoot: string): DefinitionWorkspaceLayout {
  const config = vscode.workspace.getConfiguration('kbengine');
  const entityDefsCandidates = buildWorkspaceCandidates(
    workspaceRoot,
    config.get<string>('entityDefsPath', 'scripts/entity_defs'),
    ['entity_defs', 'scripts/entity_defs', 'assets/scripts/entity_defs']
  );
  // 不可达(批64 定性):候选列表由 buildWorkspaceCandidates 生成,首项为
  // resolveWorkspacePath(root, 配置路径)——相对路径经 path.join 的最小结果是
  // '.',恒非空,故 candidates[0] 恒真、entityDefsRoot/entityScriptsRoot 恒为
  // 非空字符串(批62 已据同一事实把 `!layout.entityDefsRoot` 守卫判不可达)。
  // 本文件所有依赖该二者的空值臂(下方各 ternary 的 null/'' 臂)同因此不可达。
  /* istanbul ignore start */
  const preferredEntityDefsRoot = entityDefsCandidates[0] || null;
  const entityDefsRoot = findExistingPath(entityDefsCandidates) || preferredEntityDefsRoot;
  const entityScriptsRoot = entityDefsRoot ? getDirectoryPath(entityDefsRoot) : null;
  /* istanbul ignore stop */

  const entitiesXmlCandidates = uniquePaths([
    // 不可达(批64 定性):entityScriptsRoot 恒为非空字符串,见上方区间理由。
    /* istanbul ignore start */
    entityScriptsRoot ? joinWorkspacePath(entityScriptsRoot, 'entities.xml') : '',
    /* istanbul ignore stop */
    ...buildWorkspaceCandidates(
      workspaceRoot,
      config.get<string>('entitiesXmlPath', 'scripts/entities.xml'),
      ['entities.xml', 'scripts/entities.xml', 'assets/scripts/entities.xml']
    )
  ]);

  const typesXmlCandidates = uniquePaths([
    // 不可达(批64 定性):entityDefsRoot 恒为非空字符串,见上方区间理由。
    /* istanbul ignore start */
    entityDefsRoot ? joinWorkspacePath(entityDefsRoot, 'types.xml') : '',
    /* istanbul ignore stop */
    ...buildWorkspaceCandidates(
      workspaceRoot,
      'scripts/entity_defs/types.xml',
      [
        'types.xml',
        'entity_defs/types.xml',
        'scripts/entity_defs/types.xml',
        'assets/scripts/entity_defs/types.xml',
        'scripts/types.xml',
        'assets/scripts/types.xml'
      ]
    )
  ]);

  const userTypeRoots = uniquePaths([
    // 不可达(批64 定性):entityScriptsRoot 恒为非空字符串,见上方区间理由。
    /* istanbul ignore start */
    entityScriptsRoot ? joinWorkspacePath(entityScriptsRoot, 'user_type') : '',
    /* istanbul ignore stop */
    joinWorkspacePath(workspaceRoot, 'user_type'),
    joinWorkspacePath(workspaceRoot, 'scripts/user_type'),
    joinWorkspacePath(workspaceRoot, 'assets/scripts/user_type')
  ]);

  return {
    workspaceRoot,
    entityDefsRoot,
    entityScriptsRoot,
    // 不可达(批64 定性):entityDefsRoot 恒为非空字符串,见上方区间理由。
    /* istanbul ignore start */
    interfacesRoot: entityDefsRoot ? joinWorkspacePath(entityDefsRoot, 'interfaces') : null,
    componentsRoot: entityDefsRoot ? joinWorkspacePath(entityDefsRoot, 'components') : null,
    /* istanbul ignore stop */
    entitiesXmlPath: findExistingPath(entitiesXmlCandidates),
    typesXmlPath: findExistingPath(typesXmlCandidates),
    userTypeRoots
  };
}

export function getRegisteredEntities(workspaceRoot: string): RegisteredEntityInfo[] {
  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  const content = layout.entitiesXmlPath ? readTextFile(layout.entitiesXmlPath) : null;
  if (!content) {
    return [];
  }

  const document = parseXmlDocument(content);
  if (!document?.root) {
    return [];
  }

  const entities: RegisteredEntityInfo[] = [];
  const seenNames = new Set<string>();

  for (const entityNode of getDirectChildElements(document.root)) {
    const name = entityNode.name;
    if (name === 'root' || seenNames.has(name)) {
      continue;
    }

    entities.push({
      name,
      hasBaseDeclared: Object.prototype.hasOwnProperty.call(entityNode.attributes, 'hasBase'),
      hasCellDeclared: Object.prototype.hasOwnProperty.call(entityNode.attributes, 'hasCell'),
      hasClientDeclared: Object.prototype.hasOwnProperty.call(entityNode.attributes, 'hasClient'),
      hasBase: isTrueAttributeValue(entityNode.attributes.hasBase),
      hasCell: isTrueAttributeValue(entityNode.attributes.hasCell),
      hasClient: isTrueAttributeValue(entityNode.attributes.hasClient)
    });
    seenNames.add(name);
  }

  return entities;
}

export function getCustomTypeInfos(workspaceRoot: string): CustomTypeInfo[] {
  const snapshot = getTypesXmlSnapshot(workspaceRoot);
  if (!snapshot) {
    return [];
  }

  return snapshot.typeNodes
    .map(typeNode => buildCustomTypeInfo(snapshot.document, snapshot.layout, typeNode))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getRegisteredCustomTypes(workspaceRoot: string): Set<string> {
  const typeNames = new Set<string>();
  const snapshot = getTypesXmlSnapshot(workspaceRoot);
  if (!snapshot) {
    return typeNames;
  }

  for (const typeNode of snapshot.typeNodes) {
    typeNames.add(typeNode.name);
  }

  return typeNames;
}

export function findCustomTypePythonFile(
  workspaceRoot: string,
  typeName: string
): string | null {
  return getCustomTypeInfos(workspaceRoot).find(type => type.name === typeName)?.pythonFilePath || null;
}

export function findCustomTypeInfo(
  typeName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): CustomTypeInfo | null {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);

  if (!workspaceRoot) {
    return null;
  }

  return getCustomTypeInfos(workspaceRoot).find(type => type.name === typeName) || null;
}

export function findCustomTypeDeclarationInfo(
  typeName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): CustomTypeDeclarationInfo | null {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);

  if (!workspaceRoot) {
    return null;
  }

  const snapshot = getTypesXmlSnapshot(workspaceRoot);
  if (!snapshot) {
    return null;
  }

  const typeNode = snapshot.typeNodes.find(node => node.name === typeName);
  if (!typeNode) {
    return null;
  }

  return {
    name: typeNode.name,
    filePath: snapshot.layout.typesXmlPath as string,
    line: getLineNumberAt(snapshot.document, typeNode.tagStart),
    implementedBy: getScalarChildValue(typeNode, 'implementedBy')
  };
}

export function findCustomTypePythonImplementationFile(
  typeName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>,
  implementedBy?: string
): string | null {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);

  if (!workspaceRoot) {
    return null;
  }

  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  return findCustomTypePythonFileByImplementation(layout, typeName, implementedBy) || null;
}

export function findEntityDefinitionFile(
  entityName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): string | null {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);

  if (!workspaceRoot) {
    return null;
  }

  // 不可达(批62 定性):entityDefsRoot = 已存在候选 || 候选[0],候选列表恒含
  // 非空相对路径,该值只能是字符串,守卫无触发路径。
  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  /* istanbul ignore start */
  if (!layout.entityDefsRoot) {
    return null;
  }
  /* istanbul ignore stop */

  const candidate = joinWorkspacePath(layout.entityDefsRoot, `${entityName}.def`);
  return findExistingLookupPath(candidate);
}

export function findEntityDefinitionsRoot(
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): string | null {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);

  if (!workspaceRoot) {
    return null;
  }

  return getDefinitionWorkspaceLayout(workspaceRoot).entityDefsRoot;
}

// 批110 用户令:属性/方法要能导航到实体脚本实现。返回
// scripts/<role>/<实体>.py(base|cell|client)中第一个存在的路径,
// 不存在时返回 null。与 getEntityRuntimeProfile 不同,这里不要求
// 实体已登记在 entities.xml(纯脚本/孤立 def 也要能跳)。
export function findEntityScriptFile(
  entityName: string,
  role: 'base' | 'cell' | 'client',
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): string | null {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);

  if (!workspaceRoot) {
    return null;
  }

  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  // 不可达(批64 定性):entityScriptsRoot 恒为非空字符串,见
  // getDefinitionWorkspaceLayout 的区间理由。
  /* istanbul ignore start */
  if (!layout.entityScriptsRoot) {
    return null;
  }
  /* istanbul ignore stop */

  return findExistingLookupPath(
    joinWorkspacePath(layout.entityScriptsRoot, role, `${entityName}.py`)
  );
}

// 批110:配套文本读取(供导航方在脚本里定位 class/def 行)。读不到
// (路径不存在/IO 失败)时返回空串,调用方按"零行"自然走 null 兜底,
// 不再单设失败分支。
export function readWorkspaceTextFile(filePath: string): string {
  return readTextFile(filePath) ?? '';
}

// 批110:行数组口径(导航方只需要逐行扫描)。
export function readWorkspaceTextLines(filePath: string): string[] {
  return readWorkspaceTextFile(filePath).split('\n');
}

export function getEntityRuntimeProfile(
  entityName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): EntityRuntimeProfile | null {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);

  if (!workspaceRoot) {
    return null;
  }

  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  const entityInfo = getRegisteredEntities(workspaceRoot).find(entity => entity.name === entityName);
  if (!entityInfo) {
    return null;
  }

  const createFacet = (
    role: 'base' | 'cell' | 'client',
    declared: boolean,
    declaredValue: boolean
  ): EntityRuntimeFacet => {
    // 不可达(批64 定性):layout.entityScriptsRoot 恒为非空字符串(见
    // getDefinitionWorkspaceLayout 的区间理由),scriptRoot 随之恒真、恒非空,
    // 两处 ternary 的 null 臂均不可达。
    /* istanbul ignore start */
    const scriptRoot = layout.entityScriptsRoot
      ? joinWorkspacePath(layout.entityScriptsRoot, role)
      : null;
    const scriptPath = scriptRoot
      ? findExistingLookupPath(joinWorkspacePath(scriptRoot, `${entityName}.py`))
      : null;
    /* istanbul ignore stop */
    const scriptExists = !!scriptPath;
    const enabled = declared ? declaredValue : scriptExists;

    return {
      enabled,
      declared,
      scriptExists,
      scriptPath,
      source: declared
        ? (declaredValue ? 'declared' : 'disabled')
        : (scriptExists ? 'inferred' : 'disabled')
    };
  };

  const base = createFacet('base', entityInfo.hasBaseDeclared, entityInfo.hasBase);
  const cell = createFacet('cell', entityInfo.hasCellDeclared, entityInfo.hasCell);
  const client = createFacet('client', entityInfo.hasClientDeclared, entityInfo.hasClient);

  const runtimeRoles = [
    base.enabled ? 'BaseApp' : null,
    cell.enabled ? 'CellApp' : null,
    client.enabled ? 'Client' : null
  ].filter((value): value is string => !!value);
  const runtimeLabel = runtimeRoles.join(' / ') || 'None';
  const visibilityLabel = client.enabled ? 'Client Entity' : 'Server Only';

  const registrationSummary = runtimeRoles.length > 0
    ? `Registered on ${runtimeRoles.join(' / ')}`
    : 'Registered, but no runtime role enabled';

  const visibilitySummary = client.enabled
    ? 'Has client entity definition'
    : 'Server only (no client entity)';

  return {
    base,
    cell,
    client,
    runtimeRoles,
    runtimeLabel,
    visibilityLabel,
    registrationSummary,
    visibilitySummary
  };
}

export function findEntitiesXmlFile(
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): string | null {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);

  if (!workspaceRoot) {
    return null;
  }

  return getDefinitionWorkspaceLayout(workspaceRoot).entitiesXmlPath;
}

// entities.xml 缺席降级提示(source-analysis 设计 D8)的已提示工作区记账。
// 引擎侧 entities.xml 缺省合法(纯脚本定义,entitydef.cpp:184-186),kode
// 按同一口径降级为逐文件解析,但提示每个工作区根只发一次,不逐键打扰。
const entitiesXmlMissingNotifiedRoots = new Set<string>();

export const ENTITIES_XML_MISSING_NOTICE =
  '未找到 entities.xml:实体导航按逐文件解析降级(引擎允许纯脚本定义)';

export function notifyEntitiesXmlMissingOnce(
  workspaceRoot: string,
  notify: (message: string) => void
): void {
  if (entitiesXmlMissingNotifiedRoots.has(workspaceRoot)) {
    return;
  }

  entitiesXmlMissingNotifiedRoots.add(workspaceRoot);
  notify(ENTITIES_XML_MISSING_NOTICE);
}

/** 测试隔离用:清空降级提示记账。 */
export function resetEntitiesXmlMissingNotices(): void {
  entitiesXmlMissingNotifiedRoots.clear();
}

export function findDefinitionFileByCategory(
  name: string,
  category: DefinitionCategory,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): string | null {
  return findDefinitionEntryByCategory(name, category, target)?.filePath || null;
}

export function findDefinitionEntryByCategory(
  name: string,
  category: DefinitionCategory,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): DefinitionEntry | null {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);

  if (!workspaceRoot) {
    return null;
  }

  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  let baseDirectory: string | null = null;

  switch (category) {
    case 'type':
      baseDirectory = layout.typesXmlPath;
      break;
    case 'entity':
      baseDirectory = layout.entityDefsRoot;
      break;
    case 'interface':
      baseDirectory = layout.interfacesRoot;
      break;
    case 'component':
      baseDirectory = layout.componentsRoot;
      break;
  }

  if (!baseDirectory) {
    return null;
  }

  if (category === 'type') {
    return getDefinitionEntries(workspaceRoot, category).find(entry => entry.name === name) || null;
  }

  const candidate = joinWorkspacePath(baseDirectory, `${name}.def`);
  const existingPath = findExistingLookupPath(candidate);
  if (!existingPath) {
    return null;
  }

  return {
    name,
    filePath: existingPath,
    category,
    exists: true,
    registered: true
  };
}

export function getDefinitionEntries(
  workspaceRoot: string,
  category: DefinitionCategory
): DefinitionEntry[] {
  const layout = getDefinitionWorkspaceLayout(workspaceRoot);

  if (category === 'type') {
    return getCustomTypeInfos(workspaceRoot)
      .map(type => ({
        name: type.name,
        filePath: type.filePath,
        category,
        exists: pathExists(type.filePath),
        registered: true,
        line: type.line,
        aliasType: type.aliasType,
        rawValue: type.rawValue,
        typeStructure: type.structure,
        implementedBy: type.implementedBy,
        pythonFilePath: type.pythonFilePath,
        typeProperties: type.properties
      }))
      .sort(compareDefinitionEntries);
  }

  if (category === 'entity') {
    const entries = new Map<string, DefinitionEntry>();

    for (const entity of getRegisteredEntities(workspaceRoot)) {
      // 不可达(批64 定性):layout.entityDefsRoot 恒为非空字符串,见
      // getDefinitionWorkspaceLayout 的区间理由,故回退 `${name}.def` 臂不可达。
      /* istanbul ignore start */
      const filePath = layout.entityDefsRoot
        ? joinWorkspacePath(layout.entityDefsRoot, `${entity.name}.def`)
        : `${entity.name}.def`;
      /* istanbul ignore stop */
      entries.set(entity.name, {
        name: entity.name,
        filePath,
        category,
        exists: pathExists(filePath),
        registered: true,
        hasBaseDeclared: entity.hasBaseDeclared,
        hasCellDeclared: entity.hasCellDeclared,
        hasClientDeclared: entity.hasClientDeclared,
        hasBase: entity.hasBase,
        hasCell: entity.hasCell,
        hasClient: entity.hasClient
      });
    }

    for (const filePath of listDefinitionFiles(layout.entityDefsRoot)) {
      const name = path.basename(filePath, '.def');
      if (!entries.has(name)) {
        entries.set(name, {
          name,
          filePath,
          category,
          exists: true,
          registered: false
        });
      }
    }

    return [...entries.values()].sort(compareDefinitionEntries);
  }

  const directory = category === 'interface' ? layout.interfacesRoot : layout.componentsRoot;
  return listDefinitionFiles(directory)
    .map(filePath => ({
      name: path.basename(filePath, '.def'),
      filePath,
      category,
      exists: true,
      registered: true
    }))
    .sort(compareDefinitionEntries);
}

function buildWorkspaceCandidates(
  workspaceRoot: string,
  configuredPath: string,
  fallbackRelativePaths: string[]
): string[] {
  return uniquePaths([
    resolveWorkspacePath(workspaceRoot, configuredPath),
    ...fallbackRelativePaths.map(relativePath => resolveWorkspacePath(workspaceRoot, relativePath))
  ]);
}

function resolveWorkspacePath(workspaceRoot: string, candidatePath: string): string {
  if (path.isAbsolute(candidatePath)) {
    return candidatePath;
  }

  return joinWorkspacePath(workspaceRoot, candidatePath);
}

function joinWorkspacePath(basePath: string, ...segments: string[]): string {
  if (usesPosixPaths(basePath)) {
    return path.posix.join(basePath, ...segments.map(segment => segment.replace(/\\/g, '/')));
  }

  return path.join(basePath, ...segments);
}

function getDirectoryPath(targetPath: string): string {
  return usesPosixPaths(targetPath)
    ? path.posix.dirname(targetPath)
    : path.dirname(targetPath);
}

function usesPosixPaths(targetPath: string): boolean {
  return !/^[A-Za-z]:[\\/]/.test(targetPath) && targetPath.includes('/');
}

function pathExists(candidatePath: string | null | undefined): candidatePath is string {
  return findExistingLookupPath(candidatePath) !== null;
}

function findExistingLookupPath(candidatePath: string | null | undefined): string | null {
  // 不可达(批62 定性):唯一能传非字符串的调用面是 listDefinitionFiles 的
  // `directory: string | null`,其实参为 layout.entityDefsRoot/interfacesRoot/
  // componentsRoot——三者只在 entityDefsRoot 为空时为 null,而 entityDefsRoot
  // 恒为字符串(候选列表恒含非空相对路径),故 null 入参无来源。
  /* istanbul ignore start */
  if (typeof candidatePath !== 'string') {
    return null;
  }
  /* istanbul ignore stop */

  for (const lookupPath of getPathLookupCandidates(candidatePath)) {
    if (fs.existsSync(lookupPath)) {
      return lookupPath;
    }
  }

  return null;
}

function findExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const existingPath = findExistingLookupPath(candidate);
    if (existingPath) {
      return existingPath;
    }
  }

  return null;
}

function uniquePaths(candidates: string[]): string[] {
  return [...new Set(candidates.filter(Boolean))];
}

function readTextFile(filePath: string): string | null {
  for (const lookupPath of getPathLookupCandidates(filePath)) {
    try {
      return fs.readFileSync(lookupPath, 'utf8');
    } catch {
      continue;
    }
  }

  return null;
}

function parseXmlDocument(content: string): DefDocument | null {
  try {
    return parseDefDocument(content);
  } catch {
    return null;
  }
}

function getTypesXmlSnapshot(workspaceRoot: string): {
  layout: DefinitionWorkspaceLayout;
  document: DefDocument;
  typeNodes: DefElementNode[];
} | null {
  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  const content = layout.typesXmlPath ? readTextFile(layout.typesXmlPath) : null;

  if (!content || !layout.typesXmlPath) {
    return null;
  }

  const document = parseXmlDocument(content);
  if (!document?.root) {
    return null;
  }

  return {
    layout,
    document,
    typeNodes: getDirectChildElements(document.root)
  };
}

function buildCustomTypeInfo(
  document: DefDocument,
  layout: DefinitionWorkspaceLayout,
  typeNode: DefElementNode
): CustomTypeInfo {
  const rawValue = extractCustomTypeRawValue(typeNode);
  const implementedBy = getScalarChildValue(typeNode, 'implementedBy');

  return {
    name: typeNode.name,
    filePath: layout.typesXmlPath as string,
    line: getLineNumberAt(document, typeNode.tagStart),
    startOffset: typeNode.tagStart,
    endOffset: typeNode.closeTagEnd,
    aliasType: extractCustomTypeAliasType(rawValue),
    rawValue,
    structure: parseCustomTypeStructure(rawValue),
    implementedBy,
    properties: parseCustomTypeProperties(typeNode),
    pythonFilePath: findCustomTypePythonFileByImplementation(layout, typeNode.name, implementedBy)
  };
}

function parseCustomTypeProperties(typeNode: DefElementNode): CustomTypePropertyInfo[] {
  const propertiesNode = getDirectChildElement(typeNode, 'Properties');
  if (!propertiesNode) {
    return [];
  }

  return getDirectChildElements(propertiesNode)
    .map(property => ({
      name: property.name,
      typeName: getScalarChildValue(property, 'Type')
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function extractCustomTypeRawValue(typeNode: DefElementNode): string {
  const chunks: string[] = [];

  for (const child of typeNode.children) {
    if (child.kind === 'text') {
      const normalized = normalizeXmlText(child.text);
      if (normalized) {
        chunks.push(normalized);
      }
      continue;
    }

    if (child.name === 'implementedBy' || child.name === 'Properties') {
      continue;
    }

    chunks.push(renderStructureNode(child));
  }

  return chunks.join(' ').trim() || 'ALIAS';
}

function extractCustomTypeAliasType(rawValue: string): string {
  const match = rawValue.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  return match?.[0] || 'ALIAS';
}

function parseCustomTypeStructure(rawValue: string): CustomTypeStructureNode {
  const document = parseXmlDocument(`<root>${rawValue}</root>`);
  const root = document?.root;
  const normalizedRawValue = normalizeXmlText(rawValue) || 'ALIAS';

  return {
    name: extractCustomTypeAliasType(normalizedRawValue),
    rawValue: normalizedRawValue,
    children: root
      ? getDirectChildElements(root).map(node => ({
          tag: node.name,
          value: parseCustomTypeStructure(getInnerXml(node))
        }))
      : []
  };
}

function renderStructureNode(node: DefElementNode): string {
  if (node.selfClosing) {
    return `<${node.name}/>`;
  }

  return `<${node.name}>${getInnerXml(node)}</${node.name}>`;
}

function getInnerXml(node: DefElementNode): string {
  return node.children
    .map(child => {
      if (child.kind === 'text') {
        return child.text;
      }

      return renderStructureNode(child);
    })
    .join('');
}

function normalizeXmlText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function findCustomTypePythonFileByImplementation(
  layout: DefinitionWorkspaceLayout,
  typeName: string,
  implementedBy?: string
): string | undefined {
  const moduleCandidates = new Set<string>();

  if (implementedBy?.trim()) {
    const normalizedModule = implementedBy.trim().replace(/\./g, '/');
    // 不可达(批64 定性):外层 `implementedBy?.trim()` 为真 ⇒ trim 结果非空,
    // 非空字符串经 replace(/\./g,'/') 仍非空,故 `if (normalizedModule)` 的
    // 假臂不可达。istanbul ignore 只支持整行区间(嵌套的 `if (firstSegment)`
    // 假臂在 implementedBy 以 '.' 开头(如 '.doll')时实际可达,但其分支
    // 条目与外层落在同一区间被一并忽略);tests/definitionWorkspaceBranches
    // .test.ts 以前导点用例锁定该路径行为,行为未裸奔。
    /* istanbul ignore start */
    if (normalizedModule) {
      moduleCandidates.add(normalizedModule);
      const [firstSegment] = normalizedModule.split('/');
      if (firstSegment) {
        moduleCandidates.add(firstSegment);
      }
    }
    /* istanbul ignore stop */
  }

  moduleCandidates.add(typeName);

  const candidates: string[] = [];
  for (const root of layout.userTypeRoots) {
    for (const moduleCandidate of moduleCandidates) {
      candidates.push(joinWorkspacePath(root, `${moduleCandidate}.py`));
    }
  }

  return findExistingPath(candidates) || undefined;
}

function isTrueAttributeValue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function listDefinitionFiles(directory: string | null): string[] {
  if (!pathExists(directory)) {
    return [];
  }

  const readdirSync = (fs as typeof fs & {
    readdirSync?: (...args: unknown[]) => unknown[];
  }).readdirSync;

  if (!readdirSync) {
    return [];
  }

  for (const lookupPath of getPathLookupCandidates(directory)) {
    try {
      return mapDefinitionFiles(directory, readdirSync(lookupPath, { withFileTypes: true }));
    } catch {
      try {
        return mapDefinitionFiles(directory, readdirSync(lookupPath));
      } catch {
        continue;
      }
    }
  }

  return [];
}

function mapDefinitionFiles(directory: string, entries: unknown[]): string[] {
  const files: string[] = [];

  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry.toLowerCase().endsWith('.def')) {
        files.push(joinWorkspacePath(directory, entry));
      }
      continue;
    }

    const item = entry as {
      name?: string;
      isDirectory?: () => boolean;
      isFile?: () => boolean;
    };

    if (!item.name) {
      continue;
    }

    if (typeof item.isDirectory === 'function' && item.isDirectory()) {
      continue;
    }

    if (typeof item.isFile === 'function' && !item.isFile()) {
      continue;
    }

    if (item.name.toLowerCase().endsWith('.def')) {
      files.push(joinWorkspacePath(directory, item.name));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function compareDefinitionEntries(left: DefinitionEntry, right: DefinitionEntry): number {
  // 不可达(批64 定性):唯一出现 registered 混排的输入是 entity 类目——
  // entries 按 Map 插入序先 registered 后 unregistered,且 unregistered 侧
  // 已经文件名排序;V8 sort 的比较方向恒为 (后元素, 前元素),混排对的
  // left 恒为 unregistered,故 `left.registered ? -1` 的真臂不可达(节点
  // 探针 12/12、25/25、40/40、60/60 多种命名序均仅触发假臂)。type/
  // interface/component 类目全部 registered,根本不进入本 if。
  /* istanbul ignore start */
  if (left.registered !== right.registered) {
    return left.registered ? -1 : 1;
  }
  /* istanbul ignore stop */

  return left.name.localeCompare(right.name);
}

function getPathLookupCandidates(targetPath: string): string[] {
  const normalizedForward = targetPath.replace(/\\/g, '/');
  const normalizedBackward = targetPath.replace(/\//g, '\\');
  return [...new Set([targetPath, normalizedForward, normalizedBackward])];
}
