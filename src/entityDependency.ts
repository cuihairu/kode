/**
 * KBEngine 实体依赖关系分析器
 * 分析实体之间的继承和引用关系，生成依赖图
 */

import * as vscode from 'vscode';
import * as path from 'path';
import {
  findEntityDefinitionFile,
  getRegisteredEntities,
  getWorkspaceRootForDocument
} from './definitionWorkspace';

/**
 * 实体类型
 */
export enum EntityType {
  Base = 'Base',
  Cell = 'Cell',
  Client = 'Client'
}

/**
 * 依赖关系类型
 */
export enum DependencyType {
  /** 继承关系 */
  Inheritance = 'inheritance',
  /** ARRAY 包含实体 */
  Array = 'array',
  /** FIXED_DICT 包含实体 */
  FixedDict = 'fixed_dict',
  /** TUPLE 包含实体 */
  Tuple = 'tuple'
}

/**
 * 实体节点信息
 */
export interface EntityNode {
  /** 实体名称 */
  name: string;
  /** .def 文件路径 */
  defFile: string;
  /** 实体类型（Base/Cell/Client） */
  types: EntityType[];
  /** 父实体 */
  parent?: string;
  /** 引用的其他实体 */
  references: { entityName: string, type: DependencyType, propertyName: string }[];
  /** 被引用次数 */
  referencedBy: number;
  /** 位置信息（用于可视化布局） */
  position?: { x: number; y: number };
}

/**
 * 依赖边信息
 */
export interface DependencyEdge {
  /** 源实体 */
  from: string;
  /** 目标实体 */
  to: string;
  /** 关系类型 */
  type: DependencyType;
  /** 属性名称 */
  label: string;
}

/**
 * 依赖图数据
 */
export interface DependencyGraph {
  /** 所有节点 */
  nodes: EntityNode[];
  /** 所有边 */
  edges: DependencyEdge[];
  /** 统计信息 */
  stats: {
    totalEntities: number;
    baseEntities: number;
    cellEntities: number;
    clientEntities: number;
    maxDepth: number;
    mostReferenced: string;
  };
}

/**
 * 实体依赖关系分析器
 */
export class EntityDependencyAnalyzer {
  private entities: Map<string, EntityNode> = new Map();
  private edges: DependencyEdge[] = [];

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * 分析所有实体依赖关系
   */
  async analyze(): Promise<DependencyGraph> {
    this.entities.clear();
    this.edges = [];

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return this.getEmptyGraph();
    }

    await this.loadFromEntitiesXml();

    // 查找所有 .def 文件
    const defFiles = await vscode.workspace.findFiles('**/*.def', null);

    // 第一遍：读取所有实体信息
    for (const defFile of defFiles) {
      await this.parseEntityFile(defFile.fsPath);
    }

    // 第二遍：解析依赖关系
    for (const [, node] of this.entities) {
      await this.parseDependencies(node);
    }

    // 计算统计信息
    const stats = this.calculateStats();

