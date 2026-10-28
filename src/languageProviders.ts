import * as path from 'path';
import * as vscode from 'vscode';
import { eventDefinitionAt, findEventCalls } from './eventApi';
export { EventCodeLensProvider } from './eventApi';
import { getScanRootForFile } from './scanRoots';
import {
  parsePythonFile,
  linearizeC3,
  isPythonCodePosition,
  getPythonBaseExpressionAtPosition,
  PythonClassIndex,
  PythonClassDef,
  PythonMethodLocation
} from './pythonClassIndex';
import {
  DefDocument,
  DefElementNode,
  DefNode,
  findAncestorElement,
  findDeepestElementAtOffset,
  findTextNodeAtOffset,
  getDirectChildElement,
  getDirectChildElements,
  getLineNumberAt,
  getScalarChildValue,
  getScalarChildValues,
  hasTruthyChildTag,
  parseDefDocument
} from './defParser';
import {
  EntityMappingManager,
  EntityMethodSection,
  type EntityMappingIndex
} from './entityMapping';
import { analyzeEntitiesXml } from './entitiesXmlAnalysis';
import { getDocumentLines, getOrParseDocumentSync } from './documentStore';
import { shadowCompareDefinition, shadowObserveDefDocument } from './kodeCoreShadowFaces';
import { buildDefChain } from './defChain';
import {
  METHOD_DECLARATION_PATTERN,
  buildRpcCodeLenses,
  defaultRpcCodeLensTitle,
  findPythonMethodDeclarations,
  RpcMethodHit
} from './rpcCodeLens';
import {
  buildPropertyCodeLenses,
  findPythonSelfPropertyAccesses,
  propertyAccessKey,
  PropertyCodeLensHit
} from './propertyCodeLens';
import {
  createDatabaseSchemaUri,
  describePropertyDatabaseStorage,
  findDatabaseSchemaFieldAtPosition,
  findDatabaseSchemaSourceLocation,
  findDatabaseSchemaTargetsForSource,
  getDatabaseSchemaSnapshot,
  getTypeStorageShape,
  getTypeStorageUsageIndexReadOnly,
  indexTypeStorageUsageEntries,
  invalidateTypeStorageUsageIndex,
  onTypeStorageUsageIndexPublished,
  isDatabaseSchemaDocument,
  locateDatabaseSchemaLine,
  replaceTypeStorageUsageForEntity
} from './databaseSchema';
import type { TypeStorageShape, TypeStorageUsage } from './databaseSchema';
import { buildPropertyDatabaseStorageHover } from './databaseSimulator';
import {
  findCustomTypeDeclarationInfo,
  findCustomTypeInfo,
  findCustomTypePythonImplementationFile,
  findImplementedBySymbolLine,
  findTypesXmlImplementedByReference,
  findDefinitionEntryByCategory,
  findDefinitionFileByCategory,
  findEntityDefsDirForDefFile,
  findComponentScriptFile,
  findEntityDefinitionFile,
  findEntitiesXmlFile,
  findEntityScriptFile,
  findInterfaceScriptFile,
  getDefinitionWorkspaceLayout,
  getEntityRuntimeProfile,
  getRegisteredCustomTypes,
  getRegisteredAliasTypes,
  getRegisteredEntities,
  getScriptsRootForDefFile,
  getWorkspaceRootForDocument,
  resolveEntityAnnotationType,
  scriptFoldersForRole,
  notifyEntitiesXmlMissingOnce,
  readWorkspaceTextFile,
  readWorkspaceTextLines
} from './definitionWorkspace';
import {
  computeDefRenameEdits,
  getLineCharacterAtOffset,
  parseDefFileSemantics,
  resolveRenameSymbolAtOffset
} from './defRenamer';
import { HOOK_CATEGORY_NAMES, KBENGINE_HOOKS, getHookByName } from './hooks';
import {
  DETAIL_LEVELS,
  KBENGINE_FLAGS,
  KBENGINE_RELOAD_FUNCTIONS,
  KBENGINE_TYPES
} from './kbengineMetadata';
import { jumpLog, jumpTimeStart, logNavigation } from './navigationLog';
import {
  formatEntityBuiltinPropertyDetail,
  formatEntityBuiltinPropertyHeadline,
  getEntityBuiltinPropertiesForFace,
  hasKnownEntityBuiltinPropertyType,
  resolveEntityBuiltinPropertyHit,
  resolveEntityComponentFaceFromPath,
  collectEntityBuiltinPropertyInlayTargets,
  type EntityComponentFace
} from './entityBuiltinProperties';
import { resolveLocalVariableReturnTypeFromSnapshot } from './pythonReturnTypeInference';
import {
  startLanguageServiceOperation
} from './languageServiceMetrics';
import { PYTHON_TYPE_STUB_FALLBACK } from './pythonTypeStubs';
import {
  findPythonReceiverCalls,
  getPythonReceiverCallAtPosition,
  PYTHON_RECEIVER_BY_SECTION,
  type PythonReceiverCall,
  getPythonSelfAccessAtPosition,
  getPythonSelfCompletionContext,
  getPythonMemberAccessAtPosition,
  type PythonMemberAccess,
  getPythonCallAtPosition,
  type PythonCallAtPosition
} from './pythonLanguageUtils';
import {
  buildKbeStubDocument,
  buildKbeStubUriString,
  filterKbeSymbols,
  getKbeAliases,
  getKbeCompletionContext,
  getKbeFromImportedSymbols,
  getKbeSymbol,
  getPythonClassBaseAtPosition,
  resolveKbeAccessAtPosition
} from './kbeModuleIndex';
import type { EngineApiCatalog } from './engineApiMetadata';
import {
  createHoverRequestDeadline,
  createWaiterUnionToken,
  HOVER_ASYNC_BUDGET_MS_DEFAULT,
  raceWithBudget,
  withInitialScanTimeout
} from './hoverBudget';

/**
 * 批159(用户令 2026-10-26「点击 codelens 跳 def 后 alt+← 后退,再点没反应」):
 * 镜链不再用内置 vscode.open —— 它对「已打开且已定位」的目标常跳过 reveal,
 * 退回原文件后再点就毫无反应。自建打开链:showTextDocument 带 selection 后,
 * 再对活动编辑器显式 revealRange(若命中),后退后再点也强制滚回。
 * 命令参数与旧 arguments 完全同形(uri, { selection }),测试/调用点零迁移成本。
 */
export const KBENGINE_SOURCE_REVEAL_COMMAND = 'kbengine.source.reveal';

export interface KbengineSourceRevealArgs {
  uri: vscode.Uri;
  options?: { selection?: vscode.Range };
}

export async function revealSourceCommand(
  uriArg?: vscode.Uri,
  options?: { selection?: vscode.Range }
): Promise<void> {
  if (!uriArg) {
    return;
  }
  const document = await vscode.workspace.openTextDocument(uriArg);
  const selection = options?.selection;
  const editor = await vscode.window.showTextDocument(document, selection ? { selection } : undefined);
  if (selection && editor && typeof (editor as vscode.TextEditor).revealRange === 'function') {
    // TextEditorRevealType 缺失(fake 环境/枚举未就绪)时退 0(Default),不炸
    const revealDefault =
      (vscode as unknown as { TextEditorRevealType?: { Default?: number } }).TextEditorRevealType?.Default ?? 0;
    (editor as vscode.TextEditor).revealRange(selection, revealDefault);
  }
}

/**
 * 批159(用户令「hover 还是需要 loading 很久」):同点位并发 hover 各自重跑
 * 整条异步解析链。按(文件+版本+行+列)做在途去重:第二个并发 hover 直接
 * 共享第一个的在途 Promise。只在途、不缓存落定结果 —— 暖路径加速由
 * manager 自身的 mtime/解析缓存承担(hoverBudget 契约:重复 hover 必须仍
 * 走 def 解析缓存、可数命中);若缓存完结结果,会在 TTL 窗口内冻结标注
 * 错过索引更新,且让缓存命中计数失明。文档编辑(版本变)天然失效;存
 * provider 实例上:生产单实例语义不变,测试逐用例新建 provider 天然隔离。
 */
const HOVER_MEMO_LIMIT = 256;

interface HoverMemoEntry {
  documentVersion: number;
  promise: Promise<vscode.Hover | null>;
  /** IDE-BUD-008:合并请求登记在册等待者(人人取消才取消共享计算) */
  addWaiter(waiterToken: vscode.CancellationToken | undefined): () => void;
}

function hoverMemoKey(document: vscode.TextDocument, position: vscode.Position): string {
  return `${document.fileName}#${document.version}#${position.line}#${position.character}`;
}

/** 开档预热(批159):开 Python 档即触发对应实体 .def 的定向首解析,首次
 * hover/CodeLens 不再吃冷启动等待。索引未就绪时后台补,失败静默(预热是
 * 优化不是功能,不准失败上浮)。 */
export function prewarmKbengineIndex(
  manager: EntityMappingManager,
  document: vscode.TextDocument
): void {
  if (document.languageId !== 'python') {
    return;
  }
  void manager.resolveMethodDefinition(document.fileName, '__prewarm__').catch(() => undefined);
}

function getLanguageFeatureConfig() {
  const config = vscode.workspace.getConfiguration('kbengine');
  return {
    enableDiagnostics: config.get<boolean>('enableDiagnostics', true),
    enableStructureDiagnostics: config.get<boolean>('enableStructureDiagnostics', true),
    diagnosticsCheckUnknownTypes: config.get<boolean>('diagnostics.checkUnknownTypes', true),
    diagnosticsCheckUnknownFlags: config.get<boolean>('diagnostics.checkUnknownFlags', true),
    diagnosticsCheckUnknownDetailLevels: config.get<boolean>('diagnostics.checkUnknownDetailLevels', true),
    diagnosticsCheckDuplicateDefinitions: config.get<boolean>('diagnostics.checkDuplicateDefinitions', true),
    diagnosticsCheckMissingPropertyFields: config.get<boolean>('diagnostics.checkMissingPropertyFields', true),
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
    // CodeLens 同批按 provider 各一枚
    codeLensRpc: config.get<boolean>('codeLens.rpc', true),
    codeLensEventCallbacks: config.get<boolean>('codeLens.eventCallbacks', true),
    codeLensProperty: config.get<boolean>('codeLens.property', true),
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
    // 悬停异步链总预算(用户令 2026-10-22「hover 永转 loading」):>0 时 def
    // 方法/接收者/内建属性三条异步链各套总预算 race,超时返回空悬停并记
    // LogHub(层名+耗时);<=0 关闭预算闸(既有行为)。
    hoverAsyncBudgetMs: config.get<number>('hover.asyncBudgetMs', HOVER_ASYNC_BUDGET_MS_DEFAULT)
  };
}

const TOP_LEVEL_DEF_TAGS = [
  'Parent',
  'Interfaces',
  'Components',
  'Properties',
  'BaseMethods',
  'CellMethods',
  'ClientMethods',
  'DetailLevels',
  'Volatile'
];

const PROPERTY_CHILD_TAGS = [
  'Type',
  'Flags',
  'Default',
  'Persistent',
  'Identifier',
  'Index',
  'DatabaseLength',
  'DetailLevel',
  'Utype'
];

const BASE_OR_CELL_METHOD_CHILD_TAGS = ['Arg', 'Utype', 'Exposed'];
const CLIENT_METHOD_CHILD_TAGS = ['Arg', 'Utype'];
const DETAIL_LEVEL_TAGS = ['NEAR', 'MEDIUM', 'FAR'];
const DETAIL_LEVEL_VALUE_TAGS = ['radius', 'hyst'];
const ENTITY_BASE_DATA_FLAGS = new Set(['BASE', 'BASE_AND_CLIENT']);
const ENTITY_CELL_DATA_FLAGS = new Set([
  'CELL_PUBLIC',
  'CELL_PRIVATE',
  'ALL_CLIENTS',
  'CELL_PUBLIC_AND_OWN',
  'OWN_CLIENT',
  'OTHER_CLIENTS'
]);
const ENTITY_CLIENT_DATA_FLAGS = new Set([
  'BASE_AND_CLIENT',
  'ALL_CLIENTS',
  'CELL_PUBLIC_AND_OWN',
  'OWN_CLIENT',
  'OTHER_CLIENTS'
]);
const PROPERTY_SCOPE_LABELS = {
  base: 'Base',
  cell: 'Cell',
  client: 'Client'
} as const;
type PropertyScope = keyof typeof PROPERTY_SCOPE_LABELS;

function createCompletionItems(
  labels: string[],
  kind: vscode.CompletionItemKind
): vscode.CompletionItem[] {
  return labels.map(label => new vscode.CompletionItem(label, kind));
}

/**
 * def 方法签名文本(审计遗留承诺 2026-10-21;用户令 2026-10-21 统一解析链):
 * def 声明了 <Arg> 的形参带类型注解(arg1: int 形态),类型走
 * resolveEntityAnnotationType 同一解析链——内建直查 → types.xml/alias.xml
 * 自定义类型逐层下钻;声明面 hover、接收者面 hover 与补全方法 detail 三处
 * 同源,一面都不得私走单表。def 未声明 <Arg> 的不硬造(只出 self);<Arg>
 * 在而类型文本空的只出名不造型。链断/未知(解析落 Any)按「能推才显」闸
 * 同规则无提示降级:只出名不带注解(不显 `: Any`)。声明形参名以 def 为
 * 准不可考,统一 argN 与存根生成器同口径。
 */
function formatDefMethodParameter(
  workspaceRoot: string | undefined,
  arg: string,
  index: number
): string {
  const trimmed = arg.trim();
  if (!trimmed) {
    // 有 <Arg> 无 <Type>:只出名不造型
    return `arg${index + 1}`;
  }
  const annotation = resolveEntityAnnotationType(workspaceRoot ?? '', trimmed);
  // 解析链断/未知(落 Any)→ 无提示降级,只出名(三提示面不显 Any)
  if (annotation === PYTHON_TYPE_STUB_FALLBACK) {
    return `arg${index + 1}`;
  }
  return `arg${index + 1}: ${annotation}`;
}

function formatDefMethodSignature(
  workspaceRoot: string | undefined,
  methodName: string,
  declaredArgs?: readonly string[]
): string {
  const parameters = (declaredArgs ?? []).map((arg, index) =>
    formatDefMethodParameter(workspaceRoot, arg, index)
  );
  return `def ${methodName}(self${parameters.length > 0 ? `, ${parameters.join(', ')}` : ''})`;
}

function getTextBeforePosition(
  document: vscode.TextDocument,
  position: vscode.Position
): string {
  const start = new vscode.Position(0, 0);
  return document.getText(new vscode.Range(start, position));
}

function getOpenTagStack(text: string): string[] {
  const stack: string[] = [];
  const tagRegex = /<\/?([A-Za-z][\w-]*)[^>]*\/?>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(text)) !== null) {
    const [tagText, tagName] = match;
    if (tagText.startsWith('</')) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i] === tagName) {
          stack.splice(i, 1);
          break;
        }
      }
      continue;
    }

    if (tagText.endsWith('/>')) {
      continue;
    }

    stack.push(tagName);
  }

  return stack;
}

function getDefTagCompletionLabels(
  document: vscode.TextDocument,
  position: vscode.Position
): string[] {
  const textBeforeCursor = getTextBeforePosition(document, position);
  const stack = getOpenTagStack(textBeforeCursor);
  const currentTag = stack[stack.length - 1];
  const parentTag = stack[stack.length - 2];
  const trimmedText = textBeforeCursor.trimEnd();

  if ((currentTag === 'Type' || currentTag === 'Arg') && /ARRAY\s*<$/i.test(trimmedText)) {
    // 引擎源码 FixedArrayType::initialize 强制要求 <of> 子节点声明元素类型
    return ['of'];
  }

  if (!currentTag || currentTag === 'root') {
    return TOP_LEVEL_DEF_TAGS;
  }

  if (currentTag === 'Properties') {
    return [];
  }

  if (currentTag === 'Interfaces') {
    return ['Interface', 'interface', 'Type', 'type'];
  }

  if (currentTag === 'Components' || currentTag === 'Parent') {
    return [];
  }

  if (currentTag === 'Volatile') {
    return ['position', 'yaw', 'pitch', 'roll', 'optimized'];
  }

  if (TOP_LEVEL_DEF_TAGS.includes(currentTag) && currentTag !== 'DetailLevels' && currentTag !== 'Interfaces') {
    return [];
  }

  if (currentTag === 'DetailLevels') {
    return DETAIL_LEVEL_TAGS;
  }

  if (DETAIL_LEVEL_TAGS.includes(currentTag) && parentTag === 'DetailLevels') {
    return DETAIL_LEVEL_VALUE_TAGS;
  }

  if (parentTag === 'Properties') {
    return PROPERTY_CHILD_TAGS;
  }

  if (parentTag === 'BaseMethods' || parentTag === 'CellMethods') {
    return BASE_OR_CELL_METHOD_CHILD_TAGS;
  }

  if (parentTag === 'ClientMethods') {
    return CLIENT_METHOD_CHILD_TAGS;
  }

  return [];
}

export class KBEngineCompletionProvider implements vscode.CompletionItemProvider {
  // 内建属性补全(用户令 2026-10-21 内建属性单 ③):self. 上下文需要 def
  // 归属面兜底,可选注入;缺省时仅目录域判面(既有无参用例口径不变)。
  constructor(private readonly entityMappingManager?: EntityMappingManager) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (token?.isCancellationRequested) return null;
    const line = document.lineAt(position.line);
    const lineText = line.text.substring(0, position.character);
    const items: vscode.CompletionItem[] = [];

    if (lineText.match(/<(Type|Arg|of)>\s*\w*$/)) {
      getKnownTypeSuggestions(document, token).forEach(type => {
        const item = new vscode.CompletionItem(type.name, vscode.CompletionItemKind.Class);
        item.detail = type.detail;
        item.documentation = new vscode.MarkdownString(type.documentation);
        items.push(item);
      });
      return token?.isCancellationRequested ? null : items;
    }

    if (lineText.match(/<Flags>\s*\w*$/)) {
      KBENGINE_FLAGS.forEach(flag => {
        const item = new vscode.CompletionItem(flag.name, vscode.CompletionItemKind.Enum);
        item.detail = flag.detail;
        item.documentation = new vscode.MarkdownString(flag.documentation);
        items.push(item);
      });
      return items;
    }

    if (lineText.match(/<DetailLevel>\s*\w*$/)) {
      DETAIL_LEVELS.forEach(level => {
        const item = new vscode.CompletionItem(level, vscode.CompletionItemKind.Constant);
        items.push(item);
      });
      return items;
    }

    if (lineText.endsWith('<')) {
      return createCompletionItems(
        getDefTagCompletionLabels(document, position),
        vscode.CompletionItemKind.Property
      );
    }

    const openTags = getOpenTagStack(getTextBeforePosition(document, position));
    const enclosingTag = openTags[openTags.length - 1];
    const inMethodsSection =
      enclosingTag === 'BaseMethods' || enclosingTag === 'CellMethods' || enclosingTag === 'ClientMethods';
    const methodPrefixMatch = lineText.match(/<([A-Za-z][A-Za-z0-9_]*)$/);

    if (inMethodsSection && methodPrefixMatch) {
      const methodName = methodPrefixMatch[1].toLowerCase();
      KBENGINE_HOOKS.forEach(hook => {
        if (hook.name.toLowerCase().startsWith(methodName)) {
          const item = new vscode.CompletionItem(hook.name, vscode.CompletionItemKind.Method);
          item.detail = `${HOOK_CATEGORY_NAMES[hook.category]} - ${hook.description}`;
          item.documentation = new vscode.MarkdownString(
            `**${hook.name}**\n\n${hook.documentation}\n\n调用时机: ${hook.timing}\n\n签名:\n\`\`\`python\n${hook.signature}\n\`\`\``
          );
          items.push(item);
        }
      });
      return items;
    }

    if (document.fileName.endsWith('.py') || document.fileName.endsWith('.def')) {
      // 内建属性补全(用户令 2026-10-21 内建属性单 ③):实体脚本内 self.<片段>
      // 上下文给所在面的属性项(单段,self.cell.X 等多段访问不接管);
      // 非实体脚本不接管(返回空,不遮蔽既有链)。
      // kbengine.entity.builtinProperties=false 时整体让位,回落原链路。
      if (document.fileName.endsWith('.py')) {
        const selfContext = getPythonSelfCompletionContext(lineText);
        if (
          getLanguageFeatureConfig().entityBuiltinProperties &&
          selfContext &&
          selfContext.parentPath === ''
        ) {
          return this.provideBuiltinPropertyCompletions(document);
        }
      }

      if (lineText.match(/KBEngine\.[a-zA-Z]*$/)) {
        KBENGINE_RELOAD_FUNCTIONS
          .filter(fn => fn.name.startsWith('KBEngine.'))
          .forEach(fn => {
            const shortName = fn.name.replace('KBEngine.', '');
            const item = new vscode.CompletionItem(shortName, vscode.CompletionItemKind.Function);
            item.detail = fn.detail;
            item.documentation = new vscode.MarkdownString(fn.documentation);
            items.push(item);
          });
        return items;
      }

      if (lineText.match(/importlib\.[a-zA-Z]*$/)) {
        const fn = KBENGINE_RELOAD_FUNCTIONS.find(f => f.name === 'importlib.reload');
        // 不可达(批64 定性):KBENGINE_RELOAD_FUNCTIONS 是模块级静态白名单,
        // 恒含 'importlib.reload'(src/kbengineMetadata.ts),故 fn 恒真。
        // 精确单行区间只摘除该 if 的分支条目,补全项构造保持被覆盖计入分母。
        /* istanbul ignore start */
        if (fn) {
        /* istanbul ignore stop */
          const item = new vscode.CompletionItem('reload', vscode.CompletionItemKind.Function);
          item.detail = fn.detail;
          item.documentation = new vscode.MarkdownString(fn.documentation);
          items.push(item);
        }
        return items;
      }
    }

    return items;
  }

  /**
   * self. 上下文的内建属性项(用户令 ③④):目录域判面先行;判不出且注入了
   * manager 时问 def 归属——唯一面给全量面属性,多面歧义或判为实体但无面
   * → 只给宏公共 3;非实体(manager 判 null 且无目录域)→ 空表不接管。
   */
  private provideBuiltinPropertyCompletions(
    document: vscode.TextDocument
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const pathFace = resolveEntityComponentFaceFromPath(document.fileName);
    if (pathFace) {
      return createBuiltinPropertyCompletionItems(pathFace);
    }
    const manager = this.entityMappingManager;
    if (!manager) {
      return [];
    }
    return manager
      .getEntityComponentFacesForPythonFile(document.fileName)
      .then(faces => {
        // null = 无 def 归属(非实体)→ 不接管;空数组/多面 → 只给宏公共 3
        if (faces === null) {
          return [];
        }
        return createBuiltinPropertyCompletionItems(faces.length === 1 ? faces[0] : null);
      })
      .catch(() => []);
  }
}

