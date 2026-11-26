/**
 * Python literal type inference (GEN-DEF-1c): the `<Default>` value of a def attribute
 * is a Python expression that the engine evaluates with Py_eval_input via
 * PythonType::parseDefaultStr (datatype.cpp). This module purely logically parses the
 * common literals and yields precise annotations:
 *   PYTHON <Default>123</Default>  -> int
 *   PY_DICT <Default>{'hp': 1}</Default> -> dict[str, int]
 *   PY_LIST <Default>[1, 2]</Default>  -> list[int]
 *   PY_TUPLE <Default>(1, 'a')</Default> -> tuple[int, str]
 * A parse failure, an empty container, or a None default value falls back to the base
 * class annotation (Any/dict/tuple/list); never leave a bare name hanging.
 * Decoupled from vscode (pure logic; unit tests feed strings straight in).
 */

export type PythonLiteralType =
  | { kind: 'int' }
  | { kind: 'float' }
  | { kind: 'str' }
  | { kind: 'bytes' }
  | { kind: 'bool' }
  | { kind: 'none' }
  | { kind: 'list'; elements: PythonLiteralType[] }
  | { kind: 'tuple'; elements: PythonLiteralType[] }
  | { kind: 'set'; elements: PythonLiteralType[] }
  | { kind: 'dict'; entries: Array<{ key: PythonLiteralType; value: PythonLiteralType }> };

/** Base class annotations (PYTHON->Any, PY_DICT->dict, PY_TUPLE->tuple, PY_LIST->list) */
export const PYTHON_FAMILY_BASE: Record<string, string> = {
  PYTHON: 'Any',
  PY_DICT: 'dict',
  PY_TUPLE: 'tuple',
  PY_LIST: 'list'
};

/**
 * Parse Python literal text -> type tree; return null when it cannot be parsed (the
 * caller falls back to the base class annotation).
 * Supports: int/float/str/bytes/bool/None, list/tuple/set/dict (nestable),
 * a unary minus, string quotes and the b prefix, and comments. Dicts and sets share
 * the `{}` syntax and are told apart by the presence of a colon; `(x)` is parenthesised
 * grouping and produces no tuple -- only `(x,)` is a single-element tuple.
 */
