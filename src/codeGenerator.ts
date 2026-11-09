/**
 * KBEngine 代码生成器
 * 根据模板快速生成 .def 文件和 Python 脚本
 */

import { findFilesAcrossRoots } from './scanRoots';
import * as vscode from 'vscode';

/** 面板分类文案走 vscode.l10n:调用期求值,默认英文源串,zh-cn bundle 出中文 */
const l10nText = (message: string): string => vscode.l10n.t(message);
import * as path from 'path';
import * as fs from 'fs';
import { findEntitiesXmlFile, findEntityDefinitionsRoot, getDefinitionWorkspaceLayout } from './definitionWorkspace';
import { joinWorkspacePath } from './backend/workspacePath';
import { writeFileAtomic } from './backend/atomicFileWrite';
import { readSharedFileSnapshot } from './sharedFileSnapshot';
import { confirmGenerationPlanItems, type GenerationPlanItem } from './generationConfirm';
import { activeProfileSwitchCount, onDidChangeActiveProfile, resolveActiveProfile } from './activeProfile';
import {
  buildEntityDefContent,
  buildEntityPartContent,
  buildFixedDictTypeDefinition,
  buildNewEntityRegistration,
  entityWizardPartsToGenerate,
  fixedDictTypeName,
  resolveEntityWizardTemplateOverrides,
  type EntityWizardPart,
  type NewEntityWizardInput
} from './backend/entityWizard';

import {
  generateDefContent,
  generatePythonContent,
  generateEntityRegistration,
  getEmptyTemplate,
  getAccountTemplate,
  getAvatarTemplate,
  getNpcTemplate,
  getItemTemplate,
  getMonsterTemplate,
  getSpaceTemplate,
  getGuildTemplate,
  getTeamTemplate,
  getMailTemplate
} from './backend/codeGeneratorRender';

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
 * 单次生成调用的回滚账本(AUD-064):每次向导/模板调用持有自己的一份,
 * 重叠调用互不覆盖——实例级共享账本会让后一次调用的重置/回滚误删前一次
 * 的成功文件(R3-F08)。AUD-030:缓冲登记插入单记账(bufferEdits),回收只撤
 * 本次插入,不把缓冲内容当盘上前值写回。
 */
export interface GenerationRollbackLedger {
  createdFiles: string[];
  overwrittenFiles: Array<{ filePath: string; previous: string }>;
  bufferEdits: Array<{ filePath: string; uri: vscode.Uri; offset: number; text: string }>;
}

/** 新的空回滚账本(每次调用独立创建)。 */
export function createGenerationRollbackLedger(): GenerationRollbackLedger {
  return { createdFiles: [], overwrittenFiles: [], bufferEdits: [] };
}

/**
 * 代码生成器
 */
export class KBEngineCodeGenerator {
  private config: GeneratorConfig;
  private readonly profileSwitchSubscription: vscode.Disposable;

