// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as vscode from 'vscode';
import { DefDocument, DefElementNode, DefNode, findDeepestElementAtOffset, findTextNodeAtOffset, getDirectChildElements, parseDefDocument } from '../defParser';
import { getOrParseDocumentSync } from '../documentStore';
import { HOVER_ASYNC_BUDGET_MS_DEFAULT } from '../hoverBudget';
export function getLanguageFeatureConfig() {
  const config = vscode.workspace.getConfiguration('kbengine');
  return {
    enableDiagnostics: config.get<boolean>('enableDiagnostics', true),
    enableStructureDiagnostics: config.get<boolean>('enableStructureDiagnostics', true),
    diagnosticsCheckUnknownTypes: config.get<boolean>('diagnostics.checkUnknownTypes', true),
    diagnosticsCheckUnknownFlags: config.get<boolean>('diagnostics.checkUnknownFlags', true),
    diagnosticsCheckUnknownDetailLevels: config.get<boolean>('diagnostics.checkUnknownDetailLevels', true),
    diagnosticsCheckDuplicateDefinitions: config.get<boolean>('diagnostics.checkDuplicateDefinitions', true),
    diagnosticsCheckMissingPropertyFields: config.get<boolean>('diagnostics.checkMissingPropertyFields', true),
    // C-19:def↔Python 方法一致性规则。正向(def 有 Python 无)默认开;反向
    // (Python 有 def 无)默认关(防误报,跳过引擎钩子/dunder 后仍启发式)。
    checkDefMethodMissingInPython: config.get<boolean>('diagnostics.checkDefMethodMissingInPython', true),
    checkPythonMethodNotInDef: config.get<boolean>('diagnostics.checkPythonMethodNotInDef', false),
    // C-19 交付②:一键骨架体(IDE-NAV-014 空方法生成的体),pass=空体默认,
    // raise=抛 NotImplementedError。
    methodStubBody: config.get<'pass' | 'raise'>('entity.methodStubBody', 'pass'),
    hoverShowTagDocs: config.get<boolean>('hover.showTagDocs', true),
    hoverShowValueDocs: config.get<boolean>('hover.showValueDocs', true),
    hoverShowSymbolDocs: config.get<boolean>('hover.showSymbolDocs', true),
    // 批154(用户令「都需要配置开关,默认打开」「hover 也需要配置开关,需要把
    // 功能拆分」):悬停面按功能各一枚独立开关,不设总闸一刀切
    hoverTypeStorage: config.get<boolean>('hover.typeStorage', true),
    hoverImplementedBy: config.get<boolean>('hover.implementedBy', true),
    hoverEntityRegistration: config.get<boolean>('hover.entityRegistration', true),
    hoverDefChain: config.get<boolean>('hover.defChain', true),
    hoverEventStats: config.get<boolean>('hover.eventStats', true),
    // C-21:KBEngine Python API 文档 hover(KBEngine.<api>/生命周期回调/内建
    // 属性文档段),默认开
    hoverApiDocs: config.get<boolean>('hover.apiDocs', true),
    // C-23(交付③):KB-001 结构化行为注记段(FIXED_DICT 属性/易坑 API 的
    // 「现象+正确姿势+依据」双语段),默认开
    hoverBehaviorNotes: config.get<boolean>('hover.behaviorNotes', true),
    // CodeLens 同批按 provider 各一枚
    codeLensRpc: config.get<boolean>('codeLens.rpc', true),
    codeLensEventCallbacks: config.get<boolean>('codeLens.eventCallbacks', true),
    codeLensProperty: config.get<boolean>('codeLens.property', true),
    // IDE-PROP-001:属性先于 __init__ 装载提示镜,与属性访问镜同 provider 但
    // 独立开关(关访问镜不关装载语义提示)
    codeLensPropertyInitOrder: config.get<boolean>('codeLens.propertyInitOrder', true),
    codeLensTypesXml: config.get<boolean>('codeLens.typesXml', true),
    // 实体脚本新功能各一枚独立开关(用户令 2026-10-21:新功能都要配置开关,
    // 默认开)。builtinProperties 管内建属性 hover+self. 补全(内建属性相关
    // 面的总闸,行内 inlay 也先过它);receiverSections 管接收者段过滤
    // (false 回归不感知段的旧解析,形参/类型闸门不受影响);
    // python.builtinTypeInlayHints 管内建属性行内 `: <type>` inlay(总闸与
    // 本键双控,false 即不给提示;provider 每次现读,下一次渲染即生效)。
    entityBuiltinProperties: config.get<boolean>('entity.builtinProperties', true),
    entityReceiverSections: config.get<boolean>('entity.receiverSections', true),
    entityBuiltinTypeInlayHints: config.get<boolean>('python.builtinTypeInlayHints', true),
    // TYP-ARRAY(def 属性访问的类型推导与数组元素类型,hover 面):自属性类型
    // hover(容器注解 + for/下标元素类型推导)复用 entity.builtinProperties
    // 总闸(实体脚本 self.<属性> 类型 hover 的注册面开关,package.json 注册
    // 键;false 落回普通 hover 链)。行内元素 inlay 面另走 inlayHints.typeData。
    // 悬停异步链总预算(用户令 2026-10-22「hover 永转 loading」):>0 时 def
    // 方法/接收者/内建属性三条异步链各套总预算 race,超时返回空悬停并记
    // LogHub(层名+耗时);<=0 关闭预算闸(既有行为)。
    hoverAsyncBudgetMs: config.get<number>('hover.asyncBudgetMs', HOVER_ASYNC_BUDGET_MS_DEFAULT)
  };
}

