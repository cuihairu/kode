import {
  getDirectChildElements,
  parseDefDocument
} from './defParser';
import type { DefDocument, DefElementNode } from './defParser';
import { parsePythonFile } from './pythonParser';

// RUST-179:创建向导纯核——往既有 def/types.xml/python 追加 RPC 方法、
// 组件槽与类型别名的插入计算。全部返回「插入点 + 文本」形状(零 vscode),
// 由命令层经 WorkspaceEdit 应用(尊重打开缓冲、可 Ctrl+Z);冲突一律拒绝
// 不改写(同名方法/槽/别名存在、解析失败、无类),绝不静默装成功。

export type EntityMethodSection = 'BaseMethods' | 'CellMethods' | 'ClientMethods';

export const ENTITY_METHOD_SECTIONS: readonly EntityMethodSection[] = [
  'BaseMethods',
  'CellMethods',
  'ClientMethods'
];

/** 插入点形状:offset 处替换 length(恒 0)字节为 text,供 WorkspaceEdit 使用 */
export interface TextInsertion {
  offset: number;
  length: 0;
  text: string;
}

export type DefInsertionFailure =
  | { reason: 'parse-failed' }
  | { reason: 'no-root' }
  | { reason: 'method-exists'; section: string }
  | { reason: 'slot-exists' }
  | { reason: 'alias-exists' };

export interface DefInsertionSuccess {
  ok: true;
  insertion: TextInsertion;
  /** 目标段原本不存在,本次插入同时创建了该段 */
  createdSection: boolean;
  /** 本次插入内容里出现的名字(方法名/槽名/别名),预览展示用 */
  name: string;
}

type DefInsertionResult = DefInsertionSuccess | { ok: false; reason: DefInsertionFailure['reason']; section?: string };

