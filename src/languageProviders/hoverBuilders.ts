// SRC-012 partial split from hover.ts: module-level hover builders and value
// docs faces moved verbatim (zero behavior change). Class providers and the
// in-flight memo infra remain in hover.ts; hover.ts re-exports every name
// moved here so './hover' import paths are unchanged.

import * as path from 'path';
import * as vscode from 'vscode';
import { DefElementNode, findDeepestElementAtOffset, findTextNodeAtOffset, getScalarChildValue, getScalarChildValues, hasTruthyChildTag } from '../backend/defParser';
import { buildDefChain } from '../backend/defChain';
import { describePropertyDatabaseStoragePublished, getTypeStorageShape, TypeStorageShape } from '../databaseSchema';
import { buildPropertyDatabaseStorageHover, describeBuiltinTypeCapacity } from '../databaseSimulator';
import { findCustomTypeInfo, findTypesXmlImplementedByReference, findDefinitionFileByCategory, findEntityDefinitionFile, findEntityScriptFile, getEntityRuntimeProfile, getRegisteredEntities, getWorkspaceRootForDocument } from '../definitionWorkspace';
import { describeMethodCallDirection, describePropertySyncDirection } from '../backend/entityFlowGraph';
import { renderUserTypeContractHoverSection, userTypeContractStatusForName, implementedByBindingForWorkspace } from '../backend/userTypeContractSource';
import { renderImplementedByBindingSection } from '../backend/implementedByBinding';
import { HOOK_CATEGORY_NAMES } from '../hooks';
import { engineApiVersionAnnotation, summaryForLanguage } from '../kbeModuleIndex';
import { getEngineVersion } from '../engineVersion';
import { KBEngineSectionName, METHOD_SECTIONS, PROPERTY_SECTIONS, getSectionLabel, parseDefAst } from './shared';
import { describeExpectedScriptPaths, findCustomTypeAtPosition, findEnclosingSymbol, formatWorkspaceRelativePath, isPositionInsideTagValue } from './navigation';

export interface SymbolHoverInfo {
  name: string;
  section: KBEngineSectionName;
  type?: string;
  flags?: string;
  defaultValue?: string;
  detailLevel?: string;
  database?: string;
  identifier?: string;
  persistent: boolean;
  args: string[];
  exposed?: boolean;
}

export function getSymbolHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  const symbolInfo = findEnclosingSymbol(document, position, word);
  if (!symbolInfo) {
    return null;
  }

  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${symbolInfo.name}**\n\n`);
  markdown.appendMarkdown(`${getSectionLabel(symbolInfo.section)}中的自定义定义。\n\n`);

  if (PROPERTY_SECTIONS.has(symbolInfo.section)) {
    if (symbolInfo.type) {
      markdown.appendMarkdown(`**Type**: \`${symbolInfo.type}\`\n\n`);
    }
    if (symbolInfo.flags) {
      markdown.appendMarkdown(`**Flags**: \`${symbolInfo.flags}\`\n\n`);
    }
    // GEN-DEF-1e ③:属性数据流方向(同步源→受众),与 entityFlowGraph 主图
    // 同源旗标语义;无旗标给出「不注册任何域」,不发明方向。
    const syncDirection = describePropertySyncDirection(symbolInfo.flags);
    if (syncDirection) {
      markdown.appendMarkdown(`**同步方向**: ${syncDirection}\n\n`);
    }
    if (symbolInfo.defaultValue) {
      markdown.appendMarkdown(`**Default**: \`${symbolInfo.defaultValue}\`\n\n`);
    }
    if (symbolInfo.detailLevel) {
      markdown.appendMarkdown(`**DetailLevel**: \`${symbolInfo.detailLevel}\`\n\n`);
    }
    if (symbolInfo.database) {
      markdown.appendMarkdown(`**DatabaseLength**: \`${symbolInfo.database}\`\n\n`);
    }
    if (symbolInfo.identifier) {
      markdown.appendMarkdown(`**Identifier**: \`${symbolInfo.identifier}\`\n\n`);
    }
    // Persistent 字段的数据库落点(2026-10-13 用户令):悬停展示库表与列名;
    // types.xml 别名类型沿快照别名链展开,完整建表结构走 kbengine.database.open。
    if (symbolInfo.persistent) {
      const storageLine = describePropertyDatabaseStorageHover(document, symbolInfo.name);
      if (storageLine) {
        markdown.appendMarkdown(`\n\n**数据库存储**: ${storageLine}`);
      }
    }
  }

  if (METHOD_SECTIONS.has(symbolInfo.section)) {
    // GEN-DEF-1e ③:方法段调用方向(baseapp/cellapp 方法 / 客户端回调)。
    const methodDirection = describeMethodCallDirection(symbolInfo.section);
    if (methodDirection) {
      markdown.appendMarkdown(`**调用方向**: ${methodDirection}\n\n`);
    }
    markdown.appendMarkdown(`**参数个数**: ${symbolInfo.args.length}\n\n`);
    if (symbolInfo.args.length > 0) {
      markdown.appendMarkdown(`**Args**: \`${symbolInfo.args.join(', ')}\``);
    }
    if (symbolInfo.exposed) {
      markdown.appendMarkdown(`\n\n**Exposed**: \`true\`\n\n`);
      markdown.appendMarkdown('该方法可被客户端远程调用。');
    }
  }

  return new vscode.Hover(markdown);
}

