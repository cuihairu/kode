/**
 * KBEngine 代码生成器
 * 根据模板快速生成 .def 文件和 Python 脚本
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 实体类型配置
 */
export interface EntityTypeConfig {
  /** 实体名称 */
  name: string;
  /** 是否有 Base */
  hasBase: boolean;
  /** 是否有 Cell */
  hasCell: boolean;
  /** 是否有 Client */
  hasClient: boolean;
  /** 父实体 */
  parent?: string;
  /** 描述 */
  description?: string;
}

/**
 * 属性定义
 */
export interface PropertyDefinition {
  /** 属性名 */
  name: string;
  /** 类型 */
  type: string;
  /** 标志 */
  flags: string;
  /** 默认值 */
  default?: string;
  /** 数据库长度 */
  dbLength?: number;
  /** 细节级别 */
  detailLevel?: string;
  /** 是否持久化到数据库 */
  persistent?: boolean;
  /** 标识符 */
  identifier?: boolean;
}

/**
 * 方法定义
 */
export interface MethodDefinition {
  /** 方法名 */
  name: string;
  /** 是否是暴露方法 */
  exposed?: boolean;
  /** 参数 */
  args?: Array<{ name: string; type: string }>;
  /** 返回类型 */
  returnType?: string;
}

/**
 * 实体定义
 */
export interface EntityDefinition {
  /** 实体配置 */
  config: EntityTypeConfig;
  /** Base 属性 */
  baseProperties?: PropertyDefinition[];
  /** Cell 属性 */
  cellProperties?: PropertyDefinition[];
  /** Client 属性 */
  clientProperties?: PropertyDefinition[];
  /** Base 方法 */
  baseMethods?: MethodDefinition[];
  /** Cell 方法 */
  cellMethods?: MethodDefinition[];
  /** Client 方法 */
  clientMethods?: MethodDefinition[];
}

/**
 * 代码生成器配置
 */
export interface GeneratorConfig {
  /** .def 文件输出目录 */
  defOutputPath: string;
  /** Python 文件输出目录 */
  pythonOutputPath: string;
  /** 是否生成 Python 文件 */
  generatePython: boolean;
  /** 是否在 entities.xml 中注册 */
  registerInEntitiesXml: boolean;
}

/**
 * 代码生成器
 */
export class KBEngineCodeGenerator {
  private config: GeneratorConfig;

  constructor(private context: vscode.ExtensionContext) {
    this.config = this.loadConfig();
  }

  /**
   * 加载配置
   */
  private loadConfig(): GeneratorConfig {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return this.getDefaultConfig();
    }