/** 面属性 → 补全项(label 右列灰字类型(Pylance 同款),detail 面与读写短句,documentation 带引擎注册面取证) */
function createBuiltinPropertyCompletionItems(
  face: EntityComponentFace | null
): vscode.CompletionItem[] {
  return getEntityBuiltinPropertiesForFace(face).map(property => {
    // label 用 CompletionItemLabel 形态:名称旁右列灰字类型(用户令 2026-10-21
    // 形态升级单 ②),detail 保留读写/面短句(单一 formatter,与 hover 同源);
    // Any 位按「能推才显」闸不显示类型(右列空,无 Any 降级)
    const item = new vscode.CompletionItem(
      { label: property.name, description: hasKnownEntityBuiltinPropertyType(property) ? property.type : undefined },
      vscode.CompletionItemKind.Property
    );
    item.detail = formatEntityBuiltinPropertyDetail(face, property);
    item.documentation = new vscode.MarkdownString(`引擎注册面: \`${property.source}\``);
    return item;
  });
}

/**
 * 内建属性行内类型提示(用户令 2026-10-21 形态升级单 ③):实体脚本内单段
 * `self.<内建属性>` 访问处在其 range 之后渲染 `: <type>` 右对齐提示
 * (kind=Type);面判定与命中集合和 hover 同一底座
 * (resolveEntityComponentFaceFromPath / getEntityComponentFacesForPythonFile /
 * resolveEntityBuiltinPropertyHit)。开关 kbengine.python.builtinTypeInlayHints
 * (默认开)且受总闸 kbengine.entity.builtinProperties 双控,false 即不给
 * 提示;provider 每次现读配置,下一次渲染即生效(inlay 无变更事件可 fire)。
 */
export class KBEngineBuiltinTypeInlayHintsProvider implements vscode.InlayHintsProvider {
  constructor(private readonly entityMappingManager?: EntityMappingManager) {}

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): Promise<vscode.InlayHint[]> {
    const featureConfig = getLanguageFeatureConfig();
    if (!featureConfig.entityBuiltinProperties || !featureConfig.entityBuiltinTypeInlayHints) {
      return [];
    }
    const pathFace = resolveEntityComponentFaceFromPath(document.fileName);
    let defFaces: readonly EntityComponentFace[] | null = null;
    if (!pathFace) {
      if (!this.entityMappingManager) {
        return [];
      }
      try {
        defFaces = await this.entityMappingManager.getEntityComponentFacesForPythonFile(
          document.fileName
        );
      } catch {
        defFaces = null;
      }
    }
    // PR2 快照接入:行数组走 documentStore(同版本复用,不再逐次全文拆行)
    const lines = getDocumentLines(document);
    return collectEntityBuiltinPropertyInlayTargets(lines, pathFace, defFaces)
      // inlay 按可视区要:视图口外的访问行不出 hint(批154 同口径);
      // Any 位(未知)按「能推才显」闸整个不出 hint(无提示降级)
      .filter(target => hasKnownEntityBuiltinPropertyType(target.property))
      .filter(target => target.line >= range.start.line && target.line <= range.end.line)
      .map(
        target =>
          new vscode.InlayHint(
            new vscode.Position(target.line, target.endCharacter),
            `: ${target.property.type}`,
            vscode.InlayHintKind.Type
          )
      );
  }
}

/** IDE-MET-003:hover 分支级计时面——start(label) 返回段结束 stop */
export interface HoverPhaseTimer {
  start(label: string): () => void;
}

export class KBEngineHoverProvider implements vscode.HoverProvider {
  // 实体 def 方法标注面(用户令:只凭名字标 KBEngine 函数不严谨)需要 def
  // 索引,按 RpcCodeLensProvider 同款注入;可选参数保持既有无参用例口径。
  constructor(private readonly entityMappingManager?: EntityMappingManager) {}

  // 批159:同点位在途 hover 去重(provider 实例级,生产单实例语义不变,
  // 测试逐用例新建 provider 天然隔离)。
  private readonly hoverMemo = new Map<string, HoverMemoEntry>();

  /**
   * 在途共享:同 key 同版本的并发 hover 复用同一 Promise;落定条目即刻出册。
   * IDE-BUD-008:共享计算的 token = 全部在册等待者的并集(人人取消才取消),
   * 单个等待者取消只影响自己的 respond,不斩断别人还在等的计算;等待者的
   * 注销函数在各自 respond 落定时调用。
   */
  private memoizedHover(
    key: string,
    documentVersion: number,
    run: (sharedToken: vscode.CancellationToken) => Promise<vscode.Hover | null>,
    waiterToken?: vscode.CancellationToken
  ): Promise<vscode.Hover | null> {
    const inflight = this.hoverMemo.get(key);
    if (inflight && inflight.documentVersion === documentVersion) {
      inflight.addWaiter(waiterToken); // 注销随共享 promise 落定统一清理
      return inflight.promise;
    }
    const union = createWaiterUnionToken();
    const unregister = union.addWaiter(waiterToken);
    const promise = run(union.token);
    const entry: HoverMemoEntry = {
      documentVersion,
      promise,
      addWaiter: nextToken => union.addWaiter(nextToken)
    };
    this.hoverMemo.set(key, entry);
    if (this.hoverMemo.size > HOVER_MEMO_LIMIT) {
      const oldest = this.hoverMemo.keys().next().value;
      if (oldest !== undefined) {
        this.hoverMemo.delete(oldest);
      }
    }
    // 落定即出册(成败同):完结结果不复用,后续 hover 重走 manager 暖缓存
    const drop = () => {
      const memoEntry = this.hoverMemo.get(key);
      if (memoEntry && memoEntry.promise === promise) {
        this.hoverMemo.delete(key);
      }
      unregister();
      union.dispose();
    };
    promise.then(drop, drop);
    return promise;
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    return this.provideHoverTimed(document, position, token);
  }

