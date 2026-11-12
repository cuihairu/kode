/**
 * cellData 读取类型推导(KSEM-CELL-06):`self.cellData["key"]` 下标读取与
 * `self.cellData.get(key[, default])` 的读取类型,以及写/删流敏感存在性。
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
 *   字段 | default(并集去重)。
 */
import { buildPythonCodeMask } from './globalDataIndexCore';
import { parseCellDataKeyAccess, type ParsedKeyAccess } from './cellDataKeyAccess';

/** 一次 cellData 键操作(读取/写入/删除;get 恒读)。 */
export interface CellDataKeyOperation {
  key: string;
  /** 行号(0 基)。 */
  line: number;
  /** read=取值(get/裸下标);write=`[key] =` 赋值;del=`del [key]`。 */
  kind: 'read' | 'write' | 'del';
  /** 访问形态:下标 `[..]` 或 `.get(..)`。 */
  accessKind: 'subscript' | 'get';
  /** 整个读取表达式起点(0 基字符列,含 `self`)。 */
  exprStart: number;
  /** 整个读取表达式尾后一列(闭 `]`/`)` 之后)。 */
  exprEnd: number;
  /** 键内容起点(不含引号)。 */
  keyStart: number;
  /** 键内容尾后一列(不含引号)。 */
  keyEnd: number;
  /** get 形态第二个实参(default)文本;无/空 → null。 */
  defaultExpr: string | null;
}

/** 行起始偏移(按 `\n` 切分)。 */
function lineStartOffsetsOf(text: string): number[] {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
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
 * 全文扫描 cellData 键操作(read/write/del)。词法掩码剔除注释/字符串里的
 * 伪访问(与 CELL-05 同口径);只收当前行闭合的访问。
 */
export function scanCellDataKeyOperations(text: string): CellDataKeyOperation[] {
  const mask = buildPythonCodeMask(text);
  const lineStarts = lineStartOffsetsOf(text);
  const lines = text.split(/\r?\n/);
  const ops: CellDataKeyOperation[] = [];
  for (let line = 0; line < lines.length; line += 1) {
    const raw = lines[line];
    const lineStart = lineStarts[line] ?? 0;
    let search = 0;
    while (search < raw.length) {
      const match = /self\.cellData\b/.exec(raw.slice(search));
      if (!match) {
        break;
      }
      const receiverStart = search + match.index;
      const receiverEnd = receiverStart + match[0].length;
      // self.cellData 段必须在词法代码域(注释/字符串里的伪访问不入)
      if (!spanIsCode(mask, lineStart + receiverStart, match[0].length)) {
        search = receiverEnd;
        continue;
      }
      const parsed = parseCellDataKeyAccess(raw, receiverEnd);
      if (!parsed) {
        search = receiverEnd;
        continue;
      }
      ops.push({
        key: parsed.key,
        line,
        kind: classifyKind(raw, receiverStart, parsed),
        accessKind: parsed.kind,
        exprStart: receiverStart,
        exprEnd: parsed.accessEnd,
        keyStart: parsed.keyStart,
        keyEnd: parsed.keyEnd,
        defaultExpr: parsed.defaultExpr
      });
      search = parsed.accessEnd;
    }
  }
  return ops;
}

/**
 * 键在目标读点是否可证明存在。规则:
 * - 同一键最近一次写/删(自目标向上,作用域限)定状态:写 → 必有,删 → 必无;
 * - 无写/删 → 初始状态:键在宇宙(def 字段/内建/组件槽)→ 必有,否则必无。
 */
export function cellDataKeyProvablyPresent(
  ops: readonly CellDataKeyOperation[],
  target: CellDataKeyOperation,
  lines: readonly string[],
  keyInUniverse: boolean
): boolean {
  const mutation = findNearestKeyMutation(ops, target, lines);
  if (mutation) {
    return mutation === 'write';
  }
  return keyInUniverse;
}

/** 自目标向上找同一键最近写/删(作用域限);无 → null。 */
function findNearestKeyMutation(
  ops: readonly CellDataKeyOperation[],
  target: CellDataKeyOperation,
  lines: readonly string[]
): 'write' | 'del' | null {
  const opsByLine = new Map<number, CellDataKeyOperation[]>();
  for (const op of ops) {
    const list = opsByLine.get(op.line);
    if (list) {
      list.push(op);
    } else {
      opsByLine.set(op.line, [op]);
    }
  }
  // 同行:目标之前的写/删(列序小者在前)
  for (const op of opsByLine.get(target.line) ?? []) {
    if (
      op.key === target.key &&
      (op.kind === 'write' || op.kind === 'del') &&
      op.exprStart < target.exprStart
    ) {
      return op.kind;
    }
  }
  // 更早行:作用域限(与 findNearestWrite 同口径)——跨 def/class 头即止
  let scopeIndentLimit = Number.POSITIVE_INFINITY;
  for (let line = target.line - 1; line >= 0; line -= 1) {
    const text = lines[line] ?? '';
    const indent = text.length - text.trimStart().length;
    if (indent < scopeIndentLimit) {
      for (const op of opsByLine.get(line) ?? []) {
        if (op.key === target.key && (op.kind === 'write' || op.kind === 'del')) {
          return op.kind;
        }
      }
    }
    if (/^\s*(?:async\s+def|def|class)\s/.test(text)) {
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
