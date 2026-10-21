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

/** 只认 self.<role>.<name> 形态;entity.cell.X 等局部接收者不识别(用户令) */
const PYTHON_RECEIVER_CALL_PATTERN =
  /\bself\.(cell|base|client)\.([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * 光标处的接收者调用解析:F12/Hover 面用。光标必须落在方法名 token 上
 * (self.cell./self.base./self.client. 的第三段);落在接收者段或别处 → null。
 */
export function getPythonReceiverCallAtPosition(
  lineText: string,
  character: number
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
    return {
      line: 0,
      character: nameStart,
      receiver,
      section: PYTHON_RECEIVER_SECTIONS[receiver],
      methodName
    };
  }

  return null;
}

/** 全文档接收者调用扫描(CodeLens 面):每行每处 self.<role>.<name> 一条 */
export function findPythonReceiverCalls(text: string): PythonReceiverCall[] {
  const calls: PythonReceiverCall[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const regex = new RegExp(PYTHON_RECEIVER_CALL_PATTERN.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(lines[index])) !== null) {
      const methodName = match[2];
      calls.push({
        line: index,
        character: match.index + match[0].length - methodName.length,
        receiver: match[1] as PythonReceiverCall['receiver'],
        section: PYTHON_RECEIVER_SECTIONS[match[1] as PythonReceiverCall['receiver']],
        methodName
      });
    }
  }

  return calls;
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
