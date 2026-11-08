// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as path from 'path';
import * as vscode from 'vscode';
import { DefElementNode, findAncestorElement, getDirectChildElement, getDirectChildElements, getLineNumberAt } from '../defParser';
import { EntityMappingManager, EntityMethodSection, type DefinitionSymbolIdentity } from '../entityMapping';
import {
  getKodeCoreShadowGate,
  serveDefinitionFromRust,
  settleProviderResult,
  shadowCompareDefinition,
  type LspLocationFace
} from '../kodeCoreShadowFaces';
import { findDatabaseSchemaFieldAtPosition, findDatabaseSchemaSourceLocation, findDatabaseSchemaTargetsForSource, getDatabaseSchemaSnapshot, locateDatabaseSchemaLine } from '../databaseSchema';
import { createDatabaseSchemaUri, isDatabaseSchemaDocument } from '../databaseSchemaPresentation';
import { findCustomTypeDeclarationInfo, findCustomTypeInfo, findCustomTypePythonImplementationFile, findImplementedBySymbolLine, findDefinitionEntryByCategory, findDefinitionFileByCategory, findEntityDefsDirForDefFile, findComponentScriptFile, findEntityDefinitionFile, findEntitiesXmlFile, findEntityScriptFile, findInterfaceScriptFile, getDefinitionWorkspaceLayout, getRegisteredCustomTypes, getScriptsRootForDefFile, getWorkspaceRootForDocument, scriptFoldersForRole, notifyEntitiesXmlMissingOnce, readWorkspaceTextFile, readWorkspaceTextLines } from '../definitionWorkspace';
import { parseDefFileSemantics } from '../defRenamer';
import { KBENGINE_TYPES } from '../kbengineMetadata';
import { logNavigation } from '../navigationLog';
import { SymbolHoverInfo, buildSymbolHoverInfo } from './hover';
import { CustomTypeResolution, KBEngineSectionName, METHOD_SECTIONS, getDefNodeAtPosition, getDefNodeAtWord, getSymbolNodeInfo, isOffsetInsideNodeValue, parseDefAst } from './shared';
/** LSP 落点面(规范路径 uri)→ vscode.Location(Rust 面与 shadow 同形)。 */
function lspFaceToVscodeLocation(face: LspLocationFace): vscode.Location {
  return new vscode.Location(
    vscode.Uri.file(face.uri),
    new vscode.Range(
      new vscode.Position(face.range.start.line, face.range.start.character),
      new vscode.Position(face.range.end.line, face.range.end.character)
    )
  );
}

