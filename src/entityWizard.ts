/**
 * 新建实体向导的纯内容构建面(GEN-DEF-2)。
 *
 * 只负责「输入 → 文本」与「项目模板覆盖」的纯计算,零 vscode 依赖、零 IO;
 * 落盘/注册/回滚等事务面由 codeGenerator.ts 的交互流承担。
 *
 * 引擎约定(与 kbengine-demo-assets 实测对账,勿凭记忆改):
 *  - 实体脚本按段分文件:scripts/base/<Name>.py / scripts/cell/<Name>.py /
 *    scripts/client/<Name>.py;类名必须与实体名逐字一致(无 Cell/Base 后缀)。
 *  - base/cell 段类继承 KBEngine.Entity,__init__ 先 KBEngine.Entity.__init__(self)。
 *  - onTimer(id, userArg) 是脚本钩子(配合 addTimer),不是 def 方法——绝不写进 def。
 *  - onWriteToDB(self, cellData) 是 base 段钩子,cellData 即「cell 数据字典」约定。
 *  - def 属性 Flags 决定可见段位(BASE/CELL_PUBLIC/ALL_CLIENTS 等);Persistent=false
 *    即 TEMP 属性(不持久化)。
 *  - ARRAY 内联:<Type> ARRAY <of> 元素类型 </of> </Type>;FIXED_DICT 只能引用
 *    types.xml 命名类型(不能内联),无 implementedBy 用默认序列化即可加载。
 */

export type EntityWizardPart = 'base' | 'cell' | 'client';

export type EntityPropertyTemplate = 'simple' | 'fixedArray' | 'fixedDict';

/** 新建实体向导输入(纯数据,无 vscode 句柄) */
export interface NewEntityWizardInput {
  name: string;
  hasBase: boolean;
  hasCell: boolean;
  /** 客户端存在性(entities.xml hasClient) */
  hasClient: boolean;
  /** 是否生成客户端 stub(仅在 hasClient 时有效) */
  generateClientStub: boolean;
  propertyTemplate: EntityPropertyTemplate;
  /** 可选父实体(生成 <Parent> 声明;空则不写) */
  parent?: string;
  description?: string;
}

/** 项目级模板覆盖(.kode/templates/),逐文件可缺省回退内置 */
export interface EntityWizardTemplateOverrides {
  def?: string;
  base?: string;
  cell?: string;
  client?: string;
}

/** 模板文件名(相对 .kode/templates/) */
export const ENTITY_WIZARD_TEMPLATE_FILES = {
  def: 'new-entity.def',
  base: 'new-entity.base.py',
  cell: 'new-entity.cell.py',
  client: 'new-entity.client.py'
} as const;

/** FIXED_DICT 属性模板引用的 types.xml 命名类型名(实体名打头防跨实体撞名) */
export function fixedDictTypeName(entityName: string): string {
  return `${entityName}State`;
}

/** 生成 entities.xml 注册片段(与既有 generateEntityRegistration 同构,属性序 hasCell/hasBase/hasClient) */
export function buildNewEntityRegistration(input: NewEntityWizardInput): string {
  return `  <${input.name} hasCell="${input.hasCell}" hasBase="${input.hasBase}" hasClient="${input.hasClient}" />`;
}

/**
 * 生成 FIXED_DICT 属性模板对应的 types.xml 命名类型定义。
 * 无 implementedBy(默认序列化,引擎可直接加载);仅 propertyTemplate='fixedDict'
 * 时使用。
 */
export function buildFixedDictTypeDefinition(input: NewEntityWizardInput): string {
  const typeName = fixedDictTypeName(input.name);
  const lines: string[] = [];
  lines.push(`\t<${typeName}>`);
  lines.push('\t\tFIXED_DICT');
  lines.push('\t\t<Properties>');
  lines.push('\t\t\t<value>');
  lines.push('\t\t\t\t<Type> UINT32 </Type>');
  lines.push('\t\t\t</value>');
  lines.push('\t\t</Properties>');
  lines.push(`\t</${typeName}>`);
  return lines.join('\n');
}

/** 固定样板属性(def 骨架的常用 CELL_DATA 示例 + TEMP 属性) */
function commonPropertyLines(indent: string): string[] {
  return [
    `${indent}<name>`,
    `${indent}\t<Type> STRING </Type>`,
    `${indent}\t<Flags> BASE_AND_CLIENT </Flags>`,
    `${indent}\t<Persistent> true </Persistent>`,
    `${indent}\t<DatabaseLength> 64 </DatabaseLength>`,
    `${indent}</name>`,
    `${indent}<hp>`,
    `${indent}\t<Type> UINT32 </Type>`,
    `${indent}\t<Flags> ALL_CLIENTS </Flags>`,
    `${indent}</hp>`,
    `${indent}<position>`,
    `${indent}\t<Type> VECTOR3 </Type>`,
    `${indent}\t<Flags> CELL_PUBLIC_AND_OWN </Flags>`,
    `${indent}</position>`,
    // TEMP 属性:Persistent=false,服务器重启即失
    `${indent}<tempState>`,
    `${indent}\t<Type> UINT32 </Type>`,
    `${indent}\t<Flags> CELL_PRIVATE </Flags>`,
    `${indent}\t<Persistent> false </Persistent>`,
    `${indent}</tempState>`
  ];
}

