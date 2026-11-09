/**
 * KBEngine 客户端实体 SDK 生成器（盘点 G4，已代决）
 *
 * 语言清单是需求取舍项，按用户 2026-10-16 的代决授权定首批两种目标：
 * TypeScript（js 客户端/Web/Cocos 系）与 C#（Unity 系）——经典 KBEngine 的
 * 两个主流客户端生态。GDScript/C++ 留后续增量：语言中立模型与逐语言发射器
 * 已分离，新增语言只补一个映射表加一个发射函数。
 *
 * 生成面严格收在 def 已有语义内，不发明客户端插件 API：
 * - 属性只收 Flags 含客户端域（defAnalyzer 的三域位表同源）的项，成为可写字段
 * - ClientMethods 成为虚位回调（客户端插件派发），Exposed 的 Base/Cell 方法
 *   成为包装调用，实际发送只落 `onBaseOutgoing`/`onCellOutgoing` 两个接缝
 * - 类型表取引擎注册表（kbengineMetadata 同源 17 个内置类型），引擎未注册的
 *   BOOL 等幻影类型不给映射，靠 defAnalyzer 现有诊断拦
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PropertyFlagDomain } from '../backend/defAnalyzer';
import {
  getCustomTypeInfos,
  getDefinitionWorkspaceLayout,
  getRegisteredEntities,
  readWorkspaceTextFile
} from '../definitionWorkspace';
import { parseDefFileSemantics } from '../backend/defRenamer';
import { getKodeCoreShadowGate } from '../kodeCoreShadowFaces';
import type { SdkEngineTrace } from './sdkGenerationTrace';
import {
  buildClientSdkTypeMap,
  CLIENT_SDK_COMPONENTS_BASENAME,
  CLIENT_SDK_CSHARP_NAMESPACE,
  CLIENT_SDK_FIXED_DICTS_BASENAME,
  findClientSdkMemberConflicts,
  generateClientSdkComponentsFile,
  generateClientSdkEntityFile,
  generateClientSdkFixedDictsFile,
  parseClientSdkEntity,
  ClientSdkMemberConflictError
} from './clientSdkCodegen';
import type { ClientSdkMemberConflict } from './clientSdkCodegen';

/** 首批目标语言（已代决，用户可推翻后增删） */
export const CLIENT_SDK_LANGUAGES = ['typescript', 'csharp'] as const;
export type ClientSdkLanguage = typeof CLIENT_SDK_LANGUAGES[number];

/** 配置段：kbengine.clientSdk.outputDir */
export const CLIENT_SDK_OUTPUT_DIR_KEY = 'clientSdk.outputDir';
export const CLIENT_SDK_DEFAULT_OUTPUT_DIR = 'scripts/client_entities';

export const CLIENT_SDK_LANGUAGE_EXTENSIONS: Record<ClientSdkLanguage, string> = {
  typescript: 'ts',
  csharp: 'cs'
};

export interface ClientSdkProperty {
  readonly name: string;
  /** `<Type>` 直文本；ARRAY 为 `ARRAY` */
  readonly type: string;
  /** ARRAY 的 `<of>` 文本；非容器为 null */
  readonly elementType: string | null;
  readonly flags: string;
  readonly domains: PropertyFlagDomain[];
  /** KR-AUD-73:合并自接口/父链 def 时的来源 def 名;自身成员无此字段 */
  readonly inheritedFrom?: string;
  /** KR-AUD-73:经父链合并(含父链上各 def 的接口)时为 true——基类承载,不重复声明 */
  readonly inheritedViaParent?: boolean;
}

/** KR-AUD-79:`<Arg>` 类型面——与属性同构(type + `<of>` 元素类型)。
 * 旧实现只取直文本,`<Arg>ARRAY<of>X</of></Arg>` 得 "ARRAY"、元素类型丢失。 */
export interface ClientSdkArgType {
  /** `<Arg>` 直文本;ARRAY 为 `ARRAY` */
  readonly type: string;
  /** ARRAY 的 `<of>` 文本;非容器为 null(嵌套 ARRAY 与属性面同口径,只取一层) */
  readonly elementType: string | null;
}

