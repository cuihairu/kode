/**
 * KBEngine Entity Definition 映射管理器
 * 管理 .def 文件与生成的 Python 文件之间的映射关系
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  DefDocument,
  DefElementNode,
  getDirectChildElement,
  getDirectChildElements,
  getLineNumberAt,
  hasTruthyChildTag,
  parseDefDocument
} from './defParser';
import { joinWorkspacePath } from './workspacePath';

export type EntityMethodSection = 'BaseMethods' | 'CellMethods' | 'ClientMethods';

export interface EntityMethodDefinitionLocation {
  defFile: string;
  line: number;
  section: EntityMethodSection;
  exposed: boolean;
}

/**
 * 实体定义映射信息
 */
export interface EntityMapping {
  /** 实体名称 */
  name: string;
  /** .def 文件路径 */
  defFile: string;
  /** Python 文件路径 */
  pythonFile: string;
  /** 可能的 Python 文件路径 */
  pythonFiles: string[];
  /** 属性映射（属性名 -> .def 中的行号） */
  properties: { [propertyName: string]: { defFile: string, line: number } };
  /** 方法映射（方法名 -> .def 中的行号） */
  methods: { [methodName: string]: EntityMethodDefinitionLocation[] };
}

/**
 * 实体定义映射管理器
 */
export class EntityMappingManager {
  private mappings: Map<string, EntityMapping> = new Map();
  private pythonWatcher: vscode.FileSystemWatcher | null = null;

  constructor(private context: vscode.ExtensionContext) {
    this.scanEntityMappings();
    this.watchPythonFiles();
  }

  /**
   * 扫描实体定义映射
   */
  private async scanEntityMappings(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const defFiles = await vscode.workspace.findFiles('**/*.def', null);

    for (const defFile of defFiles) {
      const entityName = path.basename(defFile.fsPath, '.def');
      await this.parseDefFile(entityName, defFile.fsPath);
    }
  }

