/**
 * cellData 读取类型推导(KSEM-CELL-06/07):`self.cellData["key"]` 下标读取与
 * `self.cellData.get(key[, default])` 的读取类型,写/删流敏感存在性,以及
 * CELL-07 字典别名传播:`data = self.cellData` 后透过别名的同形访问按同一
 * 键宇宙推导;可确定常量键(`k = "hp"` 后 `self.cellData[k]`);重绑定/
 * 动态逃逸后降低确定性。
 *
 * 与 cellDataKeyAccess(CELL-05 读取探测)分工:本模块做**读取类型**的推导
 * (键宇宙 typeLabel → Python 注解;get 按可证明存在性/default 算可空/联合;
 * 删除后不再沿用必有键),消费面是 typeInlayHints 的局部变量/表达式提示。
 *
 * 诚实边界(能推才显,不硬造):
 * - 键不在宇宙(无 typeLabel)→ null(未知类型,不出提示);
 * - 字段类型解析落 Any(未知)→ null;
 * - get 有 default 但 default 类型推不出 → null(不能精确并集,不猜);
 * - 可证明存在性:def 字段/内建键初始必有;写点起必有;del 起必无(除非再写)。
 *   get 按存在性窄化:必有 → 字段类型(非空);非必有 → 字段 | None 或
 *   字段 | default(并集去重);
 * - 别名:只认 `NAME = self.cellData`(最近赋值,重绑定/for/with-as/增强
 *   赋值/海象即断);别名逃逸(传参/return/属性存/非 get 方法调用)后存在性
 *   不再可证(get 降级可空,下标类型不变);别名的别名(`b = a`)不传播;
 * - 常量键:只认 `NAME = '字面量'`(最近赋值,同样重绑定即断);拼接/
 *   f-string/数字下标 → 推不出,不出提示;
 * - 透过无效别名(已重绑定)的写/删不算 cellData 存在性证据。
 */
import { buildPythonCodeMask, findLineCommentIndex } from './globalDataIndexCore';
import { decodeStringLiteral, parseCellDataKeyAccess, type ParsedKeyAccess } from './cellDataKeyAccess';

/** 一次 cellData 键操作(读取/写入/删除;get 恒读)。 */
export interface CellDataKeyOperation {
  /** 解引后的键(字面量,或常量名解析出的值);解析不出 → 该操作不入列。 */
  key: string;
  /** 行号(0 基)。 */
  line: number;
  /** read=取值(get/裸下标);write=`[key] =` 赋值;del=`del [key]`。 */
  kind: 'read' | 'write' | 'del';
  /** 访问形态:下标 `[..]` 或 `.get(..)`。 */
  accessKind: 'subscript' | 'get';
  /** 接收者原文(`self.cellData` 或别名名,CELL-07)。 */
  receiver: string;
  /** 整个读取表达式起点(0 基字符列)。 */
  exprStart: number;
  /** 整个读取表达式尾后一列(闭 `]`/`)` 之后)。 */
  exprEnd: number;
  /** 键内容起点(不含引号;常量键时为变量名区间)。 */
  keyStart: number;
  /** 键内容尾后一列。 */
  keyEnd: number;
  /** get 形态第二个实参(default)文本;无/空 → null。 */
  defaultExpr: string | null;
}

/** 文档剖析面:行数组 + 词法掩码 + 行起始偏移(别名/常量流分析共用)。 */
interface DocFaces {
  lines: string[];
  mask: Uint8Array;
  lineStarts: number[];
}

function docFacesOf(text: string): DocFaces {
  const lineStarts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }
  return { lines: text.split(/\r?\n/), mask: buildPythonCodeMask(text), lineStarts };
}

/** `[start,start+length)` 全段是否代码(词法掩码全 0)。 */
function spanIsCode(mask: Uint8Array, start: number, length: number): boolean {
  for (let index = start; index < start + length; index += 1) {
    if (mask[index] !== 0) {
      return false;
    }
  }
  return true;
}

/** 行缩进列数(纯空白前缀)。 */
function indentOf(lineText: string): number {
  return lineText.length - lineText.trimStart().length;
}

/** 剥行尾注释(引号外 `#`;无 → 原文)。 */
function stripLineComment(lineText: string): string {
  const at = findLineCommentIndex(lineText);
  return at === -1 ? lineText : lineText.slice(0, at);
}