/**
 * 属性悬停的数据库存储描述行(批131 用户令升级:完整 db.table.column +
 * 引擎 DDL 片段 + 具体大小限制;库表名转义,粘贴进外部 MySQL 客户端即用)。
 * 非持久属性无目标返回 null,悬停不显示该行。
 */
export function describePropertyDatabaseStorageHover(
  document: vscode.TextDocument,
  propertyName: string
): string | null {
  const entityName = path.basename(document.fileName, '.def');
  // IDE-REV-012:悬停只读已发布快照——冷/失效 miss 不整段同步构建,调度
  // 后台构建(阶段间让出宿主,可取消)后本悬停不出存储行,发布后下一悬停出
  return buildPropertyDatabaseStorageHover(
    describePropertyDatabaseStoragePublished(entityName, propertyName, document)
  );
}

export function createHookHover(hook: import('../hooks').KBEngineHook): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${hook.name}** - ${vscode.l10n.t(HOOK_CATEGORY_NAMES[hook.category])}\n\n`);
  markdown.appendMarkdown(`${hook.description}\n\n`);
  markdown.appendMarkdown('**调用时机**: ' + hook.timing + '\n\n');
  markdown.appendMarkdown('**函数签名**:\n');
  markdown.appendCodeblock(hook.signature, 'python');
  markdown.appendMarkdown('\n**详细说明**:\n');
  markdown.appendMarkdown(hook.documentation);
  // 不可达(批64 定性):KBENGINE_HOOKS 全部 36 个 hook 均带 sourceLocation
  // 与 example(src/hooks.ts 数据不变式,引擎侧用例亦锁定 sourceLocation),
  // 两个 if 的假臂不可达。精确单行区间只摘除分支条目,悬停文案保持被覆盖计入分母。
  /* istanbul ignore start */
  if (hook.sourceLocation) {
  /* istanbul ignore stop */
    markdown.appendMarkdown('\n\n**源码位置**: `' + hook.sourceLocation + '`');
  }
  /* istanbul ignore start */
  if (hook.example) {
  /* istanbul ignore stop */
    markdown.appendMarkdown('\n\n**使用示例**:\n');
    markdown.appendCodeblock(hook.example, 'python');
  }
  return new vscode.Hover(markdown);
}

// GEN-DEF-1e ②+口径①:user_type 带 impl 时,悬停补三契约方法状态与双向
// 序列化契约。workspace root 不可得 / 无 implementedBy / 未注册 → null
// (不打扰无契约的类型悬停)。
/**
 * SP-5: cellappIndex semantics for createCellEntityInNewSpace.
 * Sources: baseapp/Entity.md:144; cellappmgr.cpp:348-351 ((index-1)%size);
 * baseapp.cpp:2473-2479 (0 => load balancer).
 */
export function createCellappIndexHover(word: string): vscode.Hover | null {
  if (word !== 'cellappIndex' && word !== 'createCellEntityInNewSpace') {
    return null;
  }
  const markdown = new vscode.MarkdownString();
  if (word === 'cellappIndex') {
    markdown.appendMarkdown('**cellappIndex** - createCellEntityInNewSpace 的目标 cellapp 序号\n\n');
  } else {
    markdown.appendMarkdown('**createCellEntityInNewSpace**(cellappIndex) - 新建 Space 并把本实体 cell 放入\n\n');
  }
  markdown.appendMarkdown('**语义**:\n');
  markdown.appendMarkdown('- `0`/`None`:由引擎负载均衡动态选择 cellapp(推荐,副本 space 默认用法)\n');
  markdown.appendMarkdown('- `N > 0`:固定选第 N 个 cellapp;索引溢出取模轮转——预期 4 个实际只有 3 个时,`4→1`、`5→2`(cellappmgr.cpp:348-351 `(N-1) % cellappSize`)\n\n');
  markdown.appendMarkdown('**搭配**:`KBEngine.setAppFlags(KBEngine.APP_FLAGS_NOT_PARTCIPATING_LOAD_BALANCING)` 把大地图钉在固定 cellapp,副本用 `cellappIndex=0` 走机动进程,互不抢负载。\n\n');
  markdown.appendMarkdown('**示例**:\n');
  markdown.appendCodeblock(['# 大地图:固定到第 2 个 cellapp(需先对该 cellapp 设 NOT_PARTCIPATING_LOAD_BALANCING)', 'self.createCellEntityInNewSpace(2)', '', '# 副本:自动均衡', 'self.createCellEntityInNewSpace(0)'].join('\n'), 'python');
  markdown.appendMarkdown('\n**源码**: `baseapp.cpp:2462` → `cellappmgr.cpp:310`\n');
  return new vscode.Hover(markdown);
}

/** SP-1: entrance script (kbemain) module-level SPI hover - no self, scoped by component entry path */
export function createEntryHookHover(hook: import('../backend/entryHooks').KBEngineEntryHook): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${hook.name}** - Entry Script (${hook.component})\n\n`);
  markdown.appendMarkdown(`${hook.description}\n\n`);
  markdown.appendMarkdown('**调用时机**: ' + hook.timing + '\n\n');
  markdown.appendMarkdown('**函数签名**:\n');
  markdown.appendCodeblock(hook.signature, 'python');
  markdown.appendMarkdown('\n**详细说明**:\n');
  markdown.appendMarkdown(hook.documentation);
  markdown.appendMarkdown('\n\n**源码位置**: `' + hook.sourceLocation + '`');
  if (hook.example) {
    markdown.appendMarkdown('\n\n**使用示例**:\n');
    markdown.appendCodeblock(hook.example, 'python');
  }
  return new vscode.Hover(markdown);
}

