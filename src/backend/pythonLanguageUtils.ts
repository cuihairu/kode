export interface PythonSelfAccess {
  rootSymbol: string;
  currentSymbol: string;
  fullPath: string;
}

export interface PythonSelfCompletionContext {
  rootSymbol: string | null;
  parentPath: string;
  fullPath: string;
  partialSymbol: string;
}

export function getPythonSelfAccessAtPosition(
  lineText: string,
  character: number
): PythonSelfAccess | null {
  const regex = /\bself\.(\w+(?:\.\w+)*)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(lineText)) !== null) {
    const fullMatch = match[0];
    const accessPath = match[1];
    // fullMatch 恒等于 'self.' + accessPath(批86 M7 反向发现:indexOf 会命中
    // 'self' 内部同形子串,'self.e' 的 'e' 令 pathStart 越界),按后缀算术取路径起点
    const pathStart = match.index + fullMatch.length - accessPath.length;
    const segments = accessPath.split('.');

    let segmentOffset = pathStart;
    for (const segment of segments) {
      const segmentStart = segmentOffset;
      const segmentEnd = segmentStart + segment.length;

      if (character >= segmentStart && character <= segmentEnd) {
        return {
          rootSymbol: segments[0],
          currentSymbol: segment,
          fullPath: accessPath
        };
      }

      segmentOffset = segmentEnd + 1;
    }
  }

  return null;
}

/** def 方法区块(与 defParser 的 DefMethodSection 同形;此处只做接收者段映射) */
export type PythonReceiverSection = 'BaseMethods' | 'CellMethods' | 'ClientMethods';

export interface PythonReceiverCall {
  /** 文档行(0 起;单行口径恒 0) */
  line: number;
  /** 方法名在行内的起始列(0 起) */
  character: number;
  /** 接收者段:self.cell / self.base / self.client 的段名 */
  receiver: 'cell' | 'base' | 'client';
  /** 接收者段对应的 def 方法区块(段闸依据) */
  section: PythonReceiverSection;
  /** 被调用的方法名 */
  methodName: string;
  /**
   * 调用面(脚本目录域换算;逐面语义闸依据)。未换算(调用方未给路径
   * 域)→ undefined:语义闸按旧口径走(receiver → 段),不裁合法性。
   */
  callerFace?: PythonCallerFace;
}

/** 接收者段 → def 方法区块(用户令 2026-10-21:cell→CellMethods 等,一一对应) */
export const PYTHON_RECEIVER_SECTIONS: Record<
  PythonReceiverCall['receiver'],
  PythonReceiverSection
> = {
  cell: 'CellMethods',
  base: 'BaseMethods',
  client: 'ClientMethods'
};

/** def 方法区块 → 接收者段(引用收录面 IDE-NAV-003:CellMethods→cell 等,反查表) */
export const PYTHON_RECEIVER_BY_SECTION: Record<
  PythonReceiverSection,
  PythonReceiverCall['receiver']
> = {
  CellMethods: 'cell',
  BaseMethods: 'base',
  ClientMethods: 'client'
};

/**
 * 调用面(脚本目录域:scripts/base|cell|client|bots;与 entityMapping
 * pythonScriptDomain 同名同域,此处不引依赖,值由调用方换算)。
 */
export type PythonCallerFace = 'base' | 'cell' | 'client';

/**
 * 逐面语义表(深审-3 收口,引擎九面属性表;与 Rust refs.rs bind_self_role
 * 同源单点语义):每个调用面上 self.<receiver> 的合法派发目标段;该面无此
 * 角色属性 → null。引擎依据(SCRIPT_GET_DECLARE 构造点逐个核):
 * baseapp 有 .cell/.client(baseapp/entity.cpp:750/:800)、cellapp 有
 * .base/.client(cellapp/entity.cpp:391/:573,.client 是 CLIENT_VIA_BASE,
 * 目标段仍是 ClientMethods)、client 有 .base/.cell(client_lib/entity.cpp:
 * 104/:115);同面无此属性(base.base/cell.cell/client.client,自身即该面;
 * client 面同名 .clientapp 是应用对象非角色引用)。照旧无条件段映射会把
 * AttributeError 的引用当合法派发去对账 def 段——与 bind_self_role 矛盾
 * (九面表:非法 face·attr 组合 → None),诊断闸须先过本表。
 */
export const PYTHON_RECEIVER_FACES: Record<
  PythonCallerFace,
  Record<PythonReceiverCall['receiver'], PythonReceiverSection | null>
> = {
  base: { cell: 'CellMethods', base: null, client: 'ClientMethods' },
  cell: { cell: null, base: 'BaseMethods', client: 'ClientMethods' },
  client: { cell: 'CellMethods', base: 'BaseMethods', client: null }
};

