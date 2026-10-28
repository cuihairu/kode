/**
 * KBEngine 定义形态生成器(盘点 G7)
 *
 * 实体向导(codeGenerator.showWizard)只覆盖「实体」一种形态,工程里另外三种
 * 定义形态仍要手写:代理实体(scripts/proxy_defs/<实体名>Proxy.def)、组件
 * (entity_defs/components/<名>.def)、固定字典类型(types.xml 里的 FIXED_DICT),
 * 空间实体(entity_defs/<名>.def + entities.xml 登记)。本模块按形态出内容
 * 并落盘,再按引擎装载口径做必要的附带改写(空间登记、组件挂载、类型入库)。
 *
 * 口径说明(不写码之外的承诺):
 * - 生成物是骨架,不是成品:属性/方法段照形态给出最小可装载样例,业务字段
 *   留给使用者填。
 * - 代理的方法段(`BaseMethods` / `CellMethods`)由命令内选择,不替引擎断言
 *   版本差异;`Parent` 恒为 `<实体名>Proxy`。
 * - 组件挂载走实体 def 的 `<Properties>` 里加一条 `<Type> COMPONENT </Type>`
 *   属性,实体没有 `<Properties>` 段时如实报告不硬插。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getDefinitionWorkspaceLayout,
  getRegisteredEntities,
  type DefinitionWorkspaceLayout
} from './definitionWorkspace';
import {
  getDirectChildElement,
  getDirectChildElements,
  parseDefDocument
} from './defParser';
import { joinWorkspacePath } from './workspacePath';
import { writeFileAtomic } from './atomicFileWrite';
import { confirmGenerationPlanItems, type GenerationPlanItem } from './generationConfirm';

export const GENERATOR_FORM_KINDS = ['proxy', 'space', 'component', 'fixedDict'] as const;
export type GeneratorFormKind = (typeof GENERATOR_FORM_KINDS)[number];

/** 代理方法段:引擎按版本装载面不同,由使用者在命令内选,生成器不替引擎断言 */
export const PROXY_METHOD_SECTIONS = ['BaseMethods', 'CellMethods'] as const;
export type ProxyMethodSection = typeof PROXY_METHOD_SECTIONS[number];

export interface GeneratorFormPropertyInput {
  name: string;
  type: string;
  flags?: string;
  default?: string;
  persistent?: boolean;
}

export interface ProxyFormInput {
  /** 代理对应的实体名(决定 def 文件名与 `<Parent>` 标签名) */
  entityName: string;
  methodSection: ProxyMethodSection;
  methodNames: string[];
  description?: string;
}

export interface SpaceFormInput {
  name: string;
  description?: string;
}

export interface ComponentFormInput {
  name: string;
  properties: GeneratorFormPropertyInput[];
  methodNames?: string[];
  description?: string;
}

export interface FixedDictFormInput {
  name: string;
  properties: GeneratorFormPropertyInput[];
  implementedBy?: string;
}

export type GeneratorFormInput =
  | { kind: 'proxy'; value: ProxyFormInput }
  | { kind: 'space'; value: SpaceFormInput }
  | { kind: 'component'; value: ComponentFormInput }
  | { kind: 'fixedDict'; value: FixedDictFormInput };

interface GeneratorFormPickItem extends vscode.QuickPickItem {
  readonly value: GeneratorFormKind;
}

interface ProxySectionPickItem extends vscode.QuickPickItem {
  readonly value: ProxyMethodSection;
}

interface YesNoPickItem extends vscode.QuickPickItem {
  readonly value: boolean;
}

interface AttachPickItem extends vscode.QuickPickItem {
  readonly value: string | null;
}

export const GENERATOR_FORM_LABELS: Record<GeneratorFormKind, string> = {
  proxy: '代理实体',
  space: '空间实体',
  component: '组件',
  fixedDict: '固定字典类型'
};

export const GENERATOR_FORM_CHOICES: ReadonlyArray<GeneratorFormPickItem> = [
  {
    label: '代理实体 (proxy)',
    description: 'scripts/proxy_defs/<实体名>Proxy.def,Parent 指向同名 Proxy',
    value: 'proxy'
  },
  {
    label: '空间实体 (space)',
    description: 'entity_defs/<名称>.def,父类 Space,并登记进 entities.xml',
    value: 'space'
  },
  {
    label: '组件 (component)',
    description: 'entity_defs/components/<名称>.def,可挂载为实体的 COMPONENT 属性',
    value: 'component'
  },
  {
    label: '固定字典类型 (fixedDict)',
    description: '写入 types.xml 的 FIXED_DICT 类型',
    value: 'fixedDict'
  }
];

