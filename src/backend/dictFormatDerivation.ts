/**
 * KSEM-SER-09:项目静态字典格式推导(纯核心,零 vscode 依赖)。
 *
 * 验收口径(todo.md KSEM-SER-09):从确定的 dict 构造/写点提取必有、
 * 可选及值类型;分支汇流、多写者和动态 update 扩展为开放结构。
 *
 * 推导模型(模块作用域 v1):
 *  - 写点收集 = 模块作用域(不落入任何 def/class 体的行;if/elif/else/
 *    for/while/try/except/with 体仍是模块作用域——Python 语义);
 *    函数局部同名变量是另一作用域,绝不并入(同名跨作用域合流是谎报,
 *    诚实边界);
 *  - 执行保证三级:always(模块顶层无条件写点)> complete(if/elif/else
 *    组带 else 且键在该组全部臂都有写点——恰好一臂执行,键必在)>
 *    maybe(无 else 的 if 臂/for/while/try/except/with 体——可能不执行);
 *  - 顺序语义:无条件字面量写点 = 重绑(其后读点看到的是新形状,先前
 *    条件写点作废——旧绑定的证据不跨重绑);其后动态写点(下标写/
 *    update/setdefault/|=/del)并入并置开放;
 *  - 无条件非字面量 RHS(构造调用/裸名)= unknown 终局(其后的动态写点
 *    转为 open+observed);
 *  - 必有 = 键被 always 写点写入,或被 complete 组全臂写入;可选 = 其余
 *    有证据键;值类型跨同键多写点分歧 → unknown(不猜);
 *  - 开放结构 = 任意动态写点/展开/推导式/动态键 → kind 'open',
 *    observed 保留已观测键面(宇宙开放但观测证据仍真);
 *  - 值类型面 = 字面量分类:带引号串/int/float/True/False/None/list
 *    (元素类型取首元素,混合/空 → unknown)/嵌套 dict(递归
 *    parseDictPairs,单写点全键必有;** 展开/推导式 → 嵌套 open)/
 *    其余(名字/调用/f 串)→ unknown。
 *
 * raw/masked 双行口径:结构判定(def/class/分支行/写点形状)走掩码行,
 * 键串/值字面量内容走原文行(pythonCodeLines 掩码把引号抹成 '_',串值
 * 只在原文可见;matchDictBraces 自带注释剥离)。SER-04/05/06 同构坑。
 *
 * 消费契约:KSEM-SER-10(JSON dumps/loads 链传播)按本模块输出裁结构;
 * 无写点变量不入 map(调用侧缺键即未知);schema 绑定(KSEM-SER-08 设计)
 * 命中时优先 schema,推导只是代码事实侧的证据源。
 */

import { pythonCodeLines } from './pythonParser';
import {
  matchDictBraces,
  parseDictPairs,
  type MatchedBraces
} from './fixedDictConstructCheck';

/** 一个键的值类型面(字面量事实;推不出 = unknown,不猜)。 */
export type DictValueKind =
  | { kind: 'scalar'; scalar: 'str' | 'int' | 'float' | 'bool' | 'none' }
  | { kind: 'list'; element: DictValueKind | null }
  | { kind: 'dict'; dict: DictFormat }
  | { kind: 'unknown' };

/**
 * 变量字典格式:
 *  - literal:封闭形状(required = 必有键,optional = 可选键);
 *  - open:开放结构(observed = 已观测键,宇宙开放);
 *  - unknown:重绑非字面量/无法判(零键面声称)。
 */
export type DictFormat =
  | {
      kind: 'literal';
      required: Map<string, DictValueKind>;
      optional: Map<string, DictValueKind>;
    }
  | { kind: 'open'; observed: Map<string, DictValueKind> }
  | { kind: 'unknown' };

/** 写点键证据(键 → 值类型)。 */
type KeyEvidence = Map<string, DictValueKind>;

/** 键执行保证等级。 */
type KeyRank = 'always' | 'complete' | 'maybe';

