import * as vscode from 'vscode';
import {
  findDeepestElementAtOffset,
  getDirectChildElements,
  parseDefDocument,
  type DefDocument,
  type DefElementNode
} from '../backend/defParser';
import { KBENGINE_TYPES } from '../backend/kbengineMetadata';
import { getEntityCustomTypesSnapshot, getWorkspaceRootForDocument, type CustomTypeInfo } from '../definitionWorkspace';

/**
 * alias.xml 直接编辑能力(KODE-SYN-003):条目目标位的补全与跳转。
 *
 * 引擎装载语境(datatypes.cpp loadTypes 单遍):alias.xml 在 types.xml 之后
 * 装载,条目目标只可解内建名、types.xml 已注册名与本文件**先于本条**声明的
 * 别名名(前向引用/循环引擎报错中止)。两个 provider 只按这条可解域供货:
 * 补全不供后文名,跳转只落可解声明位,不猜文档身份。
 *
 * 纯 vscode provider 薄壳:注册表统一走 getEntityCustomTypesSnapshot
 * (语义索引快照,types.xml 未保存编辑经 open-version 前进即时生效);
 * 本文件未保存条目按缓冲文本解析,与诊断面 validateAliasXmlDocument
 * 同一装载语境。
 */

/** alias.xml 顶层条目(根的直接子元素)目标位语境 */
interface AliasEntryContext {
  /** 光标所在顶层条目 */
  entry: DefElementNode;
  /** 条目名(别名名) */
  entryName: string;
}

/** 可解域条目(补全/跳转共用):本文件先于光标的条目或 types.xml 注册面 */
interface ResolvableEntry {
  name: string;
  /** 本文件条目:同文档区间;types.xml 条目:文件+行 */
  location:
    | { kind: 'document'; entry: DefElementNode }
    | { kind: 'registry'; info: CustomTypeInfo };
}

/** 词边界取词(与 typesXmlReferences wordAt 同口径:标识符字符) */
function wordAt(content: string, offset: number): string {
  const isWordChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);
  let start = offset;
  while (start > 0 && isWordChar(content[start - 1])) {
    start -= 1;
  }
  let end = offset;
  while (end < content.length && isWordChar(content[end])) {
    end += 1;
  }
  return content.slice(start, end);
}

/** 解析 alias.xml 文档(畸形返回 null,与诊断面零发现口径一致) */
function parseAliasDocument(content: string): DefDocument | null {
  try {
    const document = parseDefDocument(content);
    return document.root ? document : null;
  } catch {
    return null;
  }
}

/**
 * 光标是否在某顶层条目内,并给出条目语境。目标位=条目体内(开标签之后);
 * 光标在条目名/闭标签上不属于目标位(那是别名声明本身,不在本模块供货域)。
 */
function aliasEntryContextAt(document: DefDocument, offset: number): AliasEntryContext | null {
  if (!document.root) {
    return null;
  }
  for (const entry of getDirectChildElements(document.root)) {
    if (offset >= entry.tagStart && offset <= entry.closeTagEnd) {
      // 条目名段(开标签内)不是目标位
      if (offset < entry.contentStart) {
        return null;
      }
      return { entry, entryName: entry.name.trim() };
    }
  }
  return null;
}

/** 光标处的目标词:目标位上有词才供货;ARRAY/FIXED_DICT 是声明关键字非引用名 */
function targetWordAt(content: string, document: DefDocument, offset: number): string | null {
  const context = aliasEntryContextAt(document, offset);
  if (!context) {
    return null;
  }
  const word = wordAt(content, offset);
  if (!word || word === 'ARRAY' || word === 'FIXED_DICT') {
    return null;
  }
  return word;
}

/**
 * 可解域三源(引擎单遍装载序):
 * ① 本文件先于光标的条目(含未保存缓冲条目;`excludeName`=光标所在条目自身
 *   ——引擎读指引时本条尚未注册,自引用与前向引用同口径);
 * ② types.xml 注册面(快照,过滤 alias.xml 来源——alias 条目只认本文件序)。
 * 内建名单独由 BUILTIN 集合承载,不入此列。
 */
