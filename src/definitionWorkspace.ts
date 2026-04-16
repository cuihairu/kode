import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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

export interface RegisteredEntityInfo {
  name: string;
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
  interfacesRoot: string | null;
  componentsRoot: string | null;
  entitiesXmlPath: string | null;
  typesXmlPath: string | null;
  userTypeRoots: string[];
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
  const preferredEntityDefsRoot = entityDefsCandidates[0] || null;
  const entityDefsRoot = findExistingPath(entityDefsCandidates) || preferredEntityDefsRoot;
  const entityScriptsRoot = entityDefsRoot ? getDirectoryPath(entityDefsRoot) : null;

  const entitiesXmlCandidates = uniquePaths([
    entityScriptsRoot ? joinWorkspacePath(entityScriptsRoot, 'entities.xml') : '',
    ...buildWorkspaceCandidates(
      workspaceRoot,
      config.get<string>('entitiesXmlPath', 'scripts/entities.xml'),
      ['entities.xml', 'scripts/entities.xml', 'assets/scripts/entities.xml']
    )
  ]);

  const typesXmlCandidates = uniquePaths([
    entityDefsRoot ? joinWorkspacePath(entityDefsRoot, 'types.xml') : '',
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
    entityScriptsRoot ? joinWorkspacePath(entityScriptsRoot, 'user_type') : '',
    joinWorkspacePath(workspaceRoot, 'user_type'),
    joinWorkspacePath(workspaceRoot, 'scripts/user_type'),
    joinWorkspacePath(workspaceRoot, 'assets/scripts/user_type')
  ]);