export interface ClientSdkMethod {
  readonly name: string;
  /** def 的 `<Arg>` 只有类型、没有名字 */
  readonly argTypes: readonly ClientSdkArgType[];
  /** KR-AUD-73:合并自接口/父链 def 时的来源 def 名;自身成员无此字段 */
  readonly inheritedFrom?: string;
  /** KR-AUD-73:经父链合并(含父链上各 def 的接口)时为 true——基类承载,不重复声明 */
  readonly inheritedViaParent?: boolean;
}

export interface ClientSdkEntity {
  readonly name: string;
  /** def 的 `<Parent>` 目标名；无继承为 null */
  readonly parent: string | null;
  readonly properties: ReadonlyArray<ClientSdkProperty>;
  /** 组件槽（IDE-RUST-006）：slot 成员 + 组件类型类（客户端可见属性） */
  readonly components: ReadonlyArray<ClientSdkComponent>;
  readonly clientMethods: ReadonlyArray<ClientSdkMethod>;
  readonly exposedBaseMethods: ReadonlyArray<ClientSdkMethod>;
  readonly exposedCellMethods: ReadonlyArray<ClientSdkMethod>;
}

/** 实体组件槽：槽名 + 组件类型 + 组件模块客户端可见属性（递归含接口/父类）。 */
export interface ClientSdkComponent {
  readonly slot: string;
  readonly typeName: string;
  readonly properties: ReadonlyArray<ClientSdkProperty>;
}

/** Rust `$/kode/sdk/generate` 的 defs map：组件/接口名 → def 原文（闭包收集）。 */
export type ClientSdkComponentDefs = Readonly<Record<string, string>>;

export interface ClientSdkFixedDictProperty {
  readonly name: string;
  readonly typeName: string | null;
  /** 属性标签在 types.xml 的声明行(1 起);合成模型为 null */
  readonly sourceLine: number | null;
}

export interface ClientSdkFixedDictType {
  readonly name: string;
  readonly properties: ReadonlyArray<ClientSdkFixedDictProperty>;
  /** 类型节点在 types.xml 的声明行(1 起);合成模型为 null */
  readonly sourceLine: number | null;
}

export interface ClientSdkTypeMap {
  readonly builtin: Readonly<Record<string, string>>;
  readonly aliases: ReadonlyMap<string, string>;
  readonly fixedDicts: ReadonlyMap<string, ClientSdkFixedDictType>;
  readonly fallback: string;
}

export interface ClientSdkGenerationOptions {
  readonly languages: ReadonlyArray<ClientSdkLanguage>;
  /** 输出目录，可相对工作区根 */
  readonly outputDir: string;
  readonly overwrite: boolean;
  readonly generatedAt?: string;
  /** 引擎溯源(IDE-SDK-004):生成文件头部记录版本与提交;缺省写 unknown */
  readonly engineTrace?: SdkEngineTrace;
}

export interface ClientSdkGeneratedFile {
  readonly path: string;
  readonly kind: 'entity' | 'fixedDicts' | 'components';
  readonly language: ClientSdkLanguage;
  readonly entityName: string | null;
  readonly written: boolean;
}

export interface ClientSdkGenerationResult {
  readonly files: ReadonlyArray<ClientSdkGeneratedFile>;
  readonly entities: ReadonlyArray<ClientSdkEntity>;
  readonly skipped: number;
}

interface ClientSdkLanguagePickItem extends vscode.QuickPickItem {
  readonly value: ClientSdkLanguage;
}

interface ClientSdkOverwritePickItem extends vscode.QuickPickItem {
  readonly value: 'skip' | 'overwrite';
}

export const CLIENT_SDK_LANGUAGE_CHOICES: ReadonlyArray<ClientSdkLanguagePickItem> = [
  { label: 'TypeScript', value: 'typescript' },
  { label: 'C#', value: 'csharp' }
];

export const CLIENT_SDK_OVERWRITE_CHOICES: ReadonlyArray<ClientSdkOverwritePickItem> = [
  { label: '跳过已存在', value: 'skip' },
  { label: '覆盖已存在', value: 'overwrite' }
];

/** KR-AUD-73:实体合并面(Interfaces/Parent 链)的 def 原文闭包——实体 def 以
 * entities.xml 登记序预置,再从每个 def 的 Interfaces/Parent 出发在
 * entity_defs/interfaces/components 三目录查找递归收集。缺失 def 不收集
 * (调用方合并时按名跳过)。 */