/** SP-2: kbe/KBEngine module symbol hover - knowledge summary + typings anchor */
export function createKbeSymbolHover(entry: import('../kbeModuleIndex').KbeSymbolEntry): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  const language = vscode.env.language;
  markdown.appendMarkdown(`**${entry.name}** - ${entry.signature}\n\n`);
  markdown.appendMarkdown(summaryForLanguage(entry, language) + '\n\n');
  markdown.appendMarkdown('原始声明: `' + entry.sourceFile + ':' + entry.sourceLine + '`');
  const note = engineApiVersionAnnotation(entry, getEngineVersion(), language);
  if (note) {
    markdown.appendMarkdown('\n\n' + note);
  }
  return new vscode.Hover(markdown);
}

export function resolveUserTypeContractSection(
  document: vscode.TextDocument,
  customTypeInfo: NonNullable<ReturnType<typeof findCustomTypeInfo>>
): string | null {
  if (!customTypeInfo.implementedBy) {
    return null;
  }
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return null;
  }
  const status = userTypeContractStatusForName(workspaceRoot, customTypeInfo.name);
  if (!status) {
    return null;
  }
  return renderUserTypeContractHoverSection(status);
}

// KSEM-STRUCT-06:implementedBy 绑定真形段(形态/落点/未知原因)。
// 无 implementedBy / 文档不在工作区 → null(与契约段同门槛);绑定未知也
// 有段(如实呈现未知原因),缺的是「面」不是「绑定」。
export function resolveImplementedByBindingSection(
  document: vscode.TextDocument,
  customTypeInfo: NonNullable<ReturnType<typeof findCustomTypeInfo>>
): string | null {
  if (!customTypeInfo.implementedBy) {
    return null;
  }
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return null;
  }
  const binding = implementedByBindingForWorkspace(workspaceRoot, customTypeInfo.implementedBy);
  return binding ? renderImplementedByBindingSection(binding) : null;
}