  return {
    workspaceRoot,
    entityDefsRoot,
    interfacesRoot: entityDefsRoot ? joinWorkspacePath(entityDefsRoot, 'interfaces') : null,
    componentsRoot: entityDefsRoot ? joinWorkspacePath(entityDefsRoot, 'components') : null,
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

  const entities: RegisteredEntityInfo[] = [];
  const seenNames = new Set<string>();
  const entityRegex = /<([A-Za-z_][A-Za-z0-9_]*)\b([^>]*)\/?>/g;
  let match: RegExpExecArray | null;

  while ((match = entityRegex.exec(content)) !== null) {
    const name = match[1];
    if (name === 'root' || seenNames.has(name)) {
      continue;
    }

    const attributes = match[2] || '';
    entities.push({
      name,
      hasBase: hasTrueAttribute(attributes, 'hasBase'),
      hasCell: hasTrueAttribute(attributes, 'hasCell'),
      hasClient: hasTrueAttribute(attributes, 'hasClient')
    });
    seenNames.add(name);
  }

  return entities;
}

export function getCustomTypeInfos(workspaceRoot: string): CustomTypeInfo[] {
  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  const content = layout.typesXmlPath ? readTextFile(layout.typesXmlPath) : null;

  if (!content || !layout.typesXmlPath) {
    return [];
  }

  const rootBodyInfo = getXmlRootBodyInfo(content);
  return getTopLevelXmlNodes(rootBodyInfo.body, rootBodyInfo.startOffset)
    .map(node => {
      const rawValue = extractCustomTypeRawValue(node.body);
      const implementedBy = normalizeXmlText(extractTagValue(node.body, 'implementedBy'));
      return {
        name: node.name,
        filePath: layout.typesXmlPath as string,
        line: getLineNumberForOffset(content, node.startOffset),
        startOffset: node.startOffset,
        endOffset: node.endOffset,
        aliasType: extractCustomTypeAliasType(rawValue),
        rawValue,
        structure: parseCustomTypeStructure(rawValue),
        implementedBy,
        properties: parseCustomTypeProperties(node.body),
        pythonFilePath: findCustomTypePythonFileByImplementation(layout, node.name, implementedBy)
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getRegisteredCustomTypes(workspaceRoot: string): Set<string> {
  const typeNames = new Set<string>();

  for (const customType of getCustomTypeInfos(workspaceRoot)) {
    typeNames.add(customType.name);
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

  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  if (!layout.entityDefsRoot) {
    return null;
  }

  const candidate = joinWorkspacePath(layout.entityDefsRoot, `${entityName}.def`);
  return findExistingLookupPath(candidate);
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
      const filePath = layout.entityDefsRoot
        ? joinWorkspacePath(layout.entityDefsRoot, `${entity.name}.def`)
        : `${entity.name}.def`;
      entries.set(entity.name, {
        name: entity.name,
        filePath,
        category,
        exists: pathExists(filePath),
        registered: true,
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
  if (typeof candidatePath !== 'string') {
    return null;
  }

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

function getXmlRootBodyInfo(content: string): { body: string; startOffset: number } {
  const match = content.match(/<root\b[^>]*>([\s\S]*?)<\/root>/i);
  if (!match || typeof match.index !== 'number') {
    return { body: content, startOffset: 0 };
  }

  return {
    body: match[1],
    startOffset: match.index + match[0].indexOf(match[1])
  };
}

function getTopLevelXmlNodes(
  content: string,
  startOffset = 0
): Array<{ name: string; body: string; startOffset: number; endOffset: number }> {
  const nodes: Array<{ name: string; body: string; startOffset: number; endOffset: number }> = [];
  let cursor = 0;

  while (cursor < content.length) {
    const openIndex = content.indexOf('<', cursor);
    if (openIndex === -1) {
      break;
    }

    if (content.startsWith('<!--', openIndex)) {
      const commentEnd = content.indexOf('-->', openIndex + 4);
      cursor = commentEnd === -1 ? content.length : commentEnd + 3;
      continue;
    }

    if (content.startsWith('</', openIndex)) {
      cursor = openIndex + 2;
      continue;
    }

    const openTagMatch = /^<([A-Za-z_][A-Za-z0-9_]*)(?:\b[^>]*?)?(\/?)>/.exec(content.slice(openIndex));
    if (!openTagMatch) {
      cursor = openIndex + 1;
      continue;
    }

    const tagName = openTagMatch[1];
    const fullTagText = openTagMatch[0];
    const isSelfClosing = /\/>$/.test(fullTagText);
    const tagEnd = openIndex + fullTagText.length;

    if (isSelfClosing) {
      nodes.push({
        name: tagName,
        body: '',
        startOffset: startOffset + openIndex,
        endOffset: startOffset + tagEnd
      });
      cursor = tagEnd;
      continue;
    }

    const closeInfo = findClosingTag(content, tagName, tagEnd);
    if (!closeInfo) {
      cursor = tagEnd;
      continue;
    }

    nodes.push({
      name: tagName,
      body: content.slice(tagEnd, closeInfo.startIndex),
      startOffset: startOffset + openIndex,
      endOffset: startOffset + closeInfo.endIndex
    });
    cursor = closeInfo.endIndex;
  }

  return nodes;
}

function parseCustomTypeProperties(body: string): CustomTypePropertyInfo[] {
  const propertiesBody = extractTagValue(body, 'Properties');
  if (!propertiesBody) {
    return [];
  }

  return getTopLevelXmlNodes(propertiesBody)
    .map(property => ({
      name: property.name,
      typeName: normalizeXmlText(extractTagValue(property.body, 'Type'))
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function extractCustomTypeRawValue(body: string): string {
  const withoutComments = body.replace(/<!--[\s\S]*?-->/g, ' ');
  const withoutImplementationBlocks = withoutComments
    .replace(/<implementedBy>\s*[\s\S]*?\s*<\/implementedBy>/ig, ' ')
    .replace(/<Properties>\s*[\s\S]*?\s*<\/Properties>/ig, ' ')
    .trim();

  return normalizeXmlText(withoutImplementationBlocks) || 'ALIAS';
}

function extractCustomTypeAliasType(rawValue: string): string {
  const match = rawValue.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  return match?.[0] || 'ALIAS';
}

function parseCustomTypeStructure(rawValue: string): CustomTypeStructureNode {
  const normalizedRawValue = normalizeXmlText(rawValue) || 'ALIAS';

  return {
    name: extractCustomTypeAliasType(normalizedRawValue),
    rawValue: normalizedRawValue,
    children: getTopLevelXmlNodes(normalizedRawValue).map(node => ({
      tag: node.name,
      value: parseCustomTypeStructure(node.body)
    }))
  };
}

function extractTagValue(text: string, tagName: string): string | undefined {
  const match = text.match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, 'i'));
  return match?.[1];
}

function normalizeXmlText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function getLineNumberForOffset(content: string, offset: number): number {
  return content.slice(0, offset).split(/\r?\n/).length;
}

function findClosingTag(
  content: string,
  tagName: string,
  searchStart: number
): { startIndex: number; endIndex: number } | null {
  const tagRegex = /<\/?([A-Za-z_][A-Za-z0-9_]*)(?:\b[^>]*)\s*(\/?)>/g;
  tagRegex.lastIndex = searchStart;
  let depth = 1;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(content)) !== null) {
    const fullMatch = match[0];
    const currentTagName = match[1];
    const isClosing = fullMatch.startsWith('</');
    const isSelfClosing = match[2] === '/';

    if (currentTagName !== tagName) {
      continue;
    }

    if (isClosing) {
      depth -= 1;
      if (depth === 0) {
        return {
          startIndex: match.index,
          endIndex: match.index + fullMatch.length
        };
      }
      continue;
    }

    if (!isSelfClosing) {
      depth += 1;
    }
  }

  return null;
}

function findCustomTypePythonFileByImplementation(
  layout: DefinitionWorkspaceLayout,
  typeName: string,
  implementedBy?: string
): string | undefined {
  const moduleCandidates = new Set<string>();

  if (implementedBy) {
    const normalizedModule = implementedBy.trim().replace(/\./g, '/');
    if (normalizedModule) {
      moduleCandidates.add(normalizedModule);
      const [firstSegment] = normalizedModule.split('/');
      if (firstSegment) {
        moduleCandidates.add(firstSegment);
      }
    }
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

function hasTrueAttribute(attributes: string, attributeName: string): boolean {
  return new RegExp(`\\b${attributeName}\\s*=\\s*["']true["']`, 'i').test(attributes);
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
  if (left.registered !== right.registered) {
    return left.registered ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

function getPathLookupCandidates(targetPath: string): string[] {
  const normalizedForward = targetPath.replace(/\\/g, '/');
  const normalizedBackward = targetPath.replace(/\//g, '\\');
  return [...new Set([targetPath, normalizedForward, normalizedBackward])];
}