  /**
   * IDE-MET-003:hover 分支级耗时记录——timer 由适配层注入(per-request
   * operation.startSubPhase),并发请求各自归因;不传计时面零开销,行为与
   * provideHover 完全一致。分支标签四类:annotation-query(注解查询)、
   * def-mapping(def 映射/def 归属)、schema(签名/形参闸/属性表)、render;
   * 总耗时由 operation.elapsedMs 承担。
   */
  provideHoverTimed(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
    timer?: HoverPhaseTimer
  ): vscode.ProviderResult<vscode.Hover> {
    if (token?.isCancellationRequested) { return null; }
    const featureConfig = getLanguageFeatureConfig();
    // IDE-BUD-001:一次请求一个截止时间上下文——绝对 deadline + 链接 token
    // 全分支共享:各层 raceWithBudget 用 remainingMs() 而非各起满额预算窗;
    // 父取消或预算到期即取消链接 token,异步层与取消闸同刻观测。
    const deadline = createHoverRequestDeadline(token, featureConfig.hoverAsyncBudgetMs);
    const respond = (work: Promise<vscode.Hover | null>): Promise<vscode.Hover | null> =>
      raceWithBudget('hover:cancel', work, 0, deadline.token)
        .finally(() => deadline.dispose());
    const range = document.getWordRangeAtPosition(position, /\w+/);
    if (!range) {
      deadline.dispose();
      return null;
    }

    const word = document.getText(range);

    // 实体 def 方法声明标注(用户令:Python 实现里看不出哪些函数是 def 声明
    // 的方法):光标落在 python def 声明行方法名上时,先问 def 索引是否命中;
    // 命中后过与 RPC CodeLens/全项目回退同一把形参闸门(def 声明了 <Arg> 时
    // 个数/注解类型必须对上),不符不给该标注。未命中或未注入 manager 时落
    // 回普通 hover 链,既有同步行为不变(未注入即不进异步面)。
    const manager = this.entityMappingManager;
    if (manager && document.languageId === 'python') {
      // 批159:同点位并发 hover 在途去重(共享同一 Promise);命中任一异步面
      // 才进 memo,未命中落回下方同步链(局部变量返回类型推导等),与批159
      // 前贯穿语义一致。
      const memoKey = hoverMemoKey(document, position);
      const methodName = getPythonMethodDeclarationAtPosition(
        document.lineAt(position.line).text,
        position.character
      );
      if (methodName) {
        // 异步链总预算闸(用户令 2026-10-22):底层索引慢(首扫秒级+)时不再
        // 永转 loading,超预算返回空悬停并记 LogHub(层名+耗时)。
        // IDE-BUD-001:预算 = 共享 deadline 的剩余量,不再各起满额窗。
        return respond(this.memoizedHover(memoKey, document.version, sharedToken =>
          raceWithBudget(
            'hover:def-method',
            this.resolveDefMethodAnnotation(manager, document, position.line, methodName, sharedToken, timer)
              .then(annotation => {
                if (annotation) { return annotation; }
                const stop = timer?.start('annotation-query');
                try {
                  return this.provideKnownHover(document, position, featureConfig, range, word);
                } finally { stop?.(); }
              }),
            deadline.remainingMs(),
            sharedToken
          )
        , deadline.token));
      }
      // 接收者感知(用户令 2026-10-21):光标落在 self.cell./self.base./self.client.
      // 的方法名上时,先按段闸解析(仅对应区块的 def 候选通过,段不符不给标注,
      // 落回普通 hover 链);段过滤先行于形参闸(命中后沿用同一把签名对账)。
      // kbengine.entity.receiverSections=false 时回归不感知段的旧解析
      // (直接落 provideKnownHover),形参/类型闸门不受此开关影响。
      const receiverCall = featureConfig.entityReceiverSections
        ? getPythonReceiverCallAtPosition(
            document.lineAt(position.line).text,
            position.character
          )
        : null;
      if (receiverCall) {
        return respond(this.memoizedHover(memoKey, document.version, sharedToken =>
          raceWithBudget(
            'hover:receiver-call',
            this.resolveReceiverCallAnnotation(manager, document, position.line, receiverCall, sharedToken, timer)
              .then(annotation => {
                if (annotation) { return annotation; }
                const stop = timer?.start('annotation-query');
                try {
                  return this.provideKnownHover(document, position, featureConfig, range, word);
                } finally { stop?.(); }
              }),
            deadline.remainingMs(),
            sharedToken
          )
        , deadline.token));
      }
      // 内建属性(用户令 2026-10-21 内建属性单 ②):self.<属性> 单段访问
      // (fullPath 无第二段,不与 self.cell.X 接收者调用重叠)命中分面表
      // → 内建属性标注;未命中/非实体脚本落回普通 hover 链。
      // kbengine.entity.builtinProperties=false 时整体让位,不进异步面。
      const selfAccess = getPythonSelfAccessAtPosition(
        document.lineAt(position.line).text,
        position.character
      );
      if (
        featureConfig.entityBuiltinProperties &&
        selfAccess &&
        !selfAccess.fullPath.includes('.')
      ) {
        return respond(this.memoizedHover(memoKey, document.version, sharedToken =>
          raceWithBudget(
            'hover:builtin-property',
            this.resolveBuiltinPropertyAnnotation(manager, document, selfAccess.currentSymbol, sharedToken, timer)
              .then(annotation => {
                if (annotation) { return annotation; }
                const stop = timer?.start('annotation-query');
                try {
                  return this.provideKnownHover(document, position, featureConfig, range, word);
                } finally { stop?.(); }
              }),
            deadline.remainingMs(),
            sharedToken
          )
        , deadline.token));
      }
      // 三个异步面都未命中:落回下方同步链(批159 前语义,不进 memo)
      // IDE-BUD-001:同步段不可抢占——只在段口协作检查 deadline(父已取消/
      // 预算已耗尽就不进同步链),不得宣称同步路径因此可被抢占。
      if (deadline.token.isCancellationRequested || deadline.isExpired()) {
        deadline.dispose();
        return null;
      }
    }

    // 局部变量返回类型推导(用户令 2026-10-21:「data = activity_data.get_data()
    // → data: JSONDATA」):光标落在变量名上时,按右侧单层调用的被调函数返回
    // 注解推导(python `def get_data(...) -> X:` 注解先行;.def 方法无返回声明
    // 语法故该层结构性缺位)。解出才提示并标注来源;解不出不显示任何类型
    // (不显 Any、不显空类型,落回普通 hover 链)。
    if (document.languageId === 'python' && vscode.workspace.getConfiguration('kbengine').get<boolean>('hover.returnTypeInference', true)) {
      // PR2 快照接入:局部变量推导复用快照行数据(同版本不重拆);
      // IDE-HOV-011:按文档版本喂当前文件注解桶(未保存变化立即生效)
      // IDE-MET-003:推导整段属注解查询面(annotation-query)
      const stopInfer = timer?.start('annotation-query');
      let inferred: ReturnType<typeof resolveLocalVariableReturnTypeFromSnapshot>;
      try {
        inferred = resolveLocalVariableReturnTypeFromSnapshot(
          getDocumentLines(document),
          position.line,
          word,
          getWorkspaceRootForDocument(document),
          {
            fileKey: document.uri.toString(),
            version: document.version,
            source: () => document.getText()
          }
        );
      } finally { stopInfer?.(); }
      if (inferred) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${inferred.target}: ${inferred.annotation}**\n\n`);
        markdown.appendMarkdown(`推导自 ${inferred.methodName}() 返回注解`);
        deadline.dispose();
        return new vscode.Hover(markdown);
      }
    }

    const stopKnown = timer?.start('annotation-query');
    let known: vscode.Hover | null;
    try {
      known = this.provideKnownHover(document, position, featureConfig, range, word);
    } finally { stopKnown?.(); }
    deadline.dispose();
    return known;
  }

  /**
   * 「此函数是实体 def 声明的 X 方法」标注(形参闸门同源):resolveMethodDefinition
   * 命中才标;def 声明了 <Arg> 时本行签名须过 pythonSignatureMatchesDeclaredArgs,
   * 不符返回 null(调用方落回普通 hover)。
   */
  private async resolveDefMethodAnnotation(
    manager: EntityMappingManager,
    document: vscode.TextDocument,
    line: number,
    methodName: string,
    token?: vscode.CancellationToken,
    timer?: HoverPhaseTimer
  ): Promise<vscode.Hover | null> {
    // IDE-MET-003 分段:def-mapping(def 索引映射)→ schema(形参闸+签名)→
    // render(markdown 构造);timer 缺省零开销。
    let location: Awaited<ReturnType<EntityMappingManager['resolveMethodDefinition']>>;
    const stopMapping = timer?.start('def-mapping');
    try {
      location = await manager.resolveMethodDefinition(document.fileName, methodName, undefined, token);
    } catch {
      return null;
    } finally { stopMapping?.(); }
    if (!location) {
      return null;
    }
    const declaredArgTypes =
      location.declaredArgs && location.declaredArgs.length > 0 ? location.declaredArgs : undefined;
    // 形参闸与签名同链(用户令 2026-10-21):注解按统一解析链对账,types.xml
    // 自定义类型断到内建(如 TIMESTAMP→int),与 formatter 输出同源。
    const workspaceRoot = getWorkspaceRootForDocument(document);
    const resolveAnnotation = (raw: string): string =>
      resolveEntityAnnotationType(workspaceRoot ?? '', raw);
    const stopSchema = timer?.start('schema');
    let signatureMatched = true;
    let signature: string;
    try {
      if (
        declaredArgTypes &&
        !EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
          declaredArgTypes,
          [...getDocumentLines(document)],
          line,
          resolveAnnotation
        )
      ) {
        signatureMatched = false;
      }
      signature = formatDefMethodSignature(workspaceRoot ?? undefined, methodName, location.declaredArgs);
    } finally { stopSchema?.(); }
    if (!signatureMatched) {
      return null;
    }
    const stopRender = timer?.start('render');
    let hover: vscode.Hover;
    try {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(
        `**${methodName}** — 此函数是实体 def 声明的 ${location.section} 方法\n\n`
      );
      markdown.appendMarkdown(`签名: \`${signature}\`\n\n`);
      markdown.appendMarkdown(`声明: \`${path.basename(location.defFile)}:${location.line}\``);
      if (location.exposed) {
        markdown.appendMarkdown('\n\n**Exposed**: 该方法可被客户端远程调用。');
      }
      hover = new vscode.Hover(markdown);
    } finally { stopRender?.(); }
    return hover;
  }

  /**
   * 接收者调用标注(用户令 2026-10-21):self.cell./self.base./self.client. 调用
   * 的方法名上,按段闸解析(resolveMethodDefinition 第三参,段不符即 null);
   * 命中后与声明面共用形参闸(def 声明了 <Arg> 时对账,不符不标注)。
   */
  private async resolveReceiverCallAnnotation(
    manager: EntityMappingManager,
    document: vscode.TextDocument,
    line: number,
    receiverCall: PythonReceiverCall,
    token?: vscode.CancellationToken,
    timer?: HoverPhaseTimer
  ): Promise<vscode.Hover | null> {
    // IDE-MET-003 分段:与声明面同构 def-mapping → schema → render。
    let location: Awaited<ReturnType<EntityMappingManager['resolveMethodDefinition']>>;
    const stopMapping = timer?.start('def-mapping');
    try {
      location = await manager.resolveMethodDefinition(
        document.fileName,
        receiverCall.methodName,
        receiverCall.section,
        token
      );
    } catch {
      return null;
    } finally { stopMapping?.(); }
    if (!location) {
      return null;
    }
    const declaredArgTypes =
      location.declaredArgs && location.declaredArgs.length > 0 ? location.declaredArgs : undefined;
    // 形参闸与签名同链(用户令 2026-10-21):与声明面共用 resolveEntityAnnotationType
    const workspaceRoot = getWorkspaceRootForDocument(document);
    const resolveAnnotation = (raw: string): string =>
      resolveEntityAnnotationType(workspaceRoot ?? '', raw);
    const stopSchema = timer?.start('schema');
    let signatureMatched = true;
    let signature: string;
    try {
      if (
        declaredArgTypes &&
        !EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
          declaredArgTypes,
          [...getDocumentLines(document)],
          line,
          resolveAnnotation
        )
      ) {
        signatureMatched = false;
      }
      signature = formatDefMethodSignature(
        workspaceRoot ?? undefined,
        receiverCall.methodName,
        location.declaredArgs
      );
    } finally { stopSchema?.(); }
    if (!signatureMatched) {
      return null;
    }
    const stopRender = timer?.start('render');
    let hover: vscode.Hover;
    try {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(
        `**${receiverCall.methodName}** — 此调用是实体 def 声明的 ${location.section} 方法` +
          `(接收者 self.${receiverCall.receiver})\n\n`
      );
      markdown.appendMarkdown(`签名: \`${signature}\`\n\n`);
      markdown.appendMarkdown(`声明: \`${path.basename(location.defFile)}:${location.line}\``);
      if (location.exposed) {
        markdown.appendMarkdown('\n\n**Exposed**: 该方法可被客户端远程调用。');
      }
      hover = new vscode.Hover(markdown);
    } finally { stopRender?.(); }
    return hover;
  }

  /**
   * 内建属性标注(用户令 2026-10-21 内建属性单 ②④):self.<属性> 单段访问
   * 命中分面属性表 → 「KBEngine 内建属性（<组件>面）·只读/可写 · 类型」。
   * 组件面判定:目录域(与 collectAllPythonMethodHits 的 base/cell/client
   * 目录闸同源)先行,判不出再问 def 归属(owner 文件段位);都判不出 =
   * 非实体脚本 → 不接管;判为实体但 def 面歧义 → 只查宏公共 3。
   * 面内未命中 → null(不遮蔽 def 属性/普通符号,落回普通 hover 链)。
   */
  private async resolveBuiltinPropertyAnnotation(
    manager: EntityMappingManager,
    document: vscode.TextDocument,
    attributeName: string,
    token?: vscode.CancellationToken,
    timer?: HoverPhaseTimer
  ): Promise<vscode.Hover | null> {
    // IDE-MET-003 分段:def-mapping(面归属判定+属性命中)→ render;此面无
    // schema 段(不读 def 声明签名)。
    const stopMapping = timer?.start('def-mapping');
    const pathFace = resolveEntityComponentFaceFromPath(document.fileName);
    let defFaces: readonly EntityComponentFace[] | null = null;
    if (!pathFace) {
      try {
        defFaces = await manager.getEntityComponentFacesForPythonFile(document.fileName, token);
      } catch {
        defFaces = null;
      }
    }
    let hit: ReturnType<typeof resolveEntityBuiltinPropertyHit>;
    try {
      hit = resolveEntityBuiltinPropertyHit(attributeName, pathFace, defFaces);
    } finally { stopMapping?.(); }
    if (!hit) {
      return null;
    }
    const stopRender = timer?.start('render');
    let hover: vscode.Hover;
    try {
      const markdown = new vscode.MarkdownString();
      // 首行紧凑形态(用户令 2026-10-21 形态升级单 ①):类型紧跟属性名冒号后
      // (**self.databaseID: int** — baseapp面 · 只读),详情段走单一 formatter
      markdown.appendMarkdown(
        `${formatEntityBuiltinPropertyHeadline(hit.property.name, hit.face, hit.property)}\n\n`
      );
      markdown.appendMarkdown(`引擎注册面: \`${hit.property.source}\``);
      hover = new vscode.Hover(markdown);
    } finally { stopRender?.(); }
    return hover;
  }

  private provideKnownHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    featureConfig: ReturnType<typeof getLanguageFeatureConfig>,
    range: vscode.Range,
    word: string
  ): vscode.Hover | null {
    if (document.languageId === 'python' && featureConfig.hoverEventStats) {
      const calls = findEventCalls(document.getText());
      const current = calls.find(call => position && document.offsetAt(position) >= call.eventOffset && document.offsetAt(position) <= call.eventOffset + call.event.length);
      if (current) {
        const registrations = calls.filter(call => (call.api === 'addEvent' || call.api === 'registerEvent') && call.event === current.event).length;
        const emits = calls.filter(call => call.api === 'emitEvent' && call.event === current.event).length;
        return new vscode.Hover(`**${current.event}**\n\n当前文件统计：${registrations} 处注册 · ${emits} 处触发`);
      }
    }
    if (featureConfig.hoverTypeStorage) {
      const typeValueHover = getTypeValueHover(document, position, word);
      if (typeValueHover) {
        return typeValueHover;
      }

      const customTypeHover = getCustomTypeHover(document, position, word);
      if (customTypeHover) {
        return customTypeHover;
      }
    }

    if (featureConfig.hoverImplementedBy) {
      const implementedByReverseHover = getImplementedByReverseHover(document, position, word);
      if (implementedByReverseHover) {
        return implementedByReverseHover;
      }
    }

    if (featureConfig.hoverEntityRegistration) {
      const entityRegistrationHover = getEntityRegistrationHover(document, position, word);
      if (entityRegistrationHover) {
        return entityRegistrationHover;
      }
    }

    if (featureConfig.hoverDefChain) {
      const defChainHover = getDefChainHover(document, position);
      if (defChainHover) {
        return defChainHover;
      }
    }

    if (featureConfig.hoverShowValueDocs) {
      const earlyHook = getHookByName(word);
      if (earlyHook) {
        return createHookHover(earlyHook);
      }
    }

    if (featureConfig.hoverShowSymbolDocs) {
      const knownHook = getHookByName(word);
      if (!knownHook) {
        const symbolHover = getSymbolHover(document, position, word);
        if (symbolHover) {
          return symbolHover;
        }
      }
    }

    if (featureConfig.hoverShowTagDocs) {
      const tagDoc = TAG_HOVER_DOCS[word];
      if (tagDoc) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${word}**\n\n`);
        markdown.appendMarkdown(`${tagDoc.detail}\n\n`);
        markdown.appendMarkdown(tagDoc.documentation);
        // 根修令③:实现位置给真实解析路径,不给花括号模板。
        const implementationNote = describeImplementationForHover(document, word);
        if (implementationNote) {
          markdown.appendMarkdown(`\n\n${implementationNote}`);
        }
        return new vscode.Hover(markdown);
      }
    }

    if (featureConfig.hoverShowValueDocs) {
      const type = KBENGINE_TYPES.find(t => t.name === word);
      if (type) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${type.name}**\n\n`);
        markdown.appendMarkdown(`${type.detail}\n\n`);
        markdown.appendMarkdown('**说明**:\n');
        markdown.appendMarkdown(type.documentation);
        return new vscode.Hover(markdown);
      }

      if (DETAIL_LEVELS.includes(word)) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${word}**\n\n`);
        markdown.appendMarkdown('KBEngine 属性细节级别。\n\n');
        markdown.appendMarkdown('可用于 `<DetailLevel>` 标签，表示属性同步的重要程度。');
        return new vscode.Hover(markdown);
      }

      const flag = KBENGINE_FLAGS.find(f => f.name === word);
      if (flag) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${flag.name}**\n\n`);
        markdown.appendMarkdown(`${flag.detail}\n\n`);
        markdown.appendMarkdown('**说明**:\n');
        markdown.appendMarkdown(flag.documentation);
        return new vscode.Hover(markdown);
      }

      // 不可达(批62 定性):同一个 hoverShowValueDocs 开关下,前面的 earlyHook
      // 命中即已返回,走到这里时 getHookByName(word) 必为假。
      const hook = getHookByName(word);
      /* istanbul ignore start */
      if (hook) {
        return createHookHover(hook);
      }
      /* istanbul ignore stop */

      const reloadFunc = KBENGINE_RELOAD_FUNCTIONS.find(f => f.name.endsWith(word) || word === f.name);
      if (reloadFunc) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${reloadFunc.name}**\n\n`);
        markdown.appendMarkdown(`${reloadFunc.detail}\n\n`);
        markdown.appendMarkdown(reloadFunc.documentation);
        return new vscode.Hover(markdown);
      }
    }

    return null;
  }
}

/**
 * 签名帮助(批159):光标落在 self.base/cell/client.X(...) 或对象 avatar.X(...)
 * 的方法名/实参表内时,按与 hover 同一条解析链(resolveMethodDefinition + 形参
 * 闸)出 def 签名;活动形参按调用点顶层逗号序号标亮(括号/逗号触发)。解析
 * 走预算闸(复用 hoverAsyncBudgetMs),超时不阻塞输入;形参名 argN 与存根
 * 生成器同口径,类型注解与声明面 hover 同源(formatDefMethodParameter)。
 */
export class KBEngineSignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(private readonly entityMappingManager?: EntityMappingManager) {}

  async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): Promise<vscode.SignatureHelp | null> {
    if (document.languageId !== 'python' || !this.entityMappingManager) {
      return null;
    }
    const call = getPythonCallAtPosition(
      document.lineAt(position.line).text,
      position.character
    );
    if (!call) {
      return null;
    }
    const featureConfig = getLanguageFeatureConfig();
    const version = document.version;
    const result = await raceWithBudget(
      'signatureHelp:def-method',
      this.resolveSignatureHelp(this.entityMappingManager, document, call),
      featureConfig.hoverAsyncBudgetMs,
      token
    );
    return document.version === version ? result : null;
  }

  private async resolveSignatureHelp(
    manager: EntityMappingManager,
    document: vscode.TextDocument,
    call: PythonCallAtPosition
  ): Promise<vscode.SignatureHelp | null> {
    let location: Awaited<ReturnType<EntityMappingManager['resolveMethodDefinition']>>;
    try {
      location = await manager.resolveMethodDefinition(
        document.fileName,
        call.methodName,
        call.section
      );
    } catch {
      return null;
    }
    if (!location) {
      return null;
    }
    // 形参闸不适用调用行(仓内 CodeLens 调用行先例):闸门对账的是 def 声明行
    // 签名;签名帮助恰是「调用写错时照着修」的提示面,闸掉本末倒置。
    const workspaceRoot = getWorkspaceRootForDocument(document);
    const parameterLabels = (location.declaredArgs ?? []).map((arg, index) =>
      formatDefMethodParameter(workspaceRoot ?? undefined, arg, index)
    );
    const signature = new vscode.SignatureInformation(
      formatDefMethodSignature(workspaceRoot ?? undefined, call.methodName, location.declaredArgs)
    );
    signature.parameters = parameterLabels.map(
      parameterLabel => new vscode.ParameterInformation(parameterLabel)
    );
    const documentation = new vscode.MarkdownString();
    documentation.appendMarkdown(`此调用是实体 def 声明的 ${location.section} 方法`);
    if (call.section) {
      documentation.appendMarkdown(`(接收者 self.${call.section})`);
    }
    if (location.exposed) {
      documentation.appendMarkdown(' · **Exposed**: 可被客户端远程调用');
    }
    signature.documentation = documentation;
    const help = new vscode.SignatureHelp();
    help.signatures = [signature];
    help.activeSignature = 0;
    help.activeParameter =
      parameterLabels.length > 0
        ? Math.min(call.activeArgument, parameterLabels.length - 1)
        : 0;
    return help;
  }
}

interface SymbolHoverInfo {
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

export class KBEngineDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private entityMappingManager?: EntityMappingManager) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Location> {
    const location = this.provideDefinitionImpl(document, position);
    // Phase2 首片:shadow 双轨对拍(定义面)。fire-and-forget,不改返回值。
    shadowCompareDefinition(document, position, location);
    return location;
  }

  private provideDefinitionImpl(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Location> {
    if (isDatabaseSchemaDocument(document)) {
      return findDatabaseSchemaDefinition(document, position);
    }

    const range = document.getWordRangeAtPosition(position, /\w+/);
    if (!range) {
      return null;
    }

    const word = document.getText(range);

    if (document.fileName.endsWith('entities.xml')) {
      const defPath = findEntityDefinitionFile(word, document);
      if (defPath) {
        return new vscode.Location(vscode.Uri.file(defPath), new vscode.Position(0, 0));
      }
    }

    if (document.fileName.endsWith('types.xml')) {
      const customTypeLocation = findCustomTypeDefinition(document, position, word);
      if (customTypeLocation) {
        return customTypeLocation;
      }

      const typeValueLocation = findTypeValueDefinitionInTypesXml(document, position, word);
      if (typeValueLocation) {
        return typeValueLocation;
      }
    }

    if (document.languageId === 'kbengine-def' || document.fileName.toLowerCase().endsWith('.def')) {
      const location = findEntityDefinitionInDef(document, position, word, this.entityMappingManager);
      if (!location && looksLikeEntityName(word)) {
        // 降级提示(source-analysis 设计 D8):链路词未命中且工作区没有
        // entities.xml 时按一次口径提示,导航回落逐文件解析(引擎允许
        // entities.xml 缺省,entitydef.cpp:184-186)。
        const workspaceRoot = getWorkspaceRootForDocument(document);
        if (workspaceRoot && !findEntitiesXmlFile(workspaceRoot)) {
          notifyEntitiesXmlMissingOnce(workspaceRoot, message => {
            void vscode.window.showInformationMessage(message);
          });
        }
      }

      return location;
    }

    return null;
  }
}

export function validateDocument(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection
): void {
  const featureConfig = getLanguageFeatureConfig();
  if (!featureConfig.enableDiagnostics) {
    diagnostics.delete(document.uri);
    return;
  }

  const diagnosticsList: vscode.Diagnostic[] = [];

  // 批92 性能优化:标量校验与结构校验共用同一次 parseDefAst 结果。
  // parseDefDocument 对同一段文本是确定性的,原先两阶段各自解析一遍,
  // 大 .def 文档上纯解析开销翻倍。
  const ast = parseDefAst(document);
  validateScalarTagValues(document, diagnosticsList, featureConfig, ast);
  if (featureConfig.enableStructureDiagnostics) {
    validateDefStructure(document, diagnosticsList, featureConfig, ast);
  }

  diagnostics.set(document.uri, diagnosticsList);
  // Phase2 首片:shadow 双轨对拍(诊断面)+ 语料镜像腿。fire-and-forget,
  // 只读 diagnosticsList 的可比面,不改 collection 内容。
  shadowObserveDefDocument(document, diagnosticsList);
}

// entities.xml 清单诊断(source-analysis 设计 D3):同名重复条目引擎按首条
// 静默合并(entitydef.cpp:255-262),这里是文档事件联动的落 collection 面,
// 开关与 validateDocument 共用 kbengine.enableDiagnostics。
// PR6 A6-3:分析结果经 documentStore 同步解析缓存命名空间化版本化 ——
// 同版本重复校验直接命中缓存(不重跑 analyzeEntitiesXml),版本前进由
// 快照机制整体作废旧槽位;无版本替身每次现算(与旧行为同价)。
export function validateEntitiesXmlDocument(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection
): void {
  const featureConfig = getLanguageFeatureConfig();
  if (!featureConfig.enableDiagnostics) {
    diagnostics.delete(document.uri);
    return;
  }

  const { result: findings } = getOrParseDocumentSync(
    document,
    text => analyzeEntitiesXml(text),
    'entities-analysis'
  );

  diagnostics.set(
    document.uri,
    findings.map(item => {
      const start = document.positionAt(item.offset);
      const end = document.positionAt(item.offset + item.length);
      return new vscode.Diagnostic(
        new vscode.Range(start, end),
        item.message,
        vscode.DiagnosticSeverity.Warning
      );
    })
  );
}

type KBEngineSectionName =
  | 'Parent'
  | 'Interfaces'
  | 'Components'
  | 'Properties'
  | 'BaseMethods'
  | 'CellMethods'
  | 'ClientMethods'
  | 'Volatile';

const PROPERTY_SECTIONS = new Set<KBEngineSectionName>(['Properties']);

const METHOD_SECTIONS = new Set<KBEngineSectionName>([
  'BaseMethods',
  'CellMethods',
  'ClientMethods'
]);

const DEF_SYMBOL_SECTIONS = new Set<KBEngineSectionName>([
  'Properties',
  'BaseMethods',
  'CellMethods',
  'ClientMethods'
]);

const ALLOWED_TOP_LEVEL_SECTIONS = new Set<KBEngineSectionName>([
  'Parent',
  'Interfaces',
  'Components',
  'Properties',
  'BaseMethods',
  'CellMethods',
  'ClientMethods',
  'Volatile'
]);

const TAG_HOVER_DOCS: Record<string, { detail: string; documentation: string }> = {
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

function validateScalarTagValues(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  featureConfig: ReturnType<typeof getLanguageFeatureConfig>,
  ast: DefDocument | null
): void {
  if (!ast?.root) {
    return;
  }

  const knownTypeContext = getKnownTypeContext(document);
  const knownFlags = new Set(KBENGINE_FLAGS.map(flag => flag.name));
  const knownLevels = new Set(DETAIL_LEVELS);

  visitElementNodes(ast.root, node => {
    if (node.name === 'Type') {
      validateTypeNode(document, diagnosticsList, node, knownTypeContext, featureConfig);
      return;
    }

    if (node.name === 'Flags') {
      const rawValue = getNodeValue(node);
      const normalizedValue = rawValue.toUpperCase();
      if (featureConfig.diagnosticsCheckUnknownFlags && normalizedValue && !knownFlags.has(normalizedValue)) {
        pushDiagnosticForNodeValue(
          document,
          diagnosticsList,
          node,
          rawValue,
          `未知的 KBEngine Flags 值: ${rawValue}。KBEngine 源码按单个映射值解析 <Flags>，不支持此写法。`,
          vscode.DiagnosticSeverity.Error
        );
      }
      return;
    }

    if (node.name === 'DetailLevel') {
      const value = getNodeValue(node);
      if (featureConfig.diagnosticsCheckUnknownDetailLevels && value && !knownLevels.has(value)) {
        pushDiagnosticForNodeValue(
          document,
          diagnosticsList,
          node,
          value,
          `未知的 DetailLevel: ${value}`,
          vscode.DiagnosticSeverity.Error
        );
      }
    }
  });
}

function validateDefStructure(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  featureConfig: ReturnType<typeof getLanguageFeatureConfig>,
  ast: DefDocument | null
): void {
  const root = ast?.root;
  if (!root) {
    return;
  }

  for (const sectionNode of getDirectChildElements(root)) {
    const sectionName = toSectionName(sectionNode.name);
    if (!sectionName || !ALLOWED_TOP_LEVEL_SECTIONS.has(sectionName)) {
      continue;
    }

    validateSectionStructure(document, diagnosticsList, sectionNode, sectionName, featureConfig);
  }
}

function validateTypeNode(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  typeNode: DefElementNode,
  knownTypeContext: KnownTypeContext,
  featureConfig: ReturnType<typeof getLanguageFeatureConfig>
): void {
  const value = getNodeValue(typeNode);
  if (!value || getDirectChildElements(typeNode).length > 0 || !featureConfig.diagnosticsCheckUnknownTypes) {
    return;
  }

  const typeCandidateRegex = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  let typeCandidateMatch: RegExpExecArray | null;

  while ((typeCandidateMatch = typeCandidateRegex.exec(value)) !== null) {
    const candidate = typeCandidateMatch[0];
    if (knownTypeContext.builtins.has(candidate) || knownTypeContext.entityTypes.has(candidate)) {
      continue;
    }

    const customTypeResolution = resolveCustomTypeReference(document, candidate, knownTypeContext.customTypes);
    if (customTypeResolution.status === 'resolved' || customTypeResolution.status === 'unverifiable') {
      continue;
    }

    if (customTypeResolution.status === 'missingPythonFile') {
      pushDiagnosticForNodeValue(
        document,
        diagnosticsList,
        typeNode,
        candidate,
        `自定义类型 ${candidate} 已在 types.xml 中注册，但未找到对应的 user_type Python 文件，请检查 user_type/${candidate}.py`,
        vscode.DiagnosticSeverity.Warning
      );
      continue;
    }

    // 不可达(批64 定性):CustomTypeResolutionStatus 共四值,resolved/
    // unverifiable/missingPythonFile 已在上方三分支 continue 穷尽,能走到此处
    // 即 missingTypeRegistration。精确单行区间只摘除该 if 的分支条目,
    // 诊断构造保持被覆盖计入分母。
    /* istanbul ignore start */
    if (customTypeResolution.status === 'missingTypeRegistration') {
    /* istanbul ignore stop */
      pushDiagnosticForNodeValue(
        document,
        diagnosticsList,
        typeNode,
        candidate,
        `自定义类型 ${candidate} 未在 types.xml 中注册，请先在 types.xml 注册后再引用`,
        vscode.DiagnosticSeverity.Error
      );
    }
  }
}

function validateSectionStructure(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  sectionNode: DefElementNode,
  sectionName: KBEngineSectionName,
  featureConfig: ReturnType<typeof getLanguageFeatureConfig>
): void {
  const seenSymbols = new Map<string, vscode.Range>();
  const seenPropertyScopes = new Map<string, Map<PropertyScope, vscode.Range>>();

  for (const symbolNode of getDirectChildElements(sectionNode)) {
    const symbolRange = createNodeRange(document, symbolNode);
    if (featureConfig.diagnosticsCheckDuplicateDefinitions && sectionName === 'Properties') {
      const propertyScopes = getPropertyFlagScopes(symbolNode);
      const seenScopes = seenPropertyScopes.get(symbolNode.name) || new Map<PropertyScope, vscode.Range>();

      for (const scope of propertyScopes) {
        const existing = seenScopes.get(scope);
        if (!existing) {
          continue;
        }

        diagnosticsList.push(new vscode.Diagnostic(
          symbolRange,
          `${getSectionLabel(sectionName)}中存在重复定义: ${symbolNode.name} (${describePropertyScope(scope)})`,
          vscode.DiagnosticSeverity.Warning
        ));
        diagnosticsList.push(new vscode.Diagnostic(
          existing,
          `${symbolNode.name} 在 ${getSectionLabel(sectionName)} 中已在 ${describePropertyScope(scope)} 作用域定义`,
          vscode.DiagnosticSeverity.Information
        ));
      }

      for (const scope of propertyScopes) {
        if (!seenScopes.has(scope)) {
          seenScopes.set(scope, symbolRange);
        }
      }

      if (propertyScopes.length > 0) {
        seenPropertyScopes.set(symbolNode.name, seenScopes);
      }
    } else {
      const existing = seenSymbols.get(symbolNode.name);
      if (featureConfig.diagnosticsCheckDuplicateDefinitions && existing) {
        diagnosticsList.push(new vscode.Diagnostic(
          symbolRange,
          `${getSectionLabel(sectionName)}中存在重复定义: ${symbolNode.name}`,
          vscode.DiagnosticSeverity.Warning
        ));
        diagnosticsList.push(new vscode.Diagnostic(
          existing,
          `${symbolNode.name} 在 ${getSectionLabel(sectionName)} 中已定义`,
          vscode.DiagnosticSeverity.Information
        ));
      } else {
        seenSymbols.set(symbolNode.name, symbolRange);
      }
    }

    if (sectionName === 'Properties' && featureConfig.diagnosticsCheckMissingPropertyFields) {
      validatePropertyStructure(document, diagnosticsList, symbolNode);
    }
  }
}

function validatePropertyStructure(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  propertyNode: DefElementNode
): void {
  const propertyRange = createNodeRange(document, propertyNode);

  if (!getDirectChildElement(propertyNode, 'Type')) {
    diagnosticsList.push(new vscode.Diagnostic(
      propertyRange,
      `属性 ${propertyNode.name} 缺少 <Type> 定义`,
      vscode.DiagnosticSeverity.Error
    ));
  }

  if (!getDirectChildElement(propertyNode, 'Flags')) {
    diagnosticsList.push(new vscode.Diagnostic(
      propertyRange,
      `属性 ${propertyNode.name} 缺少 <Flags> 定义`,
      vscode.DiagnosticSeverity.Error
    ));
  }
}

function getPropertyFlagScopes(propertyNode: DefElementNode): PropertyScope[] {
  const flags = normalizePropertyFlag(getScalarChildValue(propertyNode, 'Flags'));
  if (!flags) {
    return [];
  }

  const scopes: PropertyScope[] = [];
  if (ENTITY_BASE_DATA_FLAGS.has(flags)) {
    scopes.push('base');
  }
  if (ENTITY_CELL_DATA_FLAGS.has(flags)) {
    scopes.push('cell');
  }
  if (ENTITY_CLIENT_DATA_FLAGS.has(flags)) {
    scopes.push('client');
  }
  return scopes;
}

function normalizePropertyFlag(flags: string | undefined): string | undefined {
  const normalizedFlag = flags?.trim().toUpperCase();
  if (!normalizedFlag) {
    return undefined;
  }

  switch (normalizedFlag) {
    case 'CELL_AND_CLIENT':
      return 'CELL_PUBLIC_AND_OWN';
    case 'CELL_AND_CLIENTS':
      return 'ALL_CLIENTS';
    case 'CELL_AND_OTHER_CLIENTS':
      return 'OTHER_CLIENTS';
    default:
      return normalizedFlag;
  }
}

function describePropertyScope(scope: PropertyScope): string {
  return PROPERTY_SCOPE_LABELS[scope];
}

function visitElementNodes(node: DefElementNode, visitor: (node: DefElementNode) => void): void {
  visitor(node);

  for (const child of getDirectChildElements(node)) {
    visitElementNodes(child, visitor);
  }
}

function getNodeValue(node: DefElementNode): string {
  return documentTextSlice(node).trim();
}

function documentTextSlice(node: DefElementNode): string {
  return node.children
    .filter((child): child is Exclude<DefNode, DefElementNode> => child.kind === 'text')
    .map(child => child.text)
    .join('');
}

function pushDiagnosticForNodeValue(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  node: DefElementNode,
  value: string,
  message: string,
  severity: vscode.DiagnosticSeverity
): void {
  const offset = document.getText().indexOf(value, node.contentStart);
  const range = offset >= 0 && offset <= node.contentEnd
    ? new vscode.Range(
        document.positionAt(offset),
        document.positionAt(offset + value.length)
      )
    : createNodeValueRange(document, node);

  diagnosticsList.push(new vscode.Diagnostic(range, message, severity));
}

function createNodeRange(document: vscode.TextDocument, node: DefElementNode): vscode.Range {
  return new vscode.Range(
    document.positionAt(node.tagStart),
    document.positionAt(node.closeTagEnd)
  );
}

function createNodeValueRange(document: vscode.TextDocument, node: DefElementNode): vscode.Range {
  return new vscode.Range(
    document.positionAt(node.contentStart),
    document.positionAt(node.contentEnd)
  );
}

function getSectionLabel(section: KBEngineSectionName): string {
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

function getSymbolHover(
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
function describePropertyDatabaseStorageHover(
  document: vscode.TextDocument,
  propertyName: string
): string | null {
  const entityName = path.basename(document.fileName, '.def');
  return buildPropertyDatabaseStorageHover(
    describePropertyDatabaseStorage(entityName, propertyName, document)
  );
}

function createHookHover(hook: import('./hooks').KBEngineHook): vscode.Hover {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${hook.name}** - ${HOOK_CATEGORY_NAMES[hook.category]}\n\n`);
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

function getCustomTypeHover(
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
    customTypeTarget.isImplementedByValue ? null : getTypeStorageShapeMarkdown(document, word)
  );
}