export const PROXY_METHOD_SECTION_CHOICES: ReadonlyArray<ProxySectionPickItem> = [
  { label: 'BaseMethods', description: '方法声明在 BaseMethods 段', value: 'BaseMethods' },
  { label: 'CellMethods', description: '方法声明在 CellMethods 段', value: 'CellMethods' }
];

const YES_NO_CHOICES: ReadonlyArray<YesNoPickItem> = [
  { label: '是', value: true, description: '带上示例' },
  { label: '否', value: false, description: '只出结构' }
];

const NO_ATTACH_CHOICE: AttachPickItem = {
  label: '不挂载',
  description: '只生成组件 def,挂载由使用者手写',
  value: null
};

/** 组件示例属性:与官方模板的 CELL_PUBLIC 组件属性同口径 */
export const COMPONENT_SAMPLE_PROPERTY: GeneratorFormPropertyInput = {
  name: 'value',
  type: 'UINT32',
  flags: 'CELL_PUBLIC'
};

/** 固定字典示例字段:types.xml 的键只带 `<Type>` */
export const FIXED_DICT_SAMPLE_PROPERTY: GeneratorFormPropertyInput = {
  name: 'value',
  type: 'UINT32'
};

const NAME_VALIDATOR = (value: string): string | null =>
  !value || !/^[A-Z][a-zA-Z0-9_]*$/.test(value)
    ? '名称必须以大写字母开头,只能包含字母、数字和下划线'
    : null;

const IMPLEMENTED_BY_VALIDATOR = (value: string): string | null =>
  !value || /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value)
    ? null
    : '实现符号需形如 MODULE.symbol(引擎按「模块路径.实现对象」装载)';

function headerLines(title: string, description: string | undefined, generatedAt: string): string[] {
  const lines = [
    '<!DOCTYPE entity>',
    '<!--',
    `  ${title}`
  ];

  if (description) {
    lines.push(`  描述: ${description}`);
  }

  lines.push(`  生成时间: ${generatedAt}`, '-->', '');
  return lines;
}

function propertyLines(property: GeneratorFormPropertyInput, indent: string): string[] {
  const lines = [`${indent}<${property.name}>`, `${indent}  <Type>${property.type}</Type>`];

  if (property.flags) {
    lines.push(`${indent}  <Flags>${property.flags}</Flags>`);
  }
  if (property.default !== undefined) {
    lines.push(`${indent}  <Default>${property.default}</Default>`);
  }
  if (property.persistent !== undefined) {
    lines.push(`${indent}  <Persistent>${property.persistent}</Persistent>`);
  }

  lines.push(`${indent}</${property.name}>`);
  return lines;
}

function methodLines(methodName: string, indent: string, argTypes: string[]): string[] {
  const lines = [`${indent}<${methodName}>`];

  for (const argType of argTypes) {
    lines.push(`${indent}  <Arg>${argType}</Arg>`);
  }

  lines.push(`${indent}</${methodName}>`);
  return lines;
}