function parseDefOrUndefined(text: string): DefDocument | undefined {
  try {
    const document = parseDefDocument(text);
    return document.root ? document : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 关闭标签行首偏移:插入点必须落在行首——closeTagStart 指向 `</段>` 的
 * `<`,直接插会让新行吃掉关闭标签自己的缩进前缀(整档缩进漂移);
 * 无关闭标签(截断/自闭合残缺)返回 null,拒绝计算绝不硬插。
 */
function closeInsertionOffset(sourceText: string, closeTagStart: number): number | null {
  if (closeTagStart < 0) {
    return null;
  }
  return sourceText.lastIndexOf('\n', closeTagStart) + 1;
}

/** 元素首子元素的行首缩进(无子元素回退 fallback) */
function firstChildIndent(element: DefElementNode, sourceText: string, fallback: string): string {
  for (const child of getDirectChildElements(element)) {
    const lineStart = sourceText.lastIndexOf('\n', child.tagStart) + 1;
    const raw = sourceText.slice(lineStart, child.tagStart);
    if (/^[\t ]*$/.test(raw) && raw.length > 0) {
      return raw;
    }
    return fallback;
  }
  return fallback;
}

function sourceLineIndent(sourceText: string, offset: number, fallback: string): string {
  const lineStart = sourceText.lastIndexOf('\n', offset) + 1;
  const raw = sourceText.slice(lineStart, offset);
  return /^[\t ]+$/.test(raw) ? raw : fallback;
}

function methodDefBlock(indent: string, methodName: string, args: readonly string[], exposed: boolean): string {
  const lines: string[] = [];
  lines.push(`${indent}<${methodName}>`);
  if (exposed) {
    lines.push(`${indent}\t<Exposed> true </Exposed>`);
  }
  for (const arg of args) {
    lines.push(`${indent}\t<Arg> ${arg} </Arg>`);
  }
  lines.push(`${indent}</${methodName}>`);
  return `${lines.join('\n')}\n`;
}

function findSection(root: DefElementNode, section: EntityMethodSection | 'Components'): DefElementNode | undefined {
  return getDirectChildElements(root).find(child => child.name === section);
}

function sectionMemberNames(root: DefElementNode, sections: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const child of getDirectChildElements(root)) {
    if (!sections.includes(child.name)) {
      continue;
    }
    for (const member of getDirectChildElements(child)) {
      names.add(member.name);
    }
  }
  return names;
}

/**
 * RPC 方法 def 插入:往指定段(缺段则创建)关闭标签前追加方法声明;
 * 三个方法段任意一段已有同名方法即拒绝(引擎方法名全局唯一于实体)。
 */
export function buildRpcMethodDefInsertion(
  defText: string,
  section: EntityMethodSection,
  methodName: string,
  args: readonly string[],
  exposed: boolean
): DefInsertionResult {
  const document = parseDefOrUndefined(defText);
  if (!document || !document.root) {
    return { ok: false, reason: 'parse-failed' };
  }
  const root = document.root;
  const existing = sectionMemberNames(root, ENTITY_METHOD_SECTIONS);
  if (existing.has(methodName)) {
    const owner = ENTITY_METHOD_SECTIONS.find(candidate => {
      const holder = findSection(root, candidate);
      return Boolean(holder && getDirectChildElements(holder).some(member => member.name === methodName));
    });
    return { ok: false, reason: 'method-exists', section: owner ?? section };
  }

  const target = findSection(root, section);
  if (target) {
    const offset = closeInsertionOffset(defText, target.closeTagStart);
    if (offset === null) {
      return { ok: false, reason: 'parse-failed' };
    }
    const indent = firstChildIndent(target, defText, '\t\t');
    return {
      ok: true,
      insertion: {
        offset,
        length: 0,
        text: methodDefBlock(indent, methodName, args, exposed)
      },
      createdSection: false,
      name: methodName
    };
  }

  // 缺段:段块整体插到 root 关闭标签行首(成员缩进比段缩进深一档)
  const offset = closeInsertionOffset(defText, root.closeTagStart);
  if (offset === null) {
    return { ok: false, reason: 'parse-failed' };
  }
  const sectionIndent = '\t';
  const block =
    `${sectionIndent}<${section}>\n` +
    methodDefBlock(`${sectionIndent}\t`, methodName, args, exposed) +
    `${sectionIndent}</${section}>\n`;
  return {
    ok: true,
    insertion: {
      offset,
      length: 0,
      text: block
    },
    createdSection: true,
    name: methodName
  };
}

/** 组件 def 骨架(entity_defs/components/<Name>.def,真形态对齐 demo Inventory.def) */
export function buildComponentDefContent(componentName: string): string {
  return [
    '<root>',
    `\t<!-- ${componentName}:组件 def(KBEngine 组件与实体 def 同构装载,槽宿主经 <Components> 引用) -->`,
    '\t<Properties>',
    '\t</Properties>',
    '',
    '</root>',
    ''
  ].join('\n');
}

/**
 * 组件槽插入:往宿主实体 def 的 <Components> 段(缺段则创建)追加槽,
 * 形态对齐真资产 `<bag><Type> Inventory </Type><Persistent> true </Persistent></bag>`;
 * 已有同名槽(同段内同名元素)拒绝。
 */
export function buildComponentSlotInsertion(
  defText: string,
  slotName: string,
  componentType: string,
  persistent: boolean
): DefInsertionResult {
  const document = parseDefOrUndefined(defText);
  if (!document || !document.root) {
    return { ok: false, reason: 'parse-failed' };
  }
  const root = document.root;
  const target = findSection(root, 'Components');
  if (target) {
    if (getDirectChildElements(target).some(member => member.name === slotName)) {
      return { ok: false, reason: 'slot-exists' };
    }
    const offset = closeInsertionOffset(defText, target.closeTagStart);
    if (offset === null) {
      return { ok: false, reason: 'parse-failed' };
    }
    const indent = firstChildIndent(target, defText, '\t\t');
    const lines = [`${indent}<${slotName}>`, `${indent}\t<Type> ${componentType} </Type>`];
    if (persistent) {
      lines.push(`${indent}\t<Persistent> true </Persistent>`);
    }
    lines.push(`${indent}</${slotName}>`);
    return {
      ok: true,
      insertion: { offset, length: 0, text: `${lines.join('\n')}\n` },
      createdSection: false,
      name: slotName
    };
  }

  const rootOffset = closeInsertionOffset(defText, root.closeTagStart);
  if (rootOffset === null) {
    return { ok: false, reason: 'parse-failed' };
  }
  const indent = '\t\t';
  const lines = [
    '\t<Components>',
    `${indent}<${slotName}>`,
    `${indent}\t<Type> ${componentType} </Type>`
  ];
  if (persistent) {
    lines.push(`${indent}\t<Persistent> true </Persistent>`);
  }
  lines.push(`${indent}</${slotName}>`, '\t</Components>');
  return {
    ok: true,
    insertion: { offset: rootOffset, length: 0, text: `${lines.join('\n')}\n` },
    createdSection: true,
    name: slotName
  };
}

/**
 * types.xml 类型别名插入:`<NAME> TYPE </NAME>` 单行形态(真资产 ITEM_ID 口径),
 * 插到 root 关闭标签前;已有同名条目拒绝。
 */
export function buildTypeAliasInsertion(
  typesXmlText: string,
  aliasName: string,
  targetType: string
): DefInsertionResult {
  const document = parseDefOrUndefined(typesXmlText);
  if (!document || !document.root) {
    return { ok: false, reason: 'parse-failed' };
  }
  const root = document.root;
  if (getDirectChildElements(root).some(child => child.name === aliasName)) {
    return { ok: false, reason: 'alias-exists' };
  }
  const offset = closeInsertionOffset(typesXmlText, root.closeTagStart);
  if (offset === null) {
    return { ok: false, reason: 'parse-failed' };
  }
  // 缩进取既有条目行首(空表回退单 tab)
  const indent = '\t';
  for (const child of getDirectChildElements(root)) {
    const candidate = sourceLineIndent(typesXmlText, child.tagStart, indent);
    if (/^[\t ]+$/.test(candidate)) {
      return {
        ok: true,
        insertion: {
          offset,
          length: 0,
          text: `${candidate}<${aliasName}> ${targetType} </${aliasName}>\n`
        },
        createdSection: false,
        name: aliasName
      };
    }
  }
  return {
    ok: true,
    insertion: {
      offset,
      length: 0,
      text: `${indent}<${aliasName}> ${targetType} </${aliasName}>\n`
    },
    createdSection: false,
    name: aliasName
  };
}

export type PythonInsertionFailure =
  | { reason: 'parse-failed' }
  | { reason: 'no-class' }
  | { reason: 'method-exists' };

export interface PythonInsertionSuccess {
  ok: true;
  insertion: TextInsertion;
  className: string;
}

/**
 * RPC 方法 Python 实现插入:往实体脚本首个类体末追加方法骨架
 * (KBEngine 方法靠 def 声明绑定,py 侧只要求同名成员存在);
 * 已有同名方法拒绝,文件无类拒绝(实体脚本必有实体类,缺失=不是可注入目标)。
 */
export function buildRpcMethodPythonInsertion(
  pyText: string,
  filePath: string,
  methodName: string,
  args: readonly string[]
): PythonInsertionSuccess | { ok: false; reason: PythonInsertionFailure['reason'] } {
  let parsed;
  try {
    parsed = parsePythonFile(pyText, filePath);
  } catch {
    return { ok: false, reason: 'parse-failed' };
  }
  const target = parsed.classes[0];
  if (!target) {
    return { ok: false, reason: 'no-class' };
  }
  if (target.methods.has(methodName)) {
    return { ok: false, reason: 'method-exists' };
  }

  const lines = pyText.split(/\r?\n/);
  // 类体最后一行(0 基):endLine 不含,故最后一行 = endLine - 1
  let bodyLastLine = Math.min(target.endLine - 1, lines.length - 1);
  // 跳过类尾空行/纯注释缩进行,贴住最后一个实质行
  while (bodyLastLine > target.startLine && lines[bodyLastLine]?.trim() === '') {
    bodyLastLine -= 1;
  }
  // 插入点 = bodyLastLine 行的行尾(含换行符);逐行按原始 \n 位置推进,
  // 对 \n 与 \r\n 两种行尾都精确
  let insertionOffset = 0;
  for (let line = 0; line <= bodyLastLine; line += 1) {
    const newline = pyText.indexOf('\n', insertionOffset);
    insertionOffset = newline === -1 ? pyText.length : newline + 1;
  }

  const signature = ['self', ...args.map((arg, index) => `arg${index + 1}`)].join(', ');
  const body =
    `\n\tdef ${methodName}(${signature}):\n` +
    `\t\t"KBEngine method."\n` +
    `\t\tpass\n`;
  return {
    ok: true,
    insertion: { offset: insertionOffset, length: 0, text: body },
    className: target.name
  };
}