export function getCustomTypeHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  if (isPositionInsideTagValue(document, position, 'Type')) {
    return null;
  }

  const customTypeTarget = findCustomTypeAtPosition(document, position, word);
  if (!customTypeTarget) {
    return null;
  }

  return createCustomTypeHover(
    customTypeTarget.info,
    'Custom type from `types.xml`',
    // 批134:声明行悬停追加落库形态;implementedBy 值上的悬停只谈引用,不谈存储
    customTypeTarget.isImplementedByValue ? null : getTypeStorageShapeMarkdown(document, word),
    resolveUserTypeContractSection(document, customTypeTarget.info),
    resolveImplementedByBindingSection(document, customTypeTarget.info)
  );
}

// 批134:types.xml 类型声明行悬停的落库形态段。形态判定走 schema 构建
// 器的别名/列展开语义(getTypeStorageShape 与引擎装载同源),这里把形态
// 翻成说明文字;悬停的就是 types.xml 本体,直接按文档路径解析
export function getTypeStorageShapeMarkdown(document: vscode.TextDocument, word: string): string | null {
  const shapeLines = describeTypeStorageShape(getTypeStorageShape(document.fileName, word));
  return `**落库形态**:\n${shapeLines.map(line => `- ${line}`).join('\n')}\n\n`;
}

export function describeTypeStorageShape(shape: TypeStorageShape): string[] {
  if (shape.kind === 'builtin') {
    // IDE-DB-001:内建形态附容量说明(可指定与否/引擎默认 255/上限与校验方)
    const capacity = describeBuiltinTypeCapacity(shape.typeName);
    return [
      `主表单列${shape.columnType ? `（\`${shape.columnType}\`）` : ''}`,
      ...(capacity ? [`容量：${capacity}`] : [])
    ];
  }
  if (shape.kind === 'fixedDict') {
    const keys = shape.topLevelKeys.length > 0
      ? `；顶层键各占一列：${shape.topLevelKeys.join('、')}`
      : '';
    return [
      `平铺成列，不成表${keys}`,
      '容量：逐键按其键类型——STRING 键可配长度（未配置引擎默认 255），整型/浮点键为显示宽度，blob 族键不可配'
    ];
  }
  if (shape.kind === 'array') {
    const element = shape.element
      ? `元素落列：${describeTypeStorageElement(shape.element)}`
      : '缺 <of>，元素类型未知';
    return [
      `成子表 \`tbl_<实体>_<属性>\`，元素各占一行；${element}`,
      '容量：逐元素按其元素类型，规则同主表单列'
    ];
  }
  return ['未知类型，引擎装载 types.xml 会失败'];
}

export function describeTypeStorageElement(element: TypeStorageShape): string {
  if (element.kind === 'builtin') {
    return `\`sm_value\`${element.columnType ? `（\`${element.columnType}\`）` : ''}`;
  }
  if (element.kind === 'fixedDict') {
    return element.topLevelKeys.length > 0
      ? `键平铺：${element.topLevelKeys.join('、')}`
      : '键平铺';
  }
  if (element.kind === 'array') {
    return element.element ? '`sm_value`（套更深层子表）' : '`sm_value`';
  }
  return '未知元素类型';
}

// types.xml implementedBy 反向跳转提示(python 侧):光标在被引用符号上时
// 给出引用方与落点,点击跳转(F12/Ctrl+点击)走 PythonDefinitionProvider
// 的反向链,提示与跳转同一套解析,不另起一套
export function getImplementedByReverseHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  if (!document.fileName.toLowerCase().endsWith('.py')) {
    return null;
  }

  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return null;
  }

  const reference = findTypesXmlImplementedByReference(workspaceRoot, document.fileName, word);
  if (!reference) {
    return null;
  }

  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${word}**\n\n`);
  markdown.appendMarkdown(
    `types.xml 自定义类型 \`${reference.typeName}\` 以 \`implementedBy\` 引用此符号。\n\n`
  );
  markdown.appendMarkdown(
    `F12 / Ctrl+点击 跳回 \`${path.basename(reference.filePath)}\` 第 ${reference.line} 行。`
  );
  return new vscode.Hover(markdown);
}

