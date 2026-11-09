/**
 * Python 字面量类型推断(GEN-DEF-1c):def 属性 `<Default>` 值是引擎
 * PythonType::parseDefaultStr 用 Py_eval_input 求值的 Python 表达式
 * (datatype.cpp)。本模块纯逻辑解析常见字面量,产出精确注解:
 *   PYTHON <Default>123</Default>  → int
 *   PY_DICT <Default>{'hp': 1}</Default> → dict[str, int]
 *   PY_LIST <Default>[1, 2]</Default>  → list[int]
 *   PY_TUPLE <Default>(1, 'a')</Default> → tuple[int, str]
 * 解析失败/空容器/None 默认值回落基类注解(Any/dict/tuple/list),绝不悬裸名。
 * 与 vscode 解耦(纯逻辑,单元测试直接喂字符串)。
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

/** 基类注解(PYTHON→Any、PY_DICT→dict、PY_TUPLE→tuple、PY_LIST→list) */
export const PYTHON_FAMILY_BASE: Record<string, string> = {
  PYTHON: 'Any',
  PY_DICT: 'dict',
  PY_TUPLE: 'tuple',
  PY_LIST: 'list'
};

/**
 * 解析 Python 字面量文本 → 类型树;无法解析返回 null(调用方回落基类)。
 * 支持:int/float/str/bytes/bool/None、list/tuple/set/dict(可嵌套)、
 * 一元负号、字符串引号与 b 前缀、注释。字典/集合共用 `{}` 语法,按是否
 * 出现冒号区分;`(x)` 是括号分组不产 tuple,`(x,)` 才是单元素 tuple。
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

/** 类型树 → Python 注解字符串(元素并集按首见序去重,空容器回落基类) */
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
 * 由 `<Default>` 与基础类型名求精确注解:无 Default、非 PYTHON 族、解析失败、
 * None 默认值均回落基类注解(1a 口径:注解不产 `X | None`;None 默认值不携带
 * 元素型信息,诚实回落基类)。
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
  // 容器元素型必须与基础类型一致才精化(如 PY_DICT 默认值是 list 不算数)
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
    // 字符串前缀(b'..' / r".." / f'..'):字母后紧跟引号才是字符串,否则名字
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
        // `(x)` 是分组不是 tuple;只有 `(x,)` 才产单元素 tuple。
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
    // 可选前缀(b / r / u / f),仅认 b 为 bytes,其余当普通字符串
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
    // 十六进制/八进制字面量回落 int(不展开求值,只认形态)
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
        // 变量名/常量(如 SOME_CONST)无法求值,解析失败回落基类
        throw new Error('unresolvable name');
    }
  }
}
