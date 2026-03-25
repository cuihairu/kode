/**
 * KBEngine 实体依赖关系分析器
 * 分析实体之间的继承和引用关系，生成依赖图
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

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
  /** MAILBOX 引用 */
  Mailbox = 'mailbox',
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

    // 查找所有 .def 文件
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return this.getEmptyGraph();
    }

    const defFiles = await vscode.workspace.findFiles('**/*.def', null);

    // 第一遍：读取所有实体信息
    for (const defFile of defFiles) {
      await this.parseEntityFile(defFile.fsPath);
    }

    // 第二遍：解析依赖关系
    for (const [entityName, node] of this.entities) {
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

      const node: EntityNode = {
        name: entityName,
        defFile: defPath,
        types: [],
        references: [],
        referencedBy: 0
      };

      // 检查实体类型（Base/Cell/Client）
      const hasBase = /<Base>\s*<[^>]*>/i.test(text);
      const hasCell = /<Cell>\s*<[^>]*>/i.test(text);
      const hasClient = /<Client>\s*<[^>]*>/i.test(text);

      if (hasBase) node.types.push(EntityType.Base);
      if (hasCell) node.types.push(EntityType.Cell);
      if (hasClient) node.types.push(EntityType.Client);

      // 查找父实体（通过 <Implements> 标签）
      const implementsMatch = text.match(/<Implements>\s*<(\w+)\s*\/>/i);
      if (implementsMatch) {
        node.parent = implementsMatch[1];
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

      // 解析属性中的实体引用
      const propertyRegex = /<(\w+)>\s*<Type>\s*(\w+)(?:\s*<\w+>)?/g;
      let match;

      while ((match = propertyRegex.exec(text)) !== null) {
        const propertyName = match[1];
        const typeName = match[2];

        // 检查是否是引用类型
        if (typeName === 'MAILBOX') {
          // MAILBOX 通常指向另一个实体
          // 需要更多上下文来确定目标实体
          // 这里暂时标记为可能的关系
        }

        // 检查容器类型
        if (typeName === 'ARRAY' || typeName === 'FIXED_DICT' || typeName === 'TUPLE') {
          // 这些容器可能包含实体
          // 需要更复杂的解析来提取实际的实体类型
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
        const parentNode = this.entities.get(node.parent)!;
        parentNode.referencedBy++;
      }

    } catch (error) {
      console.error(`解析依赖关系失败: ${node.defFile}`, error);
    }
  }

  /**
   * 从 entities.xml 读取实体列表和类型
   */
  async loadFromEntitiesXml(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const entitiesXmlPath = path.join(workspaceFolder.uri.fsPath, 'scripts/entities.xml');

    if (!fs.existsSync(entitiesXmlPath)) {
      return;
    }

    const content = fs.readFileSync(entitiesXmlPath, 'utf-8');
    const entityMatches = content.matchAll(/<(\w+)\s+([^>]+)>/g);

    for (const match of entityMatches) {
      const entityName = match[1];
      const attributes = match[2];

      // 查找对应的 .def 文件
      const defPath = this.findEntityDefFile(entityName);
      if (!defPath) {
        continue;
      }

      // 如果实体不存在，创建它
      if (!this.entities.has(entityName)) {
        const node: EntityNode = {
          name: entityName,
          defFile: defPath,
          types: [],
          references: [],
          referencedBy: 0
        };

        // 解析类型
        if (/\bhasCell\s*=\s*"true"/i.test(attributes)) {
          node.types.push(EntityType.Cell);
        }
        if (/\bhasBase\s*=\s*"true"/i.test(attributes)) {
          node.types.push(EntityType.Base);
        }
        if (/\bhasClient\s*=\s*"true"/i.test(attributes)) {
          node.types.push(EntityType.Client);
        }

        this.entities.set(entityName, node);
      }

      // 查找父实体
      const parentMatch = attributes.match(/\bparent\s*=\s*"(\w+)"/i);
      if (parentMatch) {
        const node = this.entities.get(entityName)!;
        node.parent = parentMatch[1];

        if (this.entities.has(parentMatch[1])) {
          this.edges.push({
            from: entityName,
            to: parentMatch[1],
            type: DependencyType.Inheritance,
            label: '继承'
          });
        }
      }
    }
  }

  /**
   * 查找实体定义文件
   */
  private findEntityDefFile(entityName: string): string | null {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return null;
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;
    const possiblePaths = [
      path.join(workspaceRoot, 'scripts/entity_defs', `${entityName}.def`),
      path.join(workspaceRoot, '**/entity_defs', `${entityName}.def`),
    ];

    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        return possiblePath;
      }
    }

    return null;
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

    for (const [name, node] of this.entities) {
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
}