/**
 * 逐面语义闸:解析接收者在该调用面的目标段(段闸依据)。调用面已知 →
 * 九面表裁定(面上无此属性 → null,该引用是 AttributeError,def 段对账
 * 不适用);调用面未知 → 保旧口径(receiver → 段,目标段映射 whenever
 * 该引用合法恒真,未知面不裁合法性与目标段无关)。
 */
export function pythonReceiverSectionFor(
  callerFace: PythonCallerFace | null | undefined,
  receiver: PythonReceiverCall['receiver']
): PythonReceiverSection | null {
  if (callerFace) {
    return PYTHON_RECEIVER_FACES[callerFace][receiver];
  }
  return PYTHON_RECEIVER_SECTIONS[receiver];
}

/** 只认 self.<role>.<name> 形态;entity.cell.X 等局部接收者不识别(用户令) */
const PYTHON_RECEIVER_CALL_PATTERN =
  /\bself\.(cell|base|client)\.([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * 光标处的接收者调用解析:F12/Hover 面用。光标必须落在方法名 token 上
 * (self.cell./self.base./self.client. 的第三段);落在接收者段或别处 → null。
 * callerFace 可选(逐面语义闸依据,见 pythonReceiverSectionFor)。
 */
export function getPythonReceiverCallAtPosition(
  lineText: string,
  character: number,
  callerFace?: PythonCallerFace
): PythonReceiverCall | null {
  const regex = new RegExp(PYTHON_RECEIVER_CALL_PATTERN.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(lineText)) !== null) {
    const methodName = match[2];
    // match[0] 恒为 'self.<role>.' + methodName(批86 同口径:按后缀算术取起点,
    // 不用 indexOf——方法名与 'self' 同形子串会错位)
    const nameStart = match.index + match[0].length - methodName.length;
    const nameEnd = nameStart + methodName.length;
    if (character < nameStart || character > nameEnd) {
      continue;
    }
    const receiver = match[1] as PythonReceiverCall['receiver'];
    const section = pythonReceiverSectionFor(callerFace, receiver);
    if (section === null) {
      return null; // 调用面无此角色属性(AttributeError 面):不产出派生信息
    }
    return {
      line: 0,
      character: nameStart,
      receiver,
      section,
      methodName,
      callerFace
    };
  }

  return null;
}

/** 全文档接收者调用扫描(CodeLens 面):每行每处 self.<role>.<name> 一条 */
export function findPythonReceiverCalls(
  text: string,
  callerFace?: PythonCallerFace
): PythonReceiverCall[] {
  const calls: PythonReceiverCall[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const regex = new RegExp(PYTHON_RECEIVER_CALL_PATTERN.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(lines[index])) !== null) {
      const methodName = match[2];
      const receiver = match[1] as PythonReceiverCall['receiver'];
      const section = pythonReceiverSectionFor(callerFace, receiver);
      if (section === null) {
        continue; // 调用面无此角色属性:不进发现面(诊断闸裁合法性的前置)
      }
      calls.push({
        line: index,
        character: match.index + match[0].length - methodName.length,
        receiver,
        section,
        methodName,
        callerFace
      });
    }
  }

  return calls;
}

export interface PythonReceiverCallArgumentSpan {
  /** 实参首字符列(0 起,已跳过前导空白) */
  start: number;
  /** 实参尾后一列(已剔除尾随空白;inlay hint 锚点) */
  end: number;
  /** 实参去空白直文本(不做任何推导,只作数量对齐用) */
  text: string;
}

export interface PythonReceiverCallWithArguments extends PythonReceiverCall {
  /**
   * 单行口径顶层逗号切分的实参区间;跨行调用/括号不闭合 → 空数组(inlay
   * 不给该调用出提示)。只做机械切分,零语义推导。
   */
  arguments: PythonReceiverCallArgumentSpan[];
}