export class KBEngineDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private entityMappingManager?: EntityMappingManager) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Location> {
    // 2026-11-08 用户令「直接切到 rust」:服务轨道下定义面走 Rust,TS 只作
    // 失败/无落点兜底(Rust 面=语料声明落点,Python/schema 恒 null→TS)。
    const gate = getKodeCoreShadowGate();
    if (gate?.serveFromRust()) {
      return this.provideDefinitionRustFirst(document, position);
    }
    const location = this.provideDefinitionImpl(document, position);
    // Phase2 首片:shadow 双轨对拍(定义面)。fire-and-forget,不改返回值。
    shadowCompareDefinition(document, position, location);
    return location;
  }

  /**
   * Rust 命中直接返回;失败或不支持时才计算 TS,避免正常路径重复解析和查询。
   */
  private async provideDefinitionRustFirst(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location | null> {
    const version = document.version;
    try {
      const rustLocation = await serveDefinitionFromRust(document, position);
      if (document.version !== version) { return null; }
      if (rustLocation) { return lspFaceToVscodeLocation(rustLocation); }
    } catch {
      // A malformed response or unavailable server must retain TS navigation.
    }
    if (document.version !== version) { return null; }
    let tsValue: unknown = null;
    try {
      const settled = await settleProviderResult(this.provideDefinitionImpl(document, position));
      if (settled.settled) {
        tsValue = settled.value;
      }
    } catch {
      tsValue = null;
    }
    const first = Array.isArray(tsValue) ? tsValue[0] : tsValue;
    if (first && typeof first === 'object' && 'uri' in first) {
      return first as vscode.Location;
    }
    return null;
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

export function resolveCustomTypeReference(
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

export function findEnclosingSymbol(
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

export function findEntityDefinitionInDef(
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
export function describeExpectedScriptPaths(
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

export function formatWorkspaceRelativePath(candidate: string, workspaceRoot: string | null): string {
  if (workspaceRoot && candidate.startsWith(`${workspaceRoot}${path.sep}`)) {
    return path.relative(workspaceRoot, candidate);
  }
  return candidate;
}

// 根修令④:脚本确实不存在时的可跳落点——实体在 entities.xml 的声明行
// 优先(注册事实所在,def 反推与工作区布局两级各取一次),否则同名 def
// (即当前文档)首行。
export function findEntityDeclarationLine(xmlPath: string, entityName: string): number {
  if (!/^[A-Za-z_]\w*$/.test(entityName)) {
    return -1;
  }
  const pattern = new RegExp(`^\\s*<${entityName}(\\s|/>|>)`);
  return readWorkspaceTextLines(xmlPath).findIndex(line => pattern.test(line));
}

export function findRegistryFallbackLocation(
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

export function findDatabaseSchemaDefinition(
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

export function findDatabaseSchemaLocationFromDef(
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
    // AUD-055:定位目标 URI 带根身份(与 def 文档同根),A/B 同名实体不串
    createDatabaseSchemaUri(entityName, getWorkspaceRootForDocument(document)),
    new vscode.Position(
      Math.max(locateDatabaseSchemaLine(snapshot, primaryTarget.tableName, primaryTarget.fieldName) - 1, 0),
      0
    )
  );
}

export function buildPropertyPath(symbolNode: DefElementNode): string {
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

export function findTypeValueDefinitionInTypesXml(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): vscode.Location | null {
  if (!isPositionInsideTagValue(document, position, 'Type')) {
    return null;
  }

  return createDefinitionLocation(document, findTypeValueDefinitionReference(document, word));
}

export function findCustomTypeDefinition(
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

export function findCustomTypeAtPosition(
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

export function findCurrentDocumentCustomTypeReference(
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

export function isPositionInsideTagValue(
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

export function isPositionInsideImplementedByValue(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  return isPositionInsideTagValue(document, position, 'implementedBy');
}

export function isPositionInsideChildTag(
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

export function looksLikeEntityName(word: string): boolean {
  const builtInTypes = new Set(KBENGINE_TYPES.map(type => type.name));
  return !builtInTypes.has(word) && /^[A-Z][A-Za-z0-9_]*$/.test(word);
}

export function createDefinitionLocation(
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

export function findTypeValueDefinitionReference(
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

export function findDefinitionReferenceInDef(
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

export function findDefSymbolInfo(
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

// IDE-ACC-013:导航落点读取优先开着的文档缓冲——目标脚本已被打开(含未
// 保存编辑)时按缓冲内容定行,方法在脏缓冲里挪行后 F12 落缓冲新行;未
// 打开时回落磁盘直读(批110 既有口径)。放弃修改后缓冲内容回到磁盘版
// (无论文档是否仍驻留宿主工作集),落点随之恢复磁盘位。
export function readScriptLinesForNavigation(scriptPath: string): string[] {
  const openDocument = vscode.workspace.textDocuments.find(doc => doc.fileName === scriptPath);
  return openDocument ? openDocument.getText().split('\n') : readWorkspaceTextLines(scriptPath);
}

export const METHOD_SECTION_SCRIPT_ROLES: Partial<Record<KBEngineSectionName, 'base' | 'cell' | 'client'>> = {
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
export function findPropertyScriptLocationInDef(document: vscode.TextDocument): vscode.Location | null {
  const entityName = path.basename(document.fileName, '.def');

  const candidateScripts = collectPropertyCandidateScripts(document);
  logNavigation(`属性候选链 [${candidateScripts.join(' | ') || '空'}]`);
  for (const scriptPath of candidateScripts) {
    const lineIndex = resolvePropertyLandingLine(
      readScriptLinesForNavigation(scriptPath),
      entityName
    );
    return new vscode.Location(vscode.Uri.file(scriptPath), new vscode.Position(lineIndex, 0));
  }

  return null;
}

// 属性落点四档:与 def 同名的类定义行 → __init__ 行 → 首个类行(类名与
// def 不一致时)→ 脚本首行。引擎在 __init__ 之前装载属性,脚本里没有同名
// 赋值时类/__init__ 仍是唯一可定位的锚点。
// 导出供四档落点锁测试(IDE-PROP-001 回归面,provider 不经此函数)。
export function resolvePropertyLandingLine(lines: string[], entityName: string): number {
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
export function collectPropertyCandidateScripts(document: vscode.TextDocument): string[] {
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
export function collectMethodCandidateScripts(
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
export function findParentDefPath(
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
export function findMethodScriptLocationInDef(
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
    const defLineIndex = readScriptLinesForNavigation(scriptPath).findIndex(line => {
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
export function findDetailLevelDefinitionInDef(
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

/**
 * IDE-NAV-015:def 方法 → python 实现目标的统一解析链,F12(findEntity
 * DefinitionInDef)与调用层次(prepareCallHierarchy)同链:identity 绑定/
 * 属主命中(含全项目唯一名回退)→ def 相对约定链。两臂皆空返回 null——
 * F12 的提示+注册回落是展示兜底(落 def/entities.xml,不是 python 目标),
 * 不进本链;调用层次拿不到 python 方法如实 null。
 */
/** IDE-ACC-013:索引/全局回退臂的落点行是扫描期磁盘口径;目标脚本开着
 * 脏缓冲(未保存编辑把方法挪行)时按缓冲内容找 `def <方法>` 行重定,以
 * 缓冲为准(编辑时跳到脏缓冲区位置);缓冲里已无该方法(编辑中删除)时
 * 保留索引行。约定链臂(findMethodScriptLocationInDef)读取本身已走缓冲,
 * 不经此调。 */
export function adjustMethodTargetToOpenBuffer(
  target: { filePath: string; line: number; character: number },
  methodName: string
): { filePath: string; line: number; character: number } {
  const openDocument = vscode.workspace.textDocuments.find(doc => doc.fileName === target.filePath);
  if (!openDocument) {
    return target;
  }
  const defPattern = new RegExp(`^\\s*def\\s+${methodName}\\b`);
  const bufferLine = openDocument.getText().split('\n').findIndex(line => defPattern.test(line));
  return bufferLine >= 0 ? { ...target, line: bufferLine + 1 } : target;
}

export async function resolveDefMethodPythonTarget(
  document: vscode.TextDocument,
  methodName: string,
  section: EntityMethodSection,
  manager: EntityMappingManager,
  identity: DefinitionSymbolIdentity | null
): Promise<{ filePath: string; line: number; character: number } | null> {
  if (identity) {
    const bound = await manager.resolveMethodImplementationByIdentity(identity);
    if (bound) {
      const adjusted = adjustMethodTargetToOpenBuffer(bound, methodName);
      logNavigation(`方法落点(索引${adjusted === bound ? '' : ',缓冲重定'}) ${adjusted.filePath}:${adjusted.line - 1}`);
      return adjusted;
    }
  }

  // 约定链:def 相对候选脚本直读(不依赖索引,identity 缺失/未绑定同臂)
  const byConvention = findMethodScriptLocationInDef(document, methodName, section);
  if (byConvention) {
    logNavigation(`方法落点(约定链) ${byConvention.uri.fsPath}:${byConvention.range.start.line}`);
    return {
      filePath: byConvention.uri.fsPath,
      line: byConvention.range.start.line + 1,
      character: byConvention.range.start.character
    };
  }

  // 索引外全局唯一名回退(与 F12 同臂:域目录层在 resolveMethodImplementation
  // Globally 内部;这里只兜 identity 缺失/未绑定的残余)
  if (typeof manager.resolveMethodImplementationGlobally !== 'function') {
    return null;
  }
  const defSection =
    section === 'BaseMethods' || section === 'CellMethods' ? section : undefined;
  const glob = await manager.resolveMethodImplementationGlobally(methodName, defSection);
  if (glob) {
    const adjusted = adjustMethodTargetToOpenBuffer(glob, methodName);
    logNavigation(`方法落点(全项目回退${adjusted === glob ? '' : ',缓冲重定'}) ${adjusted.filePath}:${adjusted.line - 1}`);
    return adjusted;
  }
  return null;
}

export function findMethodImplementationLocationInDef(
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

  // IDE-NAV-015:统一链(identity 绑定/属主 → 约定链 → 全项目唯一,与调用
  // 层次 prepare 同链)收敛在 resolveDefMethodPythonTarget;空臂回落展示
  // 兜底(提示+注册声明/def 首行——根修令①/用户令 2026-10-20 口径不变)。
  return entityMappingManager.resolveDefinitionSymbolAtPosition(
    document.fileName,
    line,
    methodName,
    section as EntityMethodSection
  ).then(identity =>
    resolveDefMethodPythonTarget(
      document,
      methodName,
      section as EntityMethodSection,
      entityMappingManager,
      identity
    )
  ).then(target => {
    if (target) {
      return new vscode.Location(
        vscode.Uri.file(target.filePath),
        new vscode.Position(Math.max(target.line - 1, 0), target.character)
      );
    }
    logNavigation(`方法未落 python 实现 ${methodName}(${section}),回落注册声明/def 首行`);
    return hintRegistryFallback();
  });
}

export function findDefinitionSiblingForParent(
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
