// .def 属性/方法重命名的纯逻辑(COMPLETED_FEATURES「重构支持」):
// 从文本与偏移解析可重命名符号(顶层 Properties 的属性 / 三个方法段的方法),
// 并在定义树内计算全部引用编辑点(同文件声明 + 后代 def 复述)。不依赖 vscode;
// 定义根定位从目标文件向上找 entities.xml 推导(KBEngine 布局 entities.xml
// 位于 entity_defs 的父目录,见 definitionWorkspace 的布局候选)。
//
// 作用域与边界(如实说明,COMPLETED_FEATURES.md 同步记录):
// - 符号 = 顶层 Properties 直接子元素(属性,同名全部 Flags 作用域变体算同一
//   文本符号)或某方法段直接子元素(方法,段是命名空间,Base/Cell/Client
//   互不相干)。嵌套结构(FIXED_DICT 内层字段等)不是独立符号。
// - 引用 = 同文件同名符号 + 祖先闭包含目标 owner 的后代 def 中的同名复述
//   (Parent 链与 Interfaces 混入的传递闭包;Components 槽不参与)。
// - 在复述处发起重命名只更新该文件与其后代,不复改祖先源头声明。
// - 仅覆盖 .def 面:Python 侧 self.x / 方法调用、entities.xml、types.xml、
//   数据库 schema 虚拟文档与资源管理器引用不在重命名范围内。
// - 找不到 entities.xml 定位定义根时退化为仅同文件;新名非法(非 C 风格
//   标识符)或与原名相同返回空编辑。
import * as fs from 'fs';
import * as path from 'path';
import {
  DEF_METHOD_SECTIONS,
  DefDocument,
  DefElementNode,
  DefMethodSection,
  getDirectChildElements,
  getScalarChildValue,
  parseDefDocument
} from './defParser';

export type DefRenameSymbolKind = 'property' | 'method';

export interface DefRenameSymbol {
  kind: DefRenameSymbolKind;
  name: string;
  /** 方法所属段;属性为 null */
  section: DefMethodSection | null;
  /** 光标所在名字区间(相对全文偏移,含端不含尾),供 prepareRename */
  wordStart: number;
  wordEnd: number;
}

export interface DefRenameEditRange {
  start: number;
  end: number;
}

export interface DefRenameFileEdits {
  filePath: string;
  /** 该文件内全部开/闭标签名字区间,升序;区间相对 text */
  edits: DefRenameEditRange[];
  /** edits 的计算基准文本(消费方据此换算行列,不重复读盘) */
  text: string;
}

export interface DefRenameOptions {
  targetFilePath: string;
  targetText: string;
  symbol: DefRenameSymbol;
  newName: string;
}

/** def 属性/方法名的合法形态(C 风格标识符;实体名的首字母大写约束不适用于成员) */
export const DEF_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 偏移 → 0 基行列(vscode.TextEdit 的坐标;按 \n 分行,与 fake-vscode 同口径) */
export function getLineCharacterAtOffset(text: string, offset: number): { line: number; character: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < clamped; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: clamped - lineStart };
}

const METHOD_SECTION_SET = new Set<string>(DEF_METHOD_SECTIONS);

type DefOwnerCategory = 'entity' | 'interface' | 'component';

interface DefFileEntry {
  filePath: string;
  category: DefOwnerCategory;
  name: string;
}

interface DefFileSemantics {
  parentName: string | null;
  interfaceNames: string[];
}

function isIdentifierChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 光标处(或紧贴词尾右侧一格)的标识符词区间;无词返回 null */
function findIdentifierAtOffset(text: string, offset: number): DefRenameEditRange | null {
  if (offset < 0 || text.length === 0) {
    return null;
  }
  let start = offset;
  if (start >= text.length || !isIdentifierChar(text[start])) {
    if (start > 0 && isIdentifierChar(text[start - 1])) {
      start -= 1;
    } else {
      return null;
    }
  }
  while (start > 0 && isIdentifierChar(text[start - 1])) {
    start -= 1;
  }
  let end = start + 1;
  while (end < text.length && isIdentifierChar(text[end])) {
    end += 1;
  }
  return { start, end };
}

/**
 * 元素标签内名字的精确区间。tokenizer 允许 `< hp>`/`</ hp>` 这类空白形态,
 * 故不能盲取 tagStart+1,须在标签文本上重匹配。
 */
function getTagNameRange(
  text: string,
  element: DefElementNode,
  part: 'open' | 'close'
): DefRenameEditRange | null {
  const tagStart = part === 'open' ? element.tagStart : element.closeTagStart;
  const tagEnd = part === 'open' ? element.tagEnd : element.closeTagEnd;
  // 自闭合元素 closeTagStart === closeTagEnd,天然被排除
  if (tagStart < 0 || tagEnd <= tagStart || tagEnd > text.length) {
    return null;
  }
  const match = new RegExp(`^<\\s*/?\\s*${escapeRegExp(element.name)}\\b`)
    .exec(text.slice(tagStart, tagEnd));
  if (!match) {
    return null;
  }
  const start = tagStart + match[0].length - element.name.length;
  return { start, end: start + element.name.length };
}