function collectClientSdkRelatedDefs(
  workspaceRoot: string,
  entitySources: ReadonlyArray<ClientSdkEntitySource>
): ClientSdkComponentDefs {
  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  const defs: Record<string, string> = {};
  const queue: string[] = [];
  const enqueued = new Set<string>();
  const enqueue = (name: string): void => {
    if (name && !enqueued.has(name)) {
      enqueued.add(name);
      queue.push(name);
    }
  };
  const readDefFor = (name: string): string | null => {
    const candidates: Array<string | null> = [
      layout.entityDefsRoot ? path.join(layout.entityDefsRoot, `${name}.def`) : null,
      layout.interfacesRoot ? path.join(layout.interfacesRoot, `${name}.def`) : null,
      layout.componentsRoot ? path.join(layout.componentsRoot, `${name}.def`) : null
    ];
    const defPath = candidates.find(candidate => candidate !== null && fs.existsSync(candidate));
    return defPath ? readWorkspaceTextFile(defPath) : null;
  };
  const visit = (name: string): void => {
    if (defs[name] !== undefined) {
      return;
    }
    const content = readDefFor(name);
    if (content === null) {
      return;
    }
    defs[name] = content;
    const semantics = parseDefFileSemantics(content);
    for (const iface of semantics?.interfaceNames ?? []) {
      enqueue(iface);
    }
    if (semantics?.parentName) {
      enqueue(semantics.parentName);
    }
  };
  for (const source of entitySources) {
    defs[source.name] = source.defText;
    const semantics = parseDefFileSemantics(source.defText);
    for (const iface of semantics?.interfaceNames ?? []) {
      enqueue(iface);
    }
    if (semantics?.parentName) {
      enqueue(semantics.parentName);
    }
  }
  while (queue.length > 0) {
    visit(queue.shift()!);
  }
  return defs;
}

/** 按 entities.xml 登记序收集实体，缺 def 文件的登记项跳过。 */
export function collectClientSdkEntities(workspaceRoot: string): ClientSdkEntity[] {
  const sources = collectClientSdkEntitySources(workspaceRoot);
  const componentDefs = collectClientSdkComponentDefs(workspaceRoot, sources);
  const relatedDefs = collectClientSdkRelatedDefs(workspaceRoot, sources);
  const entities: ClientSdkEntity[] = [];

  for (const source of sources) {
    const entity = parseClientSdkEntity(source.defText, source.name, componentDefs, relatedDefs);
    if (entity) {
      entities.push(entity);
    }
  }

  return entities;
}

function findClientSdkDefPath(workspaceRoot: string, entityName: string): string | null {
  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  // 不可达(与 defAnalyzer 批64 同因):候选列表首项恒为已解析的非空相对路径,
  // entityDefsRoot 只能是字符串,空值臂无触发路径。
  /* istanbul ignore start */
  if (!layout.entityDefsRoot) {
    return null;
  }
  /* istanbul ignore stop */

  const defPath = path.join(layout.entityDefsRoot, `${entityName}.def`);
  return fs.existsSync(defPath) ? defPath : null;
}

function writeClientSdkFile(
  descriptor: Omit<ClientSdkGeneratedFile, 'written'>,
  contentOf: () => string,
  options: Pick<ClientSdkGenerationOptions, 'overwrite'>
): ClientSdkGeneratedFile {
  if (fs.existsSync(descriptor.path) && !options.overwrite) {
    return { ...descriptor, written: false };
  }

  fs.mkdirSync(path.dirname(descriptor.path), { recursive: true });
  fs.writeFileSync(descriptor.path, contentOf(), 'utf8');
  return { ...descriptor, written: true };
}

/** Rust 核心的 RPC 入参:每个实体的原始 def 文本(名称按 entities.xml 登记序)。 */
interface ClientSdkEntitySource {
  readonly name: string;
  readonly defText: string;
}

/** Rust `$/kode/sdk/generate` 返回的单个生成文件。 */
interface ClientSdkRustFile {
  readonly fileName: string;
  readonly content: string;
}

/** 按 entities.xml 登记序收集实体原始 def 文本,缺 def 文件的登记项跳过。
 * 与 collectClientSdkEntities 同序,但保留原始文本供 Rust 核心消费。 */