export function getTypeValueHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  if (!isPositionInsideTagValue(document, position, 'Type')) {
    return null;
  }

  const customTypeInfo = findCustomTypeInfo(word, document);
  if (customTypeInfo) {
    return createCustomTypeHover(
      customTypeInfo,
      'Referenced custom type from `types.xml`',
      null,
      resolveUserTypeContractSection(document, customTypeInfo)
    );
  }

  const componentPath = findDefinitionFileByCategory(word, 'component', document);
  if (componentPath) {
    return createDefinitionReferenceHover(word, 'Component type', componentPath);
  }

  const entityPath = findEntityDefinitionFile(word, document);
  if (entityPath) {
    const extraLines = getEntityRuntimeHoverLines(document, word);
    return createDefinitionReferenceHover(word, 'Entity type', entityPath, extraLines);
  }

  return null;
}

export function createCustomTypeHover(
  customTypeInfo: NonNullable<ReturnType<typeof findCustomTypeInfo>>,
  summary: string,
  shapeMarkdown: string | null = null,
  contractSection: string | null = null,
  bindingSection: string | null = null
): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${customTypeInfo.name}**\n\n`);
  markdown.appendMarkdown(`${summary}\n\n`);
  markdown.appendMarkdown(`**AliasType**: \`${customTypeInfo.aliasType}\`\n\n`);

  if (customTypeInfo.rawValue && customTypeInfo.rawValue !== customTypeInfo.aliasType) {
    markdown.appendMarkdown(`**Raw**: \`${customTypeInfo.rawValue}\`\n\n`);
  }

  if (customTypeInfo.implementedBy) {
    markdown.appendMarkdown(`**implementedBy**: \`${customTypeInfo.implementedBy}\`\n\n`);
  }

  if (customTypeInfo.pythonFilePath) {
    markdown.appendMarkdown(`**Python**: \`${path.basename(customTypeInfo.pythonFilePath)}\`\n\n`);
  }

  if (customTypeInfo.properties.length > 0) {
    // KSEM-STRUCT-07:implementedBy 类型——Properties 键位属传输/存储形式
    // (引擎经 getDictFromObj 还原后使用),内存形式由实现类重定义(见绑定段),
    // 标题区分两表示,不把实现对象当 TypedDict。
    markdown.appendMarkdown(
      customTypeInfo.implementedBy
        ? '**Properties(传输/存储形式)**:\n'
        : '**Properties**:\n'
    );
    for (const property of customTypeInfo.properties) {
      markdown.appendMarkdown(`- \`${property.name}\`: \`${property.typeName || 'UNKNOWN'}\`\n`);
    }
    if (customTypeInfo.implementedBy) {
      markdown.appendMarkdown(
        '\n内存形式由实现类重定义,下标/访问面以实现类为准(字典键位不适用于内存形式)。\n'
      );
    }
  }

  // KSEM-STRUCT-06:绑定真形段(形态/落点/未知原因)在契约段之前——
  // 先说绑到哪,再说契约要求什么。
  if (bindingSection) {
    markdown.appendMarkdown(bindingSection);
  }

  // GEN-DEF-1e ②+口径①:user_type 带 impl 时补三契约方法状态与双向序列化契约
  if (contractSection) {
    markdown.appendMarkdown(contractSection);
  }

  if (shapeMarkdown) {
    markdown.appendMarkdown(shapeMarkdown);
  }

  return new vscode.Hover(markdown);
}

export function createDefinitionReferenceHover(
  name: string,
  summary: string,
  filePath: string,
  extraLines: string[] = []
): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${name}**\n\n`);
  markdown.appendMarkdown(`${summary}\n\n`);
  markdown.appendMarkdown(`**Definition**: \`${path.basename(filePath)}\`\n\n`);

  for (const line of extraLines) {
    markdown.appendMarkdown(`${line}\n\n`);
  }

  return new vscode.Hover(markdown);
}

