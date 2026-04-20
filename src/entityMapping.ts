/**
 * KBEngine Entity Definition 映射管理器
 * 管理 .def 文件与生成的 Python 文件之间的映射关系
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { joinWorkspacePath } from './workspacePath';

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
  /** 属性映射（属性名 → .def 中的行号） */
  properties: { [propertyName: string]: { defFile: string, line: number } };
  /** 方法映射（方法名 → .def 中的行号） */
  methods: { [methodName: string]: { defFile: string, line: number } };
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

    // 查找所有 .def 文件
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

      const pythonPaths = this.findPythonFiles(defPath);

      const mapping: EntityMapping = {
        name: entityName,
        defFile: defPath,
        pythonFile: pythonPaths[0],
        pythonFiles: pythonPaths,
        properties: {},
        methods: {}
      };

      this.collectPropertyMappings(text, defPath, mapping);
      this.collectMethodMappings(text, defPath, mapping);

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

  /**
   * 获取文本中某个位置的行号
   */
  private getLineNumber(text: string, index: number): number {
    const beforeIndex = text.substring(0, index);
    return beforeIndex.split('\n').length;
  }

  private collectPropertyMappings(text: string, defPath: string, mapping: EntityMapping): void {
    const propertySections = ['Properties'];

    for (const sectionName of propertySections) {
      const sections = this.extractTagBodiesWithIndex(text, sectionName);
      for (const section of sections) {
        this.collectPropertyBlocks(text, defPath, mapping, section.body, section.index, '');
      }
    }
  }

  private collectMethodMappings(text: string, defPath: string, mapping: EntityMapping): void {
    const methodSections = ['BaseMethods', 'CellMethods', 'ClientMethods'];

    for (const sectionName of methodSections) {
      const sections = this.extractTagBodiesWithIndex(text, sectionName);
      for (const section of sections) {
        for (const methodBlock of this.extractDirectChildBlocks(section.body)) {
          const methodName = methodBlock.name;
          const methodBody = methodBlock.body;
          if (!/<Arg>/i.test(methodBody) && methodBody.trim().length > 0) {
            continue;
          }

          const line = this.getLineNumber(text, section.index + methodBlock.index);
          mapping.methods[methodName] = {
            defFile: defPath,
            line
          };
        }
      }
    }
  }

  private extractTagBodies(text: string, tagName: string): string[] {
    return this.extractTagBodiesWithIndex(text, tagName).map(item => item.body);
  }

  private extractTagBodiesWithIndex(text: string, tagName: string): Array<{ body: string; index: number }> {
    const regex = new RegExp(`<(\\/)?${tagName}>`, 'gi');
    const bodies: Array<{ body: string; index: number }> = [];
    let match: RegExpExecArray | null;
    const openTagStack: number[] = [];

    while ((match = regex.exec(text)) !== null) {
      const isClosingTag = match[1] === '/';

      if (!isClosingTag) {
        openTagStack.push(match.index);
        continue;
      }

      const openTagIndex = openTagStack.pop();
      if (openTagIndex === undefined || openTagStack.length > 0) {
        continue;
      }

      const openTagText = `<${tagName}>`;
      const bodyStart = openTagIndex + openTagText.length;
      const bodyEnd = match.index;
      bodies.push({
        body: text.slice(bodyStart, bodyEnd),
        index: bodyStart
      });
    }

    return bodies;
  }

  private extractDirectChildBlocks(
    text: string
  ): Array<{ name: string; body: string; index: number }> {
    const regex = /<(\/)?([A-Za-z_][A-Za-z0-9_]*)>/g;
    const blocks: Array<{ name: string; body: string; index: number }> = [];
    const stack: Array<{ name: string; tagStart: number; bodyStart: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const isClosingTag = match[1] === '/';
      const tagName = match[2];

      if (!isClosingTag) {
        stack.push({
          name: tagName,
          tagStart: match.index,
          bodyStart: regex.lastIndex
        });
        continue;
      }

      const lastOpenTag = stack.pop();
      if (!lastOpenTag || lastOpenTag.name !== tagName) {
        continue;
      }

      if (stack.length === 0) {
        blocks.push({
          name: tagName,
          body: text.slice(lastOpenTag.bodyStart, match.index),
          index: lastOpenTag.tagStart
        });
      }
    }

    return blocks;
  }

  private collectPropertyBlocks(
    fullText: string,
    defPath: string,
    mapping: EntityMapping,
    sectionBody: string,
    sectionOffset: number,
    prefixPath: string
  ): void {
    for (const propertyBlock of this.extractDirectChildBlocks(sectionBody)) {
      const propertyName = propertyBlock.name;
      const propertyBody = propertyBlock.body;
      if (!/<Type>/i.test(propertyBody)) {
        continue;
      }

      const propertyPath = prefixPath ? `${prefixPath}.${propertyName}` : propertyName;
      const line = this.getLineNumber(fullText, sectionOffset + propertyBlock.index);
      mapping.properties[propertyPath] = {
        defFile: defPath,
        line
      };

      const nestedPropertySections = this.extractTagBodiesWithIndex(propertyBody, 'Properties');
      for (const nestedSection of nestedPropertySections) {
        const nestedSectionOffset = fullText.indexOf(
          nestedSection.body,
          sectionOffset + propertyBlock.index
        );

        this.collectPropertyBlocks(
          fullText,
          defPath,
          mapping,
          nestedSection.body,
          nestedSectionOffset >= 0
            ? nestedSectionOffset
            : sectionOffset + propertyBlock.index + nestedSection.index,
          propertyPath
        );
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
    // 重新扫描相关映射
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

  /**
   * 从 Python 文件跳转到 .def 文件
   */
  async jumpToDef(pythonFile: string, symbol: string, type: 'property' | 'method'): Promise<boolean> {
    // 查找包含此符号的实体
    const entityName = path.basename(pythonFile, '.py');

    let mapping = this.mappings.get(entityName);
    if (!mapping) {
      // 尝试重新扫描
      await this.scanEntityMappings();
      mapping = this.mappings.get(entityName);
      if (!mapping) {
        return false;
      }
    }

    const location = type === 'property'
      ? mapping.properties[symbol]
      : mapping.methods[symbol];

    if (!location) {
      return false;
    }

    // 打开 .def 文件并跳转到指定位置
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(location.defFile));
    const position = new vscode.Position(location.line - 1, 0);

    const range = new vscode.Range(position, position);

    // 显示并选中文本
    const textEditor = await vscode.window.showTextDocument(document, {
      selection: range
    });

    return textEditor !== undefined;
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