/** 属性模板示例(def 内联属性行;FIXED_DICT 引用命名类型) */
function templatePropertyLines(
  input: NewEntityWizardInput,
  indent: string
): string[] {
  const lines: string[] = [];
  switch (input.propertyTemplate) {
    case 'fixedArray':
      lines.push(`${indent}<skillIds>`);
      lines.push(`${indent}\t<Type>`);
      lines.push(`${indent}\t\tARRAY`);
      lines.push(`${indent}\t\t<of> UINT32 </of>`);
      lines.push(`${indent}\t</Type>`);
      lines.push(`${indent}\t<Flags> BASE </Flags>`);
      lines.push(`${indent}\t<Persistent> true </Persistent>`);
      lines.push(`${indent}</skillIds>`);
      break;
    case 'fixedDict':
      lines.push(`${indent}<state>`);
      lines.push(`${indent}\t<Type> ${fixedDictTypeName(input.name)} </Type>`);
      lines.push(`${indent}\t<Flags> CELL_PUBLIC </Flags>`);
      lines.push(`${indent}\t<Persistent> true </Persistent>`);
      lines.push(`${indent}</state>`);
      break;
    case 'simple':
    default:
      lines.push(`${indent}<level>`);
      lines.push(`${indent}\t<Type> UINT32 </Type>`);
      lines.push(`${indent}\t<Flags> BASE_AND_CLIENT </Flags>`);
      lines.push(`${indent}\t<Persistent> true </Persistent>`);
      lines.push(`${indent}</level>`);
      break;
  }
  return lines;
}

/** 生成 .def 文件内容(新建实体向导口径) */
export function buildNewEntityDefContent(
  input: NewEntityWizardInput,
  generatedAt = new Date().toISOString()
): string {
  const lines: string[] = [];
  lines.push('<!DOCTYPE entity>');
  lines.push('<!--');
  lines.push(`  实体: ${input.name}`);
  if (input.description) {
    lines.push(`  描述: ${input.description}`);
  }
  lines.push(`  生成时间: ${generatedAt}`);
  lines.push('-->');
  lines.push('');
  lines.push('<root>');
  lines.push('');
  if (input.parent) {
    lines.push('  <Parent>');
    lines.push(`    <${input.parent}/>`);
    lines.push('  </Parent>');
    lines.push('');
  }
  lines.push('  <Properties>');
  lines.push('    <!-- 常用示例属性 -->');
  lines.push(...commonPropertyLines('    '));
  lines.push('    <!-- 属性模板示例 -->');
  lines.push(...templatePropertyLines(input, '    '));
  lines.push('  </Properties>');
  lines.push('');
  lines.push('</root>');
  return lines.join('\n');
}

/**
 * 返回某段需要判 None 守卫的容器属性(仅 ARRAY/FIXED_DICT 形态,与
 * GEN-DEF-1 口径一致:简单类型不守卫)。守卫只出现在该属性的 Flags 域段:
 * skillIds(BASE)→base 段;state(CELL_PUBLIC)→cell 段;其余段不引用该属性,
 * 生成守卫会因 self.<prop> 不存在而炸——绝不越域生成。
 */
export function containerGuardProperties(
  input: NewEntityWizardInput,
  part: EntityWizardPart
): Array<{ name: string; empty: string }> {
  const guards: Array<{ name: string; empty: string }> = [];
  if (input.propertyTemplate === 'fixedArray' && part === 'base') {
    guards.push({ name: 'skillIds', empty: '[]' });
  } else if (input.propertyTemplate === 'fixedDict' && part === 'cell') {
    guards.push({ name: 'state', empty: '{}' });
  }
  return guards;
}