/** 正则元字符转义(接收者名 `self.cellData` 含点)。 */
function escapeRegExp(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 词头匹配:名字前不得是 `.` 或字词字符(排除 `self.data`/`my_data`)。 */
function receiverRegex(name: string): RegExp {
  return new RegExp(`(?<![.\\w])${escapeRegExp(name)}\\b`, 'g');
}

/**
 * 分类一次解析出的键访问:get 恒读;下标看上下文——`del ` 前缀 → del,
 * `=` 后缀(非 `==`)→ write,否则 read。
 */
function classifyKind(
  lineText: string,
  receiverStart: number,
  parsed: ParsedKeyAccess
): 'read' | 'write' | 'del' {
  if (parsed.kind === 'get') {
    return 'read';
  }
  if (/^\s*del[ \t]+$/.test(lineText.slice(0, receiverStart))) {
    return 'del';
  }
  if (/^[ \t]*=(?!=)/.test(lineText.slice(parsed.accessEnd))) {
    return 'write';
  }
  return 'read';
}

/**
 * 全文扫描 cellData 键操作(read/write/del)。receiverNames 缺省只扫
 * `self.cellData`;传入别名候选名(见 cellDataAliasNames)后透过别名的同形
 * 访问一并入列(别名有效性由消费方按行核定)。非常量键:字面量直解;标识符
 * 走常数解析(最近字面量赋值),推不出 → 该操作不入列(不硬猜)。词法掩码
 * 剔除注释/字符串里的伪访问(与 CELL-05 同口径);只收当前行闭合的访问。
 */
export function scanCellDataKeyOperations(text: string, receiverNames?: string[]): CellDataKeyOperation[] {
  const receivers = receiverNames && receiverNames.length > 0 ? receiverNames : ['self.cellData'];
  const doc = docFacesOf(text);
  const ops: CellDataKeyOperation[] = [];
  for (const receiver of receivers) {
    const regex = receiverRegex(receiver);
    for (let line = 0; line < doc.lines.length; line += 1) {
      const raw = doc.lines[line];
      const lineStart = doc.lineStarts[line] ?? 0;
      regex.lastIndex = 0;
      let match = regex.exec(raw);
      while (match) {
        const receiverStart = match.index;
        const receiverEnd = receiverStart + match[0].length;
        if (!spanIsCode(doc.mask, lineStart + receiverStart, match[0].length)) {
          match = regex.exec(raw);
          continue;
        }
        const parsed = parseCellDataKeyAccess(raw, receiverEnd);
        if (!parsed) {
          match = regex.exec(raw);
          continue;
        }
        const key = parsed.keyLiteral
          ? parsed.key
          : resolveConstantKeyInDoc(doc, parsed.rawKey, line);
        if (key !== null) {
          ops.push({
            key,
            line,
            kind: classifyKind(raw, receiverStart, parsed),
            accessKind: parsed.kind,
            receiver,
            exprStart: receiverStart,
            exprEnd: parsed.accessEnd,
            keyStart: parsed.keyStart,
            keyEnd: parsed.keyEnd,
            defaultExpr: parsed.defaultExpr
          });
        }
        match = regex.exec(raw);
      }
    }
  }
  // 多接收者合并后按位置恢复文档序(读点存在性/提示落点依赖次序)
  ops.sort((a, b) => (a.line - b.line) || (a.exprStart - b.exprStart));
  return ops;
}

// ---------------------------------------------------------------------------
// CELL-07:常量键 + 字典别名
// ---------------------------------------------------------------------------

/** 最近一次名字赋值(或确定性重绑定形态)的行位与 RHS。 */
interface NameAssignmentHit {
  line: number;
  /** 赋值 RHS(剥注释、去首尾空白);重绑定形态(for/增强/海象)→ 空串。 */
  rhs: string;
  /** true=普通 `NAME = rhs`;false=for 目标/with-as/增强赋值/海象(值未知)。 */
  plain: boolean;
}

/** 候选行的赋值前缀(LHS + `=`)是否代码域(排除 docstring/字符串内伪赋值)。 */
function assignmentPrefixIsCode(doc: DocFaces, line: number, prefixLength: number): boolean {
  const start = doc.lineStarts[line] ?? 0;
  return spanIsCode(doc.mask, start, Math.max(prefixLength, 1));
}

/**
 * 自 fromLine 向上(作用域限,与 findNearestKeyMutation 同口径)找 name 的
 * 最近赋值。识别重绑定形态:`for NAME in`/`with ... as NAME`/增强赋值/海象
 * → plain=false;普通 `NAME = rhs` → plain=true。跨 def/class 头收紧作用域
 * (兄弟方法体不越);找不到 → null。
 */
function findNearestNameAssignment(doc: DocFaces, name: string, fromLine: number): NameAssignmentHit | null {
  const assign = new RegExp(`^[ \\t]*${escapeRegExp(name)}[ \\t]*=[ \\t]*`);
  const forTarget = new RegExp(`^[ \\t]*for[ \\t]+${escapeRegExp(name)}[ \\t]+in\\b`);
  const withAs = new RegExp(`\\bas[ \\t]+${escapeRegExp(name)}\\b`);
  const augmented = new RegExp(`^[ \\t]*${escapeRegExp(name)}[ \\t]*(?:[+\\-*/%&|^]|<<|>>|\\*\\*|//)=`);
  const walrus = new RegExp(`\\([ \\t]*${escapeRegExp(name)}[ \\t]*:=`);
  let scopeIndentLimit = Number.POSITIVE_INFINITY;
  for (let line = fromLine - 1; line >= 0; line -= 1) {
    const raw = doc.lines[line] ?? '';
    if (!raw.trim()) {
      continue;
    }
    const indent = indentOf(raw);
    if (indent < scopeIndentLimit) {
      const stripped = stripLineComment(raw);
      const simple = assign.exec(stripped);
      const prefixLength = simple ? simple[0].length : Math.max(indent, 1);
      if (assignmentPrefixIsCode(doc, line, prefixLength)) {
        if (simple) {
          return { line, rhs: stripped.slice(simple[0].length).trim(), plain: true };
        }
        if (forTarget.test(stripped) || augmented.test(stripped) || walrus.test(stripped) || withAs.test(stripped)) {
          return { line, rhs: '', plain: false };
        }
      }
    }
    if (/^\s*(?:async\s+def|def|class)\s/.test(raw)) {
      scopeIndentLimit = Math.min(scopeIndentLimit, indent + 1);
    }
  }
  return null;
}

/**
 * 常量键解析(KSEM-CELL-07):rawKey 本身是字符串字面量 → 直解;标识符 →
 * 最近一次赋值的 RHS 为字符串字面量 → 解引;重绑定(值未知)/非字面量 RHS/
 * 找不到赋值/非标识符(拼接/f-string/数字)→ null(推不出,不硬猜)。
 */
export function resolveCellDataConstantKey(text: string, rawKey: string, line: number): string | null {
  return resolveConstantKeyInDoc(docFacesOf(text), rawKey, line);
}

function resolveConstantKeyInDoc(doc: DocFaces, rawKey: string, line: number): string | null {
  const direct = decodeStringLiteral(rawKey);
  if (direct !== null) {
    return direct;
  }
  if (!/^[A-Za-z_]\w*$/.test(rawKey)) {
    return null;
  }
  const hit = findNearestNameAssignment(doc, rawKey, line);
  if (!hit || !hit.plain) {
    return null;
  }
  return decodeStringLiteral(hit.rhs);
}

/**
 * cellData 别名候选名(KSEM-CELL-07):全文里 `NAME = self.cellData`(剥行
 * 尾注释;赋值前缀须在词法代码域,docstring 内伪赋值不算)的 NAME 集合,
 * 按出现序。`self` 自身不作别名。
 */
export function cellDataAliasNames(text: string): string[] {
  const doc = docFacesOf(text);
  const names: string[] = [];
  for (let line = 0; line < doc.lines.length; line += 1) {
    const stripped = stripLineComment(doc.lines[line] ?? '');
    const prefix = /^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*/.exec(stripped);
    if (!prefix || prefix[1] === 'self') {
      continue;
    }
    if (!assignmentPrefixIsCode(doc, line, prefix[0].length)) {
      continue;
    }
    if (stripped.slice(prefix[0].length).trim() === 'self.cellData' && !names.includes(prefix[1])) {
      names.push(prefix[1]);
    }
  }
  return names;
}

/** 别名在目标行的状态。 */
export interface CellDataAliasState {
  /** 最近赋值是 `NAME = self.cellData` 且未被重绑定。 */
  valid: boolean;
  /** 别名有效但发生过动态逃逸(存在性不再可证)。 */
  escaped: boolean;
  /** 最近一次逃逸行(0 基);无逃逸 → null。 */
  escapedLine: number | null;
  /** 别名赋值行(0 基);无效 → -1。 */
  aliasLine: number;
}

/**
 * 名字在 targetLine 是否(仍)是 `self.cellData` 的别名,以及别名段内是否
 * 发生过动态逃逸。规则:
 * - 最近赋值(作用域限)非 `= self.cellData`(或 for/with-as/增强/海象重绑)
 *   → 无效;
 * - 别名段(赋值行+1 .. 目标行-1)内名字出现在**非 cellData 操作**位 → 逃逸:
 *   传参/return/属性存/非 get 方法调用/容器字面量;`NAME[...]`/`NAME.get(...)`
 *   与裸局部引用(`b = NAME` 整体 RHS)不算;嵌套 def/class 体内的出现不算
 *   (未被调用即未逃逸,与写点作用域口径对称)。
 */
export function cellDataAliasState(text: string, name: string, targetLine: number): CellDataAliasState {
  const doc = docFacesOf(text);
  const hit = findNearestNameAssignment(doc, name, targetLine);
  if (!hit || !hit.plain || hit.rhs !== 'self.cellData') {
    return { valid: false, escaped: false, escapedLine: null, aliasLine: -1 };
  }
  const aliasLine = hit.line;
  const regex = receiverRegex(name);
  let escaped = false;
  let escapedLine: number | null = null;
  let nestedBodyIndent: number | null = null;
  for (let line = aliasLine + 1; line < targetLine; line += 1) {
    const raw = doc.lines[line] ?? '';
    if (!raw.trim()) {
      continue;
    }
    const indent = indentOf(raw);
    if (nestedBodyIndent !== null) {
      if (indent > nestedBodyIndent) {
        continue;
      }
      nestedBodyIndent = null;
    }
    if (/^\s*(?:async\s+def|def|class)\s/.test(raw)) {
      // def/class 体内出现不算逃逸(未被调用即未发生,与写点作用域口径对称
      // ——头行起,体内跳过,缩进回落即出);def/class 行本身(方法名/参数)
      // 不构成逃逸位
      nestedBodyIndent = indent;
      continue;
    }
    const stripped = stripLineComment(raw);
    const lineStart = doc.lineStarts[line] ?? 0;
    regex.lastIndex = 0;
    let match = regex.exec(stripped);
    while (match) {
      if (spanIsCode(doc.mask, lineStart + match.index, name.length)) {
        if (occurrenceEscapesCellData(stripped, match.index, name)) {
          escaped = true;
          escapedLine = line;
        }
      }
      match = regex.exec(stripped);
    }
  }
  return { valid: true, escaped, escapedLine, aliasLine };
}

/** 单个名字出现位是否构成 cellData 逃逸(非下标/get、非裸局部整体引用)。 */
function occurrenceEscapesCellData(stripped: string, at: number, name: string): boolean {
  const rest = stripped.slice(at + name.length).replace(/^[ \t]+/, '');
  if (rest.startsWith('[')) {
    return false; // cellData 下标操作(读/写/删都由操作表跟踪)
  }
  if (/^\.get[ \t]*\(/.test(rest)) {
    return false; // cellData get 读
  }
  // 裸局部整体引用(`b = NAME`)不算逃逸:引用仍在本地作用域内
  const wholeRhs = new RegExp(`^[ \\t]*[A-Za-z_]\\w*[ \\t]*=[ \\t]*${escapeRegExp(name)}[ \\t]*$`);
  if (wholeRhs.test(stripped)) {
    return false;
  }
  return true;
}

/**
 * 键在目标读点是否可证明存在。规则:
 * - 同一键最近一次**有效**写/删(自目标向上,作用域限)定状态:写 → 必有,
 *   删 → 必无;透过无效别名(已重绑定)的写/删不算证据,继续向更早找;
 * - 别名逃逸({@link escape} 带 line)晚于最近写/删(或无写/删)→ 存在性不
 *   再可证(外部可能增删键);
 * - 无写/删且无逃逸 → 初始状态:键在宇宙(def 字段/内建/组件槽)→ 必有,
 *   否则必无。
 */
export function cellDataKeyProvablyPresent(
  ops: readonly CellDataKeyOperation[],
  target: CellDataKeyOperation,
  text: string,
  keyInUniverse: boolean,
  escape?: { line: number } | null
): boolean {
  const mutation = findNearestKeyMutation(ops, target, text);
  if (mutation && (!escape || mutation.line > escape.line)) {
    return mutation.kind === 'write';
  }
  if (escape) {
    return false;
  }
  return keyInUniverse;
}

/**
 * 自目标向上找同一键最近的有效写/删(作用域限);透过无效别名的写/删跳过
 * (重绑定后操作的是别的字典,不是 cellData 存在性证据)。无 → null。
 * CELL-09 键跟踪消费(伪删与真实 del 同形入列)。
 */
export function findNearestKeyMutation(
  ops: readonly CellDataKeyOperation[],
  target: CellDataKeyOperation,
  text: string
): CellDataKeyOperation | null {
  const doc = docFacesOf(text);
  const opsByLine = new Map<number, CellDataKeyOperation[]>();
  for (const op of ops) {
    const list = opsByLine.get(op.line);
    if (list) {
      list.push(op);
    } else {
      opsByLine.set(op.line, [op]);
    }
  }
  const counts = (op: CellDataKeyOperation): boolean =>
    op.receiver === 'self.cellData' || cellDataAliasState(text, op.receiver, op.line).valid;
  // 同行:目标之前的写/删(列序小者在前)
  for (const op of opsByLine.get(target.line) ?? []) {
    if (
      op.key === target.key &&
      (op.kind === 'write' || op.kind === 'del') &&
      op.exprStart < target.exprStart &&
      counts(op)
    ) {
      return op;
    }
  }
  // 更早行:作用域限(与 findNearestWrite 同口径)——跨 def/class 头即止
  let scopeIndentLimit = Number.POSITIVE_INFINITY;
  for (let line = target.line - 1; line >= 0; line -= 1) {
    const raw = doc.lines[line] ?? '';
    const indent = indentOf(raw);
    if (indent < scopeIndentLimit) {
      for (const op of opsByLine.get(line) ?? []) {
        if (op.key === target.key && (op.kind === 'write' || op.kind === 'del') && counts(op)) {
          return op;
        }
      }
    }
    if (/^\s*(?:async\s+def|def|class)\s/.test(raw)) {
      scopeIndentLimit = Math.min(scopeIndentLimit, indent + 1);
    }
  }
  return null;
}

/** 字符串并集去重:`int | None`,`int | str`,`int | int` → `int`。 */
function unionTypes(types: string[]): string {
  const seen: string[] = [];
  for (const type of types) {
    if (!seen.includes(type)) {
      seen.push(type);
    }
  }
  return seen.join(' | ');
}

/** 读取类型推导输入面。 */
export interface CellDataReadTypeInput {
  accessKind: 'subscript' | 'get';
  /** 字段类型注解(def 字段 typeLabel 解析后);null=未知,不出。 */
  fieldAnnotation: string | null;
  /** get 是否带 default 实参。 */
  hasDefault: boolean;
  /** default 实参类型注解;null=推不出(未知)。 */
  defaultAnnotation: string | null;
  /** 键当前是否可证明存在。 */
  provablyPresent: boolean;
}

/**
 * cellData 读取类型:
 * - 下标 → 字段类型(下标缺失抛 KeyError,恒非空);
 * - get 且必有 → 字段类型(default 不可达);
 * - get 且非必有、无 default → 字段 | None;
 * - get 且非必有、有 default(类型已知)→ 字段 | default(去重);
 * - get 且非必有、有 default(类型未知)→ null(不能精确并集,不猜);
 * - 字段类型未知 → null(能推才显)。
 */
export function resolveCellDataReadType(input: CellDataReadTypeInput): string | null {
  const field = input.fieldAnnotation;
  if (!field) {
    return null;
  }
  if (input.accessKind === 'subscript') {
    return field;
  }
  if (input.provablyPresent) {
    return field;
  }
  if (input.hasDefault) {
    if (input.defaultAnnotation === null) {
      return null;
    }
    return unionTypes([field, input.defaultAnnotation]);
  }
  return unionTypes([field, 'None']);
}

/** cellData 读取提示落点(纯计算):纯赋值 RHS → 目标变量后;否则表达式尾后。 */
export function cellDataHintPosition(
  lineText: string,
  op: CellDataKeyOperation
): { line: number; character: number } {
  const assign = /^(\s*)([A-Za-z_]\w*)\s*=\s*(?!=)(.+)$/.exec(lineText);
  if (assign) {
    const rhsStart = assign[1].length + assign[2].length + 3; // 缩进 + 名 + ` = `
    const rhsText = assign[3].trim();
    const exprText = lineText.slice(op.exprStart, op.exprEnd).trim();
    // 纯赋值 RHS(读取表达式恰为整个 RHS)→ 提示落在目标变量后
    if (op.exprStart === rhsStart && exprText === rhsText) {
      return { line: op.line, character: assign[1].length + assign[2].length };
    }
  }
  return { line: op.line, character: op.exprEnd };
}