function collectClientSdkEntitySources(workspaceRoot: string): ClientSdkEntitySource[] {
  const sources: ClientSdkEntitySource[] = [];
  for (const info of getRegisteredEntities(workspaceRoot)) {
    const defPath = findClientSdkDefPath(workspaceRoot, info.name);
    if (!defPath) {
      continue;
    }
    sources.push({ name: info.name, defText: readWorkspaceTextFile(defPath) });
  }
  return sources;
}

/** 组件 def 闭包收集(IDE-RUST-006):实体 `<Components>` 槽出发,组件 def 自身 +
 * 其 Interfaces(interface 类)+ Parent(组件类)递归;Rust 侧组件模块域面与 SDK
 * 组件可见性都按名查这份 defs。缺失 def 不收集(调用方跳过/报 issue)。 */
function collectClientSdkComponentDefs(
  workspaceRoot: string,
  entitySources: ReadonlyArray<ClientSdkEntitySource>
): ClientSdkComponentDefs {
  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  const defs: Record<string, string> = {};
  const queue: string[] = [];
  const enqueued = new Set<string>();
  const enqueue = (name: string): void => {
    if (name && !enqueued.has(name)) {
      enqueued.add(name);
      queue.push(name);
    }
  };
  const visit = (name: string): void => {
    if (defs[name] !== undefined) {
      return;
    }
    // 组件优先 components/,接口回落 interfaces/(两目录同名属畸形工程,取组件)
    const componentPath = layout.componentsRoot
      ? path.join(layout.componentsRoot, `${name}.def`)
      : null;
    const interfacePath = layout.interfacesRoot
      ? path.join(layout.interfacesRoot, `${name}.def`)
      : null;
    const defPath = componentPath && fs.existsSync(componentPath)
      ? componentPath
      : interfacePath && fs.existsSync(interfacePath)
        ? interfacePath
        : null;
    if (!defPath) {
      return;
    }
    const content = readWorkspaceTextFile(defPath);
    defs[name] = content;
    const semantics = parseDefFileSemantics(content);
    for (const iface of semantics?.interfaceNames ?? []) {
      enqueue(iface);
    }
    if (semantics?.parentName) {
      enqueue(semantics.parentName);
    }
    for (const typeName of semantics?.componentTypeNames ?? []) {
      enqueue(typeName);
    }
  };
  for (const source of entitySources) {
    const semantics = parseDefFileSemantics(source.defText);
    for (const typeName of semantics?.componentTypeNames ?? []) {
      enqueue(typeName);
    }
  }
  while (queue.length > 0) {
    visit(queue.shift()!);
  }
  return defs;
}

/** 读 types.xml 原始文本(无该文件时返回空串,Rust 侧等价于空类型表)。 */
function readTypesXmlText(workspaceRoot: string): string {
  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  return layout.typesXmlPath ? readWorkspaceTextFile(layout.typesXmlPath) : '';
}

/** 把 Rust 返回的文件名还原成写盘描述符(实体名 = 去扩展名基名,固定字典/
 * 组件伴随 = 基名匹配)。 */
function describeRustGeneratedFile(
  fileName: string,
  filePath: string,
  language: ClientSdkLanguage
): Omit<ClientSdkGeneratedFile, 'written'> {
  const extension = CLIENT_SDK_LANGUAGE_EXTENSIONS[language];
  const fixedDictsName = `${CLIENT_SDK_FIXED_DICTS_BASENAME}.${extension}`;
  if (fileName === fixedDictsName) {
    return { path: filePath, kind: 'fixedDicts', language, entityName: null };
  }
  const componentsName = `${CLIENT_SDK_COMPONENTS_BASENAME}.${extension}`;
  if (fileName === componentsName) {
    return { path: filePath, kind: 'components', language, entityName: null };
  }
  const entityName = fileName.slice(0, fileName.length - extension.length - 1);
  return { path: filePath, kind: 'entity', language, entityName };
}

/** 主路径:Rust 核心生成(单一来源)。Rust 不可用(无 gate/无 serverPath/调用失败)
 * 返回 null,由调用方回落到 TS 纯实现。 */