/** 生成某段实体脚本(类名=实体名,继承 KBEngine.Entity) */
export function buildEntityPartPythonContent(
  input: NewEntityWizardInput,
  part: EntityWizardPart,
  generatedAt = new Date().toISOString()
): string {
  const lines: string[] = [];
  lines.push('# -*- coding: utf-8 -*-');
  lines.push('#');
  lines.push(`# ${input.name} (${part} 段)`);
  lines.push(`# 生成时间: ${generatedAt}`);
  lines.push('#');
  lines.push('');
  lines.push('import KBEngine');
  lines.push('');
  lines.push('');
  lines.push(`class ${input.name}(KBEngine.Entity):`);
  lines.push('');
  lines.push('\tdef __init__(self):');
  lines.push('\t\tKBEngine.Entity.__init__(self)');
  for (const guard of containerGuardProperties(input, part)) {
    lines.push(`\t\tif self.${guard.name} is None:`);
    lines.push(`\t\t\tself.${guard.name} = ${guard.empty}`);
  }
  lines.push('');

  // onTimer:脚本钩子(配合 addTimer),非 def 方法
  lines.push('\tdef onTimer(self, id, userArg):');
  lines.push('\t\t"""');
  lines.push('\t\tKBEngine method.');
  lines.push('\t\t使用 addTimer 后, 当时间到达则该接口被调用');
  lines.push('\t\t@param id: addTimer 的返回值 ID');
  lines.push('\t\t@param userArg: addTimer 最后一个参数所给入的数据');
  lines.push('\t\t"""');
  lines.push('\t\tpass');
  lines.push('');

  if (part === 'base') {
    // base 段:onWriteToDB(self, cellData) —— cellData 即「cell 数据字典」约定
    lines.push('\tdef onWriteToDB(self, cellData):');
    lines.push('\t\t"""');
    lines.push('\t\tKBEngine method.');
    lines.push('\t\t将 cell 数据持久化到数据库时调用, cellData 为需要保存的 cell 数据字典。');
    lines.push('\t\t如需过滤字段, 修改 cellData 后按默认逻辑落库。');
    lines.push('\t\t"""');
    lines.push('\t\tpass');
    lines.push('');
  } else if (part === 'cell') {
    lines.push('\tdef onEnterWorld(self):');
    lines.push('\t\t"""');
    lines.push('\t\tKBEngine method.');
    lines.push('\t\t进入世界时调用(仅 Cell 段实体)。');
    lines.push('\t\t"""');
    lines.push('\t\tpass');
    lines.push('');
    lines.push('\tdef onLeaveWorld(self):');
    lines.push('\t\t"""');
    lines.push('\t\tKBEngine method.');
    lines.push('\t\t离开世界时调用(仅 Cell 段实体)。');
    lines.push('\t\t"""');
    lines.push('\t\tpass');
    lines.push('');
  } else {
    lines.push('\tdef onClientEnabled(self):');
    lines.push('\t\t"""');
    lines.push('\t\tKBEngine method.');
    lines.push('\t\t该 entity 被正式激活为可使用, 此时已建立 client 对应实体。');
    lines.push('\t\t"""');
    lines.push('\t\tpass');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 应用项目模板占位符。占位符:{{Name}} / {{ClassName}}(类名=实体名)。
 * 未识别的占位符原样保留(不静默吞掉,便于项目作者发现拼写错误)。
 */
export function applyEntityTemplatePlaceholders(text: string, name: string): string {
  return text
    .replace(/\{\{Name\}\}/g, name)
    .replace(/\{\{ClassName\}\}/g, name);
}

/**
 * 解析 .kode/templates/ 下的项目级模板覆盖。
 * readFile 注入(返回 null 表示不存在),缺失项缺省 undefined(回退内置)。
 */
export function resolveEntityWizardTemplateOverrides(
  workspaceRoot: string,
  readFile: (absolutePath: string) => string | null
): EntityWizardTemplateOverrides {
  const join = (relative: string) => `${workspaceRoot}/.kode/templates/${relative}`;
  const overrides: EntityWizardTemplateOverrides = {};
  for (const part of ['def', 'base', 'cell', 'client'] as const) {
    const content = readFile(join(ENTITY_WIZARD_TEMPLATE_FILES[part]));
    if (content !== null) {
      overrides[part] = content;
    }
  }
  return overrides;
}

/**
 * 该输入需要落盘的脚本段列表(按引擎约定:hasBase→base,hasCell→cell,
 * hasClient&&generateClientStub→client)。
 */
export function entityWizardPartsToGenerate(input: NewEntityWizardInput): EntityWizardPart[] {
  const parts: EntityWizardPart[] = [];
  if (input.hasBase) parts.push('base');
  if (input.hasCell) parts.push('cell');
  if (input.hasClient && input.generateClientStub) parts.push('client');
  return parts;
}

/**
 * 构建某段脚本内容,项目模板覆盖优先(占位符替换),否则内置。
 */
export function buildEntityPartContent(
  input: NewEntityWizardInput,
  part: EntityWizardPart,
  overrides: EntityWizardTemplateOverrides,
  generatedAt = new Date().toISOString()
): string {
  const template = overrides[part];
  if (template !== undefined) {
    return applyEntityTemplatePlaceholders(template, input.name);
  }
  return buildEntityPartPythonContent(input, part, generatedAt);
}

/**
 * 构建 def 内容,项目模板覆盖优先,否则内置。
 */
export function buildEntityDefContent(
  input: NewEntityWizardInput,
  overrides: EntityWizardTemplateOverrides,
  generatedAt = new Date().toISOString()
): string {
  if (overrides.def !== undefined) {
    return applyEntityTemplatePlaceholders(overrides.def, input.name);
  }
  return buildNewEntityDefContent(input, generatedAt);
}