const CALL_ARGUMENT_OPENERS = new Set(['(', '[', '{']);
const CALL_ARGUMENT_CLOSERS = new Set([')', ']', '}']);
const CALL_ARGUMENT_CLOSER_FOR: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * 从方法名结束处向后取同行实参:首个 '(' 起到深度 0 的 ')' 止,内容按顶层
 * 逗号切分(深度计 ()[]{},字符串 ' " 内的逗号/括号不算)。同行找不到闭合
 * ')' → null(跨行调用不出实参表)。
 */
function parseSingleLineCallArguments(
  lineText: string,
  scanFrom: number
): PythonReceiverCallArgumentSpan[] | null {
  let openParen = -1;
  for (let index = scanFrom; index < lineText.length; index += 1) {
    if (lineText[index] === '(') {
      openParen = index;
      break;
    }
    if (!/\s/.test(lineText[index])) {
      // 方法名与 '(' 之间出现其他 token(如换行前的运算符尾)→ 不认
      return null;
    }
  }
  if (openParen === -1) {
    return null;
  }

  const spans: PythonReceiverCallArgumentSpan[] = [];
  const depth: string[] = [];
  let inString: string | null = null;
  let currentStart = -1;

  for (let index = openParen + 1; index < lineText.length; index += 1) {
    const ch = lineText[index];
    if (inString) {
      if (ch === '\\') {
        index += 1;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      inString = ch;
      if (depth.length === 0 && currentStart === -1) {
        currentStart = index;
      }
      continue;
    }
    if (depth.length === 0 && ch === ')') {
      if (currentStart !== -1) {
        spans.push(finishArgumentSpan(lineText, currentStart, index));
      }
      return spans;
    }
    if (depth.length === 0 && ch === ',') {
      if (currentStart !== -1) {
        spans.push(finishArgumentSpan(lineText, currentStart, index));
        currentStart = -1;
      }
      continue;
    }
    if (CALL_ARGUMENT_OPENERS.has(ch)) {
      if (depth.length === 0 && currentStart === -1) {
        currentStart = index;
      }
      depth.push(CALL_ARGUMENT_CLOSER_FOR[ch]);
      continue;
    }
    if (CALL_ARGUMENT_CLOSERS.has(ch) && depth.length > 0 && ch === depth[depth.length - 1]) {
      depth.pop();
    }
    if (depth.length === 0 && currentStart === -1 && !/\s/.test(ch)) {
      currentStart = index;
    }
  }

  // 同行括号不闭合(跨行调用)→ 整体不出实参表
  return null;
}

function finishArgumentSpan(
  lineText: string,
  start: number,
  end: number
): PythonReceiverCallArgumentSpan {
  let lo = start;
  let hi = end;
  while (lo < hi && /\s/.test(lineText[lo])) {
    lo += 1;
  }
  while (hi > lo && /\s/.test(lineText[hi - 1])) {
    hi -= 1;
  }
  return { start: lo, end: hi, text: lineText.slice(lo, hi) };
}

/** 全文档接收者调用实参扫描(inlay 形参提示面):调用 + 同行实参区间 */
export function findPythonReceiverCallArguments(
  text: string,
  callerFace?: PythonCallerFace
): PythonReceiverCallWithArguments[] {
  return findPythonReceiverCalls(text, callerFace).map(call => {
    const lineText = text.split(/\r?\n/)[call.line] ?? '';
    const nameEnd = call.character + call.methodName.length;
    const arguments_ = parseSingleLineCallArguments(lineText, nameEnd);
    return { ...call, arguments: arguments_ ?? [] };
  });
}

export function getPythonSelfSymbolAtPosition(lineText: string, character: number): string | null {
  const access = getPythonSelfAccessAtPosition(lineText, character);
  return access ? access.rootSymbol : null;
}

export function getPythonSelfCompletionContext(lineText: string): PythonSelfCompletionContext | null {
  const match = lineText.match(/\bself\.(\w+(?:\.\w+)*)?\.?$/);
  if (!match) {
    return null;
  }

  const accessPath = match[1] || '';
  const endsWithDot = lineText.endsWith('.');
  const segments = accessPath ? accessPath.split('.') : [];

  if (endsWithDot) {
    return {
      rootSymbol: segments.length > 0 ? segments[0] : null,
      parentPath: accessPath,
      fullPath: accessPath,
      partialSymbol: ''
    };
  }

  // 不可达(批65 定性):能走到此处必是"正则命中且行不以 '.' 结尾"——组1 未
  // 匹配时命中串只能是 'self.'/'self..'(双点亦被 `\.?` 吞掉),均以 '.' 结尾
  // 而在上方 endsWithDot 早退;组1 命中则 accessPath 至少含一个 \w 段,segments
  // 恒非空。两个三元恒取真臂,''/null 兜底无触发路径。语句与分支条目随区间
  // 一并移出分母(TESTING.md 分母口径据实登记);tests/pythonLanguageUtils
  // .test.ts 另以 'self..'(双点仍走早退)与 'self.a..'(锚定失败归 null)
  // 锁死通往此处的输入形状。
  /* istanbul ignore start */
  const partialSymbol = segments.length > 0 ? segments[segments.length - 1] : '';
  const rootSymbol = segments.length > 0 ? segments[0] : null;
  /* istanbul ignore stop */
  const parentPath = segments.length > 1 ? segments.slice(0, -1).join('.') : '';

  return {
    rootSymbol,
    parentPath,
    fullPath: accessPath,
    partialSymbol
  };
}

export interface PythonMemberAccess {
  /** 接收者名(非 self:avatar/monster 等对象名) */
  receiverName: string;
  /** 光标所在成员名(方法名段) */
  memberName: string;
  /** 完整访问路径 接收者.成员 */
  fullPath: string;
}

/**
 * 光标处成员访问解析(批158,用户令 2026-10-26):非 self 接收者的调用形态
 * avatar.SendErrorInfo("err", 1)。只认「调用形」——成员名后(允许空白)必须是
 * '(';属性访问/传方法引用不走此层。self.* 有专属管线
 * (getPythonSelfAccessAtPosition),此处跳过避免双管线。光标必须落在成员名
 * 段(与接收者调用同口径:按后缀算术取起点,不用 indexOf——成员名与接收者
 * 同形子串会错位);落在接收者段不认(接收者词由其它面负责)。
 */
export function getPythonMemberAccessAtPosition(
  lineText: string,
  character: number
): PythonMemberAccess | null {
  const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(lineText)) !== null) {
    const receiverName = match[1];
    const memberName = match[2];
    if (receiverName === 'self') {
      continue;
    }
    const nameStart = match.index + match[0].length - memberName.length;
    const nameEnd = nameStart + memberName.length;
    if (character < nameStart || character > nameEnd) {
      continue;
    }
    let scan = nameEnd;
    while (scan < lineText.length && /\s/.test(lineText[scan])) {
      scan += 1;
    }
    if (lineText[scan] !== '(') {
      continue;
    }
    return {
      receiverName,
      memberName,
      fullPath: `${receiverName}.${memberName}`
    };
  }

  return null;
}