async function generateClientSdkInRust(
  root: string,
  options: ClientSdkGenerationOptions,
  generatedAt: string,
  outputDir: string
): Promise<ClientSdkGenerationResult | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }

  const entitySources = collectClientSdkEntitySources(root);
  if (entitySources.length === 0) {
    // 与 TS 路径同口径:无登记实体时不产出任何文件。
    return { files: [], entities: [], skipped: 0 };
  }

  const typesXml = readTypesXmlText(root);
  const componentDefs = collectClientSdkComponentDefs(root, entitySources);
  const files: ClientSdkGeneratedFile[] = [];

  for (const language of options.languages) {
    const response = await gate.runInRust<ClientSdkRustFile[]>('$/kode/sdk/generate', {
      language,
      entities: entitySources,
      defs: componentDefs,
      typesXml,
      generatedAt,
      engineTrace: options.engineTrace,
      namespace: CLIENT_SDK_CSHARP_NAMESPACE
    });
    if (!response.ok) {
      return null;
    }
    for (const item of response.result) {
      const filePath = path.join(outputDir, item.fileName);
      files.push(
        writeClientSdkFile(
          describeRustGeneratedFile(item.fileName, filePath, language),
          () => item.content,
          options
        )
      );
    }
  }

  return { files, entities: [], skipped: files.filter(file => !file.written).length };
}

/** 兜底:原 TS 纯生产器。仅在主路径(Rust 核心)不可用时执行。 */
function generateClientSdkEntitiesFallback(
  options: ClientSdkGenerationOptions,
  root: string,
  generatedAt: string,
  outputDir: string
): ClientSdkGenerationResult {
  const entities = collectClientSdkEntities(root);
  const customTypes = getCustomTypeInfos(root);
  const entityNames = new Set(entities.map(entity => entity.name));
  const files: ClientSdkGeneratedFile[] = [];

  for (const language of options.languages) {
    const typeMap = buildClientSdkTypeMap(customTypes, language);
    const extension = CLIENT_SDK_LANGUAGE_EXTENSIONS[language];

    for (const entity of entities) {
      const filePath = path.join(outputDir, `${entity.name}.${extension}`);
      files.push(
        writeClientSdkFile(
          { path: filePath, kind: 'entity', language, entityName: entity.name },
          () => generateClientSdkEntityFile(entity, language, typeMap, generatedAt, options.engineTrace, entityNames),
          options
        )
      );
    }

    const fixedDictsContent = generateClientSdkFixedDictsFile(
      entities, language, typeMap, generatedAt, options.engineTrace
    );
    if (fixedDictsContent !== null) {
      const filePath = path.join(outputDir, `${CLIENT_SDK_FIXED_DICTS_BASENAME}.${extension}`);
      files.push(
        writeClientSdkFile(
          { path: filePath, kind: 'fixedDicts', language, entityName: null },
          () => fixedDictsContent,
          options
        )
      );
    }

    const componentsContent = generateClientSdkComponentsFile(
      entities, language, typeMap, generatedAt, options.engineTrace
    );
    if (componentsContent !== null) {
      const filePath = path.join(outputDir, `${CLIENT_SDK_COMPONENTS_BASENAME}.${extension}`);
      files.push(
        writeClientSdkFile(
          { path: filePath, kind: 'components', language, entityName: null },
          () => componentsContent,
          options
        )
      );
    }
  }

  return { files, entities, skipped: files.filter(file => !file.written).length };
}

export async function generateClientSdkEntities(
  options: ClientSdkGenerationOptions,
  workspaceRoot?: string
): Promise<ClientSdkGenerationResult> {
  const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return { files: [], entities: [], skipped: 0 };
  }

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const outputDir = path.isAbsolute(options.outputDir)
    ? options.outputDir
    : path.join(root, options.outputDir);

  // IDE-AUD-062:落盘前预检辅助固定成员与业务成员重名,冲突即提前拒绝,
  // 绝不静默生成含重复成员(TS 2300/2687/2717)的产物。解析失败(畸形 def 等)
  // 跳过预检,交给主/兜底路径按既有口径处理,不改变既有行为。
  let conflicts: ClientSdkMemberConflict[] = [];
  try {
    conflicts = findClientSdkMemberConflicts(collectClientSdkEntities(root), options.languages);
  } catch {
    conflicts = [];
  }
  if (conflicts.length > 0) {
    throw new ClientSdkMemberConflictError(conflicts);
  }

  // 主路径:Rust 生成核心;不可用时回落到 TS 纯实现。
  const rustResult = await generateClientSdkInRust(root, options, generatedAt, outputDir);
  if (rustResult !== null) {
    return rustResult;
  }
  return generateClientSdkEntitiesFallback(options, root, generatedAt, outputDir);
}

  /** 命令编排：选语言 → 定输出目录 → 定覆盖策略 → 落盘 → 通知。任一步取消即无副作用返回。
   * IDE-SDK-003：profileRoot=活动 profile 资产根——实体注册序与类型数据
   * 全部取自该根（generateClientSdkEntities 的注册/类型读取都吃该根），
   * 不回落工作区根；skippedSameNameFromOtherRoots=其他根同名实体拒收
   * 点名（装配侧经 bindSdkGenerationToProfile 算出，非空时通知点名，
   * 不静默吞掉跨根歧义）。 */