// 批134:types.xml 类型声明行悬停的落库形态段。形态判定走 schema 构建
// 器的别名/列展开语义(getTypeStorageShape 与引擎装载同源),这里把形态
// 翻成说明文字;悬停的就是 types.xml 本体,直接按文档路径解析
function getTypeStorageShapeMarkdown(document: vscode.TextDocument, word: string): string | null {
  const shapeLines = describeTypeStorageShape(getTypeStorageShape(document.fileName, word));
  return `**落库形态**:\n${shapeLines.map(line => `- ${line}`).join('\n')}\n\n`;
}

export function describeTypeStorageShape(shape: TypeStorageShape): string[] {
  if (shape.kind === 'builtin') {
    return [`主表单列${shape.columnType ? `（\`${shape.columnType}\`）` : ''}`];
  }
  if (shape.kind === 'fixedDict') {
    const keys = shape.topLevelKeys.length > 0
      ? `；顶层键各占一列：${shape.topLevelKeys.join('、')}`
      : '';
    return [`平铺成列，不成表${keys}`];
  }
  if (shape.kind === 'array') {
    const element = shape.element
      ? `元素落列：${describeTypeStorageElement(shape.element)}`
      : '缺 <of>，元素类型未知';
    return [`成子表 \`tbl_<实体>_<属性>\`，元素各占一行；${element}`];
  }
  return ['未知类型，引擎装载 types.xml 会失败'];
}

