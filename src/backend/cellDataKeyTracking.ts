/**
 * cellData 脚本附加键跟踪(KSEM-CELL-09):把文档里每个键操作归入四类——
 * declared(def/组件槽声明字段)、builtin(引擎内建)、scriptAdded(脚本运行
 * 时显式写入的新键)、unknown(只读未写的未知键)——并给出每个操作点的三
 * 态存在性(present/absent/unknown)。CELL-10 错键提示消费:只有 unknown
 * 且封闭世界才提示缺失/拼写;scriptAdded 是合法代码,绝不误报。
 *
 * 复用 CELL-06/07 同一面:scanCellDataKeyOperations(read/write/del + 词法
 * 掩码 + 常量键 + 别名)、cellDataAliasState(有效性/逃逸)、
 * findNearestKeyMutation(作用域限最近写/删,本批导出)。删证据另含伪操作:
 * `pop('字面量')` = 该键的 del;`clear()` = 全部已知键的 del(键宇宙 + 此前
 * 引入的 scriptAdded)——记为 pseudo,与真实 del 同流走 walk。
 *
 * 诚实边界(能推才显,不硬造):
 * - write 恒 present(写后必有);read/get 走 walk:最近有效写 → present,
 *   最近有效删(pseudo 含)→ absent;都无 → 初始状态;
 * - 初始:declared/builtin → present(引擎创建即有);scriptAdded → unknown
 *   (引入写点在别的作用域时调用序不可证,同域先后也保守不断——事实带
 *   introducedLine,消费面可自行细化);unknown → 世界开放则 unknown,
 *   封闭则 absent(cellData 初始恰为宇宙键,未写即无);
 * - 世界开放(存在追踪不到的增键面):动态键下标写(键非整段字符串字面量)、
 *   update(/setdefault( → unknown 键不再断 absent;
 * - 别名:无效别名(已重绑定)的操作整条剔除(操作的是别的字典,既不算
 *   证据也不引入);逃逸后存在性不再可证(read → unknown);
 * - popitem(/动态键 pop 不入证据(popitem 删哪一个不可证,动态 pop 删的
 *   是不在宇宙的键)——本批边界;`self.cellData = {...}` 整体重赋值与
 *   CELL-06 同口径不可见。
 */
import { buildPythonCodeMask, findLineCommentIndex } from './globalDataIndexCore';
import { decodeStringLiteral } from './cellDataKeyAccess';
import {
  cellDataAliasNames,
  cellDataAliasState,
  findNearestKeyMutation,
  scanCellDataKeyOperations,
  type CellDataKeyOperation
} from './cellDataReadType';
import type { CellDataKeyEntry } from './cellDataCompletion';

/** 键的来源四类。 */
export type CellDataKeyClass = 'declared' | 'builtin' | 'scriptAdded' | 'unknown';

/** 操作点键存在性三态。 */
export type CellDataKeyPresence = 'present' | 'absent' | 'unknown';

/** 一次键操作的跟踪事实(每条有效操作一条)。 */
export interface CellDataKeyFact {
  op: CellDataKeyOperation;
  /** 键来源四类(同键全部操作一致)。 */
  keyClass: CellDataKeyClass;
  /** 宇宙条目(declared/builtin);scriptAdded/unknown → null。 */
  entry: CellDataKeyEntry | null;
  /** 操作点的存在性(write=写后恒有;read/get/del=执行前状态)。 */
  presence: CellDataKeyPresence;
  /** 首次脚本写入行(0 基);declared/builtin → null。 */
  introducedLine: number | null;
  /** 最后一次写入之后发生过有效删(下标 del/pop('字面量')/clear)。 */
  removedAfterWrite: boolean;
}

/** 行数组 + 词法掩码 + 行起始偏移(开世界/伪删扫描共用)。 */
interface ScanFaces {
  lines: string[];
  mask: Uint8Array;
  lineStarts: number[];
}