export type KBEngineSectionName =
  | 'Parent'
  | 'Interfaces'
  | 'Components'
  | 'Properties'
  | 'BaseMethods'
  | 'CellMethods'
  | 'ClientMethods'
  | 'Volatile';

export const PROPERTY_SECTIONS = new Set<KBEngineSectionName>(['Properties']);

export const METHOD_SECTIONS = new Set<KBEngineSectionName>([
  'BaseMethods',
  'CellMethods',
  'ClientMethods'
]);

export const DEF_SYMBOL_SECTIONS = new Set<KBEngineSectionName>([
  'Properties',
  'BaseMethods',
  'CellMethods',
  'ClientMethods'
]);

export const ALLOWED_TOP_LEVEL_SECTIONS = new Set<KBEngineSectionName>([
  'Parent',
  'Interfaces',
  'Components',
  'Properties',
  'BaseMethods',
  'CellMethods',
  'ClientMethods',
  'Volatile'
]);

export const TAG_HOVER_DOCS: Record<string, { detail: string; documentation: string }> = {
  root: {
    detail: 'KBEngine 实体定义根节点',
    documentation: '`.def` 文件的根标签。源码会在该节点下读取 `Properties`、方法区块和 `DetailLevels` 等实体定义信息。'
  },
  Properties: {
    detail: '玩家属性',
    documentation: '实体属性区块。字段可通过 `Persistent` 开启自动存储,`Flags` 决定同步范围;字段名可跳转到实体脚本的类实现(悬停时下方给出本工程的真实解析路径)。'
  },
  BaseMethods: {
    detail: 'BaseApp 方法(可远程调用)',
    documentation: 'BaseApp 上的方法。带 `<Exposed>true</Exposed>` 时客户端可以直接请求该方法。方法名可跳转到 scripts/base/<实体>.py 的 `def` 实现。'
  },
  CellMethods: {
    detail: 'CellApp 方法(可远程调用)',
    documentation: 'CellApp 上的方法。带 `<Exposed>true</Exposed>` 时客户端可以直接请求该方法。方法名可跳转到 scripts/cell/<实体>.py 的 `def` 实现。'
  },
  ClientMethods: {
    detail: '客户端回调方法',
    documentation: '服务端回调客户端的方法:引擎把这里的声明下发给客户端实体脚本实现。方法名可跳转到 scripts/client/<实体>.py 或官方模板 scripts/bots/<实体>.py(BotsApp)的 `def` 实现。'
  },
  DetailLevels: {
    detail: '细节等级区块',
    documentation: '源码通过 `<DetailLevels>` 读取 `NEAR`、`MEDIUM`、`FAR` 三档同步细节配置，每档都要求同时提供 `<radius>` 和 `<hyst>`。'
  },
  Type: {
    detail: '类型声明标签',
    documentation: '用于声明属性类型、方法参数类型或容器内部元素类型，例如 `UINT32`、`VECTOR3`、`ARRAY<of>UINT8</of>`。'
  },
  Arg: {
    detail: '方法参数标签',
    documentation: '用于声明方法参数类型。只应出现在 `BaseMethods`、`CellMethods`、`ClientMethods` 的方法节点内。'
  },
  Flags: {
    detail: '属性同步/存储标志标签',
    documentation: '用于描述属性的存储位置和同步范围，例如 `BASE`、`CELL_PUBLIC`、`OWN_CLIENT`。'
  },
  Default: {
    detail: '默认值标签',
    documentation: '用于声明属性的默认值。字符串、数字和布尔值都可以在这里配置。'
  },
  Persistent: {
    detail: '持久化标签',
    documentation: '用于声明属性是否持久化到数据库。源码按 `true` 识别为启用。'
  },
  Identifier: {
    detail: '标识字段标签',
    documentation: '用于标记属性是否作为索引键。源码按 `true` 识别为启用。'
  },
  Index: {
    detail: '索引类型标签',
    documentation: '用于声明属性的索引类型，源码会读取并转为大写。'
  },
  DatabaseLength: {
    detail: '数据库长度标签',
    documentation: '用于声明属性在数据库中的长度限制，对应源码中的 `DatabaseLength`。'
  },
  DetailLevel: {
    detail: '细节级别标签',
    documentation: '用于定义属性同步细节等级，可选值为 `NEAR`、`MEDIUM`、`FAR`。'
  },
  of: {
    detail: '容器元素类型标签',
    documentation: '用于 `ARRAY` 的内部类型声明，引擎源码读取 `<of>` 子节点作为元素类型。'
  },
  radius: {
    detail: '细节等级半径标签',
    documentation: '用于 `DetailLevels` 的 `NEAR`、`MEDIUM`、`FAR` 节点内，源码会读取其数值作为该档位半径。'
  },
  hyst: {
    detail: '细节等级迟滞标签',
    documentation: '用于 `DetailLevels` 的 `NEAR`、`MEDIUM`、`FAR` 节点内，源码会读取其数值作为该档位迟滞。'
  },
  Utype: {
    detail: '显式 Utype 标签',
    documentation: '用于显式指定属性或方法的 Utype；未提供时由引擎自动分配。'
  },
  Exposed: {
    detail: '暴露方法标签',
    documentation: '用于 Base/Cell 方法，表示该方法允许远端调用。'
  },
  FIXED_DICT: {
    detail: '固定字典容器',
    documentation: 'KBEngine 容器类型之一。在当前引擎版本中仅支持于 `scripts/entity_defs/types.xml` 内以别名声明(需 `<Properties>` 子节点)，`.def` 属性通过别名引用；引擎不解析 `.def` 属性内联的 `FIXED_DICT`。'
  }
};

