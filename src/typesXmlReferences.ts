/**
 * IDE-NAV-017:types.xml 符号引用查询(Shift+F12)。
 *
 * 现状缺口:KBEngineReferencesProvider 只挂 defDocumentSelector 且对非 .def
 * 提前返回 null——types.xml 符号(自定义类型/别名)无引用面。本模块补上:
 *
 * 1. 符号识别 `resolveTypesXmlSymbolName`:光标落在 types.xml 的
 *    - 顶层类型声明名(`<Foo>…</Foo>` 的元素名),或
 *    - `<Type>`/`<Arg>`/`<of>` 值内的类型名引用
 *    上时,返回该类型名;容器字面(ARRAY/FIXED_DICT)与 implementedBy
 *    (Python 符号,非类型引用)不当作类型符号。
 * 2. 引用扫描 `scanTypeReferencesInXml`:遍历解析树,对 `<Type>` 值文本
 *    (剔除容器字面)+其 `<of>` 子节点文本、`<Arg>` 值文本、游离 `<of>`
 *    值文本,凡 token 等于目标类型名即记一个引用位(逐 token 定位,
 *    与 collectTypeReferences 同口径)。
 *
 * 引用位与定义侧(findTypeValueDefinitionReference 同名解析链)对账:
 * 定义侧按名解析到 types.xml 声明,引用侧按名收全部使用处,双向一致。
 * includeDeclaration 语义与 def 面一致(忽略该标志,只回引用位);
 * 空结果如实 null 不虚构(调用方约定)。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  DefDocument,
  DefElementNode,
  parseDefDocument,
  getLineNumberAt,
  findDeepestElementAtOffset,
  findTextNodeAtOffset
} from './defParser';
import { findFilesAcrossRoots } from './scanRoots';
import { findCustomTypeInfo, getWorkspaceRootForDocument } from './definitionWorkspace';

export interface TypesXmlRefSite {
  /** 引用所在文件绝对路径 */
  file: string;
  /** 0 基行号 */
  line: number;
  /** 行内字符偏移(名字起点) */
  start: number;
  /** 行内字符偏移(名字终点,开区间) */
  end: number;
}

/** 容器字面不是类型引用(collectTypeReferences 同口径) */
const CONTAINER_LITERALS = new Set(['ARRAY', 'FIXED_DICT']);

/** 绝对 offset → 行内字符偏移(lineStarts 二分为线号,再回推列) */
function charOffsetFor(document: DefDocument, offset: number): number {
  const line0 = getLineNumberAt(document, offset) - 1;
  return offset - document.lineStarts[line0];
}

/**
 * 把 [startOffset,endOffset) 值区间的空白分隔 token 逐个定位,
 * 等于 target 的记引用位;excludeContainers 时 ARRAY/FIXED_DICT 不记。
 */
function collectTokenSites(
  document: DefDocument,
  file: string,
  startOffset: number,
  endOffset: number,
  target: string,
  sites: TypesXmlRefSite[],
  excludeContainers: boolean
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
    if (!(excludeContainers && CONTAINER_LITERALS.has(token)) && token === target) {
      sites.push({
        file,
        line: getLineNumberAt(document, idx) - 1,
        start: charOffsetFor(document, idx),
        end: charOffsetFor(document, idx) + token.length
      });
    }
    searchFrom = idx + token.length;
  }
}

function walkElements(node: DefElementNode, visit: (el: DefElementNode) => void): void {
  visit(node);
  for (const child of node.children) {
    if (child.kind === 'element') {
      walkElements(child, visit);
    }
  }
}

/**
 * 扫描一段 .def / types.xml 内容中对 target 类型名的引用位。
 * `<Type>` 值文本(剔除容器字面)+其 `<of>` 子节点、`<Arg>` 值文本、
 * 非 `<Type>` 子级的游离 `<of>` 值文本均收录。
 */