export interface PythonCallAtPosition {
  /** 接收者:'self' 或对象变量名(avatar 等) */
  receiverName: string;
  /** 被调方法名 */
  methodName: string;
  /** 接收者段对应的 def 方法区块(与 PythonReceiverCall.section 同口径,
   *  段闸依据);无段(undefined) */
  section?: PythonReceiverSection;
  /** 光标所在实参序号(顶层逗号切分,0 起) */
  activeArgument: number;
}

/**
 * 光标处调用解析(批159 签名帮助面):覆盖 self.base/cell/client.X(...) 与
 * 对象调用 avatar.X(...) 两形态;光标须落在「方法名→'(' 之间或实参表内」
 * (实参表按字符串感知深度计顶层逗号,与 inlay 实参切分同源口径)。属性
 * 读取(名字后非 '(')不认;不在任何调用实参表内不认。
 */
export function getPythonCallAtPosition(
  lineText: string,
  character: number
): PythonCallAtPosition | null {
  const regex = /\b(self\.(?:base|cell|client)|[A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/g;
  const candidates: Array<PythonCallAtPosition & { callOpen: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(lineText)) !== null) {
    const receiverToken = match[1];
    const methodName = match[2];
    const callOpen = match.index + match[0].length - 1; // '(' 列
    // 光标须落在 '(' 及其实参表范围内;方法名上不算(签名帮助不在此触发)
    if (character < callOpen) {
      continue;
    }
    // 实参表字符串感知深度扫描:顶层逗号定活动实参,顺带找闭合
    let depth = 0;
    let inString: string | null = null;
    let activeArgument = 0;
    let closed = false;
    let closeIndex = -1;
    for (let i = callOpen; i < lineText.length; i += 1) {
      const ch = lineText[i];
      if (inString) {
        if (ch === '\\') {
          i += 1;
        } else if (ch === inString) {
          inString = null;
        }
        continue;
      }
      if (ch === '\'' || ch === '"') {
        inString = ch;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') {
        depth += 1;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) {
          closed = true;
          closeIndex = i;
          break;
        }
      } else if (ch === ',' && depth === 1 && i < character) {
        activeArgument += 1;
      }
    }
    // 归属判定:闭合调用要求光标不越过闭括号(一行多调用互不吞);
    // 未闭合(边打边求助的进行时)视为延伸到行尾,光标在其后即认。
    if (closed && closeIndex < character) {
      continue;
    }
    const isReceiver = receiverToken.startsWith('self.');
    candidates.push({
      receiverName: isReceiver ? 'self' : receiverToken,
      methodName,
      section: isReceiver
        ? PYTHON_RECEIVER_SECTIONS[receiverToken.split('.')[1] as PythonReceiverCall['receiver']]
        : undefined,
      activeArgument,
      callOpen
    });
  }

  // 嵌套/相邻时取起点最靠后者(最紧包含光标的调用;匹配序即 callOpen 升序)
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}