Object.assign(TAG_HOVER_DOCS, {
  Parent: {
    detail: '父类区块',
    documentation: '对应 KBEngine 的 `loadParentClass`，用于声明当前实体或组件继承的父定义。'
  },
  Interfaces: {
    detail: '接口区块',
    documentation: '对应 KBEngine 的 `loadInterfaces`，用于组合 `entity_defs/interfaces/*.def` 中的接口定义。'
  },
  Components: {
    detail: '组件区块',
    documentation: '对应 KBEngine 的 `loadComponents`，用于声明当前实体挂载的组件属性及其组件定义类型。'
  },
  Interface: {
    detail: '接口引用标签',
    documentation: '在 `<Interfaces>` 下使用，写成 `<interface>SomeInterface</interface>`（或 Interface/type/Type 拼写，引擎按四拼写精确比对装载），KBEngine 会到 `entity_defs/interfaces/SomeInterface.def` 加载定义；直接以接口名作标签（如 `<SomeInterface/>`）引擎会静默跳过。'
  },
  Volatile: {
    detail: '易变同步区块',
    documentation: '对应 KBEngine 的 `loadVolatileInfo`，用于配置 position、yaw、pitch、roll 等实时同步参数。'
  }
});

export function visitElementNodes(node: DefElementNode, visitor: (node: DefElementNode) => void): void {
  visitor(node);

  for (const child of getDirectChildElements(node)) {
    visitElementNodes(child, visitor);
  }
}

export function getNodeValue(node: DefElementNode): string {
  return documentTextSlice(node).trim();
}

export function documentTextSlice(node: DefElementNode): string {
  return node.children
    .filter((child): child is Exclude<DefNode, DefElementNode> => child.kind === 'text')
    .map(child => child.text)
    .join('');
}

export function pushDiagnosticForNodeValue(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  node: DefElementNode,
  value: string,
  message: string,
  severity: vscode.DiagnosticSeverity,
  code?: string | number
): void {
  const offset = document.getText().indexOf(value, node.contentStart);
  const range = offset >= 0 && offset <= node.contentEnd
    ? new vscode.Range(
        document.positionAt(offset),
        document.positionAt(offset + value.length)
      )
    : createNodeValueRange(document, node);

  const diagnostic = new vscode.Diagnostic(range, message, severity);
  if (code !== undefined) {
    diagnostic.code = code;
  }
  diagnosticsList.push(diagnostic);
}

export function createNodeRange(document: vscode.TextDocument, node: DefElementNode): vscode.Range {
  return new vscode.Range(
    document.positionAt(node.tagStart),
    document.positionAt(node.closeTagEnd)
  );
}