export function getEntityRegistrationHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  if (!document.fileName.endsWith('entities.xml')) {
    return null;
  }

  const ast = parseDefAst(document);
  const root = ast?.root;
  if (!root) {
    return null;
  }

  const offset = document.offsetAt(position);
  const textNode = findTextNodeAtOffset(root, offset);
  const elementNode = textNode?.parent || findDeepestElementAtOffset(root, offset);
  if (!elementNode || elementNode.parent !== root || elementNode.name !== word) {
    return null;
  }

  const defPath = findEntityDefinitionFile(word, document);
  const extraLines = getEntityRuntimeHoverLines(document, word);
  const utypeLine = getEntityUtypeLine(document, word);
  if (utypeLine) {
    extraLines.unshift(utypeLine);
  }
  return createDefinitionReferenceHover(
    word,
    'Entity registration from `entities.xml`',
    defPath || `${word}.def`,
    extraLines
  );
}

// 清单序号行(source-analysis 设计 D3):引擎按 entities.xml 子节点顺序
// 分配 utype(entitydef.cpp:253-265、2382-2396),注册快照保持清单序,
// 首次出现位置即序号(同名重复引擎按首条合并,重复条目另有诊断提示)。
export function getEntityUtypeLine(
  document: vscode.TextDocument,
  entityName: string
): string | null {
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return null;
  }

  const entities = getRegisteredEntities(workspaceRoot);
  const index = entities.findIndex(entity => entity.name === entityName);
  if (index < 0) {
    return null;
  }

  return `**Utype**: \`${index + 1}\`(entities.xml 清单顺序,共 \`${entities.length}\` 个实体)`;
}

// def 链合并呈现(source-analysis 设计 D5 剩余段):def 文档内悬停根级
// <Parent> 元素(含其取值文本)时,呈现该 def 的继承闭包三面——Parent 链
// 递归 + interfaces/ 平铺 + components/ 挂接,与引擎归并口径一致
// (entitydef.cpp:890-924、551-639、642-771)。引擎 loadParentClass 未见
// 防环,buildDefChain 带 visited 截断并如实标注。
export function getDefChainHover(
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.Hover | null {
  const fileName = document.fileName.toLowerCase();
  if (document.languageId !== 'kbengine-def' && !fileName.endsWith('.def')) {
    return null;
  }

  const ast = parseDefAst(document);
  const root = ast?.root;
  if (!root) {
    return null;
  }

  const offset = document.offsetAt(position);
  const node = findTextNodeAtOffset(root, offset)?.parent
    || findDeepestElementAtOffset(root, offset);
  if (!node || node.parent !== root || node.name !== 'Parent') {
    return null;
  }

  const entityName = path.basename(document.fileName, '.def');
  const info = buildDefChain(document.fileName);
  const describe = (item: { name: string; defPath: string | null }): string =>
    `\`${item.name}\`${item.defPath ? '' : '(def 缺失)'}`;

  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${entityName} 的 def 链**(引擎归并口径)\n\n`);
  if (info.parentChain.length > 0) {
    const chainText = info.parentChain.map(describe).join(' → ');
    const cycleNote = info.cycleTruncated ? ';检测到环,已截断' : '';
    markdown.appendMarkdown(`- **Parent 链**: ${chainText}(共 ${info.parentChain.length} 层${cycleNote})\n\n`);
  }
  if (info.interfaces.length > 0) {
    const list = info.interfaces.map(describe).join('、');
    markdown.appendMarkdown(`- **Interfaces 平铺**: ${list}(接口 def 不跟随 Parent)\n\n`);
  }
  if (info.components.length > 0) {
    const list = info.components.map(describe).join('、');
    markdown.appendMarkdown(`- **Components 挂接**: ${list}\n\n`);
  }
  if (info.parentChain.length === 0 && info.interfaces.length === 0 && info.components.length === 0) {
    markdown.appendMarkdown('无 Parent、接口与组件声明。');
  }

  return new vscode.Hover(markdown);
}

export function getRegisteredEntityInfo(
  document: vscode.TextDocument,
  entityName: string
) {
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return null;
  }

  return getRegisteredEntities(workspaceRoot).find(entity => entity.name === entityName) || null;
}

export function getEntityRuntimeHoverLines(
  document: vscode.TextDocument,
  entityName: string
): string[] {
  const entityInfo = getRegisteredEntityInfo(document, entityName);
  const runtimeProfile = getEntityRuntimeProfile(entityName, document);
  if (!entityInfo) {
    return [];
  }

  const renderFacet = (
    label: 'Base' | 'Cell' | 'Client',
    facet: ReturnType<typeof getEntityRuntimeProfile> extends infer T
      ? T extends { base: infer F } ? F : never
      : never,
    declaredValue: boolean
  ): string => {
    const state = facet.enabled ? 'enabled' : 'disabled';
    if (facet.declared) {
      return `**${label}**: \`${declaredValue}\` (declared, ${state})`;
    }

    if (facet.scriptExists) {
      return `**${label}**: \`${facet.enabled}\` (inferred from script)`;
    }

    return `**${label}**: \`false\` (not declared, no script)`;
  };

  // 不可达(批62 定性):entityInfo 与 runtimeProfile 同源于同一 workspaceRoot 的
  // getRegisteredEntities 快照,上面 !entityInfo 已早退,此处 profile 必非 null。
  /* istanbul ignore start */
  if (!runtimeProfile) {
    return [
      `**Base**: \`${entityInfo.hasBase}\``,
      `**Cell**: \`${entityInfo.hasCell}\``,
      `**Client**: \`${entityInfo.hasClient}\``
    ];
  }
  /* istanbul ignore stop */

  const extraLines = [
    renderFacet('Base', runtimeProfile.base, entityInfo.hasBase),
    renderFacet('Cell', runtimeProfile.cell, entityInfo.hasCell),
    renderFacet('Client', runtimeProfile.client, entityInfo.hasClient),
    `**Runtime**: \`${runtimeProfile.runtimeRoles.join(' / ') || 'None'}\``,
    `**Visibility**: ${runtimeProfile.visibilitySummary}`,
    `**Registration**: ${runtimeProfile.registrationSummary}`
  ];

  if (!runtimeProfile.client.enabled) {
    extraLines.push('**Meaning**: client SDK will not create this entity type on the client side.');
  } else {
    extraLines.push('**Meaning**: client SDK may generate and instantiate this entity type on the client side.');
  }

  return extraLines;
}