function parseMethodNames(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

/** 代理 def:Parent 恒为 `<实体名>Proxy`;方法段按选择落 BaseMethods/CellMethods */
export function buildProxyDefContent(input: ProxyFormInput, generatedAt = new Date().toISOString()): string {
  const proxyName = `${input.entityName}Proxy`;
  const lines = headerLines(
    `代理: ${proxyName}`,
    input.description,
    generatedAt
  );

  lines.push('<root>', '');
  lines.push('  <Parent>', `    <${proxyName}/>`, '  </Parent>', '');

  if (input.methodNames.length > 0) {
    lines.push(`  <${input.methodSection}>`);
    for (const methodName of input.methodNames) {
      lines.push(...methodLines(methodName, '    ', []));
    }
    lines.push(`  </${input.methodSection}>`, '');
  }

  lines.push('</root>', '');
  return lines.join('\n');
}

/** 空间 def:父类 Space + 进出空间回调(CellMethods) */
export function buildSpaceDefContent(input: SpaceFormInput, generatedAt = new Date().toISOString()): string {
  const lines = headerLines(`空间: ${input.name}`, input.description, generatedAt);

  lines.push('<root>', '');
  lines.push('  <Parent>', '    <Space/>', '  </Parent>', '');
  lines.push('  <CellMethods>');
  lines.push(...methodLines('onEnterSpace', '    ', ['VECTOR3']));
  lines.push(...methodLines('onLeaveSpace', '    ', ['ENTITYCALL']));
  lines.push('  </CellMethods>', '');
  lines.push('</root>', '');
  return lines.join('\n');
}

/** entities.xml 里的空间登记行:空间实体必同时有 Base 与 Cell */
export function buildSpaceRegistrationLine(name: string): string {
  return `  <${name} hasBase="true" hasCell="true" />`;
}

/** 组件 def:属性段 + 方法段,两段都可为空 */
export function buildComponentDefContent(
  input: ComponentFormInput,
  generatedAt = new Date().toISOString()
): string {
  const lines = headerLines(`组件: ${input.name}`, input.description, generatedAt);

  lines.push('<root>', '');
  lines.push('  <Properties>');
  for (const property of input.properties) {
    lines.push(...propertyLines(property, '    '));
  }
  lines.push('  </Properties>', '');
  lines.push('  <CellMethods>');
  for (const methodName of input.methodNames ?? []) {
    lines.push(...methodLines(methodName, '    ', []));
  }
  lines.push('  </CellMethods>', '');
  lines.push('</root>', '');
  return lines.join('\n');
}

/** 挂到实体上的组件属性:`COMPONENT` 类型 + 可见域 */
export function buildComponentPropertySnippet(propertyName: string, flags = 'CELL_PUBLIC'): string {
  return [
    `    <${propertyName}>`,
    '      <Type>COMPONENT</Type>',
    `      <Flags>${flags}</Flags>`,
    `    </${propertyName}>`
  ].join('\n');
}

/** types.xml 里的 FIXED_DICT 类型块(缩进一格,插入点在 </root> 前) */
export function buildFixedDictTypeContent(input: FixedDictFormInput): string {
  const lines = [`  <${input.name}>`, '    FIXED_DICT'];

  lines.push('    <Properties>');
  for (const property of input.properties) {
    lines.push(...propertyLines(property, '      '));
  }
  lines.push('    </Properties>');

  if (input.implementedBy) {
    lines.push(`    <implementedBy>${input.implementedBy}</implementedBy>`);
  }

  lines.push(`  </${input.name}>`, '');
  return lines.join('\n');
}

export interface GeneratorFormTarget {
  /** 主产物路径;目录未能定位时为 null */
  filePath: string | null;
}

/** 按形态解析主产物落点(合成布局可注入,便于覆盖目录缺失面) */
export function resolveGeneratorFormTarget(
  input: GeneratorFormInput,
  layout: DefinitionWorkspaceLayout
): GeneratorFormTarget {
  switch (input.kind) {
    case 'proxy': {
      return {
        filePath: layout.entityScriptsRoot
          ? joinWorkspacePath(layout.entityScriptsRoot, 'proxy_defs', `${input.value.entityName}Proxy.def`)
          : null
      };
    }
    case 'space': {
      return {
        filePath: layout.entityDefsRoot
          ? joinWorkspacePath(layout.entityDefsRoot, `${input.value.name}.def`)
          : null
      };
    }
    case 'component': {
      return {
        filePath: layout.componentsRoot
          ? joinWorkspacePath(layout.componentsRoot, `${input.value.name}.def`)
          : null
      };
    }
    case 'fixedDict': {
      return {
        filePath: layout.typesXmlPath
          ? layout.typesXmlPath
          : layout.entityDefsRoot
            ? joinWorkspacePath(layout.entityDefsRoot, 'types.xml')
            : null
      };
    }
  }
}

function contentOf(input: GeneratorFormInput, generatedAt: string): string {
  switch (input.kind) {
    case 'proxy':
      return buildProxyDefContent(input.value, generatedAt);
    case 'space':
      return buildSpaceDefContent(input.value, generatedAt);
    case 'component':
      return buildComponentDefContent(input.value, generatedAt);
    case 'fixedDict':
      return buildFixedDictTypeContent(input.value);
  }
}

/** 取 def 里 `<Properties>` 段的插入偏移与既有属性名(结构不合时返回 null) */
function readPropertiesSection(content: string): { insertOffset: number; propertyNames: string[] } | null {
  let document: ReturnType<typeof parseDefDocument> | null = null;
  try {
    document = parseDefDocument(content);
  } catch {
    return null;
  }

  if (!document?.root) {
    return null;
  }

  const section = getDirectChildElement(document.root, 'Properties');
  if (!section) {
    return null;
  }

  return {
    insertOffset: section.contentEnd,
    propertyNames: getDirectChildElements(section).map(node => node.name)
  };
}

/** 在 </root> 前插入一行;找不到闭合标签时返回 null */
function rootTailInsert(content: string, snippet: string): string | null {
  const index = content.lastIndexOf('</root>');
  if (index === -1) {
    return null;
  }

  return `${content.slice(0, index)}${snippet}\n${content.slice(index)}`;
}

export interface GenerateGeneratorFormOptions {
  /** 已存在的主产物是否覆盖(默认跳过) */
  overwrite?: boolean;
  /** 生成时间戳(测试可注入固定值) */
  generatedAt?: string;
  /** 组件挂载的目标实体名(其余形态忽略) */
  attachTo?: string | null;
  /** 布局注入(默认按工作区根发现) */
  layout?: DefinitionWorkspaceLayout;
}

export interface GeneratorFormOutcome {
  kind: GeneratorFormKind;
  filePath: string | null;
  /** 主产物是否真的写入 */
  written: boolean;
  /** 附带说明(跳过、目录未定、登记/挂载未做等) */
  notes: string[];
  /** 被改写的已有文件(entities.xml / types.xml / 实体 def) */
  touchedFiles: string[];
  /** IDE-GEN-008:目标冲突整体未写(def 已存在/类型重名) */
  conflict?: boolean;
}

/**
 * 主产物冲突判定(IDE-GEN-008):def 类形态看目标文件,fixedDict 看
 * types.xml 里是否已有同名类型;与实体向导同规则——冲突即整体不写
 */
export function hasGeneratorFormConflict(input: GeneratorFormInput, filePath: string): boolean {
  if (input.kind === 'fixedDict') {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    return new RegExp(`<${input.value.name}(?=[\\s>/])`, 'i').test(fs.readFileSync(filePath, 'utf8'));
  }
  return fs.existsSync(filePath);
}

/**
 * 回收本次新增与改写(IDE-GEN-008 与实体向导同规则):先还原被改写文件,
 * 再按写入逆序删除本次新增;单项回收失败不掩盖原始错误
 */
function rollbackFormWrites(
  createdFiles: string[],
  overwrittenFiles: Array<{ filePath: string; previous: string }>
): void {
  for (const item of [...overwrittenFiles].reverse()) {
    try {
      writeFileAtomic(item.filePath, item.previous);
    } catch {
      // 回收失败不掩盖原始错误
    }
  }
  for (const filePath of [...createdFiles].reverse()) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // 回收失败不掩盖原始错误
    }
  }
}