export function parsePythonLiteral(text: string): PythonLiteralType | null {
  const parser = new LiteralParser(text);
  try {
    const value = parser.parseValue();
    parser.skipWhitespaceAndComments();
    if (!parser.atEnd) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/** Type tree -> Python annotation string (the element union is deduped in first-seen order; an empty container falls back to the base class) */
export function pythonLiteralAnnotation(type: PythonLiteralType): string {
  switch (type.kind) {
    case 'int':
      return 'int';
    case 'float':
      return 'float';
    case 'str':
      return 'str';
    case 'bytes':
      return 'bytes';
    case 'bool':
      return 'bool';
    case 'none':
      return 'None';
    case 'list':
      return type.elements.length === 0
        ? 'list'
        : `list[${unifyAnnotations(type.elements)}]`;
    case 'tuple':
      return type.elements.length === 0
        ? 'tuple'
        : `tuple[${type.elements.map(pythonLiteralAnnotation).join(', ')}]`;
    case 'set':
      return type.elements.length === 0
        ? 'set'
        : `set[${unifyAnnotations(type.elements)}]`;
    case 'dict':
      if (type.entries.length === 0) {
        return 'dict';
      }
      return `dict[${unifyAnnotations(type.entries.map(entry => entry.key))}, ${unifyAnnotations(
        type.entries.map(entry => entry.value)
      )}]`;
  }
}

/**
 * Derive the precise annotation from `<Default>` and the base type name: a missing
 * Default, a non-PYTHON family, a parse failure, and a None default value all fall
 * back to the base class annotation (per the 1a stance: an annotation never yields
 * `X | None`; a None default carries no element-type information, so falling back
 * honestly to the base class).
 */
export function inferPythonLiteralAnnotation(
  defaultValue: string | undefined,
  baseTypeName: string
): string {
  const base = PYTHON_FAMILY_BASE[baseTypeName];
  if (base === undefined) {
    return baseTypeName;
  }
  if (defaultValue === undefined || defaultValue.trim().length === 0) {
    return base;
  }
  const literal = parsePythonLiteral(defaultValue);
  if (literal === null || literal.kind === 'none') {
    return base;
  }
  // A container's element type must match the base type for refinement to apply (e.g. a PY_DICT whose default is a list does not count)
  if (base === 'dict' && literal.kind !== 'dict') {
    return base;
  }
  if (base === 'list' && literal.kind !== 'list') {
    return base;
  }
  if (base === 'tuple' && literal.kind !== 'tuple') {
    return base;
  }
  return pythonLiteralAnnotation(literal);
}

function unifyAnnotations(types: PythonLiteralType[]): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const type of types) {
    const name = pythonLiteralAnnotation(type);
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  if (names.length === 1) {
    return names[0];
  }
  return `Union[${names.join(', ')}]`;
}

class LiteralParser {
  private readonly text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  get atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  skipWhitespaceAndComments(): void {
    for (;;) {
      while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) {
        this.pos += 1;
      }
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') {
          this.pos += 1;
        }
        continue;
      }
      return;
    }
  }

  parseValue(): PythonLiteralType {
    this.skipWhitespaceAndComments();
    const char = this.text[this.pos];
    if (char === '[') {
      return this.parseList();
    }
    if (char === '(') {
      return this.parseTupleOrGroup();
    }
    if (char === '{') {
      return this.parseDictOrSet();
    }
    if (char === "'" || char === '"') {
      return this.parseString();
    }
    // String prefix (b'..' / r".." / f'..'): it is a string only when a quote follows the letters, otherwise it is a name
    const prefixMatch = /^[bBrRuUfF]{1,2}(?=['"])/.exec(this.text.slice(this.pos));
    if (prefixMatch) {
      return this.parseString();
    }
    if (char === '-' || char === '+' || /[0-9.]/.test(char)) {
      return this.parseNumber();
    }
    return this.parseName();
  }

  private parseList(): PythonLiteralType {
    this.pos += 1; // [
    const elements: PythonLiteralType[] = [];
    this.skipWhitespaceAndComments();
    if (this.text[this.pos] === ']') {
      this.pos += 1;
      return { kind: 'list', elements };
    }
    for (;;) {
      elements.push(this.parseValue());
      this.skipWhitespaceAndComments();
      const char = this.text[this.pos];
      if (char === ',') {
        this.pos += 1;
        this.skipWhitespaceAndComments();
        if (this.text[this.pos] === ']') {
          this.pos += 1;
          return { kind: 'list', elements };
        }
        continue;
      }
      if (char === ']') {
        this.pos += 1;
        return { kind: 'list', elements };
      }
      throw new Error('expected , or ]');
    }
  }

  private parseTupleOrGroup(): PythonLiteralType {
    this.pos += 1; // (
    this.skipWhitespaceAndComments();
    if (this.text[this.pos] === ')') {
      this.pos += 1;
      return { kind: 'tuple', elements: [] };
    }
    const elements: PythonLiteralType[] = [];
    for (;;) {
      elements.push(this.parseValue());
      this.skipWhitespaceAndComments();
      const char = this.text[this.pos];
      if (char === ',') {
        this.pos += 1;
        this.skipWhitespaceAndComments();
        if (this.text[this.pos] === ')') {
          this.pos += 1;
          return { kind: 'tuple', elements };
        }
        continue;
      }
      if (char === ')') {
        this.pos += 1;
        // `(x)` is grouping, not a tuple; only `(x,)` produces a single-element tuple.
        if (elements.length === 1) {
          return elements[0];
        }
        return { kind: 'tuple', elements };
      }
      throw new Error('expected , or )');
    }
  }

  private parseDictOrSet(): PythonLiteralType {
    this.pos += 1; // {
    this.skipWhitespaceAndComments();
    if (this.text[this.pos] === '}') {
      this.pos += 1;
      return { kind: 'dict', entries: [] };
    }
    const entries: Array<{ key: PythonLiteralType; value: PythonLiteralType }> = [];
    const setElements: PythonLiteralType[] = [];
    let isDict = false;
    let parsedAny = false;
    for (;;) {
      const first = this.parseValue();
      parsedAny = true;
      this.skipWhitespaceAndComments();
      if (this.text[this.pos] === ':') {
        isDict = true;
        this.pos += 1;
        const value = this.parseValue();
        entries.push({ key: first, value });
      } else {
        setElements.push(first);
      }
      this.skipWhitespaceAndComments();
      const char = this.text[this.pos];
      if (char === ',') {
        this.pos += 1;
        this.skipWhitespaceAndComments();
        if (this.text[this.pos] === '}') {
          this.pos += 1;
          break;
        }
        continue;
      }
      if (char === '}') {
        this.pos += 1;
        break;
      }
      throw new Error('expected , or }');
    }
    if (!parsedAny) {
      return { kind: 'dict', entries: [] };
    }
    if (isDict) {
      return { kind: 'dict', entries };
    }
    return { kind: 'set', elements: setElements };
  }

  private parseString(): PythonLiteralType {
    let isBytes = false;
    // Optional prefix (b / r / u / f); only b counts as bytes, the rest are treated as plain strings
    while (/[a-zA-Z]/.test(this.text[this.pos])) {
      if (this.text[this.pos] === 'b') {
        isBytes = true;
      }
      this.pos += 1;
      if (this.text[this.pos] === "'" || this.text[this.pos] === '"') {
        break;
      }
    }
    const quote = this.text[this.pos];
    if (quote !== "'" && quote !== '"') {
      throw new Error('expected quote');
    }
    this.pos += 1;
    let closed = false;
    while (this.pos < this.text.length) {
      const char = this.text[this.pos];
      if (char === '\\') {
        this.pos += 2;
        continue;
      }
      if (char === quote) {
        this.pos += 1;
        closed = true;
        break;
      }
      this.pos += 1;
    }
    if (!closed) {
      throw new Error('unterminated string');
    }
    return isBytes ? { kind: 'bytes' } : { kind: 'str' };
  }

  private parseNumber(): PythonLiteralType {
    const start = this.pos;
    if (this.text[this.pos] === '-' || this.text[this.pos] === '+') {
      this.pos += 1;
    }
    let isFloat = false;
    while (this.pos < this.text.length && /[0-9]/.test(this.text[this.pos])) {
      this.pos += 1;
    }
    if (this.text[this.pos] === '.') {
      isFloat = true;
      this.pos += 1;
      while (this.pos < this.text.length && /[0-9]/.test(this.text[this.pos])) {
        this.pos += 1;
      }
    }
    if (this.text[this.pos] === 'e' || this.text[this.pos] === 'E') {
      isFloat = true;
      this.pos += 1;
      if (this.text[this.pos] === '-' || this.text[this.pos] === '+') {
        this.pos += 1;
      }
      while (this.pos < this.text.length && /[0-9]/.test(this.text[this.pos])) {
        this.pos += 1;
      }
    }
    // Hexadecimal/octal literals fall back to int (they are not evaluated, only their shape is recognised)
    if (!isFloat && this.text[start] === '0' && /[xXoObB]/.test(this.text[start + 1] ?? '')) {
      return { kind: 'int' };
    }
    if (this.pos === start) {
      throw new Error('expected number');
    }
    return isFloat ? { kind: 'float' } : { kind: 'int' };
  }

  private parseName(): PythonLiteralType {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (match === null) {
      throw new Error('expected value');
    }
    this.pos += match[0].length;
    switch (match[0]) {
      case 'True':
      case 'False':
        return { kind: 'bool' };
      case 'None':
        return { kind: 'none' };
      default:
        // Variable names/constants (such as SOME_CONST) cannot be evaluated; a parse failure falls back to the base class
        throw new Error('unresolvable name');
    }
  }
}