function describeTypeStorageElement(element: TypeStorageShape): string {
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
function getImplementedByReverseHover(
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

function getTypeValueHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Hover | null {
  if (!isPositionInsideTagValue(document, position, 'Type')) {
    return null;
  }

  const customTypeInfo = findCustomTypeInfo(word, document);
  if (customTypeInfo) {
    return createCustomTypeHover(customTypeInfo, 'Referenced custom type from `types.xml`');
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

function createCustomTypeHover(
  customTypeInfo: NonNullable<ReturnType<typeof findCustomTypeInfo>>,
  summary: string,
  shapeMarkdown: string | null = null
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
    markdown.appendMarkdown('**Properties**:\n');
    for (const property of customTypeInfo.properties) {
      markdown.appendMarkdown(`- \`${property.name}\`: \`${property.typeName || 'UNKNOWN'}\`\n`);
    }
  }

  if (shapeMarkdown) {
    markdown.appendMarkdown(shapeMarkdown);
  }

  return new vscode.Hover(markdown);
}

function createDefinitionReferenceHover(
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

function getEntityRegistrationHover(
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
function getEntityUtypeLine(
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
function getDefChainHover(
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

function getRegisteredEntityInfo(
  document: vscode.TextDocument,
  entityName: string
) {
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return null;
  }

  return getRegisteredEntities(workspaceRoot).find(entity => entity.name === entityName) || null;
}

function getEntityRuntimeHoverLines(
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

type CustomTypeResolutionStatus =
  | 'resolved'
  | 'missingTypeRegistration'
  | 'missingPythonFile'
  | 'unverifiable';

interface CustomTypeResolution {
  status: CustomTypeResolutionStatus;
}

function parseDefAst(document: vscode.TextDocument): DefDocument | null {
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

function toSectionName(name: string): KBEngineSectionName | null {
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

function getDefNodeAtPosition(document: vscode.TextDocument, position: vscode.Position): DefNode | null {
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

function getDefNodeAtWord(document: vscode.TextDocument, position: vscode.Position, word: string): DefNode | null {
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

function getSymbolNodeInfo(
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

function isOffsetInsideNodeValue(node: DefElementNode, offset: number): boolean {
  return offset >= node.contentStart && offset <= node.contentEnd;
}

function resolveCustomTypeReference(
  document: vscode.TextDocument,
  candidate: string,
  registeredCustomTypes?: Set<string>
): CustomTypeResolution {
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return { status: 'unverifiable' };
  }

  // 不可达(批64 定性):唯一调用方(validateTypeNode)恒传非空的
  // knownTypeContext.customTypes,`?? getRegisteredCustomTypes` 右臂无触发
  // 路径;该行语句已被覆盖,随区间离开语句/行分母(TESTING.md 分母口径据实登记)。
  /* istanbul ignore start */
  const customTypes = registeredCustomTypes ?? getRegisteredCustomTypes(workspaceRoot);
  /* istanbul ignore stop */
  if (!customTypes.size) {
    return { status: 'unverifiable' };
  }

  if (!customTypes.has(candidate)) {
    return { status: 'missingTypeRegistration' };
  }

  // 不可达(批62 定性):customTypes 与声明查询都读同一 workspaceRoot 的 types.xml
  // 快照,集合命中必有节点,故 !declarationInfo 无触发路径。
  const declarationInfo = findCustomTypeDeclarationInfo(candidate, workspaceRoot);
  /* istanbul ignore start */
  if (!declarationInfo) {
    return { status: 'resolved' };
  }
  /* istanbul ignore stop */

  if (declarationInfo.implementedBy && !findCustomTypePythonImplementationFile(
    declarationInfo.name,
    workspaceRoot,
    declarationInfo.implementedBy
  )) {
    return { status: 'missingPythonFile' };
  }

  return { status: 'resolved' };
}

function findEnclosingSymbol(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): SymbolHoverInfo | null {
  const node = getDefNodeAtWord(document, position, word);
  const info = getSymbolNodeInfo(node);
  if (!info || info.symbolNode.name !== word) {
    return null;
  }

  return buildSymbolHoverInfo(info.section, info.symbolNode);
}

function findEntityDefinitionInDef(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string,
  entityMappingManager?: EntityMappingManager
): vscode.ProviderResult<vscode.Location> {
  const entityName = path.basename(document.fileName, '.def');
  const symbolInfo = findDefSymbolInfo(document, position, word);
  // 真机诊断日志(用户令):每点一次 F12 一段,断在哪一级直接可读。
  logNavigation(`F12 ${document.fileName} ${position.line + 1}:${position.character + 1} word=${word}`);
  logNavigation(`符号解析 section=${symbolInfo?.section ?? 'null'} symbol=${symbolInfo?.symbolNode.name ?? 'null'}`);

  // 批111 用户令:引用族全量接通——DetailLevel 值引用同文件
  // <DetailLevels> 下的档位声明(NEAR/MEDIUM/FAR),点击值跳档位行。
  // 必须先于 Properties 链:DetailLevel 值的 symbolInfo.section 也是
  // 'Properties',若排在脚本/class 与 schema 之后,凡有脚本的实体都会
  // 被那两条链截获,本链成死代码。
  const detailLevelLocation = findDetailLevelDefinitionInDef(document, position, word);
  if (detailLevelLocation) {
    return detailLevelLocation;
  }

  // 批110 用户令:Properties 字段优先导航到实体脚本实现;脚本不存在时
  // 再回落数据库 schema 虚拟文档。
  if (symbolInfo?.section === 'Properties') {
    const propertyScriptLocation = findPropertyScriptLocationInDef(document);
    if (propertyScriptLocation) {
      logNavigation(
        `属性落点 ${propertyScriptLocation.uri.fsPath}:${propertyScriptLocation.range.start.line}`
      );
      return propertyScriptLocation;
    }
  }

  const databaseSchemaLocation = findDatabaseSchemaLocationFromDef(document, position, word);
  if (databaseSchemaLocation) {
    logNavigation(`schema 回落 ${databaseSchemaLocation.uri.fsPath}`);
    return databaseSchemaLocation;
  }

  // 根修令④(2026-10-10 用户令):属性找不到实现必须落到类(脚本存在,
  // d3711f5 已覆盖);脚本确实不存在 → 跳 entities.xml 声明行或同名 def
  // 首行,提示仅作辅助,不许只弹提示不跳。
  if (symbolInfo?.section === 'Properties') {
    const expected = describeExpectedScriptPaths(document, entityName, ['base', 'cell', 'client']);
    void vscode.window.showInformationMessage(
      `属性 ${word} 未找到脚本实现,期望位置:${expected.join('、')}(辅助提示,已回落到注册声明/def 首行)`
    );
    return findRegistryFallbackLocation(document, entityName);
  }

  if (symbolInfo?.section && METHOD_SECTIONS.has(symbolInfo.section)) {
    const methodLocation = findMethodImplementationLocationInDef(
      document,
      position,
      symbolInfo.symbolNode.name,
      symbolInfo.section,
      entityMappingManager
    );
    // 管理器路径返回 Thenable(内部恒有落点:实现或 def 声明行),原样回传;
    // 同步结果为 null = 无管理器回落链全空(根修令④:给提示 + 可跳落点)。
    if (methodLocation && 'then' in methodLocation) {
      return methodLocation;
    }
    if (methodLocation) {
      logNavigation(`方法落点 ${methodLocation.uri.fsPath}:${methodLocation.range.start.line}`);
      return methodLocation;
    }

    const methodRole = METHOD_SECTION_SCRIPT_ROLES[symbolInfo.section];
    const expected = describeExpectedScriptPaths(
      document,
      entityName,
      // 不可达(根修令④ 定性):METHOD_SECTIONS 只含 Base/Cell/Client 三段,
      // 与 METHOD_SECTION_SCRIPT_ROLES 的键完全重合,methodRole 恒真——
      // 三角色兜底臂无触发路径。
      /* istanbul ignore start */
      methodRole ? [methodRole] : ['base', 'cell', 'client']
    );
    /* istanbul ignore stop */
    void vscode.window.showInformationMessage(
      `方法 ${word} 未找到脚本实现,期望位置:${expected.join('、')}(辅助提示,已回落到注册声明/def 首行)`
    );
    return findRegistryFallbackLocation(document, entityName);
  }

  const definitionReference = findDefinitionReferenceInDef(document, position, word);
  if (definitionReference) {
    return createDefinitionLocation(document, definitionReference);
  }

  // 属性链同口径:点击属性的 <Type> 值未解析时给显式提示——内建类型无
  // 定义文件(引擎 C++ 内建),自定义类型未在 types.xml 声明。
  if (isPositionInsideTagValue(document, position, 'Type')) {
    const builtInTypes = new Set(KBENGINE_TYPES.map(type => type.name));
    void vscode.window.showInformationMessage(
      builtInTypes.has(word)
        ? `内建类型 ${word} 无定义文件(引擎 C++ 内建,无对应声明文件)`
        : `自定义类型 ${word} 未找到声明:types.xml 未声明或 implementedBy 脚本缺失`
    );
  }

  return null;
}

// 根修令③(2026-10-10 用户令):文案给真实路径,不给花括号模板。收集
// 文件相对(def 反推)与工作区布局(文档所属根 + 其余工作区根,2026-10-12
// 多根自动寻找同口径)两级推断的全部候选脚本位置;路径在
// 工作区根下时按工作区相对展示,否则绝对路径。
function describeExpectedScriptPaths(
  document: vscode.TextDocument,
  entityName: string,
  roles: Array<'base' | 'cell' | 'client'>
): string[] {
  const roots: string[] = [];
  const defScriptsRoot = getScriptsRootForDefFile(document.fileName);
  if (defScriptsRoot) {
    roots.push(defScriptsRoot);
  }
  const layoutRoots: string[] = [];
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (workspaceRoot) {
    layoutRoots.push(workspaceRoot);
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (!layoutRoots.includes(folder.uri.fsPath)) {
      layoutRoots.push(folder.uri.fsPath);
    }
  }
  for (const layoutRoot of layoutRoots) {
    const layoutScriptsRoot = getDefinitionWorkspaceLayout(layoutRoot).entityScriptsRoot;
    if (layoutScriptsRoot && !roots.includes(layoutScriptsRoot)) {
      roots.push(layoutScriptsRoot);
    }
  }

  // 双根已由 includes 去重,不同根不可能拼出同一路径,无需二次去重。
  // 目录序列与 findEntityScriptFile 的候选链同口径:client 兼容官方模板
  // bots/,每个根末尾附生成器平铺形态 scripts/<实体>.py。
  const shown: string[] = [];
  for (const scriptsRoot of roots) {
    for (const role of roles) {
      for (const folder of scriptFoldersForRole(role)) {
        shown.push(formatWorkspaceRelativePath(path.join(scriptsRoot, folder, `${entityName}.py`), workspaceRoot));
      }
    }
    shown.push(formatWorkspaceRelativePath(path.join(scriptsRoot, `${entityName}.py`), workspaceRoot));
  }
  return shown;
}

function formatWorkspaceRelativePath(candidate: string, workspaceRoot: string | null): string {
  if (workspaceRoot && candidate.startsWith(`${workspaceRoot}${path.sep}`)) {
    return path.relative(workspaceRoot, candidate);
  }
  return candidate;
}

// 根修令③:段标签悬停附带本工程的真实实现解析——命中给实际脚本路径,
// 未命中列全部期望位置,不给花括号模板。
function describeImplementationForHover(
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

// 根修令④:脚本确实不存在时的可跳落点——实体在 entities.xml 的声明行
// 优先(注册事实所在,def 反推与工作区布局两级各取一次),否则同名 def
// (即当前文档)首行。
function findEntityDeclarationLine(xmlPath: string, entityName: string): number {
  if (!/^[A-Za-z_]\w*$/.test(entityName)) {
    return -1;
  }
  const pattern = new RegExp(`^\\s*<${entityName}(\\s|/>|>)`);
  return readWorkspaceTextLines(xmlPath).findIndex(line => pattern.test(line));
}

function findRegistryFallbackLocation(
  document: vscode.TextDocument,
  entityName: string
): vscode.Location {
  const xmlCandidates: string[] = [];
  const defScriptsRoot = getScriptsRootForDefFile(document.fileName);
  if (defScriptsRoot) {
    xmlCandidates.push(path.join(defScriptsRoot, 'entities.xml'));
  }
  // defs 目录自身的 entities.xml(部分工程/夹具把清单放在 entity_defs 内)
  const defsDir = findEntityDefsDirForDefFile(document.fileName);
  if (defsDir) {
    xmlCandidates.push(path.join(defsDir, 'entities.xml'));
  }
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (workspaceRoot) {
    const layoutEntitiesXml = findEntitiesXmlFile(workspaceRoot);
    if (layoutEntitiesXml) {
      xmlCandidates.push(layoutEntitiesXml);
    }
  }

  for (const xmlPath of xmlCandidates) {
    const line = findEntityDeclarationLine(xmlPath, entityName);
    if (line >= 0) {
      logNavigation(`注册表回落 ${xmlPath}:${line}`);
      return new vscode.Location(vscode.Uri.file(xmlPath), new vscode.Position(line, 0));
    }
  }

  logNavigation(`def 首行回落 ${document.fileName}:0`);
  return new vscode.Location(document.uri, new vscode.Position(0, 0));
}

function findDatabaseSchemaDefinition(
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.Location | null {
  const entityName = decodeURIComponent(document.uri.path.replace(/^\/+/, '').replace(/\.schema$/, ''));
  const snapshot = getDatabaseSchemaSnapshot(entityName, document);
  if (!snapshot) {
    return null;
  }

  const target = findDatabaseSchemaFieldAtPosition(document, position);
  if (!target) {
    return null;
  }

  const source = findDatabaseSchemaSourceLocation(snapshot, target.table, target.field);
  if (!source) {
    return null;
  }

  return new vscode.Location(
    vscode.Uri.file(source.filePath),
    new vscode.Position(Math.max(source.line - 1, 0), 0)
  );
}

function findDatabaseSchemaLocationFromDef(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Location | null {
  const symbolInfo = findDefSymbolInfo(document, position, word);
  if (!symbolInfo || symbolInfo.section !== 'Properties') {
    return null;
  }

  const entityName = path.basename(document.fileName, '.def');
  const snapshot = getDatabaseSchemaSnapshot(entityName, document);
  if (!snapshot) {
    return null;
  }

  const sourcePath = buildPropertyPath(symbolInfo.symbolNode);
  const targets = findDatabaseSchemaTargetsForSource(snapshot, document.fileName, sourcePath);
  if (targets.length === 0) {
    return null;
  }

  const primaryTarget = targets[0];
  return new vscode.Location(
    createDatabaseSchemaUri(entityName),
    new vscode.Position(
      Math.max(locateDatabaseSchemaLine(snapshot, primaryTarget.tableName, primaryTarget.fieldName) - 1, 0),
      0
    )
  );
}

function buildPropertyPath(symbolNode: DefElementNode): string {
  const segments: string[] = [];
  let current: DefElementNode | null = symbolNode;

  while (current) {
    if (current.parent?.name === 'Properties') {
      segments.push(current.name);
    }
    current = current.parent;
  }

  return segments.reverse().join('.');
}

function findTypeValueDefinitionInTypesXml(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Location | null {
  if (!isPositionInsideTagValue(document, position, 'Type')) {
    return null;
  }

  return createDefinitionLocation(document, findTypeValueDefinitionReference(document, word));
}

function findCustomTypeDefinition(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Location | null {
  if (isPositionInsideTagValue(document, position, 'Type')) {
    return null;
  }

  const customTypeTarget = findCustomTypeAtPosition(document, position, word);
  if (!customTypeTarget) {
    return null;
  }

  if (customTypeTarget.isImplementedByValue) {
    if (customTypeTarget.info.pythonFilePath) {
      // 引擎语义(datatype.cpp loadImplModule):implementedBy 拆成
      // moduleName.symbolName 后落在模块内符号上,落点是符号定义行,
      // 不是文件首行;符号解析不到才回落首行(跳转必须始终有落点)
      const symbolLine = findImplementedBySymbolLine(
        customTypeTarget.info.pythonFilePath,
        customTypeTarget.info.implementedBy
      );
      return new vscode.Location(
        vscode.Uri.file(customTypeTarget.info.pythonFilePath),
        new vscode.Position(symbolLine ? symbolLine - 1 : 0, 0)
      );
    }
    return null;
  }

  return new vscode.Location(
    vscode.Uri.file(document.fileName),
    new vscode.Position(customTypeTarget.line - 1, 0)
  );
}

function findCustomTypeAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): { info: NonNullable<ReturnType<typeof findCustomTypeInfo>>; line: number; isImplementedByValue: boolean } | null {
  if (!document.fileName.endsWith('types.xml')) {
    return null;
  }

  const node = getDefNodeAtWord(document, position, word);
  const isImplementedByValue = isPositionInsideImplementedByValue(document, position);
  const topLevelTypeNode = isImplementedByValue
    ? findAncestorElement(node, 'implementedBy')?.parent || null
    : (node?.kind === 'element' ? node : node?.parent) || null;

  if (!topLevelTypeNode || topLevelTypeNode.parent?.name !== 'root') {
    return null;
  }

  if (!isImplementedByValue && topLevelTypeNode.name !== word) {
    return null;
  }

  const customTypeInfo = findCustomTypeInfo(topLevelTypeNode.name, document);
  if (!customTypeInfo) {
    return null;
  }

  // 不可达(批62 定性):node 出自同一 document 同一次同步调用内的 parseDefAst 结果,
  // 解析失败时上面的 topLevelTypeNode 已早退,此处 ast 不可能为 null。
  const ast = parseDefAst(document);
  /* istanbul ignore start */
  if (!ast) {
    return null;
  }
  /* istanbul ignore stop */

  return {
    info: customTypeInfo,
    line: getLineNumberAt(ast, topLevelTypeNode.tagStart),
    isImplementedByValue
  };
}

function findCurrentDocumentCustomTypeReference(
  document: vscode.TextDocument,
  typeName: string
): { filePath: string; line: number } | null {
  if (!document.fileName.endsWith('types.xml')) {
    return null;
  }

  // 不可达(批62 定性):唯一调用面 findTypeValueDefinitionReference 的两个入口
  // (findTypeValueDefinitionInTypesXml / findDefinitionReferenceInDef)都先用
  // isPositionInsideTagValue('Type') 判定,而它经 getDefNodeAtPosition 对同一
  // document 解析并在 !ast?.root 处早退;parseDefAst 纯同步且确定性,同一次调用内
  // 两次解析结果一致,该守卫无触发路径。
  const ast = parseDefAst(document);
  /* istanbul ignore start */
  if (!ast?.root) {
    return null;
  }
  /* istanbul ignore stop */

  const typeNode = getDirectChildElements(ast.root).find(node => node.name === typeName);
  if (!typeNode) {
    return null;
  }

  return {
    filePath: document.fileName,
    line: getLineNumberAt(ast, typeNode.tagStart)
  };
}

function buildSymbolHoverInfo(
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

function isPositionInsideTagValue(
  document: vscode.TextDocument,
  position: vscode.Position,
  tagName: string
): boolean {
  const node = getDefNodeAtPosition(document, position);
  const elementNode = node?.kind === 'element' ? node : node?.parent;
  const candidateNode = elementNode?.name === tagName
    ? elementNode
    : findAncestorElement(node, tagName);

  if (!candidateNode) {
    return false;
  }

  return isOffsetInsideNodeValue(candidateNode, document.offsetAt(position));
}

function isPositionInsideImplementedByValue(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  return isPositionInsideTagValue(document, position, 'implementedBy');
}

function isPositionInsideChildTag(
  document: vscode.TextDocument,
  position: vscode.Position,
  parentTagName: string
): boolean {
  const node = getDefNodeAtPosition(document, position);
  const elementNode = node?.kind === 'element' ? node : node?.parent;
  if (!elementNode) {
    return false;
  }

  // 批109 放宽:引擎对接口引用不要求自闭合写法(`entity_defs/interfaces/
  // <名>.def` 按引用名加载,entitydef.cpp:551-639,见 docs/source-analysis.md),
  // `<Iface/>` 与 `<Iface></Iface>` 均导航——defParser 的元素跨度覆盖闭合标签,
  // 起止标签名上的光标都落在元素节点上。
  return !!findAncestorElement(elementNode, parentTagName);
}

function looksLikeEntityName(word: string): boolean {
  const builtInTypes = new Set(KBENGINE_TYPES.map(type => type.name));
  return !builtInTypes.has(word) && /^[A-Z][A-Za-z0-9_]*$/.test(word);
}

function createDefinitionLocation(
  document: vscode.TextDocument,
  definitionReference: { filePath: string; line?: number } | null
): vscode.Location | null {
  if (!definitionReference) {
    return null;
  }

  if (definitionReference.filePath === document.uri.fsPath && definitionReference.line === undefined) {
    return null;
  }

  return new vscode.Location(
    vscode.Uri.file(definitionReference.filePath),
    new vscode.Position((definitionReference.line || 1) - 1, 0)
  );
}

function findTypeValueDefinitionReference(
  document: vscode.TextDocument,
  word: string
): { filePath: string; line?: number } | null {
  const currentDocumentTypeReference = findCurrentDocumentCustomTypeReference(document, word);
  if (currentDocumentTypeReference) {
    return currentDocumentTypeReference;
  }

  const customTypeEntry = findDefinitionEntryByCategory(word, 'type', document);
  if (customTypeEntry) {
    return { filePath: customTypeEntry.filePath, line: customTypeEntry.line };
  }

  const componentPath = findDefinitionFileByCategory(word, 'component', document);
  if (componentPath) {
    return { filePath: componentPath };
  }

  const entityPath = findEntityDefinitionFile(word, document);
  if (entityPath) {
    return { filePath: entityPath };
  }

  return null;
}

function findDefinitionReferenceInDef(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): { filePath: string; line?: number } | null {
  if (!looksLikeEntityName(word)) {
    return null;
  }

  if (isPositionInsideTagValue(document, position, 'Arg')) {
    const entityPath = findEntityDefinitionFile(word, document);
    if (entityPath) {
      return { filePath: entityPath };
    }
  }

  if (isPositionInsideTagValue(document, position, 'Type')) {
    return findTypeValueDefinitionReference(document, word);
  }

  if (isPositionInsideChildTag(document, position, 'Interfaces')) {
    const interfacePath = findDefinitionFileByCategory(word, 'interface', document);
    if (interfacePath) {
      return { filePath: interfacePath };
    }
  }

  if (isPositionInsideChildTag(document, position, 'Parent')) {
    const siblingPath = findDefinitionSiblingForParent(document, word);
    if (siblingPath) {
      return { filePath: siblingPath };
    }
  }

  return null;
}

function findDefSymbolInfo(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): { section: KBEngineSectionName; symbolNode: DefElementNode } | null {
  const node = getDefNodeAtWord(document, position, word);
  const info = getSymbolNodeInfo(node);
  if (!info || info.symbolNode.name !== word) {
    return null;
  }

  return info;
}

const METHOD_SECTION_SCRIPT_ROLES: Partial<Record<KBEngineSectionName, 'base' | 'cell' | 'client'>> = {
  BaseMethods: 'base',
  CellMethods: 'cell',
  ClientMethods: 'client'
};

// 批110 用户令:属性字段导航到实现。实体实现在 scripts/{base,cell,client}/
// <实体>.py 的实体类声明行;按 base→cell→client 取第一个存在的脚本。
// 2026-10-10 补充口径:属性先于 __init__ 装载,脚本里未必有同名赋值——
// 落点按「类定义行 → __init__ 行 → 首个类行 → 脚本首行」四档解析,
// 全落空才走显式提示,不许无声 null。候选脚本沿引擎装载链收集:本 def
// 角色脚本 → 接口 def 的 scripts/interfaces/ 脚本 → <Parent> 链各层角色
// 脚本(组件 def 的 Parent 在 components/ 内解析,接口 def 不跟随
// Parent,口径同 collectMethodCandidateScripts)。
function findPropertyScriptLocationInDef(document: vscode.TextDocument): vscode.Location | null {
  const entityName = path.basename(document.fileName, '.def');

  const candidateScripts = collectPropertyCandidateScripts(document);
  logNavigation(`属性候选链 [${candidateScripts.join(' | ') || '空'}]`);
  for (const scriptPath of candidateScripts) {
    const lineIndex = resolvePropertyLandingLine(
      readWorkspaceTextLines(scriptPath),
      entityName
    );
    return new vscode.Location(vscode.Uri.file(scriptPath), new vscode.Position(lineIndex, 0));
  }

  return null;
}

// 属性落点四档:与 def 同名的类定义行 → __init__ 行 → 首个类行(类名与
// def 不一致时)→ 脚本首行。引擎在 __init__ 之前装载属性,脚本里没有同名
// 赋值时类/__init__ 仍是唯一可定位的锚点。
function resolvePropertyLandingLine(lines: string[], entityName: string): number {
  let firstInitLine = -1;
  let firstClassLine = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const classMatch = /^\s*class\s+([A-Za-z_]\w*)/.exec(lines[index]);
    if (classMatch) {
      if (classMatch[1] === entityName) {
        return index;
      }
      if (firstClassLine < 0) {
        firstClassLine = index;
      }
      continue;
    }

    if (firstInitLine < 0 && /^\s*def\s+__init__\s*\(/.test(lines[index])) {
      firstInitLine = index;
    }
  }

  if (firstInitLine >= 0) {
    return firstInitLine;
  }
  return firstClassLine >= 0 ? firstClassLine : 0;
}

// 属性候选脚本闭包:结构同 collectMethodCandidateScripts(方法实现候选),
// 差别只在接口 def 只取 scripts/interfaces/<接口名>.py、不跟随 Parent,
// 且每层 def 按 base→cell→client 全角色入队(属性不区分方法段角色)。
function collectPropertyCandidateScripts(document: vscode.TextDocument): string[] {
  const candidates: string[] = [];
  const seenScripts = new Set<string>();
  const seenDefs = new Set<string>();
  const pushScript = (scriptPath: string | null): void => {
    if (scriptPath && !seenScripts.has(scriptPath)) {
      seenScripts.add(scriptPath);
      candidates.push(scriptPath);
    }
  };

  let defPath: string | null = document.fileName;
  // 当前文档用缓冲区文本(未保存改动也参与解析);上游 def 走磁盘。
  let defContent: string = document.getText();
  let defName = path.basename(document.fileName, '.def');

  while (defPath && defContent) {
    // 环防护由下方 parentDefPath 的 seen 判定承担(入队前拦截),
    // 循环顶不再重复检查:进入循环体的 defPath 恒为未见过的路径。
    seenDefs.add(defPath);

    const isInterfaceDef = /(^|[\\/])interfaces[\\/][^\\/]*$/.test(defPath);
    const semantics = parseDefFileSemantics(defContent);
    if (isInterfaceDef) {
      // 接口 def 的实现脚本在 scripts/interfaces/<接口名>.py(引擎
      // loadInterfaces 的装载口径),不在 scripts/<role>/;接口 def 不跟随 Parent。
      pushScript(findInterfaceScriptFile(defName, document));
      break;
    }

    for (const role of ['base', 'cell', 'client'] as const) {
      pushScript(findEntityScriptFile(defName, role, document));
    }
    if (semantics) {
      for (const interfaceName of semantics.interfaceNames) {
        pushScript(findInterfaceScriptFile(interfaceName, document));
      }
    }

    if (!semantics?.parentName) {
      break;
    }

    const parentDefPath = findParentDefPath(defPath, semantics.parentName, document);
    if (!parentDefPath || seenDefs.has(parentDefPath)) {
      break;
    }
    defPath = parentDefPath;
    defName = semantics.parentName;
    defContent = readWorkspaceTextFile(parentDefPath);
  }

  return candidates;
}

// 批111 用户令:引用族全量接通——方法实现不只在实体自身角色脚本。引擎把
// <Interfaces> 声明的接口实现与 <Parent> 链的父类实现混入实体类,方法可能
// 落在任一层的 .py。候选脚本按近似 MRO 顺序收集:本实体角色脚本 → 本 def
// 接口脚本 → 父 def 角色脚本 → 父 def 接口脚本 → 逐级上溯。接口 def 不跟随
// Parent(引擎 loadInterfaces 不读 Parent);组件 def 的 Parent 在 components/
// 目录内解析(与 defRenamer 装载口径一致);见环即止(有限 def 集必终止)。
function collectMethodCandidateScripts(
  document: vscode.TextDocument,
  role: 'base' | 'cell' | 'client'
): string[] {
  const candidates: string[] = [];
  const seenScripts = new Set<string>();
  const seenDefs = new Set<string>();
  const pushScript = (scriptPath: string | null): void => {
    if (scriptPath && !seenScripts.has(scriptPath)) {
      seenScripts.add(scriptPath);
      candidates.push(scriptPath);
    }
  };

  let defPath: string | null = document.fileName;
  // 当前文档用缓冲区文本(未保存改动也参与解析);上游 def 走磁盘。
  let defContent: string = document.getText();
  let defName = path.basename(document.fileName, '.def');

  while (defPath && defContent) {
    // 环防护由下方 parentDefPath 的 seen 判定承担(入队前拦截),
    // 循环顶不再重复检查:进入循环体的 defPath 恒为未见过的路径。
    seenDefs.add(defPath);

    const isInterfaceDef = /(^|[\\/])interfaces[\\/][^\\/]*$/.test(defPath);
    const semantics = parseDefFileSemantics(defContent);
    if (isInterfaceDef) {
      // 接口 def 的实现脚本在 scripts/interfaces/<接口名>.py(引擎 loadInterfaces
      // 的装载口径),不在 scripts/<role>/;接口 def 不跟随 Parent。
      pushScript(findInterfaceScriptFile(defName, document, role));
    }
    pushScript(findEntityScriptFile(defName, role, document));
    if (semantics) {
      // 接口与组件脚本均按段角色配对解析(2026-10-12 用户令:BaseApp
      // 的 def 跳 base、CellApp 跳 cell):接口查 scripts/<role>/interfaces/
      // 及 Interface_<名>.py 变体,组件查 scripts/<role>/components/。
      for (const interfaceName of semantics.interfaceNames) {
        pushScript(findInterfaceScriptFile(interfaceName, document, role));
      }
      for (const componentType of semantics.componentTypeNames) {
        pushScript(findComponentScriptFile(componentType, role, document));
      }
    }

    if (isInterfaceDef || !semantics?.parentName) {
      break;
    }

    const parentDefPath = findParentDefPath(defPath, semantics.parentName, document);
    if (!parentDefPath || seenDefs.has(parentDefPath)) {
      break;
    }
    defPath = parentDefPath;
    defName = semantics.parentName;
    defContent = readWorkspaceTextFile(parentDefPath);
  }

  return candidates;
}

// 父 def 路径:实体 Parent 平铺在定义根;组件 def 的 Parent 在 components/
// 内解析(defRenamer.resolveLinkPaths 同口径)。实体链先按 def 自身反推的
// defs 目录找同名 def(2026-10-12 用户令:非候选布局如 server_assets 的
// Parent 链不再因工作区布局探测落空而断),再回落工作区布局。不存在返回
// null(悬空引用不产生候选)。
function findParentDefPath(
  currentDefPath: string,
  parentName: string,
  document: vscode.TextDocument
): string | null {
  const parentDir = path.dirname(currentDefPath);
  if (path.basename(parentDir) === 'components') {
    const candidate = path.join(parentDir, `${parentName}.def`);
    return readWorkspaceTextFile(candidate) ? candidate : null;
  }

  const defsDir = findEntityDefsDirForDefFile(currentDefPath);
  if (defsDir) {
    const candidate = path.join(defsDir, `${parentName}.def`);
    if (readWorkspaceTextFile(candidate)) {
      return candidate;
    }
  }

  return findEntityDefinitionFile(parentName, document);
}

// 批110 用户令:方法无映射管理器时的文件回落——在候选脚本闭包里按顺序找
// `def <方法名>`,命中即止;全无实现(或脚本缺失)返回 null,不虚跳。
function findMethodScriptLocationInDef(
  document: vscode.TextDocument,
  methodName: string,
  section: KBEngineSectionName
): vscode.Location | null {
  const role = METHOD_SECTION_SCRIPT_ROLES[section];
  // 不可达(批110 定性):唯一入口 findEntityDefinitionInDef 只在
  // METHOD_SECTIONS 命中后进入方法链,section 恒映射出角色。
  /* istanbul ignore start */
  if (!role) {
    return null;
  }
  /* istanbul ignore stop */

  const candidateScripts = collectMethodCandidateScripts(document, role);
  logNavigation(`方法候选链 [${candidateScripts.join(' | ') || '空'}]`);
  for (const scriptPath of candidateScripts) {
    const defLineIndex = readWorkspaceTextLines(scriptPath).findIndex(line => {
      const match = /^\s*def\s+([A-Za-z_]\w*)/.exec(line);
      return match?.[1] === methodName;
    });
    if (defLineIndex >= 0) {
      return new vscode.Location(vscode.Uri.file(scriptPath), new vscode.Position(defLineIndex, 0));
    }
  }

  // 根修令④:实现缺失时不再在此处提示——统一交调用方给「真实期望位置
  // 提示 + 注册声明/def 首行落点」,本函数只如实返回 null。
  return null;
}

// 批111 用户令:DetailLevel 值(NEAR/MEDIUM/FAR)引用同文件 <DetailLevels>
// 下的档位声明节点,点击值跳到档位声明行;无该段或档位缺失返回 null。
function findDetailLevelDefinitionInDef(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Location | null {
  if (!isPositionInsideTagValue(document, position, 'DetailLevel')) {
    return null;
  }

  const ast = parseDefAst(document);
  const root = ast?.root;
  // 不可达(批111 定性):上方 isPositionInsideTagValue 经 getDefNodeAtPosition
  // 对同一 document 同步解析,解析失败时该处早退;parseDefAst 确定性,
  // 此处 root 恒非空。
  /* istanbul ignore start */
  if (!root) {
    return null;
  }
  /* istanbul ignore stop */

  const detailLevels = getDirectChildElement(root, 'DetailLevels');
  if (!detailLevels) {
    return null;
  }

  for (const level of getDirectChildElements(detailLevels)) {
    if (level.name === word) {
      return new vscode.Location(
        document.uri,
        new vscode.Position(getLineNumberAt(ast, level.tagStart) - 1, 0)
      );
    }
  }

  return null;
}

function findMethodImplementationLocationInDef(
  document: vscode.TextDocument,
  position: vscode.Position,
  methodName: string,
  section: KBEngineSectionName,
  entityMappingManager?: EntityMappingManager
): vscode.ProviderResult<vscode.Location> {
  // 批110 用户令:无映射管理器(未开工程索引)时按文件约定回落:
  // scripts/<role>/<实体>.py 中的 `def <方法名>`。
  if (!entityMappingManager) {
    return findMethodScriptLocationInDef(document, methodName, section);
  }

  // 不可达(批110 定性):同一调用方已在段名过滤后才进入本函数。
  /* istanbul ignore start */
  if (!METHOD_SECTIONS.has(section)) {
    return null;
  }
  /* istanbul ignore stop */

  // 不可达(批62 定性):调用方(findEntityDefinitionInDef)已在同一 document+position
  // 上用同一个词取到 symbolInfo 并确认段名为方法段,ast 亦因取到 node 而必非 null。
  const ast = parseDefAst(document);
  const symbolInfo = findDefSymbolInfo(document, position, methodName);
  /* istanbul ignore start */
  if (!ast || !symbolInfo) {
    return null;
  }
  /* istanbul ignore stop */

  const line = getLineNumberAt(ast, symbolInfo.symbolNode.tagStart);
  // 根修令④同口径补齐(2026-10-12 用户令「跳转不了也弹出 log」):管理器
  // 路径每一臂都留痕,约定链也落空时给「期望位置」提示并落注册声明/def 首行,
  // 不再静默落 def 声明行(光标常已在该行,用户视角等同没跳)。
  const entityName = path.basename(document.fileName, '.def');
  const conventionLocation = (): vscode.Location | null => {
    const byConvention = findMethodScriptLocationInDef(
      document,
      methodName,
      section as EntityMethodSection
    );
    if (byConvention) {
      logNavigation(`方法落点(约定链) ${byConvention.uri.fsPath}:${byConvention.range.start.line}`);
    }
    return byConvention;
  };

  const hintRegistryFallback = (): vscode.Location => {
    const methodRole = METHOD_SECTION_SCRIPT_ROLES[section];
    // 不可达(根修令④ 定性):section 已过 METHOD_SECTIONS 过滤,与
    // METHOD_SECTION_SCRIPT_ROLES 键完全重合(口径同 :1556),methodRole 恒真。
    /* istanbul ignore start */
    const expected = describeExpectedScriptPaths(
      document,
      entityName,
      methodRole ? [methodRole] : ['base', 'cell', 'client']
    );
    /* istanbul ignore stop */
    void vscode.window.showInformationMessage(
      `方法 ${methodName} 未找到脚本实现,期望位置:${expected.join('、')}(辅助提示,已回落到注册声明/def 首行)`
    );
    return findRegistryFallbackLocation(document, entityName);
  };

  // 用户令(2026-10-20):identity 未命中/实现未绑定的两个早落分支按
  // **同名优先 → 全项目唯一命中 → 提示+注册回落** 三段解析(实现常在非同名 py 里)。
  const withGlobalFallback = (): vscode.ProviderResult<vscode.Location> => {
    const byConvention = conventionLocation();
    if (byConvention) {
      return byConvention;
    }
    // 特性检测:桩管理器/旧索引可能没有该方法,缺位时维持原提示+注册回落。
    if (typeof entityMappingManager.resolveMethodImplementationGlobally !== 'function') {
      return hintRegistryFallback();
    }
    // 2026-10-21:KBEngineSectionName 面比 EntityMethodSection 宽,先收敛再进域层。
    const defSection =
      section === 'BaseMethods' || section === 'CellMethods' ? section : undefined;
    return entityMappingManager.resolveMethodImplementationGlobally(methodName, defSection).then(glob => {
      if (glob) {
        logNavigation(`方法落点(全项目回退) ${glob.filePath}:${glob.line - 1}`);
        return new vscode.Location(
          vscode.Uri.file(glob.filePath),
          new vscode.Position(Math.max(glob.line - 1, 0), glob.character)
        );
      }
      return hintRegistryFallback();
    });
  };

  return entityMappingManager.resolveDefinitionSymbolAtPosition(
    document.fileName,
    line,
    methodName,
    section as EntityMethodSection
  ).then(identity => {
    if (!identity) {
      // 根修令①:索引未收录该符号(非标准布局的工程未纳入索引)时先按文件
      // 约定在 def 相对候选链里找实现,找不到才落注册声明/def 首行。
      logNavigation(`方法索引未收录 ${methodName}(${section}),按全项目回退/约定链回落`);
      return withGlobalFallback();
    }

    return entityMappingManager.resolveMethodImplementationByIdentity(identity).then(reference => {
      if (reference) {
        logNavigation(`方法落点(索引) ${reference.filePath}:${reference.line - 1}`);
        return new vscode.Location(
          vscode.Uri.file(reference.filePath),
          new vscode.Position(reference.line - 1, reference.character)
        );
      }

      // 根修令①:索引收录了符号但脚本未被索引(嵌套/非标准布局)→
      // 同上,def 相对候选链优先,注册声明/def 首行兜底。
      logNavigation(`方法索引未绑定实现 ${methodName},按全项目回退/约定链回落`);
      return withGlobalFallback();
    });
  }).then(reference => {
    // 不可达(批64 定性,合并扩展批62 区间):内层两臂(identity 缺失 / 实现
    // 未解析)都恒返回 Location,外层 then 收到的 reference 恒真——
    // `if (reference)` 的假臂与兜底 return 均无触发路径。被覆盖的
    // `return reference;` 亦随区间离开语句/行分母(TESTING.md 分母口径据实登记)。
    /* istanbul ignore start */
    if (reference) {
      return reference;
    }

    return new vscode.Location(
      document.uri,
      new vscode.Position(Math.max(line - 1, 0), 0)
    );
    /* istanbul ignore stop */
  });
}

function findDefinitionSiblingForParent(
  document: vscode.TextDocument,
  word: string
): string | null {
  const normalizedPath = document.uri.fsPath.replace(/\\/g, '/');
  if (normalizedPath.includes('/components/')) {
    const componentPath = findDefinitionFileByCategory(word, 'component', document);
    if (componentPath) {
      return componentPath;
    }
  }

  return findEntityDefinitionFile(word, document);
}

interface KnownTypeContext {
  builtins: Set<string>;
  customTypes: Set<string>;
  entityTypes: Set<string>;
}

interface KnownTypeSuggestion {
  name: string;
  detail: string;
  documentation: string;
}

function getKnownTypeContext(document: vscode.TextDocument, token?: vscode.CancellationToken): KnownTypeContext {
  const builtins = new Set(KBENGINE_TYPES.map(type => type.name));
  const workspaceRoot = getWorkspaceRootForDocument(document);

  if (!workspaceRoot) {
    return {
      builtins,
      customTypes: new Set<string>(),
      entityTypes: new Set<string>()
    };
  }

  return {
    builtins,
    customTypes: token?.isCancellationRequested ? new Set<string>() : getRegisteredCustomTypes(workspaceRoot),
    entityTypes: token?.isCancellationRequested ? new Set<string>() : new Set(getRegisteredEntities(workspaceRoot).map(entity => entity.name))
  };
}

function getKnownTypeSuggestions(document: vscode.TextDocument, token?: vscode.CancellationToken): KnownTypeSuggestion[] {
  const suggestions = new Map<string, KnownTypeSuggestion>();

  for (const type of KBENGINE_TYPES) {
    suggestions.set(type.name, {
      name: type.name,
      detail: type.detail,
      documentation: type.documentation
    });
  }

  const knownTypeContext = getKnownTypeContext(document, token);
  if (token?.isCancellationRequested) return [];
  for (const typeName of [...knownTypeContext.customTypes].sort()) {
    if (!suggestions.has(typeName)) {
      suggestions.set(typeName, {
        name: typeName,
        detail: 'Custom type',
        documentation: '来自 types.xml 的自定义类型。'
      });
    }
  }

  // 别名指向面(alias.xml;PR-012 门 G-C 关闭单):parity 复算面含别名而
  // provider 缺,致 Rust-only 差异;此处补面后 Rust 补全 ⊆ TS 面。
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (workspaceRoot && !token?.isCancellationRequested) {
    for (const [aliasName, aliasType] of [...getRegisteredAliasTypes(workspaceRoot)].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!suggestions.has(aliasName)) {
        suggestions.set(aliasName, {
          name: aliasName,
          detail: aliasType,
          documentation: '来自 alias.xml 的别名指向。'
        });
      }
    }
  }

  for (const entityName of [...knownTypeContext.entityTypes].sort()) {
    if (!suggestions.has(entityName)) {
      suggestions.set(entityName, {
        name: entityName,
        detail: 'Entity type',
        documentation: '来自 entities.xml 的实体类型引用。'
      });
    }
  }

  return [...suggestions.values()];
}

/**
 * 层2 python-mro 开关(kbengine.python.enableMroJump,默认开;用户 2026-10-17:
 * mixin 函数导航要可关——上一轮实测行为异常时,先关掉隔离该层再排查)。
 * extension 激活时读取、配置变更时刷新(与 kbengine.jumpLog 同款接线);
 * 关闭时层2 只记 skip,不触发全仓扫描。
 */
let pythonMroJumpEnabled = true;

export function setPythonMroJumpEnabled(enabled: boolean): void {
  pythonMroJumpEnabled = enabled;
}

export function isPythonMroJumpEnabled(): boolean {
  return pythonMroJumpEnabled;
}

/**
 * 跳转分层追踪(用户 2026-10-16「放弃范围必须逐层收窄,对象级不是文件级」):
 * 记录本次跳转查过的每一层与命中/落空原因,全部落空时可据此说明「查过哪些层」。
 */
export interface JumpLayerTrace {
  /**
   * entity-def = .def 派生索引(对象级类粒度 → 文件级 owner 归属两个子探);
   * python-mro = PythonClassIndex 跨文件 C3-MRO + 组合根;
   * file-scope = 当前文件类作用域 / 本文件 MRO;
   * kbe-stub / class-base / types-reverse = 前置契约分支(命中即终点);
   * member-access = 非 self 接收者成员调用(avatar.SendErrorInfo,批158);
   * context = 入参形态判定(既非 self 访问/成员调用也非方法声明)。
   */
  layer:
    | 'kbe-stub'
    | 'class-base'
    | 'types-reverse'
    | 'entity-def'
    | 'python-mro'
    | 'file-scope'
    | 'member-access'
    | 'context';
  /** 本层查询的符号(方法层为光标所在段/声明名,非根符号) */
  query: string;
  /** partial = 预算到期枚举不完整(IDE-IDX-018,python-mro 层),非权威 miss */
  status: 'hit' | 'miss' | 'skip' | 'partial';
  /** 命中落点或落空原因(object=<类名>/file=<文件名> 子探结果、异常等) */
  detail?: string;
}

export interface TracedDefinitionResult {
  location: vscode.Location | vscode.Location[] | null;
  layers: JumpLayerTrace[];
}

const cancelledDefinitionResult = (): TracedDefinitionResult => ({
  location: null,
  layers: [{ layer: 'context', query: '', status: 'skip', detail: 'cancelled' }]
});

const layerErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const describeMethodLocation = (candidate: PythonMethodLocation): string =>
  `${path.basename(candidate.filePath)}:${candidate.line + 1}` +
  (candidate.compositionRoot ? ` (root=${candidate.compositionRoot})` : '');

const toDefinitionLocation = (candidate: PythonMethodLocation): vscode.Location =>
  new vscode.Location(
    vscode.Uri.file(candidate.filePath),
    new vscode.Position(candidate.line, candidate.character)
  );

export class PythonDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private entityMappingManager: EntityMappingManager,
    // mixin/跨类跳转根因修复:.def 派生索引解析不到时(非实体文件或方法不在
    // 任何 .def),回退 Python 类层级 C3-MRO 解析 —— entityMapping.ts:573
    // 对非 .def 映射文件直接 return null 即丢定位处。
    private pythonClassIndex?: PythonClassIndex
  ) {}

  /**
   * VS Code 定义跳转入口:落点即分层解析的首个命中(层序见 provideDefinitionTraced)。
   */
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): Promise<vscode.Location | vscode.Location[] | null> {
    if (token?.isCancellationRequested) { return null; }
    const eventLocation = await eventDefinitionAt(document, position, this.entityMappingManager);
    if (token?.isCancellationRequested) { return null; }
    if (eventLocation) return eventLocation;
    return (await this.provideDefinitionTraced(document, position, token)).location;
  }

  /**
   * 分层追踪入口。放弃范围逐层收窄(用户 2026-10-16):
   * 前置契约分支(kbe 桩 / 类基类 / types implementedBy 反查,命中即终点)后,
   * 层1 entity-def:.def 派生索引,先对象级(类粒度)再文件级(owner 归属);
   * 层2 python-mro:PythonClassIndex 跨文件 C3-MRO + 组合根(异常降级落空,不断链);
   * 层3 file-scope:当前文件类作用域 / 本文件 MRO;
   * 属性访问和方法声明优先 .def；方法使用优先 Python 实现，找不到再回 .def；
   * 每层命中/落空/未执行与原因记入 layers,供测试与排障说明「查过哪些层」。
   */
  async provideDefinitionTraced(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): Promise<TracedDefinitionResult> {
    // PR1 打点:semantic-query = 分层语义解析全链路耗时(层序实现见
    // provideDefinitionTracedImpl),location 命中 → ok,落空 → miss;
    // 打点不改任何查找顺序与返回值。
    const metrics = startLanguageServiceOperation('semantic-query', {
      fileKind: 'python',
      documentVersion: document.version
    });
    try {
      const traced = await this.provideDefinitionTracedImpl(document, position, token);
      if (token?.isCancellationRequested) {
        metrics.end('cancelled');
        return cancelledDefinitionResult();
      }
      metrics.end(traced.location ? 'ok' : 'miss');
      return traced;
    } catch (error) {
      metrics.end('error');
      throw error;
    }
  }

  private async provideDefinitionTracedImpl(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): Promise<TracedDefinitionResult> {
    if (token?.isCancellationRequested) {
      return cancelledDefinitionResult();
    }
    const line = document.lineAt(position.line);
    if (!isPythonCodePosition(document.getText(), position.line, position.character)) {
      return { location: null, layers: [{ layer: 'context', query: '', status: 'skip', detail: 'comment or string literal' }] };
    }
    jumpLog('info', () =>
      `F12 ${document.fileName}:${position.line + 1}:${position.character + 1} ` +
        `行="${line.text.trim().slice(0, 160)}"`
    );

    // kbe/KBEngine 模块符号(批108):别名已在文档引入且 position 落在
    // 模块符号上时,跳到内置桩文档的对应声明行。未引入或非模块面访问
    // (self.kbe 之类)时交回下方实体属性/方法链路。
    const kbeAccess = resolveKbeAccessAtPosition(
      line.text,
      position.character,
      getKbeAliases(document.getText())
    );
    if (kbeAccess && getKbeSymbol(kbeAccess.symbol)) {
      const stub = buildKbeStubDocument();
      jumpLog('info', () => `前置命中 kbe-stub:${kbeAccess.symbol} → 内置桩`);
      return {
        location: new vscode.Location(
          vscode.Uri.parse(buildKbeStubUriString()),
          new vscode.Position(stub.symbolLines[kbeAccess.symbol], 0)
        ),
        layers: [{ layer: 'kbe-stub', query: kbeAccess.symbol, status: 'hit', detail: 'kbe module stub' }]
      };
    }

    // 类继承头基类(批109):class X(Base) 行,光标落在基类标识符上时沿
    // 注册链解析——①from-import 引入的 kbe 符号走内置桩文档;②登记实体走
    // entities.xml 链(def 文件优先,纯脚本实体回落 scripts/{base,cell,
    // client}/<Name>.py,与引擎同名类注册口径一致,见 docs/source-analysis.md
    // 第五节 D5/D7)。都未命中则交回下方 self 属性/方法链路与 python 扩展。
    const classBase = getPythonClassBaseAtPosition(line.text, position.character);
    const pythonBase = getPythonBaseExpressionAtPosition(document.getText(), position.line, position.character);
    const baseImports = pythonBase ? parsePythonFile(document.getText(), document.fileName).imports : undefined;
    const explicitlyImportedBase = !!pythonBase && baseImports?.has(pythonBase.split('.')[0]) === true;
    if (classBase) {
      const fromImports = getKbeFromImportedSymbols(document.getText());
      if (fromImports.has(classBase) && getKbeSymbol(classBase)) {
        const stub = buildKbeStubDocument();
        jumpLog('info', () => `前置命中 class-base:${classBase} → kbe from-import 桩`);
        return {
          location: new vscode.Location(
            vscode.Uri.parse(buildKbeStubUriString()),
            new vscode.Position(stub.symbolLines[classBase], 0)
          ),
          layers: [{ layer: 'class-base', query: classBase, status: 'hit', detail: 'kbe from-import stub' }]
        };
      }

    }

    // An explicit Python import binds the class name to that module. Resolve it
    // before KBEngine's basename-based .def/entity fallback, which can otherwise
    // send an aliased mixin to an unrelated entity with the same name.
    if (pythonBase && explicitlyImportedBase && this.pythonClassIndex && isPythonMroJumpEnabled()) {
      try {
        const base = await this.pythonClassIndex.resolveClassBase(document, pythonBase, position.line, token);
        if (base) {
          return {
            location: new vscode.Location(vscode.Uri.file(base.filePath), new vscode.Position(base.startLine, 0)),
            layers: [{ layer: 'class-base', query: pythonBase, status: 'hit', detail: `Python class ${base.qualifiedName ?? base.name}` }]
          };
        }
      } catch (error) {
        jumpLog('debug', () => `Python base lookup failed: ${layerErrorMessage(error)}`);
      }
    }

    if (classBase && !explicitlyImportedBase) {
      const baseDefPath = findEntityDefinitionFile(classBase, document);
      if (baseDefPath) {
        jumpLog('info', () => `前置命中 class-base:${classBase} → 实体 def ${path.basename(baseDefPath)}`);
        return {
          location: new vscode.Location(vscode.Uri.file(baseDefPath), new vscode.Position(0, 0)),
          layers: [{ layer: 'class-base', query: classBase, status: 'hit', detail: `entity def ${path.basename(baseDefPath)}` }]
        };
      }

      const baseProfile = getEntityRuntimeProfile(classBase, document);
      const baseScriptPath =
        baseProfile?.base.scriptPath || baseProfile?.cell.scriptPath || baseProfile?.client.scriptPath;
      if (baseScriptPath) {
        jumpLog('info', () => `前置命中 class-base:${classBase} → 实体脚本 ${path.basename(baseScriptPath)}`);
        return {
          location: new vscode.Location(vscode.Uri.file(baseScriptPath), new vscode.Position(0, 0)),
          layers: [{ layer: 'class-base', query: classBase, status: 'hit', detail: `entity script ${path.basename(baseScriptPath)}` }]
        };
      }
    }

    if (pythonBase && !explicitlyImportedBase && this.pythonClassIndex && isPythonMroJumpEnabled()) {
      try {
        const base = await this.pythonClassIndex.resolveClassBase(document, pythonBase, position.line, token);
        if (base) {
          return {
            location: new vscode.Location(vscode.Uri.file(base.filePath), new vscode.Position(base.startLine, 0)),
            layers: [{ layer: 'class-base', query: pythonBase, status: 'hit', detail: `Python class ${base.qualifiedName ?? base.name}` }]
          };
        }
      } catch (error) {
        jumpLog('debug', () => `Python base lookup failed: ${layerErrorMessage(error)}`);
      }
    }

    // types.xml implementedBy 反向跳转:光标落在被 types.xml 引用的符号上
    // (class/def/赋值或任意使用处)时跳回 implementedBy 行——正向跳得到
    // 去,反向跳得回来。模块按快照 pythonFilePath 比对定,不猜文件名。
    const reverseWorkspaceRoot =
      getWorkspaceRootForDocument(document) || getScanRootForFile(document.fileName);
    if (reverseWorkspaceRoot) {
      const reverseWordRange = document.getWordRangeAtPosition(position, /\w+/);
      if (reverseWordRange) {
        const reference = findTypesXmlImplementedByReference(
          reverseWorkspaceRoot,
          document.fileName,
          document.getText(reverseWordRange)
        );
        if (reference) {
          jumpLog('info', () => `前置命中 types-reverse:${document.getText(reverseWordRange)} → ${reference.filePath}:${reference.line}`);
          return {
            location: new vscode.Location(
              vscode.Uri.file(reference.filePath),
              new vscode.Position(reference.line - 1, 0)
            ),
            layers: [{
              layer: 'types-reverse',
              query: document.getText(reverseWordRange),
              status: 'hit',
              detail: `${path.basename(reference.filePath)}:${reference.line}`
            }]
          };
        }
      }
    }

    const access = getPythonSelfAccessAtPosition(line.text, position.character);
    const declaredMethodName = getPythonMethodDeclarationAtPosition(line.text, position.character);
    // 接收者感知(用户令 2026-10-21):光标落在 self.cell./self.base./self.client.
    // 的方法名上时,候选先按段过滤(CellMethods/BaseMethods/ClientMethods),
    // 段不符不跳;链前缀只认 self. 形态,解析自调用行文本。
    // kbengine.entity.receiverSections=false → 回归不感知段的旧解析(不传
    // receiver);形参/类型闸门是纠错不是增强,不随此开关关闭。
    const receiverCall =
      access && getLanguageFeatureConfig().entityReceiverSections
        ? getPythonReceiverCallAtPosition(line.text, position.character)
        : null;
    if (access) {
      const accessResult = await this.runDefinitionLayers(document, position, access, null, receiverCall ?? undefined, token);
      if (accessResult.location) {
        return accessResult;
      }
      // 光标行同时是方法声明的交叠形态:再走声明层序,层记录合并
      if (declaredMethodName) {
        const declaredResult = await this.runDefinitionLayers(document, position, null, declaredMethodName, undefined, token);
        return {
          location: declaredResult.location,
          layers: [...accessResult.layers, ...declaredResult.layers]
        };
      }
      return accessResult;
    }
    if (declaredMethodName) {
      return this.runDefinitionLayers(document, position, null, declaredMethodName, undefined, token);
    }
    // 批158(用户令 2026-10-26):非 self 接收者的成员调用 avatar.SendErrorInfo(...)
    // 不再直接放弃。旧口径在 context 层返回 null(用户实测「精确跳转不行」的根因);
    // 新增 member-access 层:接收者名 → 全项目唯一同名 .def 实体 → 方法声明行;
    // 无同名实体时不误跳,维持 null(仅层记录不同)。
    const memberAccess = getPythonMemberAccessAtPosition(line.text, position.character);
    if (memberAccess) {
      return this.resolveMemberAccess(document, memberAccess);
    }
    jumpLog('info', () => '跳转放弃: 光标既非 self 访问/成员调用也非方法声明(context)');
    const wordRange = document.getWordRangeAtPosition(position, /\w+/);
    return {
      location: null,
      layers: [
        {
          layer: 'context',
          query: wordRange ? document.getText(wordRange) : '',
          status: 'miss',
          detail: 'position is neither self access nor method declaration'
        }
      ]
    };
  }

  /**
   * 批158 member-access 层:非 self 接收者成员调用的定义解析
   * (avatar.SendErrorInfo)。接收者名在 KBEngine 语义里即实体名(实体变量命名
   * 惯例与实体同名,如 avatar: Avatar);解析链:
   * ①全项目唯一同名 .def 实体(Avatar.def)→ 该 def 内方法声明行(段不过滤,
   *   方法在 Base/Cell/Client 任一段都算命中);
   * ②接收者名同时是当前文件内可见的 Python 类名(同文件/import)且该类有同名
   *   方法 → 类声明处。
   * 找不到同名实体/类时不误跳(返回 null + 层记录),绝不静默落别的实体。
   */
  private async resolveMemberAccess(
    document: vscode.TextDocument,
    access: PythonMemberAccess
  ): Promise<TracedDefinitionResult> {
    const query = access.memberName;
    jumpLog('info', () => `member-access 层: ${access.fullPath}(接收者=${access.receiverName})`);

    // ① 接收者名 → 同名实体 def 的方法声明(对象级,复用类粒度 API)。
    // KBEngine 变量命名惯例:实体变量小驼峰(avatar)与实体名帕斯卡(Avatar)
    // 同形,精确名未命中时按首字母大写变体再试一次;两者都不中不误跳。
    const entityCandidates = [access.receiverName];
    const capitalized = access.receiverName.charAt(0).toUpperCase() + access.receiverName.slice(1);
    if (capitalized !== access.receiverName) {
      entityCandidates.push(capitalized);
    }
    let defHit: { defFile: string; line: number } | null = null;
    let matchedEntity = access.receiverName;
    for (const candidate of entityCandidates) {
      const hit = await this.entityMappingManager.resolveMethodDefinitionForClass(
        candidate,
        query,
        undefined,
        document.fileName
      );
      if (hit) {
        defHit = hit;
        matchedEntity = candidate;
        break;
      }
    }
    if (defHit) {
      const hitFile = defHit.defFile;
      const hitLine = defHit.line;
      jumpLog('info', () =>
        `member-access 命中 def: ${path.basename(hitFile)}:${hitLine}`
      );
      return {
        location: new vscode.Location(
          vscode.Uri.file(hitFile),
          new vscode.Position(Math.max(hitLine - 1, 0), 0)
        ),
        layers: [
          {
            layer: 'member-access',
            query,
            status: 'hit',
            detail: `entity=${matchedEntity} def=${path.basename(hitFile)}:${hitLine}`
          }
        ]
      };
    }

    // ② 接收者名 = 当前文件内可见类名 → 同名方法声明(本文件作用域)。
    // IDE-IDX-017:答案本就只来自当前文档(旧路径取索引同文件类后仍重解析
    // 现文档复核),改为直查当前文件快照——不经 findClassesByName 的
    // ensureScanned,全仓扫描挂起时同文件 Class.method 跳转不受拖累。
    if (this.pythonClassIndex) {
      try {
        const parsed = parsePythonFile(document.getText(), document.fileName);
        const cls = parsed.classes.find(item => item.name === access.receiverName);
        const method = cls?.methods.get(query);
        if (method) {
          jumpLog('info', () =>
            `member-access 命中类: ${access.receiverName}.${query} @ ${path.basename(document.fileName)}:${method.line + 1}`
          );
          return {
            location: new vscode.Location(
              vscode.Uri.file(document.fileName),
              new vscode.Position(method.line, method.character)
            ),
            layers: [
              {
                layer: 'member-access',
                query,
                status: 'hit',
                detail: `class=${access.receiverName}.${query}`
              }
            ]
          };
        }
      } catch (error) {
        jumpLog('debug', () => `member-access 类回退失败: ${layerErrorMessage(error)}`);
      }
    }

    jumpLog('info', () => `member-access 落空: ${access.fullPath}(无同名实体/类方法)`);
    return {
      location: null,
      layers: [
        {
          layer: 'member-access',
          query,
          status: 'miss',
          detail: `receiver=${access.receiverName} has no matching entity def or class method`
        }
      ]
    };
  }

  /**
   * 属性声明优先；方法使用先尝试 Python 实现，再回退 .def 声明。
   * 多段访问必须有 receiver 类型证据，不能把 obj.method 当成 self.method。
   */
  private async runDefinitionLayers(
    document: vscode.TextDocument,
    position: vscode.Position,
    access: { rootSymbol: string; currentSymbol: string; fullPath: string } | null,
    declaredMethodName: string | null,
    receiver?: PythonReceiverCall,
    token?: vscode.CancellationToken
  ): Promise<TracedDefinitionResult> {
    if (token?.isCancellationRequested) { return cancelledDefinitionResult(); }
    const manager = this.entityMappingManager;
    // 查询符号 = 光标所在段(方法层不再查根符号——根对象不在 .def 时不连带断链);
    // 属性子探的完整访问路径(可能多段)记入 detail。
    const symbol = access ? access.currentSymbol : (declaredMethodName as string);
    const query = symbol;
    const basename = path.basename(document.fileName);
    const layers: JumpLayerTrace[] = [];
    const totalTimer = jumpTimeStart();

    // 对象上下文:光标所在类 —— 对象级 .def 判定的输入。直接解析当前文档
    // 文本(单文件,不触发 PythonClassIndex 的全仓扫描:.def 命中路径因此
    // 保持与旧实现同量级,不因对象级探而变慢);取不到不中断(退化文件级)。
    let enclosingName: string | undefined;
    let enclosingNote = '';
    try {
      const parsed = parsePythonFile(document.getText(), document.fileName);
      const enclosing = parsed.classes
        .filter(cls => position.line >= cls.startLine && position.line < cls.endLine)
        .sort((left, right) => right.startLine - left.startLine)[0];
      if (enclosing) {
        enclosingName = enclosing.name;
      } else {
        enclosingNote = 'no enclosing class';
      }
    } catch (error) {
      enclosingNote = `enclosing class error: ${layerErrorMessage(error)}`;
    }
    jumpLog('info', () =>
      `解析开始 query=${symbol} 文件=${basename}:${position.line + 1} ` +
        `对象类=${enclosingName ?? `(无:${enclosingNote})`}`
    );
    const defTimer = jumpTimeStart();

    // ── 层0 接收者段闸(用户令 2026-10-21):self.cell./self.base./self.client.
    // 调用的候选只认对应区块(CellMethods/BaseMethods/ClientMethods)的 def 声明,
    // 段不符不跳;属性子探不做(接收者段不是属性),段过滤先行于一切后续闸。
    // 实现层(python-mro/file-scope)不感知段,命中段内声明后直接落 def 声明行。
    if (receiver) {
      const receiverParts: string[] = [`receiver=self.${receiver.receiver} → ${receiver.section}`];
      const receiverProbes: Array<{
        via: string;
        run: () => Promise<{ defFile: string; line: number } | null>;
      }> = [];
      if (enclosingName) {
        receiverProbes.push({
          via: `object=${enclosingName}`,
          run: () =>
            manager.resolveMethodDefinitionForClass(
              enclosingName as string,
              symbol,
              receiver.section,
              document.fileName
            )
        });
      }
      receiverProbes.push({
        via: `file=${basename}`,
        run: () => manager.resolveMethodDefinition(document.fileName, symbol, receiver.section)
      });
      for (const probe of receiverProbes) {
        let hit: { defFile: string; line: number } | null;
        try {
          hit = await probe.run();
        } catch (error) {
          receiverParts.push(`method ${probe.via} error=${layerErrorMessage(error)}`);
          continue;
        }
        if (token?.isCancellationRequested) { return cancelledDefinitionResult(); }
        if (hit) {
          const hitLocation = new vscode.Location(
            vscode.Uri.file(hit.defFile),
            new vscode.Position(hit.line - 1, 0)
          );
          receiverParts.push(`method ${probe.via} hit ${path.basename(hit.defFile)}:${hit.line}`);
          jumpLog('info', () =>
            `层0 接收者段闸命中(${receiver.section}) → ${hitLocation.uri.fsPath}:${hitLocation.range.start.line + 1} ${defTimer()}ms`
          );
          return {
            location: hitLocation,
            layers: [{ layer: 'entity-def', query, status: 'hit', detail: receiverParts.join('; ') }]
          };
        }
        receiverParts.push(`method ${probe.via} miss`);
      }
      jumpLog('info', () =>
        `层0 接收者段闸落空(${receiver.section} 无候选) ${defTimer()}ms`
      );
      return {
        location: null,
        layers: [{ layer: 'entity-def', query, status: 'miss', detail: receiverParts.join('; ') }]
      };
    }

    // ── 层1 entity-def:对象级(类粒度)→ 文件级(owner 归属);属性子探在前(契约) ──
    const defParts: string[] = [];
    let defLocation: vscode.Location | null = null;
    let propertyHit = false;
    let propertyTypeLocation: vscode.Location | null = null;

    if (access) {
      const propertyProbes: Array<{
        via: string;
        run: () => Promise<{ defFile: string; line: number } | null>;
      }> = [];
      if (enclosingName) {
        propertyProbes.push({
          via: `object=${enclosingName}`,
          run: () =>
            manager.resolvePropertyDefinitionForClass(
              enclosingName as string,
              access.fullPath,
              access.rootSymbol,
              document.fileName
            )
        });
      }
      propertyProbes.push({
        via: `file=${basename}`,
        run: () => manager.resolvePropertyDefinition(document.fileName, access.fullPath, access.rootSymbol)
      });
      for (const probe of propertyProbes) {
        let hit: { defFile: string; line: number } | null;
        try {
          hit = await probe.run();
        } catch (error) {
          defParts.push(`property(${access.fullPath}) ${probe.via} error=${layerErrorMessage(error)}`);
          continue;
        }
        if (token?.isCancellationRequested) { return cancelledDefinitionResult(); }
        if (hit) {
          defLocation = new vscode.Location(
            vscode.Uri.file(hit.defFile),
            new vscode.Position(hit.line - 1, 0)
          );
          const workspaceRoot = getWorkspaceRootForDocument(document)
            || getScanRootForFile(document.fileName);
          const managerWithScan = manager as EntityMappingManager & { waitForInitialScan?: () => Promise<void> };
          if (managerWithScan.waitForInitialScan) {
            // 首扫超时闸(用户令 2026-10-22):大树首扫可秒级+,不拖死跳转层
            await withInitialScanTimeout(managerWithScan.waitForInitialScan(), undefined, token);
            if (token?.isCancellationRequested) { return cancelledDefinitionResult(); }
          }
          const indexAccessor = manager as EntityMappingManager & {
            getIndex?: (entityName: string) => EntityMappingIndex | undefined;
            getIndexForPythonFile?: (pythonFile: string) => EntityMappingIndex | undefined;
          };
          const mapping = enclosingName
            ? indexAccessor.getIndex?.(enclosingName) || indexAccessor.getIndexForPythonFile?.(document.fileName)
            : indexAccessor.getIndexForPythonFile?.(document.fileName);
          const typeName = Object.values(mapping?.propertyDefinitions ?? [])
            .find(definition => definition.identity.symbolName === access.currentSymbol)
            ?.typeName;
          if (typeName && workspaceRoot) {
            const typeDeclaration = findCustomTypeDeclarationInfo(typeName, workspaceRoot);
            if (typeDeclaration) {
              propertyTypeLocation = new vscode.Location(
                vscode.Uri.file(typeDeclaration.filePath),
                new vscode.Position(typeDeclaration.line - 1, 0)
              );
            }
          }
          propertyHit = true;
          defParts.push(`property(${access.fullPath}) ${probe.via} hit ${path.basename(hit.defFile)}:${hit.line}`);
          break;
        }
        defParts.push(`property(${access.fullPath}) ${probe.via} miss`);
      }
    }

    // A member of self.component is not a method on self. Until its receiver
    // type is known, leave it to the Python language server rather than guessing.
    if (!defLocation && access && access.currentSymbol !== access.rootSymbol) {
      return { location: null, layers: [{ layer: 'entity-def', query, status: 'miss',
        detail: 'nested receiver type is unknown; ' + defParts.join('; ') }] };
    }

    if (!defLocation) {
      const methodProbes: Array<{
        via: string;
        run: () => Promise<{ defFile: string; line: number } | null>;
      }> = [];
      if (enclosingName) {
        methodProbes.push({
          via: `object=${enclosingName}`,
          run: () => manager.resolveMethodDefinitionForClass(enclosingName as string, symbol, undefined, document.fileName)
        });
      }
      methodProbes.push({
        via: `file=${basename}`,
        run: () => manager.resolveMethodDefinition(document.fileName, symbol)
      });
      for (const probe of methodProbes) {
        let hit: { defFile: string; line: number } | null;
        try {
          hit = await probe.run();
        } catch (error) {
          defParts.push(`method ${probe.via} error=${layerErrorMessage(error)}`);
          continue;
        }
        if (token?.isCancellationRequested) { return cancelledDefinitionResult(); }
        if (hit) {
          defLocation = new vscode.Location(
            vscode.Uri.file(hit.defFile),
            new vscode.Position(hit.line - 1, 0)
          );
          defParts.push(`method ${probe.via} hit ${path.basename(hit.defFile)}:${hit.line}`);
          break;
        }
        defParts.push(`method ${probe.via} miss`);
      }
    }

    const implementationFirst = !!access && !propertyHit;
    if (defLocation && !implementationFirst) {
      const detail = defParts.join('; ');
      // 闭包内 TS 不收窄 let:命中位置先固化为 const 再进日志闭包
      const hitLocation = defLocation;
      layers.push({ layer: 'entity-def', query, status: 'hit', detail });
      jumpLog('info', () =>
        `层1 entity-def 命中 → ${hitLocation.uri.fsPath}:${hitLocation.range.start.line + 1}` +
          `(${detail.slice(0, 200)}) ${defTimer()}ms`
      );
      return { location: propertyTypeLocation ?? defLocation, layers };
    }
    const defDetail = defParts.join('; ') || enclosingNote || 'no .def index';
    layers.push({
      layer: 'entity-def',
      query,
      status: defLocation ? 'skip' : 'miss',
      detail: defLocation ? `deferred method declaration; ${defDetail}` : defDetail
    });
    jumpLog('info', () => `层1 entity-def ${defLocation ? '暂存方法声明，先查实现' : '落空'}(${defDetail.slice(0, 200)}) ${defTimer()}ms`);
    const pyTimer = jumpTimeStart();

    // ── 层2 python-mro:跨文件 MRO + 组合根;异常降级为落空,绝不在本层断链 ──
    if (!isPythonMroJumpEnabled()) {
      layers.push({ layer: 'python-mro', query: symbol, status: 'skip', detail: 'disabled by kbengine.python.enableMroJump' });
      jumpLog('info', () => '层2 python-mro 跳过(设置关闭)');
    } else if (!this.pythonClassIndex) {
      layers.push({ layer: 'python-mro', query: symbol, status: 'skip', detail: 'python class index unavailable' });
      jumpLog('info', () => '层2 python-mro 跳过(索引未注入)');
    } else {
      try {
        // IDE-IDX-018:取带 partial 标记的完整结果——预算到期只拿到静态目标时
        // 不得把这枚(可能是空的)候选集发布成完整枚举的权威负结论。
        const resolution = await this.pythonClassIndex.resolveSelfMethodResolution(
          document.fileName,
          position.line,
          symbol,
          document,
          token
        );
        const resolved = resolution.candidates;
        const partialNote = resolution.partial ? ' (partial: budget expired)' : '';
        const candidates = declaredMethodName ? resolved.filter(candidate =>
          candidate.filePath !== document.fileName || candidate.line !== position.line) : resolved;
        if (candidates.length === 1) {
          const detail = describeMethodLocation(candidates[0]) + partialNote;
          layers.push({ layer: 'python-mro', query: symbol, status: 'hit', detail });
          jumpLog('info', () =>
            `层2 python-mro 命中 → ${candidates[0].filePath}:${candidates[0].line + 1}` +
              `(${detail.slice(0, 160)}) ${pyTimer()}ms`
          );
          return { location: toDefinitionLocation(candidates[0]), layers };
        }
        if (candidates.length > 1) {
          layers.push({
            layer: 'python-mro',
            query: symbol,
            status: 'hit',
            detail: `${candidates.length} candidates: ${candidates.map(describeMethodLocation).join(', ')}${partialNote}`
          });
          jumpLog('info', () =>
            `层2 python-mro 命中 ${candidates.length} 候选 → [${candidates
              .map(describeMethodLocation)
              .join(' | ')
              .slice(0, 300)}] ${pyTimer()}ms`
          );
          return { location: candidates.map(toDefinitionLocation), layers };
        }
        if (resolution.partial) {
          // IDE-IDX-018:预算到期枚举不完整——落空不是权威负结论,记 partial,
          // 继续走后续层兜底;下次查询预算/索引就绪后自然补齐。
          layers.push({
            layer: 'python-mro',
            query: symbol,
            status: 'partial',
            detail: 'budget expired before full enumeration'
          });
          jumpLog('info', () => `层2 python-mro 预算到期,记 partial 不作权威落空 ${pyTimer()}ms`);
        } else {
          const missDetail = enclosingName
            ? 'no provider in mro/composition-roots/descendants'
            : enclosingNote || 'no enclosing class';
          layers.push({ layer: 'python-mro', query: symbol, status: 'miss', detail: missDetail });
          jumpLog('info', () => `层2 python-mro 落空(${missDetail}) ${pyTimer()}ms`);
        }
      } catch (error) {
        const missDetail = `error: ${layerErrorMessage(error)}`;
        layers.push({ layer: 'python-mro', query: symbol, status: 'miss', detail: missDetail });
        jumpLog('info', () => `层2 python-mro 异常降级为落空(${missDetail.slice(0, 160)})`);
      }
    }
    const fileScopeTimer = jumpTimeStart();

    // ── 层3 file-scope:当前文件类作用域 / 本文件 MRO(索引缺此文件时的兜底) ──
    try {
      const fileScope = this.resolveFileScope(document, position.line, symbol, declaredMethodName !== null);
      layers.push({
        layer: 'file-scope',
        query: symbol,
        status: fileScope.location ? 'hit' : 'miss',
        detail: fileScope.detail
      });
      if (fileScope.location) {
        // 闭包内 TS 不收窄:命中行先固化为 const 再进日志闭包
        const hitLine = (Array.isArray(fileScope.location) ? fileScope.location[0] : fileScope.location).range.start.line;
        jumpLog('info', () =>
          `层3 file-scope 命中 → ${document.fileName}:${hitLine + 1}` +
            `(${fileScope.detail.slice(0, 160)}) ${fileScopeTimer()}ms`
        );
        return { location: fileScope.location, layers };
      }
      jumpLog('info', () => `层3 file-scope 落空(${fileScope.detail.slice(0, 200)}) ${fileScopeTimer()}ms`);
    } catch (error) {
      layers.push({
        layer: 'file-scope',
        query: symbol,
        status: 'miss',
        detail: `parse error: ${layerErrorMessage(error)}`
      });
    }

    if (defLocation) {
      layers.push({ layer: 'entity-def', query, status: 'hit', detail: 'Python implementation unavailable; use declaration' });
      jumpLog('info', () => `Python 实现未找到，回退 .def 声明(query=${symbol})`);
      return { location: defLocation, layers };
    }
    jumpLog('info', () => `跳转放弃: 三层全落空(query=${symbol}) 总耗时 ${totalTimer()}ms`);
    return { location: null, layers };
  }

  /**
   * 层3:直接解析当前文档文本(不依赖索引扫描)。顺序:光标所在类自身 →
   * 同文件内的基类(本文件 MRO)→ 真实后代的全部候选；排除无关类和声明自身行。
   */
  private resolveFileScope(
    document: vscode.TextDocument,
    line: number,
    symbol: string,
    excludeSelfLine: boolean
  ): { location: vscode.Location | vscode.Location[] | null; detail: string } {
    const parsed = parsePythonFile(document.getText(), document.fileName);
    const enclosing = parsed.classes
      .filter(cls => line >= cls.startLine && line < cls.endLine)
      .sort((left, right) => right.startLine - left.startLine)[0];
    const chain: Array<{ cls: PythonClassDef; how: string }> = [];
    if (enclosing) {
      const mro = linearizeC3(enclosing.qualifiedName ?? enclosing.name, name =>
        parsed.classes.filter(cls => (cls.qualifiedName ?? cls.name) === name));
      for (const name of mro) {
        const cls = parsed.classes.find(item => (item.qualifiedName ?? item.name) === name);
        if (cls) { chain.push({ cls, how: cls === enclosing ? 'same class' : `file-local base ${name}` }); }
      }
    }
    for (const item of chain) {
      const loc = item.cls.methods.get(symbol);
      if (!loc) {
        continue;
      }
      if (excludeSelfLine && loc.line === line) {
        continue;
      }
      return {
        location: new vscode.Location(
          vscode.Uri.file(document.fileName),
          new vscode.Position(loc.line, loc.character)
        ),
        detail: `${item.how}: ${item.cls.name}`
      };
    }
    if (enclosing) {
      const locations = new Map<string, vscode.Location>();
      for (const cls of parsed.classes) {
        if (cls === enclosing) { continue; }
        const mro = linearizeC3(cls.qualifiedName ?? cls.name, name =>
          parsed.classes.filter(item => (item.qualifiedName ?? item.name) === name));
        if (!mro.includes(enclosing.qualifiedName ?? enclosing.name)) { continue; }
        for (const name of mro) {
          const provider = parsed.classes.find(item => (item.qualifiedName ?? item.name) === name);
          const loc = provider?.methods.get(symbol);
          if (!loc || (excludeSelfLine && loc.line === line)) { continue; }
          locations.set(`${loc.line}:${loc.character}`, new vscode.Location(vscode.Uri.file(document.fileName), new vscode.Position(loc.line, loc.character)));
          break;
        }
      }
      if (locations.size) {
        const candidates = [...locations.values()];
        return { location: candidates.length === 1 ? candidates[0] : candidates,
          detail: `file-local descendants: ${candidates.length} implementation(s)` };
      }
    }
    return {
      location: null,
      detail: enclosing
        ? `class ${enclosing.name} (of ${parsed.classes.length} classes in file) does not define ${symbol}`
        : `no enclosing class; no class in file defines ${symbol}`
    };
  }
}

export class RpcCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  constructor(private entityMappingManager: EntityMappingManager) {}

  // 批154(用户令 CodeLens/Hover「按功能拆分,每枚独立开关」):RPC 镜链
  // 一枚独立开关(kbengine.codeLens.rpc),关只熄这一类,不牵连事件回调/
  // 属性/types.xml 各自的镜链;开关变更由 extension 配置监听 fire 即时生效
  fireConfigurationChanged(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const cancelled = () => !!token?.isCancellationRequested || document.isClosed;
    if (cancelled() || !getLanguageFeatureConfig().codeLensRpc) {
      return [];
    }
    const declarations = findPythonMethodDeclarations(document.getText());

    // 同名方法只解析一次:闭包脚本里同名方法可能重复出现,而解析结果
    // (是否 def 声明 + 声明位置)与方法名一一对应,按名缓存无歧义
    const hits = new Map<string, RpcMethodHit>();
    // def 声明的 <Arg> 类型序列(按方法名;未声明为 undefined,不作闸门)
    const declaredArgTypesByName = new Map<string, string[]>();
    for (const declaration of declarations) {
      if (cancelled()) return [];
      if (hits.has(declaration.methodName)) {
        continue;
      }
      const location = await this.entityMappingManager.resolveMethodDefinition(
        document.fileName,
        declaration.methodName
      );
      if (cancelled()) return [];
      if (location) {
        hits.set(declaration.methodName, {
          methodName: declaration.methodName,
          section: location.section,
          defFile: location.defFile,
          defLine: location.line,
          exposed: location.exposed
        });
        if (location.declaredArgs && location.declaredArgs.length > 0) {
          declaredArgTypesByName.set(declaration.methodName, location.declaredArgs);
        }
      }
    }

    // 形参闸门(用户令:只凭名字标 RPC 不严谨):def 声明了 <Arg> 时,被标
    // lens 的 python def 行形参个数必须相等、有注解的按内建映射对上类型,
    // 不符则该行不出 lens;未声明 <Arg> 维持现状。闸门本体与全项目回退
    // 扫描同源(EntityMappingManager.pythonSignatureMatchesDeclaredArgs)。
    const documentLines = document.getText().split(/\r?\n/);
    // 形参闸与 hover 同链(用户令 2026-10-21):注解按统一解析链对账
    const lensWorkspaceRoot = getWorkspaceRootForDocument(document);
    const resolveAnnotation = (raw: string): string =>
      resolveEntityAnnotationType(lensWorkspaceRoot ?? '', raw);
    const gatedDeclarations = declarations.filter(declaration => {
      const declaredArgTypes = declaredArgTypesByName.get(declaration.methodName);
      if (!declaredArgTypes) {
        return true;
      }
      return EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
        declaredArgTypes,
        documentLines,
        declaration.line,
        resolveAnnotation
      );
    });

    const rpcLenses = buildRpcCodeLenses(gatedDeclarations, methodName => hits.get(methodName)).map(spec =>
      new vscode.CodeLens(
        new vscode.Range(
          new vscode.Position(spec.declaration.line, spec.declaration.character),
          new vscode.Position(
            spec.declaration.line,
            spec.declaration.character + spec.hit.methodName.length
          )
        ),
        {
          title: spec.title,
          command: KBENGINE_SOURCE_REVEAL_COMMAND,
          arguments: [
            vscode.Uri.file(spec.hit.defFile),
            { selection: createDefinitionSelection(spec.hit.defLine) }
          ]
        }
      )
    );

    // 接收者感知(用户令 2026-10-21):self.cell./self.base./self.client. 调用行
    // 的 RPC 镜。段过滤在解析内先行(resolveMethodDefinition 第三参,只留对应
    // 区块的 def 候选)——段不符解析落空,不出镜;段符合照常出镜、点击跳声明。
    // 形参闸不适用调用行(闸门本体对账的是 def 声明行签名)。
    // kbengine.entity.receiverSections=false 时不出接收者镜。
    const receiverLenses: vscode.CodeLens[] = [];
    const receiverCalls = getLanguageFeatureConfig().entityReceiverSections
      ? findPythonReceiverCalls(document.getText())
      : [];
    if (receiverCalls.length > 0) {
      const receiverHits = new Map<string, RpcMethodHit | null>();
      for (const call of receiverCalls) {
        if (cancelled()) return [];
        const key = `${call.section}::${call.methodName}`;
        if (receiverHits.has(key)) {
          continue;
        }
        let hit: RpcMethodHit | null = null;
        try {
          const location = await this.entityMappingManager.resolveMethodDefinition(
            document.fileName,
            call.methodName,
            call.section
          );
          if (location) {
            hit = {
              methodName: call.methodName,
              section: location.section,
              defFile: location.defFile,
              defLine: location.line,
              exposed: location.exposed
            };
          }
        } catch {
          hit = null;
        }
        if (cancelled()) return [];
        receiverHits.set(key, hit);
      }
      for (const call of receiverCalls) {
        const hit = receiverHits.get(`${call.section}::${call.methodName}`);
        if (!hit) {
          continue;
        }
        receiverLenses.push(
          new vscode.CodeLens(
            new vscode.Range(
              new vscode.Position(call.line, call.character),
              new vscode.Position(call.line, call.character + call.methodName.length)
            ),
            {
              title: defaultRpcCodeLensTitle(hit),
              command: KBENGINE_SOURCE_REVEAL_COMMAND,
              arguments: [
                vscode.Uri.file(hit.defFile),
                { selection: createDefinitionSelection(hit.defLine) }
              ]
            }
          )
        );
      }
    }

    return cancelled() ? [] : [...rpcLenses, ...receiverLenses];
  }
}

export function createDefinitionSelection(defLine: number): vscode.Range {
  const position = new vscode.Position(defLine - 1, 0);
  return new vscode.Range(position, position);
}

// 批135:属性访问标记。Python 脚本里没有类型名可写(脚本即代码,与 RPC 那
// 套「实现里看不出」不同),可行等价是 self.<属性> 访问处出一行 CodeLens,标
// def 声明的类型与可见域,点击回 def 声明行。解析走属性 F12 同一索引
// (resolvePropertyDefinitionInfo),def 侧信息零重复解析。只认 self.<属性>
// 形态,与 F12 口径一致。
export class PropertyCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  constructor(private entityMappingManager: EntityMappingManager) {}

  // 批154:属性访问镜链一枚独立开关(kbengine.codeLens.property)
  fireConfigurationChanged(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const cancelled = () => !!token?.isCancellationRequested || document.isClosed;
    if (cancelled() || !getLanguageFeatureConfig().codeLensProperty) {
      return [];
    }
    const accesses = findPythonSelfPropertyAccesses(document.getText());

    // 同一属性多处访问只解析一次:解析结果按 (根段, 完整路径) 一一对应
    const hits = new Map<string, PropertyCodeLensHit | null>();
    for (const access of accesses) {
      if (cancelled()) return [];
      const key = propertyAccessKey(access);
      if (hits.has(key)) {
        continue;
      }
      const location = await this.entityMappingManager.resolvePropertyDefinitionInfo(
        document.fileName,
        access.fullPath,
        access.rootSymbol
      );
      if (cancelled()) return [];
      hits.set(key, location
        ? {
            propertyName: location.identity.symbolName,
            componentSlotName: location.identity.componentSlotName,
            typeName: location.typeName ?? null,
            domains: location.domains,
            persistent: location.persistent,
            defFile: location.defFile,
            defLine: location.line
          }
        : null);
    }

    return buildPropertyCodeLenses(accesses, access => hits.get(propertyAccessKey(access))).map(
      spec =>
        new vscode.CodeLens(
          new vscode.Range(
            new vscode.Position(spec.access.line, spec.access.character),
            new vscode.Position(
              spec.access.line,
              spec.access.character + spec.access.rootSymbol.length
            )
          ),
          {
            title: spec.title,
            command: KBENGINE_SOURCE_REVEAL_COMMAND,
            arguments: [
              vscode.Uri.file(spec.hit.defFile),
              { selection: createDefinitionSelection(spec.hit.defLine) }
            ]
          }
        )
    );
  }
}

// 批134:types.xml 类型声明行的引用反扫。一条真实使用出一枚镜(使用处
// 实体.属性 → 落库表.列),点击走 kbengine.database.open 打开 schema 文档
// 并定位到对应列;超过上限折叠成计数镜;类型无引用不出镜。
export interface TypesXmlStorageLensSpec {
  line: number;
  character: number;
  title: string;
  target: { entity: string; table: string; column: string } | null;
}

const TYPE_STORAGE_LENS_LIMIT = 10;

export function buildTypesXmlStorageLensSpecs(
  content: string,
  workspaceRoot: string,
  typesXmlPath = getDefinitionWorkspaceLayout(workspaceRoot).typesXmlPath
): TypesXmlStorageLensSpec[] {
  const document = parseDefDocument(content);
  if (!document.root) {
    return [];
  }

  // IDE-SCH-009:渲染只读已发布聚合(暖渲染零快照探测),新鲜度由
  // watcher 事件面承担;无状态时只读面自行冷构建一次
  const usageIndex = getTypeStorageUsageIndexReadOnly(workspaceRoot);
  const usagesBySourceLine = typesXmlPath
    ? indexTypeStorageUsageEntries(usageIndex, typesXmlPath)
    : new Map<number, TypeStorageUsage[]>();
  const specs: TypesXmlStorageLensSpec[] = [];
  for (const node of getDirectChildElements(document.root)) {
    const usages = usageIndex.get(node.name) || [];
    const firstLine = getLineNumberAt(document, node.tagStart);
    const lastLine = getLineNumberAt(document, node.closeTagEnd);
    const expandedUsages: TypeStorageUsage[] = [];
    for (let line = firstLine; line <= lastLine; line += 1) {
      expandedUsages.push(...(usagesBySourceLine.get(line) || []));
    }
    const seen = new Set<string>();
    const appendUsage = (title: string, usage: (typeof usages)[number]): void => {
      const key = `${usage.entity}:${usage.table}:${usage.column}`;
      if (seen.has(key) || seen.size >= TYPE_STORAGE_LENS_LIMIT) {
        return;
      }
      seen.add(key);
      const position = getLineCharacterAtOffset(content, content.indexOf(node.name, node.tagStart));
      specs.push({
        line: position.line,
        character: position.character,
        title,
        target: { entity: usage.entity, table: usage.table, column: usage.column }
      });
    };
    for (const usage of usages) {
      appendUsage(`${usage.entity}.${usage.property} → ${usage.table}.${usage.column}`, usage);
    }
    for (const usage of expandedUsages) {
      appendUsage(`字段 · ${usage.entity}.${usage.property} → ${usage.table}.${usage.column}`, usage);
    }
    const totalUsages = new Set([...usages, ...expandedUsages].map(
      usage => `${usage.entity}:${usage.table}:${usage.column}`
    )).size;
    if (totalUsages > TYPE_STORAGE_LENS_LIMIT) {
      const position = getLineCharacterAtOffset(content, content.indexOf(node.name, node.tagStart));
      specs.push({
        line: position.line,
        character: position.character,
        title: `+${totalUsages - TYPE_STORAGE_LENS_LIMIT} 处落库未列出`,
        target: null
      });
    }
  }
  return specs;
}

// def/types.xml/entities.xml 任一改动都会改变引用与落点并触发重取;dispose
// 随扩展注销拆掉 watcher。def 变更走 IDE-SCH-008 按实体增量替换(只重建
// 该实体贡献的 usage 记录),types.xml/entities.xml 仍整表置空(别名与实体
// 清单影响全体消费方)
export class TypesXmlCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly unsubscribeIndexPublished: () => void;

  constructor() {
    // 2026-10-28 审核整改:冷渲染拿空表(构建在后台),构建完成后通知重渲染
    this.unsubscribeIndexPublished = onTypeStorageUsageIndexPublished(() => {
      this.onDidChangeCodeLensesEmitter.fire();
    });
    for (const pattern of ['**/*.def', '**/types.xml', '**/entities.xml']) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const invalidate = (): void => {
        invalidateTypeStorageUsageIndex();
        this.onDidChangeCodeLensesEmitter.fire();
      };
      const replaceEntity = (uri?: vscode.Uri): void => {
        if (!uri) {
          invalidate(); // 无 uri 的事件面兜底:退回整表置空
          return;
        }
        const folder = vscode.workspace.workspaceFolders?.find(item =>
          uri.fsPath === item.uri.fsPath
          || uri.fsPath.startsWith(`${item.uri.fsPath}/`)
          || uri.fsPath.startsWith(`${item.uri.fsPath}${path.sep}`));
        const root = folder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
          invalidate();
          return;
        }
        replaceTypeStorageUsageForEntity(root, path.basename(uri.fsPath, path.extname(uri.fsPath)));
        this.onDidChangeCodeLensesEmitter.fire();
      };
      if (pattern === '**/*.def') {
        watcher.onDidChange(replaceEntity);
        watcher.onDidCreate(replaceEntity);
        watcher.onDidDelete(replaceEntity);
      } else {
        watcher.onDidChange(invalidate);
        watcher.onDidCreate(invalidate);
        watcher.onDidDelete(invalidate);
      }
      this.watchers.push(watcher);
    }
  }

  // 批154:types.xml 落库镜链一枚独立开关(kbengine.codeLens.typesXml)
  fireConfigurationChanged(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!getLanguageFeatureConfig().codeLensTypesXml) {
      return [];
    }
    const workspaceRoot = getWorkspaceRootForDocument(document);
    if (!workspaceRoot) {
      return [];
    }

    return buildTypesXmlStorageLensSpecs(document.getText(), workspaceRoot, document.fileName).map(spec =>
      new vscode.CodeLens(
        new vscode.Range(
          new vscode.Position(spec.line, spec.character),
          new vscode.Position(spec.line, spec.character)
        ),
        spec.target
          ? {
            title: spec.title,
            command: 'kbengine.database.open',
            arguments: [spec.target.entity, spec.target.table, spec.target.column]
          }
          : undefined
      )
    );
  }

  dispose(): void {
    this.unsubscribeIndexPublished();
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.onDidChangeCodeLensesEmitter.dispose();
  }
}

export class KBEngineCallHierarchyProvider implements vscode.CallHierarchyProvider {
  constructor(private entityMappingManager: EntityMappingManager) {}

  async prepareCallHierarchy(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CallHierarchyItem | vscode.CallHierarchyItem[] | null> {
    if (document.languageId === 'python') {
      const pythonMethod = await this.entityMappingManager.resolvePythonMethodAtPosition(
        document.fileName,
        position.line + 1,
        position.character
      );
      return pythonMethod ? createPythonCallHierarchyItem(pythonMethod) : null;
    }

    if (document.languageId === 'kbengine-def' || document.fileName.toLowerCase().endsWith('.def')) {
      const range = document.getWordRangeAtPosition(position, /\w+/);
      if (!range) {
        return null;
      }

      const word = document.getText(range);
      const symbolInfo = findDefSymbolInfo(document, position, word);
      if (!symbolInfo || !METHOD_SECTIONS.has(symbolInfo.section)) {
        return null;
      }

      // 不可达(批62 定性):symbolInfo 非空说明上一次 parseDefAst 已取到 AST
      // (getDefNodeAtWord→getDefNodeAtPosition 在 ast 为空时必然返回 null),
      // 且本分支的 languageId/文件名条件已满足 parseDefAst 的白名单;同一 document
      // 的同步重复解析不可能改判为空。
      const ast = parseDefAst(document);
      /* istanbul ignore start */
      if (!ast) {
        return null;
      }
      /* istanbul ignore stop */

      const identity = await this.entityMappingManager.resolveDefinitionSymbolAtPosition(
        document.fileName,
        getLineNumberAt(ast, symbolInfo.symbolNode.tagStart),
        symbolInfo.symbolNode.name,
        symbolInfo.section as EntityMethodSection
      );
      if (!identity) {
        return null;
      }

      const implementation = await this.entityMappingManager.resolveMethodImplementationByIdentity(identity);
      if (!implementation) {
        return null;
      }

      return createPythonCallHierarchyItem({
        filePath: implementation.filePath,
        methodName: symbolInfo.symbolNode.name,
        line: implementation.line,
        character: implementation.character
      });
    }

    return null;
  }

  async provideCallHierarchyIncomingCalls(
    item: vscode.CallHierarchyItem, token?: vscode.CancellationToken
  ): Promise<vscode.CallHierarchyIncomingCall[]> {
    if (token?.isCancellationRequested) return [];
    const calls = await this.entityMappingManager.getIncomingPythonMethodCalls(item.uri.fsPath, item.name, token);
    if (token?.isCancellationRequested) return [];
    return calls.map(call => new vscode.CallHierarchyIncomingCall(
      createPythonCallHierarchyItem(call.caller),
      [createSelectionRange(call.callLine, call.callCharacter, item.name)]
    ));
  }

  async provideCallHierarchyOutgoingCalls(
    item: vscode.CallHierarchyItem, token?: vscode.CancellationToken
  ): Promise<vscode.CallHierarchyOutgoingCall[]> {
    if (token?.isCancellationRequested) return [];
    const calls = await this.entityMappingManager.getOutgoingPythonMethodCalls(item.uri.fsPath, item.name, token);
    if (token?.isCancellationRequested) return [];
    return calls.map(call => new vscode.CallHierarchyOutgoingCall(
      createPythonCallHierarchyItem(call),
      [createSelectionRange(call.line, call.character, call.methodName)]
    ));
  }
}

/**
 * IDE-NAV-001:def 原生引用查询入口(Shift+F12)。引用结果复用统一符号
 * 身份——与调用层级 prepare 完全同链(findDefSymbolInfo →
 * resolveDefinitionSymbolAtPosition → resolveMethodImplementationByIdentity),
 * 解析到 python 实现后经 getIncomingPythonMethodCalls 出调用点,不另起
 * 名字搜索。本批收方法段;属性 self 访问(NAV-002)与 receiver RPC
 * (NAV-003)在引用收录面上后续批扩展。
 */
export class KBEngineReferencesProvider implements vscode.ReferenceProvider {
  constructor(private entityMappingManager: EntityMappingManager) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    token?: vscode.CancellationToken
  ): Promise<vscode.Location[] | null> {
    if (token?.isCancellationRequested) { return null; }
    if (
      document.languageId !== 'kbengine-def' &&
      !document.fileName.toLowerCase().endsWith('.def')
    ) {
      return null;
    }
    const range = document.getWordRangeAtPosition(position, /\w+/);
    if (!range) {
      return null;
    }
    const word = document.getText(range);
    const symbolInfo = findDefSymbolInfo(document, position, word);
    if (!symbolInfo) {
      return null;
    }
    // IDE-NAV-002:属性段 self 访问——归属由 owner 注册面决定
    // (getIncomingPythonPropertyAccesses 只扫本 def 的 owner 文件),
    // 无关实体同名属性不进来;方法调用不带括号断言,不混入。
    if (symbolInfo.section === 'Properties') {
      const accesses = await this.entityMappingManager.getIncomingPythonPropertyAccesses(
        document.fileName,
        symbolInfo.symbolNode.name,
        token
      );
      if (token?.isCancellationRequested) {
        return null;
      }
      return accesses.map(access =>
        new vscode.Location(
          vscode.Uri.file(access.filePath),
          createSelectionRange(access.line, access.character, symbolInfo.symbolNode.name)
        ));
    }
    if (!METHOD_SECTIONS.has(symbolInfo.section)) {
      return null;
    }
    const ast = parseDefAst(document);
    if (!ast) {
      return null;
    }
    const identity = await this.entityMappingManager.resolveDefinitionSymbolAtPosition(
      document.fileName,
      getLineNumberAt(ast, symbolInfo.symbolNode.tagStart),
      symbolInfo.symbolNode.name,
      symbolInfo.section as EntityMethodSection
    );
    if (!identity || token?.isCancellationRequested) {
      return null;
    }
    const implementation =
      await this.entityMappingManager.resolveMethodImplementationByIdentity(identity);
    if (token?.isCancellationRequested) {
      return null;
    }
    // IDE-NAV-003:receiver RPC 调用按段收录——CellMethods 配 self.cell.X(、
    // BaseMethods 配 self.base.X(、ClientMethods 配 self.client.X(,同名方法
    // 跨段互不串账;纯声明方法(无 python 实现)也有 receiver 引用面。
    const receiver =
      PYTHON_RECEIVER_BY_SECTION[symbolInfo.section as EntityMethodSection];
    const receiverCalls = receiver
      ? await this.entityMappingManager.getIncomingPythonReceiverCalls(
          document.fileName,
          symbolInfo.symbolNode.name,
          receiver,
          token
        )
      : [];
    if (token?.isCancellationRequested) {
      return null;
    }
    const receiverLocations = receiverCalls.map(call =>
      new vscode.Location(
        vscode.Uri.file(call.filePath),
        createSelectionRange(call.line, call.character, symbolInfo.symbolNode.name)
      ));
    if (!implementation) {
      return receiverLocations.length > 0 ? receiverLocations : null;
    }
    const calls = await this.entityMappingManager.getIncomingPythonMethodCalls(
      implementation.filePath,
      symbolInfo.symbolNode.name,
      token
    );
    if (token?.isCancellationRequested) {
      return null;
    }
    return [
      ...calls.map(call =>
        new vscode.Location(
          vscode.Uri.file(call.caller.filePath),
          createSelectionRange(call.callLine, call.callCharacter, symbolInfo.symbolNode.name)
        )),
      ...receiverLocations
    ];
  }
}

/**
 * IDE-NAV-005:def 文档符号(Outline):Properties/三方法段作容器
 * (Properties=Struct,方法段=Class),段内声明作子符号(属性=Field,方法=
 * Method)。精确范围:range=元素全跨度(开标签到闭标签,selfClosing 到开
 * 标签尾),selectionRange=名字所在开标签跨度(⊆ range);只出在场段,
 * 非符号段(Parent/Interfaces/Components/Volatile)不进 Outline。
 */
export class KBEngineDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  async provideDocumentSymbols(
    document: vscode.TextDocument,
    _token?: vscode.CancellationToken
  ): Promise<vscode.DocumentSymbol[] | null> {
    const ast = parseDefAst(document);
    if (!ast || !ast.root) {
      return null;
    }

    const symbols: vscode.DocumentSymbol[] = [];
    for (const child of ast.root.children) {
      if (child.kind !== 'element') {
        continue;
      }
      const sectionName = toSectionName(child.name);
      if (!sectionName || !DEF_SYMBOL_SECTIONS.has(sectionName)) {
        continue;
      }
      const isProperties = sectionName === 'Properties';
      const sectionSymbol = new vscode.DocumentSymbol(
        sectionName,
        '',
        isProperties ? vscode.SymbolKind.Struct : vscode.SymbolKind.Class,
        elementFullRange(document, child),
        elementTagRange(document, child)
      );
      sectionSymbol.children = child.children
        .filter((member): member is DefElementNode => member.kind === 'element')
        .map(member => new vscode.DocumentSymbol(
          member.name,
          '',
          isProperties ? vscode.SymbolKind.Field : vscode.SymbolKind.Method,
          elementFullRange(document, member),
          elementTagRange(document, member)
        ));
      symbols.push(sectionSymbol);
    }
    return symbols;
  }
}

/** 元素全跨度:开标签头到闭标签尾;selfClosing(无闭标签)到开标签尾 */
function elementFullRange(document: vscode.TextDocument, node: DefElementNode): vscode.Range {
  return new vscode.Range(
    document.positionAt(node.tagStart),
    document.positionAt(node.selfClosing ? node.tagEnd : node.closeTagEnd)
  );
}

/** 名字所在开标签跨度(selectionRange 恒 ⊆ range) */
function elementTagRange(document: vscode.TextDocument, node: DefElementNode): vscode.Range {
  return new vscode.Range(
    document.positionAt(node.tagStart),
    document.positionAt(node.tagEnd)
  );
}

/**
 * IDE-NAV-006:根范围工作区符号查询(Ctrl+T)——已索引 def 符号按名称前缀
 * 查询,manager.searchDefSymbolsByPrefix 只读内存索引,查询面不触发全仓
 * 扫描;containerName 带 root/段信息(方法=`root · 段`,属性=root),
 * location 指向 def 声明行。
 */
export class KBEngineWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private entityMappingManager: EntityMappingManager) {}

  async provideWorkspaceSymbols(
    query: string,
    token?: vscode.CancellationToken
  ): Promise<vscode.SymbolInformation[] | null> {
    if (token?.isCancellationRequested) {
      return null;
    }
    const hits = this.entityMappingManager.searchDefSymbolsByPrefix(query, token);
    if (token?.isCancellationRequested) {
      return null;
    }
    return hits.map(hit => new vscode.SymbolInformation(
      hit.symbolName,
      hit.kind === 'property' ? vscode.SymbolKind.Field : vscode.SymbolKind.Method,
      hit.section ? `${hit.rootName} · ${hit.section}` : hit.rootName,
      new vscode.Location(
        vscode.Uri.file(hit.defFile),
        new vscode.Position(Math.max(0, hit.line - 1), 0)
      )
    ));
  }
}

export class KBEngineRenameProvider implements vscode.RenameProvider {
  /**
   * .def 属性/方法重命名(重构支持):符号解析与引用编辑计算在 defRenamer
   * 纯模块,这里只做 vscode 值类型的装配。作用域与边界见 defRenamer 头注。
   */
  prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<{ range: vscode.Range; placeholder: string }> {
    const symbol = resolveRenameSymbolAtOffset(document.getText(), document.offsetAt(position));
    if (!symbol) {
      return null;
    }
    return {
      range: new vscode.Range(
        document.positionAt(symbol.wordStart),
        document.positionAt(symbol.wordEnd)
      ),
      placeholder: symbol.name
    };
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string
  ): Promise<vscode.WorkspaceEdit | null> {
    const symbol = resolveRenameSymbolAtOffset(document.getText(), document.offsetAt(position));
    if (!symbol) {
      return null;
    }
    const fileEdits = computeDefRenameEdits({
      targetFilePath: document.fileName,
      targetText: document.getText(),
      symbol,
      newName
    });
    if (fileEdits.length === 0) {
      return null;
    }
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const fileEdit of fileEdits) {
      const uri = path.resolve(fileEdit.filePath) === path.resolve(document.fileName)
        ? document.uri
        : vscode.Uri.file(fileEdit.filePath);
      // 偏移区间相对 fileEdit.text(各文件自己的行表),不能借目标文档换算
      workspaceEdit.set(uri, fileEdit.edits.map(edit => {
        const start = getLineCharacterAtOffset(fileEdit.text, edit.start);
        const end = getLineCharacterAtOffset(fileEdit.text, edit.end);
        return new vscode.TextEdit(
          new vscode.Range(
            new vscode.Position(start.line, start.character),
            new vscode.Position(end.line, end.character)
          ),
          newName
        );
      }));
    }
    return workspaceEdit;
  }
}

export class PythonCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private entityMappingManager: EntityMappingManager,
    private engineApiCatalog: EngineApiCatalog | null = null
  ) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (token?.isCancellationRequested) return null;
    const version = document.version;
    const result = this.computeCompletionItems(document, position);
    return token?.isCancellationRequested || document.version !== version ? null : result;
  }

  private computeCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const line = document.lineAt(position.line);
    const linePrefix = line.text.substring(0, position.character);

    // kbe/KBEngine 模块符号补全(批108):`kbe.` / `KBEngine.` 语境下按索引
    // 前缀过滤。仅识别已引入/已使用的模块别名,非模块语境照常走 self 补全。
    const kbeAliases = getKbeAliases(document.getText());
    const kbeContext = getKbeCompletionContext(linePrefix, kbeAliases);
    if (kbeContext) {
      const entries = filterKbeSymbols(kbeContext.partialSymbol);
      return entries.map(entry => {
        const item = new vscode.CompletionItem(
          entry.name,
          entry.kind === 'class' ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.Function
        );
        item.detail = entry.signature;
        item.documentation = new vscode.MarkdownString(
          `${entry.summary}\n\n原始声明: \`${entry.sourceFile}:${entry.sourceLine}\``
        );
        return item;
      });
    }

    const completionContext = getPythonSelfCompletionContext(
      line.text.substring(0, position.character)
    );
    if (!completionContext) {
      return null;
    }

    const mapping = this.entityMappingManager.getMappingForPythonFile(document.fileName);

    if (!mapping) {
      return null;
    }

    const items: vscode.CompletionItem[] = [];
    const partialLower = completionContext.partialSymbol.toLowerCase();
    const seenProperties = new Set<string>();

    if (completionContext.parentPath) {
      const nestedPrefix = `${completionContext.parentPath}.`;
      for (const [propPath, propInfo] of Object.entries(mapping.properties)) {
        if (!propPath.startsWith(nestedPrefix)) {
          continue;
        }

        const remainder = propPath.slice(nestedPrefix.length);
        const nextSegment = remainder.split('.')[0];
        if (!nextSegment) {
          continue;
        }

        if (partialLower && !nextSegment.toLowerCase().startsWith(partialLower)) {
          continue;
        }

        if (seenProperties.has(nextSegment)) {
          continue;
        }
        seenProperties.add(nextSegment);

        const item = new vscode.CompletionItem(nextSegment, vscode.CompletionItemKind.Property);
        item.detail = 'Nested Entity Property';
        item.documentation = new vscode.MarkdownString(
          `定义于: \`${path.basename(propInfo.defFile)}:${propInfo.line}\`\n\n从 .def 文件中的嵌套属性自动推导。`
        );
        items.push(item);
      }

      return items;
    }

    for (const [propName, propInfo] of Object.entries(mapping.properties)) {
      if (propName.includes('.')) {
        continue;
      }

      if (partialLower && !propName.toLowerCase().startsWith(partialLower)) {
        continue;
      }

      const item = new vscode.CompletionItem(propName, vscode.CompletionItemKind.Property);
      item.detail = 'Entity Property';
      item.documentation = new vscode.MarkdownString(
        `定义于: \`${path.basename(propInfo.defFile)}:${propInfo.line}\`\n\n从 .def 文件自动生成的实体属性。`
      );
      items.push(item);
    }

    for (const [methodName, methodDefinitions] of Object.entries(mapping.methods)) {
      if (partialLower && !methodName.toLowerCase().startsWith(partialLower)) {
        continue;
      }

      const primaryDefinition = methodDefinitions[0];
      if (!primaryDefinition) {
        continue;
      }

      const item = new vscode.CompletionItem(methodName, vscode.CompletionItemKind.Method);
      item.detail = primaryDefinition.exposed ? 'Entity Method (Exposed)' : 'Entity Method';
      // def 方法签名随补全出示(审计遗留承诺):declared <Arg> 的形参带类型注解,
      // 与两处 hover 同走 resolveEntityAnnotationType 解析链(用户令 2026-10-21);
      // 未声明 <Arg> 不硬造(只出 self)
      item.documentation = new vscode.MarkdownString(
        `\`${formatDefMethodSignature(getWorkspaceRootForDocument(document) ?? undefined, methodName, primaryDefinition.declaredArgs)}\`\n\n` +
        `定义于: \`${path.basename(primaryDefinition.defFile)}:${primaryDefinition.line}\`\n\n从 .def 文件自动生成的实体方法。`
      );
      items.push(item);
    }

    return items;
  }
}

function getPythonMethodDeclarationAtPosition(lineText: string, character: number): string | null {
  const match = METHOD_DECLARATION_PATTERN.exec(lineText);
  if (!match) {
    return null;
  }

  const methodName = match[1];
  const nameStart = lineText.indexOf(methodName);
  const nameEnd = nameStart + methodName.length;
  if (character < nameStart || character > nameEnd) {
    return null;
  }

  return methodName;
}

function createPythonCallHierarchyItem(
  method: { filePath: string; methodName: string; line: number; character: number }
): vscode.CallHierarchyItem {
  const selectionRange = createSelectionRange(method.line, method.character, method.methodName);
  return new vscode.CallHierarchyItem(
    vscode.SymbolKind.Method,
    method.methodName,
    path.basename(method.filePath),
    vscode.Uri.file(method.filePath),
    selectionRange,
    selectionRange
  );
}

function createSelectionRange(line: number, character: number, text: string): vscode.Range {
  return new vscode.Range(
    new vscode.Position(Math.max(line - 1, 0), Math.max(character, 0)),
    new vscode.Position(Math.max(line - 1, 0), Math.max(character, 0) + text.length)
  );
}

