/** 一个类的定义(含它自己的 `def` 方法) */
export interface PythonClassDef {
  name: string;
  /** 基类表达式，保留模块与 import 别名。 */
  bases: string[];
  qualifiedName?: string;
  filePath: string;
  /** 0-based 起始行(class 语句行) */
  startLine: number;
  /** 0-based 结束行(不含) */
  endLine: number;
  /** 方法名 → 定义位置(0-based 行/列) */
  methods: Map<string, { line: number; character: number }>;
}

/** 解析结果:类按文件聚合 + 全局 className → 定义 多映射(同名类可能多处) */
export interface ParsedPythonFile {
  filePath: string;
  classes: PythonClassDef[];
  imports?: Map<string, { module: string; symbol?: string }>;
  /** 模块级实例赋值 `NAME = CLASS(...)`(types.xml implementedBy 指向实现对象,经此解析 实例→类) */
  instanceAssignments: Array<{ variable: string; className: string; line: number }>;
}

/** Mask comments and literals without shifting any source positions. */
function pythonCodeLines(content: string): string[] {
  let quote = '';
  let triple = false;
  return content.split(/\r?\n/).map(raw => {
    let masked = '';
    for (let col = 0; col < raw.length; col += 1) {
      const ch = raw[col];
      if (quote) {
        if (ch === '\\') { masked += '  '; col += 1; continue; }
        if (triple && raw.slice(col, col + 3) === quote.repeat(3)) {
          quote = ''; triple = false; masked += '   '; col += 2;
        } else if (!triple && ch === quote) { quote = ''; masked += ' '; }
        else { masked += ' '; }
        continue;
      }
      if (ch === '#') { masked += ' '.repeat(raw.length - col); break; }
      if (ch === "'" || ch === '"') {
        quote = ch;
        triple = raw.slice(col, col + 3) === ch.repeat(3);
        masked += triple ? '___' : '_';
        if (triple) { col += 2; }
      } else { masked += ch; }
    }
    return masked;
  });
}

export function isPythonCodePosition(content: string, line: number, character: number): boolean {
  const raw = content.split(/\r?\n/)[line] ?? '';
  const col = /\w/.test(raw[character] ?? '') ? character : Math.max(0, character - 1);
  return /\w/.test(raw[col] ?? '') && pythonCodeLines(content)[line]?.[col] === raw[col];
}

/** Join bracket/backslash continuations, retaining the first line's coordinates. */
function pythonStatements(content: string): Array<{ text: string; line: number; endLine: number; indent: number }> {
  const statements: Array<{ text: string; line: number; endLine: number; indent: number }> = [];
  let depth = 0;
  let pending = '';
  let start = 0;
  let indent = 0;
  for (const [line, masked] of pythonCodeLines(content).entries()) {
    if (!pending && !masked.trim()) { continue; }
    if (!pending) {
      start = line;
      indent = masked.match(/^[ \t]*/)![0].replace(/\t/g, '    ').length;
    }
    for (const ch of masked) {
      if ('([{'.includes(ch)) { depth += 1; }
      if (')]}'.includes(ch)) { depth = Math.max(0, depth - 1); }
    }
    const continued = /\\\s*$/.test(masked);
    pending += (pending ? ' ' : '') + masked.replace(/\\\s*$/, '');
    if (depth === 0 && !continued) {
      statements.push({ text: pending, line: start, endLine: line, indent });
      pending = '';
    }
  }
  return statements;
}

/** Base expression under the cursor, including multiline headers and aliases. */
export function getPythonBaseExpressionAtPosition(content: string, line: number, character: number): string | null {
  const statement = pythonStatements(content).find(item => item.line <= line && line <= item.endLine && /^\s*class\s/.test(item.text));
  if (!statement) { return null; }
  const header = /^\s*class\s+\w+\s*\((.*)\)\s*:/.exec(statement.text);
  if (!header) { return null; }
  const bases = header[1].split(',').map(base => base.trim());
  const raw = pythonCodeLines(content)[line];
  for (const match of raw.matchAll(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g)) {
    if (character >= match.index! && character <= match.index! + match[0].length && bases.includes(match[0])) {
      // The class name itself is not a base, even if it shadows a parent name.
      if (line === statement.line && match.index! < raw.indexOf('(')) { return null; }
      return match[0];
    }
  }
  return null;
}

/** Parse class/function scopes and import bindings without executing Python. */
export function parsePythonFile(content: string, filePath: string): ParsedPythonFile {
  const classes: PythonClassDef[] = [];
  const imports: NonNullable<ParsedPythonFile['imports']> = new Map();
  const instanceAssignments: ParsedPythonFile['instanceAssignments'] = [];
  const stack: Array<{ indent: number; cls?: PythonClassDef; function?: boolean }> = [];
  const endLine = content.split(/\r?\n/).length;
  for (const statement of pythonStatements(content)) {
    const { text, line, indent } = statement;
    if (!text.trim()) { continue; }
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      const closed = stack.pop()!;
      if (closed.cls) { closed.cls.endLine = line; }
    }
    // A class statement nested inside a function creates a local runtime class,
    // not an importable module/class-suite symbol for workspace-wide navigation.
    // Keep the enclosing function scope until its indentation closes.
    if (stack.some(scope => scope.function)) { continue; }
    const classMatch = /^\s*class\s+([A-Za-z_]\w*)\s*(?:\((.*)\))?\s*:/.exec(text);
    if (classMatch) {
      const parent = [...stack].reverse().find(scope => scope.cls)?.cls;
      const cls: PythonClassDef = {
        name: classMatch[1],
        qualifiedName: parent ? `${parent.qualifiedName ?? parent.name}.${classMatch[1]}` : classMatch[1],
        bases: (classMatch[2] ?? '').split(',').map(base => base.trim())
          .filter(base => /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(base) && base !== 'object'),
        filePath, startLine: line, endLine, methods: new Map()
      };
      classes.push(cls);
      stack.push({ indent, cls });
      continue;
    }
    const defMatch = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(text);
    if (defMatch) {
      // Only functions directly inside a class suite are methods; closures aren't.
      const scope = stack[stack.length - 1];
      if (scope?.cls) {
        const name = defMatch[1];
        scope.cls.methods.set(name, { line, character: text.indexOf(name, text.indexOf('def') + 3) });
      }
      stack.push({ indent, function: true });
      continue;
    }
    const from = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/.exec(text);
    const imported = /^\s*import\s+(.+)$/.exec(text);
    if (from || imported) {
      const bindings = (from ? from[2] : imported![1]).replace(/[()]/g, '').split(',');
      for (const binding of bindings) {
        const match = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(binding);
        if (!match) { continue; }
        if (from) { imports.set(match[2] ?? match[1], { module: from[1], symbol: match[1] }); }
        else { imports.set(match[2] ?? match[1].split('.')[0], { module: match[2] ? match[1] : match[1].split('.')[0] }); }
      }
    }
    if (indent === 0) {
      const assign = /^([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(/.exec(text);
      if (assign) { instanceAssignments.push({ variable: assign[1], className: assign[2], line }); }
    }
  }
  return { filePath, classes, imports, instanceAssignments };
}

