/**
 * IDE-NAV-018:def 内类型名/实体名/接口名引用查询(Shift+F12)。
 *
 * 用户反馈(2026-10-30):def 内 Shift+F12 未展示引用。NAV-001/002/003 已覆盖
 * 方法名(实现+receiver 调用)与属性名(self 访问),但类型名(<Type>/<Arg>/<of>
 * 值)、实体名(<Parent> 值)与接口名(<Interface> 值)不在引用链上——
 * findDefSymbolInfo 只认 Properties/方法段,这些符号落 null(见
 * languageProviders.getSymbolNodeInfo)。本模块补上:
 *
 *  - 类型名(types.xml 自定义类型)→ 全工作区 .def/.types.xml 使用处
 *    (复用 scanTypeReferencesInXml,与 NAV-017 同扫描口径);
 *  - 类型名(实体类型)→ 全工作区 .def 的 <Parent>/<Type> 使用处;
 *  - 实体名(<Parent> 值)→ 全工作区 .def 的 <Parent>/<Type> 使用处 + 实体 def;
 *  - 接口名(<Interface> 值)→ 全工作区 .def 的 <Interface> 使用处 + 接口 def。
 *
 * 内建类型(UINT32 等)与容器字面(ARRAY/FIXED_DICT)无引用面(同 NAV-017)。
 * includeDeclaration 语义与 def 面一致(true 含声明,false 只回引用位);
 * 空结果如实 null(调用方约定,不虚构)。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  DefDocument,
  DefElementNode,
  parseDefDocument,
  getLineNumberAt,
  findTextNodeAtOffset,
  findDeepestElementAtOffset
} from './backend/defParser';
import { findFilesAcrossRoots } from './scanRoots';
import { KBENGINE_TYPES, FIXED_DICT_TYPE_NAME } from './kbengineMetadata';
import {
  findCustomTypeInfo,
  findCustomTypeDeclarationInfo,
  findDefinitionFileByCategory,
  findEntityDefinitionFile,
  getWorkspaceRootForDocument
} from './definitionWorkspace';
import { scanTypeReferencesInXml, type TypesXmlRefSite } from './typesXmlReferences';
import { INTERFACE_WRAPPER_NAMES } from './backend/defRenamer';

/** 容器字面不是类型符号(scanTypeReferencesInXml 同口径) */
const CONTAINER_LITERALS = new Set(['ARRAY', FIXED_DICT_TYPE_NAME]);

export type DefSymbolReferenceKind = 'type' | 'parent' | 'interface';

export interface DefSymbolReferenceTarget {
  kind: DefSymbolReferenceKind;
  name: string;
}

/** offset 处 word(与 vscode getWordRangeAtPosition /\w+/ 同规则) */
function wordAt(content: string, offset: number): string {
  let start = offset;
  let end = offset;
  while (start > 0 && /\w/.test(content[start - 1])) {
    start -= 1;
  }
  while (end < content.length && /\w/.test(content[end])) {
    end += 1;
  }
  return content.slice(start, end);
}

/**
 * 识别 def 光标处符号的引用类:光标落在 <Type>/<Arg>/<of> 值内为类型名,
 * <Parent> 值内为父实体名,<Interfaces> 子 <Interface> 值内为接口名。
 * 标签名/容器字面/其他上下文返回 null。
 */
export function resolveDefSymbolReferenceTarget(
  content: string,
  offset: number
): DefSymbolReferenceTarget | null {
  const document = parseDefDocument(content);
  if (!document.root) {
    return null;
  }
  const textNode = findTextNodeAtOffset(document.root, offset);
  const element = textNode?.parent ?? findDeepestElementAtOffset(document.root, offset);
  if (!element) {
    return null;
  }
  const word = wordAt(content, offset);
  if (!word || CONTAINER_LITERALS.has(word)) {
    return null;
  }

  let node: DefElementNode | null = element;
  while (node) {
    // KR-AUD-77:引擎在 <Interfaces> 下认四种 wrapper 拼写(interface/Interface/
    // type/Type,entitydef.cpp:563-566)——直挂 <Interfaces> 的 wrapper 优先于
    // 下方 Type 分支判定为接口引用;<Interfaces> 外的同名 <Type> 仍是属性类型。
    if (
      INTERFACE_WRAPPER_NAMES.has(node.name) &&
      node.parent?.name === 'Interfaces' &&
      offset >= node.contentStart &&
      offset <= node.contentEnd
    ) {
      return { kind: 'interface', name: word };
    }
    if (
      (node.name === 'Type' || node.name === 'Arg' || node.name === 'of') &&
      offset >= node.contentStart &&
      offset <= node.contentEnd
    ) {
      return { kind: 'type', name: word };
    }
    if (node.name === 'Parent' && offset >= node.contentStart && offset <= node.contentEnd) {
      return { kind: 'parent', name: word };
    }
    if (node.name === 'Interfaces' && offset >= node.contentStart && offset <= node.contentEnd) {
      return { kind: 'interface', name: word };
    }
    node = node.parent;
  }
  return null;
}