export function createNodeValueRange(document: vscode.TextDocument, node: DefElementNode): vscode.Range {
  return new vscode.Range(
    document.positionAt(node.contentStart),
    document.positionAt(node.contentEnd)
  );
}

export function getSectionLabel(section: KBEngineSectionName): string {
  if (section === 'Parent') {
    return '父类区块';
  }

  if (section === 'Interfaces') {
    return '接口区块';
  }

  if (section === 'Components') {
    return '组件区块';
  }

  if (section === 'Properties') {
    return '属性区块';
  }

  if (section === 'Volatile') {
    return '易变同步区块';
  }

  return '方法区块';
}

export type CustomTypeResolutionStatus =
  | 'resolved'
  | 'missingTypeRegistration'
  | 'missingPythonFile'
  | 'unverifiable';

export interface CustomTypeResolution {
  status: CustomTypeResolutionStatus;
}

export function parseDefAst(document: vscode.TextDocument): DefDocument | null {
  const fileName = document.fileName.toLowerCase();
  if (!(
    document.languageId === 'kbengine-def'
    || fileName.endsWith('.def')
    || fileName.endsWith('types.xml')
    || fileName.endsWith('entities.xml')
  )) {
    return null;
  }

  // PR2 快照接入:同版本只解析一次(documentStore 版本化缓存,命名空间
  // 'def-ast');诊断/hover/definition 等调用面共用同一份结果。无版本替身
  // (部分测试)不缓存,行为与此前逐次解析一致。
  try {
    return getOrParseDocumentSync(
      document,
      text => parseDefDocument(text),
      'def-ast'
    ).result;
  } catch {
    return null;
  }
}

export function toSectionName(name: string): KBEngineSectionName | null {
  switch (name) {
    case 'Parent':
    case 'Interfaces':
    case 'Components':
    case 'Properties':
    case 'BaseMethods':
    case 'CellMethods':
    case 'ClientMethods':
    case 'Volatile':
      return name;
    default:
      return null;
  }
}

export function getDefNodeAtPosition(document: vscode.TextDocument, position: vscode.Position): DefNode | null {
  const ast = parseDefAst(document);
  if (!ast?.root) {
    return null;
  }

  const offset = document.offsetAt(position);
  const textNode = findTextNodeAtOffset(ast.root, offset);
  if (textNode) {
    return textNode;
  }

  return findDeepestElementAtOffset(ast.root, offset);
}

export function getDefNodeAtWord(document: vscode.TextDocument, position: vscode.Position, word: string): DefNode | null {
  // 不可达(批62 定性):四个调用面(hover/definition/callHierarchy/方法实现)都先用
  // 同一条 /\w+/ 规则在同一个 document+position 上取词再原样传入,range 必存在且
  // text === word,两条回落臂在该调用面上无触发路径。
  const range = document.getWordRangeAtPosition(position, /\w+/);
  /* istanbul ignore start */
  if (!range) {
    return getDefNodeAtPosition(document, position);
  }
  /* istanbul ignore stop */

  const text = document.getText(range);
  /* istanbul ignore start */
  if (text !== word) {
    return getDefNodeAtPosition(document, position);
  }
  /* istanbul ignore stop */

  return getDefNodeAtPosition(document, range.start);
}

export function getSymbolNodeInfo(
  node: DefNode | null | undefined
): { section: KBEngineSectionName; symbolNode: DefElementNode } | null {
  if (!node) {
    return null;
  }

  let current: DefElementNode | null = node.kind === 'element' ? node : node.parent;

  while (current) {
    const sectionNode = current.parent;
    const sectionName = toSectionName(sectionNode?.name || '');
    if (sectionNode && sectionName && DEF_SYMBOL_SECTIONS.has(sectionName)) {
      return {
        section: sectionName,
        symbolNode: current
      };
    }
    current = current.parent;
  }

  return null;
}

export function isOffsetInsideNodeValue(node: DefElementNode, offset: number): boolean {
  return offset >= node.contentStart && offset <= node.contentEnd;
}

/** 元素全跨度:开标签头到闭标签尾;selfClosing(无闭标签)到开标签尾 */
export function elementFullRange(document: vscode.TextDocument, node: DefElementNode): vscode.Range {
  return new vscode.Range(
    document.positionAt(node.tagStart),
    document.positionAt(node.selfClosing ? node.tagEnd : node.closeTagEnd)
  );
}

/** 名字所在开标签跨度(selectionRange 恒 ⊆ range) */
export function elementTagRange(document: vscode.TextDocument, node: DefElementNode): vscode.Range {
  return new vscode.Range(
    document.positionAt(node.tagStart),
    document.positionAt(node.tagEnd)
  );
}
