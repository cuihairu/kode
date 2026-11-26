/**
 * Custom code snippet generator (pure logic layer)
 * Turns the editor selection text into a VSCode snippet body, merged into the
 * workspace-level .vscode/kbengine-custom.code-snippets; persisting to disk is
 * done by the command layer (extension.ts).
 */

/** The workspace custom snippets file (relative to the workspace root) */
export const CUSTOM_SNIPPETS_RELATIVE_PATH = '.vscode/kbengine-custom.code-snippets';

/** A single custom snippet entry */
export interface SnippetEntry {
  /** Trigger prefix */
  prefix: string;
  /** Snippet body (line by line) */
  body: string[];
  /** Description (an empty string means the field is not written) */
  description: string;
  /** The effective language (scope), taken from the document's languageId at generation time */
  scope: string;
}

export interface MergeSnippetResult {
  /** The merged full snippet file content (JSON with 2-space indent, trailing newline) */
  content: string;
  /** Whether a same-named older entry was overwritten */
  overwritten: boolean;
}

// In the snippet grammar `\` is the escape prefix and `$` opens a tabstop/
// placeholder/variable; both are escaped before literal inclusion (the VSCode
// snippet grammar convention).
export function escapeSnippetText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\$/g, '\\$');
}

/**
 * Leading whitespace column width (the editor's tabSize column semantics): a space
 * is 1 column, a tab advances to the next tabSize multiple. A character-count
 * ruling is not equivalent to the column semantics when tabs/spaces are mixed
 * (1 tab can fold into 4 columns); removing the common indent must be computed in
 * columns to preserve the relative hierarchy.
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
 * Strip leading whitespace up to the common column count, keeping the remaining
 * characters verbatim. The strip criterion is "columns before stripping < common
 * columns": a tab cannot be split, a whole tab crossing the common column is
 * stripped with it, and the retained relative indentation of that line can only
 * come out shallower, never deeper (the reverse would invert the hierarchy);
 * stopping when the column count is reached or a non-whitespace appears.
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
 * Selection text -> snippet body lines: normalize newlines to \n, drop leading and
 * trailing blank lines, strip the common indent by the minimum indent of the
 * non-empty lines (the insertion position's indent is supplied by the editor), and
 * escape each line for the snippet grammar. Indentation is measured in tabSize
 * column semantics (the editor's tabSize is passed in by the command layer): a pure
 * character-count ruling leaves residual offsets in relative hierarchy when tabs/
 * spaces mix, while the column ruling aligns with the editor's
 * normalizeIndentation insertion semantics.
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
 * Merge an entry into the snippet file content: creates a new file when
 * existingContent is null/an empty string; existing content must be legal JSON of
 * a top-level object — hand-edited comments/bad JSON throws straight to the command
 * layer for prompting, never silently rewriting the user's file. A same-named
 * entry counts as an overwrite.
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
  // The entry does not go through plain assignment: a snippet named __proto__
  // would hit Object.prototype's __proto__ accessor, and the new entry would be
  // dropped without landing any own property (serialization has no such snippet,
  // yet the command layer reports it generated); the official snippet loader
  // vs/base/common/json.ts's setObjectProperty uses defineProperty for exactly
  // this key to preserve own properties. Spread/computed keys follow
  // CreateDataProperty, likewise bypassing the accessor, with unchanged behavior
  // for ordinary names.
  root = { ...root, [name]: record };

  return { content: `${JSON.stringify(root, null, 2)}\n`, overwritten };
}