/** 一个写点记录(变量单次赋值/写点收集的证据单元)。 */
interface WriterRec {
  line: number;
  /** 赋值重绑(= {…});false = 增量写点(下标/update/setdefault/|=)。 */
  rebind: boolean;
  /** always / complete 组 / maybe(解析后回填 complete)。 */
  rank: KeyRank;
  /** 动态写点(开放宇宙证据)。 */
  dynamic: boolean;
  /** 重绑到非字面量(unknown 终局证据)。 */
  unknownBase: boolean;
  keys: KeyEvidence;
}

/** 模块作用域判定所需的分支组现场(解析后回填 hasElse/臂覆盖)。 */
interface IfGroup {
  id: number;
  hasElse: boolean;
  armCount: number;
  /** 臂序号 → 该臂写点键集(全臂齐键才可 complete)。 */
  arms: Map<number, KeyEvidence>;
}

/** 模块作用域复合块现场(arm = 该块内当前臂序,elif/else 递增)。 */
interface BlockFrame {
  indent: number;
  kind: string;
  group: IfGroup | null;
  arm: number;
}

/**
 * 字典格式推导入口:全文件模块作用域变量 → 格式 map(只含有 dict
 * 证据的变量;无写点变量不入 map,调用侧缺键即未知)。
 */
export function deriveDictFormats(text: string): Map<string, DictFormat> {
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);
  const collectors = new Map<
    string,
    { recs: WriterRec[]; groups: Map<number, IfGroup> }
  >();
  const scopeIndents: number[] = [];
  const blockStack: BlockFrame[] = [];
  let ifSeq = 0;
  let line = 0;
  while (line < masked.length) {
    const m = masked[line] ?? '';
    if (m.trim().length === 0) {
      line += 1;
      continue;
    }
    const indent = m.length - m.trimStart().length;
    // 作用域/分支栈收缩:缩退行关闭更深的 def/class 与分支块
    while (
      scopeIndents.length > 0 &&
      scopeIndents[scopeIndents.length - 1] >= indent
    ) {
      scopeIndents.pop();
    }
    // elif/else 延续同缩进 if 组:顶部组帧豁免收缩(同缩进先收后找组
    // 恒落空,分支合流面死);其余行按缩退正常关块
    const continuesGroup = /^(elif|else)\b/.test(m.trim());
    while (blockStack.length > 0) {
      const top = blockStack[blockStack.length - 1];
      if (continuesGroup && top.indent === indent && top.group !== null) {
        break;
      }
      if (top.indent < indent) {
        break;
      }
      blockStack.pop();
    }
    const inFunction = scopeIndents.length > 0;
    const isCompound = /^\s*(async\s+)?(def|class)\s/.test(m) ||
      /^(if|elif|else|for|while|try|except|finally|with)\b/.test(m.trim());
    if (isCompound) {
      const trimmed = m.trim();
      if (/^(async\s+)?(def|class)\s/.test(trimmed)) {
        scopeIndents.push(indent);
        line += 1;
        continue;
      }
      if (!inFunction) {
        if (/^if\b/.test(trimmed)) {
          ifSeq += 1;
          blockStack.push({
            indent,
            kind: 'if',
            arm: 0,
            group: { id: ifSeq, hasElse: false, armCount: 1, arms: new Map() }
          });
        } else if (/^elif\b/.test(trimmed) && blockStack.length > 0) {
          const top = blockStack[blockStack.length - 1];
          if (top.group !== null) {
            top.group.armCount += 1;
            top.arm += 1;
          }
        } else if (/^else\b/.test(trimmed) && blockStack.length > 0) {
          const top = blockStack[blockStack.length - 1];
          if (top.group !== null) {
            top.group.hasElse = true;
            top.group.armCount += 1;
            top.arm += 1;
          }
        } else {
          // 头 token 剥尾部冒号:`try:`/`finally:` 是单 token,带冒号
          // 恒不中 maybe 名单(`for i in xs:` 有后文自然剥开,不受影响)
          blockStack.push({ indent, kind: trimmed.split(/\s/)[0].replace(/:+$/, ''), group: null, arm: 0 });
        }
      }
      line += 1;
      continue;
    }
    if (!inFunction) {
      const next = collectWriter(m, realLines, line, blockStack, collectors);
      if (next > line) {
        line = next; // 多行字面量写点整体跳过
        continue;
      }
    }
    line += 1;
  }
  const out = new Map<string, DictFormat>();
  for (const [name, state] of collectors) {
    const shape = resolveShape(state.recs, state.groups);
    if (shape !== null) {
      out.set(name, shape);
    }
  }
  return out;
}

