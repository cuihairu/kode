// .def 属性/方法重命名的纯逻辑(COMPLETED_FEATURES「重构支持」):
// 从文本与偏移解析可重命名符号(顶层 Properties 的属性 / 三个方法段的方法),
// 并在定义树内计算全部引用编辑点(同文件声明 + 后代 def 复述)。不依赖 vscode;
// 定义根定位从目标文件向上找 entities.xml 推导(KBEngine 布局 entities.xml
// 位于 entity_defs 的父目录,见 definitionWorkspace 的布局候选)。
//
// 作用域与边界(如实说明,COMPLETED_FEATURES.md 同步记录;批96 引擎复核对齐):
// - 符号 = 顶层 Properties 直接子元素(属性,同名全部 Flags 作用域变体算同一
//   文本符号)或某方法段直接子元素(方法,段是命名空间,Base/Cell/Client
//   互不相干)。嵌套结构(FIXED_DICT 内层字段等)不是独立符号。
// - 引用 = 同文件同名符号 + 后代 def 的同名复述。传播边对齐引擎装载路径
//   (entitydef.cpp):Parent/接口 wrapper 的名取首个子节点(文本取文本、
//   元素取标签名,同引擎 getKey;`<Parent> Hero </Parent>` 与紧凑的
//   `<Parent><Hero/></Parent>` 都认,但标签间换行缩进使首子节点成空白
//   文本 → 空名不产生边,引擎同样装载不到),按 owner 类别解析——实体在
//   定义根、组件 def 在 components/ 内,接口文件装载时不读 Parent
//   (loadInterfaces 不走 loadParentClass);Interfaces 只认 wrapper 形态
//   (interface/Interface/type/Type 包裹),固定解析到 interfaces/ 子目录。
//   以接口名直接命名的 <Interfaces> 子元素引擎不装载,不产生传播边;
//   悬空引用同样不产生边。
// - 在复述处发起重命名只更新该文件与其后代,不复改祖先源头声明。
// - 仅覆盖 .def 面:Python 侧 self.x / 方法调用、entities.xml、types.xml、
//   数据库 schema 虚拟文档与资源管理器引用不在重命名范围内;新名与既有
//   方法/属性/组件跨面同名的装载冲突不在此校验(引擎侧 addProperty/
//   addMethodDescription 为装载错误,可由 defAnalyzer 的同名检查项提示)。
// - 找不到 entities.xml 定位定义根时退化为仅同文件;新名非法(非 C 风格
//   标识符)或与原名相同返回空编辑。
import * as fs from 'fs';
import * as path from 'path';
import {
  DEF_METHOD_SECTIONS,
  DefDocument,
  DefElementNode,
  DefMethodSection,
  getDirectChildElement,
  getDirectChildElements,
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
  // 不可达(批62 定性):tagStart/tagEnd/name 都出自同一份 text 的同一次解析
  // (defParser 的 tokenizeXml 扫描 `<`…`>` 得到),切片必以该标签名开头;
  // 越界与自闭合已由上方范围守卫拦下,该正则无失配路径。
  /* istanbul ignore start */
  if (!match) {
    return null;
  }
  /* istanbul ignore stop */
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
      // 不可达(批68 定性):open 侧的 tagStart/tagEnd 出自 defParser 的
      // tokenizeXml——每个元素先建节点再以 open/self 令牌回填,二者恒满足
      // tagStart ≥ 0 且 tagEnd > tagStart 且不越过文本长度 ⇒ 范围守卫对
      // open 侧恒假,open 恒真,判空假臂无触发路径(close 侧由自闭合的
      // closeTagStart === closeTagEnd 真实走到)。分支条目(含已覆盖真臂)
      // 随区间移出分母,真臂行为由既有重命名用例锁定。
      /* istanbul ignore start */
      if (open) {
      /* istanbul ignore stop */
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

/**
 * 引擎在 `<Interfaces>` 下只认这四种 wrapper 拼写(entitydef.cpp:563-566,
 * 大小写敏感);以接口名直接命名的子元素(如 `<MoveIface/>`)引擎不装载,
 * 这里同样不跟随。
 */
const INTERFACE_WRAPPER_NAMES = new Set(['interface', 'Interface', 'type', 'Type']);

/**
 * 引擎的取名语义(entitydef.cpp 对 `<Parent>`/接口 wrapper 的取值:
 * `enterNode` 拿到元素后取其**首个子节点**,再经 xml.cpp 的
 * `getKey = kbe_trim(node->Value())`——文本节点取文本,元素取标签名):
 * `<Parent> Hero </Parent>` 与 `<Parent><Hero/></Parent>` 两种紧凑写法都得
 * 'Hero';但混合内容只看第一个子节点,`<Parent>` 与 `<Hero/>` 之间换行缩进
 * 时首子节点是空白文本,引擎取到空名、拼不出父类文件(装载失败)——
 * 这里同样得空名,不产生边。
 */
function getReferenceTargetName(node: DefElementNode): string {
  const firstChild = node.children[0];
  if (!firstChild) {
    return '';
  }
  return (firstChild.kind === 'text' ? firstChild.text : firstChild.name).trim();
}

/** def 文件的直接语义面:Parent 名 + Interfaces 引用名(对齐引擎装载语法) */
function parseDefFileSemantics(content: string): DefFileSemantics | null {
  const document = parseDefText(content);
  if (!document?.root) {
    return null;
  }
  const parentNode = getDirectChildElement(document.root, 'Parent');
  const parentName = parentNode ? getReferenceTargetName(parentNode) || null : null;
  const interfaceNames: string[] = [];
  for (const section of getDirectChildElements(document.root)) {
    if (section.name !== 'Interfaces') {
      continue;
    }
    for (const reference of getDirectChildElements(section)) {
      if (!INTERFACE_WRAPPER_NAMES.has(reference.name)) {
        continue;
      }
      // 自闭合/空 wrapper 得空名,等价悬空引用,跳过(引擎同样取不到名)
      const name = getReferenceTargetName(reference);
      if (name) {
        interfaceNames.push(name);
      }
    }
  }
  return { parentName, interfaceNames };
}

interface DefLinkPaths {
  parentPath: string | null;
  interfacePaths: string[];
}

/**
 * 引擎的边解析面(entitydef.cpp):实体 Parent 平铺在定义根(`<root>/<P>.def`,
 * loadParentClass L890-920);接口固定在 interfaces/ 子目录(loadInterfaces
 * L551-640,组件亦从原定义根解析,L765);组件 def 的 Parent 在 components/
 * 内解析(loadComponents L774)。接口文件装载时不读 Parent(loadInterfaces
 * 只递归描述/DetailLevel/接口,不走 loadParentClass)——其 `<Parent>` 声明
 * 对引擎不可见,这里同样不产生边。
 */
function resolveLinkPaths(defsRoot: string, entry: DefFileEntry, semantics: DefFileSemantics): DefLinkPaths {
  const interfacePaths = semantics.interfaceNames.map(name =>
    path.join(defsRoot, 'interfaces', `${name}.def`));
  let parentPath: string | null = null;
  if (semantics.parentName && entry.category !== 'interface') {
    const parentDir = entry.category === 'component'
      ? path.join(defsRoot, 'components')
      : defsRoot;
    parentPath = path.join(parentDir, `${semantics.parentName}.def`);
  }
  return { parentPath, interfacePaths };
}

/**
 * 文件 owner 的祖先闭包(Parent 链 + Interfaces 混入,传递),值为命中文件
 * 的绝对路径——按引擎装载路径精确解析,悬空引用不产生边。
 */
function collectOwnerClosure(
  entry: DefFileEntry,
  defsRoot: string,
  fileIndex: Map<string, DefFileEntry>,
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
    const links = resolveLinkPaths(defsRoot, current, semantics);
    for (const targetPath of [links.parentPath, ...links.interfacePaths]) {
      if (!targetPath) {
        continue;
      }
      const targetEntry = fileIndex.get(path.resolve(targetPath));
      if (!targetEntry) {
        continue;
      }
      closure.add(targetEntry.filePath);
      if (!seen.has(targetEntry.filePath)) {
        seen.add(targetEntry.filePath);
        queue.push(targetEntry);
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
  const fileIndex = new Map<string, DefFileEntry>();
  for (const entry of files) {
    fileIndex.set(entry.filePath, entry);
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

  for (const entry of files) {
    if (entry.filePath === targetEntry.filePath) {
      continue;
    }
    const content = readContent(entry.filePath);
    if (content === null) {
      continue;
    }
    const closure = collectOwnerClosure(entry, defsRoot, fileIndex, loadSemantics);
    if (!closure.has(targetEntry.filePath)) {
      continue;
    }
    const edits = collectRenameEditsInText(content, symbol);
    if (edits.length > 0) {
      results.push({ filePath: entry.filePath, edits, text: content });
    }
  }

  return results.sort((left, right) => left.filePath.localeCompare(right.filePath));
}