/** 读取文件内容,优先开着的文档缓冲(与导航落点同口径) */
function readFileContentForScan(filePath: string): string {
  const openDocument = vscode.workspace.textDocuments.find(doc => doc.fileName === filePath);
  return openDocument ? openDocument.getText() : fs.readFileSync(filePath, 'utf8');
}

function walkElements(node: DefElementNode, visit: (el: DefElementNode) => void): void {
  visit(node);
  for (const child of node.children) {
    if (child.kind === 'element') {
      walkElements(child, visit);
    }
  }
}

/** 把 [startOffset,endOffset) 值区间的空白分隔 token 逐个定位,等于 target 的记位 */
function collectTokenSites(
  document: DefDocument,
  file: string,
  startOffset: number,
  endOffset: number,
  target: string,
  sites: TypesXmlRefSite[]
): void {
  const raw = document.text.slice(startOffset, endOffset);
  let searchFrom = startOffset;
  for (const token of raw.split(/\s+/)) {
    if (token.length === 0) {
      continue;
    }
    const idx = document.text.indexOf(token, searchFrom);
    if (idx === -1 || idx >= endOffset) {
      break;
    }
    if (token === target) {
      sites.push({
        file,
        line: getLineNumberAt(document, idx) - 1,
        start: idx - document.lineStarts[getLineNumberAt(document, idx) - 1],
        end: idx - document.lineStarts[getLineNumberAt(document, idx) - 1] + token.length
      });
    }
    searchFrom = idx + token.length;
  }
}

/** 扫描单个 def 内容里所有 <tagName> 值等于 target 的引用位 */
function scanDefTagValueSites(
  content: string,
  file: string,
  tagName: string,
  target: string,
  onlyDirectInterfacesChild = false
): TypesXmlRefSite[] {
  const document = parseDefDocument(content);
  if (!document.root) {
    return [];
  }
  const sites: TypesXmlRefSite[] = [];
  walkElements(document.root, el => {
    if (el.name !== tagName) {
      return;
    }
    // KR-AUD-77:接口 wrapper 仅在 <Interfaces> 直挂时算接口引用
    if (onlyDirectInterfacesChild && el.parent?.name !== 'Interfaces') {
      return;
    }
    collectTokenSites(document, file, el.contentStart, el.contentEnd, target, sites);
  });
  return sites;
}

async function enumerateDefFiles(
  token?: vscode.CancellationToken
): Promise<string[]> {
  const uris = await findFilesAcrossRoots('**/*.def', null, token);
  return uris.map(uri => uri.fsPath);
}

/** 全工作区 .def + types.xml 中 target 类型名的使用处(复用 NAV-017 扫描) */
async function collectCustomTypeSites(
  name: string,
  token?: vscode.CancellationToken
): Promise<TypesXmlRefSite[]> {
  const [defFiles, typesXmlFiles] = await Promise.all([
    findFilesAcrossRoots('**/*.def', null, token),
    findFilesAcrossRoots('**/types.xml', null, token)
  ]);
  const files = [...defFiles.map(uri => uri.fsPath), ...typesXmlFiles.map(uri => uri.fsPath)];
  const sites: TypesXmlRefSite[] = [];
  for (const file of files) {
    if (token?.isCancellationRequested) {
      return sites;
    }
    try {
      sites.push(...scanTypeReferencesInXml(readFileContentForScan(file), file, name));
    } catch {
      // 单文件读取失败不拖垮整次引用查询
    }
  }
  return sites;
}

/** 全工作区 .def 中 target 实体名的引用位:<Parent> 子实体 + <Type>/<Arg>/<of> 实体引用 */
async function collectEntitySites(
  name: string,
  token?: vscode.CancellationToken
): Promise<TypesXmlRefSite[]> {
  const defFiles = await enumerateDefFiles(token);
  const sites: TypesXmlRefSite[] = [];
  for (const file of defFiles) {
    if (token?.isCancellationRequested) {
      return sites;
    }
    let content: string;
    try {
      content = readFileContentForScan(file);
    } catch {
      continue;
    }
    sites.push(...scanDefTagValueSites(content, file, 'Parent', name));
    sites.push(...scanTypeReferencesInXml(content, file, name));
  }
  return sites;
}