function resolvableEntriesBefore(
  document: DefDocument,
  offset: number,
  registry: readonly CustomTypeInfo[],
  excludeName?: string
): ResolvableEntry[] {
  const entries: ResolvableEntry[] = [];
  const seen = new Set<string>();
  if (document.root) {
    for (const entry of getDirectChildElements(document.root)) {
      const name = entry.name.trim();
      if (
        !name ||
        name.startsWith('_') ||
        entry.contentStart >= offset ||
        name === excludeName
      ) {
        continue;
      }
      if (seen.has(name.toLowerCase())) {
        continue;
      }
      seen.add(name.toLowerCase());
      entries.push({ name, location: { kind: 'document', entry } });
    }
  }
  for (const info of registry) {
    if (info.filePath.endsWith('alias.xml') || info.name.startsWith('_')) {
      continue;
    }
    if (seen.has(info.name.toLowerCase())) {
      continue;
    }
    seen.add(info.name.toLowerCase());
    entries.push({ name: info.name, location: { kind: 'registry', info } });
  }
  return entries;
}

/** 内建类型名集合(补全供货 + 跳转负判:内建名无文件落点,返回空) */
const BUILTIN_NAMES: ReadonlySet<string> = new Set(KBENGINE_TYPES.map(item => item.name));

export async function provideAliasXmlCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.CompletionItem[]> {
  const content = document.getText();
  const parsed = parseAliasDocument(content);
  if (!parsed) {
    return [];
  }
  const offset = document.offsetAt(position);
  // 目标位语境:光标须在某顶层条目体内(开标签后),否则零供货
  if (!aliasEntryContextAt(parsed, offset)) {
    return [];
  }
  const root = getWorkspaceRootForDocument(document) ?? '';
  const registry = root ? getEntityCustomTypesSnapshot(root) : [];
  const enclosing = aliasEntryContextAt(parsed, offset);
  const items: vscode.CompletionItem[] = [];

  // 声明关键字(引擎指引分支:FIXED_DICT/ARRAY 复合结构入口)
  for (const keyword of ['ARRAY', 'FIXED_DICT'] as const) {
    const item = new vscode.CompletionItem(
      keyword,
      vscode.CompletionItemKind.Keyword
    );
    item.detail = '复合类型声明关键字';
    items.push(item);
  }
  // 内建类型
  for (const builtin of KBENGINE_TYPES) {
    const item = new vscode.CompletionItem(
      builtin.name,
      vscode.CompletionItemKind.Unit
    );
    item.detail = 'KBEngine 内建类型';
    items.push(item);
  }
  // 可解域自定义名(本文件先于光标条目 + types.xml 注册面;去重已内置,
  // 光标所在条目自身排除=自引用同引擎「读指引时本条未注册」口径)
  for (const entry of resolvableEntriesBefore(parsed, offset, registry, enclosing?.entryName)) {
    const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Class);
    item.detail =
      entry.location.kind === 'document'
        ? '本文档先声明的别名'
        : 'types.xml 已注册类型';
    items.push(item);
  }
  return items;
}

export async function provideAliasXmlDefinition(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.Location[] | null> {
  const content = document.getText();
  const parsed = parseAliasDocument(content);
  if (!parsed) {
    return null;
  }
  const offset = document.offsetAt(position);
  const word = targetWordAt(content, parsed, offset);
  if (!word) {
    return null;
  }
  // 内建名无声明落点(引擎内建表非文档实体)
  if (BUILTIN_NAMES.has(word)) {
    return [];
  }
  const root = getWorkspaceRootForDocument(document) ?? '';
  const registry = root ? getEntityCustomTypesSnapshot(root) : [];
  const enclosing = aliasEntryContextAt(parsed, offset);
  const hit = resolvableEntriesBefore(parsed, offset, registry, enclosing?.entryName).find(
    entry => entry.name === word
  );
  if (!hit) {
    return [];
  }
  if (hit.location.kind === 'document') {
    const entry = hit.location.entry;
    return [
      new vscode.Location(
        document.uri,
        new vscode.Range(
          document.positionAt(entry.tagStart),
          document.positionAt(entry.closeTagEnd)
        )
      )
    ];
  }
  const info = hit.location.info;
  const targetUri = vscode.Uri.file(info.filePath);
  const startLine = Math.max(0, info.line - 1);
  return [
    new vscode.Location(
      targetUri,
      new vscode.Range(startLine, 0, startLine, Number.MAX_SAFE_INTEGER)
    )
  ];
}