  /**
   * 解析 .def 文件，提取映射信息
   */
  private async parseDefFile(entityName: string, defPath: string): Promise<void> {
    try {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.file(defPath));
      const text = Buffer.from(content).toString('utf8');
      const document = parseDefDocument(text);
      const pythonPaths = this.findPythonFiles(defPath);

      const mapping: EntityMapping = {
        name: entityName,
        defFile: defPath,
        pythonFile: pythonPaths[0],
        pythonFiles: pythonPaths,
        properties: {},
        methods: {}
      };

      this.collectPropertyMappings(document, defPath, mapping);
      this.collectMethodMappings(document, defPath, mapping);

      this.mappings.set(entityName, mapping);
    } catch (error) {
      console.error(`解析 .def 文件失败: ${defPath}`, error);
    }
  }

  /**
   * 查找对应的 Python 文件
   */
  private findPythonFiles(defPath: string): string[] {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const entityName = path.basename(defPath, '.def');
    const possiblePaths = [
      joinWorkspacePath(workspaceRoot, 'scripts/base', `${entityName}.py`),
      joinWorkspacePath(workspaceRoot, 'scripts/cell', `${entityName}.py`),
      joinWorkspacePath(workspaceRoot, 'scripts/interfaces', `${entityName}.py`),
      joinWorkspacePath(workspaceRoot, 'assets/scripts/base', `${entityName}.py`),
      joinWorkspacePath(workspaceRoot, 'assets/scripts/cell', `${entityName}.py`),
      joinWorkspacePath(workspaceRoot, 'assets/scripts/interfaces', `${entityName}.py`),
      joinWorkspacePath(workspaceRoot, 'assets/scripts/entity_defs', `${entityName}.py`),
      joinWorkspacePath(workspaceRoot, 'scripts/entity_defs', `${entityName}.py`)
    ];
    const existingPaths = possiblePaths.filter(candidatePath => fs.existsSync(candidatePath));

    return existingPaths.length > 0 ? existingPaths : [
      joinWorkspacePath(workspaceRoot, 'scripts/base', `${entityName}.py`)
    ];
  }

  private collectPropertyMappings(document: DefDocument, defPath: string, mapping: EntityMapping): void {
    const propertySection = getDirectChildElement(document.root, 'Properties');
    if (!propertySection) {
      return;
    }

    this.collectPropertyBlocks(document, defPath, mapping, propertySection, '');
  }

  private collectMethodMappings(document: DefDocument, defPath: string, mapping: EntityMapping): void {
    const methodSections: EntityMethodSection[] = ['BaseMethods', 'CellMethods', 'ClientMethods'];

    for (const sectionName of methodSections) {
      const sectionNode = getDirectChildElement(document.root, sectionName);
      if (!sectionNode) {
        continue;
      }

      for (const methodNode of getDirectChildElements(sectionNode)) {
        const definitions = mapping.methods[methodNode.name] || [];
        definitions.push({
          defFile: defPath,
          line: getLineNumberAt(document, methodNode.tagStart),
          section: sectionName,
          exposed: hasTruthyChildTag(methodNode, 'Exposed')
        });
        mapping.methods[methodNode.name] = definitions;
      }
    }
  }

  private collectPropertyBlocks(
    document: DefDocument,
    defPath: string,
    mapping: EntityMapping,
    sectionNode: DefElementNode,
    prefixPath: string
  ): void {
    for (const propertyNode of getDirectChildElements(sectionNode)) {
      if (!getDirectChildElement(propertyNode, 'Type')) {
        continue;
      }

      const propertyPath = prefixPath ? `${prefixPath}.${propertyNode.name}` : propertyNode.name;
      mapping.properties[propertyPath] = {
        defFile: defPath,
        line: getLineNumberAt(document, propertyNode.tagStart)
      };

      const nestedPropertySection = getDirectChildElement(propertyNode, 'Properties');
      if (nestedPropertySection) {
        this.collectPropertyBlocks(document, defPath, mapping, nestedPropertySection, propertyPath);
      }
    }
  }

  /**
   * 监视 Python 文件变化
   */
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

  /**
   * 处理 Python 文件变化
   */
  private handlePythonFileChanged(pythonPath: string): void {
    for (const [entityName, mapping] of this.mappings) {
      if (mapping.pythonFiles.includes(pythonPath)) {
        this.parseDefFile(entityName, mapping.defFile);
        break;
      }
    }
  }

  /**
   * 根据实体名称获取映射
   */
  getMapping(entityName: string): EntityMapping | undefined {
    return this.mappings.get(entityName);
  }

  /**
   * 获取所有映射
   */
  getAllMappings(): EntityMapping[] {
    return Array.from(this.mappings.values());
  }

  async resolvePropertyDefinition(
    pythonFile: string,
    fullPath: string,
    rootSymbol?: string
  ): Promise<{ defFile: string; line: number } | null> {
    const entityName = path.basename(pythonFile, '.py');
    const mapping = await this.ensureMapping(entityName);
    if (!mapping) {
      return null;
    }

    return mapping.properties[fullPath]
      || (rootSymbol ? mapping.properties[rootSymbol] : undefined)
      || null;
  }

  async resolveMethodDefinition(
    pythonFile: string,
    methodName: string
  ): Promise<EntityMethodDefinitionLocation | null> {
    const entityName = path.basename(pythonFile, '.py');
    const mapping = await this.ensureMapping(entityName);
    if (!mapping) {
      return null;
    }

    return this.selectMethodDefinition(
      mapping.methods[methodName] || [],
      inferMethodSectionFromPythonFile(pythonFile)
    );
  }

  async openMethodTarget(
    entityName: string,
    methodName: string,
    section: EntityMethodSection
  ): Promise<boolean> {
    const mapping = await this.ensureMapping(entityName);
    if (!mapping) {
      return false;
    }

    const implementationTarget = this.findMethodImplementation(mapping, methodName, section);
    if (implementationTarget) {
      return this.openFileAtLocation(implementationTarget.filePath, implementationTarget.line);
    }

    const definition = this.selectMethodDefinition(mapping.methods[methodName] || [], section);
    if (!definition) {
      return false;
    }

    return this.openFileAtLocation(definition.defFile, definition.line);
  }

  private findMethodImplementation(
    mapping: EntityMapping,
    methodName: string,
    section: EntityMethodSection
  ): { filePath: string; line: number } | null {
    const candidateFiles = mapping.pythonFiles.filter(candidatePath =>
      inferMethodSectionFromPythonFile(candidatePath) === section
    );

    for (const candidateFile of candidateFiles) {
      const line = this.findPythonMethodLine(candidateFile, methodName);
      if (line !== null) {
        return {
          filePath: candidateFile,
          line
        };
      }
    }

    return null;
  }

  private findPythonMethodLine(pythonFile: string, methodName: string): number | null {
    if (!fs.existsSync(pythonFile)) {
      return null;
    }

    try {
      const content = fs.readFileSync(pythonFile, 'utf8');
      const regex = new RegExp(`^\\s*(?:async\\s+)?def\\s+${escapeRegExp(methodName)}\\s*\\(`, 'm');
      const match = regex.exec(content);
      if (!match) {
        return null;
      }

      return getLineNumber(content, match.index);
    } catch {
      return null;
    }
  }

  private async openFileAtLocation(filePath: string, line: number): Promise<boolean> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const position = new vscode.Position(Math.max(line - 1, 0), 0);
    const range = new vscode.Range(position, position);
    const textEditor = await vscode.window.showTextDocument(document, {
      selection: range
    });

    return textEditor !== undefined;
  }

  private async ensureMapping(entityName: string): Promise<EntityMapping | undefined> {
    let mapping = this.mappings.get(entityName);
    if (!mapping) {
      await this.scanEntityMappings();
      mapping = this.mappings.get(entityName);
    }

    return mapping;
  }

  private selectMethodDefinition(
    definitions: EntityMethodDefinitionLocation[],
    preferredSection?: EntityMethodSection
  ): EntityMethodDefinitionLocation | null {
    if (definitions.length === 0) {
      return null;
    }

    if (preferredSection) {
      const matchedDefinition = definitions.find(definition => definition.section === preferredSection);
      if (matchedDefinition) {
        return matchedDefinition;
      }
    }

    return definitions[0];
  }

  /**
   * 从 Python 文件跳转到 .def 文件
   */
  async jumpToDef(pythonFile: string, symbol: string, type: 'property' | 'method'): Promise<boolean> {
    const location = type === 'property'
      ? await this.resolvePropertyDefinition(pythonFile, symbol, symbol)
      : await this.resolveMethodDefinition(pythonFile, symbol);

    if (!location) {
      return false;
    }

    return this.openFileAtLocation(location.defFile, location.line);
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.pythonWatcher) {
      this.pythonWatcher.dispose();
    }
  }
}

function inferMethodSectionFromPythonFile(pythonFile: string): EntityMethodSection | undefined {
  const normalizedPath = pythonFile.replace(/\\/g, '/').toLowerCase();

  if (normalizedPath.includes('/scripts/base/')) {
    return 'BaseMethods';
  }

  if (normalizedPath.includes('/scripts/cell/')) {
    return 'CellMethods';
  }

  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLineNumber(text: string, index: number): number {
  const beforeIndex = text.substring(0, index);
  return beforeIndex.split('\n').length;
}