function writeOrSkip(filePath: string, content: string, overwrite: boolean): boolean {
  if (fs.existsSync(filePath) && !overwrite) {
    return false;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, content);
  return true;
}

/** 空间登记:entities.xml 存在则插一行,缺失/已登记/结构异常各记一条说明 */
function registerSpaceEntity(
  name: string,
  layout: DefinitionWorkspaceLayout,
  notes: string[],
  touchedFiles: string[]
): void {
  const entitiesXmlPath = layout.entitiesXmlPath;
  if (!entitiesXmlPath || !fs.existsSync(entitiesXmlPath)) {
    notes.push(`未找到 entities.xml,空间 ${name} 未登记(引擎按登记装载,请手动补一行)`);
    return;
  }

  const content = fs.readFileSync(entitiesXmlPath, 'utf8');
  if (new RegExp(`<${name}(?=[\\s>/])`, 'i').test(content)) {
    notes.push(`${name} 已在 entities.xml 中注册,未重复写入`);
    return;
  }

  const updated = rootTailInsert(content, buildSpaceRegistrationLine(name));
  if (updated === null) {
    notes.push(`entities.xml 找不到 </root> 标签,空间 ${name} 未登记`);
    return;
  }

  writeFileAtomic(entitiesXmlPath, updated);
  touchedFiles.push(entitiesXmlPath);
}

/** 固定字典入库:types.xml 存在则插块,不存在则新建一份最小根。
 *  返回是否真的改写了 types.xml(重名/结构异常时只记说明,不算生成) */
