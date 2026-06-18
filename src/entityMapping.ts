/**
 * KBEngine definition / Python navigation mapping
 * 基于统一 definition semantics 构建 owner-aware 的导航索引。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DefMethodSection } from './defParser';
import {
  createDefinitionSemanticsLoader,
  DefinitionMemberSourceKind,
  DefinitionMethod,
  DefinitionOwnerRef,
  DefinitionProperty,
  DefinitionSemanticCategory,
  ResolvedDefinitionComponentSlot,
  ResolvedDefinitionSemantics,
  normalizeLookupPath
} from './definitionSemantics';
import {
  findDefinitionFileByCategory,
  findEntityDefinitionFile,
  getDefinitionWorkspaceLayout
} from './definitionWorkspace';
import { joinWorkspacePath } from './workspacePath';

export type EntityMethodSection = DefMethodSection;

export interface DefinitionSymbolIdentity {
  ownerKind: DefinitionSemanticCategory;
  ownerName: string;
  sourceKind: DefinitionMemberSourceKind;
  sourceChain: string[];
  section?: EntityMethodSection;
  symbolName: string;
  propertyPath?: string;
  componentSlotName?: string;
}

export interface EntityMethodDefinitionLocation {
  defFile: string;
  line: number;
  section: EntityMethodSection;
  exposed: boolean;
  identity: DefinitionSymbolIdentity;
}

export interface EntityPropertyDefinitionLocation {
  defFile: string;
  line: number;
  identity: DefinitionSymbolIdentity;
}

export interface PythonMethodLocation {
  filePath: string;
  methodName: string;
  line: number;
  character: number;
}

export interface PythonMethodCallReference {
  filePath: string;
  methodName: string;
  line: number;
  character: number;
}

interface IndexedPropertyDefinition extends EntityPropertyDefinitionLocation {}

interface IndexedMethodDefinition extends EntityMethodDefinitionLocation {
  owner: DefinitionOwnerRef;
}

interface PythonOwnerFile {
  ownerKind: DefinitionSemanticCategory;
  ownerName: string;
  section?: EntityMethodSection;
  filePath: string;
}

interface PythonMethodBinding {
  identity: DefinitionSymbolIdentity;
  pythonFile: string;
}

interface IndexedPythonMethodLocation extends PythonMethodLocation {
  endLine: number;
  calls: Array<{ methodName: string; line: number; character: number; filePath: string }>;
  binding?: PythonMethodBinding;
}

interface EntityMappingIndex {
  rootName: string;
  rootCategory: DefinitionSemanticCategory;
  rootDefFile: string;
  semantics: ResolvedDefinitionSemantics;
  propertyDefinitions: IndexedPropertyDefinition[];
  methodDefinitions: IndexedMethodDefinition[];
  pythonOwnerFiles: PythonOwnerFile[];
  pythonMethods: IndexedPythonMethodLocation[];
}

export interface EntityMapping {
  name: string;
  defFile: string;
  pythonFile: string;
  pythonFiles: string[];
  properties: { [propertyName: string]: { defFile: string; line: number } };
  methods: { [methodName: string]: EntityMethodDefinitionLocation[] };
}

export class EntityMappingManager {
  private mappingIndexes = new Map<string, EntityMappingIndex>();
  private mappingIndexesByRoot = new Map<string, EntityMappingIndex>();
  private pythonWatcher: vscode.FileSystemWatcher | null = null;

  constructor(private context: vscode.ExtensionContext) {
    void this.scanEntityMappings();
    this.watchPythonFiles();
  }

  private async scanEntityMappings(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const loader = createDefinitionSemanticsLoader(workspaceFolder.uri.fsPath);
    if (!loader) {
      return;
    }

    const defFiles = await vscode.workspace.findFiles('**/*.def', null);
    for (const defFile of defFiles) {
      const normalizedPath = normalizeLookupPath(defFile.fsPath);
      if (normalizedPath.includes('/interfaces/') || normalizedPath.includes('/components/')) {
        continue;
      }

      const entityName = path.basename(defFile.fsPath, '.def');
      await this.parseDefFile(entityName, defFile.fsPath, loader);
    }
  }

  private async parseDefFile(
    entityName: string,
    defPath: string,
    loader?: ReturnType<typeof createDefinitionSemanticsLoader>,
    rootCategory: DefinitionSemanticCategory = 'entity'
  ): Promise<void> {
    try {
      const mapping = await this.buildIndex(entityName, defPath, loader, rootCategory);
      if (mapping) {
        this.storeIndex(mapping);
      }
    } catch (error) {
      console.error(`解析 .def 文件失败: ${defPath}`, error);
    }
  }

  private async buildIndex(
    entityName: string,
    defPath: string,
    providedLoader?: ReturnType<typeof createDefinitionSemanticsLoader>,
    rootCategory: DefinitionSemanticCategory = 'entity'
  ): Promise<EntityMappingIndex | null> {
    const loader = providedLoader || createDefinitionSemanticsLoader(defPath);
    if (!loader) {
      return null;
    }

    const semantics = loader.loadResolved(entityName, rootCategory, true);
    if (!semantics) {
      return null;
    }

    const pythonOwnerFiles = this.collectPythonOwnerFiles(semantics);
    const pythonMethods = this.collectPythonMethods(pythonOwnerFiles);
    const propertyDefinitions = this.collectPropertyDefinitions(semantics);
    const methodDefinitions = this.collectMethodDefinitions(semantics);
    this.bindPythonMethods(methodDefinitions, pythonMethods);

    return {
      rootName: entityName,
      rootDefFile: defPath,
      semantics,
      propertyDefinitions,
      methodDefinitions,
      pythonOwnerFiles,
      pythonMethods
    };
  }

  private collectPythonOwnerFiles(semantics: ResolvedDefinitionSemantics): PythonOwnerFile[] {
    const layout = getDefinitionWorkspaceLayout(this.getWorkspaceRoot(semantics.owner.filePath) || '');
    const files: PythonOwnerFile[] = [];
    const seen = new Set<string>();

    const push = (candidate: PythonOwnerFile | null) => {
      if (!candidate) {
        return;
      }

      const key = `${candidate.ownerKind}:${candidate.ownerName}:${candidate.section || ''}:${normalizeLookupPath(candidate.filePath)}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      files.push(candidate);
    };

    const addDefinitionOwnerFiles = (
      owner: DefinitionOwnerRef,
      componentSlotName?: string
    ) => {
      for (const section of ['BaseMethods', 'CellMethods', 'ClientMethods'] as EntityMethodSection[]) {
        for (const filePath of this.getPythonCandidates(layout.workspaceRoot, owner, section, componentSlotName)) {
          if (fs.existsSync(filePath)) {
            push({
              ownerKind: owner.kind,
              ownerName: owner.name,
              section,
              filePath
            });
          }
        }
      }

      if (owner.kind === 'interface') {
        for (const section of ['BaseMethods', 'CellMethods'] as EntityMethodSection[]) {
          for (const filePath of this.getPythonCandidates(layout.workspaceRoot, owner, section, componentSlotName, true)) {
            if (fs.existsSync(filePath)) {
              push({
                ownerKind: owner.kind,
                ownerName: owner.name,
                section,
                filePath
              });
            }
          }
        }
      }
    };

    const owners = new Map<string, DefinitionOwnerRef>();
    const collectOwner = (owner: DefinitionOwnerRef) => {
      owners.set(`${owner.kind}:${owner.name}`, owner);
    };

    collectOwner(semantics.owner);
    for (const property of semantics.effectiveProperties) {
      collectOwner(property.owner);
    }
    for (const section of ['BaseMethods', 'CellMethods', 'ClientMethods'] as EntityMethodSection[]) {
      for (const method of semantics.effectiveMethodsBySection[section]) {
        collectOwner(method.owner);
      }
    }
    for (const component of semantics.components) {
      if (component.resolved) {
        collectOwner(component.resolved.owner);
      }
    }

    for (const owner of owners.values()) {
      addDefinitionOwnerFiles(owner);
    }

    for (const component of semantics.components) {
      if (!component.resolved) {
        continue;
      }

      addDefinitionOwnerFiles(component.resolved.owner, component.slotName);
    }

    return files;
  }

  private getPythonCandidates(
    workspaceRoot: string,
    owner: DefinitionOwnerRef,
    section: EntityMethodSection,
    componentSlotName?: string,
    preferInterfaceScriptFolder = false
  ): string[] {
    const candidates: string[] = [];
    const sectionFolder = this.getSectionFolder(section);
    const assetPrefix = ['scripts', 'assets/scripts'];
    const ownerName = owner.name;

    if (owner.kind === 'entity') {
      for (const prefix of assetPrefix) {
        candidates.push(joinWorkspacePath(workspaceRoot, prefix, sectionFolder, `${ownerName}.py`));
      }
      return candidates;
    }

    if (owner.kind === 'component') {
      for (const prefix of assetPrefix) {
        candidates.push(joinWorkspacePath(workspaceRoot, prefix, sectionFolder, 'components', `${ownerName}.py`));
      }
      return candidates;
    }

    if (owner.kind === 'interface') {
      const interfaceFolders = preferInterfaceScriptFolder
        ? [`${sectionFolder}/interfaces`, 'interfaces']
        : ['interfaces', `${sectionFolder}/interfaces`];

      for (const prefix of assetPrefix) {
        for (const folder of interfaceFolders) {
          candidates.push(joinWorkspacePath(workspaceRoot, prefix, folder, `${ownerName}.py`));
        }
      }
      return candidates;
    }

    if (componentSlotName) {
      for (const prefix of assetPrefix) {
        candidates.push(joinWorkspacePath(workspaceRoot, prefix, sectionFolder, 'components', `${ownerName}.py`));
      }
    }

    return candidates;
  }

  private getSectionFolder(section: EntityMethodSection): 'base' | 'cell' | 'client' {
    switch (section) {
      case 'BaseMethods':
        return 'base';
      case 'CellMethods':
        return 'cell';
      case 'ClientMethods':
        return 'client';
    }
  }

  private collectPropertyDefinitions(semantics: ResolvedDefinitionSemantics): IndexedPropertyDefinition[] {
    const results: IndexedPropertyDefinition[] = [];
    const pushProperty = (property: DefinitionProperty, componentSlotName?: string) => {
      results.push({
        defFile: property.owner.filePath,
        line: property.line,
        identity: {
          ownerKind: property.owner.kind,
          ownerName: property.owner.name,
          sourceKind: property.source.kind,
          sourceChain: [...property.source.chain],
          symbolName: property.name,
          propertyPath: property.fullPath,
          componentSlotName
        }
      });

      for (const child of property.children) {
        pushProperty(child, componentSlotName);
      }

      if (property.arrayElement) {
        pushProperty(property.arrayElement, componentSlotName);
      }
    };

    for (const property of semantics.effectiveProperties) {
      pushProperty(property);
    }

    for (const component of semantics.components) {
      if (!component.resolved) {
        continue;
      }

      for (const property of component.resolved.effectiveProperties) {
        pushProperty(this.rebasePropertyPath(property, component.slotName), component.slotName);
      }
    }

    return results;
  }

  private collectMethodDefinitions(semantics: ResolvedDefinitionSemantics): IndexedMethodDefinition[] {
    const results: IndexedMethodDefinition[] = [];
    const pushMethod = (method: DefinitionMethod, componentSlotName?: string) => {
      results.push({
        defFile: method.owner.filePath,
        line: method.line,
        section: method.section,
        exposed: method.exposed,
        owner: method.owner,
        identity: {
          ownerKind: method.owner.kind,
          ownerName: method.owner.name,
          sourceKind: method.source.kind,
          sourceChain: [...method.source.chain],
          section: method.section,
          symbolName: method.name,
          componentSlotName
        }
      });
    };

    for (const section of ['BaseMethods', 'CellMethods', 'ClientMethods'] as EntityMethodSection[]) {
      for (const method of semantics.effectiveMethodsBySection[section]) {
        pushMethod(method);
      }
    }

    for (const component of semantics.components) {
      if (!component.resolved) {
        continue;
      }

      for (const section of ['BaseMethods', 'CellMethods', 'ClientMethods'] as EntityMethodSection[]) {
        for (const method of component.resolved.effectiveMethodsBySection[section]) {
          pushMethod(method, component.slotName);
        }
      }
    }

    return results;
  }

  private rebasePropertyPath(property: DefinitionProperty, prefix: string): DefinitionProperty {
    const sourceRoot = property.fullPath.split('.')[0] || property.fullPath;
    const suffix = property.fullPath === sourceRoot
      ? ''
      : property.fullPath.slice(sourceRoot.length);
    const nextFullPath = `${prefix}${suffix}`;

    return {
      ...property,
      fullPath: nextFullPath,
      children: property.children.map(child => this.rebasePropertyPath(child, prefix)),
      arrayElement: property.arrayElement ? this.rebasePropertyPath(property.arrayElement, prefix) : undefined
    };
  }

  private collectPythonMethods(ownerFiles: PythonOwnerFile[]): IndexedPythonMethodLocation[] {
    const methods: IndexedPythonMethodLocation[] = [];

    for (const ownerFile of ownerFiles) {
      if (!fs.existsSync(ownerFile.filePath)) {
        continue;
      }

      const content = fs.readFileSync(ownerFile.filePath, 'utf8');
      const parsedMethods = parsePythonMethodBlocks(content, ownerFile.filePath);
      for (const method of parsedMethods) {
        methods.push({
          ...method
        });
      }
    }

    return methods;
  }

  private bindPythonMethods(
    methodDefinitions: IndexedMethodDefinition[],
    pythonMethods: IndexedPythonMethodLocation[]
  ): void {
    const byOwner = new Map<string, IndexedMethodDefinition[]>();
    for (const definition of methodDefinitions) {
      const key = buildMethodOwnerBindingKey(definition.identity);
      const list = byOwner.get(key) || [];
      list.push(definition);
      byOwner.set(key, list);
    }

    for (const method of pythonMethods) {
      const ownerBindingKeys = [
        buildMethodOwnerBindingKey({
          ownerKind: inferOwnerKindFromPythonFile(method.filePath) || 'entity',
          ownerName: inferOwnerNameFromPythonFile(method.filePath),
          section: inferMethodSectionFromPythonFile(method.filePath),
          symbolName: method.methodName
        }),
        buildMethodOwnerBindingKey({
          ownerKind: inferOwnerKindFromPythonFile(method.filePath) || 'interface',
          ownerName: inferOwnerNameFromPythonFile(method.filePath),
          section: inferMethodSectionFromPythonFile(method.filePath),
          symbolName: method.methodName
        }),
        buildMethodOwnerBindingKey({
          ownerKind: inferOwnerKindFromPythonFile(method.filePath) || 'component',
          ownerName: inferOwnerNameFromPythonFile(method.filePath),
          section: inferMethodSectionFromPythonFile(method.filePath),
          symbolName: method.methodName
        })
      ];

      const boundDefinition = ownerBindingKeys
        .map(key => byOwner.get(key)?.[0])
        .find((candidate): candidate is IndexedMethodDefinition => !!candidate);

      if (!boundDefinition) {
        continue;
      }

      method.binding = {
        identity: boundDefinition.identity,
        pythonFile: method.filePath
      };
    }
  }

  private watchPythonFiles(): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const pattern = vscode.Uri.joinPath(workspaceFolder.uri, '**/*.py');
    this.pythonWatcher = vscode.workspace.createFileSystemWatcher(pattern.toString());
    this.pythonWatcher.onDidChange(uri => {
      this.handlePythonFileChanged(uri.fsPath);
    });

    this.context.subscriptions.push(this.pythonWatcher);
  }

  private handlePythonFileChanged(pythonPath: string): void {
    for (const [entityName, mapping] of this.mappingIndexes) {
      if (mapping.pythonOwnerFiles.some(item => normalizeLookupPath(item.filePath) === normalizeLookupPath(pythonPath))) {
        void this.parseDefFile(entityName, mapping.rootDefFile);
        break;
      }
    }
  }

  getMapping(entityName: string): EntityMapping | undefined {
    const index = this.mappingIndexes.get(entityName);
    return index ? this.toLegacyMapping(index) : undefined;
  }

  getMappingForPythonFile(pythonFile: string): EntityMapping | undefined {
    const index = this.findIndexForPythonFile(pythonFile);
    return index ? this.toLegacyMapping(index) : undefined;
  }

  getAllMappings(): EntityMapping[] {
    return [...this.mappingIndexes.values()].map(index => this.toLegacyMapping(index));
  }

  async resolvePropertyDefinition(
    pythonFile: string,
    fullPath: string,
    rootSymbol?: string
  ): Promise<EntityPropertyDefinitionLocation | null> {
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (!index) {
      return null;
    }

    const normalizedFullPath = normalizePropertyLookupPath(fullPath);
    const normalizedRoot = rootSymbol ? normalizePropertyLookupPath(rootSymbol) : undefined;

    return index.propertyDefinitions.find(item => normalizePropertyLookupPath(item.identity.propertyPath || '') === normalizedFullPath)
      || (normalizedRoot
        ? index.propertyDefinitions.find(item => normalizePropertyLookupPath(item.identity.propertyPath || '') === normalizedRoot)
        : undefined)
      || null;
  }

  async resolveMethodDefinition(
    pythonFile: string,
    methodName: string
  ): Promise<EntityMethodDefinitionLocation | null> {
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (!index) {
      return null;
    }

    const ownerKind = inferOwnerKindFromPythonFile(pythonFile);
    const ownerName = inferOwnerNameFromPythonFile(pythonFile);
    const section = inferMethodSectionFromPythonFile(pythonFile);

    return this.selectMethodDefinition(index.methodDefinitions, {
      methodName,
      ownerKind,
      ownerName,
      section
    });
  }

  async resolveDefinitionSymbolAtPosition(
    defFile: string,
    line: number,
    symbolName: string,
    section?: EntityMethodSection,
    propertyPath?: string
  ): Promise<DefinitionSymbolIdentity | null> {
    const index = await this.ensureIndexByDefFile(defFile);
    if (!index) {
      return null;
    }

    if (propertyPath) {
      const property = index.propertyDefinitions.find(item =>
        normalizeLookupPath(item.defFile) === normalizeLookupPath(defFile)
        && item.line === line
        && normalizePropertyLookupPath(item.identity.propertyPath || '') === normalizePropertyLookupPath(propertyPath)
      );
      return property?.identity || null;
    }

    if (section) {
      const method = index.methodDefinitions.find(item =>
        normalizeLookupPath(item.defFile) === normalizeLookupPath(defFile)
        && item.line === line
        && item.section === section
        && item.identity.symbolName === symbolName
      );
      return method?.identity || null;
    }

    return null;
  }

  async openMethodTarget(
    identityOrEntityName: DefinitionSymbolIdentity | string,
    methodName?: string,
    section?: EntityMethodSection
  ): Promise<boolean> {
    const identity = typeof identityOrEntityName === 'string'
      ? this.createLegacyIdentity(identityOrEntityName, methodName, section)
      : identityOrEntityName;
    if (!identity) {
      return false;
    }

    const index = await this.ensureIndex(identity.ownerName);
    if (!index) {
      return false;
    }

    const implementationTarget = this.findMethodImplementationByIdentity(index, identity);
    if (implementationTarget) {
      return this.openFileAtLocation(
        implementationTarget.filePath,
        implementationTarget.line,
        implementationTarget.character
      );
    }

    const definition = index.methodDefinitions.find(item => sameIdentity(item.identity, identity));
    if (!definition) {
      return false;
    }

    return this.openFileAtLocation(definition.defFile, definition.line);
  }

  async resolveMethodImplementationByIdentity(
    identity: DefinitionSymbolIdentity
  ): Promise<{ filePath: string; line: number; character: number } | null> {
    const index = await this.ensureIndex(identity.ownerName);
    if (!index) {
      return null;
    }

    return this.findMethodImplementationByIdentity(index, identity);
  }

  async resolveMethodImplementation(
    entityName: string,
    methodName: string,
    section: EntityMethodSection
  ): Promise<{ filePath: string; line: number; character: number } | null> {
    const index = await this.ensureIndex(entityName);
    if (!index) {
      return null;
    }

    const definition = this.selectMethodDefinition(index.methodDefinitions, {
      methodName,
      ownerKind: 'entity',
      ownerName: entityName,
      section
    });

    return definition ? this.findMethodImplementationByIdentity(index, definition.identity) : null;
  }

  async resolvePythonMethodAtPosition(
    pythonFile: string,
    line: number,
    character: number
  ): Promise<PythonMethodLocation | null> {
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (!index) {
      return null;
    }

    const normalizedPythonPath = normalizeLookupPath(pythonFile);
    return index.pythonMethods.find(method =>
      normalizeLookupPath(method.filePath) === normalizedPythonPath
      && line >= method.line
      && line <= method.endLine
      && (line !== method.line || character >= method.character)
    ) || null;
  }

  async getOutgoingPythonMethodCalls(
    pythonFile: string,
    methodName: string
  ): Promise<PythonMethodCallReference[]> {
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (!index) {
      return [];
    }

    const targetMethod = index.pythonMethods.find(method =>
      normalizeLookupPath(method.filePath) === normalizeLookupPath(pythonFile)
      && method.methodName === methodName
    );
    if (!targetMethod) {
      return [];
    }

    const references: PythonMethodCallReference[] = [];
    const seen = new Set<string>();
    for (const reference of targetMethod.calls) {
      const binding = index.pythonMethods.find(candidate =>
        normalizeLookupPath(candidate.filePath) === normalizeLookupPath(reference.filePath)
        && candidate.methodName === reference.methodName
      );

      const resolved = binding
        || index.pythonMethods.find(candidate => candidate.methodName === reference.methodName);
      if (!resolved) {
        continue;
      }

      const key = `${normalizeLookupPath(resolved.filePath)}:${resolved.methodName}:${resolved.line}:${resolved.character}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      references.push({
        filePath: resolved.filePath,
        methodName: resolved.methodName,
        line: resolved.line,
        character: resolved.character
      });
    }

    return references;
  }

  async getIncomingPythonMethodCalls(
    pythonFile: string,
    methodName: string
  ): Promise<Array<{ caller: PythonMethodLocation; callLine: number; callCharacter: number }>> {
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (!index) {
      return [];
    }

    const incoming: Array<{ caller: PythonMethodLocation; callLine: number; callCharacter: number }> = [];
    const normalizedTarget = normalizeLookupPath(pythonFile);

    for (const method of index.pythonMethods) {
      for (const call of method.calls) {
        if (call.methodName !== methodName) {
          continue;
        }

        const resolved = index.pythonMethods.find(candidate =>
          candidate.methodName === call.methodName
          && normalizeLookupPath(candidate.filePath) === normalizedTarget
        );
        if (!resolved) {
          continue;
        }

        incoming.push({
          caller: {
            filePath: method.filePath,
            methodName: method.methodName,
            line: method.line,
            character: method.character
          },
          callLine: call.line,
          callCharacter: call.character
        });
      }
    }

    return incoming;
  }

  async jumpToDef(
    pythonFile: string,
    symbol: string,
    type: 'property' | 'method'
  ): Promise<boolean> {
    const location = type === 'property'
      ? await this.resolvePropertyDefinition(pythonFile, symbol, symbol)
      : await this.resolveMethodDefinition(pythonFile, symbol);

    if (!location) {
      return false;
    }

    return this.openFileAtLocation(location.defFile, location.line);
  }

  dispose(): void {
    this.pythonWatcher?.dispose();
  }

  private selectMethodDefinition(
    definitions: IndexedMethodDefinition[],
    options: {
      methodName: string;
      ownerKind?: DefinitionSemanticCategory;
      ownerName?: string;
      section?: EntityMethodSection;
      componentSlotName?: string;
    }
  ): IndexedMethodDefinition | null {
    const matches = definitions.filter(item => item.identity.symbolName === options.methodName);
    if (matches.length === 0) {
      return null;
    }

    const scored = matches
      .map(item => ({ item, score: this.scoreMethodDefinition(item, options) }))
      .sort((left, right) => right.score - left.score);

    return scored[0]?.item || null;
  }

  private scoreMethodDefinition(
    definition: IndexedMethodDefinition,
    options: {
      ownerKind?: DefinitionSemanticCategory;
      ownerName?: string;
      section?: EntityMethodSection;
      componentSlotName?: string;
    }
  ): number {
    let score = 0;
    if (options.ownerKind && definition.identity.ownerKind === options.ownerKind) {
      score += 40;
    }
    if (options.ownerName && definition.identity.ownerName === options.ownerName) {
      score += 40;
    }
    if (options.section && definition.section === options.section) {
      score += 20;
    }
    if (options.componentSlotName && definition.identity.componentSlotName === options.componentSlotName) {
      score += 30;
    }
    if (definition.identity.sourceKind === 'local') {
      score += 10;
    }
    return score;
  }

  private findMethodImplementationByIdentity(
    index: EntityMappingIndex,
    identity: DefinitionSymbolIdentity
  ): { filePath: string; line: number; character: number } | null {
    const direct = index.pythonMethods.find(method =>
      method.binding && sameIdentity(method.binding.identity, identity)
    );
    if (direct) {
      return {
        filePath: direct.filePath,
        line: direct.line,
        character: direct.character
      };
    }

    const ownerName = identity.ownerName;
    const ownerKind = identity.ownerKind;
    const section = identity.section;
    const candidates = index.pythonOwnerFiles
      .filter(item =>
        item.ownerName === ownerName
        && item.ownerKind === ownerKind
        && (!section || item.section === section)
      )
      .map(item => item.filePath);

    for (const filePath of uniqueFilePaths(candidates)) {
      const location = this.findPythonMethodLine(filePath, identity.symbolName);
      if (location) {
        return {
          filePath,
          line: location.line,
          character: location.character
        };
      }
    }

    return null;
  }

  private findPythonMethodLine(
    pythonFile: string,
    methodName: string
  ): { line: number; character: number } | null {
    if (!fs.existsSync(pythonFile)) {
      return null;
    }

    try {
      const content = fs.readFileSync(pythonFile, 'utf8');
      const regex = new RegExp(`^(\\s*)(?:async\\s+)?def\\s+(${escapeRegExp(methodName)})\\s*\\(`, 'm');
      const match = regex.exec(content);
      if (!match) {
        return null;
      }

      const nameIndex = match.index + match[0].indexOf(match[2]);
      return {
        line: getLineNumber(content, nameIndex),
        character: getColumnNumber(content, nameIndex)
      };
    } catch {
      return null;
    }
  }

  private async openFileAtLocation(filePath: string, line: number, character = 0): Promise<boolean> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const position = new vscode.Position(Math.max(line - 1, 0), Math.max(character, 0));
    const selection = new vscode.Range(position, position);
    const editor = await vscode.window.showTextDocument(document, { selection });
    return editor !== undefined;
  }

  private async ensureIndex(entityName: string): Promise<EntityMappingIndex | undefined> {
    let index = this.mappingIndexes.get(entityName);
    if (!index) {
      await this.scanEntityMappings();
      index = this.mappingIndexes.get(entityName);
    }
    return index;
  }

  private async ensureIndexByDefFile(defFile: string): Promise<EntityMappingIndex | undefined> {
    let index = [...this.mappingIndexes.values()].find(item =>
      normalizeLookupPath(item.rootDefFile) === normalizeLookupPath(defFile)
    );
    if (!index) {
      const entityName = path.basename(defFile, '.def');
      index = await this.ensureIndex(entityName);
    }
    return index;
  }

  private async ensureIndexForPythonFile(pythonFile: string): Promise<EntityMappingIndex | undefined> {
    let index = this.findIndexForPythonFile(pythonFile);
    if (!index) {
      await this.scanEntityMappings();
      index = this.findIndexForPythonFile(pythonFile);
    }
    return index;
  }

  private findIndexForPythonFile(pythonFile: string): EntityMappingIndex | undefined {
    const normalized = normalizeLookupPath(pythonFile);
    return [...this.mappingIndexes.values()].find(index =>
      index.pythonOwnerFiles.some(item => normalizeLookupPath(item.filePath) === normalized)
    );
  }

  private getWorkspaceRoot(filePath: string): string | null {
    const workspaceFolder = vscode.workspace.workspaceFolders?.find(folder =>
      filePath.startsWith(`${folder.uri.fsPath}${path.sep}`) || filePath.startsWith(`${folder.uri.fsPath}/`)
    );
    return workspaceFolder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
  }

  private createLegacyIdentity(
    entityName: string,
    methodName?: string,
    section?: EntityMethodSection
  ): DefinitionSymbolIdentity | null {
    if (!entityName || !methodName || !section) {
      return null;
    }

    return {
      ownerKind: 'entity',
      ownerName: entityName,
      sourceKind: 'local',
      sourceChain: [],
      section,
      symbolName: methodName
    };
  }

  private toLegacyMapping(index: EntityMappingIndex): EntityMapping {
    const properties: EntityMapping['properties'] = {};
    for (const property of index.propertyDefinitions) {
      const propertyPath = property.identity.propertyPath;
      if (!propertyPath || properties[propertyPath]) {
        continue;
      }

      properties[propertyPath] = {
        defFile: property.defFile,
        line: property.line
      };
    }

    const methods: EntityMapping['methods'] = {};
    for (const method of index.methodDefinitions) {
      const list = methods[method.identity.symbolName] || [];
      list.push({
        defFile: method.defFile,
        line: method.line,
        section: method.section,
        exposed: method.exposed,
        identity: method.identity
      });
      methods[method.identity.symbolName] = list;
    }

    return {
      name: index.rootName,
      defFile: index.rootDefFile,
      pythonFile: index.pythonOwnerFiles[0]?.filePath || buildFallbackPythonPath(index.rootName),
      pythonFiles: uniqueFilePaths(index.pythonOwnerFiles.map(item => item.filePath)).length > 0
        ? uniqueFilePaths(index.pythonOwnerFiles.map(item => item.filePath))
        : [buildFallbackPythonPath(index.rootName)],
      properties,
      methods
    };
  }
}