/** 全工作区 .def 中 target 接口名的引用位:<Interface> 值 */
async function collectInterfaceSites(
  name: string,
  token?: vscode.CancellationToken
): Promise<TypesXmlRefSite[]> {
  const defFiles = await enumerateDefFiles(token);
  const sites: TypesXmlRefSite[] = [];
  for (const file of defFiles) {
    if (token?.isCancellationRequested) {
      return sites;
    }
    let content: string;
    try {
      content = readFileContentForScan(file);
    } catch {
      continue;
    }
    // KR-AUD-77:引擎认四种 wrapper 拼写(复用 defRenamer.INTERFACE_WRAPPER_NAMES,
    // entitydef.cpp:563-566);仅 <Interfaces> 直挂的 wrapper 算接口引用,
    // 属性 <Type> 等同名元素不误计。
    sites.push(
      ...[...INTERFACE_WRAPPER_NAMES].flatMap(tag =>
        scanDefTagValueSites(content, file, tag, name, true)
      )
    );
  }
  return sites;
}

function toLocation(site: TypesXmlRefSite): vscode.Location {
  return new vscode.Location(
    vscode.Uri.file(site.file),
    new vscode.Position(site.line, site.start)
  );
}

/**
 * def 内类型名/实体名/接口名引用查询入口。光标不在上述符号上(或符号
 * 不可解析)返回 null;空结果也返回 null(调用方约定,不虚构)。
 */
export async function provideDefSymbolReferences(
  document: vscode.TextDocument,
  position: vscode.Position,
  includeDeclaration: boolean,
  token?: vscode.CancellationToken
): Promise<vscode.Location[] | null> {
  if (token?.isCancellationRequested) {
    return null;
  }
  const target = resolveDefSymbolReferenceTarget(document.getText(), document.offsetAt(position));
  if (!target) {
    return null;
  }
  const builtIns = new Set(KBENGINE_TYPES.map(type => type.name));
  if (builtIns.has(target.name)) {
    return null;
  }
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return null;
  }

  let declarationLocation: vscode.Location | null = null;
  let sites: TypesXmlRefSite[] = [];

  if (target.kind === 'type') {
    // 自定义类型(types.xml)→ 全工作区使用处 + types.xml 声明
    if (findCustomTypeInfo(target.name, document)) {
      sites = await collectCustomTypeSites(target.name, token);
      const decl = findCustomTypeDeclarationInfo(target.name, workspaceRoot);
      if (decl) {
        declarationLocation = new vscode.Location(
          vscode.Uri.file(decl.filePath),
          new vscode.Position(decl.line - 1, 0)
        );
      }
    } else if (findEntityDefinitionFile(target.name, document)) {
      // 实体类型 → 实体引用 + 实体 def
      sites = await collectEntitySites(target.name, token);
      const entityPath = findEntityDefinitionFile(target.name, document);
      if (entityPath) {
        declarationLocation = new vscode.Location(vscode.Uri.file(entityPath), new vscode.Position(0, 0));
      }
    } else {
      return null;
    }
  } else if (target.kind === 'parent') {
    const entityPath = findEntityDefinitionFile(target.name, document);
    if (!entityPath) {
      return null;
    }
    sites = await collectEntitySites(target.name, token);
    declarationLocation = new vscode.Location(vscode.Uri.file(entityPath), new vscode.Position(0, 0));
  } else {
    // interface
    sites = await collectInterfaceSites(target.name, token);
    const ifacePath = findDefinitionFileByCategory(target.name, 'interface', document);
    if (ifacePath) {
      declarationLocation = new vscode.Location(vscode.Uri.file(ifacePath), new vscode.Position(0, 0));
    }
  }

  if (token?.isCancellationRequested) {
    return null;
  }

  const locations: vscode.Location[] = [];
  const seen = new Set<string>();
  if (includeDeclaration && declarationLocation) {
    const key = `${declarationLocation.uri.fsPath}:${declarationLocation.range.start.line}`;
    seen.add(key);
    locations.push(declarationLocation);
  }
  for (const site of sites) {
    const key = `${site.file}:${site.line}:${site.start}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    locations.push(toLocation(site));
  }
  if (locations.length === 0) {
    return null;
  }
  return locations;
}