function registerFixedDictType(
  typeName: string,
  snippet: string,
  typesXmlPath: string,
  generatedAt: string,
  notes: string[],
  touchedFiles: string[]
): boolean {
  if (!fs.existsSync(typesXmlPath)) {
    fs.mkdirSync(path.dirname(typesXmlPath), { recursive: true });
    writeFileAtomic(
      typesXmlPath,
      `<root>\n\n<!-- 生成时间: ${generatedAt} -->\n${snippet}</root>\n`
    );
    touchedFiles.push(typesXmlPath);
    return true;
  }

  const content = fs.readFileSync(typesXmlPath, 'utf8');
  if (new RegExp(`<${typeName}(?=[\\s>/])`, 'i').test(content)) {
    notes.push(`types.xml 中已有同名类型 ${typeName},未写入`);
    return false;
  }

  const updated = rootTailInsert(content, snippet);
  if (updated === null) {
    notes.push(`types.xml 找不到 </root> 标签,类型 ${typeName} 未写入`);
    return false;
  }

  writeFileAtomic(typesXmlPath, updated);
  touchedFiles.push(typesXmlPath);
  return true;
}

/** 组件挂载:在目标实体 def 的 `<Properties>` 段末插一条 COMPONENT 属性 */
function attachComponentToEntity(
  componentName: string,
  attachTo: string,
  layout: DefinitionWorkspaceLayout,
  notes: string[],
  touchedFiles: string[]
): void {
  if (!layout.entityDefsRoot) {
    notes.push('未能定位实体定义目录,组件未挂载');
    return;
  }

  const entityDefPath = joinWorkspacePath(layout.entityDefsRoot, `${attachTo}.def`);
  if (!fs.existsSync(entityDefPath)) {
    notes.push(`未找到实体 ${attachTo} 的 .def,组件未挂载`);
    return;
  }

  const content = fs.readFileSync(entityDefPath, 'utf8');
  const section = readPropertiesSection(content);
  if (section === null) {
    notes.push(`${attachTo}.def 里没有 <Properties> 段,组件未挂载(请手写 COMPONENT 属性)`);
    return;
  }

  const existingNames = section.propertyNames.map(name => name.toLowerCase());
  if (existingNames.includes(componentName.toLowerCase())) {
    notes.push(`${attachTo}.def 已有同名属性 ${componentName},组件未挂载`);
    return;
  }

  const snippet = buildComponentPropertySnippet(componentName);
  writeFileAtomic(
    entityDefPath,
    `${content.slice(0, section.insertOffset)}${snippet}\n\n${content.slice(section.insertOffset)}`
  );
  touchedFiles.push(entityDefPath);
}