export async function runClientSdkGenerateCommand(
  profileRoot?: string,
  skippedSameNameFromOtherRoots?: string[],
  engineTrace?: SdkEngineTrace
): Promise<void> {
  const workspaceRoot = profileRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('没有打开的工作区');
    return;
  }

  const languages = await vscode.window.showQuickPick<ClientSdkLanguagePickItem>(CLIENT_SDK_LANGUAGE_CHOICES, {
    canPickMany: true,
    placeHolder: '选择目标语言（可多选）'
  });
  if (!languages || languages.length === 0) {
    return;
  }

  const config = vscode.workspace.getConfiguration('kbengine');
  const outputDir = await vscode.window.showInputBox({
    prompt: '客户端实体 SDK 输出目录（相对生成根）',
    value: config.get<string>(CLIENT_SDK_OUTPUT_DIR_KEY, CLIENT_SDK_DEFAULT_OUTPUT_DIR)
  });
  if (outputDir === undefined) {
    return;
  }

  const overwriteChoice = await vscode.window.showQuickPick<ClientSdkOverwritePickItem>(CLIENT_SDK_OVERWRITE_CHOICES, {
    placeHolder: '输出目录里已存在的文件如何处理'
  });
  if (overwriteChoice === undefined) {
    return;
  }

  let result: ClientSdkGenerationResult;
  try {
    result = await generateClientSdkEntities(
      {
        languages: languages.map(choice => choice.value as ClientSdkLanguage),
        outputDir,
        overwrite: overwriteChoice.value === 'overwrite',
        engineTrace
      },
      workspaceRoot
    );
  } catch (error) {
    // IDE-AUD-062:重名预检拒绝说明原因;其余错误按既有行为抛给命令宿主。
    if (error instanceof ClientSdkMemberConflictError) {
      vscode.window.showErrorMessage(error.message);
      return;
    }
    throw error;
  }

  const written = result.files.filter(file => file.written);
  const writtenPath = written[0]?.path;
  const skippedNames = skippedSameNameFromOtherRoots ?? [];
  const skippedNote = skippedNames.length > 0 ? `；跨根同名未覆盖：${skippedNames.join('、')}` : '';
  vscode.window.showInformationMessage(
    `客户端实体 SDK 已生成 ${written.length} 个文件${writtenPath ? `（${writtenPath}）` : ''}，跳过 ${result.skipped} 个${skippedNote}`
  );
}

// SRC-012:纯生成逻辑已拆至 clientSdkCodegen.ts;此处再导出保持既有
// `from './clientSdkGenerator'` 导入路径不变(generators/测试消费方)。
export {
  buildClientSdkTypeMap,
  CLIENT_SDK_COMPONENTS_BASENAME,
  CLIENT_SDK_CSHARP_NAMESPACE,
  CLIENT_SDK_FIXED_DICTS_BASENAME,
  findClientSdkMemberConflicts,
  formatClientSdkMemberConflictMessage,
  generateClientSdkComponentsFile,
  generateClientSdkEntityFile,
  generateClientSdkFixedDictsFile,
  isClientVisibleProperty,
  listClientSdkBuiltinTypeNames,
  parseClientSdkEntity,
  resolveClientSdkTypeName,
  ClientSdkMemberConflictError
} from './clientSdkCodegen';
export type { ClientSdkMemberConflict } from './clientSdkCodegen';