/**
 * 单行写点收集(掩码行判形状;字面量配对/键串走原文行)。返回 >
 * line 表示多行字面量写点已被整体消费,调用方跳至返回行。
 */
function collectWriter(
  m: string,
  realLines: string[],
  line: number,
  blockStack: ReadonlyArray<BlockFrame>,
  collectors: Map<string, { recs: WriterRec[]; groups: Map<number, IfGroup> }>
): number {
  const rankOf = (): KeyRank => {
    for (const block of blockStack) {
      if (block.kind === 'for' || block.kind === 'while' || block.kind === 'try' ||
          block.kind === 'except' || block.kind === 'finally' || block.kind === 'with') {
        return 'maybe';
      }
    }
    for (const block of blockStack) {
      if (block.group !== null) {
        return 'complete'; // 占位:组解析时按全臂覆盖/hasElse 降级
      }
    }
    return 'always';
  };
  const groupId = (): IfGroup | null => {
    for (let i = blockStack.length - 1; i >= 0; i -= 1) {
      if (blockStack[i].group !== null) {
        return blockStack[i].group;
      }
      if (blockStack[i].kind === 'for' || blockStack[i].kind === 'while' ||
          blockStack[i].kind === 'try' || blockStack[i].kind === 'except' ||
          blockStack[i].kind === 'finally' || blockStack[i].kind === 'with') {
        return null;
      }
    }
    return null;
  };
  const group = groupId();
  const baseRank = rankOf();
  const push = (
    name: string,
    rec: Omit<WriterRec, 'line'>
  ): void => {
    let state = collectors.get(name);
    if (!state) {
      state = { recs: [], groups: new Map() };
      collectors.set(name, state);
    }
    state.recs.push({ line, ...rec });
    if (group !== null) {
      let g = state.groups.get(group.id);
      if (!g) {
        g = { id: group.id, hasElse: group.hasElse, armCount: group.armCount, arms: new Map() };
        state.groups.set(g.id, g);
      }
      g.hasElse = group.hasElse;
      g.armCount = group.armCount;
      const arm = armIndex(blockStack);
      const keys = g.arms.get(arm) ?? new Map();
      for (const [k, v] of rec.keys) {
        keys.set(k, v);
      }
      g.arms.set(arm, keys);
    }
  };
  const armIndex = (stack: ReadonlyArray<BlockFrame>): number => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].group !== null) {
        return stack[i].arm;
      }
    }
    return 0;
  };

  // ── NAME = { 字面量(重绑语义;注解形参容忍)──
  const literalAssign = /^([A-Za-z_]\w*)\s*(?::[^=]*?)?=\s*\{/.exec(m.trim());
  if (literalAssign) {
    const raw = realLines[line] ?? '';
    const rawTrim = raw.trim();
    const braceOffset = rawTrim.indexOf('{');
    const rawIndent = raw.length - raw.trimStart().length;
    const matched = braceOffset >= 0
      ? matchDictBraces(realLines, line, rawIndent + braceOffset)
      : null;
    if (matched) {
      const keys = literalKeysOf(matched);
      push(literalAssign[1], {
        rebind: true,
        rank: baseRank,
        dynamic: keys.dynamic,
        unknownBase: false,
        keys: keys.map
      });
      return matched.endLine + 1;
    }
    // `{` 配对失败(超窗/未闭):形状不猜——非字面量终局,诚实
    push(literalAssign[1], { rebind: true, rank: baseRank, dynamic: false, unknownBase: true, keys: new Map() });
    return line + 1;
  }
  // ── NAME = 非字面量 RHS(调用/裸名/标量)= unknown 终局证据
  //(掩码行判:注释/字符串位天然不匹配)──
  const plainAssign = /^([A-Za-z_]\w*)\s*(?::[^=]*?)?=(?![=>])\s*\S/.exec(m.trim());
  if (plainAssign) {
    push(plainAssign[1], { rebind: true, rank: baseRank, dynamic: false, unknownBase: true, keys: new Map() });
    return line + 1;
  }
  // ── NAME[键] = RHS(单段字面量键=观测键;变量键=开放)──
  // 键串引号被掩码抹成 '_',形状匹配走原文行;名位经掩码行核验
  //(注释/字符串位不判,SER-04/05/06 同构坑)
  const raw = realLines[line] ?? '';
  const rawTrim = raw.trim();
  const subWrite = /^([A-Za-z_]\w*)\s*\[\s*(['"])([\s\S]*?)\2\s*\]\s*=(?![=>])/.exec(rawTrim);
  if (subWrite) {
    const nameAt = subWrite.index + subWrite[0].indexOf(subWrite[1]);
    if (m.trim().slice(nameAt, nameAt + subWrite[1].length) !== subWrite[1]) {
      return line; // 注释/字符串位:名非真代码
    }
    const quoteAt = rawTrim.indexOf(subWrite[2], subWrite[1].length);
    const keyText = quoteAt >= 0
      ? rawTrim.slice(quoteAt + 1).split(subWrite[2])[0]
      : subWrite[3];
    const rhsAt = rawTrim.indexOf('=', rawTrim.indexOf(']')) + 1;
    const value = classifyValue(rawTrim.slice(rhsAt).trim());
    push(subWrite[1], {
      rebind: false,
      rank: baseRank,
      dynamic: false,
      unknownBase: false,
      keys: new Map([[keyText, value]])
    });
    return line + 1;
  }
  // ── NAME[动态键] = … / NAME[切片] = … → 开放 ──
  const dynWrite = /^([A-Za-z_]\w*)\s*\[(?!\s*['"]).+\]\s*=(?![=>])/.exec(m.trim());
  if (dynWrite) {
    push(dynWrite[1], { rebind: false, rank: baseRank, dynamic: true, unknownBase: false, keys: new Map() });
    return line + 1;
  }
  // ── NAME.update(...) / NAME.setdefault(...) / NAME |= RHS ──
  const updateCall = /^([A-Za-z_]\w*)\s*\.\s*(update|setdefault)\s*\((.+)\)\s*$/.exec(m.trim());
  if (updateCall) {
    const rawTrim = raw.trim();
    if (updateCall[2] === 'setdefault') {
      // setdefault 语义:key = 首实参,值 = 次实参(缺省 None)——dict
      // 实参是被插入的值,不是 update 的键面合并
      const argsText = rawTrim.slice(rawTrim.indexOf('(') + 1, rawTrim.lastIndexOf(')')).trim();
      const args = splitTopLevel(argsText);
      const keyTok = args !== null && args.length >= 1 ? args[0].trim() : '';
      const setKey = keyTok.length >= 2 && isQuotedLiteral(keyTok)
        ? keyTok.slice(1, -1)
        : null;
      if (setKey === null) {
        push(updateCall[1], { rebind: false, rank: baseRank, dynamic: true, unknownBase: false, keys: new Map() });
      } else {
        const valueText = args !== null && args.length >= 2 ? args[1].trim() : 'None';
        push(updateCall[1], {
          rebind: false,
          rank: baseRank,
          dynamic: false,
          unknownBase: false,
          keys: new Map([[setKey, classifyValue(valueText)]])
        });
      }
      return line + 1;
    }
    const openAt = rawTrim.indexOf('(');
    const argText = rawTrim.slice(openAt + 1, rawTrim.lastIndexOf(')')).trim();
    const braceAt = argText.indexOf('{');
    const argIndent = rawIndentOf(raw, argText, braceAt);
    const matched = braceAt >= 0 && argIndent >= 0
      ? matchDictBraces(realLines, line, argIndent)
      : null;
    if (matched) {
      const keys = literalKeysOf(matched);
      push(updateCall[1], {
        rebind: false,
        rank: baseRank,
        dynamic: keys.dynamic,
        unknownBase: false,
        keys: keys.map
      });
    } else {
      // 非字面量实参/多实参混合 → 开放宇宙
      push(updateCall[1], { rebind: false, rank: baseRank, dynamic: true, unknownBase: false, keys: new Map() });
    }
    return line + 1;
  }
  const ior = /^([A-Za-z_]\w*)\s*\|=\s*(.+)$/.exec(m.trim());
  if (ior) {
    const rawTrim = raw.trim();
    const braceAt = rawTrim.indexOf('{');
    const argIndent = braceAt >= 0 ? rawIndentOf(raw, rawTrim, braceAt) : -1;
    const matched = braceAt >= 0 && argIndent >= 0
      ? matchDictBraces(realLines, line, argIndent)
      : null;
    if (matched) {
      const keys = literalKeysOf(matched);
      push(ior[1], { rebind: false, rank: baseRank, dynamic: keys.dynamic, unknownBase: false, keys: keys.map });
    } else {
      push(ior[1], { rebind: false, rank: baseRank, dynamic: true, unknownBase: false, keys: new Map() });
    }
    return line + 1;
  }
  // ── del NAME[键] → 键证据作废面,开放处理 ──
  if (/^del\s+[A-Za-z_]\w*\s*\[/.test(m.trim())) {
    const delName = /^del\s+([A-Za-z_]\w*)/.exec(m.trim());
    if (delName) {
      push(delName[1], { rebind: false, rank: baseRank, dynamic: true, unknownBase: false, keys: new Map() });
    }
    return line + 1;
  }
  return line;
}

/** 行原文中 argText 首个 `{` 的绝对列(argText 未出现/无 `{` → -1)。 */
function rawIndentOf(raw: string, argText: string, braceAt: number): number {
  if (braceAt < 0) {
    return -1;
  }
  const probe = argText.slice(braceAt, braceAt + 1);
  if (probe !== '{') {
    return -1;
  }
  const rawTrim = raw.trim();
  const at = rawTrim.indexOf('{', rawTrim.indexOf(argText.slice(0, 8)));
  if (at < 0) {
    return -1;
  }
  return raw.length - raw.trimStart().length + at;
}

/** 字面量 → 键证据(单写点全键必有;** 展开/推导式/动态键 → 开放)。 */
function literalKeysOf(matched: MatchedBraces): { map: KeyEvidence; dynamic: boolean } {
  const { pairs, openUniverse } = parseDictPairs(matched);
  const map: KeyEvidence = new Map();
  let dynamic = openUniverse;
  for (const pair of pairs) {
    if (pair.spread || pair.key === null) {
      dynamic = true;
      continue;
    }
    if (isComprehensionValue(pair.valueText)) {
      dynamic = true;
      continue;
    }
    map.set(pair.key, classifyValue(pair.valueText));
  }
  return { map, dynamic };
}

/** 值文本顶层含 for…in(字典/集合推导式)→ 开放结构。 */
function isComprehensionValue(valueText: string): boolean {
  let probe = valueText.trim();
  const open = probe[0];
  if (open === '{' || open === '[' || open === '(') {
    // 值自带外层括号:剥到括号内找 depth-0 的 for(推导式本体),
    // 否则 `{k: 1 for k in xs}` 的 for 恒在深度 1,推导式漏检
    const inner = unwrapBracket(probe, open, open === '{' ? '}' : open === '[' ? ']' : ')');
    if (inner !== null) {
      probe = inner;
    }
  }
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < probe.length; i += 1) {
    const ch = probe[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
    } else if (ch === '[' || ch === '(' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth -= 1;
    } else if (depth === 0 && /\bfor\b/.test(probe.slice(i, i + 4))) {
      return true;
    }
  }
  return false;
}

/** 值字面量分类(原文 valueText;引号完整可见)。 */
function classifyValue(valueText: string): DictValueKind {
  const v = valueText.trim();
  if (v.length === 0) {
    return { kind: 'unknown' };
  }
  if (isQuotedLiteral(v)) {
    return { kind: 'scalar', scalar: 'str' };
  }
  if (/^-?\d+$/.test(v)) {
    return { kind: 'scalar', scalar: 'int' };
  }
  if (/^-?\d+\.\d+$/.test(v)) {
    return { kind: 'scalar', scalar: 'float' };
  }
  if (v === 'True' || v === 'False') {
    return { kind: 'scalar', scalar: 'bool' };
  }
  if (v === 'None') {
    return { kind: 'scalar', scalar: 'none' };
  }
  if (v[0] === '[') {
    if (isComprehensionValue(v)) {
      return { kind: 'list', element: null }; // 推导式列表:元素宇宙开放
    }
    const inner = unwrapBracket(v, '[', ']');
    if (inner === null) {
      return { kind: 'unknown' };
    }
    const items = splitTopLevel(inner);
    if (items === null || items.length === 0) {
      return { kind: 'list', element: null };
    }
    const first = classifyValue(items[0]);
    for (const item of items.slice(1)) {
      if (!sameKind(first, classifyValue(item))) {
        return { kind: 'list', element: null }; // 混合元素 → 未收敛,不猜
      }
    }
    return { kind: 'list', element: first };
  }
  if (v[0] === '{') {
    const inner = unwrapBracket(v, '{', '}');
    if (inner === null || isComprehensionValue(v)) {
      return { kind: 'dict', dict: { kind: 'open', observed: new Map() } };
    }
    const synthesized: MatchedBraces = {
      joined: v,
      lineStarts: lineStartsOf(v),
      startLine: 0,
      startColumn: 0,
      endLine: v.split('\n').length - 1,
      endColumn: v.length
    };
    const { pairs, openUniverse } = parseDictPairs(synthesized);
    const required = new Map<string, DictValueKind>();
    const optional = new Map<string, DictValueKind>();
    let open = openUniverse;
    for (const pair of pairs) {
      if (pair.spread || pair.key === null) {
        open = true;
        continue;
      }
      required.set(pair.key, classifyValue(pair.valueText));
    }
    if (open) {
      const observed = new Map<string, DictValueKind>();
      for (const [k, val] of required) {
        observed.set(k, val);
      }
      return { kind: 'dict', dict: { kind: 'open', observed } };
    }
    return { kind: 'dict', dict: { kind: 'literal', required, optional } };
  }
  return { kind: 'unknown' };
}

/** 带引号字面量(首尾同引号;转义闭口容忍)。 */
function isQuotedLiteral(v: string): boolean {
  const q = v[0];
  if (q !== '\'' && q !== '"') {
    return false;
  }
  return v.length >= 2 && v[v.length - 1] === q;
}

/** 平衡括号内文(首尾括号配对,引号感知;不闭 → null)。 */
function unwrapBracket(v: string, open: string, close: string): string | null {
  if (v[0] !== open) {
    return null;
  }
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < v.length; i += 1) {
    const ch = v[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
    } else if (ch === open || ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === close || ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return v.slice(1, i);
      }
    }
  }
  return null;
}

/** 顶层逗号切分(引号/深度感知;残缺引号段原样返回)。 */
function splitTopLevel(text: string): string[] | null {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') {
        current += text.slice(i, i + 2);
        i += 1;
        continue;
      }
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '(' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail.length > 0) {
    items.push(tail);
  }
  return items;
}

/** 同值类型判定(嵌套 dict 深等比较)。 */
function sameKind(a: DictValueKind, b: DictValueKind): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'scalar' && b.kind === 'scalar') {
    return a.scalar === b.scalar;
  }
  if (a.kind === 'list' && b.kind === 'list') {
    if (a.element === null || b.element === null) {
      return a.element === b.element;
    }
    return sameKind(a.element, b.element);
  }
  return true; // dict/unknown 同 kind 即视为一致形状证据
}