/** 按形态生成定义文件并做引擎装载口径的附带改写 */
export function generateGeneratorForm(
  input: GeneratorFormInput,
  workspaceRoot: string,
  options: GenerateGeneratorFormOptions = {}
): GeneratorFormOutcome {
  const layout = options.layout ?? getDefinitionWorkspaceLayout(workspaceRoot);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const overwrite = options.overwrite ?? false;
  const notes: string[] = [];
  const touchedFiles: string[] = [];
  const target = resolveGeneratorFormTarget(input, layout);

  if (target.filePath === null) {
    notes.push(`未能定位${GENERATOR_FORM_LABELS[input.kind]}的落盘目录,未生成`);
    return { kind: input.kind, filePath: null, written: false, notes, touchedFiles };
  }

  const filePath = target.filePath;

  // IDE-GEN-008:主产物冲突即整体不写——不先落 def 也不做附带改写
  // (entities.xml 登记/组件挂载),与实体向导的预检规则同源
  if (!overwrite && hasGeneratorFormConflict(input, filePath)) {
    notes.push(
      input.kind === 'fixedDict'
        ? `types.xml 中已有同名类型 ${input.value.name},未写入`
        : `${filePath} 已存在,未覆盖(需要覆盖请重新执行并选择覆盖)`
    );
    return { kind: input.kind, filePath, written: false, notes, touchedFiles, conflict: true };
  }

  const createdFiles: string[] = [];
  const overwrittenFiles: Array<{ filePath: string; previous: string }> = [];

  try {
    let written = false;

    if (input.kind === 'fixedDict') {
      // 固定字典入库即主产物:新文件记新增,改写记原内容供回收
      if (fs.existsSync(filePath)) {
        overwrittenFiles.push({ filePath, previous: fs.readFileSync(filePath, 'utf8') });
      } else {
        createdFiles.push(filePath);
      }
      // 重名/结构异常时只有说明,不算已生成(重名已被上面的冲突闸拦下,
      // 这里剩缺 </root> 的结构异常面)
      written = registerFixedDictType(
        input.value.name,
        contentOf(input, generatedAt),
        filePath,
        generatedAt,
        notes,
        touchedFiles
      );
    } else {
      // 冲突闸已拦下「存在且不覆盖」;到达此处要么新建(记新增)要么
      // overwrite=true 改写既有文件(记原内容供回收)
      const existed = fs.existsSync(filePath);
      if (existed) {
        overwrittenFiles.push({ filePath, previous: fs.readFileSync(filePath, 'utf8') });
      }
      writeOrSkip(filePath, contentOf(input, generatedAt), overwrite);
      written = true;
      if (!existed) {
        createdFiles.push(filePath);
      }
    }

    if (input.kind === 'space') {
      const entitiesXmlPath = layout.entitiesXmlPath;
      if (entitiesXmlPath && fs.existsSync(entitiesXmlPath)) {
        overwrittenFiles.push({ filePath: entitiesXmlPath, previous: fs.readFileSync(entitiesXmlPath, 'utf8') });
      }
      registerSpaceEntity(input.value.name, layout, notes, touchedFiles);
    }

    if (input.kind === 'component') {
      const attachTo = options.attachTo ?? null;
      if (attachTo) {
        // 备份只在能定位到实体 def 时记;挂载本身的各未做面说明
        // 仍由 attachComponentToEntity 如实给出
        if (layout.entityDefsRoot) {
          const entityDefPath = joinWorkspacePath(layout.entityDefsRoot, `${attachTo}.def`);
          if (fs.existsSync(entityDefPath)) {
            overwrittenFiles.push({ filePath: entityDefPath, previous: fs.readFileSync(entityDefPath, 'utf8') });
          }
        }
        attachComponentToEntity(input.value.name, attachTo, layout, notes, touchedFiles);
      }
    }

    return { kind: input.kind, filePath, written, notes, touchedFiles };
  } catch (error) {
    // IDE-GEN-008:任一步失败回收本次新增与改写,不留半套
    rollbackFormWrites(createdFiles, overwrittenFiles);
    throw error;
  }
}

async function askName(prompt: string, placeholder: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    placeHolder: placeholder,
    validateInput: value => NAME_VALIDATOR(value)
  });
}

async function askYesNo(placeHolder: string): Promise<boolean | undefined> {
  const picked = await vscode.window.showQuickPick(YES_NO_CHOICES, { placeHolder });
  return picked?.value;
}

async function askProxyInput(): Promise<ProxyFormInput | null> {
  const entityName = await askName('输入代理对应的实体名称', 'Avatar');
  if (!entityName) {
    return null;
  }

  const methodNames = parseMethodNames(
    await vscode.window.showInputBox({
      prompt: '代理方法名(逗号分隔,留空则只出 Parent)',
      placeHolder: 'onTargetChanged'
    })
  );

  if (methodNames.length === 0) {
    return { entityName, methodSection: 'BaseMethods', methodNames };
  }

  const section = await vscode.window.showQuickPick(PROXY_METHOD_SECTION_CHOICES, {
    placeHolder: '代理方法声明在哪个方法段'
  });
  if (!section) {
    return null;
  }

  return { entityName, methodSection: section.value, methodNames };
}

async function askComponentInput(): Promise<{ input: ComponentFormInput; attachTo: string | null } | null> {
  const name = await askName('输入组件名称', 'Inventory');
  if (!name) {
    return null;
  }

  const addSample = await askYesNo('是否添加示例属性?');
  const attachItems: AttachPickItem[] = [
    NO_ATTACH_CHOICE,
    ...getRegisteredEntities(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '').map(entity => ({
      label: entity.name,
      description: '挂到该实体(加一条 COMPONENT 属性)',
      value: entity.name
    }))
  ];
  const attach = await vscode.window.showQuickPick(attachItems, { placeHolder: '挂载到哪个实体?' });
  if (!attach) {
    return null;
  }

  return {
    input: {
      name,
      properties: addSample ? [COMPONENT_SAMPLE_PROPERTY] : [],
      methodNames: addSample ? ['onChanged'] : [],
      description: `自动生成的 ${name} 组件`
    },
    attachTo: attach.value
  };
}