  constructor(private context: vscode.ExtensionContext) {
    this.config = this.loadConfig();
    // IDE-PRJ-013:profile 切换即时重载输出配置(下一次预览/写入即用新
    // 根);已打开预览由 confirmGenerationPlan 的切换计数守卫作废重算
    this.profileSwitchSubscription = onDidChangeActiveProfile(() => {
      this.config = this.loadConfig();
    });
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

    // IDE-PRJ-013:活动 profile 的资产根优先——def/python 输出根都按所选
    // profile 解析(共享发现链以资产根为基,布局未识别回落 <资产根>/scripts
    // 约定),预览与写入同源;路径项不回落设置链(profile 是权威输入),
    // 开关项(generatePython/注册)仍读设置
    const profileAssetsRoot = resolveActiveProfile(this.context.workspaceState)?.assetsRoot;
    if (profileAssetsRoot) {
      return {
        defOutputPath: findEntityDefinitionsRoot(profileAssetsRoot)
          || joinWorkspacePath(profileAssetsRoot, 'scripts', 'entity_defs'),
        // 不可达兜底(批64 不变量):entityScriptsRoot 恒非空字符串(发现链对
        // 任意根都给出首选候选拼接路径),类型上仍是 string | null
        /* istanbul ignore next */
        pythonOutputPath: getDefinitionWorkspaceLayout(profileAssetsRoot).entityScriptsRoot
          ?? joinWorkspacePath(profileAssetsRoot, 'scripts'),
        generatePython: config.get<boolean>('generatePython') ?? true,
        registerInEntitiesXml: config.get<boolean>('registerInEntitiesXml') ?? true
      };
    }

    const configuredDefOutputPath = config.get<string>('defOutputPath') || 'scripts/entity_defs';
    return {
      defOutputPath: this.resolveDefOutputPath(configuredDefOutputPath, workspaceFolder.uri.fsPath),
      // 批125 自动发现:配置为默认值时从发现出的 def 根推导 python 根(def 根父目录)
      pythonOutputPath: this.resolvePythonOutputPath(
        config.get<string>('pythonOutputPath') || 'scripts',
        workspaceFolder.uri.fsPath
      ),
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

  private resolveDefOutputPath(configuredPath: string, workspaceRoot: string): string {
    if (path.isAbsolute(configuredPath)) {
      return configuredPath;
    }

    const normalizedConfiguredPath = configuredPath.replace(/\\/g, '/');
    if (normalizedConfiguredPath !== 'scripts/entity_defs') {
      return configuredPath;
    }

    // 不可达(批67 定性):findEntityDefinitionsRoot 的返回值即
    // getDefinitionWorkspaceLayout(workspaceRoot).entityDefsRoot,恒为
    // 非空字符串——候选列表首项由 path.join 生成、相对路径最小结果是
    // '.',''(批62/64 已据同一事实把空值臂判不可达),目录不存在时返回
    // 首选候选拼接路径而非 null ⇒ `|| configuredPath` 兜底无触发路径。
    // 语句与两分支条目随区间移出分母(TESTING.md 分母口径据实登记);
    // 真臂行为由既有"解析定义根"用例与 tests/codeGeneratorBranches 的
    // 裸工作区用例锁定。
    /* istanbul ignore start */
    return findEntityDefinitionsRoot(workspaceRoot) || configuredPath;
    /* istanbul ignore stop */
  }

  private resolvePythonOutputPath(configuredPath: string, workspaceRoot: string): string {
    if (configuredPath !== 'scripts') {
      return configuredPath;
    }
    const scriptsRoot = getDefinitionWorkspaceLayout(workspaceRoot).entityScriptsRoot;
    // 不可达(批64 定性):entityScriptsRoot 即 layout 的 entityDefsRoot 父目录,
    // entityDefsRoot 恒为非空字符串 ⇒ scriptsRoot 恒真(null 臂无触发路径)。
    /* istanbul ignore start */
    if (!scriptsRoot) {
      return configuredPath;
    }
    /* istanbul ignore stop */
    const relative = path.relative(workspaceRoot, scriptsRoot);
    // def 根在工作区外或就在工作区根时保持默认,不产出 ../ 或空段路径
    if (!relative || relative.startsWith('..')) {
      return configuredPath;
    }
    return relative.split(path.sep).join('/');
  }

  /**
   * 解析 def 输出根(生成/预检/计划预览同源,预览路径=写入路径)
   */
  private resolveDefOutputRoot(workspaceRoot: string): string {
    return path.isAbsolute(this.config.defOutputPath)
      ? this.config.defOutputPath
      : joinWorkspacePath(workspaceRoot, this.config.defOutputPath);
  }

  /**
   * 解析 python 输出根(IDE-PRJ-013):profile 模式下是绝对根(profile 的
   * scripts 根),直接用;设置链保持相对值以工作区根为基
   */
  private resolvePythonOutputRoot(workspaceRoot: string): string {
    return path.isAbsolute(this.config.pythonOutputPath)
      ? this.config.pythonOutputPath
      : joinWorkspacePath(workspaceRoot, this.config.pythonOutputPath);
  }

  /**
   * 解析 entities.xml 落点(注册与计划预览同源,预览路径=写入路径)。
   * IDE-PRJ-013:活动 profile 的资产根优先——发现链以资产根为基,未识别
   * 回落 <资产根>/scripts/entities.xml;读取时解析,跟随切换即时生效
   */
  private resolveEntitiesXmlPath(workspaceRoot: string): string {
    const profileAssetsRoot = resolveActiveProfile(this.context.workspaceState)?.assetsRoot;
    if (profileAssetsRoot) {
      return findEntitiesXmlFile(profileAssetsRoot)
        || joinWorkspacePath(profileAssetsRoot, 'scripts', 'entities.xml');
    }
    return findEntitiesXmlFile() || joinWorkspacePath(
      workspaceRoot,
      vscode.workspace
        .getConfiguration('kbengine')
        .get<string>('entitiesXmlPath', 'scripts/entities.xml')
    );
  }

  /**
   * 回收本次新增项(IDE-GEN-006):先还原被改写文件(entities.xml 注册项),
   * 再按写入逆序删除本次新增文件;单项回收失败不掩盖原始错误。
   * AUD-030:缓冲登记撤销优先——只撤回本次插入,且缓冲仍恰好含该插入才动
   * (用户未再改动),避免误删他人后续改动。
   * AUD-064:账本由调用方传入(每次调用独立),绝不共享实例状态。
   */
  private async rollbackGeneration(ledger: GenerationRollbackLedger): Promise<void> {
    for (const item of [...ledger.bufferEdits].reverse()) {
      try {
        const doc = vscode.workspace.textDocuments.find(candidate => candidate.uri.fsPath === item.filePath);
        if (!doc) {
          continue;
        }
        const start = doc.positionAt(item.offset);
        const end = doc.positionAt(item.offset + item.text.length);
        if (doc.getText(new vscode.Range(start, end)) !== item.text) {
          continue;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(item.uri, new vscode.Range(start, end), '');
        await vscode.workspace.applyEdit(edit);
      } catch {
        // 回收失败不掩盖原始错误
      }
    }
    for (const item of [...ledger.overwrittenFiles].reverse()) {
      try {
        writeFileAtomic(item.filePath, item.previous);
      } catch {
        // 回收失败不掩盖原始错误
      }
    }
    for (const filePath of [...ledger.createdFiles].reverse()) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // 回收失败不掩盖原始错误
      }
    }
  }

  /**
   * 预检全部生成目标(IDE-GEN-003):逐项报出冲突(def/python),
   * 调用方在写出任何文件前整体中止,不留半套
   */
  private collectGenerationConflicts(entity: EntityTypeConfig): string[] {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('没有打开的工作区');
    }

    const conflicts: string[] = [];
    const defFilePath = joinWorkspacePath(
      this.resolveDefOutputRoot(workspaceFolder.uri.fsPath),
      `${entity.name}.def`
    );
    if (fs.existsSync(defFilePath)) {
      conflicts.push(`def 文件已存在，保留原文件未覆盖: ${defFilePath}`);
    }

    if (this.config.generatePython) {
      // KR-AUD-74:分段路径逐段预检(任一段冲突即整体中止,不写半套)
      for (const part of this.entityScriptParts(entity)) {
        const partFilePath = joinWorkspacePath(
          this.resolvePythonOutputRoot(workspaceFolder.uri.fsPath),
          part,
          `${entity.name}.py`
        );
        if (fs.existsSync(partFilePath)) {
          conflicts.push(`Python 文件已存在，保留原代码未覆盖: ${partFilePath}`);
        }
      }
    }

    return conflicts;
  }