export function scanTypeReferencesInXml(
  content: string,
  file: string,
  target: string
): TypesXmlRefSite[] {
  const document = parseDefDocument(content);
  if (!document.root) {
    return [];
  }
  const sites: TypesXmlRefSite[] = [];
  walkElements(document.root, el => {
    if (el.name === 'Type') {
      for (const child of el.children) {
        if (child.kind === 'text') {
          collectTokenSites(document, file, child.startOffset, child.endOffset, target, sites, true);
        }
      }
      for (const child of el.children) {
        if (child.kind === 'element' && child.name === 'of') {
          collectTokenSites(document, file, child.contentStart, child.contentEnd, target, sites, false);
        }
      }
    } else if (el.name === 'Arg') {
      for (const child of el.children) {
        if (child.kind === 'text') {
          collectTokenSites(document, file, child.startOffset, child.endOffset, target, sites, false);
        }
      }
    } else if (el.name === 'of' && el.parent?.name !== 'Type') {
      collectTokenSites(document, file, el.contentStart, el.contentEnd, target, sites, false);
    }
  });
  return sites;
}

/** offset 处 word(与 vscode 的 getWordRangeAtPosition /\w+/ 同规则) */
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
 * 识别 types.xml 光标处符号的类型名:顶层类型声明名,或 `<Type>/<Arg>/<of>`
 * 值内的类型名引用。不是类型上下文(容器字面/implementedBy/其他标签)返回 null。
 */
export function resolveTypesXmlSymbolName(content: string, offset: number): string | null {
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
  // 顶层类型声明名:光标在开标签上,父为 root,名字即 word
  if (element.parent?.name === 'root' && element.name === word && offset < element.contentStart) {
    return word;
  }
  // Type/Arg/of 值内引用:光标在对应标签的值区间
  if (
    (element.name === 'Type' || element.name === 'Arg' || element.name === 'of') &&
    offset >= element.contentStart &&
    offset <= element.contentEnd
  ) {
    return word;
  }
  return null;
}

/**
 * 读取文件内容,优先开着的文档缓冲(与导航落点 readScriptLinesForNavigation
 * 同口径:未保存编辑里的引用也按缓冲计入)。
 */
function readFileContentForScan(filePath: string): string {
  const openDocument = vscode.workspace.textDocuments.find(doc => doc.fileName === filePath);
  return openDocument ? openDocument.getText() : fs.readFileSync(filePath, 'utf8');
}

/**
 * 工作区级 types.xml 符号引用查询:枚举工作区(+外部根)全部 .def 与
 * types.xml,逐文件扫描 target 的引用位;取消令牌置位即返回 null。
 * 空结果返回 null(调用方约定,不虚构)。
 */
export async function provideTypesXmlReferences(
  document: vscode.TextDocument,
  position: vscode.Position,
  token?: vscode.CancellationToken
): Promise<vscode.Location[] | null> {
  if (token?.isCancellationRequested) {
    return null;
  }
  const name = resolveTypesXmlSymbolName(document.getText(), document.offsetAt(position));
  if (!name) {
    return null;
  }
  const workspaceRoot = getWorkspaceRootForDocument(document);
  if (!workspaceRoot) {
    return null;
  }
  // 只对 types.xml 已声明的自定义类型/别名出引用;内建类型(UINT32 等)
  // 不是 types.xml 符号,无引用面(避免全仓同名内建使用处的大噪声)。
  if (!findCustomTypeInfo(name, document)) {
    return null;
  }
  const [defFiles, typesXmlFiles] = await Promise.all([
    findFilesAcrossRoots('**/*.def', null, token),
    findFilesAcrossRoots('**/types.xml', null, token)
  ]);
  const files = [...defFiles.map(uri => uri.fsPath), ...typesXmlFiles.map(uri => uri.fsPath)];
  const sites: TypesXmlRefSite[] = [];
  for (const file of files) {
    if (token?.isCancellationRequested) {
      return null;
    }
    try {
      sites.push(...scanTypeReferencesInXml(readFileContentForScan(file), file, name));
    } catch {
      // 单文件读取失败不拖垮整次引用查询(其余文件照常收录)
    }
  }
  if (token?.isCancellationRequested) {
    return null;
  }
  if (sites.length === 0) {
    return null;
  }
  return sites.map(
    site =>
      new vscode.Location(
        vscode.Uri.file(site.file),
        new vscode.Position(site.line, site.start)
      )
  );
}