    return {
      nodes: Array.from(this.entities.values()),
      edges: this.edges,
      stats
    };
  }

  /**
   * 解析实体文件
   */
  private async parseEntityFile(defPath: string): Promise<void> {
    try {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.parse(defPath));
      const text = Buffer.from(content).toString('utf8');
      const entityName = path.basename(defPath, '.def');
      const existingNode = this.entities.get(entityName);
      const node: EntityNode = existingNode || {
        name: entityName,
        defFile: defPath,
        types: [],
        references: [],
        referencedBy: 0
      };
      node.defFile = defPath;
      node.references = [];
      node.types = existingNode ? [...existingNode.types] : [];

      // 当 entities.xml 尚未提供类型标记时，只从明确的方法区块补充组件域。
      const hasBase = /<BaseMethods>/i.test(text);
      const hasCell = /<CellMethods>/i.test(text);
      const hasClient = /<ClientMethods>/i.test(text);

      if (hasBase && !node.types.includes(EntityType.Base)) node.types.push(EntityType.Base);
      if (hasCell && !node.types.includes(EntityType.Cell)) node.types.push(EntityType.Cell);
      if (hasClient && !node.types.includes(EntityType.Client)) node.types.push(EntityType.Client);

      // 查找父实体
      const parentMatch = text.match(/<Parent>\s*<([A-Za-z_][A-Za-z0-9_]*)\s*\/>\s*<\/Parent>/i);
      if (parentMatch) {
        node.parent = parentMatch[1];
      }

      this.entities.set(entityName, node);
    } catch (error) {
      console.error(`解析实体文件失败: ${defPath}`, error);
    }
  }

  /**
   * 解析实体的依赖关系
   */
  private async parseDependencies(node: EntityNode): Promise<void> {
    try {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.parse(node.defFile));
      const text = Buffer.from(content).toString('utf8');
      const sections = ['Properties'];

      for (const sectionName of sections) {
        const sectionBlocks = extractTagBodies(text, sectionName);
        for (const sectionBody of sectionBlocks) {
          const propertyBlocks = extractNamedChildBlocks(sectionBody);
          for (const property of propertyBlocks) {
            const references = this.extractReferencesFromProperty(property.name, property.body);
            for (const reference of references) {
              node.references.push(reference);
              if (this.entities.has(reference.entityName)) {
                this.edges.push({
                  from: node.name,
                  to: reference.entityName,
                  type: reference.type,
                  label: reference.propertyName
                });

                const targetNode = this.entities.get(reference.entityName);
                if (targetNode) {
                  targetNode.referencedBy++;
                }
              }
            }
          }
        }
      }

      // 如果有父实体，添加继承关系
      if (node.parent && this.entities.has(node.parent)) {
        this.edges.push({
          from: node.name,
          to: node.parent,
          type: DependencyType.Inheritance,
          label: '继承'
        });

        // 增加被引用计数
        const parentNode = this.entities.get(node.parent);
        if (parentNode) {
          parentNode.referencedBy++;
        }
      }

    } catch (error) {
      console.error(`解析依赖关系失败: ${node.defFile}`, error);
    }
  }

  /**
   * 从 entities.xml 读取实体列表和类型
   */
  async loadFromEntitiesXml(): Promise<void> {
    const workspaceRoot = getWorkspaceRootForDocument();
    if (!workspaceRoot) {
      return;
    }

    for (const entity of getRegisteredEntities(workspaceRoot)) {
      const entityName = entity.name;
      const defPath = this.findEntityDefFile(entityName);
      if (!defPath) {
        continue;
      }

      if (!this.entities.has(entityName)) {
        const node: EntityNode = {
          name: entityName,
          defFile: defPath,
          types: [],
          references: [],
          referencedBy: 0
        };

        if (entity.hasCell) {
          node.types.push(EntityType.Cell);
        }
        if (entity.hasBase) {
          node.types.push(EntityType.Base);
        }
        if (entity.hasClient) {
          node.types.push(EntityType.Client);
        }

        this.entities.set(entityName, node);
      }
    }
  }

  /**
   * 查找实体定义文件
   */
  private findEntityDefFile(entityName: string): string | null {
    return findEntityDefinitionFile(entityName);
  }

  /**
   * 计算统计信息
   */
  private calculateStats(): DependencyGraph['stats'] {
    const nodes = Array.from(this.entities.values());

    let baseEntities = 0;
    let cellEntities = 0;
    let clientEntities = 0;

    for (const node of nodes) {
      if (node.types.includes(EntityType.Base)) baseEntities++;
      if (node.types.includes(EntityType.Cell)) cellEntities++;
      if (node.types.includes(EntityType.Client)) clientEntities++;
    }

    // 计算最大深度
    const maxDepth = this.calculateMaxDepth();

    // 找出被引用最多的实体
    let mostReferenced = '';
    let maxRefCount = 0;
    for (const [name, node] of this.entities) {
      if (node.referencedBy > maxRefCount) {
        maxRefCount = node.referencedBy;
        mostReferenced = name;
      }
    }

    return {
      totalEntities: nodes.length,
      baseEntities,
      cellEntities,
      clientEntities,
      maxDepth,
      mostReferenced
    };
  }

  /**
   * 计算继承树的最大深度
   */
  private calculateMaxDepth(): number {
    let maxDepth = 0;

    const calculateDepth = (entityName: string, currentDepth: number): void => {
      if (currentDepth > maxDepth) {
        maxDepth = currentDepth;
      }

      const node = this.entities.get(entityName);
      if (node && node.parent) {
        calculateDepth(node.parent, currentDepth + 1);
      }
    };

    for (const [name, node] of this.entities) {
      if (!node.parent) {
        calculateDepth(name, 1);
      }
    }

    return maxDepth;
  }

  /**
   * 获取空图
   */
  private getEmptyGraph(): DependencyGraph {
    return {
      nodes: [],
      edges: [],
      stats: {
        totalEntities: 0,
        baseEntities: 0,
        cellEntities: 0,
        clientEntities: 0,
        maxDepth: 0,
        mostReferenced: ''
      }
    };
  }

  /**
   * 获取特定实体的节点信息
   */
  getEntityNode(entityName: string): EntityNode | undefined {
    return this.entities.get(entityName);
  }

  /**
   * 获取实体的所有子类
   */
  getChildren(entityName: string): EntityNode[] {
    const children: EntityNode[] = [];

    for (const [, node] of this.entities) {
      if (node.parent === entityName) {
        children.push(node);
      }
    }

    return children;
  }

  /**
   * 获取实体的所有祖先
   */
  getAncestors(entityName: string): EntityNode[] {
    const ancestors: EntityNode[] = [];
    let currentName = entityName;

    while (currentName) {
      const node = this.entities.get(currentName);
      if (!node || !node.parent) {
        break;
      }

      const parentNode = this.entities.get(node.parent);
      if (parentNode) {
        ancestors.push(parentNode);
        currentName = node.parent;
      } else {
        break;
      }
    }

    return ancestors;
  }

  private extractReferencesFromProperty(
    propertyName: string,
    propertyBody: string
  ): Array<{ entityName: string; type: DependencyType; propertyName: string }> {
    const references: Array<{ entityName: string; type: DependencyType; propertyName: string }> = [];
    const typeBodies = extractTagBodies(propertyBody, 'Type');

    for (const rawTypeBody of typeBodies) {
      const typeBody = rawTypeBody.trim();
      const containerMatch = typeBody.match(/^([A-Z_]+)\s*<([\s\S]+)>$/);

      if (containerMatch) {
        const containerType = containerMatch[1];
        const innerType = stripXmlTags(containerMatch[2]).trim();
        const dependencyType = this.mapContainerType(containerType);
        if (dependencyType && this.isEntityReference(innerType)) {
          references.push({
            entityName: innerType,
            type: dependencyType,
            propertyName
          });
        }
        continue;
      }

      if (typeBody === 'FIXED_DICT') {
        const dictReferences = this.extractFixedDictReferences(propertyName, propertyBody);
        references.push(...dictReferences);
        continue;
      }

      if (typeBody === 'TUPLE') {
        const tupleReferences = this.extractTupleReferences(propertyName, propertyBody);
        references.push(...tupleReferences);
      }
    }

    return dedupeReferences(references);
  }

  private extractFixedDictReferences(
    propertyName: string,
    propertyBody: string
  ): Array<{ entityName: string; type: DependencyType; propertyName: string }> {
    const references: Array<{ entityName: string; type: DependencyType; propertyName: string }> = [];
    const implementedByBlocks = extractTagBodies(propertyBody, 'implementedBy');

    for (const block of implementedByBlocks) {
      for (const typeBody of extractTagBodies(block, 'Type')) {
        const candidate = stripXmlTags(typeBody).trim();
        if (this.isEntityReference(candidate)) {
          references.push({
            entityName: candidate,
            type: DependencyType.FixedDict,
            propertyName
          });
        }
      }
    }

    const nestedProperties = extractTagBodies(propertyBody, 'Properties');
    for (const nestedPropertySection of nestedProperties) {
      const propertyBlocks = extractNamedChildBlocks(nestedPropertySection);
      for (const nestedProperty of propertyBlocks) {
        const nestedReferences = this.extractReferencesFromProperty(
          `${propertyName}.${nestedProperty.name}`,
          nestedProperty.body
        );
        references.push(...nestedReferences);
      }
    }

    return references;
  }

  private extractTupleReferences(
    propertyName: string,
    propertyBody: string
  ): Array<{ entityName: string; type: DependencyType; propertyName: string }> {
    const references: Array<{ entityName: string; type: DependencyType; propertyName: string }> = [];

    for (const typeBody of extractTagBodies(propertyBody, 'Type')) {
      const candidate = stripXmlTags(typeBody).trim();
      if (this.isEntityReference(candidate)) {
        references.push({
          entityName: candidate,
          type: DependencyType.Tuple,
          propertyName
        });
      }
    }

    return references;
  }
  private isEntityReference(typeName: string): boolean {
    return /^[A-Z][A-Za-z0-9_]*$/.test(typeName) && this.entities.has(typeName);
  }

  private mapContainerType(typeName: string): DependencyType | null {
    switch (typeName) {
      case 'ARRAY':
        return DependencyType.Array;
      case 'FIXED_DICT':
        return DependencyType.FixedDict;
      case 'TUPLE':
        return DependencyType.Tuple;
      default:
        return null;
    }
  }
}

function extractTagBodies(text: string, tagName: string): string[] {
  const regex = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, 'gi');
  const bodies: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    bodies.push(match[1]);
  }

  return bodies;
}

function extractNamedChildBlocks(text: string): Array<{ name: string; body: string }> {
  const regex = /<([A-Za-z_][A-Za-z0-9_]*)>\s*([\s\S]*?)\s*<\/\1>/g;
  const reserved = new Set([
    'Type',
    'Flags',
    'Default',
    'Database',
    'Identifier',
    'DetailLevel',
    'Arg',
    'implementedBy',
    'Properties',
    'BaseMethods',
    'CellMethods',
    'ClientMethods'
  ]);
  const blocks: Array<{ name: string; body: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    if (reserved.has(name)) {
      continue;
    }

    blocks.push({
      name,
      body: match[2]
    });
  }

  return blocks;
}

function stripXmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function dedupeReferences(
  references: Array<{ entityName: string; type: DependencyType; propertyName: string }>
): Array<{ entityName: string; type: DependencyType; propertyName: string }> {
  const seen = new Set<string>();
  return references.filter(reference => {
    const key = `${reference.entityName}:${reference.type}:${reference.propertyName}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