function buildFallbackPythonPath(entityName: string): string {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  return joinWorkspacePath(workspaceRoot, 'scripts/base', `${entityName}.py`);
}

function buildMethodOwnerBindingKey(identity: {
  ownerKind: DefinitionSemanticCategory;
  ownerName: string;
  section?: EntityMethodSection;
  symbolName: string;
}): string {
  return [
    identity.ownerKind,
    identity.ownerName,
    identity.section || '',
    identity.symbolName
  ].join('::').toLowerCase();
}

function sameIdentity(left: DefinitionSymbolIdentity, right: DefinitionSymbolIdentity): boolean {
  return left.ownerKind === right.ownerKind
    && left.ownerName === right.ownerName
    && left.sourceKind === right.sourceKind
    && left.section === right.section
    && left.symbolName === right.symbolName
    && left.componentSlotName === right.componentSlotName
    && normalizePropertyLookupPath(left.propertyPath || '') === normalizePropertyLookupPath(right.propertyPath || '')
    && left.sourceChain.join('::').toLowerCase() === right.sourceChain.join('::').toLowerCase();
}

function inferOwnerNameFromPythonFile(pythonFile: string): string {
  return path.basename(pythonFile, '.py');
}

function inferOwnerKindFromPythonFile(
  pythonFile: string
): DefinitionSemanticCategory | undefined {
  const normalizedPath = normalizeLookupPath(pythonFile);
  if (normalizedPath.includes('/components/')) {
    return 'component';
  }
  if (normalizedPath.includes('/interfaces/')) {
    return 'interface';
  }
  if (normalizedPath.endsWith('.py')) {
    return 'entity';
  }
  return undefined;
}