// 根修令③:段标签悬停附带本工程的真实实现解析——命中给实际脚本路径,
// 未命中列全部期望位置,不给花括号模板。
export function describeImplementationForHover(
  document: vscode.TextDocument,
  sectionWord: string
): string | null {
  const sectionRoles: Partial<Record<string, Array<'base' | 'cell' | 'client'>>> = {
    Properties: ['base', 'cell', 'client'],
    BaseMethods: ['base'],
    CellMethods: ['cell'],
    ClientMethods: ['client']
  };
  const roles = sectionRoles[sectionWord];
  if (!roles) {
    return null;
  }

  const entityName = path.basename(document.fileName, '.def');
  for (const role of roles) {
    const scriptPath = findEntityScriptFile(entityName, role, document);
    if (scriptPath) {
      return `当前实现:${formatWorkspaceRelativePath(scriptPath, getWorkspaceRootForDocument(document))}`;
    }
  }
  return `未找到实体脚本,期望位置:${describeExpectedScriptPaths(document, entityName, roles).join('、')}`;
}

export function buildSymbolHoverInfo(
  section: KBEngineSectionName,
  symbolNode: DefElementNode
): SymbolHoverInfo {
  return {
    name: symbolNode.name,
    section,
    type: getScalarChildValue(symbolNode, 'Type'),
    flags: getScalarChildValue(symbolNode, 'Flags'),
    defaultValue: getScalarChildValue(symbolNode, 'Default'),
    detailLevel: getScalarChildValue(symbolNode, 'DetailLevel'),
    database: getScalarChildValue(symbolNode, 'DatabaseLength'),
    identifier: getScalarChildValue(symbolNode, 'Identifier'),
    // 引擎装载语义:Properties 字段文本恰为 "true"(忽略大小写)才持久,
    // 与 databaseSchema 的 isTruePersistent 同口径(loadDefPropertys)。
    persistent: getScalarChildValue(symbolNode, 'Persistent')?.trim().toLowerCase() === 'true',
    args: getScalarChildValues(symbolNode, 'Arg'),
    exposed: hasTruthyChildTag(symbolNode, 'Exposed')
  };
}