function containsRange(outer: DefRenameEditRange, inner: DefRenameEditRange): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

function parseDefText(text: string): DefDocument | null {
  try {
    return parseDefDocument(text);
  } catch {
    return null;
  }
}

/**
 * 解析偏移处的可重命名符号。要求光标落在符号元素的名字上(开标签或闭标签),
 * 且该元素是顶层 Properties / 方法段的直接子元素;否则返回 null。
 */
export function resolveRenameSymbolAtOffset(text: string, offset: number): DefRenameSymbol | null {
  const wordRange = findIdentifierAtOffset(text, offset);
  if (!wordRange) {
    return null;
  }
  const document = parseDefText(text);
  if (!document?.root) {
    return null;
  }
  const word = text.slice(wordRange.start, wordRange.end);

  for (const section of getDirectChildElements(document.root)) {
    const isPropertySection = section.name === 'Properties';
    const isMethodSection = METHOD_SECTION_SET.has(section.name);
    if (!isPropertySection && !isMethodSection) {
      continue;
    }
    for (const child of getDirectChildElements(section)) {
      if (child.name !== word) {
        continue;
      }
      for (const part of ['open', 'close'] as const) {
        const nameRange = getTagNameRange(text, child, part);
        if (nameRange && containsRange(nameRange, wordRange)) {
          return {
            kind: isPropertySection ? 'property' : 'method',
            name: word,
            section: isPropertySection ? null : section.name as DefMethodSection,
            wordStart: nameRange.start,
            wordEnd: nameRange.end
          };
        }
      }
    }
  }
  return null;
}

/** 收集一份 def 文本里符号的全部名字区间(开标签 + 非自闭合的闭标签) */
export function collectRenameEditsInText(text: string, symbol: DefRenameSymbol): DefRenameEditRange[] {
  const document = parseDefText(text);
  if (!document?.root) {
    return [];
  }
  const ranges: DefRenameEditRange[] = [];
  for (const section of getDirectChildElements(document.root)) {
    const sectionMatches = symbol.kind === 'method'
      ? section.name === symbol.section
      : section.name === 'Properties';
    if (!sectionMatches) {
      continue;
    }
    for (const child of getDirectChildElements(section)) {
      if (child.name !== symbol.name) {
        continue;
      }
      const open = getTagNameRange(text, child, 'open');
      if (open) {
        ranges.push(open);
      }
      const close = getTagNameRange(text, child, 'close');
      if (close) {
        ranges.push(close);
      }
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function isPathInside(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 从目标文件向上推导 entity_defs 定义根:KBEngine 常规布局 entities.xml 在
 * entity_defs 的父目录,故命中含 entities.xml 的目录后须确认目标文件确实位于
 * 其 entity_defs 子树下;找不到 entities.xml 返回 null(调用方退化为仅同文件)。
 */
export function findEntityDefsRootFromFile(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  let dir = path.dirname(resolved);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'entities.xml'))) {
      const defsRoot = path.join(dir, 'entity_defs');
      if (isPathInside(defsRoot, resolved)) {
        return defsRoot;
      }
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** 调用方约定 filePath 在 defsRoot 内(根由目标文件自身向上推导/枚举构造),无需再判空 */
function classifyDefFile(defsRoot: string, filePath: string): DefFileEntry {
  const relative = path.relative(defsRoot, filePath).split(path.sep);
  let category: DefOwnerCategory = 'entity';
  if (relative.some(segment => segment === 'interfaces')) {
    category = 'interface';
  } else if (relative.some(segment => segment === 'components')) {
    category = 'component';
  }
  return {
    filePath: path.resolve(filePath),
    category,
    name: path.basename(filePath, '.def')
  };
}

function listDefFilesRecursive(defsRoot: string): DefFileEntry[] {
  const entries: DefFileEntry[] = [];
  const walk = (dir: string): void => {
    let dirents: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true }) as fs.Dirent[];
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const fullPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(fullPath);
      } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.def')) {
        entries.push(classifyDefFile(defsRoot, fullPath));
      }
    }
  };
  walk(defsRoot);
  return entries.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