    const config = vscode.workspace.getConfiguration('kbengine.generator');
    return {
      defOutputPath: config.get<string>('defOutputPath') || 'scripts/entity_defs',
      pythonOutputPath: config.get<string>('pythonOutputPath') || 'scripts',
      generatePython: config.get<boolean>('generatePython') ?? true,
      registerInEntitiesXml: config.get<boolean>('registerInEntitiesXml') ?? true
    };
  }

  /**
   * 获取默认配置
   */
  private getDefaultConfig(): GeneratorConfig {
    return {
      defOutputPath: 'scripts/entity_defs',
      pythonOutputPath: 'scripts',
      generatePython: true,
      registerInEntitiesXml: true
    };
  }

  /**
   * 生成 .def 文件
   */
  async generateDefFile(entity: EntityDefinition): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('没有打开的工作区');
    }

    const defFilePath = path.join(workspaceFolder.uri.fsPath, this.config.defOutputPath, `${entity.config.name}.def`);
    const content = this.generateDefContent(entity);

    // 确保目录存在
    const dir = path.dirname(defFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 写入文件
    fs.writeFileSync(defFilePath, content, 'utf8');

    return defFilePath;
  }

  /**
   * 生成 .def 文件内容
   */
  private generateDefContent(entity: EntityDefinition): string {
    const lines: string[] = [];

    // 文件头注释
    lines.push(`<!DOCTYPE entity>`);
    lines.push(`<!--`);
    lines.push(`  实体: ${entity.config.name}`);
    if (entity.config.description) {
      lines.push(`  描述: ${entity.config.description}`);
    }
    lines.push(`  生成时间: ${new Date().toISOString()}`);
    lines.push(`-->`);
    lines.push('');

    // 根节点
    lines.push('<root>');
    lines.push('');

    if (entity.config.parent) {
      lines.push(`  <Parent>${entity.config.parent}</Parent>`);
      lines.push('');
    }

    // Properties 节点
    if (entity.baseProperties && entity.baseProperties.length > 0) {
      lines.push('  <Properties>');
      for (const prop of entity.baseProperties) {
        lines.push(this.generatePropertyCode(prop, '    '));
      }
      lines.push('  </Properties>');
      lines.push('');
    }

    if (entity.cellProperties && entity.cellProperties.length > 0) {
      lines.push('  <CellProperties>');
      for (const prop of entity.cellProperties) {
        lines.push(this.generatePropertyCode(prop, '    '));
      }
      lines.push('  </CellProperties>');
      lines.push('');
    }

    if (entity.clientProperties && entity.clientProperties.length > 0) {
      lines.push('  <ClientProperties>');
      for (const prop of entity.clientProperties) {
        lines.push(this.generatePropertyCode(prop, '    '));
      }
      lines.push('  </ClientProperties>');
      lines.push('');
    }

    // BaseMethods 节点
    if (entity.baseMethods && entity.baseMethods.length > 0) {
      lines.push('  <BaseMethods>');
      for (const method of entity.baseMethods) {
        lines.push(this.generateMethodCode(method, '    '));
      }
      lines.push('  </BaseMethods>');
      lines.push('');
    }

    // CellMethods 节点
    if (entity.cellMethods && entity.cellMethods.length > 0) {
      lines.push('  <CellMethods>');
      for (const method of entity.cellMethods) {
        lines.push(this.generateMethodCode(method, '    '));
      }
      lines.push('  </CellMethods>');
      lines.push('');
    }

    // ClientMethods 节点
    if (entity.clientMethods && entity.clientMethods.length > 0) {
      lines.push('  <ClientMethods>');
      for (const method of entity.clientMethods) {
        lines.push(this.generateMethodCode(method, '    '));
      }
      lines.push('  </ClientMethods>');
      lines.push('');
    }

    // 根节点结束
    lines.push('</root>');

    return lines.join('\n');
  }

  /**
   * 生成属性代码
   */
  private generatePropertyCode(prop: PropertyDefinition, indent: string): string {
    const lines: string[] = [];

    lines.push(`${indent}<${prop.name}>`);
    lines.push(`${indent}  <Type>${prop.type}</Type>`);
    lines.push(`${indent}  <Flags>${prop.flags}</Flags>`);

    if (prop.default !== undefined) {
      lines.push(`${indent}  <Default>${prop.default}</Default>`);
    }

    if (prop.dbLength !== undefined) {
      lines.push(`${indent}  <Database>`);

      if (prop.persistent !== undefined) {
        lines.push(`${indent}    <Persistent>${prop.persistent}</Persistent>`);
      }

      lines.push(`${indent}    <Length>${prop.dbLength}</Length>`);
      lines.push(`${indent}  </Database>`);
    }

    if (prop.detailLevel) {
      lines.push(`${indent}  <DetailLevel>${prop.detailLevel}</DetailLevel>`);
    }

    if (prop.identifier !== undefined) {
      lines.push(`${indent}  <Identifier>${prop.identifier}</Identifier>`);
    }

    lines.push(`${indent}</${prop.name}>`);

    return lines.join('\n');
  }

  /**
   * 生成方法代码
   */
  private generateMethodCode(method: MethodDefinition, indent: string): string {
    const lines: string[] = [];

    lines.push(`${indent}<${method.name}>`);

    if (method.args && method.args.length > 0) {
      for (const arg of method.args) {
        lines.push(`${indent}  <Arg>${arg.type} ${arg.name}</Arg>`);
      }
    }

    lines.push(`${indent}</${method.name}>`);

    return lines.join('\n');
  }

  /**
   * 生成 Python 文件
   */
  async generatePythonFile(entity: EntityDefinition): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('没有打开的工作区');
    }

    const pythonFilePath = path.join(workspaceFolder.uri.fsPath, this.config.pythonOutputPath, `${entity.config.name}.py`);
    const content = this.generatePythonContent(entity);

    // 确保目录存在
    const dir = path.dirname(pythonFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 写入文件
    fs.writeFileSync(pythonFilePath, content, 'utf8');

    return pythonFilePath;
  }

  /**
   * 生成 Python 文件内容
   */
  private generatePythonContent(entity: EntityDefinition): string {
    const lines: string[] = [];

    // 文件头
    lines.push('# -*- coding: utf-8 -*-');
    lines.push(`#`);
    lines.push(`# ${entity.config.name}`);
    if (entity.config.description) {
      lines.push(`# ${entity.config.description}`);
    }
    lines.push(`# 生成时间: ${new Date().toISOString()}`);
    lines.push(`#`);
    lines.push('');

    // 导入
    lines.push('import KBEngine');
    lines.push('');

    // 类定义
    let className = entity.config.name;
    if (entity.config.hasCell) {
      className += 'Cell';
    } else if (entity.config.hasBase) {
      className += 'Base';
    }

    lines.push(`class ${className}():`);
    lines.push('');

    // 构造函数
    lines.push('    def __init__(self):');
    lines.push('        pass');
    lines.push('');

    // 钩子方法
    lines.push('    # ----------------------- 钩子方法 -----------------------');
    lines.push('');
    lines.push('    def onCreate(self):');
    lines.push('        """');
    lines.push('        实体创建时调用');
    lines.push('        """');
    lines.push('        pass');
    lines.push('');

    if (entity.config.hasCell) {
      lines.push('    def onEnterWorld(self):');
      lines.push('        """');
      lines.push('        进入世界时调用（仅 Cell 实体）');
      lines.push('        """');
      lines.push('        pass');
      lines.push('');
    }

    // Base 方法
    if (entity.baseMethods && entity.baseMethods.length > 0) {
      lines.push('    # ----------------------- Base 方法 -----------------------');
      lines.push('');

      for (const method of entity.baseMethods) {
        lines.push(this.generatePythonMethodCode(method));
      }
    }

    // Cell 方法
    if (entity.cellMethods && entity.cellMethods.length > 0) {
      lines.push('    # ----------------------- Cell 方法 -----------------------');
      lines.push('');

      for (const method of entity.cellMethods) {
        lines.push(this.generatePythonMethodCode(method));
      }
    }

    return lines.join('\n');
  }

  /**
   * 生成 Python 方法代码
   */
  private generatePythonMethodCode(method: MethodDefinition): string {
    const lines: string[] = [];

    // 方法签名
    const args = method.args ? method.args.map(a => a.name).join(', ') : '';
    lines.push(`    def ${method.name}(self${args ? ', ' + args : ''}):`);
    lines.push(`        """`);
    lines.push(`        ${method.name} 方法`);
    if (method.returnType) {
      lines.push(`        返回: ${method.returnType}`);
    }
    lines.push(`        """`);
    lines.push(`        pass`);
    lines.push('');

    return lines.join('\n');
  }

  /**
   * 在 entities.xml 中注册实体
   */
  async registerInEntitiesXml(entity: EntityTypeConfig): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('没有打开的工作区');
    }

    const entitiesXmlPath = path.join(
      workspaceFolder.uri.fsPath,
      vscode.workspace
        .getConfiguration('kbengine')
        .get<string>('entitiesXmlPath', 'scripts/entities.xml')
    );

    if (!fs.existsSync(entitiesXmlPath)) {
      throw new Error(`entities.xml 不存在: ${entitiesXmlPath}`);
    }

    let content = fs.readFileSync(entitiesXmlPath, 'utf8');

    // 检查是否已经注册
    const entityPattern = new RegExp(`<${entity.name}(?=[\\s>/])`, 'i');
    if (entityPattern.test(content)) {
      vscode.window.showWarningMessage(`实体 ${entity.name} 已经在 entities.xml 中注册`);
      return;
    }

    // 生成注册代码
    const registration = this.generateEntityRegistration(entity);

    // 在 </root> 前插入
    const insertIndex = content.lastIndexOf('</root>');
    if (insertIndex === -1) {
      throw new Error('entities.xml 格式错误：找不到 </root> 标签');
    }

    content = content.substring(0, insertIndex) + registration + '\n' + content.substring(insertIndex);

    // 写回文件
    fs.writeFileSync(entitiesXmlPath, content, 'utf8');
  }

  /**
   * 生成实体注册代码
   */
  private generateEntityRegistration(config: EntityTypeConfig): string {
    const attrs: string[] = [];

    if (config.parent) {
      attrs.push(`parent="${config.parent}"`);
    }

    attrs.push(`hasCell="${config.hasCell}"`);
    attrs.push(`hasBase="${config.hasBase}"`);
    attrs.push(`hasClient="${config.hasClient}"`);

    return `  <${config.name} ${attrs.join(' ')} />`;
  }

  /**
   * 显示生成器向导
   */
  async showWizard(): Promise<void> {
    // 步骤 1: 输入实体名称
    const entityName = await vscode.window.showInputBox({
      prompt: '输入实体名称',
      placeHolder: 'MyEntity',
      validateInput: (value) => {
        if (!value || !/^[A-Z][a-zA-Z0-9_]*$/.test(value)) {
          return '实体名称必须以大写字母开头，只能包含字母、数字和下划线';
        }
        return null;
      }
    });

    if (!entityName) {
      return;
    }

    // 步骤 2: 选择实体类型
    const typeOptions = [
      { label: 'Base', description: 'BaseApp 实体', hasBase: true, hasCell: false, hasClient: false },
      { label: 'Cell', description: 'CellApp 实体', hasBase: false, hasCell: true, hasClient: false },
      { label: 'Client', description: '客户端实体', hasBase: false, hasCell: false, hasClient: true },
      { label: 'Base + Cell', description: '同时包含 Base 和 Cell', hasBase: true, hasCell: true, hasClient: false },
      { label: 'Base + Client', description: '同时包含 Base 和 Client', hasBase: true, hasCell: false, hasClient: true },
      { label: 'Cell + Client', description: '同时包含 Cell 和 Client', hasBase: false, hasCell: true, hasClient: true },
      { label: 'Base + Cell + Client', description: '完整实体', hasBase: true, hasCell: true, hasClient: true }
    ];

    const selectedType = await vscode.window.showQuickPick(typeOptions, {
      placeHolder: '选择实体类型'
    });

    if (!selectedType) {
      return;
    }

    // 步骤 3: 选择父实体（可选）
    const parentEntity = await vscode.window.showQuickPick(
      this.getExistingEntities(),
      {
        placeHolder: '选择父实体（可选）',
        canPickMany: false
      }
    );

    // 步骤 4: 选择是否生成属性
    const addProperties = await vscode.window.showQuickPick(
      [
        { label: '是', value: true, description: '添加示例属性' },
        { label: '否', value: false, description: '不添加属性' }
      ],
      { placeHolder: '是否添加示例属性？' }
    );

    // 构建实体定义
    const entity: EntityDefinition = {
      config: {
        name: entityName,
        hasBase: selectedType.hasBase,
        hasCell: selectedType.hasCell,
        hasClient: selectedType.hasClient,
        parent: parentEntity?.label,
        description: `自动生成的 ${entityName} 实体`
      }
    };

    if (addProperties?.value) {
      const sampleFlags = selectedType.hasBase
        ? 'BASE'
        : selectedType.hasCell
          ? 'CELL_PRIVATE'
          : 'OTHER_CLIENTS';

      const sampleProperties: PropertyDefinition[] = [
        {
          name: 'id',
          type: 'UINT64',
          flags: sampleFlags,
          default: '0',
          persistent: selectedType.hasBase,
          identifier: selectedType.hasBase
        },
        {
          name: 'name',
          type: 'STRING',
          flags: sampleFlags,
          default: '""',
          dbLength: selectedType.hasBase ? 50 : undefined,
          persistent: selectedType.hasBase
        }
      ];

      const sampleMethod: MethodDefinition = {
        name: 'getName',
        exposed: false,
        returnType: 'STRING'
      };

      if (selectedType.hasBase) {
        entity.baseProperties = sampleProperties;
        entity.baseMethods = [sampleMethod];
      } else if (selectedType.hasCell) {
        entity.cellProperties = sampleProperties;
        entity.cellMethods = [sampleMethod];
      } else if (selectedType.hasClient) {
        entity.clientProperties = sampleProperties;
      }
    }

    // 生成文件
    try {
      const defFile = await this.generateDefFile(entity);
      vscode.window.showInformationMessage(`✅ 已生成 .def 文件: ${defFile}`);

      if (this.config.generatePython) {
        const pythonFile = await this.generatePythonFile(entity);
        vscode.window.showInformationMessage(`✅ 已生成 Python 文件: ${pythonFile}`);
      }

      if (this.config.registerInEntitiesXml) {
        await this.registerInEntitiesXml(entity.config);
        vscode.window.showInformationMessage(`✅ 已在 entities.xml 中注册 ${entityName}`);
      }

      // 询问是否打开文件
      const openFile = await vscode.window.showInformationMessage(
        '是否打开生成的文件？',
        '是',
        '否'
      );

      if (openFile === '是') {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(defFile));
        await vscode.window.showTextDocument(document);
      }

    } catch (error) {
      vscode.window.showErrorMessage(`生成失败: ${error}`);
    }
  }

  /**
   * 获取已存在的实体列表
   */
  private async getExistingEntities(): Promise<Array<{ label: string; description: string }>> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return [];
    }

    const defFiles = await vscode.workspace.findFiles('**/*.def', null);
    const entities: Array<{ label: string; description: string }> = [];

    for (const defFile of defFiles) {
      const name = path.basename(defFile.fsPath, '.def');
      entities.push({
        label: name,
        description: defFile.fsPath
      });
    }

    return entities;
  }

  /**
   * 显示模板列表
   */
  async showTemplates(): Promise<void> {
    const templates = [
      {
        label: '账号实体',
        description: '玩家账号实体，包含登录认证、角色选择等',
        value: 'account'
      },
      {
        label: '角色实体',
        description: '游戏角色实体，包含位置、属性、技能等',
        value: 'avatar'
      },
      {
        label: 'NPC 实体',
        description: '非玩家角色实体',
        value: 'npc'
      },
      {
        label: '物品实体',
        description: '游戏物品/道具实体',
        value: 'item'
      },
      {
        label: '空实体',
        description: '空白的实体模板',
        value: 'empty'
      }
    ];

    const selected = await vscode.window.showQuickPick(templates, {
      placeHolder: '选择实体模板'
    });

    if (!selected) {
      return;
    }

    const entity = this.getTemplateEntity(selected.value);
    await this.generateFromTemplate(entity);
  }

  /**
   * 获取模板实体
   */
  private getTemplateEntity(templateType: string): EntityDefinition {
    switch (templateType) {
      case 'account':
        return this.getAccountTemplate();
      case 'avatar':
        return this.getAvatarTemplate();
      case 'npc':
        return this.getNpcTemplate();
      case 'item':
        return this.getItemTemplate();
      case 'empty':
      default:
        return this.getEmptyTemplate();
    }
  }

  /**
   * 从模板生成
   */
  private async generateFromTemplate(entity: EntityDefinition): Promise<void> {
    // 步骤 1: 输入实体名称
    const entityName = await vscode.window.showInputBox({
      prompt: '输入实体名称',
      placeHolder: entity.config.name,
      value: entity.config.name
    });

    if (!entityName) {
      return;
    }

    entity.config.name = entityName;

    // 生成文件
    try {
      const defFile = await this.generateDefFile(entity);
      vscode.window.showInformationMessage(`✅ 已生成 .def 文件: ${defFile}`);

      if (this.config.generatePython) {
        const pythonFile = await this.generatePythonFile(entity);
        vscode.window.showInformationMessage(`✅ 已生成 Python 文件: ${pythonFile}`);
      }

      if (this.config.registerInEntitiesXml) {
        await this.registerInEntitiesXml(entity.config);
        vscode.window.showInformationMessage(`✅ 已在 entities.xml 中注册 ${entityName}`);
      }

    } catch (error) {
      vscode.window.showErrorMessage(`生成失败: ${error}`);
    }
  }

  /**
   * 获取空实体模板
   */
  private getEmptyTemplate(): EntityDefinition {
    return {
      config: {
        name: 'EmptyEntity',
        hasBase: true,
        hasCell: false,
        hasClient: false,
        description: '空实体模板'
      }
    };
  }

  /**
   * 获取账号实体模板
   */
  private getAccountTemplate(): EntityDefinition {
    return {
      config: {
        name: 'Account',
        hasBase: true,
        hasCell: false,
        hasClient: true,
        description: '玩家账号实体'
      },
      baseProperties: [
        { name: 'accountName', type: 'STRING', flags: 'BASE', default: '""', dbLength: 64, persistent: true },
        { name: 'password', type: 'STRING', flags: 'BASE', default: '""', dbLength: 64, persistent: true },
        { name: 'lastLoginTime', type: 'UINT64', flags: 'BASE', default: '0', persistent: true }
      ],
      baseMethods: [
        { name: 'login', exposed: true, args: [{ name: 'password', type: 'STRING' }] },
        { name: 'createAvatar', exposed: true, args: [{ name: 'roleType', type: 'UINT8' }] }
      ]
    };
  }

  /**
   * 获取角色实体模板
   */
  private getAvatarTemplate(): EntityDefinition {
    return {
      config: {
        name: 'Avatar',
        hasBase: true,
        hasCell: true,
        hasClient: true,
        description: '游戏角色实体'
      },
      baseProperties: [
        { name: 'name', type: 'STRING', flags: 'BASE', default: '""', dbLength: 32, persistent: true },
        { name: 'roleType', type: 'UINT8', flags: 'BASE', default: '0', persistent: true },
        { name: 'level', type: 'UINT32', flags: 'BASE', default: '1', persistent: true },
        { name: 'exp', type: 'UINT64', flags: 'BASE', default: '0', persistent: true }
      ],
      cellProperties: [
        { name: 'position', type: 'VECTOR3', flags: 'CELL_PRIVATE', default: '0,0,0' },
        { name: 'direction', type: 'VECTOR3', flags: 'CELL_PRIVATE', default: '0,0,0' },
        { name: 'spaceID', type: 'UINT32', flags: 'CELL_PRIVATE', default: '0' },
        { name: 'hp', type: 'UINT32', flags: 'CELL_PUBLIC_AND_PRIVATE', default: '100' },
        { name: 'mp', type: 'UINT32', flags: 'CELL_PUBLIC_AND_PRIVATE', default: '100' }
      ],
      clientMethods: [
        { name: 'onHPChanged', exposed: true, args: [{ name: 'oldHP', type: 'UINT32' }, { name: 'newHP', type: 'UINT32' }] }
      ],
      cellMethods: [
        { name: 'moveTo', exposed: true, args: [{ name: 'position', type: 'VECTOR3' }] },
        { name: 'takeDamage', exposed: true, args: [{ name: 'damage', type: 'UINT32' }] }
      ]
    };
  }

  /**
   * 获取 NPC 实体模板
   */
  private getNpcTemplate(): EntityDefinition {
    return {
      config: {
        name: 'NPC',
        hasBase: true,
        hasCell: true,
        hasClient: true,
        description: '非玩家角色实体'
      },
      baseProperties: [
        { name: 'npcID', type: 'UINT32', flags: 'BASE', default: '0', persistent: true },
        { name: 'name', type: 'STRING', flags: 'BASE', default: '""', dbLength: 32, persistent: true }
      ],
      cellProperties: [
        { name: 'position', type: 'VECTOR3', flags: 'CELL_PRIVATE', default: '0,0,0' },
        { name: 'hp', type: 'UINT32', flags: 'CELL_PUBLIC_AND_PRIVATE', default: '100' }
      ]
    };
  }

  /**
   * 获取物品实体模板
   */
  private getItemTemplate(): EntityDefinition {
    return {
      config: {
        name: 'Item',
        hasBase: true,
        hasCell: false,
        hasClient: true,
        description: '游戏物品实体'
      },
      baseProperties: [
        { name: 'itemID', type: 'UINT32', flags: 'BASE', default: '0', persistent: true },
        { name: 'itemType', type: 'UINT8', flags: 'BASE', default: '0', persistent: true },
        { name: 'count', type: 'UINT32', flags: 'BASE', default: '1', persistent: true }
      ]
    };
  }

  /**
   * 清理资源
   */
  dispose(): void {
    // 清理资源
  }
}