  /**
   * 生成计划预览与确认(IDE-GEN-004):确认前列出将新增的
   * def/Python 与注册项及准确路径,选择"确认生成"才继续落盘。
   * IDE-PRJ-013:预览打开期间活动 profile 切换即作废——旧预览的路径不再
   * 可信,按重载后的配置重算计划并要求重新确认,绝不沿旧预览路径落盘
   */
  private async confirmGenerationPlan(config: EntityTypeConfig): Promise<boolean> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('没有打开的工作区');
    }

    for (;;) {
      const epochAtPreview = activeProfileSwitchCount();
      // IDE-GEN-008:与表单向导共用同一确认面
      const confirmed = await confirmGenerationPlanItems(
        this.buildGenerationPlanItems(config, workspaceFolder.uri.fsPath)
      );
      if (!confirmed) {
        return false;
      }
      if (activeProfileSwitchCount() === epochAtPreview) {
        return true;
      }
      vscode.window.showInformationMessage('活动 profile 已切换，生成路径已按新 profile 重算，请重新确认');
    }
  }

  /**
   * 计划预览项(IDE-GEN-004/PRJ-013):def/Python/注册项的准确路径,
   * 与写入同源(同一 resolveDefOutputRoot/resolvePythonOutputRoot/
   * resolveEntitiesXmlPath)
   */
  private buildGenerationPlanItems(config: EntityTypeConfig, workspaceRoot: string): GenerationPlanItem[] {
    const planItems: GenerationPlanItem[] = [
      {
        label: '新增 .def',
        description: joinWorkspacePath(
          this.resolveDefOutputRoot(workspaceRoot),
          `${config.name}.def`
        )
      }
    ];

    if (this.config.generatePython) {
      // KR-AUD-74:分段路径逐段列出(引擎 scripts/<part>/ 布局)
      for (const part of this.entityScriptParts(config)) {
        planItems.push({
          label: `新增 Python (${part} 段)`,
          description: joinWorkspacePath(
            this.resolvePythonOutputRoot(workspaceRoot),
            part,
            `${config.name}.py`
          )
        });
      }
    }

    if (this.config.registerInEntitiesXml) {
      planItems.push({
        label: '注册 entities.xml',
        description: `${this.resolveEntitiesXmlPath(workspaceRoot)}: ${generateEntityRegistration(config).trim()}`
      });
    }

    return planItems;
  }

  /**
   * 生成 .def 文件
   */
  async generateDefFile(entity: EntityDefinition): Promise<string> {
    return this.generateDefFileWithContent(entity, generateDefContent(entity));
  }

  /**
   * 以显式内容生成 .def 文件(GEN-DEF-2 新建实体向导:内容由
   * entityWizard.buildEntityDefContent 提供,可被项目模板覆盖)。
   * 同 generateDefFile 的冲突预检/原子写/目录保障。
   */
  async generateDefFileWithContent(
    entity: { config: { name: string } },
    content: string
  ): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('没有打开的工作区');
    }

    const outputRoot = this.resolveDefOutputRoot(workspaceFolder.uri.fsPath);
    const defFilePath = joinWorkspacePath(outputRoot, `${entity.config.name}.def`);

    // IDE-GEN-001:同名 def 已存在时拒绝覆盖——原字节原样保留,
    // 冲突信息带上目标路径;两个生成入口(向导/模板)都先走这里
    if (fs.existsSync(defFilePath)) {
      throw new Error(`def 文件已存在，保留原文件未覆盖: ${defFilePath}`);
    }

    // 确保目录存在
    const dir = path.dirname(defFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 写入文件(IDE-GEN-005:原子替换,中断不留半截)
    writeFileAtomic(defFilePath, content);

    return defFilePath;
  }

  /**
   * 生成 .def 文件内容
   */
  async generatePythonFile(entity: EntityDefinition, ledger?: GenerationRollbackLedger): Promise<string[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('没有打开的工作区');
    }

    const pythonOutputRoot = this.resolvePythonOutputRoot(workspaceFolder.uri.fsPath);
    const partPaths = this.entityScriptParts(entity.config).map(part =>
      joinWorkspacePath(pythonOutputRoot, part, `${entity.config.name}.py`)
    );

    // IDE-GEN-002:同名实现已存在时拒绝覆盖——保留使用者代码,
    // 不能因生成 def 顺带覆盖实现文件;两个生成入口同守
    for (const partFilePath of partPaths) {
      if (fs.existsSync(partFilePath)) {
        throw new Error(`Python 文件已存在，保留原代码未覆盖: ${partFilePath}`);
      }
    }

    const written: string[] = [];
    for (const [index, part] of this.entityScriptParts(entity.config).entries()) {
      const partFilePath = partPaths[index];
      const content = generatePythonContent(entity, part);

      // 确保目录存在
      const dir = path.dirname(partFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 写入文件(IDE-GEN-005:原子替换,中断不留半截)
      writeFileAtomic(partFilePath, content);
      written.push(partFilePath);
      // KR-AUD-74 分段后落盘即入账:某段失败抛错时,已落盘的段随事务回滚
      // 回收(等全部段成功才登记会漏删已写段,违反 IDE-GEN-006 不留半套)
      ledger?.createdFiles.push(partFilePath);
    }

    return written;
  }

  /**
   * 生成某段实体脚本文件(GEN-DEF-2):scripts/<part>/<Name>.py,类名=实体名,
   * 冲突预检/原子写同 generatePythonFile。
   */
  async generateEntityPartFile(
    name: string,
    part: EntityWizardPart,
    content: string
  ): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('没有打开的工作区');
    }

    const partFilePath = joinWorkspacePath(
      this.resolvePythonOutputRoot(workspaceFolder.uri.fsPath),
      part,
      `${name}.py`
    );

    // IDE-GEN-002 同守:同名实现已存在时拒绝覆盖
    if (fs.existsSync(partFilePath)) {
      throw new Error(`Python 文件已存在，保留原代码未覆盖: ${partFilePath}`);
    }

    const dir = path.dirname(partFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    writeFileAtomic(partFilePath, content);
    return partFilePath;
  }

  /**
   * 解析 types.xml 落点(与 entities.xml 同源链:资产根优先)。
   */
  private resolveTypesXmlPath(workspaceRoot: string): string {
    const profileAssetsRoot = resolveActiveProfile(this.context.workspaceState)?.assetsRoot;
    if (profileAssetsRoot) {
      return joinWorkspacePath(profileAssetsRoot, 'scripts', 'entity_defs', 'types.xml');
    }
    return joinWorkspacePath(workspaceRoot, 'scripts', 'entity_defs', 'types.xml');
  }

  /**
   * 向 types.xml 追加 FIXED_DICT 命名类型(GEN-DEF-2 fixedDict 属性模板)。
   * 仅当类型名未出现时追加;打开文档走缓冲写入,未打开原子写盘(与
   * registerInEntitiesXml 同规则)。
   */
  async appendFixedDictTypeToTypesXml(
    input: NewEntityWizardInput,
    ledger: GenerationRollbackLedger
  ): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('没有打开的工作区');
    }

    const typesXmlPath = this.resolveTypesXmlPath(workspaceFolder.uri.fsPath);
    const typeName = fixedDictTypeName(input.name);

    const snapshot = readSharedFileSnapshot(typesXmlPath);
    if (!snapshot) {
      throw new Error(`types.xml 不存在: ${typesXmlPath}`);
    }

    if (snapshot.content.includes(`<${typeName}>`)) {
      // 已有同名类型:不追加也不改写,引用既有定义(幂等)
      return;
    }

    const typeDefinition = buildFixedDictTypeDefinition(input);
    const insertIndex = snapshot.content.lastIndexOf('</root>');
    if (insertIndex === -1) {
      throw new Error('types.xml 格式错误：找不到 </root> 标签');
    }

    if (snapshot.source === 'document') {
      const openDoc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === typesXmlPath);
      if (!openDoc) {
        throw new Error(`types.xml 缓冲区已关闭: ${typesXmlPath}`);
      }
      const edit = new vscode.WorkspaceEdit();
      edit.insert(openDoc.uri, openDoc.positionAt(insertIndex), `${typeDefinition}\n\n`);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied || !openDoc.getText().includes(typeDefinition)) {
        vscode.window.showWarningMessage(`types.xml 缓冲区写入未生效,类型 ${typeName} 未登记`);
        return;
      }
      ledger.bufferEdits.push({
        filePath: typesXmlPath,
        uri: openDoc.uri,
        offset: insertIndex,
        text: `${typeDefinition}\n\n`
      });
      return;
    }

    const nextContent =
      snapshot.content.substring(0, insertIndex) + typeDefinition + '\n\n' + snapshot.content.substring(insertIndex);
    writeFileAtomic(typesXmlPath, nextContent);
    ledger.overwrittenFiles.push({ filePath: typesXmlPath, previous: snapshot.content });
  }

  /**
   * GEN-DEF-1(用户令 2026-11-02):属性类型 → __init__ is None 守卫复位值。
   * 仅容器引用型生成:ARRAY(<of> 内联或裸)→ '[]';本实体在 types.xml 登记
   * 的 FIXED_DICT 命名类型(entityWizard.fixedDictTypeName:<Entity>State)
   * → '{}';其余(内建/别名/未知名)一律 null 不守卫——没有注册表可依时
   * 不猜,与向导 containerGuardProperties 同口径。已知取舍:该生成器运行时
   * 无 types.xml 注册表(FIXED_DICT 命名类型恰由同事务
   * appendFixedDictTypeToTypesXml 首次登记),<Entity>State 判定是命名约定
   * 耦合——漏守(他名 FIXED_DICT)保守安全;误守仅在用户手工把同名注册成
   * 简单别名的边缘出现(如实记录于 docs/review 审计报告)。
   */
  private entityScriptParts(config: EntityTypeConfig): EntityWizardPart[] {
    const parts: EntityWizardPart[] = [];
    if (config.hasBase) parts.push('base');
    if (config.hasCell) parts.push('cell');
    if (config.hasClient) parts.push('client');
    return parts;
  }

  /**
   * 生成 Python 方法代码
   */
  async registerInEntitiesXml(entity: EntityTypeConfig, ledger: GenerationRollbackLedger): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('没有打开的工作区');
    }

    const entitiesXmlPath = this.resolveEntitiesXmlPath(workspaceFolder.uri.fsPath);

    // IDE-GEN-007:文件在编辑器打开时以缓冲区当前文本为基底——用户尚未
    // 保存的其他注册修改进入本次写入,不被磁盘旧内容覆盖;未打开回落磁盘
    const snapshot = readSharedFileSnapshot(entitiesXmlPath);
    if (!snapshot) {
      throw new Error(`entities.xml 不存在: ${entitiesXmlPath}`);
    }

    const content = snapshot.content;

    // 检查是否已经注册
    const entityPattern = new RegExp(`<${entity.name}(?=[\\s>/])`, 'i');
    if (entityPattern.test(content)) {
      vscode.window.showWarningMessage(`实体 ${entity.name} 已经在 entities.xml 中注册`);
      return;
    }

    // 生成注册代码
    const registration = generateEntityRegistration(entity);

    // 在 </root> 前插入
    const insertIndex = content.lastIndexOf('</root>');
    if (insertIndex === -1) {
      throw new Error('entities.xml 格式错误：找不到 </root> 标签');
    }

    // AUD-030:打开文档走缓冲写入(与 generatorForms.registerSpaceEntity 同
    // 规则)——读缓冲到 applyEdit 是同一快照(此处到 applyEdit 无 await),
    // 重名检查与插入点都按缓冲区当前文本定位;未打开才原子写盘。
    if (snapshot.source === 'document') {
      const openDoc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === entitiesXmlPath);
      if (!openDoc) {
        throw new Error(`entities.xml 缓冲区已关闭: ${entitiesXmlPath}`);
      }
      const edit = new vscode.WorkspaceEdit();
      edit.insert(openDoc.uri, openDoc.positionAt(insertIndex), `${registration}\n`);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied || !openDoc.getText().includes(registration)) {
        vscode.window.showWarningMessage(`entities.xml 缓冲区写入未生效,实体 ${entity.name} 未登记`);
        return;
      }
      ledger.bufferEdits.push({
        filePath: entitiesXmlPath,
        uri: openDoc.uri,
        offset: insertIndex,
        text: `${registration}\n`
      });
      return;
    }

    // 未打开:写回文件(IDE-GEN-005:原子替换,中断时旧注册保持完整)
    writeFileAtomic(entitiesXmlPath, content.substring(0, insertIndex) + registration + '\n' + content.substring(insertIndex));
    ledger.overwrittenFiles.push({ filePath: entitiesXmlPath, previous: content });
  }

  /**
   * 生成实体注册代码
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
      { label: 'Base', description: l10nText('BaseApp entity'), hasBase: true, hasCell: false, hasClient: false },
      { label: 'Cell', description: l10nText('CellApp entity'), hasBase: false, hasCell: true, hasClient: false },
      { label: 'Client', description: l10nText('Client entity'), hasBase: false, hasCell: false, hasClient: true },
      { label: 'Base + Cell', description: l10nText('Includes Base and Cell'), hasBase: true, hasCell: true, hasClient: false },
      { label: 'Base + Client', description: l10nText('Includes Base and Client'), hasBase: true, hasCell: false, hasClient: true },
      { label: 'Cell + Client', description: l10nText('Includes Cell and Client'), hasBase: false, hasCell: true, hasClient: true },
      { label: 'Base + Cell + Client', description: l10nText('Complete entity'), hasBase: true, hasCell: true, hasClient: true }
    ];

    const selectedType = await vscode.window.showQuickPick(typeOptions, {
      placeHolder: l10nText('Select entity type')
    });

    if (!selectedType) {
      return;
    }

    // 步骤 3: 选择父实体（可选）
    const parentEntity = await vscode.window.showQuickPick(
      this.getExistingEntities(),
      {
        placeHolder: l10nText('Select parent entity (optional)'),
        canPickMany: false
      }
    );

    // 步骤 4: 选择是否生成属性
    const addProperties = await vscode.window.showQuickPick(
      [
        { label: l10nText('Yes'), value: true, description: l10nText('Add sample properties') },
        { label: l10nText('No'), value: false, description: l10nText('No properties') }
      ],
      { placeHolder: l10nText('Add sample properties?') }
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
          // 不用 'id':引擎受限名(ENTITY_LIMITED_PROPERTYS),声明会导致实体
          // 加载失败;实体 id 由引擎自动提供
          name: 'entityID',
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
      // 不可达(批67 定性):步骤 2 的类型选项为固定 7 项字面量,每项
      // hasBase/hasCell/hasClient 至少一真;链式判断能到达本臂时前两域
      // 必为假,而选项表保证 hasClient 必真 ⇒ 判假臂(不赋
      // clientProperties)无触发路径。分支条目(含已覆盖真臂)随区间
      // 移出分母,真臂行为由既有 Client-only 向导用例锁定;块体保持在
      // 分母内。
      /* istanbul ignore start */
      } else if (selectedType.hasClient) {
      /* istanbul ignore stop */
        entity.clientProperties = sampleProperties;
      }
    }

    // 每次调用独立事务(AUD-064):账本为本次调用局部,重叠向导互不覆盖。
    const ledger = createGenerationRollbackLedger();
    let defFile = '';

    // 生成文件
    try {
      // IDE-GEN-003:落盘前预检全部目标,任一冲突即整体中止,不写半套
      const conflicts = this.collectGenerationConflicts(entity.config);
      if (conflicts.length > 0) {
        for (const conflict of conflicts) {
          vscode.window.showErrorMessage(conflict);
        }
        return;
      }

      // IDE-GEN-004:确认前列出将新增的 def/Python 与注册项及准确路径
      if (!(await this.confirmGenerationPlan(entity.config))) {
        return;
      }

      defFile = await this.generateDefFile(entity);
      ledger.createdFiles.push(defFile);
      vscode.window.showInformationMessage(`✅ 已生成 .def 文件: ${defFile}`);

      if (this.config.generatePython) {
        // 段级入账见 generatePythonFile(失败段前的已写段随事务回收)
        const pythonFiles = await this.generatePythonFile(entity, ledger);
        vscode.window.showInformationMessage(`✅ 已生成 Python 文件: ${pythonFiles.join(', ')}`);
      }

      if (this.config.registerInEntitiesXml) {
        // IDE-GEN-006/AUD-030:回滚前值由 registerInEntitiesXml 按实际写入
        // 面记账(缓冲插入入 bufferEdits,盘写覆盖入 overwrittenFiles),避免
        // 把打开文档的缓冲内容误当盘上前值
        await this.registerInEntitiesXml(entity.config, ledger);
        vscode.window.showInformationMessage(`✅ 已在 entities.xml 中注册 ${entityName}`);
      }

    } catch (error) {
      // IDE-GEN-006:回收本次新增文件与注册项,不留半套
      await this.rollbackGeneration(ledger);
      vscode.window.showErrorMessage(`生成失败: ${error}`);
      return;
    }

    // 提交边界(AUD-064):def/python 落盘与 entities.xml 注册全部完成,事务
    // 已提交;此后的"打开生成文件"是已提交事务的 UI 后续,失败只提示打开
    // 失败,绝不回滚——旧实现把打开步骤留在回滚 try 里,打开失败会删掉已
    // 成功的产物,还会在重叠调用时误删另一调用的文件(R3-F08)。
    const openFile = await vscode.window.showInformationMessage(
      '是否打开生成的文件？',
      '是',
      '否'
    );

    if (openFile === '是') {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(defFile));
        await vscode.window.showTextDocument(document);
      } catch (error) {
        vscode.window.showErrorMessage(`打开生成文件失败: ${error}`);
      }
    }
  }

  /**
   * 新建实体向导(GEN-DEF-2):3 步(名称 → 属性模板 → 实体形态)生成一个
   * 可直接被引擎加载的实体——def + 按段 py(base/cell/client stub)+
   * FIXED_DICT types.xml 注册 + entities.xml 登记,冲突预检/计划确认/失败
   * 回滚同旧向导纪律。项目级模板(.kode/templates/)优先于内置骨架。
   */
  async runNewEntityWizard(folderUri?: string): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('没有打开的工作区');
      return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;

    // 右键入口:限定 entity_defs 目录(含其内)才走,否则提示后中止;
    // 命令面板入口无 uri,直接按解析根走
    if (folderUri) {
      const defRoot = this.resolveDefOutputRoot(workspaceRoot);
      const rel = path.relative(defRoot, folderUri);
      const insideDefRoot = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      if (!insideDefRoot) {
        vscode.window.showInformationMessage('请在 entity_defs 目录上使用「New KBEngine Entity」');
        return;
      }
    }

    // 步骤 1: 实体名
    const name = await vscode.window.showInputBox({
      prompt: '输入实体名称',
      placeHolder: 'MyEntity',
      validateInput: (value) => {
        if (!value || !/^[A-Z][a-zA-Z0-9_]*$/.test(value)) {
          return '实体名称必须以大写字母开头，只能包含字母、数字和下划线';
        }
        return null;
      }
    });
    if (!name) {
      return;
    }

    // 步骤 2: 属性模板
    const templateChoices = [
      {
        label: l10nText('Simple type properties'),
        description: l10nText('UINT32 sample, no guard'),
        value: 'simple' as const
      },
      {
        label: l10nText('FixedArray properties'),
        description: l10nText('ARRAY<UINT32> sample, generated py gets an is None guard'),
        value: 'fixedArray' as const
      },
      {
        label: l10nText('FixedDict properties'),
        description: l10nText('FIXED_DICT named type, auto-registered in types.xml'),
        value: 'fixedDict' as const
      }
    ];
    const templatePick = await vscode.window.showQuickPick(templateChoices, {
      placeHolder: l10nText('Select property template')
    });
    if (!templatePick) {
      return;
    }

    // 步骤 3: 实体形态(含 Client 即同时生成客户端 stub)
    const formChoices = [
      { label: 'Base', description: l10nText('BaseApp entity'), hasBase: true, hasCell: false, hasClient: false },
      { label: 'Cell', description: l10nText('CellApp entity'), hasBase: false, hasCell: true, hasClient: false },
      { label: 'Client', description: l10nText('Client entity'), hasBase: false, hasCell: false, hasClient: true },
      { label: 'Base + Cell', description: l10nText('Includes Base and Cell'), hasBase: true, hasCell: true, hasClient: false },
      { label: 'Base + Client', description: l10nText('Includes Base and Client'), hasBase: true, hasCell: false, hasClient: true },
      { label: 'Cell + Client', description: l10nText('Includes Cell and Client'), hasBase: false, hasCell: true, hasClient: true },
      { label: 'Base + Cell + Client', description: l10nText('Complete entity (generates client stub)'), hasBase: true, hasCell: true, hasClient: true }
    ];
    const formPick = await vscode.window.showQuickPick(formChoices, {
      placeHolder: l10nText('Select entity form (generates the client stub when Client is included)')
    });
    if (!formPick) {
      return;
    }

    const input: NewEntityWizardInput = {
      name,
      hasBase: formPick.hasBase,
      hasCell: formPick.hasCell,
      hasClient: formPick.hasClient,
      generateClientStub: true,
      propertyTemplate: templatePick.value,
      description: `自动生成的 ${name} 实体`
    };

    // 每次调用独立事务(AUD-064 同口径)
    const ledger = createGenerationRollbackLedger();
    let defFile = '';

    try {
      // IDE-GEN-003 同口径:落盘前预检全部目标,任一冲突整体中止
      const conflicts = this.collectNewEntityConflicts(input, workspaceRoot);
      if (conflicts.length > 0) {
        for (const conflict of conflicts) {
          vscode.window.showErrorMessage(conflict);
        }
        return;
      }

      // IDE-GEN-004 同口径:确认前列出全部落点
      if (!(await this.confirmNewEntityPlan(input, workspaceRoot))) {
        return;
      }

      // 项目模板覆盖(.kode/templates/)优先于内置
      const overrides = resolveEntityWizardTemplateOverrides(workspaceRoot, p =>
        fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
      );

      defFile = await this.generateDefFileWithContent(
        { config: { name: input.name } },
        buildEntityDefContent(input, overrides)
      );
      ledger.createdFiles.push(defFile);

      for (const part of entityWizardPartsToGenerate(input)) {
        const partFile = await this.generateEntityPartFile(
          input.name,
          part,
          buildEntityPartContent(input, part, overrides)
        );
        ledger.createdFiles.push(partFile);
      }

      if (input.propertyTemplate === 'fixedDict') {
        await this.appendFixedDictTypeToTypesXml(input, ledger);
      }

      if (this.config.registerInEntitiesXml) {
        await this.registerInEntitiesXml(input, ledger);
      }

      vscode.window.showInformationMessage(`✅ 已生成实体 ${name}: ${defFile}`);
    } catch (error) {
      await this.rollbackGeneration(ledger);
      vscode.window.showErrorMessage(`生成失败: ${error}`);
      return;
    }

    // 提交边界(AUD-064 同口径):此后是已提交事务的 UI 后续,失败不回滚
    // ④ def 注册表同步:新文件由 fs watcher 自动入索引;此处主动刷新
    // 实体树让新实体立即可见(命令未注册时静默跳过,不影响生成结果)
    try {
      await vscode.commands.executeCommand('kbengine.refreshExplorer');
    } catch {
      // 刷新面缺席不构成生成失败
    }

    const openFile = await vscode.window.showInformationMessage('是否打开生成的 def 文件？', '是', '否');
    if (openFile === '是') {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(defFile));
        await vscode.window.showTextDocument(document);
      } catch (error) {
        vscode.window.showErrorMessage(`打开生成文件失败: ${error}`);
      }
    }
  }

  /**
   * 新建实体向导的冲突预检:def/各段 py/types.xml(登记面存在性)。
   */
  private collectNewEntityConflicts(input: NewEntityWizardInput, workspaceRoot: string): string[] {
    const conflicts: string[] = [];

    const defPath = joinWorkspacePath(this.resolveDefOutputRoot(workspaceRoot), `${input.name}.def`);
    if (fs.existsSync(defPath)) {
      conflicts.push(`def 文件已存在: ${defPath}`);
    }

    for (const part of entityWizardPartsToGenerate(input)) {
      const partPath = joinWorkspacePath(
        this.resolvePythonOutputRoot(workspaceRoot),
        part,
        `${input.name}.py`
      );
      if (fs.existsSync(partPath)) {
        conflicts.push(`${part} 段脚本已存在: ${partPath}`);
      }
    }

    if (input.propertyTemplate === 'fixedDict') {
      const typesXmlPath = this.resolveTypesXmlPath(workspaceRoot);
      if (!fs.existsSync(typesXmlPath)) {
        conflicts.push(`types.xml 不存在(FIXED_DICT 模板需登记命名类型): ${typesXmlPath}`);
      }
    }

    return conflicts;
  }

  /**
   * 新建实体向导的计划确认清单(IDE-GEN-004 同口径,列出全部落点)。
   */
  private async confirmNewEntityPlan(input: NewEntityWizardInput, workspaceRoot: string): Promise<boolean> {
    const items: GenerationPlanItem[] = [
      {
        label: '新增 .def',
        description: joinWorkspacePath(this.resolveDefOutputRoot(workspaceRoot), `${input.name}.def`)
      }
    ];

    for (const part of entityWizardPartsToGenerate(input)) {
      items.push({
        label: `新增 ${part} 段脚本`,
        description: joinWorkspacePath(
          this.resolvePythonOutputRoot(workspaceRoot),
          part,
          `${input.name}.py`
        )
      });
    }

    if (input.propertyTemplate === 'fixedDict') {
      items.push({
        label: '登记 FIXED_DICT 类型',
        description: `${this.resolveTypesXmlPath(workspaceRoot)}: <${fixedDictTypeName(input.name)}>`
      });
    }

    if (this.config.registerInEntitiesXml) {
      items.push({
        label: '注册 entities.xml',
        description: `${this.resolveEntitiesXmlPath(workspaceRoot)}: ${buildNewEntityRegistration(input).trim()}`
      });
    }

    return confirmGenerationPlanItems(items);
  }

  /**
   * 获取已存在的实体列表
   */
  private async getExistingEntities(): Promise<Array<{ label: string; description: string }>> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return [];
    }

    const defFiles = await findFilesAcrossRoots('**/*.def', null);
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
        label: l10nText('Account entity'),
        description: l10nText('Player account entity: login authentication, character selection, etc.'),
        value: 'account'
      },
      {
        label: l10nText('Character entity'),
        description: l10nText('Game character entity: position, attributes, skills, etc.'),
        value: 'avatar'
      },
      {
        label: l10nText('NPC entity'),
        description: l10nText('Non-player character entity'),
        value: 'npc'
      },
      {
        label: l10nText('Item entity'),
        description: l10nText('Game item/prop entity'),
        value: 'item'
      },
      {
        label: l10nText('Monster entity'),
        description: l10nText('Game monster entity: health, movement and attacks'),
        value: 'monster'
      },
      {
        label: l10nText('Scene entity'),
        description: l10nText('Scene/space entity with enter/leave scene callbacks'),
        value: 'space'
      },
      {
        label: l10nText('Guild entity'),
        description: l10nText('Player guild entity: announcements and member management'),
        value: 'guild'
      },
      {
        label: l10nText('Team entity'),
        description: l10nText('Player team entity: member list and leader'),
        value: 'team'
      },
      {
        label: l10nText('Mail entity'),
        description: l10nText('Game mail entity: send, receive and read state'),
        value: 'mail'
      },
      {
        label: l10nText('Empty entity'),
        description: l10nText('Blank entity template'),
        value: 'empty'
      }
    ];

    const selected = await vscode.window.showQuickPick(templates, {
      placeHolder: l10nText('Select entity template')
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
        return getAccountTemplate();
      case 'avatar':
        return getAvatarTemplate();
      case 'npc':
        return getNpcTemplate();
      case 'item':
        return getItemTemplate();
      case 'monster':
        return getMonsterTemplate();
      case 'space':
        return getSpaceTemplate();
      case 'guild':
        return getGuildTemplate();
      case 'team':
        return getTeamTemplate();
      case 'mail':
        return getMailTemplate();
      case 'empty':
      default:
        return getEmptyTemplate();
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

    // 每次调用独立事务(AUD-064):账本为本次调用局部,重叠模板调用互不覆盖。
    const ledger = createGenerationRollbackLedger();

    // 生成文件
    try {
      // IDE-GEN-003:落盘前预检全部目标,任一冲突即整体中止,不写半套
      const conflicts = this.collectGenerationConflicts(entity.config);
      if (conflicts.length > 0) {
        for (const conflict of conflicts) {
          vscode.window.showErrorMessage(conflict);
        }
        return;
      }

      // IDE-GEN-004:确认前列出将新增的 def/Python 与注册项及准确路径
      if (!(await this.confirmGenerationPlan(entity.config))) {
        return;
      }

      const defFile = await this.generateDefFile(entity);
      ledger.createdFiles.push(defFile);
      vscode.window.showInformationMessage(`✅ 已生成 .def 文件: ${defFile}`);

      if (this.config.generatePython) {
        // 段级入账见 generatePythonFile(失败段前的已写段随事务回收)
        const pythonFiles = await this.generatePythonFile(entity, ledger);
        vscode.window.showInformationMessage(`✅ 已生成 Python 文件: ${pythonFiles.join(', ')}`);
      }

      if (this.config.registerInEntitiesXml) {
        // IDE-GEN-006/AUD-030:回滚前值由 registerInEntitiesXml 按实际写入
        // 面记账(缓冲插入入 bufferEdits,盘写覆盖入 overwrittenFiles),避免
        // 把打开文档的缓冲内容误当盘上前值
        await this.registerInEntitiesXml(entity.config, ledger);
        vscode.window.showInformationMessage(`✅ 已在 entities.xml 中注册 ${entityName}`);
      }

    } catch (error) {
      // IDE-GEN-006:回收本次新增文件与注册项,不留半套
      await this.rollbackGeneration(ledger);
      vscode.window.showErrorMessage(`生成失败: ${error}`);
    }
  }

  /**
   * 获取空实体模板
   */
  dispose(): void {
    // 清理资源
    this.profileSwitchSubscription.dispose();
  }
}