/** 合成 MatchedBraces 用的行起始表。 */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * 写点序列 → 最终格式:
 *  - 无条件字面量写点 = 重绑(清空前序证据,含条件写点);
 *  - 无条件非字面量 = unknown 终局(其后动态写点 → open+observed);
 *  - 条件写点并入;if 组全臂齐键(组带 else)→ complete 键升必有;
 *  - 任意动态证据 → open。
 */
function resolveShape(
  recs: readonly WriterRec[],
  groups: ReadonlyMap<number, IfGroup>
): DictFormat | null {
  if (recs.length === 0) {
    return null;
  }
  // 组解析:hasElse && 全臂齐键的键 → complete
  const completeKeys = new Set<string>();
  for (const g of groups.values()) {
    if (!g.hasElse || g.armCount < 2 || g.arms.size < g.armCount) {
      continue;
    }
    const first = g.arms.get(0);
    if (!first) {
      continue;
    }
    for (const key of first.keys()) {
      let all = true;
      for (const armKeys of g.arms.values()) {
        if (!armKeys.has(key)) {
          all = false;
          break;
        }
      }
      if (all) {
        completeKeys.add(key);
      }
    }
  }
  let recs2: WriterRec[] = [];
  let unknownBase = false;
  for (const rec of recs) {
    if (rec.rank === 'always' && !rec.dynamic && rec.unknownBase) {
      unknownBase = true;
      recs2 = [{ ...rec, rank: 'always' }];
      continue;
    }
    if (rec.rank === 'always' && !rec.dynamic && rec.rebind) {
      // 无条件字面量赋值 = 重绑(增量写点在序后并入,不重置)
      unknownBase = false;
      recs2 = [{ ...rec, rank: 'always' }];
      continue;
    }
    if (rec.rank === 'always' && rec.dynamic) {
      recs2.push(rec);
      continue;
    }
    if (unknownBase && rec.rank !== 'always') {
      continue; // unknown 基上的条件写点:开放面已表达,不并键(always
      // 写点保留:观测键面是开放结构的证据载体)
    }
    recs2.push(rec);
  }
  if (recs2.length === 0) {
    return null;
  }
  const open = recs2.some(rec => rec.dynamic) || unknownBase;
  const merged = new Map<string, { value: DictValueKind; rank: KeyRank }>();
  for (const rec of recs2) {
    for (const [key, value] of rec.keys) {
      let rank: KeyRank = rec.rank;
      if (rank === 'complete') {
        rank = completeKeys.has(key) ? 'complete' : 'maybe';
      }
      const prior = merged.get(key);
      if (!prior) {
        merged.set(key, { value, rank });
        continue;
      }
      if (RANK_ORDER[rank] > RANK_ORDER[prior.rank]) {
        merged.set(key, { value, rank });
      } else if (RANK_ORDER[rank] === RANK_ORDER[prior.rank] && !sameKind(prior.value, value)) {
        merged.set(key, { value: { kind: 'unknown' }, rank });
      }
    }
  }
  if (open) {
    const observed = new Map<string, DictValueKind>();
    for (const [key, entry] of merged) {
      observed.set(key, entry.value);
    }
    if (observed.size === 0) {
      return null; // 开放宇宙但零观测证据:无形状声称(缺键即未知)
    }
    return { kind: 'open', observed };
  }
  const required = new Map<string, DictValueKind>();
  const optional = new Map<string, DictValueKind>();
  for (const [key, entry] of merged) {
    if (entry.rank === 'always' || entry.rank === 'complete') {
      required.set(key, entry.value);
    } else {
      optional.set(key, entry.value);
    }
  }
  if (required.size === 0 && optional.size === 0) {
    return null; // 只有 unknown 基零键证据:无形状声称
  }
  return { kind: 'literal', required, optional };
}

const RANK_ORDER: Record<KeyRank, number> = { always: 2, complete: 1, maybe: 0 };