function scanFacesOf(text: string): ScanFaces {
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

/** 正则元字符转义(接收者名 `self.cellData` 含点)。 */
function escapeRegExp(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 剥行尾注释(引号外 `#`;无 → 原文)。 */
function stripLineComment(lineText: string): string {
  const at = findLineCommentIndex(lineText);
  return at === -1 ? lineText : lineText.slice(0, at);
}

/**
 * 动态增键面是否存在于文档(世界开放):接收者(self.cellData/别名)的
 * - 下标写但键表达式不是整段字符串字面量(变量/拼接/f-string/数字)——
 *   scan 解不出的写点,加的键不可追踪;
 * - `.update(` / `.setdefault(`——批量增键不可追踪。
 * 只看单行(与操作扫描同口径);匹配段须在词法代码域。别名有效性不核定
 * (保守:无效别名的动态写落在别的字典上,也算开放)。
 */
/**
 * 文档内是否存在追踪不到的增键面(CELL-10 置信度判据,与 trackCellDataKeys
 * 内部用的是同一判定,消费面不必各自重算一遍):动态键下标写 /
 * update( / setdefault()。有 → 世界开放,unknown 键不报确定性缺失。
 */
export function cellDataKeyWorldOpen(text: string, extraReceivers?: readonly string[]): boolean {
  const receivers = extraReceivers && extraReceivers.length > 0
    ? extraReceivers
    : ['self.cellData', ...cellDataAliasNames(text)];
  return hasDynamicKeyAddition(text, receivers);
}

function hasDynamicKeyAddition(text: string, receivers: readonly string[]): boolean {
  const faces = scanFacesOf(text);
  for (const receiver of receivers) {
    const write = new RegExp(
      `(?<![.\\w])${escapeRegExp(receiver)}\\s*\\[([^\\]]*)\\][ \\t]*=(?!=)`,
      'g'
    );
    const mutators = new RegExp(
      `(?<![.\\w])${escapeRegExp(receiver)}\\s*\\.\\s*(?:update|setdefault)\\s*\\(`,
      'g'
    );
    for (let line = 0; line < faces.lines.length; line += 1) {
      const raw = faces.lines[line] ?? '';
      if (!raw.trim()) {
        continue;
      }
      const stripped = stripLineComment(raw);
      const lineStart = faces.lineStarts[line] ?? 0;
      for (const regex of [write, mutators]) {
        regex.lastIndex = 0;
        let match = regex.exec(stripped);
        while (match) {
          // 只核接收者头段(词头到 `[`/`.`)在代码域——匹配全段含字符串
          // 字面量,掩码会标非代码而误剔(与 scanCellDataKeyOperations 同口径)
          if (!spanIsCode(faces.mask, lineStart + match.index, receiver.length)) {
            match = regex.exec(stripped);
            continue;
          }
          if (regex === write && isWholeStringLiteral(match[1] ?? '')) {
            match = regex.exec(stripped);
            continue; // 整段字面量键 → scan 已追踪,不算开放面
          }
          return true;
        }
      }
    }
  }
  return false;
}

/** 键表达式是否恰为一个字符串字面量(首尾同引号,中间无裸同引号)。 */
function isWholeStringLiteral(expr: string): boolean {
  const trimmed = expr.trim();
  const quoted = /^(['"])(?:\\.|(?!\1)[^\\])*\1$/.exec(trimmed);
  return quoted !== null && decodeStringLiteral(trimmed) !== null;
}

/** 伪删操作(pop('字面量')/clear();与真实 del 同流走 walk)。 */
interface PseudoDel extends CellDataKeyOperation {
  pseudo: true;
}

/**
 * 收集伪删证据:pop('字面量') → 该键一条 del;clear() → 键宇宙全部键 +
 * 该行前已引入的 scriptAdded 键各一条 del(popitem/动态 pop 不入,见模块
 * 头边界)。接收者记原文,walk 内按别名状态核定有效性。
 */
function collectPseudoDels(
  faces: ScanFaces,
  receivers: readonly string[],
  universeKeys: readonly string[],
  introducedBefore: ReadonlyMap<string, number>
): PseudoDel[] {
  const out: PseudoDel[] = [];
  for (const receiver of receivers) {
    const popLiteral = new RegExp(
      `(?<![.\\w])${escapeRegExp(receiver)}\\s*\\.\\s*pop\\s*\\(\\s*(['"])(?:\\\\.|(?!\\1)[^\\\\])*\\1`,
      'g'
    );
    const clear = new RegExp(`(?<![.\\w])${escapeRegExp(receiver)}\\s*\\.\\s*clear\\s*\\(\\s*\\)`, 'g');
    for (let line = 0; line < faces.lines.length; line += 1) {
      const raw = faces.lines[line] ?? '';
      if (!raw.trim()) {
        continue;
      }
      const stripped = stripLineComment(raw);
      const lineStart = faces.lineStarts[line] ?? 0;
      popLiteral.lastIndex = 0;
      let match = popLiteral.exec(stripped);
      while (match) {
        // 只核接收者头段(全段含键字面量,掩码标非代码会误剔)
        if (spanIsCode(faces.mask, lineStart + match.index, receiver.length)) {
          const literal = match[0].slice(match[0].indexOf(match[1])).trim();
          const key = decodeStringLiteral(literal);
          if (key !== null) {
            out.push({
              key,
              line,
              kind: 'del',
              accessKind: 'get',
              receiver,
              exprStart: match.index,
              exprEnd: match.index + match[0].length,
              keyStart: match.index,
              keyEnd: match.index + match[0].length,
              defaultExpr: null,
              pseudo: true
            });
          }
        }
        match = popLiteral.exec(stripped);
      }
      clear.lastIndex = 0;
      match = clear.exec(stripped);
      while (match) {
        if (spanIsCode(faces.mask, lineStart + match.index, receiver.length)) {
          for (const key of universeKeys) {
            out.push({
              key,
              line,
              kind: 'del',
              accessKind: 'get',
              receiver,
              exprStart: match.index,
              exprEnd: match.index + match[0].length,
              keyStart: match.index,
              keyEnd: match.index + match[0].length,
              defaultExpr: null,
              pseudo: true
            });
          }
          for (const [key, introduced] of introducedBefore) {
            if (introduced < line) {
              out.push({
                key,
                line,
                kind: 'del',
                accessKind: 'get',
                receiver,
                exprStart: match.index,
                exprEnd: match.index + match[0].length,
                keyStart: match.index,
                keyEnd: match.index + match[0].length,
                defaultExpr: null,
                pseudo: true
              });
            }
          }
        }
        match = clear.exec(stripped);
      }
    }
  }
  out.sort((a, b) => (a.line - b.line) || (a.exprStart - b.exprStart));
  return out;
}

/**
 * 跟踪文档全部键操作(每条有效操作一条事实)。entries 为键宇宙(Rust
 * cellDataKeys RPC 同形:kind=defField/builtin/componentSlot)。无效别名
 * (已重绑定)的操作整条剔除;存在性走 CELL-06 同一 walk(伪删并入)。
 */
export function trackCellDataKeys(
  text: string,
  entries: readonly CellDataKeyEntry[]
): CellDataKeyFact[] {
  const receivers = ['self.cellData', ...cellDataAliasNames(text)];
  const allOps = scanCellDataKeyOperations(text, receivers);
  const validOps: CellDataKeyOperation[] = [];
  const escapes = new Map<CellDataKeyOperation, { line: number } | null>();
  for (const op of allOps) {
    if (op.receiver === 'self.cellData') {
      escapes.set(op, null);
      validOps.push(op);
      continue;
    }
    const alias = cellDataAliasState(text, op.receiver, op.line);
    if (!alias.valid) {
      continue; // 已重绑定:操作的是别的字典,整条剔除
    }
    escapes.set(op, alias.escaped ? { line: alias.escapedLine ?? alias.aliasLine } : null);
    validOps.push(op);
  }

  const universe = new Map<string, CellDataKeyEntry>();
  for (const entry of entries) {
    if (!universe.has(entry.key)) {
      universe.set(entry.key, entry);
    }
  }
  const writeLinesByKey = new Map<string, number[]>();
  for (const op of validOps) {
    if (op.kind === 'write') {
      const list = writeLinesByKey.get(op.key);
      if (list) {
        list.push(op.line);
      } else {
        writeLinesByKey.set(op.key, [op.line]);
      }
    }
  }

  const keyClassOf = (key: string): CellDataKeyClass => {
    const entry = universe.get(key);
    if (entry) {
      return entry.kind === 'builtin' ? 'builtin' : 'declared';
    }
    return writeLinesByKey.has(key) ? 'scriptAdded' : 'unknown';
  };
  const introducedLineOf = (key: string): number | null => {
    if (keyClassOf(key) !== 'scriptAdded') {
      return null;
    }
    return Math.min(...(writeLinesByKey.get(key) as number[]));
  };

  const faces = scanFacesOf(text);
  const universeKeys = [...universe.keys()];
  const introducedBefore = new Map<string, number>();
  for (const [key, lines] of writeLinesByKey) {
    if (!universe.has(key)) {
      introducedBefore.set(key, Math.min(...lines));
    }
  }
  const pseudo = collectPseudoDels(faces, receivers, universeKeys, introducedBefore);
  const worldOpen = hasDynamicKeyAddition(text, receivers);

  const delLinesByKey = new Map<string, number[]>();
  for (const op of [...validOps, ...pseudo]) {
    if (op.kind === 'del') {
      const list = delLinesByKey.get(op.key);
      if (list) {
        list.push(op.line);
      } else {
        delLinesByKey.set(op.key, [op.line]);
      }
    }
  }

  const facts: CellDataKeyFact[] = [];
  for (const op of validOps) {
    const keyClass = keyClassOf(op.key);
    let presence: CellDataKeyPresence;
    if (op.kind === 'write') {
      presence = 'present';
    } else {
      const mutation = findNearestKeyMutation([...validOps, ...pseudo], op, text);
      const escape = escapes.get(op) ?? null;
      if (mutation && (!escape || mutation.line > escape.line)) {
        presence = mutation.kind === 'write' ? 'present' : 'absent';
      } else if (escape) {
        presence = 'unknown';
      } else if (keyClass === 'declared' || keyClass === 'builtin') {
        presence = 'present';
      } else if (keyClass === 'scriptAdded') {
        presence = 'unknown'; // 调用序/作用域不可证;事实带 introducedLine
      } else {
        presence = worldOpen ? 'unknown' : 'absent';
      }
    }
    const writeLines = writeLinesByKey.get(op.key);
    const lastWrite = writeLines ? Math.max(...writeLines) : null;
    const delLines = delLinesByKey.get(op.key);
    const removedAfterWrite =
      lastWrite !== null && delLines !== undefined && delLines.some(line => line > lastWrite);
    facts.push({
      op,
      keyClass,
      entry: universe.get(op.key) ?? null,
      presence,
      introducedLine: introducedLineOf(op.key),
      removedAfterWrite
    });
  }
  return facts;
}