async function askFixedDictInput(): Promise<FixedDictFormInput | null> {
  const name = await askName('输入类型名称', 'MY_DATA');
  if (!name) {
    return null;
  }

  const implementedBy = await vscode.window.showInputBox({
    prompt: '实现符号(留空则不写 implementedBy)',
    placeHolder: `${name}_DATA.${name.toLowerCase()}_inst`,
    validateInput: value => IMPLEMENTED_BY_VALIDATOR(value)
  });
  if (implementedBy === undefined) {
    return null;
  }

  const addSample = await askYesNo('是否添加示例字段?');
  return {
    name,
    properties: addSample ? [FIXED_DICT_SAMPLE_PROPERTY] : [],
    implementedBy: implementedBy.trim() ? implementedBy.trim() : undefined
  };
}

async function askSpaceInput(): Promise<SpaceFormInput | null> {
  const name = await askName('输入空间名称', 'MySpace');
  if (!name) {
    return null;
  }

  return { name, description: `自动生成的 ${name} 空间实体` };
}

/** 表单生成的计划项(IDE-GEN-008):主产物准确路径 + 附带改写目标 */
function buildFormPlanItems(
  input: GeneratorFormInput,
  layout: DefinitionWorkspaceLayout,
  filePath: string,
  attachTo: string | null
): GenerationPlanItem[] {
  if (input.kind === 'fixedDict') {
    return [{ label: '注册 types.xml', description: `${filePath}: <${input.value.name}>` }];
  }

  const items: GenerationPlanItem[] = [{ label: '新增 .def', description: filePath }];

  if (input.kind === 'space' && layout.entitiesXmlPath) {
    items.push({
      label: '注册 entities.xml',
      description: `${layout.entitiesXmlPath}: ${buildSpaceRegistrationLine(input.value.name).trim()}`
    });
  }

  if (input.kind === 'component' && attachTo && layout.entityDefsRoot) {
    items.push({
      label: '挂载组件属性',
      description: joinWorkspacePath(layout.entityDefsRoot, `${attachTo}.def`)
    });
  }

  return items;
}

/** 命令入口:勾形态 → 填参数 → 落盘 + 附带改写 → 逐条播报说明 */
export async function runGeneratorFormWizard(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('没有打开的工作区');
    return;
  }

  const picked = await vscode.window.showQuickPick(GENERATOR_FORM_CHOICES, {
    placeHolder: '选择要生成的定义形态'
  });
  if (!picked) {
    return;
  }

  let input: GeneratorFormInput | null = null;
  let attachTo: string | null = null;

  if (picked.value === 'proxy') {
    const value = await askProxyInput();
    input = value ? { kind: 'proxy', value } : null;
  } else if (picked.value === 'space') {
    const value = await askSpaceInput();
    input = value ? { kind: 'space', value } : null;
  } else if (picked.value === 'component') {
    const answered = await askComponentInput();
    input = answered ? { kind: 'component', value: answered.input } : null;
    attachTo = answered?.attachTo ?? null;
  } else {
    const value = await askFixedDictInput();
    input = value ? { kind: 'fixedDict', value } : null;
  }

  if (!input) {
    return;
  }

  try {
    // IDE-GEN-008:与实体向导同规则——冲突不进预览直接交落盘层播报,
    // 无冲突先出计划确认(准确路径+附带改写项),确认后才写
    const layout = getDefinitionWorkspaceLayout(workspaceRoot);
    const target = resolveGeneratorFormTarget(input, layout);
    if (target.filePath !== null && !hasGeneratorFormConflict(input, target.filePath)) {
      const confirmed = await confirmGenerationPlanItems(
        buildFormPlanItems(input, layout, target.filePath, attachTo)
      );
      if (!confirmed) {
        return;
      }
    }

    const outcome = generateGeneratorForm(input, workspaceRoot, { attachTo, layout });
    for (const note of outcome.notes) {
      vscode.window.showWarningMessage(note);
    }

    if (outcome.written && outcome.filePath) {
      vscode.window.showInformationMessage(
        `✅ 已生成${GENERATOR_FORM_LABELS[outcome.kind]}: ${outcome.filePath}`
      );

      const open = await vscode.window.showInformationMessage('是否打开生成的文件?', '是', '否');
      if (open === '是') {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(outcome.filePath));
        await vscode.window.showTextDocument(document);
      }
    }
  } catch (error) {
    vscode.window.showErrorMessage(`生成失败: ${error}`);
  }
}