/** def 文件的直接语义面:Parent 实体名 + Interfaces 引用名(对齐 definitionSemantics 的三形态) */
function parseDefFileSemantics(content: string): DefFileSemantics | null {
  const document = parseDefText(content);
  if (!document?.root) {
    return null;
  }
  const parentName = getScalarChildValue(document.root, 'Parent')?.trim() || null;
  const interfaceNames: string[] = [];
  for (const section of getDirectChildElements(document.root)) {
    if (section.name !== 'Interfaces') {
      continue;
    }
    for (const reference of getDirectChildElements(section)) {
      if (reference.name === 'Interface') {
        // <Interface><MoveIface/></Interface> 取首子元素名;自闭合无名跳过
        const firstChild = getDirectChildElements(reference)[0];
        if (firstChild) {
          interfaceNames.push(firstChild.name);
        }
      } else {
        // <MoveIface/> 直取标签名
        interfaceNames.push(reference.name);
      }
    }
  }
  return { parentName, interfaceNames };
}

function ownerKey(category: DefOwnerCategory, name: string): string {
  return `${category}:${name}`;
}

/**
 * 文件 owner 的祖先闭包(Parent 链 + Interfaces 混入,传递),键为
 * `${category}:${name}`。Parent 指向实体;Interfaces 指向 interfaces/ 目录。
 */
function collectOwnerClosure(
  entry: DefFileEntry,
  ownerIndex: Map<string, DefFileEntry>,
  loadSemantics: (filePath: string) => DefFileSemantics | null
): Set<string> {
  const closure = new Set<string>();
  const seen = new Set<string>([entry.filePath]);
  const queue: DefFileEntry[] = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as DefFileEntry;
    const semantics = loadSemantics(current.filePath);
    if (!semantics) {
      continue;
    }
    if (semantics.parentName) {
      const parentEntry = ownerIndex.get(ownerKey('entity', semantics.parentName));
      if (parentEntry) {
        closure.add(ownerKey('entity', parentEntry.name));
        if (!seen.has(parentEntry.filePath)) {
          seen.add(parentEntry.filePath);
          queue.push(parentEntry);
        }
      }
    }
    for (const interfaceName of semantics.interfaceNames) {
      const ifaceEntry = ownerIndex.get(ownerKey('interface', interfaceName));
      if (!ifaceEntry) {
        continue;
      }
      closure.add(ownerKey('interface', ifaceEntry.name));
      if (!seen.has(ifaceEntry.filePath)) {
        seen.add(ifaceEntry.filePath);
        queue.push(ifaceEntry);
      }
    }
  }
  return closure;
}

/**
 * 计算重命名的全部编辑:目标文件的同名符号 + 后代 def 里的同名复述。
 * 新名非法或与原名相同、无法解析目标文件时返回空数组(provider 层归一为 null)。
 */
export function computeDefRenameEdits(options: DefRenameOptions): DefRenameFileEdits[] {
  const { targetFilePath, targetText, symbol, newName } = options;
  if (!DEF_IDENTIFIER_PATTERN.test(newName) || newName === symbol.name) {
    return [];
  }

  const resolvedTarget = path.resolve(targetFilePath);
  const targetEdits = collectRenameEditsInText(targetText, symbol);
  const results: DefRenameFileEdits[] = targetEdits.length > 0
    ? [{ filePath: resolvedTarget, edits: targetEdits, text: targetText }]
    : [];
  if (targetEdits.length === 0) {
    return results;
  }

  const defsRoot = findEntityDefsRootFromFile(resolvedTarget);
  if (!defsRoot) {
    return results;
  }
  const targetEntry = classifyDefFile(defsRoot, resolvedTarget);

  const files = listDefFilesRecursive(defsRoot);
  const ownerIndex = new Map<string, DefFileEntry>();
  for (const entry of files) {
    ownerIndex.set(ownerKey(entry.category, entry.name), entry);
  }

  // 每个文件至多读盘一次:语义面与编辑面共用同一份内容(不可读即 null)
  const contentCache = new Map<string, string | null>();
  const readContent = (filePath: string): string | null => {
    if (!contentCache.has(filePath)) {
      contentCache.set(filePath, readFileOrNull(filePath));
    }
    return contentCache.get(filePath) ?? null;
  };
  const loadSemantics = (filePath: string): DefFileSemantics | null => {
    const content = readContent(filePath);
    return content === null ? null : parseDefFileSemantics(content);
  };

  const targetOwnerKey = ownerKey(targetEntry.category, targetEntry.name);
  for (const entry of files) {
    if (entry.filePath === targetEntry.filePath) {
      continue;
    }
    const content = readContent(entry.filePath);
    if (content === null) {
      continue;
    }
    const closure = collectOwnerClosure(entry, ownerIndex, loadSemantics);
    if (!closure.has(targetOwnerKey)) {
      continue;
    }
    const edits = collectRenameEditsInText(content, symbol);
    if (edits.length > 0) {
      results.push({ filePath: entry.filePath, edits, text: content });
    }
  }

  return results.sort((left, right) => left.filePath.localeCompare(right.filePath));
}
