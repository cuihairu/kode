/**
 * 自定义代码片段生成器(纯逻辑层)
 * 把编辑器选区文本转成 VSCode 片段体,合并进工作区级
 * .vscode/kbengine-custom.code-snippets;落盘由命令层(extension.ts)执行。
 */

/** 工作区内自定义片段文件(相对工作区根) */
export const CUSTOM_SNIPPETS_RELATIVE_PATH = '.vscode/kbengine-custom.code-snippets';

/** 单个自定义片段条目 */
export interface SnippetEntry {
  /** 触发前缀 */
  prefix: string;
  /** 片段体(逐行) */
  body: string[];
  /** 描述(空串表示不写该字段) */
  description: string;
  /** 生效语言(scope),取生成时文档的 languageId */
  scope: string;
}

export interface MergeSnippetResult {
  /** 合并后的完整片段文件内容(2 空格缩进 JSON,尾部换行) */
  content: string;
  /** 是否覆盖了同名旧条目 */
  overwritten: boolean;
}

// 片段语法中 `\` 是转义前缀、`$` 开启 tabstop/占位符/变量,字面收录前
// 双双转义(VSCode 片段语法约定)。
export function escapeSnippetText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\$/g, '\\$');
}

/**
 * 行首空白列宽(编辑器 tabSize 列语义):空格 1 列,tab 前进到下一
 * tabSize 倍数。字符数口径在 tab/空格混用时与列语义不等价(1 枚 tab
 * 可折 4 列),去公共缩进必须按列算才保得住相对层级。
 */
export function leadingWhitespaceColumns(line: string, tabSize: number): number {
  let column = 0;
  let index = 0;
  while (index < line.length && (line[index] === ' ' || line[index] === '\t')) {
    column += line[index] === ' ' ? 1 : tabSize - (column % tabSize);
    index += 1;
  }
  return column;
}

/**
 * 按公共列数剥行首空白,余文保留原字符。剥除判据是「剥前列数 < 公共列」:
 * tab 不可拆,跨公共列的整枚一并剥除,该行保留的相对缩进只会偏浅不会偏深
 * (反向会颠倒层级);列数到达或遇非空白即止。
 */
export function stripCommonIndent(line: string, commonColumns: number, tabSize: number): string {
  let column = 0;
  let index = 0;
  while (
    index < line.length
    && column < commonColumns
    && (line[index] === ' ' || line[index] === '\t')
  ) {
    column += line[index] === ' ' ? 1 : tabSize - (column % tabSize);
    index += 1;
  }
  return line.slice(index);
}

/**
 * 选区文本 → 片段体行:统一换行为 \n,去掉首尾空行,按非空行的最少缩进
 * 去公共缩进(插入位置的缩进由编辑器补),逐行做片段语法转义。
 * 缩进按 tabSize 列语义计(编辑器 tabSize 由命令层传入):纯字符数口径
 * 在 tab/空格混用时相对层级残留偏移,列口径与编辑器 normalizeIndentation
 * 的插入语义对齐。
 */
export function selectionToSnippetBody(text: string, tabSize = 4): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    return [];
  }

  const indents = lines
    .filter(line => line.trim() !== '')
    .map(line => leadingWhitespaceColumns(line, tabSize));
  const commonIndent = Math.min(...indents);

  return lines.map(line => escapeSnippetText(stripCommonIndent(line, commonIndent, tabSize)));
}

/**
 * 把条目合并进片段文件内容:existingContent 为 null/空串时新建;已有内容
 * 必须是顶层对象的合法 JSON——手改出的注释/坏 JSON 直接抛错交命令层提示,
 * 不静默改写用户文件。同名条目视为覆盖。
 */
export function mergeSnippetEntry(
  existingContent: string | null,
  name: string,
  entry: SnippetEntry
): MergeSnippetResult {
  let root: Record<string, unknown> = {};

  if (existingContent !== null && existingContent.trim() !== '') {
    const parsed: unknown = JSON.parse(existingContent);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('自定义片段文件顶层必须是对象');
    }
    root = parsed as Record<string, unknown>;
  }

  const overwritten = Object.prototype.hasOwnProperty.call(root, name);
  const record: Record<string, unknown> = {
    scope: entry.scope,
    prefix: entry.prefix,
    body: entry.body
  };
  if (entry.description.trim() !== '') {
    record.description = entry.description;
  }
  // 条目不走普通赋值:片段名 __proto__ 会命中 Object.prototype 的 __proto__
  // 访问器,新条目不落任何自身属性即被丢掉(序列化无该片段,命令层却报已生成);
  // 官方片段装载 vs/base/common/json.ts 的 setObjectProperty 正是为该键改用
  // defineProperty 保留自身属性。spread/计算键按 CreateDataProperty 定义,
  // 同样绕开访问器,常规名称行为不变。
  root = { ...root, [name]: record };

  return { content: `${JSON.stringify(root, null, 2)}\n`, overwritten };
}