function inferMethodSectionFromPythonFile(pythonFile: string): EntityMethodSection | undefined {
  const normalizedPath = normalizeLookupPath(pythonFile);

  if (normalizedPath.includes('/scripts/base/') || normalizedPath.includes('/assets/scripts/base/')) {
    return 'BaseMethods';
  }

  if (normalizedPath.includes('/scripts/cell/') || normalizedPath.includes('/assets/scripts/cell/')) {
    return 'CellMethods';
  }

  if (normalizedPath.includes('/scripts/client/') || normalizedPath.includes('/assets/scripts/client/')) {
    return 'ClientMethods';
  }

  return undefined;
}

function uniqueFilePaths(candidatePaths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidatePath of candidatePaths) {
    const normalized = normalizeLookupPath(candidatePath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(candidatePath);
  }
  return unique;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLineNumber(text: string, index: number): number {
  return text.substring(0, index).split('\n').length;
}

function getColumnNumber(text: string, index: number): number {
  const lineStart = text.lastIndexOf('\n', index - 1);
  return index - (lineStart + 1);
}

function normalizePropertyLookupPath(value: string): string {
  return value.trim().toLowerCase();
}

function parsePythonMethodBlocks(
  content: string,
  pythonFile: string
): IndexedPythonMethodLocation[] {
  const lines = content.split('\n');
  const methods: IndexedPythonMethodLocation[] = [];
  const definitionRegex = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index];
    const match = definitionRegex.exec(lineText);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    const methodName = match[2];
    const character = lineText.indexOf(methodName);
    let endLine = lines.length;

    for (let nextLine = index + 1; nextLine < lines.length; nextLine += 1) {
      const nextText = lines[nextLine];
      if (!nextText.trim()) {
        continue;
      }

      const nextIndent = nextText.match(/^\s*/)?.[0].length || 0;
      if (nextIndent <= indent) {
        endLine = nextLine;
        break;
      }
    }

    const bodyLines = lines.slice(index + 1, endLine);
    methods.push({
      filePath: pythonFile,
      methodName,
      line: index + 1,
      character,
      endLine,
      calls: parsePythonSelfCalls(bodyLines, index + 2, pythonFile)
    });
  }

  return methods;
}

function parsePythonSelfCalls(
  bodyLines: string[],
  startLine: number,
  pythonFile: string
): Array<{ methodName: string; line: number; character: number; filePath: string }> {
  const calls: Array<{ methodName: string; line: number; character: number; filePath: string }> = [];
  const callRegex = /\bself\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  for (let index = 0; index < bodyLines.length; index += 1) {
    const lineText = bodyLines[index];
    let match: RegExpExecArray | null;

    while ((match = callRegex.exec(lineText)) !== null) {
      calls.push({
        methodName: match[1],
        line: startLine + index,
        character: match.index + match[0].indexOf(match[1]),
        filePath: pythonFile
      });
    }
  }

  return calls;
}
